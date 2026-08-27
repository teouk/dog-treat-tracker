import { getDb } from '@/lib/db';

let migrationRan = false;

/**
 * Idempotent schema migration for inventory, product grouping and the
 * manual-adjustment audit trail.
 *
 * Guarded by a module-level flag so a warm serverless instance runs the
 * DDL once rather than on every request — the previous
 * `ensureChannelColumns` helper re-issued four ALTER TABLEs per sync.
 */
export async function ensureSchema(): Promise<void> {
  if (migrationRan) return;
  const sql = getDb();

  // --- base tables ---
  // Previously assumed to exist, so a deploy against an empty database
  // failed on the first ALTER TABLE.
  await sql`
    CREATE TABLE IF NOT EXISTS inventory (
      sku              TEXT PRIMARY KEY,
      product_name     TEXT,
      fba_quantity     INTEGER DEFAULT 0,
      fbm_quantity     INTEGER DEFAULT 0,
      shop_stock       INTEGER DEFAULT 0,
      shopify_quantity INTEGER DEFAULT 0,
      last_sync_at     TIMESTAMPTZ
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `;

  // --- channel membership (previously ensureChannelColumns) ---
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS on_amazon BOOLEAN DEFAULT TRUE`;
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS on_shopify BOOLEAN DEFAULT FALSE`;
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS shopify_synced_at TIMESTAMPTZ`;
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS fulfillment_channel TEXT`;

  // --- variant grouping ---
  // asin/parent_asin come from Amazon; parent_asin is the variation family.
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS asin TEXT`;
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS parent_asin TEXT`;
  // Shopify's own product->variant structure, captured verbatim.
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS shopify_product_id TEXT`;
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS variant_label TEXT`;
  // Manual override — wins over both of the above, and is the only way to
  // merge an Amazon family with a Shopify product (their IDs never match).
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS group_override TEXT`;

  await sql`CREATE INDEX IF NOT EXISTS idx_inventory_parent_asin ON inventory(parent_asin)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_inventory_shopify_product ON inventory(shopify_product_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS product_groups (
      group_key    TEXT PRIMARY KEY,
      display_name TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // --- manual stock adjustment audit trail ---
  await sql`
    CREATE TABLE IF NOT EXISTS stock_adjustments (
      id          BIGSERIAL PRIMARY KEY,
      sku         TEXT NOT NULL,
      delta       INTEGER NOT NULL,
      before_qty  INTEGER NOT NULL,
      after_qty   INTEGER NOT NULL,
      reason      TEXT,
      adjusted_by TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_stock_adj_sku_time ON stock_adjustments(sku, created_at DESC)`;

  migrationRan = true;
}
