import { NextRequest, NextResponse } from 'next/server';
import { gunzipSync } from 'node:zlib';
import { getAccessToken } from '@/lib/amazon';
import { auth } from '@/auth';
import { getDb } from '@/lib/db';
import { ensureChannelColumns } from '@/lib/shopify';

export const maxDuration = 60;

const MARKETPLACE_ID = 'A1F83G8C2ARO7P';
const SPAPI = 'https://sellingpartnerapi-eu.amazon.com';
const FBA_BATCH_SIZE = 50; // max sellerSkus per request
const FBA_THROTTLE_MS = 600; // FBA inventory rate limit is 2 req/sec

async function spFetch(path: string, token: string, init?: RequestInit) {
  return fetch(`${SPAPI}${path}`, {
    ...init,
    headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const startTime = Date.now();
  // Leave ~13s for the FBA batch fetch + DB writes after the report is ready
  const reportDeadline = startTime + 47_000;

  try {
    await ensureChannelColumns();
    const token = await getAccessToken();

    // 1. Reuse the report from a previous call if the client is retrying,
    //    otherwise request a new one. Reusing avoids restarting Amazon's
    //    report generation each retry, which is what was causing the loop.
    let reportId = request.nextUrl.searchParams.get('reportId') || '';
    if (!reportId) {
      const reportRes = await spFetch('/reports/2021-06-30/reports', token, {
        method: 'POST',
        body: JSON.stringify({
          reportType: 'GET_MERCHANT_LISTINGS_ALL_DATA',
          marketplaceIds: [MARKETPLACE_ID],
        }),
      });
      const reportData = await reportRes.json();
      if (!reportData.reportId) {
        return NextResponse.json({ error: 'Failed to request report', detail: reportData }, { status: 500 });
      }
      reportId = reportData.reportId;
    }

    // 2. Poll for report completion
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
      // Return the reportId so the client can retry against the same in-flight report
      return NextResponse.json(
        { error: 'TIMEOUT', message: 'Amazon report is still being prepared.', reportId },
        { status: 408 }
      );
    }

    // 3. Download + decompress the report
    const docRes = await spFetch(`/reports/2021-06-30/documents/${reportDocumentId}`, token);
    const docData = await docRes.json();
    const fileRes = await fetch(docData.url);
    let text: string;
    if (docData.compressionAlgorithm === 'GZIP') {
      const buffer = Buffer.from(await fileRes.arrayBuffer());
      text = gunzipSync(buffer).toString('utf-8');
    } else {
      text = await fileRes.text();
    }
    text = text.replace(/\r/g, '');
    const lines = text.split('\n');

    // Strip UTF-8 BOM that Amazon prepends to the first column header
    const headers = lines[0].split('\t').map(h => h.replace(/^﻿/, ''));
    const skuIdx = headers.indexOf('seller-sku');
    const nameIdx = headers.indexOf('item-name');
    const statusIdx = headers.indexOf('status');
    const channelIdx = headers.indexOf('fulfillment-channel');
    const qtyIdx = headers.indexOf('quantity');

    // 4. Parse active rows
    type Row = { sku: string; name: string; channel: string; quantity: number };
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
      });
    }

    // 5. Build the FBA SKU list (any AMAZON_* fulfillment channel)
    const fbaSkus = Array.from(new Set(
      rows.filter(r => r.channel.startsWith('AMAZON_')).map(r => r.sku)
    ));

    // 6. Batch-query FBA inventory for those SKUs (50 per request, throttled)
    const fbaMap = new Map<string, { qty: number; name: string }>();
    for (let i = 0; i < fbaSkus.length; i += FBA_BATCH_SIZE) {
      const batch = fbaSkus.slice(i, i + FBA_BATCH_SIZE);
      const url =
        `/fba/inventory/v1/summaries?details=true` +
        `&granularityType=Marketplace&granularityId=${MARKETPLACE_ID}` +
        `&marketplaceIds=${MARKETPLACE_ID}` +
        `&sellerSkus=${encodeURIComponent(batch.join(','))}`;

      let attempts = 0;
      while (attempts < 3) {
        attempts++;
        const res = await spFetch(url, token);
        if (res.status === 429) {
          // Throttled — back off and retry
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        const data = await res.json();
        for (const item of data.payload?.inventorySummaries || []) {
          const sku = (item.sellerSku || '').trim().toUpperCase();
          if (!sku) continue;
          fbaMap.set(sku, {
            qty: typeof item.totalQuantity === 'number' ? item.totalQuantity : 0,
            name: item.productName || '',
          });
        }
        break;
      }

      if (i + FBA_BATCH_SIZE < fbaSkus.length) {
        await new Promise(r => setTimeout(r, FBA_THROTTLE_MS));
      }
    }

    // 7. Upsert into the DB
    const sql = getDb();
    const syncTime = new Date().toISOString();
    let upserted = 0;

    const finalRows = rows.map(r => {
      const fbaData = fbaMap.get(r.sku.toUpperCase());
      const fbmQty = r.channel === 'DEFAULT' ? r.quantity : 0;
      const fbaQty = fbaData?.qty || 0;
      const name = r.name || fbaData?.name || '';
      return { sku: r.sku, name, fbm: fbmQty, fba: fbaQty };
    });

    const BATCH = 20;
    for (let i = 0; i < finalRows.length; i += BATCH) {
      const slice = finalRows.slice(i, i + BATCH);
      await Promise.all(slice.map(r => sql`
        INSERT INTO inventory (sku, product_name, fbm_quantity, fba_quantity, last_sync_at, on_amazon)
        VALUES (${r.sku}, ${r.name}, ${r.fbm}, ${r.fba}, ${syncTime}, TRUE)
        ON CONFLICT (sku) DO UPDATE SET
          product_name = CASE
            WHEN EXCLUDED.product_name IS NULL OR EXCLUDED.product_name = ''
            THEN inventory.product_name
            ELSE EXCLUDED.product_name
          END,
          fbm_quantity = EXCLUDED.fbm_quantity,
          fba_quantity = EXCLUDED.fba_quantity,
          last_sync_at = EXCLUDED.last_sync_at,
          on_amazon = TRUE
      `));
      upserted += slice.length;
    }

    return NextResponse.json({
      success: true,
      upserted,
      activeListings: rows.length,
      fbaListings: fbaSkus.length,
      fbaMapped: fbaMap.size,
      elapsedMs: Date.now() - startTime,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Unknown error' }, { status: 500 });
  }
}
