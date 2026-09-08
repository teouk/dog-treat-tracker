/**
 * Variant grouping.
 *
 * Every SKU resolves to exactly one group key, by precedence:
 *   1. group_override      — manual assignment, and the only way to merge
 *                            an Amazon family with a Shopify product
 *   2. shopify:<product>   — Shopify's native product -> variant structure
 *   3. amazon:<parentAsin> — Amazon's variation family
 *   4. sku:<sku>           — ungrouped singleton
 *
 * Nothing is ever grouped by fuzzy name or SKU-substring matching: on this
 * catalogue that merges Lamb Tail with Lamb Trotter (both `GLS-FS-LT*`) and
 * Camel Skin with Collagen Sticks (both `*-CS*`), which would silently
 * report one combined stock figure for two unrelated products.
 */

/** Brand prefixes that add nothing to a group header. */
const BRAND_PREFIX = /^\s*(glorious\s+treats\s+(and|&)\s+chews)\s*[-–—:|,]?\s*/i;

/**
 * Scan for the first separator that introduces marketing copy, ignoring any
 * that falls inside brackets — cutting at the comma in "(30 cm, 3 ct)" would
 * leave an unbalanced fragment.
 */
function marketingCutIndex(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') { depth++; continue; }
    if (c === ')' || c === ']') { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;

    // " - ", " – ", " | ", " : " style separators
    if (/\s/.test(c) && /[-–—|:]/.test(s[i + 1] || '') && /\s/.test(s[i + 2] || '')) return i;
    // ", " ": " "; " ". "
    if (/[,:;.]/.test(c) && /\s/.test(s[i + 1] || '')) return i;
  }
  return -1;
}

/** Every bracketed span, outermost first, in document order. */
function parentheticals(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (s[i] === ')') {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && start >= 0) {
        out.push(s.slice(start, i));
        start = -1;
      }
    }
  }
  return out;
}

/**
 * Turn a 200-character Amazon SEO title into something that reads as a
 * product name. Applied only to auto-derived names — a user's explicit
 * display_name override is always used verbatim.
 */
export function prettifyName(raw: string | null | undefined, fallback: string): string {
  if (!raw || !raw.trim()) return fallback;

  let name = raw.trim().replace(BRAND_PREFIX, '');

  const cut = marketingCutIndex(name);
  if (cut > 0) name = name.slice(0, cut);

  // Drop a trailing size/count parenthetical — that belongs on the variant.
  name = name.replace(/\s*\([^()]*\)\s*$/, '').trim();
  // An unbalanced "(30 cm" left by an earlier cut helps nobody.
  const opens = (name.match(/\(/g) || []).length;
  const closes = (name.match(/\)/g) || []).length;
  if (opens > closes) name = name.slice(0, name.lastIndexOf('(')).trim();
  name = name.replace(/[\s,;:–—-]+$/, '').trim();

  if (name.length > 60) {
    const clip = name.slice(0, 60);
    const sp = clip.lastIndexOf(' ');
    name = (sp > 30 ? clip.slice(0, sp) : clip).trim() + '…';
  }

  if (!name) return fallback;

  // ALL-CAPS or all-lowercase titles read badly as headers; title-case them.
  const letters = name.replace(/[^a-z]/gi, '');
  if (letters && (letters === letters.toUpperCase() || letters === letters.toLowerCase())) {
    name = name.replace(/\b[a-z]/gi, c => c.toUpperCase());
  }

  return name;
}

/**
 * Best-effort variant label for an Amazon SKU, which — unlike Shopify —
 * carries no structured variant title. Prefers the last bracketed span that
 * mentions a size or count, else a bare measurement, else the SKU tail.
 */
export function deriveVariantLabel(productName: string | null, sku: string): string {
  const spans = parentheticals(productName || '').filter(t => /\d/.test(t));
  for (let i = spans.length - 1; i >= 0; i--) {
    const label = spans[i].replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[,;]$/, '');
    if (label && label.length <= 40) return label;
  }

  const sizeish = (productName || '').match(/\b(\d+\s?(?:cm|mm|kg|g|gram|ct|count|pcs|pack))\b/i);
  if (sizeish) return sizeish[1];

  return sku.split('-').pop() || sku;
}

/**
 * Rows joined to their resolved group and display name.
 *
 * `derived_name` prefers a Shopify title (short and human-written) over an
 * Amazon one, then the shortest available, matching the chosen naming rule.
 */
export const GROUPED_INVENTORY_SQL = `
  WITH resolved AS (
    SELECT
      i.*,
      COALESCE(
        i.group_override,
        CASE WHEN i.shopify_product_id IS NOT NULL AND i.shopify_product_id <> ''
             THEN 'shopify:' || i.shopify_product_id END,
        CASE WHEN i.parent_asin IS NOT NULL AND i.parent_asin <> ''
             THEN 'amazon:' || i.parent_asin END,
        'sku:' || i.sku
      ) AS group_key
    FROM inventory i
  ),
  names AS (
    SELECT
      group_key,
      (array_agg(product_name ORDER BY on_shopify DESC, length(product_name) ASC)
         FILTER (WHERE product_name IS NOT NULL AND product_name <> ''))[1] AS derived_name
    FROM resolved
    GROUP BY group_key
  )
  SELECT
    r.sku, r.product_name,
    COALESCE(r.fba_quantity, 0)     AS fba_quantity,
    COALESCE(r.shop_stock, 0)       AS shop_stock,
    COALESCE(r.shopify_quantity, 0) AS shopify_quantity,
    COALESCE(r.ebay_quantity, 0)    AS ebay_quantity,
    COALESCE(r.fba_inbound, 0)      AS fba_inbound,
    COALESCE(r.on_amazon, FALSE)    AS on_amazon,
    COALESCE(r.on_shopify, FALSE)   AS on_shopify,
    COALESCE(r.on_ebay, FALSE)      AS on_ebay,
    r.last_sync_at, r.shopify_synced_at, r.ebay_synced_at, r.variant_label,
    r.group_key,
    n.derived_name,
    g.display_name
  FROM resolved r
  LEFT JOIN names n          ON n.group_key = r.group_key
  LEFT JOIN product_groups g ON g.group_key = r.group_key
  ORDER BY COALESCE(g.display_name, n.derived_name, r.sku) ASC, r.sku ASC
`;
