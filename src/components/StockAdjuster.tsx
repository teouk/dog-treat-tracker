'use client';
import { useEffect, useRef, useState } from 'react';

type Props = {
  sku: string;
  value: number;
  onChange: (sku: string, next: number) => void;
};

type Direction = 'add' | 'remove';

/**
 * Manual shop-stock control.
 *
 * Entering a quantity never implies a direction: no key commits the form and
 * Apply stays disabled until Add or Remove has been picked, so a typed
 * number can't be applied the wrong way round. The resulting stock level is
 * previewed before it is committed.
 *
 * Changes are sent as a relative `adjust`, applied inside the UPDATE, so two
 * people adjusting the same SKU at once accumulate rather than overwrite.
 */
export default function StockAdjuster({ sku, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<Direction | null>(null);
  const [qty, setQty] = useState('');
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

  function reset() {
    setDirection(null);
    setQty('');
    setError('');
  }

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
  const ready = validQty && direction !== null;
  const preview = ready
    ? Math.max(0, direction === 'add' ? value + parsed : value - parsed)
    : null;

  async function apply() {
    if (!ready) return;
    const delta = direction === 'add' ? parsed : -parsed;
    if (await send({ adjust: delta })) {
      reset();
      setOpen(false);
    }
  }

  const stepBtn =
    'w-6 h-6 rounded-md border border-slate-200 dark:border-slate-700 text-slate-500 ' +
    'dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-900 ' +
    'dark:hover:text-slate-100 disabled:opacity-40 transition-colors grid place-items-center ' +
    'text-sm font-semibold leading-none';

  function segment(dir: Direction, label: string, tone: string) {
    const active = direction === dir;
    return (
      <button
        type="button"
        onClick={() => setDirection(dir)}
        aria-pressed={active}
        className={`flex-1 rounded-md px-2 py-1.5 text-sm font-semibold transition-colors ${
          active
            ? tone
            : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
        }`}
      >
        {label}
      </button>
    );
  }

  return (
    <div ref={rootRef} className="relative inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => send({ adjust: -1 })}
        disabled={busy || value <= 0}
        className={stepBtn}
        aria-label={`Remove one from ${sku}`}
        title="Remove one"
      >
        −
      </button>

      <button
        type="button"
        onClick={() => { setOpen(o => !o); reset(); }}
        className="tnum min-w-9 rounded-md px-1 py-0.5 text-sm font-semibold text-slate-900 transition-colors hover:bg-slate-100 dark:text-slate-100 dark:hover:bg-slate-700"
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
        title="Add one"
      >
        +
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Adjust shop stock"
          className="absolute right-0 top-full z-30 mt-1.5 w-64 rounded-xl border border-slate-200 bg-white p-3 text-left shadow-xl dark:border-slate-700 dark:bg-slate-900"
        >
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
            Adjust shop stock
          </p>
          <p className="mb-3 mt-0.5 truncate font-mono text-[11px] text-slate-400 dark:text-slate-500">{sku}</p>

          <div className="flex gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1 dark:border-slate-700 dark:bg-slate-800">
            {segment('remove', '− Remove', 'bg-red-600 text-white shadow-sm')}
            {segment('add', '+ Add', 'bg-emerald-600 text-white shadow-sm')}
          </div>

          <label className="mt-3 block text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
            Quantity
          </label>
          <input
            ref={qtyRef}
            type="number"
            min="1"
            inputMode="numeric"
            placeholder="0"
            value={qty}
            onChange={e => setQty(e.target.value)}
            // Deliberately no Enter-to-submit: a direction must be chosen.
            onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }}
            className="tnum mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />

          <div className="mt-2.5 flex h-5 items-center justify-center gap-2 text-sm">
            {preview !== null ? (
              <>
                <span className="tnum text-slate-400 dark:text-slate-500">{value}</span>
                <span className="text-slate-300 dark:text-slate-600">→</span>
                <span className={`tnum font-bold ${
                  direction === 'add' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                }`}>{preview}</span>
              </>
            ) : (
              <span className="text-[11px] text-slate-400 dark:text-slate-500">
                {validQty ? 'Choose Add or Remove' : 'Enter a quantity'}
              </span>
            )}
          </div>

          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="flex-1 rounded-lg border border-slate-200 px-2 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!ready || busy}
              onClick={apply}
              className={`flex-1 rounded-lg px-2 py-2 text-sm font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 dark:disabled:bg-slate-800 dark:disabled:text-slate-600 ${
                direction === 'remove' ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'
              }`}
            >
              {ready ? (direction === 'add' ? `Add ${parsed}` : `Remove ${parsed}`) : 'Apply'}
            </button>
          </div>

          {error && <p className="mt-2 text-xs font-medium text-red-600 dark:text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}
