/**
 * Turbo Sniper UI — local dashboard for arming and watching turbo.ts.
 *
 * Zero dependencies: plain Node http + Server-Sent Events. Spawns
 * `tsx src/turbo.ts` as a child process, translates its log stream into
 * plain-English phases, and renders a single verdict at the end.
 *
 * Binds to 127.0.0.1 ONLY — this can trigger real-money bookings.
 *
 * Run: npm run ui   →  http://localhost:4747
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFile, type ChildProcess } from 'child_process';
import { ImapFlow } from 'imapflow';
import { armTimerCmd, attachCmd, cancelTimerCmd } from './remote-arm';

const PORT = 4747;
const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'static', 'turbo-ui.html');
const HTML_NEXT_PATH = path.join(ROOT, 'static', 'turbo-ui-next.html'); // redesign preview, served at /next
const LOG_PATH = path.join(ROOT, 'logs', 'race-log.jsonl');

// ────────────────────────────────────────────────────────────
// Run state
// ────────────────────────────────────────────────────────────
type Mode = 'test' | 'live' | 'dry';
type Target = 'mac' | 'oregon' | 'aws';
type Phase =
  | 'idle' | 'bootstrap' | 'ready' | 'waiting' | 'racing'
  | 'held' | 'booking' | 'ready_click' | 'booked' | 'test_passed' | 'failed' | 'manual';

interface RunState {
  phase: Phase;
  mode: Mode | null;
  target: Target | null;
  running: boolean;
  startedAt: string | null;
  statusText: string;       // plain-English one-liner for the big panel
  verdict: { kind: 'booked' | 'test_passed' | 'failed' | 'manual' | 'ready_click'; title: string; detail: string } | null;
  lines: string[];          // raw log tail
}

const state: RunState = {
  phase: 'idle', mode: null, target: null, running: false, startedAt: null,
  statusText: 'Not armed', verdict: null, lines: [],
};
let child: ChildProcess | null = null;

// This same server runs in two places: the Mac (headed runs, can remote-drive
// the VM over ssh) and the Oregon VM itself (always-on, phone-reachable over
// Tailscale, local headless runs only).
const IS_MAC = process.platform === 'darwin';

// ── Oregon VM (GCP free-tier e2-micro, us-west1) ────────────
// Runs headless — a "live" run there MUST auto-book (nobody can click).
const VM = { name: 'bethpage-sniper', zone: 'us-west1-b', project: 'open-487121' };
const VM_SSH_ARGS = ['compute', 'ssh', VM.name, `--zone=${VM.zone}`, `--project=${VM.project}`, '--quiet'];
let vmCache: { status: string; at: number } = { status: 'unknown', at: 0 };
let vmProbe: Promise<string> | null = null;

/** VM status via gcloud, cached 20s. 'RUNNING' | 'TERMINATED' | 'absent' | 'unreachable'. */
function vmStatus(): Promise<string> {
  if (Date.now() - vmCache.at < 20_000) return Promise.resolve(vmCache.status);
  if (vmProbe) return vmProbe;
  vmProbe = new Promise((resolve) => {
    execFile('gcloud', ['compute', 'instances', 'describe', VM.name, `--zone=${VM.zone}`, `--project=${VM.project}`, '--format=value(status)'],
      { timeout: 15_000 }, (err, stdout, stderr) => {
        const status = err ? (String(stderr).includes('not found') ? 'absent' : 'unreachable') : stdout.trim() || 'unknown';
        vmCache = { status, at: Date.now() };
        vmProbe = null;
        resolve(status);
      });
  });
  return vmProbe;
}

// ── AWS box (t3.small, us-west-2 — SAME region/cloud as ForeUp's origin, ~2ms) ──
// Runs headless — a "live" run there MUST auto-book (nobody can click).
// Its public IP changes on stop/start, so it is resolved live from the EC2 API.
const AWS_BOX = { name: 'bethpage-sniper', region: 'us-west-2', user: 'ubuntu' };
const AWS_KEY = path.join(process.env.HOME ?? '', '.ssh', 'bethpage-sniper-key.pem');
const AWS_SSH_OPTS = ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=10', '-i', AWS_KEY]; // LogLevel: no known-hosts chatter in the run log
let awsCache: { status: string; ip: string | null; at: number } = { status: 'unknown', ip: null, at: 0 };
let awsProbe: Promise<{ status: string; ip: string | null }> | null = null;

/** AWS box state via awscli, cached 20s. status: 'running' | 'stopped' | 'absent' | 'unreachable'. */
function awsStatus(): Promise<{ status: string; ip: string | null }> {
  if (Date.now() - awsCache.at < 20_000) return Promise.resolve({ status: awsCache.status, ip: awsCache.ip });
  if (awsProbe) return awsProbe;
  awsProbe = new Promise((resolve) => {
    execFile('aws', ['ec2', 'describe-instances', '--region', AWS_BOX.region,
      '--filters', `Name=tag:Name,Values=${AWS_BOX.name}`, 'Name=instance-state-name,Values=pending,running,stopping,stopped',
      '--query', 'Reservations[0].Instances[0].[State.Name,PublicIpAddress]', '--output', 'text'],
      { timeout: 15_000 }, (err, stdout) => {
        let status = 'unreachable';
        let ip: string | null = null;
        if (!err) {
          const [s, i] = stdout.trim().split(/\s+/);
          status = !s || s === 'None' ? 'absent' : s;
          ip = i && i !== 'None' ? i : null;
        }
        awsCache = { status, ip, at: Date.now() };
        awsProbe = null;
        resolve({ status, ip });
      });
  });
  return awsProbe;
}
/** IP of the box the CURRENT run was armed on — the cache may rotate under a long run. */
let awsRunIp: string | null = null;

// Course keys the UI may request. Crab Meadow is a separate foreUP facility
// (own login) and must run alone — turbo.ts enforces the same rule.
const BETHPAGE_KEYS = ['red', 'green', 'black', 'blue', 'yellow'];
const ALL_KEYS = [...BETHPAGE_KEYS, 'crab-meadow'];

// ── auto-arm schedule + sleep protection ────────────────────
interface Schedule { mode: Mode; at: number; courses: string[] | null; target: Target; players?: number; date?: string; spec?: boolean; boxArmed?: boolean }
let schedule: Schedule | null = null;
let scheduleTimer: NodeJS.Timeout | null = null;
let caffeinateProc: ChildProcess | null = null;
// The schedule survives a dashboard restart (it used to live only in memory —
// a restart or re-sync silently dropped tonight's arm).
const SCHEDULE_PATH = path.join(ROOT, 'logs', 'schedule.json');
// An auto-arm that fires this late is not the run that was asked for: starting
// it could race a sheet released long ago (or re-book after a finished run).
const STALE_ARM_MS = 5 * 60_000;
// A remote schedule is started by the BOX's own timer; the Mac attaches a few
// seconds later so it only ever attaches to that run instead of racing to
// create a second one.
const REMOTE_ATTACH_DELAY_MS = 4000;

/** Keep the Mac awake whenever a run is live OR an auto-arm is pending —
 *  a sleeping laptop at 6:58pm is the dumbest way to lose. */
function updateCaffeinate() {
  const need = !!(child || schedule);
  if (process.platform !== 'darwin') return;
  if (need && !caffeinateProc) {
    caffeinateProc = spawn('caffeinate', ['-dims'], { stdio: 'ignore' });
    caffeinateProc.on('exit', () => { caffeinateProc = null; });
  } else if (!need && caffeinateProc) {
    caffeinateProc.kill();
    caffeinateProc = null;
  }
}

function validateCourses(courses?: string[] | null): string | null {
  if (!courses) return null;
  if (!courses.length || courses.some((c) => !ALL_KEYS.includes(c))) return 'Unknown course selection.';
  if (courses.includes('crab-meadow') && courses.length > 1) return 'Crab Meadow is a separate facility — book it alone.';
  return null;
}

/** turbo.ts flags for a run — shared by "arm now" and the box-side timer. */
function turboFlagsFor(mode: Mode, date?: string, courses?: string[], players?: number, spec?: boolean): string[] {
  const turboFlags: string[] = [];
  turboFlags.push('--race'); // the only supported drop mode — never depend on .env RACE=1
  if (mode === 'test') turboFlags.push('--no-book');
  if (mode === 'dry') turboFlags.push('--dry-run');
  if (date) turboFlags.push('--date', date);
  if (courses?.length) turboFlags.push('--course', courses.join(','));
  if (players && Number.isInteger(players) && players >= 1 && players <= 4) turboFlags.push('--players', String(players));
  if (spec) turboFlags.push('--spec');
  return turboFlags;
}

/** The command a remote box runs. Remote boxes never have a display server:
 *  headless mode is an invariant of the generated command instead of relying
 *  on a VM-specific .env value that a Mac-to-VM config sync can overwrite. */
function remoteRunCmd(mode: Mode, turboFlags: string[]): string {
  const envPrefix = `HEADLESS=1 ${mode === 'live' ? 'AUTO_BOOK=1 ' : ''}`;
  return `${envPrefix}npx tsx src/turbo.ts ${turboFlags.join(' ')}`.trim();
}

/** Run one short command on a remote box; resolves with its combined output. */
async function remoteExec(target: 'aws' | 'oregon', cmd: string, timeoutMs = 25_000): Promise<{ ok: boolean; out: string }> {
  let bin = 'gcloud';
  let args = [...VM_SSH_ARGS, '--command', cmd];
  if (target === 'aws') {
    if (!fs.existsSync(AWS_KEY)) return { ok: false, out: `AWS key missing (${AWS_KEY})` };
    const { status, ip } = await awsStatus();
    if (status !== 'running' || !ip) return { ok: false, out: `AWS box is ${status}` };
    bin = 'ssh';
    args = [...AWS_SSH_OPTS, `${AWS_BOX.user}@${ip}`, cmd];
  }
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() });
    });
  });
}

/** Give the box its own timer for this schedule: a detached tmux session
 *  ('armtimer') that sleeps until the arm time and then BECOMES the 'snipe'
 *  run session — exactly what a dashboard arm would have created. From then on
 *  the run needs nothing from this Mac: asleep, offline or closed, the box
 *  still fires. tmux session names are unique, so if a run is already live at
 *  that moment the rename fails and nothing starts twice. ('armtimer' is not
 *  a prefix of 'snipe': tmux -t does prefix matching.) */
async function placeRemoteSchedule(s: Schedule): Promise<{ ok: boolean; error?: string }> {
  if (!IS_MAC || s.target === 'mac') return { ok: false };
  const runCmd = remoteRunCmd(s.mode, turboFlagsFor(s.mode, s.date, s.courses ?? undefined, s.players, s.spec));
  const cmd = armTimerCmd(s.at, runCmd);
  const r = await remoteExec(s.target, cmd);
  return r.ok && r.out.includes('ARMTIMER_OK') ? { ok: true } : { ok: false, error: r.out.split('\n').pop() || 'no response from the box' };
}

/** Remove the box's timer. Must be CONFIRMED: a cancel that silently failed
 *  would leave a (possibly real-money) run armed on the box. */
async function cancelRemoteSchedule(target: 'aws' | 'oregon', alsoRun = false): Promise<{ ok: boolean; error?: string }> {
  // alsoRun: the timer may have fired seconds ago and already become the run
  // session — a cancel pressed in that window must stop the run it started.
  const r = await remoteExec(target, cancelTimerCmd(alsoRun));
  return r.out.includes('ARMTIMER_GONE') ? { ok: true } : { ok: false, error: r.out.split('\n').pop() || 'no response from the box' };
}

function persistSchedule() {
  try {
    if (schedule) {
      fs.mkdirSync(path.dirname(SCHEDULE_PATH), { recursive: true });
      fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(schedule));
    } else if (fs.existsSync(SCHEDULE_PATH)) fs.unlinkSync(SCHEDULE_PATH);
  } catch { /* persistence is best-effort; the in-memory schedule still works */ }
}

/** The auto-arm fires. A box-armed remote schedule is only ATTACHED to (the
 *  box started it; if this Mac slept through it, the finished log is replayed
 *  so the verdict still shows). Anything else starts the run here — unless it
 *  is firing too late to be the run that was asked for. */
function fireSchedule(s: Schedule) {
  const lateMs = Date.now() - s.at;
  const when = new Date(s.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (state.running) return;
  const report = (r: { ok: boolean; error?: string }) => {
    if (r.ok) return;
    const msg = s.boxArmed
      ? `Could not attach to the box at ${when} (${r.error}) — the box's own timer still ran the scheduled run; press Arm to view it once the box is reachable.`
      : `Auto-arm at ${when} failed: ${r.error}`;
    state.statusText = msg;
    state.lines.push(`  ✗ ${msg}`);
    broadcast('line', { line: `  ✗ ${msg}`, phase: state.phase, statusText: msg });
  };
  if (s.target !== 'mac' && s.boxArmed) {
    void arm(s.mode, s.date, s.courses ?? undefined, s.target, s.players, s.spec, { schedAt: s.at, allowCreate: lateMs < STALE_ARM_MS }).then(report);
  } else if (lateMs < STALE_ARM_MS) {
    void arm(s.mode, s.date, s.courses ?? undefined, s.target, s.players, s.spec, {}).then(report);
  } else {
    state.statusText = `Auto-arm for ${when} was missed (this Mac was asleep or the dashboard was down) — nothing was started.`;
    state.lines.push(`  ✗ ${state.statusText}`);
    broadcast('line', { line: `  ✗ ${state.statusText}`, phase: state.phase, statusText: state.statusText });
  }
}

function startScheduleTimer() {
  if (!schedule) return;
  if (scheduleTimer) clearTimeout(scheduleTimer);
  const fireAt = schedule.at + (schedule.target !== 'mac' ? REMOTE_ATTACH_DELAY_MS : 0);
  scheduleTimer = setTimeout(() => {
    const s = schedule;
    schedule = null; scheduleTimer = null;
    persistSchedule();
    if (s) fireSchedule(s);
    updateCaffeinate();
    broadcast('schedule', { schedule: null });
  }, Math.max(0, fireAt - Date.now()));
}

async function setSchedule(mode: Mode, hhmm: string, courses: string[] | null, target: Target, players?: number, date?: string, day: 'today' | 'tomorrow' = 'today', spec?: boolean): Promise<{ ok: boolean; error?: string; boxArmed?: boolean; warning?: string }> {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { ok: false, error: 'Time must look like 18:50.' };
  const bad = validateCourses(courses); // these values are embedded in a remote command — validate first
  if (bad) return { ok: false, error: bad };
  const at = new Date();
  if (day === 'tomorrow') at.setDate(at.getDate() + 1);
  at.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
  if (at.getTime() <= Date.now() + 5000) return { ok: false, error: 'That time has already passed today.' };
  if (at.getTime() > Date.now() + 36 * 3600_000) return { ok: false, error: 'Auto-arm reaches at most ~36h out.' };
  const cleared = await clearSchedule();
  if (!cleared.ok) return { ok: false, error: `Could not cancel the previous auto-arm on the box (${cleared.error}) — it is still armed there. Try again.` };
  schedule = { mode, at: at.getTime(), courses, target, players, date, spec };
  let warning: string | undefined;
  if (IS_MAC && target !== 'mac') {
    const placed = await placeRemoteSchedule(schedule);
    schedule.boxArmed = placed.ok;
    if (!placed.ok) warning = `Could not give the ${target === 'aws' ? 'AWS box' : 'GCP VM'} its own timer (${placed.error ?? 'unreachable'}). This Mac will arm it at the set time instead — keep the Mac awake.`;
  }
  // The easiest way to lose a drop: the mode was still on "Systems check"
  // when the auto-arm was set. A check at 6:50pm finishes in a minute and
  // nothing races at 7:00.
  const hm = at.getHours() * 60 + at.getMinutes();
  if (mode === 'dry' && hm >= 18 * 60 && hm < 19 * 60) {
    const note = 'Heads up: this auto-arm is a SYSTEMS CHECK. It only tests the setup — nothing will race the 7:00pm drop. To go for a tee time, cancel it, pick "Real booking" (or "Test run — $0") and set the auto-arm again.';
    warning = warning ? `${warning}\n\n${note}` : note;
  }
  persistSchedule();
  startScheduleTimer();
  updateCaffeinate();
  broadcast('schedule', { schedule: publicSchedule() });
  return { ok: true, boxArmed: !!schedule.boxArmed, warning };
}

/** Clear the pending auto-arm. For a box-armed schedule the box's timer is
 *  removed FIRST and must be confirmed gone; otherwise nothing changes. */
async function clearSchedule(): Promise<{ ok: boolean; error?: string }> {
  if (schedule?.boxArmed && schedule.target !== 'mac') {
    const r = await cancelRemoteSchedule(schedule.target, Date.now() >= schedule.at - 2000);
    if (!r.ok) return r;
  }
  if (scheduleTimer) clearTimeout(scheduleTimer);
  schedule = null; scheduleTimer = null;
  persistSchedule();
  updateCaffeinate();
  return { ok: true };
}
const publicSchedule = () => schedule ? { mode: schedule.mode, at: new Date(schedule.at).toISOString(), courses: schedule.courses, target: schedule.target, players: schedule.players ?? null, date: schedule.date ?? null, spec: schedule.spec ?? false, boxArmed: !!schedule.boxArmed } : null;

/** After a dashboard restart: pick the saved auto-arm back up. Future → re-arm
 *  the timer (and re-place the box's timer, which is idempotent). Past →
 *  fireSchedule decides (attach to the box's run, start if only minutes late,
 *  or report it missed). */
async function restoreSchedule() {
  let saved: Schedule | null = null;
  try { saved = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf-8')); } catch { return; }
  if (!saved || typeof saved.at !== 'number' || !['test', 'live', 'dry'].includes(saved.mode) || validateCourses(saved.courses)) { schedule = null; persistSchedule(); return; }
  if (Date.now() - saved.at > 6 * 3600_000) { schedule = null; persistSchedule(); return; } // ancient — drop it
  schedule = saved;
  if (saved.at > Date.now()) {
    if (IS_MAC && saved.target !== 'mac') {
      const placed = await placeRemoteSchedule(saved);
      if (schedule === saved) { saved.boxArmed = placed.ok || !!saved.boxArmed; persistSchedule(); }
    }
    if (schedule !== saved) return; // changed while we were talking to the box
    startScheduleTimer();
    updateCaffeinate();
    broadcast('schedule', { schedule: publicSchedule() });
    console.log(`  ↻ restored auto-arm: ${saved.mode} at ${new Date(saved.at).toLocaleString()} on ${saved.target}${saved.boxArmed ? ' (box has its own timer)' : ''}`);
  } else {
    schedule = null;
    persistSchedule();
    fireSchedule(saved);
  }
}

// Log-line → phase + plain English. First match wins; order matters.
const PHASE_MAP: Array<{ re: RegExp; phase: Phase; text: (m: RegExpMatchArray) => string }> = [
  { re: /Browser bootstrap/,          phase: 'bootstrap', text: () => 'Opening Chrome and loading ForeUp…' },
  { re: /Logging in/,                 phase: 'bootstrap', text: () => 'Logging into your ForeUp account…' },
  { re: /Logged in/,                  phase: 'bootstrap', text: () => 'Logged in. Syncing clock and email…' },
  { re: /preflight: flow markers MISSING/, phase: 'failed', text: () => 'ForeUp changed their booking flow — re-map before trusting a real run.' },
  { re: /API detector unhealthy/, phase: 'bootstrap', text: () => 'Tee-sheet detector is NOT working (login/WAF) — fix before 7pm or the drop will be missed.' },
  { re: /preflight: their JS updated/, phase: 'bootstrap', text: () => 'ForeUp updated their code, but the mapped flow still matches.' },
  { re: /ForeUp preflight: v/, phase: 'bootstrap', text: () => 'ForeUp’s code still matches the mapped flow.' },
  { re: /IMAP ready|skipping IMAP/,   phase: 'ready',     text: () => 'All systems ready. Checking the tee sheet…' },
  { re: /Pre-drop .*: (\d+) times/,   phase: 'ready',     text: (m) => `Tee sheet already live — ${m[1]} times visible.` },
  { re: /until T-/,                   phase: 'waiting',   text: () => 'Armed. Waiting for the 7:00pm drop…' },
  { re: /POLLING/,                    phase: 'racing',    text: () => 'DROP! Racing to detect times…' },
  { re: /(Bethpage[^:]*|Crab[^:]*): (\d+) times/, phase: 'racing', text: (m) => `${m[1]}: ${m[2]} times detected — picking the best tile…` },
  { re: /Candidates: (.+)$/,          phase: 'racing',    text: (m) => `Best slots: ${m[1]} — clicking in the browser…` },
  { re: /bridge hold (.+?) —/,        phase: 'racing',    text: (m) => `Grabbing ${m[1]} directly — no waiting for the page to draw…` },
  { re: /falling back to tile click/, phase: 'racing',    text: () => 'Direct grab unavailable — clicking the tile the classic way…' },
  { re: /clicking (.+?) tile/,        phase: 'racing',    text: (m) => `Clicking the ${m[1]} tile…` },
  { re: /HELD (.+?) reservation/,     phase: 'held',      text: (m) => `Slot held: ${m[1]}. Verifying it’s exactly right…` },
  { re: /Verified: /,                 phase: 'held',      text: () => 'Verified — course, date, time and players all match.' },
  { re: /Waiting for the emailed code/, phase: 'booking', text: () => 'Waiting for the 6-digit code by email…' },
  { re: /Code entered in browser/,    phase: 'booking',   text: () => 'Code entered — advancing to the payment window…' },
  { re: /Code via IMAP/,              phase: 'booking',   text: () => 'Code received — entering it in the browser…' },
  { re: /Payment screen loaded/,      phase: 'booking',   text: () => 'Payment window open — verifying the fee amount…' },
  { re: /Fee verified/,               phase: 'booking',   text: () => 'Fee amount verified — filling the card…' },
  { re: /Card pre-filled/,            phase: 'booking',   text: () => 'Card filled — one click left…' },
  { re: /AUTO-BOOKED/,                phase: 'booked',    text: () => 'Booked automatically. Check your email for the confirmation.' },
  { re: /READY — ONE CLICK LEFT/,     phase: 'ready_click', text: () => 'Ready — one click left. Click “PROCESS TRANSACTION” in the browser to finish.' },
  { re: /NO-BOOK MODE:/,              phase: 'test_passed', text: () => 'Test passed. Tile clicked and slot verified for real, then released — $0 charged.' },
  { re: /BOOKED/,                     phase: 'booked',    text: () => 'Booked. Check your email for the confirmation.' },
  { re: /finish by hand|finish it BY HAND|Could not reach the pay screen/i, phase: 'manual', text: () => 'Automation stalled — the browser window is open, finish it BY HAND within 5 minutes.' },
  { re: /VULTURE mode/,               phase: 'racing',    text: () => 'Lost the first wave — hunting slots freed as other bots’ holds expire…' },
  { re: /Vulture: trying (.+?) \(T\+/, phase: 'racing',   text: (m) => `Freed slot spotted — trying ${m[1]}…` },
  { re: /Vulture window closed/,      phase: 'failed',    text: () => 'Nothing came back before the hunt window closed.' },
  { re: /MISMATCH/,                   phase: 'failed',    text: () => 'Safety abort: the held slot didn’t match what was asked for. $0 charged.' },
  { re: /Hold failed|All concurrent holds failed|No successful hold/, phase: 'failed', text: () => 'Lost the race — every candidate slot was taken first.' },
  { re: /No times after polling|no bookable slots/i, phase: 'failed', text: () => 'No tee times appeared in or after your window.' },
  { re: /DRY RUN done/,               phase: 'test_passed', text: () => 'Dry run finished — login, clock, email and tee-sheet access all work.' },
];

const clients = new Set<http.ServerResponse>();
function broadcast(event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function ingestLine(raw: string) {
  const line = raw.trimEnd();
  if (!line.trim()) return;
  if (/^# armtimer \d+$/.test(line)) return; // the box timer's own marker, not run output
  state.lines.push(line);
  if (state.lines.length > 400) state.lines.shift();
  let hitTerminal = false;
  for (const { re, phase, text } of PHASE_MAP) {
    const m = line.match(re);
    if (m) {
      state.phase = phase;
      state.statusText = text(m);
      // These states leave the child alive (browser open for the human, or a
      // VM run lingering) — surface the verdict + start the proof watcher now
      // instead of waiting for process exit.
      if (phase === 'ready_click' || phase === 'manual' || phase === 'booked') hitTerminal = true;
      break;
    }
  }
  broadcast('line', { line, phase: state.phase, statusText: state.statusText });
  // ready_click/manual leave the child alive (browser stays open for the human),
  // so the verdict must surface now rather than waiting for process exit.
  if (hitTerminal && !state.verdict) emitVerdict();
}

/** Build + broadcast the verdict from current phase. Safe to call once mid-run
 *  (for the parked ready_click/manual states) and again on exit. */
function emitVerdict() {
  const held = state.lines.find((l) => /HELD (.+?) reservation/.test(l));
  const heldWhat = held?.match(/HELD (.+?) reservation/)?.[1] ?? '';
  if (state.phase === 'booked') {
    state.verdict = { kind: 'booked', title: 'BOOKED', detail: `${heldWhat || 'Your tee time'} is yours. Confirmation email + $5/player fee are the proof — check both.` };
  } else if (state.phase === 'ready_click') {
    state.verdict = { kind: 'ready_click', title: 'ONE CLICK LEFT', detail: `${heldWhat || 'Your slot'} is held with the code entered and the card filled in. Switch to the Chrome window and click “PROCESS TRANSACTION” to finish — that click is the only thing that charges the $5/player fee. The hold lasts ~5 minutes.` };
  } else if (state.phase === 'manual') {
    state.verdict = { kind: 'manual', title: 'FINISH BY HAND', detail: 'The slot is held for ~5 minutes. Switch to the open Chrome window and continue where it stopped: code → Book Time → Pay at Facility → card details → PROCESS TRANSACTION (the only charging click).' };
  } else if (state.phase === 'test_passed') {
    state.verdict = state.mode === 'dry'
      ? { kind: 'test_passed', title: 'SYSTEMS CHECK PASSED', detail: dryDetail() }
      : { kind: 'test_passed', title: 'TEST PASSED', detail: `Held ${heldWhat || 'a real slot'} then released it on purpose. $0 charged. The real run will work the same way.` };
  } else {
    const lastErr = [...state.lines].reverse().find((l) => l.includes('✗')) ?? state.lines[state.lines.length - 1] ?? '';
    state.verdict = { kind: 'failed', title: 'DID NOT BOOK', detail: `${state.statusText} — last log: ${lastErr.replace(/^\s*[✗⚠]\s*/, '').slice(0, 160)}` };
  }
  broadcast('verdict', { verdict: state.verdict, phase: state.phase });
  if (['booked', 'ready_click', 'manual'].includes(state.verdict?.kind ?? '')) startProofWatch();
}

/** A systems check can pass while running degraded (SPEC off, no ForeUp clock
 *  bound, blind detector, wrong date). Surface that in the verdict itself. */
const TARGET_LABEL: Record<string, string> = { mac: 'this Mac', aws: 'the AWS box', oregon: 'the GCP VM' };

/** Plain-English systems-check result. Only real problems are DEGRADED;
 *  SPEC being off (no fee data yet) is a normal state — the detect-first
 *  race still runs — so it is a calm note, not a warning. */
function dryDetail(): string {
  const where = IS_MAC ? TARGET_LABEL[state.target ?? 'mac'] ?? 'this machine' : 'this box';
  const base = `Checked on ${where}: login, clock, email and tee-sheet access all work. Nothing was held or charged.`;
  const clean = (l: string) => l.replace(/^\s*[✗⚠✓ℹ…]\s*(\[[^\]]*\]\s*)?/, '').slice(0, 140);
  const problems = state.lines
    .filter((l) => /API detector unhealthy|DATE CHECK|detector poll (rejected|blocked)|Clock offset: machine clock|could not be staged|Bridge preflight|flow markers MISSING|IMAP not connected|✗ .*SIM DROP/.test(l))
    .slice(0, 3)
    .map(clean);
  const specOff = state.lines.some((l) => /spec disabled|no safe predicted/.test(l));
  const note = specOff
    ? ' Note: SPEC (the pre-aimed shot) is off — no full-rate fee data for this day type yet — so it races detect-first, the way July’s booking was won.'
    : '';
  const hint = IS_MAC && (state.target ?? 'mac') === 'mac' ? ' To check the race machine, pick AWS us-west-2 and run this again.' : '';
  return problems.length ? `DEGRADED — fix before 7pm: ${problems.join(' · ')}. ${base}` : `${base}${note}${hint}`;
}

function finalizeRun(code: number | null) {
  state.running = false;
  if (state.verdict?.title === 'BOOKED ✓') { // email-verified — don't downgrade it
    broadcast('verdict', { verdict: state.verdict, phase: state.phase, exitCode: code });
    child = null;
    updateCaffeinate();
    return;
  }
  const held = state.lines.find((l) => /HELD (.+?) reservation/.test(l));
  const heldWhat = held?.match(/HELD (.+?) reservation/)?.[1] ?? '';
  if (state.phase === 'booked') {
    state.verdict = { kind: 'booked', title: 'BOOKED', detail: `${heldWhat || 'Your tee time'} is yours. Confirmation email + $5/player fee are the proof — check both.` };
  } else if (state.phase === 'ready_click') {
    state.verdict = { kind: 'ready_click', title: 'ONE CLICK LEFT', detail: `${heldWhat || 'Your slot'} is held with the code entered and the card filled in. Switch to the Chrome window and click “PROCESS TRANSACTION” to finish — that click is the only thing that charges the $5/player fee. The hold lasts ~5 minutes.` };
  } else if (state.phase === 'test_passed') {
    state.verdict = state.mode === 'dry'
      ? { kind: 'test_passed', title: 'SYSTEMS CHECK PASSED', detail: dryDetail() }
      : { kind: 'test_passed', title: 'TEST PASSED', detail: `Held ${heldWhat || 'a real slot'} then released it on purpose. $0 charged. The real run will work the same way.` };
  } else if (state.phase === 'manual') {
    state.verdict = { kind: 'manual', title: 'FINISH BY HAND', detail: 'The slot is held for ~5 minutes. Switch to the open Chrome window and continue where it stopped: code → Book Time → Pay at Facility → card details → PROCESS TRANSACTION (the only charging click).' };
  } else {
    const lastErr = [...state.lines].reverse().find((l) => l.includes('✗')) ?? state.lines[state.lines.length - 1] ?? '';
    state.verdict = { kind: 'failed', title: 'DID NOT BOOK', detail: `${state.statusText} — last log: ${lastErr.replace(/^\s*[✗⚠]\s*/, '').slice(0, 160)}` };
  }
  if (!['booked', 'test_passed', 'manual', 'ready_click'].includes(state.phase)) state.phase = 'failed';
  broadcast('verdict', { verdict: state.verdict, phase: state.phase, exitCode: code });
  if (['booked', 'ready_click', 'manual'].includes(state.verdict?.kind ?? '')) startProofWatch();
  child = null;
  updateCaffeinate();
}

async function arm(mode: Mode, date?: string, courses?: string[], target: Target = 'mac', players?: number, spec?: boolean, sched: { schedAt?: number; allowCreate?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
  if (state.running) return { ok: false, error: 'A run is already armed. Disarm it first.' };
  if (syncChild) return { ok: false, error: 'A sync is in progress — wait for it to finish.' };
  const badCourses = validateCourses(courses);
  if (badCourses) return { ok: false, error: badCourses };
  if (target !== 'mac' && !IS_MAC) {
    return { ok: false, error: 'This dashboard IS a remote box — use the "This VM" machine.' };
  }
  const headlessLive = (target !== 'mac' || !IS_MAC) && mode === 'live';
  if (headlessLive) {
    const cs = cardStatus();
    if (!cs.present) return { ok: false, error: 'A headless run books fully automatically and needs the booking-fee card: fill FEE_CARD_* in .env (then "Sync → VM" if arming from the Mac).' };
    if (!cs.valid) return { ok: false, error: `Card looks wrong: ${cs.issues.join('; ')}. Fix FEE_CARD_* in .env before an auto-book run.` };
  }
  const turboFlags = turboFlagsFor(mode, date, courses, players, spec);

  if (target === 'oregon' || target === 'aws') {
    // Headless remote run, tmux-hardened: turbo lives in a detached tmux session
    // and the ssh child just replays + follows its log, exiting when the
    // session ends. If the ssh drops (Mac sleep, wifi blip) the run SURVIVES —
    // pressing Arm again reattaches to it (the has-session guard) and replays
    // the log from the top so the dashboard reconstructs the right state.
    const runCmd = remoteRunCmd(mode, turboFlags);
    // A box-armed schedule was (or is being) started by the box's own timer.
    // Then this Mac only ATTACHES — live if the run is still going, a full
    // replay if it already finished — and never starts a second run. Creating
    // one here is the fallback for a box that did not start it, and only
    // while the arm is not stale. ("Arm now" passes no schedAt: start-or-attach.)
    const remoteCmd = attachCmd(runCmd, sched);
    if (target === 'aws') {
      if (!fs.existsSync(AWS_KEY)) return { ok: false, error: `AWS key missing (${AWS_KEY}) — run deploy/aws-setup.sh once from this Mac.` };
      const { status, ip } = await awsStatus();
      if (status !== 'running' || !ip) {
        return { ok: false, error: `AWS box is ${status} — press "Sync → AWS box" (it starts + re-syncs the instance) and try again.` };
      }
      awsRunIp = ip;
      child = spawn('ssh', [...AWS_SSH_OPTS, `${AWS_BOX.user}@${ip}`, remoteCmd]);
    } else {
      child = spawn('gcloud', [...VM_SSH_ARGS, '--command', remoteCmd]);
    }
  } else {
    // On the Mac: headed browser on purpose — if automation stalls you can
    // finish by hand. On the VM (this server running there): headless, and a
    // live run must click PROCESS TRANSACTION itself.
    const env: NodeJS.ProcessEnv = { ...process.env, HEADLESS: IS_MAC ? '' : '1' };
    if (headlessLive) env.AUTO_BOOK = '1';
    child = spawn('npx', ['tsx', 'src/turbo.ts', ...turboFlags], { cwd: ROOT, env });
  }
  stopProofWatch();
  state.phase = 'bootstrap';
  state.mode = mode;
  state.target = target;
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.statusText = target === 'oregon' ? 'Starting on the Oregon VM…' : target === 'aws' ? 'Starting on the AWS box (us-west-2)…' : 'Starting…';
  state.verdict = null;
  state.lines = [];
  child.stdout?.on('data', (d: Buffer) => d.toString().split('\n').forEach(ingestLine));
  child.stderr?.on('data', (d: Buffer) => d.toString().split('\n').forEach(ingestLine));
  child.on('exit', (code) => finalizeRun(code));
  updateCaffeinate();
  broadcast('armed', { mode, target, startedAt: state.startedAt });
  return { ok: true };
}

function disarm(): { ok: boolean } {
  if (child) {
    child.kill('SIGINT');
    const c = child;
    setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, 3000);
    const remoteKill = "tmux kill-session -t snipe 2>/dev/null; pkill -INT -f 'tsx src/turbo' 2>/dev/null; true";
    if (state.target === 'oregon') {
      // The run lives in tmux on the VM — kill the session, not just the ssh.
      spawn('gcloud', [...VM_SSH_ARGS, '--command', remoteKill], { stdio: 'ignore' }).unref();
    } else if (state.target === 'aws' && awsRunIp) {
      spawn('ssh', [...AWS_SSH_OPTS, `${AWS_BOX.user}@${awsRunIp}`, remoteKill], { stdio: 'ignore' }).unref();
    }
    state.statusText = 'Disarmed by you.';
    state.phase = 'idle';
    state.running = false;
    broadcast('line', { line: '  ■ disarmed from UI', phase: 'idle', statusText: state.statusText });
  }
  return { ok: true };
}

// ── Remote sync: re-runs the idempotent deploy script (code + .env → box) ──
// 'oregon' → deploy/gcp-setup.sh; 'aws' → deploy/aws-setup.sh (also STARTS a
// stopped AWS instance — that script restarts it by Name tag before syncing).
let syncChild: ChildProcess | null = null;
function startSync(target: 'oregon' | 'aws' = 'oregon'): { ok: boolean; error?: string } {
  if (state.running) return { ok: false, error: 'Disarm the current run before syncing.' };
  if (syncChild) return { ok: false, error: 'Sync already in progress.' };
  const script = target === 'aws' ? 'deploy/aws-setup.sh' : 'deploy/gcp-setup.sh';
  const label = target === 'aws' ? 'AWS box' : 'Oregon VM';
  syncChild = spawn('bash', [script], { cwd: ROOT });
  state.lines = []; // a sync is its own activity — never mix it into the previous run's log
  // Routine apt/ssh/npm chatter says nothing useful; keep the step lines.
  const NOISE = /Permanently added .* to the list of known hosts|is already the newest version|^\s*(Hit|Get|Ign):\d+ |Reading package lists|Building dependency tree|Reading state information|npm notice|^\s*Installing dependencies\.\.\.$|0 upgraded, 0 newly installed/;
  const push = (d: Buffer) => d.toString().split('\n').forEach((raw) => {
    const line = raw.trimEnd();
    if (!line.trim() || NOISE.test(line)) return;
    state.lines.push(`  ↺ ${line}`);
    if (state.lines.length > 400) state.lines.shift();
    broadcast('line', { line: `  ↺ ${line}`, phase: state.phase, statusText: `Syncing code + settings to the ${label}…` });
  });
  syncChild.stdout?.on('data', push);
  syncChild.stderr?.on('data', push);
  syncChild.on('exit', (code) => {
    syncChild = null;
    awsCache.at = 0; // the sync may have started/relaunched the instance — re-probe
    broadcast('sync', { ok: code === 0 });
    broadcast('line', { line: code === 0 ? `  ↺ ✓ ${label} sync complete` : `  ↺ ✗ ${label} sync failed (exit ${code})`, phase: state.phase, statusText: code === 0 ? `${label} sync complete.` : `${label} sync failed — see log.` });
  });
  broadcast('line', { line: `  ↺ syncing code + .env to the ${label}…`, phase: state.phase, statusText: `Syncing code + settings to the ${label}…` });
  return { ok: true };
}

/** True when all four FEE_CARD_* values are present in .env (values never leave this process). */
function cardReady(): boolean {
  try {
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf-8');
    return ['FEE_CARD_NUMBER', 'FEE_CARD_EXP_MONTH', 'FEE_CARD_EXP_YEAR', 'FEE_CARD_CVV']
      .every((k) => new RegExp(`^${k}=.{2,}$`, 'm').test(env));
  } catch { return false; }
}

function readEnvVal(key: string): string {
  try {
    const m = fs.readFileSync(path.join(ROOT, '.env'), 'utf-8').match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m?.[1]?.trim() ?? '';
  } catch { return ''; }
}

/** Validate the fee card WITHOUT exposing it — returns only issue labels, so a
 *  typo (bad Luhn) or a stale expiry is caught at setup, not at the Sunday
 *  payment window. Card values never leave this function. */
function cardStatus(): { present: boolean; valid: boolean; issues: string[] } {
  const num = readEnvVal('FEE_CARD_NUMBER').replace(/\s+/g, '');
  const mo = parseInt(readEnvVal('FEE_CARD_EXP_MONTH'), 10);
  const yrRaw = readEnvVal('FEE_CARD_EXP_YEAR');
  const cvv = readEnvVal('FEE_CARD_CVV');
  const present = !!(num && readEnvVal('FEE_CARD_EXP_MONTH') && yrRaw && cvv);
  if (!present) return { present: false, valid: false, issues: [] };
  const issues: string[] = [];
  // Luhn
  const d = num.replace(/\D/g, '');
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = parseInt(d[i], 10);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  if (d.length < 13 || d.length > 19 || sum % 10 !== 0) issues.push('card number fails the checksum — check for a typo');
  if (!(mo >= 1 && mo <= 12)) issues.push('expiry month must be 01–12');
  const yr = yrRaw.length === 2 ? 2000 + parseInt(yrRaw, 10) : parseInt(yrRaw, 10);
  const now = new Date();
  if (mo >= 1 && mo <= 12 && yr >= 2000) {
    const exp = new Date(yr, mo, 0, 23, 59, 59); // last day of the month
    if (exp < now) issues.push('card is expired');
  } else if (!(yr >= 2000)) issues.push('expiry year looks wrong');
  if (!/^\d{3,4}$/.test(cvv)) issues.push('CVV must be 3–4 digits');
  return { present: true, valid: issues.length === 0, issues };
}

/** One shareable markdown bundle of the current/last run — served as a
 *  download by /api/capture so it works from the phone with one tap.
 *  state.lines is the machine-independent transcript (streamed from Mac OR VM);
 *  telemetry is added when it lives on this host. No card data is ever logged. */
function buildCapture(): string {
  let tel = '';
  try {
    const lines = fs.readFileSync(LOG_PATH, 'utf-8').trim().split('\n').filter(Boolean);
    tel = lines[lines.length - 1] ?? '';
    tel = JSON.stringify(JSON.parse(tel), null, 2);
  } catch {}
  const v = state.verdict;
  return [
    '# Bethpage Sniper — run capture',
    '',
    `- captured: ${new Date().toISOString()}`,
    `- dashboard host: ${IS_MAC ? 'mac' : 'oregon-vm'}`,
    `- run target: ${state.target ?? '—'} · mode: ${state.mode ?? '—'}`,
    `- started: ${state.startedAt ?? '—'}`,
    `- verdict: ${v ? v.title : '—'}`,
    v ? `- detail: ${v.detail}` : '',
    '',
    '## Live log',
    '```',
    ...(state.lines.length ? state.lines : ['(no run captured yet)']),
    '```',
    '',
    '## Telemetry (timing splits)',
    IS_MAC && state.target === 'oregon'
      ? '_This was a VM run — full timing telemetry is on the VM at `~/bethpage-sniper/logs/race-log.jsonl` (last line). The log above still has the key splits._'
      : '',
    '```json',
    tel || '(none on this host)',
    '```',
    '',
  ].filter((l) => l !== null).join('\n');
}

// ────────────────────────────────────────────────────────────
// Proof watcher — the answer to "did it ACTUALLY hit?".
// A booking is only real once ForeUp's confirmation email exists. After a run
// ends in BOOKED (verify it) or ONE CLICK LEFT / FINISH BY HAND (the human
// makes the final click, which turbo can't see), poll Gmail over IMAP for a
// ForeUp confirmation newer than the run start. Finding one flips the verdict
// to BOOKED with the email as proof; 12 minutes of silence reports that too.
// ────────────────────────────────────────────────────────────
let proofTimer: NodeJS.Timeout | null = null;

function stopProofWatch() { if (proofTimer) { clearInterval(proofTimer); proofTimer = null; } }

async function findConfirmationEmail(sinceMs: number): Promise<{ subject: string; at: string } | null> {
  const user = readEnvVal('GMAIL_EMAIL');
  const pass = readEnvVal('GMAIL_APP_PASSWORD');
  if (!user || !pass) return null;
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false });
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const exists = client.mailbox ? client.mailbox.exists : 0;
      if (!exists) return null;
      const from = Math.max(1, exists - 14);
      let found: { subject: string; at: string } | null = null;
      for await (const msg of client.fetch(`${from}:${exists}`, { envelope: true })) {
        const env = msg.envelope;
        if (!env) continue;
        const sender = `${env.from?.[0]?.address ?? ''} ${env.from?.[0]?.name ?? ''}`;
        const subject = env.subject ?? '';
        const t = env.date ? new Date(env.date).getTime() : 0;
        // Any ForeUp email newer than the run that is NOT the 6-digit-code
        // email is the confirmation (exact subject unknown until the first
        // real booking — the sender + timing is the strong signal).
        if (t >= sinceMs - 120_000 && /foreup|bethpage/i.test(sender) && !/code/i.test(subject)) {
          found = { subject, at: new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) };
        }
      }
      return found;
    } finally { lock.release(); }
  } catch { return null; }
  finally { try { await client.logout(); } catch {} }
}

function startProofWatch() {
  stopProofWatch();
  const sinceMs = state.startedAt ? new Date(state.startedAt).getTime() : Date.now() - 10 * 60_000;
  const deadline = Date.now() + 12 * 60_000;
  let checking = false;
  const tick = async () => {
    if (checking) return;
    checking = true;
    try {
      const hit = await findConfirmationEmail(sinceMs);
      if (hit) {
        stopProofWatch();
        state.phase = 'booked';
        state.verdict = { kind: 'booked', title: 'BOOKED ✓', detail: `Confirmed by email — “${hit.subject}” landed at ${hit.at}. The tee time is yours; the $5/player fee is on your card.` };
        broadcast('proof', { emailFound: true, ...hit });
        broadcast('verdict', { verdict: state.verdict, phase: state.phase });
      } else if (Date.now() > deadline) {
        stopProofWatch();
        broadcast('proof', { emailFound: false });
      }
    } finally { checking = false; }
  };
  proofTimer = setInterval(tick, 15_000);
  tick();
}

// ────────────────────────────────────────────────────────────
// Config + history (never expose credentials)
// ────────────────────────────────────────────────────────────
const SAFE_ENV_KEYS = ['COURSE', 'WINDOW_START', 'WINDOW_END', 'FALLBACK_UNTIL', 'SLOT_ORDER', 'VULTURE_MIN', 'VULTURE_POLL_SEC', 'PLAYERS', 'MIN_PLAYERS', 'HOLES', 'TARGET_DATE', 'RACE', 'CRABMEADOW_BOOKING_CLASS_ID'];
function readConfig(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf-8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && SAFE_ENV_KEYS.includes(m[1])) out[m[1]] = m[2];
    }
  } catch {}
  return out;
}

function readHistory(): { runs: unknown[]; stats: { drops: number; medianDetectMs: number } | null } {
  const runs = readRuns();
  // Median detection latency across plausible live drops (already-live sheets
  // detect in ~1 RTT and would skew it) — same filter turbo.ts uses.
  const dets = runs.map((r: any) => r.detectMs).filter((n: any) => typeof n === 'number' && n >= 150 && n <= 10_000).sort((a: number, b: number) => a - b);
  return { runs, stats: dets.length ? { drops: dets.length, medianDetectMs: dets[Math.floor(dets.length / 2)] } : null };
}

function readRuns(): any[] {
  try {
    return fs.readFileSync(LOG_PATH, 'utf-8').split('\n').filter(Boolean).slice(-30).reverse()
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .map((run: any) => {
        const ev = (name: string) => run.events?.find((e: any) => e.name === name);
        const outcome = ev('outcome');
        const holds = run.events?.filter((e: any) => e.name === 'hold') ?? [];
        const okHold = holds.find((h: any) => h.ok);
        const polls = run.events?.filter((e: any) => e.name === 'poll') ?? [];
        const rtts = polls.map((p: any) => p.rtt).filter((n: any) => typeof n === 'number');
        return {
          runAt: run.runAt,
          args: (run.args ?? []).join(' '),
          result: outcome?.result ?? 'unknown',
          heldTime: okHold?.time ?? null,
          heldCourse: okHold?.course ?? null,
          detectMs: ev('detected')?.ms ?? null,
          holdMs: okHold?.ms ?? null,
          avgPollRtt: rtts.length ? Math.round(rtts.reduce((a: number, b: number) => a + b, 0) / rtts.length) : null,
          totalMs: outcome?.totalMs ?? null,
        };
      });
  } catch { return []; }
}

// ────────────────────────────────────────────────────────────
// HTTP server
// ────────────────────────────────────────────────────────────
function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? '/';
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(HTML_PATH));
  } else if (req.method === 'GET' && url === '/next' && fs.existsSync(HTML_NEXT_PATH)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(HTML_NEXT_PATH));
  } else if (req.method === 'GET' && url === '/api/state') {
    json(res, 200, { ...state, host: IS_MAC ? 'mac' : 'vm', config: readConfig(), cardReady: cardReady(), card: cardStatus(), schedule: publicSchedule() });
  } else if (req.method === 'GET' && url === '/api/vm') {
    json(res, 200, { ...VM, status: await vmStatus(), cardReady: cardReady(), card: cardStatus() });
  } else if (req.method === 'GET' && url === '/api/aws') {
    json(res, 200, { name: AWS_BOX.name, region: AWS_BOX.region, ...(await awsStatus()) });
  } else if (req.method === 'POST' && url === '/api/vm/sync') {
    const body = await readBody(req);
    json(res, 200, startSync(body.target === 'aws' ? 'aws' : 'oregon'));
  } else if (req.method === 'GET' && url === '/api/capture') {
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="bethpage-run-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md"`,
    });
    res.end(buildCapture());
  } else if (req.method === 'GET' && url === '/api/history') {
    json(res, 200, readHistory());
  } else if (req.method === 'POST' && url === '/api/schedule') {
    const body = await readBody(req);
    if (body.cancel) {
      const wasBox = !!schedule?.boxArmed;
      const r = await clearSchedule();
      if (!r.ok) { json(res, 200, { ok: false, error: `Could not reach the box to cancel its timer (${r.error}). The run is STILL ARMED there — try Cancel again.` }); return; }
      broadcast('schedule', { schedule: null });
      json(res, 200, { ok: true, boxCancelled: wasBox });
      return;
    }
    const mode: Mode = ['test', 'live', 'dry'].includes(body.mode) ? body.mode : 'test';
    const target: Target = body.target === 'oregon' ? 'oregon' : body.target === 'aws' ? 'aws' : 'mac';
    if (target !== 'mac' && mode === 'live') {
      const cs = cardStatus();
      if (!cs.present) { json(res, 200, { ok: false, error: 'A remote box books fully automatically and needs the booking-fee card: fill FEE_CARD_* in .env, then sync.' }); return; }
      if (!cs.valid) { json(res, 200, { ok: false, error: `Card looks wrong: ${cs.issues.join('; ')}. Fix FEE_CARD_* in .env first.` }); return; }
    }
    const courses = Array.isArray(body.courses) ? body.courses.filter((c: unknown) => typeof c === 'string') : null;
    const schedPlayers = Number.isInteger(body.players) && body.players >= 1 && body.players <= 4 ? body.players : undefined;
    const schedDate = typeof body.date === 'string' && /^\d{2}-\d{2}-\d{4}$/.test(body.date) ? body.date : undefined;
    const schedDay = body.day === 'tomorrow' ? 'tomorrow' as const : 'today' as const;
    const schedSpec = body.spec === true;
    json(res, 200, await setSchedule(mode, String(body.time ?? ''), courses, target, schedPlayers, schedDate, schedDay, schedSpec));
  } else if (req.method === 'GET' && url === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify(state)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  } else if (req.method === 'POST' && url === '/api/arm') {
    const body = await readBody(req);
    const mode: Mode = ['test', 'live', 'dry'].includes(body.mode) ? body.mode : 'test';
    const date = typeof body.date === 'string' && /^\d{2}-\d{2}-\d{4}$/.test(body.date) ? body.date : undefined;
    const courses = Array.isArray(body.courses) ? body.courses.filter((c: unknown) => typeof c === 'string') : undefined;
    const target: Target = body.target === 'oregon' ? 'oregon' : body.target === 'aws' ? 'aws' : 'mac';
    const players = Number.isInteger(body.players) && body.players >= 1 && body.players <= 4 ? body.players : undefined;
    const spec = body.spec === true;
    json(res, 200, await arm(mode, date, courses, target, players, spec));
  } else if (req.method === 'POST' && url === '/api/disarm') {
    json(res, 200, disarm());
  } else {
    res.writeHead(404); res.end('not found');
  }
});

// keep SSE connections alive through proxies/sleep
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25_000);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  ⛳  Turbo Sniper UI → http://localhost:${PORT}\n`);
  if (process.platform === 'darwin' && !process.env.NO_OPEN) execFile('open', [`http://localhost:${PORT}`], () => {});
  void restoreSchedule();
});
