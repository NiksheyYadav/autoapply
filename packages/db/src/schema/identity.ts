import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { Permissions } from '@atlas/types';
import {
  authProviderEnum,
  memberRoleEnum,
  organizationPlanEnum,
  organizationTypeEnum,
} from './enums.js';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
};

export const organizations = pgTable(
  'organizations',
  {
    organizationId: uuid('organization_id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 200 }).notNull(),
    type: organizationTypeEnum('type').notNull().default('individual'),
    plan: organizationPlanEnum('plan').notNull().default('free'),
    /** Optional vanity slug used by university/enterprise portals. */
    slug: varchar('slug', { length: 100 }),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('organizations_slug_key').on(table.slug).where(sql`${table.slug} IS NOT NULL`),
    index('organizations_type_idx').on(table.type),
  ],
);

export const users = pgTable(
  'users',
  {
    userId: uuid('user_id').primaryKey().defaultRandom(),
    /** Points at the resume currently treated as the canonical profile. */
    profileId: uuid('profile_id'),
    email: varchar('email', { length: 320 }).notNull(),
    fullName: varchar('full_name', { length: 200 }).notNull(),
    authProvider: authProviderEnum('auth_provider').notNull().default('password'),
    /**
     * Null for SSO users, who have no local credential. Never leaves this
     * table — see docs/09 § Data protection.
     */
    passwordHash: text('password_hash'),
    emailVerified: boolean('email_verified').notNull().default(false),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    mfaSecret: text('mfa_secret'),
    /** Consecutive failed logins, used for step-up/lockout (docs/09). */
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'string' }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'string' }),
    /** Set only where deletion is legally required (docs/02 § Design notes). */
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    ...timestamps,
  },
  (table) => [
    // Case-insensitive uniqueness: `Ada@x.com` and `ada@x.com` are one account.
    uniqueIndex('users_email_key').on(sql`lower(${table.email})`),
    index('users_profile_id_idx').on(table.profileId),
  ],
);

export const organizationMembers = pgTable(
  'organization_members',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.organizationId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    role: memberRoleEnum('role').notNull().default('member'),
    permissions: jsonb('permissions').$type<Permissions>().notNull().default({}),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    index('organization_members_user_idx').on(table.userId),
  ],
);

export const students = pgTable(
  'students',
  {
    studentId: uuid('student_id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.organizationId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    department: varchar('department', { length: 200 }),
    graduationYear: integer('graduation_year'),
    currentStatus: varchar('current_status', { length: 80 }).notNull().default('active'),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex('students_org_user_key').on(table.organizationId, table.userId),
    index('students_grad_year_idx').on(table.organizationId, table.graduationYear),
  ],
);

/**
 * Refresh-token sessions. Only the SHA-256 of the token is stored, so a
 * database leak does not hand an attacker usable sessions.
 */
export const sessions = pgTable(
  'sessions',
  {
    sessionId: uuid('session_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.organizationId, {
      onDelete: 'set null',
    }),
    refreshTokenHash: varchar('refresh_token_hash', { length: 64 }).notNull(),
    userAgent: varchar('user_agent', { length: 500 }),
    ipAddress: varchar('ip_address', { length: 64 }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    /** Set when this session was replaced by rotation, for reuse detection. */
    rotatedToSessionId: uuid('rotated_to_session_id'),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex('sessions_refresh_hash_key').on(table.refreshTokenHash),
    index('sessions_user_idx').on(table.userId),
    index('sessions_expires_idx').on(table.expiresAt),
  ],
);

/** Immutable audit trail (docs/09 § Compliance posture). Append-only. */
export const auditLogs = pgTable(
  'audit_logs',
  {
    auditId: uuid('audit_id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.organizationId, {
      onDelete: 'set null',
    }),
    actorUserId: uuid('actor_user_id').references(() => users.userId, { onDelete: 'set null' }),
    action: varchar('action', { length: 120 }).notNull(),
    resourceType: varchar('resource_type', { length: 80 }).notNull(),
    resourceId: varchar('resource_id', { length: 200 }),
    traceId: varchar('trace_id', { length: 100 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index('audit_logs_org_created_idx').on(table.organizationId, table.createdAt),
    index('audit_logs_actor_idx').on(table.actorUserId),
    index('audit_logs_resource_idx').on(table.resourceType, table.resourceId),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(organizationMembers),
  sessions: many(sessions),
}));

export const organizationsRelations = relations(organizations, ({ many }) => ({
  members: many(organizationMembers),
  students: many(students),
}));

export const organizationMembersRelations = relations(organizationMembers, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationMembers.organizationId],
    references: [organizations.organizationId],
  }),
  user: one(users, {
    fields: [organizationMembers.userId],
    references: [users.userId],
  }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.userId] }),
}));
