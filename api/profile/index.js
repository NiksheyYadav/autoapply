import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
function send(res, code, body) { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body, null, 2)); }
export default async function handler(req, res) {
  const step = new URL(req.url, 'http://x').searchParams.get('step') || 'impl';
  const report = { step, here, node: process.versions.node, arch: process.arch, platform: process.platform };
  try {
    if (step === 'fs') {
      report.hereFiles = fs.readdirSync(here).map((f) => [f, fs.statSync(path.join(here, f)).size]);
      for (const p of ['/var/task/node_modules/@napi-rs', '/var/task/node_modules/.pnpm']) {
        try { report[p] = fs.readdirSync(p).filter((n) => p.endsWith('napi-rs') || n.includes('napi')); } catch (e) { report[p] = String(e.message); }
      }
      try { const s = fs.lstatSync('/var/task/node_modules/@napi-rs/canvas'); report.canvasLink = { symlink: s.isSymbolicLink(), target: s.isSymbolicLink() ? fs.readlinkSync('/var/task/node_modules/@napi-rs/canvas') : null }; } catch (e) { report.canvasLink = String(e.message); }
      return send(res, 200, report);
    }
    const r = createRequire(import.meta.url);
    if (step === 'resolve') {
      report.resolved = r.resolve('@napi-rs/canvas');
      const dir = path.dirname(report.resolved);
      report.canvasDir = fs.readdirSync(dir);
      try { report.siblings = fs.readdirSync(path.dirname(fs.realpathSync(dir))); } catch (e) { report.siblings = String(e.message); }
      return send(res, 200, report);
    }
    if (step === 'load') { const c = r('@napi-rs/canvas'); report.canvasKeys = Object.keys(c).slice(0, 15); return send(res, 200, report); }
    const mod = await import('./_impl.js');
    return mod.default(req, res);
  } catch (e) {
    report.error = String(e && e.message).slice(0, 1200);
    report.stack = String(e && e.stack).slice(0, 1500);
    return send(res, 500, report);
  }
}
