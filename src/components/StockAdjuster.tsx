'use client';
import { useEffect, useRef, useState } from 'react';

type Props = {
  sku: string;
  value: number;
  onChange: (sku: string, next: number) => void;
  /** Wider control with a persistent Set button, for the mobile card layout. */
  block?: boolean;
};

/**
 * Manual shop-stock control: type the count you have and it becomes the
 * stored value.
 *
 * This replaces an earlier add/remove control. The owner counts what is
 * physically on the shelf, so an absolute figure is what they actually hold
 * in mind; making them work out a delta first was arithmetic in the wrong
 * direction.
 *
 * The trade-off is that an absolute write is last-writer-wins, where the old
 * relative `adjust` accumulated. That is the intended behaviour here — "the
 * shelf has 50" is a statement about the shelf, not about someone else's
 * edit — but it does mean two people counting at once will not add up.
 */
export default function StockAdjuster({ sku, value, onChange, block = false }: Props) {
  const [draft, setDraft] = useState(String(value));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Follow the server value unless the user is mid-edit, so a sync or another
  // row's update does not overwrite what is being typed.
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (!dirtyRef.current) setDraft(String(value));
  }, [value]);

  const parsed = parseInt(draft, 10);
  const valid = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1_000_000;
  const dirty = draft.trim() !== '' && String(value) !== draft.trim();
  const canSubmit = valid && dirty && !busy;

  function revert() {
    dirtyRef.current = false;
    setDraft(String(value));
    setError('');
  }

  async function commit() {
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/inventory/${encodeURIComponent(sku)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // Absolute set — the API applies this value verbatim.
        body: JSON.stringify({ shop_stock: parsed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Update failed');
      dirtyRef.current = false;
      onChange(sku, data.shop_stock);
      setDraft(String(data.shop_stock));
      setSaved(true);
      setTimeout(() => setSaved(false), 1400);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    'tnum rounded-md border bg-white px-2 py-1 text-sm font-semibold text-slate-900 outline-none ' +
    'transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 ' +
    'dark:bg-slate-800 dark:text-slate-100 disabled:opacity-50 ' +
    (error
      ? 'border-red-400 dark:border-red-500'
      : saved
        ? 'border-emerald-400 dark:border-emerald-500'
        : 'border-slate-200 dark:border-slate-700');

  const setBtn =
    'rounded-md bg-blue-600 px-2.5 py-1 text-xs font-bold text-white transition-colors ' +
    'hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 ' +
    'dark:disabled:bg-slate-800 dark:disabled:text-slate-600';

  return (
    <div className={block ? 'w-full' : 'inline-flex flex-col items-end'}>
      <div className={`flex items-center gap-1.5 ${block ? 'w-full' : ''}`}>
        <input
          ref={inputRef}
          type="number"
          min="0"
          inputMode="numeric"
          disabled={busy}
          value={draft}
          aria-label={`Set shop stock for ${sku}`}
          onChange={e => { dirtyRef.current = true; setDraft(e.target.value); setError(''); }}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); void commit(); }
            if (e.key === 'Escape') { e.preventDefault(); revert(); inputRef.current?.blur(); }
          }}
          // Abandoning an edit reverts rather than saves: a half-typed number
          // left behind by a stray click must never be written as stock.
          onBlur={() => { if (!busy) revert(); }}
          className={`${inputClass} ${block ? 'flex-1' : 'w-16 text-center'}`}
        />
        <button
          type="button"
          // Runs before blur, which would otherwise revert the draft first.
          onMouseDown={e => e.preventDefault()}
          onClick={commit}
          disabled={!canSubmit}
          className={`${setBtn} ${dirty || block ? '' : 'invisible'}`}
        >
          {busy ? '…' : 'Set'}
        </button>
      </div>

      {(error || saved) && (
        <p className={`mt-0.5 text-[10px] font-medium ${error ? 'text-red-500' : 'text-emerald-500'}`}>
          {error || 'Saved'}
        </p>
      )}
    </div>
  );
}
