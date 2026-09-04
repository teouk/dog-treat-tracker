/**
 * The one file to edit when the owner renames a column.
 *
 * Every alias is written in the normalised form produced by
 * `normalizeHeader` — lower case, Turkish letters folded to ASCII, separators
 * collapsed to single spaces. So `Toplam_Stok_Fiyatı`, `TOPLAM STOK FİYATI`
 * and `toplam stok fiyati` are all matched by the single alias
 * `'toplam stok fiyati'`.
 *
 * Adding a spelling the owner starts using is a one-line change here; no
 * matching logic needs to be touched.
 */

/** Logical columns the sync cares about. */
export type ColumnKey =
  | 'sku'
  | 'fnsku'
  | 'productName'
  | 'depotStock'
  | 'shopifyQty'
  | 'amazonQty'
  | 'unitPrice'
  | 'lineTotal';

export type ColumnSpec = {
  key: ColumnKey;
  /** Whether the sync cannot run without this column. */
  required: boolean;
  /** Whether the sync writes to this column. */
  written: boolean;
  /** Human description used in error messages. */
  label: string;
  /**
   * Normalised aliases, most specific first. Order matters only for
   * readability — scoring, not position, decides the winner.
   */
  aliases: string[];
};

export const COLUMN_SPECS: ColumnSpec[] = [
  {
    key: 'sku',
    required: true,
    written: false,
    label: 'seller SKU (Item)',
    aliases: [
      'item', 'sku', 'item code', 'seller sku', 'satici sku', 'urun kodu',
      'stok kodu', 'stok kod', 'kod', 'model', 'model kodu', 'urun kod',
    ],
  },
  {
    key: 'fnsku',
    required: false,
    written: false,
    label: 'Amazon FNSKU',
    aliases: ['fnsku', 'fn sku', 'asin', 'amazon kodu', 'amazon kod'],
  },
  {
    key: 'productName',
    required: false,
    written: false,
    label: 'product name',
    aliases: [
      'products', 'product', 'product name', 'urun', 'urunler', 'urun adi',
      'urun ismi', 'aciklama', 'description', 'name',
    ],
  },
  {
    key: 'depotStock',
    required: true,
    written: true,
    label: 'local shop / depot stock',
    aliases: [
      'depot on hand', 'depot onhand', 'depot', 'depo', 'depo stok',
      'depo mevcut', 'depo adet', 'depo miktar', 'magaza stok', 'magaza',
      'dukkan stok', 'dukkan', 'shop stock', 'local stock', 'on hand',
      'onhand', 'mevcut stok', 'mevcut', 'elde mevcut', 'stok',
    ],
  },
  {
    key: 'shopifyQty',
    required: true,
    written: true,
    label: 'Shopify quantity',
    aliases: [
      'shopify qty', 'shopify quantity', 'shopify', 'shopify stok',
      'shopify adet', 'shopify miktar', 'web stok', 'web sitesi stok',
      'site stok',
    ],
  },
  {
    key: 'amazonQty',
    required: true,
    written: true,
    label: 'Amazon quantity',
    aliases: [
      'amazon qty uk', 'amazon qty', 'amazon quantity', 'amazon uk',
      'amazon', 'amazon stok', 'amazon adet', 'amazon miktar', 'fba',
      'fba qty', 'fba stok', 'amzn qty',
    ],
  },
  {
    key: 'unitPrice',
    required: true,
    written: false,
    label: 'unit / package price',
    aliases: [
      'paket fiyati', 'paket fiyat', 'birim fiyati', 'birim fiyat',
      'unit price', 'package price', 'fiyat', 'fiyati', 'price',
      'alis fiyati', 'maliyet',
    ],
  },
  {
    key: 'lineTotal',
    required: true,
    written: true,
    label: 'total stock value',
    aliases: [
      'toplam stok fiyati', 'toplam stok fiyat', 'toplam stok degeri',
      'stok toplam fiyati', 'stok toplam', 'stok degeri', 'toplam fiyati',
      'toplam fiyat', 'toplam deger', 'toplam tutar',
      'total stock value', 'total stock price', 'stock value', 'total value',
    ],
  },
];

/**
 * Labels that mark the grand-total row at the foot of the sheet.
 *
 * Only cells in the few columns immediately left of the total column are
 * tested against these, because the workbook also has a `GENEL TOPLAM` in an
 * unrelated accounting block further right that must not be mistaken for it.
 */
export const TOTAL_ROW_LABELS: string[] = [
  'toplam', 'genel toplam', 'toplam deger', 'genel', 'total', 'grand total',
  'sum', 'toplam tutar',
];

/** How far left of the total column a grand-total label may sit. */
export const TOTAL_LABEL_SEARCH_WIDTH = 3;

/** Rows scanned from the top when looking for the header row. */
export const HEADER_SEARCH_DEPTH = 10;

/**
 * Minimum score for a fuzzy (non-exact, non-token) header match to be
 * accepted, and the margin it must beat the runner-up by.
 *
 * Both are deliberately strict: `Shopify_Qty` and `Amazon_Qty_UK` are
 * textually similar, and silently swapping two stock columns would corrupt
 * the master sheet in a way nobody would notice for weeks.
 */
export const FUZZY_MIN_SCORE = 0.72;
export const FUZZY_MIN_MARGIN = 0.12;

/**
 * Which stock columns the sync is allowed to write.
 *
 * All three are on by default, but only because the app now holds real depot
 * figures. `Depot_OnHand` is the owner's physical count, and it lived solely
 * in the workbook until `scripts/import-depot-from-workbook.ts` seeded
 * `inventory.shop_stock` from it. Before that seed the database held 20 units
 * against the sheet's 10,753, and enabling this column would not have updated
 * the sheet — it would have erased it.
 *
 * The kill switch remains: WORKBOOK_SYNC_COLUMNS=shopify,amazon drops depot
 * back out if the two sides ever diverge again.
 */
export type StockColumnKey = 'depotStock' | 'shopifyQty' | 'amazonQty';

const COLUMN_FLAG_NAMES: Record<string, StockColumnKey> = {
  depot: 'depotStock',
  depotstock: 'depotStock',
  shop: 'depotStock',
  shopify: 'shopifyQty',
  amazon: 'amazonQty',
  fba: 'amazonQty',
};

export const DEFAULT_SYNC_COLUMNS: StockColumnKey[] = ['depotStock', 'shopifyQty', 'amazonQty'];

export function resolveSyncColumns(raw = process.env.WORKBOOK_SYNC_COLUMNS): Set<StockColumnKey> {
  if (!raw || !raw.trim()) return new Set(DEFAULT_SYNC_COLUMNS);
  if (raw.trim().toLowerCase() === 'all') {
    return new Set<StockColumnKey>(['depotStock', 'shopifyQty', 'amazonQty']);
  }
  const out = new Set<StockColumnKey>();
  for (const part of raw.split(',')) {
    const key = COLUMN_FLAG_NAMES[part.trim().toLowerCase()];
    if (key) out.add(key);
  }
  return out.size > 0 ? out : new Set(DEFAULT_SYNC_COLUMNS);
}
