/**
 * Exact decimal arithmetic for t.decimal(scale) columns (Design §8).
 *
 * Decimals live as canonical strings — exactly `scale` fraction digits, no
 * leading zeros, no "-0" — so string equality coincides with numeric equality
 * (which is what makes GROUP BY / DISTINCT / join / unique keys correct with
 * no special casing). Ordering and arithmetic go through scaled BigInt, so
 * precision is arbitrary and SUM can never overflow.
 *
 * All rounding here is half-up, documented in the SQL docs.
 */
import { SqlError } from "./sql/errors";

const DEC_RE = /^-?\d+(\.\d+)?$/;

export const MAX_SCALE = 12;

/** Parse a decimal source string into scaled BigInt at `scale`. Throws
 * TYPE_MISMATCH when the text isn't a plain decimal numeral or has more
 * fraction digits than the scale allows (accuracy-first: never round input
 * silently). */
export function parseDecimal(text: string, scale: number, context: string): bigint {
  const s = text.trim();
  if (!DEC_RE.test(s)) {
    throw new SqlError(
      "TYPE_MISMATCH",
      `${context}: "${text}" is not a decimal numeral — use plain digits like 123.45 (no exponents)`,
    );
  }
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [int, frac = ""] = body.split(".");
  if (frac.length > scale) {
    throw new SqlError(
      "TYPE_MISMATCH",
      `${context}: "${text}" has ${frac.length} fraction digits but the column is decimal(${scale}) — round it explicitly`,
    );
  }
  const scaled = BigInt(int + frac.padEnd(scale, "0"));
  return neg ? -scaled : scaled;
}

/** Scaled BigInt → canonical string at `scale`. */
export function formatDecimal(scaled: bigint, scale: number): string {
  const neg = scaled < 0n;
  const abs = (neg ? -scaled : scaled).toString().padStart(scale + 1, "0");
  const int = abs.slice(0, abs.length - scale) || "0";
  const frac = scale > 0 ? "." + abs.slice(abs.length - scale) : "";
  const out = int + frac;
  return neg && scaled !== 0n ? "-" + out : out;
}

/** Canonicalize arbitrary input (string or number) to the column's canonical
 * form. Numbers go through String(n) — the shortest round-trip representation,
 * i.e. the digits the author typed for anything a double can carry. */
export function canonDecimal(value: string | number, scale: number, context: string): string {
  const text = typeof value === "number" ? String(value) : value;
  return formatDecimal(parseDecimal(text, scale, context), scale);
}

/** True if the string is already in canonical form for `scale`. */
export function isCanonicalDecimal(value: string, scale: number): boolean {
  try {
    return formatDecimal(parseDecimal(value, scale, "check"), scale) === value;
  } catch {
    return false;
  }
}

/** Numeric comparison of two decimal strings (may be at different scales). */
export function cmpDecimal(a: string, b: string): number {
  const sa = fracLen(a);
  const sb = fracLen(b);
  const s = Math.max(sa, sb);
  const va = parseDecimal(a, s, "compare");
  const vb = parseDecimal(b, s, "compare");
  return va < vb ? -1 : va > vb ? 1 : 0;
}

export function fracLen(s: string): number {
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

/** Rescale a scaled BigInt from one scale to another. Widening is exact;
 * narrowing rounds half-up (used only by explicit ops that document it). */
export function rescale(scaled: bigint, from: number, to: number): bigint {
  if (to === from) return scaled;
  if (to > from) return scaled * 10n ** BigInt(to - from);
  const div = 10n ** BigInt(from - to);
  return divHalfUp(scaled, div);
}

/** BigInt division rounding half-up (away from zero on .5). */
export function divHalfUp(n: bigint, d: bigint): bigint {
  const neg = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = (an * 2n + ad) / (ad * 2n);
  return neg ? -q : q;
}
