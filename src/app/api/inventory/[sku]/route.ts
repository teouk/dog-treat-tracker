import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getDb } from '@/lib/db';
import { ensureFinanceColumns } from '@/lib/finance';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ sku: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureFinanceColumns();

  const { sku } = await params;
  const body = await request.json();
  const sql = getDb();

  // shop_stock — kept for backwards compatibility with the inventory dashboard
  if (body.shop_stock !== undefined) {
    if (typeof body.shop_stock !== 'number' || body.shop_stock < 0) {
      return NextResponse.json({ error: 'Invalid shop_stock value' }, { status: 400 });
    }
    await sql`UPDATE inventory SET shop_stock = ${body.shop_stock} WHERE sku = ${sku}`;
  }

  // amazon_price / shopify_price / unit_cost — accept null to clear, or number >= 0
  async function updateMoneyField(field: 'amazon_price' | 'shopify_price' | 'unit_cost', value: any) {
    if (value === null) {
      if (field === 'amazon_price') await sql`UPDATE inventory SET amazon_price = NULL WHERE sku = ${sku}`;
      else if (field === 'shopify_price') await sql`UPDATE inventory SET shopify_price = NULL WHERE sku = ${sku}`;
      else await sql`UPDATE inventory SET unit_cost = NULL WHERE sku = ${sku}`;
      return null;
    }
    if (typeof value !== 'number' || isNaN(value) || value < 0) {
      return `Invalid ${field} value`;
    }
    if (field === 'amazon_price') await sql`UPDATE inventory SET amazon_price = ${value} WHERE sku = ${sku}`;
    else if (field === 'shopify_price') await sql`UPDATE inventory SET shopify_price = ${value} WHERE sku = ${sku}`;
    else await sql`UPDATE inventory SET unit_cost = ${value} WHERE sku = ${sku}`;
    return null;
  }

  for (const field of ['amazon_price', 'shopify_price', 'unit_cost'] as const) {
    if (body[field] !== undefined) {
      const err = await updateMoneyField(field, body[field]);
      if (err) return NextResponse.json({ error: err }, { status: 400 });
    }
  }

  return NextResponse.json({ success: true });
}
