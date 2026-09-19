import { describe, expect, it } from 'vitest';
import { extractText } from '../src/lib/extract-text.js';

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
