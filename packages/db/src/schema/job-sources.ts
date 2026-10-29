import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { jobBoardProviderEnum } from './enums.js';

/**
 * Public employer job boards (Greenhouse, Lever, Ashby) the jobs service reads
 * on a schedule to fill the shared catalog. One row per board; the postings it
 * yields land in `jobs` with `source` set to the provider.
 *
 * Global (not tenant) data, like `jobs` and `companies`: only platform
 * administrators manage it (`POST /v1/jobs/sources`). Nothing here is a secret:
 * the endpoints read are public and unauthenticated, so there is no credential
 * column to protect. RLS is enabled by packages/db/supabase/rls.sql like every
 * other table in `public`.
 */
export const jobSources = pgTable(
  'job_sources',
  {
    sourceId: uuid('source_id').primaryKey().defaultRandom(),
    provider: jobBoardProviderEnum('provider').notNull(),
    /**
     * The board's identifier in the provider's URL (Greenhouse `board_token`,
     * Lever site name, Ashby job board name). It is the only caller-supplied
     * part of the outbound request URL, hence the charset check below.
     */
    boardToken: text('board_token').notNull(),
    /** The employer the board's postings are attributed to. */
    companyName: text('company_name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** Last attempt, successful or not, so a failing source cannot starve the others. */
    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true, mode: 'string' }),
    /** `ok` | `partial` | `error`. */
    lastStatus: text('last_status'),
    /** Short and scrubbed: never a raw driver or upstream message. */
    lastError: text('last_error'),
    /** Postings the last successful fetch listed. */
    lastJobCount: integer('last_job_count'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('job_sources_provider_board_token_key').on(table.provider, table.boardToken),
    // Defense in depth for rows that bypass the API (SQL seeds, the dashboard):
    // the fetch layer re-validates before building a URL, and so does the route.
    check(
      'job_sources_board_token_check',
      sql`${table.boardToken} ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$'`,
    ),
  ],
);
