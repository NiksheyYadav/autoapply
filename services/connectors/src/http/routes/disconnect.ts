import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { toConnectorAccountView, type ConnectorAccountView } from '../../lib/public-view.js';
import { findByUserAndProvider, markRevoked } from '../../repo/connector-accounts.js';

const paramsSchema = z.object({ provider: z.string() });

export interface DisconnectResponse {
  connector: ConnectorAccountView;
}

export function disconnectRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post('/v1/connectors/:provider/disconnect', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    const { provider } = paramsSchema.parse(request.params);

    const existing = await findByUserAndProvider(deps.db, actor.user_id, provider);
    if (!existing) {
      throw new AppError('NOT_FOUND', `No connection for provider "${provider}"`);
    }

    // Delete before marking revoked, not best-effort: if this throws, the
    // row must stay un-revoked so the credential isn't left sitting in the
    // secret store with no record admitting it's still there. The caller
    // sees the failure and can retry disconnect.
    await deps.secretStore.delete(existing.secretRef);

    const updated = await markRevoked(deps.db, existing.connectorAccountId);
    const response: DisconnectResponse = { connector: toConnectorAccountView(updated) };
    reply.status(200).send(response);
  });
}
