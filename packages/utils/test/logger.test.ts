import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/index.js';

function capture() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const logger = createLogger({ service: 'test-service', level: 'info', destination });
  return { logger, output: () => lines.join('') };
}

const SECRET = 'SECRET-VALUE-MUST-NOT-APPEAR';

describe('createLogger redaction', () => {
  it.each([
    ['a top-level password', { password: SECRET }],
    ['a top-level token', { token: SECRET }],
    ['the authorization header of a request', { req: { headers: { authorization: `Bearer ${SECRET}` } } }],
    ['the cookie header of a request', { req: { headers: { cookie: `sb=${SECRET}` } } }],
    ['a bare headers object', { headers: { authorization: `Bearer ${SECRET}`, cookie: `sb=${SECRET}`, 'x-api-key': SECRET } }],
    ['headers one level down', { request: { headers: { authorization: `Bearer ${SECRET}`, 'x-api-key': SECRET } } }],
    ['a nested secret and api key', { config: { secret: SECRET, api_key: SECRET, client_secret: SECRET, private_key: SECRET } }],
    ['a nested token', { session: { token: SECRET, access_token: SECRET, refresh_token: SECRET } }],
    ['a response cookie', { res: { headers: { 'set-cookie': [`sb=${SECRET}`] } } }],
    ['a resume text', { parsed_text: SECRET }],
    ['a resume text one level down', { resume: { parsed_text: SECRET } }],
  ])('keeps %s out of the log', (_label, fields) => {
    const { logger, output } = capture();
    logger.info(fields, 'something happened');
    expect(output()).toContain('something happened');
    expect(output()).not.toContain(SECRET);
    expect(output()).toContain('[redacted]');
  });

  it('still logs ordinary fields', () => {
    const { logger, output } = capture();
    logger.info({ user_id: 'u-1', route: '/v1/resumes', status: 200 }, 'request completed');
    const entry = JSON.parse(output()) as Record<string, unknown>;
    expect(entry).toMatchObject({ service: 'test-service', user_id: 'u-1', route: '/v1/resumes', status: 200, level: 'info' });
  });

  it('escapes line breaks and control characters in user-controlled text, so one request cannot forge a log line', () => {
    const { logger, output } = capture();
    logger.info({ note: 'first\n{"level":"error","msg":"forged line"}\r\u001b[31m' }, 'user supplied a note');
    const written = output();
    expect(written.trimEnd().split('\n')).toHaveLength(1);
    expect(written).not.toContain('\u001b');
  });
});
