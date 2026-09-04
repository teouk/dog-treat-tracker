/**
 * Create inventory rows for workbook products the app does not know about.
 *
 *   npm run workbook:import-missing            report only
 *   npm run workbook:import-missing -- --apply write to the database
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
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Put it in .env.local and run again.');
    process.exit(1);
  }
  const apply = process.argv.includes('--apply');
  const { importMissingProducts } = await import('../src/lib/workbook/import-missing');
  const r = await importMissingProducts({ dryRun: !apply, actor: 'workbook:import-missing' });

  const line = '─'.repeat(84);
  console.log(`\n${line}`);
  console.log(apply ? 'APPLIED — inventory rows created' : 'DRY RUN — database not touched');
  console.log(line);
  console.log(`\n  already in the app        ${r.alreadyPresent}`);
  console.log(`  ${apply ? 'created' : 'would create'}              ${r.toCreate.length}`);
  console.log(`  depot units brought in    ${r.depotUnitsAdded}`);

  console.log(`\n  ${'row'.padEnd(5)}${'SKU'.padEnd(20)}${'depot'.padStart(6)}${'shpfy'.padStart(7)}${'amzn'.padStart(6)}  ${'chan'.padEnd(10)}product`);
  for (const p of r.toCreate) {
    const chan = [p.onAmazon ? 'amz' : '', p.onShopify ? 'shop' : ''].filter(Boolean).join('+') || '—';
    console.log(
      `  r${String(p.rowNumber).padEnd(4)}${p.sku.padEnd(20)}` +
      `${String(p.depot).padStart(6)}${String(p.shopify).padStart(7)}${String(p.amazon).padStart(6)}  ` +
      `${chan.padEnd(10)}${(p.productName || '').slice(0, 34)}${p.variantLabel ? `  [${p.variantLabel}]` : ''}`
    );
  }

  const sk = r.skipped;
  console.log(`\n  skipped: no SKU rows ${sk.noSku.join(', ') || '—'}` +
    `; duplicate twins ${sk.duplicateIgnored.join(', ') || '—'}` +
    `; unresolved ${sk.duplicateUnresolved.join(', ') || '—'}`);
  console.log(`\n${line}\n`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
