import { afterEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_STATUSES } from '@atlas/types';
import {
  MAX_MAILTO_LENGTH,
  buildMailtoUrl,
  canOpenInMailApp,
  canRecordAsSent,
  copyText,
  describeMarkSentFailure,
  formatMessageForCopy,
  messageStatusLabel,
  messageStatusNote,
  recipientsByContactId,
  safeRecipient,
  toHeaderValue,
  toMailBody,
} from '../src/components/messages/draft-actions';

// Built from char codes so no tool or editor can turn these into invisible literals.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const NEXT_LINE = String.fromCharCode(0x85);
const NUL = String.fromCharCode(0);
const VERTICAL_TAB = String.fromCharCode(0x0b);
/** Everything that must never survive in a mail header value. */
const BREAK_CHARACTERS = ['\r', '\n', LINE_SEPARATOR, PARAGRAPH_SEPARATOR, NEXT_LINE, NUL];

/** Parses the way a mail client does: split the query into fields and decode each. */
function parse(url: string) {
  expect(url.startsWith('mailto:')).toBe(true);
  const parsed = new URL(url);
  const fields = new Map<string, string>();
  for (const [key, value] of parsed.searchParams) fields.set(key, value);
  return { to: decodeURIComponent(parsed.pathname), fields, keys: [...parsed.searchParams.keys()] };
}

describe('buildMailtoUrl', () => {
  it('builds a link with the recipient, an encoded subject and a CRLF body', () => {
    const url = buildMailtoUrl({ to: 'grace@example.com', subject: 'Hello there', body: 'Hi Grace,\n\nThanks!' });
    expect(url).toBe('mailto:grace@example.com?subject=Hello%20there&body=Hi%20Grace%2C%0D%0A%0D%0AThanks!');
  });

  it('leaves the To field empty when the recipient is not known', () => {
    for (const to of [undefined, null, '']) {
      expect(buildMailtoUrl({ to, subject: 'Hi', body: 'Body' })).toBe('mailto:?subject=Hi&body=Body');
    }
  });

  it('leaves the subject out when there is none', () => {
    for (const subject of [undefined, null, '', '   ', '\r\n']) {
      expect(buildMailtoUrl({ to: 'a@example.com', subject, body: 'Body' })).toBe('mailto:a@example.com?body=Body');
    }
  });

  describe('encoding', () => {
    const awkward = 'R&D? a=b #1 100% + "quotes" <tag> /slash\\ ; : @ ~ ünï cødé 日本語 😀';

    it('keeps reserved characters inside the field they were typed in, in the subject and the body', () => {
      const url = buildMailtoUrl({ to: 'a@example.com', subject: awkward, body: awkward })!;
      const { fields, keys } = parse(url);
      expect(keys).toEqual(['subject', 'body']);
      expect(fields.get('subject')).toBe(awkward);
      expect(fields.get('body')).toBe(awkward);
      // The raw URL carries none of them unescaped.
      expect(url.slice(url.indexOf('?') + 1).replace(/subject=|&body=/g, '')).not.toMatch(/[ "<>#\\;:&=?]/);
    });

    it('encodes a plus sign so no client reads it as a space', () => {
      const { fields } = parse(buildMailtoUrl({ subject: 'a+b', body: '1+1' })!);
      expect(fields.get('subject')).toBe('a+b');
      expect(fields.get('body')).toBe('1+1');
      expect(buildMailtoUrl({ subject: 'a+b', body: 'x' })).toContain('a%2Bb');
    });

    it('encodes a subject space as %20, never as +', () => {
      expect(buildMailtoUrl({ subject: 'a b', body: 'x' })).toContain('subject=a%20b');
    });

    it('produces only printable ASCII, so nothing in the link can be read as a line break', () => {
      const url = buildMailtoUrl({ to: 'a@example.com', subject: awkward + '\r\n' + LINE_SEPARATOR, body: awkward + '\n\r\n\r' })!;
      expect(url).toMatch(/^[\x21-\x7e]+$/);
    });

    it('does not throw on text that is not valid Unicode (a lone surrogate)', () => {
      const lone = 'broken ' + String.fromCharCode(0xd800) + ' text';
      const url = buildMailtoUrl({ subject: lone, body: lone });
      expect(url).not.toBeNull();
      expect(parse(url!).fields.get('body')).toBe('broken � text');
    });
  });

  describe('body line breaks', () => {
    it('writes every kind of line break as CRLF', () => {
      const url = buildMailtoUrl({ body: `a\nb\r\nc\rd${LINE_SEPARATOR}e${PARAGRAPH_SEPARATOR}f` })!;
      expect(parse(url).fields.get('body')).toBe('a\r\nb\r\nc\r\nd\r\ne\r\nf');
      expect(url).not.toMatch(/(?<!%0D)%0A/);
      expect(url).not.toMatch(/%0D(?!%0A)/);
    });

    it('drops control characters but keeps tabs', () => {
      const url = buildMailtoUrl({ body: `a${NUL}b\tc${VERTICAL_TAB}d${NEXT_LINE}e` })!;
      expect(parse(url).fields.get('body')).toBe('ab\tcde');
    });
  });

  describe('header injection', () => {
    const attacks = [
      'Hello\r\nBcc: evil@example.com',
      'Hello\nBcc: evil@example.com',
      'Hello\rBcc: evil@example.com',
      `Hello${LINE_SEPARATOR}Bcc: evil@example.com`,
      `Hello${PARAGRAPH_SEPARATOR}Bcc: evil@example.com`,
      `Hello${NEXT_LINE}Bcc: evil@example.com`,
      'Hello%0D%0ABcc: evil@example.com',
      'Hello&bcc=evil@example.com',
      'Hello&cc=evil@example.com&body=owned',
      'Hello?bcc=evil@example.com',
      'Hello\r\n\r\nInjected body',
      `Hello${NUL}\r\nBcc: evil@example.com`,
    ];

    it.each(attacks)('keeps the subject %j on one line and adds no header field', (attack) => {
      const url = buildMailtoUrl({ to: 'a@example.com', subject: attack, body: 'Body' })!;
      const { fields, keys, to } = parse(url);

      expect(to).toBe('a@example.com');
      expect(keys).toEqual(['subject', 'body']);
      expect(BREAK_CHARACTERS.some((character) => fields.get('subject')!.includes(character))).toBe(false);
      expect(fields.get('subject')).toBe(toHeaderValue(attack));
      expect(fields.get('body')).toBe('Body');
      // Literal CR/LF never appear as encoded bytes in the subject part of the link either.
      const subjectPart = url.slice(url.indexOf('subject='), url.indexOf('&body='));
      expect(subjectPart).not.toMatch(/%0[AD]/i);
    });

    it('turns the break into a single space so the words are not glued together', () => {
      expect(toHeaderValue('Hello\r\n\r\nthere')).toBe('Hello there');
      expect(toHeaderValue('  a \t b  ')).toBe('a b');
    });

    it('never uses line breaks in the body to start a header: they stay in the body field', () => {
      const url = buildMailtoUrl({ to: 'a@example.com', subject: 'S', body: 'Hi\r\nBcc: evil@example.com' })!;
      const { fields, keys } = parse(url);
      expect(keys).toEqual(['subject', 'body']);
      expect(fields.get('body')).toBe('Hi\r\nBcc: evil@example.com');
    });

    it.each([
      'a@example.com\r\nbcc:evil@example.com',
      'a@example.com\nbcc:evil@example.com',
      'a@example.com,evil@example.com',
      'a@example.com;evil@example.com',
      // A second "address" with no @ of its own: a mail client reads `evil` as a local recipient.
      'evil,a@example.com',
      'evil;a@example.com',
      'a@example.com evil@example.com',
      'a@example.com?bcc=evil@example.com',
      'a@example.com&cc=evil@example.com',
      'a@example.com%0d%0abcc:evil@example.com',
      '<a@example.com>',
      'Grace <a@example.com>',
      '"a@example.com"',
    ])('drops the recipient %j rather than passing it on', (to) => {
      const url = buildMailtoUrl({ to, subject: 'S', body: 'B' })!;
      expect(url).toBe('mailto:?subject=S&body=B');
    });
  });

  describe('recipient', () => {
    it('accepts ordinary addresses and trims them', () => {
      expect(buildMailtoUrl({ to: '  first.last@sub.example.co.uk ', body: 'B' })).toBe('mailto:first.last@sub.example.co.uk?body=B');
    });

    it('encodes the characters a mailto path cannot carry as they are', () => {
      const url = buildMailtoUrl({ to: "o'brien+jobs@example.com", body: 'B' })!;
      expect(url).toBe("mailto:o'brien%2Bjobs@example.com?body=B");
      expect(parse(url).to).toBe("o'brien+jobs@example.com");
    });

    it.each(['grace', 'grace@', '@example.com', 'grace@example', 'grace@@example.com', 'gra ce@example.com', '.grace@example.com', 'grace.@example.com', 'gr..ace@example.com', 'grace@-example.com', 'grace@example..com', 'grace@example.com.', 'grace@exa_mple.com'])(
      'rejects the malformed address %j',
      (value) => {
        expect(safeRecipient(value)).toBeNull();
      },
    );

    it('rejects an address that is too long', () => {
      expect(safeRecipient(`${'a'.repeat(65)}@example.com`)).toBeNull();
      expect(safeRecipient(`a@${'b'.repeat(250)}.com`)).toBeNull();
      expect(safeRecipient(`${'a'.repeat(64)}@example.com`)).not.toBeNull();
    });
  });

  describe('length', () => {
    it('returns null instead of cutting the message when the link would be too long', () => {
      expect(buildMailtoUrl({ to: 'a@example.com', subject: 'S', body: 'x'.repeat(MAX_MAILTO_LENGTH) })).toBeNull();
      // Non-Latin text grows threefold or more once encoded.
      expect(buildMailtoUrl({ body: '日'.repeat(300) })).toBeNull();
    });

    it('allows a link right up to the limit and no further', () => {
      const overhead = buildMailtoUrl({ body: '' })!.length;
      const exact = buildMailtoUrl({ body: 'x'.repeat(MAX_MAILTO_LENGTH - overhead) })!;
      expect(exact.length).toBe(MAX_MAILTO_LENGTH);
      expect(buildMailtoUrl({ body: 'x'.repeat(MAX_MAILTO_LENGTH - overhead + 1) })).toBeNull();
    });

    it('is comfortable with a typical drafted message', () => {
      const body = 'Hi Grace,\n\nI recently applied for the Backend Engineer role at Acme and noticed you lead the team. '.repeat(3);
      expect(buildMailtoUrl({ to: 'grace@example.com', subject: 'Backend Engineer at Acme', body })).not.toBeNull();
    });
  });
});

describe('toMailBody', () => {
  it('is idempotent on text that already uses CRLF', () => {
    expect(toMailBody('a\r\nb')).toBe('a\r\nb');
    expect(toMailBody(toMailBody('a\nb\rc'))).toBe('a\r\nb\r\nc');
  });
});

describe('formatMessageForCopy', () => {
  it('puts the subject on its own line above the body', () => {
    expect(formatMessageForCopy({ subject: 'Hello', body: 'Line one\nLine two' })).toBe('Subject: Hello\n\nLine one\nLine two');
  });

  it('is just the body when there is no subject', () => {
    expect(formatMessageForCopy({ subject: null, body: 'Body' })).toBe('Body');
    expect(formatMessageForCopy({ subject: '  ', body: 'Body' })).toBe('Body');
  });

  it('uses plain newlines, and keeps a multi-line subject to one line', () => {
    expect(formatMessageForCopy({ subject: 'A\r\nBcc: x', body: 'a\r\nb\rc' })).toBe('Subject: A Bcc: x\n\na\nb\nc');
  });
});

describe('copyText', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes to the clipboard and reports success', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copyText('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('reports failure instead of throwing when the browser refuses', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: async () => {
          throw new Error('NotAllowedError');
        },
      },
    });
    await expect(copyText('hello')).resolves.toBe(false);
  });

  it('reports failure when there is no clipboard API', async () => {
    vi.stubGlobal('navigator', {});
    await expect(copyText('hello')).resolves.toBe(false);
    vi.stubGlobal('navigator', undefined);
    await expect(copyText('hello')).resolves.toBe(false);
  });
});

describe('which actions a status gets', () => {
  const table: Record<(typeof MESSAGE_STATUSES)[number], { open: boolean; record: boolean }> = {
    draft: { open: true, record: true },
    scheduled: { open: true, record: true },
    failed: { open: true, record: false },
    sent: { open: false, record: false },
    delivered: { open: false, record: false },
    replied: { open: false, record: false },
    bounced: { open: false, record: false },
  };

  it('covers every message status the API can return', () => {
    expect(Object.keys(table).sort()).toEqual([...MESSAGE_STATUSES].sort());
  });

  it.each(MESSAGE_STATUSES)('%s', (status) => {
    expect(canOpenInMailApp(status)).toBe(table[status].open);
    // "I sent this" is offered exactly where mark-sent accepts the message (draft and scheduled).
    expect(canRecordAsSent(status)).toBe(table[status].record);
  });
});

describe('status wording', () => {
  it('calls a recorded send what it is: the person saying they sent it', () => {
    expect(messageStatusLabel('sent')).toBe('Marked as sent');
    expect(messageStatusNote('sent')).toMatch(/you sent this yourself/i);
    expect(messageStatusNote('sent')).toMatch(/not a delivery receipt/i);
  });

  it('does not present a scheduled draft as something Atlas will send', () => {
    expect(messageStatusLabel('scheduled')).toBe('Draft');
    expect(messageStatusNote('scheduled')).toMatch(/does not send scheduled messages/i);
  });

  it('never claims Atlas delivered or will deliver anything', () => {
    for (const status of MESSAGE_STATUSES) {
      const text = `${messageStatusLabel(status)} ${messageStatusNote(status) ?? ''}`;
      expect(text).not.toMatch(/\b(we|atlas) (sent|delivered|will send|is sending)\b/i);
      expect(text).not.toMatch(/delivered to/i);
    }
  });

  it('has no note for a plain draft', () => {
    expect(messageStatusNote('draft')).toBeNull();
    expect(messageStatusLabel('draft')).toBe('Draft');
  });
});

describe('describeMarkSentFailure', () => {
  it('gives a plain-language reason and never the raw server text', () => {
    expect(describeMarkSentFailure(404)).toMatch(/could not find/i);
    expect(describeMarkSentFailure(409)).toMatch(/cannot be marked as sent/i);
    expect(describeMarkSentFailure(401)).toMatch(/sign in/i);
    expect(describeMarkSentFailure(500)).toMatch(/try again/i);
    expect(describeMarkSentFailure(null)).toMatch(/try again/i);
  });
});

describe('recipientsByContactId', () => {
  it('keeps only contacts with a usable address', () => {
    const map = recipientsByContactId([
      { contact: { contact_id: 'c1', email: 'grace@example.com' } },
      { contact: { contact_id: 'c2', email: null } },
      { contact: { contact_id: 'c3', email: 'not an address' } },
      { contact: { contact_id: 'c4', email: 'a@example.com,b@example.com' } },
    ]);
    expect([...map.entries()]).toEqual([['c1', 'grace@example.com']]);
  });

  it('is empty for an empty list', () => {
    expect(recipientsByContactId([]).size).toBe(0);
  });
});
