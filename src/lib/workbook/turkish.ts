/**
 * Turkish-aware text folding, plus parsing/formatting for the money values
 * the master workbook stores as *text*.
 *
 * Two things in this file bite a naive implementation:
 *
 *  1. Casing. `"FİYATI".toLowerCase()` returns "fi̇yati" — an ASCII `i`
 *     followed by COMBINING DOT ABOVE (U+0307) — which never compares equal
 *     to the "fiyati" written in a config file. Dotless `ı` (U+0131) has the
 *     mirror problem. Both are folded explicitly *before* any case operation
 *     rather than relying on locale-aware toLowerCase, which is not
 *     guaranteed to be available in every runtime we deploy to.
 *
 *  2. Money. The workbook holds no numeric currency cells at all — the
 *     amounts are literal strings like "£ 12.308,22", written in the Turkish
 *     convention where `.` groups thousands and `,` is the decimal point.
 *     Zero is written as "£ -", not "£ 0,00".
 */

/**
 * Characters that must be resolved before case folding. Both cases of every
 * Turkish-specific letter are listed so the mapping never depends on the
 * host's locale.
 */
const FOLD: Record<string, string> = {
  'İ': 'i', 'I': 'i', 'ı': 'i', 'i': 'i',
  'Ğ': 'g', 'ğ': 'g',
  'Ü': 'u', 'ü': 'u',
  'Ş': 's', 'ş': 's',
  'Ö': 'o', 'ö': 'o',
  'Ç': 'c', 'ç': 'c',
  'Â': 'a', 'â': 'a',
  'Î': 'i', 'î': 'i',
  'Û': 'u', 'û': 'u',
};

/** Fold Turkish letters to their ASCII equivalents, preserving other text. */
export function foldTurkish(raw: string): string {
  let out = '';
  for (const ch of raw.normalize('NFC')) out += FOLD[ch] ?? ch;
  return out;
}

/**
 * Canonical form used for every header comparison.
 *
 * `Depot_OnHand`      -> "depot on hand"
 * `Toplam_Stok_Fiyatı` -> "toplam stok fiyati"
 * `TOPLAM STOK FİYATI` -> "toplam stok fiyati"
 *
 * camelCase is split before separators are collapsed, so a header written
 * without underscores still tokenises the same way as one that has them.
 */
export function normalizeHeader(raw: string): string {
  const spaced = raw
    // camelCase / PascalCase boundary, on the original text so the Turkish
    // letters still carry their case information.
    .replace(/([a-zçğıöşü0-9])([A-ZÇĞİÖŞÜ])/g, '$1 $2')
    // An acronym running into a word: "FNSKUCode" -> "FNSKU Code"
    .replace(/([A-ZÇĞİÖŞÜ]{2,})([A-ZÇĞİÖŞÜ][a-zçğıöşü])/g, '$1 $2');

  return foldTurkish(spaced)
    .toLowerCase()
    // Strip any combining marks left over from other alphabets.
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Whitespace-separated tokens of a normalised header. */
export function tokenize(normalized: string): string[] {
  return normalized ? normalized.split(' ') : [];
}

// --------------------------------------------------------------------------
// Numbers and money
// --------------------------------------------------------------------------

/**
 * Parse a decimal written in either the Turkish (1.234,56) or the
 * English (1,234.56) convention.
 *
 * The separator that appears *last* is the decimal point. When only one kind
 * of separator is present it is a decimal point only if it appears once and
 * is followed by one or two digits — so "1.234" reads as one thousand two
 * hundred and thirty-four, which is what the workbook means by it.
 */
export function parseFlexibleDecimal(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,-]/g, '').trim();
  if (!cleaned || cleaned === '-') return null;

  const negative = cleaned.startsWith('-');
  const digits = cleaned.replace(/-/g, '');
  if (!digits) return null;

  const lastDot = digits.lastIndexOf('.');
  const lastComma = digits.lastIndexOf(',');

  let intPart: string;
  let decPart = '';

  if (lastDot >= 0 && lastComma >= 0) {
    const decIndex = Math.max(lastDot, lastComma);
    intPart = digits.slice(0, decIndex).replace(/[.,]/g, '');
    decPart = digits.slice(decIndex + 1).replace(/[.,]/g, '');
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sepIndex = Math.max(lastDot, lastComma);
    const sep = digits[sepIndex];
    const occurrences = digits.split(sep).length - 1;
    const trailing = digits.length - sepIndex - 1;
    if (occurrences === 1 && trailing > 0 && trailing <= 2) {
      intPart = digits.slice(0, sepIndex);
      decPart = digits.slice(sepIndex + 1);
    } else {
      intPart = digits.replace(/[.,]/g, '');
    }
  } else {
    intPart = digits;
  }

  const value = Number(`${intPart || '0'}.${decPart || '0'}`);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/**
 * How the workbook writes money, learned from the cells already in it rather
 * than hard-coded, so a switch from `£` to `₺` needs no code change.
 */
export type MoneyStyle = {
  /** Text before the digits of a positive amount, e.g. "£ ". */
  prefix: string;
  /** Text after the digits, for locales that put the symbol last. */
  suffix: string;
  /** Verbatim text used for a zero amount, e.g. "£ -". */
  zeroText: string;
  /** Where the minus sign goes relative to the prefix. */
  minusBeforePrefix: boolean;
};

export const DEFAULT_MONEY_STYLE: MoneyStyle = {
  prefix: '£ ',
  suffix: '',
  zeroText: '£ -',
  minusBeforePrefix: true,
};

/**
 * Infer the money style from existing cells.
 *
 * Zero is sampled separately from non-zero amounts: the workbook writes
 * "£ -" for nothing-in-stock, and reproducing that exactly is what keeps a
 * re-synced sheet looking untouched next to one that was edited by hand.
 */
export function detectMoneyStyle(samples: string[]): MoneyStyle {
  const prefixes = new Map<string, number>();
  const suffixes = new Map<string, number>();
  const zeros = new Map<string, number>();
  let minusBeforePrefix = 0;
  let minusAfterPrefix = 0;

  for (const sample of samples) {
    const text = sample?.trim();
    if (!text) continue;

    const firstDigit = text.search(/\d/);
    if (firstDigit < 0) {
      // No digits at all — this is how zero is written.
      if (/[-–—]/.test(text)) zeros.set(text, (zeros.get(text) ?? 0) + 1);
      continue;
    }

    const lastDigit = text.length - 1 - [...text].reverse().findIndex(c => /\d/.test(c));
    let prefix = text.slice(0, firstDigit);
    const suffix = text.slice(lastDigit + 1);

    if (prefix.startsWith('-')) {
      minusBeforePrefix++;
      prefix = prefix.slice(1);
    } else if (/-\s*$/.test(prefix)) {
      minusAfterPrefix++;
      prefix = prefix.replace(/-\s*$/, '');
    }

    prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
    suffixes.set(suffix, (suffixes.get(suffix) ?? 0) + 1);
  }

  const most = (m: Map<string, number>, fallback: string) => {
    let best = fallback;
    let bestCount = 0;
    for (const [key, count] of m) {
      if (count > bestCount) { best = key; bestCount = count; }
    }
    return bestCount > 0 ? best : fallback;
  };

  const prefix = most(prefixes, DEFAULT_MONEY_STYLE.prefix);
  const suffix = most(suffixes, DEFAULT_MONEY_STYLE.suffix);
  return {
    prefix,
    suffix,
    zeroText: most(zeros, `${prefix}-${suffix}`),
    minusBeforePrefix: minusAfterPrefix > minusBeforePrefix ? false : true,
  };
}

/** Format an amount the way the workbook already writes them. */
export function formatMoney(value: number, style: MoneyStyle = DEFAULT_MONEY_STYLE): string {
  // `+ Number.EPSILON` nudges values that landed a hair below the .005
  // boundary in binary floating point, so 0.615 rounds up like a human expects.
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  if (rounded === 0) return style.zeroText;

  const negative = rounded < 0;
  const [intPart, decPart] = Math.abs(rounded).toFixed(2).split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const body = `${style.prefix}${grouped},${decPart}${style.suffix}`;

  if (!negative) return body;
  return style.minusBeforePrefix
    ? `-${body}`
    : `${style.prefix}-${grouped},${decPart}${style.suffix}`;
}

/** Parse a quantity cell that may be a number or numeric text. */
export function parseQuantity(raw: unknown): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  if (typeof raw !== 'string') return 0;
  const parsed = parseFlexibleDecimal(raw);
  return parsed ?? 0;
}
