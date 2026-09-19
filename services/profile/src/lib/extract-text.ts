import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { AppError } from '@atlas/utils';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const LEGACY_DOC_MIME = 'application/msword';

/** Dispatches on the uploaded file's content type. Throws for anything we can't read yet. */
export async function extractText(buffer: Buffer, contentType: string): Promise<string> {
  if (contentType === 'application/pdf') {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }

  if (contentType === DOCX_MIME) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (contentType === 'text/plain') {
    return buffer.toString('utf8');
  }

  if (contentType === LEGACY_DOC_MIME) {
    throw new AppError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Legacy .doc files are not supported yet — please upload a PDF, DOCX, or plain-text resume.',
    );
  }

  throw new AppError('UNSUPPORTED_MEDIA_TYPE', `Unsupported resume content type: "${contentType}"`);
}
