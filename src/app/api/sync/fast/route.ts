import { NextResponse } from 'next/server';
import { getAccessToken } from '@/lib/amazon';
import { auth } from '@/auth';
import { getDb } from '@/lib/db';
import { ensureChannelColumns } from '@/lib/shopify';

export const maxDuration = 30;

const MARKETPLACE_ID = 'A1F83G8C2ARO7P';
const SPAPI = 'https://sellingpartnerapi-eu.amazon.com';
const FBA_BATCH_SIZE = 50;
const FBA_THROTTLE_MS = 600;

type Summary = { qty: number; name: string };

async function fetchFbaBatchWithPagination(
  skus: string[],
  token: string
): Promise<{ map: Map<string, Summary>; failed: boolean }> {
  const map = new Map<string, Summary>();
  const encoded = skus.map(s => encodeURIComponent(s)).join(',');
  const base =
    `${SPAPI}/fba/inventory/v1/summaries?details=true` +
    `&granularityType=Marketplace&granularityId=${MARKETPLACE_ID}` +
    `&marketplaceIds=${MARKETPLACE_ID}` +
    `&sellerSkus=${encoded}`;

  let nextToken: string | null = null;
  let firstPage = true;

  do {
    const url: string = firstPage ? base : `${base}&nextToken=${encodeURIComponent(nextToken!)}`;

    let attempts = 0;
    let success = false;
    while (attempts < 4 && !success) {
      attempts++;
      const res = await fetch(url, { headers: { 'x-amz-access-token': token } });

      if (res.status === 429 || res.status === 503) {
        // Throttled / temporarily unavailable — back off and retry
        await new Promise(r => setTimeout(r, 1500 * attempts));
        continue;
      }
      if (!res.ok) {
        const body = await res.text();
        console.error(`[sync/fast] FBA batch ${res.status}:`, body.substring(0, 200));
        return { map, failed: true };
      }

      const data = await res.json();
      for (const item of data.payload?.inventorySummaries || []) {
        const sku = (item.sellerSku || '').trim();
        if (!sku) continue;
        map.set(sku.toUpperCase(), {
          qty: typeof item.totalQuantity === 'number' ? item.totalQuantity : 0,
          name: item.productName || '',
        });
      }
      nextToken = data.pagination?.nextToken || null;
      success = true;
    }

    if (!success) {
      console.error(`[sync/fast] FBA batch exhausted retries`);
      return { map, failed: true };
    }

    firstPage = false;
    if (nextToken) await new Promise(r => setTimeout(r, FBA_THROTTLE_MS));
  } while (nextToken);

  return { map, failed: false };
}

/**
 * Fast Amazon sync — refreshes FBA quantities for known FBA SKUs.
 *
 * Safety guarantees:
 *  - Only queries SKUs whose fulfillment_channel starts with AMAZON_
 *    (or is unknown), so we don't pollute FBM-only listings
 *  - Only UPDATEs fba_quantity for SKUs the FBA API actually returned —
 *    never zero out a SKU on a transient API miss
 *  - Handles pagination inside a single batch (e.g. when SKUs have
 *    multiple conditions, the response may paginate)
 *  - Retries throttled responses with exponential backoff
 */
export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const startTime = Date.now();

  try {
    await ensureChannelColumns();
    const sql = getDb();

    const rows = await sql`
      SELECT sku FROM inventory
      WHERE on_amazon = TRUE
        AND (fulfillment_channel IS NULL OR fulfillment_channel LIKE 'AMAZON_%')
    ` as Array<{ sku: string }>;

    if (rows.length === 0) {
      return NextResponse.json(
        { error: 'NO_SKUS', message: 'No FBA SKUs in database. Run a Full Refresh first.' },
        { status: 400 }
      );
    }

    const allSkus = rows.map(r => r.sku);
    const token = await getAccessToken();
    const syncTime = new Date().toISOString();

    const aggregate = new Map<string, Summary>();
    let failedBatches = 0;

    for (let i = 0; i < allSkus.length; i += FBA_BATCH_SIZE) {
      const batch = allSkus.slice(i, i + FBA_BATCH_SIZE);
      const { map, failed } = await fetchFbaBatchWithPagination(batch, token);
      if (failed) failedBatches++;
      for (const [k, v] of map.entries()) aggregate.set(k, v);

      if (i + FBA_BATCH_SIZE < allSkus.length) {
        await new Promise(r => setTimeout(r, FBA_THROTTLE_MS));
      }
    }

    // Only update SKUs the API returned. Missing SKUs keep their existing
    // fba_quantity — this prevents transient API misses from zeroing out
    // legitimate stock.
    const entries = Array.from(aggregate.entries());
    let updated = 0;
    const DB_BATCH = 20;
    for (let i = 0; i < entries.length; i += DB_BATCH) {
      const slice = entries.slice(i, i + DB_BATCH);
      await Promise.all(slice.map(([skuUpper, data]) => sql`
        UPDATE inventory SET
          fba_quantity = ${data.qty},
          product_name = CASE
            WHEN (inventory.product_name IS NULL OR inventory.product_name = '') AND ${data.name} != ''
            THEN ${data.name}
            ELSE inventory.product_name
          END,
          last_sync_at = ${syncTime}
        WHERE UPPER(sku) = ${skuUpper}
      `));
      updated += slice.length;
    }

    return NextResponse.json({
      success: true,
      mode: 'fast',
      totalFbaSkusInDb: allSkus.length,
      fbaReturnedByApi: aggregate.size,
      updated,
      failedBatches,
      elapsedMs: Date.now() - startTime,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Unknown error' }, { status: 500 });
  }
}
