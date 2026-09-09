import { getDb } from '@/lib/db';
import { ensureSchema } from '@/lib/migrate';
import { readSheetGrid } from './read';
import { resolveLayout } from './resolve-layout';
import { getWorkbookStore, type WorkbookStore } from './store';
import { extractRows, resolveRowDispositions } from './stock-sync';

/**
 * Copies the shop's own product naming out of the master workbook.
 *
 * The app had been showing channel names and channel groupings, which do not
 * agree with how the business thinks about its catalogue: Shopify bundles
 * separate products into one listing with variants, and Amazon treats THIN,
 * REGULAR, THICK and BRAIDED bully sticks as one variation family. Both then
 * fed the product name and the grouping, so distinct products appeared as
 * variants of each other.
 *
 * `shop_name` and `shop_variant` are stored apart from `product_name` and
 * `variant_label` precisely so a later Amazon or Shopify sync cannot overwrite
 * them — both of those syncs write `product_name` on every run.
 *
 * Re-run whenever the workbook's Products or Bag columns change.
 */

export type CatalogueChange = {
  sku: string;
  name: { from: string | null; to: string };
  variant: { from: string | null; to: string };
};

export type CatalogueImportResult = {
  dryRun: boolean;
  source: string;
  /** Workbook rows carrying a usable SKU. */
  consideredRows: number;
  matched: number;
  updated: number;
  unchanged: number;
  notInDatabase: string[];
  /** App SKUs with no workbook row; these keep their channel naming. */
  withoutWorkbookRow: number;
  changes: CatalogueChange[];
  warnings: string[];
};

export type CatalogueImportOptions = {
  dryRun?: boolean;
  store?: WorkbookStore;
  sheetName?: string;
};

export async function importCatalogueFromWorkbook(
  options: CatalogueImportOptions = {}
): Promise<CatalogueImportResult> {
  const dryRun = options.dryRun ?? true;
  const store = options.store ?? getWorkbookStore();

  const grid = await readSheetGrid(await store.read(), options.sheetName);
  const layout = resolveLayout(grid);
  const rows = extractRows(grid, layout);
  const dispositions = resolveRowDispositions(rows);
  const warnings = [...layout.warnings, ...dispositions.warnings];

  const nameCol = layout.columns.productName?.index;
  if (!nameCol) throw new Error('The workbook has no product name column to import.');

  // The "Bag" column is the shop's variant axis ("10 pcs/bag", "250 gr/bag").
  // It is not one of the columns the stock sync resolves, so it is located
  // here by its own header rather than assumed to sit at a fixed index.
  const bagCol = (() => {
    for (let c = 1; c <= grid.columnCount; c++) {
      if (/^(bag|paket|ambalaj)$/i.test(grid.text(layout.headerRow, c).trim())) return c;
    }
    return null;
  })();
  if (!bagCol) warnings.push('No "Bag" column found — variant labels will be left as they are.');

  await ensureSchema();
  const sql = getDb();
  const existing = await sql`
    SELECT sku, shop_name, shop_variant FROM inventory
  ` as Array<{ sku: string; shop_name: string | null; shop_variant: string | null }>;

  const bySku = new Map(existing.map(r => [r.sku.trim().toUpperCase(), r]));

  const changes: CatalogueChange[] = [];
  const notInDatabase: string[] = [];
  const matchedSkus = new Set<string>();
  let considered = 0;
  let unchanged = 0;

  for (const row of rows) {
    if (!row.sku || dispositions.ignoredRows.has(row.rowNumber)) continue;
    considered++;

    const target = bySku.get(row.sku.trim().toUpperCase());
    if (!target) { notInDatabase.push(row.sku); continue; }
    matchedSkus.add(target.sku);

    const name = grid.text(row.rowNumber, nameCol).trim();
    const variant = bagCol ? grid.text(row.rowNumber, bagCol).trim() : (target.shop_variant ?? '');
    if (!name) continue;

    if ((target.shop_name ?? '') === name && (target.shop_variant ?? '') === variant) {
      unchanged++;
      continue;
    }
    changes.push({
      sku: target.sku,
      name: { from: target.shop_name, to: name },
      variant: { from: target.shop_variant, to: variant },
    });
  }

  if (!dryRun && changes.length > 0) {
    const BATCH = 20;
    for (let i = 0; i < changes.length; i += BATCH) {
      const slice = changes.slice(i, i + BATCH);
      await Promise.all(slice.map(c => sql`
        UPDATE inventory
        SET shop_name = ${c.name.to}, shop_variant = ${c.variant.to || null}
        WHERE sku = ${c.sku}
      `));
    }
  }

  return {
    dryRun,
    source: store.describe(),
    consideredRows: considered,
    matched: matchedSkus.size,
    updated: dryRun ? 0 : changes.length,
    unchanged,
    notInDatabase,
    withoutWorkbookRow: existing.length - matchedSkus.size,
    changes,
    warnings,
  };
}
