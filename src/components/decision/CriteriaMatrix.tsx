import { cn } from '../../lib/cn.ts';

export type Outcome = 'SATISFIED' | 'MEETS_TARGET' | 'VIOLATED' | 'MISSES_TARGET' | 'STATED' | 'ASSESSED' | 'UNKNOWN' | 'NOT_ASSESSED';
export interface MatrixCell { display: string; outcome: Outcome; note?: string; title?: string; judgement?: 'STRONG_SUPPORT' | 'SUPPORT' | 'NEUTRAL' | 'CONCERN' | 'STRONG_CONCERN' }
export interface MatrixRow { name: string; meta: string; cells: MatrixCell[] }
export interface MatrixAlt { mark: string; label: string; chosen?: boolean }

const OUT: Record<Outcome, string> = {
  SATISFIED: 'text-emerald-700', MEETS_TARGET: 'text-emerald-700', VIOLATED: 'text-red-700', MISSES_TARGET: 'text-amber-700',
  STATED: 'text-ink-500', ASSESSED: 'text-ink-500', UNKNOWN: 'text-ink-500', NOT_ASSESSED: 'text-ink-500',
};
const JUDGE = { STRONG_SUPPORT: 'text-emerald-700', SUPPORT: 'text-emerald-700', NEUTRAL: 'text-ink-500', CONCERN: 'text-red-700', STRONG_CONCERN: 'text-red-700' };

/* Alternatives × criteria. No card, no zebra: label heads over hairline rows.
   The chosen alternative's column is tinted accent-50 top to bottom.
   Numbers are mono 15px; qualitative judgements are sans 14px.
   Outcome words (uppercase 11px) sit under each value — never replace them with colour alone. */
export function CriteriaMatrix({ alternatives, rows }: { alternatives: MatrixAlt[]; rows: MatrixRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] border-collapse">
        <thead>
          <tr>
            <th className="helm-label w-[26%] pb-[10px] pr-3 pt-[14px] text-left">Criterion</th>
            {alternatives.map((a) => (
              <th key={a.mark} className={cn('rounded-t-lg px-3 pb-[10px] pt-[14px] text-left align-bottom', a.chosen && 'bg-accent-50')}>
                <span className="block font-mono text-meta font-medium text-accent-800">{a.mark}</span>
                <span className="block text-dense font-semibold leading-[18px] text-ink-950">{a.label}{a.chosen && ' ✓'}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-t border-ink-200">
              <td className="py-[14px] pr-3 align-top">
                <span className="block text-ui font-semibold">{r.name}</span>
                <span className="block text-meta text-ink-500">{r.meta}</span>
              </td>
              {r.cells.map((c, i) => (
                <td key={i} title={c.title} className={cn('px-3 py-[14px] align-top', alternatives[i]?.chosen && 'bg-accent-50')}>
                  <span className={cn('block leading-[22px]', c.judgement ? 'font-sans text-ui font-medium ' + JUDGE[c.judgement] : 'font-mono text-read font-medium text-ink-950')}>{c.display}</span>
                  <span className={cn('block font-sans text-[11px] font-medium leading-4 tracking-[0.04em]', OUT[c.outcome])}>
                    {c.outcome.replace('_', ' ')}{c.note && ' · ' + c.note}
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
