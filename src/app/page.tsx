'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession, signOut } from 'next-auth/react';
import Login from '@/components/Login';
import ThemeToggle from '@/components/ThemeToggle';
import StockAdjuster from '@/components/StockAdjuster';
import GroupNameEditor from '@/components/GroupNameEditor';
import BulkReceiveModal from '@/components/BulkReceiveModal';
import Nav from '@/components/Nav';
import {
  type InventoryItem, type Channel, type StatusFilter, type Status, type ProductGroup,
  LOW_STOCK_THRESHOLD, statusOf, totalStock, buildGroups,
} from '@/lib/inventory-view';

const STATUS_STYLES: Record<Status, { dot: string; text: string; label: string }> = {
  in:  { dot: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-400', label: 'In stock' },
  low: { dot: 'bg-amber-500',   text: 'text-amber-700 dark:text-amber-400',     label: 'Low' },
  out: { dot: 'bg-red-500',     text: 'text-red-700 dark:text-red-400',         label: 'Out' },
};

function StatusPill({ status }: { status: Status }) {
  const s = STATUS_STYLES[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${s.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

function StatTile({ label, value, sub, tone, active, onClick }: {
  label: string; value: number; sub?: string; tone: Status | 'all'; active: boolean; onClick: () => void;
}) {
  const tones: Record<string, string> = {
    all:  'text-slate-900 dark:text-slate-100',
    in:   'text-emerald-600 dark:text-emerald-400',
    low:  'text-amber-600 dark:text-amber-400',
    out:  'text-red-600 dark:text-red-400',
  };
  return (
    <button
      onClick={onClick}
      className={`rounded-xl border px-4 py-3 text-left transition-all ${
        active
          ? 'border-slate-900 dark:border-slate-100 bg-white dark:bg-slate-900 shadow-sm'
          : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700'
      }`}
    >
      <p className={`tnum text-2xl font-bold ${tones[tone]}`}>{value}</p>
      <p className="mt-0.5 text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
      {sub && <p className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">{sub}</p>}
    </button>
  );
}

function Num({ value, muted }: { value: number; muted?: boolean }) {
  return (
    <span className={`tnum text-sm ${
      muted && value === 0
        ? 'text-slate-300 dark:text-slate-700'
        : 'font-medium text-slate-700 dark:text-slate-300'
    }`}>
      {value}
    </span>
  );
}

export default function InventoryDashboard() {
  const { status: authStatus } = useSession();
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [fetching, setFetching] = useState(true);
  const [amazonLoading, setAmazonLoading] = useState(false);
  const [fullSyncLoading, setFullSyncLoading] = useState(false);
  const [shopifyLoading, setShopifyLoading] = useState(false);
  const [ebayLoading, setEbayLoading] = useState(false);
  const [syncStatus, setSyncStatus] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [channel, setChannel] = useState<Channel>('all');
  const [shopifyConnected, setShopifyConnected] = useState(false);
  const [ebayConnected, setEbayConnected] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showReceive, setShowReceive] = useState(false);
  const [deductAmazon, setDeductAmazon] = useState(true);

  const headerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const apply = () =>
      document.documentElement.style.setProperty('--app-header-h', `${el.offsetHeight}px`);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [authStatus]);

  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    let cancelled = false;

    (async () => {
      try {
        const [invRes, shopRes, ebayRes, setRes] = await Promise.all([
          fetch('/api/inventory'),
          fetch('/api/shopify/status'),
          fetch('/api/ebay/status'),
          fetch('/api/settings'),
        ]);
        if (cancelled) return;
        const inv = await invRes.json();
        if (Array.isArray(inv)) setInventory(inv);
        const shop = await shopRes.json().catch(() => ({}));
        setShopifyConnected(!!shop.connected);
        const ebay = await ebayRes.json().catch(() => ({}));
        setEbayConnected(!!ebay.connected);
        const settings = await setRes.json().catch(() => ({}));
        if (typeof settings.deductOutboundAmazon === 'boolean') {
          setDeductAmazon(settings.deductOutboundAmazon);
        }
      } finally {
        if (!cancelled) setFetching(false);
      }
    })();

    return () => { cancelled = true; };
  }, [authStatus]);

  async function fetchInventory() {
    const res = await fetch('/api/inventory');
    const data = await res.json();
    if (Array.isArray(data)) setInventory(data);
  }

  function flash(message: string, ms = 4500) {
    setSyncStatus(message);
    setTimeout(() => setSyncStatus(''), ms);
  }

  /**
   * Refresh Amazon stock levels — the everyday action behind the Amazon button.
   *
   * One call to /api/sync, which reads FBA quantities straight from the
   * inventory summaries API: two requests for the current catalogue, a couple
   * of seconds end to end.
   *
   * This deliberately does *not* touch listings, ASINs or variation families.
   * Those come from a report Amazon builds on its own schedule, which is what
   * made the old button appear to hang for minutes; they change rarely and are
   * handled by the full refresh and the nightly cron instead.
   */
  async function runAmazonStockRefresh() {
    setAmazonLoading(true);
    setSyncStatus('Refreshing Amazon stock…');

    try {
      const res = await fetch('/api/sync');
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(
          body.error === 'NO_SKUS'
            ? 'No Amazon SKUs known yet — run a Full refresh first.'
            : body.message || body.error || 'Sync failed'
        );
      }

      await fetchInventory();
      const seconds = ((body.elapsedMs || 0) / 1000).toFixed(1);
      const bits = [`${body.updated || 0} SKUs in ${seconds}s`];
      if (body.failedBatches) bits.push(`${body.failedBatches} batch(es) failed`);
      flash(`Amazon stock refreshed — ${bits.join(', ')}`);
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Sync failed', 6000);
    }

    setAmazonLoading(false);
  }

  /**
   * Drive the comprehensive Amazon sync to completion.
   *
   * The server does as much as fits in one invocation and hands back a
   * token; we keep calling with it until the sync reports done. The cap is
   * a safety net against an unexpected server-side loop, not an expected
   * outcome.
   *
   * The first stage waits on a report Amazon queues its own side, so this can
   * legitimately run for several minutes and the tab has to stay open. It is a
   * secondary action for that reason — use it when listings or variations have
   * changed, not to check stock.
   */
  async function runAmazonSync({ fresh = false }: { fresh?: boolean } = {}) {
    setFullSyncLoading(true);
    setSyncStatus(
      fresh
        ? 'Building a brand-new Amazon listings report — this can take a few minutes…'
        : 'Starting full Amazon refresh…'
    );

    try {
      let token = '';
      let done = false;

      for (let step = 0; step < 40 && !done; step++) {
        const url = token
          ? `/api/sync/amazon?token=${encodeURIComponent(token)}`
          : `/api/sync/amazon${fresh ? '?fresh=1' : ''}`;
        const res = await fetch(url);
        const body = await res.json().catch(() => ({}));

        if (!res.ok) throw new Error(body.error || 'Sync failed');

        if (body.done) {
          done = true;
          await fetchInventory();
          const c = body.counters || {};
          const bits = [
            `${c.listings || 0} listings`,
            `${c.fbaUpdated || 0} FBA SKUs`,
          ];
          if (c.variationFamilies) bits.push(`${c.variationFamilies} variation families`);
          if (c.unitsDeducted) bits.push(`${c.unitsDeducted} units sent to Amazon deducted`);
          flash(`Sync complete — ${bits.join(', ')}`, 7000);
        } else {
          token = body.token || token;
          setSyncStatus(body.progress || 'Working…');
        }
      }

      if (!done) flash('Sync did not finish. Run it again to resume.', 6000);
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Sync failed', 6000);
    }

    setFullSyncLoading(false);
  }

  async function triggerShopifySync() {
    setShopifyLoading(true);
    setSyncStatus('Syncing Shopify…');
    try {
      const res = await fetch('/api/sync/shopify');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Sync failed');
      await fetchInventory();
      flash(`Synced ${body.upserted || 0} variants across ${body.grouped || 0} products`);
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Sync failed', 5000);
    }
    setShopifyLoading(false);
  }

  async function triggerEbaySync() {
    setEbayLoading(true);
    setSyncStatus('Syncing eBay…');
    try {
      const res = await fetch('/api/sync/ebay');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || body.error || 'Sync failed');
      await fetchInventory();

      const bits = [`${body.matched || 0} matched`];
      if (body.unmatchedCount) bits.push(`${body.unmatchedCount} unmatched`);
      if (body.duplicateCount) bits.push(`${body.duplicateCount} on multiple listings`);
      if (body.clearedStale) bits.push(`${body.clearedStale} cleared`);
      flash(`eBay: ${bits.join(', ')} of ${body.listingsReturned || 0} listings`, 9000);

      if (body.duplicates?.length) {
        console.warn(
          `[ebay] ${body.duplicates.length} SKU(s) are listed more than once. eBay sells ` +
          'from each listing independently, so these quantities are sums and may oversell:'
        );
        console.table(body.duplicates);
      }

      // The unmatched list is the working document for relabelling listings in
      // eBay, and is far too long to read in a toast.
      if (body.unmatched?.length) {
        console.table(body.unmatched);
        console.info('[ebay] full unmatched list logged above — see docs/ebay-sync.md');
      }
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Sync failed', 6000);
    }
    setEbayLoading(false);
  }

  async function disconnectEbay() {
    if (!confirm('Disconnect eBay? You will need to re-authorise to sync again.')) return;
    await fetch('/api/ebay/disconnect', { method: 'POST' });
    setEbayConnected(false);
  }

  async function disconnectShopify() {
    if (!confirm('Disconnect Shopify? You will need to re-authorise to sync again.')) return;
    await fetch('/api/shopify/disconnect', { method: 'POST' });
    setShopifyConnected(false);
  }

  async function saveDeduction(enabled: boolean) {
    setDeductAmazon(enabled);
    await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deductOutboundAmazon: enabled }),
    });
  }

  function applyStock(sku: string, next: number) {
    setInventory(prev => prev.map(i => (i.sku === sku ? { ...i, shop_stock: next } : i)));
  }

  function applyGroupName(groupKey: string, name: string, isOverride: boolean) {
    setInventory(prev => prev.map(i =>
      i.group_key === groupKey
        ? { ...i, group_name: name || i.group_name, group_name_is_override: isOverride }
        : i
    ));
    if (!isOverride) fetchInventory();
  }

  function toggle(key: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const channelItems = useMemo(() => {
    if (channel === 'amazon') return inventory.filter(i => i.on_amazon !== false);
    if (channel === 'shopify') return inventory.filter(i => i.on_shopify === true);
    if (channel === 'ebay') return inventory.filter(i => i.on_ebay === true);
    return inventory;
  }, [inventory, channel]);

  const allGroups = useMemo(() => buildGroups(channelItems), [channelItems]);

  const stats = useMemo(() => {
    let inStock = 0, low = 0, out = 0;
    for (const g of allGroups) {
      if (g.status === 'out') out++;
      else if (g.status === 'low') low++;
      else inStock++;
    }
    return { total: allGroups.length, variants: channelItems.length, inStock, low, out };
  }, [allGroups, channelItems]);

  const groups = useMemo(() => {
    let list = allGroups;
    const q = searchQuery.trim().toLowerCase();

    if (q) {
      list = list.filter(g =>
        g.name.toLowerCase().includes(q) ||
        g.items.some(i =>
          i.sku.toLowerCase().includes(q) ||
          (i.variant_label || '').toLowerCase().includes(q) ||
          (i.product_name || '').toLowerCase().includes(q)
        )
      );
    }
    if (statusFilter !== 'all') list = list.filter(g => g.status === statusFilter);
    return list;
  }, [allGroups, searchQuery, statusFilter]);

  // A search hit inside a collapsed family would otherwise be invisible.
  const openKeys = useMemo(
    () => (searchQuery.trim() ? new Set(groups.map(g => g.key)) : expanded),
    [searchQuery, groups, expanded]
  );

  const lastSync = useMemo(() => {
    const field = channel === 'shopify' ? 'shopify_synced_at' : 'last_sync_at';
    const times = inventory
      .map(i => i[field])
      .filter((d): d is string => !!d)
      .map(d => new Date(d).getTime());
    return times.length ? new Date(Math.max(...times)) : null;
  }, [inventory, channel]);

  if (authStatus === 'loading') {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-50 dark:bg-slate-950">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-slate-800 dark:border-slate-700 dark:border-t-slate-200" />
      </div>
    );
  }
  if (authStatus === 'unauthenticated') return <Login />;

  // FBA and Shop are the two inputs to Total, so they show on every tab —
  // hiding them on the Shopify tab left a Total with no visible source.
  // The Shopify column is informational and hidden on the Amazon tab.
  const showShopify = channel === 'all' || channel === 'shopify';
  const showEbay = channel === 'all' || channel === 'ebay';
  // Controls the Amazon sync buttons only, not which columns are rendered.
  const showAmazonSync = channel === 'all' || channel === 'amazon';
  // Product, FBA, Shop, Total, Status, plus Shopify and eBay when shown.
  const colSpan = 5 + (showShopify ? 1 : 0) + (showEbay ? 1 : 0);

  const channelTabs: Array<{ key: Channel; label: string }> = [
    { key: 'all', label: 'All channels' },
    { key: 'amazon', label: 'Amazon' },
    { key: 'shopify', label: 'Shopify' },
    { key: 'ebay', label: 'eBay' },
  ];

  // Pinned under the app header, whose height is measured into
  // --app-header-h above (it grows when the sync status bar appears, so a
  // fixed offset would get overlapped). Opaque backgrounds only — rows
  // scroll underneath this row.
  const stickyHead =
    'sticky top-[var(--app-header-h,57px)] z-10 py-3 font-bold ' +
    // Amber with near-black text rather than white: light text on yellow is
    // the classic unreadable pairing, and this row has to stay legible while
    // it sits over scrolling content.
    'bg-amber-300 text-amber-950 shadow-[0_1px_0_0_theme(colors.amber.500)] ' +
    'dark:bg-amber-400 dark:text-amber-950 dark:shadow-[0_1px_0_0_theme(colors.amber.600)]';

  const syncBtn =
    'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold text-white ' +
    'transition-colors disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <header ref={headerRef} className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-4">
            <h1 className="truncate text-sm font-bold tracking-tight text-slate-900 dark:text-slate-100 sm:text-base">
              Glorious Treats <span className="text-blue-600 dark:text-blue-400">&amp; Chews</span>
            </h1>
            <Nav />
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {/* Paired with the full-width bar below, which takes over under lg. */}
            {syncStatus && (
              <span className="hidden max-w-xs truncate rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 lg:inline">
                {syncStatus}
              </span>
            )}

            {showAmazonSync && (
              <>
                <button
                  onClick={runAmazonStockRefresh}
                  disabled={amazonLoading || fullSyncLoading}
                  className={`${syncBtn} bg-orange-600 hover:bg-orange-700`}
                  title="Refresh Amazon stock levels — takes a couple of seconds"
                >
                  {amazonLoading
                    ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    : <span aria-hidden>⟳</span>}
                  <span className="hidden sm:inline">Amazon</span>
                </button>

                <button
                  onClick={e => runAmazonSync({ fresh: e.shiftKey })}
                  disabled={amazonLoading || fullSyncLoading}
                  className={
                    `${syncBtn} !text-slate-600 dark:!text-slate-300 ` +
                    'border border-slate-300 bg-transparent hover:bg-slate-100 ' +
                    'dark:border-slate-700 dark:hover:bg-slate-800'
                  }
                  title="Full Amazon refresh: listings, variation families and inbound shipments. Reuses a listings report from the last few hours when there is one, so it is usually quick. Shift-click to force Amazon to build a brand-new report, which takes several minutes — keep this tab open."
                >
                  {fullSyncLoading
                    ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-400/30 border-t-slate-500" />
                    : <span aria-hidden>⤓</span>}
                  <span className="hidden md:inline">Full</span>
                </button>
              </>
            )}

            {showShopify && (shopifyConnected ? (
              <button
                onClick={triggerShopifySync}
                disabled={shopifyLoading}
                className={`${syncBtn} bg-emerald-600 hover:bg-emerald-700`}
                title="Refresh Shopify stock"
              >
                {shopifyLoading
                  ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  : <span aria-hidden>⟳</span>}
                <span className="hidden sm:inline">Shopify</span>
              </button>
            ) : (
              <a href="/api/shopify/install" className={`${syncBtn} bg-emerald-600 hover:bg-emerald-700`}>
                <span className="hidden sm:inline">Connect Shopify</span>
                <span className="sm:hidden">Shopify</span>
              </a>
            ))}

            {showEbay && (ebayConnected ? (
              <button
                onClick={triggerEbaySync}
                disabled={ebayLoading}
                className={`${syncBtn} bg-sky-600 hover:bg-sky-700`}
                title="Refresh eBay stock"
              >
                {ebayLoading
                  ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  : <span aria-hidden>⟳</span>}
                <span className="hidden sm:inline">eBay</span>
              </button>
            ) : (
              <a href="/api/ebay/install" className={`${syncBtn} bg-sky-600 hover:bg-sky-700`}>
                <span className="hidden sm:inline">Connect eBay</span>
                <span className="sm:hidden">eBay</span>
              </a>
            ))}

            <ThemeToggle />
            <button
              onClick={() => signOut()}
              className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
              title="Sign out"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>
        </div>

        {syncStatus && (
          <div className="bg-blue-50 px-4 py-1.5 text-center text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 lg:hidden">
            {syncStatus}
          </div>
        )}
      </header>

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-800 dark:bg-slate-900">
            {channelTabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => { setChannel(tab.key); setStatusFilter('all'); }}
                className={`rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
                  channel === tab.key
                    ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowReceive(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 transition-colors hover:border-slate-400 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Bulk order received
            </button>
          </div>

          {lastSync && (
            <p className="text-xs text-slate-400 dark:text-slate-500">
              Last {channel === 'shopify' ? 'Shopify' : 'Amazon'} sync{' '}
              {lastSync.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} at{' '}
              {lastSync.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
            </p>
          )}
        </div>

        {channel === 'ebay' && !ebayConnected && (
          <div className="rounded-xl border border-sky-200 bg-sky-50 p-5 text-center dark:border-sky-800 dark:bg-sky-900/20">
            <p className="font-semibold text-sky-800 dark:text-sky-300">eBay is not connected</p>
            <p className="mt-1 text-sm text-sky-700 dark:text-sky-400">
              Authorise eBay to pull listing quantities into the eBay column.
            </p>
            <a href="/api/ebay/install" className="mt-3 inline-block rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700">
              Connect eBay
            </a>
          </div>
        )}

        {channel === 'shopify' && !shopifyConnected && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-center dark:border-emerald-800 dark:bg-emerald-900/20">
            <p className="font-semibold text-emerald-800 dark:text-emerald-300">Shopify is not connected</p>
            <p className="mt-1 text-sm text-emerald-700 dark:text-emerald-400">
              Connect your store to sync stock and group variants automatically.
            </p>
            <a href="/api/shopify/install" className="mt-3 inline-block rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
              Connect Shopify
            </a>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Products" value={stats.total} sub={`${stats.variants} SKUs`} tone="all" active={statusFilter === 'all'} onClick={() => setStatusFilter('all')} />
          <StatTile label="In stock" value={stats.inStock} tone="in" active={statusFilter === 'in'} onClick={() => setStatusFilter('in')} />
          <StatTile label="Low stock" value={stats.low} sub={`≤ ${LOW_STOCK_THRESHOLD} units`} tone="low" active={statusFilter === 'low'} onClick={() => setStatusFilter('low')} />
          <StatTile label="Out of stock" value={stats.out} tone="out" active={statusFilter === 'out'} onClick={() => setStatusFilter('out')} />
        </div>

        <div className="relative">
          <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="search"
            placeholder="Search product, variant or SKU…"
            className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-10 pr-4 text-sm text-slate-900 outline-none transition-all placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Desktop grid */}
        <div className="hidden overflow-clip rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 md:block">
          <table className="w-full">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-slate-600 dark:text-slate-300">
                <th className={`${stickyHead} px-4 text-left`}>Product</th>
                <th className={`${stickyHead} px-3 text-right`}>FBA</th>
                <th className={`${stickyHead} px-3 text-center`}>Depo</th>
                {showShopify && <th className={`${stickyHead} px-3 text-right`}>Shopify</th>}
                {showEbay && <th className={`${stickyHead} px-3 text-right`}>eBay</th>}
                <th className={`${stickyHead} px-3 text-right`}>Total</th>
                <th className={`${stickyHead} px-4 text-left`}>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {groups.map(group => {
                const single = group.items.length === 1;
                const open = openKeys.has(group.key);
                return (
                  <GroupRows
                    key={group.key}
                    group={group}
                    single={single}
                    open={open}
                    channel={channel}
                    showShopify={showShopify}
                    showEbay={showEbay}
                    onToggle={toggle}
                    onStock={applyStock}
                    onRenamed={applyGroupName}
                  />
                );
              })}
              {groups.length === 0 && (
                <tr>
                  <td colSpan={colSpan} className="px-4 py-14 text-center text-sm text-slate-400 dark:text-slate-500">
                    {fetching ? 'Loading inventory…'
                      : allGroups.length === 0 ? 'No products yet — run a sync to import your catalogue.'
                      : 'Nothing matches those filters.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/*
          Mobile: stacked cards rather than a horizontally scrollable table.
          Side-scrolling hides FBA/Shopify/eBay behind a swipe most people
          never try, and `overflow-x-auto` also forces overflow-y to `auto`,
          which would make the wrapper a scroll container and break the
          sticky header on the desktop table.
        */}
        <div className="space-y-2.5 md:hidden">
          {groups.map(group => {
            const open = openKeys.has(group.key);
            const single = group.items.length === 1;
            return (
              <div key={group.key} className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
                <button
                  onClick={() => !single && toggle(group.key)}
                  className="flex w-full items-start justify-between gap-3 p-3.5 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{group.name}</p>
                    <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
                      {single ? group.items[0].sku : `${group.items.length} variations`}
                      {group.outCount > 0 && <span className="ml-1.5 text-red-500">· {group.outCount} out</span>}
                      {group.lowCount > 0 && <span className="ml-1.5 text-amber-500">· {group.lowCount} low</span>}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="tnum text-xl font-bold text-slate-900 dark:text-slate-100">{group.total}</p>
                    <StatusPill status={group.status} />
                  </div>
                </button>

                <MetricStrip
                  fba={group.fba}
                  shop={group.shop}
                  shopify={group.shopify}
                  ebay={group.ebay}
                  showShopify={showShopify}
                  showEbay={showEbay}
                />

                {single ? (
                  <div className="border-t border-slate-100 px-3.5 py-2.5 dark:border-slate-800">
                    <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                      Set shop stock
                    </p>
                    <StockAdjuster block sku={group.items[0].sku} value={group.items[0].shop_stock || 0} onChange={applyStock} />
                  </div>
                ) : open && (
                  <div className="divide-y divide-slate-100 border-t border-slate-100 dark:divide-slate-800 dark:border-slate-800">
                    {group.items.map(item => (
                      <div key={item.sku} className="px-3.5 py-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-slate-700 dark:text-slate-300">
                              {item.variant_label || item.sku}
                            </p>
                            <p className="truncate font-mono text-[11px] text-slate-400 dark:text-slate-500">{item.sku}</p>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="tnum text-sm font-bold text-slate-900 dark:text-slate-100">
                              {totalStock(item)}
                            </p>
                            <StatusPill status={statusOf(totalStock(item))} />
                          </div>
                        </div>

                        <MetricStrip
                          bare
                          fba={item.fba_quantity || 0}
                          shop={item.shop_stock || 0}
                          shopify={item.shopify_quantity || 0}
                          ebay={item.ebay_quantity || 0}
                          showShopify={showShopify}
                          showEbay={showEbay}
                        />

                        <div className="mt-2.5">
                          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                            Set shop stock
                          </p>
                          <StockAdjuster block sku={item.sku} value={item.shop_stock || 0} onChange={applyStock} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {groups.length === 0 && (
            <p className="py-14 text-center text-sm text-slate-400 dark:text-slate-500">
              {fetching ? 'Loading inventory…' : 'Nothing matches those filters.'}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <input
              type="checkbox"
              checked={deductAmazon}
              onChange={e => saveDeduction(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-300 accent-blue-600 dark:border-slate-600"
            />
            Deduct shop stock when stock is sent to Amazon
          </label>

          {showEbay && ebayConnected && (
            <button onClick={disconnectEbay} className="text-xs text-slate-400 transition-colors hover:text-red-500">
              Disconnect eBay
            </button>
          )}

          {showShopify && shopifyConnected && (
            <button onClick={disconnectShopify} className="text-xs text-slate-400 transition-colors hover:text-red-500">
              Disconnect Shopify
            </button>
          )}
        </div>

      </main>

      {showReceive && (
        <BulkReceiveModal
          inventory={inventory}
          onClose={() => setShowReceive(false)}
          onSaved={async ({ linesApplied, totalUnits }) => {
            setShowReceive(false);
            await fetchInventory();
            flash(`Delivery recorded — ${totalUnits} units across ${linesApplied} product${linesApplied === 1 ? '' : 's'}`, 6000);
          }}
        />
      )}
    </div>
  );
}

/**
 * The per-channel stock figures, laid out for a narrow screen.
 *
 * On mobile these numbers previously had nowhere to live — the desktop table
 * is hidden below `md`, so FBA, Shopify and eBay were only reachable by
 * rotating the phone. Each figure gets its own labelled cell here, sized to
 * stay on one line in iPhone portrait even with four channels shown.
 */
/**
 * An eBay quantity, marked when it is a sum across more than one listing.
 *
 * eBay treats each listing as an independent stock pool and will sell from
 * all of them, so two listings of 40 mean it is prepared to ship 80 of stock
 * that may only exist once. The number stays truthful about that exposure;
 * the marker stops it reading as a single healthy figure.
 */
function EbayQty({ value, listings }: { value: number; listings: number }) {
  if (listings <= 1) return <Num value={value} muted />;
  return (
    <span
      className="inline-flex items-center gap-1"
      title={`Across ${listings} separate eBay listings. eBay can sell from each independently, so it may oversell.`}
    >
      <span className="tnum text-sm font-semibold text-amber-600 dark:text-amber-400">{value}</span>
      <span aria-hidden className="text-[11px] text-amber-500">⚠</span>
      <span className="sr-only">on {listings} eBay listings</span>
    </span>
  );
}

function MetricStrip({ fba, shop, shopify, ebay, showShopify, showEbay, bare = false }: {
  fba: number;
  shop: number;
  shopify: number;
  ebay: number;
  showShopify: boolean;
  showEbay: boolean;
  /** Inside a variant row, where the card already provides its own border. */
  bare?: boolean;
}) {
  const cells: Array<{ label: string; value: number; strong?: boolean }> = [
    { label: 'FBA', value: fba },
    { label: 'Shop', value: shop, strong: true },
  ];
  if (showShopify) cells.push({ label: 'Shopify', value: shopify });
  if (showEbay) cells.push({ label: 'eBay', value: ebay });

  return (
    <div
      className={
        bare
          ? 'mt-2.5 grid gap-1 rounded-lg bg-slate-50 p-1.5 dark:bg-slate-800/50'
          : 'grid gap-1 border-t border-slate-100 bg-slate-50/60 p-2 dark:border-slate-800 dark:bg-slate-800/30'
      }
      style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}
    >
      {cells.map(cell => (
        <div key={cell.label} className="min-w-0 text-center">
          <p className="truncate text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
            {cell.label}
          </p>
          <p className={`tnum truncate text-sm font-bold ${
            cell.value === 0
              ? 'text-slate-300 dark:text-slate-600'
              : cell.strong
                ? 'text-slate-900 dark:text-slate-100'
                : 'text-slate-600 dark:text-slate-300'
          }`}>
            {cell.value}
          </p>
        </div>
      ))}
    </div>
  );
}

function GroupRows({ group, single, open, showShopify, showEbay, onToggle, onStock, onRenamed }: {
  group: ProductGroup;
  single: boolean;
  open: boolean;
  channel: Channel;
  showShopify: boolean;
  showEbay: boolean;
  onToggle: (key: string) => void;
  onStock: (sku: string, next: number) => void;
  onRenamed: (key: string, name: string, isOverride: boolean) => void;
}) {
  const only = group.items[0];

  return (
    <>
      <tr
        className={`transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40 ${
          open && !single ? 'bg-slate-50/60 dark:bg-slate-800/30' : ''
        }`}
      >
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-2">
            {single ? (
              <span className="w-4" />
            ) : (
              <button
                onClick={() => onToggle(group.key)}
                className="grid h-4 w-4 place-items-center text-slate-400 transition-transform hover:text-slate-700 dark:hover:text-slate-200"
                aria-expanded={open}
                aria-label={`${open ? 'Collapse' : 'Expand'} ${group.name}`}
              >
                <svg className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            )}

            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <GroupNameEditor
                  groupKey={group.key}
                  name={group.name}
                  isOverride={group.nameIsOverride}
                  onSaved={onRenamed}
                />
                {!single && (
                  <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    {group.items.length}
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate font-mono text-[11px] text-slate-400 dark:text-slate-500">
                {single ? only.sku : (
                  <>
                    {group.items.length} variations
                    {group.outCount > 0 && <span className="ml-1.5 font-sans font-semibold text-red-500">{group.outCount} out</span>}
                    {group.lowCount > 0 && <span className="ml-1.5 font-sans font-semibold text-amber-500">{group.lowCount} low</span>}
                  </>
                )}
              </p>
            </div>
          </div>
        </td>

        <td className="px-3 py-2.5 text-right"><Num value={group.fba} muted /></td>
        <td className="px-3 py-2.5 text-center">
          {single
            ? <StockAdjuster sku={only.sku} value={only.shop_stock || 0} onChange={onStock} />
            : <Num value={group.shop} muted />}
        </td>
        {showShopify && <td className="px-3 py-2.5 text-right"><Num value={group.shopify} muted /></td>}
        {showEbay && (
          <td className="px-3 py-2.5 text-right">
            <EbayQty value={group.ebay} listings={group.ebayDuplicates > 0 ? 2 : 1} />
          </td>
        )}

        <td className="px-3 py-2.5 text-right">
          <span className="tnum text-sm font-bold text-slate-900 dark:text-slate-100">{group.total}</span>
        </td>
        <td className="px-4 py-2.5"><StatusPill status={group.status} /></td>
      </tr>

      {!single && open && group.items.map(item => {
        const total = totalStock(item);
        return (
          <tr key={item.sku} className="bg-slate-50/40 text-slate-600 dark:bg-slate-800/20 dark:text-slate-400">
            <td className="py-2 pl-12 pr-4">
              <p className="truncate text-sm font-medium text-slate-700 dark:text-slate-300">
                {item.variant_label || <span className="text-slate-400 italic">Unlabelled</span>}
              </p>
              <p className="truncate font-mono text-[11px] text-slate-400 dark:text-slate-500">
                {item.sku}
                {item.fba_inbound > 0 && (
                  <span
                    className="ml-2 font-sans font-semibold text-indigo-500 dark:text-indigo-400"
                    title="Units in transit to an Amazon fulfilment centre"
                  >
                    ↗ {item.fba_inbound} in transit
                  </span>
                )}
              </p>
            </td>
            <td className="px-3 py-2 text-right"><Num value={item.fba_quantity || 0} muted /></td>
            <td className="px-3 py-2 text-center">
              <StockAdjuster sku={item.sku} value={item.shop_stock || 0} onChange={onStock} />
            </td>
            {showShopify && <td className="px-3 py-2 text-right"><Num value={item.shopify_quantity || 0} muted /></td>}
            {showEbay && (
              <td className="px-3 py-2 text-right">
                <EbayQty value={item.ebay_quantity || 0} listings={item.ebay_listing_count || 0} />
              </td>
            )}
            <td className="px-3 py-2 text-right">
              <span className={`tnum text-sm font-semibold ${
                total === 0 ? 'text-red-500' : total <= LOW_STOCK_THRESHOLD ? 'text-amber-500' : 'text-slate-700 dark:text-slate-300'
              }`}>{total}</span>
            </td>
            <td className="px-4 py-2"><StatusPill status={statusOf(total)} /></td>
          </tr>
        );
      })}
    </>
  );
}
