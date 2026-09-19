import type { AccessTokenClaims, AuthenticatedActor, Permissions } from '@atlas/types';

export function buildActor(claims: AccessTokenClaims, permissions: Permissions = {}): AuthenticatedActor {
  return {
    user_id: claims.sub,
    email: claims.email,
    organization_id: claims.org,
    role: claims.role,
    permissions,
    session_id: claims.sid,
  };
}
