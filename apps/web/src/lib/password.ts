/**
 * Mirrors `passwordSchema` in packages/types/src/api.ts (12–256 characters).
 * Duplicated rather than imported: that module pulls zod and every request
 * schema into the client bundle for the sake of two numbers.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

/** A user-facing reason the password is unacceptable, or null when it's fine. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  return null;
}
