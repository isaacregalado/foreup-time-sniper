/**
 * Email Monitor — watches Gmail via IMAP for foreUP booking codes.
 * Uses IMAP NOOP polling to detect new messages near-instantly (~400ms).
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

export interface BookingCodeExpectation {
  dateMdY: string;
  time24: string;
}

/** ForeUp's code email identifies the reservation by date + time (but not
 * course). Match those fields before accepting a code when parallel course
 * holds may have generated more than one message. */
export function bookingCodeContextMatches(text: string, expected: BookingCodeExpectation): boolean {
  const [month, day, year] = expected.dateMdY.split('-').map(Number);
  const [hour, minute] = expected.time24.split(':').map(Number);
  if (![month, day, year, hour, minute].every(Number.isFinite) || month < 1 || month > 12) return false;
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const compact = text.toLowerCase().replace(/[^a-z0-9:]/g, '');
  const dateToken = `${months[month - 1]}${day}${year}`;
  const shortDateToken = `${months[month - 1].slice(0, 3)}${day}${year}`;
  const numericDateToken = `${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}${year}`;
  const hour12 = hour % 12 || 12;
  const timeToken = `${hour12}:${String(minute).padStart(2, '0')}${hour >= 12 ? 'pm' : 'am'}`;
  const paddedTimeToken = `${String(hour12).padStart(2, '0')}:${String(minute).padStart(2, '0')}${hour >= 12 ? 'pm' : 'am'}`;
  const dateMatches = compact.includes(dateToken) || compact.includes(shortDateToken) || compact.includes(numericDateToken);
  return dateMatches && (compact.includes(timeToken) || compact.includes(paddedTimeToken));
}

/** Pick a booking code from ForeUp message texts (newest first). Codes in
 * `exclude` were already rejected by ForeUp: when Red and Green both held the
 * same date+time, the released loser's code email is indistinguishable from
 * the winner's (the body has no course name), so checkout may need the next
 * candidate. */
export function pickBookingCode(
  textsNewestFirst: string[], expected?: BookingCodeExpectation, exclude: ReadonlySet<string> = new Set(),
): string | null {
  for (const plainText of textsNewestFirst) {
    if (expected && !bookingCodeContextMatches(plainText, expected)) continue;
    // "booking code is: XXXXXX" first (most reliable), then a standalone 6-digit number
    const code = plainText.match(/booking code\s*(?:is)?[:\s]+(\d{5,8})/i)?.[1] ?? plainText.match(/\b(\d{6})\b/)?.[1];
    if (code && !exclude.has(code)) return code;
  }
  return null;
}

/** Race a promise against a deadline (IMAP calls have no native timeout). */
function within<T>(p: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${timeoutMs}ms`)), timeoutMs); });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

export class EmailMonitor {
  private client: ImapFlow;
  private connected = false;
  private baselineCount = 0;
  private readonly email: string;
  private readonly appPassword: string;

  constructor(email: string, appPassword: string) {
    this.email = email;
    this.appPassword = appPassword;
    this.client = this.newClient();
  }

  private newClient(): ImapFlow {
    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: { user: this.email, pass: this.appPassword },
      logger: false,
    });
    client.on('close', () => { this.connected = false; });
    // ImapFlow emits 'error' on socket faults. With no listener, EventEmitter
    // THROWS — an uncaught exception that would kill a run mid-race. Mark the
    // session dead instead; the next use reconnects.
    client.on('error', (err: Error) => {
      this.connected = false;
      console.warn(`  ⚠ IMAP session error (${err?.message ?? err}) — will reconnect on next use`);
    });
    return client;
  }

  /** mailbox is `MailboxObject | false` — false while no mailbox is open */
  private mailboxCount(): number {
    const mb = this.client.mailbox;
    return mb ? mb.exists : 0;
  }

  async connect(): Promise<void> {
    if (this.connected && this.client.usable) return;
    if (!this.client.usable) this.client = this.newClient();
    await this.client.connect();
    const lock = await this.client.getMailboxLock('INBOX');
    this.baselineCount = this.mailboxCount();
    lock.release();
    this.connected = true;
  }

  /** Keep a long-running cancellation monitor's IMAP session healthy. No
   * booking-code email can exist before a hold, so refreshing the baseline
   * here is safe. Reconnect transparently if Gmail closed an idle socket. */
  async keepAlive(): Promise<void> {
    if (!this.connected || !this.client.usable) {
      this.connected = false;
      this.client = this.newClient();
      await this.connect();
      return;
    }
    await this.resetBaseline();
  }

  /** True while the IMAP session looks alive (it can still be half-open —
   * callers bound their waits). */
  isHealthy(): boolean {
    return this.connected && !!this.client.usable;
  }

  /** Checkout-path baseline: a bounded NOOP on the existing session; if the
   * socket is dead or half-open, reconnect once (connect() re-baselines).
   * The IMAP session idles through the whole drop, so this must never be
   * able to eat the 5-minute hold. */
  async ensureFreshBaseline(timeoutMs = 6000): Promise<void> {
    if (this.connected && this.client.usable) {
      try { await within(this.resetBaseline(), timeoutMs, 'IMAP baseline'); return; } catch { /* reconnect below */ }
    }
    this.connected = false;
    try { this.client.close(); } catch { /* already closed */ }
    this.client = this.newClient();
    await within(this.connect(), timeoutMs, 'IMAP reconnect');
  }

  /** Reset baseline to current message count — call right before clicking tee time */
  async resetBaseline(): Promise<void> {
    const lock = await this.client.getMailboxLock('INBOX');
    try {
      await this.client.noop();
      this.baselineCount = this.mailboxCount();
    } finally {
      lock.release();
    }
  }

  /** Poll for the booking code email. Returns the code string. */
  async waitForBookingCode(
    timeoutMs = 60_000, expected?: BookingCodeExpectation, exclude: ReadonlySet<string> = new Set(),
  ): Promise<string> {
    if (!this.connected) throw new Error('Not connected');

    const deadline = Date.now() + timeoutMs;
    const lock = await this.client.getMailboxLock('INBOX');

    try {
      while (Date.now() < deadline) {
        await this.client.noop();
        const current = this.mailboxCount();

        if (current > this.baselineCount) {
          // A returned code does not advance the baseline: if ForeUp rejects
          // it, the retry rescans this batch with that code excluded.
          const code = await this.scanNewMessages(this.baselineCount + 1, current, expected, exclude);
          if (code) return code;
          this.baselineCount = current;
        }

        await new Promise((r) => setTimeout(r, 400));
      }
    } finally {
      lock.release();
    }

    throw new Error('Timed out waiting for booking code');
  }

  private async scanNewMessages(
    from: number, to: number, expected?: BookingCodeExpectation, exclude: ReadonlySet<string> = new Set(),
  ): Promise<string | null> {
    const sources: Buffer[] = [];
    for await (const msg of this.client.fetch(`${from}:${to}`, { source: true })) {
      if (msg.source) sources.push(msg.source);
    }
    // A deliberate winner resend is newer than any auto-sent loser code.
    // Inspect newest-first so both arriving in one NOOP cycle stays safe.
    const texts: string[] = [];
    for (const source of sources.reverse()) {
      try {
        const parsed = await simpleParser(source);
        // Check sender first — only process foreUP emails
        const sender = parsed.from?.text?.toLowerCase() ?? '';
        if (!sender.includes('foreup') && !sender.includes('bethpage')) continue;
        // Search text body (not HTML — avoids matching CSS hex, tracking IDs)
        texts.push([parsed.subject, parsed.text].filter(Boolean).join(' '));
      } catch (e) {
        console.warn(`Could not parse a new booking-code email: ${(e as Error).message}`);
      }
    }
    return pickBookingCode(texts, expected, exclude);
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      try { await this.client.logout(); } catch {}
      this.connected = false;
    }
  }
}
