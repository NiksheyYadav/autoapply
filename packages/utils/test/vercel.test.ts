import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  SERVERLESS_DEFAULT_MESSAGING_DRIVER,
  SERVERLESS_PLACEHOLDER_PORT,
  createVercelHandler,
  withServerlessEnvDefaults,
} from '../src/vercel.js';

const req = { url: '/health' } as IncomingMessage;
const res = {} as ServerResponse;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('createVercelHandler', () => {
  it('boots eagerly but dispatches onto the server only once the app is ready', async () => {
    const boot = deferred();
    const emit = vi.fn(() => true);
    const ready = vi.fn(() => boot.promise);
    const handler = createVercelHandler({ ready, server: { emit } });

    // Plugin boot overlaps cold-start init: it starts before any request arrives.
    expect(ready).toHaveBeenCalledTimes(1);

    const pending = handler(req, res);
    await Promise.resolve();
    expect(emit).not.toHaveBeenCalled();

    boot.resolve();
    await pending;
    expect(emit).toHaveBeenCalledExactlyOnceWith('request', req, res);

    // Later requests reuse the one boot rather than re-running it.
    await handler(req, res);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('surfaces a failed boot on every request without an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const emit = vi.fn(() => true);
      const handler = createVercelHandler({
        ready: () => Promise.reject(new Error('plugin boot failed')),
        server: { emit },
      });

      // No request has attached to the boot promise yet: let a tick pass so a
      // missing catch would show up as an unhandled rejection.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();

      await expect(handler(req, res)).rejects.toThrow('plugin boot failed');
      await expect(handler(req, res)).rejects.toThrow('plugin boot failed');
      expect(emit).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('accepts fastify-style thenables whose `ready()` resolves to undefined', async () => {
    const emit = vi.fn(() => true);
    const thenable: PromiseLike<undefined> = {
      then: (onFulfilled) => Promise.resolve(undefined).then(onFulfilled),
    };
    const handler = createVercelHandler({ ready: () => thenable, server: { emit } });

    await handler(req, res);
    expect(emit).toHaveBeenCalledOnce();
  });
});

describe('withServerlessEnvDefaults', () => {
  it('leaves the source untouched outside Vercel so PORT stays required', () => {
    const source = { DATABASE_URL: 'postgres://example' };
    expect(withServerlessEnvDefaults(source)).toBe(source);
    expect(withServerlessEnvDefaults(source)).not.toHaveProperty('PORT');
  });

  it('supplies a placeholder PORT and the durable event driver on Vercel without mutating the source', () => {
    const source = { VERCEL: '1', DATABASE_URL: 'postgres://example' };
    const result = withServerlessEnvDefaults(source);
    expect(result).toEqual({
      ...source,
      PORT: SERVERLESS_PLACEHOLDER_PORT,
      MESSAGING_DRIVER: SERVERLESS_DEFAULT_MESSAGING_DRIVER,
    });
    expect(source).not.toHaveProperty('PORT');
    expect(source).not.toHaveProperty('MESSAGING_DRIVER');
  });

  it('keeps an explicitly configured PORT on Vercel', () => {
    expect(withServerlessEnvDefaults({ VERCEL: '1', PORT: '8080' }).PORT).toBe('8080');
  });

  it('defaults to the postgres outbox on Vercel because the in-memory broker cannot cross functions', () => {
    expect(SERVERLESS_DEFAULT_MESSAGING_DRIVER).toBe('postgres');
    expect(withServerlessEnvDefaults({ VERCEL: '1' }).MESSAGING_DRIVER).toBe('postgres');
  });

  it('keeps an explicitly configured MESSAGING_DRIVER on Vercel', () => {
    expect(withServerlessEnvDefaults({ VERCEL: '1', MESSAGING_DRIVER: 'rabbitmq' }).MESSAGING_DRIVER).toBe('rabbitmq');
  });

  // `.env.example` says MESSAGING_DRIVER=memory for local work; pasted into the project's settings it
  // would drop every cross-service event on Vercel, each function being its own process.
  it.each([['memory'], ['MEMORY'], [' memory '], [''], ['  ']])(
    'does not honour MESSAGING_DRIVER=%j on Vercel: the in-memory broker cannot cross functions',
    (configured) => {
      expect(withServerlessEnvDefaults({ VERCEL: '1', MESSAGING_DRIVER: configured }).MESSAGING_DRIVER).toBe('postgres');
    },
  );

  it('still honours the memory driver outside Vercel, for local work and tests', () => {
    expect(withServerlessEnvDefaults({ MESSAGING_DRIVER: 'memory' }).MESSAGING_DRIVER).toBe('memory');
  });

  it('does not default MESSAGING_DRIVER outside Vercel, so local dev and tests keep the memory broker', () => {
    expect(withServerlessEnvDefaults({}).MESSAGING_DRIVER).toBeUndefined();
  });

  it('does not invent any genuine configuration (database, auth, secrets)', () => {
    const result = withServerlessEnvDefaults({ VERCEL: '1' });
    expect(Object.keys(result).sort()).toEqual(['MESSAGING_DRIVER', 'PORT', 'VERCEL']);
  });
});
