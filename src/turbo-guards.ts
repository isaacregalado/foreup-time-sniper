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
