import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getDb } from '@/lib/db';
import { ensureSchema } from '@/lib/migrate';
import { syncWorkbookAfterStockChange } from '@/lib/workbook/auto-sync';

/**
 * PATCH /api/inventory/:sku — adjust the manually-tracked shop stock.
 *
 *   { adjust: -56 }      relative change, applied atomically in SQL
 *   { shop_stock: 100 }  absolute set
 *
 * `adjust` is the preferred form: it computes the new value inside the
 * UPDATE, so two people adjusting the same SKU at once can't clobber each
 * other the way a read-modify-write from the client would. Stock is
 * clamped at zero rather than rejected, and every change is recorded in
 * stock_adjustments.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ sku: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureSchema();

  const { sku } = await params;
  const body = await request.json().catch(() => ({}));
  const sql = getDb();
  const actor = session.user?.email || null;
  const reason = typeof body.reason === 'string' && body.reason.trim()
    ? body.reason.trim().slice(0, 200)
    : null;

  const hasAdjust = body.adjust !== undefined;
  const hasSet = body.shop_stock !== undefined;

  if (hasAdjust && hasSet) {
    return NextResponse.json(
      { error: 'Send either adjust or shop_stock, not both' },
      { status: 400 }
    );
  }

  if (hasAdjust) {
    const delta = Number(body.adjust);
    if (!Number.isInteger(delta) || delta === 0) {
      return NextResponse.json({ error: 'adjust must be a non-zero integer' }, { status: 400 });
    }
    if (Math.abs(delta) > 1_000_000) {
      return NextResponse.json({ error: 'adjust out of range' }, { status: 400 });
    }

    // The CTE reads the pre-update value from the same snapshot as the
    // UPDATE, so before/after are captured in one atomic statement.
    const rows = await sql`
      WITH prev AS (
        SELECT COALESCE(shop_stock, 0) AS before_qty FROM inventory WHERE sku = ${sku}
      )
      UPDATE inventory
      SET shop_stock = GREATEST(0, COALESCE(shop_stock, 0) + ${delta})
      WHERE sku = ${sku}
      RETURNING
        (SELECT before_qty FROM prev)  AS before_qty,
        COALESCE(shop_stock, 0)        AS shop_stock
    ` as Array<{ before_qty: number; shop_stock: number }>;

    if (rows.length === 0) return NextResponse.json({ error: 'SKU not found' }, { status: 404 });

    const before = rows[0].before_qty;
    const after = rows[0].shop_stock;
    // Clamping at zero means the applied delta can be smaller than requested.
    const applied = after - before;

    await sql`
      INSERT INTO stock_adjustments (sku, delta, before_qty, after_qty, reason, adjusted_by)
      VALUES (${sku}, ${applied}, ${before}, ${after}, ${reason}, ${actor})
    `;

    return NextResponse.json({
      success: true,
      sku,
      shop_stock: after,
      requested: delta,
      applied,
      clamped: applied !== delta,
      workbook: await syncWorkbookAfterStockChange(`adjust ${sku}`, actor),
    });
  }

  if (hasSet) {
    const value = Number(body.shop_stock);
    if (!Number.isInteger(value) || value < 0 || value > 1_000_000) {
      return NextResponse.json({ error: 'shop_stock must be an integer >= 0' }, { status: 400 });
    }

    const rows = await sql`
      WITH prev AS (
        SELECT COALESCE(shop_stock, 0) AS before_qty FROM inventory WHERE sku = ${sku}
      )
      UPDATE inventory
      SET shop_stock = ${value}
      WHERE sku = ${sku}
      RETURNING
        (SELECT before_qty FROM prev)  AS before_qty,
        COALESCE(shop_stock, 0)        AS shop_stock
    ` as Array<{ before_qty: number; shop_stock: number }>;

    if (rows.length === 0) return NextResponse.json({ error: 'SKU not found' }, { status: 404 });

    const before = rows[0].before_qty;
    await sql`
      INSERT INTO stock_adjustments (sku, delta, before_qty, after_qty, reason, adjusted_by)
      VALUES (${sku}, ${value - before}, ${before}, ${value}, ${reason ?? 'set exact'}, ${actor})
    `;

    return NextResponse.json({
      success: true,
      sku,
      shop_stock: value,
      applied: value - before,
      workbook: await syncWorkbookAfterStockChange(`set ${sku}`, actor),
    });
  }

  return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
}
