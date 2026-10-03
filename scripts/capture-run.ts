/**
 * Bundle the most recent turbo run into ONE shareable markdown file.
 *
 *   npm run capture
 *
 * Pulls the newest logs/run-*.log transcript + the matching last line of
 * logs/race-log.jsonl (structured timing) and writes
 * logs/capture-<stamp>.md — the file to hand back for diagnosis.
 *
 * Contains only run timing + the plain-English log. No card data is ever
 * logged anywhere, so this is safe to share as-is. (The transcript may show
 * the tee-time, course, and a masked code — nothing sensitive.)
 */
import * as fs from 'fs';
import * as path from 'path';

const LOGS = path.join(__dirname, '..', 'logs');
const TEL = path.join(LOGS, 'race-log.jsonl');

function newestRunLog(): string | null {
  try {
    const f = fs.readdirSync(LOGS).filter((n) => n.startsWith('run-') && n.endsWith('.log'))
      .map((n) => ({ n, t: fs.statSync(path.join(LOGS, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    return f ? path.join(LOGS, f.n) : null;
  } catch { return null; }
}

function lastTelemetry(): string {
  try {
    const lines = fs.readFileSync(TEL, 'utf-8').trim().split('\n').filter(Boolean);
    return lines[lines.length - 1] ?? '';
  } catch { return ''; }
}

const runLog = newestRunLog();
const transcript = runLog ? fs.readFileSync(runLog, 'utf-8').trimEnd() : '(no run-*.log transcript found)';
const tel = lastTelemetry();
let telPretty = tel;
try { telPretty = JSON.stringify(JSON.parse(tel), null, 2); } catch {}

const md = [
  '# Bethpage Sniper — run capture',
  '',
  `- captured: ${new Date().toISOString()}`,
  `- transcript: ${runLog ? path.basename(runLog) : '—'}`,
  '',
  '## Full run log',
  '```',
  transcript,
  '```',
  '',
  '## Telemetry (timing splits — detection/hold/verdict)',
  '```json',
  telPretty || '(none)',
  '```',
  '',
].join('\n');

const out = path.join(LOGS, `capture-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
fs.mkdirSync(LOGS, { recursive: true });
fs.writeFileSync(out, md);
console.log(`\n  ✓ Captured → ${out}\n  Share that file back for diagnosis.\n`);
