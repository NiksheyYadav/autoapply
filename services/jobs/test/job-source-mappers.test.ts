import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { rawJobPostingSchema } from '@atlas/types';
import {
  clampText,
  FIELD_LIMITS,
  stripUnsafeChars,
  finalizePosting,
  joinLocations,
  SourcePayloadError,
  tidyDescription,
  toIsoTimestamp,
  toWholeAmount,
} from '../src/lib/job-sources/common.js';
import { mapAshbyJobs } from '../src/lib/job-sources/ashby.js';
import { mapGreenhouseJobs } from '../src/lib/job-sources/greenhouse.js';
import { decodeHtmlEntities, htmlToText, stripTags } from '../src/lib/job-sources/html-text.js';
import { mapLeverPostings } from '../src/lib/job-sources/lever.js';
import { coerceEmploymentType, coerceRemoteType } from '../src/lib/normalize.js';

// Fixtures are real responses recorded on 2026-10-27 from public boards (Greenhouse: Figma and
// Anthropic; Lever: leverdemo and spotify; Ashby: ashby and ramp), cut down by hand to a few
// postings with shortened descriptions. Nothing here touches the network.
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

describe('html-text', () => {
  it('decodes named, decimal and hex references once, and leaves unknown ones alone', () => {
    expect(decodeHtmlEntities('Tom &amp; Jerry &#39;s &#x2014; &quot;x&quot; &nbsp;&bogus; &#0; &#xD800;')).toBe(
      'Tom & Jerry \'s — "x"  &bogus; &#0; &#xD800;',
    );
    // "&amp;lt;" is the text "&lt;", not "<".
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
  });

  it('turns markup into readable text: paragraphs, list bullets, line breaks', () => {
    const text = htmlToText('<h2>Role</h2><p>Build <b>things</b>.<br>Ship them.</p><ul><li>One</li><li>Two &amp; three</li></ul>');
    expect(text).toBe('Role\n\nBuild things.\nShip them.\n\n- One\n- Two & three');
  });

  it('drops script and style contents, and keeps a "<" that is not a tag', () => {
    expect(htmlToText('a < b and c <script>alert(1)</script>d<style>p{}</style>e')).toBe('a < b and c d e');
    expect(htmlToText('5 < 6 > 4')).toBe('5 < 6 > 4');
  });

  it('keeps an unterminated tag or script as text instead of looping or losing the rest', () => {
    expect(stripTags('keep <b and the rest')).toBe('keep <b and the rest');
    expect(stripTags('x<script>never closed')).toBe('x<script>never closed'.replace('<script>', ''));
  });

  // Sized so that a stripper which rescans the rest of the input at every "<" (quadratic) needs
  // many seconds, while a single pass needs milliseconds; the bound is generous either way.
  it.each([
    ['a long run of "<"', '<'.repeat(1_500_000)],
    ['many unclosed script tags', '<script>'.repeat(250_000)],
    ['many unclosed style tags', '<style>'.repeat(250_000)],
    ['many unclosed list items', '<li '.repeat(400_000)],
    ['many unclosed tags with attributes', '<a href="x" '.repeat(150_000)],
    ['many entities', '&amp;'.repeat(300_000)],
  ])('runs in linear time on %s', (_label, hostile) => {
    const started = performance.now();
    htmlToText(hostile);
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});

describe('mapper helpers', () => {
  it('removes NUL, control characters and bidi overrides, and keeps tab, newline and ordinary text', () => {
    expect(stripUnsafeChars('a\u0000b\u0007c\u001b[0md\u007fe\u0085f\u202eg\u2066h\u2069i')).toBe('abc[0mdefghi');
    expect(stripUnsafeChars('line one\n\tline two\r\nCafé 日本語 🙂 \u200d')).toBe('line one\n\tline two\r\nCafé 日本語 🙂 \u200d');
    expect(clampText('\u0000\u0007  \u202e ', 10)).toBeNull();
    expect(clampText('Engi\u0000neer', 10)).toBe('Engineer');
  });

  it('clamps and trims text, returning null for blanks', () => {
    expect(clampText('  hi  ', 10)).toBe('hi');
    expect(clampText('abcdef', 3)).toBe('abc');
    expect(clampText('   ', 3)).toBeNull();
    expect(clampText(undefined, 3)).toBeNull();
  });

  it('joins distinct locations, dropping whole entries that do not fit', () => {
    expect(joinLocations(['Berlin', 'berlin', ' Paris ', null, ''])).toBe('Berlin | Paris');
    const long = joinLocations(['A'.repeat(200), 'B'.repeat(200), 'C'.repeat(10)], 300);
    expect(long).toBe('A'.repeat(200));
    expect(joinLocations([null, undefined])).toBeNull();
  });

  it('accepts only plausible timestamps', () => {
    expect(toIsoTimestamp('2026-09-14T13:36:20-04:00')).toBe('2026-09-14T17:36:20.000Z');
    expect(toIsoTimestamp(1788199939703)).toBe(new Date(1788199939703).toISOString());
    expect(toIsoTimestamp('not a date')).toBeNull();
    expect(toIsoTimestamp(0)).toBeNull(); // 1970
    expect(toIsoTimestamp('9999-01-01')).toBeNull();
    expect(toIsoTimestamp(null)).toBeNull();
  });

  it('rounds amounts to whole numbers and refuses negatives and non-numbers', () => {
    expect(toWholeAmount(85000.6)).toBe(85001);
    expect(toWholeAmount(-1)).toBeNull();
    expect(toWholeAmount(Number.NaN)).toBeNull();
    expect(toWholeAmount('85000')).toBeNull();
  });

  it('joins description parts and reports nothing when they are all blank', () => {
    expect(tidyDescription(['  one  ', null, '', 'two\n\n\n\nthree'])).toBe('one\n\ntwo\n\nthree');
    expect(tidyDescription(['  ', null])).toBeNull();
  });

  it('finalizes a posting within the column limits, and refuses one without a title', () => {
    const base = { source: 'lever' as const, external_id: 'x', company_name: 'Acme', title: 't' };
    const long = finalizePosting({ ...base, title: 'T'.repeat(900), location: 'L'.repeat(900), description: 'D'.repeat(300_000) });
    expect(long?.title).toHaveLength(FIELD_LIMITS.title);
    expect(long?.location).toHaveLength(FIELD_LIMITS.location);
    expect(long?.description).toHaveLength(FIELD_LIMITS.description);
    expect(finalizePosting({ ...base, title: '   ' })).toBeNull();
  });
});

describe('Greenhouse mapper', () => {
  const context = { companyName: 'Figma' };

  it('maps a recorded content=true response', () => {
    const { postings, skipped } = mapGreenhouseJobs(fixture('greenhouse-jobs-content.json'), context);
    expect(skipped).toBe(0);
    expect(postings).toHaveLength(2);

    const intern = postings.find((posting) => posting.external_id === '6143238004')!;
    expect(intern).toMatchObject({
      source: 'greenhouse',
      title: 'Software Engineer Intern (Summer 2027)',
      company_name: 'Figma',
      location: 'San Francisco, CA • New York, NY',
      apply_url: 'https://boards.greenhouse.io/figma/jobs/6143238004?gh_jid=6143238004',
      posted_at: '2026-09-14T17:36:20.000Z',
    });
    expect(coerceEmploymentType(intern.employment_type)).toBe('internship');

    const account = postings.find((posting) => posting.external_id === '5426468004')!;
    expect(account.employment_type).toBeNull();
    expect(coerceEmploymentType(account.employment_type)).toBe('unknown');
    expect(coerceRemoteType(account.remote_type)).toBe('unknown');
  });

  it('turns the entity-escaped content into plain text', () => {
    const { postings } = mapGreenhouseJobs(fixture('greenhouse-jobs-content.json'), context);
    for (const posting of postings) {
      const description = posting.description ?? '';
      expect(description).toContain('Figma is growing our team');
      // Escaped markup is gone, and so are leftover entities.
      expect(description).not.toMatch(/&lt;|&gt;|&quot;|&#39;|<[a-z/]/i);
      expect(description).not.toMatch(/\n{3,}/);
      // "you&#39;re" came out as an apostrophe.
      expect(description).toContain("you're");
    }
  });

  it('reads the workplace type from a board that exposes it as a custom field', () => {
    const { postings } = mapGreenhouseJobs(fixture('greenhouse-jobs-metadata.json'), { companyName: 'Anthropic' });
    expect(postings).toHaveLength(1);
    expect(postings[0]).toMatchObject({ title: '3P Revenue Accounting & Reporting', location: 'San Francisco, CA | Seattle, WA' });
    expect(postings[0]?.description).toBeNull();
    expect(coerceRemoteType(postings[0]?.remote_type)).toBe('onsite');
  });

  it('falls back to the location name for "Remote", and to updated_at for the posting date', () => {
    const { postings } = mapGreenhouseJobs(
      { jobs: [{ id: 7, title: 'Engineer', location: { name: 'Remote - US' }, updated_at: '2026-01-02T03:04:05Z' }] },
      context,
    );
    expect(coerceRemoteType(postings[0]?.remote_type)).toBe('remote');
    expect(postings[0]?.posted_at).toBe('2026-01-02T03:04:05.000Z');
  });

  it('skips an entry it cannot use without dropping the board', () => {
    const { postings, skipped } = mapGreenhouseJobs(
      { jobs: [{ id: 1, title: 'Good' }, { title: 'no id' }, { id: 3, title: '   ' }, 'junk', null] },
      context,
    );
    expect(postings.map((posting) => posting.external_id)).toEqual(['1']);
    expect(skipped).toBe(4);
  });

  it('produces postings that satisfy the ingestion contract', () => {
    for (const name of ['greenhouse-jobs-content.json', 'greenhouse-jobs-metadata.json']) {
      for (const posting of mapGreenhouseJobs(fixture(name), context).postings) {
        expect(rawJobPostingSchema.safeParse(posting).success).toBe(true);
      }
    }
  });

  it.each([[null], ['text'], [[]], [{}], [{ jobs: 'nope' }]])('rejects a payload of the wrong shape: %j', (payload) => {
    expect(() => mapGreenhouseJobs(payload, context)).toThrow(SourcePayloadError);
  });

  it('accepts an empty board', () => {
    expect(mapGreenhouseJobs({ jobs: [], meta: { total: 0 } }, context)).toEqual({ postings: [], skipped: 0 });
  });
});

describe('Lever mapper', () => {
  const context = { companyName: 'Lever Demo' };

  it('maps recorded postings', () => {
    const { postings, skipped } = mapLeverPostings(fixture('lever-postings.json'), context);
    expect(skipped).toBe(0);
    expect(postings).toHaveLength(3);

    const manager = postings.find((posting) => posting.title === 'Customer Success Manager')!;
    expect(manager).toMatchObject({
      source: 'lever',
      external_id: 'ad208490-4052-4f91-a57e-433f2d1e484b',
      company_name: 'Lever Demo',
      location: 'Atlanta, Georgia',
      apply_url: 'https://jobs.lever.co/leverdemo/ad208490-4052-4f91-a57e-433f2d1e484b/apply',
      posted_at: new Date(1788199939703).toISOString(),
      salary_min: 85000,
      salary_max: 175000,
      salary_currency: 'USD',
    });
    expect(coerceRemoteType(manager.remote_type)).toBe('hybrid');
    expect(coerceEmploymentType(manager.employment_type)).toBe('full_time');
  });

  it('builds the description from the plain text, every list and the closing', () => {
    const { postings } = mapLeverPostings(fixture('lever-postings.json'), context);

    const manager = postings.find((posting) => posting.title === 'Customer Success Manager')!;
    expect(manager.description).toContain('This is a test job');
    expect(manager.description).toContain('Skill Set:');
    expect(manager.description).toContain('3+ years of customer relationship');

    // A posting whose description is empty still has its lists.
    const dentist = postings.find((posting) => posting.title === 'Dentist')!;
    expect(dentist.description).toMatch(/^Key Responsibilities\n/);
    expect(dentist.description).toContain('Doctor of Dental Surgery');
    expect(coerceRemoteType(dentist.remote_type)).toBe('onsite');

    const spotify = postings.find((posting) => posting.title.startsWith('Account Executive'))!;
    expect(spotify.description?.endsWith('401(k) retirement plan.')).toBe(true);
    // No salaryRange on this posting: nothing invented.
    expect(spotify.salary_min ?? null).toBeNull();
    expect(spotify.salary_currency ?? null).toBeNull();
    expect(coerceEmploymentType(spotify.employment_type)).toBe('unknown');
  });

  it('only reports a salary Lever says is annual', () => {
    const hourly = {
      id: 'a',
      text: 'Barista',
      workplaceType: 'unspecified',
      salaryRange: { min: 18, max: 24.5, currency: 'USD', interval: 'per-hour-wage' },
    };
    const annual = { id: 'b', text: 'Chef', salaryRange: { min: 60000.4, max: 70000, currency: 'EUR', interval: 'per-year-salary' } };
    const { postings } = mapLeverPostings([hourly, annual], context);
    expect(postings[0]?.salary_min ?? null).toBeNull();
    expect(postings[0]?.salary_max ?? null).toBeNull();
    expect(coerceRemoteType(postings[0]?.remote_type)).toBe('unknown');
    expect(postings[1]).toMatchObject({ salary_min: 60000, salary_max: 70000, salary_currency: 'EUR' });
  });

  it('lists every location and falls back to the hosted page when there is no apply link', () => {
    const { postings } = mapLeverPostings(
      [
        {
          id: 'c',
          text: 'Analyst',
          categories: { location: 'Berlin', allLocations: ['Berlin', 'Remote - Germany'] },
          hostedUrl: 'https://jobs.lever.co/x/c',
        },
      ],
      context,
    );
    expect(postings[0]?.location).toBe('Berlin | Remote - Germany');
    expect(postings[0]?.apply_url).toBe('https://jobs.lever.co/x/c');
  });

  it('skips an entry it cannot use', () => {
    const { postings, skipped } = mapLeverPostings([{ id: 'ok', text: 'Fine' }, { id: 'no-title' }, { text: 'no id' }, 7], context);
    expect(postings).toHaveLength(1);
    expect(skipped).toBe(3);
  });

  it('produces postings that satisfy the ingestion contract', () => {
    for (const posting of mapLeverPostings(fixture('lever-postings.json'), context).postings) {
      expect(rawJobPostingSchema.safeParse(posting).success).toBe(true);
    }
  });

  it.each([[null], ['text'], [{ ok: false, error: 'Site not found' }], [{ jobs: [] }]])(
    'rejects a payload that is not an array of postings: %j',
    (payload) => {
      expect(() => mapLeverPostings(payload, context)).toThrow(SourcePayloadError);
    },
  );

  it('accepts an empty site', () => {
    expect(mapLeverPostings([], context)).toEqual({ postings: [], skipped: 0 });
  });
});

describe('Ashby mapper', () => {
  const context = { companyName: 'Ashby' };

  it('maps recorded postings', () => {
    const { postings, skipped } = mapAshbyJobs(fixture('ashby-job-board.json'), context);
    expect(skipped).toBe(0);
    expect(postings).toHaveLength(2);

    const remote = postings.find((posting) => posting.external_id === '7458d4e9-da2e-47bd-98cb-adfda43d42b2')!;
    expect(remote).toMatchObject({
      source: 'ashby',
      title: 'Engineering Manager - EU',
      company_name: 'Ashby',
      location: 'Remote - European Union | Spain | Italy | Germany',
      posted_at: '2024-03-04T14:29:08.532Z',
    });
    expect(remote.apply_url).toMatch(/^https:\/\/jobs\.ashbyhq\.com\/ashby\/7458d4e9/);
    expect(coerceRemoteType(remote.remote_type)).toBe('remote');
    expect(coerceEmploymentType(remote.employment_type)).toBe('full_time');
    expect(remote.description?.length).toBeGreaterThan(100);
    expect(remote.description).not.toMatch(/<[a-z/]/i);
  });

  it('trims a title with stray whitespace and reads Hybrid', () => {
    const { postings } = mapAshbyJobs(fixture('ashby-job-board.json'), context);
    const hybrid = postings.find((posting) => posting.external_id === '34413f8d-26bf-4bbc-8ade-eb309a0e2245')!;
    expect(hybrid.title).toBe('Security Engineer, Cloud');
    expect(coerceRemoteType(hybrid.remote_type)).toBe('hybrid');
  });

  it('does not ingest a posting Ashby says is not publicly listed', () => {
    const { postings, skipped } = mapAshbyJobs(
      { apiVersion: '1', jobs: [{ id: 'a', title: 'Public', isListed: true }, { id: 'b', title: 'Link only', isListed: false }] },
      context,
    );
    expect(postings.map((posting) => posting.title)).toEqual(['Public']);
    expect(skipped).toBe(1);
  });

  it('derives the external id from the job link when the payload has no id', () => {
    const { postings } = mapAshbyJobs(
      {
        jobs: [
          { title: 'From job url', jobUrl: 'https://jobs.ashbyhq.com/acme/6A1F5B0C-1111-4222-8333-444455556666' },
          { title: 'From apply url', applyUrl: 'https://jobs.ashbyhq.com/acme/0b1f5b0c-1111-4222-8333-444455556666/application' },
          { title: 'Nothing to derive it from', jobUrl: 'not a url at all' },
        ],
      },
      context,
    );
    expect(postings.map((posting) => posting.external_id)).toEqual([
      '6a1f5b0c-1111-4222-8333-444455556666',
      '0b1f5b0c-1111-4222-8333-444455556666',
      null,
    ]);
  });

  it('uses the postal address when there is no location string, and never guesses at workplace type from isRemote', () => {
    const { postings } = mapAshbyJobs(
      {
        jobs: [
          {
            id: 'z',
            title: 'Designer',
            location: '  ',
            isRemote: true,
            address: { postalAddress: { addressLocality: 'Lisbon', addressRegion: 'Lisboa', addressCountry: 'Portugal' } },
          },
        ],
      },
      context,
    );
    expect(postings[0]?.location).toBe('Lisbon, Lisboa, Portugal');
    expect(coerceRemoteType(postings[0]?.remote_type)).toBe('unknown');
  });

  it('produces postings that satisfy the ingestion contract', () => {
    for (const posting of mapAshbyJobs(fixture('ashby-job-board.json'), context).postings) {
      expect(rawJobPostingSchema.safeParse(posting).success).toBe(true);
    }
  });

  it.each([[null], ['text'], [[]], [{ apiVersion: '1' }], [{ jobs: {} }]])('rejects a payload of the wrong shape: %j', (payload) => {
    expect(() => mapAshbyJobs(payload, context)).toThrow(SourcePayloadError);
  });
});
