import { describe, expect, it } from 'vitest';
import {
  corsOriginsSchema,
  httpEnvSchema,
  normalizeCorsOrigin,
  parseCorsOrigins,
} from '../src/index.js';

describe('CORS_ORIGINS', () => {
  it.each([
    ['https://app.example.com', 'https://app.example.com'],
    ['https://app.example.com/', 'https://app.example.com'],
    ['HTTPS://App.Example.COM', 'https://app.example.com'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['https://app.example.com:443', 'https://app.example.com'],
    ['  https://app.example.com  ', 'https://app.example.com'],
  ])('reads %j as the origin %j', (entry, origin) => {
    expect(normalizeCorsOrigin(entry)).toBe(origin);
  });

  // Each of these started a service that then blocked every browser request, or matched nothing.
  it.each([
    'app.example.com',
    '//app.example.com',
    'null',
    'https://app.example.com/login',
    'https://app.example.com?x=1',
    'https://app.example.com#top',
    'https://user:pass@app.example.com',
    'ftp://app.example.com',
    'javascript:alert(1)',
    'https://',
    '*.example.com',
    '/',
    '',
  ])('refuses the entry %j', (entry) => {
    expect(normalizeCorsOrigin(entry)).toBeUndefined();
  });

  it('turns the setting into canonical origins and keeps the wildcard as a sentinel', () => {
    expect(parseCorsOrigins('')).toEqual([]);
    expect(parseCorsOrigins('  ')).toEqual([]);
    expect(parseCorsOrigins('*')).toBe(true);
    expect(parseCorsOrigins(' * ')).toBe(true);
    expect(parseCorsOrigins('https://a.example.com/, http://localhost:3000 ,')).toEqual([
      'https://a.example.com',
      'http://localhost:3000',
    ]);
  });

  it('accepts empty, a wildcard on its own, and a clean list; names the bad entry otherwise', () => {
    expect(corsOriginsSchema.safeParse('').success).toBe(true);
    expect(corsOriginsSchema.safeParse('*').success).toBe(true);
    expect(corsOriginsSchema.safeParse('https://a.example.com/,https://b.example.com').success).toBe(true);
    const bad = corsOriginsSchema.safeParse('https://a.example.com,app.example.com,https://b.example.com/x');
    expect(bad.success).toBe(false);
    const messages = bad.success ? [] : bad.error.issues.map((issue) => issue.message);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('"app.example.com"');
    expect(messages[1]).toContain('"https://b.example.com/x"');
  });

  it('refuses a wildcard mixed into a list, where it would be a literal that matches nothing', () => {
    expect(corsOriginsSchema.safeParse('https://a.example.com,*').success).toBe(false);
  });

  it('is what the shared HTTP env validates, with an empty default', () => {
    expect(httpEnvSchema.parse({ PORT: '4000' }).CORS_ORIGINS).toBe('');
    expect(httpEnvSchema.safeParse({ PORT: '4000', CORS_ORIGINS: 'app.example.com' }).success).toBe(false);
  });
});
