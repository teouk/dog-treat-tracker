import { NextRequest, NextResponse } from 'next/server';
import { gunzipSync } from 'node:zlib';
import { auth } from '@/auth';
import { getAccessToken } from '@/lib/amazon';
import { getDb } from '@/lib/db';

export const maxDuration = 60;

const MARKETPLACE_ID = 'A1F83G8C2ARO7P';
const SPAPI = 'https://sellingpartnerapi-eu.amazon.com';

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sku = request.nextUrl.searchParams.get('sku');
  if (!sku) return NextResponse.json({ error: 'Missing sku query parameter' }, { status: 400 });

  const targetSku = sku.trim();
  const targetUpper = targetSku.toUpperCase();
  const result: any = { searchedFor: targetSku };

  try {
    const token = await getAccessToken();

    // 1a. Direct FBA query for this specific SKU using sellerSkus filter
    const directUrl =
      `${SPAPI}/fba/inventory/v1/summaries?details=true` +
      `&granularityType=Marketplace&granularityId=${MARKETPLACE_ID}` +
      `&marketplaceIds=${MARKETPLACE_ID}` +
      `&sellerSkus=${encodeURIComponent(targetSku)}`;
    const directRes = await fetch(directUrl, { headers: { 'x-amz-access-token': token } });
    const directData = await directRes.json();
    result.fbaDirectQuery = {
      httpStatus: directRes.status,
      url: directUrl,
      raw: directData,
    };

    // 1b. Paginated full scan with diagnostics on every page
    const fbaMatches: any[] = [];
    const pageLog: Array<{ page: number; httpStatus: number; itemCount: number; hasNextToken: boolean; errorBody?: any }> = [];
    let nextToken: string | null = null;
    let totalFbaItems = 0;
    let pageNum = 0;
    do {
      pageNum++;
      const url: string = nextToken
        ? `${SPAPI}/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=${MARKETPLACE_ID}&marketplaceIds=${MARKETPLACE_ID}&nextToken=${encodeURIComponent(nextToken)}`
        : `${SPAPI}/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=${MARKETPLACE_ID}&marketplaceIds=${MARKETPLACE_ID}`;
      const res = await fetch(url, { headers: { 'x-amz-access-token': token } });
      const data = await res.json();
      const summaries = data.payload?.inventorySummaries || [];
      totalFbaItems += summaries.length;
      pageLog.push({
        page: pageNum,
        httpStatus: res.status,
        itemCount: summaries.length,
        hasNextToken: !!data.pagination?.nextToken,
        ...(res.status >= 400 ? { errorBody: data } : {}),
      });
      for (const item of summaries) {
        const itemSku = (item.sellerSku || '').trim();
        if (itemSku.toUpperCase() === targetUpper || itemSku.toUpperCase().includes(targetUpper)) {
          fbaMatches.push({
            sellerSku: item.sellerSku,
            asin: item.asin,
            productName: item.productName,
            condition: item.condition,
            totalQuantity: item.totalQuantity,
            inventoryDetails: item.inventoryDetails,
          });
        }
      }
      nextToken = data.pagination?.nextToken ?? null;
      // Throttle: FBA Inventory rate limit is 2 req/sec
      if (nextToken) await new Promise(r => setTimeout(r, 600));
    } while (nextToken && pageNum < 50);

    result.fba = {
      totalFbaItemsScanned: totalFbaItems,
      pagesFetched: pageNum,
      pageLog,
      matchesFound: fbaMatches.length,
      matches: fbaMatches,
    };

    // 2. Search the merchant listings report for the SKU
    const reportRes = await fetch(`${SPAPI}/reports/2021-06-30/reports`, {
      method: 'POST',
      headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reportType: 'GET_MERCHANT_LISTINGS_ALL_DATA',
        marketplaceIds: [MARKETPLACE_ID],
      }),
    });
    const reportData = await reportRes.json();
    if (!reportData.reportId) {
      result.report = { error: 'Failed to request report', detail: reportData };
      return NextResponse.json(result);
    }

    // Poll up to 45s
    let reportDocumentId = '';
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const checkRes = await fetch(`${SPAPI}/reports/2021-06-30/reports/${reportData.reportId}`, {
        headers: { 'x-amz-access-token': token },
      });
      const checkData = await checkRes.json();
      if (checkData.processingStatus === 'DONE') {
        reportDocumentId = checkData.reportDocumentId;
        break;
      }
      if (checkData.processingStatus === 'FATAL' || checkData.processingStatus === 'CANCELLED') {
        result.report = { error: `Report ${checkData.processingStatus}` };
        return NextResponse.json(result);
      }
    }

    if (!reportDocumentId) {
      result.report = { error: 'Report timed out' };
      return NextResponse.json(result);
    }

    const docRes = await fetch(`${SPAPI}/reports/2021-06-30/documents/${reportDocumentId}`, {
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
    const lines = text.split('\n').filter(l => l.trim());
    const headers = lines[0].split('\t');
    const skuIdx = headers.indexOf('seller-sku');

    const reportMatches: any[] = [];
    for (const line of lines.slice(1)) {
      const cols = line.split('\t');
      const rowSku = (cols[skuIdx] || '').trim();
      if (rowSku.toUpperCase() === targetUpper || rowSku.toUpperCase().includes(targetUpper)) {
        const row: Record<string, string> = {};
        headers.forEach((h, i) => { row[h] = cols[i]; });
        reportMatches.push(row);
      }
    }

    result.report = {
      totalRows: lines.length - 1,
      matchesFound: reportMatches.length,
      headers,
      matches: reportMatches,
    };

    // 3. Check our DB
    const sql = getDb();
    const dbRows = await sql`SELECT * FROM inventory WHERE UPPER(sku) = ${targetUpper}`;
    result.database = {
      matchesFound: dbRows.length,
      rows: dbRows,
    };

    return NextResponse.json(result, { status: 200 });
  } catch (e: any) {
    result.error = e.message;
    return NextResponse.json(result, { status: 500 });
  }
}
