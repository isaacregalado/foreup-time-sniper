/**
 * Bethpage Turbo Sniper — API detection + browser-native booking.
 *
 * Design (2026-07-08 rework): the direct API is a fast DETECTOR only — it
 * tells us which course/time dropped ~1 RTT after 7pm. The HOLD and everything
 * after it happen in the real browser, following ForeUp's native flow, so the
 * paid step is never reverse-engineered:
 *
 *   tile click (= the hold, auto-sends code email)
 *     → Book Time modal (verify course/date/time, click players IN the modal)
 *     → code from IMAP → fill + fire jQuery change
 *     → "Book Time" ($0 — opens Payment Method)
 *     → "Pay at Facility" + continue ($0 — renders Element card window)
 *     → pre-fill card from .env, verify amount ($5 × players)
 *     → STOP one click short of "PROCESS TRANSACTION" (the ONLY charging
 *       click), or click it with --auto-book / AUTO_BOOK=1.
 *
 * Why no standalone API hold: the old pending_reservation + localStorage
 * resume experiment did not reliably re-enter ForeUp's browser checkout.
 * Holds therefore run through ForeUp's own viewTime() handler in isolated
 * per-course browser contexts, preserving its native pending ledger and
 * modal. Flow selectors live-mapped 2026-07-08 — see HANDOFF.md.
 *
 * Slot selection: any slot in [WINDOW_START, WINDOW_END] (default 6:30–8:30am).
 * Configured course order is priority (red,green means Red wins), and
 * SLOT_ORDER chooses earliest/latest within a course. If the window is empty,
 * falls back to the closest slot AFTER the window end (never past
 * FALLBACK_UNTIL). Pre-window dawn slots never.
 *
 * Money-safe gates, in order (abort = $0, an unclicked hold expires in ~5min):
 *   1. modal text must show the exact course/date/time
 *   2. players button clicked INSIDE the modal (filter-inherited UI can lie)
 *   3. Backbone model (App.data.last_reservation) players/schedule/time match
 *   4. "Pay at Facility" radio confirmed checked (an unchecked radio would
 *      make continue book directly)
 *   5. card-window amount must equal $5 × players before any card fill
 */
import { chromium, type Page, type BrowserContext, type FrameLocator } from 'playwright';
import { EmailMonitor } from './email-monitor';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import * as dgram from 'dgram';
import { lookup } from 'dns/promises';
import { execFile, spawn } from 'child_process';
import {
  firstModalIdentityMismatch,
  missingSpecTemplateFields,
  settleWithin,
  type ModalIdentityMismatch,
} from './turbo-guards';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Tee every console line to a per-run transcript file so a run (especially a
// real booking) can be captured and shared verbatim. `npm run capture` bundles
// the newest transcript + its telemetry into one markdown file.
const RUN_LOG_PATH = path.join(__dirname, '..', 'logs', `run-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
{
  let ready = false;
  const orig = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    orig(...args);
    try {
      if (!ready) { fs.mkdirSync(path.dirname(RUN_LOG_PATH), { recursive: true }); ready = true; }
      fs.appendFileSync(RUN_LOG_PATH, args.join(' ') + '\n');
    } catch { /* never let logging break a run */ }
  };
}

// ────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────
const FOREUP = 'https://foreupsoftware.com';
const SESSION_PATH = path.join(__dirname, '..', 'auth', 'session.json');
// foreUP's WAF 403s the default "HeadlessChrome" UA; present a normal Chrome
// everywhere (browser context + fetch hot path) so all requests look alike.
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TELEMETRY_PATH = path.join(__dirname, '..', 'logs', 'race-log.jsonl');
const FEE_PER_PLAYER = 5; // Bethpage online booking fee, non-refundable

interface CourseCfg {
  key: string;
  name: string;
  courseId: number;
  scheduleId: number;
  sideId: number;
  bookingClassId: number;
  emailCode: boolean;   // reservation_confirmation_uid on the schedule (Bethpage=1, Crab Meadow=0)
  golferBtn: RegExp;    // booking-class button on the pre-booking modal
}

// Booking classes are PER SCHEDULE: the times endpoint tolerates a wrong one,
// but the hold rejects it ("Invalid booking class for this schedule"). IDs
// below are Isaac's "Verified NYS Resident - Bethpage/Sunken Meadow" class for
// each teesheet, parsed from the live page 2026-07-06.
const CRABMEADOW_CLASS = parseInt(process.env.CRABMEADOW_BOOKING_CLASS_ID ?? '10785', 10);

const bethpage = (key: string, name: string, scheduleId: number, bookingClassId: number, sideId = 0): CourseCfg => ({
  key, name, courseId: 19765, scheduleId, sideId,
  bookingClassId, emailCode: true, golferBtn: /Verified NYS Resident/i,
});

const COURSES: Record<string, CourseCfg> = {
  black:        bethpage('black',      'Bethpage Black Course',          2431, 50294),
  blue:         bethpage('blue',       'Bethpage Blue Course',           2433, 50293),
  'early-blue': bethpage('early-blue', 'Bethpage Early AM 9 Holes Blue', 2539, 50300),
  green:        bethpage('green',      'Bethpage Green Course',          2434, 50296),
  red:          bethpage('red',        'Bethpage Red Course',            2432, 50295, 1016),
  yellow:       bethpage('yellow',     'Bethpage Yellow Course 9 Holes', 2435, 50297),
  // Separate foreUP facility (own login/account) — run alone, not raced with Bethpage.
  // No email-code step: schedule has reservation_confirmation_uid=0.
  'crab-meadow': {
    key: 'crab-meadow', name: 'Crab Meadow Golf Course', courseId: 21593, scheduleId: 8314,
    sideId: 0, bookingClassId: CRABMEADOW_CLASS, emailCode: false,
    golferBtn: /Cardholder|Resident/i,
  },
};

const bookingUrl = (c: CourseCfg) => `${FOREUP}/index.php/booking/${c.courseId}/${c.scheduleId}#teetimes`;

function cliArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const argInt = (name: string, fb: number) => parseInt(cliArg(name) ?? String(fb), 10);
const DRY_RUN = process.argv.includes('--dry-run');
const ABORT_BEFORE_BOOK = process.argv.includes('--no-book'); // click tile + verify modal, then close at $0
// Full $0 checkout rehearsal: consume the email code, validate the $5/player
// amount, fill every card field, then explicitly DELETE the pending hold.
// This flag always disables AUTO_BOOK, even if AUTO_BOOK=1 leaked in via env.
const TEST_PAYMENT = process.argv.includes('--test-payment');
// Default is STOP-ONE-CLICK-SHORT: the tool fills code + card and leaves the
// paid "PROCESS TRANSACTION" click to the human. --auto-book (or AUTO_BOOK=1)
// makes it click that itself (requires FEE_CARD_* in .env).
const AUTO_BOOK = !TEST_PAYMENT && (process.argv.includes('--auto-book') || process.env.AUTO_BOOK === '1');
// Bridge hold (PRIMARY since 2026-07-13 late): call ForeUp's MODERN tile view
// directly, with the tile view class extracted at runtime from their own
// Marionette view tree (TimeTilesView.itemView → TimeTileView.prototype) —
// the class is not a window global, but the live times view instance is
// reachable via App.page.currentView.content.currentView even before any tile
// renders. viewTime(model, false) runs the exact same 16-field createPending
// POST as a human tile click (the legacy window.TimeView synth posted 8 fields
// and was rejected "Invalid request" — that dead end is gone). This skips the
// tile-render wait AND the isTeetimesRefreshing click-drop entirely: first
// hold attempt lands ~T+0.7s instead of T+2.7s. Tile click remains the
// fallback on bridge_error. Disable with --no-bridge / BRIDGE=0.
const BRIDGE_OFF = process.argv.includes('--no-bridge') || process.env.BRIDGE === '0';
// Speculative pre-aimed hold (--spec / SPEC=1): blind-fire the bridge hold at
// a PREDICTED top window slot at fixed offsets after T=0, without waiting for
// any poll response. Rationale (race-log, real drops 07-12 + 07-13): the
// availability flip lands ~T+0.15–0.45s and the times endpoint answers in
// ~370-420ms under drop load, so every detect-then-hold bot — including ours —
// is floor-bounded near T+0.9s. createPending's 16 _.pick'd fields are all
// predictable pre-drop (slot grid + per-course IDs + fees/sides scouted from
// published neighbor dates); nothing in the POST comes from the times
// response. A wrong guess is one rejected hold; the normal detect path runs
// unchanged underneath. Shots are capped and deliberate — never a hammer loop.
const SPEC = process.argv.includes('--spec') || process.env.SPEC === '1';
const SPEC_OFFSETS_MS: number[] = (cliArg('spec-fire') ?? process.env.SPEC_FIRE_MS ?? '150,450')
  .split(',').map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n >= 0 && n <= 5000)
  .slice(0, 3); // ≤3 shots/course — rate-limit hygiene ("Invalid request" trips near 9 holds/5min)
const RACE = process.argv.includes('--race') || process.env.RACE === '1'; // pipelined poll across courses

const courseKeys = [...new Set((cliArg('course') ?? process.env.COURSE ?? 'red,green')
  .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean))];
const RACE_COURSES = courseKeys.map((k) => COURSES[k]).filter((c): c is CourseCfg => !!c);
if (RACE_COURSES.length === 0) RACE_COURSES.push(COURSES.red, COURSES.green);
if (new Set(RACE_COURSES.map((c) => c.courseId)).size > 1) {
  console.error('\n  ✗ Cannot mix facilities in one run (Bethpage and Crab Meadow use separate logins). Pick one.\n');
  process.exit(1);
}

/** "6:30" → minutes since midnight */
function parseHM(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

type SlotOrder = 'earliest' | 'latest';
const slotOrderRaw = (cliArg('slot-order') ?? process.env.SLOT_ORDER ?? 'earliest').toLowerCase();
if (slotOrderRaw !== 'earliest' && slotOrderRaw !== 'latest') {
  console.error(`\n  ✗ SLOT_ORDER/--slot-order must be "earliest" or "latest" (got ${slotOrderRaw}).\n`);
  process.exit(1);
}
const SLOT_ORDER = slotOrderRaw as SlotOrder;

const cfg = {
  foreupEmail: process.env.FOREUP_EMAIL ?? '',
  foreupPassword: process.env.FOREUP_PASSWORD ?? '',
  gmailEmail: process.env.GMAIL_EMAIL ?? '',
  gmailAppPassword: process.env.GMAIL_APP_PASSWORD ?? '',
  courses: RACE_COURSES,
  windowStart: parseHM(cliArg('from') ?? process.env.WINDOW_START ?? '6:30'),
  windowEnd: parseHM(cliArg('to') ?? process.env.WINDOW_END ?? '8:30'),
  // Fallback slots (after windowEnd) are only taken up to this time — an
  // unbounded "closest after 8" could book a 1pm slot on a sparse day.
  fallbackUntil: parseHM(cliArg('fallback-until') ?? process.env.FALLBACK_UNTIL ?? '8:30'),
  slotOrder: SLOT_ORDER,
  players: argInt('players', parseInt(process.env.PLAYERS ?? '4', 10)),
  // The drop attempt uses `players`; vulture may accept fewer golfers when
  // the user explicitly configured MIN_PLAYERS/--min-players. A candidate
  // carries its own player count through every checkout and money gate.
  minPlayers: argInt('min-players', parseInt(process.env.MIN_PLAYERS ?? process.env.PLAYERS ?? '4', 10)),
  holes: argInt('holes', parseInt(process.env.HOLES ?? '18', 10)),
  targetDate: cliArg('date') ?? process.env.TARGET_DATE ?? '',
  preDropMs: 200,        // Start polling this far before T=0
  pollIntervalMs: 50,    // Cycle time within the serial poll loop
  // ── Race mode tunables ──
  race: RACE,
  pollConcurrency: argInt('poll-concurrency', 6), // max in-flight polls PER COURSE
  pollStaggerMs: argInt('poll-stagger', 12),      // gap between launching polls
  candidates: argInt('candidates', 3),            // # of tiles to try (in rank order) before vulture
  // After the first course detects, wait this long for the other course before
  // ranking cross-course — the browser can only click one tile, so we pick
  // once. Short: both schedules live on the same backend and detect together.
  raceGraceMs: argInt('race-grace', 350),
  // After a lost race, keep hunting this many minutes: unpaid holds expire at
  // +5min and abandoned carts free up. 0 disables.
  vultureMs: argInt('vulture-min', parseInt(process.env.VULTURE_MIN ?? '7', 10)) * 60_000,
  vulturePollMs: Math.max(750, argInt('vulture-poll-sec', parseInt(process.env.VULTURE_POLL_SEC ?? '1', 10)) * 1000),
  // Booking-fee card for the Element payment window (NO saved-card option
  // exists there — live-verified). Missing values = tool stops at the card
  // form and the human types it.
  feeCard: {
    number: (process.env.FEE_CARD_NUMBER ?? '').replace(/\s+/g, ''),
    expMonth: process.env.FEE_CARD_EXP_MONTH ?? '',
    expYear: process.env.FEE_CARD_EXP_YEAR ?? '',
    cvv: process.env.FEE_CARD_CVV ?? '',
  },
};

if (!Number.isInteger(cfg.players) || cfg.players < 1 || cfg.players > 4 ||
    !Number.isInteger(cfg.minPlayers) || cfg.minPlayers < 1 || cfg.minPlayers > cfg.players) {
  console.error(`\n  ✗ Player range must satisfy 1 <= MIN_PLAYERS/--min-players <= PLAYERS/--players <= 4 (got ${cfg.minPlayers}–${cfg.players}).\n`);
  process.exit(1);
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Keep the AbortController live through body consumption, not merely until
 * response headers arrive. A headers-only response with a stalled body must
 * not occupy all six drop-poll lanes forever. */
async function fetchWithTimeout<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return await consume(response);
  } finally {
    clearTimeout(timer);
  }
}

const fetchTextWithTimeout = (url: string, init: RequestInit, timeoutMs: number) =>
  fetchWithTimeout(url, init, timeoutMs, async (response) => ({ response, text: await response.text() }));

const fetchHeaderWithTimeout = (url: string, init: RequestInit, timeoutMs: number, header: string) =>
  fetchWithTimeout(url, init, timeoutMs, async (response) => {
    const value = response.headers.get(header);
    await response.arrayBuffer(); // drain the small body so Undici can reuse the warm socket
    return value;
  });

const fetchAndDiscardWithTimeout = (url: string, init: RequestInit, timeoutMs: number) =>
  fetchWithTimeout(url, init, timeoutMs, async (response) => {
    await response.arrayBuffer();
  });

function ts() {
  const d = new Date();
  const t = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  return `${t}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
function log(icon: string, msg: string) { console.log(`  ${icon} [${ts()}] ${msg}`); }
function sound(name: 'success' | 'alert' | 'error') {
  if (process.platform !== 'darwin') return;
  const f = { success: '/System/Library/Sounds/Hero.aiff', alert: '/System/Library/Sounds/Glass.aiff', error: '/System/Library/Sounds/Basso.aiff' }[name];
  execFile('afplay', [f], () => {});
}

function getTargetDate(): string {
  if (cfg.targetDate) return cfg.targetDate;
  const d = new Date(); d.setDate(d.getDate() + 7);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${d.getFullYear()}`;
}

/** "07-13-2026" → "Jul 13, 2026" (the Book Time modal's date format) */
function humanDate(mdY: string): string {
  const [m, d, y] = mdY.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const fmtMin = (m: number) => {
  const h = Math.floor(m / 60), mm = m % 60;
  const h12 = h > 12 ? h - 12 : h || 12;
  return `${h12}:${String(mm).padStart(2, '0')}${h >= 12 ? 'pm' : 'am'}`;
};

// ────────────────────────────────────────────────────────────
// Telemetry — one JSON line per run in logs/race-log.jsonl.
// Poll RTTs recorded until detection; every tile-click outcome recorded.
// ────────────────────────────────────────────────────────────
const TEL: { runAt: string; args: string[]; timingBasis?: 'server_release' | 'run_start'; events: Array<Record<string, unknown>> } = {
  runAt: new Date().toISOString(), args: process.argv.slice(2), events: [],
};
let telT0 = 0; // server-release epoch for scheduled drops; run start for live-sheet tests
function tev(name: string, data: Record<string, unknown> = {}) {
  TEL.events.push({ ms: telT0 ? now() - telT0 : null, name, ...data });
}
function saveTelemetry() {
  try {
    fs.mkdirSync(path.dirname(TELEMETRY_PATH), { recursive: true });
    fs.appendFileSync(TELEMETRY_PATH, JSON.stringify(TEL) + '\n');
  } catch { /* never let telemetry break a run */ }
}

// ────────────────────────────────────────────────────────────
// NTP cross-check — DNS is resolved before timing, then three SNTP samples
// are medianed so a cold resolver or one delayed packet cannot skew T=0.
// ────────────────────────────────────────────────────────────
interface NtpSample { offsetMs: number; rttMs: number }

async function ntpSample(address: string): Promise<NtpSample | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const packet = Buffer.alloc(48);
    packet[0] = 0x1b; // LI=0, VN=3, Mode=3 (client)
    const t1 = Date.now();
    const timer = setTimeout(() => { sock.close(); resolve(null); }, 1200);
    sock.on('message', (msg) => {
      const t4 = Date.now();
      const ntpMs = (off: number) => {
        const seconds = msg.readUInt32BE(off);
        const fraction = msg.readUInt32BE(off + 4);
        return (seconds - 2208988800) * 1000 + (fraction / 0x100000000) * 1000;
      };
      const t2 = ntpMs(32); // server receive
      const t3 = ntpMs(40); // server transmit
      const offsetMs = ((t2 - t1) + (t3 - t4)) / 2;
      const rttMs = (t4 - t1) - (t3 - t2);
      clearTimeout(timer);
      sock.close();
      resolve({ offsetMs: Math.round(offsetMs), rttMs: Math.max(0, Math.round(rttMs)) });
    });
    sock.send(packet, 123, address, (err) => { if (err) { clearTimeout(timer); sock.close(); resolve(null); } });
  });
}

async function ntpOffset(samples = 3): Promise<number | null> {
  const address = await lookup('time.cloudflare.com', { family: 4 }).then((r) => r.address).catch(() => null);
  if (!address) return null;
  const got: NtpSample[] = [];
  for (let i = 0; i < samples; i++) {
    const s = await ntpSample(address);
    if (s) got.push(s);
  }
  if (!got.length) return null;
  const offsets = got.map((s) => s.offsetMs).sort((a, b) => a - b);
  return offsets[Math.floor(offsets.length / 2)];
}

// ────────────────────────────────────────────────────────────
// ForeUp server-clock sync — the drop fires on ForeUp's OWN clock, so
// aligning to its HTTP `Date` header beats NTP (which only helps if ForeUp's
// servers are perfectly disciplined; Date-header sync catches drift NTP
// can't). `Date` is second-resolution, so we tick-boundary detect: sample
// fast until the header's second value increments — that flip pins the
// server's exact second boundary to within the old/new sample bracket.
// ────────────────────────────────────────────────────────────

interface ServerFlip { offsetMs: number; gapMs: number }

/** The last-old and first-new response midpoints bracket the server's second
 * boundary. Their midpoint is less biased than treating the first-new request
 * as the boundary (which was systematically one request interval late). */
function serverOffsetFromFlip(previousMidpointMs: number, currentMidpointMs: number, newSecondEpochMs: number): ServerFlip {
  return {
    offsetMs: Math.round(newSecondEpochMs - (previousMidpointMs + currentMidpointMs) / 2),
    gapMs: Math.round(currentMidpointMs - previousMidpointMs),
  };
}

/** Prefer the tightest transition brackets and median up to three of them.
 * Wide brackets are RTT outliers and carry hundreds of ms of uncertainty. */
function selectServerOffset(flips: ServerFlip[]): number | null {
  const ranked = flips.filter((f) => f.gapMs > 0 && f.gapMs <= 400).sort((a, b) => a.gapMs - b.gapMs);
  if (!ranked.length) return null;
  // Do not average a clean 160ms bracket with a 300ms outlier merely because
  // only two flips were captured. Keep peers within 50ms of the best gap.
  const tight = ranked.filter((f) => f.gapMs <= ranked[0].gapMs + 50).slice(0, 3);
  const offsets = tight.map((f) => f.offsetMs).sort((a, b) => a - b);
  if (offsets.length % 2) return offsets[Math.floor(offsets.length / 2)];
  return Math.round((offsets[offsets.length / 2 - 1] + offsets[offsets.length / 2]) / 2);
}

// Warm once, then allow a full three-second observation window. This normally
// captures 2-3 flips; it returns early after three to cap read-only traffic.
async function foreupServerOffset(maxMs = 3000): Promise<number | null> {
  const c = cfg.courses[0];
  const url = `${FOREUP}/index.php/api/booking/times?time=all&date=01-01-2030&holes=all&players=0&booking_class=${c.bookingClassId}&schedule_id=${c.scheduleId}&specials_only=0&api_key=no_limits`;
  let deadline = Number.POSITIVE_INFINITY;
  let prevSec: number | null = null;
  let prevMidpoint: number | null = null;
  const flips: ServerFlip[] = [];
  while (Date.now() < deadline && flips.length < 3) {
    const t0 = Date.now();
    let dateHdr: string | null = null;
    try { dateHdr = await fetchHeaderWithTimeout(url, { headers: { 'User-Agent': CHROME_UA }, method: 'GET' }, 800, 'date'); }
    catch { continue; }
    const t1 = Date.now();
    if (!dateHdr) return null;
    const sec = Date.parse(dateHdr); // second-resolution → the second's .000
    if (Number.isNaN(sec)) return null;
    const midpoint = (t0 + t1) / 2;
    if (prevSec === null) deadline = Date.now() + maxMs; // cold warm-up does not consume the sample window
    else if (prevMidpoint !== null && sec - prevSec === 1000) {
      flips.push(serverOffsetFromFlip(prevMidpoint, midpoint, sec));
    }
    prevSec = sec;
    prevMidpoint = midpoint;
    // Sample tighter than the ½RTT so the flip is caught near its true instant.
    await sleep(15);
  }
  return selectServerOffset(flips);
}

const CLOCK_MAX_DELTA_MS = 125;
function trustedClockOffset(foreupMs: number | null, ntpMs: number | null): { offsetMs: number; source: 'foreup' | 'ntp' | 'local'; deltaMs: number | null } {
  const deltaMs = foreupMs !== null && ntpMs !== null ? foreupMs - ntpMs : null;
  if (foreupMs !== null && (deltaMs === null || Math.abs(deltaMs) <= CLOCK_MAX_DELTA_MS)) return { offsetMs: foreupMs, source: 'foreup', deltaMs };
  if (ntpMs !== null) return { offsetMs: ntpMs, source: 'ntp', deltaMs };
  return { offsetMs: 0, source: 'local', deltaMs };
}

let CLOCK_OFFSET_MS = 0;
const now = () => Date.now() + CLOCK_OFFSET_MS;
/** ForeUp-clock epoch of today's 7:00pm release. Offset changes alter now(),
 *  not this fixed wall-clock epoch, so a T-30s re-sync adjusts the wait safely. */
function sevenPmEpoch(serverNowMs: number): number {
  const d = new Date(serverNowMs);
  d.setHours(19, 0, 0, 0);
  return d.getTime();
}
const msUntil7pm = (): number => {
  const n = now();
  return sevenPmEpoch(n) - n;
};

// ────────────────────────────────────────────────────────────
// foreUP API client — DETECTOR ONLY (cookies from the Playwright session).
// There is deliberately no hold() and no book() here: holds stay inside each
// isolated browser context's native pending ledger, and payment only exists
// in ForeUp's checkout UI.
// ────────────────────────────────────────────────────────────
class ForeupClient {
  private cookieHeader = '';

  async loadCookiesFrom(context: BrowserContext) {
    const cookies = await context.cookies();
    this.cookieHeader = cookies
      .filter((c) => c.domain.includes('foreupsoftware.com'))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  private headers(): Record<string, string> {
    return {
      'Cookie': this.cookieHeader,
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Origin': FOREUP,
      'Referer': bookingUrl(cfg.courses[0]),
      'User-Agent': CHROME_UA,
      'Api-Key': 'no_limits',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    };
  }

  async pollTimes(date: string, course: CourseCfg, timeFilter?: 'morning' | 'all', players = cfg.players): Promise<ApiTime[] | null> {
    const tf = timeFilter ?? (cfg.windowEnd <= 12 * 60 ? 'morning' : 'all');
    const url = `${FOREUP}/index.php/api/booking/times?time=${tf}&date=${date}&holes=${cfg.holes}&players=${players}&booking_class=${course.bookingClassId}&schedule_id=${course.scheduleId}&specials_only=0&api_key=no_limits`;
    const timeoutMs = timeFilter ? 3000 : 1500; // scouts can be patient; the drop detector must free a saturated lane
    const { text } = await fetchTextWithTimeout(url, { headers: this.headers(), method: 'GET' }, timeoutMs);
    if (text === 'false' || !text) return null;
    try {
      const arr = JSON.parse(text);
      return Array.isArray(arr) && arr.length > 0 ? arr : null;
    } catch { return null; }
  }

  async preWarm(): Promise<void> {
    // Establish the TLS session before T=0. Hit a cheap GET.
    const c = cfg.courses[0];
    await fetchAndDiscardWithTimeout(`${FOREUP}/index.php/api/booking/times?time=all&date=01-01-2030&holes=all&players=0&booking_class=${c.bookingClassId}&schedule_id=${c.scheduleId}&specials_only=0&api_key=no_limits`, {
      headers: this.headers(), method: 'GET',
    }, 3000).catch(() => {});
  }
}

interface ApiTime { time: string; available_spots: number; teesheet_side_id?: number; teesheet_side_name?: string; [k: string]: any; }

// ────────────────────────────────────────────────────────────
// ForeUp preflight — detects THEM changing the flow before it costs a run.
// The whole browser-native path was live-mapped against online-booking
// v19.0.13 (2026-07-08). Every load-bearing selector/branch below appears
// verbatim in their JS bundles, so two cheap GETs tell us whether the mapped
// flow still exists. Markers missing → re-map with scripts/map-dom.ts.
// ────────────────────────────────────────────────────────────
const FOREUP_JS_VERSION_MAPPED = '19.0.13';
const FLOW_MARKERS = [
  'js-book-button', 'handleBook', 'PaymentSelectionView', 'loadPaymentWindow',
  'credit_card_window/', 'pending_reservation', 'reservation_confirmation_uid',
  'booking_fee_required', 'payment_method', 'dateFieldChange',
  'currentlyRefreshingTeetimes', 'payment_selection.html', 'booking-start-time-label',
  // Hold path (bridge + tile fallback): the modern tile view binds
  // click→viewTimeRow, viewTime routes to viewTimeDeprecated for courses
  // without the new checkout feature, and its 16-field createPending POSTs the
  // hold into BookingTimeModalView. If any of these vanish, the hold flow has
  // changed — a systems-check alarm, not a race-night surprise.
  'viewTimeRow', 'createPending', 'time-tile', 'viewTimeDeprecated', 'BookingTimeModalView',
];

async function foreupPreflight(): Promise<void> {
  try {
    const { text: html } = await fetchTextWithTimeout(bookingUrl(cfg.courses[0]), { headers: { 'User-Agent': CHROME_UA } }, 5000);
    const ver = html.match(/online-booking\.min\.js\?v=([\w.]+)/)?.[1] ?? 'unknown';
    const [ob, tpl] = await Promise.all([
      fetchTextWithTimeout(`${FOREUP}/js/dist/online-booking.min.js?v=${ver}`, { headers: { 'User-Agent': CHROME_UA } }, 5000).then((r) => r.text),
      fetchTextWithTimeout(`${FOREUP}/js/dist/online-booking-templates.min.js?v=${ver}`, { headers: { 'User-Agent': CHROME_UA } }, 5000).then((r) => r.text),
    ]);
    const all = ob + tpl;
    const missing = FLOW_MARKERS.filter((m) => !all.includes(m));
    tev('preflight', { ver, missing });
    if (missing.length) {
      log('✗', `ForeUp preflight: flow markers MISSING (${missing.join(', ')}) — their booking flow changed. Re-map with scripts/map-dom.ts before trusting a real run.`);
    } else if (ver !== FOREUP_JS_VERSION_MAPPED) {
      log('⚠', `ForeUp preflight: their JS updated (v${ver}; mapped on v${FOREUP_JS_VERSION_MAPPED}) but all ${FLOW_MARKERS.length} flow markers are still present.`);
    } else {
      log('✓', `ForeUp preflight: v${ver}, all ${FLOW_MARKERS.length} flow markers present`);
    }
  } catch (e) {
    log('⚠', `ForeUp preflight skipped (${(e as Error).message}) — not fatal, but unverified.`);
  }
}

// ────────────────────────────────────────────────────────────
// Slot selection — course priority, then configured time order in-window.
// ────────────────────────────────────────────────────────────
interface Candidate { t: ApiTime; course: CourseCfg; min: number; inWindow: boolean; players: number; }

function rankCandidates(
  times: ApiTime[], course: CourseCfg, minPlayers = cfg.players, preferredPlayers = cfg.players,
): Candidate[] {
  const parsed = times
    .map((t) => {
      const hhmm = t.time.split(' ')[1] ?? '';
      const [hh, mm] = hhmm.split(':').map(Number);
      if (isNaN(hh) || isNaN(mm)) return null;
      const available = Math.min(4, Number(t.available_spots ?? 0));
      if (available < minPlayers) return null;
      return { t, course, min: hh * 60 + mm, inWindow: false, players: Math.min(preferredPlayers, available) };
    })
    .filter((x): x is Candidate => x !== null);
  const inWin = parsed
    .filter((c) => c.min >= cfg.windowStart && c.min <= cfg.windowEnd)
    .map((c) => ({ ...c, inWindow: true }))
    .sort((a, b) => cfg.slotOrder === 'latest' ? b.min - a.min : a.min - b.min);
  if (inWin.length) return inWin;
  // Fallback: closest slot after the window, but never past fallbackUntil.
  // Pre-window dawn slots are never taken.
  return parsed
    .filter((c) => c.min > cfg.windowEnd && c.min <= cfg.fallbackUntil)
    .sort((a, b) => a.min - b.min);
}

/** Configured course priority is authoritative, then window/time order. */
function cmpCandidate(a: Candidate, b: Candidate): number {
  const ai = cfg.courses.findIndex((c) => c.key === a.course.key);
  const bi = cfg.courses.findIndex((c) => c.key === b.course.key);
  const ap = ai < 0 ? Number.MAX_SAFE_INTEGER : ai;
  const bp = bi < 0 ? Number.MAX_SAFE_INTEGER : bi;
  if (ap !== bp) return ap - bp;
  if (a.inWindow !== b.inWindow) return a.inWindow ? -1 : 1;
  if (!a.inWindow) return a.min - b.min; // generic fallback remains closest-after-window
  return cfg.slotOrder === 'latest' ? b.min - a.min : a.min - b.min;
}

// ────────────────────────────────────────────────────────────
// SPEC hold — predict the target sheet before it exists.
// The 16 fields createPending _.picks (read from online-booking v19.0.13):
// time, holes, players, carts, schedule_id, teesheet_side_id, course_id,
// booking_class_id, duration, foreup_discount, foreup_trade_discount_rate,
// trade_min_players, cart_fee, cart_fee_tax, green_fee, green_fee_tax.
// Everything is knowable pre-drop: IDs are per-course constants, the slot
// grid repeats daily, and sides/fees come from any published date on the
// same teesheet. (Mirrored in tests.ts — keep in sync.)
// ────────────────────────────────────────────────────────────

/** "07-14-2026" → "2026-07-14" (the ApiTime.time date part). */
function isoDate(mdY: string): string {
  const [m, d, y] = mdY.split('-');
  return `${y}-${m}-${d}`;
}

function isWeekendDate(mdY: string): boolean {
  const [m, d, y] = mdY.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return dow === 0 || dow === 6;
}

/** Scout-date preference order for a target: the other published dates
 *  (today..today+6 are always live regardless of the 7pm cutoff), same
 *  day-type first — weekend and weekday fee columns differ — then closest
 *  to the target. Pure ("today" injected) for tests. */
function specScoutDates(targetMdY: string, todayMdY: string): string[] {
  const [tm, td, ty] = todayMdY.split('-').map(Number);
  const out: string[] = [];
  // today+7 is live after the 7pm drop — pollTimes just returns null before.
  for (let i = 0; i <= 7; i++) {
    const d = new Date(ty, tm - 1, td + i);
    const s = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${d.getFullYear()}`;
    if (s !== targetMdY) out.push(s);
  }
  const tgtWknd = isWeekendDate(targetMdY);
  const dayNum = (s: string) => { const [m, d, y] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const tgtN = dayNum(targetMdY);
  return out.sort((a, b) => {
    const aw = isWeekendDate(a) === tgtWknd ? 0 : 1, bw = isWeekendDate(b) === tgtWknd ? 0 : 1;
    if (aw !== bw) return aw - bw;
    return Math.abs(dayNum(a) - tgtN) - Math.abs(dayNum(b) - tgtN);
  });
}

/** Merge scouted sheets into one per-time-of-day template. First scout that
 *  has a time-of-day wins — pass scouts in preference order. Availability on
 *  the scout date is irrelevant; only the createPending fields matter. */
function mergeSpecTemplate(scoutsInPreferenceOrder: ApiTime[][]): Map<string, ApiTime> {
  const tpl = new Map<string, ApiTime>();
  for (const times of scoutsInPreferenceOrder) {
    for (const t of times ?? []) {
      const hhmm = t.time.split(' ')[1];
      if (hhmm && !tpl.has(hhmm)) tpl.set(hhmm, t);
    }
  }
  return tpl;
}

/** Published mornings are sold out, but a same-day-type full-rate afternoon
 *  slot carries the same 16 createPending fields. Bethpage's observed grid is
 *  a 9-minute lattice. Infer only backwards from an anchor at/before 4:00pm;
 *  later anchors may be twilight-priced and are unsafe for a morning hold. */
function inferSpecWindowFromFullRateAnchor(times: ApiTime[], windowStart: number, windowEnd: number): ApiTime[] {
  const parsed = times.map((t) => {
    const hhmm = t.time.split(' ')[1] ?? '';
    const [hh, mm] = hhmm.split(':').map(Number);
    return { t, min: hh * 60 + mm };
  }).filter((x) => Number.isFinite(x.min));
  // A partially sold morning (for example only 06:39 remains) is still a
  // valid full-rate lattice anchor; fill its missing neighbors too. If the
  // morning is gone, use the earliest post-window full-rate slot by 4pm.
  const anchor = parsed.filter((x) => x.min >= windowStart && x.min <= windowEnd).sort((a, b) => a.min - b.min)[0]
    ?? parsed.filter((x) => x.min > windowEnd && x.min <= 16 * 60).sort((a, b) => a.min - b.min)[0];
  if (!anchor) return times;
  const datePart = anchor.t.time.split(' ')[0];
  const seen = new Set(parsed.map((x) => x.min));
  const inferred: ApiTime[] = [];
  for (let min = windowStart; min <= windowEnd; min++) {
    if ((anchor.min - min) % 9 !== 0 || seen.has(min)) continue;
    const hh = Math.floor(min / 60), mm = min % 60;
    inferred.push({ ...anchor.t, time: `${datePart} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, spec_inferred: true });
  }
  return [...inferred, ...times];
}

/** Predict the target date's sheet: template slots with the date swapped in.
 *  available_spots becomes the hold's `players` (viewTime copies it), and the
 *  server rejects players > actual spots ("Time not available" — live-proven
 *  on a 1-spot leftover). So ask for exactly what we need: right on any slot
 *  with room for us, harmlessly rejected on any slot without. */
function specPredictTimes(tpl: Map<string, ApiTime>, targetMdY: string, players: number): ApiTime[] {
  const iso = isoDate(targetMdY);
  return [...tpl.entries()].map(([hhmm, t]) => ({ ...t, time: `${iso} ${hhmm}`, available_spots: players }));
}

function fmtTime(apiTime: string): string {
  const hhmm = apiTime.split(' ')[1] ?? '';
  const [hh, mm] = hhmm.split(':').map(Number);
  if (isNaN(hh) || isNaN(mm)) return apiTime;
  const h12 = hh > 12 ? hh - 12 : hh || 12;
  return `${h12}:${String(mm).padStart(2, '0')}${hh >= 12 ? 'pm' : 'am'}`;
}

// ────────────────────────────────────────────────────────────
// Detection
// ────────────────────────────────────────────────────────────
interface StopToken { stopped: boolean }

/**
 * Pipelined poll: keep up to `pollConcurrency` requests in flight, launching a
 * new one every `pollStaggerMs`. Resolves the instant ANY poll returns a
 * non-empty list — so detection latency is ~one RTT past the drop, not
 * (RTT + pollInterval). Concurrency is capped low (default 6 per course):
 * this is a fast client, not a flood.
 */
function racePoll(api: ForeupClient, date: string, course: CourseCfg, stop: StopToken, maxPolls = 600): Promise<ApiTime[] | null> {
  return new Promise((resolve) => {
    let done = false;
    let inflight = 0;
    let launched = 0;
    const finish = (v: ApiTime[] | null) => { if (!done) { done = true; clearInterval(timer); resolve(v); } };
    const timer = setInterval(() => {
      if (done) return;
      if (stop.stopped) { finish(null); return; }
      if (launched >= maxPolls) { if (inflight === 0) finish(null); return; }
      if (inflight >= cfg.pollConcurrency) return;
      launched++; inflight++;
      const sent = Date.now();
      api.pollTimes(date, course)
        .then((r) => {
          inflight--;
          const hit = !!(r && r.length);
          if (!done) tev('poll', { course: course.key, rtt: Date.now() - sent, hit });
          if (hit) finish(r);
        })
        .catch(() => { inflight--; });
    }, cfg.pollStaggerMs);
  });
}

/**
 * Median detection latency after the ForeUp server release. Legacy telemetry
 * used poll-start as T=0 and cannot be mixed with release-relative timing.
 */
function historicalDetectStats(): { n: number; medianMs: number } | null {
  try {
    const vals: number[] = [];
    for (const line of fs.readFileSync(TELEMETRY_PATH, 'utf-8').split('\n')) {
      if (!line) continue;
      try {
        const run = JSON.parse(line);
        if (run.timingBasis !== 'server_release') continue;
        const det = run.events?.find((e: any) => e.name === 'detected' && typeof e.ms === 'number');
        if (det && det.ms >= 150 && det.ms <= 10_000) vals.push(det.ms);
      } catch {}
    }
    if (!vals.length) return null;
    vals.sort((a, b) => a - b);
    return { n: vals.length, medianMs: vals[Math.floor(vals.length / 2)] };
  } catch { return null; }
}

// ────────────────────────────────────────────────────────────
// Browser bootstrap — login once, then pre-stage one ISOLATED CONTEXT per
// course. ForeUp stores a single pending ID in localStorage and deletes the
// previous one before storing a new hold; two pages in one context can thus
// delete each other's Red/Green holds. Cloned authenticated contexts share
// the account cookies but keep each course's pending ledger independent.
// ────────────────────────────────────────────────────────────
/** Read the page's filter model — the authoritative staging state. */
async function readFilters(page: Page): Promise<{ date: string; players: number; holes: string } | null> {
  return page.evaluate(() => {
    const f = (window as any).App?.data?.filters;
    return f ? { date: String(f.get('date') ?? ''), players: Number(f.get('players') ?? 0), holes: String(f.get('holes') ?? '') } : null;
  }).catch(() => null);
}

/** Fire ForeUp's own date-change handler (→ setDate → refreshTimes). This is
 *  the page's refresh lever; it is silently DROPPED while a refresh is in
 *  flight (currentlyRefreshingTeetimes guard in their JS), hence the retry
 *  loops around it. Enter keypresses are useless here — the bootstrap
 *  datepicker popup eats them and can clobber the typed date. */
async function fireDateChange(page: Page): Promise<void> {
  await page.evaluate(() => { (window as any).$?.('#date-field')?.trigger?.('change'); }).catch(() => {});
}

async function stagePage(page: Page, course: CourseCfg, date: string, players = cfg.players): Promise<void> {
  await page.goto(bookingUrl(course), { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await sleep(1500);
  const golfer = page.getByRole('button', { name: course.golferBtn });
  if (await golfer.isVisible({ timeout: 3000 }).catch(() => false)) { await golfer.click(); await sleep(800); }
  await page.locator('#schedule_select').waitFor({ state: 'visible', timeout: 15_000 });
  // Players filter chip: matches how a human books and keeps only tiles with
  // enough spots visible. (The modal players button is still clicked later —
  // the filter alone does NOT reliably set the reservation model.)
  if (players >= 1 && players <= 4) {
    await page.locator(`a.btn:text-is("${players}")`).first().click().catch(() => {});
    await sleep(400);
  }
  // Holes chip: the page defaults to "Both" → filters.holes='all', and
  // viewTime copies filters.holes into the hold POST, which the server
  // REJECTS as "Invalid request" (found 2026-07-12 — a hold needs concrete
  // holes). Players chips only go to 4, so :text-is("18") is unambiguous.
  const wantHoles = String(cfg.holes);
  if (cfg.holes === 9 || cfg.holes === 18) {
    await page.locator(`a.btn:text-is("${wantHoles}")`).first().click().catch(() => {});
    await sleep(400);
  }
  // Date: every filter action fires a refresh, and ForeUp DROPS date changes
  // while one is in flight — so set, verify against the model, retry.
  const holesOk = (f: { holes: string } | null) => cfg.holes !== 9 && cfg.holes !== 18 ? true : f?.holes === wantHoles;
  let staged = false;
  for (let i = 0; i < 6 && !staged; i++) {
    await page.locator('#date-field').fill(date);
    await fireDateChange(page);
    await sleep(700);
    const f = await readFilters(page);
    staged = f?.date === date && (players < 1 || players > 4 || f?.players === players) && holesOk(f);
    if (!staged && f && f.players !== players && players >= 1 && players <= 4) {
      await page.locator(`a.btn:text-is("${players}")`).first().click().catch(() => {});
      await sleep(400);
    }
    if (!staged && !holesOk(await readFilters(page))) {
      await page.locator(`a.btn:text-is("${wantHoles}")`).first().click().catch(() => {});
      await sleep(400);
    }
  }
  const f = await readFilters(page);
  if (!staged) throw new Error(`Failed to stage ${course.name}: filters=${JSON.stringify(f)}, wanted date=${date} players=${players} holes=${wantHoles}`);
  log('✓', `Staged ${course.name}: date=${f?.date} players=${f?.players} holes=${f?.holes}`);
  await bridgePreflight(page, course);
}

// Runs in the page (flat arrow — see bridgeEval). Read-only reachability +
// flow-shape probe for the bridge hold; costs nothing server-side.
const bridgePreflightEval = () => {
  const w = window as any;
  const out = { reachable: false, release: false, checkout: false, captcha: false, bagBusy: false, err: '' };
  try {
    const tiles = w.App && w.App.page && w.App.page.currentView && w.App.page.currentView.content && w.App.page.currentView.content.currentView;
    const TileClass = tiles && (typeof tiles.getItemView === 'function' ? tiles.getItemView() : (tiles.itemView || tiles.childView));
    const proto = TileClass && TileClass.prototype;
    out.reachable = !!(proto && typeof proto.viewTime === 'function' && typeof proto.viewTimeDeprecated === 'function' && typeof proto.createPending === 'function');
    out.release = typeof w.Utils?.OnlineBooking?.Reservation?.deletePending === 'function';
    // If ForeUp flips the customer-checkout feature ON, viewTime routes to a
    // Vue flow instead of the Backbone modal our money gates verify.
    out.checkout = !!(w.App.data && w.App.data.course && w.App.data.course.hasFeature && w.App.data.course.hasFeature('2024-05-phoenix-PHX-396-online-booking-customer-checkout'));
    // viewTimeRow (the human click) would demand a captcha if this activates;
    // the bridge calls viewTime below that check, but a flow this different
    // deserves a loud pre-race warning either way.
    out.captcha = !!(w.Feature && w.Feature.isActive && w.Feature.isActive('2024-10-phoenix-PHX-557-force-recaptcha-on-tile-click'));
    const bag = w.onlineBookingVueFactory && w.onlineBookingVueFactory.dataStore && w.onlineBookingVueFactory.dataStore.getters;
    out.bagBusy = !!(bag && bag['bag/getNumTeeTimesInBag'] > 0);
  } catch (e) { out.err = String(e); }
  return out;
};

/** Systems-check-time alarm for the bridge path: verifies the modern tile
 *  view class is reachable and the flow flags still point at the Backbone
 *  modal. A failure here does not stop the run — the tile fallback still
 *  works — but it must never be a race-night surprise. */
async function bridgePreflight(page: Page, course: CourseCfg): Promise<void> {
  if (BRIDGE_OFF) return;
  const p = await page.evaluate(bridgePreflightEval)
    .catch((e) => ({ reachable: false, release: false, checkout: false, captcha: false, bagBusy: false, err: String(e) }));
  tev('bridge_preflight', { course: course.key, ...p });
  if (p.reachable && p.release && !p.checkout && !p.captcha && !p.bagBusy) {
    log('✓', `Bridge ready on ${course.name}: modern tile view + exact release helper reachable, Backbone modal flow confirmed`);
    return;
  }
  if (!p.reachable) log('⚠', `Bridge preflight ${course.name}: tile view class NOT reachable (${p.err || 'view tree changed'}) — holds will use the slower tile click`);
  if (!p.release) log('⚠', `Bridge preflight ${course.name}: exact pending-reservation release helper is unavailable — loser cleanup has no native fallback`);
  if (p.checkout) log('⚠', `Bridge preflight ${course.name}: ForeUp enabled the NEW checkout flow — modal gates need re-mapping before trusting a real run`);
  if (p.captcha) log('⚠', `Bridge preflight ${course.name}: ForeUp enabled captcha-on-click — expect human intervention, do not rely on auto-book`);
  if (p.bagBusy) log('⚠', `Bridge preflight ${course.name}: a tee time is already in the account's bag — viewTime will refuse; empty the bag first`);
}

async function bootstrap(date: string): Promise<{ context: BrowserContext; pages: Map<string, Page>; userId: number }> {
  const browser = await chromium.launch({ headless: !!process.env.HEADLESS, args: ['--disable-blink-features=AutomationControlled'] });
  const hasSession = fs.existsSync(SESSION_PATH);
  const context = hasSession
    ? await browser.newContext({ storageState: JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8')), userAgent: CHROME_UA })
    : await browser.newContext({ userAgent: CHROME_UA });
  const page = await context.newPage();
  // networkidle never fires here (foreUP keeps a long-poll open); the explicit
  // login-field / #schedule_select waits below are the real readiness gates.
  await page.goto(bookingUrl(cfg.courses[0]), { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await sleep(2000);

  const loginIfNeeded = async (): Promise<boolean> => {
    const emailField = page.getByPlaceholder('Email');
    if (!(await emailField.isVisible({ timeout: 3000 }).catch(() => false))) return false;
    log('…', 'Logging in (session expired or first run)');
    await emailField.fill(cfg.foreupEmail);
    await page.getByPlaceholder('Password').fill(cfg.foreupPassword);
    await page.locator('#login').getByText('Log In', { exact: true }).click();
    await sleep(1500);
    return true;
  };

  // Login modal can appear at page load OR only after clicking a protected
  // booking class (that's how stale sessions fail) — handle both.
  await loginIfNeeded();
  for (let attempt = 0; attempt < 2; attempt++) {
    const golferBtn = page.getByRole('button', { name: cfg.courses[0].golferBtn });
    if (await golferBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await golferBtn.click();
      await sleep(800);
    }
    if (!(await loginIfNeeded())) break; // no login modal → class selection stuck
  }

  // Wait for the booking page to be fully ready (signals our session is hot)
  await page.locator('#schedule_select').waitFor({ state: 'visible', timeout: 15_000 });

  // Extract user_id from the page's global App.data.user
  const userId = await page.evaluate(() => {
    // @ts-ignore
    return window.App?.data?.user?.get?.('user_id') ?? 0;
  });
  log('✓', `Logged in (user_id=${userId})`);

  // Save session for next run and clone it into isolated course contexts.
  fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
  const authenticatedState = await context.storageState();
  fs.writeFileSync(SESSION_PATH, JSON.stringify(authenticatedState), { mode: 0o600 });

  // Pre-stage a page per course: right teesheet, target date, players filter.
  // SPEC and detected Red holds share Red's one actor/page; Green has its own
  // localStorage so a simultaneous callback cannot remove Red's pending ID.
  const pages = new Map<string, Page>();
  await stagePage(page, cfg.courses[0], date);
  pages.set(cfg.courses[0].key, page);
  for (const course of cfg.courses.slice(1)) {
    const isolated = await browser.newContext({ storageState: authenticatedState, userAgent: CHROME_UA });
    const p = await isolated.newPage();
    await stagePage(p, course, date);
    pages.set(course.key, p);
  }
  return { context, pages, userId };
}

// ────────────────────────────────────────────────────────────
// Browser-native booking — click the tile, walk ForeUp's own flow, stop one
// click short of the charge (or click it with --auto-book).
// ────────────────────────────────────────────────────────────
let debugShotTaken = false; // one forensic screenshot per run on tile_missing

type BookResult =
  | 'ready'           // card window filled/reached; human clicks PROCESS TRANSACTION
  | 'booked'          // auto-book submitted the payment
  | 'test_passed'     // --no-book: verified modal, closed at $0
  | 'tile_missing'    // tile never rendered → try next candidate
  | 'no_modal'        // tile clicked but no hold modal (someone beat us) → next candidate
  | 'abort_mismatch'  // a money gate failed; modal closed → next candidate
  | 'manual_needed';  // hold is live but automation stalled → human finishes in browser

const pendingHoldIds = new WeakMap<Page, string>();
const activeHoldPages = new Set<Page>();

/** Close whatever modal is up, releasing our pending reservation (ForeUp
 *  removes the pending on modal close). The exact reservation ID captured
 *  from the successful POST is verified against its DELETE; if the UI close
 *  misses, use ForeUp's own native deletePending(id) helper once. */
async function closeModal(page: Page): Promise<boolean> {
  const id = pendingHoldIds.get(page);
  const deleteResp = id
    ? page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes(`/pending_reservation/${id}`), { timeout: 2500 }).catch(() => null)
    : Promise.resolve(null);
  const close = page.locator('button.js-close-button');
  if (await close.isVisible({ timeout: 1000 }).catch(() => false)) { await close.click().catch(() => {}); }
  else await page.evaluate(() => { (window as any).$?.('#modal')?.modal?.('hide'); }).catch(() => {});
  let released = false;
  const observed = await deleteResp;
  if (observed) released = observed.ok() || observed.status() === 404;
  if (id && !released) {
    type DeleteResult = { ok: boolean; status: number; timedOut?: boolean };
    const nativeDelete: Promise<DeleteResult> = page.evaluate((reservationId) => new Promise<{ ok: boolean; status: number }>((resolve) => {
      const w = window as any;
      const del = w.Utils?.OnlineBooking?.Reservation?.deletePending;
      if (typeof del !== 'function') { resolve({ ok: false, status: 0 }); return; }
      const req = del(reservationId);
      req.done(() => resolve({ ok: true, status: 200 }));
      req.fail((xhr: any) => resolve({ ok: xhr?.status === 404, status: Number(xhr?.status ?? 0) }));
    }), id).catch(() => ({ ok: false, status: 0 }));
    const direct = await settleWithin<DeleteResult>(nativeDelete, 2500, { ok: false, status: 0, timedOut: true });
    released = direct.ok;
    tev('hold_release', { reservationId: id, via: 'native_delete', status: direct.status, released, timedOut: 'timedOut' in direct });
  } else if (id) {
    tev('hold_release', { reservationId: id, via: 'modal_close', status: observed?.status() ?? 0, released });
  }
  if (released && id) {
    pendingHoldIds.delete(page);
    activeHoldPages.delete(page);
    await page.evaluate(() => {
      localStorage.setItem('pending_reservation', 'null');
      (window as any).pending_reservation_obj?.remove_timers?.();
    }).catch(() => {});
  }
  await sleep(300);
  if (!released) log('⚠', `Pending reservation release could not be verified${id ? ` (id=${id})` : ' (reservation id unavailable)'}`);
  return released;
}

type HoldOutcome = 'held' | 'held_uncertain' | 'tile_missing' | 'no_modal' | 'bridge_error';

/** Attributes for the bridge model: the raw API slot (same endpoint that
 *  fills the page's own times collection) + the per-course IDs the hold POST
 *  requires. viewTime() sets players = available_spots itself; the modal
 *  machinery then clicks the real player count and verifies the model. */
function bridgeHoldAttrs(t: ApiTime, course: CourseCfg, holes: number): Record<string, unknown> {
  return { ...t, course_id: course.courseId, schedule_id: course.scheduleId, booking_class_id: course.bookingClassId, holes };
}

// Runs in the page (keep it a single flat arrow — esbuild's __name injection
// breaks NESTED functions inside page.evaluate under tsx). Extracts the
// MODERN tile view class from ForeUp's live Marionette tree and invokes its
// viewTime with a model built from our API detection — byte-identical
// server-side to a human tile click (16-field createPending), then
// BookingTimeModalView.show() and the code email, all ForeUp's own code.
// fromRouter=false mirrors a click.
const bridgeEval = (a: Record<string, unknown>) => {
  try {
    const w = window as any;
    const tiles = w.App && w.App.page && w.App.page.currentView && w.App.page.currentView.content && w.App.page.currentView.content.currentView;
    const TileClass = tiles && (typeof tiles.getItemView === 'function' ? tiles.getItemView() : (tiles.itemView || tiles.childView));
    const proto = TileClass && TileClass.prototype;
    if (!proto || typeof proto.viewTime !== 'function') return { ok: false, err: 'tile view class unreachable via App.page' };
    // The model class matters: the times-collection's model carries defaults
    // (carts:false, duration:1, …) that feed createPending's _.pick — a bare
    // Backbone.Model lacks them and the server rejects "Invalid request".
    const TimeModel = w.App.data && w.App.data.times && w.App.data.times.model;
    if (typeof TimeModel !== 'function') return { ok: false, err: 'times model class missing' };
    const fake = Object.create(proto);
    fake.$el = w.$();
    fake.model = new TimeModel(a);
    fake.viewTime(fake.model, false);
    return { ok: true, err: '' };
  } catch (e) { return { ok: false, err: String(e) }; }
};

/** PRIMARY hold: skip the DOM and run ForeUp's own modern tile handler on a
 *  model built straight from the API detection — no tile-render wait (2.2s+
 *  at real drops, where whole mornings die before the first render) and no
 *  isTeetimesRefreshing click-drop.
 *  'bridge_error' = ForeUp's view tree changed or the call threw → caller
 *  falls back to the tile click. A REJECTED hold returns 'no_modal': the slot
 *  is gone; re-trying it slower would just re-lose it. */
async function holdViaBridge(page: Page, course: CourseCfg, cand: Candidate, t0: number): Promise<'held' | 'held_uncertain' | 'no_modal' | 'bridge_error'> {
  const tLabel = fmtTime(cand.t.time);
  log('🎯', `${course.name}: bridge hold ${tLabel} — ForeUp viewTime() direct (T+${now() - t0}ms)`);
  let reqSent = false;
  const onReq = (r: { url(): string; method(): string }) => {
    if (r.url().includes('pending_reservation') && r.method() === 'POST') reqSent = true;
  };
  page.on('request', onReq);
  const holdResp = page.waitForResponse((r) => r.url().includes('pending_reservation') && r.request().method() === 'POST', { timeout: 8000 }).catch(() => null);
  const bridge = await page.evaluate(bridgeEval, bridgeHoldAttrs(cand.t, course, cfg.holes))
    .catch((e) => ({ ok: false, err: String(e) }));
  // viewTime's $.ajax starts immediately. Give its request event a short,
  // bounded window; if it was sent, always wait for the response so a slow
  // success can never be mistaken for a safe retry.
  const requestDeadline = Date.now() + 750;
  while (!reqSent && Date.now() < requestDeadline) await sleep(25);
  page.off('request', onReq);
  if (!reqSent) {
    holdResp.catch(() => {});
    const why = bridge.ok ? 'viewTime fired no pending-reservation request' : bridge.err;
    log('⚠', `${course.name} ${tLabel}: bridge hold failed to run (${why})`);
    tev('bridge_hold', { course: course.key, time: cand.t.time, result: 'bridge_error', err: why, tPlusMs: now() - t0 });
    return 'bridge_error';
  }
  // The modern createPending $.ajax is async — the Playwright response watcher
  // is the source of truth. No POST within the window = viewTime declined
  // (available_spots=0, bag not empty) or ForeUp rewired the handler — either
  // way the tile path is the safety net.
  const resp = await holdResp;
  if (!resp) {
    log('⚠', `${course.name} ${tLabel}: hold POST was sent but its response is unknown — NOT trying another slot`);
    tev('bridge_hold', { course: course.key, time: cand.t.time, result: 'response_unknown', tPlusMs: now() - t0 });
    return 'held_uncertain';
  }
  let lost = false, body = '', reservationId = '';
  try {
    body = await resp.text();
    const j = JSON.parse(body);
    reservationId = String(j?.reservation_id ?? '');
    lost = !(j?.success && reservationId);
  } catch {
    if (resp.ok()) {
      log('⚠', `${course.name} ${tLabel}: hold response was successful but its reservation id is unreadable — NOT retrying`);
      tev('bridge_hold', { course: course.key, time: cand.t.time, result: 'response_unreadable', tPlusMs: now() - t0 });
      return 'held_uncertain';
    }
    lost = true;
  }
  if (lost) {
    const sent = resp.request().postData() ?? '';
    log('✗', `${course.name} ${tLabel}: hold rejected in ${now() - t0}ms (${body.slice(0, 100) || resp.status()}) — trying next candidate`);
    tev('bridge_hold', { course: course.key, time: cand.t.time, result: 'hold_rejected', sent: sent.slice(0, 300), tPlusMs: now() - t0 });
    return 'no_modal';
  }
  pendingHoldIds.set(page, reservationId);
  activeHoldPages.add(page);
  tev('bridge_hold', { course: course.key, time: cand.t.time, result: 'held', tPlusMs: now() - t0 });
  return 'held';
}

/** FALLBACK hold: wait for the tile to render and click it. Only reached
 *  when the bridge path can't run (ForeUp's view tree changed). */
async function holdViaTile(page: Page, course: CourseCfg, cand: Candidate, date: string, t0: number): Promise<HoldOutcome> {
  const tLabel = fmtTime(cand.t.time); // e.g. "6:30am" — matches the tile label exactly

  // 1. Refresh the staged tee sheet until the just-dropped tile renders.
  const tile = page.locator(`div.time-tile:has(div.booking-start-time-label:text-is("${tLabel}"))`).first();
  let visible = await tile.isVisible().catch(() => false);
  for (let i = 0; i < 3 && !visible; i++) {
    await fireDateChange(page);
    visible = await tile.waitFor({ state: 'visible', timeout: 2500 }).then(() => true).catch(() => false);
  }
  if (!visible) {
    // The staging can be lost (ForeUp drops date changes mid-refresh) — check
    // the model and re-stage once before writing the candidate off.
    const f = await readFilters(page);
    if (f && f.date !== date) {
      log('⚠', `${course.name}: page drifted to date=${f.date} — re-staging`);
      await stagePage(page, course, date).catch(() => {});
      await fireDateChange(page);
      visible = await tile.waitFor({ state: 'visible', timeout: 2500 }).then(() => true).catch(() => false);
    }
  }
  if (!visible) {
    log('✗', `${course.name} ${tLabel}: tile never rendered — trying next candidate`);
    tev('tile_click', { course: course.key, time: cand.t.time, result: 'tile_missing' });
    if (!debugShotTaken) {
      debugShotTaken = true;
      const shot = path.join(__dirname, '..', 'logs', `debug-tile-missing-${Date.now()}.png`);
      await page.screenshot({ path: shot }).catch(() => {});
      log('ℹ', `Debug screenshot: ${shot}`);
    }
    return 'tile_missing';
  }

  // 2. THE HOLD: click the tile. This also auto-sends the code email, so the
  //    IMAP baseline must be reset first. The click fires ForeUp's
  //    pending_reservation POST — reading that response tells us in ~1 RTT
  //    whether we won the hold, instead of waiting 6s for a modal that will
  //    never come on a contested slot.
  log('🎯', `${course.name}: clicking ${tLabel} tile (T+${now() - t0}ms)`);
  // Some tiles are phantoms: rendered AND reported by the API, but the click
  // silently no-ops (no POST at all — live-observed, repeatedly, on the same
  // slot). Watch the REQUEST: none within 2.5s → swallowed, move on fast.
  // If the request did go out, wait the full window for its response —
  // abandoning an in-flight hold would leave a pending reservation that
  // blocks the next candidate.
  let reqSent = false;
  const onReq = (r: { url(): string; method(): string }) => {
    if (r.url().includes('pending_reservation') && r.method() === 'POST') reqSent = true;
  };
  page.on('request', onReq);
  const holdResp = page.waitForResponse((r) => r.url().includes('pending_reservation') && r.request().method() === 'POST', { timeout: 8000 }).catch(() => null);
  // ForeUp's modern tile handler (viewTimeRow) STARTS with
  // `if (isTeetimesRefreshing()) return;` — a click while the sheet is
  // mid-refresh is silently dropped (fires no POST). This is transient, NOT a
  // dead tile: once the refresh settles, a re-click fires the hold (proven via
  // scripts/diag-synth-attrs.ts, where the 2nd click captured the full POST).
  // So wait for the refresh flag to clear, re-locate the tile (a refresh
  // detaches the old node), click, and retry a bounded number of times.
  for (let attempt = 0; attempt < 4 && !reqSent; attempt++) {
    await page.waitForFunction(() => {
      const c = (window as any).App?.data?.times;
      return !(c && c.isRefreshingTeetimes);
    }, undefined, { timeout: 1500 }).catch(() => {});
    const fresh = page.locator(`div.time-tile:has(div.booking-start-time-label:text-is("${tLabel}"))`).first();
    if (!(await fresh.isVisible().catch(() => false))) { await sleep(250); continue; }
    await fresh.click().catch(() => {});
    const clickAt = Date.now();
    while (!reqSent && Date.now() - clickAt < 1500) await sleep(75);
  }
  page.off('request', onReq);
  if (!reqSent) {
    holdResp.catch(() => {});
    log('✗', `${course.name} ${tLabel}: click swallowed after retries (tile truly gone) — trying next candidate`);
    tev('tile_click', { course: course.key, time: cand.t.time, result: 'click_swallowed', tPlusMs: now() - t0 });
    return 'no_modal';
  }
  const resp = await holdResp;
  if (!resp) {
    log('⚠', `${course.name} ${tLabel}: tile hold POST was sent but its response is unknown — NOT trying another slot`);
    tev('tile_click', { course: course.key, time: cand.t.time, result: 'response_unknown', tPlusMs: now() - t0 });
    return 'held_uncertain';
  }
  let lost = false, body = '', reservationId = '';
  try {
    body = await resp.text();
    const j = JSON.parse(body);
    reservationId = String(j?.reservation_id ?? '');
    lost = !(j?.success && reservationId);
  } catch {
    if (resp.ok()) {
      log('⚠', `${course.name} ${tLabel}: tile hold response id is unreadable — NOT retrying`);
      tev('tile_click', { course: course.key, time: cand.t.time, result: 'response_unreadable', tPlusMs: now() - t0 });
      return 'held_uncertain';
    }
    lost = true;
  }
  if (lost) {
    log('✗', `${course.name} ${tLabel}: hold rejected in ${now() - t0}ms (${body.slice(0, 100) || resp.status()}) — trying next candidate`);
    tev('tile_click', { course: course.key, time: cand.t.time, result: 'hold_rejected', tPlusMs: now() - t0 });
    return 'no_modal';
  }
  pendingHoldIds.set(page, reservationId);
  activeHoldPages.add(page);
  tev('tile_click', { course: course.key, time: cand.t.time, result: 'held', tPlusMs: now() - t0 });
  return 'held';
}

/** Phase 1 — get a CONFIRMED hold: bridge first, tile-click if ForeUp's
 *  view tree changed, then the modal check ('held' means the booking modal is
 *  up and the ~5min timer is running). No IMAP in here: the baseline is reset
 *  once pre-drop and after aborted holds — this path must stay hot. */
async function holdPhase(page: Page, course: CourseCfg, cand: Candidate, date: string, t0: number, bridgeOnly = false): Promise<HoldOutcome> {
  const tLabel = fmtTime(cand.t.time);
  page.bringToFront().catch(() => {}); // focus isn't needed for evaluate/locators — don't spend a round-trip on it

  let held: HoldOutcome = BRIDGE_OFF ? 'bridge_error' : await holdViaBridge(page, course, cand, t0);
  if (held === 'bridge_error' && !bridgeOnly) {
    if (!BRIDGE_OFF) log('⚠', `${course.name}: falling back to tile click`);
    held = await holdViaTile(page, course, cand, date, t0);
  }
  if (held !== 'held') return held;

  // The modal is the ground truth for both paths: no modal, no live hold.
  const modalUp = await page.locator('button.js-book-button').waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false);
  if (!modalUp) {
    log('⚠', `${course.name} ${tLabel}: hold POST succeeded but its modal did not render — pending state is uncertain; NOT trying another slot`);
    tev('hold_uncertain', { course: course.key, time: cand.t.time, result: 'no_modal_after_success' });
    return 'held_uncertain';
  }
  log('✓', `HELD ${course.name} ${tLabel}${cand.inWindow ? '' : ' (FALLBACK slot)'} reservation (browser modal, ~5min timer)`);
  return 'held';
}

/** Phase 2 — everything after a confirmed hold: money gates, code, payment.
 *  MUST only ever run on one hold at a time (single account, single charge). */
async function completeBooking(
  page: Page, course: CourseCfg, cand: Candidate, email: EmailMonitor, date: string, t0: number,
): Promise<BookResult> {
  const tLabel = fmtTime(cand.t.time);
  const bookBtn = page.locator('button.js-book-button');

  // 3. Money gate #1 — the modal must show EXACTLY what we asked for.
  const expDate = humanDate(date);
  const mismatch = await inspectModalIdentity(page, course, cand, date);
  if (mismatch) {
    reportModalIdentityMismatch(mismatch);
    return await closeModal(page) ? 'abort_mismatch' : 'manual_needed';
  }

  // 4. Money gate #2 — click the players button INSIDE the modal. The
  //    filter-inherited highlight can show "4" while the model holds 1
  //    (live-observed: fee window said $5 instead of $20).
  const pBtn = page.locator(`.js-booking-players .js-booking-field-buttons a:text-is("${cand.players}")`).first();
  if (!(await pBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
    log('✗', `MISMATCH: no "${cand.players}" players button in the modal. ABORTING this hold.`);
    tev('abort', { gate: 'players_button' });
    return await closeModal(page) ? 'abort_mismatch' : 'manual_needed';
  }
  await pBtn.click();
  await sleep(300);
  log('✓', `Verified: modal shows ${course.name} · ${expDate} · ${tLabel}; players set to ${cand.players} in-modal`);
  tev('modal_verified', { course: course.key, time: cand.t.time, players: cand.players });

  if (ABORT_BEFORE_BOOK) {
    log('🏁', 'NO-BOOK MODE: tile clicked + modal verified for real. Closing modal — hold released, $0 charged.');
    tev('outcome_detail', { result: 'no_book_abort' });
    return await closeModal(page) ? 'test_passed' : 'manual_needed';
  }

  // 5. The emailed code (Bethpage schedules). Sent automatically on tile click.
  if (course.emailCode) {
    // Red/Green can both hold briefly, generating two auto-emails. Once the
    // loser DELETE is verified, reset the mailbox baseline and request one
    // fresh winner code. EmailMonitor additionally requires this date+time
    // and scans newest-first; course is not present in ForeUp's email body.
    const baselineReady = await email.resetBaseline().then(() => true).catch(() => false);
    const resend = page.locator('button.js-reservation-confirmation-resend-button');
    const resent = baselineReady && await resend.click().then(() => true).catch(() => false);
    if (!resent) {
      log('✗', 'Could not establish a fresh winner-only email baseline/resend — finish by hand in the browser.');
      return 'manual_needed';
    }
    log('…', 'Waiting for the fresh winner booking code via IMAP (matched by date + time)…');
    const code = await email.waitForBookingCode(70_000, {
      dateMdY: date,
      time24: cand.t.time.split(' ')[1] ?? '',
    }).catch(() => null);
    if (!code) {
      log('✗', 'No matching fresh code via IMAP — finish by hand: read the code from your email and type it in the browser.');
      tev('code_timeout', {});
      return 'manual_needed';
    }
    log('✓', `Code via IMAP: ***${code.slice(-2)}`);
    tev('code_received', {});
    const codeInput = page.locator('#reservation_confirmation_uid');
    await codeInput.fill(code);
    // ForeUp's Backbone model only picks the code up from a change event —
    // fill() alone leaves the model empty (live-verified validation error).
    await codeInput.dispatchEvent('change');
    log('✓', 'Code entered in browser');
  }

  // 6. First "Book Time" — $0 with a booking fee: it opens Payment Method.
  //    (For no-fee schedules like Crab Meadow this click BOOKS — stop first.)
  if (!course.emailCode) {
    // Crab Meadow path: no fee window mapped; js-book-button is the final act.
    if (AUTO_BOOK) {
      await bookBtn.click();
      log('✓', `AUTO-BOOKED ${course.name} ${tLabel} (no-fee schedule) — check the confirmation email`);
      tev('outcome_detail', { result: 'booked_nofee' });
      return 'booked';
    }
    log('🟢', 'READY — ONE CLICK LEFT: click "Book Time" in the browser to finish (no online fee on this schedule).');
    tev('ready', { stage: 'book_button_nofee' });
    return 'ready';
  }

  let onPayment = false;
  for (let attempt = 0; attempt < 2 && !onPayment; attempt++) {
    await bookBtn.click().catch(() => {});
    onPayment = await page.locator('#payment_selection').waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
    if (!onPayment) {
      // Most likely the code didn't commit — refire change and retry once.
      await page.locator('#reservation_confirmation_uid').dispatchEvent('change').catch(() => {});
    }
  }
  if (!onPayment) {
    log('✗', 'Never reached the Payment Method screen — finish by hand in the browser (code, Book Time, Pay at Facility).');
    return 'manual_needed';
  }

  // 7. Money gate #3 — the Backbone model is what ForeUp actually books from.
  const model = await page.evaluate(() => {
    const m = (window as any).App?.data?.last_reservation;
    return m ? { players: m.get('players'), schedule: m.get('schedule_id'), time: m.get('time') } : null;
  }).catch(() => null);
  const hhmm = cand.t.time.split(' ')[1] ?? '';
  if (!model || Number(model.players) !== cand.players || Number(model.schedule) !== course.scheduleId || !String(model.time).includes(hhmm)) {
    log('✗', `MISMATCH: reservation model is ${JSON.stringify(model)}, expected players=${cand.players} schedule=${course.scheduleId} time~${hhmm}. ABORTING this hold.`);
    tev('abort', { gate: 'model', model });
    return await closeModal(page) ? 'abort_mismatch' : 'manual_needed';
  }
  log('✓', `Verified: model players=${model.players} schedule=${model.schedule} time=${model.time}`);

  // 8. Money gate #4 — "Pay at Facility" must be the checked method. If NO
  //    radio were checked, continue would fall through to a direct booking.
  const radio = page.locator('#payment_selection input[name="payment_method"][value="course"]');
  if (!(await radio.isChecked().catch(() => false))) {
    await radio.check({ force: true }).catch(() => {});
  }
  if (!(await radio.isChecked().catch(() => false))) {
    log('✗', 'MISMATCH: could not confirm "Pay at Facility" selection. ABORTING this hold.');
    tev('abort', { gate: 'payment_radio' });
    return await closeModal(page) ? 'abort_mismatch' : 'manual_needed';
  }

  // 9. Continue → Element card window (still $0 — it only renders the form).
  await page.locator('#payment_selection button.continue').click();
  const frame: FrameLocator = page.frameLocator('#element_iframe');
  const cardNum = frame.locator('#cardNumber');
  const cardUp = await cardNum.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false);
  if (!cardUp) {
    log('✗', 'Card window never loaded — finish by hand in the browser.');
    return 'manual_needed';
  }
  log('✓', 'Payment screen loaded (Element card window)');
  tev('payment_screen', {});

  // 10. Money gate #5 — the amount must be exactly $5 × players.
  const amount = ((await frame.locator('#lblTotalValue').innerText().catch(() => '')) || '').trim();
  const expected = `$${(FEE_PER_PLAYER * cand.players).toFixed(2)}`;
  if (amount !== expected) {
    log('✗', `MISMATCH: card window shows ${amount || '(unreadable)'}, expected ${expected}. NOT touching the card form — inspect the browser before doing anything.`);
    tev('abort', { gate: 'amount', amount, expected });
    return 'manual_needed';
  }
  log('✓', `Fee verified: ${amount} (${cand.players} × $${FEE_PER_PLAYER})`);

  // 11. Pre-fill the card (no saved-card option exists in this window).
  const card = cfg.feeCard;
  let filled = false;
  if (card.number && card.expMonth && card.expYear && card.cvv) {
    await cardNum.fill(card.number);
    await frame.locator('#ddlExpirationMonth').selectOption({ label: card.expMonth.padStart(2, '0') });
    await frame.locator('#ddlExpirationYear').selectOption({ label: card.expYear.length === 2 ? `20${card.expYear}` : card.expYear });
    await frame.locator('#CVV').fill(card.cvv);
    filled = true;
    log('✓', `Card pre-filled (…${card.number.slice(-4)})`);
    tev('card_prefilled', {});
  } else {
    log('⚠', 'No FEE_CARD_* values in .env — type the card into the window yourself.');
  }

  if (TEST_PAYMENT) {
    if (!filled) {
      log('✗', 'PAYMENT TEST: card fields are incomplete. Releasing the hold; $0 charged.');
      tev('abort', { gate: 'test_payment_card_missing' });
      return await closeModal(page) ? 'abort_mismatch' : 'manual_needed';
    }
    log('🏁', `PAYMENT TEST PASSED: code accepted, ${expected} verified, and card fields filled. Releasing the hold without clicking PROCESS TRANSACTION.`);
    tev('outcome_detail', { result: 'payment_test_abort', expected });
    return await closeModal(page) ? 'test_passed' : 'manual_needed';
  }

  // 12. The charge. Default: hand over. --auto-book: click it.
  if (AUTO_BOOK && filled) {
    log('💳', `AUTO-BOOK: clicking PROCESS TRANSACTION (${expected})…`);
    await frame.locator('a#submit').click();
    const gone = await page.locator('#element_iframe').waitFor({ state: 'detached', timeout: 60_000 }).then(() => true).catch(() => false);
    if (!gone) {
      const err = ((await frame.locator('#divErrors').innerText().catch(() => '')) || '').trim();
      log('✗', `Payment window still open after submit${err ? ` — error: ${err}` : ''}. Check the browser.`);
      tev('auto_book_stalled', { err });
      return 'manual_needed';
    }
    log('✓', `AUTO-BOOKED ${course.name} ${tLabel} — payment submitted. Proof: confirmation email + ${expected} charge + ForeUp My Account.`);
    return 'booked';
  }
  if (AUTO_BOOK && !filled) log('⚠', 'AUTO_BOOK is set but no card in .env — falling back to manual click.');
  log('🟢', `READY — ONE CLICK LEFT: click PROCESS TRANSACTION (${expected}) in the browser to finish.`);
  log('💳', 'That click is the ONLY thing that charges. Nothing has been paid yet; the hold dies at ~5min for $0 if you walk away.');
  tev('ready', { stage: 'process_transaction' });
  return 'ready';
}

// Every detection snapshots the full times payload here — a captured drop
// sheet is the only source that has the MORNING grid (published dates have
// those slots booked), and last week's same-weekday sheet is the best
// template for this week's target.
const SHEETS_DIR = path.join(__dirname, '..', 'logs', 'sheets');
type SnapshotKind = 'drop-first-hit' | 'preflight-live' | 'neighbor-scout';
let snapshotSeq = 0;

function snapshotFileName(courseKey: string, date: string, savedAt: string, seq: number, kind: SnapshotKind, pid = process.pid): string {
  const stamp = savedAt.replace(/[^0-9]/g, '');
  return `${courseKey}-${date}-${stamp}-${pid}-${String(seq).padStart(3, '0')}-${kind}.json`;
}

function saveSheetSnapshot(course: CourseCfg, date: string, times: ApiTime[], kind: SnapshotKind, tPlusMs: number | null = null): void {
  try {
    fs.mkdirSync(SHEETS_DIR, { recursive: true });
    const savedAt = new Date().toISOString();
    const base = snapshotFileName(course.key, date, savedAt, snapshotSeq++, kind);
    const finalPath = path.join(SHEETS_DIR, base);
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({
      schemaVersion: 1, course: course.key, date, savedAt, kind, runAt: TEL.runAt,
      tPlusMs, players: cfg.players, holes: cfg.holes, times,
    }));
    fs.renameSync(tmpPath, finalPath); // atomic + immutable: a later sparse run cannot erase the first drop capture
  } catch (e) {
    // Drop captures are scheduled off the hot path, so report durability
    // failures without jeopardizing the hold itself.
    log('⚠', `Could not save ${kind} sheet snapshot for ${course.key} ${date}: ${(e as Error).message}`);
  }
}

/** Saved sheets for a course, target's own date excluded (it must stay blind),
 *  same day-type first, then newest. */
function loadSheetSnapshots(course: CourseCfg, targetMdY: string): ApiTime[][] {
  try {
    const tgtWknd = isWeekendDate(targetMdY);
    return fs.readdirSync(SHEETS_DIR)
      .filter((f) => f.startsWith(`${course.key}-`) && f.endsWith('.json'))
      .map((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(SHEETS_DIR, f), 'utf-8')); } catch { return null; }
      })
      .filter((s): s is { date: string; savedAt: string; kind?: SnapshotKind; times: ApiTime[] } =>
        !!s?.times?.length && s.date !== targetMdY && isWeekendDate(s.date) === tgtWknd)
      .sort((a, b) => {
        const dow = (s: string) => { const [m, d, y] = s.split('-').map(Number); return new Date(y, m - 1, d).getDay(); };
        const targetDow = dow(targetMdY);
        const dateTier = (s: string) => dow(s) === targetDow ? 0 : isWeekendDate(s) === tgtWknd ? 1 : 2;
        const aw = dateTier(a.date), bw = dateTier(b.date);
        if (aw !== bw) return aw - bw;
        const kindTier = (k?: SnapshotKind) => k === 'drop-first-hit' ? 0 : k === undefined ? 1 : k === 'preflight-live' ? 2 : 3;
        const ak = kindTier(a.kind), bk = kindTier(b.kind);
        if (ak !== bk) return ak - bk;
        return a.savedAt.localeCompare(b.savedAt); // earliest capture is least censored by other holds
      })
      .map((s) => s.times);
  } catch { return []; }
}

/** SPEC scout: build each course's predicted top in-window candidate from
 *  published neighbor dates + saved drop sheets. Cheap GETs, zero holds —
 *  runs pre-drop. Live scouts first (fresh fees), snapshots fill the gaps
 *  (mornings are booked out on every published date). */
async function buildSpecCandidates(api: ForeupClient, date: string): Promise<Map<string, Candidate[]>> {
  const t = new Date();
  const todayMdY = `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}-${t.getFullYear()}`;
  const dates = specScoutDates(date, todayMdY);
  const targetWeekend = isWeekendDate(date);
  const out = new Map<string, Candidate[]>();
  for (const course of cfg.courses) {
    const liveScouts: ApiTime[][] = [];
    for (const d of dates) {
      const r = await api.pollTimes(d, course, 'all').catch(() => null);
      if (r?.length) {
        saveSheetSnapshot(course, d, r, 'neighbor-scout');
        if (isWeekendDate(d) === targetWeekend) liveScouts.push(inferSpecWindowFromFullRateAnchor(r, cfg.windowStart, cfg.windowEnd));
      }
    }
    // Exact-weekday drop captures are the least censored and loader-ranked;
    // let them define colliding times before adjacent live inference fills gaps.
    const snapshotScouts = loadSheetSnapshots(course, date)
      .map((times) => inferSpecWindowFromFullRateAnchor(times, cfg.windowStart, cfg.windowEnd));
    const scouts = [...snapshotScouts, ...liveScouts];
    const tpl = mergeSpecTemplate(scouts);
    if (tpl.size) {
      const keys = [...tpl.keys()].sort();
      log('ℹ', `SPEC template ${course.name}: ${tpl.size} times-of-day (${keys[0]}–${keys[keys.length - 1]}) from ${scouts.length} sheet(s)`);
    }
    const cands = rankCandidates(specPredictTimes(tpl, date, cfg.players), course).filter((c) => c.inWindow);
    const invalid = cands.map((cand) => ({ cand, missing: missingSpecTemplateFields(cand.t) }))
      .filter((x) => x.missing.length > 0);
    const valid = cands.filter((cand) => missingSpecTemplateFields(cand.t).length === 0);
    tev('spec_scout', {
      course: course.key,
      scouted: scouts.length,
      slots: tpl.size,
      top: valid[0]?.t.time ?? null,
      ranked: valid.slice(0, SPEC_OFFSETS_MS.length).map((c) => c.t.time),
      invalid: invalid.slice(0, SPEC_OFFSETS_MS.length).map((x) => ({ time: x.cand.t.time, missing: x.missing })),
    });
    if (invalid.length) {
      const fields = [...new Set(invalid.flatMap((x) => x.missing))];
      log('⚠', `SPEC ${course.name}: excluded ${invalid.length} incomplete prediction(s), missing ${fields.join(', ')}`);
    }
    if (!valid.length) {
      log('⚠', `SPEC: no in-window slot predictable for ${course.name} — spec disabled for it`);
      continue;
    }
    const ranked = valid.slice(0, SPEC_OFFSETS_MS.length);
    out.set(course.key, ranked);
    log('✓', `SPEC candidates ${course.name}: ${ranked.map((c, i) => `${fmtTime(c.t.time)}@T+${SPEC_OFFSETS_MS[i]}ms`).join(', ')}`);
  }
  return out;
}

function planSpecShots(cands: Candidate[], offsets: number[]): Array<{ cand: Candidate; scheduledOffsetMs: number }> {
  return cands.slice(0, offsets.length).map((cand, i) => ({ cand, scheduledOffsetMs: offsets[i] }));
}

function specShotIsLate(actualOffsetMs: number, scheduledOffsetMs: number, toleranceMs = 150): boolean {
  return actualOffsetMs > scheduledOffsetMs + toleranceMs;
}

interface HeldAttempt {
  cand: Candidate;
  page: Page;
  modalConfirmed: boolean;
  uncertain: boolean;
  source: 'spec' | 'detect';
}

type HoldRunResult = { result: BookResult | 'exhausted'; cand?: Candidate };

/** SPEC strike: per course, one ranked candidate per offset until one lands or
 *  the plan runs out. No tile fallback (pre-flip there is no tile). The next
 *  shot only runs after the previous response and is skipped if that made its
 *  fixed release-relative deadline stale. */
async function specStrike(
  pages: Map<string, Page>, specCands: Map<string, Candidate[]>, date: string, t0: number, offsets: number[],
): Promise<HeldAttempt[]> {
  const held: HeldAttempt[] = [];
  const stop = { stopped: false };
  await Promise.all([...specCands.entries()].map(async ([key, cands]) => {
    const page = pages.get(key);
    if (!page) return;
    for (const { cand, scheduledOffsetMs: off } of planSpecShots(cands, offsets)) {
      if (stop.stopped) return;
      const dt = t0 + off - now();
      if (dt > 0) await sleep(dt);
      if (stop.stopped) return;
      const actualOffsetMs = now() - t0;
      if (specShotIsLate(actualOffsetMs, off)) {
        tev('spec_shot_skipped', { course: key, time: cand.t.time, scheduledOffsetMs: off, actualOffsetMs, lateByMs: actualOffsetMs - off });
        continue; // never turn a fixed-offset backup into a seconds-late extra hold
      }
      tev('spec_shot', { course: key, time: cand.t.time, scheduledOffsetMs: off, actualOffsetMs, lateByMs: actualOffsetMs - off });
      // SPEC only needs the POST result on the hot path. Modal rendering is
      // confirmed after all already-in-flight course attempts settle.
      const r = await holdViaBridge(page, cand.course, cand, t0);
      if (r === 'held' || r === 'held_uncertain') {
        held.push({ cand, page, modalConfirmed: false, uncertain: r === 'held_uncertain', source: 'spec' });
        stop.stopped = true; // one live hold freezes the other course's shots
        return;
      }
      if (r === 'bridge_error') return; // view tree broken — spec can't help; the detect walk will tile-fallback
    }
  }));
  return held;
}

/** Hold + complete in one shot — the vulture path (one deliberate attempt at a time). */
async function browserBook(
  page: Page, course: CourseCfg, cand: Candidate, email: EmailMonitor, date: string, t0: number,
): Promise<BookResult> {
  const held = await holdPhase(page, course, cand, date, t0);
  if (held === 'held_uncertain') return 'manual_needed';
  if (held !== 'held') return held as BookResult;
  return completeBooking(page, course, cand, email, date, t0);
}

/** Resolve ForeUp's async modal after a POST-level success. If the response
 * was lost, the native pending object can recover the reservation ID from
 * this course's isolated localStorage once the callback finishes. */
async function confirmHeldAttempt(h: HeldAttempt): Promise<boolean> {
  if (h.modalConfirmed) return true;
  const modalUp = await h.page.locator('button.js-book-button').waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false);
  if (!pendingHoldIds.has(h.page)) {
    const localId = await h.page.evaluate(() => String((window as any).pending_reservation_obj?.get_id?.() ?? '')).catch(() => '');
    if (localId) {
      pendingHoldIds.set(h.page, localId);
      activeHoldPages.add(h.page);
    }
  }
  if (!modalUp) return false;
  h.modalConfirmed = true;
  h.uncertain = false;
  log('✓', `HELD ${h.cand.course.name} ${fmtTime(h.cand.t.time)} reservation (browser modal, ~5min timer)`);
  return true;
}

/** Read-only gate used before settlement mutates any competing hold. */
async function inspectModalIdentity(
  page: Page, course: CourseCfg, cand: Candidate, date: string,
): Promise<ModalIdentityMismatch | null> {
  const modalText = (await page.locator('#modal .modal-content').first().innerText().catch(() => '')) || '';
  return firstModalIdentityMismatch(modalText, {
    time: fmtTime(cand.t.time),
    date: humanDate(date),
    course: course.name,
  });
}

function reportModalIdentityMismatch(mismatch: ModalIdentityMismatch): void {
  log('✗', `MISMATCH: modal is missing expected ${mismatch.what} "${mismatch.needle}". ABORTING this hold.`);
  tev('abort', { gate: 'modal_text', what: mismatch.what, needle: mismatch.needle });
}

/** Settle every already-started hold, verify exact loser releases, then and
 * only then enter checkout for the configured winner. */
async function finalizeHeldAttempts(
  attempts: HeldAttempt[], email: EmailMonitor, date: string, t0: number,
): Promise<HoldRunResult & { abortedCandidate?: Candidate }> {
  const usable: HeldAttempt[] = [];
  let releasedWithoutModal: Candidate | undefined;
  for (const h of attempts) {
    if (await confirmHeldAttempt(h)) {
      usable.push(h);
      continue;
    }
    const known = pendingHoldIds.has(h.page);
    if (known && await closeModal(h.page)) {
      log('⚠', `Released ${h.cand.course.name} ${fmtTime(h.cand.t.time)} by reservation ID because its modal never rendered`);
      releasedWithoutModal ??= h.cand;
      continue;
    }
    const companions = [...new Set(attempts.filter((x) => x !== h && pendingHoldIds.has(x.page)).map((x) => x.page))];
    const releases = await Promise.allSettled(companions.map((page) => closeModal(page)));
    if (releases.some((x) => x.status === 'rejected' || !x.value)) log('⚠', 'At least one companion hold also failed verified release');
    await h.page.bringToFront().catch(() => {});
    log('⚠', `Pending state for ${h.cand.course.name} ${fmtTime(h.cand.t.time)} is unknown — stopped before another hold or payment step`);
    return { result: 'manual_needed', cand: h.cand };
  }
  if (!usable.length) return { result: 'exhausted', abortedCandidate: releasedWithoutModal };
  usable.sort((a, b) => cmpCandidate(a.cand, b.cand));
  let rejectedIdentity = releasedWithoutModal;
  let win: HeldAttempt | undefined;
  while (usable.length) {
    const candidate = usable.shift()!;
    const mismatch = await inspectModalIdentity(candidate.page, candidate.cand.course, candidate.cand, date);
    if (!mismatch) {
      win = candidate;
      break;
    }
    reportModalIdentityMismatch(mismatch);
    rejectedIdentity ??= candidate.cand;
    if (await closeModal(candidate.page)) continue;

    // This mismatched reservation is still potentially live. Never enter
    // checkout; best-effort cleanup of every known companion leaves the
    // browser on the reservation that needs human inspection.
    const companionReleases = await Promise.allSettled(usable.map((h) => closeModal(h.page)));
    if (companionReleases.some((x) => x.status === 'rejected' || !x.value)) {
      log('⚠', 'At least one companion hold also failed verified release');
    }
    await candidate.page.bringToFront().catch(() => {});
    log('⚠', 'Mismatched hold could not be verified released — checkout blocked');
    return { result: 'manual_needed', cand: candidate.cand };
  }
  if (!win) return { result: 'exhausted', abortedCandidate: rejectedIdentity };

  const loserReleases = await Promise.allSettled(usable.map(async (loser) => {
    log('ℹ', `Releasing ${loser.cand.course.name} ${fmtTime(loser.cand.t.time)} — keeping the better slot`);
    return closeModal(loser.page);
  }));
  if (loserReleases.some((x) => x.status === 'rejected' || !x.value)) {
    await closeModal(win.page);
    log('⚠', 'A loser hold could not be verified released — checkout blocked');
    return { result: 'manual_needed', cand: win.cand };
  }
  await win.page.bringToFront().catch(() => {});
  log('🏆', `Completing ${win.source === 'spec' ? 'SPEC ' : ''}${win.cand.course.name} ${fmtTime(win.cand.t.time)} (T+${now() - t0}ms)`);
  const result = await completeBooking(win.page, win.cand.course, win.cand, email, date, t0);
  if (result === 'ready' || result === 'booked' || result === 'test_passed' || result === 'manual_needed') return { result, cand: win.cand };
  return { result: 'exhausted', abortedCandidate: win.cand };
}

/**
 * The drop race: each course walks ITS OWN ranked candidates serially on its
 * own isolated browser context. Courses race in parallel, but a Green hold
 * never suppresses the higher-priority Red actor; a Red hold stops lower
 * actors before their next attempt. Already-sent POSTs always settle, the
 * winner is chosen by configured course order, and every loser DELETE is
 * verified before exactly one hold can enter completeBooking. Retryable
 * outcomes move serially to that course's next candidate—one bounded pass,
 * never a hammer loop.
 */
async function attemptCandidates(
  pages: Map<string, Page>, cands: Candidate[], email: EmailMonitor, date: string, t0: number,
): Promise<HoldRunResult> {
  const perCourse = Math.max(cfg.candidates, 1);
  const byCourse = new Map<string, Candidate[]>();
  for (const c of cands) {
    const list = byCourse.get(c.course.key) ?? [];
    if (list.length < perCourse) { list.push(c); byCourse.set(c.course.key, list); }
  }
  const held: HeldAttempt[] = [];
  let bestHeldPriority = Number.POSITIVE_INFINITY;
  let unsafe: { cand: Candidate; page: Page; message: string } | null = null;
  const walks = [...byCourse.entries()].map(async ([key, list]) => {
    const page = pages.get(key);
    if (!page) return;
    const priority = cfg.courses.findIndex((c) => c.key === key);
    for (const cand of list) {
      // A confirmed hold on a higher-priority course prevents new lower
      // attempts. A Green hold does not suppress the still-running Red walk.
      if (priority >= bestHeldPriority) return;
      let r: HoldOutcome;
      try {
        r = await holdPhase(page, cand.course, cand, date, t0);
      } catch (e) {
        const message = `${cand.course.name} ${fmtTime(cand.t.time)} hold walk failed: ${(e as Error).message}`;
        unsafe = { cand, page, message };
        log('⚠', message);
        tev('hold_error', { course: key, time: cand.t.time, err: (e as Error).message });
        return;
      }
      if (r === 'held' || r === 'held_uncertain') {
        held.push({ cand, page, modalConfirmed: r === 'held', uncertain: r === 'held_uncertain', source: 'detect' });
        bestHeldPriority = Math.min(bestHeldPriority, priority < 0 ? Number.MAX_SAFE_INTEGER : priority);
        return;
      }
    }
  });
  await Promise.allSettled(walks);
  if (unsafe) {
    await Promise.allSettled([...activeHoldPages].map((page) => closeModal(page)));
    const hazard = unsafe as { cand: Candidate; page: Page; message: string };
    await hazard.page.bringToFront().catch(() => {});
    return { result: 'manual_needed', cand: hazard.cand };
  }
  return finalizeHeldAttempts(held, email, date, t0);
}

/** Drop race with one actor per isolated course context. Detection begins for
 * every course at T-200 and each actor starts its hold the instant that
 * course responds—raceGrace only limits how long silent pollers linger; it no
 * longer delays a detected hold. Red's actor serializes SPEC before consuming
 * its already-buffered API detection so two Red holds never share a page. */
async function raceDetectAndHold(
  api: ForeupClient,
  pages: Map<string, Page>,
  email: EmailMonitor,
  date: string,
  t0: number,
  specP: Promise<HeldAttempt[]> | null,
): Promise<HoldRunResult> {
  const pollStop: StopToken = { stopped: false };
  const detected: Candidate[] = [];
  const held: HeldAttempt[] = [];
  const attempted = new Set<string>();
  let bestHeldPriority = Number.POSITIVE_INFINITY;
  let unsafe: { message: string; page?: Page; cand?: Candidate } | null = null;
  let pollStopTimer: ReturnType<typeof setTimeout> | null = null;

  const detect = async (course: CourseCfg, priority: number): Promise<Candidate[]> => {
    const times = await racePoll(api, date, course, pollStop);
    if (!times) return [];
    tev('detected', { course: course.key, count: times.length });
    log('⚡', `${course.name}: ${times.length} times (T+${now() - t0}ms)`);
    setImmediate(() => saveSheetSnapshot(course, date, times, 'drop-first-hit', now() - t0));
    const list = rankCandidates(times, course);
    if (!list.length) log('✗', `${course.name}: no bookable slots inside the configured cutoff`);
    detected.push(...list);
    if (list.length) {
      // A lower-priority Green hit must not cut off a slightly delayed Red
      // response. Give the preferred actor a full second; a Red hit can then
      // shorten the remaining lower-course grace back to the configured cap.
      if (pollStopTimer) clearTimeout(pollStopTimer);
      const grace = priority === 0 ? cfg.raceGraceMs : Math.max(cfg.raceGraceMs, 1000);
      pollStopTimer = setTimeout(() => { pollStop.stopped = true; }, grace);
    }
    return list;
  };

  const actors = cfg.courses.map(async (course, priority) => {
    const page = pages.get(course.key);
    if (!page) return;
    const detectedP = detect(course, priority); // starts immediately for every course

    if (priority === 0 && specP) {
      try {
        const specHeld = await specP;
        if (specHeld.length) {
          held.push(...specHeld);
          bestHeldPriority = 0;
          pollStop.stopped = true;
          return;
        }
      } catch (e) {
        unsafe = { message: `SPEC actor failed after launch: ${(e as Error).message}`, page };
        pollStop.stopped = true;
        return;
      }
    }

    const list = await detectedP;
    for (const cand of list.slice(0, Math.max(cfg.candidates, 1))) {
      if (unsafe || priority >= bestHeldPriority) return;
      let r: HoldOutcome;
      try {
        attempted.add(`${cand.course.key}|${cand.t.time}`);
        r = await holdPhase(page, course, cand, date, t0);
      } catch (e) {
        unsafe = { message: `${course.name} hold actor failed: ${(e as Error).message}`, page, cand };
        pollStop.stopped = true;
        return;
      }
      if (r === 'held' || r === 'held_uncertain') {
        held.push({ cand, page, modalConfirmed: r === 'held', uncertain: r === 'held_uncertain', source: 'detect' });
        bestHeldPriority = Math.min(bestHeldPriority, priority);
        return;
      }
    }
  });

  const settled = await Promise.allSettled(actors);
  if (pollStopTimer) clearTimeout(pollStopTimer);
  pollStop.stopped = true;
  const actorFailure = settled.find((x): x is PromiseRejectedResult => x.status === 'rejected');
  if (actorFailure && !unsafe) unsafe = { message: `Course actor rejected: ${String(actorFailure.reason)}` };

  if (unsafe) {
    const releases = await Promise.allSettled([...activeHoldPages].map((page) => closeModal(page)));
    if (releases.some((x) => x.status === 'rejected' || !x.value)) log('⚠', 'Actor failure cleanup could not verify every known release');
    const hazard = unsafe as { message: string; page?: Page; cand?: Candidate };
    await hazard.page?.bringToFront().catch(() => {});
    log('⚠', `${hazard.message} — stopped before payment or another hold`);
    return { result: 'manual_needed', cand: hazard.cand };
  }

  const finalized = await finalizeHeldAttempts(held, email, date, t0);
  if (finalized.result === 'exhausted' && held.length && detected.length) {
    // A SPEC/modal money-gate failure was explicitly released. Consume the
    // detection results already buffered under it instead of jumping to the
    // slower vulture phase or discarding the other course.
    const failed = finalized.abortedCandidate;
    const remaining = detected
      .filter((c) => !attempted.has(`${c.course.key}|${c.t.time}`))
      .filter((c) => !failed || c.course.key !== failed.course.key || c.t.time !== failed.t.time)
      .sort(cmpCandidate);
    if (remaining.length) return attemptCandidates(pages, remaining, email, date, t0);
  }
  return finalized;
}

/**
 * Vulture mode: after a lost race, keep re-polling until T+vultureMs. Slots
 * come back — unpaid holds expire at exactly +5min (every bot doing a $0 test
 * releases one) and abandoned carts free up. Retries a seen slot at most every
 * 20s so we don't hammer a slot someone is actively booking.
 */
async function vultureHunt(
  api: ForeupClient, pages: Map<string, Page>, email: EmailMonitor, date: string, t0: number,
): Promise<{ result: BookResult | 'exhausted'; cand?: Candidate }> {
  if (cfg.vultureMs <= 0) return { result: 'exhausted' };
  const deadline = t0 + cfg.vultureMs;
  const playerRange = cfg.minPlayers === cfg.players ? `${cfg.players}` : `${cfg.players} preferred, ${cfg.minPlayers} accepted`;
  log('🦅', `VULTURE mode — hunting freed slots every ${Math.round(cfg.vulturePollMs / 1000)}s until T+${Math.round(cfg.vultureMs / 60_000)}min (${playerRange} players)`);
  tev('vulture_start', { preferredPlayers: cfg.players, minPlayers: cfg.minPlayers, deadline, pollMs: cfg.vulturePollMs });

  // The initial race is staged for the preferred party size. If a smaller
  // explicitly-approved party is acceptable, re-stage once after that race
  // is exhausted. The 3-player filter still exposes 4-spot tiles; each
  // candidate then carries 4 or 3 through the exact checkout money gates.
  if (cfg.minPlayers < cfg.players) {
    log('…', `Recovery staging: widening every page from ${cfg.players} to ${cfg.minPlayers}–${cfg.players} players`);
    const staged = await Promise.allSettled([...pages.entries()].map(([key, page]) => {
      const course = cfg.courses.find((c) => c.key === key);
      return course ? stagePage(page, course, date, cfg.minPlayers) : Promise.reject(new Error(`Unknown course page ${key}`));
    }));
    const failed = staged.find((x): x is PromiseRejectedResult => x.status === 'rejected');
    if (failed) {
      log('✗', `Could not safely stage the ${cfg.minPlayers}-player recovery filter: ${String(failed.reason)}. Recovery stopped before any hold.`);
      tev('vulture_stage_failed', { error: String(failed.reason) });
      return { result: 'exhausted' };
    }
    log('✓', `Recovery pages ready for ${cfg.minPlayers}–${cfg.players} players`);
  }

  const lastTry = new Map<string, number>();
  let lastLog = 0;
  let nextEmailKeepAlive = now() + 5 * 60_000;
  while (now() < deadline) {
    if (now() >= nextEmailKeepAlive) {
      await email.keepAlive()
        .then(() => log('✓', 'Long-monitor IMAP keepalive ready'))
        .catch((e) => log('⚠', `Long-monitor IMAP keepalive failed; will retry in 5min (${(e as Error).message})`));
      nextEmailKeepAlive = now() + 5 * 60_000;
    }
    const results = await Promise.all(cfg.courses.map(async (course) => ({
      course, times: await api.pollTimes(date, course, undefined, cfg.minPlayers).catch(() => null),
    })));
    const cands: Candidate[] = [];
    for (const { course, times } of results) {
      if (times) cands.push(...rankCandidates(times, course, cfg.minPlayers, cfg.players));
    }
    const fresh = cands.sort(cmpCandidate).filter((c) => {
      const key = `${c.course.key}|${c.t.time}|${c.players}`;
      return now() - (lastTry.get(key) ?? 0) > 20_000;
    });
    if (fresh.length) {
      const target = fresh[0]; // browser is serial — one deliberate attempt at a time
      if (now() - lastLog > 10_000) {
        log('🎯', `Vulture: trying ${fmtTime(target.t.time)} ${target.course.key} for ${target.players} players (T+${Math.round((now() - t0) / 1000)}s)`);
        lastLog = now();
      }
      lastTry.set(`${target.course.key}|${target.t.time}|${target.players}`, now());
      const page = pages.get(target.course.key);
      if (page) {
        const result = await browserBook(page, target.course, target, email, date, t0);
        if (result === 'ready' || result === 'booked' || result === 'test_passed' || result === 'manual_needed') {
          tev('vulture_success', { time: target.t.time, tPlusMs: now() - t0 });
          return { result, cand: target };
        }
      }
    }
    await sleep(Math.min(cfg.vulturePollMs, Math.max(0, deadline - now())));
  }
  log('✗', 'Vulture window closed — nothing came back.');
  return { result: 'exhausted' };
}

// ────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────
async function main() {
  const date = getTargetDate();
  console.log(`\n  ⛳  TURBO SNIPER ${DRY_RUN ? '(DRY RUN)' : ABORT_BEFORE_BOOK ? '(NO-BOOK MODE — click + verify + abort)' : TEST_PAYMENT ? '(PAYMENT TEST — fill + verify + release at $0)' : AUTO_BOOK ? '(AUTO-BOOK)' : '(one click left for you)'}\n`);
  console.log(`  Course${cfg.courses.length > 1 ? 's' : ''}:   ${cfg.courses.map((c) => c.name).join(' + ')}`);
  console.log(`  Date:      ${date}`);
  console.log(`  Window:    ${fmtMin(cfg.windowStart)}–${fmtMin(cfg.windowEnd)}, ${cfg.slotOrder} first (fallback up to ${fmtMin(cfg.fallbackUntil)}, then abort)`);
  if (cfg.courses.length > 1) console.log(`  Priority:  ${cfg.courses.map((c) => c.name).join(' → ')}`);
  console.log(`  Players:   ${cfg.players}${cfg.minPlayers < cfg.players ? ` preferred; ${cfg.minPlayers} accepted during recovery` : ''}`);
  console.log(`  Card:      ${cfg.feeCard.number ? `…${cfg.feeCard.number.slice(-4)} will be pre-filled` : 'not in .env — you type it at the end'}\n`);

  // Keep the Mac awake for the whole run — a 6:58pm sleep kills everything.
  // -w ties caffeinate's lifetime to this process. Must be fully detached
  // (no stdio pipes): piped stdio would keep OUR event loop alive waiting on
  // caffeinate, which waits on us — a deadlock that hangs every run at exit.
  if (process.platform === 'darwin') {
    spawn('caffeinate', ['-dims', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref();
  }

  const detStats = historicalDetectStats();
  if (detStats) {
    log('ℹ', `History: median detection +${detStats.medianMs}ms after server release across ${detStats.n} drop${detStats.n > 1 ? 's' : ''}`);
  }

  // ── Setup ─────────────────────────────────────────────
  log('…', 'Browser bootstrap');
  const { context, pages } = await bootstrap(date);

  // Server-clock sync first (the drop fires on ForeUp's clock), NTP as a
  // sanity cross-check + fallback if the Date-header probe fails.
  log('…', 'Clock sync (ForeUp server clock)');
  const [srv, ntp] = await Promise.all([foreupServerOffset(), ntpOffset()]);
  const clock = trustedClockOffset(srv, ntp);
  CLOCK_OFFSET_MS = clock.offsetMs;
  if (clock.source === 'foreup') {
    log('✓', `Clock offset: ${clock.offsetMs}ms (ForeUp server clock; NTP says ${ntp ?? 'unavailable'}ms${clock.deltaMs === null ? '' : `, Δ${clock.deltaMs}ms`})`);
  } else if (clock.source === 'ntp') {
    const why = srv === null ? 'server-clock probe failed' : `ForeUp/NTP disagreement Δ${clock.deltaMs}ms`;
    log('⚠', `Clock offset: ${clock.offsetMs}ms (NTP fallback — ${why})`);
  } else {
    log('⚠', 'Clock sync unavailable — using the machine clock');
  }
  tev('clock_sync', { source: clock.source, offsetMs: clock.offsetMs, foreupMs: srv, ntpMs: ntp, deltaMs: clock.deltaMs });

  const api = new ForeupClient();
  await api.loadCookiesFrom(context);
  log('✓', 'Cookies extracted');

  log('…', 'Pre-warm TLS');
  await api.preWarm();
  await foreupPreflight();

  const needEmail = cfg.courses.some((c) => c.emailCode);
  const email = new EmailMonitor(cfg.gmailEmail, cfg.gmailAppPassword);
  if (needEmail) {
    log('…', 'IMAP connect');
    await email.connect();
    log('✓', 'IMAP ready');
  } else {
    log('ℹ', 'No email code needed for this course — skipping IMAP');
  }
  const cleanup = async () => { if (needEmail) await email.disconnect(); };

  // Verify API works pre-drop (all courses)
  let sheetAlreadyLive = false;
  for (const course of cfg.courses) {
    const test = await api.pollTimes(date, course).catch(() => null);
    if (test) {
      sheetAlreadyLive = true;
      saveSheetSnapshot(course, date, test, 'preflight-live'); // free spec-template material for future runs
      const best = rankCandidates(test, course)[0];
      log('✓', `Pre-drop ${course.name}: ${test.length} times${best ? ` — best ${fmtTime(best.t.time)}${best.inWindow ? '' : ' (fallback)'}` : ''}`);
    } else {
      log('ℹ', `Pre-drop ${course.name}: no times for ${date} yet`);
    }
  }

  if (DRY_RUN) {
    if (SPEC && !BRIDGE_OFF && cfg.race) {
      log('…', 'SPEC scout (read-only dry run): validating predicted slots from published/saved sheets');
      const scouted = await buildSpecCandidates(api, date);
      const preferred = cfg.courses[0];
      const ranked = preferred ? scouted.get(preferred.key) : undefined;
      if (preferred && ranked?.length) {
        log('✓', `DRY RUN SPEC ${preferred.name}: ${ranked.map((c, i) => `${fmtTime(c.t.time)}@T+${SPEC_OFFSETS_MS[i]}ms`).join(', ')}`);
      } else if (preferred) {
        log('⚠', `DRY RUN SPEC: no safe predicted ${preferred.name} slot; detect path only`);
      }
    }
    log('🏁', 'DRY RUN done.');
    tev('outcome', { result: 'dry_run_ok' }); saveTelemetry();
    await cleanup();
    await context.browser()?.close();
    return;
  }

  // IMAP baseline set once here, OUT of the hold hot path (it's a mailbox
  // round-trip). Code emails only ever arrive after a hold, so a pre-drop
  // baseline stays valid; aborted holds re-baseline via closeModal.
  if (needEmail) await email.resetBaseline().catch(() => {});

  // ── SPEC scout (pre-drop, $0) ─────────────────────────
  let specCands = new Map<string, Candidate[]>();
  if (SPEC) {
    if (BRIDGE_OFF) log('⚠', 'SPEC requires the bridge — --no-bridge set, spec disabled');
    else if (!cfg.race) log('⚠', 'SPEC requires race mode — spec disabled');
    else {
      log('…', 'SPEC scout: building the slot template from published neighbor dates');
      const scouted = await buildSpecCandidates(api, date);
      // SPEC is reserved for the first configured course (red in red,green).
      // A lower-priority blind hold must not preempt an unknown Red sheet;
      // normal API detection still races every configured course underneath.
      const preferred = cfg.courses[0];
      const ranked = preferred ? scouted.get(preferred.key) : undefined;
      if (preferred && ranked?.length) {
        specCands.set(preferred.key, ranked);
        log('✓', `SPEC priority: blind-fire ${preferred.name}; other courses remain detect-path fallbacks`);
      } else if (preferred && scouted.size) {
        log('⚠', `SPEC: no safe predicted ${preferred.name} slot — not blind-firing a fallback course`);
      }
    }
  }

  // ── Wait for drop ─────────────────────────────────────
  // No waiting if the target date's sheet is already live (re-runs, tests).
  const releaseAt = sevenPmEpoch(now());
  const scheduledDrop = !sheetAlreadyLive && releaseAt > now();
  const wait = releaseAt - now() - cfg.preDropMs;
  if (wait > 0 && scheduledDrop) {
    log('⏳', `${Math.floor(wait / 60000)}m ${Math.ceil((wait % 60000) / 1000)}s until T-${cfg.preDropMs}ms`);
    let browserWarmed = false;
    let resynced = false;
    while (releaseAt - now() > cfg.preDropMs) {
      const r = releaseAt - now();
      // T-30s: re-sync the server clock. It was measured minutes ago at arm
      // time; a late, close-to-drop reading corrects any drift so the poll
      // loop is genuinely mid-flight at the true release instant.
      // Never start a multi-second probe close enough to straddle T=0. A late
      // startup inside ten seconds keeps the already-trusted initial clock.
      if (r <= 30_000 && r > 10_000 && !resynced) {
        resynced = true;
        const [s, n] = await Promise.all([foreupServerOffset().catch(() => null), ntpOffset().catch(() => null)]);
        const fresh = trustedClockOffset(s, n);
        if (fresh.source !== 'local' && Math.abs(fresh.offsetMs - CLOCK_OFFSET_MS) >= 20) {
          log('✓', `Clock re-sync near T-30s: ${CLOCK_OFFSET_MS}ms → ${fresh.offsetMs}ms (${fresh.source}; drift ${fresh.offsetMs - CLOCK_OFFSET_MS}ms)`);
          tev('clock_resync', { fromMs: CLOCK_OFFSET_MS, toMs: fresh.offsetMs, source: fresh.source, foreupMs: s, ntpMs: n, deltaMs: fresh.deltaMs });
          CLOCK_OFFSET_MS = fresh.offsetMs;
        }
      }
      // T-3.5s: re-warm each page's connection pool so the hold POST doesn't
      // pay a cold TCP+TLS handshake — the pages have been idle for minutes.
      if (r <= 3500 && !browserWarmed) {
        browserWarmed = true;
        for (const p of pages.values()) {
          p.evaluate(`fetch('/robots.txt', { cache: 'no-store' }).catch(() => {})`).catch(() => {});
        }
      }
      if (r > 5000) await sleep(1000);
      else if (r > 500) await sleep(50);
      else await sleep(5); // tight loop in final 500ms
    }
  }

  // ══════════════════════════════════════════════════════
  // ══  S N I P E  ══════════════════════════════════════
  // ══════════════════════════════════════════════════════
  const pollStartedAt = now();
  const t0 = scheduledDrop ? releaseAt : pollStartedAt;
  const pollDelta = pollStartedAt - t0;
  log('🔥', `T${pollDelta < 0 ? '' : '+'}${pollDelta}ms — POLLING`);
  sound('alert');
  telT0 = t0;
  TEL.timingBasis = scheduledDrop ? 'server_release' : 'run_start';
  tev('poll_start', { leadMs: Math.max(0, t0 - pollStartedAt) });
  tev('drop', { date, courses: cfg.courses.map((c) => c.key), window: [cfg.windowStart, cfg.windowEnd], race: cfg.race, releaseAt, scheduledDrop });

  // NOTE: the old 800ms pre-fire sheet refresh is gone. It re-rendered the
  // tile list mid-race, which detached the tile Playwright was about to click
  // (the 2026-07-12 "click swallowed" dead tile). The bridge hold needs no
  // rendered tiles at all, and the tile fallback does its own refresh retries.

  // ── SPEC strike + DETECT (API), concurrently ─────────
  // On a live sheet (tests, re-runs) spec runs ALONE with a single immediate
  // shot — that is the $0 blind-fire mechanism test; mixing it with the
  // detect walk would double-hold.
  const specTest = SPEC && sheetAlreadyLive && specCands.size > 0;
  const specP = specCands.size ? specStrike(pages, specCands, date, t0, specTest ? [0] : SPEC_OFFSETS_MS) : null;
  if (specP) log('🚀', `SPEC: blind-firing without waiting for detection (${specTest ? 'live-sheet test, single shot' : `T+${SPEC_OFFSETS_MS.join('/')}ms`})`);

  let outcome: HoldRunResult = { result: 'exhausted' };
  if (specTest) {
    // Live-sheet mechanism test: one immediate SPEC attempt, no detector or
    // vulture. finalizeHeldAttempts verifies the exact $0 release.
    outcome = await finalizeHeldAttempts(specP ? await specP : [], email, date, t0);
  } else if (cfg.race) {
    log('🏁', `RACE mode — ${cfg.courses.length} isolated course actor(s), pipelined API detection (concurrency=${cfg.pollConcurrency}/course, stagger=${cfg.pollStaggerMs}ms); each holds immediately on detection`);
    outcome = await raceDetectAndHold(api, pages, email, date, t0, specP);
  } else {
    const course = cfg.courses[0];
    let times: ApiTime[] | null = null;
    let polls = 0;
    while (!times && polls < 1000) {
      polls++;
      times = await api.pollTimes(date, course).catch(() => null);
      if (!times) await sleep(cfg.pollIntervalMs);
      if (polls % 20 === 0 && !times) log('⚡', `Poll #${polls} (T+${now() - t0}ms)`);
    }
    if (times) {
      log('⚡', `${course.name}: ${times.length} times — ${now() - t0}ms after drop`);
      tev('detected', { course: course.key, count: times.length });
      setImmediate(() => saveSheetSnapshot(course, date, times!, 'drop-first-hit', now() - t0));
      const cands = rankCandidates(times, course);
      if (cands.length && !cands[0].inWindow) log('⚠', `Window empty — falling back to ${fmtTime(cands[0].t.time)}`);
      if (!cands.length && times.length) log('✗', `No bookable slots. First few: ${times.slice(0, 5).map((t) => t.time.split(' ')[1]).join(', ')}`);
      const specHeld = specP ? await specP : [];
      outcome = specHeld.length
        ? await finalizeHeldAttempts(specHeld, email, date, t0)
        : await attemptCandidates(pages, cands, email, date, t0);
      if (outcome.result === 'exhausted' && specHeld.length && cands.length) {
        outcome = await attemptCandidates(pages, cands, email, date, t0);
      }
    } else {
      log('✗', 'No times after polling');
      if (specP) outcome = await finalizeHeldAttempts(await specP, email, date, t0);
    }
  }
  if (outcome.result === 'exhausted' && !specTest) {
    outcome = await vultureHunt(api, pages, email, date, t0);
  }

  // ── OUTCOME ───────────────────────────────────────────
  const cand = outcome.cand;
  const label = cand ? `${fmtTime(cand.t.time)} ${cand.course.name}` : '';
  switch (outcome.result) {
    case 'booked':
      tev('outcome', { result: 'booked', totalMs: now() - t0, auto: true }); saveTelemetry();
      sound('success');
      banner(`BOOKED ${label}`, `${date} · ${cand?.players ?? cfg.players} players · $${FEE_PER_PLAYER * (cand?.players ?? cfg.players)} charged`, 'Proof: confirmation email + card charge');
      await keepAliveForManual(context);
      break;
    case 'ready':
      tev('outcome', { result: 'ready_for_click', totalMs: now() - t0 }); saveTelemetry();
      sound('success'); sound('alert');
      banner('READY — ONE CLICK LEFT', label, `${date} · ${cand?.players ?? cfg.players} players · $${FEE_PER_PLAYER * (cand?.players ?? cfg.players)} on your click`);
      await keepAliveForManual(context);
      break;
    case 'manual_needed':
      log('✗', 'Automation stalled mid-flow — the browser is open, finish by hand within the 5-min hold.');
      tev('outcome', { result: 'manual_needed' }); saveTelemetry();
      sound('alert');
      await keepAliveForManual(context);
      break;
    case 'test_passed':
      tev('outcome', { result: 'no_book_abort' }); saveTelemetry();
      sound('success');
      await cleanup(); await context.browser()?.close();
      return;
    default:
      log('✗', 'No successful hold (no times, empty window, or every tile was taken)');
      tev('outcome', { result: 'no_hold' }); saveTelemetry();
      sound('error');
      await cleanup();
      await context.browser()?.close();
      return;
  }
  await cleanup();
}

/** Hold the browser open so the human can finish; exit on Ctrl-C.
 *  Headless (VM) runs have no human and no Ctrl-C — linger briefly so the
 *  log stream is read, then exit on their own. */
async function keepAliveForManual(context: BrowserContext): Promise<void> {
  if (process.env.HEADLESS) {
    log('ℹ', 'Headless run — nothing to finish by hand. Closing in 30s.');
    await sleep(30_000);
    await context.browser()?.close().catch(() => {});
    return;
  }
  log('ℹ', 'Browser stays open. Finish there, then press Ctrl+C here to exit.');
  await new Promise<void>((r) => process.on('SIGINT', r));
  await context.browser()?.close().catch(() => {});
}

function banner(line1: string, line2: string, line3: string) {
  const pad = (s: string) => s.slice(0, 47).padEnd(47);
  console.log('\n  ╔═════════════════════════════════════════════════╗');
  console.log(`  ║  🏌️  ${pad(line1)}║`);
  console.log(`  ║      ${pad(line2)}║`);
  console.log(`  ║      ${pad(line3)}║`);
  console.log('  ╚═════════════════════════════════════════════════╝\n');
}

main().catch(async (e) => {
  console.error(`\n  ✗ ${e.stack ?? e.message ?? e}\n`);
  tev('outcome', { result: 'crash', error: String(e?.message ?? e) });
  if (activeHoldPages.size) {
    log('⚠', `Crash cleanup: releasing ${activeHoldPages.size} known pending hold${activeHoldPages.size === 1 ? '' : 's'}`);
    await Promise.allSettled([...activeHoldPages].map((page) => closeModal(page)));
  }
  saveTelemetry();
  sound('error');
  process.exit(1);
});
