/**
 * Dry-run the workbook sync against the REAL database.
 *
 *   npm run workbook:dry-run          report only, writes nothing
 *   npm run workbook:dry-run -- --apply   actually write the workbook
 *
 * This is the check the verification harness cannot do: it exercises
 * `loadInventory()` and the SKU matching between the app's inventory table
 * and the sheet's Item column, which is the one assumption in the sync that
 * was inferred rather than confirmed.
 *
 * Reads DATABASE_URL from .env.local (or the environment). The credential is
 * never printed.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Minimal .env loader — tsx does not read .env.local the way Next.js does. */
async function loadEnvFile(file: string): Promise<void> {
  let text: string;
  try {
    text = await fs.readFile(path.join(process.cwd(), file), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

async function main() {
  for (const file of ['.env.local', '.env']) await loadEnvFile(file);

  if (!process.env.DATABASE_URL) {
    console.error(
      'DATABASE_URL is not set.\n' +
      'Put it in .env.local (the same value the app uses) and run this again.\n' +
      'Nothing is printed from it — only the SKUs and quantities it returns.'
    );
    process.exit(1);
  }

  const apply = process.argv.includes('--apply');

  // Imported after the env is loaded: the db module reads DATABASE_URL eagerly.
  const { syncStockToWorkbook } = await import('../src/lib/workbook/stock-sync');
  const { formatMoney } = await import('../src/lib/workbook/turkish');

  const result = await syncStockToWorkbook({
    dryRun: !apply,
    actor: 'workbook:dry-run',
    reason: apply ? 'cli apply' : 'cli dry run',
  });

  const line = '─'.repeat(76);
  console.log(`\n${line}`);
  console.log(`${apply ? 'APPLIED' : 'DRY RUN — nothing written'}   ${result.source}`);
  console.log(line);

  const LABEL: Record<string, string> = {
    depotStock: 'Depot_OnHand', shopifyQty: 'Shopify_Qty', amazonQty: 'Amazon_Qty_UK',
  };
  const enabled = result.syncedColumns.map(c => LABEL[c] ?? c);
  const disabled = (['depotStock', 'shopifyQty', 'amazonQty'] as const)
    .filter(c => !result.syncedColumns.includes(c)).map(c => LABEL[c]);
  console.log(`\nStock columns being written: ${enabled.join(', ') || '(none)'}`);
  if (disabled.length) console.log(`  NOT written: ${disabled.join(', ')}   (set WORKBOOK_SYNC_COLUMNS to change)`);

  console.log(`\nColumn mapping (sheet "${result.sheetName}", header row ${result.layout.headerRow}):`);
  for (const [key, col] of Object.entries(result.layout.columns)) {
    console.log(`  ${key.padEnd(12)} -> ${col.column.padEnd(3)} "${col.header}"  (${col.matchedBy} ${col.confidence})`);
  }
  console.log(`  data rows ${result.layout.dataRows}, total cell ${result.layout.totalCell ?? '(none found)'}`);

  console.log(`\nSKU matching:`);
  console.log(`  matched                     ${result.matchedRows}`);
  console.log(`  in sheet, not in database   ${result.unmatchedSkus.length}`);
  console.log(`  in database, not in sheet   ${result.skusNotInWorkbook.length}`);
  if (result.unmatchedSkus.length) {
    console.log(`    e.g. ${result.unmatchedSkus.slice(0, 8).join(', ')}${result.unmatchedSkus.length > 8 ? ' …' : ''}`);
  }
  if (result.skusNotInWorkbook.length) {
    console.log(`    e.g. ${result.skusNotInWorkbook.slice(0, 8).join(', ')}${result.skusNotInWorkbook.length > 8 ? ' …' : ''}`);
  }

  // A zero match count means the two systems disagree about what a SKU is —
  // the single failure mode that would quietly write nothing useful.
  if (result.matchedRows === 0) {
    console.log(
      `\n  !! Nothing matched. The sheet's Item column and inventory.sku are not the\n` +
      `     same identifier. Compare a few values before going further.`
    );
  }

  const sk = result.skippedRows;
  if (sk.noSku.length || sk.duplicateIgnored.length || sk.duplicateUnresolved.length) {
    console.log(`\nRows deliberately skipped:`);
    if (sk.noSku.length) console.log(`  no SKU in the row        rows ${sk.noSku.join(', ')}`);
    if (sk.duplicateIgnored.length) console.log(`  empty half of a duplicate rows ${sk.duplicateIgnored.join(', ')}`);
    if (sk.duplicateUnresolved.length) console.log(`  duplicate, unresolvable  rows ${sk.duplicateUnresolved.join(', ')}`);
  }

  console.log(`\nChanges: ${result.changes.length} row(s), ${result.cellsWritten} cell(s) written`);
  for (const c of result.changes.slice(0, 25)) {
    const parts: string[] = [];
    if (c.depot) parts.push(`depot ${c.depot.from}->${c.depot.to}`);
    if (c.shopify) parts.push(`shopify ${c.shopify.from}->${c.shopify.to}`);
    if (c.amazon) parts.push(`amazon ${c.amazon.from}->${c.amazon.to}`);
    if (c.lineTotal) parts.push(`value ${c.lineTotal.from}->${c.lineTotal.to}`);
    console.log(`  r${String(c.rowNumber).padEnd(4)} ${(c.sku || '(no sku)').padEnd(18)} ${parts.join('  ')}`);
  }
  if (result.changes.length > 25) console.log(`  … and ${result.changes.length - 25} more`);

  const t = result.totals;
  console.log(`\nTotals:`);
  console.log(`  depot-only inventory value  ${formatMoney(t.depotInventoryValue.from)} -> ${formatMoney(t.depotInventoryValue.to)}`);
  console.log(`  TOPLAM (depot + Amazon)     ${formatMoney(t.totalStockValue.from)} -> ${formatMoney(t.totalStockValue.to)}`);
  console.log(`  TOPLAM cell ${t.totalCellUpdated ? 'updated' : 'unchanged'}`);

  if (result.warnings.length) {
    console.log(`\nWarnings:`);
    for (const w of result.warnings) console.log(`  - ${w}`);
  }
  console.log(`\n${line}\n`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
