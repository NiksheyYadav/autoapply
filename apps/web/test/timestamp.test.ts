import { describe, expect, it } from 'vitest';
import { formatServiceDate, parseServiceTimestamp } from '../src/components/applications/timestamp';

describe('parseServiceTimestamp', () => {
  it('reads the Postgres-style string the applications service returns', () => {
    const date = parseServiceTimestamp('2026-10-27 12:59:21.123+00');
    expect(date?.toISOString()).toBe('2026-10-27T12:59:21.123Z');
  });

  it.each([
    ['2026-10-27T12:59:21.123Z', '2026-10-27T12:59:21.123Z'],
    ['2026-10-27T12:59:21Z', '2026-10-27T12:59:21.000Z'],
    ['2026-10-27T12:59:21.123+00:00', '2026-10-27T12:59:21.123Z'],
    ['2026-10-27 12:59:21+00', '2026-10-27T12:59:21.000Z'],
    ['2026-10-27 12:59:21.5+00', '2026-10-27T12:59:21.500Z'],
    // Postgres emits microseconds; a Date holds milliseconds, so extra digits are truncated.
    ['2026-10-27 12:59:21.123456+00', '2026-10-27T12:59:21.123Z'],
    ['2026-10-27 12:59:21.999999+00', '2026-10-27T12:59:21.999Z'],
    // Offsets other than UTC are honoured.
    ['2026-10-27 12:59:21+02', '2026-10-27T10:59:21.000Z'],
    ['2026-10-27 12:59:21+0530', '2026-10-27T07:29:21.000Z'],
    ['2026-10-27 12:59:21-05:00', '2026-10-27T17:59:21.000Z'],
    // No offset at all means UTC (the backend only emits UTC).
    ['2026-10-27 12:59:21', '2026-10-27T12:59:21.000Z'],
    ['2026-10-27T12:59', '2026-10-27T12:59:00.000Z'],
    ['2026-10-27', '2026-10-27T00:00:00.000Z'],
    ['  2026-10-27 12:59:21.123+00  ', '2026-10-27T12:59:21.123Z'],
    ['2026-10-27 12:59:21.123z', '2026-10-27T12:59:21.123Z'],
  ])('parses %j', (input, iso) => {
    expect(parseServiceTimestamp(input)?.toISOString()).toBe(iso);
  });

  it('accepts a leap day only in a leap year', () => {
    expect(parseServiceTimestamp('2028-02-29 00:00:00+00')?.toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(parseServiceTimestamp('2026-02-29 00:00:00+00')).toBeNull();
  });

  it.each([
    ['2026-02-31 10:00:00+00'], // Date would silently roll this over to March
    ['2026-04-31T10:00:00Z'],
    ['2026-13-01 10:00:00+00'],
    ['2026-00-10 10:00:00+00'],
    ['2026-10-00 10:00:00+00'],
    ['2026-10-27 24:00:00+00'],
    ['2026-10-27 12:60:00+00'],
    ['2026-10-27 12:59:60+00'],
    ['yesterday'],
    ['27/10/2026'],
    ['2026-10-27 12:59:21 PM'],
    ['2026-10-27T12:59:21.123+0'],
    ['1793105961123'],
    [''],
    ['   '],
  ])('returns null for %j rather than an Invalid Date', (input) => {
    expect(parseServiceTimestamp(input)).toBeNull();
  });

  it.each([[null], [undefined], [1793105961123], [{}], [new Date()]])('returns null for the non-string %j', (input) => {
    expect(parseServiceTimestamp(input)).toBeNull();
  });

  it('never throws or yields an Invalid Date on arbitrary text', () => {
    for (const input of ['', 'x', '2026', '2026-', '2026-10-27T', '2026-10-27 12:', '\u0000', '9999-99-99 99:99:99+99']) {
      const parsed = parseServiceTimestamp(input);
      expect(parsed === null || !Number.isNaN(parsed.getTime())).toBe(true);
    }
  });
});

describe('formatServiceDate', () => {
  const options = { locale: 'en-US', timeZone: 'UTC' };

  it('formats the Postgres-style string as a short date', () => {
    expect(formatServiceDate('2026-10-27 12:59:21.123+00', options)).toBe('Oct 27, 2026');
  });

  it('uses the viewer-pinned time zone', () => {
    expect(formatServiceDate('2026-10-27 23:30:00+00', { ...options, timeZone: 'Asia/Tokyo' })).toBe('Oct 28, 2026');
  });

  it('falls back instead of printing "Invalid Date"', () => {
    expect(formatServiceDate('garbage', options)).toBe('Unknown date');
    expect(formatServiceDate(null, options)).toBe('Unknown date');
    expect(formatServiceDate(undefined, { ...options, fallback: 'recently' })).toBe('recently');
  });
});
