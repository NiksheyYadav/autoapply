import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { AppError } from '@atlas/utils';
import {
  assertSafeDocxArchive,
  assertSafePdfStreams,
  extractText,
  looksLikeText,
  MAX_DOCX_ENTRIES,
  MAX_DOCX_UNCOMPRESSED_BYTES,
  MAX_EXTRACTED_TEXT_CHARS,
  MAX_PDF_PAGES,
  MAX_PDF_STREAM_BYTES,
  MAX_PDF_TOTAL_STREAM_BYTES,
  RESUME_FAILURE_REASONS,
  resumeFailureReason,
  verifyResumeUpload,
} from '../src/lib/extract-text.js';
import { buildDocx, buildPdf, buildZip } from './fixtures.js';

const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('extractText', () => {
  it('reads plain text as-is', async () => {
    const buffer = Buffer.from('Ada Lovelace\nBackend engineer.', 'utf8');
    await expect(extractText(buffer, 'text/plain')).resolves.toBe('Ada Lovelace\nBackend engineer.');
  });

  it('rejects an unrecognized content type', async () => {
    await expect(extractText(Buffer.from('x'), 'application/zip')).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
    });
  });

  it('rejects legacy .doc with a specific, actionable message', async () => {
    await expect(extractText(Buffer.from('x'), 'application/msword')).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: expect.stringContaining('.doc'),
    });
  });
});

describe('looksLikeText', () => {
  it('accepts ordinary UTF-8 and Latin-1 text with tabs and CRLF line endings', () => {
    expect(looksLikeText(Buffer.from('Ada Lovelace\r\n\tBackend engineer — résumé\r\n', 'utf8'))).toBe(true);
    expect(looksLikeText(Buffer.from('r\xe9sum\xe9\n', 'latin1'))).toBe(true);
  });

  it('rejects NUL bytes, control-character soup, and known binary signatures', () => {
    expect(looksLikeText(Buffer.from('hello\u0000world'))).toBe(false);
    expect(looksLikeText(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x41, 0x42]))).toBe(false);
    expect(looksLikeText(buildPdf(['x']))).toBe(false);
    expect(looksLikeText(buildDocx(['x']))).toBe(false);
    expect(looksLikeText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(false);
    expect(looksLikeText(Buffer.from([0x4d, 0x5a, 0x90, 0x41, 0x42]))).toBe(false);
  });
});

describe('verifyResumeUpload', () => {
  const pdf = buildPdf(['Hello']);
  const docx = buildDocx(['Hello']);
  const text = Buffer.from('Ada Lovelace\nBackend engineer.', 'utf8');

  it('accepts each supported type when the bytes agree, returning the canonical MIME type', async () => {
    await expect(verifyResumeUpload(pdf, PDF_MIME)).resolves.toBe(PDF_MIME);
    await expect(verifyResumeUpload(docx, DOCX_MIME)).resolves.toBe(DOCX_MIME);
    await expect(verifyResumeUpload(text, 'text/plain')).resolves.toBe('text/plain');
  });

  it('normalizes case and parameters on the declared type', async () => {
    await expect(verifyResumeUpload(text, 'Text/Plain; charset=UTF-8')).resolves.toBe('text/plain');
    await expect(verifyResumeUpload(pdf, ' application/PDF ')).resolves.toBe(PDF_MIME);
  });

  it('tolerates a PDF with a few bytes of junk before the header', async () => {
    await expect(verifyResumeUpload(Buffer.concat([Buffer.from('\n\n  '), pdf]), PDF_MIME)).resolves.toBe(PDF_MIME);
  });

  it.each([
    ['PDF declared, plain text sent', PDF_MIME, Buffer.from('just some text, not a pdf')],
    ['PDF declared, DOCX sent', PDF_MIME, docx],
    ['PDF declared, empty file', PDF_MIME, Buffer.alloc(0)],
    ['DOCX declared, PDF sent', DOCX_MIME, pdf],
    ['DOCX declared, plain text sent', DOCX_MIME, text],
    ['text declared, PDF sent', 'text/plain', pdf],
    ['text declared, DOCX/zip sent', 'text/plain', docx],
    ['text declared, NUL-laden binary sent', 'text/plain', Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0xff, 0xfe])],
    ['text declared, OLE2 (.doc) sent', 'text/plain', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
  ])('rejects a mismatch with 415: %s', async (_label, declared, bytes) => {
    await expect(verifyResumeUpload(bytes, declared)).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      statusCode: 415,
    });
  });

  it.each(['application/zip', 'application/octet-stream', 'image/png', 'text/html', ''])(
    'rejects the unsupported declared type "%s" with 415',
    async (declared) => {
      await expect(verifyResumeUpload(text, declared)).rejects.toMatchObject({ statusCode: 415 });
    },
  );

  it('keeps the actionable legacy .doc message', async () => {
    await expect(verifyResumeUpload(Buffer.from('x'), 'application/msword')).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: expect.stringContaining('.doc'),
    });
  });

  it('does not echo the client-declared type back in the error message', async () => {
    const hostile = 'x/<script>alert(1)</script>';
    const error = await verifyResumeUpload(text, hostile).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).message).not.toContain('script');
  });
});

describe('extractText: DOCX', () => {
  it('reads the text of a genuine DOCX', async () => {
    const text = await extractText(buildDocx(['Ada Lovelace', 'Backend engineer']), DOCX_MIME);
    expect(text).toContain('Ada Lovelace');
    expect(text).toContain('Backend engineer');
  });

  it('rejects text bytes sent as a DOCX instead of handing them to the zip parser', async () => {
    await expect(extractText(Buffer.from('not a zip'), DOCX_MIME)).rejects.toMatchObject({ statusCode: 415 });
  });
});

describe('assertSafeDocxArchive (zip-bomb guard)', () => {
  it('accepts an ordinary DOCX, including stored (uncompressed) entries', async () => {
    await expect(assertSafeDocxArchive(buildDocx(['hi']))).resolves.toBeUndefined();
    const stored = buildDocx(['hi'], [{ name: 'word/media/a.bin', data: Buffer.from('abc'), method: 0 }]);
    await expect(assertSafeDocxArchive(stored)).resolves.toBeUndefined();
  });

  it('rejects an entry that inflates far beyond the size its header declares (lying header)', async () => {
    // 40 MiB of zeros deflates to a few tens of KiB; the header claims 10 bytes.
    const bomb = buildDocx(['hi'], [
      { name: 'word/media/bomb.bin', data: Buffer.alloc(40 * 1024 * 1024), declaredUncompressedSize: 10 },
    ]);
    expect(bomb.length).toBeLessThan(200 * 1024);
    await expect(assertSafeDocxArchive(bomb)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE', statusCode: 413 });
  });

  it('rejects an archive whose honestly-declared total exceeds the cap, without inflating it', async () => {
    const big = buildDocx(['hi'], [
      { name: 'word/media/big.bin', data: Buffer.from('x'), declaredUncompressedSize: MAX_DOCX_UNCOMPRESSED_BYTES + 1 },
    ]);
    await expect(assertSafeDocxArchive(big)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('rejects an archive whose real contents exceed the cap across many entries', async () => {
    // Each entry is honest and individually modest; only the sum is too big.
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    const entries = Array.from({ length: 4 }, (_, index) => ({ name: `word/media/chunk${index}.bin`, data: chunk }));
    await expect(assertSafeDocxArchive(buildDocx(['hi'], entries))).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('rejects an archive with too many entries', async () => {
    const entries = Array.from({ length: MAX_DOCX_ENTRIES + 1 }, (_, index) => ({
      name: `word/media/f${index}.txt`,
      data: Buffer.from('x'),
      method: 0 as const,
    }));
    await expect(assertSafeDocxArchive(buildZip(entries))).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('rejects encrypted entries and an entry whose data disagrees with its declared size', async () => {
    await expect(
      assertSafeDocxArchive(buildZip([{ name: 'word/document.xml', data: Buffer.from('<x/>'), encrypted: true }])),
    ).rejects.toMatchObject({ statusCode: 415 });

    // Declares more than the stream really holds.
    await expect(
      assertSafeDocxArchive(buildZip([{ name: 'word/document.xml', data: Buffer.from('<x/>'), declaredUncompressedSize: 50 }])),
    ).rejects.toMatchObject({ statusCode: 415 });
  });

  it('rejects a compression method other than stored/deflate', async () => {
    const unknownMethod = buildZip([{ name: 'word/document.xml', data: Buffer.from('<x/>'), method: 0 }]);
    // Patch both the local and central headers' compression method to 12 (bzip2).
    unknownMethod.writeUInt16LE(12, 8);
    const centralAt = unknownMethod.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    unknownMethod.writeUInt16LE(12, centralAt + 10);
    await expect(assertSafeDocxArchive(unknownMethod)).rejects.toMatchObject({ statusCode: 415 });
  });

  it('rejects garbage that merely starts with the zip signature, and truncated archives', async () => {
    const garbage = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100, 7)]);
    await expect(assertSafeDocxArchive(garbage)).rejects.toMatchObject({ statusCode: 415 });
    const real = buildDocx(['hi']);
    await expect(assertSafeDocxArchive(real.subarray(0, real.length - 10))).rejects.toMatchObject({ statusCode: 415 });
  });

  it('rejects a directory that does not end exactly at the end-of-directory record (offset-rebasing trick)', async () => {
    const real = buildDocx(['hi']);
    const eocdAt = real.length - 22;
    // Slip 8 junk bytes between the central directory and the EOCD.
    const gapped = Buffer.concat([real.subarray(0, eocdAt), Buffer.alloc(8), real.subarray(eocdAt)]);
    await expect(assertSafeDocxArchive(gapped)).rejects.toMatchObject({ statusCode: 415 });
  });

  it('rejects hidden extra central-directory records beyond the declared entry count', async () => {
    const real = buildDocx(['hi']);
    const eocdAt = real.length - 22;
    const centralAt = real.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const firstRecord = real.subarray(centralAt, centralAt + 46 + '[Content_Types].xml'.length);
    // Splice a duplicate record into the directory but leave the declared count/size alone.
    const withExtra = Buffer.concat([real.subarray(0, eocdAt), firstRecord, real.subarray(eocdAt)]);
    await expect(assertSafeDocxArchive(withExtra)).rejects.toMatchObject({ statusCode: 415 });
  });
});

describe('extractText: output caps', () => {
  it('truncates extracted plain text at the cap', async () => {
    const huge = Buffer.from('a'.repeat(MAX_EXTRACTED_TEXT_CHARS + 5_000), 'utf8');
    const text = await extractText(huge, 'text/plain');
    expect(text).toHaveLength(MAX_EXTRACTED_TEXT_CHARS);
  });

  it('truncates DOCX text at the cap too', async () => {
    const line = 'x'.repeat(1_000);
    const lines = Array.from({ length: Math.ceil(MAX_EXTRACTED_TEXT_CHARS / 1_000) + 20 }, () => line);
    const text = await extractText(buildDocx(lines), DOCX_MIME);
    expect(text).toHaveLength(MAX_EXTRACTED_TEXT_CHARS);
  });

  it('strips NUL characters that Postgres text columns cannot store', async () => {
    const text = await extractText(buildDocx([`before${String.fromCharCode(0)}after`]), DOCX_MIME);
    expect(text).toContain('beforeafter');
    expect(text).not.toContain('\u0000');
  });
});

describe('extractText: PDF', () => {
  it('reads the text of a PDF', async () => {
    const text = await extractText(buildPdf(['Ada Lovelace Backend Engineer']), PDF_MIME);
    expect(text).toContain('Ada Lovelace Backend Engineer');
  });

  it('only reads the first MAX_PDF_PAGES pages of a long document', async () => {
    const mark = (page: number) => `PAGEMARK${String(page).padStart(3, '0')}`;
    const pages = Array.from({ length: MAX_PDF_PAGES + 10 }, (_, index) => mark(index + 1));
    const text = await extractText(buildPdf(pages), PDF_MIME);
    expect(text).toContain(mark(MAX_PDF_PAGES));
    expect(text).not.toContain(mark(MAX_PDF_PAGES + 1));
  });
});

describe('resumeFailureReason', () => {
  it('maps every failure to one of a few fixed, user-safe strings', () => {
    expect(resumeFailureReason(new AppError('UNSUPPORTED_MEDIA_TYPE', 'x'))).toBe(RESUME_FAILURE_REASONS.unsupported);
    expect(resumeFailureReason(new AppError('PAYLOAD_TOO_LARGE', 'x'))).toBe(RESUME_FAILURE_REASONS.tooComplex);
    expect(resumeFailureReason(new Error('anything else'))).toBe(RESUME_FAILURE_REASONS.unreadable);
    expect(resumeFailureReason('a thrown string')).toBe(RESUME_FAILURE_REASONS.unreadable);
    expect(resumeFailureReason(undefined)).toBe(RESUME_FAILURE_REASONS.unreadable);
  });

  it('never carries SQL, bound parameters, or other raw error text through', () => {
    const drizzleLike = Object.assign(
      new Error('Failed query: update "resumes" set "parsed_text" = $1 where "resume_id" = $2\nparams: SECRET RESUME BODY,abc'),
      { query: 'update ...', params: ['SECRET RESUME BODY', 'abc'] },
    );
    const reason = resumeFailureReason(drizzleLike);
    expect(reason).not.toMatch(/SECRET|Failed query|params|update/i);
    expect(Object.values(RESUME_FAILURE_REASONS)).toContain(reason);
  });
});

describe('assertSafePdfStreams (decompression-bomb guard)', () => {
  const MIB = 1024 * 1024;

  /** A PDF-shaped buffer whose objects carry the given raw stream bodies. The guard reads bytes, not structure. */
  function pdfWithStreams(bodies: Buffer[]): Buffer {
    const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
    bodies.forEach((body, index) => {
      parts.push(Buffer.from(`${index + 1} 0 obj\n<< /Length ${body.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'));
      parts.push(body, Buffer.from('\nendstream\nendobj\n', 'latin1'));
    });
    parts.push(Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'));
    return Buffer.concat(parts);
  }
  const flateOf = (megabytes: number): Buffer => deflateSync(Buffer.alloc(megabytes * MIB, 0x20), { level: 9 });

  it('accepts an ordinary PDF and one with a large but reasonable compressed image', () => {
    expect(() => assertSafePdfStreams(buildPdf(['Ada Lovelace', 'Backend engineer']))).not.toThrow();
    expect(() => assertSafePdfStreams(pdfWithStreams([flateOf(20), flateOf(5)]))).not.toThrow();
  });

  it('rejects one stream that inflates past the per-stream limit, whatever the file size', () => {
    const bomb = pdfWithStreams([flateOf(MAX_PDF_STREAM_BYTES / MIB + 8)]);
    expect(bomb.length).toBeLessThan(200 * 1024);
    expect(() => assertSafePdfStreams(bomb)).toThrowError(expect.objectContaining({ statusCode: 413 }));
  });

  it('rejects many streams that are each fine but together inflate past the total limit', () => {
    const each = 24;
    const count = Math.ceil(MAX_PDF_TOTAL_STREAM_BYTES / MIB / each) + 1;
    const bodies = Array.from({ length: count }, () => flateOf(each));
    expect(() => assertSafePdfStreams(pdfWithStreams(bodies))).toThrowError(expect.objectContaining({ statusCode: 413 }));
  });

  it('leaves damaged or non-zlib streams to the PDF reader instead of failing the upload', () => {
    const damaged = Buffer.concat([Buffer.from([0x78, 0x9c]), Buffer.from('this is not deflate data at all')]);
    const plain = Buffer.from('BT /F1 12 Tf (plain) Tj ET');
    const truncated = flateOf(1).subarray(0, 40);
    expect(() => assertSafePdfStreams(pdfWithStreams([damaged, plain, truncated]))).not.toThrow();
  });

  it('does not take "endstream" for the start of a stream, and stays fast on a file full of the keywords', () => {
    const noise = Buffer.from('endstream stream\nendstream '.repeat(40_000), 'latin1');
    const start = performance.now();
    expect(() => assertSafePdfStreams(Buffer.concat([Buffer.from('%PDF-1.4\n'), noise]))).not.toThrow();
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  it('is applied before extraction, so a bomb is refused quickly with the "too complex" reason', async () => {
    const bomb = pdfWithStreams([flateOf(MAX_PDF_STREAM_BYTES / MIB + 8)]);
    const start = performance.now();
    const failure = await extractText(bomb, PDF_MIME).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(failure).toMatchObject({ statusCode: 413 });
    expect(resumeFailureReason(failure)).toBe(RESUME_FAILURE_REASONS.tooComplex);
    expect(performance.now() - start).toBeLessThan(3_000);
  });
});
