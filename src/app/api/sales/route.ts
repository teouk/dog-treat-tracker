import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getDb } from '@/lib/db';
import { ensureFinanceColumns } from '@/lib/finance';

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureFinanceColumns();

  const sp = request.nextUrl.searchParams;
  const from = sp.get('from');
  const to = sp.get('to');
  const channel = sp.get('channel');
  const sku = sp.get('sku');

  const sql = getDb();

  // Apply filters by switching between pre-compiled queries — the neon
  // tagged template doesn't allow conditional fragments, so we branch.
  let rows;
  if (from && to && channel && sku) {
    rows = await sql`SELECT * FROM sales WHERE sale_date >= ${from} AND sale_date < ${to} AND channel = ${channel} AND sku = ${sku} ORDER BY sale_date DESC LIMIT 1000`;
  } else if (from && to && channel) {
    rows = await sql`SELECT * FROM sales WHERE sale_date >= ${from} AND sale_date < ${to} AND channel = ${channel} ORDER BY sale_date DESC LIMIT 1000`;
  } else if (from && to && sku) {
    rows = await sql`SELECT * FROM sales WHERE sale_date >= ${from} AND sale_date < ${to} AND sku = ${sku} ORDER BY sale_date DESC LIMIT 1000`;
  } else if (from && to) {
    rows = await sql`SELECT * FROM sales WHERE sale_date >= ${from} AND sale_date < ${to} ORDER BY sale_date DESC LIMIT 1000`;
  } else if (channel) {
    rows = await sql`SELECT * FROM sales WHERE channel = ${channel} ORDER BY sale_date DESC LIMIT 1000`;
  } else if (sku) {
    rows = await sql`SELECT * FROM sales WHERE sku = ${sku} ORDER BY sale_date DESC LIMIT 1000`;
  } else {
    rows = await sql`SELECT * FROM sales ORDER BY sale_date DESC LIMIT 1000`;
  }

  return NextResponse.json(rows);
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureFinanceColumns();

  const body = await request.json();
  const channel = body.channel as string;
  const sku = (body.sku || '').trim();
  const quantity = Number(body.quantity);
  const unit_price = Number(body.unit_price);
  const sale_date = body.sale_date || new Date().toISOString();
  const notes = body.notes || null;

  if (!['amazon', 'shopify', 'manual'].includes(channel)) {
    return NextResponse.json({ error: 'channel must be amazon, shopify, or manual' }, { status: 400 });
  }
  if (!sku) return NextResponse.json({ error: 'sku required' }, { status: 400 });
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return NextResponse.json({ error: 'quantity must be positive' }, { status: 400 });
  }
  if (!Number.isFinite(unit_price) || unit_price < 0) {
    return NextResponse.json({ error: 'unit_price must be >= 0' }, { status: 400 });
  }

  const total_revenue = +(quantity * unit_price).toFixed(2);
  const sql = getDb();

  const result = await sql`
    INSERT INTO sales (channel, external_order_id, sku, quantity, unit_price, total_revenue, sale_date, notes)
    VALUES (${channel}, NULL, ${sku}, ${quantity}, ${unit_price}, ${total_revenue}, ${sale_date}, ${notes})
    RETURNING *
  ` as Array<Record<string, unknown>>;

  return NextResponse.json(result[0]);
}
