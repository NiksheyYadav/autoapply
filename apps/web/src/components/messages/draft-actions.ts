/**
 * Pure helpers behind the Messages page. Atlas does not send email: it shows a
 * draft, and the person copies it or opens it in their own mail app. Nothing in
 * here touches React or the DOM, so it is unit tested directly
 * (apps/web/test/message-draft-actions.test.ts).
 */

/**
 * A `mailto:` URL longer than this is refused rather than shortened. Mail
 * clients and the OS handlers in front of them cut long links off (classic
 * Windows handlers stop around 2,000 characters), and a draft whose ending was
 * silently dropped is worse than one that has to be copied.
 */
export const MAX_MAILTO_LENGTH = 2000;

// The control-character ranges below are the point of these patterns, not an accident.
/** Line breaks in the sense mail headers care about: CR, LF, NEL and the Unicode separators. */
// eslint-disable-next-line no-control-regex
const HEADER_BREAKS_AND_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
/** Control characters that have no business in a body; tab, LF and CR are kept. */
// eslint-disable-next-line no-control-regex
const BODY_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** `encodeURIComponent` throws on a lone surrogate; swap each one for U+FFFD and keep valid pairs. */
function withoutLoneSurrogates(value: string): string {
  return value.replace(
    /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g,
    (match) => (match.length === 2 ? match : '\uFFFD'),
  );
}

/**
 * Makes a value safe to use as a mail header (the subject): every run of line
 * breaks and control characters becomes one space. A CR or LF left in a header
 * value is how a second header (`Bcc:`) gets smuggled in behind a subject.
 */
export function toHeaderValue(value: string): string {
  return withoutLoneSurrogates(value).replace(HEADER_BREAKS_AND_CONTROLS, ' ').replace(/ {2,}/g, ' ').trim();
}

/** Body text with every line break as CRLF (what RFC 6068 wants in a `body` field) and no stray control characters. */
export function toMailBody(value: string): string {
  return withoutLoneSurrogates(value).replace(BODY_CONTROLS, '').replace(/\r\n|\r|\n|\u2028|\u2029/g, '\r\n');
}

const LOCAL_PART = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * Returns the address if it is one plain address, otherwise `null` (so the
 * link opens with an empty To field rather than a doubtful one). Deliberately
 * stricter than the RFCs: no quoted strings, no display names, no lists. A
 * comma, semicolon, space, angle bracket or line break means this is not a
 * single address, and a smuggled `?bcc=` or `&cc=` never reaches the URL.
 */
export function safeRecipient(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const address = value.trim();
  if (address.length === 0 || address.length > 254) return null;

  const at = address.lastIndexOf('@');
  if (at < 1) return null;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  if (!LOCAL_PART.test(local)) return null;

  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) return null;
  return address;
}

export interface MailtoInput {
  /** The contact's address, when it is known. */
  to?: string | null;
  subject?: string | null;
  body: string;
}

/**
 * Builds the `mailto:` link for "Open in my email app", or `null` when there is
 * nothing safe to build (the result would exceed `MAX_MAILTO_LENGTH`).
 *
 * - Every value is percent-encoded, so `&`, `=`, `?`, `#` and `%` inside the
 *   subject or body stay text and cannot start another header field.
 * - The subject has its line breaks and control characters removed, and the
 *   recipient must be a single plain address; anything else is dropped.
 * - The body keeps its line breaks, as CRLF (`%0D%0A`).
 */
export function buildMailtoUrl({ to, subject, body }: MailtoInput): string | null {
  const recipient = safeRecipient(to);
  const fields: string[] = [];

  const cleanSubject = typeof subject === 'string' ? toHeaderValue(subject) : '';
  if (cleanSubject.length > 0) fields.push(`subject=${encodeURIComponent(cleanSubject)}`);
  fields.push(`body=${encodeURIComponent(toMailBody(body))}`);

  // `@` is left as it is (RFC 6068 allows it in a mailto path); everything else is encoded.
  const path = recipient === null ? '' : recipient.split('@').map(encodeURIComponent).join('@');
  const url = `mailto:${path}?${fields.join('&')}`;
  return url.length > MAX_MAILTO_LENGTH ? null : url;
}

/**
 * Puts text on the clipboard. Resolves `false` rather than throwing when the
 * browser has no clipboard API, or refuses (insecure page, permission denied),
 * so the caller can tell the person to copy by hand.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** What "Copy message" puts on the clipboard: the subject on its own line, a blank line, then the body. */
export function formatMessageForCopy({ subject, body }: { subject: string | null; body: string }): string {
  const text = body.replace(/\r\n|\r/g, '\n');
  const cleanSubject = typeof subject === 'string' ? toHeaderValue(subject) : '';
  return cleanSubject.length > 0 ? `Subject: ${cleanSubject}\n\n${text}` : text;
}

/** Statuses whose text the person can still send themselves. */
const UNSENT_STATUSES: ReadonlySet<string> = new Set(['draft', 'scheduled', 'failed']);
/** Statuses `POST /v1/messages/:id/mark-sent` accepts. */
const RECORDABLE_STATUSES: ReadonlySet<string> = new Set(['draft', 'scheduled']);

/** Whether to offer "Open in my email app": only for text that has not gone out. */
export function canOpenInMailApp(status: string): boolean {
  return UNSENT_STATUSES.has(status);
}

/** Whether to offer "I sent this": exactly the statuses the API will accept. */
export function canRecordAsSent(status: string): boolean {
  return RECORDABLE_STATUSES.has(status);
}

/**
 * What the badge says. `sent` means the person told us they sent it (Atlas
 * delivers nothing), and says so; the other statuses use the app-wide labels.
 */
export function messageStatusLabel(status: string): string {
  if (status === 'sent') return 'Marked as sent';
  if (status === 'scheduled') return 'Draft';
  return status.charAt(0).toUpperCase() + status.slice(1).replaceAll('_', ' ');
}

/** A short plain-language explanation shown under a message whose status needs one. */
export function messageStatusNote(status: string): string | null {
  switch (status) {
    case 'sent':
      return 'You told us you sent this yourself. Atlas does not send email, so this is your record, not a delivery receipt.';
    case 'scheduled':
      return 'This was scheduled, but Atlas does not send scheduled messages. Send it yourself, then mark it as sent.';
    case 'failed':
      return 'An earlier attempt to send this failed. You can still copy it or open it in your email app.';
    default:
      return null;
  }
}

/** The text shown when recording a send fails; never the raw server message. */
export function describeMarkSentFailure(status: number | null): string {
  if (status === 404) return 'We could not find this message. Reload the page and try again.';
  if (status === 409) return 'This message cannot be marked as sent. Reload the page to see its current state.';
  if (status === 401) return 'Your session has expired. Sign in again to continue.';
  return 'We could not save that. Check your connection and try again.';
}

interface ContactWithEmail {
  contact: { contact_id: string; email: string | null };
}

/**
 * Contact id → address, from the referral list, for the contacts that have a
 * usable address. A message to a contact missing from this map simply opens
 * with an empty To field.
 */
export function recipientsByContactId(items: readonly ContactWithEmail[]): Map<string, string> {
  const recipients = new Map<string, string>();
  for (const { contact } of items) {
    const address = safeRecipient(contact.email);
    if (address !== null) recipients.set(contact.contact_id, address);
  }
  return recipients;
}
