import { cn } from '../../lib/cn.ts';
import { TruthMark } from '../ui/TruthMark.tsx';

export type Outcome = 'SATISFIED' | 'MEETS_TARGET' | 'VIOLATED' | 'MISSES_TARGET' | 'STATED' | 'ASSESSED' | 'UNKNOWN' | 'NOT_ASSESSED';
export interface MatrixCell { display: string; outcome: Outcome; note?: string; title?: string; judgement?: 'STRONG_SUPPORT' | 'SUPPORT' | 'NEUTRAL' | 'CONCERN' | 'STRONG_CONCERN' }
export interface MatrixRow { name: string; meta: string; cells: MatrixCell[] }
export interface MatrixAlt { mark: string; label: string; chosen?: boolean }

const OUT: Record<Outcome, string> = {
  SATISFIED: 'text-emerald-700', MEETS_TARGET: 'text-emerald-700', VIOLATED: 'text-red-700', MISSES_TARGET: 'text-amber-700',
  STATED: 'text-ink-500', ASSESSED: 'text-ink-500', UNKNOWN: 'text-ink-500', NOT_ASSESSED: 'text-ink-500',
};
const JUDGE = { STRONG_SUPPORT: 'text-emerald-700', SUPPORT: 'text-emerald-700', NEUTRAL: 'text-ink-500', CONCERN: 'text-red-700', STRONG_CONCERN: 'text-red-700' };
const DECISION_COL = 'bg-accent-50/60';

/* Alternatives × criteria as a ledger: paper caps header on an ink-300 rule, hairline rows, no zebra.
   The chosen alternative is the one teal-tinted decision column, with a 2px teal rule on its head.
   Computed values carry the modelled mark (◆ teal mono); judgements are a named person's words in sans.
   The outcome sits under each value in words — never colour alone. Nothing here is ranked. */
export function CriteriaMatrix({ alternatives, rows }: { alternatives: MatrixAlt[]; rows: MatrixRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] border-collapse text-dense">
        <thead>
          <tr>
            <th className="ledger-th w-[26%]">What management said matters</th>
            {alternatives.map((a) => (
              <th key={a.mark} className={cn('ledger-th normal-case tracking-normal', a.chosen && 'bg-accent-50 shadow-decision')}>
                <span className="flex items-baseline gap-[6px]">
                  <span className={cn('font-serif text-figure font-semibold', a.chosen ? 'text-accent-700' : 'text-ink-950')}>{a.mark}</span>
                  {a.chosen && <span className="rounded-sm bg-emerald-600 px-[6px] py-[2px] text-meta font-medium text-white">chosen</span>}
                </span>
                <span className="block text-dense font-medium text-ink-800">{a.label}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={r.name}>
              <td className={cn('px-3 py-[10px] align-top', ri < rows.length - 1 && 'border-b border-ink-100')}>
                <span className="block font-semibold text-ink-950">{r.name}</span>
                <span className="block text-meta text-ink-500">{r.meta}</span>
              </td>
              {r.cells.map((c, i) => (
                <td key={i} title={c.title} className={cn('px-3 py-[10px] align-top', ri < rows.length - 1 && 'border-b border-ink-100', alternatives[i]?.chosen && DECISION_COL)}>
                  {c.judgement ? (
                    <span className={cn('block font-semibold', JUDGE[c.judgement])}>{c.display}</span>
                  ) : c.display === '—' || c.outcome === 'UNKNOWN' || c.outcome === 'NOT_ASSESSED' ? (
                    <span className="block text-ink-700">{c.display}</span>
                  ) : (
                    <TruthMark layer="modelled" value={c.display} />
                  )}
                  <span className={cn('block text-meta', OUT[c.outcome])}>
                    {c.outcome.replace('_', ' ').toLowerCase()}{c.note && ' · ' + c.note}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
