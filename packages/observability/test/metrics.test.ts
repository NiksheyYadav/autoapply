import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createMetricsRegistry, metricsRoute, registerHttpMetrics } from '../src/index.js';

function buildTestApp() {
  const app = Fastify();
  const metrics = createMetricsRegistry('test-service');
  registerHttpMetrics(app, metrics);
  metricsRoute(app, metrics);
  app.get('/v1/widgets/:id', async () => ({ ok: true }));
  return { app, metrics };
}

describe('observability metrics', () => {
  it('exposes Prometheus text format on GET /metrics', async () => {
    const { app } = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('# HELP http_requests_total');
  });

  it('counts a request by its route pattern, not the raw URL', async () => {
    const { app } = buildTestApp();
    await app.inject({ method: 'GET', url: '/v1/widgets/abc-123' });
    await app.inject({ method: 'GET', url: '/v1/widgets/xyz-789' });

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    // Both requests roll up under the route pattern, not two separate label sets per id.
    expect(res.body).toContain('route="/v1/widgets/:id"');
    expect(res.body).not.toContain('abc-123');
    expect(res.body).not.toContain('xyz-789');
    expect(res.body).toMatch(/http_requests_total\{[^}]*route="\/v1\/widgets\/:id"[^}]*\} 2/);
  });

  it('records request duration', async () => {
    const { app } = buildTestApp();
    await app.inject({ method: 'GET', url: '/v1/widgets/1' });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain('http_request_duration_seconds_bucket');
  });

  it('labels the service via default labels', async () => {
    const { app } = buildTestApp();
    await app.inject({ method: 'GET', url: '/v1/widgets/1' });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain('service="test-service"');
  });
});
