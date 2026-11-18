/**
 * MemoryBroker behavior tests (backlog A2). No network, no timers: `sleep` is
 * injected as a recorder.
 *
 * Behavior gaps recorded here (documented, not invented or "fixed"):
 * - Failures after retries are swallowed: `publish` resolves even when a
 *   consumer is dead-lettered. The only signals are `deadLetters` and the
 *   `onDeadLetter` callback.
 * - Backoff jitter is not injectable, so delays are asserted as bands, not
 *   exact values.
 * - `attempt` passed to handlers is zero-based.
 * - `stop()` deletes the consumer registration: there is no redelivery and no
 *   persistence of events published while a consumer was absent.
 * - The `onDeadLetter` callback is unguarded (a throwing callback would
 *   propagate out of `publish`); that is not tested because it is not a
 *   stable contract.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@atlas/types';
import { newTraceContext } from '@atlas/utils';
import { createEvent, MemoryBroker, type DeadLetter } from '../src/index.js';

function learningEvent(): EventEnvelope<'learning.updated'> {
  return createEvent(
    'learning.updated',
    { model_version: 'v-test', samples: 3, metric: 'score_lift', value: 0.25 },
    newTraceContext(),
  );
}

function scoredEvent(): EventEnvelope<'job.scored'> {
  return createEvent(
    'job.scored',
    { job_id: randomUUID(), user_id: randomUUID(), score: 0.5, model_version: 'v-test' },
    newTraceContext(),
  );
}

function setup(options: { defaultMaxRetries?: number; onDeadLetter?: (l: DeadLetter) => void } = {}) {
  const delays: number[] = [];
  const broker = new MemoryBroker({
    ...options,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { broker, delays };
}

describe('MemoryBroker delivery', () => {
  it('delivers a published event once to a subscriber, without sleeping', async () => {
    const { broker, delays } = setup();
    const received: EventEnvelope[] = [];
    await broker.subscribe({
      consumer: 'c',
      eventTypes: ['learning.updated'],
      handler: async (envelope) => {
        received.push(envelope);
      },
    });
    const env = learningEvent();

    await broker.publish(env);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(env);
    expect(broker.published).toEqual([env]);
    expect(delays).toEqual([]);
  });

  it('filters by event type but still records everything as published', async () => {
    const { broker } = setup();
    let calls = 0;
    await broker.subscribe({
      consumer: 'c',
      eventTypes: ['learning.updated'],
      handler: async () => {
        calls += 1;
      },
    });
    const other = scoredEvent();

    await broker.publish(other);

    expect(calls).toBe(0);
    expect(broker.published).toEqual([other]);
  });

  it('resolves when there are no subscribers', async () => {
    const { broker } = setup();
    await expect(broker.publish(learningEvent())).resolves.toBeUndefined();
  });

  it('passes a zero-based attempt and the envelope trace in the context', async () => {
    const { broker } = setup();
    const seen: { attempt: number; trace: unknown }[] = [];
    await broker.subscribe({
      consumer: 'c',
      eventTypes: ['learning.updated'],
      maxRetries: 2,
      handler: async (_envelope, context) => {
        seen.push({ attempt: context.attempt, trace: context.trace });
        throw new Error('again');
      },
    });
    const env = learningEvent();

    await broker.publish(env);

    expect(seen.map((s) => s.attempt)).toEqual([0, 1, 2]);
    for (const s of seen) expect(s.trace).toEqual(env.trace);
  });
});

describe('MemoryBroker retries and dead letters', () => {
  it('retries once after a single failure and does not dead-letter', async () => {
    const { broker, delays } = setup();
    const attempts: number[] = [];
    await broker.subscribe({
      consumer: 'c',
      eventTypes: ['learning.updated'],
      handler: async (_e, context) => {
        attempts.push(context.attempt);
        if (attempts.length === 1) throw new Error('once');
      },
    });

    await broker.publish(learningEvent());

    expect(attempts).toEqual([0, 1]);
    expect(delays).toHaveLength(1);
    expect(broker.deadLetters).toEqual([]);
  });

  it('dead-letters after the default 3 retries, sleeping between but not after attempts', async () => {
    const { broker, delays } = setup();
    const attempts: number[] = [];
    await broker.subscribe({
      consumer: 'c',
      eventTypes: ['learning.updated'],
      handler: async (_e, context) => {
        attempts.push(context.attempt);
        throw new Error('boom');
      },
    });
    const env = learningEvent();

    await expect(broker.publish(env)).resolves.toBeUndefined();

    expect(attempts).toEqual([0, 1, 2, 3]);
    expect(delays).toHaveLength(3);
    expect(delays[0]).toBeGreaterThanOrEqual(350);
    expect(delays[0]).toBeLessThanOrEqual(650);
    expect(delays[1]).toBeGreaterThanOrEqual(700);
    expect(delays[1]).toBeLessThanOrEqual(1300);
    expect(delays[2]).toBeGreaterThanOrEqual(1400);
    expect(delays[2]).toBeLessThanOrEqual(2600);
    expect(broker.deadLetters).toHaveLength(1);
    const letter = broker.deadLetters[0]!;
    expect(letter.consumer).toBe('c');
    expect(letter.attempts).toBe(4);
    expect(letter.error).toBe('boom');
    expect(letter.envelope).toBe(env);
    expect(new Date(letter.deadLetteredAt).toISOString()).toBe(letter.deadLetteredAt);
  });

  it('stringifies a non-Error throw into the dead letter', async () => {
    const { broker } = setup();
    await broker.subscribe({
      consumer: 'c',
      eventTypes: ['learning.updated'],
      maxRetries: 0,
      handler: async () => {
        throw 'str';
      },
    });

    await broker.publish(learningEvent());

    expect(broker.deadLetters[0]?.error).toBe('str');
  });

  it('lets a subscription maxRetries override defaultMaxRetries', async () => {
    const { broker, delays } = setup({ defaultMaxRetries: 5 });
    const attempts: number[] = [];
    await broker.subscribe({
      consumer: 'c',
      eventTypes: ['learning.updated'],
      maxRetries: 1,
      handler: async (_e, context) => {
        attempts.push(context.attempt);
        throw new Error('x');
      },
    });

    await broker.publish(learningEvent());

    expect(attempts).toHaveLength(2);
    expect(delays).toHaveLength(1);
    expect(broker.deadLetters[0]?.attempts).toBe(2);
  });

  it('with maxRetries 0 tries once, never sleeps, and dead-letters', async () => {
    const { broker, delays } = setup();
    let calls = 0;
    await broker.subscribe({
      consumer: 'c',
      eventTypes: ['learning.updated'],
      maxRetries: 0,
      handler: async () => {
        calls += 1;
        throw new Error('x');
      },
    });

    await broker.publish(learningEvent());

    expect(calls).toBe(1);
    expect(delays).toEqual([]);
    expect(broker.deadLetters).toHaveLength(1);
    expect(broker.deadLetters[0]?.attempts).toBe(1);
  });

  it('uses the constructor defaultMaxRetries when the subscription has no override', async () => {
    const { broker } = setup({ defaultMaxRetries: 1 });
    let calls = 0;
    await broker.subscribe({
      consumer: 'c',
      eventTypes: ['learning.updated'],
      handler: async () => {
        calls += 1;
        throw new Error('x');
      },
    });

    await broker.publish(learningEvent());

    expect(calls).toBe(2);
  });

  it('isolates consumers: a failing one does not affect another', async () => {
    const { broker } = setup();
    let aCalls = 0;
    let bCalls = 0;
    await broker.subscribe({
      consumer: 'a',
      eventTypes: ['learning.updated'],
      maxRetries: 1,
      handler: async () => {
        aCalls += 1;
        throw new Error('a failed');
      },
    });
    await broker.subscribe({
      consumer: 'b',
      eventTypes: ['learning.updated'],
      handler: async () => {
        bCalls += 1;
      },
    });

    await expect(broker.publish(learningEvent())).resolves.toBeUndefined();

    expect(bCalls).toBe(1);
    expect(aCalls).toBe(2);
    expect(broker.deadLetters.map((l) => l.consumer)).toEqual(['a']);
  });

  it('keeps retry counters independent per consumer', async () => {
    const { broker } = setup();
    const aAttempts: number[] = [];
    const bAttempts: number[] = [];
    await broker.subscribe({
      consumer: 'a',
      eventTypes: ['learning.updated'],
      maxRetries: 1,
      handler: async (_e, context) => {
        aAttempts.push(context.attempt);
        throw new Error('a');
      },
    });
    await broker.subscribe({
      consumer: 'b',
      eventTypes: ['learning.updated'],
      maxRetries: 2,
      handler: async (_e, context) => {
        bAttempts.push(context.attempt);
        throw new Error('b');
      },
    });

    await broker.publish(learningEvent());

    expect(aAttempts).toEqual([0, 1]);
    expect(bAttempts).toEqual([0, 1, 2]);
    expect(broker.deadLetters.map((l) => [l.consumer, l.attempts])).toEqual(
      expect.arrayContaining([
        ['a', 2],
        ['b', 3],
      ]),
    );
  });

  it('calls onDeadLetter once with the recorded letter, and not on eventual success', async () => {
    const letters: DeadLetter[] = [];
    const { broker } = setup({ onDeadLetter: (letter) => letters.push(letter) });
    await broker.subscribe({
      consumer: 'bad',
      eventTypes: ['learning.updated'],
      maxRetries: 1,
      handler: async () => {
        throw new Error('x');
      },
    });

    await broker.publish(learningEvent());

    expect(letters).toHaveLength(1);
    expect(letters[0]).toBe(broker.deadLetters[0]);

    const ok = setup({ onDeadLetter: (letter) => letters.push(letter) });
    let calls = 0;
    await ok.broker.subscribe({
      consumer: 'flaky',
      eventTypes: ['learning.updated'],
      handler: async () => {
        calls += 1;
        if (calls === 1) throw new Error('once');
      },
    });
    await ok.broker.publish(learningEvent());

    expect(calls).toBe(2);
    expect(letters).toHaveLength(1);
  });
});

describe('MemoryBroker subscriptions and lifecycle', () => {
  it('rejects a duplicate consumer name and keeps the first subscription', async () => {
    const { broker } = setup();
    let first = 0;
    await broker.subscribe({
      consumer: 'x',
      eventTypes: ['learning.updated'],
      handler: async () => {
        first += 1;
      },
    });

    await expect(
      broker.subscribe({
        consumer: 'x',
        eventTypes: ['learning.updated'],
        handler: async () => undefined,
      }),
    ).rejects.toThrow('Consumer "x" is already subscribed');

    await broker.publish(learningEvent());
    expect(first).toBe(1);
  });

  it('stop() ends delivery, allows resubscribing, and is safe to call twice', async () => {
    const { broker } = setup();
    let calls = 0;
    const subscription = await broker.subscribe({
      consumer: 'x',
      eventTypes: ['learning.updated'],
      handler: async () => {
        calls += 1;
      },
    });

    await subscription.stop();
    await broker.publish(learningEvent());
    expect(calls).toBe(0);

    await expect(subscription.stop()).resolves.toBeUndefined();

    let again = 0;
    await broker.subscribe({
      consumer: 'x',
      eventTypes: ['learning.updated'],
      handler: async () => {
        again += 1;
      },
    });
    await broker.publish(learningEvent());
    expect(again).toBe(1);
    expect(calls).toBe(0);
  });

  it('close() clears registrations; publish still records but calls no handler', async () => {
    const { broker } = setup();
    let calls = 0;
    await broker.subscribe({
      consumer: 'x',
      eventTypes: ['learning.updated'],
      handler: async () => {
        calls += 1;
      },
    });

    await broker.close();
    const env = learningEvent();
    await broker.publish(env);

    expect(calls).toBe(0);
    expect(broker.published).toEqual([env]);
  });

  it('reports healthy', () => {
    expect(setup().broker.isHealthy()).toBe(true);
  });
});

describe('MemoryBroker test helpers', () => {
  it('publishedOf filters by type in order, and is empty for an unseen type', async () => {
    const { broker } = setup();
    const l1 = learningEvent();
    const s1 = scoredEvent();
    const l2 = learningEvent();
    await broker.publish(l1);
    await broker.publish(s1);
    await broker.publish(l2);

    expect(broker.publishedOf('learning.updated')).toEqual([l1, l2]);
    expect(broker.publishedOf('job.scored')).toEqual([s1]);
    expect(broker.publishedOf('outreach.sent')).toEqual([]);
  });

  it('reset() empties published and deadLetters in place and keeps subscriptions', async () => {
    const { broker } = setup();
    const published = broker.published;
    const deadLetters = broker.deadLetters;
    let calls = 0;
    await broker.subscribe({
      consumer: 'x',
      eventTypes: ['learning.updated'],
      maxRetries: 0,
      handler: async () => {
        calls += 1;
        throw new Error('x');
      },
    });
    await broker.publish(learningEvent());
    expect(published).toHaveLength(1);
    expect(deadLetters).toHaveLength(1);

    broker.reset();

    expect(broker.published).toBe(published);
    expect(broker.deadLetters).toBe(deadLetters);
    expect(published).toEqual([]);
    expect(deadLetters).toEqual([]);

    await broker.publish(learningEvent());
    expect(calls).toBe(2);
  });
});
