import { relations } from 'drizzle-orm';
import {
  index,
  integer,
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
import type { ParsedProfile } from '@atlas/types';
import { resumeStatusEnum } from './enums.js';
import { users } from './identity.js';

/** Matches text-embedding-3-small. Changing this requires a re-embed backfill. */
export const EMBEDDING_DIMENSIONS = 1536;

export const resumes = pgTable(
  'resumes',
  {
    resumeId: uuid('resume_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    /** Object-store key, not a signed URL — those are minted on read. */
    storageUrl: text('storage_url').notNull(),
    originalFilename: varchar('original_filename', { length: 400 }).notNull(),
    contentType: varchar('content_type', { length: 200 }).notNull(),
    byteSize: integer('byte_size').notNull(),
    /** SHA-256 of the file bytes; makes re-uploads idempotent per user. */
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    status: resumeStatusEnum('status').notNull().default('pending'),
    /** Sensitive: classified alongside the source document (docs/09). */
    parsedText: text('parsed_text'),
    parsedProfile: jsonb('parsed_profile').$type<ParsedProfile>(),
    atsScore: real('ats_score'),
    atsReport: jsonb('ats_report').$type<Record<string, unknown>>(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    failureReason: text('failure_reason'),
    parsedAt: timestamp('parsed_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Re-uploading the same file is a no-op rather than a duplicate record.
    uniqueIndex('resumes_user_content_hash_key').on(table.userId, table.contentHash),
    index('resumes_user_created_idx').on(table.userId, table.createdAt),
    index('resumes_status_idx').on(table.status),
  ],
);

export const resumesRelations = relations(resumes, ({ one }) => ({
  user: one(users, { fields: [resumes.userId], references: [users.userId] }),
}));
