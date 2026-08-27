import { getDb } from '@/lib/db';
import { ensureSchema } from '@/lib/migrate';
import { getAccessToken, fetchFbaQuantities } from '@/lib/amazon';

export type FastSyncResult = {
  success: true;
  mode: 'fast';
  totalFbaSkusInDb: number;
  fbaReturnedByApi: number;
  updated: number;
  failedBatches: number;
  elapsedMs: number;
};

export class NoSkusError extends Error {
  constructor() {
    super('No FBA SKUs in database. Run a Full Refresh first.');
    this.name = 'NoSkusError';
  }
}

/**
 * Refresh FBA quantities for SKUs we already know about.
 *
 * Shared by the user-triggered /api/sync/fast and the nightly cron at
 * /api/sync, which previously ran a different, single-page implementation
 * that read `fulfillableQuantity` instead of `totalQuantity` — so the cron
 * and the button disagreed about what "in stock" meant.
 *
 * Only SKUs the API actually returned are written, so a transient miss
 * leaves existing stock alone rather than zeroing it.
 */
export async function runFastSync(): Promise<FastSyncResult> {
  const startTime = Date.now();
  await ensureSchema();
  const sql = getDb();

  const rows = await sql`
    SELECT sku FROM inventory
    WHERE on_amazon = TRUE
      AND (fulfillment_channel IS NULL OR fulfillment_channel LIKE 'AMAZON_%')
  ` as Array<{ sku: string }>;

  if (rows.length === 0) throw new NoSkusError();

  const allSkus = rows.map(r => r.sku);
  const token = await getAccessToken();
  const syncTime = new Date().toISOString();

  const { map: aggregate, failedBatches } = await fetchFbaQuantities(allSkus, token);

  const entries = Array.from(aggregate.entries());
  let updated = 0;
  const DB_BATCH = 20;

  for (let i = 0; i < entries.length; i += DB_BATCH) {
    const slice = entries.slice(i, i + DB_BATCH);
    await Promise.all(slice.map(([skuUpper, data]) => sql`
      UPDATE inventory SET
        fba_quantity = ${data.qty},
        product_name = CASE
          WHEN (inventory.product_name IS NULL OR inventory.product_name = '') AND ${data.name} != ''
          THEN ${data.name}
          ELSE inventory.product_name
        END,
        last_sync_at = ${syncTime}
      WHERE UPPER(sku) = ${skuUpper}
    `));
    updated += slice.length;
  }

  return {
    success: true,
    mode: 'fast',
    totalFbaSkusInDb: allSkus.length,
    fbaReturnedByApi: aggregate.size,
    updated,
    failedBatches,
    elapsedMs: Date.now() - startTime,
  };
}
