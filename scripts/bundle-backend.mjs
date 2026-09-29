// Bundles each backend service into a single self-contained Vercel
// function under api/<name>/index.js. The output is committed (Vercel's
// zero-config function detection for "Other" framework projects scans
// the git checkout directly, before any buildCommand runs — a build
// step can't generate new function source files this way, only static
// output). Re-run this — `node scripts/bundle-backend.mjs` — and commit
// the result whenever a service or a workspace package it depends on
// changes. It also re-runs as part of atlas-backend's buildCommand
// (see vercel.json) as a freshness safety net, but that alone is not
// sufficient: the committed copy is what Vercel's function scan sees.
//
// Why this exists: workspace packages (packages/*) publish their exports
// as raw TypeScript ("./src/index.ts"), which tsx transpiles on the fly
// for local dev/tests. Vercel's Node builder only transpiles the entry
// file you point it at directly — anything reached through node_modules
// (including pnpm-symlinked workspace packages) is expected to already
// be valid, executable JS. Left alone, every service crashes at runtime
// with ERR_MODULE_NOT_FOUND trying to import a .ts file. Bundling each
// service with esbuild (packages inlined, not left external) sidesteps
// this entirely: the deployed function is one flat, plain-JS file.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

const services = [
  'auth',
  'profile',
  'jobs',
  'matching',
  'applications',
  'referrals',
  'outreach',
  'learning',
  'analytics',
];

for (const name of services) {
  mkdirSync(`api/${name}`, { recursive: true });
  await build({
    entryPoints: [`services/${name}/src/index.ts`],
    outfile: `api/${name}/index.js`,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    logLevel: 'info',
  });
}
