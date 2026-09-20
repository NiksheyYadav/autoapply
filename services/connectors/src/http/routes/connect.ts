import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { isConnectorProvider } from '../../lib/providers.js';
import { toConnectorAccountView, type ConnectorAccountView } from '../../lib/public-view.js';
import { findByProviderAndExternalId, findByUserAndProvider, insertConnection, replaceConnection } from '../../repo/connector-accounts.js';

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

const paramsSchema = z.object({ provider: z.string() });

const bodySchema = z.object({
  external_account_id: z.string().min(1).max(400),
  /** The board token/API key itself — goes straight to the secret store, never to a column. */
  credential: z.string().min(1).max(10_000),
  scopes: z.array(z.string().min(1).max(80)).max(50).default([]),
  // Explicit per docs/09 § Compliance posture: "Keep consent records for
  // every connected service." A default here would make consent implicit.
  consent: z.literal(true),
});

export interface ConnectResponse {
  connector: ConnectorAccountView;
}

export function connectRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post('/v1/connectors/:provider/connect', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    const { provider } = paramsSchema.parse(request.params);
    if (!isConnectorProvider(provider)) {
      throw new AppError('NOT_FOUND', `Unknown connector provider "${provider}"`);
    }
    const body = bodySchema.parse(request.body);

    const { ref } = await deps.secretStore.put(body.credential);
    const consentGrantedAt = new Date().toISOString();

    try {
      const existing = await findByUserAndProvider(deps.db, actor.user_id, provider);
      if (existing) {
        // Reconnecting replaces the credential; the old one must not linger.
        await deps.secretStore.delete(existing.secretRef);
        const updated = await replaceConnection(deps.db, {
          connectorAccountId: existing.connectorAccountId,
          externalAccountId: body.external_account_id,
          secretRef: ref,
          scopes: body.scopes,
          consentGrantedAt,
        });
        const response: ConnectResponse = { connector: toConnectorAccountView(updated) };
        reply.status(200).send(response);
        return;
      }

      const created = await insertConnection(deps.db, {
        userId: actor.user_id,
        organizationId: actor.organization_id,
        provider,
        externalAccountId: body.external_account_id,
        secretRef: ref,
        scopes: body.scopes,
        consentGrantedAt,
      });
      const response: ConnectResponse = { connector: toConnectorAccountView(created) };
      reply.status(201).send(response);
    } catch (cause) {
      if ((cause as { code?: string }).code === UNIQUE_VIOLATION) {
        // Someone else already connected this exact provider account — the
        // secret we just wrote is orphaned and must not be left behind.
        await deps.secretStore.delete(ref);
        const conflicting = await findByProviderAndExternalId(deps.db, provider, body.external_account_id);
        throw new AppError('CONFLICT', 'This connector account is already connected by another user', {
          details: conflicting ? { connector_account_id: conflicting.connectorAccountId } : undefined,
        });
      }
      await deps.secretStore.delete(ref);
      throw cause;
    }
  });
}
