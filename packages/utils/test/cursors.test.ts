import { describe, expect, it } from 'vitest';
import { AppError, encodeCursor, parseScoreCursor, parseTimeCursor } from '../src/index.js';

const ID = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';
const forged = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

function rejects(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400, message: 'Invalid cursor' });
    return;
  }
  throw new Error('expected the cursor to be refused');
}

describe('parseTimeCursor', () => {
  it('means "first page" when there is no cursor', () => {
    expect(parseTimeCursor(undefined)).toBeNull();
  });

  it.each([
    '2026-10-27 12:34:56.123456+00', // what Postgres writes in drizzle's string mode
    '2026-10-27 12:34:56+00',
    '2026-10-27T12:34:56.123Z',
    '2026-10-27T12:34:56+05:30',
    '2026-10-27 12:34:56.5-0700',
    '2024-02-29T00:00:00Z', // a real leap day
  ])('accepts what the API itself issues: %s', (createdAt) => {
    expect(parseTimeCursor(encodeCursor({ createdAt, id: ID }))).toEqual({ createdAt, id: ID });
  });

  it.each([
    ['not a timestamp', { createdAt: 'not-a-date', id: ID }],
    ['a date that does not exist (Postgres refuses it)', { createdAt: '2026-02-31T00:00:00Z', id: ID }],
    ['a leap day in a common year', { createdAt: '2025-02-29T00:00:00Z', id: ID }],
    ['month 13', { createdAt: '2026-13-01T00:00:00Z', id: ID }],
    ['hour 24', { createdAt: '2026-10-27T24:00:00Z', id: ID }],
    ['an offset of 99 hours', { createdAt: '2026-10-27T00:00:00+99:00', id: ID }],
    ['five-digit years', { createdAt: '99999-99-99T99:99:99Z', id: ID }],
    ['SQL in the timestamp', { createdAt: "2026-10-27'; drop table users;--", id: ID }],
    ['a timestamp with no zone', { createdAt: '2026-10-27T12:34:56', id: ID }],
    ['an id that is not a uuid', { createdAt: '2026-10-27T12:34:56Z', id: "1' or '1'='1" }],
    ['numbers for text', { createdAt: 1_790_000_000, id: 42 }],
    ['a missing id', { createdAt: '2026-10-27T12:34:56Z' }],
    ['a missing timestamp', { id: ID }],
    ['objects for text', { createdAt: { $gt: '' }, id: [ID] }],
    ['an empty object', {}],
  ])('refuses %s', (_label, payload) => {
    rejects(() => parseTimeCursor(forged(payload)));
  });

  it.each([['not base64 json'], ['%%%'], ['e30'], [forged([1, 2, 3])], [forged('text')], [forged(null)], [''], [' ']])(
    'refuses something that does not decode to a cursor: %j',
    (cursor) => {
      rejects(() => parseTimeCursor(cursor));
    },
  );
});

describe('parseScoreCursor', () => {
  it('means "first page" when there is no cursor', () => {
    expect(parseScoreCursor(undefined)).toBeNull();
  });

  it.each([0, 0.5, 87, 100, -3.25])('accepts a score the API issues: %d', (score) => {
    expect(parseScoreCursor(encodeCursor({ score, id: ID }))).toEqual({ score, id: ID });
  });

  it('refuses an infinite score: the text 1e999 parses to Infinity, which JSON.stringify cannot round-trip', () => {
    const raw = Buffer.from(`{"score":1e999,"id":"${ID}"}`, 'utf8').toString('base64url');
    rejects(() => parseScoreCursor(raw));
  });

  it.each([
    ['text for the score', { score: '87', id: ID }],
    ['a huge score', { score: 1e12, id: ID }],
    ['a missing score', { id: ID }],
    ['an id that is not a uuid', { score: 1, id: 'x' }],
    ['a missing id', { score: 1 }],
  ])('refuses %s', (_label, payload) => {
    rejects(() => parseScoreCursor(forged(payload)));
  });
});
