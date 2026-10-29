import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { ZodError } from 'zod';
import type { TokenVerifierConfig } from '@atlas/auth-kit';
import { parseCorsOrigins } from '@atlas/config';
import type { Database } from '@atlas/db';
import type { EventBroker } from '@atlas/messaging';
import type { ErrorCode } from '@atlas/types';
import { isAppError, newUuid, toAppError, type Logger } from '@atlas/utils';
import {
  createMetricsRegistry,
  metricsRoute,
  registerHttpMetrics,
  registerIsoTimestamps,
  registerRateLimitedRoutes,
} from '@atlas/observability';
import type { ApplicationsServiceEnv } from './env.js';
import { appendEventRoute } from './http/routes/append-event.js';
import { createApplicationRoute } from './http/routes/create-application.js';
import { getApplicationRoute } from './http/routes/get-application.js';
import { healthRoute } from './http/routes/health.js';
import { listApplicationsRoute } from './http/routes/list-applications.js';

export interface AppDeps {
  db: Database;
  sql: postgres.Sql;
  env: ApplicationsServiceEnv;
  logger: Logger;
  broker: EventBroker;
  tokenVerifier: TokenVerifierConfig;
}

const STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
  400: 'VALIDATION_ERROR',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
};

/**
 * Creating an application is the call here that fans out to other services (events to matching and
 * analytics) and, later, to employers, so it is held to a tighter limit than the global one. A
 * route listed here uses its own budget instead of the global one.
 */
const ROUTE_LIMITS = {
  'POST /v1/applications': { max: 30, timeWindow: '1 minute' },
} as const;

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    // See services/auth/src/app.ts for why this cast is needed: pino's Logger
    // type and Fastify's FastifyBaseLogger disagree on a structural detail
    // that doesn't matter at runtime.
    loggerInstance: deps.logger as unknown as FastifyBaseLogger,
    bodyLimit: deps.env.BODY_LIMIT_BYTES,
    trustProxy: true,
    genReqId: () => newUuid(),
  });

  void app.register(cors, { origin: parseCorsOrigins(deps.env.CORS_ORIGINS) });

  const metrics = createMetricsRegistry('applications-service');
  registerHttpMetrics(app, metrics);
  // Postgres-style timestamps ('2026-10-27 12:59:21+00') become strict ISO 8601, which Safari can parse.
  registerIsoTimestamps(app);

  app.setErrorHandler((error: FastifyError | ZodError, request, reply) => {
    if (error instanceof ZodError) {
      reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request failed validation',
          request_id: request.id,
          details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        },
      });
      return;
    }

    if (isAppError(error)) {
      reply.status(error.statusCode).send(error.toResponse(request.id));
      return;
    }

    const fastifyStatus = (error as { statusCode?: number }).statusCode;
    if (fastifyStatus !== undefined && fastifyStatus >= 400 && fastifyStatus < 500) {
      reply.status(fastifyStatus).send({
        error: {
          code: STATUS_TO_CODE[fastifyStatus] ?? 'VALIDATION_ERROR',
          message: error.message,
          request_id: request.id,
        },
      });
      return;
    }

    request.log.error({ err: error }, 'unhandled error');
    const appError = toAppError(error);
    reply.status(appError.statusCode).send(appError.toResponse(request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'Route not found', request_id: request.id },
    });
  });

  // Probes are scraped by infrastructure and stay outside the rate limiter.
  healthRoute(app, deps);
  metricsRoute(app, metrics);

  // Everything else is declared inside the rate-limited scope: see registerRateLimitedRoutes for
  // why routes declared on `app` right after registering the plugin would not be limited.
  registerRateLimitedRoutes(
    app,
    {
      plugin: rateLimit,
      settings: { max: deps.env.RATE_LIMIT_MAX, timeWindow: deps.env.RATE_LIMIT_WINDOW },
      routeLimits: ROUTE_LIMITS,
    },
    (api) => {
      createApplicationRoute(api, deps);
      listApplicationsRoute(api, deps);
      getApplicationRoute(api, deps);
      appendEventRoute(api, deps);
    },
  );

  return app;
}
