import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getDb } from '@/lib/db';
import { ensureFinanceColumns, getLastSaleDate } from '@/lib/finance';
import { fetchShopifyOrders, getShopifyToken, ShopifyForbiddenError } from '@/lib/shopify';

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureFinanceColumns();

  const token = await getShopifyToken();
  if (!token) {
    return NextResponse.json(
      { error: 'NOT_CONNECTED', message: 'Connect Shopify first.' },
      { status: 400 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const to = body.to || new Date().toISOString();

  let from = body.from;
  if (!from) {
    const last = await getLastSaleDate('shopify');
    if (last) {
      // 1 hour overlap to catch edge cases
      from = new Date(new Date(last).getTime() - 60 * 60 * 1000).toISOString();
    } else {
      // First-time sync: pull last 90 days by default
      from = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    }
  }

  let orders;
  try {
    orders = await fetchShopifyOrders(token, from, to);
  } catch (e: any) {
    if (e instanceof ShopifyForbiddenError) {
      return NextResponse.json(
        {
          error: 'RECONNECT_REQUIRED',
          message: 'Shopify needs to be reconnected to grant order permissions (read_orders scope).',
        },
        { status: 403 }
      );
    }
    return NextResponse.json({ error: e.message || 'Shopify orders fetch failed' }, { status: 500 });
  }

  const sql = getDb();
  let inserted = 0;
  let skipped = 0;
  let lineItemCount = 0;

  for (const order of orders) {
    const externalId = String(order.id);
    const saleDate = order.created_at;
    for (const line of order.line_items || []) {
      lineItemCount++;
      const sku = (line.sku || '').trim();
      if (!sku) { skipped++; continue; }
      const quantity = Number(line.quantity) || 0;
      const unitPrice = Number(line.price) || 0;
      if (quantity <= 0) { skipped++; continue; }
      const total = +(quantity * unitPrice).toFixed(2);

      const result = await sql`
        INSERT INTO sales (channel, external_order_id, sku, quantity, unit_price, total_revenue, sale_date)
        VALUES ('shopify', ${externalId}, ${sku}, ${quantity}, ${unitPrice}, ${total}, ${saleDate})
        ON CONFLICT (channel, external_order_id, sku) DO NOTHING
        RETURNING id
      ` as Array<{ id: string }>;
      if (result.length > 0) inserted++;
    }
  }

  return NextResponse.json({
    success: true,
    from,
    to,
    ordersFetched: orders.length,
    lineItemsProcessed: lineItemCount,
    inserted,
    skipped,
  });
}
