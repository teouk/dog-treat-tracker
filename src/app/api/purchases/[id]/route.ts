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

  if (body.quantity !== undefined || body.unit_cost !== undefined) {
    const existing = await sql`SELECT * FROM purchases WHERE id = ${id}` as Array<{ quantity: number; unit_cost: number }>;
    if (existing.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const quantity = body.quantity !== undefined ? Number(body.quantity) : existing[0].quantity;
    const unit_cost = body.unit_cost !== undefined ? Number(body.unit_cost) : Number(existing[0].unit_cost);
    if (!Number.isFinite(quantity) || quantity <= 0) return NextResponse.json({ error: 'Invalid quantity' }, { status: 400 });
    if (!Number.isFinite(unit_cost) || unit_cost < 0) return NextResponse.json({ error: 'Invalid unit_cost' }, { status: 400 });
    const total = +(quantity * unit_cost).toFixed(2);
    await sql`UPDATE purchases SET quantity = ${quantity}, unit_cost = ${unit_cost}, total_cost = ${total} WHERE id = ${id}`;
  }
  if (body.purchase_date !== undefined) {
    await sql`UPDATE purchases SET purchase_date = ${body.purchase_date} WHERE id = ${id}`;
  }
  if (body.supplier !== undefined) {
    await sql`UPDATE purchases SET supplier = ${body.supplier} WHERE id = ${id}`;
  }
  if (body.notes !== undefined) {
    await sql`UPDATE purchases SET notes = ${body.notes} WHERE id = ${id}`;
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
  await sql`DELETE FROM purchases WHERE id = ${id}`;
  return NextResponse.json({ success: true });
}
