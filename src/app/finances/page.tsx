'use client';
import { useEffect, useMemo, useState } from 'react';
import { useSession, signOut } from 'next-auth/react';
import Login from '@/components/Login';
import ThemeToggle from '@/components/ThemeToggle';
import Nav from '@/components/Nav';

type Tab = 'sales' | 'purchases' | 'pricing';
type RangePreset = '7d' | '30d' | '90d' | 'year' | 'custom';

type Sale = {
  id: string;
  channel: 'amazon' | 'shopify' | 'manual';
  external_order_id: string | null;
  sku: string;
  quantity: number;
  unit_price: number;
  total_revenue: number;
  sale_date: string;
  notes: string | null;
};
type Purchase = {
  id: string;
  sku: string;
  quantity: number;
  unit_cost: number;
  total_cost: number;
  purchase_date: string;
  supplier: string | null;
  notes: string | null;
};
type InventoryItem = {
  sku: string;
  product_name: string;
  amazon_price: number | null;
  shopify_price: number | null;
  unit_cost: number | null;
  on_amazon: boolean;
  on_shopify: boolean;
};
type Summary = {
  revenue: number;
  costOfUnitsSold: number;
  purchaseSpend: number;
  profit: number;
  margin: number;
  unitsSold: number;
  byChannel: Record<string, { revenue: number; costOfUnitsSold: number; quantity: number }>;
};

function rangeToDates(preset: RangePreset, customFrom?: string, customTo?: string): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString();
  if (preset === 'custom' && customFrom && customTo) {
    return {
      from: new Date(customFrom).toISOString(),
      to: new Date(new Date(customTo).getTime() + 24 * 60 * 60 * 1000 - 1).toISOString(),
    };
  }
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : preset === '90d' ? 90 : 365;
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  return { from, to };
}

function formatMoney(n: number): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n);
}
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function SummaryCard({ label, value, color, hint }: { label: string; value: string; color: string; hint?: string }) {
  const base: Record<string, string> = {
    emerald: 'bg-emerald-50 dark:bg-emerald-900/30 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400',
    amber: 'bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400',
    blue: 'bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-400',
    slate: 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100',
    fuchsia: 'bg-fuchsia-50 dark:bg-fuchsia-900/30 border-fuchsia-200 dark:border-fuchsia-800 text-fuchsia-700 dark:text-fuchsia-400',
  };
  return (
    <div className={`rounded-2xl border p-4 ${base[color]}`}>
      <p className="text-xl sm:text-2xl font-black">{value}</p>
      <p className="text-xs font-semibold opacity-70 mt-0.5">{label}</p>
      {hint && <p className="text-[11px] opacity-50 mt-1 leading-tight">{hint}</p>}
    </div>
  );
}

function PriceEditor({ value, onSave }: { value: number | null; onSave: (v: number | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value !== null ? String(value) : '');

  useEffect(() => { setDraft(value !== null ? String(value) : ''); }, [value]);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed === '') { onSave(null); setEditing(false); return; }
    const parsed = parseFloat(trimmed);
    if (!isNaN(parsed) && parsed >= 0) onSave(+parsed.toFixed(2));
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        type="number"
        step="0.01"
        min="0"
        autoFocus
        className="w-20 text-right font-mono text-sm border border-blue-300 dark:border-blue-700 bg-white dark:bg-slate-800 rounded-md px-1.5 py-0.5 outline-none focus:ring-2 focus:ring-blue-400"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(value !== null ? String(value) : ''); setEditing(false); } }}
      />
    );
  }
  return (
    <button
      onClick={() => setEditing(true)}
      className="font-mono text-sm text-slate-700 dark:text-slate-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded px-1.5 py-0.5 transition-colors min-w-[60px] text-right cursor-text"
      title="Click to edit"
    >
      {value !== null ? formatMoney(value) : <span className="text-slate-400 italic">set</span>}
    </button>
  );
}

export default function FinancesPage() {
  const { status } = useSession();
  const [tab, setTab] = useState<Tab>('sales');
  const [preset, setPreset] = useState<RangePreset>('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [sales, setSales] = useState<Sale[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [pricingSearch, setPricingSearch] = useState('');
  const [showAddSale, setShowAddSale] = useState(false);
  const [showAddPurchase, setShowAddPurchase] = useState(false);

  const { from, to } = useMemo(() => rangeToDates(preset, customFrom, customTo), [preset, customFrom, customTo]);

  useEffect(() => {
    if (status === 'authenticated') reloadAll();
  }, [status, from, to]);

  async function reloadAll() {
    try {
      const [sumRes, salesRes, purchRes, invRes] = await Promise.all([
        fetch(`/api/finances/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
        fetch(`/api/sales?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
        fetch(`/api/purchases?from=${encodeURIComponent(from.split('T')[0])}&to=${encodeURIComponent(to.split('T')[0])}`),
        fetch('/api/inventory'),
      ]);
      if (sumRes.ok) setSummary(await sumRes.json());
      if (salesRes.ok) setSales(await salesRes.json());
      if (purchRes.ok) setPurchases(await purchRes.json());
      if (invRes.ok) setInventory(await invRes.json());
    } catch {}
  }

  async function syncAmazonSales() {
    setBusy(true);
    setMsg('Requesting Amazon orders report...');
    try {
      let pendingReportId = '';
      let completed = false;
      for (let i = 0; i < 5; i++) {
        const res = await fetch('/api/sales/sync/amazon', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to, reportId: pendingReportId || undefined }),
        });
        if (res.ok) {
          const r = await res.json();
          setMsg(`Imported ${r.inserted} new Amazon sales (${r.lineCount} line items)`);
          completed = true;
          break;
        }
        if (res.status === 408) {
          const r = await res.json();
          pendingReportId = r.reportId || pendingReportId;
          setMsg(`Amazon still preparing report... continuing (${i + 1}/5)`);
          continue;
        }
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Sync failed');
      }
      if (!completed) setMsg('Amazon report took too long. Try again in a few minutes.');
      await reloadAll();
    } catch (e: any) {
      setMsg(e.message || 'Sync failed');
    }
    setTimeout(() => setMsg(''), 5000);
    setBusy(false);
  }

  async function syncShopifySales() {
    setBusy(true);
    setMsg('Syncing Shopify orders...');
    try {
      const res = await fetch('/api/sales/sync/shopify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to }),
      });
      if (res.ok) {
        const r = await res.json();
        setMsg(`Imported ${r.inserted} new Shopify sales (${r.ordersFetched} orders, ${r.lineItemsProcessed} line items)`);
      } else {
        const err = await res.json().catch(() => ({}));
        if (err.error === 'RECONNECT_REQUIRED') {
          setMsg('Reconnect Shopify to grant order permissions — see Inventory page.');
        } else {
          throw new Error(err.message || err.error || 'Sync failed');
        }
      }
      await reloadAll();
    } catch (e: any) {
      setMsg(e.message || 'Sync failed');
    }
    setTimeout(() => setMsg(''), 6000);
    setBusy(false);
  }

  async function deleteSale(id: string) {
    if (!confirm('Delete this sale?')) return;
    await fetch(`/api/sales/${id}`, { method: 'DELETE' });
    reloadAll();
  }
  async function deletePurchase(id: string) {
    if (!confirm('Delete this purchase?')) return;
    await fetch(`/api/purchases/${id}`, { method: 'DELETE' });
    reloadAll();
  }
  async function updatePrice(sku: string, field: 'amazon_price' | 'shopify_price' | 'unit_cost', value: number | null) {
    setInventory(prev => prev.map(i => i.sku === sku ? { ...i, [field]: value } : i));
    await fetch(`/api/inventory/${encodeURIComponent(sku)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    });
  }

  if (status === 'loading') return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950">
      <div className="w-6 h-6 border-2 border-slate-300 dark:border-slate-700 border-t-slate-800 dark:border-t-slate-200 rounded-full animate-spin" />
    </div>
  );
  if (status === 'unauthenticated') return <Login />;

  const filteredInventory = pricingSearch
    ? inventory.filter(i =>
        (i.product_name || '').toLowerCase().includes(pricingSearch.toLowerCase()) ||
        i.sku.toLowerCase().includes(pricingSearch.toLowerCase()))
    : inventory;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-4 min-w-0">
            <h1 className="text-base sm:text-lg font-black tracking-tight text-slate-900 dark:text-slate-100 truncate">
              Glorious Treats <span className="text-blue-600 dark:text-blue-400">&amp; Chews</span>
            </h1>
            <Nav />
          </div>
          <div className="flex items-center gap-2 shrink-0">
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
        {msg && (
          <div className="bg-blue-50 dark:bg-blue-900/30 px-4 py-2 text-xs font-medium text-blue-600 dark:text-blue-400 text-center">
            {msg}
          </div>
        )}
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* Date range selector */}
        <div className="flex flex-wrap items-center gap-2 bg-white dark:bg-slate-900 p-2 rounded-xl border border-slate-200 dark:border-slate-800">
          {(['7d', '30d', '90d', 'year', 'custom'] as RangePreset[]).map(p => (
            <button
              key={p}
              onClick={() => setPreset(p)}
              className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
                preset === p
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {p === '7d' ? 'Last 7 days' : p === '30d' ? 'Last 30 days' : p === '90d' ? 'Last 90 days' : p === 'year' ? 'Last year' : 'Custom'}
            </button>
          ))}
          {preset === 'custom' && (
            <div className="flex items-center gap-2 ml-2">
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="text-sm px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100" />
              <span className="text-slate-400">→</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className="text-sm px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100" />
            </div>
          )}
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <SummaryCard label="Revenue" value={formatMoney(summary?.revenue || 0)} color="emerald" hint="Money in from sales" />
          <SummaryCard label="Cost of Units Sold" value={formatMoney(summary?.costOfUnitsSold || 0)} color="amber" hint="Sold qty × unit cost" />
          <SummaryCard label="Gross Profit" value={formatMoney(summary?.profit || 0)} color="blue" hint="Revenue − cost" />
          <SummaryCard label="Margin" value={`${(summary?.margin || 0).toFixed(1)}%`} color="slate" hint={`${summary?.unitsSold || 0} units sold`} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <SummaryCard label="Purchase Spend (this period)" value={formatMoney(summary?.purchaseSpend || 0)} color="fuchsia" hint="Actual cash out on restocks" />
          <SummaryCard label="Amazon Revenue" value={formatMoney(summary?.byChannel?.amazon?.revenue || 0)} color="emerald" hint={`${summary?.byChannel?.amazon?.quantity || 0} units`} />
          <SummaryCard label="Shopify Revenue" value={formatMoney(summary?.byChannel?.shopify?.revenue || 0)} color="emerald" hint={`${summary?.byChannel?.shopify?.quantity || 0} units`} />
        </div>

        {/* Tab selector */}
        <div className="flex gap-2 bg-white dark:bg-slate-900 p-1.5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
          {(['sales', 'purchases', 'pricing'] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 px-3 py-2.5 rounded-lg text-sm font-semibold transition-all ${
                tab === t
                  ? 'bg-blue-600 text-white shadow-md'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {t === 'sales' ? '💷 Sales' : t === 'purchases' ? '📥 Purchases' : '🏷️ Pricing'}
            </button>
          ))}
        </div>

        {/* Sales tab */}
        {tab === 'sales' && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2 justify-end">
              <button onClick={syncAmazonSales} disabled={busy} className="bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white text-sm font-semibold px-3 py-2 rounded-lg transition-colors">
                Sync Amazon Sales
              </button>
              <button onClick={syncShopifySales} disabled={busy} className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-semibold px-3 py-2 rounded-lg transition-colors">
                Sync Shopify Sales
              </button>
              <button onClick={() => setShowAddSale(true)} className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-3 py-2 rounded-lg transition-colors">
                + Add Manual Sale
              </button>
            </div>
            <SalesTable sales={sales} onDelete={deleteSale} />
          </div>
        )}

        {/* Purchases tab */}
        {tab === 'purchases' && (
          <div className="space-y-3">
            <div className="flex justify-end">
              <button onClick={() => setShowAddPurchase(true)} className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-3 py-2 rounded-lg transition-colors">
                + Add Purchase
              </button>
            </div>
            <PurchasesTable purchases={purchases} onDelete={deletePurchase} />
          </div>
        )}

        {/* Pricing tab */}
        {tab === 'pricing' && (
          <div className="space-y-3">
            <input
              type="text"
              placeholder="Search SKU or product name..."
              value={pricingSearch}
              onChange={e => setPricingSearch(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-blue-500"
            />
            <PricingTable items={filteredInventory} onUpdate={updatePrice} />
          </div>
        )}
      </main>

      {showAddSale && <AddSaleModal onClose={() => setShowAddSale(false)} onSaved={() => { setShowAddSale(false); reloadAll(); }} />}
      {showAddPurchase && <AddPurchaseModal onClose={() => setShowAddPurchase(false)} onSaved={() => { setShowAddPurchase(false); reloadAll(); }} />}
    </div>
  );
}

function SalesTable({ sales, onDelete }: { sales: Sale[]; onDelete: (id: string) => void }) {
  if (sales.length === 0) {
    return <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-12 text-center text-slate-400 dark:text-slate-500 text-sm">No sales in this date range yet. Click "Sync Amazon Sales" or "Sync Shopify Sales" above to import.</div>;
  }
  const channelBadge = (channel: string) => {
    const map: Record<string, string> = {
      amazon: 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400',
      shopify: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400',
      manual: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300',
    };
    return map[channel] || map.manual;
  };
  return (
    <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50">
              <th className="text-left py-3 px-4 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider">Date</th>
              <th className="text-left py-3 px-3 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider">Channel</th>
              <th className="text-left py-3 px-3 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider">SKU</th>
              <th className="text-right py-3 px-3 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider">Qty</th>
              <th className="text-right py-3 px-3 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider">Unit Price</th>
              <th className="text-right py-3 px-3 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider">Revenue</th>
              <th className="py-3 px-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
            {sales.map(s => (
              <tr key={s.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/50">
                <td className="py-2.5 px-4 whitespace-nowrap text-slate-700 dark:text-slate-300">{formatDate(s.sale_date)}</td>
                <td className="py-2.5 px-3"><span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${channelBadge(s.channel)}`}>{s.channel}</span></td>
                <td className="py-2.5 px-3 font-mono text-xs text-slate-600 dark:text-slate-400">{s.sku}</td>
                <td className="py-2.5 px-3 text-right font-semibold text-slate-800 dark:text-slate-200">{s.quantity}</td>
                <td className="py-2.5 px-3 text-right font-mono text-slate-700 dark:text-slate-300">{formatMoney(Number(s.unit_price))}</td>
                <td className="py-2.5 px-3 text-right font-mono font-semibold text-emerald-700 dark:text-emerald-400">{formatMoney(Number(s.total_revenue))}</td>
                <td className="py-2.5 px-3 text-right">
                  <button onClick={() => onDelete(s.id)} className="text-slate-400 hover:text-red-500 text-xs" title="Delete">✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PurchasesTable({ purchases, onDelete }: { purchases: Purchase[]; onDelete: (id: string) => void }) {
  if (purchases.length === 0) {
    return <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-12 text-center text-slate-400 dark:text-slate-500 text-sm">No purchases in this date range yet. Click "+ Add Purchase" above to log a restock.</div>;
  }
  return (
    <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50">
              <th className="text-left py-3 px-4 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider">Date</th>
              <th className="text-left py-3 px-3 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider">SKU</th>
              <th className="text-right py-3 px-3 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider">Qty</th>
              <th className="text-right py-3 px-3 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider">Unit Cost</th>
              <th className="text-right py-3 px-3 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider">Total Cost</th>
              <th className="text-left py-3 px-3 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider">Supplier</th>
              <th className="py-3 px-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
            {purchases.map(p => (
              <tr key={p.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/50">
                <td className="py-2.5 px-4 whitespace-nowrap text-slate-700 dark:text-slate-300">{formatDate(p.purchase_date)}</td>
                <td className="py-2.5 px-3 font-mono text-xs text-slate-600 dark:text-slate-400">{p.sku}</td>
                <td className="py-2.5 px-3 text-right font-semibold text-slate-800 dark:text-slate-200">{p.quantity}</td>
                <td className="py-2.5 px-3 text-right font-mono text-slate-700 dark:text-slate-300">{formatMoney(Number(p.unit_cost))}</td>
                <td className="py-2.5 px-3 text-right font-mono font-semibold text-fuchsia-700 dark:text-fuchsia-400">{formatMoney(Number(p.total_cost))}</td>
                <td className="py-2.5 px-3 text-slate-600 dark:text-slate-400">{p.supplier || '—'}</td>
                <td className="py-2.5 px-3 text-right">
                  <button onClick={() => onDelete(p.id)} className="text-slate-400 hover:text-red-500 text-xs" title="Delete">✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PricingTable({ items, onUpdate }: { items: InventoryItem[]; onUpdate: (sku: string, field: 'amazon_price' | 'shopify_price' | 'unit_cost', v: number | null) => void }) {
  if (items.length === 0) {
    return <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-12 text-center text-slate-400 dark:text-slate-500 text-sm">No products. Run an Amazon Full Refresh from the Inventory page to import your SKUs.</div>;
  }
  return (
    <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50">
              <th className="text-left py-3 px-4 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider">Product</th>
              <th className="text-right py-3 px-3 font-semibold text-orange-500 dark:text-orange-400 text-xs uppercase tracking-wider">Amazon Price</th>
              <th className="text-right py-3 px-3 font-semibold text-fuchsia-500 dark:text-fuchsia-400 text-xs uppercase tracking-wider">Shopify Price</th>
              <th className="text-right py-3 px-3 font-semibold text-amber-500 dark:text-amber-400 text-xs uppercase tracking-wider">Unit Cost</th>
              <th className="text-right py-3 px-3 font-semibold text-emerald-500 dark:text-emerald-400 text-xs uppercase tracking-wider">Margin (AZ)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
            {items.map(i => {
              const ap = i.amazon_price !== null ? Number(i.amazon_price) : null;
              const uc = i.unit_cost !== null ? Number(i.unit_cost) : null;
              const marginPct = ap !== null && uc !== null && ap > 0 ? ((ap - uc) / ap * 100) : null;
              return (
                <tr key={i.sku} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/50">
                  <td className="py-2.5 px-4">
                    <p className="font-semibold text-slate-800 dark:text-slate-200 text-sm leading-tight">{i.product_name || i.sku}</p>
                    {i.product_name && <p className="text-xs text-slate-400 dark:text-slate-500 font-mono mt-0.5">{i.sku}</p>}
                  </td>
                  <td className="py-2.5 px-3 text-right"><PriceEditor value={ap} onSave={v => onUpdate(i.sku, 'amazon_price', v)} /></td>
                  <td className="py-2.5 px-3 text-right"><PriceEditor value={i.shopify_price !== null ? Number(i.shopify_price) : null} onSave={v => onUpdate(i.sku, 'shopify_price', v)} /></td>
                  <td className="py-2.5 px-3 text-right"><PriceEditor value={uc} onSave={v => onUpdate(i.sku, 'unit_cost', v)} /></td>
                  <td className="py-2.5 px-3 text-right font-mono text-sm">
                    {marginPct !== null ? (
                      <span className={marginPct > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}>{marginPct.toFixed(1)}%</span>
                    ) : <span className="text-slate-300 dark:text-slate-600">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AddSaleModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [channel, setChannel] = useState<'manual' | 'amazon' | 'shopify'>('manual');
  const [sku, setSku] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unitPrice, setUnitPrice] = useState('');
  const [saleDate, setSaleDate] = useState(new Date().toISOString().split('T')[0]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    setSaving(true);
    setErr('');
    const res = await fetch('/api/sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel,
        sku: sku.trim(),
        quantity: Number(quantity),
        unit_price: Number(unitPrice),
        sale_date: new Date(saleDate).toISOString(),
      }),
    });
    if (res.ok) onSaved();
    else { const e = await res.json().catch(() => ({})); setErr(e.error || 'Failed'); }
    setSaving(false);
  }
  return <Modal title="Add Manual Sale" onClose={onClose}>
    <Field label="Channel">
      <select value={channel} onChange={e => setChannel(e.target.value as any)} className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm">
        <option value="manual">Manual (offline / shop)</option>
        <option value="amazon">Amazon</option>
        <option value="shopify">Shopify</option>
      </select>
    </Field>
    <Field label="SKU"><Input value={sku} onChange={setSku} placeholder="GLS-Y-47" /></Field>
    <Field label="Quantity"><Input value={quantity} onChange={setQuantity} type="number" /></Field>
    <Field label="Unit Price (£)"><Input value={unitPrice} onChange={setUnitPrice} type="number" placeholder="17.99" /></Field>
    <Field label="Sale Date"><Input value={saleDate} onChange={setSaleDate} type="date" /></Field>
    {err && <p className="text-sm text-red-500">{err}</p>}
    <ModalButtons onCancel={onClose} onSave={save} saving={saving} />
  </Modal>;
}

function AddPurchaseModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [sku, setSku] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(new Date().toISOString().split('T')[0]);
  const [supplier, setSupplier] = useState('');
  const [updateUnitCost, setUpdateUnitCost] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    setSaving(true);
    setErr('');
    const res = await fetch('/api/purchases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sku: sku.trim(),
        quantity: Number(quantity),
        unit_cost: Number(unitCost),
        purchase_date: purchaseDate,
        supplier: supplier.trim() || null,
        updateUnitCost,
      }),
    });
    if (res.ok) onSaved();
    else { const e = await res.json().catch(() => ({})); setErr(e.error || 'Failed'); }
    setSaving(false);
  }
  return <Modal title="Add Purchase" onClose={onClose}>
    <Field label="SKU"><Input value={sku} onChange={setSku} placeholder="GLS-Y-47" /></Field>
    <Field label="Quantity"><Input value={quantity} onChange={setQuantity} type="number" /></Field>
    <Field label="Unit Cost (£)"><Input value={unitCost} onChange={setUnitCost} type="number" placeholder="4.20" /></Field>
    <Field label="Purchase Date"><Input value={purchaseDate} onChange={setPurchaseDate} type="date" /></Field>
    <Field label="Supplier (optional)"><Input value={supplier} onChange={setSupplier} placeholder="Acme Supplies" /></Field>
    <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
      <input type="checkbox" checked={updateUnitCost} onChange={e => setUpdateUnitCost(e.target.checked)} />
      Update product&apos;s unit cost to this value
    </label>
    {err && <p className="text-sm text-red-500">{err}</p>}
    <ModalButtons onCancel={onClose} onSave={save} saving={saving} />
  </Modal>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/40 dark:bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl max-w-md w-full p-6 space-y-4 border border-slate-200 dark:border-slate-800">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">{label}</label>
      {children}
    </div>
  );
}
function Input({ value, onChange, type = 'text', placeholder }: { value: string; onChange: (v: string) => void; type?: string; placeholder?: string }) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-slate-100 outline-none focus:ring-2 focus:ring-blue-500"
    />
  );
}
function ModalButtons({ onCancel, onSave, saving }: { onCancel: () => void; onSave: () => void; saving: boolean }) {
  return (
    <div className="flex justify-end gap-2 pt-2">
      <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">Cancel</button>
      <button onClick={onSave} disabled={saving} className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg">{saving ? 'Saving...' : 'Save'}</button>
    </div>
  );
}
