import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { ZodError } from 'zod';
import { parseCorsOrigins } from '@atlas/config';
import type { Database } from '@atlas/db';
import type { ErrorCode } from '@atlas/types';
import { isAppError, newUuid, toAppError, type Logger } from '@atlas/utils';
import { createMetricsRegistry, metricsRoute, registerHttpMetrics } from '@atlas/observability';
import type { AuthServiceEnv } from './env.js';
import { healthRoute } from './http/routes/health.js';
import { loginRoute } from './http/routes/login.js';
import { logoutRoute } from './http/routes/logout.js';
import { meRoute } from './http/routes/me.js';
import { refreshRoute } from './http/routes/refresh.js';
import { registerRoute } from './http/routes/register.js';
import type { TokenConfig } from './security/tokens.js';

export interface AppDeps {
  db: Database;
  sql: postgres.Sql;
  env: AuthServiceEnv;
  logger: Logger;
  tokenConfig: TokenConfig;
}

const STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
  400: 'VALIDATION_ERROR',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
};

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    // Pino's Logger type and Fastify's FastifyBaseLogger disagree on a couple
    // of structural details even though pino is exactly what Fastify expects
    // here at runtime; the cast avoids that mismatch poisoning every route's
    // inferred types below.
    loggerInstance: deps.logger as unknown as FastifyBaseLogger,
    bodyLimit: deps.env.BODY_LIMIT_BYTES,
    // Deployed behind an ingress/load balancer (docs/07) — trust its forwarded IP.
    trustProxy: true,
    genReqId: () => newUuid(),
  });

  void app.register(cors, { origin: parseCorsOrigins(deps.env.CORS_ORIGINS) });
  void app.register(rateLimit, {
    max: deps.env.RATE_LIMIT_MAX,
    timeWindow: deps.env.RATE_LIMIT_WINDOW,
  });

  const metrics = createMetricsRegistry('auth-service');
  registerHttpMetrics(app, metrics);

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

    // Fastify's own request-parsing errors (malformed JSON, oversized body,
    // a tripped rate limiter) already carry the right HTTP status.
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

  healthRoute(app, deps);
  metricsRoute(app, metrics);
  registerRoute(app, deps);
  loginRoute(app, deps);
  refreshRoute(app, deps);
  logoutRoute(app, deps);
  meRoute(app, deps);

  return app;
}
