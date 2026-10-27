import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { normalizeTimestamps, registerIsoTimestamps, toIsoTimestamp } from '../src/timestamps.js';

describe('toIsoTimestamp', () => {
  it.each([
    ['2026-10-27 12:59:21.123+00', '2026-10-27T12:59:21.123Z'],
    ['2026-10-27 12:59:21+00', '2026-10-27T12:59:21.000Z'],
    ['2026-10-27 12:59:21.123456+00', '2026-10-27T12:59:21.123Z'],
    ['2026-10-27 12:59:21.5+00:00', '2026-10-27T12:59:21.500Z'],
    ['2026-10-27 18:29:21.123+05:30', '2026-10-27T12:59:21.123Z'],
    ['2026-10-27 12:59:21.123-0800', '2026-10-27T20:59:21.123Z'],
    ['2026-10-27T12:59:21.123Z', '2026-10-27T12:59:21.123Z'],
  ])('converts %s', (input, expected) => {
    const iso = toIsoTimestamp(input);
    expect(iso).toBe(expected);
    // Strict ISO 8601 UTC: it round-trips through Date unchanged.
    expect(new Date(iso as string).toISOString()).toBe(iso);
  });

  it.each(['', 'yesterday', '2026-10-27', '2026-13-45 99:99:99+00', 'prefix 2026-10-27 12:59:21+00'])(
    'leaves %j alone',
    (input) => {
      expect(toIsoTimestamp(input)).toBeUndefined();
    },
  );
});

describe('normalizeTimestamps', () => {
  it('converts *_at fields at any depth, in arrays and nested objects', () => {
    const body = {
      items: [{ application_id: 'a', created_at: '2026-10-27 12:59:21.123+00', job: { posted_at: '2026-10-01 00:00:00+00' } }],
      next_cursor: null,
      generated_at: '2026-10-27 13:00:00+00',
    };
    expect(normalizeTimestamps(body)).toEqual({
      items: [{ application_id: 'a', created_at: '2026-10-27T12:59:21.123Z', job: { posted_at: '2026-10-01T00:00:00.000Z' } }],
      next_cursor: null,
      generated_at: '2026-10-27T13:00:00.000Z',
    });
  });

  it('never rewrites free text, even when it looks like a timestamp', () => {
    const body = { description: '2026-10-27 12:59:21+00', note: '2026-10-27 12:59:21+00', title: 'x_at' };
    expect(normalizeTimestamps(body)).toBe(body);
  });

  it('does not touch non-timestamp *_at values and does not mutate its input', () => {
    const body = { retry_at: 'later', created_at: '2026-10-27 12:59:21+00', count: 3 };
    const snapshot = structuredClone(body);
    const result = normalizeTimestamps(body);
    expect(result).toEqual({ retry_at: 'later', created_at: '2026-10-27T12:59:21.000Z', count: 3 });
    expect(body).toEqual(snapshot);
  });

  it('returns unchanged structures by reference', () => {
    const body = { items: [{ created_at: '2026-10-27T12:59:21.123Z' }] };
    expect(normalizeTimestamps(body)).toBe(body);
  });

  it('passes primitives, nulls and Dates through', () => {
    const when = new Date('2026-10-27T12:59:21.123Z');
    expect(normalizeTimestamps(null)).toBeNull();
    expect(normalizeTimestamps(3)).toBe(3);
    expect(normalizeTimestamps({ created_at: when })).toEqual({ created_at: when });
  });
});

describe('registerIsoTimestamps', () => {
  it('normalises JSON responses and leaves non-JSON bodies alone', async () => {
    const app = Fastify();
    registerIsoTimestamps(app);
    // Mirrors services/admin: an async onSend hook that does not take the payload.
    app.addHook('onSend', async (_request, reply) => {
      reply.header('cache-control', 'no-store');
    });
    app.get('/json', async () => ({ created_at: '2026-10-27 12:59:21.123+00' }));
    // The house style: an async handler that calls reply.send() and does NOT `return reply`.
    app.get('/no-return', async (_request, reply) => {
      reply.status(201).send({ created_at: '2026-10-27 12:59:21+00' });
    });
    app.get('/text', async (_request, reply) => reply.type('text/plain').send('created_at: 2026-10-27 12:59:21+00'));

    const json = await app.inject({ method: 'GET', url: '/json' });
    expect(json.json()).toEqual({ created_at: '2026-10-27T12:59:21.123Z' });
    const noReturn = await app.inject({ method: 'GET', url: '/no-return' });
    expect(noReturn.statusCode).toBe(201);
    expect(noReturn.json()).toEqual({ created_at: '2026-10-27T12:59:21.000Z' });
    const text = await app.inject({ method: 'GET', url: '/text' });
    expect(text.body).toBe('created_at: 2026-10-27 12:59:21+00');
    await app.close();
  });
});
