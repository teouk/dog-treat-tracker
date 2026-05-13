import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getDb } from '@/lib/db';
import { ensureFinanceColumns } from '@/lib/finance';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureFinanceColumns();
  const { id } = await params;
  const body = await request.json();
  const sql = getDb();

  if (body.quantity !== undefined || body.unit_price !== undefined) {
    const existing = await sql`SELECT * FROM sales WHERE id = ${id}` as Array<{ quantity: number; unit_price: number }>;
    if (existing.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const quantity = body.quantity !== undefined ? Number(body.quantity) : existing[0].quantity;
    const unit_price = body.unit_price !== undefined ? Number(body.unit_price) : Number(existing[0].unit_price);
    if (!Number.isFinite(quantity) || quantity <= 0) return NextResponse.json({ error: 'Invalid quantity' }, { status: 400 });
    if (!Number.isFinite(unit_price) || unit_price < 0) return NextResponse.json({ error: 'Invalid unit_price' }, { status: 400 });
    const total = +(quantity * unit_price).toFixed(2);
    await sql`UPDATE sales SET quantity = ${quantity}, unit_price = ${unit_price}, total_revenue = ${total} WHERE id = ${id}`;
  }
  if (body.sale_date !== undefined) {
    await sql`UPDATE sales SET sale_date = ${body.sale_date} WHERE id = ${id}`;
  }
  if (body.notes !== undefined) {
    await sql`UPDATE sales SET notes = ${body.notes} WHERE id = ${id}`;
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureFinanceColumns();
  const { id } = await params;
  const sql = getDb();
  await sql`DELETE FROM sales WHERE id = ${id}`;
  return NextResponse.json({ success: true });
}
