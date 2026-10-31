import { describe, expect, it } from 'vitest';
import { normalizeSupabaseUrl, supabaseAuthEnvSchema } from '../src/index.js';

describe('SUPABASE_URL', () => {
  it.each([
    ['https://abc.supabase.co', 'https://abc.supabase.co'],
    ['https://abc.supabase.co/', 'https://abc.supabase.co'],
    ['  https://abc.supabase.co/  ', 'https://abc.supabase.co'],
    ['https://abc.supabase.co/rest/v1/', 'https://abc.supabase.co'],
    ['HTTPS://ABC.Supabase.co', 'https://abc.supabase.co'],
    ['https://auth.example.com:8443', 'https://auth.example.com:8443'],
    ['http://127.0.0.1:54321', 'http://127.0.0.1:54321'],
    ['http://localhost:54321/', 'http://localhost:54321'],
  ])('reads %j as the origin %j', (value, origin) => {
    expect(normalizeSupabaseUrl(value)).toBe(origin);
    expect(supabaseAuthEnvSchema.parse({ SUPABASE_URL: value }).SUPABASE_URL).toBe(origin);
  });

  // A trailing slash is the one that matters: it used to start fine and refuse every token.
  it.each([
    '',
    'abc.supabase.co',
    'http://abc.supabase.co',
    'http://evil.example',
    'ftp://abc.supabase.co',
    'javascript:alert(1)',
    'https://user:pass@abc.supabase.co',
    'https://',
    'file:///etc/passwd',
  ])('refuses %j', (value) => {
    expect(normalizeSupabaseUrl(value)).toBeUndefined();
    expect(supabaseAuthEnvSchema.safeParse({ SUPABASE_URL: value }).success).toBe(false);
  });

  it('gives an issuer that matches what Supabase signs, whatever slash the operator pasted', () => {
    for (const pasted of ['https://abc.supabase.co', 'https://abc.supabase.co/']) {
      const url = supabaseAuthEnvSchema.parse({ SUPABASE_URL: pasted }).SUPABASE_URL;
      expect(`${url}/auth/v1`).toBe('https://abc.supabase.co/auth/v1');
    }
  });
});
