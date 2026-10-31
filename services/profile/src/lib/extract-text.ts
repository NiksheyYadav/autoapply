import { inflateRaw, inflateSync } from 'node:zlib';
import { promisify } from 'node:util';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { AppError } from '@atlas/utils';

const inflateRawAsync = promisify(inflateRaw);

const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TEXT_MIME = 'text/plain';
const LEGACY_DOC_MIME = 'application/msword';

/**
 * Resource caps. Resumes are small; these sit far above any real one and
 * exist so a hostile upload (a zip bomb, a million-page PDF, a text file the
 * size of the body limit) cannot be used to exhaust CPU, memory, or the
 * `resumes.parsed_text` column.
 */
export const MAX_EXTRACTED_TEXT_CHARS = 200_000;
export const MAX_PDF_PAGES = 30;
export const MAX_DOCX_ENTRIES = 1_000;
export const MAX_DOCX_UNCOMPRESSED_BYTES = 30 * 1024 * 1024;
/** One PDF stream may inflate to this much (a full-page 24-bit scan at 300 dpi is about 25 MB). */
export const MAX_PDF_STREAM_BYTES = 32 * 1024 * 1024;
/** All the PDF's compressed streams together may inflate to this much. */
export const MAX_PDF_TOTAL_STREAM_BYTES = 128 * 1024 * 1024;
const MAX_PDF_STREAMS_CHECKED = 20_000;

export type ResumeFormat = 'pdf' | 'docx' | 'text';

const FORMAT_BY_MIME: Record<string, ResumeFormat> = {
  [PDF_MIME]: 'pdf',
  [DOCX_MIME]: 'docx',
  [TEXT_MIME]: 'text',
};

const MIME_BY_FORMAT: Record<ResumeFormat, string> = {
  pdf: PDF_MIME,
  docx: DOCX_MIME,
  text: TEXT_MIME,
};

/** `Text/Plain; charset=utf-8` → `text/plain`. */
function normalizeMime(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

// --- Content sniffing -------------------------------------------------------

/** The PDF spec lets the `%PDF-` header sit anywhere in the first 1024 bytes. */
const PDF_HEADER_WINDOW = 1024;

function startsWith(buffer: Uint8Array, signature: readonly number[]): boolean {
  return buffer.length >= signature.length && signature.every((byte, index) => buffer[index] === byte);
}

function hasPdfHeader(buffer: Buffer): boolean {
  return buffer.subarray(0, PDF_HEADER_WINDOW).includes('%PDF-', 0, 'latin1');
}

/** Local file header (`PK\x03\x04`). Empty (`PK\x05\x06`) and spanned (`PK\x07\x08`) archives are not documents. */
function hasZipHeader(buffer: Buffer): boolean {
  return startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]);
}

/** Leading bytes of common non-text formats, checked so a binary file can't pass as `text/plain`. */
const BINARY_SIGNATURES: readonly (readonly number[])[] = [
  [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  [0x50, 0x4b, 0x03, 0x04], // zip / docx / xlsx / jar
  [0x50, 0x4b, 0x05, 0x06], // empty zip
  [0xd0, 0xcf, 0x11, 0xe0], // OLE2 (legacy .doc / .xls)
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0x1f, 0x8b], // gzip
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x4d, 0x5a], // MZ (Windows executables)
];

/** Control characters other than tab, LF, FF and CR. */
function isBinaryControl(byte: number): boolean {
  return byte < 0x20 ? byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d : byte === 0x7f;
}

/**
 * Plain-text sniff: no NUL bytes, no known binary signature, and (almost) no
 * control characters. Deliberately encoding-agnostic — it only has to tell
 * "someone's resume.txt" apart from "a binary wearing a .txt label".
 */
export function looksLikeText(buffer: Buffer): boolean {
  if (BINARY_SIGNATURES.some((signature) => startsWith(buffer, signature))) return false;
  let controls = 0;
  for (const byte of buffer) {
    if (byte === 0x00) return false;
    if (isBinaryControl(byte)) controls += 1;
  }
  return controls <= buffer.length * 0.01;
}

// --- DOCX (zip) bomb guard --------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const ZIP32_MAX = 0xffffffff;

/** Archives already proven safe, so the route's pre-check and `extractText` don't inflate twice. */
const verifiedArchives = new WeakSet<Buffer>();

function malformedArchive(): AppError {
  return new AppError('UNSUPPORTED_MEDIA_TYPE', 'The uploaded file is not a valid DOCX document.');
}

function archiveTooLarge(): AppError {
  return new AppError('PAYLOAD_TOO_LARGE', 'The uploaded document is too large or complex to process.');
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const lowest = Math.max(0, buffer.length - EOCD_MIN_SIZE - 0xffff);
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= lowest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw malformedArchive();
}

/**
 * Rejects zip bombs *before* mammoth/JSZip see the file. Header sizes alone
 * are not trustworthy (an attacker can under-declare), so every entry is
 * actually inflated here with `maxOutputLength` pinned to its declared size:
 * an entry that expands beyond what it claims aborts instead of ballooning
 * memory. Once an archive passes, JSZip's own inflate is provably bounded by
 * {@link MAX_DOCX_UNCOMPRESSED_BYTES}.
 *
 * Throws 413 for entry-count / size violations and 415 for anything that
 * isn't a well-formed zip (encrypted, ZIP64, unknown compression, truncated).
 */
export async function assertSafeDocxArchive(buffer: Buffer): Promise<void> {
  if (verifiedArchives.has(buffer)) return;

  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);

  // 0xffff / 0xffffffff are the ZIP64 "look elsewhere" markers — no resume needs them.
  if (entryCount === 0xffff || directorySize === ZIP32_MAX || directoryOffset === ZIP32_MAX) throw archiveTooLarge();
  if (entryCount === 0) throw malformedArchive();
  if (entryCount > MAX_DOCX_ENTRIES) throw archiveTooLarge();
  // Require the central directory to end exactly where the end-of-directory
  // record starts. JSZip (via mammoth) re-bases every offset when it sees a
  // gap there, so tolerating one would let a file show us one directory and
  // JSZip another — the entries we inflate below must be the entries it reads.
  if (directoryOffset + directorySize !== eocd) throw malformedArchive();

  interface Entry {
    method: number;
    compressedSize: number;
    uncompressedSize: number;
    localOffset: number;
  }
  const entries: Entry[] = [];
  let declaredTotal = 0;
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + CENTRAL_HEADER_SIZE > eocd || buffer.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) {
      throw malformedArchive();
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);

    if ((flags & 0x1) !== 0) throw malformedArchive(); // encrypted
    if (compressedSize === ZIP32_MAX || uncompressedSize === ZIP32_MAX || localOffset === ZIP32_MAX) {
      throw archiveTooLarge();
    }
    declaredTotal += uncompressedSize;
    if (declaredTotal > MAX_DOCX_UNCOMPRESSED_BYTES) throw archiveTooLarge();

    entries.push({ method, compressedSize, uncompressedSize, localOffset });
    cursor += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
  }
  // Declared entries must account for the whole directory: JSZip reads every
  // consecutive central header, not just `entryCount` of them.
  if (cursor !== eocd) throw malformedArchive();

  let actualTotal = 0;
  for (const entry of entries) {
    if (entry.localOffset + LOCAL_HEADER_SIZE > buffer.length || buffer.readUInt32LE(entry.localOffset) !== LOCAL_HEADER_SIGNATURE) {
      throw malformedArchive();
    }
    const dataStart =
      entry.localOffset + LOCAL_HEADER_SIZE + buffer.readUInt16LE(entry.localOffset + 26) + buffer.readUInt16LE(entry.localOffset + 28);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > directoryOffset) throw malformedArchive();
    const data = buffer.subarray(dataStart, dataEnd);

    let actualSize: number;
    if (entry.method === 0) {
      actualSize = data.length;
    } else if (entry.method === 8) {
      try {
        // Never allow more output than the entry declared (min 1: the option rejects 0).
        actualSize = (await inflateRawAsync(data, { maxOutputLength: Math.max(entry.uncompressedSize, 1) })).length;
      } catch (cause) {
        const code = (cause as { code?: string }).code;
        throw code === 'ERR_BUFFER_TOO_LARGE' ? archiveTooLarge() : malformedArchive();
      }
    } else {
      throw malformedArchive(); // OOXML uses only stored and deflate
    }
    if (actualSize !== entry.uncompressedSize) throw malformedArchive();

    actualTotal += actualSize;
    if (actualTotal > MAX_DOCX_UNCOMPRESSED_BYTES) throw archiveTooLarge();
  }

  verifiedArchives.add(buffer);
}

// --- Public API -------------------------------------------------------------

/**
 * The client-declared multipart `Content-Type` is untrusted: it only picks
 * which parser runs, so it must agree with what the bytes really are. Returns
 * the canonical MIME type for storage (never the raw client string). Throws:
 *   - 415 for an unsupported type (including legacy `.doc`) or a type/bytes mismatch,
 *   - 413 for a DOCX that is a zip bomb.
 */
export async function verifyResumeUpload(buffer: Buffer, declaredContentType: string): Promise<string> {
  const mime = normalizeMime(declaredContentType);

  if (mime === LEGACY_DOC_MIME) {
    throw new AppError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Legacy .doc files are not supported yet — please upload a PDF, DOCX, or plain-text resume.',
    );
  }

  const format = FORMAT_BY_MIME[mime];
  if (!format) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Unsupported resume file type — please upload a PDF, DOCX, or plain-text resume.');
  }

  const matches = format === 'pdf' ? hasPdfHeader(buffer) : format === 'docx' ? hasZipHeader(buffer) : looksLikeText(buffer);
  if (!matches) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'The uploaded file does not match its declared type.');
  }

  if (format === 'docx') await assertSafeDocxArchive(buffer);
  return MIME_BY_FORMAT[format];
}

/** True when the bytes open with a valid zlib header (the `FlateDecode` filter's wrapper). */
function startsLikeZlib(body: Buffer): boolean {
  return body.length >= 2 && (body[0]! & 0x0f) === 8 && ((body[0]! << 8) | body[1]!) % 31 === 0;
}

/**
 * Rejects PDF decompression bombs *before* pdf.js sees the file. A PDF stream is usually
 * `FlateDecode`, and a few hundred KB of it can inflate to hundreds of MB (a page whose content is
 * a very long run of spaces, an image of one colour), which costs seconds of CPU and a gigabyte
 * or more of memory in the upload request. Every stream that opens like a zlib stream is inflated
 * here with `maxOutputLength`, so one that expands past {@link MAX_PDF_STREAM_BYTES}, or streams
 * that together pass {@link MAX_PDF_TOTAL_STREAM_BYTES}, abort the upload with a 413. The scan
 * looks at raw bytes and ignores what the stream dictionaries claim, because those are
 * attacker-controlled; anything it cannot inflate is left to pdf.js, which reads it lazily and
 * only for the first {@link MAX_PDF_PAGES} pages.
 */
export function assertSafePdfStreams(buffer: Buffer): void {
  let total = 0;
  let checked = 0;
  let from = 0;
  for (;;) {
    const keyword = buffer.indexOf('stream', from, 'latin1');
    if (keyword === -1) return;
    from = keyword + 6;
    // "endstream" contains the keyword too; only "stream" on its own opens a stream.
    if (keyword >= 3 && buffer.toString('latin1', keyword - 3, keyword) === 'end') continue;

    let start = keyword + 6;
    if (buffer[start] === 0x0d) start += 1;
    if (buffer[start] === 0x0a) start += 1;
    if (!startsLikeZlib(buffer.subarray(start, start + 2))) continue;

    checked += 1;
    if (checked > MAX_PDF_STREAMS_CHECKED) throw archiveTooLarge();
    const end = buffer.indexOf('endstream', start, 'latin1');
    const body = buffer.subarray(start, end === -1 ? buffer.length : end);
    let inflated: number;
    try {
      inflated = inflateSync(body, { maxOutputLength: MAX_PDF_STREAM_BYTES }).length;
    } catch (cause) {
      // Over the limit is the one failure that matters; a damaged stream is pdf.js's to report.
      if ((cause as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') throw archiveTooLarge();
      continue;
    }
    total += inflated;
    if (total > MAX_PDF_TOTAL_STREAM_BYTES) throw archiveTooLarge();
    from = Math.max(from, end === -1 ? buffer.length : end);
  }
}

/** Bounded, NUL-free text: Postgres `text` rejects NUL bytes and `parsed_text` is sensitive and unbounded otherwise. */
function finalizeText(text: string): string {
  const clean = text.includes('\u0000') ? text.replaceAll('\u0000', '') : text;
  return clean.length > MAX_EXTRACTED_TEXT_CHARS ? clean.slice(0, MAX_EXTRACTED_TEXT_CHARS) : clean;
}

/**
 * Dispatches on the uploaded file's content type, after re-verifying it against the bytes
 * ({@link verifyResumeUpload}). Throws for anything we can't read yet.
 */
export async function extractText(buffer: Buffer, contentType: string): Promise<string> {
  const mime = await verifyResumeUpload(buffer, contentType);

  if (mime === PDF_MIME) {
    assertSafePdfStreams(buffer);
    const parser = new PDFParse({ data: buffer });
    try {
      // A resume is a handful of pages; never walk an arbitrarily long document.
      const result = await parser.getText({ first: MAX_PDF_PAGES });
      return finalizeText(result.text);
    } finally {
      await parser.destroy();
    }
  }

  if (mime === DOCX_MIME) {
    const result = await mammoth.extractRawText({ buffer });
    return finalizeText(result.value);
  }

  return finalizeText(buffer.toString('utf8'));
}

/** Stable, user-safe `resumes.failure_reason` values — never raw error text (see {@link resumeFailureReason}). */
export const RESUME_FAILURE_REASONS = {
  unsupported: 'This file type is not supported. Please upload a PDF, DOCX, or plain-text resume.',
  tooComplex: 'This file is too large or complex to process. Please upload a smaller resume.',
  unreadable: 'We could not read this file. Please try exporting it again as a text-based PDF, DOCX, or plain-text resume.',
} as const;

/**
 * Maps whatever a parse attempt threw to one of a few fixed strings. The raw
 * error is never persisted or returned: drizzle/driver errors embed the SQL
 * and bound parameters (which here would be the resume's own text), and
 * parser errors can echo file content. The real error belongs in the logs.
 */
export function resumeFailureReason(cause: unknown): string {
  const code = cause instanceof AppError ? cause.code : undefined;
  if (code === 'UNSUPPORTED_MEDIA_TYPE') return RESUME_FAILURE_REASONS.unsupported;
  if (code === 'PAYLOAD_TOO_LARGE') return RESUME_FAILURE_REASONS.tooComplex;
  return RESUME_FAILURE_REASONS.unreadable;
}
