import { describe, expect, it } from 'vitest';
import { DEFAULT_NEXT_PATH, safeNextPath } from '../src/lib/safe-redirect';

describe('safeNextPath', () => {
  it.each([
    ['/dashboard'],
    ['/dashboard/0b6d2a4e-6f43-4a39-9a43-4a1d3c1a8e11/roster'],
    ['/dashboard/organizations'],
  ])('allows the same-origin path %s unchanged', (path) => {
    expect(safeNextPath(path)).toBe(path);
  });

  it.each([[null], [undefined], ['']])('falls back to the default for %s', (value) => {
    expect(safeNextPath(value)).toBe(DEFAULT_NEXT_PATH);
  });

  it.each([
    ['https://evil.example/dashboard'],
    ['//evil.example'],
    ['/\\evil.example'],
    ['/\t/evil.example'],
    ['///evil.example'],
    ['javascript:alert(1)'],
    ['dashboard'],
    ['@evil.example'],
    ['/%5Cevil.example'],
    ['/%E0%A4%A'],
  ])('refuses %j', (value) => {
    expect(safeNextPath(value)).toBe(DEFAULT_NEXT_PATH);
  });

  it('refuses an oversized value', () => {
    expect(safeNextPath(`/${'a'.repeat(3000)}`)).toBe(DEFAULT_NEXT_PATH);
  });
});
