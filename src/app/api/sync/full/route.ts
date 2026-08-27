import { NextRequest, NextResponse } from 'next/server';
import { gunzipSync } from 'node:zlib';
import { auth } from '@/auth';
import { getDb } from '@/lib/db';
import { ensureSchema } from '@/lib/migrate';
import {
  getAccessToken, spFetch, fetchFbaQuantities, fetchParentAsins, UK_MARKETPLACE_ID,
} from '@/lib/amazon';
import { deriveVariantLabel } from '@/lib/grouping';

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const startTime = Date.now();
  // Leave headroom for the FBA + catalog fetches and the DB writes.
  const reportDeadline = startTime + 40_000;

  try {
    await ensureSchema();
    const token = await getAccessToken();

    // 1. Reuse an in-flight report when the client retries, rather than
    //    asking Amazon to generate a fresh one each time.
    let reportId = request.nextUrl.searchParams.get('reportId') || '';
    if (!reportId) {
      const reportRes = await spFetch('/reports/2021-06-30/reports', token, {
        method: 'POST',
        body: JSON.stringify({
          reportType: 'GET_MERCHANT_LISTINGS_ALL_DATA',
          marketplaceIds: [UK_MARKETPLACE_ID],
        }),
      });
      const reportData = await reportRes.json();
      if (!reportData.reportId) {
        return NextResponse.json({ error: 'Failed to request report', detail: reportData }, { status: 500 });
      }
      reportId = reportData.reportId;
    }

    // 2. Poll for completion.
    let reportDocumentId = '';
    while (Date.now() < reportDeadline) {
      await new Promise(r => setTimeout(r, 2000));
      const checkRes = await spFetch(`/reports/2021-06-30/reports/${reportId}`, token);
      const checkData = await checkRes.json();
      if (checkData.processingStatus === 'DONE') {
        reportDocumentId = checkData.reportDocumentId;
        break;
      }
      if (checkData.processingStatus === 'FATAL' || checkData.processingStatus === 'CANCELLED') {
        return NextResponse.json({ error: `Report ${checkData.processingStatus}` }, { status: 500 });
      }
    }
    if (!reportDocumentId) {
      return NextResponse.json(
        { error: 'TIMEOUT', message: 'Amazon report is still being prepared.', reportId },
        { status: 408 }
      );
    }

    // 3. Download + decompress.
    const docRes = await spFetch(`/reports/2021-06-30/documents/${reportDocumentId}`, token);
    const docData = await docRes.json();
    const fileRes = await fetch(docData.url);
    let text: string;
    if (docData.compressionAlgorithm === 'GZIP') {
      text = gunzipSync(Buffer.from(await fileRes.arrayBuffer())).toString('utf-8');
    } else {
      text = await fileRes.text();
    }
    text = text.replace(/\r/g, '');
    const lines = text.split('\n');

    // Strip the UTF-8 BOM Amazon prepends to the first column header.
    const headers = lines[0].split('\t').map(h => h.replace(/^﻿/, ''));
    const skuIdx = headers.indexOf('seller-sku');
    const nameIdx = headers.indexOf('item-name');
    const statusIdx = headers.indexOf('status');
    const channelIdx = headers.indexOf('fulfillment-channel');
    const qtyIdx = headers.indexOf('quantity');
    const asinIdx = headers.indexOf('asin1');

    // 4. Parse active rows.
    type Row = { sku: string; name: string; channel: string; quantity: number; asin: string };
    const rows: Row[] = [];
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const cols = line.split('\t');
      const sku = (cols[skuIdx] || '').trim();
      const status = (cols[statusIdx] || '').trim();
      if (!sku) continue;
      if (status === 'Inactive' || status === 'Closed' || status === 'Deleted') continue;
      rows.push({
        sku,
        name: (cols[nameIdx] || '').trim(),
        channel: (cols[channelIdx] || '').trim(),
        quantity: parseInt(cols[qtyIdx] || '0', 10) || 0,
        asin: asinIdx >= 0 ? (cols[asinIdx] || '').trim() : '',
      });
    }

    // 5. FBA quantities for the Amazon-fulfilled SKUs.
    const fbaSkus = Array.from(new Set(
      rows.filter(r => r.channel.startsWith('AMAZON_')).map(r => r.sku)
    ));
    const { map: fbaMap, failedBatches } = await fetchFbaQuantities(fbaSkus, token);

    // 6. Resolve variation families. Grouping is cosmetic, so a catalog
    //    failure degrades to ungrouped rather than failing the sync.
    let parentMap = new Map<string, string>();
    try {
      parentMap = await fetchParentAsins(rows.map(r => r.asin).filter(Boolean), token);
    } catch (e) {
      console.error('[sync/full] parent ASIN lookup failed, continuing ungrouped:', e);
    }

    // 7. Upsert.
    const sql = getDb();
    const syncTime = new Date().toISOString();
    let upserted = 0;

    const finalRows = rows.map(r => {
      const fbaData = fbaMap.get(r.sku.toUpperCase());
      const name = r.name || fbaData?.name || '';
      return {
        sku: r.sku,
        name,
        fbm: r.channel === 'DEFAULT' ? r.quantity : 0,
        fba: fbaData?.qty || 0,
        channel: r.channel,
        asin: r.asin || null,
        parentAsin: r.asin ? parentMap.get(r.asin) || null : null,
        label: deriveVariantLabel(name, r.sku),
      };
    });

    const BATCH = 20;
    for (let i = 0; i < finalRows.length; i += BATCH) {
      const slice = finalRows.slice(i, i + BATCH);
      await Promise.all(slice.map(r => sql`
        INSERT INTO inventory (
          sku, product_name, fbm_quantity, fba_quantity, last_sync_at,
          on_amazon, fulfillment_channel, asin, parent_asin, variant_label
        )
        VALUES (
          ${r.sku}, ${r.name}, ${r.fbm}, ${r.fba}, ${syncTime},
          TRUE, ${r.channel}, ${r.asin}, ${r.parentAsin}, ${r.label}
        )
        ON CONFLICT (sku) DO UPDATE SET
          product_name = CASE
            WHEN EXCLUDED.product_name IS NULL OR EXCLUDED.product_name = ''
            THEN inventory.product_name
            ELSE EXCLUDED.product_name
          END,
          fbm_quantity        = EXCLUDED.fbm_quantity,
          fba_quantity        = EXCLUDED.fba_quantity,
          last_sync_at        = EXCLUDED.last_sync_at,
          on_amazon           = TRUE,
          fulfillment_channel = EXCLUDED.fulfillment_channel,
          asin                = COALESCE(EXCLUDED.asin, inventory.asin),
          parent_asin         = COALESCE(EXCLUDED.parent_asin, inventory.parent_asin),
          -- Shopify's real variant title always beats our derived guess.
          variant_label = CASE
            WHEN inventory.shopify_product_id IS NOT NULL THEN inventory.variant_label
            ELSE COALESCE(EXCLUDED.variant_label, inventory.variant_label)
          END
      `));
      upserted += slice.length;
    }

    return NextResponse.json({
      success: true,
      upserted,
      activeListings: rows.length,
      fbaListings: fbaSkus.length,
      fbaMapped: fbaMap.size,
      failedBatches,
      variationFamilies: new Set(Array.from(parentMap.values())).size,
      elapsedMs: Date.now() - startTime,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
