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

/**
 * Fast Amazon sync. Refreshes FBA quantities only using the FBA Inventory
 * API directly — no slow Amazon report involved.
 *
 * Requires that a Full Sync has been run at least once to populate the
 * inventory table with SKUs.
 */
export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const startTime = Date.now();

  try {
    await ensureChannelColumns();
    const sql = getDb();

    const rows = await sql`
      SELECT sku FROM inventory WHERE on_amazon = TRUE
    ` as Array<{ sku: string }>;

    if (rows.length === 0) {
      return NextResponse.json(
        { error: 'NO_SKUS', message: 'No Amazon SKUs in database. Run a Full Refresh first.' },
        { status: 400 }
      );
    }

    const allSkus = rows.map(r => r.sku);
    const token = await getAccessToken();
    const syncTime = new Date().toISOString();

    // Batch query FBA Inventory for every Amazon SKU. SKUs that aren't FBA
    // (i.e. fulfilled by merchant) won't be returned by the API, which is fine —
    // we just skip them and leave their fbm_quantity untouched.
    const fbaMap = new Map<string, { qty: number; name: string }>();

    for (let i = 0; i < allSkus.length; i += FBA_BATCH_SIZE) {
      const batch = allSkus.slice(i, i + FBA_BATCH_SIZE);
      const url =
        `${SPAPI}/fba/inventory/v1/summaries?details=true` +
        `&granularityType=Marketplace&granularityId=${MARKETPLACE_ID}` +
        `&marketplaceIds=${MARKETPLACE_ID}` +
        `&sellerSkus=${encodeURIComponent(batch.join(','))}`;

      let attempts = 0;
      while (attempts < 3) {
        attempts++;
        const res = await fetch(url, { headers: { 'x-amz-access-token': token } });
        if (res.status === 429) {
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        const data = await res.json();
        for (const item of data.payload?.inventorySummaries || []) {
          const sku = (item.sellerSku || '').trim();
          if (!sku) continue;
          fbaMap.set(sku, {
            qty: typeof item.totalQuantity === 'number' ? item.totalQuantity : 0,
            name: item.productName || '',
          });
        }
        break;
      }

      if (i + FBA_BATCH_SIZE < allSkus.length) {
        await new Promise(r => setTimeout(r, FBA_THROTTLE_MS));
      }
    }

    // Update DB. For SKUs not in fbaMap (i.e. not FBA), set fba_quantity = 0
    // because if they're not in FBA inventory, there genuinely is none there.
    let updated = 0;
    const BATCH = 20;
    for (let i = 0; i < allSkus.length; i += BATCH) {
      const slice = allSkus.slice(i, i + BATCH);
      await Promise.all(slice.map(sku => {
        const fbaData = fbaMap.get(sku);
        const qty = fbaData?.qty || 0;
        const fbaName = fbaData?.name || '';
        return sql`
          UPDATE inventory SET
            fba_quantity = ${qty},
            product_name = CASE
              WHEN (inventory.product_name IS NULL OR inventory.product_name = '') AND ${fbaName} != ''
              THEN ${fbaName}
              ELSE inventory.product_name
            END,
            last_sync_at = ${syncTime}
          WHERE sku = ${sku}
        `;
      }));
      updated += slice.length;
    }

    return NextResponse.json({
      success: true,
      mode: 'fast',
      totalSkus: allSkus.length,
      fbaMatched: fbaMap.size,
      updated,
      elapsedMs: Date.now() - startTime,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Unknown error' }, { status: 500 });
  }
}
