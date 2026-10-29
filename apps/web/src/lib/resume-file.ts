/**
 * Vercel rejects request bodies over ~4.5 MB before they reach the function,
 * with a plain-text error we can't show nicely. Stay safely under it.
 */
export const MAX_RESUME_BYTES = 4 * 1024 * 1024;

/** extension -> the content type profile-service dispatches on (see services/profile/src/lib/extract-text.ts). */
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
};

export type ResumeFileCheck = { ok: true; file: File } | { ok: false; message: string };

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

/**
 * Client-side checks run before the upload, so the user gets a clear message
 * instead of a failed request: PDF/DOCX/TXT only, non-empty, at most 4 MB.
 *
 * The server picks a parser from the multipart content type, and browsers
 * sometimes report an empty or generic one (`application/octet-stream`) for
 * .docx/.txt, so the file is re-typed from its extension when that happens.
 */
export function checkResumeFile(file: File): ResumeFileCheck {
  const expectedType = CONTENT_TYPE_BY_EXTENSION[extensionOf(file.name)];
  if (!expectedType) {
    return { ok: false, message: 'Please choose a PDF, DOCX, or plain-text (.txt) file.' };
  }
  if (file.size === 0) {
    return { ok: false, message: 'That file is empty. Please choose a different one.' };
  }
  if (file.size > MAX_RESUME_BYTES) {
    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    return { ok: false, message: `That file is ${sizeMb} MB. Resumes can be at most 4 MB — try a smaller or compressed copy.` };
  }
  if (file.type === expectedType) return { ok: true, file };
  return { ok: true, file: new File([file], file.name, { type: expectedType, lastModified: file.lastModified }) };
}
