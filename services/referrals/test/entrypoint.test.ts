import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as AtlasDb from '@atlas/db';
import type * as Worker from '../src/worker.js';

// The entrypoint builds env, logger, db and app at module scope, so every case re-imports it
// against a fresh environment. postgres.js connects lazily, which is why loading the module needs
// no live database; only the case that expects a healthy /health does, and it self-skips when
// ATLAS_TEST_DATABASE_URL is unset (see .env.example).
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;
// Nothing listens on port 1, so /health reports a degraded database instead of hanging.
const UNREACHABLE_DATABASE_URL = 'postgres://atlas:atlas@127.0.0.1:1/atlas_entrypoint_unreachable';

const tracked = vi.hoisted(() => ({
  closers: [] as Array<() => Promise<void>>,
  consumers: [] as string[],
}));

vi.mock('@atlas/db', async (importOriginal) => {
  const actual = await importOriginal<typeof AtlasDb>();
  return {
    ...actual,
    // Track every pool the entrypoint opens so each case can close it.
    createDatabase: (options: Parameters<typeof actual.createDatabase>[0]) => {
      const handle = actual.createDatabase(options);
      tracked.closers.push(() => handle.close());
      return handle;
    },
  };
});

vi.mock('../src/worker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Worker>();
  return {
    ...actual,
    registerConsumers: async (deps: Parameters<typeof actual.registerConsumers>[0]) => {
      const subscriptions = await actual.registerConsumers(deps);
      for (const subscription of subscriptions) {
        tracked.consumers.push(subscription.consumer);
        tracked.closers.push(() => subscription.stop());
      }
      return subscriptions;
    },
  };
});

const loadedApps: FastifyInstance[] = [];
const baselineSignalListeners = {
  SIGTERM: process.listeners('SIGTERM'),
  SIGINT: process.listeners('SIGINT'),
};

async function loadEntrypoint(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  const env: Record<string, string | undefined> = {
    VERCEL: '1',
    LOG_LEVEL: 'fatal',
    MESSAGING_DRIVER: 'memory',
    HOST: '127.0.0.1',
    DATABASE_URL: UNREACHABLE_DATABASE_URL,
    SUPABASE_URL: 'https://test-project.supabase.co',
    // Vercel does not provide a PORT; the entrypoint must cope without one.
    PORT: undefined,
    REFERRALS_SERVICE_PORT: undefined,
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

  const entrypoint = await import('../src/index.js');
  loadedApps.push(entrypoint.app);
  return entrypoint;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Serves one GET through `handler` over a real socket, the way Vercel hands it a request. */
async function getThrough(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  path: string,
): Promise<{ status: number; body: { status: string; service: string; checks: unknown } }> {
  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch('http://127.0.0.1:' + port + path);
    return { status: response.status, body: (await response.json()) as never };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(loadedApps.splice(0).map((app) => app.close()));
  await Promise.all(tracked.closers.splice(0).map((close) => close()));
  tracked.consumers.length = 0;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    for (const listener of process.listeners(signal)) {
      if (!baselineSignalListeners[signal].includes(listener)) process.off(signal, listener);
    }
  }
});

describe('referrals-service Vercel entrypoint', () => {
  it('loads without a PORT, exports a request handler and does not bind a socket', async () => {
    const entrypoint = await loadEntrypoint();

    expect(typeof entrypoint.default).toBe('function');
    expect(entrypoint.app.server.listening).toBe(false);
    expect(entrypoint.app.addresses()).toEqual([]);
    // Shutdown handlers belong to the long-lived local process only.
    expect(process.listeners('SIGTERM')).toEqual(baselineSignalListeners.SIGTERM);
    expect(process.listeners('SIGINT')).toEqual(baselineSignalListeners.SIGINT);
  });

  it('still registers its event consumers on Vercel', async () => {
    await loadEntrypoint();

    expect(tracked.consumers.length).toBeGreaterThan(0);
    for (const consumer of tracked.consumers) expect(consumer).toMatch(/^referrals-service\./);
  });

  it('wires the postgres driver to a drain route that is closed to callers without the cron secret', async () => {
    const secret = 'entrypoint-cron-secret-0123456789';
    const { app } = await loadEntrypoint({ MESSAGING_DRIVER: 'postgres', CRON_SECRET: secret });

    const anonymous = await app.inject({ method: 'POST', url: '/internal/drain' });
    expect(anonymous.statusCode).toBe(401);

    // An authorized call reaches the postgres broker, which then finds no database to drain: a
    // plain 500 (so Vercel Cron records a failure) rather than a hang or a silent 200.
    const failed = await app.inject({
      method: 'POST',
      url: '/internal/drain',
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(failed.statusCode).toBe(500);
  });

  it('keeps /internal/drain disabled on Vercel until CRON_SECRET is configured', async () => {
    const { app } = await loadEntrypoint({ MESSAGING_DRIVER: 'postgres' });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/drain',
      headers: { authorization: 'Bearer anything-at-all-0123456789' },
    });
    expect(response.statusCode).toBe(503);
  });

  it('serves /health through the default handler without any live infrastructure', async () => {
    const { default: handler } = await loadEntrypoint();

    const { status, body } = await getThrough(handler, '/health');

    expect(status).toBe(503);
    expect(body).toMatchObject({
      status: 'degraded',
      service: 'referrals-service',
      checks: { database: 'fail', broker: 'ok' },
    });
  });

  it.skipIf(!testDatabaseUrl)(
    'reports healthy through app.inject and the default handler when the database is reachable',
    async () => {
      const { app, default: handler } = await loadEntrypoint({ DATABASE_URL: testDatabaseUrl });

      const injected = await app.inject({ method: 'GET', url: '/health' });
      expect(injected.statusCode).toBe(200);
      expect(injected.json()).toMatchObject({ status: 'ok', service: 'referrals-service' });

      const { status, body } = await getThrough(handler, '/health');
      expect(status).toBe(200);
      expect(body).toMatchObject({ status: 'ok', service: 'referrals-service' });
    },
  );

  it('only defaults PORT: other missing configuration still fails fast on Vercel', async () => {
    const error = await loadEntrypoint({ DATABASE_URL: undefined }).then(
      () => undefined,
      (cause: unknown) => cause as Error,
    );

    expect(error?.name).toBe('ConfigError');
    expect(error?.message).toContain('DATABASE_URL');
    expect(error?.message).not.toContain('PORT');
  });

  it('keeps local dev intact: outside Vercel it listens on PORT and installs shutdown handlers', async () => {
    const port = await freePort();

    const entrypoint = await loadEntrypoint({ VERCEL: undefined, PORT: String(port) });

    expect(entrypoint.app.server.listening).toBe(true);
    expect((entrypoint.app.server.address() as AddressInfo).port).toBe(port);
    expect(process.listeners('SIGTERM')).toHaveLength(baselineSignalListeners.SIGTERM.length + 1);
    expect(process.listeners('SIGINT')).toHaveLength(baselineSignalListeners.SIGINT.length + 1);
  });
});
