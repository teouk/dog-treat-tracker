import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getDb } from '@/lib/db';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ sku: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { sku } = await params;
  const { shop_stock } = await request.json();

  if (typeof shop_stock !== 'number' || shop_stock < 0) {
    return NextResponse.json({ error: 'Invalid shop_stock value' }, { status: 400 });
  }

  const sql = getDb();
  await sql`UPDATE inventory SET shop_stock = ${shop_stock} WHERE sku = ${sku}`;
  return NextResponse.json({ success: true });
}
