'use client';
import { useState } from 'react';

type Props = {
  groupKey: string;
  name: string;
  isOverride: boolean;
  onSaved: (groupKey: string, name: string, isOverride: boolean) => void;
};

/**
 * Inline rename for a product group. Amazon listing titles are long SEO
 * strings, so the derived header is a best guess — this lets it be corrected
 * once and stored, without touching the underlying listing.
 */
export default function GroupNameEditor({ groupKey, name, isOverride, onSaved }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);

  async function save(next: string | null) {
    setBusy(true);
    try {
      const res = await fetch('/api/groups', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_key: groupKey, display_name: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) onSaved(groupKey, next ?? '', !!data.display_name);
    } finally {
      setBusy(false);
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
        <input
          autoFocus
          value={draft}
          disabled={busy}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') save(draft.trim() || null);
            if (e.key === 'Escape') { setDraft(name); setEditing(false); }
          }}
          className="w-56 rounded-md border border-blue-400 bg-white dark:bg-slate-800 px-2 py-0.5 text-sm font-semibold text-slate-900 dark:text-slate-100 outline-none focus:ring-2 focus:ring-blue-500/30"
        />
        <button
          onClick={() => save(draft.trim() || null)}
          disabled={busy}
          className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
        >
          Save
        </button>
        {isOverride && (
          <button
            onClick={() => save(null)}
            disabled={busy}
            className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
            title="Revert to the name derived from the listing"
          >
            Reset
          </button>
        )}
      </span>
    );
  }

  return (
    <span className="group/name inline-flex items-center gap-1.5">
      <span className="font-semibold text-slate-900 dark:text-slate-100">{name}</span>
      <button
        onClick={e => { e.stopPropagation(); setDraft(name); setEditing(true); }}
        className="opacity-0 group-hover/name:opacity-100 focus:opacity-100 text-slate-300 hover:text-blue-600 dark:text-slate-600 dark:hover:text-blue-400 transition-opacity"
        aria-label={`Rename ${name}`}
        title="Rename product"
      >
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
      </button>
    </span>
  );
}
