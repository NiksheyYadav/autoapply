import { z } from 'zod';
import type { RawJobPosting } from '@atlas/types';
import {
  asRecord,
  collectPostings,
  SourcePayloadError,
  toIsoTimestamp,
  type MapperContext,
  type ProviderAdapter,
} from './common.js';
import { decodeHtmlEntities, htmlToText } from './html-text.js';

/**
 * Greenhouse Job Board API, "List jobs" (public, no authentication; only the
 * application-submission POST needs a key):
 *   https://docs.greenhouse.io/job-board.html#list-jobs
 *   (the same page was previously served from developers.greenhouse.io)
 *
 *   GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true
 *
 * Documented response: `{ jobs: [...], meta: { total } }`. With `content=true`
 * each job also carries `content`, `departments` and `offices`. Per job:
 * `id` (the job post), `internal_job_id`, `title`, `updated_at`, `requisition_id`,
 * `location: { name }`, `absolute_url`, `language`, `metadata`.
 *
 * Observed against live boards (Anthropic, Figma, Stripe, Databricks) on
 * 2026-10-27, beyond what the list docs show: `company_name`, `first_published`
 * and `application_deadline` are present on the list response too, and `content`
 * is HTML that has been entity-escaped once (`&lt;p&gt;`), so it must be decoded
 * before the tags can be stripped. The list carries no salary, employment type
 * or workplace type; the last two are read from `metadata` custom fields when a
 * board exposes them, and `location.name` is the only place "Remote" shows up
 * otherwise.
 */
export const GREENHOUSE_ORIGIN = 'https://boards-api.greenhouse.io';

const greenhouseJobSchema = z.object({
  id: z.union([z.number().int(), z.string().min(1)]),
  title: z.string(),
  absolute_url: z.string().nullish(),
  location: z.object({ name: z.string().nullish() }).nullish(),
  content: z.string().nullish(),
  first_published: z.string().nullish(),
  updated_at: z.string().nullish(),
  metadata: z
    .array(z.object({ name: z.string().nullish(), value: z.unknown() }))
    .nullish(),
});

type GreenhouseJob = z.infer<typeof greenhouseJobSchema>;

/** The text value of the first custom field whose name matches, if it is a string. */
function metadataText(job: GreenhouseJob, namePattern: RegExp): string | null {
  for (const field of job.metadata ?? []) {
    if (field.name && namePattern.test(field.name) && typeof field.value === 'string') {
      return field.value;
    }
  }
  return null;
}

const INTERN_TITLE_RE = /\bintern(?:ship)?\b/i;

function toPosting(job: GreenhouseJob, companyName: string): RawJobPosting {
  const locationName = job.location?.name ?? null;
  const workplace = metadataText(job, /location type|workplace|work type|remote/i);
  const employment =
    metadataText(job, /employment|job type|worker type/i) ??
    (INTERN_TITLE_RE.test(job.title) ? 'internship' : null);

  return {
    source: 'greenhouse',
    external_id: String(job.id),
    title: job.title,
    // The source's configured name, not the list's own `company_name`, which the
    // list docs do not describe.
    company_name: companyName,
    description: job.content ? htmlToText(decodeHtmlEntities(job.content)) : null,
    location: locationName,
    remote_type: workplace ?? (locationName && /remote/i.test(locationName) ? 'remote' : null),
    employment_type: employment,
    apply_url: job.absolute_url ?? null,
    posted_at: toIsoTimestamp(job.first_published) ?? toIsoTimestamp(job.updated_at),
  };
}

export function mapGreenhouseJobs(payload: unknown, context: MapperContext) {
  const body = asRecord(payload);
  if (body === null || !Array.isArray(body.jobs)) {
    throw new SourcePayloadError('Greenhouse response has no "jobs" array');
  }
  return collectPostings(body.jobs, greenhouseJobSchema, (job) => toPosting(job, context.companyName));
}

export const greenhouseAdapter: ProviderAdapter = {
  provider: 'greenhouse',
  origin: GREENHOUSE_ORIGIN,
  buildUrl(boardToken) {
    const url = new URL(`/v1/boards/${encodeURIComponent(boardToken)}/jobs`, GREENHOUSE_ORIGIN);
    url.searchParams.set('content', 'true');
    return url;
  },
  map: mapGreenhouseJobs,
};
