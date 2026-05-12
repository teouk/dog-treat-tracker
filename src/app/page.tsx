'use client';
import { useEffect, useState, useMemo } from 'react';
import { useSession, signOut } from 'next-auth/react';
import Login from '@/components/Login';
import ThemeToggle from '@/components/ThemeToggle';

type InventoryItem = {
  sku: string;
  product_name: string;
  fba_quantity: number;
  fbm_quantity: number;
  shop_stock: number;
  shopify_quantity: number;
  on_amazon: boolean;
  on_shopify: boolean;
  last_sync_at: string | null;
  shopify_synced_at: string | null;
};

type StatusFilter = 'all' | 'in' | 'low' | 'out';
type Channel = 'all' | 'amazon' | 'shopify';

const LOW_STOCK_THRESHOLD = 10;

function statusOf(total: number): 'in' | 'low' | 'out' {
  if (total === 0) return 'out';
  if (total <= LOW_STOCK_THRESHOLD) return 'low';
  return 'in';
}

function channelTotal(item: InventoryItem, channel: Channel): number {
  const fba = item.fba_quantity || 0;
  const fbm = item.fbm_quantity || 0;
  const shop = item.shop_stock || 0;
  const shopify = item.shopify_quantity || 0;
  if (channel === 'amazon') return fba + fbm + shop;
  if (channel === 'shopify') return shopify;
  return fba + fbm + shop + shopify;
}

function ShopStockEditor({ value, onSave }: { value: number; onSave: (v: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));

  function commit() {
    const parsed = parseInt(draft, 10);
    if (!isNaN(parsed) && parsed >= 0) onSave(parsed);
    else setDraft(String(value));
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        type="number"
        min="0"
        autoFocus
        className="w-16 text-center font-semibold text-emerald-600 dark:text-emerald-400 border border-emerald-300 dark:border-emerald-700 bg-white dark:bg-slate-800 rounded-md py-0.5 text-sm outline-none focus:ring-2 focus:ring-emerald-400"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(String(value)); setEditing(false); } }}
      />
    );
  }

  return (
    <div className="inline-flex items-center gap-1.5">
      <button onClick={() => onSave(Math.max(0, value - 1))} className="w-6 h-6 rounded-md border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-700 dark:hover:text-slate-200 transition-colors flex items-center justify-center text-sm font-bold">-</button>
      <button
        onClick={() => { setDraft(String(value)); setEditing(true); }}
        className="font-semibold text-emerald-600 dark:text-emerald-400 w-8 text-center hover:bg-emerald-50 dark:hover:bg-emerald-900/30 rounded cursor-text"
        title="Click to set exact amount"
      >{value}</button>
      <button onClick={() => onSave(value + 1)} className="w-6 h-6 rounded-md border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-700 dark:hover:text-slate-200 transition-colors flex items-center justify-center text-sm font-bold">+</button>
    </div>
  );
}

function StockBadge({ total }: { total: number }) {
  const s = statusOf(total);
  if (s === 'out') return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400">Out of Stock</span>;
  if (s === 'low') return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400">Low Stock</span>;
  return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400">In Stock</span>;
}

function StatCard({ label, value, color, active, onClick }: { label: string; value: number; color: string; active: boolean; onClick: () => void }) {
  const base: Record<string, string> = {
    slate: 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100',
    emerald: 'bg-emerald-50 dark:bg-emerald-900/30 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400',
    amber: 'bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400',
    red: 'bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800 text-red-700 dark:text-red-400',
  };
  const ring: Record<string, string> = {
    slate: 'ring-slate-400 dark:ring-slate-500',
    emerald: 'ring-emerald-500',
    amber: 'ring-amber-500',
    red: 'ring-red-500',
  };
  return (
    <button
      onClick={onClick}
      className={`text-left rounded-2xl border p-4 transition-all hover:scale-[1.02] hover:shadow-md cursor-pointer ${base[color]} ${active ? `ring-2 ${ring[color]} shadow-md` : ''}`}
    >
      <p className="text-2xl font-black">{value}</p>
      <p className="text-xs font-semibold opacity-60 mt-0.5">{label}</p>
    </button>
  );
}

export default function InventoryDashboard() {
  const { status } = useSession();
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [shopifyLoading, setShopifyLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [syncStatus, setSyncStatus] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [channel, setChannel] = useState<Channel>('all');
  const [shopifyConnected, setShopifyConnected] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') {
      fetchInventory();
      checkShopifyStatus();
    }
  }, [status]);

  async function checkShopifyStatus() {
    try {
      const res = await fetch('/api/shopify/status');
      const data = await res.json();
      setShopifyConnected(!!data.connected);
    } catch {}
  }

  async function fetchInventory() {
    setFetching(true);
    const res = await fetch('/api/inventory');
    const data = await res.json();
    if (Array.isArray(data)) setInventory(data);
    setFetching(false);
  }

  async function triggerAmazonSync() {
    setLoading(true);
    setSyncStatus('Syncing Amazon... this may take up to a minute');
    try {
      let attempts = 0;
      while (attempts < 3) {
        attempts++;
        const res = await fetch('/api/sync/full');
        if (res.ok) {
          const result = await res.json();
          await fetchInventory();
          setSyncStatus(`Synced ${result.upserted || 0} Amazon products`);
          setTimeout(() => setSyncStatus(''), 4000);
          break;
        }
        if (res.status === 408) {
          setSyncStatus(`Amazon still preparing report... retry ${attempts}/3`);
          continue;
        }
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Sync failed');
      }
      if (attempts >= 3) {
        setSyncStatus('Amazon timed out. Try again in a minute.');
        setTimeout(() => setSyncStatus(''), 5000);
      }
    } catch (e: any) {
      setSyncStatus(e.message || 'Sync failed');
      setTimeout(() => setSyncStatus(''), 5000);
    }
    setLoading(false);
  }

  async function triggerShopifySync() {
    setShopifyLoading(true);
    setSyncStatus('Syncing Shopify...');
    try {
      const res = await fetch('/api/sync/shopify');
      if (res.ok) {
        const result = await res.json();
        await fetchInventory();
        setSyncStatus(`Synced ${result.upserted || 0} Shopify variants${result.inserted ? ` (${result.inserted} new)` : ''}`);
        setTimeout(() => setSyncStatus(''), 4000);
      } else {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Sync failed');
      }
    } catch (e: any) {
      setSyncStatus(e.message || 'Sync failed');
      setTimeout(() => setSyncStatus(''), 5000);
    }
    setShopifyLoading(false);
  }

  async function disconnectShopify() {
    if (!confirm('Disconnect Shopify? You will need to re-authorize to sync again.')) return;
    await fetch('/api/shopify/disconnect', { method: 'POST' });
    setShopifyConnected(false);
  }

  async function setShopStock(sku: string, newStock: number) {
    setInventory(prev => prev.map(i => i.sku === sku ? { ...i, shop_stock: newStock } : i));
    await fetch(`/api/inventory/${encodeURIComponent(sku)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shop_stock: newStock }),
    });
  }

  // Filter by channel membership first
  const channelItems = useMemo(() => {
    if (channel === 'amazon') return inventory.filter(i => i.on_amazon !== false);
    if (channel === 'shopify') return inventory.filter(i => i.on_shopify === true);
    return inventory;
  }, [inventory, channel]);

  const stats = useMemo(() => {
    let inStock = 0, lowStock = 0, outOfStock = 0;
    for (const item of channelItems) {
      const s = statusOf(channelTotal(item, channel));
      if (s === 'out') outOfStock++;
      else if (s === 'low') lowStock++;
      else inStock++;
    }
    return { total: channelItems.length, inStock, lowStock, outOfStock };
  }, [channelItems, channel]);

  const lastSync = useMemo(() => {
    const field = channel === 'shopify' ? 'shopify_synced_at' : 'last_sync_at';
    const dates = inventory.map(i => i[field as 'last_sync_at']).filter(Boolean) as string[];
    if (dates.length === 0) return null;
    return new Date(Math.max(...dates.map(d => new Date(d).getTime())));
  }, [inventory, channel]);

  const filtered = useMemo(() => {
    let items = channelItems.slice();

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      items = items.filter(i =>
        (i.product_name || '').toLowerCase().includes(q) ||
        i.sku.toLowerCase().includes(q)
      );
    }

    if (statusFilter !== 'all') {
      items = items.filter(i => statusOf(channelTotal(i, channel)) === statusFilter);
    }

    const order = { in: 0, low: 1, out: 2 } as const;
    items.sort((a, b) => {
      const oa = order[statusOf(channelTotal(a, channel))];
      const ob = order[statusOf(channelTotal(b, channel))];
      if (oa !== ob) return oa - ob;
      return (a.product_name || a.sku).localeCompare(b.product_name || b.sku);
    });

    return items;
  }, [channelItems, searchQuery, statusFilter, channel]);

  if (status === 'loading') return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950">
      <div className="w-6 h-6 border-2 border-slate-300 dark:border-slate-700 border-t-slate-800 dark:border-t-slate-200 rounded-full animate-spin" />
    </div>
  );
  if (status === 'unauthenticated') return <Login />;

  const showAmazonCols = channel !== 'shopify';
  const showShopifyCol = channel !== 'amazon';

  const channelTabs: Array<{ key: Channel; label: string; icon: string }> = [
    { key: 'all', label: 'All Channels', icon: '🌐' },
    { key: 'amazon', label: 'Amazon', icon: '📦' },
    { key: 'shopify', label: 'Shopify', icon: '🛍️' },
  ];

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* Header */}
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="text-base sm:text-lg font-black tracking-tight text-slate-900 dark:text-slate-100 truncate">
              Glorious Treats <span className="text-blue-600 dark:text-blue-400">&amp; Chews</span> Inventory
            </h1>
            {syncStatus && (
              <span className="hidden xl:inline text-xs font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 px-2.5 py-1 rounded-full whitespace-nowrap">
                {syncStatus}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Amazon Sync */}
            {(channel === 'all' || channel === 'amazon') && (
              <button
                onClick={triggerAmazonSync}
                disabled={loading}
                className="flex items-center gap-1.5 bg-orange-600 text-white px-3 sm:px-4 py-2 rounded-lg font-semibold text-sm hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title="Sync Amazon inventory"
              >
                {loading ? (
                  <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> <span className="hidden sm:inline">Amazon...</span></>
                ) : (
                  <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg> <span className="hidden sm:inline">Amazon</span></>
                )}
              </button>
            )}

            {/* Shopify Sync / Connect */}
            {(channel === 'all' || channel === 'shopify') && (
              shopifyConnected ? (
                <button
                  onClick={triggerShopifySync}
                  disabled={shopifyLoading}
                  className="flex items-center gap-1.5 bg-emerald-600 text-white px-3 sm:px-4 py-2 rounded-lg font-semibold text-sm hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  title="Sync Shopify inventory"
                >
                  {shopifyLoading ? (
                    <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> <span className="hidden sm:inline">Shopify...</span></>
                  ) : (
                    <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg> <span className="hidden sm:inline">Shopify</span></>
                  )}
                </button>
              ) : (
                <a
                  href="/api/shopify/install"
                  className="flex items-center gap-1.5 bg-emerald-600 text-white px-3 sm:px-4 py-2 rounded-lg font-semibold text-sm hover:bg-emerald-700 transition-colors"
                  title="Connect Shopify store"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                  <span className="hidden sm:inline">Connect Shopify</span>
                </a>
              )
            )}

            <ThemeToggle />
            <button
              onClick={() => signOut()}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title="Sign out"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
            </button>
          </div>
        </div>
        {syncStatus && (
          <div className="xl:hidden bg-blue-50 dark:bg-blue-900/30 px-4 py-2 text-xs font-medium text-blue-600 dark:text-blue-400 text-center">
            {syncStatus}
          </div>
        )}
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {/* Channel Selector */}
        <div className="flex gap-2 bg-white dark:bg-slate-900 p-1.5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
          {channelTabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => { setChannel(tab.key); setStatusFilter('all'); }}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold transition-all ${
                channel === tab.key
                  ? 'bg-blue-600 text-white shadow-md'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <span>{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Shopify connection notice (in Shopify mode but not connected) */}
        {channel === 'shopify' && !shopifyConnected && (
          <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-xl p-5 text-center">
            <p className="text-emerald-800 dark:text-emerald-300 font-semibold mb-2">Shopify is not connected yet</p>
            <p className="text-sm text-emerald-700 dark:text-emerald-400 mb-4">Connect your Shopify store to sync inventory.</p>
            <a
              href="/api/shopify/install"
              className="inline-flex items-center gap-2 bg-emerald-600 text-white px-4 py-2 rounded-lg font-semibold text-sm hover:bg-emerald-700 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
              Connect Shopify
            </a>
          </div>
        )}

        {/* Stats Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Total Products" value={stats.total} color="slate" active={statusFilter === 'all'} onClick={() => setStatusFilter('all')} />
          <StatCard label="In Stock" value={stats.inStock} color="emerald" active={statusFilter === 'in'} onClick={() => setStatusFilter('in')} />
          <StatCard label="Low Stock" value={stats.lowStock} color="amber" active={statusFilter === 'low'} onClick={() => setStatusFilter('low')} />
          <StatCard label="Out of Stock" value={stats.outOfStock} color="red" active={statusFilter === 'out'} onClick={() => setStatusFilter('out')} />
        </div>

        {/* Search */}
        <div className="relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
          <input
            type="text"
            placeholder="Search by product name or SKU..."
            className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          )}
        </div>

        {/* Last sync + disconnect link */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          {lastSync ? (
            <p className="text-xs text-slate-400 dark:text-slate-500">
              Last {channel === 'shopify' ? 'Shopify' : 'Amazon'} sync: {lastSync.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} at {lastSync.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
            </p>
          ) : <span />}
          {channel === 'shopify' && shopifyConnected && (
            <button onClick={disconnectShopify} className="text-xs text-slate-400 hover:text-red-500 transition-colors">
              Disconnect Shopify
            </button>
          )}
        </div>

        {/* Inventory Table — Desktop */}
        <div className="hidden md:block bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50">
                <th className="text-left py-3 px-4 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider">Product</th>
                {showAmazonCols && <th className="text-center py-3 px-3 font-semibold text-orange-500 dark:text-orange-400 text-xs uppercase tracking-wider">FBA</th>}
                {showAmazonCols && <th className="text-center py-3 px-3 font-semibold text-blue-500 dark:text-blue-400 text-xs uppercase tracking-wider">FBM</th>}
                {showAmazonCols && <th className="text-center py-3 px-3 font-semibold text-emerald-500 dark:text-emerald-400 text-xs uppercase tracking-wider">Shop</th>}
                {showShopifyCol && <th className="text-center py-3 px-3 font-semibold text-fuchsia-500 dark:text-fuchsia-400 text-xs uppercase tracking-wider">Shopify</th>}
                <th className="text-center py-3 px-3 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider">Total</th>
                <th className="text-center py-3 px-3 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
              {filtered.map(item => {
                const total = channelTotal(item, channel);
                const name = item.product_name?.trim();
                return (
                  <tr key={item.sku} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/50 transition-colors">
                    <td className="py-3 px-4">
                      {name ? (
                        <>
                          <p className="font-semibold text-slate-800 dark:text-slate-200 leading-tight">{name}</p>
                          <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5 font-mono">{item.sku}</p>
                        </>
                      ) : (
                        <p className="font-semibold text-slate-800 dark:text-slate-200 leading-tight font-mono">{item.sku}</p>
                      )}
                    </td>
                    {showAmazonCols && <td className="text-center py-3 px-3"><span className="font-semibold text-orange-600 dark:text-orange-400">{item.fba_quantity || 0}</span></td>}
                    {showAmazonCols && <td className="text-center py-3 px-3"><span className="font-semibold text-blue-600 dark:text-blue-400">{item.fbm_quantity || 0}</span></td>}
                    {showAmazonCols && <td className="text-center py-3 px-3"><ShopStockEditor value={item.shop_stock || 0} onSave={(v) => setShopStock(item.sku, v)} /></td>}
                    {showShopifyCol && <td className="text-center py-3 px-3"><span className="font-semibold text-fuchsia-600 dark:text-fuchsia-400">{item.shopify_quantity || 0}</span></td>}
                    <td className="text-center py-3 px-3">
                      <span className={`font-bold text-lg ${total === 0 ? 'text-red-500' : total <= LOW_STOCK_THRESHOLD ? 'text-amber-500' : 'text-slate-800 dark:text-slate-200'}`}>
                        {total}
                      </span>
                    </td>
                    <td className="text-center py-3 px-3">
                      <StockBadge total={total} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="py-12 text-center text-slate-400 dark:text-slate-500 text-sm">
              {fetching ? 'Loading inventory...' : channelItems.length === 0 ? `No ${channel === 'all' ? '' : channel + ' '}products yet.` : 'No products match your search.'}
            </div>
          )}
        </div>

        {/* Inventory Cards — Mobile */}
        <div className="md:hidden space-y-3">
          {filtered.map(item => {
            const total = channelTotal(item, channel);
            const name = item.product_name?.trim();
            return (
              <div key={item.sku} className={`bg-white dark:bg-slate-900 rounded-xl border p-4 ${total === 0 ? 'border-red-200 dark:border-red-800' : total <= LOW_STOCK_THRESHOLD ? 'border-amber-200 dark:border-amber-800' : 'border-slate-200 dark:border-slate-800'}`}>
                <div className="flex justify-between items-start mb-3">
                  <div className="flex-1 min-w-0 mr-3">
                    {name ? (
                      <>
                        <p className="font-semibold text-slate-800 dark:text-slate-200 text-sm leading-tight truncate">{name}</p>
                        <p className="text-xs text-slate-400 dark:text-slate-500 font-mono mt-0.5">{item.sku}</p>
                      </>
                    ) : (
                      <p className="font-semibold text-slate-800 dark:text-slate-200 text-sm leading-tight truncate font-mono">{item.sku}</p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <p className={`text-2xl font-black ${total === 0 ? 'text-red-500' : total <= LOW_STOCK_THRESHOLD ? 'text-amber-500' : 'text-slate-800 dark:text-slate-200'}`}>{total}</p>
                    <StockBadge total={total} />
                  </div>
                </div>
                <div className={`grid gap-2 text-center ${channel === 'all' ? 'grid-cols-4' : channel === 'amazon' ? 'grid-cols-3' : 'grid-cols-1'}`}>
                  {showAmazonCols && (
                    <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg py-2">
                      <p className="text-[10px] font-bold text-orange-400 uppercase">FBA</p>
                      <p className="font-bold text-orange-700 dark:text-orange-400 text-sm">{item.fba_quantity || 0}</p>
                    </div>
                  )}
                  {showAmazonCols && (
                    <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg py-2">
                      <p className="text-[10px] font-bold text-blue-400 uppercase">FBM</p>
                      <p className="font-bold text-blue-700 dark:text-blue-400 text-sm">{item.fbm_quantity || 0}</p>
                    </div>
                  )}
                  {showAmazonCols && (
                    <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-lg py-2">
                      <p className="text-[10px] font-bold text-emerald-400 uppercase">Shop</p>
                      <div className="flex items-center justify-center mt-0.5">
                        <ShopStockEditor value={item.shop_stock || 0} onSave={(v) => setShopStock(item.sku, v)} />
                      </div>
                    </div>
                  )}
                  {showShopifyCol && (
                    <div className="bg-fuchsia-50 dark:bg-fuchsia-900/20 rounded-lg py-2">
                      <p className="text-[10px] font-bold text-fuchsia-400 uppercase">Shopify</p>
                      <p className="font-bold text-fuchsia-700 dark:text-fuchsia-400 text-sm">{item.shopify_quantity || 0}</p>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="py-12 text-center text-slate-400 dark:text-slate-500 text-sm">
              {fetching ? 'Loading inventory...' : channelItems.length === 0 ? `No ${channel === 'all' ? '' : channel + ' '}products yet.` : 'No products match your search.'}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
