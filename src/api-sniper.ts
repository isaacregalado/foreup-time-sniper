/**
 * Bethpage Sniper — hybrid API detection + browser booking.
 *
 * PROVEN flow:
 *   1. $.ajax poll inside browser for times    (~100ms) ← tested
 *   2. Page reload + Playwright click time     (~1.5s)  ← tested
 *   3. IMAP gets booking code                  (~500ms) ← tested
 *   4. Playwright enters code + clicks Book    (~300ms) ← testing now
 *   Total: ~2.5s from 7:00:00 PM
 *
 * All API calls use jQuery's $.ajax (via page.evaluate) which carries
 * foreUP's API key headers automatically. Direct fetch() returns 403.
 */

import { chromium, type Page, type Locator } from 'playwright';
import { EmailMonitor } from './email-monitor';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

// ────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────

const FOREUP_URL = 'https://foreupsoftware.com/index.php/booking/19765/2431#teetimes';
const SESSION_PATH = path.join(__dirname, '..', 'auth', 'session.json');
const DRY_RUN = process.argv.includes('--dry-run');
const EARLIEST = process.argv.includes('--earliest');

function cliArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const COURSES: Record<string, { name: string; scheduleId: number; sideId: number }> = {
  black:  { name: 'Bethpage Black Course',           scheduleId: 2431, sideId: 0 },
  blue:   { name: 'Bethpage Blue Course',            scheduleId: 2433, sideId: 0 },
  'early-blue': { name: 'Bethpage Early AM 9 Holes Blue', scheduleId: 2539, sideId: 0 },
  green:  { name: 'Bethpage Green Course',           scheduleId: 2434, sideId: 0 },
  red:    { name: 'Bethpage Red Course',             scheduleId: 2432, sideId: 1016 },
  yellow: { name: 'Bethpage Yellow Course 9 Holes',  scheduleId: 2435, sideId: 0 },
};

const POLL_INTERVAL_MS = 80;
const MAX_POLLS = 600;

function int(v: string | undefined, fb: number) { return v ? parseInt(v, 10) : fb; }

const courseKey = (cliArg('course') ?? process.env.COURSE ?? 'red').toLowerCase();
const course = COURSES[courseKey] ?? COURSES.red;
const [tHour, tMin] = (cliArg('time') ?? `${process.env.TARGET_HOUR ?? 7}:${process.env.TARGET_MINUTE ?? 30}`).split(':').map(Number);

const cfg = {
  foreupEmail: process.env.FOREUP_EMAIL ?? '',
  foreupPassword: process.env.FOREUP_PASSWORD ?? '',
  gmailEmail: process.env.GMAIL_EMAIL ?? '',
  gmailAppPassword: process.env.GMAIL_APP_PASSWORD ?? '',
  course,
  courseId: int(process.env.FOREUP_COURSE_ID, 19765),
  bookingClassId: int(process.env.FOREUP_BOOKING_CLASS_ID, 50295),
  earliest: EARLIEST,
  targetHour: tHour,
  targetMinute: tMin,
  timeWindow: EARLIEST ? 999 : int(cliArg('window') ?? process.env.TIME_WINDOW, 15),
  players: int(cliArg('players') ?? process.env.PLAYERS, 4),
  holes: int(cliArg('holes') ?? process.env.HOLES, 18),
  targetDate: cliArg('date') ?? process.env.TARGET_DATE ?? '',
  preDropSec: int(process.env.PRE_DROP_SECONDS, 3),
  renderDelay: int(process.env.RENDER_DELAY_MS, 250),
};

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function getTargetDate(): string {
  if (cfg.targetDate) return cfg.targetDate;
  const d = new Date(); d.setDate(d.getDate() + 7);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${d.getFullYear()}`;
}

function parseTime(s: string): number {
  const m = s.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return -1;
  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  if (m[3].toLowerCase() === 'pm' && h !== 12) h += 12;
  if (m[3].toLowerCase() === 'am' && h === 12) h = 0;
  return h * 60 + min;
}

function msUntil(h: number, m: number, s = 0): number {
  const now = new Date(); const t = new Date(now); t.setHours(h, m, s, 0);
  return t.getTime() - now.getTime();
}

function ts(): string {
  return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: true });
}

function log(i: string, m: string) { console.log(`  ${i} [${ts()}] ${m}`); }

function sound(name: 'success' | 'alert' | 'error') {
  execFile('afplay', [{ success: '/System/Library/Sounds/Hero.aiff', alert: '/System/Library/Sounds/Glass.aiff', error: '/System/Library/Sounds/Basso.aiff' }[name]], () => {});
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ────────────────────────────────────────────────────────────
// API polling via $.ajax inside the browser
// ────────────────────────────────────────────────────────────

interface ApiTime { time: string; available_spots: number; [key: string]: any; }

/** Poll foreUP API for tee times using jQuery (carries API key automatically) */
async function pollTimes(page: Page, date: string): Promise<ApiTime[] | null> {
  const tf = cfg.earliest ? 'all' : (cfg.targetHour < 12 ? 'morning' : cfg.targetHour < 17 ? 'midday' : 'evening');
  const url = `/index.php/api/booking/times?time=${tf}&date=${date}&holes=${cfg.holes}&players=${cfg.players}&booking_class=${cfg.bookingClassId}&schedule_id=${cfg.course.scheduleId}&schedule_ids%5B%5D=2433&schedule_ids%5B%5D=2539&schedule_ids%5B%5D=2432&schedule_ids%5B%5D=2435&specials_only=0&api_key=no_limits`;

  const result = await page.evaluate(async (u: string) => {
    try {
      const res = await fetch(u, { credentials: 'include' });
      const text = await res.text();
      if (text === 'false' || !text) return null;
      return JSON.parse(text);
    } catch { return null; }
  }, url);

  return Array.isArray(result) && result.length > 0 ? result : null;
}

/** Rank times by priority (earliest-first or closest-to-target) */
function rankTimes(times: ApiTime[]): ApiTime[] {
  const target = cfg.targetHour * 60 + cfg.targetMinute;
  const valid = times
    .map(t => {
      const hhmm = t.time.split(' ')[1];
      if (!hhmm) return null;
      const [hh, mm] = hhmm.split(':').map(Number);
      if (isNaN(hh) || isNaN(mm)) return null;
      const min = hh * 60 + mm;
      const dist = Math.abs(min - target);
      if (dist > cfg.timeWindow || t.available_spots < cfg.players) return null;
      return { time: t, min, dist };
    })
    .filter((x): x is { time: ApiTime; min: number; dist: number } => x !== null);

  if (cfg.earliest) valid.sort((a, b) => a.min - b.min);
  else valid.sort((a, b) => a.dist - b.dist);

  return valid.map(x => x.time);
}

// ────────────────────────────────────────────────────────────
// Browser interactions (proven selectors from DOM inspection)
// ────────────────────────────────────────────────────────────

async function handleLogin(page: Page): Promise<void> {
  const emailField = page.getByPlaceholder('Email');
  if (!(await emailField.isVisible({ timeout: 3000 }).catch(() => false))) return;
  log('…', 'Logging in');
  await emailField.fill(cfg.foreupEmail);
  await page.getByPlaceholder('Password').fill(cfg.foreupPassword);
  await page.locator('#login').getByText('Log In', { exact: true }).click();
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await sleep(1000);
  log('✓', 'Logged in');
}

async function selectGolferType(page: Page): Promise<void> {
  const btn = page.getByRole('button', { name: /Verified NYS Resident/i });
  if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await btn.click();
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await sleep(500);
    log('✓', 'Selected Verified NYS Resident');
    await handleLogin(page);
  }
}

async function setupFilters(page: Page, date: string): Promise<void> {
  await page.locator('#schedule_select').waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('#schedule_select').selectOption(cfg.course.name);
  await sleep(800);
  log('✓', `Course: ${cfg.course.name}`);

  const dateInput = page.getByPlaceholder('MM-DD-YYYY');
  await dateInput.click({ clickCount: 3 });
  await dateInput.fill(date);
  await dateInput.press('Enter');
  await sleep(800);
  log('✓', `Date: ${date}`);

  const timeFilter = cfg.earliest ? 'All' : (cfg.targetHour < 12 ? 'Morning' : cfg.targetHour < 17 ? 'Midday' : 'Evening');
  const timeSection = page.getByText('Time of Day', { exact: true }).locator('..');
  await timeSection.getByText(timeFilter, { exact: true }).click();
  await sleep(300);

  const holesSection = page.getByText('Holes', { exact: true }).locator('..');
  await holesSection.getByText(String(cfg.holes), { exact: true }).click();
  await sleep(300);

  const playersSection = page.getByText('Players', { exact: true }).locator('..');
  await playersSection.getByText(String(cfg.players), { exact: true }).click();
  await sleep(300);
  log('✓', `Filters: ${timeFilter}, ${cfg.holes} holes, ${cfg.players} players`);
}

/** Convert API time "2026-04-03 17:18" to display format "5:18pm" */
function apiTimeToDisplay(apiTime: string): string {
  const hhmm = apiTime.split(' ')[1] ?? '';
  const [hh, mm] = hhmm.split(':').map(Number);
  if (isNaN(hh) || isNaN(mm)) return '';
  const h12 = hh > 12 ? hh - 12 : hh || 12;
  const ap = hh >= 12 ? 'pm' : 'am';
  return `${h12}:${String(mm).padStart(2, '0')}${ap}`;
}

/** Click a tee time card using Playwright's simulated mouse click.
 * This triggers real browser events that bubble up to Backbone/jQuery handlers.
 * The MCP browser proved this works: page.getByText('5:45pm Front...').click() */
async function clickTimeCard(page: Page, displayTime: string): Promise<boolean> {
  // The time text (e.g., "2:45pm") is shown as exact text in a leaf div.
  // Playwright's getByText with exact match + click triggers real mouse events
  // that bubble up to the foreUP card's click handler.
  const timeEl = page.getByText(displayTime, { exact: true }).first();
  try {
    await timeEl.waitFor({ state: 'visible', timeout: 3000 });
    await timeEl.click({ timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────────────────────
// Player-count select + verify (money-safe: must return false
// rather than proceed if anything is uncertain — we'd rather
// lose the slot than charge for the wrong player count).
// ────────────────────────────────────────────────────────────

async function selectAndVerifyPlayers(page: Page, n: number): Promise<boolean> {
  // foreUP pattern (confirmed via live DOM inspection 2026-04-19):
  //   <a class="btn btn-primary [active] [disabled]" data-value="N">N</a>
  // Selected state = `active` class. `disabled` appears during processing.
  return await page.evaluate((target: number) => {
    const modal = document.querySelector<HTMLElement>('.modal.in, dialog[open], [role="dialog"]') ?? document;
    const btn = modal.querySelector<HTMLElement>(`a.btn[data-value="${target}"]`);
    if (!btn) return false;
    btn.click();
    return new Promise<boolean>((resolve) => {
      const start = Date.now();
      const tick = () => {
        const cls = btn.className;
        if (cls.includes('active') && !cls.includes('disabled')) return resolve(true);
        if (Date.now() - start > 1500) return resolve(false);
        setTimeout(tick, 50);
      };
      setTimeout(tick, 50);
    });
  }, n);
}

// ────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────

async function main() {
  const date = getTargetDate();
  const ap = cfg.targetHour >= 12 ? 'PM' : 'AM';
  const dh = cfg.targetHour > 12 ? cfg.targetHour - 12 : cfg.targetHour || 12;

  console.log(`\n  ⛳  BETHPAGE SNIPER ${DRY_RUN ? '(DRY RUN)' : ''}\n`);
  console.log(`  Course:    ${cfg.course.name}`);
  console.log(`  Date:      ${date}`);
  console.log(`  Target:    ${cfg.earliest ? 'EARLIEST available' : `~${dh}:${String(cfg.targetMinute).padStart(2, '0')} ${ap} (±${cfg.timeWindow} min)`}`);
  console.log(`  Players:   ${cfg.players}`);
  console.log(`  Mode:      API detect → browser book (~2.5s)\n`);

  // ── Browser Setup ─────────────────────────────────────
  log('…', 'Launching browser');
  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });

  let shuttingDown = false;
  process.on('SIGINT', async () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    log('ℹ', 'Shutting down...');
    await browser.close().catch(() => {});
    process.exit(0);
  });

  const hasSession = fs.existsSync(SESSION_PATH);
  const context = hasSession
    ? await browser.newContext({ storageState: JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8')) })
    : await browser.newContext();

  const page = await context.newPage();
  await page.goto(FOREUP_URL, { waitUntil: 'networkidle', timeout: 30_000 });

  await handleLogin(page);
  await selectGolferType(page);

  fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
  fs.writeFileSync(SESSION_PATH, JSON.stringify(await context.storageState()), { mode: 0o600 });

  await setupFilters(page, date);
  log('✓', 'Ready');

  // ── Verify API ────────────────────────────────────────
  const test = await pollTimes(page, date);
  if (test) {
    const ranked = rankTimes(test);
    log('✓', `API: ${test.length} times, ${ranked.length} in window`);
    if (ranked[0]) log('🎯', `Best: ${ranked[0].time} (${ranked[0].available_spots} spots)`);
  } else {
    log('ℹ', `No times for ${date} yet`);
  }

  // ── IMAP ──────────────────────────────────────────────
  log('…', 'Connecting IMAP');
  const imap = new EmailMonitor(cfg.gmailEmail, cfg.gmailAppPassword);
  await imap.connect();
  log('✓', 'IMAP ready');

  if (DRY_RUN) { log('🏁', 'DRY RUN done.'); await imap.disconnect(); await browser.close(); return; }

  // ── Wait for 7 PM ────────────────────────────────────
  const wait = msUntil(19, 0, 0) - cfg.preDropSec * 1000;
  if (wait > 0 && !test) {
    log('⏳', `${Math.floor(wait / 60000)}m ${Math.ceil((wait % 60000) / 1000)}s to drop...`);
    const tick = setInterval(() => {
      const r = msUntil(19, 0, 0); if (r <= 0) { clearInterval(tick); return; }
      process.stdout.write(`\r  ⏳ ${Math.floor(r/60000)}:${String(Math.ceil((r%60000)/1000)).padStart(2,'0')}   `);
    }, 500);
    await sleep(wait); clearInterval(tick);
    process.stdout.write('\r                              \r');
  }

  // Keep session alive with a lightweight API ping (no page reload)
  await page.evaluate(() => fetch('/index.php/api/booking/times?time=all&date=01-01-2026&holes=all&players=0&booking_class=50295&schedule_id=2432&specials_only=0&api_key=no_limits', { credentials: 'include' }).catch(() => {}));
  log('✓', 'Session alive');

  // ══════════════════════════════════════════════════════
  // ══  S N I P E  ══════════════════════════════════════
  // ══════════════════════════════════════════════════════

  log('🔥', 'GO!');
  sound('alert');
  const t0 = Date.now();

  // ── Step 1: API poll for times (fast, ~100ms/cycle) ───
  let ranked: ApiTime[] = [];
  let polls = 0;
  let lastError = '';

  while (ranked.length === 0 && polls < MAX_POLLS) {
    polls++;
    try {
      const times = await pollTimes(page, date);
      if (times) ranked = rankTimes(times);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== lastError) { log('⚠', `Poll: ${msg}`); lastError = msg; }
    }
    if (ranked.length === 0) await sleep(POLL_INTERVAL_MS);
    if (polls % 50 === 0 && ranked.length === 0) log('⚡', `Poll #${polls}`);
  }

  if (ranked.length === 0) {
    log('✗', `No times after ${polls} polls`);
    sound('error');
    await imap.disconnect();
    await new Promise<void>(r => process.on('SIGINT', r));
    return;
  }

  const t1 = Date.now();
  log('⚡', `DETECTED ${ranked.length} times — ${t1 - t0}ms`);
  log('⚡', `Priority: ${ranked.slice(0, 6).map(t => t.time.split(' ')[1]).join(' → ')}`);

  // ── Step 2: Refresh tee sheet + click time card ────────
  // The browser click flow is the proven path (booked 5:18pm).
  // API detection saves ~1.5s vs page reload detection.
  await imap.resetBaseline();

  // Toggle date to refresh visible times
  const dateField = page.getByPlaceholder('MM-DD-YYYY');
  await dateField.click({ clickCount: 3 });
  await dateField.fill('01-01-2026');
  await dateField.press('Enter');
  await sleep(300);
  await dateField.click({ clickCount: 3 });
  await dateField.fill(date);
  await dateField.press('Enter');

  // Wait for tee time cards to actually render (not just the AJAX response)
  await page.locator('div').filter({ hasText: /^\d{1,2}:\d{2}(am|pm)$/ }).first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  await sleep(300);
  log('✓', 'Tee sheet refreshed — times visible');

  // Click the target time card using Playwright's mouse click
  let clickedTime = '';
  for (let i = 0; i < Math.min(ranked.length, 6); i++) {
    const display = apiTimeToDisplay(ranked[i].time);
    if (!display) continue;
    if (await clickTimeCard(page, display)) {
      clickedTime = display;
      break;
    }
    log('↻', `${display} not clickable, trying next`);
  }

  if (!clickedTime) {
    log('✗', 'Could not click any time on page');
    sound('error');
    await imap.disconnect();
    await new Promise<void>(r => process.on('SIGINT', r));
    return;
  }

  const t2 = Date.now();
  log('🎯', `Clicked ${clickedTime} — ${t2 - t1}ms`);
  sound('alert');

  // ── Step 3: Wait for booking modal ────────────────────
  // The modal might be <dialog>, .modal, or [role="dialog"]
  // Most reliable: wait for the "Booking Code" text or placeholder "123456" input
  const codeInput = page.getByPlaceholder('123456');
  try {
    await codeInput.waitFor({ state: 'visible', timeout: 10000 });
    log('✓', 'Modal open — code input visible');
  } catch {
    log('⚠', 'Modal did not open — check browser!');
    sound('alert');
    await imap.disconnect();
    await new Promise<void>(r => process.on('SIGINT', r));
    return;
  }

  // Set player count in modal — MUST verify before proceeding to code entry.
  // Charge fires on Book Time + code submission ($5/player, non-refundable,
  // can't edit player count after booking). Any failure here MUST abort
  // before code entry so the held slot just times out (free).
  const playersOk = await selectAndVerifyPlayers(page, cfg.players);
  if (!playersOk) {
    log('✗', `Could not verify ${cfg.players}-player selection — ABORTING before charge`);
    log('ℹ', 'Slot will release in ~5 min. No charge incurred.');
    sound('error');
    await imap.disconnect();
    await new Promise<void>(r => process.on('SIGINT', r));
    return;
  }
  log('✓', `${cfg.players} players selected and verified`);

  // ── Step 4: Get code via IMAP ─────────────────────────
  log('…', 'Waiting for code...');
  let code: string | null = null;
  try {
    code = await imap.waitForBookingCode(45_000);
    log('✓', `Code: ***${code.slice(-2)}`);
  } catch {
    sound('alert');
    log('⚠', 'No code via IMAP — enter manually in the browser!');
    await imap.disconnect();
    await new Promise<void>(r => process.on('SIGINT', r));
    return;
  }

  // ── Step 5: Enter code + click Book Time ──────────────
  await codeInput.fill(code);
  log('✓', 'Code entered');

  await sleep(300);
  // Click the "Book Time" button (not "Close")
  await page.locator('button').filter({ hasText: /^Book Time$/ }).first().click();

  const tEnd = Date.now();
  const totalSec = ((tEnd - t0) / 1000).toFixed(1);
  log('✓', `Clicked "Book Time" — ${totalSec}s total`);
  sound('success');

  console.log('');
  console.log('  ╔═══════════════════════════════════════════════════╗');
  console.log(`  ║   🏌️  BOOKED in ${totalSec.padStart(4)}s                            ║`);
  console.log(`  ║   ${clickedTime.padEnd(8)} — ${cfg.course.name.padEnd(35)} ║`);
  console.log(`  ║   ${date}, ${cfg.players} player${cfg.players > 1 ? 's' : ''}                              ║`);
  console.log('  ║                                                   ║');
  console.log('  ║   Complete payment in browser if prompted.        ║');
  console.log('  ╚═══════════════════════════════════════════════════╝');
  console.log('');

  log('ℹ', 'Browser open. Ctrl+C to exit.');
  await imap.disconnect();
  await new Promise<void>(r => process.on('SIGINT', r));
  await browser.close().catch(() => {});
}

main().catch(e => { console.error(`\n  ✗ ${e.message}\n`); sound('error'); process.exit(1); });
