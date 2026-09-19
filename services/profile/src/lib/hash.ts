import { createHash } from 'node:crypto';

/** `@atlas/utils`'s `sha256Hex` hashes a UTF-8 string; file bytes need a byte-accurate hash instead. */
export function sha256HexBuffer(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
