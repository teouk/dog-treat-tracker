import { NextResponse } from 'next/server';
import { gunzipSync } from 'node:zlib';
import { getAccessToken } from '@/lib/amazon';
import { auth } from '@/auth';
import { getDb } from '@/lib/db';
import { ensureChannelColumns } from '@/lib/shopify';

export const maxDuration = 60;

const MARKETPLACE_ID = 'A1F83G8C2ARO7P';
const SPAPI = 'https://sellingpartnerapi-eu.amazon.com';

async function spFetch(path: string, token: string, init?: RequestInit) {
  return fetch(`${SPAPI}${path}`, {
    ...init,
    headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const startTime = Date.now();
  const deadline = startTime + 52_000; // leave 8s buffer before Vercel's 60s limit

  try {
    await ensureChannelColumns();
    const token = await getAccessToken();

    // Fetch FBA inventory in parallel with starting the report
    const fbaPromise = (async () => {
      const fbaMap = new Map<string, { qty: number; name: string }>();
      let nextToken: string | null = null;
      do {
        const url: string = nextToken
          ? `/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=${MARKETPLACE_ID}&marketplaceIds=${MARKETPLACE_ID}&nextToken=${encodeURIComponent(nextToken)}`
          : `/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=${MARKETPLACE_ID}&marketplaceIds=${MARKETPLACE_ID}`;
        const res = await spFetch(url, token);
        const data = await res.json();
        data.payload?.inventorySummaries?.forEach((item: any) => {
          const sku = (item.sellerSku || '').trim().toUpperCase();
          if (!sku) return;
          fbaMap.set(sku, { qty: item.inventoryDetails?.fulfillableQuantity || 0, name: item.productName || '' });
        });
        nextToken = data.pagination?.nextToken ?? null;
      } while (nextToken);
      return fbaMap;
    })();

    // Request listings report
    const reportRes = await spFetch('/reports/2021-06-30/reports', token, {
      method: 'POST',
      body: JSON.stringify({ reportType: 'GET_MERCHANT_LISTINGS_ALL_DATA', marketplaceIds: [MARKETPLACE_ID] }),
    });
    const reportData = await reportRes.json();
    if (!reportData.reportId) {
      return NextResponse.json({ error: 'Failed to request report', detail: reportData }, { status: 500 });
    }

    // Poll for the report (every 2s)
    let reportDocumentId = '';
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const checkRes = await spFetch(`/reports/2021-06-30/reports/${reportData.reportId}`, token);
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
      return NextResponse.json({ error: 'TIMEOUT', message: 'Amazon report is still being prepared. Try again in a minute.' }, { status: 408 });
    }

    // Download the report
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
    const headers = lines[0].split('\t');
    const syncTime = new Date().toISOString();

    const fbaMap = await fbaPromise;
    const sql = getDb();
    let upserted = 0;

    // Build batch values
    const skuIdx = headers.indexOf('seller-sku');
    const nameIdx = headers.indexOf('item-name');
    const statusIdx = headers.indexOf('status');
    const channelIdx = headers.indexOf('fulfillment-channel');
    const qtyIdx = headers.indexOf('quantity');

    // Parallelize upserts in batches of 25 to speed things up
    const rows: Array<{ sku: string; name: string; fbm: number; fba: number }> = [];
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const cols = line.split('\t');
      const itemStatus = cols[statusIdx]?.trim();
      const rawSku = (cols[skuIdx] || '').trim();
      if (!rawSku) continue;
      if (itemStatus === 'Inactive' || itemStatus === 'Closed' || itemStatus === 'Deleted') continue;

      const fbaData = fbaMap.get(rawSku.toUpperCase());
      const reportName = (cols[nameIdx] || '').trim();
      const productName = reportName || fbaData?.name || '';
      const channel = (cols[channelIdx] || '').trim();
      const fbmQty = channel === 'DEFAULT' ? parseInt(cols[qtyIdx] || '0', 10) : 0;
      const fbaQty = fbaData?.qty || 0;
      rows.push({ sku: rawSku, name: productName, fbm: fbmQty, fba: fbaQty });
    }

    // Run upserts in parallel batches
    const BATCH = 20;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      await Promise.all(slice.map(r => sql`
        INSERT INTO inventory (sku, product_name, fbm_quantity, fba_quantity, last_sync_at, on_amazon)
        VALUES (${r.sku}, ${r.name}, ${r.fbm}, ${r.fba}, ${syncTime}, TRUE)
        ON CONFLICT (sku) DO UPDATE SET
          product_name = EXCLUDED.product_name,
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
      fbaMapped: fbaMap.size,
      elapsedMs: Date.now() - startTime,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Unknown error' }, { status: 500 });
  }
}
