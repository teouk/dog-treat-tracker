export type InventoryItem = {
  sku: string;
  product_name: string | null;
  fba_quantity: number;
  shop_stock: number;
  shopify_quantity: number;
  /** Units already on their way to an Amazon fulfilment centre. */
  fba_inbound: number;
  on_amazon: boolean;
  on_shopify: boolean;
  last_sync_at: string | null;
  shopify_synced_at: string | null;
  variant_label: string | null;
  group_key: string;
  group_name: string;
  group_name_is_override: boolean;
};

export type Channel = 'all' | 'amazon' | 'shopify';
export type StatusFilter = 'all' | 'in' | 'low' | 'out';
export type Status = 'in' | 'low' | 'out';

export const LOW_STOCK_THRESHOLD = 10;

export function statusOf(total: number): Status {
  if (total <= 0) return 'out';
  if (total <= LOW_STOCK_THRESHOLD) return 'low';
  return 'in';
}

/**
 * Stock the business actually owns for a SKU: shop floor plus what Amazon
 * holds in its fulfilment centres.
 *
 * Shopify is deliberately excluded. Its quantity is a shop-front figure for
 * units fulfilled out of the same physical shop stock, so adding it would
 * count those units a second time. FBM was removed from the model entirely
 * for the same reason — merchant-fulfilled Amazon orders also ship from the
 * shop, so its quantity was never stock in its own right.
 *
 * The figure does not vary by channel: the channel tabs decide which products
 * are listed, not what "in stock" means for one of them. This matches how the
 * master workbook has always computed Toplam_Stok_Fiyatı.
 */
export function totalStock(item: InventoryItem): number {
  return (item.fba_quantity || 0) + (item.shop_stock || 0);
}

export type ProductGroup = {
  key: string;
  name: string;
  nameIsOverride: boolean;
  items: InventoryItem[];
  fba: number;
  shop: number;
  shopify: number;
  total: number;
  status: Status;
  /** Variants that are individually low or out, even when the group total looks healthy. */
  lowCount: number;
  outCount: number;
};

/**
 * Collapse SKUs into their variant families.
 *
 * A group's status comes from its combined stock, but lowCount/outCount are
 * tracked separately so a family that is healthy in aggregate still surfaces
 * the individual variant that has run out.
 */
export function buildGroups(items: InventoryItem[]): ProductGroup[] {
  const byKey = new Map<string, InventoryItem[]>();
  for (const item of items) {
    const list = byKey.get(item.group_key);
    if (list) list.push(item);
    else byKey.set(item.group_key, [item]);
  }

  const groups: ProductGroup[] = [];
  for (const [key, groupItems] of byKey) {
    let fba = 0, shop = 0, shopify = 0, lowCount = 0, outCount = 0;

    for (const item of groupItems) {
      fba += item.fba_quantity || 0;
      shop += item.shop_stock || 0;
      // Carried for display only — never added into `total`.
      shopify += item.shopify_quantity || 0;
      const s = statusOf(totalStock(item));
      if (s === 'out') outCount++;
      else if (s === 'low') lowCount++;
    }

    const total = groupItems.reduce((sum, i) => sum + totalStock(i), 0);
    const sorted = groupItems
      .slice()
      .sort((a, b) => (a.variant_label || a.sku).localeCompare(b.variant_label || b.sku, undefined, { numeric: true }));

    groups.push({
      key,
      name: sorted[0]?.group_name || key,
      nameIsOverride: sorted[0]?.group_name_is_override ?? false,
      items: sorted,
      fba, shop, shopify, total,
      status: statusOf(total),
      lowCount,
      outCount,
    });
  }

  groups.sort((a, b) => a.name.localeCompare(b.name));
  return groups;
}
