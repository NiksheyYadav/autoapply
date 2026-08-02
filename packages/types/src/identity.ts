import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';
import {
  authProviderSchema,
  memberRoleSchema,
  organizationPlanSchema,
  organizationTypeSchema,
} from './enums.js';

export const userSchema = z.object({
  user_id: uuidSchema,
  profile_id: uuidSchema.nullable(),
  email: z.email(),
  full_name: z.string().min(1).max(200),
  auth_provider: authProviderSchema,
  email_verified: z.boolean(),
  mfa_enabled: z.boolean(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
});

export type User = z.infer<typeof userSchema>;

/** The shape safe to return over the wire — never includes credential material. */
export const publicUserSchema = userSchema.pick({
  user_id: true,
  email: true,
  full_name: true,
  auth_provider: true,
  email_verified: true,
  mfa_enabled: true,
  created_at: true,
});

export type PublicUser = z.infer<typeof publicUserSchema>;

export const organizationSchema = z.object({
  organization_id: uuidSchema,
  name: z.string().min(1).max(200),
  type: organizationTypeSchema,
  plan: organizationPlanSchema,
  created_at: isoTimestampSchema,
});

export type Organization = z.infer<typeof organizationSchema>;

/**
 * Fine-grained permission grants layered on top of the coarse role. Absent keys
 * mean "fall back to the role default", so this is additive only.
 */
export const permissionsSchema = z.object({
  can_manage_members: z.boolean().optional(),
  can_view_analytics: z.boolean().optional(),
  can_export_reports: z.boolean().optional(),
  can_manage_connectors: z.boolean().optional(),
  can_apply_on_behalf: z.boolean().optional(),
});

export type Permissions = z.infer<typeof permissionsSchema>;

export const organizationMemberSchema = z.object({
  organization_id: uuidSchema,
  user_id: uuidSchema,
  role: memberRoleSchema,
  permissions: permissionsSchema,
  created_at: isoTimestampSchema,
});

export type OrganizationMember = z.infer<typeof organizationMemberSchema>;

/** Resolved caller identity attached to every authenticated request. */
export interface AuthenticatedActor {
  user_id: string;
  email: string;
  organization_id: string | null;
  role: z.infer<typeof memberRoleSchema> | null;
  permissions: Permissions;
  session_id: string;
}

/** Access-token claims. Kept small — tokens are not a data channel. */
export const accessTokenClaimsSchema = z.object({
  sub: uuidSchema,
  sid: uuidSchema,
  org: uuidSchema.nullable(),
  role: memberRoleSchema.nullable(),
  email: z.email(),
});

export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;
