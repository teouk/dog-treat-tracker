'use client';
import { useMemo, useRef, useState } from 'react';
import type { InventoryItem } from '@/lib/inventory-view';

type Line = { sku: string; quantity: string };

type Props = {
  inventory: InventoryItem[];
  onClose: () => void;
  onSaved: (summary: { linesApplied: number; totalUnits: number }) => void;
};

/**
 * Record a pallet delivery: pick products, enter counts, submit once.
 *
 * The whole delivery posts as a single request so it is applied atomically —
 * a rejected line means nothing is written, rather than half a pallet
 * landing in stock.
 */
export default function BulkReceiveModal({ inventory, onClose, onSaved }: Props) {
  const [reference, setReference] = useState('');
  const [supplier, setSupplier] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const byLabel = useMemo(() => {
    const map = new Map<string, InventoryItem>();
    for (const item of inventory) map.set(item.sku, item);
    return map;
  }, [inventory]);

  const chosen = useMemo(() => new Set(lines.map(l => l.sku)), [lines]);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return inventory
      .filter(i =>
        !chosen.has(i.sku) && (
          i.sku.toLowerCase().includes(q) ||
          i.group_name.toLowerCase().includes(q) ||
          (i.variant_label || '').toLowerCase().includes(q) ||
          (i.product_name || '').toLowerCase().includes(q)
        )
      )
      .slice(0, 8);
  }, [inventory, search, chosen]);

  function addLine(sku: string) {
    setLines(prev => [...prev, { sku, quantity: '' }]);
    setSearch('');
    searchRef.current?.focus();
  }

  function setQuantity(sku: string, quantity: string) {
    setLines(prev => prev.map(l => (l.sku === sku ? { ...l, quantity } : l)));
  }

  function removeLine(sku: string) {
    setLines(prev => prev.filter(l => l.sku !== sku));
  }

  const parsedLines = lines.map(l => ({ sku: l.sku, quantity: parseInt(l.quantity, 10) }));
  const validLines = parsedLines.filter(l => Number.isInteger(l.quantity) && l.quantity > 0);
  const ready = lines.length > 0 && validLines.length === lines.length;
  const totalUnits = validLines.reduce((sum, l) => sum + l.quantity, 0);

  async function submit() {
    if (!ready) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/receipts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference, supplier, note, items: validLines }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not save delivery');
      onSaved({ linesApplied: data.linesApplied, totalUnits: data.totalUnits });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save delivery');
    } finally {
      setBusy(false);
    }
  }

  const field =
    'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 ' +
    'outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 ' +
    'dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 placeholder:text-slate-400';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm">
      <div className="my-8 w-full max-w-2xl rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Bulk order received</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Adds to shop stock and files a permanent delivery record.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
            aria-label="Close"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                Reference
              </label>
              <input className={field} placeholder="PO-2026-114" value={reference} onChange={e => setReference(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                Supplier
              </label>
              <input className={field} placeholder="Optional" value={supplier} onChange={e => setSupplier(e.target.value)} />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              Add products
            </label>
            <div className="relative">
              <input
                ref={searchRef}
                className={field}
                placeholder="Search by product, variant or SKU…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              {matches.length > 0 && (
                <ul className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-800">
                  {matches.map(item => (
                    <li key={item.sku}>
                      <button
                        onClick={() => addLine(item.sku)}
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-700"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-slate-800 dark:text-slate-200">
                            {item.group_name}
                          </span>
                          <span className="block truncate font-mono text-[11px] text-slate-400">
                            {item.variant_label ? `${item.variant_label} · ` : ''}{item.sku}
                          </span>
                        </span>
                        <span className="tnum shrink-0 text-xs text-slate-400">{item.shop_stock} in shop</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {lines.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500 dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-400">
                    <th className="px-3 py-2 text-left font-semibold">Product</th>
                    <th className="w-28 px-3 py-2 text-right font-semibold">Received</th>
                    <th className="w-24 px-3 py-2 text-right font-semibold">New total</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {lines.map(line => {
                    const item = byLabel.get(line.sku);
                    const qty = parseInt(line.quantity, 10);
                    const valid = Number.isInteger(qty) && qty > 0;
                    return (
                      <tr key={line.sku}>
                        <td className="px-3 py-2">
                          <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-200">
                            {item?.group_name || line.sku}
                          </p>
                          <p className="truncate font-mono text-[11px] text-slate-400">
                            {item?.variant_label ? `${item.variant_label} · ` : ''}{line.sku}
                          </p>
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="number"
                            min="1"
                            autoFocus
                            inputMode="numeric"
                            value={line.quantity}
                            onChange={e => setQuantity(line.sku, e.target.value)}
                            className={`tnum w-full rounded-md border px-2 py-1 text-right text-sm outline-none focus:ring-2 focus:ring-blue-500/30 dark:bg-slate-800 dark:text-slate-100 ${
                              line.quantity && !valid
                                ? 'border-red-400 focus:border-red-500'
                                : 'border-slate-200 focus:border-blue-500 dark:border-slate-700'
                            }`}
                          />
                        </td>
                        <td className="tnum px-3 py-2 text-right text-sm text-slate-500 dark:text-slate-400">
                          {valid ? (item?.shop_stock || 0) + qty : '—'}
                        </td>
                        <td className="px-2 py-2 text-right">
                          <button
                            onClick={() => removeLine(line.sku)}
                            className="rounded p-1 text-slate-300 transition-colors hover:bg-red-50 hover:text-red-500 dark:text-slate-600 dark:hover:bg-red-900/30"
                            aria-label={`Remove ${line.sku}`}
                          >
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              Note
            </label>
            <textarea
              rows={2}
              className={field}
              placeholder="Anything worth recording about this delivery"
              value={note}
              onChange={e => setNote(e.target.value)}
            />
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-5 py-4 dark:border-slate-800">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {lines.length === 0
              ? 'No products added yet'
              : <><span className="tnum font-bold text-slate-900 dark:text-slate-100">{totalUnits}</span> units across {lines.length} product{lines.length === 1 ? '' : 's'}</>}
          </p>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={!ready || busy}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 dark:disabled:bg-slate-800 dark:disabled:text-slate-600"
            >
              {busy ? 'Saving…' : 'Record delivery'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
