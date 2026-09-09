import { XMLParser } from 'fast-xml-parser';
import { getDb } from '@/lib/db';

/**
 * eBay Trading API client and OAuth plumbing.
 *
 * Trading rather than the newer Sell Inventory API: Inventory is SKU-keyed
 * and requires every listing to carry one, but this seller has active
 * listings with no custom label at all, which cannot exist in that model.
 * Trading reads any listing regardless of how it was created.
 *
 * The awkward part of eBay OAuth is that `redirect_uri` is not a URL — it is
 * the RuName, an opaque handle that eBay resolves to the real callback it has
 * on file. Sending the actual callback URL is the single most common cause of
 * `invalid_request` here.
 */

export const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID || '';
export const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || '';
export const EBAY_DEV_ID = process.env.EBAY_DEV_ID || '';
/** The RuName, not a URL. */
export const EBAY_RUNAME = process.env.EBAY_REDIRECT_URI || '';
export const EBAY_ENVIRONMENT = (process.env.EBAY_ENVIRONMENT || 'sandbox').toLowerCase();

export const IS_SANDBOX = EBAY_ENVIRONMENT !== 'production';

/** UK site. Trading calls are site-scoped and the seller lists on ebay.co.uk. */
export const EBAY_SITE_ID = '3';
const TRADING_COMPAT_LEVEL = '1193';

const HOSTS = {
  auth: IS_SANDBOX ? 'https://auth.sandbox.ebay.com' : 'https://auth.ebay.com',
  api: IS_SANDBOX ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com',
};

/**
 * Scope identifiers are literal strings that always read `api.ebay.com`, in
 * both environments — they are names, not endpoints.
 */
export const EBAY_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
].join(' ');

export function ebayConfigured(): boolean {
  return !!(EBAY_CLIENT_ID && EBAY_CLIENT_SECRET && EBAY_RUNAME);
}

// --------------------------------------------------------------------------
// Token storage
// --------------------------------------------------------------------------

type StoredTokens = {
  refreshToken: string;
  accessToken: string;
  /** Epoch ms at which the access token should be treated as expired. */
  expiresAt: number;
};

const KEYS = {
  refresh: 'ebay_refresh_token',
  access: 'ebay_access_token',
  expires: 'ebay_access_expires_at',
};

async function readSetting(key: string): Promise<string | null> {
  try {
    const sql = getDb();
    const rows = await sql`SELECT value FROM settings WHERE key = ${key}` as Array<{ value: string }>;
    return rows[0]?.value || null;
  } catch {
    return null;
  }
}

async function writeSetting(key: string, value: string): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO settings (key, value) VALUES (${key}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
}

export async function getStoredTokens(): Promise<StoredTokens | null> {
  const refreshToken = await readSetting(KEYS.refresh);
  if (!refreshToken) return null;
  return {
    refreshToken,
    accessToken: (await readSetting(KEYS.access)) || '',
    expiresAt: Number(await readSetting(KEYS.expires)) || 0,
  };
}

export async function clearEbayTokens(): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM settings WHERE key IN (${KEYS.refresh}, ${KEYS.access}, ${KEYS.expires})`;
}

export async function isEbayConnected(): Promise<boolean> {
  return (await readSetting(KEYS.refresh)) !== null;
}

// --------------------------------------------------------------------------
// OAuth
// --------------------------------------------------------------------------

export function buildConsentUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: EBAY_CLIENT_ID,
    // The RuName, deliberately — see the note at the top of this file.
    redirect_uri: EBAY_RUNAME,
    response_type: 'code',
    scope: EBAY_SCOPES,
    state,
  });
  return `${HOSTS.auth}/oauth2/authorize?${params.toString()}`;
}

function basicAuthHeader(): string {
  return 'Basic ' + Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');
}

async function tokenRequest(body: URLSearchParams): Promise<{
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}> {
  const res = await fetch(`${HOSTS.api}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    // eBay returns a JSON error body; surface its description, which is far
    // more useful than the status alone when diagnosing scope or RuName slips.
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      detail = parsed.error_description || parsed.error || detail;
    } catch { /* keep the raw text */ }
    throw new Error(`eBay token request failed (${res.status}): ${detail}`);
  }
  return JSON.parse(text);
}

/** Exchange the one-time authorization code for a refresh token. */
export async function exchangeCodeForTokens(code: string): Promise<void> {
  const data = await tokenRequest(new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: EBAY_RUNAME,
  }));

  if (!data.refresh_token) {
    throw new Error('eBay did not return a refresh token — check the RuName and requested scopes.');
  }
  await writeSetting(KEYS.refresh, data.refresh_token);
  await writeSetting(KEYS.access, data.access_token);
  await writeSetting(KEYS.expires, String(Date.now() + data.expires_in * 1000));
}

/**
 * A usable access token, refreshed when the stored one is close to expiry.
 *
 * eBay user access tokens last about two hours; the refresh token lasts
 * roughly 18 months and then needs the consent flow running again.
 */
export async function getEbayAccessToken(): Promise<string> {
  const stored = await getStoredTokens();
  if (!stored) throw new Error('eBay is not connected. Authorise it first.');

  // Five minutes of headroom so a token cannot expire mid-request.
  if (stored.accessToken && Date.now() < stored.expiresAt - 5 * 60_000) {
    return stored.accessToken;
  }

  const data = await tokenRequest(new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: stored.refreshToken,
    scope: EBAY_SCOPES,
  }));

  await writeSetting(KEYS.access, data.access_token);
  await writeSetting(KEYS.expires, String(Date.now() + data.expires_in * 1000));
  return data.access_token;
}

// --------------------------------------------------------------------------
// Trading API
// --------------------------------------------------------------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  // Trading responses repeat <Item> and <Variation>; forcing arrays for those
  // avoids the classic bug where a seller with exactly one of something gets
  // an object instead of a list.
  isArray: name => ['Item', 'Variation', 'NameValueList'].includes(name),
});

async function tradingCall(callName: string, innerXml: string, token: string): Promise<Record<string, unknown>> {
  const envelope =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">` +
    `<ErrorLanguage>en_GB</ErrorLanguage><WarningLevel>High</WarningLevel>` +
    innerXml +
    `</${callName}Request>`;

  const res = await fetch(`${HOSTS.api}/ws/api.dll`, {
    method: 'POST',
    headers: {
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-SITEID': EBAY_SITE_ID,
      'X-EBAY-API-COMPATIBILITY-LEVEL': TRADING_COMPAT_LEVEL,
      // Trading takes an OAuth token in this header, not Authorization.
      'X-EBAY-API-IAF-TOKEN': token,
      'Content-Type': 'text/xml',
    },
    body: envelope,
  });

  const xml = await res.text();
  if (!res.ok) throw new Error(`eBay ${callName} failed (${res.status}): ${xml.slice(0, 300)}`);

  const parsed = parser.parse(xml) as Record<string, Record<string, unknown>>;
  const body = parsed[`${callName}Response`];
  if (!body) throw new Error(`eBay ${callName}: unexpected response shape`);

  if (body.Ack === 'Failure') {
    const errs = Array.isArray(body.Errors) ? body.Errors : [body.Errors];
    const msg = errs.map(e => (e as { LongMessage?: string; ShortMessage?: string })?.LongMessage
      ?? (e as { ShortMessage?: string })?.ShortMessage).filter(Boolean).join('; ');
    throw new Error(`eBay ${callName} error: ${msg || 'unknown'}`);
  }
  return body;
}

/** One sellable unit on eBay: either a plain listing or one variation of one. */
export type EbayListing = {
  itemId: string;
  title: string;
  /** eBay's custom label. Empty when the seller never set one. */
  sku: string;
  quantityAvailable: number;
  /** e.g. "Size & Count: M (65g - 75g) x 3" — empty for single listings. */
  variationLabel: string;
};

function asNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function variationLabelOf(variation: Record<string, unknown>): string {
  const specifics = variation.VariationSpecifics as { NameValueList?: unknown[] } | undefined;
  const pairs = (specifics?.NameValueList ?? []) as Array<{ Name?: string; Value?: unknown }>;
  return pairs
    .map(p => `${p.Name}: ${Array.isArray(p.Value) ? p.Value.join('/') : p.Value}`)
    .join(', ');
}

/**
 * Every active listing, flattened so each variation is its own row.
 *
 * A variation listing reports quantity per variation, and the parent's
 * quantity is the sum — so flattening is what makes the figures line up with
 * an inventory keyed by SKU.
 */
export async function fetchActiveListings(token: string): Promise<EbayListing[]> {
  const out: EbayListing[] = [];
  const PER_PAGE = 100;
  let page = 1;
  let totalPages = 1;

  do {
    const body = await tradingCall('GetMyeBaySelling', `
      <ActiveList>
        <Include>true</Include>
        <IncludeVariations>true</IncludeVariations>
        <Pagination>
          <EntriesPerPage>${PER_PAGE}</EntriesPerPage>
          <PageNumber>${page}</PageNumber>
        </Pagination>
      </ActiveList>
      <DetailLevel>ReturnAll</DetailLevel>
    `, token);

    const activeList = body.ActiveList as Record<string, unknown> | undefined;
    const itemArray = (activeList?.ItemArray as { Item?: unknown[] } | undefined)?.Item ?? [];
    const pagination = activeList?.PaginationResult as { TotalNumberOfPages?: unknown } | undefined;
    totalPages = Math.max(1, asNumber(pagination?.TotalNumberOfPages) || 1);

    for (const raw of itemArray as Array<Record<string, unknown>>) {
      const itemId = String(raw.ItemID ?? '');
      const title = String(raw.Title ?? '');
      const variations = (raw.Variations as { Variation?: unknown[] } | undefined)?.Variation;

      if (Array.isArray(variations) && variations.length > 0) {
        for (const v of variations as Array<Record<string, unknown>>) {
          // Quantity on a variation is the total ever listed; what remains is
          // that minus what has sold.
          const sold = asNumber((v.SellingStatus as { QuantitySold?: unknown } | undefined)?.QuantitySold);
          out.push({
            itemId,
            title,
            sku: String(v.SKU ?? '').trim(),
            quantityAvailable: Math.max(0, asNumber(v.Quantity) - sold),
            variationLabel: variationLabelOf(v),
          });
        }
      } else {
        const sold = asNumber((raw.SellingStatus as { QuantitySold?: unknown } | undefined)?.QuantitySold);
        out.push({
          itemId,
          title,
          sku: String(raw.SKU ?? '').trim(),
          quantityAvailable: Math.max(0, asNumber(raw.Quantity) - sold),
          variationLabel: '',
        });
      }
    }

    page++;
  } while (page <= totalPages && page <= 20);

  return out;
}
