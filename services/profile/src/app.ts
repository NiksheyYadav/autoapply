import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { ZodError } from 'zod';
import type { TokenVerifierConfig } from '@atlas/auth-kit';
import { parseCorsOrigins } from '@atlas/config';
import type { Database } from '@atlas/db';
import type { EventBroker } from '@atlas/messaging';
import type { StorageDriver } from '@atlas/storage';
import type { ErrorCode } from '@atlas/types';
import { isAppError, newUuid, toAppError, type Logger } from '@atlas/utils';
import { createMetricsRegistry, metricsRoute, registerHttpMetrics } from '@atlas/observability';
import type { ProfileServiceEnv } from './env.js';
import { getResumeRoute } from './http/routes/get-resume.js';
import { healthRoute } from './http/routes/health.js';
import { listResumesRoute } from './http/routes/list-resumes.js';
import { uploadResumeRoute } from './http/routes/upload-resume.js';

export interface AppDeps {
  db: Database;
  sql: postgres.Sql;
  env: ProfileServiceEnv;
  logger: Logger;
  broker: EventBroker;
  storage: StorageDriver;
  tokenVerifier: TokenVerifierConfig;
}

const STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
  400: 'VALIDATION_ERROR',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
};

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
  void app.register(rateLimit, {
    max: deps.env.RATE_LIMIT_MAX,
    timeWindow: deps.env.RATE_LIMIT_WINDOW,
  });
  void app.register(multipart, {
    limits: { fileSize: deps.env.BODY_LIMIT_BYTES, files: 1 },
  });

  const metrics = createMetricsRegistry('profile-service');
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
  uploadResumeRoute(app, deps);
  getResumeRoute(app, deps);
  listResumesRoute(app, deps);

  return app;
}
