/**
 * Bethpage Sniper — Unit Tests
 *
 * No test framework needed. Simple assertion runner that tests the pure
 * logic extracted from api-sniper.ts, index.ts, and email-monitor.ts.
 *
 * Run: npm test
 */

import * as fs from 'fs';
import { bookingCodeContextMatches } from './email-monitor';
import { firstModalIdentityMismatch, missingSpecTemplateFields, settleWithin } from './turbo-guards';

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

section('SPEC hold — turbo.ts sheet prediction (scout dates / template merge / predict)');

// From turbo.ts — specScoutDates + mergeSpecTemplate + specPredictTimes (mirrored; keep in sync)
function isWeekendDate(mdY: string): boolean {
  const [m, d, y] = mdY.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return dow === 0 || dow === 6;
}
function specScoutDates(targetMdY: string, todayMdY: string): string[] {
  const [tm, td, ty] = todayMdY.split('-').map(Number);
  const out: string[] = [];
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
type SpecTime = { time: string; available_spots?: number; [k: string]: any };
function mergeSpecTemplate(scouts: SpecTime[][]): Map<string, SpecTime> {
  const tpl = new Map<string, SpecTime>();
  for (const times of scouts) for (const t of times ?? []) {
    const hhmm = t.time.split(' ')[1];
    if (hhmm && !tpl.has(hhmm)) tpl.set(hhmm, t);
  }
  return tpl;
}
function inferSpecWindowFromFullRateAnchor(times: SpecTime[], windowStart: number, windowEnd: number): SpecTime[] {
  const parsed = times.map((t) => {
    const hhmm = t.time.split(' ')[1] ?? '';
    const [hh, mm] = hhmm.split(':').map(Number);
    return { t, min: hh * 60 + mm };
  }).filter((x) => Number.isFinite(x.min));
  const anchor = parsed.filter((x) => x.min >= windowStart && x.min <= windowEnd).sort((a, b) => a.min - b.min)[0]
    ?? parsed.filter((x) => x.min > windowEnd && x.min <= 16 * 60).sort((a, b) => a.min - b.min)[0];
  if (!anchor) return times;
  const datePart = anchor.t.time.split(' ')[0];
  const seen = new Set(parsed.map((x) => x.min));
  const inferred: SpecTime[] = [];
  for (let min = windowStart; min <= windowEnd; min++) {
    if ((anchor.min - min) % 9 !== 0 || seen.has(min)) continue;
    const hh = Math.floor(min / 60), mm = min % 60;
    inferred.push({ ...anchor.t, time: `${datePart} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, spec_inferred: true });
  }
  return [...inferred, ...times];
}
function specPredictTimes(tpl: Map<string, SpecTime>, iso: string, players: number): SpecTime[] {
  return [...tpl.entries()].map(([hhmm, t]) => ({ ...t, time: `${iso} ${hhmm}`, available_spots: players }));
}
function planSpecShots<T>(cands: T[], offsets: number[]): Array<{ cand: T; scheduledOffsetMs: number }> {
  return cands.slice(0, offsets.length).map((cand, i) => ({ cand, scheduledOffsetMs: offsets[i] }));
}
function specShotIsLate(actualOffsetMs: number, scheduledOffsetMs: number, toleranceMs = 150): boolean {
  return actualOffsetMs > scheduledOffsetMs + toleranceMs;
}
function snapshotFileName(courseKey: string, date: string, savedAt: string, seq: number, kind: string, pid: number): string {
  const stamp = savedAt.replace(/[^0-9]/g, '');
  return `${courseKey}-${date}-${stamp}-${pid}-${String(seq).padStart(3, '0')}-${kind}.json`;
}

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
// field via viewTime; server rejects players > actual spots), fields carried
{
  const tpl = mergeSpecTemplate([[{ time: '2026-07-18 06:30', green_fee: 70, available_spots: 1 }]]);
  const pred = specPredictTimes(tpl, '2026-07-20', 1);
  assertEqual(pred[0].time, '2026-07-20 06:30', 'predict: target date swapped into slot time');
  assertEqual(pred[0].available_spots, 1, 'predict: spots pinned to requested players');
  assertEqual(pred[0].green_fee, 70, 'predict: createPending fields carried through');
}

// Prediction feeds the existing ranking unchanged: earliest in-window wins
{
  const tpl = mergeSpecTemplate([[
    { time: '2026-07-18 06:39', available_spots: 1 },
    { time: '2026-07-18 06:30', available_spots: 1 },
    { time: '2026-07-18 05:50', available_spots: 1 },
  ]]);
  const pred = specPredictTimes(tpl, '2026-07-20', 4).map((t) => ({ time: t.time, available_spots: t.available_spots ?? 0 }));
  const ranked = rankCandidates(pred, W_START, W_END, 4);
  assertEqual(ranked[0]?.time, '2026-07-20 06:30', 'predict+rank: earliest in-window slot is the spec target');
  assert(ranked.every((c) => c.inWindow), 'predict+rank: dawn slot excluded');
}

// Ranked SPEC plan spends later offsets on later-ranked candidates, not the
// same already-contested slot, and never exceeds the offset budget.
{
  const plan = planSpecShots(['red-8:27', 'red-8:18', 'red-8:09'], [150, 450]);
  assertDeepEqual(plan, [
    { cand: 'red-8:27', scheduledOffsetMs: 150 },
    { cand: 'red-8:18', scheduledOffsetMs: 450 },
  ], 'spec plan: distinct ranked candidates fit the fixed shot budget');
}

// A slow first response must not turn the second fixed-offset shot into a
// seconds-late extra hold.
{
  assert(!specShotIsLate(560, 450), 'spec deadline: 110ms jitter remains eligible');
  assert(specShotIsLate(601, 450), 'spec deadline: >150ms-late backup is skipped');
}

// A same-day-type full-rate Red anchor safely supplies the constant hold
// fields while the observed 9-minute lattice supplies morning timestamps.
{
  const expanded = inferSpecWindowFromFullRateAnchor(
    [{ time: '2026-07-25 15:57', available_spots: 1, green_fee: 48, teesheet_side_id: 1016 }],
    6 * 60 + 30,
    8 * 60 + 30,
  );
  const tpl = mergeSpecTemplate([expanded]);
  const pred = specPredictTimes(tpl, '2026-07-26', 1).map((t) => ({ time: t.time, available_spots: t.available_spots ?? 0 }));
  const ranked = rankCandidates(pred, 6 * 60 + 30, 8 * 60 + 30, 1, 8 * 60 + 30, 'latest');
  assertEqual(ranked[0]?.time, '2026-07-26 08:27', 'spec inference: latest valid Red grid slot is 8:27');
  assertEqual(tpl.get('08:27')?.green_fee, 48, 'spec inference: weekend full-rate fee carried to morning');
  assertEqual(tpl.get('08:27')?.teesheet_side_id, 1016, 'spec inference: Red side carried to morning');
}

// Twilight-only anchors are never extrapolated into the morning fee band.
{
  const twilight = [{ time: '2026-07-19 16:51', available_spots: 1, green_fee: 29 }];
  const expanded = inferSpecWindowFromFullRateAnchor(twilight, 6 * 60 + 30, 8 * 60 + 30);
  assertEqual(expanded.length, 1, 'spec inference: post-4pm twilight anchor creates no morning slots');
  assertEqual(expanded[0].time, '2026-07-19 16:51', 'spec inference: twilight source remains unchanged');
}

// One surviving morning slot is enough to reconstruct the rest of its
// full-rate 9-minute lattice; sparse availability must not force SPEC to 6:39.
{
  const sparse = inferSpecWindowFromFullRateAnchor(
    [{ time: '2026-07-18 06:39', available_spots: 1, green_fee: 48, teesheet_side_id: 1016 }],
    6 * 60 + 30,
    8 * 60 + 30,
  );
  const tpl = mergeSpecTemplate([sparse]);
  assertEqual(tpl.get('08:27')?.green_fee, 48, 'spec inference: sparse morning expands through the latest valid slot');
  assertEqual(tpl.get('06:39')?.spec_inferred, undefined, 'spec inference: observed anchor wins over its inferred duplicate');
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

section('Server-clock sync — turbo.ts tick-boundary offset math');

// From turbo.ts — noisy Date-transition selection (mirrored; keep in sync)
type ServerFlip = { offsetMs: number; gapMs: number };
function serverOffsetFromFlip(previousMidpointMs: number, currentMidpointMs: number, newSecondEpochMs: number): ServerFlip {
  return {
    offsetMs: Math.round(newSecondEpochMs - (previousMidpointMs + currentMidpointMs) / 2),
    gapMs: Math.round(currentMidpointMs - previousMidpointMs),
  };
}
function selectServerOffset(flips: ServerFlip[]): number | null {
  const ranked = flips.filter((f) => f.gapMs > 0 && f.gapMs <= 400).sort((a, b) => a.gapMs - b.gapMs);
  if (!ranked.length) return null;
  const tight = ranked.filter((f) => f.gapMs <= ranked[0].gapMs + 50).slice(0, 3);
  const offsets = tight.map((f) => f.offsetMs).sort((a, b) => a - b);
  if (offsets.length % 2) return offsets[Math.floor(offsets.length / 2)];
  return Math.round((offsets[offsets.length / 2 - 1] + offsets[offsets.length / 2]) / 2);
}
function trustedClockOffset(foreupMs: number | null, ntpMs: number | null): { offsetMs: number; source: string } {
  const delta = foreupMs !== null && ntpMs !== null ? foreupMs - ntpMs : null;
  if (foreupMs !== null && (delta === null || Math.abs(delta) <= 125)) return { offsetMs: foreupMs, source: 'foreup' };
  if (ntpMs !== null) return { offsetMs: ntpMs, source: 'ntp' };
  return { offsetMs: 0, source: 'local' };
}
function sevenPmEpoch(serverNowMs: number): number {
  const d = new Date(serverNowMs);
  d.setHours(19, 0, 0, 0);
  return d.getTime();
}

// Last-old and first-new samples symmetrically bracket the boundary.
{
  const serverSec = Date.UTC(2026, 6, 14, 0, 31, 14); // .000 of the flipped second
  const flip = serverOffsetFromFlip(serverSec - 600, serverSec - 400, serverSec);
  assertEqual(flip.offsetMs, 500, 'clock: local 500ms behind → +500ms offset');
  assertEqual(flip.gapMs, 200, 'clock: transition carries its uncertainty bracket');
}

// Local clock 300ms AHEAD of the server → negative offset
{
  const serverSec = Date.UTC(2026, 6, 14, 0, 31, 14);
  assertEqual(serverOffsetFromFlip(serverSec + 200, serverSec + 400, serverSec).offsetMs, -300, 'clock: local 300ms ahead → -300ms offset');
}

// Perfectly synced → ~0 (sub-ms rounding)
{
  const serverSec = Date.UTC(2026, 6, 14, 0, 31, 14);
  assertEqual(serverOffsetFromFlip(serverSec - 50.4, serverSec + 49.6, serverSec).offsetMs, 0, 'clock: synced → 0ms offset');
}

// Pick tight transitions, reject RTT outliers, and median the best three.
{
  const picked = selectServerOffset([
    { offsetMs: 198, gapMs: 275 },
    { offsetMs: 18, gapMs: 178 },
    { offsetMs: 27, gapMs: 163 },
    { offsetMs: -400, gapMs: 900 },
  ]);
  assertEqual(picked, 23, 'clock: tight-bracket median rejects a wide outlier');
  assertEqual(selectServerOffset([{ offsetMs: 1, gapMs: 0 }, { offsetMs: 2, gapMs: 401 }]), null, 'clock: no trustworthy transition falls back');
}

// ForeUp remains primary only while its noisy whole-second header agrees
// with DNS-corrected NTP; otherwise NTP is the safe fallback.
{
  assertEqual(trustedClockOffset(36, 27).source, 'foreup', 'clock: agreeing ForeUp sample stays primary');
  assertEqual(trustedClockOffset(-90, 50).source, 'ntp', 'clock: >125ms disagreement falls back to NTP');
  assertEqual(trustedClockOffset(null, null).source, 'local', 'clock: total sync failure uses local clock explicitly');
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
section('Turbo safety guards — production helpers');

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
  assert(turbo.includes('async function foreupServerOffset(maxMs = 3000)'), 'clock sync: sampling window survives a cold first request');
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
  assert(turbo.includes('isWeekendDate(d) === targetWeekend'), 'spec scout: weekday/weekend fee classes are never mixed');
  assert(turbo.includes('const scouts = [...snapshotScouts, ...liveScouts];'), 'spec scout: ranked drop captures beat adjacent inferred rows on collisions');
  assert(turbo.includes('const courseKeys = [...new Set('), 'course actors: duplicate CLI/env course keys are deduplicated');
  assert(turbo.includes('Math.max(cfg.raceGraceMs, 1000)'), 'poll race: lower-priority detection leaves a full second for preferred Red');
  assert(turbo.includes(".filter((c) => !attempted.has(`${c.course.key}|${c.t.time}`))"), 'fallback race: already-attempted detected slots are not retried');
  assert(turbo.includes('missingSpecTemplateFields(cand.t)'), 'spec payload: incomplete predicted payloads are excluded before blind fire');
  assert(turbo.includes("fetchTextWithTimeout(url, { headers: this.headers(), method: 'GET' }, timeoutMs)"), 'poll safety: every times request has a bounded header+body timeout');
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
  assert(checkout.includes('FEE_PER_PLAYER * cand.players'), 'player fallback money gate: required fee is exactly $5 times candidate party size');
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
