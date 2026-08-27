import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getDb } from '@/lib/db';
import { ensureSchema } from '@/lib/migrate';

type ItemInput = { sku: string; quantity: number };

/**
 * GET — delivery history, newest first, with line items attached.
 *
 * Receipts are append-only: there is deliberately no PATCH or DELETE here.
 * A miscount is corrected by recording a manual adjustment, which leaves
 * both the original delivery and the correction visible.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureSchema();
  const sql = getDb();

  const limitParam = parseInt(request.nextUrl.searchParams.get('limit') || '50', 10);
  const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 50, 1), 200);

  const rows = await sql`
    SELECT
      r.id, r.reference, r.supplier, r.note, r.received_by, r.created_at,
      COALESCE(SUM(i.quantity), 0)::int AS total_units,
      COUNT(i.id)::int                  AS line_count,
      COALESCE(
        json_agg(
          json_build_object(
            'sku', i.sku, 'quantity', i.quantity,
            'before_qty', i.before_qty, 'after_qty', i.after_qty,
            'product_name', inv.product_name, 'variant_label', inv.variant_label
          ) ORDER BY i.sku
        ) FILTER (WHERE i.id IS NOT NULL), '[]'
      ) AS items
    FROM bulk_receipts r
    LEFT JOIN bulk_receipt_items i ON i.receipt_id = r.id
    LEFT JOIN inventory inv        ON inv.sku = i.sku
    GROUP BY r.id
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ${limit}
  `;

  return NextResponse.json(rows);
}

/**
 * POST — record a pallet delivery.
 *
 * Increments shop stock and writes the immutable delivery record in a
 * single statement, so a delivery can never be half-applied: either every
 * line lands with its audit trail, or nothing changes at all.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureSchema();
  const body = await request.json().catch(() => ({}));
  const actor = session.user?.email || null;

  const reference = typeof body.reference === 'string' ? body.reference.trim().slice(0, 120) || null : null;
  const supplier = typeof body.supplier === 'string' ? body.supplier.trim().slice(0, 120) || null : null;
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) || null : null;

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: 'Add at least one product' }, { status: 400 });
  }
  if (body.items.length > 500) {
    return NextResponse.json({ error: 'Too many lines in one delivery' }, { status: 400 });
  }

  // Merge repeated SKUs rather than rejecting them — picking the same
  // product twice on a long form is an easy slip, and the intent is clear.
  const merged = new Map<string, number>();
  for (const raw of body.items as ItemInput[]) {
    const sku = typeof raw?.sku === 'string' ? raw.sku.trim() : '';
    const qty = Number(raw?.quantity);
    if (!sku) continue;
    if (!Number.isInteger(qty) || qty <= 0 || qty > 1_000_000) {
      return NextResponse.json(
        { error: `Quantity for ${sku} must be a whole number above zero` },
        { status: 400 }
      );
    }
    merged.set(sku, (merged.get(sku) || 0) + qty);
  }

  if (merged.size === 0) {
    return NextResponse.json({ error: 'Add at least one product' }, { status: 400 });
  }

  const skus = Array.from(merged.keys());
  const quantities = skus.map(s => merged.get(s)!);
  const sql = getDb();

  // Reject the whole delivery if any SKU is unknown, rather than silently
  // dropping that line and reporting success.
  const known = await sql`
    SELECT sku FROM inventory WHERE sku = ANY(${skus})
  ` as Array<{ sku: string }>;
  const knownSet = new Set(known.map(r => r.sku));
  const unknown = skus.filter(s => !knownSet.has(s));
  if (unknown.length > 0) {
    return NextResponse.json(
      { error: `Unknown SKU${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}` },
      { status: 400 }
    );
  }

  const label = reference ? `Pallet delivery ${reference}` : 'Pallet delivery';

  const result = await sql`
    WITH new_receipt AS (
      INSERT INTO bulk_receipts (reference, supplier, note, received_by)
      VALUES (${reference}, ${supplier}, ${note}, ${actor})
      RETURNING id
    ),
    input AS (
      SELECT sku, qty FROM unnest(${skus}::text[], ${quantities}::int[]) AS t(sku, qty)
    ),
    upd AS (
      UPDATE inventory i
      SET shop_stock = COALESCE(i.shop_stock, 0) + input.qty
      FROM input
      WHERE i.sku = input.sku
      RETURNING i.sku, input.qty, COALESCE(i.shop_stock, 0) AS after_qty
    ),
    items AS (
      INSERT INTO bulk_receipt_items (receipt_id, sku, quantity, before_qty, after_qty)
      SELECT (SELECT id FROM new_receipt), u.sku, u.qty, u.after_qty - u.qty, u.after_qty
      FROM upd u
      RETURNING 1
    ),
    adj AS (
      INSERT INTO stock_adjustments
        (sku, delta, before_qty, after_qty, reason, adjusted_by, source)
      SELECT u.sku, u.qty, u.after_qty - u.qty, u.after_qty, ${label}, ${actor}, 'receipt'
      FROM upd u
      RETURNING 1
    )
    SELECT
      (SELECT id FROM new_receipt)::int AS receipt_id,
      (SELECT count(*) FROM upd)::int   AS lines_applied,
      (SELECT COALESCE(SUM(qty), 0) FROM input)::int AS total_units
  ` as Array<{ receipt_id: number; lines_applied: number; total_units: number }>;

  return NextResponse.json({
    success: true,
    receiptId: result[0]?.receipt_id,
    linesApplied: result[0]?.lines_applied ?? 0,
    totalUnits: result[0]?.total_units ?? 0,
  });
}
