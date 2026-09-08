import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getDb } from '@/lib/db';
import { ensureSchema } from '@/lib/migrate';
import { GROUPED_INVENTORY_SQL, prettifyName, deriveVariantLabel } from '@/lib/grouping';

type Raw = {
  sku: string;
  product_name: string | null;
  fba_quantity: number;
  shop_stock: number;
  shopify_quantity: number;
  ebay_quantity: number;
  fba_inbound: number;
  on_amazon: boolean;
  on_shopify: boolean;
  on_ebay: boolean;
  last_sync_at: string | null;
  shopify_synced_at: string | null;
  ebay_synced_at: string | null;
  variant_label: string | null;
  group_key: string;
  derived_name: string | null;
  display_name: string | null;
};

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureSchema();
  const sql = getDb();
  const rows = (await sql.query(GROUPED_INVENTORY_SQL)) as Raw[];

  const items = rows.map(r => ({
    sku: r.sku,
    product_name: r.product_name,
    fba_quantity: r.fba_quantity,
    shop_stock: r.shop_stock,
    shopify_quantity: r.shopify_quantity,
    ebay_quantity: r.ebay_quantity,
    fba_inbound: r.fba_inbound,
    on_amazon: r.on_amazon,
    on_shopify: r.on_shopify,
    on_ebay: r.on_ebay,
    last_sync_at: r.last_sync_at,
    shopify_synced_at: r.shopify_synced_at,
    ebay_synced_at: r.ebay_synced_at,
    variant_label: r.variant_label || deriveVariantLabel(r.product_name, r.sku),
    group_key: r.group_key,
    // A user-set display_name is used verbatim; only derived names are cleaned up.
    group_name: r.display_name?.trim()
      ? r.display_name.trim()
      : prettifyName(r.derived_name, r.sku),
    group_name_is_override: !!r.display_name?.trim(),
  }));

  return NextResponse.json(items);
}
