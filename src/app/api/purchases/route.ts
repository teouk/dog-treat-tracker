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
  const sku = sp.get('sku');

  const sql = getDb();
  let rows;
  if (from && to && sku) {
    rows = await sql`SELECT * FROM purchases WHERE purchase_date >= ${from} AND purchase_date < ${to} AND sku = ${sku} ORDER BY purchase_date DESC, id DESC LIMIT 1000`;
  } else if (from && to) {
    rows = await sql`SELECT * FROM purchases WHERE purchase_date >= ${from} AND purchase_date < ${to} ORDER BY purchase_date DESC, id DESC LIMIT 1000`;
  } else if (sku) {
    rows = await sql`SELECT * FROM purchases WHERE sku = ${sku} ORDER BY purchase_date DESC, id DESC LIMIT 1000`;
  } else {
    rows = await sql`SELECT * FROM purchases ORDER BY purchase_date DESC, id DESC LIMIT 1000`;
  }

  return NextResponse.json(rows);
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureFinanceColumns();

  const body = await request.json();
  const sku = (body.sku || '').trim();
  const quantity = Number(body.quantity);
  const unit_cost = Number(body.unit_cost);
  const purchase_date = body.purchase_date || new Date().toISOString().split('T')[0];
  const supplier = body.supplier || null;
  const notes = body.notes || null;
  const updateUnitCost = body.updateUnitCost !== false; // default true

  if (!sku) return NextResponse.json({ error: 'sku required' }, { status: 400 });
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return NextResponse.json({ error: 'quantity must be positive' }, { status: 400 });
  }
  if (!Number.isFinite(unit_cost) || unit_cost < 0) {
    return NextResponse.json({ error: 'unit_cost must be >= 0' }, { status: 400 });
  }

  const total_cost = +(quantity * unit_cost).toFixed(2);
  const sql = getDb();

  const inserted = await sql`
    INSERT INTO purchases (sku, quantity, unit_cost, total_cost, purchase_date, supplier, notes)
    VALUES (${sku}, ${quantity}, ${unit_cost}, ${total_cost}, ${purchase_date}, ${supplier}, ${notes})
    RETURNING *
  ` as Array<Record<string, unknown>>;

  if (updateUnitCost) {
    await sql`UPDATE inventory SET unit_cost = ${unit_cost} WHERE sku = ${sku}`;
  }

  return NextResponse.json(inserted[0]);
}
