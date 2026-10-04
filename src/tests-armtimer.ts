/**
 * Arm-timer mechanics — the exact shell commands the dashboard sends to a
 * remote box, run here against a REAL tmux (private server, throwaway
 * directories). Nothing touches a box or ForeUp.
 *
 * Run: npm run test:armtimer   (~30s)
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { armMarker, armTimerCmd, attachCmd, cancelTimerCmd } from './remote-arm';

const TMUX = 'tmux -L snipertest';
let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string, detail = '') {
  if (cond) passed++;
  else { failed++; console.log(`  FAIL: ${label}${detail ? `\n    ${detail.replace(/\n/g, '\n    ')}` : ''}`); }
}
const sh = (cmd: string, timeoutMs = 30_000) => new Promise<{ code: number; out: string }>((resolve) => {
  execFile('bash', ['-c', cmd], { timeout: timeoutMs }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, out: `${stdout}${stderr}` });
  });
});
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = (epochMs: number) => sleep(Math.max(0, epochMs - Date.now()));
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const fresh = async () => {
  await sh(`${TMUX} kill-server 2>/dev/null; true`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'armtimer-'));
  return { dir, tmux: TMUX };
};
const has = async (session: string) => (await sh(`${TMUX} has-session -t "=${session}" 2>/dev/null`)).code === 0;
const RUN = 'echo RUN_START && sleep 2 && echo RUN_END';

async function main() {
  if ((await sh('command -v tmux')).code !== 0) { console.log('  (tmux not installed — arm-timer tests skipped)'); return; }
  console.log('\n  -- Arm timer — real tmux --');

  // A. The timer fires on its own, becomes the run, and a later attach only follows it.
  {
    const o = await fresh();
    const at = (Math.floor(Date.now() / 1000) + 3) * 1000;
    const placed = await sh(armTimerCmd(at, RUN, o));
    assert(placed.out.includes('ARMTIMER_OK'), 'A: timer placed and confirmed', placed.out);
    assert(await has('armtimer') && !(await has('snipe')), 'A: before the arm time only the timer session exists');
    await until(at + 1500);
    assert(await has('snipe') && !(await has('armtimer')), 'A: at the arm time the timer BECOMES the run session');
    await until(at + 4000); // the Mac attaches a few seconds late — or hours late; same command
    const attach = await sh(attachCmd(RUN, { schedAt: at, allowCreate: false }, o));
    const log = fs.readFileSync(path.join(o.dir, 'logs', 'live-run.log'), 'utf8');
    assert(log.split('\n')[0] === armMarker(at), 'A: the run log starts with this schedule’s marker', log);
    assert(count(log, 'RUN_START') === 1 && count(log, 'RUN_END') === 1, 'A: exactly one run happened', log);
    assert(attach.out.includes('RUN_START') && attach.out.includes('RUN_END'), 'A: the late attach replays the whole run', attach.out);
    assert(!(await has('snipe')), 'A: attach started nothing new');
    assert(attach.out.includes('The box started this run on its own timer'), 'A: the attach says the box started it', attach.out);
  }

  // B. A stale auto-arm on a box that never started the run starts NOTHING.
  {
    const o = await fresh();
    const at = Date.now() - 3600_000;
    const r = await sh(attachCmd(RUN, { schedAt: at, allowCreate: false }, o));
    assert(r.out.includes('did not start this scheduled run'), 'B: a stale arm reports the miss', r.out);
    assert(!(await has('snipe')) && !r.out.includes('RUN_START'), 'B: a stale arm never launches a late run', r.out);
  }

  // C. An old log from a DIFFERENT schedule is never mistaken for this one.
  {
    const o = await fresh();
    fs.mkdirSync(path.join(o.dir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(o.dir, 'logs', 'live-run.log'), `${armMarker(1_700_000_000_000)}\nOLD BOOKED VERDICT\n`);
    const r = await sh(attachCmd(RUN, { schedAt: Date.now() - 3600_000, allowCreate: false }, o));
    assert(!r.out.includes('OLD BOOKED VERDICT') && r.out.includes('did not start this scheduled run'), 'C: yesterday’s log is not replayed as today’s result', r.out);
  }

  // D. Fallback: the box had no timer and the arm is on time → the attach starts the run.
  {
    const o = await fresh();
    const r = await sh(attachCmd(RUN, { schedAt: Date.now(), allowCreate: true }, o));
    assert(count(r.out, 'RUN_START') === 1 && r.out.includes('RUN_END'), 'D: on-time fallback starts and follows exactly one run', r.out);
    assert(r.out.includes('starting it from this Mac now') && !r.out.includes('on its own timer'), 'D: the fallback says the Mac started it', r.out);
  }

  // E. The timer firing while a run is already live starts no second run.
  {
    const o = await fresh();
    fs.mkdirSync(path.join(o.dir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(o.dir, 'logs', 'live-run.log'), 'ORIGINAL RUN\n');
    await sh(`${TMUX} new-session -d -s snipe 'sleep 8'`);
    const at = (Math.floor(Date.now() / 1000) + 2) * 1000;
    await sh(armTimerCmd(at, RUN, o));
    await until(at + 2500);
    const log = fs.readFileSync(path.join(o.dir, 'logs', 'live-run.log'), 'utf8');
    assert(!(await has('armtimer')), 'E: the timer exits when a run is already live');
    assert(log === 'ORIGINAL RUN\n', 'E: the live run’s log is untouched — no second run', log);
  }

  // F. tmux prefix matching: a pending timer must never look like a live run.
  {
    const o = await fresh();
    const at = Date.now() + 120_000;
    await sh(armTimerCmd(at, RUN, o));
    const r = await sh(attachCmd(RUN, {}, o)); // "arm now" while a timer is pending
    assert(count(r.out, 'RUN_START') === 1 && r.out.includes('RUN_END'), 'F: "arm now" starts a real run despite the pending timer', r.out);
    assert(await has('armtimer'), 'F: the pending timer is left alone');
    const cancel = await sh(cancelTimerCmd(false, o));
    assert(cancel.out.includes('ARMTIMER_GONE') && !(await has('armtimer')), 'F: cancel removes the timer and confirms it', cancel.out);
    const again = await sh(cancelTimerCmd(false, o));
    assert(again.out.includes('ARMTIMER_GONE'), 'F: cancelling twice is still a confirmed cancel', again.out);
  }

  // G. Re-setting a schedule replaces the timer instead of stacking a second one.
  {
    const o = await fresh();
    await sh(armTimerCmd(Date.now() + 120_000, RUN, o));
    const second = await sh(armTimerCmd(Date.now() + 180_000, RUN, o));
    const sessions = (await sh(`${TMUX} list-sessions -F '#{session_name}'`)).out.trim().split('\n');
    assert(second.out.includes('ARMTIMER_OK') && sessions.filter((s) => s === 'armtimer').length === 1, 'G: one timer after a re-set', sessions.join(','));
  }

  // H. A run command that could break out of its quoting is refused.
  {
    let threw = false;
    try { armTimerCmd(Date.now() + 60_000, `echo hi'; rm -rf /tmp/x; echo '`); } catch { threw = true; }
    assert(threw, 'H: a run command containing a quote is rejected, never embedded');
  }

  await sh(`${TMUX} kill-server 2>/dev/null; true`);
}

main().then(() => {
  console.log(`\n  ────────────────────────────\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
});
