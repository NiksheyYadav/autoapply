import { describe, expect, it } from 'vitest';
import {
  APPLICATION_STATUSES,
  adminFunnelQuerySchema,
  adminFunnelResponseSchema,
  emptyApplicationStatusCounts,
  type AdminFunnelResponse,
} from '@atlas/types';
import { barPercent, buildFunnelStages, funnelQueryString, statusRows, toFunnelQuery } from '../src/lib/funnel';

describe('toFunnelQuery', () => {
  it('leaves both ends open when both fields are empty', () => {
    expect(toFunnelQuery({ from: '', to: '' })).toEqual({ ok: true, query: {} });
  });

  it('sends inclusive days as a half-open UTC window', () => {
    expect(toFunnelQuery({ from: '2026-09-01', to: '2026-09-30' })).toEqual({
      ok: true,
      query: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
    });
  });

  it('handles month, year and leap-day rollovers in the end date', () => {
    expect(toFunnelQuery({ from: '', to: '2026-12-31' })).toEqual({ ok: true, query: { to: '2027-01-01T00:00:00.000Z' } });
    expect(toFunnelQuery({ from: '', to: '2028-02-28' })).toEqual({ ok: true, query: { to: '2028-02-29T00:00:00.000Z' } });
    expect(toFunnelQuery({ from: '', to: '2028-02-29' })).toEqual({ ok: true, query: { to: '2028-03-01T00:00:00.000Z' } });
    expect(toFunnelQuery({ from: '', to: '2026-02-28' })).toEqual({ ok: true, query: { to: '2026-03-01T00:00:00.000Z' } });
  });

  it('treats a single day as a one-day window the API accepts', () => {
    const result = toFunnelQuery({ from: '2026-10-27', to: '2026-10-27' });
    expect(result).toEqual({
      ok: true,
      query: { from: '2026-10-27T00:00:00.000Z', to: '2026-10-28T00:00:00.000Z' },
    });
    if (result.ok) expect(adminFunnelQuerySchema.safeParse(result.query).success).toBe(true);
  });

  it('produces queries the shared API schema accepts for any ordered pair', () => {
    const result = toFunnelQuery({ from: '2026-01-31', to: '2026-03-01' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(adminFunnelQuerySchema.safeParse(result.query).success).toBe(true);
  });

  it('rejects an end before the start', () => {
    expect(toFunnelQuery({ from: '2026-10-02', to: '2026-10-01' })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/on or before/),
    });
  });

  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '26-01-01', '2026/01/01', 'tomorrow', '2026-1-1'])(
    'rejects %j as a date',
    (value) => {
      expect(toFunnelQuery({ from: value, to: '' }).ok).toBe(false);
      expect(toFunnelQuery({ from: '', to: value }).ok).toBe(false);
    },
  );

  it('serialises only the ends that are set', () => {
    expect(funnelQueryString({})).toBe('');
    expect(funnelQueryString({ from: '2026-09-01T00:00:00.000Z' })).toBe('from=2026-09-01T00%3A00%3A00.000Z');
    expect(funnelQueryString({ from: 'a', to: 'b' })).toBe('from=a&to=b');
  });
});

describe('barPercent', () => {
  it.each([
    [0, 0, 0],
    [5, 0, 0],
    [0, 10, 0],
    [5, 10, 50],
    [10, 10, 100],
    [15, 10, 100],
    [-3, 10, 0],
    [Number.NaN, 10, 0],
    [3, Number.POSITIVE_INFINITY, 0],
  ])('%d of %d is %d', (count, total, expected) => {
    expect(barPercent(count, total)).toBe(expected);
  });
});

const funnel: AdminFunnelResponse = {
  organization_id: '0b6d2a4e-6f43-4a39-9a43-4a1d3c1a8e11',
  range: { from: null, to: null },
  generated_at: '2026-10-27T12:00:00.000Z',
  roster: { size: 120, signed_up: 100, sharing_enabled: 40 },
  resumes: { students_with_resume: 30, students_with_ats_score: 25, avg_ats_score: 71.4 },
  applications: {
    total: 55,
    students_applied: 20,
    by_status: { ...emptyApplicationStatusCounts(), submitted: 40, interviewing: 10, offer: 5 },
  },
  offers: { applications: 5, students: 4 },
};

describe('buildFunnelStages', () => {
  it('lists the API’s counts in order and invents none', () => {
    const stages = buildFunnelStages(funnel);
    expect(stages.map((stage) => [stage.key, stage.count])).toEqual([
      ['roster', 120],
      ['signed_up', 100],
      ['sharing', 40],
      ['resume', 30],
      ['ats', 25],
      ['applied', 20],
      ['offer', 4],
    ]);
  });

  it('labels roster stages as "now" and activity stages as range-scoped', () => {
    const basis = Object.fromEntries(buildFunnelStages(funnel).map((stage) => [stage.key, stage.basis]));
    expect(basis).toEqual({
      roster: 'now',
      signed_up: 'now',
      sharing: 'now',
      resume: 'range',
      ats: 'range',
      applied: 'range',
      offer: 'range',
    });
  });

  it('passes zeros through as zeros', () => {
    const empty: AdminFunnelResponse = {
      ...funnel,
      roster: { size: 0, signed_up: 0, sharing_enabled: 0 },
      resumes: { students_with_resume: 0, students_with_ats_score: 0, avg_ats_score: null },
      applications: { total: 0, students_applied: 0, by_status: emptyApplicationStatusCounts() },
      offers: { applications: 0, students: 0 },
    };
    expect(buildFunnelStages(empty).every((stage) => stage.count === 0)).toBe(true);
  });

  it('works on a payload the shared response schema accepts', () => {
    expect(adminFunnelResponseSchema.safeParse(funnel).success).toBe(true);
  });
});

describe('statusRows', () => {
  it('returns every lifecycle status in order with the API’s counts', () => {
    const rows = statusRows(funnel.applications.by_status);
    expect(rows.map((row) => row.status)).toEqual([...APPLICATION_STATUSES]);
    expect(rows.find((row) => row.status === 'submitted')?.count).toBe(40);
    expect(rows.find((row) => row.status === 'draft')?.count).toBe(0);
  });

  it('reads a status the API left out as 0 rather than undefined', () => {
    const rows = statusRows({ offer: 2 });
    expect(rows).toHaveLength(APPLICATION_STATUSES.length);
    expect(rows.every((row) => Number.isInteger(row.count))).toBe(true);
  });
});
