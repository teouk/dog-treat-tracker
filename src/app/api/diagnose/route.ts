import { NextResponse } from 'next/server';
import { gunzipSync } from 'node:zlib';
import { auth } from '@/auth';
import { getAccessToken } from '@/lib/amazon';
import { getDb } from '@/lib/db';

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const results: Record<string, any> = {};

  // Step 1: Amazon Auth
  try {
    const token = await getAccessToken();
    results.step1_auth = { ok: true, tokenLength: token.length };
  } catch (e: any) {
    results.step1_auth = { ok: false, error: e.message };
    return NextResponse.json(results);
  }

  const token = await getAccessToken();
  const marketplaceId = 'A1F83G8C2ARO7P';

  // Step 2: FBA Inventory API (direct call)
  try {
    const fbaRes = await fetch(
      `https://sellingpartnerapi-eu.amazon.com/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=${marketplaceId}&marketplaceIds=${marketplaceId}`,
      { headers: { 'x-amz-access-token': token } }
    );
    const fbaData = await fbaRes.json();
    const summaries = fbaData.payload?.inventorySummaries || [];
    results.step2_fba_inventory = {
      ok: true,
      httpStatus: fbaRes.status,
      itemCount: summaries.length,
      sampleItems: summaries.slice(0, 3).map((i: any) => ({
        sku: i.sellerSku,
        name: i.productName,
        fulfillable: i.inventoryDetails?.fulfillableQuantity,
      })),
    };
  } catch (e: any) {
    results.step2_fba_inventory = { ok: false, error: e.message };
  }

  // Step 3: Request a report
  try {
    const reportRes = await fetch(
      'https://sellingpartnerapi-eu.amazon.com/reports/2021-06-30/reports',
      {
        method: 'POST',
        headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reportType: 'GET_MERCHANT_LISTINGS_ALL_DATA',
          marketplaceIds: [marketplaceId],
        }),
      }
    );
    const reportData = await reportRes.json();
    results.step3_report_request = {
      ok: !!reportData.reportId,
      httpStatus: reportRes.status,
      reportId: reportData.reportId || null,
      rawResponse: reportData,
    };

    // Step 4: Poll for report (up to 60 seconds)
    if (reportData.reportId) {
      let reportReady = false;
      let reportDocumentId = '';
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const checkRes = await fetch(
          `https://sellingpartnerapi-eu.amazon.com/reports/2021-06-30/reports/${reportData.reportId}`,
          { headers: { 'x-amz-access-token': token } }
        );
        const checkData = await checkRes.json();
        if (checkData.processingStatus === 'DONE') {
          reportReady = true;
          reportDocumentId = checkData.reportDocumentId;
          break;
        }
        if (checkData.processingStatus === 'FATAL' || checkData.processingStatus === 'CANCELLED') {
          results.step4_report_poll = { ok: false, status: checkData.processingStatus, raw: checkData };
          break;
        }
      }

      if (reportReady && reportDocumentId) {
        results.step4_report_poll = { ok: true, reportDocumentId };

        // Step 5: Download and inspect the TSV
        const docRes = await fetch(
          `https://sellingpartnerapi-eu.amazon.com/reports/2021-06-30/documents/${reportDocumentId}`,
          { headers: { 'x-amz-access-token': token } }
        );
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
        const headers = lines[0]?.split('\t') || [];

        const skuIdx = headers.indexOf('seller-sku');
        const nameIdx = headers.indexOf('item-name');
        const statusIdx = headers.indexOf('status');
        const channelIdx = headers.indexOf('fulfillment-channel');
        const qtyIdx = headers.indexOf('quantity');

        const activeLines = lines.slice(1).filter(line => {
          const cols = line.split('\t');
          const s = cols[statusIdx]?.trim();
          return s !== 'Inactive' && s !== 'Closed' && s !== 'Deleted';
        });

        results.step5_report_data = {
          ok: true,
          totalLines: lines.length - 1,
          activeLines: activeLines.length,
          headers,
          columnIndexes: { sku: skuIdx, name: nameIdx, status: statusIdx, channel: channelIdx, quantity: qtyIdx },
          sampleRows: activeLines.slice(0, 5).map(line => {
            const cols = line.split('\t');
            return {
              sku: cols[skuIdx]?.trim(),
              name: cols[nameIdx]?.trim()?.substring(0, 60),
              status: cols[statusIdx]?.trim(),
              channel: cols[channelIdx]?.trim(),
              quantity: cols[qtyIdx]?.trim(),
            };
          }),
        };
      } else if (!results.step4_report_poll) {
        results.step4_report_poll = { ok: false, status: 'TIMEOUT' };
      }
    }
  } catch (e: any) {
    results.step3_report_request = { ok: false, error: e.message };
  }

  // Step 6: Check what's in the DB
  try {
    const sql = getDb();
    const rows = await sql`SELECT sku, product_name, fba_quantity, fbm_quantity, shop_stock, last_sync_at FROM inventory LIMIT 10`;
    results.step6_database = { ok: true, rowCount: rows.length, rows };
  } catch (e: any) {
    results.step6_database = { ok: false, error: e.message };
  }

  return NextResponse.json(results, { status: 200 });
}
