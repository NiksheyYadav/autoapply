import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { uuidSchema } from '@atlas/types';
import { newTraceContext } from '@atlas/utils';
import { createEvent, derivedEventId } from '../src/index.js';

describe('derivedEventId', () => {
  it('is deterministic for the same parent and key', () => {
    const parent = randomUUID();
    expect(derivedEventId(parent, 'job.scored:a:b')).toBe(derivedEventId(parent, 'job.scored:a:b'));
  });

  it('differs by parent event and by key', () => {
    const [parentA, parentB] = [randomUUID(), randomUUID()];
    const ids = new Set([
      derivedEventId(parentA, 'k1'),
      derivedEventId(parentA, 'k2'),
      derivedEventId(parentB, 'k1'),
    ]);
    expect(ids.size).toBe(3);
  });

  it('is a valid UUID that an event envelope accepts', () => {
    const id = derivedEventId(randomUUID(), 'learning.updated:v1');
    expect(uuidSchema.safeParse(id).success).toBe(true);
    expect(id[14]).toBe('5');
  });
});

describe('createEvent', () => {
  const payload = { model_version: 'v1', samples: 1, metric: 'score_lift', value: 0.5 };

  it('generates a fresh event id by default', () => {
    const [a, b] = [
      createEvent('learning.updated', payload, newTraceContext()),
      createEvent('learning.updated', payload, newTraceContext()),
    ];
    expect(a.event_id).not.toBe(b.event_id);
  });

  it('uses a supplied event id and still validates the payload', () => {
    const eventId = derivedEventId(randomUUID(), 'learning.updated:v1');
    const event = createEvent(
      'learning.updated',
      payload,
      newTraceContext(),
      '2026-01-01T00:00:00.000Z',
      eventId,
    );
    expect(event.event_id).toBe(eventId);
    expect(event.occurred_at).toBe('2026-01-01T00:00:00.000Z');
    expect(() =>
      createEvent(
        'learning.updated',
        { ...payload, samples: -1 },
        newTraceContext(),
        undefined,
        eventId,
      ),
    ).toThrow();
  });
});
