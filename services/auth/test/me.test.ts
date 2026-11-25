import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createDatabase, type DatabaseHandle } from '@atlas/db';
import { createLocalDriver } from '@atlas/storage';
import { createSilentLogger } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadAuthServiceEnv } from '../src/env.js';
import { getMembershipPermissions } from '../src/repo/organizations.js';
import { findUserById, toPublicUser } from '../src/repo/users.js';
import type * as UsersModule from '../src/repo/users.js';

// The two repo lookups are replaced so no database is needed; token verification is NOT mocked:
// it runs for real against a locally generated key served through a stubbed JWKS fetch.
vi.mock('../src/repo/organizations.js', () => ({ getMembershipPermissions: vi.fn() }));
vi.mock('../src/repo/users.js', async (importOriginal) => ({
  ...(await importOriginal<typeof UsersModule>()),
  findUserById: vi.fn(),
}));

const SUPABASE_URL = 'https://test-project.supabase.co';
const ISSUER = `${SUPABASE_URL}/auth/v1`;
// Nothing listens on port 1; the mocked lookups mean the database is never used.
const UNREACHABLE_DATABASE_URL = 'postgres://atlas:atlas@127.0.0.1:1/atlas_auth_me';

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
type UserRow = NonNullable<Awaited<ReturnType<typeof findUserById>>>;

const USER_ID = randomUUID();
const ORG_ID = randomUUID();
const EMAIL = 'me-test@example.test';

const userRow: UserRow = {
  userId: USER_ID,
  email: EMAIL,
  fullName: 'Me Tester',
  authProvider: 'password',
  emailVerified: true,
  mfaEnabled: false,
  createdAt: '2026-01-02T03:04:05.000Z',
} as UserRow;

const findUser = vi.mocked(findUserById);
const lookupPermissions = vi.mocked(getMembershipPermissions);

let signingKey: SigningKey;
let jwk: JWK;
let jwksStatus: number;
const opened: Array<{ app: FastifyInstance; handle: DatabaseHandle }> = [];

beforeEach(async () => {
  const pair = await generateKeyPair('ES256');
  signingKey = pair.privateKey;
  jwk = await exportJWK(pair.publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  jwksStatus = 200;
  // createRemoteJWKSet fetches over HTTP: serve the local key instead of a real Supabase project.
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(jwksStatus === 200 ? JSON.stringify({ keys: [jwk] }) : 'upstream down', {
        status: jwksStatus,
        headers: { 'content-type': 'application/json' },
      }),
  );
  findUser.mockReset();
  lookupPermissions.mockReset();
});

afterEach(async () => {
  for (const { app, handle } of opened.splice(0)) {
    await app.close();
    await handle.close();
  }
  vi.unstubAllGlobals();
});

async function build(): Promise<FastifyInstance> {
  const env = loadAuthServiceEnv({
    DATABASE_URL: UNREACHABLE_DATABASE_URL,
    PORT: '4001',
    SUPABASE_URL,
    LOG_LEVEL: 'fatal',
    RATE_LIMIT_MAX: '100000',
  });
  const handle = createDatabase({ url: env.DATABASE_URL });
  const app = buildApp({
    db: handle.db,
    sql: handle.sql,
    env,
    logger: createSilentLogger(),
    tokenVerifier: createTokenVerifierConfig(env),
    storage: createLocalDriver({ root: join(tmpdir(), 'atlas-auth-me-test') }),
  });
  opened.push({ app, handle });
  await app.ready();
  return app;
}

interface TokenOptions {
  key?: SigningKey;
  issuer?: string;
  audience?: string;
  /** Seconds since the epoch; `null` leaves the claim out. */
  expiresAt?: number | null;
  appMetadata?: Record<string, unknown>;
  sub?: string;
}

async function sign(options: TokenOptions = {}): Promise<string> {
  const jwt = new SignJWT({
    session_id: randomUUID(),
    email: EMAIL,
    app_metadata: options.appMetadata ?? { org_id: ORG_ID, role: 'admin' },
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setSubject(options.sub ?? USER_ID)
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? 'authenticated')
    .setIssuedAt(Math.floor(Date.now() / 1000) - 3600);
  if (options.expiresAt !== null) {
    jwt.setExpirationTime(options.expiresAt ?? Math.floor(Date.now() / 1000) + 900);
  }
  return jwt.sign(options.key ?? signingKey);
}

async function getMe(app: FastifyInstance, authorization?: string) {
  return app.inject({
    method: 'GET',
    url: '/v1/auth/me',
    headers: authorization === undefined ? {} : { authorization },
  });
}

function expectUnauthenticated(res: Awaited<ReturnType<typeof getMe>>): void {
  expect(res.statusCode).toBe(401);
  expect(res.json().error.code).toBe('UNAUTHENTICATED');
  expect(findUser).not.toHaveBeenCalled();
  expect(lookupPermissions).not.toHaveBeenCalled();
}

describe('GET /v1/auth/me: authentication', () => {
  it('answers 401 UNAUTHENTICATED with no Authorization header, without any lookup', async () => {
    const app = await build();
    expectUnauthenticated(await getMe(app));
  });

  it.each([
    ['a non-Bearer scheme', 'Basic dXNlcjpwYXNz'],
    ['a lowercase scheme', 'bearer abc'],
    ['an empty bearer token', 'Bearer '],
    ['a blank bearer token', 'Bearer    '],
  ])('answers 401 for %s', async (_label, header) => {
    const app = await build();
    expectUnauthenticated(await getMe(app, header));
  });

  it('answers 401 for a garbage token', async () => {
    const app = await build();
    expectUnauthenticated(await getMe(app, 'Bearer not-a-jwt'));
  });

  it('answers 401 for a token signed by a different key than the one the JWKS serves', async () => {
    const app = await build();
    const other = await generateKeyPair('ES256');
    expectUnauthenticated(await getMe(app, `Bearer ${await sign({ key: other.privateKey })}`));
  });

  it('answers 401 for an expired token', async () => {
    const app = await build();
    const token = await sign({ expiresAt: Math.floor(Date.now() / 1000) - 60 });
    const res = await getMe(app, `Bearer ${token}`);
    expectUnauthenticated(res);
    expect(res.json().error.message).toBe('Access token has expired');
  });

  it('answers 401 for a token from another issuer', async () => {
    const app = await build();
    const token = await sign({ issuer: 'https://other-project.supabase.co/auth/v1' });
    expectUnauthenticated(await getMe(app, `Bearer ${token}`));
  });

  it('answers 401 for a token with the wrong audience', async () => {
    const app = await build();
    expectUnauthenticated(await getMe(app, `Bearer ${await sign({ audience: 'anon' })}`));
  });

  it('answers 401 for a token with no exp claim, rather than treating it as never expiring', async () => {
    const app = await build();
    expectUnauthenticated(await getMe(app, `Bearer ${await sign({ expiresAt: null })}`));
  });

  it('answers 401 when the claims do not have the shape Supabase stamps in', async () => {
    const app = await build();
    expectUnauthenticated(await getMe(app, `Bearer ${await sign({ sub: 'not-a-uuid' })}`));
    expectUnauthenticated(
      await getMe(app, `Bearer ${await sign({ appMetadata: { org_id: ORG_ID, role: 'superuser' } })}`),
    );
  });

  it('answers 503 UPSTREAM_UNAVAILABLE, not 401, when the key set cannot be fetched', async () => {
    jwksStatus = 500;
    const app = await build();
    const res = await getMe(app, `Bearer ${await sign()}`);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(findUser).not.toHaveBeenCalled();
    expect(lookupPermissions).not.toHaveBeenCalled();
  });
});

describe('GET /v1/auth/me: response', () => {
  it('returns the user, the token org and role, and the permissions looked up from the database', async () => {
    findUser.mockResolvedValue(userRow);
    lookupPermissions.mockResolvedValue({ can_view_analytics: true });
    const app = await build();

    const res = await getMe(
      app,
      // Permissions claimed inside the token must be ignored in favour of the lookup.
      `Bearer ${await sign({ appMetadata: { org_id: ORG_ID, role: 'admin', permissions: { can_manage_members: true } } })}`,
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      user: toPublicUser(userRow),
      organization_id: ORG_ID,
      role: 'admin',
      permissions: { can_view_analytics: true },
    });
    expect(findUser).toHaveBeenCalledTimes(1);
    expect(findUser.mock.calls[0]![1]).toBe(USER_ID);
    expect(lookupPermissions).toHaveBeenCalledTimes(1);
    expect(lookupPermissions.mock.calls[0]![1]).toBe(USER_ID);
    expect(lookupPermissions.mock.calls[0]![2]).toBe(ORG_ID);
    // Both lookups get the same database handle the app was built with.
    expect(lookupPermissions.mock.calls[0]![0]).toBe(findUser.mock.calls[0]![0]);
  });

  it('does not expose secret columns of the user row', async () => {
    findUser.mockResolvedValue({
      ...userRow,
      passwordHash: 'SECRET-HASH',
      mfaSecret: 'SECRET-MFA',
    } as UserRow);
    lookupPermissions.mockResolvedValue({});
    const app = await build();

    const res = await getMe(app, `Bearer ${await sign()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('SECRET-HASH');
    expect(res.body).not.toContain('SECRET-MFA');
    expect(Object.keys(res.json().user).sort()).toEqual([
      'auth_provider',
      'created_at',
      'email',
      'email_verified',
      'full_name',
      'mfa_enabled',
      'user_id',
    ]);
  });

  it('returns a null organization, a null role and empty permissions for a user with no organization', async () => {
    findUser.mockResolvedValue(userRow);
    lookupPermissions.mockResolvedValue({});
    const app = await build();

    const res = await getMe(
      app,
      `Bearer ${await sign({ appMetadata: { org_id: null, role: null } })}`,
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      user: toPublicUser(userRow),
      organization_id: null,
      role: null,
      permissions: {},
    });
    expect(lookupPermissions.mock.calls[0]![1]).toBe(USER_ID);
    expect(lookupPermissions.mock.calls[0]![2]).toBeNull();
  });

  it('treats a token with no app_metadata at all as having no organization', async () => {
    findUser.mockResolvedValue(userRow);
    lookupPermissions.mockResolvedValue({});
    const app = await build();

    const res = await getMe(app, `Bearer ${await sign({ appMetadata: {} })}`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ organization_id: null, role: null, permissions: {} });
  });

  it('answers 404 USER_NOT_FOUND when the token is valid but the user row is gone', async () => {
    findUser.mockResolvedValue(null);
    const app = await build();

    const res = await getMe(app, `Bearer ${await sign()}`);

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({
      code: 'USER_NOT_FOUND',
      message: 'User no longer exists',
    });
    // The permission lookup is skipped once the user is known to be gone.
    expect(lookupPermissions).not.toHaveBeenCalled();
  });
});
