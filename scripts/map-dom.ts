/**
 * DOM-mapping harness — ONE careful $0 pass through ForeUp's native booking
 * flow (slot card → code → card/Book screen) to capture real selectors.
 *
 * Opens a HEADED browser with the same bootstrap as turbo.ts (session reuse,
 * real-Chrome UA, login retry around the class click), then executes commands
 * written to <out>/cmd.txt, one at a time:
 *
 *   <seq> snap                      screenshot + DOM digest
 *   <seq> scan                      poll times for the next 7 days (API, $0)
 *   <seq> poll <MM-DD-YYYY>         poll times for one date (API, $0)
 *   <seq> click <selector>          click (REFUSES anything matching /book.?time/i)
 *   <seq> clicktext <text>          click by visible text (same guard)
 *   <seq> fill <selector> :: <val>  fill an input
 *   <seq> press <key>               keyboard key
 *   <seq> goto <url>                navigate
 *   <seq> eval <js>                 page.evaluate, JSON result
 *   <seq> html <selector>           dump outerHTML of first match
 *   <seq> base                      reset IMAP baseline (do BEFORE the click that sends the code)
 *   <seq> code                      wait for booking code via IMAP (90s)
 *   <seq> done                      close browser and exit
 *
 * After every command it writes <out>/<seq>-result.txt, <seq>-shot.png,
 * <seq>-digest.txt and appends to <out>/log.txt.
 *
 * MONEY SAFETY: the ONLY charging action on ForeUp is clicking "Book Time".
 * Both click commands hard-refuse elements whose text matches /book\s*time/i.
 * Everything else (slot click = hold, code entry, card selection) is $0 and
 * an unfinished hold expires in ~5 min.
 */
import { chromium, type Page, type BrowserContext } from 'playwright';
import { EmailMonitor } from '../src/email-monitor';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const FOREUP = 'https://foreupsoftware.com';
const SESSION_PATH = path.join(__dirname, '..', 'auth', 'session.json');
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const COURSES: Record<string, { name: string; courseId: number; scheduleId: number; bookingClassId: number }> = {
  black: { name: 'Black', courseId: 19765, scheduleId: 2431, bookingClassId: 50294 },
  blue:  { name: 'Blue',  courseId: 19765, scheduleId: 2433, bookingClassId: 50293 },
  green: { name: 'Green', courseId: 19765, scheduleId: 2434, bookingClassId: 50296 },
  red:   { name: 'Red',   courseId: 19765, scheduleId: 2432, bookingClassId: 50295 },
};

function cliArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const COURSE = COURSES[(cliArg('course') ?? 'red').toLowerCase()] ?? COURSES.red;
const OUT = cliArg('out') ?? path.join(__dirname, '..', 'logs', 'map-dom');
fs.mkdirSync(OUT, { recursive: true });

const CMD_FILE = path.join(OUT, 'cmd.txt');
const LOG_FILE = path.join(OUT, 'log.txt');
function log(msg: string) {
  const line = `[${new Date().toLocaleTimeString('en-US', { hour12: false })}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

const BOOK_GUARD = /book\s*time/i;

async function digest(page: Page): Promise<string> {
  const items = await page.evaluate(() => {
    const out: string[] = [];
    const els = document.querySelectorAll(
      'button, a, input, select, textarea, label, h1, h2, h3, h4, .modal-title, ' +
      '[class*="time-tile"], [class*="booking"], [class*="confirm"], [class*="credit"], [class*="pay"], [class*="fee"]'
    );
    let n = 0;
    els.forEach((el) => {
      if (n >= 500) return;
      const h = el as HTMLElement;
      const visible = !!(h.offsetParent || h.getClientRects().length);
      if (!visible) return;
      const tag = el.tagName.toLowerCase();
      const id = h.id ? `#${h.id}` : '';
      const cls = h.className && typeof h.className === 'string' ? '.' + h.className.trim().split(/\s+/).slice(0, 4).join('.') : '';
      let txt = '';
      if (tag === 'input' || tag === 'textarea') {
        const inp = el as HTMLInputElement;
        const val = inp.type === 'password' ? '***' : (inp.value ?? '').slice(0, 30);
        txt = `[type=${inp.type} placeholder="${inp.placeholder ?? ''}" name="${inp.name ?? ''}" value="${val}"]`;
      } else if (tag === 'select') {
        const sel = el as HTMLSelectElement;
        txt = `[selected="${sel.selectedOptions[0]?.textContent?.trim() ?? ''}" options=${sel.options.length}]`;
      } else {
        txt = (h.innerText ?? '').trim().replace(/\s+/g, ' ').slice(0, 90);
      }
      out.push(`${tag}${id}${cls} | ${txt}`);
      n++;
    });
    return { url: location.href, title: document.title, items: out };
  });
  return `URL: ${items.url}\nTITLE: ${items.title}\n\n${items.items.join('\n')}`;
}

async function pollTimes(context: BrowserContext, date: string): Promise<string> {
  const cookies = (await context.cookies())
    .filter((c) => c.domain.includes('foreupsoftware.com'))
    .map((c) => `${c.name}=${c.value}`).join('; ');
  const url = `${FOREUP}/index.php/api/booking/times?time=all&date=${date}&holes=18&players=4&booking_class=${COURSE.bookingClassId}&schedule_id=${COURSE.scheduleId}&specials_only=0&api_key=no_limits`;
  const res = await fetch(url, {
    headers: {
      'Cookie': cookies, 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': CHROME_UA,
      'Accept': 'application/json, text/javascript, */*; q=0.01', 'Referer': `${FOREUP}/index.php/booking/${COURSE.courseId}/${COURSE.scheduleId}#teetimes`,
    },
  });
  const text = await res.text();
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return `${date}: not-an-array: ${text.slice(0, 120)}`;
    const times = arr.filter((t: any) => (t.available_spots ?? 0) >= 4).map((t: any) => `${t.time.split(' ')[1]}(${t.available_spots})`);
    return `${date}: ${arr.length} times, ${times.length} with 4 spots: ${times.slice(0, 24).join(' ')}`;
  } catch { return `${date}: unparseable: ${text.slice(0, 120)}`; }
}

async function main() {
  log(`Mapping course=${COURSE.name} out=${OUT}`);
  fs.writeFileSync(CMD_FILE, '0 ready');

  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  const hasSession = fs.existsSync(SESSION_PATH);
  const context = hasSession
    ? await browser.newContext({ storageState: JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8')), userAgent: CHROME_UA, viewport: { width: 1360, height: 900 } })
    : await browser.newContext({ userAgent: CHROME_UA, viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${FOREUP}/index.php/booking/${COURSE.courseId}/${COURSE.scheduleId}#teetimes`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(2500);

  const loginIfNeeded = async (): Promise<boolean> => {
    const emailField = page.getByPlaceholder('Email');
    if (!(await emailField.isVisible({ timeout: 3000 }).catch(() => false))) return false;
    log('Logging in…');
    await emailField.fill(process.env.FOREUP_EMAIL ?? '');
    await page.getByPlaceholder('Password').fill(process.env.FOREUP_PASSWORD ?? '');
    await page.locator('#login').getByText('Log In', { exact: true }).click();
    await page.waitForTimeout(1500);
    return true;
  };
  await loginIfNeeded();
  for (let attempt = 0; attempt < 2; attempt++) {
    const golferBtn = page.getByRole('button', { name: /Verified NYS Resident/i });
    if (await golferBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await golferBtn.click();
      await page.waitForTimeout(1000);
    }
    if (!(await loginIfNeeded())) break;
  }
  await page.locator('#schedule_select').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => log('WARN: #schedule_select not visible'));
  fs.writeFileSync(SESSION_PATH, JSON.stringify(await context.storageState()), { mode: 0o600 });
  log('Bootstrap done — teesheet should be visible');

  let email: EmailMonitor | null = null;
  if (process.env.GMAIL_EMAIL && process.env.GMAIL_APP_PASSWORD) {
    email = new EmailMonitor(process.env.GMAIL_EMAIL, process.env.GMAIL_APP_PASSWORD);
    await email.connect();
    log('IMAP connected');
  } else log('WARN: no IMAP creds — code retrieval unavailable');

  // Initial artifacts
  fs.writeFileSync(path.join(OUT, '0-digest.txt'), await digest(page));
  await page.screenshot({ path: path.join(OUT, '0-shot.png') });
  log('READY — write "<seq> <command>" to cmd.txt');

  let lastSeq = 0;
  const guardClick = async (locator: ReturnType<Page['locator']>): Promise<string> => {
    const txt = ((await locator.innerText().catch(() => '')) ?? '').trim();
    if (BOOK_GUARD.test(txt)) return `REFUSED: element text "${txt}" matches Book Time guard — this is the charging click`;
    await locator.click({ timeout: 8000 });
    return `clicked "${txt.slice(0, 60)}"`;
  };

  for (;;) {
    await new Promise((r) => setTimeout(r, 300));
    let raw = '';
    try { raw = fs.readFileSync(CMD_FILE, 'utf-8').trim(); } catch { continue; }
    const m = raw.match(/^(\d+)\s+([\s\S]+)$/);
    if (!m) continue;
    const seq = parseInt(m[1], 10);
    if (seq <= lastSeq) continue;
    lastSeq = seq;
    const cmd = m[2].trim();
    log(`CMD ${seq}: ${cmd}`);
    let result = 'ok';
    try {
      if (cmd === 'done') {
        fs.writeFileSync(path.join(OUT, `${seq}-result.txt`), 'done');
        break;
      } else if (cmd === 'snap') {
        // artifacts below
      } else if (cmd === 'scan') {
        const lines: string[] = [];
        for (let d = 1; d <= 7; d++) {
          const dt = new Date(); dt.setDate(dt.getDate() + d);
          const ds = `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}-${dt.getFullYear()}`;
          lines.push(await pollTimes(context, ds));
        }
        result = lines.join('\n');
      } else if (cmd.startsWith('poll ')) {
        result = await pollTimes(context, cmd.slice(5).trim());
      } else if (cmd.startsWith('click ')) {
        result = await guardClick(page.locator(cmd.slice(6).trim()).first());
      } else if (cmd.startsWith('clicktext ')) {
        result = await guardClick(page.getByText(cmd.slice(10).trim(), { exact: false }).first());
      } else if (cmd.startsWith('fill ')) {
        const [sel, val] = cmd.slice(5).split('::').map((s) => s.trim());
        await page.locator(sel).first().fill(val ?? '');
        result = `filled ${sel}`;
      } else if (cmd.startsWith('press ')) {
        await page.keyboard.press(cmd.slice(6).trim());
      } else if (cmd.startsWith('goto ')) {
        await page.goto(cmd.slice(5).trim(), { waitUntil: 'domcontentloaded' });
      } else if (cmd.startsWith('eval ')) {
        const v = await page.evaluate(cmd.slice(5));
        result = JSON.stringify(v)?.slice(0, 4000) ?? 'undefined';
      } else if (cmd.startsWith('html ')) {
        const h = await page.locator(cmd.slice(5).trim()).first().evaluate((el) => el.outerHTML);
        fs.writeFileSync(path.join(OUT, `${seq}-html.txt`), h);
        result = `html dumped (${h.length} chars)`;
      } else if (cmd === 'frames') {
        result = page.frames().map((f) => `${f.name() || '(unnamed)'} :: ${f.url().split('?')[0]}`).join('\n') || 'no frames';
      } else if (cmd.startsWith('framedigest ')) {
        const part = cmd.slice(12).trim();
        const frame = page.frames().find((f) => f.url().includes(part));
        if (!frame) result = `no frame matching "${part}"`;
        else {
          result = await frame.evaluate(() => {
            const out: string[] = [];
            document.querySelectorAll('input, select, button, a, label, td, span[id], div[id]').forEach((el) => {
              const h = el as HTMLElement;
              if (!(h.offsetParent || h.getClientRects().length)) return;
              const tag = el.tagName.toLowerCase();
              const id = h.id ? `#${h.id}` : '';
              const name = (el as HTMLInputElement).name ? `[name=${(el as HTMLInputElement).name}]` : '';
              const type = (el as HTMLInputElement).type ? `[type=${(el as HTMLInputElement).type}]` : '';
              const txt = (h.innerText ?? (el as HTMLInputElement).placeholder ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
              out.push(`${tag}${id}${name}${type} | ${txt}`);
            });
            return `FRAME URL: ${location.href.split('?')[0]}\n` + out.slice(0, 200).join('\n');
          });
        }
      } else if (cmd.startsWith('framehtml ')) {
        const part = cmd.slice(10).trim();
        const frame = page.frames().find((f) => f.url().includes(part));
        if (!frame) result = `no frame matching "${part}"`;
        else {
          const h = await frame.evaluate(() => document.documentElement.outerHTML);
          fs.writeFileSync(path.join(OUT, `${seq}-framehtml.txt`), h);
          result = `frame html dumped (${h.length} chars)`;
        }
      } else if (cmd === 'base') {
        await email?.resetBaseline();
        result = email ? 'baseline reset' : 'no IMAP';
      } else if (cmd === 'code') {
        result = email ? `CODE: ${await email.waitForBookingCode(90_000)}` : 'no IMAP';
      } else {
        result = `unknown command: ${cmd}`;
      }
    } catch (e) {
      result = `ERROR: ${(e as Error).message?.slice(0, 400)}`;
    }
    await page.waitForTimeout(800); // let the UI settle before capturing
    fs.writeFileSync(path.join(OUT, `${seq}-result.txt`), result);
    try {
      fs.writeFileSync(path.join(OUT, `${seq}-digest.txt`), await digest(page));
      await page.screenshot({ path: path.join(OUT, `${seq}-shot.png`) });
    } catch (e) { log(`capture failed: ${(e as Error).message}`); }
    log(`CMD ${seq} → ${result.split('\n')[0].slice(0, 120)}`);
  }

  await email?.disconnect();
  await browser.close();
  log('Session closed. Hold (if any) expires in ~5 min at $0.');
}

main().catch((e) => { log(`FATAL: ${e.stack ?? e}`); process.exit(1); });
