import { relations } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from 'drizzle-orm/pg-core';
import {
  applicationModeEnum,
  applicationStatusEnum,
  messageChannelEnum,
  messageStatusEnum,
} from './enums.js';
import { organizations, users } from './identity.js';
import { companies, jobs } from './jobs.js';
import { EMBEDDING_DIMENSIONS } from './profile.js';
import { resumes } from './profile.js';

export const applications = pgTable(
  'applications',
  {
    applicationId: uuid('application_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.jobId, { onDelete: 'cascade' }),
    resumeId: uuid('resume_id').references(() => resumes.resumeId, { onDelete: 'set null' }),
    organizationId: uuid('organization_id').references(() => organizations.organizationId, {
      onDelete: 'set null',
    }),
    status: applicationStatusEnum('status').notNull().default('draft'),
    mode: applicationModeEnum('mode').notNull().default('manual'),
    /**
     * Client-supplied and unique per user: a retried submission can never
     * produce a second application (docs/04 § Validation rules).
     */
    idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull(),
    coverLetter: text('cover_letter'),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'string' }),
    lastEventAt: timestamp('last_event_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('applications_user_idempotency_key').on(table.userId, table.idempotencyKey),
    // One application per user per job, regardless of how it was triggered.
    uniqueIndex('applications_user_job_key').on(table.userId, table.jobId),
    index('applications_status_idx').on(table.status),
    index('applications_user_created_idx').on(table.userId, table.createdAt),
    index('applications_org_idx').on(table.organizationId),
  ],
);

/** Append-only lifecycle trail; `applications.status` is the folded head. */
export const applicationEvents = pgTable(
  'application_events',
  {
    eventId: uuid('event_id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.applicationId, { onDelete: 'cascade' }),
    fromStatus: applicationStatusEnum('from_status'),
    toStatus: applicationStatusEnum('to_status').notNull(),
    note: text('note'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('application_events_app_created_idx').on(table.applicationId, table.createdAt)],
);

export const contacts = pgTable(
  'contacts',
  {
    contactId: uuid('contact_id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.companyId, { onDelete: 'cascade' }),
    fullName: varchar('full_name', { length: 200 }),
    title: varchar('title', { length: 200 }),
    email: varchar('email', { length: 320 }),
    linkedinUrl: varchar('linkedin_url', { length: 500 }),
    relevanceScore: real('relevance_score'),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    source: varchar('source', { length: 80 }).notNull().default('manual'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('contacts_company_email_key').on(table.companyId, table.email),
    index('contacts_company_idx').on(table.companyId),
    index('contacts_relevance_idx').on(table.relevanceScore),
  ],
);

export const messages = pgTable(
  'messages',
  {
    messageId: uuid('message_id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id').references(() => applications.applicationId, {
      onDelete: 'cascade',
    }),
    contactId: uuid('contact_id').references(() => contacts.contactId, { onDelete: 'set null' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    channel: messageChannelEnum('channel').notNull(),
    status: messageStatusEnum('status').notNull().default('draft'),
    subject: varchar('subject', { length: 400 }),
    body: text('body').notNull(),
    /** Required so a retried send cannot email the same contact twice. */
    idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true, mode: 'string' }),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('messages_user_idempotency_key').on(table.userId, table.idempotencyKey),
    index('messages_status_scheduled_idx').on(table.status, table.scheduledFor),
    index('messages_contact_idx').on(table.contactId),
  ],
);

export const applicationsRelations = relations(applications, ({ one, many }) => ({
  user: one(users, { fields: [applications.userId], references: [users.userId] }),
  job: one(jobs, { fields: [applications.jobId], references: [jobs.jobId] }),
  resume: one(resumes, { fields: [applications.resumeId], references: [resumes.resumeId] }),
  events: many(applicationEvents),
  messages: many(messages),
}));

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  company: one(companies, { fields: [contacts.companyId], references: [companies.companyId] }),
  messages: many(messages),
}));
