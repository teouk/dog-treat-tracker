import { getDb } from '@/lib/db';
import { ensureSchema } from '@/lib/migrate';
import type { InboundLine } from '@/lib/amazon';

export type DeductionResult = {
  channel: 'amazon' | 'shopify';
  linesSeen: number;
  linesClaimed: number;
  unitsDeducted: number;
  skippedUnknownSkus: string[];
};

/**
 * Outbound deduction is opt-in per channel.
 *
 * Amazon defaults on: an FBA inbound shipment unambiguously means stock has
 * left the office. Shopify defaults off because a Shopify location is often
 * the same physical shelf as "shop stock", and deducting there would
 * double-count the same units. See docs/outbound-deductions.md.
 */
const DEFAULTS: Record<'amazon' | 'shopify', boolean> = {
  amazon: true,
  shopify: false,
};

export async function isDeductionEnabled(channel: 'amazon' | 'shopify'): Promise<boolean> {
  const sql = getDb();
  const rows = await sql`
    SELECT value FROM settings WHERE key = ${`deduct_outbound_${channel}`}
  ` as Array<{ value: string }>;
  if (rows.length === 0) return DEFAULTS[channel];
  return rows[0].value === 'true';
}

export async function setDeductionEnabled(
  channel: 'amazon' | 'shopify',
  enabled: boolean
): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO settings (key, value)
    VALUES (${`deduct_outbound_${channel}`}, ${enabled ? 'true' : 'false'})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
}

/**
 * Record an outbound shipment line and take its quantity off shop stock.
 *
 * The whole thing is one statement so it is atomic, and the INSERT ...
 * ON CONFLICT DO NOTHING is what makes it idempotent: `claim` yields a row
 * only the first time this (channel, external_id, sku) is seen, and every
 * later clause is gated on that. Re-running a sync therefore deducts once,
 * no matter how many times Amazon keeps reporting the same shipment.
 *
 * `prev` reads shop_stock from the same snapshot as the UPDATE, so before/
 * after are captured without a separate round trip. The deducted figure is
 * computed in the INSERT rather than written back afterwards: a CTE cannot
 * see rows another CTE inserted in the same statement, so an UPDATE aimed at
 * the just-inserted row matches nothing and silently records zero.
 */
async function claimAndDeduct(
  channel: 'amazon' | 'shopify',
  externalId: string,
  sku: string,
  quantity: number,
  status: string,
  reason: string,
  actor: string | null
): Promise<{ claimed: boolean; deducted: number; skuKnown: boolean }> {
  const sql = getDb();

  const rows = await sql`
    WITH prev AS (
      SELECT COALESCE(shop_stock, 0) AS before_qty
      FROM inventory WHERE sku = ${sku}
    ),
    claim AS (
      INSERT INTO outbound_shipments (channel, external_id, sku, quantity, status, deducted)
      SELECT ${channel}, ${externalId}, ${sku}, ${quantity}, ${status},
             COALESCE((SELECT LEAST(${quantity}, before_qty) FROM prev), 0)
      ON CONFLICT (channel, external_id, sku) DO NOTHING
      RETURNING id
    ),
    upd AS (
      UPDATE inventory
      SET shop_stock = GREATEST(0, COALESCE(shop_stock, 0) - ${quantity})
      WHERE sku = ${sku} AND (SELECT count(*) FROM claim) = 1
      RETURNING COALESCE(shop_stock, 0) AS after_qty
    ),
    logged AS (
      INSERT INTO stock_adjustments
        (sku, delta, before_qty, after_qty, reason, adjusted_by, source)
      SELECT ${sku}, u.after_qty - p.before_qty, p.before_qty, u.after_qty,
             ${reason}, ${actor}, 'outbound'
      FROM upd u CROSS JOIN prev p
      WHERE u.after_qty <> p.before_qty
      RETURNING 1
    )
    SELECT
      (SELECT count(*) FROM claim)::int AS claimed,
      (SELECT count(*) FROM prev)::int  AS sku_known,
      COALESCE((SELECT p.before_qty - u.after_qty FROM upd u CROSS JOIN prev p), 0)::int AS deducted
  ` as Array<{ claimed: number; sku_known: number; deducted: number }>;

  const row = rows[0];
  return {
    claimed: (row?.claimed || 0) > 0,
    deducted: row?.deducted || 0,
    skuKnown: (row?.sku_known || 0) > 0,
  };
}

/**
 * Apply Amazon FBA inbound shipments to shop stock.
 *
 * Keyed on the Amazon shipment id, so each shipment line deducts exactly
 * once however often the sync runs.
 */
export async function applyAmazonInbound(
  lines: InboundLine[],
  actor: string | null
): Promise<DeductionResult> {
  await ensureSchema();

  const result: DeductionResult = {
    channel: 'amazon',
    linesSeen: lines.length,
    linesClaimed: 0,
    unitsDeducted: 0,
    skippedUnknownSkus: [],
  };

  if (!(await isDeductionEnabled('amazon'))) return result;

  const CHUNK = 10;
  for (let i = 0; i < lines.length; i += CHUNK) {
    const chunk = lines.slice(i, i + CHUNK);
    const outcomes = await Promise.all(
      chunk.map(line =>
        claimAndDeduct(
          'amazon',
          line.shipmentId,
          line.sku,
          line.quantityShipped,
          line.status,
          `FBA shipment ${line.shipmentName || line.shipmentId}`,
          actor
        ).then(r => ({ r, line }))
      )
    );

    for (const { r, line } of outcomes) {
      if (!r.skuKnown) {
        if (!result.skippedUnknownSkus.includes(line.sku)) {
          result.skippedUnknownSkus.push(line.sku);
        }
        continue;
      }
      if (r.claimed) {
        result.linesClaimed++;
        result.unitsDeducted += r.deducted;
      }
    }
  }

  return result;
}

/**
 * Apply Shopify "incoming" inventory to shop stock.
 *
 * Shopify reports a running incoming total per SKU rather than discrete
 * shipments, so there is no id to key on. Instead we keep a per-SKU
 * watermark and deduct only the increase since the last observation — a
 * total that stays flat, or falls as stock is received, deducts nothing.
 */
export async function applyShopifyIncoming(
  incoming: Map<string, number>,
  actor: string | null
): Promise<DeductionResult> {
  await ensureSchema();

  const result: DeductionResult = {
    channel: 'shopify',
    linesSeen: incoming.size,
    linesClaimed: 0,
    unitsDeducted: 0,
    skippedUnknownSkus: [],
  };

  if (!(await isDeductionEnabled('shopify'))) return result;

  const sql = getDb();
  const entries = Array.from(incoming.entries());
  const CHUNK = 10;

  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);

    const outcomes = await Promise.all(chunk.map(async ([sku, total]) => {
      const rows = await sql`
        WITH prev_state AS (
          SELECT COALESCE(
            (SELECT last_incoming FROM channel_incoming_state
              WHERE channel = 'shopify' AND sku = ${sku}), 0
          ) AS last_incoming
        ),
        d AS (
          SELECT GREATEST(0, ${total} - (SELECT last_incoming FROM prev_state)) AS qty
        ),
        prev AS (
          SELECT COALESCE(shop_stock, 0) AS before_qty FROM inventory WHERE sku = ${sku}
        ),
        upd AS (
          UPDATE inventory
          SET shop_stock = GREATEST(0, COALESCE(shop_stock, 0) - (SELECT qty FROM d))
          WHERE sku = ${sku} AND (SELECT qty FROM d) > 0
          RETURNING COALESCE(shop_stock, 0) AS after_qty
        ),
        logged AS (
          INSERT INTO stock_adjustments
            (sku, delta, before_qty, after_qty, reason, adjusted_by, source)
          SELECT ${sku}, u.after_qty - p.before_qty, p.before_qty, u.after_qty,
                 'Shopify incoming stock', ${actor}, 'outbound'
          FROM upd u CROSS JOIN prev p
          WHERE u.after_qty <> p.before_qty
          RETURNING 1
        ),
        watermark AS (
          INSERT INTO channel_incoming_state (channel, sku, last_incoming, updated_at)
          VALUES ('shopify', ${sku}, ${total}, NOW())
          ON CONFLICT (channel, sku)
          DO UPDATE SET last_incoming = EXCLUDED.last_incoming, updated_at = NOW()
          WHERE (SELECT count(*) FROM prev) = 1
          RETURNING 1
        )
        SELECT
          (SELECT count(*) FROM prev)::int AS sku_known,
          COALESCE((SELECT p.before_qty - u.after_qty FROM upd u CROSS JOIN prev p), 0)::int AS deducted
      ` as Array<{ sku_known: number; deducted: number }>;

      return { sku, row: rows[0] };
    }));

    for (const { sku, row } of outcomes) {
      if (!row || row.sku_known === 0) {
        if (!result.skippedUnknownSkus.includes(sku)) result.skippedUnknownSkus.push(sku);
        continue;
      }
      if (row.deducted > 0) {
        result.linesClaimed++;
        result.unitsDeducted += row.deducted;
      }
    }
  }

  return result;
}
