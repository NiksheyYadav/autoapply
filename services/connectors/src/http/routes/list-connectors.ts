import type { FastifyInstance } from 'fastify';
import { getActor, requireAuth } from '@atlas/auth-kit';
import type { AppDeps } from '../../app.js';
import { CONNECTOR_PROVIDERS } from '../../lib/providers.js';
import { toConnectorAccountView, type ConnectorAccountView } from '../../lib/public-view.js';
import { listForUser } from '../../repo/connector-accounts.js';

export interface ListConnectorsResponse {
  providers: {
    provider: string;
    connected: boolean;
    account: ConnectorAccountView | null;
  }[];
}

export function listConnectorsRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/connectors', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    const accounts = await listForUser(deps.db, actor.user_id);
    const byProvider = new Map(accounts.map((account) => [account.provider, account]));

    const response: ListConnectorsResponse = {
      providers: CONNECTOR_PROVIDERS.map((provider) => {
        const account = byProvider.get(provider);
        const connected = account !== undefined && account.status === 'active';
        return { provider, connected, account: account ? toConnectorAccountView(account) : null };
      }),
    };
    reply.status(200).send(response);
  });
}
