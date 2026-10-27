/**
 * Hands a Blob to the browser as a file download. The object URL exists only
 * for the click and is revoked right after, so the data is not left reachable
 * through a URL.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Some browsers start the download asynchronously; revoke on the next tick.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function saveText(text: string, filename: string, mimeType = 'text/csv;charset=utf-8'): void {
  saveBlob(new Blob([text], { type: mimeType }), filename);
}
