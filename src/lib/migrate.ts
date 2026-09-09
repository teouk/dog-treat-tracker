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

  // --- eBay channel ---
  // Mirrors the Shopify columns. Like Shopify, an eBay quantity is a
  // shop-front figure for stock fulfilled out of the same physical shop
  // stock, so it is displayed but never added into a stock total.
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS ebay_quantity INTEGER DEFAULT 0`;
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS on_ebay BOOLEAN DEFAULT FALSE`;
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS ebay_synced_at TIMESTAMPTZ`;
  // How many separate eBay listings carry this SKU. Above one, the quantity
  // is a sum across listings that eBay treats as independent stock pools, so
  // it can sell all of them — an overselling exposure worth showing.
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS ebay_listing_count INTEGER DEFAULT 0`;

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

  // --- Amazon detail breakdown ---
  // fba_quantity stays the headline total; these record what makes it up,
  // so a comprehensive sync can be audited rather than just trusted.
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS fba_fulfillable INTEGER DEFAULT 0`;
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS fba_inbound INTEGER DEFAULT 0`;
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS fba_reserved INTEGER DEFAULT 0`;
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS fba_unfulfillable INTEGER DEFAULT 0`;
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS amazon_status TEXT`;
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS amazon_last_full_sync_at TIMESTAMPTZ`;

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

  // stock_adjustments predates the receipt and outbound features; label
  // where each row came from so the history view can separate them.
  await sql`ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual'`;

  // --- inbound pallet deliveries ---
  // Append-only: there are no update or delete paths for these two tables.
  await sql`
    CREATE TABLE IF NOT EXISTS bulk_receipts (
      id          BIGSERIAL PRIMARY KEY,
      reference   TEXT,
      supplier    TEXT,
      note        TEXT,
      received_by TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS bulk_receipt_items (
      id         BIGSERIAL PRIMARY KEY,
      receipt_id BIGINT  NOT NULL REFERENCES bulk_receipts(id) ON DELETE RESTRICT,
      sku        TEXT    NOT NULL,
      quantity   INTEGER NOT NULL CHECK (quantity > 0),
      before_qty INTEGER NOT NULL,
      after_qty  INTEGER NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_receipt_items_receipt ON bulk_receipt_items(receipt_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_receipt_items_sku ON bulk_receipt_items(sku)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_bulk_receipts_created ON bulk_receipts(created_at DESC)`;

  // --- outbound stock in transit to a channel's warehouse ---
  // The UNIQUE key is what makes deduction idempotent: re-syncing a shipment
  // we have already seen conflicts and is skipped, so stock is never
  // deducted twice for the same shipment line.
  await sql`
    CREATE TABLE IF NOT EXISTS outbound_shipments (
      id           BIGSERIAL PRIMARY KEY,
      channel      TEXT NOT NULL CHECK (channel IN ('amazon','shopify')),
      external_id  TEXT NOT NULL,
      sku          TEXT NOT NULL,
      quantity     INTEGER NOT NULL,
      deducted     INTEGER NOT NULL DEFAULT 0,
      status       TEXT,
      detected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (channel, external_id, sku)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_outbound_detected ON outbound_shipments(detected_at DESC)`;

  // Level-based APIs report a running "incoming" total rather than discrete
  // shipments, so we deduct only the increase since the last observation.
  await sql`
    CREATE TABLE IF NOT EXISTS channel_incoming_state (
      channel       TEXT NOT NULL,
      sku           TEXT NOT NULL,
      last_incoming INTEGER NOT NULL DEFAULT 0,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (channel, sku)
    )
  `;

  migrationRan = true;
}
