import { useState, type ReactNode } from 'react';
import { thisWeek, type PipelinePosition, type WeekReason } from '@helm/twin-runtime';
import { displayValue } from '../../services/scenarioRuntime.ts';
import { memoireDealUrl } from '../../services/pipelineView.ts';
import { SectionHead } from '../ui/SectionHead.tsx';
import { cn } from '../../lib/cn.ts';

/**
 * "This week" (Phase 1, 2026-10-16): the open deals that need a step from their owner, one row per deal with every
 * reason it is here — a next step that is late or due within seven days, or a close date that has passed. Each reason
 * is a date the source states, said back; the list is ordered by the date that came first, oldest first, and nothing
 * in it is ranked or scored. Deals nobody changed for a month are data to fix, listed under Fix in Memoire.
 */

const KINDS: readonly { kind: WeekReason['kind']; label: string }[] = [
  { kind: 'NEXT_STEP_OVERDUE', label: 'Next step late' },
  { kind: 'NEXT_STEP_DUE', label: 'Next step this week' },
  { kind: 'CLOSE_PASSED', label: 'Close date passed' },
];

const SHOWN = 8;

const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

function said(r: WeekReason, today: string): { text: string; late: boolean } {
  switch (r.kind) {
    case 'NEXT_STEP_OVERDUE': {
      const n = daysBetween(r.date, today);
      return { text: `Next step was due ${day(r.date)}, ${n} ${n === 1 ? 'day' : 'days'} ago`, late: true };
    }
    case 'NEXT_STEP_DUE':
      return { text: r.date === today ? 'Next step due today' : `Next step due ${day(r.date)}`, late: false };
    case 'CLOSE_PASSED':
      return { text: `Close date passed on ${day(r.date)}: close, lose or re-date it`, late: true };
  }
}

export function ThisWeek({ rows, now, source, live }: { rows: readonly PipelinePosition[]; now: string; source: string; live: boolean }) {
  const [only, setOnly] = useState<WeekReason['kind'] | null>(null);
  const [all, setAll] = useState(false);
  const w = thisWeek(rows, now);
  const lines = only ? w.lines.filter((l) => l.reasons.some((r) => r.kind === only)) : w.lines;
  const shown = all ? lines : lines.slice(0, SHOWN);
  const open = rows.filter((r) => r.state === 'OPEN').length;
  const dated = rows.some((r) => r.state === 'OPEN' && r.nextActionDate !== null);

  return (
    <section className="mt-10">
      <SectionHead title="This week" meta={`${w.lines.length} of ${open} open deals`} caveat={`by the dates in ${source}, oldest first · nothing is ranked`} />
      {w.lines.length === 0 ? (
        <p className="mt-3 max-w-reading text-ui text-ink-500">
          {dated
            ? 'Nothing is due: no next step is late or due within seven days, and no close date has passed.'
            : `HELM cannot say yet: no open deal states a next step in ${source}.`}
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Show only">
            <Chip on={only === null} onClick={() => setOnly(null)}>All · {w.lines.length}</Chip>
            {KINDS.filter((k) => w.counts[k.kind] > 0).map((k) => (
              <Chip key={k.kind} on={only === k.kind} onClick={() => setOnly(only === k.kind ? null : k.kind)}>
                {k.label} · {w.counts[k.kind]}
              </Chip>
            ))}
          </div>
          <ul className="mt-2">
            {shown.map(({ deal, reasons }) => (
              <li key={deal.opportunityId} className="border-b border-ink-200 py-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="min-w-0 flex-1 text-ui text-ink-950">
                    <span className="font-medium">{deal.opportunity}</span>
                    {deal.customer && <span className="text-ink-600"> · {deal.customer}</span>}
                  </span>
                  <span className="whitespace-nowrap font-mono text-dense tabular text-ink-700">
                    {deal.value === null ? '—' : displayValue(deal.value, 'currency', deal.currency)}
                    {deal.stage ? <span className="text-ink-500"> · {deal.stage}</span> : null}
                  </span>
                </div>
                <p className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-dense">
                  {reasons.map((r) => {
                    const s = said(r, w.today);
                    return <span key={r.kind} className={s.late ? 'text-red-700' : 'text-ink-700'}>{s.text}</span>;
                  })}
                  {live && deal.sourceId && (
                    <a href={memoireDealUrl(deal.sourceId)} target="_blank" rel="noreferrer" className="ml-auto whitespace-nowrap text-meta font-medium text-accent-700 hover:underline">
                      Open in Memoire ↗
                    </a>
                  )}
                </p>
              </li>
            ))}
          </ul>
          {lines.length > SHOWN && (
            <button type="button" onClick={() => setAll((a) => !a)} className="mt-2 text-meta font-medium text-accent-700 hover:underline">
              {all ? 'Show fewer' : `Show all ${lines.length}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

export function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-[3px] text-meta font-medium transition-colors ease-helm',
        on ? 'border-ink-950 bg-ink-950 text-white' : 'border-ink-200 bg-white text-ink-700 hover:border-ink-400',
      )}
    >
      {children}
    </button>
  );
}
