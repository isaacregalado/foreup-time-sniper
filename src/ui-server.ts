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

const PORT = 4747;
const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'static', 'turbo-ui.html');
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
const AWS_SSH_OPTS = ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=10', '-i', AWS_KEY];
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
let schedule: { mode: Mode; at: number; courses: string[] | null; target: Target; players?: number; date?: string; spec?: boolean } | null = null;
let scheduleTimer: NodeJS.Timeout | null = null;
let caffeinateProc: ChildProcess | null = null;

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

function setSchedule(mode: Mode, hhmm: string, courses: string[] | null, target: Target, players?: number, date?: string, day: 'today' | 'tomorrow' = 'today', spec?: boolean): { ok: boolean; error?: string } {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { ok: false, error: 'Time must look like 18:50.' };
  const at = new Date();
  if (day === 'tomorrow') at.setDate(at.getDate() + 1);
  at.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
  if (at.getTime() <= Date.now() + 5000) return { ok: false, error: 'That time has already passed today.' };
  if (at.getTime() > Date.now() + 36 * 3600_000) return { ok: false, error: 'Auto-arm reaches at most ~36h out.' };
  clearSchedule();
  schedule = { mode, at: at.getTime(), courses, target, players, date, spec };
  scheduleTimer = setTimeout(() => {
    const s = schedule;
    schedule = null; scheduleTimer = null;
    if (s && !state.running) void arm(s.mode, s.date, s.courses ?? undefined, s.target, s.players, s.spec);
    updateCaffeinate();
    broadcast('schedule', { schedule: null });
  }, at.getTime() - Date.now());
  updateCaffeinate();
  broadcast('schedule', { schedule: publicSchedule() });
  return { ok: true };
}
function clearSchedule() {
  if (scheduleTimer) clearTimeout(scheduleTimer);
  schedule = null; scheduleTimer = null;
  updateCaffeinate();
}
const publicSchedule = () => schedule ? { mode: schedule.mode, at: new Date(schedule.at).toISOString(), courses: schedule.courses, target: schedule.target, players: schedule.players ?? null, spec: schedule.spec ?? false } : null;

// Log-line → phase + plain English. First match wins; order matters.
const PHASE_MAP: Array<{ re: RegExp; phase: Phase; text: (m: RegExpMatchArray) => string }> = [
  { re: /Browser bootstrap/,          phase: 'bootstrap', text: () => 'Opening Chrome and loading ForeUp…' },
  { re: /Logging in/,                 phase: 'bootstrap', text: () => 'Logging into your ForeUp account…' },
  { re: /Logged in/,                  phase: 'bootstrap', text: () => 'Logged in. Syncing clock and email…' },
  { re: /preflight: flow markers MISSING/, phase: 'failed', text: () => 'ForeUp changed their booking flow — re-map before trusting a real run.' },
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
      ? { kind: 'test_passed', title: 'SYSTEMS CHECK PASSED', detail: 'Login, clock sync, email and tee-sheet access all work. Nothing was held or charged.' }
      : { kind: 'test_passed', title: 'TEST PASSED', detail: `Held ${heldWhat || 'a real slot'} then released it on purpose. $0 charged. The real run will work the same way.` };
  } else {
    const lastErr = [...state.lines].reverse().find((l) => l.includes('✗')) ?? state.lines[state.lines.length - 1] ?? '';
    state.verdict = { kind: 'failed', title: 'DID NOT BOOK', detail: `${state.statusText} — last log: ${lastErr.replace(/^\s*[✗⚠]\s*/, '').slice(0, 160)}` };
  }
  broadcast('verdict', { verdict: state.verdict, phase: state.phase });
  if (['booked', 'ready_click', 'manual'].includes(state.verdict?.kind ?? '')) startProofWatch();
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
      ? { kind: 'test_passed', title: 'SYSTEMS CHECK PASSED', detail: 'Login, clock sync, email and tee-sheet access all work. Nothing was held or charged.' }
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

async function arm(mode: Mode, date?: string, courses?: string[], target: Target = 'mac', players?: number, spec?: boolean): Promise<{ ok: boolean; error?: string }> {
  if (state.running) return { ok: false, error: 'A run is already armed. Disarm it first.' };
  if (syncChild) return { ok: false, error: 'A sync is in progress — wait for it to finish.' };
  if (courses) {
    if (!courses.length || courses.some((c) => !ALL_KEYS.includes(c))) return { ok: false, error: 'Unknown course selection.' };
    if (courses.includes('crab-meadow') && courses.length > 1) return { ok: false, error: 'Crab Meadow is a separate facility — book it alone.' };
  }
  if (target !== 'mac' && !IS_MAC) {
    return { ok: false, error: 'This dashboard IS a remote box — use the "This VM" machine.' };
  }
  const headlessLive = (target !== 'mac' || !IS_MAC) && mode === 'live';
  if (headlessLive) {
    const cs = cardStatus();
    if (!cs.present) return { ok: false, error: 'A headless run books fully automatically and needs the booking-fee card: fill FEE_CARD_* in .env (then "Sync → VM" if arming from the Mac).' };
    if (!cs.valid) return { ok: false, error: `Card looks wrong: ${cs.issues.join('; ')}. Fix FEE_CARD_* in .env before an auto-book run.` };
  }
  const turboFlags: string[] = [];
  if (mode === 'test') turboFlags.push('--no-book');
  if (mode === 'dry') turboFlags.push('--dry-run');
  if (date) turboFlags.push('--date', date);
  if (courses?.length) turboFlags.push('--course', courses.join(','));
  if (players && Number.isInteger(players) && players >= 1 && players <= 4) turboFlags.push('--players', String(players));
  if (spec) turboFlags.push('--spec');

  if (target === 'oregon' || target === 'aws') {
    // Headless remote run, tmux-hardened: turbo lives in a detached tmux session
    // and the ssh child just replays + follows its log, exiting when the
    // session ends. If the ssh drops (Mac sleep, wifi blip) the run SURVIVES —
    // pressing Arm again reattaches to it (the has-session guard) and replays
    // the log from the top so the dashboard reconstructs the right state.
    // Remote boxes never have a display server. Make headless mode an
    // invariant of the generated command instead of relying on a VM-specific
    // .env value that can be overwritten by a Mac-to-VM config sync.
    const envPrefix = `HEADLESS=1 ${mode === 'live' ? 'AUTO_BOOK=1 ' : ''}`;
    const runCmd = `${envPrefix}npx tsx src/turbo.ts ${turboFlags.join(' ')}`.trim();
    const remoteCmd =
      `cd ~/bethpage-sniper; mkdir -p logs; ` +
      `if ! tmux has-session -t snipe 2>/dev/null; then rm -f logs/live-run.log; tmux new-session -d -s snipe '${runCmd} > logs/live-run.log 2>&1'; fi; ` +
      `touch logs/live-run.log; tail -n +1 -F logs/live-run.log & TP=$!; ` +
      `while tmux has-session -t snipe 2>/dev/null; do sleep 2; done; sleep 2; kill $TP 2>/dev/null; true`;
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
  const push = (d: Buffer) => d.toString().split('\n').forEach((raw) => {
    const line = raw.trimEnd();
    if (!line.trim()) return;
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
    if (body.cancel) { clearSchedule(); broadcast('schedule', { schedule: null }); json(res, 200, { ok: true }); return; }
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
    json(res, 200, setSchedule(mode, String(body.time ?? ''), courses, target, schedPlayers, schedDate, schedDay, schedSpec));
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
});
