import { z } from 'zod';
import type { RawJobPosting } from '@atlas/types';
import {
  asRecord,
  collectPostings,
  joinLocations,
  SourcePayloadError,
  tidyDescription,
  toIsoTimestamp,
  toWholeAmount,
  type MapperContext,
  type ProviderAdapter,
} from './common.js';
import { htmlToText } from './html-text.js';

/**
 * Lever Postings API (public; an API key is only needed to POST applications):
 *   https://github.com/lever/postings-api  (README, "Job postings")
 *
 *   GET https://api.lever.co/v0/postings/{company}?mode=json
 *
 * Documented response in JSON mode: an array of postings with `id`, `text`
 * (the title), `categories` (`location`, `commitment`, `team`, `department`,
 * `allLocations`), `country`, `workplaceType` (`unspecified`, `on-site`,
 * `remote` or `hybrid`), `descriptionPlain`, `lists` (`{ text, content }`, the
 * content being HTML), `additionalPlain`, `hostedUrl`, `applyUrl`, and an
 * optional `salaryRange` (`currency`, `interval`, `min`, `max`). Paging is
 * `skip` / `limit`; no default or maximum page size is documented, so none is
 * sent and the whole list is read in one request. Only the global endpoint is
 * supported; sites hosted in Lever's EU region live on api.eu.lever.co.
 *
 * Observed on live sites (leverdemo, palantir, spotify) on 2026-10-27, beyond
 * the README: `createdAt` (epoch milliseconds) is present, `workplaceType` also
 * comes as `onsite`, and `salaryRange.interval` was `per-year-salary`.
 */
export const LEVER_ORIGIN = 'https://api.lever.co';

const leverPostingSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  categories: z
    .object({
      location: z.string().nullish(),
      commitment: z.string().nullish(),
      allLocations: z.array(z.string()).nullish(),
    })
    .nullish(),
  workplaceType: z.string().nullish(),
  createdAt: z.number().nullish(),
  descriptionPlain: z.string().nullish(),
  descriptionBodyPlain: z.string().nullish(),
  openingPlain: z.string().nullish(),
  lists: z.array(z.object({ text: z.string().nullish(), content: z.string().nullish() })).nullish(),
  additionalPlain: z.string().nullish(),
  hostedUrl: z.string().nullish(),
  applyUrl: z.string().nullish(),
  salaryRange: z
    .object({
      min: z.number().nullish(),
      max: z.number().nullish(),
      currency: z.string().nullish(),
      interval: z.string().nullish(),
    })
    .nullish(),
});

type LeverPosting = z.infer<typeof leverPostingSchema>;

/** Lever's own wording for an annual salary; hourly or monthly figures are not comparable with the annual columns. */
const ANNUAL_INTERVAL = 'per-year-salary';

/** Opening, body, each list (heading plus items) and the closing, as one readable text. */
function describe(posting: LeverPosting): string | null {
  const parts: string[] = [];
  // `descriptionPlain` is opening plus body; fall back to the pieces when a site omits it.
  const lead = posting.descriptionPlain ?? [posting.openingPlain, posting.descriptionBodyPlain].filter(Boolean).join('\n');
  parts.push(lead);
  for (const list of posting.lists ?? []) {
    if (list.text) parts.push(list.text);
    if (list.content) parts.push(htmlToText(list.content));
  }
  if (posting.additionalPlain) parts.push(posting.additionalPlain);
  return tidyDescription(parts);
}

function toPosting(posting: LeverPosting, companyName: string): RawJobPosting {
  const range = posting.salaryRange;
  const annual = range?.interval === ANNUAL_INTERVAL;
  const salaryMin = annual ? toWholeAmount(range?.min) : null;
  const salaryMax = annual ? toWholeAmount(range?.max) : null;
  const hasSalary = salaryMin !== null || salaryMax !== null;

  return {
    source: 'lever',
    external_id: posting.id,
    title: posting.text,
    company_name: companyName,
    description: describe(posting),
    location: joinLocations([...(posting.categories?.allLocations ?? []), posting.categories?.location]),
    remote_type: posting.workplaceType ?? null,
    employment_type: posting.categories?.commitment ?? null,
    salary_min: hasSalary ? salaryMin : null,
    salary_max: hasSalary ? salaryMax : null,
    salary_currency: hasSalary ? (range?.currency ?? null) : null,
    apply_url: posting.applyUrl ?? posting.hostedUrl ?? null,
    posted_at: toIsoTimestamp(posting.createdAt),
  };
}

export function mapLeverPostings(payload: unknown, context: MapperContext) {
  if (!Array.isArray(payload)) {
    // A failed request comes back as an object with an `ok: false` flag, not as an array.
    const body = asRecord(payload);
    throw new SourcePayloadError(
      body === null ? 'Lever response is not a JSON array' : 'Lever response is an object, not an array of postings',
    );
  }
  return collectPostings(payload, leverPostingSchema, (posting) => toPosting(posting, context.companyName));
}

export const leverAdapter: ProviderAdapter = {
  provider: 'lever',
  origin: LEVER_ORIGIN,
  buildUrl(boardToken) {
    const url = new URL(`/v0/postings/${encodeURIComponent(boardToken)}`, LEVER_ORIGIN);
    url.searchParams.set('mode', 'json');
    return url;
  },
  map: mapLeverPostings,
};
