import { z } from 'zod';
import type { RawJobPosting } from '@atlas/types';
import {
  asRecord,
  collectPostings,
  joinLocations,
  SourcePayloadError,
  tidyDescription,
  toIsoTimestamp,
  type MapperContext,
  type ProviderAdapter,
} from './common.js';
import { htmlToText } from './html-text.js';

/**
 * Ashby public Job Postings API (no authentication):
 *   https://developers.ashbyhq.com/docs/public-job-posting-api
 *
 *   GET https://api.ashbyhq.com/posting-api/job-board/{JOB_BOARD_NAME}
 *
 * Documented response: `{ apiVersion: "1", jobs: [...] }`. Per job: `title`,
 * `location`, `secondaryLocations[].location`, `department`, `team`, `isRemote`
 * (true for Remote *and* Hybrid, so it cannot tell them apart), `workplaceType`
 * (`OnSite`, `Remote` or `Hybrid`), `descriptionHtml`, `descriptionPlain`,
 * `publishedAt`, `employmentType` (`FullTime`, `PartTime`, `Intern`, `Contract`
 * or `Temporary`), `address.postalAddress`, `jobUrl`, `applyUrl` and `isListed`
 * ("if false, this listing should only be available via direct link", so those
 * are skipped here). Compensation is opt-in (`includeCompensation=true`) and is
 * not requested.
 *
 * Observed on live boards (ashby, ramp, notion) on 2026-10-27, beyond the
 * docs: every job also carries a UUID `id`, which is used as the external id
 * (falling back to the UUID at the end of `jobUrl` for a payload without it).
 */
export const ASHBY_ORIGIN = 'https://api.ashbyhq.com';

const ashbyJobSchema = z.object({
  id: z.string().min(1).nullish(),
  title: z.string(),
  location: z.string().nullish(),
  secondaryLocations: z.array(z.object({ location: z.string().nullish() })).nullish(),
  employmentType: z.string().nullish(),
  workplaceType: z.string().nullish(),
  isListed: z.boolean().nullish(),
  descriptionHtml: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  publishedAt: z.string().nullish(),
  jobUrl: z.string().nullish(),
  applyUrl: z.string().nullish(),
  address: z
    .object({
      postalAddress: z
        .object({
          addressLocality: z.string().nullish(),
          addressRegion: z.string().nullish(),
          addressCountry: z.string().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

type AshbyJob = z.infer<typeof ashbyJobSchema>;

const TRAILING_UUID_RE = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

function uuidFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return TRAILING_UUID_RE.exec(new URL(url, ASHBY_ORIGIN).pathname)?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function externalIdOf(job: AshbyJob): string | null {
  return job.id ?? uuidFromUrl(job.jobUrl) ?? uuidFromUrl(job.applyUrl);
}

function postalLocation(job: AshbyJob): string | null {
  const address = job.address?.postalAddress;
  return joinLocations([[address?.addressLocality, address?.addressRegion, address?.addressCountry].filter(Boolean).join(', ')]);
}

function toPosting(job: AshbyJob, companyName: string): RawJobPosting | null {
  // Unlisted postings are reachable by link only, not part of the public board.
  if (job.isListed === false) return null;

  const primary = job.location?.trim() ? job.location : postalLocation(job);
  return {
    source: 'ashby',
    external_id: externalIdOf(job),
    title: job.title,
    company_name: companyName,
    description: tidyDescription([job.descriptionPlain ?? (job.descriptionHtml ? htmlToText(job.descriptionHtml) : null)]),
    location: joinLocations([primary, ...(job.secondaryLocations ?? []).map((secondary) => secondary.location)]),
    remote_type: job.workplaceType ?? null,
    employment_type: job.employmentType ?? null,
    apply_url: job.applyUrl ?? job.jobUrl ?? null,
    posted_at: toIsoTimestamp(job.publishedAt),
  };
}

export function mapAshbyJobs(payload: unknown, context: MapperContext) {
  const body = asRecord(payload);
  if (body === null || !Array.isArray(body.jobs)) {
    throw new SourcePayloadError('Ashby response has no "jobs" array');
  }
  return collectPostings(body.jobs, ashbyJobSchema, (job) => toPosting(job, context.companyName));
}

export const ashbyAdapter: ProviderAdapter = {
  provider: 'ashby',
  origin: ASHBY_ORIGIN,
  buildUrl(boardToken) {
    return new URL(`/posting-api/job-board/${encodeURIComponent(boardToken)}`, ASHBY_ORIGIN);
  },
  map: mapAshbyJobs,
};
