export type ModalIdentityField = 'time' | 'date' | 'course';

export interface ModalIdentityMismatch {
  what: ModalIdentityField;
  needle: string;
}

/** Fields copied from a neighboring sheet that ForeUp's 16-field
 * createPending payload cannot safely reconstruct from course constants or
 * the TimeModel defaults. Zero and false are legitimate fee/trade values. */
export const SPEC_TEMPLATE_REQUIRED_FIELDS = [
  'time',
  'available_spots',
  'teesheet_side_id',
  'foreup_discount',
  'foreup_trade_discount_rate',
  'trade_min_players',
  'cart_fee',
  'cart_fee_tax',
  'green_fee',
  'green_fee_tax',
] as const;

export function missingSpecTemplateFields(payload: Record<string, unknown>): string[] {
  return SPEC_TEMPLATE_REQUIRED_FIELDS.filter((field) =>
    !Object.prototype.hasOwnProperty.call(payload, field)
      || payload[field] === undefined
      || payload[field] === null);
}

/** Bound a promise that has no native timeout (notably page.evaluate around
 * ForeUp's jqXHR). The original promise remains observed if the fallback wins,
 * so a later rejection cannot become unhandled. */
export async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Pure identity gate shared by the race settlement path and checkout.
 * Whitespace normalization mirrors what ForeUp's modal renders while keeping
 * the comparison deliberately exact for course, date, and time. */
export function firstModalIdentityMismatch(
  modalTextRaw: string,
  expected: { time: string; date: string; course: string },
): ModalIdentityMismatch | null {
  const modalText = modalTextRaw.replace(/\s+/g, ' ');
  for (const [what, needle] of Object.entries(expected) as Array<[ModalIdentityField, string]>) {
    if (!modalText.includes(needle)) return { what, needle };
  }
  return null;
}

/** How SPEC runs this time. A sheet that is already live is only a SPEC
 * mechanism test in a $0 mode; a money run there must race the real times
 * (detect walk + vulture) instead of one blind shot at a predicted slot. */
export function specRunMode(o: { spec: boolean; sheetAlreadyLive: boolean; specCount: number; zeroDollarMode: boolean }): 'off' | 'live_sheet_test' | 'drop' {
  if (!o.spec || o.specCount === 0) return 'off';
  if (!o.sheetAlreadyLive) return 'drop';
  return o.zeroDollarMode ? 'live_sheet_test' : 'off';
}

/** Vulture per-slot backoff: a slot that keeps rejecting is retried after
 * 20s, 40s, 80s, then every 160s, so listed-but-unholdable slots cannot burn
 * the account's hold budget before the +5-minute expiry wave. */
export function vultureRetryDelayMs(rejections: number, baseMs = 20_000, capMs = 160_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, rejections - 1));
}

/** "Invalid request" is ForeUp's soft rate-limit answer to a hold (distinct
 * from "Time not available", which only means the slot is contested). */
export const isSoftLimitRejection = (body: string): boolean => /invalid request/i.test(body);

/** The date tonight's 7:00pm ET drop releases (ET today + 7), independent of
 * the machine's timezone. */
export function etDropTargetDate(nowMs: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(nowMs));
  const get = (type: string) => Number(parts.find((x) => x.type === type)?.value);
  const d = new Date(Date.UTC(get('year'), get('month') - 1, get('day') + 7));
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}-${d.getUTCFullYear()}`;
}

/** What a times poll actually said. Only 'empty' means "not released yet":
 * an auth/class rejection ({"success":false}) or a WAF block must never be
 * mistaken for it, or the drop detector goes silently blind. */
export type PollKind = 'times' | 'empty' | 'rejected' | 'blocked';
export function classifyTimesResponse(status: number, text: string): { kind: PollKind; times: unknown[] | null } {
  if (status === 403 || status === 429 || status >= 500) return { kind: 'blocked', times: null };
  if (!text || text === 'false') return { kind: 'empty', times: null };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { kind: 'blocked', times: null }; } // WAF/HTML page
  if (Array.isArray(parsed)) return parsed.length ? { kind: 'times', times: parsed } : { kind: 'empty', times: null };
  return { kind: 'rejected', times: null };
}

/** Drop-poll schedule relative to the release epoch. One sentinel lane from
 * T-1000 insures against an early or clock-skewed release (re-based July
 * telemetry put the flip anywhere from ~T-180 to ~T+20); full density only
 * inside [T-350, T+400], then a gentler cadence. If the sheet is still not
 * out by T+5s the release is late: drop to a slow tail so the poll budget
 * covers ~2 more minutes instead of burning out in 30s. null = not yet. */
export interface PollPhase { maxInFlight: number; minGapMs: number }
export function pollPhase(tRelMs: number, concurrency: number, staggerMs: number): PollPhase | null {
  if (tRelMs < -1000) return null;
  if (tRelMs < -350) return { maxInFlight: 1, minGapMs: 100 };
  if (tRelMs < 400) return { maxInFlight: Math.max(1, concurrency), minGapMs: Math.max(staggerMs, 15) };
  if (tRelMs < 5000) return { maxInFlight: Math.max(1, concurrency), minGapMs: 50 };
  return { maxInFlight: Math.min(2, Math.max(1, concurrency)), minGapMs: 250 };
}

/** Vulture cadence. The minutes right after a lost race are the best ones:
 * unpaid holds expire at exactly +5 min and get re-listed, so poll every
 * second through that wave whatever the long-monitor cadence is (a 60s
 * cancellation watch would sleep straight through it). After the fast phase
 * the configured cadence applies. */
export const VULTURE_FAST_PHASE_MS = 8 * 60_000;
export function vulturePollDelayMs(elapsedSinceDropMs: number, configuredMs: number, fastMs = 1000): number {
  return elapsedSinceDropMs < VULTURE_FAST_PHASE_MS ? Math.min(configuredMs, fastMs) : configuredMs;
}

/** Keep-alive sockets to open just before the drop: one per first-wave poll
 * lane across courses (undici drops idle sockets after ~4s). */
export function poolWarmSockets(concurrency: number, courses: number, cap = 12): number {
  return Math.max(1, Math.min(cap, Math.floor(concurrency) * Math.max(1, Math.floor(courses))));
}

/** The online booking fee ForeUp lists on the slot itself (every Bethpage
 * row carries booking_fee_price / booking_fee_per_person; Red is $5/person).
 * Money gate #5 compares the card window against THIS, so a course whose
 * fee differs is verified instead of aborted. Implausible or missing values
 * fall back to the mapped $5/person. */
export function bookingFeeTotal(
  slot: Record<string, unknown>,
  players: number, fallbackPerPlayer = 5, maxPerPlayer = 25,
): number {
  const price = Number(slot.booking_fee_price);
  if (!Number.isFinite(price) || price <= 0 || price > maxPerPlayer) return fallbackPerPlayer * players;
  return slot.booking_fee_per_person === false ? price : price * players;
}
