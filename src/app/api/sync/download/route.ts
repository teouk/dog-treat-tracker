import { NextRequest, NextResponse } from 'next/server';
import { gunzipSync } from 'node:zlib';
import { getAccessToken } from '@/lib/amazon';
import { auth } from '@/auth';
import { getDb } from '@/lib/db';

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const docId = request.nextUrl.searchParams.get('reportDocumentId');
  if (!docId) return NextResponse.json({ error: 'Missing reportDocumentId' }, { status: 400 });

  const token = await getAccessToken();
  const marketplaceId = 'A1F83G8C2ARO7P';

  const fbaMap = new Map<string, number>();

  try {
    let nextToken: string | null = null;
    do {
      const url: string = nextToken
        ? `https://sellingpartnerapi-eu.amazon.com/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=${marketplaceId}&marketplaceIds=${marketplaceId}&nextToken=${encodeURIComponent(nextToken)}`
        : `https://sellingpartnerapi-eu.amazon.com/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=${marketplaceId}&marketplaceIds=${marketplaceId}`;

      const fbaRes = await fetch(url, { headers: { 'x-amz-access-token': token } });
      const fbaData = await fbaRes.json();

      fbaData.payload?.inventorySummaries?.forEach((item: any) => {
        const sku = item.sellerSku.trim().toUpperCase();
        const qty = item.inventoryDetails?.fulfillableQuantity || 0;
        fbaMap.set(sku, qty);
      });

      nextToken = fbaData.pagination?.nextToken ?? null;
    } while (nextToken);

    console.log(`[sync/download] Mapped ${fbaMap.size} FBA SKUs`);
  } catch (err) {
    console.error('[sync/download] FBA fetch error:', err);
  }

  const docRes = await fetch(`https://sellingpartnerapi-eu.amazon.com/reports/2021-06-30/documents/${docId}`, {
    headers: { 'x-amz-access-token': token },
  });
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

  const sql = getDb();
  let upserted = 0;

  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const itemStatus = cols[headers.indexOf('status')]?.trim();
    const rawSku = (cols[headers.indexOf('seller-sku')] || '').trim();

    if (!rawSku) continue;
    if (itemStatus === 'Inactive' || itemStatus === 'Closed' || itemStatus === 'Deleted') continue;

    const productName = (cols[headers.indexOf('item-name')] || '').trim();
    const channel = (cols[headers.indexOf('fulfillment-channel')] || '').trim();
    const fbmQty = channel === 'DEFAULT' ? parseInt(cols[headers.indexOf('quantity')] || '0', 10) : 0;
    const fbaQty = fbaMap.get(rawSku.toUpperCase()) || 0;

    await sql`
      INSERT INTO inventory (sku, product_name, fbm_quantity, fba_quantity, last_sync_at)
      VALUES (${rawSku}, ${productName}, ${fbmQty}, ${fbaQty}, ${syncTime})
      ON CONFLICT (sku) DO UPDATE SET
        product_name = EXCLUDED.product_name,
        fbm_quantity = EXCLUDED.fbm_quantity,
        fba_quantity = EXCLUDED.fba_quantity,
        last_sync_at = EXCLUDED.last_sync_at
    `;
    upserted++;
  }

  console.log(`[sync/download] Upserted ${upserted} items, FBA mapped: ${fbaMap.size}`);
  return NextResponse.json({ success: true, upserted, total_fba_mapped: fbaMap.size });
}