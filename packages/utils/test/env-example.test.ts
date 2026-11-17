import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Every variable a service reads (the keys of every exported zod object in its `env.ts`). */
async function schemaKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const service of readdirSync(join(ROOT, 'services'), { withFileTypes: true })) {
    if (!service.isDirectory()) continue;
    const mod = (await import(join(ROOT, 'services', service.name, 'src/env.ts'))) as Record<string, unknown>;
    for (const value of Object.values(mod)) {
      const shape = (value as { shape?: Record<string, unknown> } | null)?.shape;
      if (shape !== undefined && typeof shape === 'object') for (const key of Object.keys(shape)) keys.add(key);
    }
  }
  return keys;
}

describe('.env.example', () => {
  // Written per service as AUTH_SERVICE_PORT, JOBS_SERVICE_PORT, ... in the "Service ports" section.
  const DOCUMENTED_ELSEWHERE = new Set(['PORT']);

  it('documents every variable a service reads, so an operator can find out what exists and what it does', async () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
    const documented = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1] as string));
    const missing = [...(await schemaKeys())].filter((key) => !documented.has(key) && !DOCUMENTED_ELSEWHERE.has(key));
    expect(missing.sort()).toEqual([]);
  });
});
