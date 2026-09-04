import ExcelJS from 'exceljs';

/**
 * Reading side of the workbook adapter.
 *
 * ExcelJS is used only to *read*. Its writer re-serialises the whole
 * workbook from its own object model and is measurably lossy on this file —
 * it rewrites the `Aptos Narrow` theme font to `Calibri` and drops the
 * printer-settings part — so writes go through the surgical patcher in
 * `xlsx-writer.ts` instead. See docs/workbook-sync.md.
 */

export type CellValue =
  | { kind: 'empty' }
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string };

export const EMPTY_CELL: CellValue = { kind: 'empty' };

export type SheetGrid = {
  sheetName: string;
  rowCount: number;
  columnCount: number;
  /** 1-based row and column. */
  cell(row: number, col: number): CellValue;
  /** Cell rendered as trimmed text; '' when empty. */
  text(row: number, col: number): string;
  /** Cell as a number; 0 when empty or unparseable. */
  number(row: number, col: number): number;
};

/**
 * Flatten one ExcelJS cell into the three shapes the sync understands.
 *
 * A formula cell reports its cached result — the value a human sees — which
 * is what the totals must be computed from. The patcher separately refuses to
 * overwrite any cell that carries a formula.
 */
function toCellValue(raw: ExcelJS.CellValue): CellValue {
  if (raw === null || raw === undefined || raw === '') return EMPTY_CELL;

  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? { kind: 'number', value: raw } : EMPTY_CELL;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed ? { kind: 'text', value: trimmed } : EMPTY_CELL;
  }
  if (typeof raw === 'boolean') return { kind: 'text', value: raw ? 'TRUE' : 'FALSE' };
  if (raw instanceof Date) return { kind: 'text', value: raw.toISOString() };

  if (typeof raw === 'object') {
    if ('richText' in raw && Array.isArray(raw.richText)) {
      const joined = raw.richText.map(part => part.text).join('').trim();
      return joined ? { kind: 'text', value: joined } : EMPTY_CELL;
    }
    if ('result' in raw) return toCellValue(raw.result as ExcelJS.CellValue);
    if ('error' in raw) return EMPTY_CELL;
    if ('text' in raw && typeof raw.text === 'string') {
      const trimmed = raw.text.trim();
      return trimmed ? { kind: 'text', value: trimmed } : EMPTY_CELL;
    }
  }
  return EMPTY_CELL;
}

/**
 * Load a worksheet into a plain grid.
 *
 * `sheetName` selects the sheet; without it the first worksheet is used,
 * which is correct for the single-sheet master workbook but explicit enough
 * to survive someone adding a second tab.
 */
export async function readSheetGrid(data: Buffer, sheetName?: string): Promise<SheetGrid> {
  const workbook = new ExcelJS.Workbook();
  // ExcelJS types the argument as its own Buffer alias; the runtime accepts a
  // Node Buffer directly.
  await workbook.xlsx.load(data as unknown as ArrayBuffer);

  const worksheet = sheetName
    ? workbook.getWorksheet(sheetName)
    : workbook.worksheets[0];

  if (!worksheet) {
    const available = workbook.worksheets.map(w => w.name).join(', ') || '(none)';
    throw new Error(
      `Worksheet ${sheetName ? `"${sheetName}"` : '(first)'} not found. Sheets in file: ${available}`
    );
  }

  const cache = new Map<string, CellValue>();
  const cell = (row: number, col: number): CellValue => {
    if (row < 1 || col < 1) return EMPTY_CELL;
    const key = `${row}:${col}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const value = toCellValue(worksheet.getRow(row).getCell(col).value);
    cache.set(key, value);
    return value;
  };

  return {
    sheetName: worksheet.name,
    rowCount: worksheet.rowCount,
    columnCount: worksheet.columnCount,
    cell,
    text(row, col) {
      const v = cell(row, col);
      if (v.kind === 'empty') return '';
      return v.kind === 'number' ? String(v.value) : v.value;
    },
    number(row, col) {
      const v = cell(row, col);
      if (v.kind === 'number') return v.value;
      if (v.kind === 'empty') return 0;
      const parsed = Number(v.value.replace(/\s/g, '').replace(',', '.'));
      return Number.isFinite(parsed) ? parsed : 0;
    },
  };
}
