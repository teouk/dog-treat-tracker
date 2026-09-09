/**
 * Import the shop's product names and bag sizes from the master workbook.
 *
 *   npm run workbook:import-catalogue            report only
 *   npm run workbook:import-catalogue -- --apply write to the database
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

async function loadEnvFile(file: string): Promise<void> {
  let text: string;
  try { text = await fs.readFile(path.join(process.cwd(), file), 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

async function main() {
  for (const f of ['.env.local', '.env']) await loadEnvFile(f);
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }

  const apply = process.argv.includes('--apply');
  const { importCatalogueFromWorkbook } = await import('../src/lib/workbook/import-catalogue');
  const r = await importCatalogueFromWorkbook({ dryRun: !apply });

  const line = '─'.repeat(78);
  console.log(`\n${line}`);
  console.log(apply ? 'APPLIED — shop names and variants written' : 'DRY RUN — database not touched');
  console.log(`source: ${r.source}`);
  console.log(line);
  console.log(`\n  workbook rows with a SKU     ${r.consideredRows}`);
  console.log(`  matched to an inventory row  ${r.matched}`);
  console.log(`  already correct              ${r.unchanged}`);
  console.log(`  ${apply ? 'updated' : 'would update'}                ${r.changes.length}`);
  console.log(`  workbook SKU not in the app  ${r.notInDatabase.length}`);
  console.log(`  app SKUs with no workbook row ${r.withoutWorkbookRow}  (keep channel naming)`);

  console.log(`\n  ${'SKU'.padEnd(20)}${'shop name'.padEnd(40)}variant`);
  for (const c of r.changes.slice(0, 25)) {
    console.log(`  ${c.sku.padEnd(20)}${c.name.to.slice(0, 38).padEnd(40)}${c.variant.to}`);
  }
  if (r.changes.length > 25) console.log(`  … and ${r.changes.length - 25} more`);

  if (r.notInDatabase.length) {
    console.log(`\n  in the workbook but not the app: ${r.notInDatabase.slice(0, 12).join(', ')}`);
  }
  if (r.warnings.length) {
    console.log(`\n  Warnings:`);
    for (const w of r.warnings) console.log(`    - ${w}`);
  }
  console.log(`\n${line}\n`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
