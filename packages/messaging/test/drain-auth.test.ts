import { describe, expect, it } from 'vitest';
import { isAuthorizedDrainRequest } from '../src/index.js';

const SECRET = 'correct-horse-battery-staple-1234';

describe('isAuthorizedDrainRequest', () => {
  it('accepts the exact bearer secret Vercel Cron sends', () => {
    expect(isAuthorizedDrainRequest(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it('treats the scheme as case-insensitive and tolerates surrounding whitespace', () => {
    expect(isAuthorizedDrainRequest(`bearer ${SECRET}`, SECRET)).toBe(true);
    expect(isAuthorizedDrainRequest(`Bearer   ${SECRET} `, SECRET)).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(isAuthorizedDrainRequest(undefined, SECRET)).toBe(false);
    expect(isAuthorizedDrainRequest('', SECRET)).toBe(false);
  });

  it('rejects a wrong secret, including prefixes, extensions and different lengths', () => {
    expect(isAuthorizedDrainRequest('Bearer wrong', SECRET)).toBe(false);
    expect(isAuthorizedDrainRequest(`Bearer ${SECRET.slice(0, -1)}`, SECRET)).toBe(false);
    expect(isAuthorizedDrainRequest(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(isAuthorizedDrainRequest(`Bearer ${SECRET.toUpperCase()}`, SECRET)).toBe(false);
  });

  it('rejects other schemes and a bare secret', () => {
    expect(isAuthorizedDrainRequest(SECRET, SECRET)).toBe(false);
    expect(isAuthorizedDrainRequest(`Basic ${SECRET}`, SECRET)).toBe(false);
    expect(isAuthorizedDrainRequest(`Token ${SECRET}`, SECRET)).toBe(false);
    expect(isAuthorizedDrainRequest('Bearer', SECRET)).toBe(false);
  });

  it('never authorizes anything against an empty secret', () => {
    expect(isAuthorizedDrainRequest('Bearer ', '')).toBe(false);
    expect(isAuthorizedDrainRequest('Bearer x', '')).toBe(false);
    expect(isAuthorizedDrainRequest(undefined, '')).toBe(false);
  });
});
