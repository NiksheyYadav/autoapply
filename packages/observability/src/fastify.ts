import type { FastifyInstance } from 'fastify';
import type { MetricsRegistry } from './metrics.js';

declare module 'fastify' {
  interface FastifyRequest {
    metricsStartTime?: bigint;
  }
}

/**
 * Records count and duration for every request. Labeled by the registered
 * route pattern (`/v1/resumes/:id`), never the raw URL — using the raw path
 * would make cardinality grow with every distinct id ever requested.
 */
export function registerHttpMetrics(app: FastifyInstance, metrics: MetricsRegistry): void {
  app.decorateRequest('metricsStartTime', undefined);

  app.addHook('onRequest', async (request) => {
    request.metricsStartTime = process.hrtime.bigint();
  });

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? request.url;
    const labels = { method: request.method, route, status_code: String(reply.statusCode) };
    metrics.httpRequestsTotal.inc(labels);

    if (request.metricsStartTime !== undefined) {
      const elapsedSeconds = Number(process.hrtime.bigint() - request.metricsStartTime) / 1e9;
      metrics.httpRequestDurationSeconds.observe(labels, elapsedSeconds);
    }
  });
}

/** `GET /metrics` in Prometheus text exposition format. Unauthenticated, like every service's `/health` — scraped by infrastructure, not called by users. */
export function metricsRoute(app: FastifyInstance, metrics: MetricsRegistry): void {
  app.get('/metrics', async (_request, reply) => {
    reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });
}
