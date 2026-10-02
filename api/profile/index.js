import fs from 'node:fs';
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
