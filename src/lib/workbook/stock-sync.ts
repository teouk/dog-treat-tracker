import { getDb } from '@/lib/db';
import { ensureSchema } from '@/lib/migrate';
import { readSheetGrid, type SheetGrid } from './read';
import { resolveLayout, cellRef, columnLetter, type SheetLayout } from './resolve-layout';
import { applyCellEdits, type CellEdit } from './xlsx-writer';
import { getWorkbookStore, type WorkbookStore } from './store';
import { formatMoney, parseFlexibleDecimal, parseQuantity, type MoneyStyle } from './turkish';
import { resolveSyncColumns, type StockColumnKey } from './schema';

/**
 * Pushes Amazon, Shopify and depot stock into the master workbook and keeps
 * its money columns consistent with the new quantities.
 *
 * Which database column feeds which workbook column is stated once, here,
 * because it is the part most likely to be questioned later:
 *
 *   Depot_OnHand   <- inventory.shop_stock        the manually counted depot
 *   Shopify_Qty    <- inventory.shopify_quantity
 *   Amazon_Qty_UK  <- inventory.fba_quantity      stock Amazon physically holds
 *
 * `fbm_quantity` is deliberately excluded: merchant-fulfilled orders ship out
 * of the depot, so those units are already counted in `shop_stock` and adding
 * them to the Amazon column would inflate the workbook's stock value.
 */

/** Stock for one SKU as the application understands it. */
export type InventorySnapshot = {
  sku: string;
  shop_stock: number;
  shopify_quantity: number;
  fba_quantity: number;
};

/** One product row as it currently stands in the workbook. */
export type WorkbookRow = {
  rowNumber: number;
  sku: string;
  productName: string;
  depot: number;
  shopify: number;
  amazon: number;
  unitPrice: number;
  lineTotal: number;
  /**
   * Value to count for this row in the grand total instead of recomputing it.
   * Set on rows the sync deliberately leaves alone, so TOPLAM still equals the
   * sum of the value column as it actually reads in the sheet.
   */
  frozenValue?: number;
};

export type RowChange = {
  rowNumber: number;
  sku: string;
  productName: string;
  depot?: { from: number; to: number };
  shopify?: { from: number; to: number };
  amazon?: { from: number; to: number };
  lineTotal?: { from: number; to: number };
};

export type WorkbookSyncResult = {
  success: boolean;
  dryRun: boolean;
  source: string;
  sheetName: string;
  /** What the header resolver decided, so a mis-mapping is visible not silent. */
  layout: {
    headerRow: number;
    columns: Record<string, { column: string; header: string; matchedBy: string; confidence: number }>;
    dataRows: string;
    totalCell: string | null;
    unmatchedHeaders: string[];
  };
  /** Stock columns this run was allowed to write. */
  syncedColumns: StockColumnKey[];
  matchedRows: number;
  unmatchedSkus: string[];
  skusNotInWorkbook: string[];
  /** Rows deliberately left untouched, and why. */
  skippedRows: {
    /** No SKU in the row, so nothing to match against. */
    noSku: number[];
    /** The empty half of a duplicated SKU. */
    duplicateIgnored: number[];
    /** Duplicates where the live row could not be identified. */
    duplicateUnresolved: number[];
  };
  changes: RowChange[];
  cellsWritten: number;
  /** Money figures, before and after. */
  totals: {
    depotInventoryValue: { from: number; to: number };
    totalStockValue: { from: number; to: number };
    totalCellUpdated: boolean;
  };
  warnings: string[];
  elapsedMs: number;
};

// --------------------------------------------------------------------------
// Phase 2 — value calculation
// --------------------------------------------------------------------------

/**
 * Stock value of a single row.
 *
 * Reverse-engineered from the workbook and verified against all 111 product
 * rows with zero mismatches: the total counts stock the business owns —
 * what is in the depot plus what sits in Amazon's warehouses — and excludes
 * Shopify, whose quantity is a shop-front figure fulfilled from the depot and
 * would otherwise be counted twice.
 */
export function lineStockValue(depot: number, amazon: number, unitPrice: number): number {
  return (depot + amazon) * unitPrice;
}

/**
 * Total financial value of the local shop (depot) inventory alone.
 *
 * Reported on every sync. It is not written into the workbook, which has no
 * column for it — adding one would change the owner's layout.
 */
export function depotInventoryValue(rows: Array<Pick<WorkbookRow, 'depot' | 'unitPrice'>>): number {
  return round2(rows.reduce((sum, r) => sum + r.depot * r.unitPrice, 0));
}

/**
 * Grand total written to the workbook's TOPLAM cell.
 *
 * A row carrying `frozenValue` contributes that instead of a recomputed
 * figure. Skipped rows are therefore still counted, at whatever their value
 * cell already says — TOPLAM has to equal the sum of the column beneath it, or
 * the sheet contradicts itself.
 */
export function totalStockValue(
  rows: Array<Pick<WorkbookRow, 'depot' | 'amazon' | 'unitPrice'> & { frozenValue?: number }>
): number {
  return round2(rows.reduce(
    (sum, r) => sum + (r.frozenValue ?? lineStockValue(r.depot, r.amazon, r.unitPrice)),
    0,
  ));
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// --------------------------------------------------------------------------
// Reading the sheet
// --------------------------------------------------------------------------

/** A money cell that may be stored as a number or as Turkish-formatted text. */
function readMoney(grid: SheetGrid, row: number, col: number): number {
  const cell = grid.cell(row, col);
  if (cell.kind === 'number') return cell.value;
  if (cell.kind === 'text') return parseFlexibleDecimal(cell.value) ?? 0;
  return 0;
}

export function extractRows(grid: SheetGrid, layout: SheetLayout): WorkbookRow[] {
  const { columns } = layout;
  const skuCol = columns.sku!.index;
  const nameCol = columns.productName?.index;
  const rows: WorkbookRow[] = [];

  for (let r = layout.firstDataRow; r <= layout.lastDataRow; r++) {
    rows.push({
      rowNumber: r,
      sku: grid.text(r, skuCol),
      productName: nameCol ? grid.text(r, nameCol) : '',
      depot: parseQuantity(grid.cell(r, columns.depotStock!.index).kind === 'number'
        ? grid.number(r, columns.depotStock!.index)
        : grid.text(r, columns.depotStock!.index)),
      shopify: parseQuantity(grid.cell(r, columns.shopifyQty!.index).kind === 'number'
        ? grid.number(r, columns.shopifyQty!.index)
        : grid.text(r, columns.shopifyQty!.index)),
      amazon: parseQuantity(grid.cell(r, columns.amazonQty!.index).kind === 'number'
        ? grid.number(r, columns.amazonQty!.index)
        : grid.text(r, columns.amazonQty!.index)),
      unitPrice: readMoney(grid, r, columns.unitPrice!.index),
      lineTotal: readMoney(grid, r, columns.lineTotal!.index),
    });
  }
  return rows;
}

/**
 * Write a money value the way the target cell already holds it.
 *
 * The master workbook stores its money as Turkish-formatted text rather than
 * as numbers with a currency format, so a sync that "helpfully" wrote numbers
 * would change every visible amount in the sheet. The cell's existing type
 * decides, which also means the code keeps working if the owner later
 * converts the column to real numbers.
 */
function moneyEdit(
  grid: SheetGrid,
  row: number,
  col: number,
  value: number,
  style: MoneyStyle,
): CellEdit | null {
  const cell = grid.cell(row, col);
  const ref = cellRef(row, col);

  if (cell.kind === 'number') {
    return round2(cell.value) === round2(value) ? null : { ref, value: round2(value) };
  }
  const text = formatMoney(value, style);
  if (cell.kind === 'text' && cell.value === text) return null;
  if (cell.kind === 'empty' && round2(value) === 0) return null;
  return { ref, value: text };
}

function quantityEdit(
  grid: SheetGrid,
  row: number,
  col: number,
  value: number,
): CellEdit | null {
  const cell = grid.cell(row, col);
  const current = cell.kind === 'number' ? cell.value : parseQuantity(grid.text(row, col));
  if (current === value) return null;
  return { ref: cellRef(row, col), value };
}

// --------------------------------------------------------------------------
// Orchestration
// --------------------------------------------------------------------------

export type WorkbookSyncOptions = {
  /** Compute and report the diff without writing anything. */
  dryRun?: boolean;
  /** Recorded against the backup taken before the write. */
  actor?: string | null;
  reason?: string;
  /** Injected in tests; otherwise read from the database. */
  inventory?: InventorySnapshot[];
  store?: WorkbookStore;
  sheetName?: string;
  /** Overrides WORKBOOK_SYNC_COLUMNS for this run. */
  columns?: StockColumnKey[];
};

async function loadInventory(): Promise<InventorySnapshot[]> {
  await ensureSchema();
  const sql = getDb();
  const rows = await sql`
    SELECT
      sku,
      COALESCE(shop_stock, 0)::int       AS shop_stock,
      COALESCE(shopify_quantity, 0)::int AS shopify_quantity,
      COALESCE(fba_quantity, 0)::int     AS fba_quantity
    FROM inventory
  ` as InventorySnapshot[];
  return rows;
}

/** SKUs are compared case-insensitively and without surrounding space. */
function skuKey(sku: string): string {
  return sku.trim().toUpperCase();
}

export async function syncStockToWorkbook(
  options: WorkbookSyncOptions = {}
): Promise<WorkbookSyncResult> {
  const startedAt = Date.now();
  const store = options.store ?? getWorkbookStore();
  const dryRun = options.dryRun ?? false;

  const syncColumns = options.columns
    ? new Set<StockColumnKey>(options.columns)
    : resolveSyncColumns();

  const original = await store.read();
  const grid = await readSheetGrid(original, options.sheetName);
  const layout = resolveLayout(grid);
  const warnings = [...layout.warnings];

  const rows = extractRows(grid, layout);
  const inventory = options.inventory ?? (await loadInventory());

  if (!syncColumns.has('depotStock')) {
    warnings.push(
      'Depot_OnHand is not being written (WORKBOOK_SYNC_COLUMNS excludes "depot"). ' +
      'The sheet keeps its own depot counts and they are used to compute the stock value.'
    );
  }

  const bySku = new Map<string, InventorySnapshot>();
  for (const item of inventory) {
    if (item.sku) bySku.set(skuKey(item.sku), item);
  }

  const dispositions = resolveRowDispositions(rows);
  const { ignoredRows, duplicateIgnored, duplicateUnresolved } = dispositions;
  warnings.push(...dispositions.warnings);

  const edits: CellEdit[] = [];
  const changes: RowChange[] = [];
  const unmatchedSkus: string[] = [];
  const matchedKeys = new Set<string>();
  const { columns, moneyStyle } = layout;

  const before = {
    depot: depotInventoryValue(rows),
    total: totalStockValue(rows),
  };

  const skippedNoSku: number[] = [];

  for (const row of rows) {
    // A row with no SKU cannot be matched to anything, so it is skipped
    // outright — no quantities written, no value recomputed. Its existing
    // value still counts toward TOPLAM.
    if (!row.sku) {
      row.frozenValue = row.lineTotal;
      skippedNoSku.push(row.rowNumber);
      continue;
    }

    // The ignored half of a duplicated SKU is treated the same way.
    if (ignoredRows.has(row.rowNumber)) {
      row.frozenValue = row.lineTotal;
      continue;
    }

    const key = skuKey(row.sku);
    const snapshot = bySku.get(key);

    if (!snapshot) unmatchedSkus.push(row.sku);
    else matchedKeys.add(key);

    // Rows we cannot match keep their quantities; their value is still
    // recomputed so a stale line total gets corrected either way.
    // A column the run is not allowed to write keeps whatever the sheet
    // already says, and that value is what the row's total is computed from.
    const next = {
      depot: snapshot && syncColumns.has('depotStock') ? snapshot.shop_stock : row.depot,
      shopify: snapshot && syncColumns.has('shopifyQty') ? snapshot.shopify_quantity : row.shopify,
      amazon: snapshot && syncColumns.has('amazonQty') ? snapshot.fba_quantity : row.amazon,
    };

    const change: RowChange = {
      rowNumber: row.rowNumber,
      sku: row.sku,
      productName: row.productName,
    };
    let rowChanged = false;

    if (snapshot) {
      const pairs = [
        ['depot', 'depotStock', columns.depotStock!.index, row.depot, next.depot],
        ['shopify', 'shopifyQty', columns.shopifyQty!.index, row.shopify, next.shopify],
        ['amazon', 'amazonQty', columns.amazonQty!.index, row.amazon, next.amazon],
      ] as const;

      for (const [field, columnKey, col, from, to] of pairs) {
        if (!syncColumns.has(columnKey)) continue;
        const edit = quantityEdit(grid, row.rowNumber, col, to);
        if (edit) {
          edits.push(edit);
          change[field] = { from, to };
          rowChanged = true;
        }
      }
    }

    const newTotal = round2(lineStockValue(next.depot, next.amazon, row.unitPrice));
    const totalEdit = moneyEdit(
      grid, row.rowNumber, columns.lineTotal!.index, newTotal, moneyStyle
    );
    if (totalEdit) {
      edits.push(totalEdit);
      change.lineTotal = { from: row.lineTotal, to: newTotal };
      rowChanged = true;
    }

    // Keep the in-memory rows in step so the grand total below reflects the
    // values we are about to write, not the ones we read.
    row.depot = next.depot;
    row.shopify = next.shopify;
    row.amazon = next.amazon;

    if (rowChanged) changes.push(change);
  }

  const after = {
    depot: depotInventoryValue(rows),
    total: totalStockValue(rows),
  };

  // The grand total is refreshed on every sync that touches stock, which is
  // the whole point of Phase 2 — the workbook holds no formulas, so nothing
  // else would ever bring it back into line.
  let totalCellUpdated = false;
  if (layout.totalRow !== null) {
    const edit = moneyEdit(
      grid, layout.totalRow, columns.lineTotal!.index, after.total, moneyStyle
    );
    if (edit) {
      edits.push(edit);
      totalCellUpdated = true;
    }
  }

  const skusNotInWorkbook = [...bySku.keys()].filter(k => !matchedKeys.has(k));

  let cellsWritten = 0;
  if (!dryRun && edits.length > 0) {
    const patched = await applyCellEdits(original, edits, grid.sheetName);
    cellsWritten = patched.applied;

    if (patched.skippedFormula.length > 0) {
      warnings.push(
        `Left ${patched.skippedFormula.length} cell(s) alone because they contain formulas: ` +
        `${patched.skippedFormula.slice(0, 10).join(', ')}` +
        `${patched.skippedFormula.length > 10 ? '…' : ''}.`
      );
    }
    await store.write(patched.buffer, {
      actor: options.actor ?? null,
      reason: options.reason ?? 'stock sync',
    });
  }

  const layoutReport: WorkbookSyncResult['layout']['columns'] = {};
  for (const [key, resolved] of Object.entries(columns)) {
    if (!resolved) continue;
    layoutReport[key] = {
      column: columnLetter(resolved.index),
      header: resolved.header,
      matchedBy: resolved.matchedBy,
      confidence: resolved.confidence,
    };
  }

  return {
    success: true,
    dryRun,
    source: store.describe(),
    sheetName: grid.sheetName,
    layout: {
      headerRow: layout.headerRow,
      columns: layoutReport,
      dataRows: `${layout.firstDataRow}-${layout.lastDataRow}`,
      totalCell: layout.totalRow
        ? cellRef(layout.totalRow, columns.lineTotal!.index)
        : null,
      unmatchedHeaders: layout.unmatchedHeaders,
    },
    syncedColumns: [...syncColumns],
    matchedRows: matchedKeys.size,
    unmatchedSkus,
    skusNotInWorkbook,
    skippedRows: {
      noSku: skippedNoSku,
      duplicateIgnored,
      duplicateUnresolved,
    },
    changes,
    cellsWritten,
    totals: {
      depotInventoryValue: { from: before.depot, to: after.depot },
      totalStockValue: { from: before.total, to: after.total },
      totalCellUpdated,
    },
    warnings,
    elapsedMs: Date.now() - startedAt,
  };
}


// --------------------------------------------------------------------------
// Row disposition — shared by the sync and the depot importer
// --------------------------------------------------------------------------

export type RowDispositions = {
  /** Rows that must be left exactly as they are. */
  ignoredRows: Set<number>;
  duplicateIgnored: number[];
  duplicateUnresolved: number[];
  warnings: string[];
};

/**
 * Decide which rows a duplicated SKU should be applied to.
 *
 * A SKU on more than one row would have its stock written twice, inflating the
 * sheet's value. The live row is the one that already carries stock; the empty
 * twin is left alone. When nothing is stocked, or several rows are, neither
 * says which row is live — picking one would silently move stock between
 * products, so all of them stay put and the sheet gets fixed by hand.
 */
export function resolveRowDispositions(
  rows: Array<Pick<WorkbookRow, 'rowNumber' | 'sku' | 'depot' | 'shopify' | 'amazon'>>
): RowDispositions {
  const occurrences = new Map<string, number[]>();
  for (const row of rows) {
    if (!row.sku) continue;
    const key = skuKey(row.sku);
    const list = occurrences.get(key);
    if (list) list.push(row.rowNumber);
    else occurrences.set(key, [row.rowNumber]);
  }

  const byRowNumber = new Map(rows.map(r => [r.rowNumber, r]));
  const ignoredRows = new Set<number>();
  const duplicateIgnored: number[] = [];
  const duplicateUnresolved: number[] = [];
  const warnings: string[] = [];

  for (const [key, rowNumbers] of occurrences) {
    if (rowNumbers.length < 2) continue;

    const stocked = rowNumbers.filter(n => {
      const r = byRowNumber.get(n)!;
      return r.depot + r.shopify + r.amazon > 0;
    });

    if (stocked.length === 1) {
      const winner = stocked[0];
      const losers = rowNumbers.filter(n => n !== winner);
      for (const n of losers) { ignoredRows.add(n); duplicateIgnored.push(n); }
      warnings.push(
        `SKU "${key}" appears on rows ${rowNumbers.join(', ')}: syncing row ${winner}, ` +
        `which already carries stock, and leaving row(s) ${losers.join(', ')} untouched.`
      );
      continue;
    }

    for (const n of rowNumbers) { ignoredRows.add(n); duplicateUnresolved.push(n); }
    warnings.push(
      stocked.length === 0
        ? `SKU "${key}" appears on rows ${rowNumbers.join(', ')} and none of them carry stock, ` +
          `so the live row cannot be identified. All left untouched.`
        : `SKU "${key}" appears on rows ${rowNumbers.join(', ')} and ${stocked.length} of them ` +
          `carry stock (rows ${stocked.join(', ')}). All left untouched — resolve the duplicate in the sheet.`
    );
  }

  return { ignoredRows, duplicateIgnored, duplicateUnresolved, warnings };
}
