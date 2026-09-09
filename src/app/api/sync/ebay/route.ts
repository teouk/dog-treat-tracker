export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getDb } from '@/lib/db';
import { ensureSchema } from '@/lib/migrate';
import { getEbayAccessToken, fetchActiveListings, isEbayConnected, EBAY_ENVIRONMENT } from '@/lib/ebay';
import { buildSkuIndex, suggestMatch, type SkuCandidate } from '@/lib/ebay-match';
import { syncWorkbookAfterStockChange } from '@/lib/workbook/auto-sync';

export const maxDuration = 60;

/**
 * Pull eBay quantities into `ebay_quantity`.
 *
 * eBay stock is displayed, never added to a product's total — like Shopify it
 * is a shop-front figure for units fulfilled out of the same physical shelf.
 *
 * Listings whose custom label does not match a known SKU are reported rather
 * than guessed at, with a suggested SKU where the names overlap enough to be
 * worth checking. That report is what drives relabelling the listings in eBay,
 * after which they match exactly and need no special handling.
 */
export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureSchema();

  if (!(await isEbayConnected())) {
    return NextResponse.json(
      { success: false, error: 'NOT_CONNECTED', message: 'eBay is not authorised yet.' },
      { status: 400 }
    );
  }

  const started = Date.now();
  const sql = getDb();

  try {
    const token = await getEbayAccessToken();
    const listings = await fetchActiveListings(token);

    const rows = await sql`
      SELECT sku, product_name, variant_label FROM inventory
    ` as Array<{ sku: string; product_name: string | null; variant_label: string | null }>;

    const index = buildSkuIndex(rows.map(r => r.sku));
    const candidates: SkuCandidate[] = rows.map(r => ({
      sku: r.sku,
      productName: r.product_name,
      variantLabel: r.variant_label,
    }));

    // One eBay SKU can appear on several listings; sum rather than letting the
    // last one win, which would silently under-report stock.
    const quantities = new Map<string, number>();
    const unmatched: Array<{
      itemId: string;
      title: string;
      variation: string;
      ebaySku: string;
      quantity: number;
      suggestedSku: string | null;
      confidence: number | null;
    }> = [];

    for (const listing of listings) {
      const dbSku = listing.sku ? index.get(listing.sku.trim().toUpperCase()) : undefined;
      if (dbSku) {
        quantities.set(dbSku, (quantities.get(dbSku) || 0) + listing.quantityAvailable);
        continue;
      }
      const suggestion = suggestMatch(listing, candidates);
      unmatched.push({
        itemId: listing.itemId,
        title: listing.title,
        variation: listing.variationLabel,
        ebaySku: listing.sku,
        quantity: listing.quantityAvailable,
        suggestedSku: suggestion?.sku ?? null,
        confidence: suggestion?.score ?? null,
      });
    }

    const syncedAt = new Date().toISOString();
    const entries = [...quantities.entries()];
    const BATCH = 20;
    for (let i = 0; i < entries.length; i += BATCH) {
      const slice = entries.slice(i, i + BATCH);
      await Promise.all(slice.map(([sku, qty]) => sql`
        UPDATE inventory
        SET ebay_quantity = ${qty}, on_ebay = TRUE, ebay_synced_at = ${syncedAt}
        WHERE sku = ${sku}
      `));
    }

    // A SKU that used to be on eBay but no longer appears has sold out or been
    // ended; leaving a stale figure on screen would be worse than zeroing it.
    const matchedSkus = entries.map(([sku]) => sku);
    let cleared = 0;
    if (matchedSkus.length > 0) {
      const result = await sql`
        UPDATE inventory SET ebay_quantity = 0, ebay_synced_at = ${syncedAt}
        WHERE on_ebay = TRUE AND sku <> ALL(${matchedSkus}) AND ebay_quantity <> 0
        RETURNING sku
      ` as Array<{ sku: string }>;
      cleared = result.length;
    }

    return NextResponse.json({
      success: true,
      environment: EBAY_ENVIRONMENT,
      listingsReturned: listings.length,
      matched: entries.length,
      unmatchedCount: unmatched.length,
      clearedStale: cleared,
      // Capped: this is a review aid, not a data export.
      unmatched: unmatched.slice(0, 100),
      workbook: await syncWorkbookAfterStockChange('eBay sync', session.user?.email || null),
      syncedAt,
      elapsedMs: Date.now() - started,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.error('[ebay] sync failed:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
