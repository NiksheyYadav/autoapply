import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/security/password.js';

describe('password hashing', () => {
  it('verifies a matching password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    await expect(verifyPassword('correct-horse-battery-staple', hash)).resolves.toBe(true);
  });

  it('rejects a non-matching password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    await expect(verifyPassword('wrong-password-entirely', hash)).resolves.toBe(false);
  });

  it('salts every hash independently, even for the same password', async () => {
    const a = await hashPassword('same-password-same-password');
    const b = await hashPassword('same-password-same-password');
    expect(a).not.toBe(b);
  });

  it('rejects malformed stored hashes instead of throwing', async () => {
    await expect(verifyPassword('anything', 'not-a-valid-hash')).resolves.toBe(false);
    await expect(verifyPassword('anything', 'scrypt$bad$bad$bad$salt$hash')).resolves.toBe(false);
  });
});
