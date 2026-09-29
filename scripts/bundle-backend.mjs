// Bundles each backend service into a single self-contained Vercel
// function under api/<name>/index.js. Run at Vercel build time, not
// committed — see vercel.json / the atlas-backend project's buildCommand.
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
