import { NextRequest, NextResponse } from 'next/server';
import { gunzipSync } from 'node:zlib';
import { auth } from '@/auth';
import { getAccessToken } from '@/lib/amazon';
import { getDb } from '@/lib/db';
import { ensureFinanceColumns, getLastSaleDate } from '@/lib/finance';

export const maxDuration = 60;

const MARKETPLACE_ID = 'A1F83G8C2ARO7P';
const SPAPI = 'https://sellingpartnerapi-eu.amazon.com';

async function spFetch(path: string, token: string, init?: RequestInit) {
  return fetch(`${SPAPI}${path}`, {
    ...init,
    headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureFinanceColumns();

  const startTime = Date.now();
  const reportDeadline = startTime + 47_000;

  const body = await request.json().catch(() => ({}));
  let from: string = body.from;
  const to: string = body.to || new Date().toISOString();
  let reportId: string = body.reportId || '';

  if (!from) {
    const last = await getLastSaleDate('amazon');
    if (last) {
      from = new Date(new Date(last).getTime() - 60 * 60 * 1000).toISOString();
    } else {
      from = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    }
  }

  try {
    const token = await getAccessToken();

    // 1. Request the report (unless we're continuing a previous one)
    if (!reportId) {
      const reportRes = await spFetch('/reports/2021-06-30/reports', token, {
        method: 'POST',
        body: JSON.stringify({
          reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL',
          marketplaceIds: [MARKETPLACE_ID],
          dataStartTime: from,
          dataEndTime: to,
        }),
      });
      const reportData = await reportRes.json();
      if (!reportData.reportId) {
        return NextResponse.json({ error: 'Failed to request report', detail: reportData }, { status: 500 });
      }
      reportId = reportData.reportId;
    }

    // 2. Poll for completion
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
        { error: 'TIMEOUT', message: 'Amazon report is still being prepared.', reportId, from, to },
        { status: 408 }
      );
    }

    // 3. Download + decompress
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
    const headers = lines[0].split('\t').map(h => h.replace(/^﻿/, ''));

    const orderIdIdx = headers.indexOf('amazon-order-id');
    const skuIdx = headers.indexOf('sku');
    const qtyIdx = headers.indexOf('quantity');
    const priceIdx = headers.indexOf('item-price');
    const purchaseDateIdx = headers.indexOf('purchase-date');
    const statusIdx = headers.indexOf('item-status');

    if (orderIdIdx < 0 || skuIdx < 0 || qtyIdx < 0 || priceIdx < 0 || purchaseDateIdx < 0) {
      return NextResponse.json(
        { error: 'Unexpected report format', headers },
        { status: 500 }
      );
    }

    const sql = getDb();
    let inserted = 0;
    let skipped = 0;
    let lineCount = 0;

    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      lineCount++;
      const cols = line.split('\t');
      const status = (cols[statusIdx] || '').trim();
      if (status === 'Cancelled' || status === 'Pending') { skipped++; continue; }

      const externalId = (cols[orderIdIdx] || '').trim();
      const sku = (cols[skuIdx] || '').trim();
      const quantity = parseInt(cols[qtyIdx] || '0', 10) || 0;
      const itemPrice = parseFloat(cols[priceIdx] || '0') || 0;
      const purchaseDate = (cols[purchaseDateIdx] || '').trim();

      if (!externalId || !sku || quantity <= 0 || !purchaseDate) { skipped++; continue; }

      const unitPrice = +(itemPrice / quantity).toFixed(2);
      const totalRevenue = +itemPrice.toFixed(2);

      const result = await sql`
        INSERT INTO sales (channel, external_order_id, sku, quantity, unit_price, total_revenue, sale_date)
        VALUES ('amazon', ${externalId}, ${sku}, ${quantity}, ${unitPrice}, ${totalRevenue}, ${purchaseDate})
        ON CONFLICT (channel, external_order_id, sku) DO NOTHING
        RETURNING id
      ` as Array<{ id: string }>;
      if (result.length > 0) inserted++;
    }

    return NextResponse.json({
      success: true,
      from,
      to,
      lineCount,
      inserted,
      skipped,
      elapsedMs: Date.now() - startTime,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Unknown error' }, { status: 500 });
  }
}
