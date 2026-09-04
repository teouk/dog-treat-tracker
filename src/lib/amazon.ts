import axios from 'axios';

export const SP_API_ENDPOINT = 'https://sellingpartnerapi-eu.amazon.com';
export const UK_MARKETPLACE_ID = 'A1F83G8C2ARO7P';

/** FBA inventory allows 50 sellerSkus per request at ~2 req/sec. */
const FBA_BATCH_SIZE = 50;
const FBA_THROTTLE_MS = 600;
/** Catalog Items allows 20 identifiers per request at ~2 req/sec. */
const CATALOG_BATCH_SIZE = 20;
const CATALOG_THROTTLE_MS = 600;
/** FBA Inbound: 2 requests/sec sustained, burst 30. */
const INBOUND_RATE_PER_SEC = 2;
const INBOUND_BURST = 30;
const INBOUND_CONCURRENCY = 4;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Token bucket matching how SP-API actually meters requests: a sustained rate
 * with a burst allowance on top, rather than a flat sleep after every call.
 *
 * A fixed `await sleep(600)` per request serialises the throttle with the
 * request itself, so each one costs its own latency *plus* the full delay, and
 * the burst Amazon is happy to accept goes unused.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(private readonly ratePerSec: number, private readonly burst: number) {
    this.tokens = burst;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(
        this.burst,
        this.tokens + ((now - this.lastRefill) / 1000) * this.ratePerSec
      );
      this.lastRefill = now;

      // The check and the decrement share a synchronous block, so two callers
      // can never both spend the same token.
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.max(((1 - this.tokens) / this.ratePerSec) * 1000, 10));
    }
  }
}

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving order.
 *
 * Pairs with RateLimiter: the limiter decides how often a request may start,
 * this decides how many may be waiting on the network at once, so latency
 * overlaps instead of accumulating.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker)
  );
  return results;
}

/**
 * Cached LWA access token.
 *
 * Amazon issues these with an hour's life, but the comprehensive sync runs
 * across many short serverless invocations and asked for a brand new one at
 * the top of every single call — up to forty round trips, each paying a
 * request to Amazon's auth endpoint before doing any actual work, and each
 * counting against that endpoint's own rate limit.
 *
 * Module scope means a warm instance reuses the token and a cold one fetches
 * once. The token is account-wide rather than per-user, so sharing it between
 * requests on an instance is correct, not a leak.
 */
type CachedToken = { value: string; expiresAt: number };

let cachedToken: CachedToken | null = null;
let tokenInFlight: Promise<string> | null = null;

/** Refresh this long before the token actually dies, so it cannot expire mid-request. */
const TOKEN_SAFETY_MARGIN_MS = 5 * 60_000;

async function requestAccessToken(): Promise<string> {
  try {
    const response = await axios.post('https://api.amazon.com/auth/o2/token', {
      grant_type: 'refresh_token',
      refresh_token: process.env.SP_API_REFRESH_TOKEN,
      client_id: process.env.SP_API_CLIENT_ID,
      client_secret: process.env.SP_API_CLIENT_SECRET,
    });

    const token: string = response.data.access_token;
    // `expires_in` is seconds; fall back to the documented hour if absent.
    const lifetimeMs = (Number(response.data.expires_in) || 3600) * 1000;
    cachedToken = {
      value: token,
      expiresAt: Date.now() + Math.max(lifetimeMs - TOKEN_SAFETY_MARGIN_MS, 30_000),
    };
    return token;
  } catch (error) {
    console.error('Amazon Auth Error:', error);
    throw new Error('Failed to authenticate with Amazon');
  }
}

export async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  // Two stages of one sync can start together on a warm instance; without
  // this they would each open their own auth request.
  if (tokenInFlight) return tokenInFlight;

  tokenInFlight = requestAccessToken().finally(() => { tokenInFlight = null; });
  return tokenInFlight;
}

/** Drop the cached token, forcing the next call to fetch a fresh one. */
export function invalidateAccessToken(): void {
  cachedToken = null;
}

export function spFetch(path: string, token: string, init?: RequestInit) {
  return fetch(`${SP_API_ENDPOINT}${path}`, {
    ...init,
    headers: {
      'x-amz-access-token': token,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
}

export type FbaSummary = {
  /** totalQuantity — the headline figure Seller Central shows. */
  qty: number;
  name: string;
  asin: string;
  /** Ready to ship right now. */
  fulfillable: number;
  /** Working + shipped + receiving, i.e. stock already on its way to Amazon. */
  inbound: number;
  reserved: number;
  unfulfillable: number;
};

/**
 * Fetch FBA quantities for a batch of SKUs, following pagination within the
 * batch and backing off on throttling.
 *
 * Shared by the fast and full syncs so the two can't drift — the full sync
 * previously had its own copy that ignored pagination.
 */
async function fetchFbaBatch(
  skus: string[],
  token: string
): Promise<{ map: Map<string, FbaSummary>; failed: boolean }> {
  const map = new Map<string, FbaSummary>();
  const base =
    `/fba/inventory/v1/summaries?details=true` +
    `&granularityType=Marketplace&granularityId=${UK_MARKETPLACE_ID}` +
    `&marketplaceIds=${UK_MARKETPLACE_ID}` +
    `&sellerSkus=${skus.map(s => encodeURIComponent(s)).join(',')}`;

  let nextToken: string | null = null;
  let firstPage = true;

  do {
    const url: string = firstPage ? base : `${base}&nextToken=${encodeURIComponent(nextToken!)}`;
    let attempts = 0;
    let ok = false;

    while (attempts < 4 && !ok) {
      attempts++;
      const res = await spFetch(url, token);

      if (res.status === 429 || res.status === 503) {
        await sleep(1500 * attempts);
        continue;
      }
      if (!res.ok) {
        // Now that tokens are cached, a rejected one would be reused for the
        // rest of its hour. Drop it so the next attempt authenticates afresh.
        if (res.status === 401 || res.status === 403) invalidateAccessToken();
        const body = await res.text();
        console.error(`[amazon] FBA batch ${res.status}:`, body.substring(0, 200));
        return { map, failed: true };
      }

      const data = await res.json();
      for (const item of data.payload?.inventorySummaries || []) {
        const sku = (item.sellerSku || '').trim();
        if (!sku) continue;
        const d = item.inventoryDetails || {};
        const n = (v: unknown) => (typeof v === 'number' ? v : 0);
        map.set(sku.toUpperCase(), {
          qty: n(item.totalQuantity),
          name: item.productName || '',
          asin: item.asin || '',
          fulfillable: n(d.fulfillableQuantity),
          inbound:
            n(d.inboundWorkingQuantity) +
            n(d.inboundShippedQuantity) +
            n(d.inboundReceivingQuantity),
          reserved: n(d.reservedQuantity?.totalReservedQuantity),
          unfulfillable: n(d.unfulfillableQuantity?.totalUnfulfillableQuantity),
        });
      }
      nextToken = data.pagination?.nextToken || null;
      ok = true;
    }

    if (!ok) {
      console.error('[amazon] FBA batch exhausted retries');
      return { map, failed: true };
    }

    firstPage = false;
    if (nextToken) await sleep(FBA_THROTTLE_MS);
  } while (nextToken);

  return { map, failed: false };
}

/** Fetch FBA quantities for every SKU, in throttled batches. */
export async function fetchFbaQuantities(
  skus: string[],
  token: string
): Promise<{ map: Map<string, FbaSummary>; failedBatches: number }> {
  const map = new Map<string, FbaSummary>();
  let failedBatches = 0;

  for (let i = 0; i < skus.length; i += FBA_BATCH_SIZE) {
    const batch = skus.slice(i, i + FBA_BATCH_SIZE);
    const { map: batchMap, failed } = await fetchFbaBatch(batch, token);
    if (failed) failedBatches++;
    for (const [k, v] of batchMap) map.set(k, v);
    if (i + FBA_BATCH_SIZE < skus.length) await sleep(FBA_THROTTLE_MS);
  }

  return { map, failedBatches };
}

/**
 * Resolve each ASIN to its variation-family parent via the Catalog Items API.
 *
 * A child ASIN reports `parentAsins`; a parent reports `childAsins` and is
 * its own family root. Anything unresolved is simply left out of the map,
 * and the caller treats those SKUs as standalone products — grouping is a
 * presentation nicety, so it must never fail a stock sync.
 */
export async function fetchParentAsins(
  asins: string[],
  token: string
): Promise<Map<string, string>> {
  const parents = new Map<string, string>();
  const unique = Array.from(new Set(asins.filter(Boolean)));

  for (let i = 0; i < unique.length; i += CATALOG_BATCH_SIZE) {
    const batch = unique.slice(i, i + CATALOG_BATCH_SIZE);
    const url =
      `/catalog/2022-04-01/items` +
      `?identifiers=${batch.map(encodeURIComponent).join(',')}` +
      `&identifiersType=ASIN` +
      `&marketplaceIds=${UK_MARKETPLACE_ID}` +
      `&includedData=relationships`;

    try {
      let attempts = 0;
      while (attempts < 3) {
        attempts++;
        const res = await spFetch(url, token);

        if (res.status === 429 || res.status === 503) {
          await sleep(1500 * attempts);
          continue;
        }
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) invalidateAccessToken();
          console.error(`[amazon] catalog batch ${res.status}:`, (await res.text()).substring(0, 200));
          break;
        }

        const data = await res.json();
        for (const item of data.items || []) {
          const asin: string = item.asin;
          if (!asin) continue;

          let parent = '';
          for (const entry of item.relationships || []) {
            for (const rel of entry.relationships || []) {
              if (Array.isArray(rel.parentAsins) && rel.parentAsins.length > 0) {
                parent = rel.parentAsins[0];
                break;
              }
              // Reported as a parent itself — it roots its own family.
              if (Array.isArray(rel.childAsins) && rel.childAsins.length > 0) {
                parent = asin;
              }
            }
            if (parent) break;
          }

          if (parent) parents.set(asin, parent);
        }
        break;
      }
    } catch (e) {
      console.error('[amazon] catalog batch failed:', e);
    }

    if (i + CATALOG_BATCH_SIZE < unique.length) await sleep(CATALOG_THROTTLE_MS);
  }

  return parents;
}


export type InboundLine = {
  shipmentId: string;
  shipmentName: string;
  status: string;
  sku: string;
  quantityShipped: number;
  quantityReceived: number;
};

/**
 * List FBA inbound shipments and their line items — stock the seller has
 * sent to Amazon that Amazon has acknowledged but not yet made sellable.
 *
 * This is the signal Phase 3 deducts against: once a pallet is on its way to
 * a fulfilment centre it is no longer in the office, so shop stock should
 * fall by exactly the shipped quantity.
 *
 * Requires the FBA Inbound role on the SP-API app. Returns an empty list on
 * any failure so a missing role degrades to "no deductions" rather than
 * breaking the whole sync.
 */
export async function fetchInboundShipments(
  token: string,
  statuses: string[] = ['WORKING', 'SHIPPED', 'RECEIVING']
): Promise<InboundLine[]> {
  const lines: InboundLine[] = [];

  type Shipment = { ShipmentId?: string; ShipmentName?: string; ShipmentStatus?: string };
  const shipments: Shipment[] = [];

  let nextToken: string | null = null;
  let guard = 0;
  const limiter = new RateLimiter(INBOUND_RATE_PER_SEC, INBOUND_BURST);

  try {
    do {
      guard++;
      await limiter.acquire();
      const url = nextToken
        ? `/fba/inbound/v0/shipments?MarketplaceId=${UK_MARKETPLACE_ID}` +
          `&QueryType=NEXT_TOKEN&NextToken=${encodeURIComponent(nextToken)}`
        : `/fba/inbound/v0/shipments?MarketplaceId=${UK_MARKETPLACE_ID}` +
          `&QueryType=SHIPMENT&ShipmentStatusList=${statuses.join(',')}`;

      const res = await spFetch(url, token);
      if (res.status === 429 || res.status === 503) {
        await sleep(1500);
        continue;
      }
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) invalidateAccessToken();
        console.error(
          `[amazon] inbound shipments ${res.status}:`,
          (await res.text()).substring(0, 200)
        );
        return [];
      }

      const data = await res.json();
      const batch: Shipment[] = data.payload?.ShipmentData || [];
      shipments.push(...batch);
      nextToken = data.payload?.NextToken || null;
    } while (nextToken && guard < 20);
  } catch (e) {
    console.error('[amazon] inbound shipment listing failed:', e);
    return [];
  }

  // One request per shipment, previously run strictly one at a time with a
  // 600ms sleep after each — so thirty shipments cost about thirty seconds of
  // mostly waiting. The limiter still respects Amazon's 2/sec, but requests
  // now overlap and the burst allowance is used, which is what the endpoint
  // is documented to permit.
  const withIds = shipments.filter((s): s is Shipment & { ShipmentId: string } => !!s.ShipmentId);

  const perShipment = await mapWithConcurrency(
    withIds,
    INBOUND_CONCURRENCY,
    async (shipment): Promise<InboundLine[]> => {
      const id = shipment.ShipmentId;
      const out: InboundLine[] = [];
      try {
        await limiter.acquire();
        const res = await spFetch(
          `/fba/inbound/v0/shipments/${encodeURIComponent(id)}/items?MarketplaceId=${UK_MARKETPLACE_ID}`,
          token
        );
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) invalidateAccessToken();
          console.error(`[amazon] inbound items ${id} -> ${res.status}`);
          return out;
        }

        const data = await res.json();
        for (const item of data.payload?.ItemData || []) {
          const sku = (item.SellerSKU || '').trim();
          if (!sku) continue;
          out.push({
            shipmentId: id,
            shipmentName: shipment.ShipmentName || '',
            status: shipment.ShipmentStatus || '',
            sku,
            quantityShipped: typeof item.QuantityShipped === 'number' ? item.QuantityShipped : 0,
            quantityReceived: typeof item.QuantityReceived === 'number' ? item.QuantityReceived : 0,
          });
        }
      } catch (e) {
        // One unreadable shipment must not lose the other twenty-nine.
        console.error(`[amazon] inbound items ${id} failed:`, e);
      }
      return out;
    }
  );

  for (const group of perShipment) lines.push(...group);
  return lines;
}

export type RecentReport = {
  reportId: string;
  documentId: string;
  createdAt: string;
  ageMinutes: number;
};

/**
 * Find a finished report of `reportType` that is still fresh enough to reuse.
 *
 * Requesting `GET_MERCHANT_LISTINGS_ALL_DATA` puts a job in Amazon's queue and
 * it can be minutes before the data comes back — which was the entire reason
 * the full sync appeared to hang. It used to ask for a brand new report on
 * every single run, discarding one built moments earlier.
 *
 * Listings, ASINs and fulfilment channels change rarely, so a report from
 * earlier today answers the question just as well as one built now.
 *
 * Returns null on any failure: a lookup problem should cost a fresh report,
 * never the sync.
 */
export async function findRecentReport(
  token: string,
  reportType: string,
  maxAgeMs: number
): Promise<RecentReport | null> {
  const url =
    `/reports/2021-06-30/reports` +
    `?reportTypes=${encodeURIComponent(reportType)}` +
    `&processingStatuses=DONE` +
    `&marketplaceIds=${UK_MARKETPLACE_ID}` +
    `&pageSize=10`;

  try {
    const res = await spFetch(url, token);
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) invalidateAccessToken();
      console.error(`[amazon] recent report lookup ${res.status}`);
      return null;
    }

    const data = await res.json();
    const now = Date.now();
    let best: { report: RecentReport; created: number } | null = null;

    for (const entry of data.reports || []) {
      if (!entry?.reportDocumentId || !entry?.reportId) continue;

      const stamp = entry.processingEndTime || entry.createdTime;
      const created = Date.parse(stamp ?? '');
      if (!Number.isFinite(created)) continue;

      // A negative age means our clock and Amazon's disagree; treat it as
      // unusable rather than as infinitely fresh.
      const age = now - created;
      if (age < 0 || age > maxAgeMs) continue;

      if (!best || created > best.created) {
        best = {
          created,
          report: {
            reportId: entry.reportId,
            documentId: entry.reportDocumentId,
            createdAt: stamp,
            ageMinutes: Math.round(age / 60_000),
          },
        };
      }
    }

    return best?.report ?? null;
  } catch (e) {
    console.error('[amazon] recent report lookup failed:', e);
    return null;
  }
}
