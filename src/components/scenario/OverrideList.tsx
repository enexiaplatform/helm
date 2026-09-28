export interface OverrideView { target: string; rationale: string; change: string; baseline: string; future: string; provenance: string; type: string; confidence: string; period: string }

/* What a scenario changed. Target 14/600 · change mono 15/600 ochre (right).
   Rationale is human reasoning → italic serif 15/23. baseline → future mono 12 (right). Provenance line mono 12. */
export function OverrideList({ items }: { items: OverrideView[] }) {
  return (
    <div>
      {items.map((o) => (
        <div key={o.target} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-5 gap-y-[6px] border-b border-ink-200 py-4">
          <span className="text-ui font-semibold">{o.target}</span>
          <span className="text-right font-mono text-read font-semibold leading-5 text-amber-700">{o.change}</span>
          <p className="font-serif text-read italic leading-[23px] text-ink-800">{o.rationale}</p>
          <span className="whitespace-nowrap text-right font-mono text-meta leading-[23px] text-ink-500">{o.baseline} → {o.future}</span>
          <span className="helm-meta col-span-2">{o.provenance} · {o.type} · confidence {o.confidence} · {o.period}</span>
        </div>
      ))}
    </div>
  );
}
