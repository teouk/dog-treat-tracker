import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getDb } from '@/lib/db';
import {
  getShopifyToken,
  SHOPIFY_STORE,
  SHOPIFY_API_VERSION,
  ensureChannelColumns,
} from '@/lib/shopify';

export const maxDuration = 60;

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const token = await getShopifyToken();
  if (!token) return NextResponse.json({ error: 'Shopify not connected' }, { status: 400 });

  await ensureChannelColumns();

  const syncTime = new Date().toISOString();
  const products: any[] = [];
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
  } catch (e: any) {
    return NextResponse.json({ error: 'Fetch failed', detail: e.message }, { status: 500 });
  }

  const sql = getDb();
  let upserted = 0;
  let inserted = 0;

  for (const product of products) {
    const productName = product.title || '';
    for (const variant of product.variants || []) {
      const rawSku = (variant.sku || '').trim();
      if (!rawSku) continue;

      const qty = typeof variant.inventory_quantity === 'number' ? variant.inventory_quantity : 0;

      const result = await sql`
        INSERT INTO inventory (sku, product_name, shopify_quantity, on_amazon, on_shopify, shopify_synced_at)
        VALUES (${rawSku}, ${productName}, ${qty}, FALSE, TRUE, ${syncTime})
        ON CONFLICT (sku) DO UPDATE SET
          shopify_quantity = EXCLUDED.shopify_quantity,
          on_shopify = TRUE,
          shopify_synced_at = EXCLUDED.shopify_synced_at,
          product_name = CASE
            WHEN inventory.product_name IS NULL OR inventory.product_name = ''
            THEN EXCLUDED.product_name
            ELSE inventory.product_name
          END
        RETURNING (xmax = 0) AS inserted
      ` as Array<{ inserted: boolean }>;

      upserted++;
      if (result[0]?.inserted) inserted++;
    }
  }

  return NextResponse.json({
    success: true,
    upserted,
    inserted,
    totalProducts: products.length,
    syncedAt: syncTime,
  });
}
