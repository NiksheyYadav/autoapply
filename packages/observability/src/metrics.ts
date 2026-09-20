import { collectDefaultMetrics, Counter, Histogram, Registry } from '@prometheus-io/client';

/**
 * docs/14 § Metrics starts with "request latency" and "error rate" — this is
 * that, generic across every service rather than reimplemented per service.
 * Business-specific metrics (queue depth, connector success rate, matching
 * precision) stay where the code that knows about them lives, added
 * incrementally as those consumers actually need to watch something.
 */
export interface MetricsRegistry {
  registry: Registry;
  httpRequestsTotal: Counter<'method' | 'route' | 'status_code'>;
  httpRequestDurationSeconds: Histogram<'method' | 'route' | 'status_code'>;
}

export function createMetricsRegistry(serviceName: string): MetricsRegistry {
  const registry = new Registry();
  registry.setDefaultLabels({ service: serviceName });
  collectDefaultMetrics({ register: registry });

  const httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests handled, labeled by route pattern (not raw URL, to keep cardinality bounded)',
    labelNames: ['method', 'route', 'status_code'],
    registers: [registry],
  });

  const httpRequestDurationSeconds = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  return { registry, httpRequestsTotal, httpRequestDurationSeconds };
}
