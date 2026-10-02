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
    // Native addon (pulled in by pdf-parse → pdfjs-dist in the profile
    // service) — can't be inlined. pdfjs needs it at module load to
    // polyfill DOMMatrix; without it the whole service crashes before
    // serving a request. Installed at the repo root (package.json) so it
    // resolves from api/<name>/ at runtime and Vercel traces it in.
    external: ['@napi-rs/canvas'],
    // pino (via @atlas/utils' logger) does a dynamic require('node:os')
    // internally — esbuild's ESM output has no ambient `require`, so
    // that call fails at runtime ("Dynamic require of 'node:os' is not
    // supported") even though the bundle itself builds cleanly. Shim a
    // real `require` backed by Node's own module system.
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });
}

// TEMPORARY diagnostic (revert after reading): move the real profile bundle
// to _impl.js and front it with a wrapper that reports native-dep presence
// and any load error in the response body (no runtime logs on this plan).
import { renameSync, writeFileSync } from 'node:fs';
renameSync('api/profile/index.js', 'api/profile/_impl.js');
writeFileSync(
  'api/profile/index.js',
  `import fs from 'node:fs';
import { createRequire } from 'node:module';
export default async function handler(req, res) {
  const report = {};
  try { const s = fs.lstatSync('/var/task/node_modules/@napi-rs/canvas'); report.rootCanvas = { symlink: s.isSymbolicLink(), dir: s.isDirectory() }; } catch (e) { report.rootCanvas = String(e.message); }
  try { report.napiDir = fs.readdirSync('/var/task/node_modules/@napi-rs'); } catch (e) { report.napiDir = String(e.message); }
  try { report.pnpmNapi = fs.readdirSync('/var/task/node_modules/.pnpm').filter((n) => n.includes('napi')); } catch (e) { report.pnpmNapi = String(e.message); }
  try { const r = createRequire(import.meta.url); report.resolved = r.resolve('@napi-rs/canvas'); r('@napi-rs/canvas'); report.canvasLoad = 'ok'; } catch (e) { report.canvasErr = String(e.message).slice(0, 800); }
  let mod;
  try { mod = await import('./_impl.js'); } catch (e) { report.implErr = String(e.message); report.stack = String(e.stack).slice(0, 1500); }
  if (mod) return mod.default(req, res);
  res.statusCode = 500;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(report, null, 2));
}
`,
);
