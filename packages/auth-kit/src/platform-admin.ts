import type { AuthenticatedActor } from '@atlas/types';
import { AppError } from '@atlas/utils';

/*
 * Platform administrators are the operators of Atlas itself — the only people
 * allowed to touch GLOBAL data (the shared jobs catalog, cross-tenant
 * aggregates). That is deliberately NOT the same thing as an organization
 * `admin`/`owner` role: that role only grants authority inside one tenant,
 * and `organization_members` rows are tenant data, not a trust anchor for the
 * platform as a whole.
 *
 * The allowlist lives in server-side configuration (`PLATFORM_ADMIN_USER_IDS`,
 * a comma-separated list of `auth.users` ids) so nothing a signed-in user can
 * write — signup metadata, profile fields, org membership — can grant it.
 * Empty or unset means nobody is a platform admin (fail closed).
 */

/** Comma-separated user ids → normalized set. Blank entries are dropped; ids compare case-insensitively. */
export function parsePlatformAdminIds(raw: string | null | undefined): ReadonlySet<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter((id) => id.length > 0),
  );
}

/**
 * True when the (already token-verified) actor's `user_id` is on the
 * allowlist. `allowlist` is the raw env value, so callers pass
 * `deps.env.PLATFORM_ADMIN_USER_IDS` straight through.
 */
export function isPlatformAdmin(
  actor: Pick<AuthenticatedActor, 'user_id'>,
  allowlist: string | null | undefined,
): boolean {
  return parsePlatformAdminIds(allowlist).has(actor.user_id.toLowerCase());
}

/** Throws FORBIDDEN unless {@link isPlatformAdmin}. */
export function requirePlatformAdmin(
  actor: Pick<AuthenticatedActor, 'user_id'>,
  allowlist: string | null | undefined,
  message = 'Only platform administrators can perform this action',
): void {
  if (!isPlatformAdmin(actor, allowlist)) {
    throw new AppError('FORBIDDEN', message);
  }
}
