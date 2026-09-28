export interface FeasibilityView { key: string; state: string; name: string; status: 'SATISFIED' | 'BREACHED' | 'UNKNOWN'; explanation: string }
const T = { SATISFIED: 'text-emerald-700', BREACHED: 'text-red-700', UNKNOWN: 'text-ink-500' };

/* "Can it be done?" — one row per future: state 13/600, status word mono 11/600 (right), constraint — explanation 13/20.
   The status is the kernel's own word. */
export function FeasibilityList({ items }: { items: FeasibilityView[] }) {
  return (
    <div>
      {items.map((f) => (
        <div key={f.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-[2px] border-b border-ink-200 py-3">
          <span className="text-dense font-semibold">{f.state}</span>
          <span className={'font-mono text-[11px] font-semibold leading-5 tracking-[0.04em] ' + T[f.status]}>{f.status}</span>
          <span className="col-span-2 text-dense text-ink-600">{f.name} — {f.explanation}</span>
        </div>
      ))}
    </div>
  );
}
