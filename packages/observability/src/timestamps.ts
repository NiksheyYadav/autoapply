import type { FastifyInstance } from 'fastify';

/**
 * Postgres renders `timestamptz` as `2026-10-27 12:59:21.123456+00`: a space
 * instead of `T`, up to microseconds, and an hour-only offset. Chrome and
 * Node happen to parse that, but Safari/iOS return `Invalid Date`, and it does
 * not satisfy `isoTimestampSchema` either. Responses are therefore normalised
 * to strict ISO 8601 UTC (`2026-10-27T12:59:21.123Z`) on the way out.
 */
const PG_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)$/;

/** Only fields named like `created_at` / `last_event_at` are touched, never free text. */
const TIMESTAMP_KEY = /_at$/;

/** Returns strict ISO UTC for a Postgres/ISO-like timestamp string, or `undefined` if it is not one. */
export function toIsoTimestamp(value: string): string | undefined {
  const match = PG_TIMESTAMP.exec(value);
  if (!match) return undefined;
  const [, date, time, fraction = '', zone = 'Z'] = match;
  // ECMAScript's date-time format has exactly millisecond precision.
  const millis = fraction.slice(0, 3).padEnd(3, '0');
  let offset = zone;
  if (zone !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    offset = `${zone[0]}${digits.slice(0, 2)}:${digits.slice(2, 4).padEnd(2, '0')}`;
  }
  const parsed = new Date(`${date}T${time}.${millis}${offset}`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Deep-copies `value` converting timestamp strings under `*_at` keys to ISO.
 * Anything else (including `Date`s, which already serialise to ISO) is returned
 * untouched, and unchanged subtrees are returned by reference.
 */
export function normalizeTimestamps<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const converted = walk(item);
      if (converted !== item) changed = true;
      return converted;
    });
    return changed ? next : value;
  }
  if (!isPlainObject(value)) return value;

  let copy: Record<string, unknown> | undefined;
  for (const [key, child] of Object.entries(value)) {
    let converted: unknown;
    if (typeof child === 'string' && TIMESTAMP_KEY.test(key)) {
      converted = toIsoTimestamp(child) ?? child;
    } else {
      converted = walk(child);
    }
    if (converted !== child) {
      copy ??= { ...value };
      copy[key] = converted;
    }
  }
  return copy ?? value;
}

/**
 * Normalises `*_at` timestamps in every JSON response body of `app`.
 *
 * Callback-style on purpose, not `async`: most routes here finish with
 * `reply.send(...)` and no `return reply`. An async hook in the send pipeline
 * adds a microtask tick, so Fastify's promise wrapper sees "not sent yet" and
 * sends a second time ("Reply was already sent"). A hook that calls `done`
 * synchronously keeps the timing identical to having no hook at all.
 */
export function registerIsoTimestamps(app: FastifyInstance): void {
  app.addHook('preSerialization', (_request, _reply, payload, done) => {
    done(null, normalizeTimestamps(payload));
  });
}
