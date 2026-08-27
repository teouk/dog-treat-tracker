import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getDb } from '@/lib/db';
import { ensureSchema } from '@/lib/migrate';

/**
 * Every stock movement, newest first.
 *
 * `source` separates where a change came from: 'manual' (someone typed it),
 * 'receipt' (a pallet arrived) or 'outbound' (stock went to a channel).
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureSchema();
  const sql = getDb();

  const sp = request.nextUrl.searchParams;
  const limitRaw = parseInt(sp.get('limit') || '100', 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 500);
  const source = sp.get('source');

  const rows = source && ['manual', 'receipt', 'outbound'].includes(source)
    ? await sql`
        SELECT a.id, a.sku, a.delta, a.before_qty, a.after_qty, a.reason,
               a.adjusted_by, a.source, a.created_at,
               i.product_name, i.variant_label
        FROM stock_adjustments a
        LEFT JOIN inventory i ON i.sku = a.sku
        WHERE COALESCE(a.source, 'manual') = ${source}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${limit}
      `
    : await sql`
        SELECT a.id, a.sku, a.delta, a.before_qty, a.after_qty, a.reason,
               a.adjusted_by, a.source, a.created_at,
               i.product_name, i.variant_label
        FROM stock_adjustments a
        LEFT JOIN inventory i ON i.sku = a.sku
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${limit}
      `;

  return NextResponse.json(rows);
}
