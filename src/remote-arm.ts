/**
 * Shell commands that arm, attach to and cancel a run on a remote box (AWS /
 * GCP). Pure string builders — ui-server.ts runs them over ssh, and
 * tests-armtimer.ts runs the very same strings against a real local tmux, so
 * the mechanics are verified without touching a box or ForeUp.
 *
 * Model: a run lives in the tmux session `snipe` and writes logs/live-run.log.
 * A scheduled run is first a session called `armtimer` that sleeps until the
 * arm time and then RENAMES ITSELF to `snipe` — tmux session names are unique,
 * so two runs can never coexist. (`armtimer` is deliberately not a prefix of
 * `snipe`: tmux `-t` does prefix matching; `=name` forces an exact match. The
 * `=name` targets are always QUOTED: tmux runs a session's command under the
 * user's login shell, and in zsh a bare `=word` is command-path expansion
 * that aborts the line — caught by the real-tmux test on the Mac.)
 */
export interface RemoteOpts { dir?: string; tmux?: string }
const dirOf = (o?: RemoteOpts) => o?.dir ?? '~/bethpage-sniper';
const tmuxOf = (o?: RemoteOpts) => o?.tmux ?? 'tmux';

/** First line of logs/live-run.log when the box's own timer started the run. */
export const armMarker = (atMs: number) => `# armtimer ${Math.floor(atMs / 1000)}`;

function assertEmbeddable(runCmd: string): void {
  // runCmd is embedded inside single quotes; refuse anything that could break out.
  if (/['\n\r`]/.test(runCmd)) throw new Error('run command contains characters that cannot be embedded safely');
}

/** Follow the run log until the `snipe` session ends (live run), or replay it
 *  once if the session is already gone (finished run). */
function followLog(o?: RemoteOpts): string {
  const tmux = tmuxOf(o);
  return `touch logs/live-run.log; tail -n +1 -F logs/live-run.log & TP=$!; ` +
    `while ${tmux} has-session -t "=snipe" 2>/dev/null; do sleep 2; done; sleep 2; kill $TP 2>/dev/null; true`;
}

/** Give the box its own timer: sleep until atMs, then become the run. If a run
 *  is already live at that moment the rename fails and nothing starts twice.
 *  Prints ARMTIMER_OK once the timer session exists. */
export function armTimerCmd(atMs: number, runCmd: string, o?: RemoteOpts): string {
  assertEmbeddable(runCmd);
  const tmux = tmuxOf(o);
  const dir = dirOf(o);
  const atSec = Math.floor(atMs / 1000);
  const inner =
    `S=$(( ${atSec} - $(date +%s) )); [ "$S" -gt 0 ] && sleep "$S"; ` +
    `${tmux} has-session -t "=snipe" 2>/dev/null && exit 0; ` +
    `${tmux} rename-session -t "=armtimer" snipe || exit 0; ` +
    `cd ${dir} && echo "${armMarker(atMs)}" > logs/live-run.log && { ${runCmd}; } >> logs/live-run.log 2>&1`;
  return `cd ${dir} && mkdir -p logs && { ${tmux} kill-session -t "=armtimer" 2>/dev/null; true; } && ` +
    `${tmux} new-session -d -s armtimer '${inner}' && ${tmux} has-session -t "=armtimer" && echo ARMTIMER_OK`;
}

/** Remove the box's timer; prints ARMTIMER_GONE only when it is confirmed
 *  gone. alsoRun also stops a run the timer may have just started. */
export function cancelTimerCmd(alsoRun: boolean, o?: RemoteOpts): string {
  const tmux = tmuxOf(o);
  const killRun = alsoRun ? `${tmux} kill-session -t "=snipe" 2>/dev/null; pkill -INT -f 'tsx src/turbo' 2>/dev/null; ` : '';
  return `${tmux} kill-session -t "=armtimer" 2>/dev/null; ${killRun}` +
    `${tmux} has-session -t "=armtimer" 2>/dev/null && echo ARMTIMER_STILL || echo ARMTIMER_GONE`;
}

/** Start-or-attach command for the dashboard's stream.
 *  - No schedAt ("arm now"): start the run unless one is live, then follow it.
 *  - schedAt (auto-arm firing): if the run is live, or the log carries this
 *    schedule's marker (the box started it — maybe already finished), ONLY
 *    follow/replay it. Otherwise start it when allowCreate, else say so and
 *    start nothing (a stale arm must never launch a late run). */
export function attachCmd(runCmd: string, sched: { schedAt?: number; allowCreate?: boolean } = {}, o?: RemoteOpts): string {
  assertEmbeddable(runCmd);
  const tmux = tmuxOf(o);
  const dir = dirOf(o);
  const follow = followLog(o);
  // { …; } groups the run so the redirect covers all of it, whatever its shape.
  const create = `rm -f logs/live-run.log; ${tmux} new-session -d -s snipe '{ ${runCmd}; } > logs/live-run.log 2>&1'; `;
  if (!sched.schedAt) {
    return `cd ${dir}; mkdir -p logs; if ! ${tmux} has-session -t "=snipe" 2>/dev/null; then ${create}fi; ${follow}`;
  }
  const marked = `[ "$(head -n 1 logs/live-run.log 2>/dev/null)" = "${armMarker(sched.schedAt)}" ]`;
  const started = `${tmux} has-session -t "=snipe" 2>/dev/null || ${marked}`;
  // Say which machine started it — the marker is only ever written by the box's timer.
  const boxStarted = `if ${marked}; then echo "  ⏰ The box started this run on its own timer — this Mac is only watching."; fi; `;
  const otherwise = sched.allowCreate
    ? `echo "  ⚠ The box had not started this run — starting it from this Mac now."; ${create}${follow}`
    : `echo "  ✗ The box did not start this scheduled run, and it is too late to start it now — nothing was run."`;
  return `cd ${dir}; mkdir -p logs; if ${started}; then ${boxStarted}${follow}; else ${otherwise}; fi`;
}
