import { Pill, type PillTone } from '../ui/Pill.tsx';

export interface AssumptionView {
  id: string;
  statement: string;
  owner: string | null;
  criticality: 'CRITICAL' | 'MATERIAL' | 'MINOR';
  confidence: number | null;
  /** Where the belief comes from, when it was written down. */
  source?: string;
  /** How it turned out, once settled: the kernel's word and its note. */
  outcome?: { word: string; tone: PillTone; note?: string | null };
}

/* "What this rests on". Statement in serif 15/23 (it is reasoning, not UI).
   Right column: confidence mono, or UNKNOWN in brick. Unowned → "nobody stands behind this" in brick. */
export function AssumptionList({ items }: { items: AssumptionView[] }) {
  return (
    <div>
      {items.map((a) => (
        <div key={a.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-b border-ink-200 py-[14px]">
          <p className="font-serif text-read leading-[23px]">{a.statement}</p>
          <span className={'font-mono text-dense font-medium leading-[23px] ' + (a.confidence == null ? 'text-red-700' : 'text-ink-950')}>
            {a.confidence == null ? 'UNKNOWN' : a.confidence.toFixed(2)}
          </span>
          <span className="col-span-2 text-meta text-ink-500">
            {a.criticality.toLowerCase()} · <span className={a.owner ? '' : 'text-red-700'}>{a.owner ?? 'nobody stands behind this'}</span>
            {a.source && ' · ' + a.source}
          </span>
          {a.outcome && (
            <span className="col-span-2 flex flex-wrap items-baseline gap-2">
              <Pill tone={a.outcome.tone}>{a.outcome.word}</Pill>
              {a.outcome.note && <span className="text-meta text-ink-600">{a.outcome.note}</span>}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
