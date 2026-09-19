import type { FastifyInstance } from 'fastify';
import { pingDatabase } from '@atlas/db';
import type { HealthResponse } from '@atlas/types';
import type { AppDeps } from '../../app.js';

export function healthRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/health', async (_request, reply) => {
    const dbOk = await pingDatabase(deps.sql);
    const body: HealthResponse = {
      status: dbOk ? 'ok' : 'degraded',
      service: 'auth-service',
      version: '0.1.0',
      checks: { database: dbOk ? 'ok' : 'fail' },
    };
    reply.status(dbOk ? 200 : 503).send(body);
  });
}
