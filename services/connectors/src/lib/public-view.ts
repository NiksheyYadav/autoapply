import type { schema } from '@atlas/db';

type ConnectorAccountRow = typeof schema.connectorAccounts.$inferSelect;

/** Never includes `secretRef` — that value must never leave this service. */
export interface ConnectorAccountView {
  connector_account_id: string;
  provider: string;
  external_account_id: string;
  scopes: string[];
  status: string;
  consent_granted_at: string | null;
  expires_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
}

export function toConnectorAccountView(row: ConnectorAccountRow): ConnectorAccountView {
  return {
    connector_account_id: row.connectorAccountId,
    provider: row.provider,
    external_account_id: row.externalAccountId,
    scopes: row.scopes,
    status: row.status,
    consent_granted_at: row.consentGrantedAt,
    expires_at: row.expiresAt,
    last_synced_at: row.lastSyncedAt,
    last_error: row.lastError,
    created_at: row.createdAt,
  };
}
