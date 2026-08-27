import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getDb } from '@/lib/db';
import { ensureSchema } from '@/lib/migrate';
import { getShopifyToken, fetchShopifyIncoming, SHOPIFY_STORE, SHOPIFY_API_VERSION } from '@/lib/shopify';
import { applyShopifyIncoming } from '@/lib/outbound';

export const maxDuration = 60;

type ShopifyVariant = {
  sku: string | null;
  title: string | null;
  inventory_quantity: number | null;
  option1: string | null;
  option2: string | null;
  option3: string | null;
};
type ShopifyProduct = { id: number; title: string | null; variants: ShopifyVariant[] };

/**
 * Build a variant label from Shopify's option values, falling back to the
 * variant title. Shopify uses the literal "Default Title" for products that
 * have no real options — that's noise, not a label.
 */
function variantLabel(v: ShopifyVariant): string | null {
  const opts = [v.option1, v.option2, v.option3]
    .map(o => (o || '').trim())
    .filter(o => o && o.toLowerCase() !== 'default title');
  if (opts.length) return opts.join(' · ');

  const title = (v.title || '').trim();
  if (title && title.toLowerCase() !== 'default title') return title;
  return null;
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const token = await getShopifyToken();
  if (!token) return NextResponse.json({ error: 'Shopify not connected' }, { status: 400 });

  await ensureSchema();

  const syncTime = new Date().toISOString();
  const products: ShopifyProduct[] = [];
  let nextUrl: string | null =
    `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/products.json` +
    `?fields=id,title,variants&limit=250`;

  try {
    while (nextUrl) {
      const res: Response = await fetch(nextUrl, {
        headers: { 'X-Shopify-Access-Token': token },
      });

      if (!res.ok) {
        const text = await res.text();
        return NextResponse.json(
          { error: `Shopify API error: ${res.status}`, detail: text.substring(0, 500) },
          { status: 500 }
        );
      }

      const data = await res.json();
      if (data.products?.length) products.push(...data.products);

      const linkHeader = res.headers.get('Link') || res.headers.get('link');
      const match = linkHeader?.match(/<([^>]+)>;\s*rel="next"/);
      nextUrl = match ? match[1] : null;
    }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: 'Fetch failed', detail }, { status: 500 });
  }

  // Flatten to rows, keeping the product id and variant label. That
  // product->variant structure is Shopify's own and needs no guessing;
  // the previous version discarded it and stored only the flat SKU list.
  type Row = {
    sku: string; name: string; qty: number;
    productId: string; label: string | null;
  };
  const rows: Row[] = [];
  for (const product of products) {
    for (const variant of product.variants || []) {
      const sku = (variant.sku || '').trim();
      if (!sku) continue;
      rows.push({
        sku,
        name: product.title || '',
        qty: typeof variant.inventory_quantity === 'number' ? variant.inventory_quantity : 0,
        productId: String(product.id),
        label: variantLabel(variant),
      });
    }
  }

  const sql = getDb();
  let inserted = 0;
  const BATCH = 20;

  // Batched writes: the previous version awaited one round-trip per
  // variant, so a 300-variant catalogue meant 300 sequential queries.
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const results = (await Promise.all(slice.map(r => sql`
      INSERT INTO inventory (
        sku, product_name, shopify_quantity, on_amazon, on_shopify,
        shopify_synced_at, shopify_product_id, variant_label
      )
      VALUES (
        ${r.sku}, ${r.name}, ${r.qty}, FALSE, TRUE,
        ${syncTime}, ${r.productId}, ${r.label}
      )
      ON CONFLICT (sku) DO UPDATE SET
        shopify_quantity   = EXCLUDED.shopify_quantity,
        on_shopify         = TRUE,
        shopify_synced_at  = EXCLUDED.shopify_synced_at,
        shopify_product_id = EXCLUDED.shopify_product_id,
        variant_label      = COALESCE(EXCLUDED.variant_label, inventory.variant_label),
        product_name = CASE
          WHEN inventory.product_name IS NULL OR inventory.product_name = ''
          THEN EXCLUDED.product_name
          ELSE inventory.product_name
        END
      RETURNING (xmax = 0) AS inserted
    `))) as unknown as Array<Array<{ inserted: boolean }>>;

    for (const r of results) if (r[0]?.inserted) inserted++;
  }

  // Stock Shopify reports as incoming has left the office, so take it off
  // shop stock. No-op unless outbound deduction is enabled for Shopify.
  const incoming = await fetchShopifyIncoming(token);
  const deduction = await applyShopifyIncoming(incoming, session.user?.email || null);

  return NextResponse.json({
    success: true,
    upserted: rows.length,
    inserted,
    totalProducts: products.length,
    grouped: new Set(rows.map(r => r.productId)).size,
    incomingSkus: incoming.size,
    unitsDeducted: deduction.unitsDeducted,
    syncedAt: syncTime,
  });
}
