/**
 * Clock sync + release-timing math for the 7pm drop.
 *
 * Pure functions and one dependency-injected, hard-bounded probe. Kept out of
 * turbo.ts (import-time side effects) so tests.ts imports it directly, exactly
 * like turbo-guards.ts.
 */

// ────────────────────────────────────────────────────────────
// NTP
// ────────────────────────────────────────────────────────────
export interface NtpSample { offsetMs: number; rttMs: number }

/** NTP clock-filter rule: the minimum-delay sample has the smallest possible
 * path-asymmetry error (|err| <= rtt/2). A median of offsets keeps that error
 * from the noisier samples instead of discarding them. */
export function pickNtpSample(samples: NtpSample[]): NtpSample | null {
  const ok = samples.filter((s) => Number.isFinite(s.offsetMs) && Number.isFinite(s.rttMs) && s.rttMs >= 0);
  if (!ok.length) return null;
  return [...ok].sort((a, b) => a.rttMs - b.rttMs)[0];
}

// ────────────────────────────────────────────────────────────
// ForeUp HTTP Date header — causal (assumption-free) interval
// ────────────────────────────────────────────────────────────
export interface DateSample { sendMs: number; recvMs: number; serverSecMs: number }
export interface OffsetInterval { lo: number; hi: number; votes: number; used: number; minRttMs: number }

/** The server stamped its Date header somewhere inside [send, recv] (local),
 * and the header names server second [v, v+1000). So the offset
 * θ = server − local lies in (v − recv, v + 1000 − send) for EVERY sample,
 * with no symmetric-path or stamp-position assumption. Samples slower than
 * 1.5×minRTT+slack are dropped; Marzullo's sweep returns the sub-interval
 * agreed by the most survivors so one odd backend cannot poison it. */
export function causalOffsetInterval(samples: DateSample[], rttSlackMs = 15): OffsetInterval | null {
  const valid = samples.filter((s) => Number.isFinite(s.sendMs) && Number.isFinite(s.recvMs)
    && Number.isFinite(s.serverSecMs) && s.recvMs >= s.sendMs);
  if (!valid.length) return null;
  const minRttMs = Math.min(...valid.map((s) => s.recvMs - s.sendMs));
  const use = valid.filter((s) => s.recvMs - s.sendMs <= minRttMs * 1.5 + rttSlackMs);
  const edges: Array<[number, 1 | -1]> = [];
  for (const s of use) {
    edges.push([s.serverSecMs - s.recvMs, 1]);
    edges.push([s.serverSecMs + 1000 - s.sendMs, -1]);
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // a close sorts before an open at the same edge
  let depth = 0, best = 0, lo = NaN, hi = NaN;
  for (let i = 0; i < edges.length; i++) {
    depth += edges[i][1];
    if (edges[i][1] === 1 && depth > best && i + 1 < edges.length) {
      best = depth; lo = edges[i][0]; hi = edges[i + 1][0];
    }
  }
  if (!best) return null;
  return { lo: Math.floor(lo), hi: Math.ceil(hi), votes: best, used: use.length, minRttMs: Math.round(minRttMs) };
}

export type ClockSource = 'ntp' | 'ntp+foreup' | 'prior' | 'prior+foreup' | 'foreup' | 'local';
export interface ClockDecision {
  offsetMs: number;
  source: ClockSource;
  correctionMs: number;          // how far ForeUp's interval moved the NTP/local base
  foreupLo: number | null;
  foreupHi: number | null;
}
/** A larger "correction" means a broken probe (CDN Date, parse bug), not a
 * plausibly mis-set ForeUp server; keep the base clock and say so. */
export const MAX_FOREUP_CORRECTION_MS = 500;
/** With no independent reference (no NTP, no earlier NTP-backed offset) the
 *  machine clock itself is unverified, so a tight ForeUp interval is the best
 *  evidence available; only an absurd correction is still refused. */
export const MAX_FOREUP_ONLY_CORRECTION_MS = 10_000;

/** NTP (±rtt/2 of UTC) is the base; on AWS the chrony-disciplined local clock
 * is the base when NTP is unavailable. ForeUp's whole-second Date header only
 * bounds ITS clock to an interval about one request-processing time wide
 * (~70-100ms on the times API). Keep the base whenever that interval contains
 * it; move to the nearest edge only when ForeUp proves its clock differs. */
export function fuseClockOffset(
  ntpMs: number | null, foreup: OffsetInterval | null, minVotes = 2, priorMs: number | null = null,
): ClockDecision {
  // Base: fresh NTP; else the offset already in use (a re-sync whose NTP
  // failed must not fall back to the raw machine clock); else the machine.
  const base = ntpMs ?? priorMs ?? 0;
  const baseSource: ClockSource = ntpMs !== null ? 'ntp' : priorMs !== null ? 'prior' : 'local';
  const iv = foreup && foreup.votes >= minVotes && foreup.lo <= foreup.hi ? foreup : null;
  if (!iv) return { offsetMs: base, source: baseSource, correctionMs: 0, foreupLo: foreup?.lo ?? null, foreupHi: foreup?.hi ?? null };
  const clamped = Math.min(iv.hi, Math.max(iv.lo, base));
  const correctionMs = clamped - base;
  const cap = baseSource === 'local' ? MAX_FOREUP_ONLY_CORRECTION_MS : MAX_FOREUP_CORRECTION_MS;
  if (Math.abs(correctionMs) > cap) {
    return { offsetMs: base, source: baseSource, correctionMs: 0, foreupLo: iv.lo, foreupHi: iv.hi };
  }
  const corrected: ClockSource = baseSource === 'ntp' ? 'ntp+foreup' : baseSource === 'prior' ? 'prior+foreup' : 'foreup';
  return {
    offsetMs: clamped,
    source: correctionMs === 0 ? baseSource : corrected,
    correctionMs,
    foreupLo: iv.lo,
    foreupHi: iv.hi,
  };
}

export interface DateProbeDeps {
  /** One request; resolves the Date header (or null), rejects on error/timeout. */
  fetchDate: (timeoutMs: number) => Promise<string | null>;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
}
export interface DateProbeOptions {
  budgetMs?: number;       // HARD wall budget from the call, including backoff
  maxRequests?: number;
  timeoutMs?: number;      // per request
  priorOffsetMs?: number | null; // NTP offset: where to aim the first boundary
}
export type DateProbeReason = 'ok' | 'no_samples' | 'no_date_header' | 'too_few_votes';
export interface DateProbeResult {
  samples: DateSample[];
  interval: OffsetInterval | null;
  requests: number;
  errors: number;
  reason: DateProbeReason;
  elapsedMs: number;
}

/** Bounded, low-rate ForeUp Date probe. Each request after the first is timed
 * so its send lands at a bisected offset from the NEXT predicted server-second
 * boundary, which tightens the causal interval with ~1 request/second instead
 * of a 15ms-gap burst. It cannot run past budgetMs, backs off on errors, and
 * never loops on a failing network. */
export async function probeServerDate(deps: DateProbeDeps, opts: DateProbeOptions = {}): Promise<DateProbeResult> {
  const budgetMs = opts.budgetMs ?? 6000;
  const maxRequests = opts.maxRequests ?? 12;
  const timeoutMs = opts.timeoutMs ?? 1500;
  const start = deps.nowMs();
  const deadline = start + budgetMs;
  const samples: DateSample[] = [];
  let requests = 0, errors = 0, missingHeader = 0, backoffMs = 100;
  let minRtt = Number.POSITIVE_INFINITY;
  let dLo = Number.NaN, dHi = Number.NaN; // send offset (ms) from the predicted local boundary: OLD at dLo, NEW at dHi
  while (requests < maxRequests) {
    let sendAt = deps.nowMs();
    let boundaryServerMs: number | null = null;
    let d = 0;
    if (samples.length && Number.isFinite(minRtt)) {
      const iv = causalOffsetInterval(samples);
      const prior = opts.priorOffsetMs ?? null;
      const theta = iv ? (prior === null ? (iv.lo + iv.hi) / 2 : Math.min(iv.hi, Math.max(iv.lo, prior))) : (prior ?? 0);
      if (Number.isNaN(dLo)) { dLo = -minRtt - 40; dHi = 40; }
      d = (dLo + dHi) / 2;
      boundaryServerMs = Math.ceil((deps.nowMs() + theta - d + 20) / 1000) * 1000;
      sendAt = boundaryServerMs - theta + d;
    }
    if (sendAt + timeoutMs > deadline) break; // never start a request that could outlive the budget
    const wait = sendAt - deps.nowMs();
    if (wait > 0) await deps.sleep(wait);
    requests++;
    const sendMs = deps.nowMs();
    let hdr: string | null;
    try {
      hdr = await deps.fetchDate(timeoutMs);
    } catch {
      errors++;
      await deps.sleep(Math.max(0, Math.min(backoffMs, deadline - deps.nowMs())));
      backoffMs = Math.min(1600, backoffMs * 2);
      continue;
    }
    const recvMs = deps.nowMs();
    backoffMs = 100;
    const v = hdr ? Date.parse(hdr) : Number.NaN;
    if (!Number.isFinite(v)) {
      if (++missingHeader >= 2) break;
      continue;
    }
    samples.push({ sendMs, recvMs, serverSecMs: v });
    minRtt = Math.min(minRtt, recvMs - sendMs);
    if (boundaryServerMs !== null) {
      if (v >= boundaryServerMs) dHi = d; else dLo = d;
      if (dHi - dLo < 4) { dLo -= 10; dHi += 10; } // keep straddling the transition as RTT jitters
    }
  }
  const interval = causalOffsetInterval(samples);
  const reason: DateProbeReason = !samples.length
    ? (missingHeader ? 'no_date_header' : 'no_samples')
    : interval && interval.votes >= 2 ? 'ok' : 'too_few_votes';
  return { samples, interval, requests, errors, reason, elapsedMs: Math.round(deps.nowMs() - start) };
}

// ────────────────────────────────────────────────────────────
// Release calibration from drop telemetry (race-log.jsonl poll events)
// ────────────────────────────────────────────────────────────
export interface PollEventLike { name: string; ms?: number | null; course?: string; rtt?: number; hit?: boolean; sentMs?: number }
export interface SendBracket { lastMissSentMs: number | null; firstHitSentMs: number; firstHitRecvMs: number; polls: number }

/** Release as seen by a request's server-side check, expressed in SEND time
 * relative to T=0: the latest-sent miss and earliest-sent hit bracket the send
 * instant that first sees the open sheet. Send-time is what a blind shot
 * controls, and it already folds in server queueing and our clock error. */
export function releaseSendBracket(events: PollEventLike[], courseKey: string): SendBracket | null {
  const polls = events
    .filter((e) => e.name === 'poll' && e.course === courseKey && typeof e.ms === 'number' && typeof e.rtt === 'number')
    // sentMs is the exact release-relative send time (newer runs); ms − rtt reconstructs it for older ones.
    .map((e) => ({ sent: typeof e.sentMs === 'number' ? e.sentMs : (e.ms as number) - (e.rtt as number), recv: e.ms as number, hit: !!e.hit }));
  const hits = polls.filter((p) => p.hit);
  if (!hits.length) return null;
  const firstHitSentMs = Math.min(...hits.map((h) => h.sent));
  const misses = polls.filter((p) => !p.hit && p.sent < firstHitSentMs);
  return {
    lastMissSentMs: misses.length ? Math.max(...misses.map((p) => p.sent)) : null,
    firstHitSentMs,
    firstHitRecvMs: Math.min(...hits.map((h) => h.recv)),
    polls: polls.length,
  };
}

export interface RunLike {
  timingBasis?: string;
  events?: Array<PollEventLike & { offsetMs?: number; toMs?: number; ntpMs?: number | null; timedOut?: boolean }>;
}
export interface ReleaseStats {
  n: number;
  latestFirstHitSentMs: number;   // slowest observed release, in send time
  medianFirstHitSentMs: number;
  earliestFirstHitSentMs: number;
  openLowRuns: number;            // runs whose FIRST poll already hit: polling started too late
}

/** Summarize scheduled drops only, each normalized to NTP time when the run
 * recorded both the offset it used and NTP (so a switch of clock estimator
 * does not shift the history by the old estimator's bias). */
export function summarizeReleaseRuns(runs: RunLike[], courseKey: string): ReleaseStats | null {
  const firstHits: number[] = [];
  let openLowRuns = 0;
  for (const run of runs) {
    if (run.timingBasis !== 'server_release' || !run.events) continue;
    const b = releaseSendBracket(run.events, courseKey);
    if (!b) continue;
    // Normalize with the offset the polls were actually timed by: the last
    // successful T-30 re-sync if there was one, else the arm-time sync.
    const used = (e: { offsetMs?: number; toMs?: number }) => (typeof e.offsetMs === 'number' ? e.offsetMs : e.toMs);
    const resync = [...run.events].reverse().find((e) => e.name === 'clock_resync' && !e.timedOut
      && typeof used(e) === 'number' && typeof e.ntpMs === 'number');
    const sync = resync ?? run.events.find((e) => e.name === 'clock_sync' && typeof used(e) === 'number' && typeof e.ntpMs === 'number');
    const shift = sync ? (used(sync) as number) - (sync.ntpMs as number) : 0;
    firstHits.push(b.firstHitSentMs - shift);
    if (b.lastMissSentMs === null) openLowRuns++;
  }
  if (!firstHits.length) return null;
  const s = [...firstHits].sort((a, b) => a - b);
  return {
    n: s.length,
    latestFirstHitSentMs: s[s.length - 1],
    medianFirstHitSentMs: s[Math.floor(s.length / 2)],
    earliestFirstHitSentMs: s[0],
    openLowRuns,
  };
}

/** Data-driven SPEC offsets: the first shot leaves just after the LATEST
 * send-time that has ever seen the sheet open (+margin), clamped to
 * [0, 400]ms so it never fires before nominal release and never later than
 * the detect path would. Later shots keep their configured spacing. With fewer
 * than minRuns calibrated drops the configured defaults are returned. */
export function planSpecOffsets(
  defaults: number[], stats: ReleaseStats | null,
  opts: { marginMs?: number; minMs?: number; maxMs?: number; minRuns?: number } = {},
): number[] {
  const { marginMs = 15, minMs = 0, maxMs = 400, minRuns = 2 } = opts;
  if (!defaults.length || !stats || stats.n < minRuns) return defaults;
  const first = Math.round(Math.min(maxMs, Math.max(minMs, stats.latestFirstHitSentMs + marginMs)));
  const shift = first - defaults[0];
  return defaults.map((d, i) => (i === 0 ? first : Math.max(first + 1, Math.min(5000, d + shift))));
}

/** Poll head start: if any calibrated drop opened before our first poll was
 * sent, or the earliest open send-time is close to the current lead, widen it
 * (bounded: every extra 100ms is ~8 polls/course at the default pipeline). */
export function planPreDropMs(stats: ReleaseStats | null, baseMs = 200, maxMs = 1000): number {
  if (!stats) return baseMs;
  let lead = Math.max(baseMs, -stats.earliestFirstHitSentMs + 150);
  if (stats.openLowRuns > 0) lead = Math.max(lead, 600);
  return Math.round(Math.min(maxMs, lead));
}
