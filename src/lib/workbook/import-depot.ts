import { getDb } from '@/lib/db';
import { ensureSchema } from '@/lib/migrate';
import { readSheetGrid } from './read';
import { resolveLayout } from './resolve-layout';
import { getWorkbookStore, type WorkbookStore } from './store';
import { extractRows, resolveRowDispositions } from './stock-sync';

/**
 * One-time seed of the application's depot stock from the master workbook.
 *
 * The workbook has always been the system of record for `Depot_OnHand` — the
 * owner's physical count — while `inventory.shop_stock` was only ever written
 * by adjustments and receipts made inside the app, and so sat empty. This
 * copies the sheet's counts in, after which the app owns depot stock and the
 * sync can start writing that column back out.
 *
 * Run it once, check the report, and then set
 * WORKBOOK_SYNC_COLUMNS=depot,shopify,amazon.
 *
 * The same duplicate and no-SKU rules the sync uses apply here, so both
 * directions agree about which row represents a product.
 */

export type DepotImportChange = {
  rowNumber: number;
  sku: string;
  productName: string;
  from: number;
  to: number;
};

export type DepotImportResult = {
  dryRun: boolean;
  source: string;
  /** Sheet rows carrying a usable SKU. */
  consideredRows: number;
  /** Rows whose SKU exists in the inventory table. */
  matched: number;
  updated: number;
  unchanged: number;
  /** Sheet SKUs with no inventory row — nothing is created for these. */
  notInDatabase: Array<{ rowNumber: number; sku: string; depot: number }>;
  skipped: { noSku: number[]; duplicateIgnored: number[]; duplicateUnresolved: number[] };
  changes: DepotImportChange[];
  unitsBefore: number;
  unitsAfter: number;
  warnings: string[];
};

export type DepotImportOptions = {
  dryRun?: boolean;
  actor?: string | null;
  store?: WorkbookStore;
  sheetName?: string;
};

export async function importDepotFromWorkbook(
  options: DepotImportOptions = {}
): Promise<DepotImportResult> {
  const dryRun = options.dryRun ?? true;
  const store = options.store ?? getWorkbookStore();
  const actor = options.actor ?? null;

  const grid = await readSheetGrid(await store.read(), options.sheetName);
  const layout = resolveLayout(grid);
  const rows = extractRows(grid, layout);

  const dispositions = resolveRowDispositions(rows);
  const warnings = [...layout.warnings, ...dispositions.warnings];

  await ensureSchema();
  const sql = getDb();

  const existing = await sql`
    SELECT sku, COALESCE(shop_stock, 0)::int AS shop_stock FROM inventory
  ` as Array<{ sku: string; shop_stock: number }>;

  const bySku = new Map<string, { sku: string; shop_stock: number }>();
  for (const row of existing) bySku.set(row.sku.trim().toUpperCase(), row);

  const changes: DepotImportChange[] = [];
  const notInDatabase: DepotImportResult['notInDatabase'] = [];
  const noSku: number[] = [];
  let considered = 0;
  let matched = 0;
  let unchanged = 0;

  for (const row of rows) {
    if (!row.sku) { noSku.push(row.rowNumber); continue; }
    if (dispositions.ignoredRows.has(row.rowNumber)) continue;

    considered++;
    const target = bySku.get(row.sku.trim().toUpperCase());
    if (!target) {
      notInDatabase.push({ rowNumber: row.rowNumber, sku: row.sku, depot: row.depot });
      continue;
    }

    matched++;
    const to = Math.max(0, Math.round(row.depot));
    if (target.shop_stock === to) { unchanged++; continue; }
    changes.push({
      rowNumber: row.rowNumber,
      sku: target.sku,
      productName: row.productName,
      from: target.shop_stock,
      to,
    });
  }

  const unitsBefore = changes.reduce((sum, c) => sum + c.from, 0);
  const unitsAfter = changes.reduce((sum, c) => sum + c.to, 0);

  if (!dryRun && changes.length > 0) {
    // Written in batches, each one recording its own audit row, so the import
    // shows up in the app's history exactly like any other stock movement and
    // can be traced or reversed per SKU.
    const BATCH = 20;
    for (let i = 0; i < changes.length; i += BATCH) {
      const slice = changes.slice(i, i + BATCH);
      await Promise.all(slice.map(change => sql`
        WITH upd AS (
          UPDATE inventory SET shop_stock = ${change.to}
          WHERE sku = ${change.sku}
          RETURNING sku
        )
        INSERT INTO stock_adjustments
          (sku, delta, before_qty, after_qty, reason, adjusted_by, source)
        SELECT ${change.sku}, ${change.to - change.from}, ${change.from}, ${change.to},
               ${`Seeded from workbook row ${change.rowNumber}`}, ${actor}, 'workbook-import'
        FROM upd
      `));
    }
  }

  return {
    dryRun,
    source: store.describe(),
    consideredRows: considered,
    matched,
    updated: dryRun ? 0 : changes.length,
    unchanged,
    notInDatabase,
    skipped: {
      noSku,
      duplicateIgnored: dispositions.duplicateIgnored,
      duplicateUnresolved: dispositions.duplicateUnresolved,
    },
    changes,
    unitsBefore,
    unitsAfter,
    warnings,
  };
}
