'use client';
import { useEffect, useRef, useState } from 'react';

type Props = {
  sku: string;
  value: number;
  onChange: (sku: string, next: number) => void;
};

/**
 * Manual shop-stock control.
 *
 * The inline -/+ handle the common single-unit case. Clicking the figure
 * opens a panel for bulk changes, so removing 56 units is one entry rather
 * than 56 clicks. Everything goes to the server as a relative `adjust`, so
 * concurrent edits from two devices add up instead of overwriting.
 */
export default function StockAdjuster({ sku, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState('');
  const [exact, setExact] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    qtyRef.current?.focus();
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/inventory/${encodeURIComponent(sku)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Update failed');
      onChange(sku, data.shop_stock);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const parsed = parseInt(qty, 10);
  const validQty = Number.isFinite(parsed) && parsed > 0;

  async function applyDelta(sign: 1 | -1) {
    if (!validQty) return;
    if (await send({ adjust: sign * parsed })) {
      setQty('');
      setOpen(false);
    }
  }

  async function applyExact() {
    const n = parseInt(exact, 10);
    if (!Number.isFinite(n) || n < 0) return;
    if (await send({ shop_stock: n })) {
      setExact('');
      setOpen(false);
    }
  }

  const stepBtn =
    'w-6 h-6 rounded-md border border-slate-200 dark:border-slate-700 text-slate-500 ' +
    'dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-900 ' +
    'dark:hover:text-slate-100 disabled:opacity-40 transition-colors grid place-items-center ' +
    'text-sm font-semibold leading-none';

  return (
    <div ref={rootRef} className="relative inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => send({ adjust: -1 })}
        disabled={busy || value <= 0}
        className={stepBtn}
        aria-label={`Remove one from ${sku}`}
      >
        −
      </button>

      <button
        type="button"
        onClick={() => { setOpen(o => !o); setExact(String(value)); }}
        className="tnum min-w-9 px-1 py-0.5 rounded-md text-sm font-semibold text-slate-900 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Adjust by a specific amount"
      >
        {value}
      </button>

      <button
        type="button"
        onClick={() => send({ adjust: 1 })}
        disabled={busy}
        className={stepBtn}
        aria-label={`Add one to ${sku}`}
      >
        +
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Adjust shop stock"
          className="absolute right-0 top-full z-30 mt-1.5 w-60 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 text-left shadow-xl"
        >
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
            Adjust shop stock
          </p>
          <p className="mt-0.5 mb-2.5 truncate font-mono text-[11px] text-slate-400 dark:text-slate-500">{sku}</p>

          <input
            ref={qtyRef}
            type="number"
            min="1"
            inputMode="numeric"
            placeholder="Quantity"
            value={qty}
            onChange={e => setQty(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && validQty) applyDelta(1); }}
            className="tnum w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-2 text-sm text-slate-900 dark:text-slate-100 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30"
          />

          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={!validQty || busy}
              onClick={() => applyDelta(-1)}
              className="rounded-lg bg-red-50 dark:bg-red-900/30 px-2 py-2 text-sm font-semibold text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/50 disabled:opacity-40 transition-colors"
            >
              − Remove
            </button>
            <button
              type="button"
              disabled={!validQty || busy}
              onClick={() => applyDelta(1)}
              className="rounded-lg bg-emerald-50 dark:bg-emerald-900/30 px-2 py-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 disabled:opacity-40 transition-colors"
            >
              + Add
            </button>
          </div>

          <div className="mt-3 flex items-center gap-2 border-t border-slate-100 dark:border-slate-800 pt-2.5">
            <label className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              Set to
            </label>
            <input
              type="number"
              min="0"
              inputMode="numeric"
              value={exact}
              onChange={e => setExact(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') applyExact(); }}
              className="tnum w-full min-w-0 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1.5 text-sm text-slate-900 dark:text-slate-100 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30"
            />
            <button
              type="button"
              disabled={busy}
              onClick={applyExact}
              className="shrink-0 rounded-lg bg-slate-900 dark:bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-white dark:text-slate-900 hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              Set
            </button>
          </div>

          {error && <p className="mt-2 text-xs font-medium text-red-600 dark:text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}
