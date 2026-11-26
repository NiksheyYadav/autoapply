import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONNECTOR_PROVIDERS, isConnectorProvider } from '../src/lib/providers.js';

/**
 * A5 finding: services/connectors has NO OAuth code. Providers are
 * board-token based; the flow is POST /v1/connectors/:provider/connect with a
 * pasted credential -> secretStore.put -> secret_ref. So there is nothing to
 * mock. The guard below fails if OAuth is added, forcing a real mocked-OAuth
 * test to be written alongside it.
 */
const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

describe('connector providers', () => {
  it('is exactly greenhouse, lever, ashby', () => {
    expect([...CONNECTOR_PROVIDERS]).toEqual(['greenhouse', 'lever', 'ashby']);
  });

  it.each(['greenhouse', 'lever', 'ashby'])('accepts %s', (p) => {
    expect(isConnectorProvider(p)).toBe(true);
  });

  it.each(['manual', 'seed', 'rss', '', 'GREENHOUSE'])('rejects %j', (p) => {
    expect(isConnectorProvider(p)).toBe(false);
  });

  it('has no OAuth code in src (add a mocked-OAuth test before removing this guard)', () => {
    const files = listFiles(srcDir);
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const needle of ['authorize', 'redirect_uri', 'refresh_token']) {
        if (text.includes(needle)) offenders.push(`${file}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
