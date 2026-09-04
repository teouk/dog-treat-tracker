import { normalizeHeader, tokenize, detectMoneyStyle, type MoneyStyle } from './turkish';
import {
  COLUMN_SPECS, TOTAL_ROW_LABELS, TOTAL_LABEL_SEARCH_WIDTH, HEADER_SEARCH_DEPTH,
  FUZZY_MIN_SCORE, FUZZY_MIN_MARGIN,
  type ColumnKey, type ColumnSpec,
} from './schema';
import type { SheetGrid } from './read';

/**
 * Turns an arbitrary sheet into a map of "which column holds what", without
 * relying on the headers being in English, in a particular order, or on row 1.
 */

export type ResolvedColumn = {
  key: ColumnKey;
  /** 1-based column index. */
  index: number;
  /** The header text exactly as it appears in the sheet. */
  header: string;
  /** How the alias was matched, for the diagnostics endpoint. */
  matchedBy: 'exact' | 'tokens' | 'substring' | 'fuzzy';
  confidence: number;
};

export type SheetLayout = {
  headerRow: number;
  columns: Record<ColumnKey, ResolvedColumn | undefined>;
  /** First and last row of product data, inclusive. */
  firstDataRow: number;
  lastDataRow: number;
  /** Row holding the grand total, when one was found. */
  totalRow: number | null;
  totalLabel: string | null;
  moneyStyle: MoneyStyle;
  /** Headers present in the sheet that matched nothing — surfaced, not hidden. */
  unmatchedHeaders: string[];
  warnings: string[];
};

// --------------------------------------------------------------------------
// Scoring
// --------------------------------------------------------------------------

/** Damerau-free Levenshtein distance, iterative two-row form. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - levenshtein(a, b) / longest;
}

type Match = { score: number; matchedBy: ResolvedColumn['matchedBy'] };

/**
 * Score one sheet header against one logical column.
 *
 * The tiers are ordered by how much evidence they carry, and the numbers are
 * spread far enough apart that a weaker tier can never outrank a stronger one:
 *
 *   exact      1.00  — the normalised header is an alias verbatim
 *   tokens     0.90  — every alias word is present, e.g. "amazon qty uk (fba)"
 *   substring  0.80  — the alias appears inside the header
 *   fuzzy      <0.80 — edit distance, and only if it clears FUZZY_MIN_SCORE
 */
function scoreHeader(normalized: string, spec: ColumnSpec): Match {
  if (!normalized) return { score: 0, matchedBy: 'fuzzy' };

  const headerTokens = new Set(tokenize(normalized));
  let best: Match = { score: 0, matchedBy: 'fuzzy' };

  for (const alias of spec.aliases) {
    if (normalized === alias) return { score: 1, matchedBy: 'exact' };

    const aliasTokens = tokenize(alias);
    if (aliasTokens.length > 0 && aliasTokens.every(t => headerTokens.has(t))) {
      // Longer aliases are stronger evidence: "amazon qty" beats bare "amazon"
      // when both fit, so `Amazon_Qty_UK` cannot be claimed by a looser spec.
      const score = 0.9 + Math.min(aliasTokens.length, 5) * 0.005;
      if (score > best.score) best = { score, matchedBy: 'tokens' };
      continue;
    }

    if (alias.length >= 4 && (normalized.includes(alias) || alias.includes(normalized))) {
      const score = 0.8 + Math.min(alias.length, 20) * 0.002;
      if (score > best.score) best = { score, matchedBy: 'substring' };
      continue;
    }

    const sim = similarity(normalized, alias);
    if (sim > best.score && sim < 0.8) best = { score: sim, matchedBy: 'fuzzy' };
  }

  return best;
}

// --------------------------------------------------------------------------
// Header row discovery
// --------------------------------------------------------------------------

type HeaderCandidate = { row: number; score: number; matches: number };

function scoreHeaderRow(grid: SheetGrid, row: number): HeaderCandidate {
  let total = 0;
  let matches = 0;
  const claimed = new Set<ColumnKey>();

  for (let col = 1; col <= Math.max(grid.columnCount, 1); col++) {
    const normalized = normalizeHeader(grid.text(row, col));
    if (!normalized) continue;
    for (const spec of COLUMN_SPECS) {
      if (claimed.has(spec.key)) continue;
      const m = scoreHeader(normalized, spec);
      if (m.score >= 0.8) {
        claimed.add(spec.key);
        total += spec.required ? m.score * 2 : m.score;
        matches++;
        break;
      }
    }
  }
  return { row, score: total, matches };
}

/**
 * Find the header row rather than assuming row 1 — the owner may add a title
 * banner above the table at any time.
 */
function findHeaderRow(grid: SheetGrid): number {
  const depth = Math.min(HEADER_SEARCH_DEPTH, Math.max(grid.rowCount, 1));
  let best: HeaderCandidate = { row: 1, score: -1, matches: 0 };
  for (let row = 1; row <= depth; row++) {
    const candidate = scoreHeaderRow(grid, row);
    if (candidate.score > best.score) best = candidate;
  }
  if (best.matches === 0) {
    throw new Error(
      `Could not find a header row in the first ${depth} rows of "${grid.sheetName}". ` +
      `No column matched any known Turkish or English name.`
    );
  }
  return best.row;
}

// --------------------------------------------------------------------------
// Column resolution
// --------------------------------------------------------------------------

/**
 * Assign columns to logical fields.
 *
 * Every (column, field) pair is scored, then the pairs are consumed in
 * descending score order so the strongest evidence wins globally — a header
 * reading `Amazon_Qty_UK` claims `amazonQty` before the weaker `amazon` alias
 * can, and neither a column nor a field is ever assigned twice.
 */
function resolveColumns(grid: SheetGrid, headerRow: number): {
  columns: Record<ColumnKey, ResolvedColumn | undefined>;
  unmatchedHeaders: string[];
  warnings: string[];
} {
  type Pair = { col: number; header: string; spec: ColumnSpec } & Match;
  const pairs: Pair[] = [];
  const headers = new Map<number, string>();

  const width = Math.max(grid.columnCount, 1);
  for (let col = 1; col <= width; col++) {
    const header = grid.text(headerRow, col);
    if (!header) continue;
    headers.set(col, header);
    const normalized = normalizeHeader(header);
    for (const spec of COLUMN_SPECS) {
      const m = scoreHeader(normalized, spec);
      if (m.score > 0) pairs.push({ col, header, spec, ...m });
    }
  }

  pairs.sort((a, b) => b.score - a.score);

  const columns = {} as Record<ColumnKey, ResolvedColumn | undefined>;
  const takenCols = new Set<number>();
  const warnings: string[] = [];
  // Track the best rejected score per field so a fuzzy win can be checked
  // against its runner-up.
  const runnerUp = new Map<ColumnKey, number>();

  for (const pair of pairs) {
    if (columns[pair.spec.key] || takenCols.has(pair.col)) {
      if (!runnerUp.has(pair.spec.key)) runnerUp.set(pair.spec.key, pair.score);
      continue;
    }

    if (pair.matchedBy === 'fuzzy') {
      if (pair.score < FUZZY_MIN_SCORE) continue;
      const second = runnerUp.get(pair.spec.key) ?? 0;
      if (pair.score - second < FUZZY_MIN_MARGIN) {
        warnings.push(
          `Ignored an ambiguous fuzzy match for ${pair.spec.label}: ` +
          `"${pair.header}" scored ${pair.score.toFixed(2)} with a rival at ${second.toFixed(2)}.`
        );
        continue;
      }
      warnings.push(
        `Column ${columnLetter(pair.col)} "${pair.header}" was matched to ` +
        `${pair.spec.label} by similarity only (${pair.score.toFixed(2)}). ` +
        `Add it to COLUMN_SPECS aliases to make this exact.`
      );
    }

    columns[pair.spec.key] = {
      key: pair.spec.key,
      index: pair.col,
      header: pair.header,
      matchedBy: pair.matchedBy,
      confidence: Number(pair.score.toFixed(3)),
    };
    takenCols.add(pair.col);
  }

  const missing = COLUMN_SPECS.filter(s => s.required && !columns[s.key]);
  if (missing.length > 0) {
    const found = [...headers.entries()]
      .map(([col, h]) => `${columnLetter(col)}="${h}"`)
      .join(', ') || '(no headers on that row)';
    throw new Error(
      `Could not locate required column(s): ${missing.map(m => m.label).join(', ')}. ` +
      `Headers found on row ${headerRow}: ${found}. ` +
      `Add the sheet's wording to COLUMN_SPECS in src/lib/workbook/schema.ts.`
    );
  }

  const unmatchedHeaders = [...headers.entries()]
    .filter(([col]) => !takenCols.has(col))
    .map(([col, h]) => `${columnLetter(col)}="${h}"`);

  return { columns, unmatchedHeaders, warnings };
}

// --------------------------------------------------------------------------
// Row ranges and the grand total
// --------------------------------------------------------------------------

/**
 * Locate the grand-total row.
 *
 * Only the few columns immediately left of the total column are searched. The
 * master workbook keeps a separate accounting block further right that also
 * says `GENEL TOPLAM`, and matching that instead would write the stock total
 * into an unrelated table. Scanning upward from the bottom picks the footer
 * even if a similar label appears mid-sheet.
 */
function findTotalRow(
  grid: SheetGrid,
  totalCol: number,
  firstDataRow: number,
): { row: number; label: string } | null {
  const from = Math.max(totalCol - TOTAL_LABEL_SEARCH_WIDTH, 1);
  for (let row = grid.rowCount; row >= firstDataRow; row--) {
    for (let col = totalCol - 1; col >= from; col--) {
      const normalized = normalizeHeader(grid.text(row, col));
      if (normalized && TOTAL_ROW_LABELS.includes(normalized)) {
        return { row, label: grid.text(row, col) };
      }
    }
  }
  return null;
}

/** 1-based column index to its spreadsheet letter: 1 -> A, 27 -> AA. */
export function columnLetter(index: number): string {
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Spreadsheet letter to its 1-based index: 'A' -> 1, 'AA' -> 27. */
export function letterToColumn(letter: string): number {
  let n = 0;
  for (const ch of letter.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function cellRef(row: number, col: number): string {
  return `${columnLetter(col)}${row}`;
}

/**
 * Work out the full layout of the sheet: where the headers are, which column
 * is which, where the product rows start and stop, and where the total goes.
 */
export function resolveLayout(grid: SheetGrid): SheetLayout {
  const headerRow = findHeaderRow(grid);
  const { columns, unmatchedHeaders, warnings } = resolveColumns(grid, headerRow);

  const skuCol = columns.sku!.index;
  const nameCol = columns.productName?.index;
  const fnskuCol = columns.fnsku?.index;
  const priceCol = columns.unitPrice!.index;
  const totalCol = columns.lineTotal!.index;

  const firstDataRow = headerRow + 1;
  const total = findTotalRow(grid, totalCol, firstDataRow);

  // A product row is one that carries any kind of identity. Rows with a
  // product name but no SKU do exist in the master workbook and still count
  // toward the grand total, so identity is checked across all three columns.
  let lastDataRow = headerRow;
  const ceiling = total ? total.row - 1 : grid.rowCount;
  for (let row = firstDataRow; row <= ceiling; row++) {
    const hasIdentity =
      grid.text(row, skuCol) !== '' ||
      (fnskuCol !== undefined && grid.text(row, fnskuCol) !== '') ||
      (nameCol !== undefined && grid.text(row, nameCol) !== '');
    if (hasIdentity) lastDataRow = row;
  }

  if (lastDataRow < firstDataRow) {
    throw new Error(`No product rows found below header row ${headerRow}.`);
  }

  if (!total) {
    warnings.push(
      `No grand-total row found beneath the data (looked for ${TOTAL_ROW_LABELS.slice(0, 4).join(', ')} ` +
      `in columns ${columnLetter(Math.max(totalCol - TOTAL_LABEL_SEARCH_WIDTH, 1))}` +
      `-${columnLetter(totalCol - 1)}). Row totals will be updated but no overall total will be written.`
    );
  }

  // Learn the currency wording from the cells already in the sheet.
  const samples: string[] = [];
  for (let row = firstDataRow; row <= lastDataRow; row++) {
    for (const col of [priceCol, totalCol]) {
      const v = grid.cell(row, col);
      if (v.kind === 'text') samples.push(v.value);
    }
  }

  return {
    headerRow,
    columns,
    firstDataRow,
    lastDataRow,
    totalRow: total?.row ?? null,
    totalLabel: total?.label ?? null,
    moneyStyle: detectMoneyStyle(samples),
    unmatchedHeaders,
    warnings,
  };
}
