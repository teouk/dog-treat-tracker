import { NextRequest, NextResponse } from 'next/server';
import { gunzipSync } from 'node:zlib';
import { auth } from '@/auth';
import { getDb } from '@/lib/db';
import { ensureSchema } from '@/lib/migrate';
import {
  getAccessToken, spFetch, fetchFbaQuantities, fetchParentAsins,
  fetchInboundShipments, UK_MARKETPLACE_ID,
} from '@/lib/amazon';
import { deriveVariantLabel } from '@/lib/grouping';
import { applyAmazonInbound } from '@/lib/outbound';

export const maxDuration = 60;

/** Leave headroom inside Vercel's 60s ceiling to finish writes and respond. */
const BUDGET_MS = 45_000;
const FBA_CHUNK = 200;
const CATALOG_CHUNK = 100;

type Stage = 'report' | 'listings' | 'fba' | 'catalog' | 'inbound' | 'done';

type Counters = {
  listings: number;
  fbaUpdated: number;
  variationFamilies: number;
  inboundLines: number;
  inboundClaimed: number;
  unitsDeducted: number;
  failedBatches: number;
};

type SyncState = {
  stage: Stage;
  reportId?: string;
  documentId?: string;
  offset: number;
  counters: Counters;
};

const EMPTY: Counters = {
  listings: 0, fbaUpdated: 0, variationFamilies: 0,
  inboundLines: 0, inboundClaimed: 0, unitsDeducted: 0, failedBatches: 0,
};

function encode(state: SyncState): string {
  return Buffer.from(JSON.stringify(state)).toString('base64url');
}

function decode(token: string | null): SyncState {
  if (!token) return { stage: 'report', offset: 0, counters: { ...EMPTY } };
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf-8'));
    return {
      stage: parsed.stage ?? 'report',
      reportId: parsed.reportId,
      documentId: parsed.documentId,
      offset: Number(parsed.offset) || 0,
      counters: { ...EMPTY, ...(parsed.counters || {}) },
    };
  } catch {
    return { stage: 'report', offset: 0, counters: { ...EMPTY } };
  }
}

/**
 * Comprehensive Amazon refresh.
 *
 * Runs every source Amazon exposes rather than just FBA stock levels:
 *   report   — request the full merchant listings report
 *   listings — SKU list, status, fulfilment channel, ASIN, FBM quantity
 *   fba      — per-SKU fulfillable / inbound / reserved / unfulfillable
 *   catalog  — parent ASINs, which drive variation grouping
 *   inbound  — FBA shipments in transit, deducted from shop stock
 *
 * Completeness is prioritised over speed, which means the work does not fit
 * in one serverless invocation. Each call runs until its time budget is
 * spent and returns an opaque token; the client calls back with that token
 * until `done` is true. No state is held in memory between calls, so a
 * dropped request costs one step, not the whole sync.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const started = Date.now();
  const outOfTime = () => Date.now() - started > BUDGET_MS;
  const state = decode(request.nextUrl.searchParams.get('token'));
  const actor = session.user?.email || null;

  try {
    await ensureSchema();
    const sql = getDb();
    const token = await getAccessToken();

    // --- 1. Request the listings report, then poll until Amazon builds it.
    if (state.stage === 'report') {
      if (!state.reportId) {
        const res = await spFetch('/reports/2021-06-30/reports', token, {
          method: 'POST',
          body: JSON.stringify({
            reportType: 'GET_MERCHANT_LISTINGS_ALL_DATA',
            marketplaceIds: [UK_MARKETPLACE_ID],
          }),
        });
        const data = await res.json();
        if (!data.reportId) {
          return NextResponse.json({ error: 'Failed to request report', detail: data }, { status: 500 });
        }
        state.reportId = data.reportId;
      }

      while (!outOfTime()) {
        await new Promise(r => setTimeout(r, 2000));
        const res = await spFetch(`/reports/2021-06-30/reports/${state.reportId}`, token);
        const data = await res.json();

        if (data.processingStatus === 'DONE') {
          state.documentId = data.reportDocumentId;
          state.stage = 'listings';
          break;
        }
        if (data.processingStatus === 'FATAL' || data.processingStatus === 'CANCELLED') {
          return NextResponse.json({ error: `Report ${data.processingStatus}` }, { status: 500 });
        }
      }

      return NextResponse.json({
        done: false,
        token: encode(state),
        stage: state.stage,
        progress: state.stage === 'listings'
          ? 'Report ready — importing listings'
          : 'Amazon is preparing the listings report',
        counters: state.counters,
      });
    }

    // --- 2. Download the report and upsert every active listing.
    if (state.stage === 'listings') {
      if (!state.documentId) {
        state.stage = 'report';
        return NextResponse.json({ done: false, token: encode(state), stage: 'report', progress: 'Restarting report', counters: state.counters });
      }

      const docRes = await spFetch(`/reports/2021-06-30/documents/${state.documentId}`, token);
      const docData = await docRes.json();
      const fileRes = await fetch(docData.url);

      let text: string;
      if (docData.compressionAlgorithm === 'GZIP') {
        text = gunzipSync(Buffer.from(await fileRes.arrayBuffer())).toString('utf-8');
      } else {
        text = await fileRes.text();
      }

      const lines = text.replace(/\r/g, '').split('\n');
      const headers = lines[0].split('\t').map(h => h.replace(/^﻿/, ''));
      const idx = (name: string) => headers.indexOf(name);
      const skuIdx = idx('seller-sku');
      const nameIdx = idx('item-name');
      const statusIdx = idx('status');
      const channelIdx = idx('fulfillment-channel');
      const qtyIdx = idx('quantity');
      const asinIdx = idx('asin1');

      type Row = { sku: string; name: string; channel: string; qty: number; asin: string; status: string };
      const rows: Row[] = [];
      for (const line of lines.slice(1)) {
        if (!line.trim()) continue;
        const cols = line.split('\t');
        const sku = (cols[skuIdx] || '').trim();
        const status = (cols[statusIdx] || '').trim();
        if (!sku) continue;
        if (status === 'Inactive' || status === 'Closed' || status === 'Deleted') continue;
        rows.push({
          sku,
          name: (cols[nameIdx] || '').trim(),
          channel: (cols[channelIdx] || '').trim(),
          qty: parseInt(cols[qtyIdx] || '0', 10) || 0,
          asin: asinIdx >= 0 ? (cols[asinIdx] || '').trim() : '',
          status,
        });
      }

      const syncTime = new Date().toISOString();
      const BATCH = 20;
      for (let i = 0; i < rows.length; i += BATCH) {
        const slice = rows.slice(i, i + BATCH);
        await Promise.all(slice.map(r => sql`
          INSERT INTO inventory (
            sku, product_name, fbm_quantity, last_sync_at, on_amazon,
            fulfillment_channel, asin, amazon_status, variant_label
          )
          VALUES (
            ${r.sku}, ${r.name}, ${r.channel === 'DEFAULT' ? r.qty : 0}, ${syncTime}, TRUE,
            ${r.channel}, ${r.asin || null}, ${r.status}, ${deriveVariantLabel(r.name, r.sku)}
          )
          ON CONFLICT (sku) DO UPDATE SET
            product_name = CASE
              WHEN EXCLUDED.product_name IS NULL OR EXCLUDED.product_name = ''
              THEN inventory.product_name ELSE EXCLUDED.product_name END,
            fbm_quantity        = EXCLUDED.fbm_quantity,
            last_sync_at        = EXCLUDED.last_sync_at,
            on_amazon           = TRUE,
            fulfillment_channel = EXCLUDED.fulfillment_channel,
            asin                = COALESCE(EXCLUDED.asin, inventory.asin),
            amazon_status       = EXCLUDED.amazon_status,
            variant_label = CASE
              WHEN inventory.shopify_product_id IS NOT NULL THEN inventory.variant_label
              ELSE COALESCE(EXCLUDED.variant_label, inventory.variant_label) END
        `));
      }

      state.counters.listings = rows.length;
      state.stage = 'fba';
      state.offset = 0;
      return NextResponse.json({
        done: false, token: encode(state), stage: 'fba',
        progress: `Imported ${rows.length} listings — reading FBA stock`,
        counters: state.counters,
      });
    }

    // --- 3. Per-SKU FBA detail, in resumable chunks.
    if (state.stage === 'fba') {
      const all = await sql`
        SELECT sku FROM inventory
        WHERE on_amazon = TRUE
          AND (fulfillment_channel IS NULL OR fulfillment_channel LIKE 'AMAZON_%')
        ORDER BY sku
      ` as Array<{ sku: string }>;

      const slice = all.slice(state.offset, state.offset + FBA_CHUNK);
      if (slice.length > 0) {
        const { map, failedBatches } = await fetchFbaQuantities(slice.map(r => r.sku), token);
        state.counters.failedBatches += failedBatches;

        const syncTime = new Date().toISOString();
        const entries = Array.from(map.entries());
        const DB = 20;
        for (let i = 0; i < entries.length; i += DB) {
          const part = entries.slice(i, i + DB);
          await Promise.all(part.map(([skuUpper, d]) => sql`
            UPDATE inventory SET
              fba_quantity      = ${d.qty},
              fba_fulfillable   = ${d.fulfillable},
              fba_inbound       = ${d.inbound},
              fba_reserved      = ${d.reserved},
              fba_unfulfillable = ${d.unfulfillable},
              asin              = COALESCE(NULLIF(${d.asin}, ''), inventory.asin),
              product_name = CASE
                WHEN (inventory.product_name IS NULL OR inventory.product_name = '') AND ${d.name} != ''
                THEN ${d.name} ELSE inventory.product_name END,
              last_sync_at = ${syncTime}
            WHERE UPPER(sku) = ${skuUpper}
          `));
        }
        state.counters.fbaUpdated += map.size;
      }

      state.offset += slice.length;
      const remaining = all.length - state.offset;
      if (remaining <= 0) {
        state.stage = 'catalog';
        state.offset = 0;
      }

      return NextResponse.json({
        done: false, token: encode(state), stage: state.stage,
        progress: remaining > 0
          ? `FBA stock: ${state.offset} of ${all.length} SKUs`
          : 'FBA stock done — resolving variation families',
        counters: state.counters,
      });
    }

    // --- 4. Parent ASINs, which is what groups variants together.
    if (state.stage === 'catalog') {
      const all = await sql`
        SELECT DISTINCT asin FROM inventory
        WHERE asin IS NOT NULL AND asin <> ''
        ORDER BY asin
      ` as Array<{ asin: string }>;

      const slice = all.slice(state.offset, state.offset + CATALOG_CHUNK);
      if (slice.length > 0) {
        const parents = await fetchParentAsins(slice.map(r => r.asin), token);
        const entries = Array.from(parents.entries());
        const DB = 20;
        for (let i = 0; i < entries.length; i += DB) {
          const part = entries.slice(i, i + DB);
          await Promise.all(part.map(([asin, parent]) => sql`
            UPDATE inventory SET parent_asin = ${parent} WHERE asin = ${asin}
          `));
        }
        state.counters.variationFamilies += new Set(parents.values()).size;
      }

      state.offset += slice.length;
      const remaining = all.length - state.offset;
      if (remaining <= 0) {
        state.stage = 'inbound';
        state.offset = 0;
      }

      return NextResponse.json({
        done: false, token: encode(state), stage: state.stage,
        progress: remaining > 0
          ? `Variation families: ${state.offset} of ${all.length} ASINs`
          : 'Checking stock in transit to Amazon',
        counters: state.counters,
      });
    }

    // --- 5. Stock already on its way to Amazon comes off shop stock.
    if (state.stage === 'inbound') {
      const lines = await fetchInboundShipments(token);
      const deduction = await applyAmazonInbound(lines, actor);

      state.counters.inboundLines = lines.length;
      state.counters.inboundClaimed = deduction.linesClaimed;
      state.counters.unitsDeducted = deduction.unitsDeducted;
      state.stage = 'done';

      await sql`UPDATE inventory SET amazon_last_full_sync_at = NOW() WHERE on_amazon = TRUE`;

      return NextResponse.json({
        done: true,
        stage: 'done',
        progress: 'Comprehensive sync complete',
        counters: state.counters,
        skippedUnknownSkus: deduction.skippedUnknownSkus,
        elapsedMs: Date.now() - started,
      });
    }

    return NextResponse.json({ done: true, stage: 'done', counters: state.counters });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, stage: state.stage }, { status: 500 });
  }
}
