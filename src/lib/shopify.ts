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
