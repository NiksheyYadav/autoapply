import type { AccountExport, ExportTruncatableSection, ExportTruncation } from '@atlas/types';

/**
 * How big one account export may get.
 *
 * Two independent bounds, both reported in the file itself (`truncated`) so a
 * cut-short export never passes for a complete one:
 *   - a row cap per list section, applied in SQL, so one user cannot make the
 *     function read an unbounded table into memory;
 *   - a byte budget on the serialized document. Vercel Functions cannot send a
 *     response body larger than 4.5 MB, so the default leaves headroom below it.
 */
export interface ExportLimits {
  maxBytes: number;
  rows: Record<ExportTruncatableSection, number>;
}

export const DEFAULT_EXPORT_LIMITS: ExportLimits = {
  maxBytes: 3_500_000,
  rows: {
    organization_memberships: 200,
    student_records: 200,
    resumes: 50,
    applications: 2_000,
    application_events: 20_000,
    messages: 2_000,
    job_scores: 5_000,
    activity_events: 5_000,
    connected_accounts: 100,
  },
};

/** The one serializer for the download, so the budget measures exactly what is sent. */
export function serializeExport(doc: AccountExport): string {
  return JSON.stringify(doc, null, 2);
}

export function exportByteLength(doc: AccountExport): number {
  return Buffer.byteLength(serializeExport(doc), 'utf8');
}

interface TrimmableSection {
  name: ExportTruncatableSection;
  count(): number;
  /** Keeps the first `n` rows. Lists are ordered most-relevant first, so the tail is what goes. */
  keep(n: number): void;
  /** Serialized size of just this section, to pick the biggest one to cut. */
  weight(): number;
}

function listSection<T>(
  name: ExportTruncatableSection,
  read: () => T[],
  write: (rows: T[]) => void,
): TrimmableSection {
  return {
    name,
    count: () => read().length,
    keep: (n) => write(read().slice(0, n)),
    weight: () => Buffer.byteLength(JSON.stringify(read()), 'utf8'),
  };
}

function trimmableSections(doc: AccountExport): TrimmableSection[] {
  return [
    listSection(
      'resumes',
      () => doc.resumes,
      (rows) => {
        doc.resumes = rows;
      },
    ),
    listSection(
      'applications',
      () => doc.applications,
      (rows) => {
        doc.applications = rows;
      },
    ),
    {
      // Events are nested under their application; the cap counts them all together.
      name: 'application_events',
      count: () => doc.applications.reduce((total, application) => total + application.events.length, 0),
      keep: (n) => {
        let remaining = n;
        for (const application of doc.applications) {
          application.events = application.events.slice(0, remaining);
          remaining -= application.events.length;
        }
      },
      weight: () =>
        Buffer.byteLength(JSON.stringify(doc.applications.map((application) => application.events)), 'utf8'),
    },
    listSection(
      'messages',
      () => doc.messages,
      (rows) => {
        doc.messages = rows;
      },
    ),
    listSection(
      'job_scores',
      () => doc.job_scores,
      (rows) => {
        doc.job_scores = rows;
      },
    ),
    listSection(
      'activity_events',
      () => doc.activity_events,
      (rows) => {
        doc.activity_events = rows;
      },
    ),
  ];
}

/**
 * Cuts `doc` down to `maxBytes`, in place, by repeatedly halving whichever list
 * section is currently the heaviest. The account, memberships and the other small
 * sections are never cut here. Every cut is recorded in `doc.truncated`. Returns
 * the serialized document, which is within budget unless nothing trimmable is
 * left (the unconditional parts alone are far below any sane budget).
 */
export function fitExportToBudget(doc: AccountExport, maxBytes: number): string {
  const sections = trimmableSections(doc);
  let serialized = serializeExport(doc);

  while (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    const candidates = sections.filter((section) => section.count() > 0);
    if (candidates.length === 0) break;

    let heaviest = candidates[0]!;
    let heaviestWeight = heaviest.weight();
    for (const candidate of candidates.slice(1)) {
      const weight = candidate.weight();
      if (weight > heaviestWeight) {
        heaviest = candidate;
        heaviestWeight = weight;
      }
    }

    heaviest.keep(Math.floor(heaviest.count() / 2));
    recordTruncation(doc.truncated, { section: heaviest.name, returned: heaviest.count(), reason: 'size_limit' });
    serialized = serializeExport(doc);
  }

  return serialized;
}

/** One entry per section: a later cut of the same section updates it instead of adding another. */
export function recordTruncation(truncated: ExportTruncation[], entry: ExportTruncation): void {
  const existing = truncated.find((item) => item.section === entry.section);
  if (!existing) {
    truncated.push(entry);
    return;
  }
  existing.returned = entry.returned;
  // A size cut after a row cap is the more informative reason: it is what the file last hit.
  existing.reason = entry.reason === 'size_limit' ? 'size_limit' : existing.reason;
}
