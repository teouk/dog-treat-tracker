import axios from 'axios';

export const SP_API_ENDPOINT = 'https://sellingpartnerapi-eu.amazon.com';
export const UK_MARKETPLACE_ID = 'A1F83G8C2ARO7P';

/** FBA inventory allows 50 sellerSkus per request at ~2 req/sec. */
const FBA_BATCH_SIZE = 50;
const FBA_THROTTLE_MS = 600;
/** Catalog Items allows 20 identifiers per request at ~2 req/sec. */
const CATALOG_BATCH_SIZE = 20;
const CATALOG_THROTTLE_MS = 600;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function getAccessToken(): Promise<string> {
  try {
    const response = await axios.post('https://api.amazon.com/auth/o2/token', {
      grant_type: 'refresh_token',
      refresh_token: process.env.SP_API_REFRESH_TOKEN,
      client_id: process.env.SP_API_CLIENT_ID,
      client_secret: process.env.SP_API_CLIENT_SECRET,
    });
    return response.data.access_token;
  } catch (error) {
    console.error('Amazon Auth Error:', error);
    throw new Error('Failed to authenticate with Amazon');
  }
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

export type FbaSummary = { qty: number; name: string };

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
        const body = await res.text();
        console.error(`[amazon] FBA batch ${res.status}:`, body.substring(0, 200));
        return { map, failed: true };
      }

      const data = await res.json();
      for (const item of data.payload?.inventorySummaries || []) {
        const sku = (item.sellerSku || '').trim();
        if (!sku) continue;
        map.set(sku.toUpperCase(), {
          qty: typeof item.totalQuantity === 'number' ? item.totalQuantity : 0,
          name: item.productName || '',
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
