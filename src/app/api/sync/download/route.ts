import { NextRequest, NextResponse } from 'next/server';
import { getAccessToken } from '@/lib/amazon';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function GET(request: NextRequest) {
  const docId = request.nextUrl.searchParams.get('reportDocumentId');
  const token = await getAccessToken();
  const marketplaceId = 'A1F83G8C2ARO7P';

  const fbaMap = new Map();

  // 1. FETCH ALL FBA PAGES (Handling Pagination)
  try {
    let nextToken = null;
    do {
      const url: string = nextToken 
        ? `https://sellingpartnerapi-eu.amazon.com/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=${marketplaceId}&marketplaceIds=${marketplaceId}&nextToken=${nextToken}`
        : `https://sellingpartnerapi-eu.amazon.com/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=${marketplaceId}&marketplaceIds=${marketplaceId}`;

      const fbaRes = await fetch(url, { headers: { 'x-amz-access-token': token } });
      const fbaData = await fbaRes.json();
      
      fbaData.payload?.inventorySummaries?.forEach((item: any) => {
        const cleanSku = item.sellerSku.trim().toUpperCase();
        const qty = item.inventoryDetails?.fulfillableQuantity || 0;
        fbaMap.set(cleanSku, qty);
      });

      // Check if there is another page
      nextToken = fbaData.pagination?.nextToken;
      
    } while (nextToken); // Keep going as long as Amazon says "there's more"

    console.log(`Success: Mapped ${fbaMap.size} total FBA SKUs across all pages.`);
  } catch (err) {
    console.error("FBA Fetch Error:", err);
  }

  // 2. GET LISTINGS REPORT (Your Master SKU List)
  const docRes = await fetch(`https://sellingpartnerapi-eu.amazon.com/reports/2021-06-30/documents/${docId}`, {
    headers: { 'x-amz-access-token': token }
  });
  const { url } = await docRes.json();
  const fileRes = await fetch(url);
  const text = await fileRes.text();
  const lines = text.split('\n');
  const headers = lines[0].split('\t');
  const syncTime = new Date().toISOString();

  // 3. MERGE & FILTER
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const status = cols[headers.indexOf('status')];
    const rawSku = cols[headers.indexOf('seller-sku')] || '';
    const cleanSku = rawSku.trim().toUpperCase();

    // Skip Inactive/Suppressed
    if (status === 'Inactive' || status === 'Closed' || status === 'Deleted') continue;

    const productName = cols[headers.indexOf('item-name')];
    const channel = cols[headers.indexOf('fulfillment-channel')];
    
    const fbmQty = channel === 'DEFAULT' ? parseInt(cols[headers.indexOf('quantity')] || '0') : 0;
    const fbaQty = fbaMap.get(cleanSku) || 0;

    await supabase.from('inventory').upsert({
      sku: rawSku.trim(),
      product_name: productName,
      fbm_quantity: fbmQty,
      fba_quantity: fbaQty,
      last_sync_at: syncTime
    }, { onConflict: 'sku' });
  }

  return NextResponse.json({ success: true, total_fba_mapped: fbaMap.size });
}