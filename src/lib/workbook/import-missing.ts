import { getDb } from '@/lib/db';
import { ensureSchema } from '@/lib/migrate';
import { readSheetGrid } from './read';
import { resolveLayout } from './resolve-layout';
import { getWorkbookStore, type WorkbookStore } from './store';
import { extractRows, resolveRowDispositions } from './stock-sync';

/**
 * Create inventory rows for products that exist in the workbook but not in
 * the app.
 *
 * These are SKUs the Amazon listings report and the Shopify catalogue both
 * failed to return — typically discontinued or paused listings the owner
 * still holds physical stock of. Until they exist in `inventory` the sync
 * skips their rows entirely, so their depot counts stay outside the app.
 *
 * The channel flags are set from the workbook's own record rather than
 * guessed: a row with an FNSKU is an Amazon product, and a row with Shopify
 * stock is a Shopify product. Both syncs only write SKUs their API actually
 * returns, so a dead listing costs one slot in a request batch and nothing
 * else — it can never be zeroed by a sync that does not know about it.
 */

export type MissingProduct = {
  rowNumber: number;
  sku: string;
  productName: string;
  variantLabel: string | null;
  fnsku: string | null;
  depot: number;
  shopify: number;
  amazon: number;
  onAmazon: boolean;
  onShopify: boolean;
};

export type MissingImportResult = {
  dryRun: boolean;
  source: string;
  /** Sheet rows with a SKU that already exist in inventory. */
  alreadyPresent: number;
  toCreate: MissingProduct[];
  created: number;
  /** Rows skipped by the shared duplicate / no-SKU rules. */
  skipped: { noSku: number[]; duplicateIgnored: number[]; duplicateUnresolved: number[] };
  depotUnitsAdded: number;
  warnings: string[];
};

export type MissingImportOptions = {
  dryRun?: boolean;
  actor?: string | null;
  store?: WorkbookStore;
  sheetName?: string;
};

export async function importMissingProducts(
  options: MissingImportOptions = {}
): Promise<MissingImportResult> {
  const dryRun = options.dryRun ?? true;
  const store = options.store ?? getWorkbookStore();
  const actor = options.actor ?? null;

  const grid = await readSheetGrid(await store.read(), options.sheetName);
  const layout = resolveLayout(grid);
  const rows = extractRows(grid, layout);
  const dispositions = resolveRowDispositions(rows);
  const warnings = [...layout.warnings, ...dispositions.warnings];

  const fnskuCol = layout.columns.fnsku?.index;
  // The workbook's "Bag" column ("10 pcs/bag") is exactly a variant label,
  // and it is the only thing distinguishing several rows of one product.
  const bagCol = [...Array(grid.columnCount).keys()]
    .map(i => i + 1)
    .find(c => /^(bag|paket|ambalaj)$/i.test(grid.text(layout.headerRow, c).trim()));

  await ensureSchema();
  const sql = getDb();
  const existing = await sql`SELECT sku FROM inventory` as Array<{ sku: string }>;
  const known = new Set(existing.map(r => r.sku.trim().toUpperCase()));

  const toCreate: MissingProduct[] = [];
  const noSku: number[] = [];
  let alreadyPresent = 0;

  for (const row of rows) {
    if (!row.sku) { noSku.push(row.rowNumber); continue; }
    if (dispositions.ignoredRows.has(row.rowNumber)) continue;
    if (known.has(row.sku.trim().toUpperCase())) { alreadyPresent++; continue; }

    const fnsku = fnskuCol ? grid.text(row.rowNumber, fnskuCol) || null : null;
    toCreate.push({
      rowNumber: row.rowNumber,
      sku: row.sku.trim(),
      productName: row.productName,
      variantLabel: bagCol ? grid.text(row.rowNumber, bagCol) || null : null,
      fnsku,
      depot: Math.max(0, Math.round(row.depot)),
      shopify: Math.max(0, Math.round(row.shopify)),
      amazon: Math.max(0, Math.round(row.amazon)),
      onAmazon: !!fnsku,
      onShopify: row.shopify > 0,
    });
  }

  let created = 0;
  if (!dryRun && toCreate.length > 0) {
    const BATCH = 20;
    for (let i = 0; i < toCreate.length; i += BATCH) {
      const slice = toCreate.slice(i, i + BATCH);
      await Promise.all(slice.map(p => sql`
        INSERT INTO inventory (
          sku, product_name, variant_label, shop_stock, shopify_quantity,
          fba_quantity, fbm_quantity, on_amazon, on_shopify
        )
        VALUES (
          ${p.sku}, ${p.productName || null}, ${p.variantLabel},
          ${p.depot}, ${p.shopify}, ${p.amazon}, 0, ${p.onAmazon}, ${p.onShopify}
        )
        ON CONFLICT (sku) DO NOTHING
      `));
      created += slice.length;
    }

    // Depot stock arriving from the workbook is a stock movement like any
    // other, so it gets the same audit trail the importer and the UI write.
    const stocked = toCreate.filter(p => p.depot > 0);
    for (let i = 0; i < stocked.length; i += BATCH) {
      const slice = stocked.slice(i, i + BATCH);
      await Promise.all(slice.map(p => sql`
        INSERT INTO stock_adjustments
          (sku, delta, before_qty, after_qty, reason, adjusted_by, source)
        VALUES (${p.sku}, ${p.depot}, 0, ${p.depot},
                ${`Created from workbook row ${p.rowNumber}`}, ${actor}, 'workbook-import')
      `));
    }
  }

  return {
    dryRun,
    source: store.describe(),
    alreadyPresent,
    toCreate,
    created: dryRun ? 0 : created,
    skipped: {
      noSku,
      duplicateIgnored: dispositions.duplicateIgnored,
      duplicateUnresolved: dispositions.duplicateUnresolved,
    },
    depotUnitsAdded: toCreate.reduce((s, p) => s + p.depot, 0),
    warnings,
  };
}
