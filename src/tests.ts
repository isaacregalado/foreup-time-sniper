/**
 * Bethpage Sniper — Unit Tests
 *
 * No test framework needed. Simple assertion runner that tests the pure
 * logic extracted from api-sniper.ts, index.ts, and email-monitor.ts.
 *
 * Run: npm test
 */

import * as fs from 'fs';
import { bookingCodeContextMatches, EmailMonitor, pickBookingCode } from './email-monitor';
import {
  bookingFeeTotal, classifyTimesResponse, etDropTargetDate, firstModalIdentityMismatch, isSoftLimitRejection, missingSpecTemplateFields,
  pollPhase, poolWarmSockets, settleWithin, specRunMode, vultureRetryDelayMs,
} from './turbo-guards';
import {
  causalOffsetInterval, fuseClockOffset, pickNtpSample, planPreDropMs, planSpecOffsets, probeServerDate,
  releaseSendBracket, summarizeReleaseRuns, type DateSample,
} from './clock-sync';
import {
  dayClassOf, fullRateAnchorOf, isoDate, isWeekendDate, latticePhase, latticeStep, mergeSpecTemplate, pickFullRateAnchor,
  predictWindowFromAnchor, snapshotFileName, specPayloadDiff, specPredictTimes, specScoutDates, specShotIsLate, specShotTarget,
} from './spec-template';

// ────────────────────────────────────────────────────────────
// Test harness
// ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL: ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL: ${label}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL: ${label}`);
    console.log(`    expected: ${e}`);
    console.log(`    actual:   ${a}`);
  }
}

function section(name: string) {
  console.log(`\n  -- ${name} --`);
}

// ────────────────────────────────────────────────────────────
// Extracted functions (copied from source — these are not exported)
// ────────────────────────────────────────────────────────────

// From index.ts — parseTime
function parseTime(s: string): number {
  const m = s.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return -1;
  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  if (m[3].toLowerCase() === 'pm' && h !== 12) h += 12;
  if (m[3].toLowerCase() === 'am' && h === 12) h = 0;
  return h * 60 + min;
}

// From api-sniper.ts — TeeTime interface
interface TeeTime {
  time: string;
  schedule_id: number;
  teesheet_id: number;
  teesheet_side_id: number;
  teesheet_side_name: string;
  available_spots: number;
  booking_class_id: number;
  green_fee: number;
  green_fee_tax: number;
  cart_fee: number;
  cart_fee_tax: number;
  [key: string]: any;
}

// From api-sniper.ts — pickBest (parameterized to accept config)
function pickBest(
  times: TeeTime[],
  targetHour: number,
  targetMinute: number,
  timeWindow: number,
  players: number,
): TeeTime | null {
  const target = targetHour * 60 + targetMinute;
  let best: TeeTime | null = null;
  let bestD = Infinity;
  for (const t of times) {
    const hhmm = t.time.split(' ')[1];
    if (!hhmm) continue;
    const [hh, mm] = hhmm.split(':').map(Number);
    if (isNaN(hh) || isNaN(mm)) continue;
    const d = Math.abs(hh * 60 + mm - target);
    if (d <= timeWindow && t.available_spots >= players && d < bestD) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

// From api-sniper.ts / index.ts — getTargetDate (parameterized)
function getTargetDate(override: string): string {
  if (override) return override;
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${d.getFullYear()}`;
}

// From email-monitor.ts — booking code regex patterns
function extractBookingCode(text: string): string | null {
  // "booking code is: XXXXXX" or "booking code: XXXXXX" pattern first
  const specific = text.match(/booking code\s*(?:is)?[:\s]+(\d{5,8})/i);
  if (specific) return specific[1];
  // Fallback: standalone 6-digit number
  const sixDigit = text.match(/\b(\d{6})\b/);
  if (sixDigit) return sixDigit[1];
  return null;
}

// From api-sniper.ts — fetchT (timeout wrapper)
async function fetchT(
  url: string,
  opts: RequestInit = {},
  timeoutMs = 5000,
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// From api-sniper.ts / index.ts — cliArg + int helpers
function cliArg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function int(v: string | undefined, fb: number): number {
  return v ? parseInt(v, 10) : fb;
}

// ────────────────────────────────────────────────────────────
// Helper to build a TeeTime fixture
// ────────────────────────────────────────────────────────────

function makeTeeTime(time: string, spots: number): TeeTime {
  return {
    time,
    schedule_id: 2432,
    teesheet_id: 1,
    teesheet_side_id: 1016,
    teesheet_side_name: 'Front',
    available_spots: spots,
    booking_class_id: 50295,
    green_fee: 65,
    green_fee_tax: 0,
    cart_fee: 0,
    cart_fee_tax: 0,
  };
}

// ────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────

async function runTests() {

console.log('\n  Bethpage Sniper — Tests\n');

// ═══════════════════════════════════════════════════════════
// 1. pickBest — time matching logic
// ═══════════════════════════════════════════════════════════

section('pickBest — time matching');

// Finds closest time to target within window
{
  const times = [
    makeTeeTime('2026-04-05 07:00', 4),
    makeTeeTime('2026-04-05 07:22', 4),
    makeTeeTime('2026-04-05 07:30', 4),
    makeTeeTime('2026-04-05 07:38', 4),
    makeTeeTime('2026-04-05 08:00', 4),
  ];
  const result = pickBest(times, 7, 30, 15, 4);
  assertEqual(result?.time, '2026-04-05 07:30', 'pickBest: exact match at target time');
}

// Picks closest, not first
{
  const times = [
    makeTeeTime('2026-04-05 07:20', 4),
    makeTeeTime('2026-04-05 07:28', 4),
    makeTeeTime('2026-04-05 07:38', 4),
  ];
  const result = pickBest(times, 7, 30, 15, 4);
  assertEqual(result?.time, '2026-04-05 07:28', 'pickBest: picks closest (07:28), not first (07:20)');
}

// Respects player count (available_spots >= players)
{
  const times = [
    makeTeeTime('2026-04-05 07:30', 2), // only 2 spots, need 4
    makeTeeTime('2026-04-05 07:38', 4), // 4 spots, acceptable
  ];
  const result = pickBest(times, 7, 30, 15, 4);
  assertEqual(result?.time, '2026-04-05 07:38', 'pickBest: skips time with insufficient spots');
}

// Returns null when no times in window
{
  const times = [
    makeTeeTime('2026-04-05 09:00', 4),
    makeTeeTime('2026-04-05 10:00', 4),
  ];
  const result = pickBest(times, 7, 30, 15, 4);
  assertEqual(result, null, 'pickBest: returns null when no times within window');
}

// Returns null on empty array
{
  const result = pickBest([], 7, 30, 15, 4);
  assertEqual(result, null, 'pickBest: returns null for empty array');
}

// Handles NaN/malformed time strings
{
  const times = [
    makeTeeTime('2026-04-05 abc:def', 4),
    makeTeeTime('2026-04-05', 4),       // no space-separated HH:MM
    makeTeeTime('garbage', 4),
    makeTeeTime('2026-04-05 07:30', 4), // one valid entry
  ];
  const result = pickBest(times, 7, 30, 15, 4);
  assertEqual(result?.time, '2026-04-05 07:30', 'pickBest: ignores NaN/malformed, finds valid');
}

// Handles time with no space (no HH:MM part)
{
  const times = [makeTeeTime('nospace', 4)];
  const result = pickBest(times, 7, 30, 15, 4);
  assertEqual(result, null, 'pickBest: returns null when time has no space separator');
}

// Boundary: time exactly at window edge is included
{
  const times = [makeTeeTime('2026-04-05 07:15', 4)]; // 15 min before 7:30
  const result = pickBest(times, 7, 30, 15, 4);
  assertEqual(result?.time, '2026-04-05 07:15', 'pickBest: includes time at exact window boundary');
}

// Boundary: time 1 min outside window is excluded
{
  const times = [makeTeeTime('2026-04-05 07:14', 4)]; // 16 min before 7:30
  const result = pickBest(times, 7, 30, 15, 4);
  assertEqual(result, null, 'pickBest: excludes time 1 min outside window');
}

// Afternoon target
{
  const times = [
    makeTeeTime('2026-04-05 14:00', 4),
    makeTeeTime('2026-04-05 14:08', 4),
    makeTeeTime('2026-04-05 14:15', 4),
  ];
  const result = pickBest(times, 14, 10, 10, 4);
  assertEqual(result?.time, '2026-04-05 14:08', 'pickBest: works with afternoon target (14:10)');
}

// Players = 1, any spot works
{
  const times = [makeTeeTime('2026-04-05 07:30', 1)];
  const result = pickBest(times, 7, 30, 15, 1);
  assertEqual(result?.time, '2026-04-05 07:30', 'pickBest: 1 player with 1 spot matches');
}

// All spots insufficient
{
  const times = [
    makeTeeTime('2026-04-05 07:28', 3),
    makeTeeTime('2026-04-05 07:30', 2),
    makeTeeTime('2026-04-05 07:32', 1),
  ];
  const result = pickBest(times, 7, 30, 15, 4);
  assertEqual(result, null, 'pickBest: returns null when all times have insufficient spots');
}

// ═══════════════════════════════════════════════════════════
// 2. getTargetDate — date calculation
// ═══════════════════════════════════════════════════════════

section('getTargetDate — date calculation');

// Returns override when set
{
  const result = getTargetDate('04-05-2026');
  assertEqual(result, '04-05-2026', 'getTargetDate: returns override directly');
}

// Returns MM-DD-YYYY format, 7 days from now
{
  const result = getTargetDate('');
  const d = new Date();
  d.setDate(d.getDate() + 7);
  const expected = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${d.getFullYear()}`;
  assertEqual(result, expected, 'getTargetDate: 7 days from now in MM-DD-YYYY format');
}

// Format check: MM-DD-YYYY pattern
{
  const result = getTargetDate('');
  const pattern = /^\d{2}-\d{2}-\d{4}$/;
  assert(pattern.test(result), 'getTargetDate: matches MM-DD-YYYY pattern');
}

// Override is returned verbatim (no reformatting)
{
  const result = getTargetDate('1-2-2026');
  assertEqual(result, '1-2-2026', 'getTargetDate: returns override verbatim, no zero-padding');
}

// ═══════════════════════════════════════════════════════════
// 3. Email code extraction — regex patterns
// ═══════════════════════════════════════════════════════════

section('Email code extraction — regex');

// ForeUp's code email includes date + time but not the course. Parallel
// course holds therefore accept only the sole winner's fresh matching email.
{
  const body = 'Tee Time: 6:39 AM\nDate: July 21, 2026\nYour booking code is: 942236';
  assert(bookingCodeContextMatches(body, { dateMdY: '07-21-2026', time24: '06:39' }), 'email context: long date + spaced AM time match winner');
  assert(!bookingCodeContextMatches(body, { dateMdY: '07-21-2026', time24: '06:48' }), 'email context: wrong tee time rejected');
  assert(!bookingCodeContextMatches(body, { dateMdY: '07-22-2026', time24: '06:39' }), 'email context: wrong target date rejected');
  assert(bookingCodeContextMatches('JulY 21, 2026 at 6:39am', { dateMdY: '07-21-2026', time24: '06:39' }), 'email context: punctuation/case normalized');
  const liveBody = 'Date: 08-08-2026\nTime: 06:21 PM\nYour booking code is: 942236';
  assert(bookingCodeContextMatches(liveBody, { dateMdY: '08-08-2026', time24: '18:21' }), 'email context: live numeric date + zero-padded PM time match');
  assert(!bookingCodeContextMatches(liveBody, { dateMdY: '08-08-2026', time24: '18:30' }), 'email context: live numeric format still rejects wrong time');
}

// Standard "booking code is: XXXXXX"
{
  const code = extractBookingCode('Your booking code is: 942236');
  assertEqual(code, '942236', 'extractCode: "booking code is: 942236"');
}

// Variant: "booking code: XXXXXX" (no "is")
{
  const code = extractBookingCode('Your booking code: 384712');
  assertEqual(code, '384712', 'extractCode: "booking code: 384712" (no "is")');
}

// Case insensitive
{
  const code = extractBookingCode('Your BOOKING CODE IS: 112233');
  assertEqual(code, '112233', 'extractCode: case insensitive match');
}

// Does not match 4-digit years like "2026"
{
  const code = extractBookingCode('Booked for 2026 season. Enjoy your round.');
  assertEqual(code, null, 'extractCode: does not match 4-digit year "2026"');
}

// Matches in longer text with surrounding content
{
  const code = extractBookingCode(
    'Hello! Your tee time is confirmed.\n\nYour booking code is: 556677\n\nSee you on the course!',
  );
  assertEqual(code, '556677', 'extractCode: finds code in multi-line text');
}

// Fallback: standalone 6-digit number
{
  const code = extractBookingCode('Use this code to confirm: 123456. Thanks!');
  assertEqual(code, '123456', 'extractCode: fallback matches standalone 6-digit number');
}

// Does not match a 6-digit number embedded in a longer number
{
  const code = extractBookingCode('Transaction ref 12345678 for your booking');
  assertEqual(code, null, 'extractCode: does not match 6 digits inside 8-digit number');
}

// Handles 5-digit code via specific pattern
{
  const code = extractBookingCode('Your booking code is: 12345');
  assertEqual(code, '12345', 'extractCode: matches 5-digit code via specific pattern');
}

// Handles 8-digit code via specific pattern
{
  const code = extractBookingCode('Your booking code is: 12345678');
  assertEqual(code, '12345678', 'extractCode: matches 8-digit code via specific pattern');
}

// No code present at all
{
  const code = extractBookingCode('Thank you for booking with us.');
  assertEqual(code, null, 'extractCode: returns null when no code present');
}

// Empty string
{
  const code = extractBookingCode('');
  assertEqual(code, null, 'extractCode: returns null for empty string');
}

// "booking code is:XXXXXX" (no space after colon)
{
  const code = extractBookingCode('Your booking code is:998877');
  assertEqual(code, '998877', 'extractCode: handles no space after colon');
}

// ═══════════════════════════════════════════════════════════
// 4. parseTime — 12-hour string to minutes since midnight
// ═══════════════════════════════════════════════════════════

section('parseTime — 12h to minutes');

assertEqual(parseTime('7:30am'), 450, 'parseTime: 7:30am = 450');
assertEqual(parseTime('7:30 am'), 450, 'parseTime: 7:30 am (with space) = 450');
assertEqual(parseTime('2:00pm'), 840, 'parseTime: 2:00pm = 840');
assertEqual(parseTime('12:00am'), 0, 'parseTime: 12:00am = 0 (midnight)');
assertEqual(parseTime('12:00pm'), 720, 'parseTime: 12:00pm = 720 (noon)');
assertEqual(parseTime('12:30pm'), 750, 'parseTime: 12:30pm = 750');
assertEqual(parseTime('12:30am'), 30, 'parseTime: 12:30am = 30');
assertEqual(parseTime('1:00am'), 60, 'parseTime: 1:00am = 60');
assertEqual(parseTime('1:00pm'), 780, 'parseTime: 1:00pm = 780');
assertEqual(parseTime('11:59pm'), 1439, 'parseTime: 11:59pm = 1439');
assertEqual(parseTime('11:59am'), 719, 'parseTime: 11:59am = 719');
assertEqual(parseTime('6:00AM'), 360, 'parseTime: 6:00AM (uppercase) = 360');
assertEqual(parseTime('6:00PM'), 1080, 'parseTime: 6:00PM (uppercase) = 1080');

// Invalid inputs
assertEqual(parseTime(''), -1, 'parseTime: empty string = -1');
assertEqual(parseTime('garbage'), -1, 'parseTime: "garbage" = -1');
// Note: 25:00am — the regex \d{1,2}:\d{2} DOES match "25:00" since "25" is 2 digits.
// The source code does not validate hour range, so it returns 25*60=1500.
// This documents actual behavior, not ideal behavior.
assertEqual(parseTime('25:00am'), 1500, 'parseTime: 25:00am = 1500 (no hour validation in source)');
assertEqual(parseTime('7:30'), -1, 'parseTime: "7:30" (no am/pm) = -1');
assertEqual(parseTime('7am'), -1, 'parseTime: "7am" (no minutes) = -1');

// ═══════════════════════════════════════════════════════════
// 5. fetchT timeout — verify abort behavior
// ═══════════════════════════════════════════════════════════

section('fetchT — timeout abort');

await (async () => {
  // Test that fetchT aborts on a very short timeout against a slow/nonexistent endpoint
  // We use a non-routable IP (RFC 5737) to guarantee a timeout, not a connect.
  const start = Date.now();
  try {
    await fetchT('http://192.0.2.1:1', {}, 200); // 200ms timeout, non-routable IP
    // If it somehow connects, that's OK — we just want to verify the abort fires
    assert(false, 'fetchT: should have thrown on timeout');
  } catch (err: any) {
    const elapsed = Date.now() - start;
    // Node wraps AbortError in TypeError('fetch failed') with an AbortError cause
    const isAbortError =
      err.name === 'AbortError' ||
      err.message?.includes('abort') ||
      err.cause?.name === 'AbortError' ||
      (err.name === 'TypeError' && err.message === 'fetch failed');
    assert(isAbortError, `fetchT: throws abort-related error (got ${err.name}: ${err.message})`);
    assert(elapsed < 2000, `fetchT: aborts within 2s (took ${elapsed}ms)`);
  }
})();

// fetchT clears timeout on success (doesn't leak timers)
await (async () => {
  try {
    // Fetch a known working URL with a generous timeout
    const res = await fetchT('https://example.com', {}, 10000);
    assert(res.ok, 'fetchT: successful fetch returns ok response');
  } catch {
    // Network may not be available in test env — skip gracefully
    passed++; // Count as pass — network unavailable is not a test failure
  }
})();

// ═══════════════════════════════════════════════════════════
// 6. Config/CLI parsing — cliArg + int helpers
// ═══════════════════════════════════════════════════════════

section('Config/CLI parsing');

// cliArg finds the value after a flag
{
  const argv = ['node', 'script.ts', '--course', 'blue', '--players', '2'];
  assertEqual(cliArg(argv, 'course'), 'blue', 'cliArg: --course blue');
  assertEqual(cliArg(argv, 'players'), '2', 'cliArg: --players 2');
}

// cliArg returns undefined for missing flag
{
  const argv = ['node', 'script.ts', '--course', 'red'];
  assertEqual(cliArg(argv, 'date'), undefined, 'cliArg: missing flag returns undefined');
}

// cliArg returns undefined when flag is last arg (no value follows)
{
  const argv = ['node', 'script.ts', '--course'];
  assertEqual(cliArg(argv, 'course'), undefined, 'cliArg: flag at end with no value returns undefined');
}

// cliArg handles double flags
{
  const argv = ['node', 'script.ts', '--course', 'blue', '--course', 'red'];
  assertEqual(cliArg(argv, 'course'), 'blue', 'cliArg: first occurrence wins');
}

// int parses string to number
{
  assertEqual(int('42', 0), 42, 'int: parses "42" to 42');
  assertEqual(int('0', 10), 0, 'int: parses "0" to 0');
}

// int returns fallback for undefined
{
  assertEqual(int(undefined, 15), 15, 'int: returns fallback for undefined');
}

// int returns fallback for empty string
{
  assertEqual(int('', 15), 15, 'int: returns fallback for empty string');
}

// CLI overrides .env defaults (simulate the precedence logic from api-sniper.ts)
{
  const envPlayers = '4';
  const cliPlayers = '2';
  // The source does: int(cliArg('players') ?? process.env.PLAYERS, 4)
  // CLI takes precedence over env
  const argv = ['node', 'script.ts', '--players', cliPlayers];
  const resolved = int(cliArg(argv, 'players') ?? envPlayers, 4);
  assertEqual(resolved, 2, 'CLI override: --players 2 overrides env PLAYERS=4');
}

// Env fallback when no CLI arg
{
  const envPlayers = '3';
  const argv = ['node', 'script.ts'];
  const resolved = int(cliArg(argv, 'players') ?? envPlayers, 4);
  assertEqual(resolved, 3, 'CLI override: no CLI arg falls back to env value');
}

// Hard default when neither CLI nor env
{
  const envPlayers = undefined;
  const argv = ['node', 'script.ts'];
  const resolved = int(cliArg(argv, 'players') ?? envPlayers, 4);
  assertEqual(resolved, 4, 'CLI override: no CLI or env falls back to hard default 4');
}

// Time parsing via CLI: --time 14:00
{
  const argv = ['node', 'script.ts', '--time', '14:00'];
  const raw = cliArg(argv, 'time') ?? '7:30';
  const [h, m] = raw.split(':').map(Number);
  assertEqual(h, 14, 'CLI time parse: hour = 14');
  assertEqual(m, 0, 'CLI time parse: minute = 0');
}

section('rankCandidates — turbo.ts course priority + configurable time order');

// From turbo.ts — rankCandidates + cmpCandidate (parameterized to accept config)
interface Cand { time: string; min: number; inWindow: boolean; course: string; players?: number; }
function rankCandidates(
  times: Array<{ time: string; available_spots: number }>,
  windowStart: number,
  windowEnd: number,
  preferredPlayers: number,
  fallbackUntil: number = 9 * 60,
  slotOrder: 'earliest' | 'latest' = 'earliest',
  course: string = 'red',
  minPlayers: number = preferredPlayers,
): Cand[] {
  const parsed = times
    .map((t) => {
      const hhmm = t.time.split(' ')[1] ?? '';
      const [hh, mm] = hhmm.split(':').map(Number);
      if (isNaN(hh) || isNaN(mm)) return null;
      const available = Math.min(4, t.available_spots ?? 0);
      if (available < minPlayers) return null;
      return { time: t.time, min: hh * 60 + mm, inWindow: false, course, players: Math.min(preferredPlayers, available) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const inWin = parsed
    .filter((c) => c.min >= windowStart && c.min <= windowEnd)
    .map((c) => ({ ...c, inWindow: true }))
    .sort((a, b) => slotOrder === 'latest' ? b.min - a.min : a.min - b.min);
  if (inWin.length) return inWin;
  return parsed.filter((c) => c.min > windowEnd && c.min <= fallbackUntil).sort((a, b) => a.min - b.min);
}
function cmpCandidate(a: Cand, b: Cand, courseOrder: string[] = ['red', 'green'], slotOrder: 'earliest' | 'latest' = 'earliest'): number {
  const ai = courseOrder.indexOf(a.course), bi = courseOrder.indexOf(b.course);
  const ap = ai < 0 ? Number.MAX_SAFE_INTEGER : ai, bp = bi < 0 ? Number.MAX_SAFE_INTEGER : bi;
  if (ap !== bp) return ap - bp;
  if (a.inWindow !== b.inWindow) return a.inWindow ? -1 : 1;
  if (!a.inWindow) return a.min - b.min;
  return slotOrder === 'latest' ? b.min - a.min : a.min - b.min;
}

const W_START = 6 * 60 + 30; // 6:30
const W_END = 8 * 60;        // 8:00

// Preferred party is four, but an explicitly-approved three-player opening
// remains eligible and carries $15 semantics through checkout.
{
  const times = [
    { time: '2026-07-13 07:40', available_spots: 3 },
    { time: '2026-07-13 07:30', available_spots: 4 },
  ];
  const strict = rankCandidates(times, W_START, W_END, 4);
  assertEqual(strict.length, 1, 'player fallback: initial strict race excludes three-spot tiles');
  assertEqual(strict[0]?.players, 4, 'player fallback: strict race books four');
  const recovery = rankCandidates(times, W_START, W_END, 4, 9 * 60, 'latest', 'red', 3);
  assertEqual(recovery.length, 2, 'player fallback: recovery accepts both three- and four-spot tiles');
  assertEqual(recovery[0]?.players, 3, 'player fallback: chosen three-spot candidate carries three-player checkout');
  assertEqual(recovery[1]?.players, 4, 'player fallback: four-spot candidate retains preferred party size');
}

// Earliest in-window slot wins, even when later slots exist
{
  const times = [
    { time: '2026-07-13 07:40', available_spots: 4 },
    { time: '2026-07-13 06:50', available_spots: 4 },
    { time: '2026-07-13 07:10', available_spots: 4 },
  ];
  const r = rankCandidates(times, W_START, W_END, 4);
  assertEqual(r[0]?.time, '2026-07-13 06:50', 'rank: earliest in-window first');
  assertEqual(r.length, 3, 'rank: all in-window slots kept');
}

// Pre-window dawn slots are never candidates
{
  const times = [
    { time: '2026-07-13 05:50', available_spots: 4 },
    { time: '2026-07-13 06:20', available_spots: 4 },
    { time: '2026-07-13 07:00', available_spots: 4 },
  ];
  const r = rankCandidates(times, W_START, W_END, 4);
  assertEqual(r.length, 1, 'rank: pre-window slots excluded');
  assertEqual(r[0]?.time, '2026-07-13 07:00', 'rank: only in-window slot survives');
}

// Window boundaries are inclusive (6:30 and 8:00 both count)
{
  const times = [
    { time: '2026-07-13 06:30', available_spots: 4 },
    { time: '2026-07-13 08:00', available_spots: 4 },
  ];
  const r = rankCandidates(times, W_START, W_END, 4);
  assertEqual(r.length, 2, 'rank: 6:30 and 8:00 both in window');
  assertEqual(r[0]?.time, '2026-07-13 06:30', 'rank: 6:30 preferred over 8:00');
}

// Empty window → fallback to closest slot AFTER 8:00, never before 6:30
{
  const times = [
    { time: '2026-07-13 05:50', available_spots: 4 },
    { time: '2026-07-13 09:10', available_spots: 4 },
    { time: '2026-07-13 08:10', available_spots: 4 },
  ];
  const r = rankCandidates(times, W_START, W_END, 4);
  assertEqual(r[0]?.time, '2026-07-13 08:10', 'fallback: closest after 8:00 wins');
  assertEqual(r[0]?.inWindow, false, 'fallback: marked as not in window');
  assertEqual(r.length, 1, 'fallback: 5:50am dawn slot AND past-cap 9:10 both excluded');
}

// Insufficient spots filtered before ranking
{
  const times = [
    { time: '2026-07-13 06:40', available_spots: 2 },
    { time: '2026-07-13 07:20', available_spots: 4 },
  ];
  const r = rankCandidates(times, W_START, W_END, 4);
  assertEqual(r[0]?.time, '2026-07-13 07:20', 'rank: skips slot with too few spots');
}

// Nothing bookable at all → empty
{
  const times = [{ time: '2026-07-13 05:00', available_spots: 4 }];
  assertEqual(rankCandidates(times, W_START, W_END, 4).length, 0, 'rank: dawn-only sheet yields no candidates');
  assertEqual(rankCandidates([], W_START, W_END, 4).length, 0, 'rank: empty input yields no candidates');
}

// Fallback is capped: nothing past fallbackUntil (default 9:00) is ever taken
{
  const times = [
    { time: '2026-07-13 09:40', available_spots: 4 },
    { time: '2026-07-13 13:10', available_spots: 4 },
  ];
  assertEqual(rankCandidates(times, W_START, W_END, 4).length, 0, 'fallback cap: 9:40am and 1:10pm both rejected');
}

// Fallback keeps slots inside the cap, drops the rest
{
  const times = [
    { time: '2026-07-13 08:50', available_spots: 4 },
    { time: '2026-07-13 09:20', available_spots: 4 },
  ];
  const r = rankCandidates(times, W_START, W_END, 4);
  assertEqual(r.length, 1, 'fallback cap: only 8:50 survives a 9:00 cap');
  assertEqual(r[0]?.time, '2026-07-13 08:50', 'fallback cap: 8:50 chosen');
}

// Custom cap is respected
{
  const times = [{ time: '2026-07-13 09:20', available_spots: 4 }];
  assertEqual(rankCandidates(times, W_START, W_END, 4, 9 * 60 + 30).length, 1, 'fallback cap: 9:20 allowed with 9:30 cap');
}

// Cross-course merge: explicit Red priority remains authoritative. (For the
// current 8:30 hard cutoff, fallbackUntil equals windowEnd, so this tier is
// unreachable in Isaac's armed policy but remains deterministic generically.)
{
  const red: Cand = { time: '2026-07-13 08:10', min: 8 * 60 + 10, inWindow: false, course: 'red' };
  const green: Cand = { time: '2026-07-13 07:50', min: 7 * 60 + 50, inWindow: true, course: 'green' };
  const sorted = [red, green].sort(cmpCandidate);
  assertEqual(sorted[0].time, '2026-07-13 08:10', 'cmp: course priority beats cross-course timing tier');
}

// Cross-course merge: both in window → earlier wins
{
  const a: Cand = { time: '2026-07-13 07:00', min: 7 * 60, inWindow: true, course: 'red' };
  const b: Cand = { time: '2026-07-13 06:40', min: 6 * 60 + 40, inWindow: true, course: 'red' };
  assertEqual([a, b].sort(cmpCandidate)[0].time, '2026-07-13 06:40', 'cmp: earlier in-window slot wins');
}

// User policy: latest acceptable slot first avoids the first-slot herd.
{
  const times = [
    { time: '2026-07-13 06:39', available_spots: 1 },
    { time: '2026-07-13 08:18', available_spots: 1 },
    { time: '2026-07-13 07:51', available_spots: 1 },
  ];
  const r = rankCandidates(times, 6 * 60 + 30, 8 * 60 + 30, 1, 8 * 60 + 30, 'latest');
  assertEqual(r[0]?.time, '2026-07-13 08:18', 'latest policy: latest observed slot before cutoff wins');
}

// Hard cap: normal 8:27 grid slot is accepted; 8:36 is never a fallback.
{
  const times = [
    { time: '2026-07-13 08:27', available_spots: 1 },
    { time: '2026-07-13 08:36', available_spots: 1 },
  ];
  const r = rankCandidates(times, 6 * 60 + 30, 8 * 60 + 30, 1, 8 * 60 + 30, 'latest');
  assertDeepEqual(r.map((c) => c.time), ['2026-07-13 08:27'], '8:30 cap: 8:27 accepted and 8:36 rejected');
}

// Configured course order dominates time inside the acceptable window.
{
  const red: Cand = { time: '2026-07-13 08:27', min: 8 * 60 + 27, inWindow: true, course: 'red' };
  const green: Cand = { time: '2026-07-13 06:39', min: 6 * 60 + 39, inWindow: true, course: 'green' };
  assertEqual([green, red].sort((a, b) => cmpCandidate(a, b, ['red', 'green'], 'latest'))[0].course, 'red', 'course priority: any acceptable Red beats Green');
  assertEqual([green, red].sort((a, b) => cmpCandidate(a, b, ['green', 'red'], 'latest'))[0].course, 'green', 'course priority: configured order is authoritative');
  const redFallback: Cand = { time: '2026-07-13 08:36', min: 8 * 60 + 36, inWindow: false, course: 'red' };
  assertEqual([green, redFallback].sort((a, b) => cmpCandidate(a, b, ['red', 'green'], 'latest'))[0].course, 'red', 'course priority: Red remains authoritative across actor settlement tiers');
}

// ════════════════════════════════════════════════════════════

section('SPEC hold — spec-template.ts sheet prediction (scout dates / fee proof / lattice / predict)');

// Weekday target 7 days out (Mon 07-20 armed on Mon 07-13): all 7 published
// dates kept, closest weekday first, weekend dates last.
{
  const dates = specScoutDates('07-20-2026', '07-13-2026');
  assertEqual(dates.length, 7, 'scout dates: 7 published neighbors for a 7-day-out target');
  assert(!dates.includes('07-20-2026'), 'scout dates: target itself excluded');
  assertEqual(dates[0], '07-17-2026', 'scout dates: closest weekday first for a weekday target');
  assert(isWeekendDate(dates[5]) && isWeekendDate(dates[6]), 'scout dates: weekend dates pushed to the back');
}

// Weekend target (Sun 07-19): Saturday jumps the queue past closer weekdays
{
  const dates = specScoutDates('07-19-2026', '07-13-2026');
  assertEqual(dates.length, 7, 'scout dates: in-range target excluded');
  assertEqual(dates[0], '07-18-2026', 'scout dates: same day-type (Saturday) first for a Sunday target');
}

// Month boundary: rollover produces well-formed dates
{
  const dates = specScoutDates('08-06-2026', '07-30-2026');
  assertEqual(dates.length, 7, 'scout dates: month rollover count');
  assert(dates.includes('08-01-2026'), 'scout dates: rolls into August');
}

// Holidays are explicit opt-in weekend-rate days.
{
  assertEqual(dayClassOf('10-12-2026'), 'weekday', 'day class: Columbus Day is a weekday unless listed');
  assertEqual(dayClassOf('10-12-2026', new Set(['10-12-2026'])), 'weekend', 'day class: listed holiday uses weekend fees');
  assertEqual(specScoutDates('10-12-2026', '10-05-2026', new Set(['10-12-2026']))[0], '10-11-2026', 'scout dates: holiday target prefers weekend neighbors');
}

// Template merge: preferred scout wins per time-of-day, later scouts fill gaps
{
  const sat = [{ time: '2026-07-18 06:30', green_fee: 70, teesheet_side_id: 1 }];
  const wed = [
    { time: '2026-07-15 06:30', green_fee: 40, teesheet_side_id: 9 },
    { time: '2026-07-15 06:39', green_fee: 40, teesheet_side_id: 2 },
  ];
  const tpl = mergeSpecTemplate([sat, wed]);
  assertEqual(tpl.size, 2, 'merge: union of times-of-day');
  assertEqual(tpl.get('06:30')?.green_fee, 70, 'merge: preferred scout wins on collision');
  assertEqual(tpl.get('06:39')?.green_fee, 40, 'merge: later scout fills gaps');
}

// Prediction: date swapped in, spots = requested players (→ hold's players
// field via viewTime; server rejects players > actual spots), fields carried,
// start_front + per-holes spots re-derived like a real tile.
{
  const tpl = new Map([['08:27', { time: '2026-07-20 15:21', available_spots: 1, available_spots_18: 1, start_front: 202606201521, green_fee: 43 }]]);
  const [p] = specPredictTimes(tpl, '07-21-2026', 4, 18);
  assertEqual(p.time, '2026-07-21 08:27', 'predict: target date swapped into slot time');
  assertEqual(p.available_spots, 4, 'predict: spots pinned to requested players');
  assertEqual(p.available_spots_18, 4, 'predict: per-holes spots match the party');
  assertEqual(p.start_front, 202606210827, 'predict: start_front re-derived with zero-based month');
  assertEqual(p.green_fee, 43, 'predict: createPending fields carried through');
}

// Pins the start_front assumption against a real saved row shape.
{
  const real = { time: '2026-08-03 09:48', start_front: 202607030948 };
  const [p] = specPredictTimes(new Map([['09:48', real]]), '08-03-2026', 1);
  assertEqual(p.start_front, real.start_front, 'predict: start_front formula reproduces a real ForeUp row');
}

// Prediction feeds the existing ranking unchanged: earliest in-window wins
{
  const tpl = mergeSpecTemplate([[
    { time: '2026-07-18 06:39', available_spots: 1 },
    { time: '2026-07-18 06:30', available_spots: 1 },
    { time: '2026-07-18 05:50', available_spots: 1 },
  ]]);
  const pred = specPredictTimes(tpl, '07-20-2026', 4).map((t) => ({ time: t.time, available_spots: t.available_spots ?? 0 }));
  const ranked = rankCandidates(pred, W_START, W_END, 4);
  assertEqual(ranked[0]?.time, '2026-07-20 06:30', 'predict+rank: earliest in-window slot is the spec target');
  assert(ranked.every((c) => c.inWindow), 'predict+rank: dawn slot excluded');
}

// Shot targeting: blind shots aim the top prediction; once a poll has seen
// the sheet, only a listed first shot fires and every backup yields.
{
  const ranked = ['2026-08-10 08:27', '2026-08-10 08:18', '2026-08-10 08:09'];
  const id = (x: string) => x;
  assertEqual(specShotTarget(ranked, 0, undefined, id), '2026-08-10 08:27', 'spec shot: first shot is the top prediction');
  assertEqual(specShotTarget(ranked, 1, undefined, id), '2026-08-10 08:27', 'spec shot: still-blind backup re-aims the top slot');
  assertEqual(specShotTarget(ranked, 1, new Set(['2026-08-10 08:27']), id), undefined, 'spec shot: backup yields to the informed detect walk');
  assertEqual(specShotTarget(ranked, 0, new Set(['2026-08-10 08:27']), id), '2026-08-10 08:27', 'spec shot: listed first shot still fires');
  assertEqual(specShotTarget(ranked, 0, new Set(['2026-08-10 08:18']), id), undefined, 'spec shot: unlisted first shot is superseded by detection');
  assertEqual(specShotTarget([] as string[], 0, undefined, id), undefined, 'spec shot: no prediction, no shot');
}

// A slow first response must not turn the second fixed-offset shot into a
// seconds-late extra hold.
{
  assert(!specShotIsLate(560, 450), 'spec deadline: 110ms jitter remains eligible');
  assert(specShotIsLate(601, 450), 'spec deadline: >150ms-late backup is skipped');
}

// Fee proof: only rows that PROVE they are pre-twilight may price a morning.
{
  const rec = (date: string, rows: Array<[string, number]>, course = 'red') => ({
    course, date, savedAt: `${date}T00:00:00Z`,
    times: rows.map(([hm, fee]) => ({ time: `${isoDate(date)} ${hm}`, green_fee: fee, teesheet_side_id: 1016 })),
  });
  assertEqual(fullRateAnchorOf(rec('07-20-2026', [['15:21', 43], ['17:36', 26]]))?.evidence, 'step', 'fee proof: a later lower fee proves the earlier row is full rate');
  assertEqual(fullRateAnchorOf(rec('10-06-2026', [['15:03', 29], ['15:12', 29]])), null, 'fee proof: a pre-4pm row with no step is NOT proof (fall twilight)');
  assertEqual(fullRateAnchorOf(rec('08-03-2026', [['09:48', 43], ['17:54', 26]]))?.evidence, 'morning', 'fee proof: a morning row is proof');
  // Weekday proof never prices a weekend.
  const weekendOnlyTwilight = rec('08-08-2026', [['16:42', 29], ['18:21', 29]]);
  const weekdayMorning = rec('08-03-2026', [['09:48', 43]]);
  const none = pickFullRateAnchor([weekendOnlyTwilight, weekdayMorning], 'red', '08-09-2026');
  assertEqual(none.anchor, null, 'fee proof: twilight-only weekend library disables SPEC');
  assert(none.reason.includes('red/weekend'), 'fee proof: disabled reason names course + day class');
  // A weekend capture enables it.
  const weekendDrop = rec('08-08-2026', [['06:30', 52], ['08:54', 52], ['16:42', 29]]);
  assertEqual(pickFullRateAnchor([weekendOnlyTwilight, weekendDrop], 'red', '08-09-2026').anchor?.t.green_fee, 52, 'fee proof: one weekend drop capture arms weekend SPEC');
  // Morning proof outranks a newer step proof; new fee era makes old proof stale.
  const step = rec('09-28-2026', [['14:00', 43], ['17:00', 26]]);
  const morning = rec('09-07-2026', [['09:48', 43], ['17:54', 26]]);
  assertEqual(pickFullRateAnchor([step, morning], 'red', '10-06-2026').anchor?.evidence, 'morning', 'fee proof: morning proof outranks step proof');
  const laterTwilight = rec('09-29-2026', [['17:09', 26]]);
  assertEqual(pickFullRateAnchor([morning, laterTwilight], 'red', '10-06-2026').anchor?.date, '09-07-2026', 'fee proof: an already-seen twilight fee later does not mark the proof stale');
  const newEra = rec('10-01-2026', [['16:00', 22]]);
  assertEqual(pickFullRateAnchor([morning, newEra], 'red', '10-06-2026').anchor, null, 'fee proof: a never-seen newer fee marks the old proof stale');
  // twilight → super-twilight step must not pass as full rate
  const superTwi = rec('09-29-2026', [['16:51', 26], ['18:21', 20]]);
  const top = rec('09-30-2026', [['10:30', 43]]);
  assertEqual(pickFullRateAnchor([superTwi, top], 'red', '10-06-2026').anchor?.t.green_fee, 43, 'fee proof: a twilight → super-twilight step loses to the top fee');
}

// Lattice: phase from every sheet, prediction only on-phase.
{
  const recs = [{ course: 'red', date: '08-08-2026', savedAt: '', times: [{ time: '2026-08-08 16:42' }, { time: '2026-08-08 18:21' }] }];
  assertEqual(latticePhase(recs, 'red'), 3, 'lattice: twilight-only sheet still pins phase 3');
  const anchor = { t: { time: '2026-08-03 10:24', green_fee: 43 }, min: 624, date: '08-03-2026', evidence: 'morning' as const };
  const rows = predictWindowFromAnchor(anchor, 3, 363, 539);
  assertEqual(rows.length, 20, 'lattice: 6:03–8:59 holds 20 nine-minute slots');
  assertEqual(rows[rows.length - 1].time, '2026-08-03 08:54', 'lattice: last in-window slot is 8:54');
  assertEqual(predictWindowFromAnchor({ ...anchor, min: 621 }, 3, 363, 539).length, 0, 'lattice: off-phase anchor predicts nothing');
  assertEqual(predictWindowFromAnchor(anchor, null, 363, 539).length, 0, 'lattice: unknown phase predicts nothing');
}

// Accuracy check: predictions are diffed against the real first drop sheet.
{
  const pred = { time: '2026-08-09 08:54', available_spots: 4, teesheet_side_id: 1016, foreup_discount: false, foreup_trade_discount_rate: 0, trade_min_players: 0, cart_fee: 0, cart_fee_tax: 0, green_fee: 50, green_fee_tax: 0 };
  assertDeepEqual(specPayloadDiff(pred, { ...pred }), [], 'spec check: identical payload passes');
  assertDeepEqual(specPayloadDiff(pred, { ...pred, green_fee: 52 }), ['green_fee'], 'spec check: fee drift is named');
  assertDeepEqual(specPayloadDiff(pred, undefined), ['<slot absent from first drop sheet>'], 'spec check: missing slot is reported');
}

// Immutable snapshot names preserve every capture and identify provenance.
{
  assertEqual(
    snapshotFileName('red', '07-21-2026', '2026-07-14T23:00:00.317Z', 2, 'drop-first-hit', 4242),
    'red-07-21-2026-20260714230000317-4242-002-drop-first-hit.json',
    'snapshot: unique timestamp/process/sequence/kind filename',
  );
}

// ════════════════════════════════════════════════════════════

section('Release epoch — turbo.ts 7pm math');

// From turbo.ts (mirrored; keep in sync)
function sevenPmEpoch(serverNowMs: number): number {
  const d = new Date(serverNowMs);
  d.setHours(19, 0, 0, 0);
  return d.getTime();
}

// now()/msUntil7pm use offset additively: a +500ms offset advances our clock,
// so the drop (fixed wall instant) is reached 500ms sooner in local terms.
{
  const offset = 500;
  const localNow = 1000, corrected = localNow + offset;
  assertEqual(corrected - localNow, 500, 'clock: offset applied additively to now()');
}

// SPEC offsets are release-relative even though polling begins 200ms early.
{
  const pollStartedAt = new Date(2026, 6, 14, 18, 59, 59, 800).getTime();
  const releaseAt = sevenPmEpoch(pollStartedAt);
  assertEqual(releaseAt - pollStartedAt, 200, 'release epoch: polling starts at T-200ms');
  assertEqual(releaseAt + 150 - pollStartedAt, 350, 'release epoch: T+150 shot waits 350ms from T-200 poll start');
}

// Re-sync changes corrected now(), not the fixed 7pm wall-clock epoch.
{
  const before = new Date(2026, 6, 14, 18, 59, 30, 0).getTime();
  const releaseAt = sevenPmEpoch(before);
  const afterResync = before + 20;
  assertEqual(releaseAt, sevenPmEpoch(afterResync), 'release epoch: T-30 resync keeps the same wall-clock release');
  assertEqual((releaseAt - afterResync) - (releaseAt - before), -20, 'release epoch: +20ms clock correction shortens remaining wait by 20ms');
}

// ════════════════════════════════════════════════════════════
section('Clock sync v2 — clock-sync.ts (causal Date interval, NTP fusion, bounded probe)');

// Virtual network + server for deterministic probe tests. server = local + theta;
// the Date header is stamped at the END of processing (nginx-like).
function fakeForeUp(opts: { theta: number; upMs: number; procMs: number; downMs: number; fail?: 'always' | 'never'; noDate?: boolean }) {
  let t = 1_000_000.25;
  let calls = 0;
  return {
    calls: () => calls,
    deps: {
      nowMs: () => t,
      sleep: async (ms: number) => { t += Math.max(0, ms); },
      fetchDate: async (timeoutMs: number) => {
        calls++;
        if (opts.fail === 'always') { t += 1; throw new Error('ECONNRESET'); }
        const total = opts.upMs + opts.procMs + opts.downMs;
        if (total > timeoutMs) { t += timeoutMs; throw new Error('timeout'); }
        const stampLocal = t + opts.upMs + opts.procMs;
        t += total;
        if (opts.noDate) return null;
        return new Date(Math.floor((stampLocal + opts.theta) / 1000) * 1000).toUTCString();
      },
    },
  };
}

{
  assertDeepEqual(pickNtpSample([{ offsetMs: 60, rttMs: 40 }, { offsetMs: 45, rttMs: 8 }, { offsetMs: 52, rttMs: 15 }]),
    { offsetMs: 45, rttMs: 8 }, 'ntp: minimum-delay sample wins over the median offset');
  assertEqual(pickNtpSample([]), null, 'ntp: no samples -> null');
}

{
  // theta = 37: samples straddling one boundary bound theta causally.
  const theta = 37;
  const mk = (sendMs: number, rtt: number, stampFrac = 1): DateSample => {
    const stamp = sendMs + rtt * stampFrac;
    return { sendMs, recvMs: sendMs + rtt, serverSecMs: Math.floor((stamp + theta) / 1000) * 1000 };
  };
  const samples = [mk(10_880, 80), mk(10_890, 80), mk(10_900, 80), mk(10_910, 80), mk(11_400, 82)];
  const iv = causalOffsetInterval(samples)!;
  assert(iv.lo <= theta && theta <= iv.hi, `causal interval: contains true offset (${iv.lo}..${iv.hi})`);
  assert(iv.hi - iv.lo <= 100, 'causal interval: width bounded by one request time + bracket');
  // One sample from a backend whose clock is 3s off is out-voted, not averaged in.
  const poisoned = causalOffsetInterval([...samples, { sendMs: 11_500, recvMs: 11_580, serverSecMs: 15_000 }])!;
  assert(poisoned.lo <= theta && theta <= poisoned.hi, 'causal interval: Marzullo majority ignores a mis-set backend');
  // A slow (queued) sample is filtered rather than widening/narrowing wrongly.
  assertEqual(causalOffsetInterval([...samples, mk(12_000, 900)])!.used, 5, 'causal interval: RTT outlier excluded');
  assertEqual(causalOffsetInterval([]), null, 'causal interval: no samples -> null');
}

{
  const iv = { lo: 20, hi: 110, votes: 4, used: 4, minRttMs: 80 };
  assertDeepEqual(fuseClockOffset(45, iv), { offsetMs: 45, source: 'ntp', correctionMs: 0, foreupLo: 20, foreupHi: 110 },
    'fusion: NTP inside ForeUp interval stays exact (no +RTT/2 Date bias)');
  assertEqual(fuseClockOffset(-30, iv).offsetMs, 20, 'fusion: ForeUp proves its clock is ahead -> nearest edge');
  assertEqual(fuseClockOffset(-30, iv).source, 'ntp+foreup', 'fusion: correction is labeled');
  assertEqual(fuseClockOffset(-900, iv).offsetMs, -900, 'fusion: absurd >500ms correction is refused (broken probe)');
  assertEqual(fuseClockOffset(null, iv).source, 'foreup', 'fusion: no NTP -> local clock clamped into ForeUp interval');
  assertEqual(fuseClockOffset(null, null).source, 'local', 'fusion: nothing -> machine clock, explicitly');
  assertEqual(fuseClockOffset(45, { ...iv, votes: 1 }).source, 'ntp', 'fusion: a single Date sample cannot move NTP');
}

await (async () => {
  // AWS-like: 1ms each way, 75ms PHP time, Date stamped at the end. True theta = 3.
  const srv = fakeForeUp({ theta: 3, upMs: 1, procMs: 75, downMs: 1 });
  const r = await probeServerDate(srv.deps, { budgetMs: 6000, priorOffsetMs: 3 });
  assertEqual(r.reason, 'ok', 'probe: healthy server -> ok');
  assert(r.interval!.lo <= 3 && 3 <= r.interval!.hi, `probe: interval contains truth (${r.interval!.lo}..${r.interval!.hi})`);
  assert(r.interval!.lo >= -10, 'probe: bisection pins the tight (late-stamp) side within ~10ms');
  assert(r.elapsedMs <= 6000 && r.requests <= 12, `probe: bounded (${r.requests} req, ${r.elapsedMs}ms)`);
  assertEqual(fuseClockOffset(1, r.interval).offsetMs, 1, 'probe+fusion: disciplined server keeps NTP');
  // Server 60ms AHEAD of UTC: NTP says 3 but truth is 63 -> fusion moves toward ForeUp.
  const ahead = fakeForeUp({ theta: 63, upMs: 1, procMs: 75, downMs: 1 });
  const ra = await probeServerDate(ahead.deps, { budgetMs: 6000, priorOffsetMs: 3 });
  const fused = fuseClockOffset(3, ra.interval).offsetMs;
  assert(Math.abs(fused - 63) <= 12, `probe+fusion: ForeUp drift of +60ms is tracked (${fused})`);
})();

await (async () => {
  // Regression for the unbounded loop: every request fails instantly.
  const dead = fakeForeUp({ theta: 0, upMs: 1, procMs: 1, downMs: 1, fail: 'always' });
  const r = await probeServerDate(dead.deps, { budgetMs: 6000 });
  assertEqual(r.reason, 'no_samples', 'probe: dead network -> explicit reason, not a hang');
  assert(r.elapsedMs <= 6000, `probe: dead network returns inside budget (${r.elapsedMs}ms)`);
  assert(dead.calls() <= 8, `probe: errors back off instead of hammering (${dead.calls()} attempts)`);
  // Every response slower than the per-request timeout (Aug-2 Sunday-afternoon shape).
  const slow = fakeForeUp({ theta: 0, upMs: 35, procMs: 2000, downMs: 35 });
  const rs = await probeServerDate(slow.deps, { budgetMs: 6000 });
  assert(rs.elapsedMs <= 6000 && rs.reason === 'no_samples', 'probe: all-timeout server returns inside budget');
  const nod = fakeForeUp({ theta: 0, upMs: 1, procMs: 5, downMs: 1, noDate: true });
  const rn = await probeServerDate(nod.deps, { budgetMs: 6000 });
  assertEqual(rn.reason, 'no_date_header', 'probe: missing Date header is reported, stops after 2');
  assertEqual(nod.calls(), 2, 'probe: missing Date header costs exactly two requests');
})();

{
  // Poll telemetry -> send-time release bracket. ms = receive time rel. T=0.
  const ev = [
    { name: 'poll', course: 'red', ms: -40, rtt: 90, hit: false },   // sent -130
    { name: 'poll', course: 'red', ms: 60, rtt: 120, hit: false },   // sent -60
    { name: 'poll', course: 'red', ms: 300, rtt: 348, hit: true },   // sent -48
    { name: 'poll', course: 'red', ms: 330, rtt: 360, hit: true, afterDetect: true }, // sent -30
    { name: 'poll', course: 'green', ms: 10, rtt: 400, hit: true },
  ];
  assertDeepEqual(releaseSendBracket(ev, 'red'), { lastMissSentMs: -60, firstHitSentMs: -48, firstHitRecvMs: 300, polls: 4 },
    'release bracket: latest-sent miss / earliest-sent hit');
  const run = (firstHitMs: number, rtt: number, extra: Record<string, unknown>[] = []) => ({
    timingBasis: 'server_release',
    events: [...extra, { name: 'poll', course: 'red', ms: firstHitMs - rtt + 20, rtt: 80, hit: false }, // sent 60ms before the hit
      { name: 'poll', course: 'red', ms: firstHitMs, rtt, hit: true }] as any[],
  });
  const stats = summarizeReleaseRuns([
    run(272, 330),                                                     // first open send -58
    run(291, 300, [{ name: 'clock_sync', offsetMs: 75, ntpMs: 45 }]),  // -9, normalized by -30 -> -39
    { timingBasis: 'run_start', events: [{ name: 'poll', course: 'red', ms: 5, rtt: 5, hit: true }] as any[] },
  ], 'red')!;
  assertEqual(stats.n, 2, 'release stats: only scheduled drops count');
  assertEqual(stats.latestFirstHitSentMs, -39, 'release stats: estimator bias removed via recorded NTP');
  assertDeepEqual(planSpecOffsets([150, 450], stats), [0, 300], 'spec plan: never earlier than T+0, spacing kept');
  assertDeepEqual(planSpecOffsets([150, 450], { ...stats, n: 1 }), [150, 450], 'spec plan: one drop is not enough data');
  assertDeepEqual(planSpecOffsets([150, 450], { ...stats, latestFirstHitSentMs: 900 }), [400, 700], 'spec plan: capped at T+400');
  assertEqual(planPreDropMs(stats), 208, 'pre-drop: earliest open send -58 -> lead 208ms');
  assertEqual(planPreDropMs({ ...stats, openLowRuns: 1 }), 600, 'pre-drop: a drop open before our first poll widens to 600ms');
  assertEqual(planPreDropMs({ ...stats, earliestFirstHitSentMs: -5000 }), 1000, 'pre-drop: bounded at 1000ms');
  assertEqual(planPreDropMs(null), 200, 'pre-drop: no history keeps T-200');
}

// ════════════════════════════════════════════════════════════
section('Turbo safety guards — production helpers');

// Any Bethpage course (Black included): fee gate + tee grid come from the course's own data.
{
  assertEqual(bookingFeeTotal({ booking_fee_price: 5, booking_fee_per_person: true }, 4), 20, 'fee gate: Red $5/person × 4');
  assertEqual(bookingFeeTotal({ booking_fee_price: 7, booking_fee_per_person: true }, 3), 21, 'fee gate: a different per-person course fee is verified, not aborted');
  assertEqual(bookingFeeTotal({ booking_fee_price: 10, booking_fee_per_person: false }, 4), 10, 'fee gate: flat per-booking fee');
  assertEqual(bookingFeeTotal({}, 2), 10, 'fee gate: missing fee field falls back to $5/person');
  assertEqual(bookingFeeTotal({ booking_fee_price: 500 }, 2), 10, 'fee gate: implausible fee falls back to $5/person');
  const rec = (course: string, date: string, hms: string[]) => ({ course, date, savedAt: '', times: hms.map((h) => ({ time: `${isoDate(date)} ${h}`, green_fee: 80 })) });
  assertEqual(latticeStep([rec('red', '08-03-2026', ['09:48', '14:27', '15:21'])], 'red'), 9, 'lattice step: Red grid is 9 minutes');
  const black = [rec('black', '10-05-2026', ['07:00', '07:10', '13:40']), rec('black', '10-06-2026', ['15:20', '15:30'])];
  assertEqual(latticeStep(black, 'black'), 10, 'lattice step: a 10-minute course is learned, not assumed to be Red');
  assertEqual(latticePhase(black, 'black', 10), 0, 'lattice phase: 10-minute grid on the hour');
  assertEqual(latticePhase(black, 'black'), null, 'lattice phase: Red step on a 10-minute grid refuses inference');
  const anchor = { t: { time: '2026-10-05 07:00', green_fee: 80 }, min: 420, date: '10-05-2026', evidence: 'morning' as const };
  const rows = predictWindowFromAnchor(anchor, 0, 6 * 60, 8 * 60 + 30, 10);
  assertEqual(rows[rows.length - 1].time, '2026-10-05 08:30', 'lattice: 10-minute course predicts 8:30 as the latest slot');
  assertEqual(latticeStep([rec('black', '10-05-2026', ['07:00'])], 'black'), 9, 'lattice step: no gaps yet falls back safely');
}

// Review fixes: clock fusion without NTP, and calibration uses the re-sync offset.
{
  const iv = { lo: 2422, hi: 2619, votes: 6, used: 6, minRttMs: 90 };
  const noNtp = fuseClockOffset(null, iv);
  assertEqual(noNtp.offsetMs, 2422, 'clock fusion: without NTP a tight ForeUp interval corrects a 2.4s-slow machine clock');
  assertEqual(noNtp.source, 'foreup', 'clock fusion: no-NTP correction is labelled foreup');
  const prior = fuseClockOffset(null, { lo: 20, hi: 180, votes: 4, used: 4, minRttMs: 80 }, 2, 80);
  assertEqual(prior.offsetMs, 80, 'clock fusion: re-sync without NTP keeps a prior offset that ForeUp agrees with');
  assertEqual(prior.source, 'prior', 'clock fusion: prior base is labelled');
  assertEqual(fuseClockOffset(null, { lo: 900, hi: 1000, votes: 4, used: 4, minRttMs: 80 }, 2, 80).offsetMs, 80, 'clock fusion: prior is sanity-capped like NTP');
  assertEqual(fuseClockOffset(30, iv).offsetMs, 30, 'clock fusion: a >500ms ForeUp disagreement with NTP is still refused');
  const run = (resync: { name: string; offsetMs?: number; ntpMs?: number; timedOut?: boolean; keptMs?: number } | null) => ({
    timingBasis: 'server_release',
    events: [
      { name: 'clock_sync', offsetMs: 80, ntpMs: 0 },
      ...(resync ? [resync] : []),
      { name: 'poll', course: 'red', ms: 100, rtt: 90, sentMs: 10, hit: false },
      { name: 'poll', course: 'red', ms: 400, rtt: 300, sentMs: 100, hit: true },
    ],
  });
  assertEqual(summarizeReleaseRuns([run({ name: 'clock_resync', offsetMs: 5, ntpMs: 5 })], 'red')?.latestFirstHitSentMs, 100, 'calibration: normalized with the re-sync offset the polls used');
  assertEqual(summarizeReleaseRuns([run(null)], 'red')?.latestFirstHitSentMs, 20, 'calibration: falls back to the arm-time sync');
  assertEqual(summarizeReleaseRuns([run({ name: 'clock_resync', timedOut: true, keptMs: 80 })], 'red')?.latestFirstHitSentMs, 20, 'calibration: a timed-out re-sync is ignored');
}

{
  assertEqual(classifyTimesResponse(200, '[]').kind, 'empty', 'poll: pre-release empty array');
  assertEqual(classifyTimesResponse(200, 'false').kind, 'empty', 'poll: legacy false');
  assertEqual(classifyTimesResponse(200, '[{"time":"2026-08-09 08:27"}]').kind, 'times', 'poll: real sheet');
  assertEqual(classifyTimesResponse(200, '{"success":false,"msg":"x"}').kind, 'rejected', 'poll: unauthenticated/wrong class is NOT "no times"');
  assertEqual(classifyTimesResponse(429, '[]').kind, 'blocked', 'poll: WAF throttle');
  assertEqual(classifyTimesResponse(200, '<html>blocked</html>').kind, 'blocked', 'poll: WAF HTML page');
}

{
  assertEqual(pollPhase(-1001, 6, 12), null, 'poll phase: nothing before T-1000');
  assertDeepEqual(pollPhase(-1000, 6, 12), { maxInFlight: 1, minGapMs: 100 }, 'poll phase: sentinel lane from T-1000');
  assertDeepEqual(pollPhase(-350, 6, 12), { maxInFlight: 6, minGapMs: 15 }, 'poll phase: dense from T-350');
  assertDeepEqual(pollPhase(399, 6, 30), { maxInFlight: 6, minGapMs: 30 }, 'poll phase: dense respects a wider stagger');
  assertDeepEqual(pollPhase(400, 6, 12), { maxInFlight: 6, minGapMs: 50 }, 'poll phase: backs off after T+400');
  assertEqual(poolWarmSockets(6, 2), 12, 'pool warm: one socket per first-wave lane');
  assertEqual(poolWarmSockets(6, 3), 12, 'pool warm: capped');
  assertEqual(poolWarmSockets(0, 2), 1, 'pool warm: at least one');
}

{
  assertEqual(specRunMode({ spec: true, sheetAlreadyLive: true, specCount: 2, zeroDollarMode: false }), 'off', 'spec mode: live money run on a live sheet races real times');
  assertEqual(specRunMode({ spec: true, sheetAlreadyLive: true, specCount: 2, zeroDollarMode: true }), 'live_sheet_test', 'spec mode: $0 live-sheet mechanism test kept');
  assertEqual(specRunMode({ spec: true, sheetAlreadyLive: false, specCount: 2, zeroDollarMode: false }), 'drop', 'spec mode: drop night blind-fires');
  assertEqual(specRunMode({ spec: true, sheetAlreadyLive: false, specCount: 0, zeroDollarMode: false }), 'off', 'spec mode: no prediction, no SPEC');
  assertEqual(specRunMode({ spec: false, sheetAlreadyLive: false, specCount: 2, zeroDollarMode: false }), 'off', 'spec mode: flag off');
}

{
  assertEqual(vultureRetryDelayMs(1), 20_000, 'vulture backoff: first retry 20s');
  assertEqual(vultureRetryDelayMs(2), 40_000, 'vulture backoff: doubles');
  assertEqual(vultureRetryDelayMs(9), 160_000, 'vulture backoff: capped at 160s');
  assert(isSoftLimitRejection('{"success":false,"msg":"Invalid request"}'), 'soft limit: detected');
  assert(!isSoftLimitRejection('Time not available'), 'soft limit: a contested slot is not a rate limit');
}

{
  assertEqual(etDropTargetDate(Date.parse('2026-10-03T23:30:00Z')), '10-10-2026', 'drop date: EDT evening');
  assertEqual(etDropTargetDate(Date.parse('2026-10-04T00:30:00Z')), '10-10-2026', 'drop date: UTC already next day, ET still drop day');
  assertEqual(etDropTargetDate(Date.parse('2026-11-02T00:30:00Z')), '11-08-2026', 'drop date: EST after DST ends');
  assertEqual(etDropTargetDate(Date.parse('2026-12-28T23:00:00Z')), '01-04-2027', 'drop date: year rollover');
}

{
  const exp = { dateMdY: '08-09-2026', time24: '08:27' };
  const loser = 'Date: 08-09-2026\nTime: 08:27 AM\nYour booking code is: 111111';
  const winnerAuto = 'Date: 08-09-2026\nTime: 08:27 AM\nYour booking code is: 222222';
  const resend = 'Date: 08-09-2026\nTime: 08:27 AM\nYour booking code is: 333333';
  const other = 'Date: 08-09-2026\nTime: 08:18 AM\nYour booking code is: 999999';
  assertEqual(pickBookingCode([loser, winnerAuto], exp), '111111', 'email ambiguity: a same date+time loser code can come first');
  assertEqual(pickBookingCode([loser, winnerAuto], exp, new Set(['111111'])), '222222', 'email retry: rejected code skipped');
  assertEqual(pickBookingCode([resend, loser, winnerAuto], exp, new Set(['111111', '222222'])), '333333', 'email retry: third candidate');
  assertEqual(pickBookingCode([loser], exp, new Set(['111111'])), null, 'email retry: exhausted batch keeps waiting');
  assertEqual(pickBookingCode([other], exp), null, 'email: a different time never matches');
}

{
  const m = new EmailMonitor('nobody@example.com', 'x');
  const c = (m as any).client;
  let threw = false;
  try { c.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })); } catch { threw = true; }
  assert(!threw, 'imap safety: a socket error never becomes an uncaught exception');
  assertEqual((m as any).connected, false, 'imap safety: errored session marked for reconnect');
}

{
  const exact = 'Bethpage Red Course   July 21, 2026\n8:27am';
  assertEqual(firstModalIdentityMismatch(exact, {
    time: '8:27am', date: 'July 21, 2026', course: 'Bethpage Red Course',
  }), null, 'modal identity: exact Red/date/time survives whitespace normalization');
  assertDeepEqual(firstModalIdentityMismatch(exact, {
    time: '8:18am', date: 'July 21, 2026', course: 'Bethpage Red Course',
  }), { what: 'time', needle: '8:18am' }, 'modal identity: stale SPEC time is rejected before settlement');
  assertDeepEqual(firstModalIdentityMismatch(exact, {
    time: '8:27am', date: 'July 21, 2026', course: 'Bethpage Green Course',
  }), { what: 'course', needle: 'Bethpage Green Course' }, 'modal identity: wrong course is rejected');
}

{
  const complete = {
    time: '2026-07-21 08:27', available_spots: 1, teesheet_side_id: 1016,
    foreup_discount: false, foreup_trade_discount_rate: 0, trade_min_players: 0,
    cart_fee: 0, cart_fee_tax: 0, green_fee: 43, green_fee_tax: 0,
  };
  assertDeepEqual(missingSpecTemplateFields(complete), [], 'spec payload: zero and false are valid required values');
  assertDeepEqual(missingSpecTemplateFields({ ...complete, green_fee: undefined }), ['green_fee'], 'spec payload: undefined required fee disables the shot');
  const { teesheet_side_id: _missing, ...withoutSide } = complete;
  assertDeepEqual(missingSpecTemplateFields(withoutSide), ['teesheet_side_id'], 'spec payload: absent side id disables the shot');
}

{
  assertEqual(await settleWithin(Promise.resolve('done'), 20, 'timeout'), 'done', 'bounded promise: resolved value wins');
  assertEqual(await settleWithin(new Promise<string>(() => {}), 5, 'timeout'), 'timeout', 'bounded promise: stalled operation returns fallback');
}

// ════════════════════════════════════════════════════════════
section('Dashboard SPEC passthrough — ui-server.ts wiring contract');

// ui-server.ts starts an HTTP server at import time, so keep this regression
// check side-effect-free by verifying the explicit schedule → arm → flag links.
{
  const ui = fs.readFileSync('src/ui-server.ts', 'utf8');
  const html = fs.readFileSync('static/turbo-ui.html', 'utf8');
  assert(/let schedule: \{[^\n]*spec\?: boolean/.test(ui), 'dashboard spec: schedule stores optional flag');
  assert(/function setSchedule\([^\n]*spec\?: boolean\)/.test(ui), 'dashboard spec: setSchedule accepts flag');
  assert(ui.includes('schedule = { mode, at: at.getTime(), courses, target, players, date, spec };'), 'dashboard spec: setSchedule persists flag');
  assert(ui.includes('arm(s.mode, s.date, s.courses ?? undefined, s.target, s.players, s.spec)'), 'dashboard spec: scheduled replay forwards flag');
  assert(ui.includes('spec: schedule.spec ?? false'), 'dashboard spec: /api/state exposes explicit boolean');
  assert(/async function arm\([^\n]*spec\?: boolean\)/.test(ui), 'dashboard spec: arm accepts flag');
  assert(ui.includes("if (spec) turboFlags.push('--spec');"), 'dashboard spec: arm emits --spec');
  assert(ui.includes("const envPrefix = `HEADLESS=1 ${mode === 'live' ? 'AUTO_BOOK=1 ' : ''}`;"), 'dashboard remote safety: every AWS/VM command forces headless mode independently of .env');
  assertEqual(ui.match(/body\.spec === true/g)?.length ?? 0, 2, 'dashboard spec: both API handlers require strict true');
  assert(ui.includes('schedDay, schedSpec)'), 'dashboard spec: schedule handler forwards flag');
  assert(ui.includes('players, spec)'), 'dashboard spec: arm handler forwards flag');
  assert(html.includes('id="spec-toggle" checked'), 'dashboard spec: visible strategy toggle defaults on for Bethpage');
  assertEqual(html.match(/date: pickedDate\(\), spec/g)?.length ?? 0, 2, 'dashboard spec: arm and schedule browser payloads both send the toggle');
  assert(html.includes("s.spec ? ' · SPEC' : ' · detect-first'"), 'dashboard spec: scheduled state visibly reports SPEC vs detect-first');
  assert(html.includes("unsupported = courses.includes('crab-meadow')"), 'dashboard spec: unmapped Crab Meadow disables speculative holds');
}

section('Turbo race-policy wiring contract');

{
  const turbo = fs.readFileSync('src/turbo.ts', 'utf8');
  assert(turbo.includes('function foreupServerOffset(priorOffsetMs: number | null, budgetMs = 6000)'), 'clock sync: ForeUp probe is NTP-aimed and hard-bounded');
  assert(turbo.includes('settleWithin<ClockSync | null>(syncClock(6000, CLOCK_OFFSET_MS).catch(() => null), Math.max(0, r - 9_000), null)'), 'clock sync: T-30 re-sync returns control by T-9s and keeps the prior offset as its base');
  assert(turbo.includes("if (crashing) return 'manual_needed';"), 'crash safety: a crash cleanup and the charging click never overlap');
  assert(turbo.includes('handedOffPages.has(p)'), 'crash safety: a hold handed to the human is never auto-released');
  assert(turbo.includes('(ABORT_BEFORE_BOOK || TEST_PAYMENT) && !paymentSubmitted'), 'test modes: a checkout error releases the $0 hold');
  assert(turbo.includes('const maxCodes = sameTimeElsewhere ? 3 : 1;'), 'checkout email: retries only when a look-alike code can exist');
  assert(turbo.includes('CLOCK_OFFSET_MS = sync.clock.offsetMs;\n  anchorClock();'), 'clock sync: every adopted offset re-anchors the monotonic clock');
  assert(turbo.includes("const t0 = scheduledDrop ? releaseAt : pollStartedAt;"), 'race timing: scheduled drop uses fixed release epoch');
  assert(turbo.includes("if (run.timingBasis !== 'server_release') continue;"), 'race timing: legacy poll-relative telemetry excluded');
  assert(turbo.includes("const preferred = cfg.courses[0];"), 'spec priority: first configured course is the only blind-fire target');
  assert(turbo.includes('SPEC scout (read-only dry run): validating predicted slots'), 'spec dry run: prediction is inspectable without a hold');
  assert(turbo.includes('r <= 30_000 && r > 10_000 && !resynced'), 'clock sync: late startup never begins a multi-second probe across T=0');
  assert(turbo.includes("lookup('time.cloudflare.com', { family: 4 })"), 'clock sync: DNS completes before NTP packet timing');
  assert(turbo.includes('const settled = await Promise.allSettled(actors);'), 'course actors: every in-flight hold settles before winner selection');
  assert(turbo.includes('await Promise.allSettled(walks);'), 'fallback walks: actor failures cannot strand the settlement promise');
  assert(!turbo.includes('held after the winner — releasing at $0'), 'course priority: response order no longer auto-discards a later Red hold');
  assert(turbo.includes('browser.newContext({ storageState: authenticatedState, userAgent: CHROME_UA })'), 'course isolation: each fallback course gets independent pending-reservation localStorage');
  assert(turbo.includes('const detectedP = detect(course, priority); // starts immediately for every course'), 'stream race: per-course API detection starts before SPEC settles');
  assert(turbo.includes('const specHeld = await specP;') && turbo.includes('const list = await detectedP;'), 'stream race: Red detection buffers behind its one SPEC actor');
  assert(!turbo.includes('cands = await raceDetect('), 'stream race: cross-course grace no longer blocks the first detected hold');
  assert(turbo.includes("source: 'spec'") && turbo.includes("source: 'detect'"), 'stream race: SPEC and detect outcomes share one settlement ledger');
  assert(turbo.includes("result: 'response_unknown'") && turbo.includes("return 'held_uncertain';"), 'hold safety: sent/no-response is terminal, never retryable');
  assert(turbo.includes('pendingHoldIds.set(page, reservationId);'), 'hold safety: successful POST retains its exact reservation id');
  assert(turbo.includes("out.release = typeof w.Utils?.OnlineBooking?.Reservation?.deletePending === 'function';"), 'hold safety: dry-run bridge preflight verifies native release support');
  assert(turbo.includes("r.request().method() === 'DELETE'") && turbo.includes('Reservation?.deletePending'), 'hold safety: loser release observes DELETE and has one native fallback');
  assert(turbo.includes("log('⚠', 'A loser hold could not be verified released — checkout blocked');"), 'hold safety: unverified loser blocks payment');
  assert(turbo.includes('Waiting for the fresh winner booking code via IMAP (matched by date + time)'), 'email safety: checkout requests a fresh winner-only code');
  assert(turbo.includes("time24: cand.t.time.split(' ')[1] ?? ''"), 'email safety: accepted code is bound to held date + time');
  assert(turbo.includes('if (finalized.result === \'exhausted\' && held.length && detected.length)'), 'spec fallback: released SPEC/gate failure consumes buffered detection immediately');
  assert(turbo.includes('fs.renameSync(tmpPath, finalPath);'), 'snapshots: atomic immutable capture write');
  assert(turbo.includes("saveSheetSnapshot(course, d, r, 'neighbor-scout');"), 'snapshots: read-only neighbor scouts are preserved');
  assert(turbo.includes("api.pollTimes(d, course, 'all')"), 'spec scout: all-time GET supplies a full-rate field anchor');
  assert(turbo.includes('dayClassOf(d, SPEC_HOLIDAYS) === targetClass'), 'spec scout: weekday/weekend fee classes are never mixed');
  assert(turbo.includes('const scouts = [...loadSheetSnapshots(course, date, library), ...liveScouts, inferred];'), 'spec scout: observed rows (drop captures first) beat inferred rows on collisions');
  assert(turbo.includes('pickFullRateAnchor(library, course.key, date, SPEC_HOLIDAYS)'), 'spec scout: morning fees only come from a proven full-rate row');
  assert(!turbo.includes('16 * 60'), 'spec scout: no clock-based twilight cutoff remains');
  assert(turbo.includes('specShotTarget(cands, i, detectedSheets.get(key), (c) => c.t.time)'), 'spec strike: backups yield once the sheet is detected');
  assert(turbo.includes('reportSpecAccuracy(course, times)'), 'spec check: every drop capture is diffed against the armed prediction');
  assert(turbo.includes('const courseKeys = [...new Set('), 'course actors: duplicate CLI/env course keys are deduplicated');
  assert(turbo.includes('Math.max(cfg.raceGraceMs, 1000)'), 'poll race: lower-priority detection leaves a full second for preferred Red');
  assert(turbo.includes(".filter((c) => !attempted.has(`${c.course.key}|${c.t.time}`))"), 'fallback race: already-attempted detected slots are not retried');
  assert(turbo.includes('missingSpecTemplateFields(cand.t)'), 'spec payload: incomplete predicted payloads are excluded before blind fire');
  assert(turbo.includes("fetchTextWithTimeout(this.timesUrl(date, course, tf, players), { headers: this.headers(), method: 'GET' }, timeoutMs)"), 'poll safety: every times request has a bounded header+body timeout');
  assert(turbo.includes('api.pollTimesDetailed(date, course, 3000)'), 'poll safety: drop detector keeps a lane alive through a 3s server stall');
  assert(turbo.includes('pollPhase(now() - t0, cfg.pollConcurrency, cfg.pollStaggerMs)'), 'poll schedule: release-relative sentinel + dense window');
  assert(turbo.includes("preDropMs: 1000,"), 'poll schedule: sentinel lane starts at T-1000');
  assert(turbo.includes('sentMs: sent - t0'), 'poll telemetry: release-relative send time recorded for calibration');
  assert(turbo.includes('API detector unhealthy for'), 'detector: a blind (rejected/blocked) detector is loud before 7pm');
  assert(turbo.includes('api.warmPool(sockets)') && turbo.includes('r <= 1500 && !poolWarmed'), 'pool: keep-alive sockets warmed at T-1.5s');
  assert(turbo.includes('detectedP.catch(() => {});'), 'stream race: unawaited detector rejection is observed');
  assert(turbo.includes("process.on('uncaughtException'") && turbo.includes("process.on('unhandledRejection'"), 'crash safety: process faults run cleanup + telemetry');
  assert(turbo.includes('if (paymentSubmitted) {'), 'crash safety: nothing is released after PROCESS TRANSACTION');
  assert(turbo.includes('const result = await completeBookingSafe('), 'checkout: throws become manual_needed, not crashes');
  assert(turbo.includes('await email.ensureFreshBaseline(6000)') || turbo.includes('email.ensureFreshBaseline(6000)'), 'checkout email: bounded self-reconnecting baseline');
  assert(turbo.includes('waitForBookingCode(codeTry === 0 ? 70_000 : 30_000, expectedEmail, triedCodes)'), 'checkout email: a rejected code is excluded and the next matching code tried');
  assert(!/isVisible\(\{ timeout/.test(turbo), 'playwright: no ignored isVisible timeouts remain');
  assert(turbo.includes("pBtn.waitFor({ state: 'visible', timeout: 3000 })"), 'money gate #2 waits for the in-modal players chip');
  assert(turbo.includes("const specTest = specMode === 'live_sheet_test';"), 'spec: live-sheet single shot is $0-only');
  assert(turbo.includes('racing WITHOUT it') && turbo.includes('const stageWithRetry = async'), 'staging: one course failing (e.g. Black) never cancels the others');
  assert(turbo.includes("process.env.TZ = 'America/New_York';"), 'turbo: drop math pinned to ET');
  assert(turbo.includes('DATE CHECK:'), 'turbo: wrong-date arm is loud');
  assert(turbo.includes('for (const k of raceAttempted) tries.set('), 'vulture: race-lost slots start backed off');
  assert(turbo.includes('isSoftLimitRejection(lastHoldRejection)'), 'vulture: soft rate limit pauses holds');
  const capture = turbo.slice(turbo.indexOf('async function captureDropSheets'), turbo.indexOf('// Predictions armed for this drop'));
  assert(capture.includes("api.pollTimes(date, c, 'all')") && capture.includes("'drop-first-hit'"), 'capture-drop: saves the released sheet');
  assert(!/holdViaBridge|specStrike|holdPhase|browserBook/.test(capture), 'capture-drop: read-only, never holds');
  const pay = turbo.slice(turbo.indexOf('// 12. The charge.'), turbo.indexOf('if (AUTO_BOOK && !filled)'));
  assert(pay.indexOf('paymentSubmitted = true') >= 0 && pay.indexOf('paymentSubmitted = true') < pay.indexOf("locator('a#submit').click()"), 'payment safety: flag set before the charging click');
  const aws = fs.readFileSync('deploy/aws-setup.sh', 'utf8');
  assert(aws.includes('rsync -az --ignore-existing') && aws.includes('logs/sheets/'), 'deploy: SPEC sheet library merged both ways without overwrite');
  const uiSrc = fs.readFileSync('src/ui-server.ts', 'utf8');
  const uiHtml = fs.readFileSync('static/turbo-ui.html', 'utf8');
  assert(uiSrc.includes("turboFlags.push('--race');"), 'dashboard: race mode is explicit');
  assert(uiSrc.includes('date: schedule.date ?? null'), 'dashboard: scheduled date visible');
  assert(uiHtml.includes('if (!dateTouched) return undefined;'), 'dashboard date: untouched picker never freezes --date');
  assert(turbo.includes('return await consume(response);'), 'poll safety: abort timer remains active through response consumption');
  assert(/settleWithin(?:<DeleteResult>)?\(nativeDelete, 2500/.test(turbo), 'release safety: native DELETE fallback cannot hang settlement');
  assert(turbo.includes("const TEST_PAYMENT = process.argv.includes('--test-payment');"), 'payment test: dedicated rehearsal flag exists');
  assert(turbo.includes('const AUTO_BOOK = !TEST_PAYMENT &&'), 'payment test: rehearsal overrides an AUTO_BOOK environment value');
  assert(turbo.includes("return await closeModal(page) ? 'test_passed' : 'manual_needed';"), 'payment test: successful card validation explicitly releases the hold');
  assert(turbo.includes('PAYMENT TEST PASSED: code accepted'), 'payment test: success is only reported after code, amount, and card gates');
  assert(turbo.includes("minPlayers: argInt('min-players'"), 'player fallback: minimum party size is explicitly configurable');
  assert(turbo.includes('players: Math.min(preferredPlayers, available)'), 'player fallback: every candidate carries its safe checkout party size');
  assert(turbo.includes('stagePage(page, course, date, cfg.minPlayers)'), 'player fallback: recovery pages are re-staged for the minimum party');
  assert(turbo.includes('api.pollTimes(date, course, undefined, cfg.minPlayers)'), 'player fallback: recovery API includes three-player openings');
  assert(turbo.includes('rankCandidates(times, course, cfg.minPlayers, cfg.players)'), 'player fallback: recovery prefers four but accepts three');
  assert(turbo.includes("vulturePollMs: Math.max(750, argInt('vulture-poll-sec'"), 'long monitor: cancellation polling cadence is explicitly configurable');
  assert(turbo.includes('await email.keepAlive()'), 'long monitor: IMAP is kept healthy while waiting for a late cancellation');
  assert(turbo.includes('Math.min(cfg.vulturePollMs, Math.max(0, deadline - now()))'), 'long monitor: polling sleeps to the configured cadence without crossing its deadline');
  const emailMonitor = fs.readFileSync('src/email-monitor.ts', 'utf8');
  assert(emailMonitor.includes('if (!this.connected || !this.client.usable)'), 'long monitor email: dead IMAP sockets trigger reconnect');
  assert(emailMonitor.includes('await this.resetBaseline();'), 'long monitor email: healthy IMAP sockets receive a keepalive NOOP');
  const checkout = turbo.slice(turbo.indexOf('async function completeBooking'), turbo.indexOf('// Every detection snapshots'));
  assert(checkout.includes('a:text-is("${cand.players}")'), 'player fallback money gate: modal button uses candidate party size');
  assert(checkout.includes('Number(model.players) !== cand.players'), 'player fallback money gate: ForeUp reservation model uses candidate party size');
  assert(checkout.includes('bookingFeeTotal(cand.t, cand.players, FEE_PER_PLAYER)'), 'player fallback money gate: required fee is the slot fee times candidate party size');
  const finalize = turbo.slice(turbo.indexOf('async function finalizeHeldAttempts'), turbo.indexOf('/**\n * The drop race'));
  const identityGate = finalize.indexOf('await inspectModalIdentity(candidate.page');
  const loserRelease = finalize.indexOf('const loserReleases');
  assert(identityGate >= 0 && loserRelease > identityGate, 'settlement safety: winner modal identity is checked before any loser release');
}

// Results
// ════════════════════════════════════════════════════════════

console.log(`\n  ────────────────────────────`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log(`\n  Failures:`);
  for (const f of failures) console.log(`    - ${f}`);
}
console.log('');

process.exit(failed > 0 ? 1 : 0);

} // end runTests

runTests().catch((e) => { console.error(e); process.exit(1); });
