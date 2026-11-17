import { describe, expect, it } from 'vitest';
import { cronSecretSchema } from '../src/index.js';

const SECRET = 'correct-horse-battery-staple-1234';

describe('CRON_SECRET', () => {
  it('accepts a long secret and drops the whitespace a dashboard paste leaves around it', () => {
    expect(cronSecretSchema.parse(SECRET)).toBe(SECRET);
    expect(cronSecretSchema.parse(`${SECRET}\n`)).toBe(SECRET);
    expect(cronSecretSchema.parse(`  ${SECRET}\r\n`)).toBe(SECRET);
  });

  it.each([
    ['empty', ''],
    ['only whitespace', ' '.repeat(40)],
    ['too short', 'short-secret'],
    ['short once trimmed', `  ${'a'.repeat(10)}  `],
    ['whitespace inside', 'correct horse battery staple'],
    ['a tab inside', 'correct\thorse-battery-staple-1234'],
    ['a newline inside', 'correct-horse\nbattery-staple-1234'],
  ])('refuses a secret that is %s', (_label, value) => {
    expect(cronSecretSchema.safeParse(value).success).toBe(false);
  });
});
