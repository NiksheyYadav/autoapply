import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

interface Rewrite {
  source: string;
  destination: string;
}
const config = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')) as {
  functions: Record<string, unknown>;
  rewrites: Rewrite[];
};

/** What Vercel does with these: `/v1/jobs/:path*` matches `/v1/jobs` and everything below it, first match wins. */
function matches(source: string, path: string): boolean {
  const prefix = source.replace(/\/:path\*$/, '');
  return path === prefix || path.startsWith(`${prefix}/`);
}
function destinationOf(path: string): string | undefined {
  return config.rewrites.find((rewrite) => matches(rewrite.source, path))?.destination;
}

/** Services that are not deployed (no bundle, no rewrite): the connectors service is built and tested only. */
const NOT_DEPLOYED = new Set(['connectors']);

const services = readdirSync(join(ROOT, 'services'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => !NOT_DEPLOYED.has(name));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  );
}

/** Every quoted `/v1/...` or `/internal/...` path literal a service's code declares or mentions. */
function pathsOf(service: string): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(join(ROOT, 'services', service, 'src'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/['"`](\/(?:v1|internal)\/[^'"`\s]*)['"`]/g)) {
      const path = match[1] as string;
      // Outgoing request templates, doc placeholders and rewrite patterns, not routes.
      if (path.includes('${') || path.includes('...') || path.includes(':path*')) continue;
      found.add(path);
    }
  }
  return [...found].sort();
}

describe('vercel.json routes every public path to the function that serves it', () => {
  it('has a function entry and a committed bundle for every rewrite destination, and the reverse', () => {
    const destinations = new Set(config.rewrites.map((rewrite) => rewrite.destination));
    const functionNames = Object.keys(config.functions).map((key) => key.replace(/^api\/(.+)\/index\.js$/, '/api/$1'));
    expect([...destinations].sort()).toEqual([...functionNames].sort());
    for (const destination of destinations) {
      expect(existsSync(join(ROOT, `${destination.slice(1)}/index.js`)), destination).toBe(true);
    }
  });

  it('never rewrites to a service that is not deployed', () => {
    for (const service of NOT_DEPLOYED) {
      expect(config.rewrites.some((rewrite) => rewrite.destination === `/api/${service}`)).toBe(false);
    }
  });

  it.each(services)('%s: every public route resolves to its own function', (service) => {
    const own = pathsOf(service).filter(
      // `/internal/drain` is the service-local path; only `/internal/<service>/...` is public.
      (path) => path.startsWith('/v1/') && path !== '/v1/' || path.startsWith(`/internal/${service}/`),
    );
    const wrong = own
      .map((path) => ({ path, destination: destinationOf(path) }))
      .filter(({ destination }) => destination !== `/api/${service}`);
    expect(wrong).toEqual([]);
  });

  it('finds routes to check in every deployed service (so the extraction cannot quietly go blind)', () => {
    for (const service of services) {
      const routes = pathsOf(service).filter(
        (path) => (path.startsWith('/v1/') && path !== '/v1/') || path.startsWith(`/internal/${service}/`),
      );
      expect(routes.length, service).toBeGreaterThan(0);
    }
  });

  it('leaves the service-local drain paths unrouted, so only the scheduler-facing path is public', () => {
    expect(destinationOf('/internal/drain')).toBeUndefined();
    expect(destinationOf('/health')).toBeUndefined();
    expect(destinationOf('/metrics')).toBeUndefined();
  });
});
