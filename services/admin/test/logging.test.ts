import { Writable } from 'node:stream';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serializeRequestForLog } from '../src/app.js';
import { ADMIN_BASE, createHarness, testDatabaseUrl, type Harness } from './support.js';

describe('serializeRequestForLog', () => {
  it('drops the query string but keeps the path and connection fields', () => {
    expect(
      serializeRequestForLog({
        method: 'GET',
        url: '/v1/admin/organizations/abc/students?search=ada%40uni.edu&limit=5',
        host: 'api.example.test',
        ip: '203.0.113.9',
        socket: { remotePort: 4321 },
      }),
    ).toEqual({
      method: 'GET',
      url: '/v1/admin/organizations/abc/students?[redacted]',
      host: 'api.example.test',
      remoteAddress: '203.0.113.9',
      remotePort: 4321,
    });
    expect(serializeRequestForLog({ method: 'GET', url: '/health' }).url).toBe('/health');
  });
});

describe.skipIf(!testDatabaseUrl)('admin-service request logging', () => {
  let h: Harness;
  const output: string[] = [];

  beforeAll(async () => {
    const sink = new Writable({
      write(chunk, _encoding, done) {
        output.push(String(chunk));
        done();
      },
    });
    h = await createHarness({}, pino({ level: 'info' }, sink));
  });

  afterAll(async () => {
    await h.close();
  });

  it('never writes search terms from the query string to the log', async () => {
    const org = await h.seedOrganization('university');
    const owner = await h.seedUser();
    await h.addMember(org, owner.userId, 'owner');
    const term = 'secret.person@example.test';

    const res = await h.app.inject({
      method: 'GET',
      url: `${ADMIN_BASE}/${org}/students?search=${encodeURIComponent(term)}`,
      headers: await h.authHeaders(owner.userId),
    });
    expect(res.statusCode).toBe(200);

    const logged = output.join('');
    expect(logged).toContain('incoming request');
    expect(logged).toContain(`${ADMIN_BASE}/${org}/students?[redacted]`);
    expect(logged).not.toContain('secret.person');
    expect(logged).not.toContain(encodeURIComponent(term));
    // …and the bearer token never appears either.
    expect(logged).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });
});
