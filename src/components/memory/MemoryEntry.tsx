import { Pill, type PillTone } from '../ui/Pill.tsx';

/** The kernel's own outcome words; the tint is the second channel. */
export type AssumptionOutcome = 'PENDING' | 'CONFIRMED' | 'PARTIALLY_CONFIRMED' | 'DISPROVED' | 'UNKNOWN';
const OUTCOME_TONE: Record<AssumptionOutcome, PillTone> = {
  CONFIRMED: 'actual', PARTIALLY_CONFIRMED: 'accepted', DISPROVED: 'open', PENDING: 'neutral', UNKNOWN: 'neutral',
};

export interface MemoryView {
  id: string; meta: string; question: string; chosen: string; summary: string;
  accepted: string[]; expected: { label: string; value: string }[];
  after: { title: string; recordedAt: string }[];
  review?: {
    variances: { label: string; expected: string; actual: string; variance: string }[];
    assumptions: { outcome: AssumptionOutcome; statement: string; note?: string }[];
    statement: string; by: string;
  };
  pendingNote?: string;           // "0 of 5 assumptions settled. Review due 23 Oct 2026…"
}

/* One commitment. 2px ink rule on top. Two columns that must never merge:
   "What was reasoned" (chosen, summary, accepted, expected) | "What happened" (review or pending). */
export function MemoryEntry({ m, onOpen }: { m: MemoryView; onOpen: (id: string) => void }) {
  return (
    <article className="mt-10 border-t-2 border-ink-950 pt-4">
      <p className="helm-meta">{m.meta}</p>
      <a href={'/decisions/' + m.id} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); onOpen(m.id); }}
        className="mt-[6px] block max-w-[900px] font-serif text-[26px] font-medium leading-[33px] tracking-[-0.01em] text-ink-950 hover:text-accent-800 hover:no-underline">{m.question}</a>
      <div className="mt-[22px] grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-x-10 gap-y-7">
        <div>
          <p className="helm-label mb-[10px]">What was reasoned</p>
          <p className="font-serif text-section-sm font-medium">{m.chosen}</p>
          <p className="mt-[6px] text-base text-ink-700">{m.summary}</p>
          <p className="mb-[6px] mt-[18px] text-dense font-semibold">Accepted at the time</p>
          {m.accepted.map((t) => <p key={t} className="border-t border-ink-200 py-2 text-base text-ink-700">{t}</p>)}
          <p className="mb-[6px] mt-[18px] text-dense font-semibold">Expected</p>
          {m.expected.map((e) => (
            <div key={e.label} className="flex items-baseline justify-between gap-4 border-t border-ink-200 py-2">
              <span className="text-dense text-ink-600">{e.label}</span><span className="text-right font-mono text-dense font-medium">{e.value}</span>
            </div>
          ))}
        </div>
        <div>
          <p className="helm-label mb-[10px]">What happened</p>
          {!m.review ? (
            <>
              <div className="grid gap-[6px] rounded-xl border border-ink-200 bg-ink-50 px-5 py-[18px]">
                <p className="font-serif text-section-sm font-medium">Not looked at again yet.</p>
                <p className="text-base text-ink-700">{m.pendingNote}</p>
              </div>
              {m.after.map((a) => (
                <div key={a.title} className="mt-3 grid gap-1 rounded-xl border border-accent-200 bg-accent-50 px-[18px] py-[14px]">
                  <span className="font-sans text-label font-medium uppercase text-accent-900">Arrived after the commitment</span>
                  <span className="text-base font-medium text-accent-900">{a.title}</span>
                  <span className="font-mono text-meta text-accent-700">{a.recordedAt}</span>
                </div>
              ))}
            </>
          ) : (
            <>
              <table className="w-full border-collapse">
                <thead><tr>{['Value', 'Expected', 'Actual', 'Variance'].map((h, i) => <th key={h} className={'helm-label pb-2 ' + (i ? 'pl-3 text-right' : 'text-left')}>{h}</th>)}</tr></thead>
                <tbody>
                  {m.review.variances.map((v) => (
                    <tr key={v.label} className="border-t border-ink-200">
                      <td className="py-[10px] text-dense text-ink-700">{v.label}</td>
                      <td className="py-[10px] pl-3 text-right font-mono text-dense text-ink-600">{v.expected}</td>
                      <td className="py-[10px] pl-3 text-right font-mono text-dense font-medium">{v.actual}</td>
                      <td className="py-[10px] pl-3 text-right font-mono text-dense font-medium">{v.variance}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mb-[6px] mt-[18px] text-dense font-semibold">What it rested on</p>
              {m.review.assumptions.map((a) => (
                <div key={a.statement} className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-[2px] border-t border-ink-200 py-2">
                  <Pill tone={OUTCOME_TONE[a.outcome]}>{a.outcome.replace('_', ' ')}</Pill>
                  <span className="font-serif text-base">{a.statement}</span>
                  {a.note && <><span /><span className="text-meta text-ink-500">{a.note}</span></>}
                </div>
              ))}
              <p className="mt-4 font-serif text-read italic leading-[23px] text-ink-800">“{m.review.statement}”</p>
              <p className="helm-meta mt-1">{m.review.by}</p>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
