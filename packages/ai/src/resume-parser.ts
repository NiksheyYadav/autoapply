import type { ContactDetails, DateRange, EducationEntry, ExperienceEntry, ParsedProfile, Skill } from '@atlas/types';
import { extractSkillKeywords } from './skills.js';

/**
 * Deterministic, regex/keyword-based resume parsing — deliberately not an LLM
 * call (docs/09: no unconfigured external model calls; no LLM key exists in
 * this repo's env yet). It's real, working extraction for well-formatted
 * resumes, isolated behind this one function so a model-backed extractor can
 * replace the body later without profile-service noticing.
 */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;
const URL_RE = /\bhttps?:\/\/[^\s,;)]+|(?:www\.)[^\s,;)]+/gi;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** `Jan 2020`, `January 2020`, or `2020` on its own. */
const MONTH_YEAR_RE = /\b([a-z]{3,9})?\.?\s*(\d{4})\b/i;
const DATE_RANGE_RE =
  /((?:[a-z]{3,9}\.?\s*)?\d{4}|present|current)\s*(?:-|–|—|to)\s*((?:[a-z]{3,9}\.?\s*)?\d{4}|present|current)/i;

const EMPTY_SECTIONS = { summary: '', experience: '', education: '', skills: '', certifications: '' };

const SECTION_HEADERS: Record<keyof typeof EMPTY_SECTIONS, RegExp> = {
  summary: /^(summary|profile|objective|about)\s*:?$/i,
  experience: /^(experience|work experience|employment( history)?|professional experience)\s*:?$/i,
  education: /^education\s*:?$/i,
  skills: /^(skills|technical skills|core competencies)\s*:?$/i,
  certifications: /^(certifications?|licenses?)\s*:?$/i,
};

function splitIntoSections(lines: string[]): Record<keyof typeof EMPTY_SECTIONS, string> {
  const sections = { ...EMPTY_SECTIONS };
  let current: keyof typeof EMPTY_SECTIONS | null = null;
  const buffers: Record<string, string[]> = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const matchedHeader = (Object.keys(SECTION_HEADERS) as (keyof typeof EMPTY_SECTIONS)[]).find((key) =>
      SECTION_HEADERS[key].test(line),
    );
    if (matchedHeader) {
      current = matchedHeader;
      buffers[current] ??= [];
      continue;
    }
    if (current) {
      const bucket = (buffers[current] ??= []);
      bucket.push(rawLine);
    }
  }

  for (const key of Object.keys(sections) as (keyof typeof EMPTY_SECTIONS)[]) {
    sections[key] = (buffers[key] ?? []).join('\n').trim();
  }
  return sections;
}

function extractContact(text: string): ContactDetails {
  const email = text.match(EMAIL_RE)?.[0] ?? null;
  const phone = text.match(PHONE_RE)?.[0] ?? null;
  const links = Array.from(new Set(text.match(URL_RE) ?? []))
    .map((url) => (url.startsWith('http') ? url : `https://${url}`))
    .slice(0, 20);
  return { email, phone, location: null, links };
}

function guessFullName(firstLines: string[]): string | null {
  const candidate = firstLines.find((line) => line.trim().length > 0)?.trim();
  if (!candidate) return null;
  const words = candidate.split(/\s+/);
  const looksLikeName = words.length <= 5 && !candidate.includes('@') && !/\d/.test(candidate);
  return looksLikeName ? candidate : null;
}

function parseDateRange(text: string): DateRange {
  const match = text.match(DATE_RANGE_RE);
  if (!match) return { start: null, end: null, is_current: false };
  const start = toYearMonth(match[1] ?? '');
  const endRaw = (match[2] ?? '').trim().toLowerCase();
  const isCurrent = endRaw === 'present' || endRaw === 'current';
  const end = isCurrent ? null : toYearMonth(match[2] ?? '');
  return { start, end, is_current: isCurrent };
}

function toYearMonth(fragment: string): string | null {
  const match = fragment.match(MONTH_YEAR_RE);
  if (!match) return null;
  const year = match[2];
  const monthName = match[1]?.slice(0, 3).toLowerCase();
  const month = monthName ? MONTHS[monthName] : undefined;
  if (!year) return null;
  return `${year}-${String(month ?? 1).padStart(2, '0')}`;
}

function monthsBetween(range: DateRange): number {
  if (!range.start) return 0;
  const [startYear, startMonth] = range.start.split('-').map(Number);
  if (startYear === undefined || startMonth === undefined) return 0;

  let endYear: number;
  let endMonth: number;
  if (range.is_current) {
    const now = new Date();
    endYear = now.getFullYear();
    endMonth = now.getMonth() + 1;
  } else if (range.end) {
    const [y, m] = range.end.split('-').map(Number);
    if (y === undefined || m === undefined) return 0;
    endYear = y;
    endMonth = m;
  } else {
    return 0;
  }

  return Math.max(0, (endYear - startYear) * 12 + (endMonth - startMonth));
}

function guessEmploymentType(paragraph: string): ExperienceEntry['employment_type'] {
  const lower = paragraph.toLowerCase();
  if (lower.includes('intern')) return 'internship';
  if (lower.includes('contract')) return 'contract';
  if (lower.includes('part-time') || lower.includes('part time')) return 'part_time';
  return 'full_time';
}

function splitParagraphs(section: string): string[] {
  return section
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function parseExperience(section: string): ExperienceEntry[] {
  return splitParagraphs(section)
    .slice(0, 100)
    .map((paragraph): ExperienceEntry | null => {
      const lines = paragraph.split('\n').map((l) => l.trim()).filter(Boolean);
      const header = lines[0];
      if (!header) return null;
      const separated = header.match(/^(.+?)\s*(?:@|,| at |—|-)\s*(.+)$/);
      const title = (separated?.[1] ?? header).trim().slice(0, 200) || 'Unknown role';
      const company = (separated?.[2] ?? 'Unknown company').trim().slice(0, 200);
      const highlights = lines
        .slice(1)
        .filter((line) => !DATE_RANGE_RE.test(line))
        .map((line) => line.replace(/^[•*\-–]\s*/, '').trim())
        .filter((line) => line.length > 0)
        .slice(0, 50)
        .map((line) => line.slice(0, 1000));
      return {
        company,
        title,
        location: null,
        employment_type: guessEmploymentType(paragraph),
        period: parseDateRange(paragraph),
        highlights,
      };
    })
    .filter((entry): entry is ExperienceEntry => entry !== null);
}

function parseEducation(section: string): EducationEntry[] {
  return splitParagraphs(section)
    .slice(0, 50)
    .map((paragraph): EducationEntry => {
      const lines = paragraph.split('\n').map((l) => l.trim()).filter(Boolean);
      const institution = (lines[0] ?? 'Unknown institution').slice(0, 200);
      const degreeMatch = paragraph.match(/\b(bachelor'?s?|master'?s?|b\.?s\.?|m\.?s\.?|ph\.?d\.?|associate'?s?)[^\n,]*/i);
      const fieldMatch = paragraph.match(/\bin\s+([a-z\s]{2,60})/i);
      const gpaMatch = paragraph.match(/gpa[:\s]*([0-4]\.\d{1,2}|[0-9](?:\.\d{1,2})?|10)/i);
      return {
        institution,
        degree: degreeMatch ? degreeMatch[0].trim().slice(0, 200) : null,
        field_of_study: fieldMatch ? (fieldMatch[1] ?? '').trim().slice(0, 200) : null,
        period: parseDateRange(paragraph),
        gpa: gpaMatch?.[1] ? Math.min(10, Number(gpaMatch[1])) : null,
      };
    });
}

function parseSkills(skillsSection: string, fullText: string): Skill[] {
  const fromSection = skillsSection
    .split(/[,•|;\n]/)
    .map((raw) => raw.trim())
    .filter((raw) => raw.length > 0 && raw.length <= 120);

  const fromKeywordScan = extractSkillKeywords(fullText);

  const byName = new Map<string, Skill>();
  for (const raw of [...fromSection, ...fromKeywordScan]) {
    const name = raw.toLowerCase();
    if (!byName.has(name)) {
      byName.set(name, { name, raw, months_experience: null });
    }
  }
  return Array.from(byName.values()).slice(0, 300);
}

export function parseResumeText(rawText: string): ParsedProfile {
  const text = rawText.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const sections = splitIntoSections(lines);

  const contact = extractContact(text);
  const fullName = guessFullName(lines.slice(0, 3));
  const experience = parseExperience(sections.experience);
  const education = parseEducation(sections.education);
  const skills = parseSkills(sections.skills, text);
  const certifications = sections.certifications
    .split(/[,\n]/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .slice(0, 100)
    .map((c) => c.slice(0, 300));

  const totalMonths = experience.reduce((sum, entry) => sum + monthsBetween(entry.period), 0);

  return {
    full_name: fullName,
    headline: null,
    summary: sections.summary.length > 0 ? sections.summary.slice(0, 4000) : null,
    contact,
    skills,
    experience,
    education,
    certifications,
    keywords: Array.from(new Set(skills.map((s) => s.name))).slice(0, 400),
    total_months_experience: totalMonths,
  };
}
