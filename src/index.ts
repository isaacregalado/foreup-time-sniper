/**
 * Bethpage Sniper v3 — exact selectors from DOM inspection.
 *
 * Selectors verified via Playwright MCP snapshot of live foreUP page:
 *   - Login:    getByPlaceholder('Email'), getByPlaceholder('Password')
 *   - Course:   #schedule_select
 *   - Date:     getByPlaceholder('MM-DD-YYYY')
 *   - Filters:  text-based clicks on Morning/18/4
 *   - Calendar: columnheader "»" for next month
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

// ── CLI arg parser: --course red --players 2 --date 04-05-2026 --time 7:30 ──
function cliArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

// Course name mapping (shorthand → full foreUP dropdown label)
const COURSES: Record<string, string> = {
  red: 'Bethpage Red Course',
  blue: 'Bethpage Blue Course',
  yellow: 'Bethpage Yellow Course',
  'early-blue': 'Bethpage Early AM 9 Holes Blue',
};

function resolveCourse(input?: string): string {
  if (!input) return COURSES[process.env.COURSE?.toLowerCase() ?? 'red'] ?? 'Bethpage Red Course';
  return COURSES[input.toLowerCase()] ?? input; // Allow full name too
}

function resolveTime(input?: string): { hour: number; minute: number } {
  if (input) {
    const [h, m] = input.split(':').map(Number);
    if (!isNaN(h) && !isNaN(m)) return { hour: h, minute: m };
  }
  return { hour: int(process.env.TARGET_HOUR, 7), minute: int(process.env.TARGET_MINUTE, 30) };
}

const targetTime = resolveTime(cliArg('time'));

const cfg = {
  foreupEmail: process.env.FOREUP_EMAIL ?? '',
  foreupPassword: process.env.FOREUP_PASSWORD ?? '',
  gmailEmail: process.env.GMAIL_EMAIL ?? '',
  gmailAppPassword: process.env.GMAIL_APP_PASSWORD ?? '',
  course: resolveCourse(cliArg('course')),
  targetHour: targetTime.hour,
  targetMinute: targetTime.minute,
  timeWindow: int(cliArg('window') ?? process.env.TIME_WINDOW, 15),
  players: int(cliArg('players') ?? process.env.PLAYERS, 4),
  holes: int(cliArg('holes') ?? process.env.HOLES, 18),
  targetDate: cliArg('date') ?? process.env.TARGET_DATE ?? '',
  preDropSec: int(process.env.PRE_DROP_SECONDS, 3),
  renderDelay: int(process.env.RENDER_DELAY_MS, 250),
};

function int(v: string | undefined, fb: number) { return v ? parseInt(v, 10) : fb; }

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function parseTime(s: string): number {
  const m = s.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return -1;
  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  if (m[3].toLowerCase() === 'pm' && h !== 12) h += 12;
  if (m[3].toLowerCase() === 'am' && h === 12) h = 0;
  return h * 60 + min;
}

function getTargetDate(): string {
  if (cfg.targetDate) return cfg.targetDate;
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${d.getFullYear()}`;
}

function msUntil(hour: number, min: number, sec = 0): number {
  const now = new Date();
  const t = new Date(now);
  t.setHours(hour, min, sec, 0);
  return t.getTime() - now.getTime();
}

function ts(): string {
  return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
}

function log(icon: string, msg: string) { console.log(`  ${icon} [${ts()}] ${msg}`); }

function sound(name: 'success' | 'alert' | 'error') {
  const f: Record<string, string> = {
    success: '/System/Library/Sounds/Hero.aiff',
    alert: '/System/Library/Sounds/Glass.aiff',
    error: '/System/Library/Sounds/Basso.aiff',
  };
  execFile('afplay', [f[name]], () => {});
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ────────────────────────────────────────────────────────────
// Page Interactions (exact selectors from DOM inspection)
// ────────────────────────────────────────────────────────────

async function handleLogin(page: Page): Promise<void> {
  // Login modal has placeholders "Email" and "Password"
  const emailField = page.getByPlaceholder('Email');
  const isLogin = await emailField.isVisible({ timeout: 3000 }).catch(() => false);
  if (!isLogin) return;

  log('…', 'Login modal detected — logging in');
  await emailField.fill(cfg.foreupEmail);
  await page.getByPlaceholder('Password').fill(cfg.foreupPassword);
  // The Log In button is inside #login div
  await page.locator('#login').getByText('Log In', { exact: true }).click();
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await sleep(1000);
  log('✓', 'Logged in');
}

async function selectGolferType(page: Page): Promise<void> {
  // Button text: "Verified NYS Resident - Bethpage/Sunken Meadow"
  const btn = page.getByRole('button', { name: /Verified NYS Resident/i });
  if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await btn.click();
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await sleep(500);
    log('✓', 'Selected Verified NYS Resident');

    // Login modal may appear after clicking golfer type
    await handleLogin(page);
  }
}

async function waitForTeeSheet(page: Page): Promise<void> {
  // After login, wait for the tee sheet to fully render
  // The #schedule_select dropdown is a reliable indicator
  log('…', 'Waiting for tee sheet to load');
  await page.locator('#schedule_select').waitFor({ state: 'visible', timeout: 15_000 });
  await sleep(500);
  log('✓', 'Tee sheet loaded');
}

async function selectCourse(page: Page): Promise<void> {
  const dropdown = page.locator('#schedule_select');
  await dropdown.selectOption(cfg.course);
  await sleep(1000); // Course change triggers tee sheet reload
  log('✓', `Selected: ${cfg.course}`);
}

async function selectDate(page: Page, dateStr: string): Promise<void> {
  // Date input has placeholder "MM-DD-YYYY"
  const dateInput = page.getByPlaceholder('MM-DD-YYYY');

  try {
    // Clear and type the date
    await dateInput.click({ clickCount: 3 });
    await sleep(100);
    await dateInput.fill(dateStr);
    await dateInput.press('Enter');
    await sleep(800);
    log('✓', `Set date: ${dateStr}`);
  } catch {
    // Fallback: navigate calendar month by month
    const [mm, dd, yyyy] = dateStr.split('-');
    const targetMonth = new Date(parseInt(yyyy), parseInt(mm) - 1).toLocaleString('en', { month: 'long' });
    const targetStr = `${targetMonth} ${yyyy}`;

    // Click "»" to go forward months until we reach the target
    for (let i = 0; i < 12; i++) {
      const header = await page.locator('table columnheader').first().textContent() ?? '';
      if (header.includes(targetMonth) && header.includes(yyyy)) break;
      await page.getByRole('columnheader', { name: '»' }).click();
      await sleep(200);
    }

    // Click the day number in the calendar
    await page.locator('table td').getByText(dd.replace(/^0/, ''), { exact: true }).first().click();
    await sleep(800);
    log('✓', `Set date via calendar: ${dateStr}`);
  }
}

async function applyFilters(page: Page): Promise<void> {
  // Scope each filter click to its labeled container to avoid hitting
  // calendar days or tee time card numbers.
  //
  // DOM structure (from MCP inspection):
  //   div (container)
  //     div: "Players"     ← label
  //     div:               ← button group
  //       div: "1"
  //       div: "4"
  //       div: "Any"

  // Time of Day — pick based on target hour
  const timeFilter = cfg.targetHour < 12 ? 'Morning' : cfg.targetHour < 17 ? 'Midday' : 'Evening';
  try {
    const timeSection = page.getByText('Time of Day', { exact: true }).locator('..');
    await timeSection.getByText(timeFilter, { exact: true }).click();
    await sleep(300);
    log('✓', `Filter: ${timeFilter}`);
  } catch {
    log('⚠', `Could not set ${timeFilter} filter`);
  }

  // 18 holes — scoped to "Holes" section
  try {
    const holesSection = page.getByText('Holes', { exact: true }).locator('..');
    await holesSection.getByText(String(cfg.holes), { exact: true }).click();
    await sleep(300);
    log('✓', `Filter: ${cfg.holes} holes`);
  } catch {
    log('⚠', 'Could not set holes filter');
  }

  // Players — scoped to "Players" section
  try {
    const playersSection = page.getByText('Players', { exact: true }).locator('..');
    await playersSection.getByText(String(cfg.players), { exact: true }).click();
    await sleep(300);
    log('✓', `Filter: ${cfg.players} players`);
  } catch {
    log('⚠', 'Could not set players filter');
  }
}

/** Log all visible tee times on the page (for dry run verification) */
async function logAllVisibleTimes(page: Page): Promise<string[]> {
  const times: string[] = [];
  const timePattern = /^\d{1,2}:\d{2}(am|pm)$/i;
  // Time labels are deeply nested divs — grab all text nodes matching time format
  const allText = await page.locator('div').allTextContents();
  for (const t of allText) {
    const trimmed = t.trim();
    if (timePattern.test(trimmed) && !times.includes(trimmed)) {
      times.push(trimmed);
    }
  }
  return times;
}

/**
 * Find the tee time closest to target within the time window.
 *
 * DOM structure per card (from MCP inspection):
 *   div [cursor=pointer]        ← clickable card (3 levels up)
 *     └─ div
 *         └─ div
 *             ├─ div: "7:30am"  ← time label (what we match)
 *             └─ div: "Front"
 */
async function findBestTime(page: Page): Promise<{ locator: Locator; text: string } | null> {
  const targetMin = cfg.targetHour * 60 + cfg.targetMinute;
  const timePattern = /^\d{1,2}:\d{2}(am|pm)$/i;

  // Get all divs, filter to ones that contain just a time string
  const candidates = page.locator('div');
  const count = await candidates.count();
  if (count === 0) return null;

  let best: { locator: Locator; text: string; distance: number } | null = null;

  for (let i = 0; i < count; i++) {
    const el = candidates.nth(i);
    const raw = await el.textContent();
    if (!raw) continue;
    const text = raw.trim();
    if (!timePattern.test(text)) continue;

    const min = parseTime(text);
    if (min < 0) continue;
    const dist = Math.abs(min - targetMin);
    if (dist <= cfg.timeWindow && (!best || dist < best.distance)) {
      best = { locator: el, text, distance: dist };
    }
  }

  return best ? { locator: best.locator, text: best.text } : null;
}

// ────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────

async function main() {
  const targetDate = getTargetDate();
  const ampm = cfg.targetHour >= 12 ? 'PM' : 'AM';
  const displayHour = cfg.targetHour > 12 ? cfg.targetHour - 12 : cfg.targetHour || 12;
  const targetStr = `${displayHour}:${String(cfg.targetMinute).padStart(2, '0')} ${ampm}`;

  console.log(`\n  ⛳  BETHPAGE SNIPER ${DRY_RUN ? '(DRY RUN)' : ''}\n`);
  console.log(`  Course:    ${cfg.course}`);
  console.log(`  Date:      ${targetDate}`);
  console.log(`  Target:    ~${targetStr} (±${cfg.timeWindow} min)`);
  console.log(`  Players:   ${cfg.players}`);
  console.log(`  Holes:     ${cfg.holes}\n`);

  // ── Phase 1: Launch & Login ───────────────────────────
  log('…', 'Launching browser');
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const hasSession = fs.existsSync(SESSION_PATH);
  const context = hasSession
    ? await browser.newContext({ storageState: JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8')) })
    : await browser.newContext();
  if (hasSession) log('✓', 'Restored session');

  const page = await context.newPage();
  await page.goto(FOREUP_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  log('✓', 'Loaded foreUP');

  // Login if needed, then select golfer type
  await handleLogin(page);
  await selectGolferType(page);

  // Save session
  fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
  fs.writeFileSync(SESSION_PATH, JSON.stringify(await context.storageState()));

  // ── Phase 2: Set Filters ──────────────────────────────
  await waitForTeeSheet(page);

  // Intercept API calls during filter changes to discover the tee time endpoint
  let teeTimeApiUrl: string | null = null;
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/api/booking/times') && req.method() === 'GET') {
      teeTimeApiUrl = url;
      log('🔍', `API: ${url.substring(0, 120)}`);
    }
  });

  await selectCourse(page);
  await selectDate(page, targetDate);
  await applyFilters(page);
  log('✓', 'Page ready');

  // snapshot: TS can't see the page.on() callback assignment and narrows to never
  const discoveredApiUrl = teeTimeApiUrl as string | null;
  if (discoveredApiUrl) {
    log('⚡', `Tee time API discovered: ${discoveredApiUrl.substring(0, 100)}`);
  }

  // Log all visible times so we can verify detection works
  const allTimes = await logAllVisibleTimes(page);
  if (allTimes.length > 0) {
    log('ℹ', `${allTimes.length} tee times visible: ${allTimes.slice(0, 6).join(', ')}${allTimes.length > 6 ? '...' : ''}`);
  } else {
    log('ℹ', 'No tee times visible (expected if date is 7+ days out)');
  }

  const existingTarget = await findBestTime(page);
  if (existingTarget) log('🎯', `Target time in window: ${existingTarget.text}`);

  // ── Phase 3: IMAP ────────────────────────────────────
  log('…', 'Connecting IMAP');
  const email = new EmailMonitor(cfg.gmailEmail, cfg.gmailAppPassword);
  await email.connect();
  log('✓', 'IMAP connected');

  // ── DRY RUN exits here ───────────────────────────────
  if (DRY_RUN) {
    log('🏁', 'DRY RUN complete. Everything looks good!');
    log('ℹ', 'Run `npm run snipe` on Sunday evening before 7 PM.');
    await email.disconnect();
    await browser.close();
    return;
  }

  // ── Phase 4: Wait for 7 PM ───────────────────────────
  const dropWait = msUntil(19, 0, 0) - cfg.preDropSec * 1000;

  if (dropWait > 0 && !existingTarget) {
    const totalSec = Math.ceil(dropWait / 1000);
    log('⏳', `Waiting ${Math.floor(totalSec / 60)}m ${totalSec % 60}s until drop...`);

    const ticker = setInterval(() => {
      const rem = msUntil(19, 0, 0);
      if (rem <= 0) { clearInterval(ticker); return; }
      const s = Math.ceil(rem / 1000);
      process.stdout.write(`\r  ⏳ Drop in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}   `);
    }, 500);

    await sleep(dropWait);
    clearInterval(ticker);
    process.stdout.write('\r                              \r');
  }

  // ── Phase 5: SNIPE ───────────────────────────────────
  log('🔥', 'SNIPING!');
  sound('alert');

  let hit: { locator: Locator; text: string } | null = null;
  let attempts = 0;
  const targetMin = cfg.targetHour * 60 + cfg.targetMinute;

  // FAST PATH: poll the API directly (~100ms/cycle)
  // API returns JSON array: [{"time":"2026-04-05 07:30", "available_spots":4, ...}, ...]
  // "time" field is 24h format "YYYY-MM-DD HH:MM"
  // Returns "false" (string) when no times available
  if (teeTimeApiUrl) {
    log('⚡', 'Using fast API polling (~100ms/cycle)');

    for (let i = 0; i < 300 && !hit; i++) { // Up to 30s
      attempts++;
      try {
        const raw = await page.evaluate(async (url: string) => {
          const r = await fetch(url, { credentials: 'include' });
          return r.text();
        }, teeTimeApiUrl);

        // "false" means no times yet — keep polling
        if (raw === 'false' || raw === '') {
          if (!hit) await sleep(100);
          if (attempts % 30 === 0) log('⚡', `Poll #${attempts} — not yet`);
          continue;
        }

        // Parse JSON array of tee times
        const times = JSON.parse(raw) as Array<{ time: string; available_spots: number }>;
        if (!Array.isArray(times) || times.length === 0) {
          await sleep(100);
          continue;
        }

        // Check if any returned time falls in our target window
        // "time" format: "2026-04-05 07:30" (24h)
        const match = times.find((t) => {
          const hhmm = t.time.split(' ')[1]; // "07:30"
          if (!hhmm) return false;
          const [hh, mm] = hhmm.split(':').map(Number);
          const min = hh * 60 + mm;
          return Math.abs(min - targetMin) <= cfg.timeWindow && t.available_spots >= cfg.players;
        });

        if (match) {
          log('⚡', `API hit after ${attempts} polls: ${match.time} (${match.available_spots} spots)`);
          // Reload page once to render the times for clicking
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 8000 });
          await sleep(cfg.renderDelay);
          hit = await findBestTime(page);
        }
      } catch {
        await sleep(100);
      }

      if (!hit && attempts % 30 === 0) log('⚡', `Poll #${attempts}`);
      if (!hit) await sleep(100);
    }
  }

  // SLOW FALLBACK: page reload (~2s/cycle)
  if (!hit) {
    if (teeTimeApiUrl) log('ℹ', 'Switching to page reload fallback');
    else log('ℹ', 'No API discovered — using page reload');

    while (!hit && attempts < 200) {
      attempts++;
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 8000 });
      } catch { continue; }
      await sleep(cfg.renderDelay);
      hit = await findBestTime(page);
      if (attempts % 5 === 0 && !hit) log('↻', `Refresh #${attempts}`);
    }
  }

  if (!hit) {
    log('✗', 'No matching times found');
    sound('error');
    log('ℹ', 'Browser open — try manually!');
    await email.disconnect();
    await new Promise(() => {});
    return;
  }

  // ── Phase 6: Click it ────────────────────────────────
  log('🎯', `Found ${hit.text} — CLICKING`);
  await email.resetBaseline();

  // The time label is nested 3 levels inside the clickable card div.
  // Click the ancestor card (cursor:pointer), fallback to click propagation.
  try {
    // Try clicking 3 levels up (the card container that has the click handler)
    await hit.locator.locator('xpath=ancestor::div[3]').click({ timeout: 2000 });
  } catch {
    try {
      // Fallback: click the time text directly (event should bubble up)
      await hit.locator.click({ timeout: 2000 });
    } catch {
      // Last resort: go up 2 levels
      await hit.locator.locator('xpath=ancestor::div[2]').click({ timeout: 2000 });
    }
  }
  sound('alert');

  // ── Phase 7: Booking Modal ───────────────────────────
  try {
    await page.getByText('Booking Code').waitFor({ state: 'visible', timeout: 8000 });
    log('✓', 'Booking modal opened');
  } catch {
    log('⚠', 'Modal may not have opened');
  }

  // Players in modal
  try {
    await page.locator('.modal, [role="dialog"]').first()
      .getByText(String(cfg.players), { exact: true }).first().click();
  } catch {}

  // ── Phase 8: Email Code ──────────────────────────────
  log('…', 'Waiting for booking code...');
  let code: string | null = null;
  try {
    code = await email.waitForBookingCode(45_000);
    log('✓', `Code: ${code}`);
  } catch {
    log('⚠', 'Code not received via IMAP');
  }

  if (code) {
    // Fill code — find the visible empty text input in the modal
    const inputs = page.locator('input[type="text"], input[type="number"], input:not([type])');
    const count = await inputs.count();
    for (let i = 0; i < count; i++) {
      const inp = inputs.nth(i);
      if (!(await inp.isVisible())) continue;
      const val = await inp.inputValue();
      if (val === '') {
        await inp.fill(code);
        log('✓', 'Code entered');
        break;
      }
    }

    await sleep(300);
    await page.getByRole('button', { name: 'Book Time' })
      .or(page.locator('button').filter({ hasText: /Book Time/i }))
      .first().click();
    log('✓', 'Clicked "Book Time"!');

    sound('success');
    console.log('\n  ╔════════════════════════════════════════════════╗');
    console.log(`  ║   🏌️  TEE TIME BOOKED — ${hit.text.padEnd(10)}              ║`);
    console.log(`  ║   ${cfg.course.padEnd(44)} ║`);
    console.log('  ║   Check browser for payment.                   ║');
    console.log('  ╚════════════════════════════════════════════════╝\n');
  } else {
    sound('alert');
    sound('alert');
    console.log('\n  ╔════════════════════════════════════════════════╗');
    console.log('  ║   🎯 TIME HELD — enter code manually!          ║');
    console.log('  ║   Check email → type code → click Book Time    ║');
    console.log('  ║   You have ~5 minutes.                         ║');
    console.log('  ╚════════════════════════════════════════════════╝\n');
  }

  log('ℹ', 'Browser open. Ctrl+C when done.');
  await email.disconnect();
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(`\n  ✗ Fatal: ${err.message}\n`);
  sound('error');
  process.exit(1);
});
