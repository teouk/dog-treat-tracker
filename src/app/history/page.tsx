'use client';
import { useEffect, useState } from 'react';
import { useSession, signOut } from 'next-auth/react';
import Login from '@/components/Login';
import ThemeToggle from '@/components/ThemeToggle';
import Nav from '@/components/Nav';

type ReceiptItem = {
  sku: string; quantity: number; before_qty: number; after_qty: number;
  product_name: string | null; variant_label: string | null;
};
type Receipt = {
  id: number; reference: string | null; supplier: string | null; note: string | null;
  received_by: string | null; created_at: string;
  total_units: number; line_count: number; items: ReceiptItem[];
};
type Movement = {
  id: number; sku: string; delta: number; before_qty: number; after_qty: number;
  reason: string | null; adjusted_by: string | null; source: string | null;
  created_at: string; product_name: string | null; variant_label: string | null;
};

type Tab = 'deliveries' | 'movements';

const SOURCE_STYLE: Record<string, string> = {
  receipt:  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  outbound: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  manual:   'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
};
const SOURCE_LABEL: Record<string, string> = {
  receipt: 'Delivery',
  outbound: 'Sent to channel',
  manual: 'Manual',
};

function when(iso: string) {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

export default function HistoryPage() {
  const { status } = useSession();
  const [tab, setTab] = useState<Tab>('deliveries');
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status !== 'authenticated') return;
    let cancelled = false;

    (async () => {
      try {
        const [r, m] = await Promise.all([fetch('/api/receipts'), fetch('/api/history')]);
        if (cancelled) return;
        const rj = await r.json();
        const mj = await m.json();
        if (Array.isArray(rj)) setReceipts(rj);
        if (Array.isArray(mj)) setMovements(mj);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [status]);

  function toggle(id: number) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  if (status === 'loading') {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-50 dark:bg-slate-950">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-slate-800 dark:border-slate-700 dark:border-t-slate-200" />
      </div>
    );
  }
  if (status === 'unauthenticated') return <Login />;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-4">
            <h1 className="truncate text-sm font-bold tracking-tight text-slate-900 dark:text-slate-100 sm:text-base">
              Glorious Treats <span className="text-blue-600 dark:text-blue-400">&amp; Chews</span>
            </h1>
            <Nav />
          </div>
          <div className="flex shrink-0 items-center gap-2">
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
      </header>

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-5">
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-800 dark:bg-slate-900">
          {([['deliveries', 'Deliveries'], ['movements', 'All movements']] as Array<[Tab, string]>).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
                tab === key
                  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'deliveries' && (
          <div className="space-y-2.5">
            {receipts.map(receipt => {
              const open = expanded.has(receipt.id);
              return (
                <div key={receipt.id} className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
                  <button onClick={() => toggle(receipt.id)} className="flex w-full items-center justify-between gap-3 p-4 text-left">
                    <div className="flex min-w-0 items-center gap-3">
                      <svg className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                      </svg>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                          {receipt.reference || `Delivery #${receipt.id}`}
                          {receipt.supplier && <span className="ml-2 font-normal text-slate-400">{receipt.supplier}</span>}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
                          {when(receipt.created_at)}
                          {receipt.received_by && ` · ${receipt.received_by}`}
                        </p>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="tnum text-lg font-bold text-emerald-600 dark:text-emerald-400">+{receipt.total_units}</p>
                      <p className="text-[11px] text-slate-400">{receipt.line_count} product{receipt.line_count === 1 ? '' : 's'}</p>
                    </div>
                  </button>

                  {open && (
                    <div className="border-t border-slate-100 dark:border-slate-800">
                      {receipt.note && (
                        <p className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-400">
                          {receipt.note}
                        </p>
                      )}
                      <table className="w-full">
                        <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                          {receipt.items.map(item => (
                            <tr key={item.sku}>
                              <td className="px-4 py-2">
                                <p className="truncate text-sm text-slate-700 dark:text-slate-300">{item.product_name || item.sku}</p>
                                <p className="truncate font-mono text-[11px] text-slate-400">
                                  {item.variant_label ? `${item.variant_label} · ` : ''}{item.sku}
                                </p>
                              </td>
                              <td className="tnum px-4 py-2 text-right text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                                +{item.quantity}
                              </td>
                              <td className="tnum px-4 py-2 text-right text-xs text-slate-400">
                                {item.before_qty} → {item.after_qty}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
            {receipts.length === 0 && (
              <p className="py-14 text-center text-sm text-slate-400 dark:text-slate-500">
                {loading ? 'Loading…' : 'No deliveries recorded yet. Use “Bulk order received” on the Inventory page.'}
              </p>
            )}
          </div>
        )}

        {tab === 'movements' && (
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500 dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-400">
                  <th className="px-4 py-2.5 text-left font-semibold">Product</th>
                  <th className="px-3 py-2.5 text-left font-semibold">Source</th>
                  <th className="hidden px-3 py-2.5 text-left font-semibold sm:table-cell">Reason</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Change</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Result</th>
                  <th className="hidden px-4 py-2.5 text-right font-semibold md:table-cell">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {movements.map(m => {
                  const src = m.source || 'manual';
                  return (
                    <tr key={m.id} className="transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="px-4 py-2.5">
                        <p className="truncate text-sm text-slate-700 dark:text-slate-300">{m.product_name || m.sku}</p>
                        <p className="truncate font-mono text-[11px] text-slate-400">{m.sku}</p>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${SOURCE_STYLE[src] || SOURCE_STYLE.manual}`}>
                          {SOURCE_LABEL[src] || src}
                        </span>
                      </td>
                      <td className="hidden max-w-48 px-3 py-2.5 sm:table-cell">
                        <p className="truncate text-xs text-slate-500 dark:text-slate-400">{m.reason || '—'}</p>
                      </td>
                      <td className={`tnum px-3 py-2.5 text-right text-sm font-bold ${
                        m.delta > 0 ? 'text-emerald-600 dark:text-emerald-400' : m.delta < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-400'
                      }`}>
                        {m.delta > 0 ? `+${m.delta}` : m.delta}
                      </td>
                      <td className="tnum px-3 py-2.5 text-right text-xs text-slate-400">
                        {m.before_qty} → {m.after_qty}
                      </td>
                      <td className="hidden whitespace-nowrap px-4 py-2.5 text-right text-xs text-slate-400 md:table-cell">
                        {when(m.created_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {movements.length === 0 && (
              <p className="py-14 text-center text-sm text-slate-400 dark:text-slate-500">
                {loading ? 'Loading…' : 'No stock movements recorded yet.'}
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
