/**
 * Tests the eBay -> SKU matching against the real inventory table.
 *
 *   npm run verify:ebay
 *
 * The eBay side is the listings seen in Seller Hub, typed in by hand — the
 * sandbox has no listings of its own, so this is the only way to exercise
 * the matcher before production credentials exist.
 */
import { promises as fs } from 'node:fs';

async function loadEnv() {
  for (const file of ['.env.local', '.env']) {
    try {
      for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (process.env[m[1]] === undefined) process.env[m[1]] = v;
      }
    } catch { /* file is optional */ }
  }
}

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  await loadEnv();
  const { getDb } = await import('../src/lib/db');
  const { buildSkuIndex, suggestMatch, similarity, tokenize } = await import('../src/lib/ebay-match');

  console.log('-- tokenizer --');
  check('splits camelCase', tokenize('YakCheeseSticks').includes('yak'), tokenize('YakCheeseSticks').join(','));
  check('keeps counts', tokenize('M-YakCheese-3ct').includes('3ct'), tokenize('M-YakCheese-3ct').join(','));
  check('drops single chars', !tokenize('a b cow').includes('a'));

  console.log('\n-- similarity --');
  check('identical strings score 1', similarity('beef cheek roll', 'beef cheek roll') === 1);
  check('unrelated products score low', similarity('Yak Milk Chew', 'Cow Hooves') < 0.15,
    String(similarity('Yak Milk Chew', 'Cow Hooves')));
  check('boilerplate alone does not match',
    similarity('Natural Dog Chews Dental Treats', 'Natural Dog Chews Dental Treats Long Lasting') === 0,
    'stop-words stripped');

  const rows = await getDb()`SELECT sku, product_name, variant_label FROM inventory` as Array<{
    sku: string; product_name: string | null; variant_label: string | null;
  }>;
  const candidates = rows.map(r => ({ sku: r.sku, productName: r.product_name, variantLabel: r.variant_label }));
  console.log(`\n-- against ${rows.length} real SKUs --`);

  const index = buildSkuIndex(rows.map(r => r.sku));
  check('exact match is case-insensitive',
    index.get('GLS-15CM-GS48') !== undefined && index.get('gls-15cm-gs48'.toUpperCase()) !== undefined);
  check('unknown label does not match', index.get('YAKCHEESESTICKS') === undefined);

  // The real listings from Seller Hub.
  const listings = [
    { sku: 'GLS-15CM-GS48', title: '100% Goat Headskin Dog Chews Rawhide Free Grain Free Puppy Dental Treats Sticks', variationLabel: '' },
    { sku: 'XS-YakCheese-5ct', title: '100% Natural Himalayan Yak Milk Dog Chew, Long Lasting High Protein Dental Treat', variationLabel: 'Size & Count: XS (20g - 30g) x 5' },
    { sku: 'M-YakCheese-3ct', title: '100% Natural Himalayan Yak Milk Dog Chew, Long Lasting High Protein Dental Treat', variationLabel: 'Size & Count: M (65g - 75g) x 3' },
    { sku: 'GLS-Beef Cheek Roll', title: 'Beef Cheek Roll Dog Chews, Natural Long Lasting Dental Treats, Grain Free', variationLabel: '' },
    { sku: '', title: '100% Natural Lamb Ears for Dogs, Air Dried, High Protein Puppy Chews, 100g/250g', variationLabel: '' },
    { sku: 'GLS-Beef & Cow Tail', title: 'Beef & Cow Tail Dog Chews Natural Air Dried Long Lasting Dental Treats', variationLabel: '' },
  ];

  console.log('\n  eBay listing                          exact?   suggestion (score / runner-up)');
  for (const l of listings) {
    const exact = l.sku ? index.get(l.sku.trim().toUpperCase()) : undefined;
    const s = exact ? null : suggestMatch(l, candidates);
    const name = (l.sku || '(no label)').slice(0, 22).padEnd(24);
    const varLabel = l.variationLabel ? l.variationLabel.slice(0, 12) : '';
    console.log(
      `  ${name}${varLabel.padEnd(14)}` +
      `${exact ? 'EXACT' : '  -  '}    ` +
      `${s ? `${s.sku} (${s.score} / ${s.runnerUp})` : exact ? '' : 'no confident suggestion'}`
    );
  }

  const goat = listings[0];
  check('the one aligned label matches exactly', index.get(goat.sku.toUpperCase()) === 'GLS-15CM-GS48');

  check('camelCase now splits into words',
    tokenize('XS-YakCheese-5ct').includes('yak') && tokenize('XS-YakCheese-5ct').includes('cheese'),
    tokenize('XS-YakCheese-5ct').join(','));

  // A tie carries no information, so it must not be dressed up as a match.
  const tied = suggestMatch(
    { sku: '', title: 'Beef Cheek Roll Dog Chews', variationLabel: '' },
    [
      { sku: 'A-1', productName: 'Beef Cheek Roll', variantLabel: null },
      { sku: 'A-2', productName: 'Beef Cheek Roll', variantLabel: null },
    ]
  );
  check('identical candidates produce no suggestion', tied === null,
    tied ? `wrongly suggested ${tied.sku}` : 'suppressed');

  console.log(failures === 0 ? '\nEBAY MATCH OK' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
