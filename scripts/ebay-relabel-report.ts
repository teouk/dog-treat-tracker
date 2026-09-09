/**
 * Working list for aligning eBay custom labels with the app's SKUs.
 *
 *   npm run ebay:relabel
 *
 * For every active eBay listing whose label does not match a known SKU, this
 * prints the listing alongside the app SKUs it most plausibly refers to, with
 * their variant labels and current stock so the right one can be picked by
 * eye. Nothing is written anywhere — relabelling happens in eBay's own UI.
 *
 * Re-run it after each batch: matched listings drop off the list.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

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
    } catch { /* optional */ }
  }
}

type Row = {
  sku: string;
  product_name: string | null;
  variant_label: string | null;
  shop_stock: number;
  fba_quantity: number;
  ebay_quantity: number;
};

async function main() {
  await loadEnv();
  const { getDb } = await import('../src/lib/db');
  const { getEbayAccessToken, fetchActiveListings } = await import('../src/lib/ebay');
  const { buildSkuIndex, similarity } = await import('../src/lib/ebay-match');

  const sql = getDb();
  const rows = await sql`
    SELECT sku, product_name, variant_label,
           COALESCE(shop_stock,0)::int    AS shop_stock,
           COALESCE(fba_quantity,0)::int  AS fba_quantity,
           COALESCE(ebay_quantity,0)::int AS ebay_quantity
    FROM inventory
  ` as Row[];

  const index = buildSkuIndex(rows.map(r => r.sku));
  const listings = await fetchActiveListings(await getEbayAccessToken());

  const unmatched = listings.filter(l => !l.sku || !index.get(l.sku.trim().toUpperCase()));

  const lines: string[] = [];
  const out = (t = '') => { lines.push(t); console.log(t); };

  out(`# eBay relabelling worksheet`);
  out();
  out(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ` +
      `${listings.length} listing rows · ${listings.length - unmatched.length} already matching · ` +
      `**${unmatched.length} to relabel**`);
  out();
  out(`Set each listing's **Custom label (SKU)** in eBay to the SKU in the "Change to" column.`);
  out(`For a multi-variation listing the label is set per variation, not on the parent.`);
  out();

  // Which app SKUs each eBay listing already resolves to. A variation whose
  // siblings on the same listing are known is far better identified by those
  // siblings than by its title: "15 cm 100 gr." scores well against a trachea
  // and a cow tail alike, but its siblings are unambiguously cow tails.
  const siblingSkus = new Map<string, string[]>();
  for (const l of listings) {
    const known = l.sku ? index.get(l.sku.trim().toUpperCase()) : undefined;
    if (!known) continue;
    const seen = siblingSkus.get(l.itemId);
    if (seen) seen.push(known);
    else siblingSkus.set(l.itemId, [known]);
  }

  const bySku = new Map(rows.map(r => [r.sku, r]));

  for (const [i, listing] of unmatched.entries()) {
    const siblings = siblingSkus.get(listing.itemId) ?? [];

    // Two independent signals. Product names describe the item; the labels
    // themselves often encode the variant that names omit — "XS-YakCheese-5ct"
    // against "XS-YakCheese-FBM" identifies the size where both product names
    // are identical and the variant column reads "FBM" for every one of them.
    const scored = rows
      .map(r => {
        const byName = similarity(
          `${listing.title} ${listing.variationLabel}`,
          `${r.product_name ?? ''} ${r.variant_label ?? ''}`
        );
        const byLabel = listing.sku ? similarity(listing.sku, r.sku) : 0;
        return { row: r, score: Math.max(byName, byLabel), byName, byLabel };
      })
      .sort((a, b) => b.score - a.score);

    // Rank every SKU, then lift those that share a product family with a
    // confirmed sibling. A single family filter was too narrow — the cow tail
    // SKUs live under several different product names, so restricting to one
    // name hid the 15cm/100g variant that was obviously the right answer.
    const siblingNames = siblings
      .map(sku => bySku.get(sku)?.product_name)
      .filter(Boolean) as string[];

    const ranked = scored
      .map(({ row, score, byName, byLabel }) => {
        const familyBoost = siblingNames.length
          ? Math.max(...siblingNames.map(n => similarity(n, row.product_name ?? '')))
          : 0;
        return { row, score, byName, byLabel, familyBoost, combined: score + familyBoost };
      })
      .filter(c => !siblings.includes(c.row.sku))
      .sort((a, b) => b.combined - a.combined)
      .slice(0, 10);

    const basis = siblings.length
      ? `other variations of this listing map to ${siblings.map(x => '`' + x + '`').join(', ')} — ranked with those families lifted`
      : `name similarity only, no confirmed siblings on this listing — check carefully`;

    out(`---`);
    out();
    out(`### ${i + 1}. ${listing.title}`);
    out();
    out(`| | |`);
    out(`|---|---|`);
    out(`| eBay item | \`${listing.itemId}\` |`);
    if (listing.variationLabel) out(`| Variation | ${listing.variationLabel} |`);
    out(`| Current label | ${listing.sku ? `\`${listing.sku}\`` : '*(blank)*'} |`);
    out(`| eBay qty | ${listing.quantityAvailable} |`);
    out();
    out(`Basis: ${basis}`);
    out();
    if (ranked.length === 0) {
      out(`*No candidates left — every plausible SKU is already claimed by another variation.*`);
      out();
      continue;
    }
    out(`| Change to | Product | Variant | Depo | FBA | fit |`);
    out(`|---|---|---|---|---|---|`);
    for (const c of ranked) {
      const fit = c.byLabel > 0.5 ? '**label**'
        : c.familyBoost > 0.3 ? 'family'
        : c.byName > 0.35 ? 'name'
        : '·';
      out(`| \`${c.row.sku}\` | ${(c.row.product_name ?? '—').slice(0, 32)} | ${c.row.variant_label ?? '—'} | ${c.row.shop_stock} | ${c.row.fba_quantity} | ${fit} |`);
    }
    out();
  }

  if (unmatched.length === 0) out(`Nothing left to relabel — every listing matches a SKU.`);

  const file = path.join(process.cwd(), 'ebay-relabel.md');
  await fs.writeFile(file, lines.join('\n'), 'utf8');
  console.log(`\nWritten to ${file}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
