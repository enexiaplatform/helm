import { Fragment } from 'react';
import { cn } from '../../lib/cn.ts';
import { readable } from '../../lib/format.ts';

/** Blocked reasons that differ only in their instants are one reason, said once under the row. */
const sameReason = (r: string): string => r.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '…');

export type Interp = 'FAVORABLE' | 'UNFAVORABLE' | 'CONTEXT_DEPENDENT' | 'NEUTRAL' | 'UNRESOLVED';
export interface CompareCol { key: string; mark: string; title: string; state: string; partial?: boolean; selectable?: boolean }
export interface CompareCell {
  value: string; blocked?: boolean; delta?: string; interp?: Interp;
  /** hover text: the exact stored value, or why there is none */
  title?: string;
  /** click to explain where the value comes from */
  onExplain?: () => void;
}
export interface CompareRow { key?: string; label: string; meta?: string; cells: CompareCell[] }

const I: Record<Interp, string> = { FAVORABLE: 'text-emerald-700', UNFAVORABLE: 'text-red-700', CONTEXT_DEPENDENT: 'text-sky-700', NEUTRAL: 'text-ink-500', UNRESOLVED: 'text-ink-500' };

/* Futures × metrics, baseline first. Value mono 15/22; delta mono 12/18 with ▲▼ coloured by the metric's
   own direction (not by sign). BLOCKED values in brick with the reason as the delta line.
   Clicking a column header selects it; the selected column is tinted accent-50. Never sort or highlight a "best". */
export function ScenarioCompare({ cols, rows, selected, onSelect }: { cols: CompareCol[]; rows: CompareRow[]; selected: string; onSelect: (key: string) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[880px] border-collapse">
        <thead>
          <tr>
            <th className="helm-label w-[16%] pb-[10px] pr-3 pt-[14px] text-left align-bottom">Metric</th>
            {cols.map((c) => (
              <th key={c.key} className={cn('rounded-t-lg px-3 pb-[10px] pt-[14px] text-left align-bottom', c.key === selected && 'bg-accent-50')}>
                <button type="button" disabled={c.selectable === false} onClick={() => onSelect(c.key)} aria-pressed={c.key === selected} className="grid gap-[3px] text-left text-ink-950 disabled:cursor-default">
                  <span className="font-mono text-meta font-medium leading-4 text-accent-800">{c.mark}</span>
                  <span className="text-dense font-semibold leading-[18px]">{c.title}</span>
                  <span className={cn('font-mono text-[11px] leading-4', c.partial ? 'text-amber-700' : 'text-ink-500')}>{c.state}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            // A row blocked in several futures said its long reason once per column (audit 2026-10-13: seven copies of
            // one red paragraph). Two or more blocked cells: each says BLOCKED, the reason is said once beneath.
            const blocked = r.cells.filter((x) => x.blocked && x.delta);
            const collapse = blocked.length >= 2;
            const reasons = [...new Map(blocked.map((x) => [sameReason(x.delta!), x.delta!])).values()];
            return (
            <Fragment key={r.key ?? r.label}>
            <tr className="border-t border-ink-200">
              <td className="py-[14px] pr-3 align-top">
                <span className="block text-ui font-semibold leading-[22px]">{r.label}</span>
                {r.meta && <span className="helm-meta block">{r.meta}</span>}
              </td>
              {r.cells.map((x, i) => (
                <td key={i} title={x.title} className={cn('px-3 py-[14px] align-top', cols[i]?.key === selected && 'bg-accent-50')}>
                  {x.onExplain ? (
                    <button type="button" onClick={x.onExplain} className={cn('block text-left font-mono text-read font-medium leading-[22px] hover:underline hover:underline-offset-[3px]', x.blocked ? 'text-red-700' : 'text-ink-950')}>
                      {x.value}
                    </button>
                  ) : (
                    <span className={cn('block font-mono text-read font-medium leading-[22px]', x.blocked ? 'text-red-700' : 'text-ink-950')}>{x.value}</span>
                  )}
                  {x.delta && !(collapse && x.blocked) && <span className={cn('block font-mono text-meta font-medium', I[x.interp ?? 'NEUTRAL'])}>{x.delta}</span>}
                </td>
              ))}
            </tr>
            {collapse && (
              <tr>
                <td />
                <td colSpan={cols.length} className="px-3 pb-[14px] text-meta text-red-700">
                  <p className="max-w-reading">Blocked in {blocked.length} of {cols.length}: {reasons.map((x) => readable(x)).join(' · ')}</p>
                </td>
              </tr>
            )}
            </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
