import { describe, expect, it } from 'vitest';
import { httpEnvSchema, parseRateLimitWindowMs, rateLimitWindowSchema } from '../src/index.js';

describe('rate-limit window', () => {
  it.each([
    ['1 second', 1_000],
    ['30 seconds', 30_000],
    ['1 minute', 60_000],
    ['2 mins', 120_000],
    ['5m', 300_000],
    ['1 hour', 3_600_000],
    ['2H', 7_200_000],
    ['1 day', 86_400_000],
    ['1.5 minutes', 90_000],
    ['  10 seconds  ', 10_000],
  ])('reads %j as %d ms', (text, ms) => {
    expect(parseRateLimitWindowMs(text)).toBe(ms);
    expect(rateLimitWindowSchema.safeParse(text).success).toBe(true);
  });

  // Each of these booted a service that then answered every request with a 500, or one that
  // never limited anything, before the value was checked at boot.
  it.each([
    '',
    ' ',
    'abc',
    '1 parsec',
    '0',
    '60',
    '1000',
    '0 seconds',
    '-5 minutes',
    '1e400',
    'NaN',
    '500 ms',
    '8 days',
    '99999 years',
    '1 minute; drop table',
  ])('refuses %j', (text) => {
    expect(rateLimitWindowSchema.safeParse(text).success).toBe(false);
  });

  it('is what RATE_LIMIT_WINDOW is validated with, and keeps the one-minute default', () => {
    const base = { PORT: '4000' };
    expect(httpEnvSchema.parse(base).RATE_LIMIT_WINDOW).toBe('1 minute');
    expect(httpEnvSchema.safeParse({ ...base, RATE_LIMIT_WINDOW: 'abc' }).success).toBe(false);
    expect(httpEnvSchema.safeParse({ ...base, RATE_LIMIT_WINDOW: '-5 minutes' }).success).toBe(false);
  });
});
