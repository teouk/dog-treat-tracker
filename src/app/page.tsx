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
  last_sync_at: string | null;
};

const LOW_STOCK_THRESHOLD = 10;

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
  if (total === 0) return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400">Out of Stock</span>;
  if (total <= LOW_STOCK_THRESHOLD) return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400">Low Stock</span>;
  return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400">In Stock</span>;
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  const colors: Record<string, string> = {
    slate: 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100',
    emerald: 'bg-emerald-50 dark:bg-emerald-900/30 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400',
    amber: 'bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400',
    red: 'bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800 text-red-700 dark:text-red-400',
  };
  return (
    <div className={`rounded-2xl border p-4 ${colors[color]}`}>
      <p className="text-2xl font-black">{value}</p>
      <p className="text-xs font-semibold opacity-60 mt-0.5">{label}</p>
    </div>
  );
}

export default function InventoryDashboard() {
  const { data: session, status } = useSession();
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [syncStatus, setSyncStatus] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'low' | 'out'>('all');

  useEffect(() => {
    if (status === 'authenticated') fetchInventory();
  }, [status]);

  async function fetchInventory() {
    setFetching(true);
    const res = await fetch('/api/inventory');
    const data = await res.json();
    if (Array.isArray(data)) setInventory(data);
    setFetching(false);
  }

  async function triggerSync() {
    setLoading(true);
    setSyncStatus('Requesting report from Amazon...');
    try {
      const start = await fetch('/api/sync/start').then(r => r.json());
      if (!start.reportId) { setSyncStatus(''); setLoading(false); return; }

      let ready = false;
      let docId = '';
      for (let i = 0; i < 20; i++) {
        setSyncStatus(`Waiting for Amazon... (${i + 1}/20)`);
        await new Promise(r => setTimeout(r, 3000));
        const check = await fetch(`/api/sync/check?reportId=${start.reportId}`).then(r => r.json());
        if (check.ready) { ready = true; docId = check.reportDocumentId; break; }
      }

      if (ready) {
        setSyncStatus('Downloading inventory data...');
        const result = await fetch(`/api/sync/download?reportDocumentId=${docId}`).then(r => r.json());
        await fetchInventory();
        setSyncStatus(`Synced ${result.upserted || 0} products`);
        setTimeout(() => setSyncStatus(''), 4000);
      } else {
        setSyncStatus('Amazon timed out. Try again in 2 minutes.');
        setTimeout(() => setSyncStatus(''), 5000);
      }
    } catch {
      setSyncStatus('Sync failed. Check console for details.');
      setTimeout(() => setSyncStatus(''), 5000);
    }
    setLoading(false);
  }

  async function setShopStock(sku: string, newStock: number) {
    setInventory(prev => prev.map(i => i.sku === sku ? { ...i, shop_stock: newStock } : i));
    await fetch(`/api/inventory/${encodeURIComponent(sku)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shop_stock: newStock }),
    });
  }

  const stats = useMemo(() => {
    let inStock = 0, lowStock = 0, outOfStock = 0;
    for (const item of inventory) {
      const qty = (item.fba_quantity || 0) + (item.fbm_quantity || 0) + (item.shop_stock || 0);
      if (qty === 0) outOfStock++;
      else if (qty <= LOW_STOCK_THRESHOLD) lowStock++;
      else inStock++;
    }
    return { total: inventory.length, inStock, lowStock, outOfStock };
  }, [inventory]);

  const lastSync = useMemo(() => {
    const dates = inventory.map(i => i.last_sync_at).filter(Boolean) as string[];
    if (dates.length === 0) return null;
    return new Date(Math.max(...dates.map(d => new Date(d).getTime())));
  }, [inventory]);

  const filtered = useMemo(() => {
    let items = inventory;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      items = items.filter(i =>
        (i.product_name || '').toLowerCase().includes(q) ||
        i.sku.toLowerCase().includes(q)
      );
    }
    if (filter === 'low') {
      items = items.filter(i => {
        const t = (i.fba_quantity || 0) + (i.fbm_quantity || 0) + (i.shop_stock || 0);
        return t > 0 && t <= LOW_STOCK_THRESHOLD;
      });
    } else if (filter === 'out') {
      items = items.filter(i => {
        const t = (i.fba_quantity || 0) + (i.fbm_quantity || 0) + (i.shop_stock || 0);
        return t === 0;
      });
    }
    return items;
  }, [inventory, searchQuery, filter]);

  if (status === 'loading') return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950">
      <div className="w-6 h-6 border-2 border-slate-300 dark:border-slate-700 border-t-slate-800 dark:border-t-slate-200 rounded-full animate-spin" />
    </div>
  );
  if (status === 'unauthenticated') return <Login />;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* Header */}
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-black tracking-tight text-slate-900 dark:text-slate-100">
              Treat Tracker <span className="text-blue-600 dark:text-blue-400">Pro</span>
            </h1>
            {syncStatus && (
              <span className="hidden sm:inline text-xs font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 px-2.5 py-1 rounded-full">
                {syncStatus}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={triggerSync}
              disabled={loading}
              className="flex items-center gap-1.5 bg-blue-600 text-white px-4 py-2 rounded-lg font-semibold text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? (
                <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Syncing...</>
              ) : (
                <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg> Sync Amazon</>
              )}
            </button>
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
          <div className="sm:hidden bg-blue-50 dark:bg-blue-900/30 px-4 py-2 text-xs font-medium text-blue-600 dark:text-blue-400 text-center">
            {syncStatus}
          </div>
        )}
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {/* Stats Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Total Products" value={stats.total} color="slate" />
          <StatCard label="In Stock" value={stats.inStock} color="emerald" />
          <StatCard label="Low Stock" value={stats.lowStock} color="amber" />
          <StatCard label="Out of Stock" value={stats.outOfStock} color="red" />
        </div>

        {/* Search & Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
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
          <div className="flex gap-1.5 bg-slate-100 dark:bg-slate-800 p-1 rounded-lg self-start">
            {([['all', 'All'], ['low', 'Low Stock'], ['out', 'No Stock']] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                  filter === key ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Last sync info */}
        {lastSync && (
          <p className="text-xs text-slate-400 dark:text-slate-500">
            Last synced: {lastSync.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} at {lastSync.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
          </p>
        )}

        {/* Inventory Table — Desktop */}
        <div className="hidden md:block bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50">
                <th className="text-left py-3 px-4 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider">Product</th>
                <th className="text-center py-3 px-3 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider">Amazon FBA</th>
                <th className="text-center py-3 px-3 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider">Amazon FBM</th>
                <th className="text-center py-3 px-3 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider">Shop</th>
                <th className="text-center py-3 px-3 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider">Total</th>
                <th className="text-center py-3 px-3 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
              {filtered.map(item => {
                const total = (item.fba_quantity || 0) + (item.fbm_quantity || 0) + (item.shop_stock || 0);
                return (
                  <tr key={item.sku} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/50 transition-colors">
                    <td className="py-3 px-4">
                      <p className="font-semibold text-slate-800 dark:text-slate-200 leading-tight">{item.product_name || '—'}</p>
                      <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5 font-mono">{item.sku}</p>
                    </td>
                    <td className="text-center py-3 px-3">
                      <span className="font-semibold text-orange-600 dark:text-orange-400">{item.fba_quantity || 0}</span>
                    </td>
                    <td className="text-center py-3 px-3">
                      <span className="font-semibold text-blue-600 dark:text-blue-400">{item.fbm_quantity || 0}</span>
                    </td>
                    <td className="text-center py-3 px-3">
                      <ShopStockEditor value={item.shop_stock || 0} onSave={(v) => setShopStock(item.sku, v)} />
                    </td>
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
              {fetching ? 'Loading inventory...' : inventory.length === 0 ? 'No products yet. Click "Sync Amazon" to import your inventory.' : 'No products match your search.'}
            </div>
          )}
        </div>

        {/* Inventory Cards — Mobile */}
        <div className="md:hidden space-y-3">
          {filtered.map(item => {
            const total = (item.fba_quantity || 0) + (item.fbm_quantity || 0) + (item.shop_stock || 0);
            return (
              <div key={item.sku} className={`bg-white dark:bg-slate-900 rounded-xl border p-4 ${total === 0 ? 'border-red-200 dark:border-red-800' : total <= LOW_STOCK_THRESHOLD ? 'border-amber-200 dark:border-amber-800' : 'border-slate-200 dark:border-slate-800'}`}>
                <div className="flex justify-between items-start mb-3">
                  <div className="flex-1 min-w-0 mr-3">
                    <p className="font-semibold text-slate-800 dark:text-slate-200 text-sm leading-tight truncate">{item.product_name || '—'}</p>
                    <p className="text-xs text-slate-400 dark:text-slate-500 font-mono mt-0.5">{item.sku}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className={`text-2xl font-black ${total === 0 ? 'text-red-500' : total <= LOW_STOCK_THRESHOLD ? 'text-amber-500' : 'text-slate-800 dark:text-slate-200'}`}>{total}</p>
                    <StockBadge total={total} />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg py-2">
                    <p className="text-[10px] font-bold text-orange-400 uppercase">FBA</p>
                    <p className="font-bold text-orange-700 dark:text-orange-400 text-sm">{item.fba_quantity || 0}</p>
                  </div>
                  <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg py-2">
                    <p className="text-[10px] font-bold text-blue-400 uppercase">FBM</p>
                    <p className="font-bold text-blue-700 dark:text-blue-400 text-sm">{item.fbm_quantity || 0}</p>
                  </div>
                  <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-lg py-2">
                    <p className="text-[10px] font-bold text-emerald-400 uppercase">Shop</p>
                    <div className="flex items-center justify-center mt-0.5">
                      <ShopStockEditor value={item.shop_stock || 0} onSave={(v) => setShopStock(item.sku, v)} />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="py-12 text-center text-slate-400 dark:text-slate-500 text-sm">
              {fetching ? 'Loading inventory...' : inventory.length === 0 ? 'No products yet. Tap "Sync Amazon" to import your inventory.' : 'No products match your search.'}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
