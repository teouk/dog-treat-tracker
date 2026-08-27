import { getDb } from '@/lib/db';

export const SHOPIFY_STORE = process.env.SHOPIFY_STORE || '';
export const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '';
export const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
export const SHOPIFY_SCOPES = 'read_inventory,read_products';
export const SHOPIFY_API_VERSION = '2024-10';

export async function getShopifyToken(): Promise<string | null> {
  try {
    const sql = getDb();
    const rows = await sql`SELECT value FROM settings WHERE key = 'shopify_access_token'` as Array<{ value: string }>;
    return rows[0]?.value || null;
  } catch {
    return null;
  }
}

export async function saveShopifyToken(token: string, scope: string = ''): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO settings (key, value) VALUES ('shopify_access_token', ${token})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
  await sql`
    INSERT INTO settings (key, value) VALUES ('shopify_scope', ${scope})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
}

export async function getShopifyScope(): Promise<string | null> {
  try {
    const sql = getDb();
    const rows = await sql`SELECT value FROM settings WHERE key = 'shopify_scope'` as Array<{ value: string }>;
    return rows[0]?.value || null;
  } catch {
    return null;
  }
}

export async function clearShopifyToken(): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM settings WHERE key IN ('shopify_access_token', 'shopify_scope')`;
}

/**
 * Per-SKU "incoming" inventory — stock Shopify knows is on its way to a
 * location but has not yet made available.
 *
 * Only the GraphQL Admin API exposes this; the REST inventory_levels
 * endpoint reports `available` and nothing else. Returns an empty map on
 * any failure so a missing scope or an older API version degrades to "no
 * deductions" rather than breaking the stock sync.
 */
export async function fetchShopifyIncoming(token: string): Promise<Map<string, number>> {
  const incoming = new Map<string, number>();

  const query = `
    query IncomingInventory($cursor: String) {
      inventoryItems(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          sku
          inventoryLevels(first: 10) {
            nodes { quantities(names: ["incoming"]) { name quantity } }
          }
        }
      }
    }
  `;

  let cursor: string | null = null;
  let guard = 0;

  try {
    do {
      guard++;
      const res: Response = await fetch(
        `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query, variables: { cursor } }),
        }
      );

      if (!res.ok) {
        console.error(`[shopify] incoming inventory ${res.status}`);
        return new Map();
      }

      const body = await res.json();
      if (body.errors) {
        console.error('[shopify] incoming inventory GraphQL errors:', JSON.stringify(body.errors).slice(0, 300));
        return new Map();
      }

      const conn = body.data?.inventoryItems;
      for (const node of conn?.nodes || []) {
        const sku = (node?.sku || '').trim();
        if (!sku) continue;

        let total = 0;
        for (const level of node.inventoryLevels?.nodes || []) {
          for (const q of level?.quantities || []) {
            if (q?.name === 'incoming' && typeof q.quantity === 'number') total += q.quantity;
          }
        }
        if (total > 0) incoming.set(sku, (incoming.get(sku) || 0) + total);
      }

      cursor = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (cursor && guard < 50);
  } catch (e) {
    console.error('[shopify] incoming inventory failed:', e);
    return new Map();
  }

  return incoming;
}
