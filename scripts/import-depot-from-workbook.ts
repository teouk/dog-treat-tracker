/**
 * One-time seed of inventory.shop_stock from the workbook's Depot_OnHand.
 *
 *   npm run workbook:import-depot            report only
 *   npm run workbook:import-depot -- --apply write to the database
 *
 * Reads DATABASE_URL from .env.local. Every change is recorded in
 * stock_adjustments with source 'workbook-import'.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

async function loadEnvFile(file: string): Promise<void> {
  let text: string;
  try { text = await fs.readFile(path.join(process.cwd(), file), 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

async function main() {
  for (const f of ['.env.local', '.env']) await loadEnvFile(f);
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Put it in .env.local and run again.');
    process.exit(1);
  }

  const apply = process.argv.includes('--apply');
  const { importDepotFromWorkbook } = await import('../src/lib/workbook/import-depot');

  const r = await importDepotFromWorkbook({ dryRun: !apply, actor: 'workbook:import-depot' });
  const line = '─'.repeat(76);

  console.log(`\n${line}`);
  console.log(`${apply ? 'APPLIED — inventory.shop_stock updated' : 'DRY RUN — database not touched'}`);
  console.log(`source: ${r.source}`);
  console.log(line);

  console.log(`\n  sheet rows with a usable SKU   ${r.consideredRows}`);
  console.log(`  matched to an inventory row    ${r.matched}`);
  console.log(`  already correct                ${r.unchanged}`);
  console.log(`  ${apply ? 'updated' : 'would update'}                  ${r.changes.length}`);
  console.log(`  sheet SKU not in the database  ${r.notInDatabase.length}  (nothing created for these)`);

  const sk = r.skipped;
  if (sk.noSku.length || sk.duplicateIgnored.length || sk.duplicateUnresolved.length) {
    console.log(`\n  skipped: no SKU rows ${sk.noSku.join(', ') || '—'}` +
      `; duplicate twin rows ${sk.duplicateIgnored.join(', ') || '—'}` +
      `; unresolved duplicates ${sk.duplicateUnresolved.join(', ') || '—'}`);
  }

  console.log(`\n  depot units in app for these SKUs: ${r.unitsBefore} -> ${r.unitsAfter}`);

  console.log(`\n  Changes (${r.changes.length}):`);
  for (const c of r.changes.slice(0, 30)) {
    console.log(`    r${String(c.rowNumber).padEnd(4)} ${c.sku.padEnd(20)} ${String(c.from).padStart(6)} -> ${String(c.to).padStart(6)}   ${c.productName.slice(0, 32)}`);
  }
  if (r.changes.length > 30) console.log(`    … and ${r.changes.length - 30} more`);

  if (r.notInDatabase.length) {
    console.log(`\n  Sheet SKUs with no inventory row (their depot stock is NOT imported):`);
    for (const n of r.notInDatabase.slice(0, 40)) {
      console.log(`    r${String(n.rowNumber).padEnd(4)} ${n.sku.padEnd(22)} depot ${n.depot}`);
    }
    if (r.notInDatabase.length > 40) console.log(`    … and ${r.notInDatabase.length - 40} more`);
  }

  if (r.warnings.length) {
    console.log(`\n  Warnings:`);
    for (const w of r.warnings) console.log(`    - ${w}`);
  }
  console.log(`\n${line}\n`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
