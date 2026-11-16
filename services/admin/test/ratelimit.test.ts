import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ADMIN_BASE, createHarness, importJson, testDatabaseUrl, type Harness } from './support.js';

async function withOwner<T>(
  harness: Harness,
  run: (context: { organizationId: string; headers: Record<string, string> }) => Promise<T>,
): Promise<T> {
  const organizationId = await harness.seedOrganization('university');
  const owner = await harness.seedUser();
  await harness.addMember(organizationId, owner.userId, 'owner');
  return run({ organizationId, headers: await harness.authHeaders(owner.userId) });
}

// The rate limiter has to be wired so that it actually attaches to the API routes
// (see the comment in app.ts), and it has to run before authentication.
describe.skipIf(!testDatabaseUrl)('admin-service rate limiting', () => {
  it('throttles the import endpoint per client and answers 429 RATE_LIMITED', async () => {
    const h = await createHarness({ limits: { importRatePerMinute: 3 } });
    try {
      await withOwner(h, async ({ organizationId, headers }) => {
        const statuses: number[] = [];
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const res = await importJson(h, organizationId, headers, [
            { email: `nobody-${randomUUID()}@example.test`, full_name: 'N' },
          ]);
          statuses.push(res.statusCode);
          if (res.statusCode === 429) expect(res.json().error.code).toBe('RATE_LIMITED');
        }
        expect(statuses).toEqual([200, 200, 200, 429, 429]);
      });
    } finally {
      await h.close();
    }
  });

  it('throttles the export endpoint', async () => {
    const h = await createHarness({ limits: { exportRatePerMinute: 2 } });
    try {
      await withOwner(h, async ({ organizationId, headers }) => {
        const statuses: number[] = [];
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const res = await h.app.inject({
            method: 'GET',
            url: `${ADMIN_BASE}/${organizationId}/export.csv`,
            headers,
          });
          statuses.push(res.statusCode);
        }
        expect(statuses).toEqual([200, 200, 429, 429]);
      });
    } finally {
      await h.close();
    }
  });

  it('counts unauthenticated requests too, because the limiter runs before authentication', async () => {
    const h = await createHarness({ limits: { importRatePerMinute: 2 } });
    try {
      await withOwner(h, async ({ organizationId }) => {
        const statuses: number[] = [];
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const res = await h.app.inject({
            method: 'POST',
            url: `${ADMIN_BASE}/${organizationId}/students/import`,
            headers: { 'content-type': 'application/json' },
            payload: '{}',
          });
          statuses.push(res.statusCode);
        }
        expect(statuses).toEqual([401, 401, 429, 429]);
      });
    } finally {
      await h.close();
    }
  });

  it('applies the global limit to every API route but never to /health', async () => {
    const h = await createHarness({}, undefined, { RATE_LIMIT_MAX: '3' });
    try {
      await withOwner(h, async ({ organizationId, headers }) => {
        const statuses: number[] = [];
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const res = await h.app.inject({
            method: 'GET',
            url: `${ADMIN_BASE}/${organizationId}/funnel`,
            headers,
          });
          statuses.push(res.statusCode);
        }
        expect(statuses).toEqual([200, 200, 200, 429, 429]);

        for (let attempt = 0; attempt < 10; attempt += 1) {
          expect((await h.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
        }
      });
    } finally {
      await h.close();
    }
  });

  it('does not expose HEAD for the export (it would run the handler and audit with no body)', async () => {
    const h = await createHarness();
    try {
      await withOwner(h, async ({ organizationId, headers }) => {
        const res = await h.app.inject({
          method: 'HEAD',
          url: `${ADMIN_BASE}/${organizationId}/export.csv`,
          headers,
        });
        expect(res.statusCode).toBe(404);
        const audits = await h.handle.sql`
          select 1 from audit_logs where organization_id = ${organizationId}
        `;
        expect(audits).toHaveLength(0);
      });
    } finally {
      await h.close();
    }
  });
});
