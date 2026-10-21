/**
 * Document numbers per till: invoices "T1-000123", returns "T1-R000012".
 * Six digits, growing past that if ever needed ("T1-1234567").
 */
export function formatDocNo(tillCode: string, seq: number, prefix: '' | 'R' = ''): string {
  return `${tillCode}-${prefix}${String(seq).padStart(6, '0')}`;
}

/** The next number: one more than the highest used, but never below the floor set after a restore. */
export function nextSeq(max: number | null, floor: number | null): number {
  return Math.max((max ?? 0) + 1, floor ?? 1);
}

/**
 * Reads what staff type or scan to find an invoice: "123", "t1 123", "T1-000123",
 * "T1000123". Returns the till code (if given) and the number.
 */
export function parseInvoiceQuery(
  text: string,
): { tillCode: string | null; seq: number; isReturn: boolean } | null {
  const t = text.trim().toUpperCase().replace(/\s+/g, ' ');
  let m = /^(\d{1,9})$/.exec(t);
  if (m) return { tillCode: null, seq: Number(m[1]), isReturn: false };
  // With a separator: "T1-000123", "T1 123", "T1-R000012".
  m = /^([A-Z][A-Z0-9]{0,9})[- ](R)?(\d{1,9})$/.exec(t);
  if (m) return { tillCode: m[1]!, seq: Number(m[3]), isReturn: m[2] === 'R' };
  // Without one (a scanned or typed "T1000123"): numbers are padded to six digits,
  // so the last six digits are the number and anything before them is the till code.
  m = /^([A-Z]+)(\d+)$/.exec(t);
  if (m) {
    const digits = m[2]!;
    if (digits.length <= 6) return { tillCode: m[1]!, seq: Number(digits), isReturn: false };
    return {
      tillCode: m[1]! + digits.slice(0, -6),
      seq: Number(digits.slice(-6)),
      isReturn: false,
    };
  }
  return null;
}
