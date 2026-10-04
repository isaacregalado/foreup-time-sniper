/**
 * Pre-drop verification — one command, read-only, zero holds.
 *
 *   npm run verify                      # courses from .env COURSE
 *   npm run verify -- --course black,red
 *   npm run verify -- --course black --date 10-11-2026
 *   npm run verify -- --course black,red --simulate-drop     # + countdown rehearsal
 *
 * Runs unit tests + typecheck, then a turbo --dry-run --spec --race against
 * ET today+7 (tonight's drop date before 7pm), and grades
 * every per-course step a real drop depends on. Exit code 0 only if all pass.
 */
import { spawn, spawnSync } from 'child_process';
import * as path from 'path';
import { etDropTargetDate } from '../src/turbo-guards';

const root = path.join(__dirname, '..');
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };

const COURSE_NAMES: Record<string, string> = {
  black: 'Bethpage Black Course', red: 'Bethpage Red Course', green: 'Bethpage Green Course',
  blue: 'Bethpage Blue Course', yellow: 'Bethpage Yellow Course 9 Holes',
};

const courses = (arg('course') ?? process.env.COURSE ?? require('dotenv').config({ path: path.join(root, '.env') }).parsed?.COURSE ?? 'red')
  .split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean);
// ET today+7: before 7pm that is tonight's drop date; after 7pm it is the
// sheet released tonight (ForeUp's picker may refuse +8, which would read as a
// false staging failure). Run it again before 7pm on race day for the exact date.
const date = arg('date') ?? etDropTargetDate(Date.now());
const unknown = courses.filter((c: string) => !COURSE_NAMES[c]);
if (unknown.length) { console.error(`Unknown course(s): ${unknown.join(', ')}`); process.exit(2); }

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

async function main(): Promise<void> {
console.log(`\n  ⛳ Verify drop readiness — ${courses.join(' + ')} · ${date}\n`);

for (const [name, cmd] of (process.env.VERIFY_REPLAY ? [] : [['unit tests', ['run', 'test']], ['typecheck', ['run', 'typecheck']]] as const)) {
  const r = spawnSync('npm', [...cmd], { cwd: root, encoding: 'utf8' });
  const out = (r.stdout + r.stderr).trim().split('\n');
  const tail = out.filter((l) => /\d+ passed, \d+ failed/.test(l)).slice(-1)[0] ?? out.filter((l) => /error TS/.test(l)).slice(-1)[0] ?? '';
  add(name, r.status === 0, tail.trim());
}

const lines: string[] = [];
const replay = process.env.VERIFY_REPLAY; // grade a saved transcript offline (no ForeUp traffic)
if (replay) lines.push(...require('fs').readFileSync(replay, 'utf8').split('\n').filter((l: string) => l.trim()));
else await new Promise<void>((resolve) => {
  const simArgs = process.argv.includes('--simulate-drop') ? ['--simulate-drop', arg('simulate-drop') && /^\d+$/.test(arg('simulate-drop')!) ? arg('simulate-drop')! : '45'] : [];
  const child = spawn('npx', ['tsx', 'src/turbo.ts', '--dry-run', '--spec', '--race', '--course', courses.join(','), '--date', date, ...simArgs],
    { cwd: root, env: { ...process.env, HEADLESS: process.env.HEADLESS ?? '1' } });
  const onData = (b: Buffer) => { for (const l of b.toString().split('\n')) if (l.trim()) { lines.push(l); console.log(`  │ ${l.trim()}`); } };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const killer = setTimeout(() => child.kill('SIGTERM'), 6 * 60_000);
  child.on('close', () => { clearTimeout(killer); resolve(); });
});
const has = (re: RegExp) => lines.some((l) => re.test(l));
const find = (re: RegExp) => lines.find((l) => re.test(l))?.replace(/^\s*\S+\s+\[[^\]]*\]\s*/, '').trim();

add('login', has(/Logged in/), find(/Logged in|Login/));
for (const c of courses) {
  const n = COURSE_NAMES[c];
  add(`${c}: page staged (date/players/holes)`, has(new RegExp(`Staged ${n}:`)), find(new RegExp(`Staged ${n}|Failed to stage ${n}`)));
  add(`${c}: bridge hold path ready`, has(new RegExp(`Bridge ready on ${n}`)), find(new RegExp(`Bridge (ready on|preflight) ${n}`)));
  add(`${c}: drop detector healthy`, !has(new RegExp(`API detector unhealthy for ${n}`)), find(new RegExp(`API detector unhealthy for ${n}|Pre-drop ${n}`)));
}
add('ForeUp flow unchanged', has(/ForeUp preflight: (v[\d.]+, all \d+ flow markers present|their JS updated.*still present)/), find(/ForeUp preflight/));
add('clock synced (NTP or ForeUp)', has(/Clock offset: -?\d+ms/) && !has(/Clock offset: machine clock/), find(/Clock offset/));
add('email (IMAP) ready', has(/IMAP ready|No email code needed/), find(/IMAP/));
add('date is the drop date', !has(/DATE CHECK:/), find(/DATE CHECK/) ?? date);
if (process.argv.includes('--simulate-drop') || has(/SIM DROP:/)) {
  // The countdown, T-30 clock re-sync, warm-ups and drop-rate polling only run
  // at a real release; this rehearsal executes that exact code read-only.
  add('countdown rehearsal (simulated drop)', has(/✓ \[[^\]]*\] SIM DROP:/) && !has(/✗ \[[^\]]*\] SIM DROP:/), find(/[✓✗] \[[^\]]*\] SIM DROP:/));
}
add('dry run finished', has(/DRY RUN done\./));

const spec = find(/DRY RUN SPEC|no safe predicted|SPEC: no in-window slot predictable/);
console.log('\n  ── Result ' + '─'.repeat(50));
for (const c of checks) console.log(`  ${c.ok ? '✓ PASS' : '✗ FAIL'}  ${c.name}${c.detail ? `  — ${c.detail.slice(0, 110)}` : ''}`);
console.log(`  ℹ SPEC   ${spec ?? 'not reported'}  (informational: when SPEC is off the detect path still races)`);
const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `\n  ✗ NOT READY — ${failed.length} check(s) failed. Fix before 7pm.\n` : `\n  ✓ READY for the ${date} drop on ${courses.join(' + ')}.\n`);
process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
