import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from 'drizzle-orm/pg-core';
import { employmentTypeEnum, jobSourceEnum, remoteTypeEnum } from './enums.js';
import { users } from './identity.js';
import { EMBEDDING_DIMENSIONS } from './profile.js';

export const companies = pgTable(
  'companies',
  {
    companyId: uuid('company_id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 300 }).notNull(),
    /** Lowercased, suffix-stripped name. The join key for cross-source dedupe. */
    normalizedName: varchar('normalized_name', { length: 300 }).notNull(),
    industry: varchar('industry', { length: 200 }),
    website: varchar('website', { length: 500 }),
    domain: varchar('domain', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('companies_normalized_name_key').on(table.normalizedName),
    index('companies_domain_idx').on(table.domain),
    // Trigram index for fuzzy company matching when normalization is not enough.
    index('companies_name_trgm_idx').using('gin', sql`${table.name} gin_trgm_ops`),
  ],
);

export const jobs = pgTable(
  'jobs',
  {
    jobId: uuid('job_id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.companyId, { onDelete: 'cascade' }),
    title: varchar('title', { length: 300 }).notNull(),
    description: text('description'),
    salaryMin: integer('salary_min'),
    salaryMax: integer('salary_max'),
    salaryCurrency: varchar('salary_currency', { length: 3 }),
    salaryPeriod: varchar('salary_period', { length: 10 }),
    location: varchar('location', { length: 300 }),
    remoteType: remoteTypeEnum('remote_type').notNull().default('unknown'),
    employmentType: employmentTypeEnum('employment_type').notNull().default('unknown'),
    source: jobSourceEnum('source').notNull(),
    externalId: varchar('external_id', { length: 400 }),
    applyUrl: text('apply_url'),
    /**
     * SHA-256 over normalized company+title+location+remote type. Globally
     * unique: two sources publishing the same role collapse to one row
     * (docs/02 § Design notes).
     */
    jobHash: varchar('job_hash', { length: 64 }).notNull(),
    skills: jsonb('skills').$type<string[]>().notNull().default([]),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    /** Heuristic spam score, 0–1. Listings above the threshold are filtered. */
    spamScore: real('spam_score').notNull().default(0),
    postedAt: timestamp('posted_at', { withTimezone: true, mode: 'string' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
    isActive: boolean('is_active').notNull().default(true),
    /** Bumped every time a source re-reports the listing. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('jobs_job_hash_key').on(table.jobHash),
    // A source may only report a given external id once.
    uniqueIndex('jobs_source_external_id_key')
      .on(table.source, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
    index('jobs_company_idx').on(table.companyId),
    index('jobs_active_posted_idx').on(table.isActive, table.postedAt),
    index('jobs_remote_type_idx').on(table.remoteType),
    index('jobs_title_trgm_idx').using('gin', sql`${table.title} gin_trgm_ops`),
  ],
);

/**
 * Per-user match scores produced by the matching service. Kept separate from
 * `jobs` because scores are user-scoped and rewritten far more often than the
 * listing itself.
 */
export const jobScores = pgTable(
  'job_scores',
  {
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.jobId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    score: real('score').notNull(),
    reasons: jsonb('reasons').$type<string[]>().notNull().default([]),
    skillGaps: jsonb('skill_gaps').$type<string[]>().notNull().default([]),
    modelVersion: varchar('model_version', { length: 80 }).notNull(),
    scoredAt: timestamp('scored_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Composite PK rather than a unique index: one score per (job, user) is
    // the identity of the row, and it gives the table a replica identity.
    primaryKey({ columns: [table.jobId, table.userId] }),
    index('job_scores_user_score_idx').on(table.userId, table.score),
  ],
);

export const jobsRelations = relations(jobs, ({ one, many }) => ({
  company: one(companies, { fields: [jobs.companyId], references: [companies.companyId] }),
  scores: many(jobScores),
}));

export const companiesRelations = relations(companies, ({ many }) => ({
  jobs: many(jobs),
}));
