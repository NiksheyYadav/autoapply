import type { MemberRole, Permissions, PublicUser } from '@atlas/types';
import { apiFetch } from '../api';
import { SERVICE_URLS } from '../config';

export interface MeResponse {
  user: PublicUser;
  organization_id: string | null;
  role: MemberRole | null;
  permissions: Permissions;
}

/**
 * The one thing Supabase's own session doesn't carry: full_name/mfa_enabled/
 * etc., and permissions (a mutable jsonb blob deliberately looked up fresh
 * rather than trusted from a token — see services/auth/src/http/routes/me.ts).
 */
export function me(accessToken: string): Promise<MeResponse> {
  return apiFetch<MeResponse>(SERVICE_URLS.auth, '/v1/auth/me', { accessToken });
}
