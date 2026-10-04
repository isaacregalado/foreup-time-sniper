/**
 * SPEC prediction — pure functions shared by turbo.ts and tests.ts.
 *
 * SPEC blind-fires a hold at a PREDICTED slot of a sheet that does not exist
 * yet. createPending _.picks 16 fields; everything except the fees is a
 * per-course constant, and the slot times sit on a fixed 9-minute lattice.
 * The fees are the hard part: Bethpage prices every slot at the full rate
 * until a seasonal twilight switch (Red weekday $43 → $26, Green $38 → $23,
 * Red weekend twilight $29), and published neighbor sheets only ever show the
 * leftover AFTERNOON. So a morning prediction may only take its fee fields
 * from a row that PROVES it is full-rate:
 *   - 'morning' — a plain row at/before noon (no season prices twilight then)
 *   - 'step'    — the earliest row of a sheet whose later rows drop to a
 *                 strictly lower fee (it is on the pre-twilight side)
 * A clock cutoff ("anything before 4pm") is NOT proof: the twilight switch
 * moves earlier every fall.
 */

export interface SpecTime { time: string; available_spots?: number; [k: string]: any }

export type SnapshotKind = 'drop-first-hit' | 'preflight-live' | 'neighbor-scout';
export interface SheetRecord { course: string; date: string; savedAt: string; kind?: SnapshotKind; times: SpecTime[] }
export type DayClass = 'weekday' | 'weekend';
export interface FullRateAnchor { t: SpecTime; min: number; date: string; evidence: 'morning' | 'step' }

export const SPEC_LATTICE_MIN = 9;          // every saved Bethpage slot: gcd 9, phase 3 (6:30, 6:39 … 8:27)
export const FULL_RATE_PROOF_MIN = 12 * 60; // a plain row at/before noon is full rate
export const FEE_ERA_DAYS = 14;             // a never-seen fee >14 days after an anchor = prices moved

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "07-14-2026" → "2026-07-14" (the ApiTime.time date part). */
export function isoDate(mdY: string): string {
  const [m, d, y] = mdY.split('-');
  return `${y}-${m}-${d}`;
}

export function isWeekendDate(mdY: string): boolean {
  const [m, d, y] = mdY.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

/** Weekend and holiday dates share the weekend fee column. Holidays are an
 *  explicit opt-in list (SPEC_HOLIDAYS) — never a guessed calendar. */
export function dayClassOf(mdY: string, holidays: ReadonlySet<string> = new Set()): DayClass {
  return isWeekendDate(mdY) || holidays.has(mdY) ? 'weekend' : 'weekday';
}

export function mdYDayNum(mdY: string): number {
  const [m, d, y] = mdY.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 864e5;
}

export function slotMinOf(t: SpecTime): number {
  const [hh, mm] = (t.time.split(' ')[1] ?? '').split(':').map(Number);
  return hh * 60 + mm;
}

/** Scout-date preference order for a target: the other published dates
 *  (today..today+6 are always live regardless of the 7pm cutoff), same
 *  day class first — the fee columns differ — then closest to the target. */
export function specScoutDates(targetMdY: string, todayMdY: string, holidays: ReadonlySet<string> = new Set()): string[] {
  const [tm, td, ty] = todayMdY.split('-').map(Number);
  const out: string[] = [];
  // today+7 is live after the 7pm drop — pollTimes just returns null before.
  for (let i = 0; i <= 7; i++) {
    const d = new Date(Date.UTC(ty, tm - 1, td + i));
    const s = `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}-${d.getUTCFullYear()}`;
    if (s !== targetMdY) out.push(s);
  }
  const cls = dayClassOf(targetMdY, holidays);
  const tgtN = mdYDayNum(targetMdY);
  return out.sort((a, b) => {
    const aw = dayClassOf(a, holidays) === cls ? 0 : 1, bw = dayClassOf(b, holidays) === cls ? 0 : 1;
    if (aw !== bw) return aw - bw;
    return Math.abs(mdYDayNum(a) - tgtN) - Math.abs(mdYDayNum(b) - tgtN);
  });
}

/** Merge scouted sheets into one per-time-of-day template. First scout that
 *  has a time-of-day wins — pass scouts in preference order (observed rows
 *  before inferred ones). Availability is irrelevant; only fields matter. */
export function mergeSpecTemplate(scoutsInPreferenceOrder: SpecTime[][]): Map<string, SpecTime> {
  const tpl = new Map<string, SpecTime>();
  for (const times of scoutsInPreferenceOrder) {
    for (const t of times ?? []) {
      const hhmm = t.time.split(' ')[1];
      if (hhmm && !tpl.has(hhmm)) tpl.set(hhmm, t);
    }
  }
  return tpl;
}

/** Specials, groups and trade inventory carry their own prices. */
export function isPlainRateSlot(t: SpecTime): boolean {
  return !t.has_special && !t.special_id && !t.group_id && !t.is_designated_trade && !t.foreup_discount;
}

/** The pre-twilight row a single sheet PROVES, if any (see file header). */
export function fullRateAnchorOf(rec: SheetRecord): FullRateAnchor | null {
  const rows = rec.times.filter(isPlainRateSlot)
    .map((t) => ({ t, min: slotMinOf(t) }))
    .filter((x) => Number.isFinite(x.min) && Number.isFinite(Number(x.t.green_fee)))
    .sort((a, b) => a.min - b.min);
  const first = rows[0];
  if (!first) return null;
  const morning = rows.filter((x) => x.min <= FULL_RATE_PROOF_MIN);
  if (morning.length) return { ...morning[morning.length - 1], date: rec.date, evidence: 'morning' };
  const fee = Number(first.t.green_fee);
  return rows.some((x) => x.min > first.min && Number(x.t.green_fee) < fee)
    ? { ...first, date: rec.date, evidence: 'step' }
    : null;
}

/** Best proven anchor for course + day class across the whole immutable
 *  sheet library. Morning proof beats step proof, then the newest date. A
 *  step anchor must carry the top plain fee seen for the class (guards a
 *  twilight → super-twilight step). An anchor is stale once a sheet more than
 *  FEE_ERA_DAYS newer shows a fee this class had NEVER shown up to the
 *  anchor's era — prices moved (season change), so its fees are unproven. */
export function pickFullRateAnchor(
  recs: SheetRecord[], courseKey: string, targetMdY: string,
  holidays: ReadonlySet<string> = new Set(), maxAgeDays = 180,
): { anchor: FullRateAnchor | null; reason: string } {
  const cls = dayClassOf(targetMdY, holidays);
  const tgt = mdYDayNum(targetMdY);
  const same = recs.filter((r) => r.course === courseKey && r.date !== targetMdY
    && dayClassOf(r.date, holidays) === cls && Math.abs(mdYDayNum(r.date) - tgt) <= maxAgeDays);
  const plainFees = (r: SheetRecord) => r.times.filter(isPlainRateSlot).map((t) => Number(t.green_fee)).filter(Number.isFinite);
  const allFees = same.flatMap(plainFees);
  const topFee = allFees.length ? Math.max(...allFees) : -Infinity;
  const anchors = same.map(fullRateAnchorOf).filter((a): a is FullRateAnchor => !!a)
    .filter((a) => a.evidence === 'morning' || Number(a.t.green_fee) >= topFee)
    .filter((a) => {
      const day = mdYDayNum(a.date);
      const era = new Set(same.filter((r) => mdYDayNum(r.date) <= day + FEE_ERA_DAYS).flatMap(plainFees));
      return !same.some((r) => mdYDayNum(r.date) > day + FEE_ERA_DAYS && plainFees(r).some((f) => !era.has(f)));
    })
    .sort((a, b) => (a.evidence === b.evidence ? 0 : a.evidence === 'morning' ? -1 : 1)
      || mdYDayNum(b.date) - mdYDayNum(a.date) || a.min - b.min);
  if (anchors[0]) return { anchor: anchors[0], reason: '' };
  const seen = [...new Set(allFees)].sort((a, b) => b - a).join('/') || 'none';
  return {
    anchor: null,
    reason: `no proven full-rate ${courseKey}/${cls} fee in ${same.length} sheet(s) (green fees seen: ${seen}) — capture a ${cls} drop sheet with --dry-run --capture-drop`,
  };
}

/** Lattice phase (minute mod 9) from EVERY sheet of the course — slot times
 *  are rate-agnostic. null when sheets disagree (the grid changed). */
export function latticePhase(recs: SheetRecord[], courseKey: string, step = SPEC_LATTICE_MIN): number | null {
  const phases = new Set(recs.filter((r) => r.course === courseKey)
    .flatMap((r) => r.times.map((t) => slotMinOf(t)).filter(Number.isFinite).map((m) => ((m % step) + step) % step)));
  return phases.size === 1 ? [...phases][0] : null;
}

/** Every lattice slot inside the window, carrying the anchor's fields. */
export function predictWindowFromAnchor(
  a: FullRateAnchor, phase: number | null, windowStart: number, windowEnd: number, step = SPEC_LATTICE_MIN,
): SpecTime[] {
  if (phase === null || ((a.min % step) + step) % step !== phase) return [];
  const datePart = a.t.time.split(' ')[0];
  const out: SpecTime[] = [];
  for (let min = windowStart; min <= windowEnd; min++) {
    if ((((min - phase) % step) + step) % step !== 0) continue;
    out.push({ ...a.t, time: `${datePart} ${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`, spec_inferred: true, spec_evidence: `${a.evidence}:${a.date}` });
  }
  return out;
}

/** Predict the target date's sheet: template slots with the date swapped in.
 *  available_spots becomes the hold's `players` (viewTime copies it), and the
 *  server rejects players > actual spots ("Time not available" — live-proven
 *  on a 1-spot leftover). So ask for exactly what we need. start_front and the
 *  per-holes spot count are re-derived so the model matches a real tile
 *  (start_front uses a zero-based month on every observed row). */
export function specPredictTimes(tpl: Map<string, SpecTime>, targetMdY: string, players: number, holes = 18): Array<SpecTime & { available_spots: number }> {
  const iso = isoDate(targetMdY);
  const [y, m, d] = iso.split('-');
  return [...tpl.entries()].map(([hhmm, t]) => ({
    ...t,
    time: `${iso} ${hhmm}`,
    start_front: Number(`${y}${pad2(Number(m) - 1)}${d}${hhmm.replace(':', '')}`),
    available_spots: players,
    ...(holes === 18 ? { available_spots_18: players } : holes === 9 ? { available_spots_9: players } : {}),
  }));
}

/** Fields compared between an armed prediction and the real drop sheet. */
export const SPEC_CHECK_FIELDS = [
  'teesheet_side_id', 'foreup_discount', 'foreup_trade_discount_rate', 'trade_min_players',
  'cart_fee', 'cart_fee_tax', 'green_fee', 'green_fee_tax',
] as const;

export function specPayloadDiff(pred: SpecTime, actual: SpecTime | undefined): string[] {
  if (!actual) return ['<slot absent from first drop sheet>'];
  return SPEC_CHECK_FIELDS.filter((f) => JSON.stringify(pred[f]) !== JSON.stringify(actual[f]));
}

/** Which predicted slot a SPEC shot should fire at, or undefined to yield.
 *  `seenTimes` is the first detected sheet for the course (undefined while
 *  still blind). While blind every shot aims the top prediction: a rejected
 *  first shot most likely arrived before the release, so the backup re-aims
 *  the best slot instead of spending itself on a worse one. Once a poll has
 *  seen the sheet, the informed detect walk owns the next hold (the preferred
 *  actor is parked behind SPEC): the first shot still fires if the sheet
 *  lists its slot, every other shot yields so it cannot delay that walk. */
export function specShotTarget<T>(
  ranked: T[], shotIdx: number, seenTimes: ReadonlySet<string> | undefined, timeOf: (c: T) => string,
): T | undefined {
  const top = ranked[0];
  if (top === undefined) return undefined;
  if (!seenTimes) return top;
  return shotIdx === 0 && seenTimes.has(timeOf(top)) ? top : undefined;
}

export function specShotIsLate(actualOffsetMs: number, scheduledOffsetMs: number, toleranceMs = 150): boolean {
  return actualOffsetMs > scheduledOffsetMs + toleranceMs;
}

export function snapshotFileName(courseKey: string, date: string, savedAt: string, seq: number, kind: SnapshotKind, pid: number): string {
  const stamp = savedAt.replace(/[^0-9]/g, '');
  return `${courseKey}-${date}-${stamp}-${pid}-${String(seq).padStart(3, '0')}-${kind}.json`;
}
