import type { Fact } from '../ui/FactRow.tsx';

/* Critical-signal evidence: a white card split 1 : 2.
   Left = what was measured (serif 26px, brick) + the rule. Right = evidence facts in mono. */
export function EvidenceGrid({ measured, rule, evidence }: { measured: string; rule: string; evidence: Fact[] }) {
  return (
    <div className="mt-[18px] grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] overflow-hidden rounded-xl border border-ink-200 bg-white max-sm:grid-cols-1">
      <div className="grid content-start gap-1 border-r border-ink-200 px-[18px] py-4 max-sm:border-b max-sm:border-r-0">
        <span className="helm-label">Measured</span>
        <span className="tabular font-serif text-figure font-medium text-red-700">{measured}</span>
        <span className="text-meta text-ink-500">rule: {rule}</span>
      </div>
      <dl className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-5 gap-y-[10px] px-[18px] py-3">
        {evidence.map((e) => (
          <div key={e.label} className="grid gap-[2px]">
            <dt className="text-meta text-ink-500">{e.label}</dt>
            <dd className="font-mono text-ui font-medium">{e.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
