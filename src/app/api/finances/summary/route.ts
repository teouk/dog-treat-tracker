import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getDb } from '@/lib/db';
import { ensureFinanceColumns } from '@/lib/finance';

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureFinanceColumns();

  const sp = request.nextUrl.searchParams;
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const from = sp.get('from') || defaultFrom;
  const to = sp.get('to') || now.toISOString();

  const sql = getDb();

  const totals = await sql`
    SELECT
      COALESCE(SUM(s.total_revenue), 0)::float AS revenue,
      COALESCE(SUM(s.quantity * COALESCE(i.unit_cost, 0)), 0)::float AS cost_of_units_sold,
      COALESCE(SUM(s.quantity), 0)::int AS units_sold
    FROM sales s
    LEFT JOIN inventory i ON i.sku = s.sku
    WHERE s.sale_date >= ${from} AND s.sale_date < ${to}
  ` as Array<{ revenue: number; cost_of_units_sold: number; units_sold: number }>;

  const purchases = await sql`
    SELECT COALESCE(SUM(total_cost), 0)::float AS purchase_spend
    FROM purchases
    WHERE purchase_date >= ${from.split('T')[0]} AND purchase_date < ${to.split('T')[0]}
  ` as Array<{ purchase_spend: number }>;

  const byChannel = await sql`
    SELECT
      s.channel,
      COALESCE(SUM(s.total_revenue), 0)::float AS revenue,
      COALESCE(SUM(s.quantity * COALESCE(i.unit_cost, 0)), 0)::float AS cost_of_units_sold,
      COALESCE(SUM(s.quantity), 0)::int AS quantity
    FROM sales s
    LEFT JOIN inventory i ON i.sku = s.sku
    WHERE s.sale_date >= ${from} AND s.sale_date < ${to}
    GROUP BY s.channel
  ` as Array<{ channel: string; revenue: number; cost_of_units_sold: number; quantity: number }>;

  const byDay = await sql`
    SELECT
      to_char(date_trunc('day', s.sale_date), 'YYYY-MM-DD') AS day,
      COALESCE(SUM(s.total_revenue), 0)::float AS revenue,
      COALESCE(SUM(s.quantity * COALESCE(i.unit_cost, 0)), 0)::float AS cost_of_units_sold
    FROM sales s
    LEFT JOIN inventory i ON i.sku = s.sku
    WHERE s.sale_date >= ${from} AND s.sale_date < ${to}
    GROUP BY day
    ORDER BY day ASC
  ` as Array<{ day: string; revenue: number; cost_of_units_sold: number }>;

  const revenue = totals[0]?.revenue || 0;
  const costOfUnitsSold = totals[0]?.cost_of_units_sold || 0;
  const purchaseSpend = purchases[0]?.purchase_spend || 0;
  const profit = revenue - costOfUnitsSold;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

  return NextResponse.json({
    from,
    to,
    revenue,
    costOfUnitsSold,
    purchaseSpend,
    profit,
    margin,
    unitsSold: totals[0]?.units_sold || 0,
    byChannel: byChannel.reduce<Record<string, { revenue: number; costOfUnitsSold: number; quantity: number }>>((acc, r) => {
      acc[r.channel] = {
        revenue: r.revenue,
        costOfUnitsSold: r.cost_of_units_sold,
        quantity: r.quantity,
      };
      return acc;
    }, {}),
    byDay: byDay.map(d => ({
      date: d.day,
      revenue: d.revenue,
      costOfUnitsSold: d.cost_of_units_sold,
      profit: d.revenue - d.cost_of_units_sold,
    })),
  });
}
