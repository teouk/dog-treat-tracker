import { getDb } from '@/lib/db';

export const SHOPIFY_STORE = process.env.SHOPIFY_STORE || '';
export const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '';
export const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
export const SHOPIFY_SCOPES = 'read_inventory,read_products,read_orders';
export const SHOPIFY_API_VERSION = '2024-10';

export type ShopifyLineItem = {
  sku: string | null;
  quantity: number;
  price: string;
};
export type ShopifyOrder = {
  id: number;
  created_at: string;
  line_items: ShopifyLineItem[];
};

export class ShopifyForbiddenError extends Error {
  constructor(message = 'Shopify returned 403 — re-authorize to grant new scopes') {
    super(message);
    this.name = 'ShopifyForbiddenError';
  }
}

/**
 * Page through Shopify orders for a date range. Throws ShopifyForbiddenError
 * on 403 so the caller can prompt the user to reconnect.
 */
export async function fetchShopifyOrders(
  token: string,
  fromIso: string,
  toIso: string
): Promise<ShopifyOrder[]> {
  const orders: ShopifyOrder[] = [];
  let nextUrl: string | null =
    `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders.json` +
    `?status=any&financial_status=paid&limit=250` +
    `&fields=id,created_at,line_items` +
    `&created_at_min=${encodeURIComponent(fromIso)}` +
    `&created_at_max=${encodeURIComponent(toIso)}`;

  while (nextUrl) {
    const res: Response = await fetch(nextUrl, {
      headers: { 'X-Shopify-Access-Token': token },
    });

    if (res.status === 403) throw new ShopifyForbiddenError();
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify orders API ${res.status}: ${body.substring(0, 200)}`);
    }

    const data = await res.json();
    if (Array.isArray(data.orders)) orders.push(...data.orders);

    const linkHeader = res.headers.get('Link') || res.headers.get('link');
    const match = linkHeader?.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = match ? match[1] : null;
  }

  return orders;
}

export async function getShopifyToken(): Promise<string | null> {
  try {
    const sql = getDb();
    const rows = await sql`SELECT value FROM settings WHERE key = 'shopify_access_token'` as Array<{ value: string }>;
    return rows[0]?.value || null;
  } catch {
    return null;
  }
}

export async function saveShopifyToken(token: string): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO settings (key, value) VALUES ('shopify_access_token', ${token})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
}

export async function clearShopifyToken(): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM settings WHERE key = 'shopify_access_token'`;
}

export async function ensureChannelColumns(): Promise<void> {
  const sql = getDb();
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS on_amazon BOOLEAN DEFAULT TRUE`;
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS on_shopify BOOLEAN DEFAULT FALSE`;
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS shopify_synced_at TIMESTAMPTZ`;
  await sql`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS fulfillment_channel TEXT`;
}
