import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Hand-rolled file builders for the upload-hardening tests: tiny PDF/DOCX
 * documents plus deliberately hostile zips. Not a `*.test.ts` file, so vitest
 * doesn't collect it.
 */

export interface ZipEntrySpec {
  name: string;
  data: Buffer;
  /** 8 (deflate, default) or 0 (stored). */
  method?: 0 | 8;
  /** Lie about the uncompressed size in the headers (the bytes themselves are untouched). */
  declaredUncompressedSize?: number;
  /** Set the "encrypted" general-purpose flag. */
  encrypted?: boolean;
}

export function buildZip(entries: ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const method = entry.method ?? 8;
    const name = Buffer.from(entry.name, 'utf8');
    const body = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const uncompressedSize = entry.declaredUncompressedSize ?? entry.data.length;
    const flags = entry.encrypted === true ? 0x1 : 0;
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

const DOCX_CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';

const DOCX_ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** A minimal but genuine DOCX (mammoth reads it) with one paragraph per line. */
export function buildDocx(lines: string[], extraEntries: ZipEntrySpec[] = []): Buffer {
  const paragraphs = lines.map((line) => `<w:p><w:r><w:t>${escapeXml(line)}</w:t></w:r></w:p>`).join('');
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    paragraphs +
    '</w:body></w:document>';
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(DOCX_CONTENT_TYPES) },
    { name: '_rels/.rels', data: Buffer.from(DOCX_ROOT_RELS) },
    { name: 'word/document.xml', data: Buffer.from(documentXml) },
    ...extraEntries,
  ]);
}

/** A minimal single-font PDF with one line of text per page. */
export function buildPdf(pageTexts: string[]): Buffer {
  const objects: string[] = [];
  const pageCount = pageTexts.length;
  // Object ids: 1 catalog, 2 pages, 3 font, then (page, content) pairs from 4.
  const pageIds = pageTexts.map((_, index) => 4 + index * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pageTexts.forEach((text, index) => {
    const pageId = 4 + index * 2;
    const stream = `BT /F1 12 Tf 72 720 Td (${text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')}) Tj ET`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageId + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
