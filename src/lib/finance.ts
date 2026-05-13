import { getDb } from '@/lib/db';

export type Sale = {
  id: string;
  channel: 'amazon' | 'shopify' | 'manual';
  external_order_id: string | null;
  sku: string;
  quantity: number;
  unit_price: number;
  total_revenue: number;
  sale_date: string;
  notes: string | null;
  created_at: string;
};

export type Purchase = {
  id: string;
  sku: string;
  quantity: number;
  unit_cost: number;
  total_cost: number;
  purchase_date: string;
  supplier: string | null;
  notes: string | null;
  created_at: string;
};

export type FinanceSummary = {
  revenue: number;
  costOfUnitsSold: number;
  purchaseSpend: number;
  profit: number;
  margin: number;
  byChannel: Record<string, { revenue: number; costOfUnitsSold: number; quantity: number }>;
  byDay: Array<{ date: string; revenue: number; costOfUnitsSold: number; profit: number }>;
};

let migrationRan = false;

export async function ensureFinanceColumns(): Promise<void> {
  if (migrationRan) return;
  const sql = getDb();

  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS amazon_price NUMERIC(10,2)`;
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS shopify_price NUMERIC(10,2)`;
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(10,2)`;

  await sql`
    CREATE TABLE IF NOT EXISTS purchases (
      id BIGSERIAL PRIMARY KEY,
      sku TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_cost NUMERIC(10,2) NOT NULL CHECK (unit_cost >= 0),
      total_cost NUMERIC(10,2) NOT NULL,
      purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
      supplier TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(purchase_date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_purchases_sku ON purchases(sku)`;

  await sql`
    CREATE TABLE IF NOT EXISTS sales (
      id BIGSERIAL PRIMARY KEY,
      channel TEXT NOT NULL CHECK (channel IN ('amazon','shopify','manual')),
      external_order_id TEXT,
      sku TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price NUMERIC(10,2) NOT NULL,
      total_revenue NUMERIC(10,2) NOT NULL,
      sale_date TIMESTAMPTZ NOT NULL,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_dedup
    ON sales(channel, external_order_id, sku)
    WHERE external_order_id IS NOT NULL
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sales_sku ON sales(sku)`;

  migrationRan = true;
}

/**
 * Find the most recent sale_date for a channel (used as the default
 * "from" date for incremental syncs). Returns ISO string or null.
 */
export async function getLastSaleDate(channel: 'amazon' | 'shopify'): Promise<string | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT MAX(sale_date) AS last FROM sales WHERE channel = ${channel}
  ` as Array<{ last: string | null }>;
  return rows[0]?.last || null;
}
