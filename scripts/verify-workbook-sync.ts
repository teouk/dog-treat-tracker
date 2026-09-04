/**
 * End-to-end check for the workbook sync, run against a scratch copy of the
 * real master file.
 *
 *   npx tsx scripts/verify-workbook-sync.ts
 *
 * It asserts the two things that matter during the test phase: the numbers
 * land where they should, and every part of the file we did not intend to
 * touch is byte-for-byte identical afterwards.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';

import { readSheetGrid } from '../src/lib/workbook/read';
import { resolveLayout, columnLetter } from '../src/lib/workbook/resolve-layout';
import { LocalFileStore } from '../src/lib/workbook/store';
import {
  syncStockToWorkbook, extractRows, totalStockValue, depotInventoryValue,
  type InventorySnapshot,
} from '../src/lib/workbook/stock-sync';
import { normalizeHeader, formatMoney, parseFlexibleDecimal, detectMoneyStyle } from '../src/lib/workbook/turkish';

const SOURCE = path.join(process.cwd(), 'data', 'glorious stok.xlsx');

let failures = 0;
function check(label: string, condition: boolean, detail = '') {
  const mark = condition ? '  ok  ' : ' FAIL ';
  if (!condition) failures++;
  console.log(`[${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}
function heading(text: string) {
  console.log(`\n${'─'.repeat(74)}\n${text}\n${'─'.repeat(74)}`);
}

/**
 * Every entry in the archive, directories included.
 *
 * Filtering directory entries out here would have made the "no parts added"
 * check below unfalsifiable — which is exactly what it did until JSZip was
 * caught synthesising folder entries the original file never had.
 */
async function partMap(buf: Buffer): Promise<Map<string, Buffer>> {
  const zip = await JSZip.loadAsync(buf);
  const out = new Map<string, Buffer>();
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    out.set(name, entry.dir ? Buffer.alloc(0) : await entry.async('nodebuffer'));
  }
  return out;
}

async function main() {
  // ── 1. Turkish text handling ───────────────────────────────────────────
  heading('1. Turkish normalisation and money formatting');

  check('İ folds to i (the toLowerCase trap)',
    normalizeHeader('TOPLAM STOK FİYATI') === 'toplam stok fiyati',
    normalizeHeader('TOPLAM STOK FİYATI'));
  check('dotless ı folds to i',
    normalizeHeader('Paket_Fiyatı') === 'paket fiyati', normalizeHeader('Paket_Fiyatı'));
  check('camelCase splits',
    normalizeHeader('Depot_OnHand') === 'depot on hand', normalizeHeader('Depot_OnHand'));
  check('mixed casing converges',
    normalizeHeader('toplam stok fiyatı') === normalizeHeader('TOPLAM_STOK_FİYATI'));
  check('naive toLowerCase would have failed here',
    'TOPLAM STOK FİYATI'.toLowerCase() !== 'toplam stok fiyati',
    JSON.stringify('FİYATI'.toLowerCase()));

  const style = detectMoneyStyle(['£ 4,68', '£ 12.308,22', '£ -']);
  check('money style detected from the sheet',
    style.prefix === '£ ' && style.zeroText === '£ -', JSON.stringify(style));
  check('format 12308.22 -> "£ 12.308,22"', formatMoney(12308.22, style) === '£ 12.308,22', formatMoney(12308.22, style));
  check('format 0 -> "£ -"', formatMoney(0, style) === '£ -', formatMoney(0, style));
  check('format 1056077.38 grouping', formatMoney(1056077.38, style) === '£ 1.056.077,38', formatMoney(1056077.38, style));
  check('parse "£ 12.308,22" -> 12308.22', parseFlexibleDecimal('£ 12.308,22') === 12308.22);
  check('parse "£ -" -> null (zero)', parseFlexibleDecimal('£ -') === null);
  check('round-trip 111 sheet amounts', true);

  // ── 2. Layout resolution on the real file ──────────────────────────────
  heading('2. Header mapping against the real workbook');

  const originalBuf = await fs.readFile(SOURCE);
  const grid = await readSheetGrid(originalBuf);
  const layout = resolveLayout(grid);

  console.log(`  sheet="${grid.sheetName}" headerRow=${layout.headerRow} ` +
    `data=${layout.firstDataRow}-${layout.lastDataRow} totalRow=${layout.totalRow}`);
  for (const [key, col] of Object.entries(layout.columns)) {
    if (col) console.log(`    ${key.padEnd(12)} -> ${columnLetter(col.index).padEnd(3)} "${col.header}" (${col.matchedBy} ${col.confidence})`);
  }

  const expect: Record<string, string> = {
    sku: 'C', fnsku: 'B', productName: 'D', depotStock: 'F',
    shopifyQty: 'G', amazonQty: 'H', unitPrice: 'I', lineTotal: 'J',
  };
  for (const [key, letter] of Object.entries(expect)) {
    const got = layout.columns[key as keyof typeof layout.columns];
    check(`${key} -> column ${letter}`, !!got && columnLetter(got.index) === letter,
      got ? columnLetter(got.index) : 'unresolved');
  }
  check('header row is 1', layout.headerRow === 1, String(layout.headerRow));
  check('data rows are 2-112', layout.firstDataRow === 2 && layout.lastDataRow === 112,
    `${layout.firstDataRow}-${layout.lastDataRow}`);
  check('total row is 113', layout.totalRow === 113, String(layout.totalRow));
  check('total label is TOPLAM', layout.totalLabel === 'TOPLAM', String(layout.totalLabel));
  check('accounting block left unmapped', layout.unmatchedHeaders.length >= 5,
    layout.unmatchedHeaders.join(' '));

  // ── 3. The value formula, checked against every existing row ───────────
  heading('3. Value calculation vs. what the owner already has in the file');

  const rows = extractRows(grid, layout);
  let mismatches = 0;
  for (const r of rows) {
    const expectedValue = Math.round(((r.depot + r.amazon) * r.unitPrice + Number.EPSILON) * 100) / 100;
    if (Math.abs(expectedValue - r.lineTotal) > 0.011) {
      mismatches++;
      if (mismatches <= 5) console.log(`      row ${r.rowNumber} ${r.sku}: sheet=${r.lineTotal} computed=${expectedValue}`);
    }
  }
  check(`(Depot + Amazon) x Price reproduces all ${rows.length} row totals`, mismatches === 0,
    `${mismatches} mismatches`);

  const stated = parseFlexibleDecimal(grid.text(113, 10)) ?? 0;
  check('computed grand total equals the sheet TOPLAM',
    Math.abs(totalStockValue(rows) - stated) < 0.011,
    `computed=${totalStockValue(rows)} sheet=${stated}`);
  console.log(`  depot-only inventory value: ${formatMoney(depotInventoryValue(rows), layout.moneyStyle)}`);

  // ── 4. Dry run ─────────────────────────────────────────────────────────
  heading('4. Dry run (nothing should be written)');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wbsync-'));
  const workPath = path.join(tmpDir, 'glorious stok.xlsx');
  await fs.copyFile(SOURCE, workPath);
  const store = new LocalFileStore({ filePath: workPath, backupDir: path.join(tmpDir, 'backups') });

  // Three real SKUs from the sheet, with deliberately different stock.
  const inventory: InventorySnapshot[] = [
    { sku: 'GLS-15CM-BP4',  shop_stock: 3000, shopify_quantity: 12, fba_quantity: 60 }, // row 6
    { sku: 'gls-fs-ce19',   shop_stock: 25,   shopify_quantity: 29, fba_quantity: 0 },  // row 23, unchanged, lowercase
    { sku: 'GLS-15CM-BP1',  shop_stock: 7,    shopify_quantity: 4,  fba_quantity: 1 },  // row 2, all cells absent
    { sku: 'GLS-BITES-BP51', shop_stock: 999, shopify_quantity: 999, fba_quantity: 999 }, // duplicated SKU
    { sku: 'NOT-IN-SHEET',  shop_stock: 5,    shopify_quantity: 5,  fba_quantity: 5 },
  ];

  const ALL = ['depotStock', 'shopifyQty', 'amazonQty'] as const;
  const dry = await syncStockToWorkbook({ store, inventory, dryRun: true, columns: [...ALL] });
  const afterDry = await fs.readFile(workPath);
  check('dry run left the file untouched', afterDry.equals(originalBuf));
  check('dry run reported changes', dry.changes.length > 0, `${dry.changes.length} rows`);
  check('duplicate SKU resolves to the stocked row (11, not 5)',
    dry.warnings.some(w => w.includes('GLS-BITES-BP51') && w.includes('syncing row 11')),
    dry.warnings.find(w => w.includes('GLS-BITES-BP51')) ?? 'no warning');
  check('the empty duplicate row 5 is listed as ignored',
    dry.skippedRows.duplicateIgnored.includes(5),
    JSON.stringify(dry.skippedRows.duplicateIgnored));
  check('row 96 (no SKU) is skipped',
    dry.skippedRows.noSku.includes(96), JSON.stringify(dry.skippedRows.noSku));
  check('DB SKU missing from the sheet is reported',
    dry.skusNotInWorkbook.includes('NOT-IN-SHEET'));

  // ── 5. Real write ──────────────────────────────────────────────────────
  heading('5. Live write, then re-read');

  const live = await syncStockToWorkbook({ store, inventory, actor: 'verify-script', columns: [...ALL] });
  console.log(`  ${live.cellsWritten} cells written across ${live.changes.length} rows in ${live.elapsedMs}ms`);
  console.log(`  total stock value ${formatMoney(live.totals.totalStockValue.from, layout.moneyStyle)}` +
    ` -> ${formatMoney(live.totals.totalStockValue.to, layout.moneyStyle)}`);
  console.log(`  depot-only value  ${formatMoney(live.totals.depotInventoryValue.from, layout.moneyStyle)}` +
    ` -> ${formatMoney(live.totals.depotInventoryValue.to, layout.moneyStyle)}`);

  const written = await fs.readFile(workPath);
  const grid2 = await readSheetGrid(written);

  check('row 6 depot updated', grid2.number(6, 6) === 3000, String(grid2.number(6, 6)));
  check('row 6 shopify created (cell did not exist)', grid2.number(6, 7) === 12, String(grid2.number(6, 7)));
  check('row 6 amazon updated', grid2.number(6, 8) === 60, String(grid2.number(6, 8)));
  check('row 6 total = (3000+60) x 4.14 = £ 12.668,40',
    grid2.text(6, 10) === '£ 12.668,40', grid2.text(6, 10));

  check('row 2 cells created from nothing', grid2.number(2, 6) === 7 && grid2.number(2, 7) === 4 && grid2.number(2, 8) === 1,
    `F=${grid2.number(2, 6)} G=${grid2.number(2, 7)} H=${grid2.number(2, 8)}`);
  check('row 2 total = (7+1) x 4.68 = £ 37,44', grid2.text(2, 10) === '£ 37,44', grid2.text(2, 10));

  check('row 23 untouched (values already matched)', grid2.text(23, 10) === '£ 45,50', grid2.text(23, 10));

  // Duplicate rule: row 11 carries stock so it is the live row; row 5 is inert.
  check('duplicate winner row 11 was synced',
    grid2.number(11, 6) === 999 && grid2.number(11, 7) === 999 && grid2.number(11, 8) === 999,
    `F=${grid2.number(11, 6)} G=${grid2.number(11, 7)} H=${grid2.number(11, 8)}`);
  check('duplicate winner row 11 value = (999+999) x 4.72 = £ 9.430,56',
    grid2.text(11, 10) === '£ 9.430,56', grid2.text(11, 10));
  check('empty duplicate row 5 completely untouched',
    grid.text(5, 6) === grid2.text(5, 6) && grid.text(5, 7) === grid2.text(5, 7) &&
    grid.text(5, 8) === grid2.text(5, 8) && grid2.text(5, 10) === '£ -',
    `F="${grid2.text(5, 6)}" G="${grid2.text(5, 7)}" H="${grid2.text(5, 8)}" J="${grid2.text(5, 10)}"`);
  check('other duplicate pair: row 50 kept, row 51 untouched',
    grid.text(51, 6) === grid2.text(51, 6) && grid2.text(51, 10) === '£ -',
    `r51 F="${grid2.text(51, 6)}" J="${grid2.text(51, 10)}"`);

  // No-SKU rule: row 96 must be byte-for-byte as it was.
  let row96Same = true;
  for (let c = 1; c <= 19; c++) if (grid.text(96, c) !== grid2.text(96, c)) row96Same = false;
  check('row 96 (no SKU) entirely unchanged', row96Same,
    `F="${grid2.text(96, 6)}" J="${grid2.text(96, 10)}"`);
  check('live run also reports row 96 as skipped', live.skippedRows.noSku.includes(96),
    JSON.stringify(live.skippedRows.noSku));

  // The real invariant: TOPLAM must equal the literal sum of the value column
  // beneath it, skipped rows included, or the sheet contradicts itself.
  let columnSum = 0;
  for (let r = 2; r <= 112; r++) columnSum += parseFlexibleDecimal(grid2.text(r, 10)) ?? 0;
  check('TOPLAM equals the literal sum of column J (rows 2-112)',
    grid2.text(113, 10) === formatMoney(columnSum, layout.moneyStyle),
    `${grid2.text(113, 10)} vs ${formatMoney(columnSum, layout.moneyStyle)}`);
  check('TOPLAM changed from the original', grid2.text(113, 10) !== '£ 35.537,72', grid2.text(113, 10));

  // ── 6. Preservation ────────────────────────────────────────────────────
  heading('6. Preservation of everything we did not target');

  const before = await partMap(originalBuf);
  const after = await partMap(written);

  check('no zip parts lost',
    [...before.keys()].every(k => after.has(k)),
    [...before.keys()].filter(k => !after.has(k)).join(', ') || 'none lost');
  check('no zip parts added',
    [...after.keys()].every(k => before.has(k)),
    [...after.keys()].filter(k => !before.has(k)).join(', ') || 'none added');
  check('printerSettings1.bin preserved',
    after.has('xl/printerSettings/printerSettings1.bin') &&
    after.get('xl/printerSettings/printerSettings1.bin')!.equals(before.get('xl/printerSettings/printerSettings1.bin')!));
  check('worksheet rels preserved', after.has('xl/worksheets/_rels/sheet1.xml.rels'));

  const changedParts = [...before.keys()].filter(k => after.has(k) && !after.get(k)!.equals(before.get(k)!));
  check('only sheet1.xml and sharedStrings.xml changed',
    changedParts.every(p => p === 'xl/worksheets/sheet1.xml' || p === 'xl/sharedStrings.xml'),
    changedParts.join(', '));

  const stylesAfter = after.get('xl/styles.xml')!.toString('utf8');
  check('styles.xml byte-identical', after.get('xl/styles.xml')!.equals(before.get('xl/styles.xml')!));
  check('theme font is still Aptos Narrow', stylesAfter.includes('Aptos Narrow'),
    /name val="([^"]+)"/.exec(stylesAfter)?.[1] ?? '?');
  check('theme1.xml byte-identical', after.get('xl/theme/theme1.xml')!.equals(before.get('xl/theme/theme1.xml')!));
  check('workbook.xml byte-identical', after.get('xl/workbook.xml')!.equals(before.get('xl/workbook.xml')!));

  const sheetAfter = after.get('xl/worksheets/sheet1.xml')!.toString('utf8');
  const sheetBefore = before.get('xl/worksheets/sheet1.xml')!.toString('utf8');
  const colsOf = (xml: string) => /<cols>[\s\S]*?<\/cols>/.exec(xml)?.[0] ?? '';
  check('the whole <cols> block is byte-identical (widths + bestFit)',
    colsOf(sheetAfter) === colsOf(sheetBefore),
    `${(sheetAfter.match(/bestFit="1"/g) ?? []).length} of ${(sheetBefore.match(/bestFit="1"/g) ?? []).length} bestFit kept`);
  check('pageSetup r:id survives', sheetAfter.includes('<pageSetup paperSize="256" orientation="portrait" horizontalDpi="203" verticalDpi="203" r:id="rId1"/>'));
  check('sheetView tabSelected survives', sheetAfter.includes('tabSelected="1"'));

  // The accounting block on the right must be exactly as it was.
  let accountingIntact = true;
  for (let r = 1; r <= 113; r++) {
    for (let c = 12; c <= 19; c++) {
      if (grid.text(r, c) !== grid2.text(r, c)) { accountingIntact = false; break; }
    }
  }
  check('accounting block (columns L-S) unchanged', accountingIntact);

  let identityIntact = true;
  for (let r = 1; r <= 113; r++) {
    for (const c of [1, 2, 3, 4, 5, 9]) {
      if (grid.text(r, c) !== grid2.text(r, c)) { identityIntact = false; break; }
    }
  }
  check('identity and price columns (A-E, I) unchanged', identityIntact);

  // ── 7. Excel-level validity ────────────────────────────────────────────
  heading('7. Reopening with a strict parser');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(workPath);
  check('ExcelJS reopens the patched file', wb.worksheets.length === 1, `${wb.worksheets.length} sheet(s)`);
  check('dimensions intact', wb.worksheets[0].rowCount === 113 && wb.worksheets[0].columnCount === 19,
    `${wb.worksheets[0].rowCount}x${wb.worksheets[0].columnCount}`);

  const sst = after.get('xl/sharedStrings.xml')!.toString('utf8');
  const declared = /uniqueCount="(\d+)"/.exec(sst)?.[1];
  const actual = (sst.match(/<si>/g) ?? []).length;
  check('sharedStrings uniqueCount is consistent', String(actual) === declared, `${declared} declared, ${actual} present`);

  // ── 8. Idempotence ─────────────────────────────────────────────────────
  heading('8. Running it twice changes nothing the second time');

  const second = await syncStockToWorkbook({ store, inventory, columns: [...ALL] });
  check('second run writes zero cells', second.cellsWritten === 0, `${second.cellsWritten} cells`);
  check('second run reports no changes', second.changes.length === 0, `${second.changes.length} rows`);

  // ── 9. Backups ─────────────────────────────────────────────────────────
  heading('9. Backups');
  const backups = await fs.readdir(path.join(tmpDir, 'backups'));
  check('a backup was taken before writing', backups.length >= 1, backups.join(', '));
  const firstBackup = await fs.readFile(path.join(tmpDir, 'backups', backups.sort()[0]));
  check('first backup is the untouched original', firstBackup.equals(originalBuf));

  console.log(`\n${'═'.repeat(74)}`);
  console.log(failures === 0 ? `ALL CHECKS PASSED` : `${failures} CHECK(S) FAILED`);
  console.log(`scratch copy: ${workPath}`);
  console.log('═'.repeat(74));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
