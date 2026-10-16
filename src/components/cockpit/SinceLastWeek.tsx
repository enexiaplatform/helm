import { useState } from 'react';
import { pipelineMoves, type DealChange, type DealMove, type DealState, type MoveGroup, type PipelinePosition, type PipelineReadable } from '@helm/twin-runtime';
import { displayDelta, displayValue } from '../../services/scenarioRuntime.ts';
import { memoireDealUrl } from '../../services/pipelineView.ts';
import { SectionHead } from '../ui/SectionHead.tsx';
import { Chip } from './ThisWeek.tsx';
import { moneyText, quarterLabel } from './QuarterPanel.tsx';
import { cn } from '../../lib/cn.ts';

/**
 * "What moved since last week" (Phase 2, 2026-10-16): the pipeline as HELM held it a week or more ago against today's.
 * A walk from the earlier weighted figure for the quarter to today's — each changed deal counted once, under the first
 * group that applies, reconciling to the cent — and below it every deal that changed, with each change said back as
 * the source states it. Deals are in the state's own order; nothing is ranked, scored or recommended.
 */

const SHOWN = 8;

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

const STATE_WORD: Record<DealState, string> = { OPEN: 'Open', WON: 'Won', LOST: 'Lost', ON_HOLD: 'On hold' };

const groupLabel = (g: MoveGroup, label: string, since: string): string => {
  switch (g) {
    case 'NEW': return `New since ${since}`;
    case 'GONE': return 'No longer in what HELM reads';
    case 'WON': return 'Won: leaves the forecast';
    case 'LOST': return 'Lost';
    case 'ON_HOLD': return 'Put on hold';
    case 'REOPENED': return 'Reopened';
    case 'LEFT_QUARTER': return `Close moved out of ${label}`;
    case 'ENTERED_QUARTER': return `Close moved into ${label}`;
    case 'REVALUED': return 'Value or probability changed';
    case 'OTHER': return 'Stage or date within the quarter';
  }
};

const pct = (p: string | null) => (p === null ? 'none' : `${Math.round(Number(p) * 100)}%`);

function said(m: DealMove, c: DealChange, label: string, since: string): { text: string; tone: 'ink' | 'red' | 'green' } {
  switch (m.kind) {
    case 'NEW':
      return { text: `New since ${since}`, tone: 'ink' };
    case 'GONE':
      return { text: 'No longer in what HELM reads: deleted, or out of your view', tone: 'ink' };
    case 'STATE':
      return { text: `${STATE_WORD[m.from]} → ${STATE_WORD[m.to]}`, tone: m.to === 'LOST' ? 'red' : m.to === 'WON' ? 'green' : 'ink' };
    case 'CLOSE': {
      const verb = m.direction === 'LATER' ? 'Close moved later' : m.direction === 'EARLIER' ? 'Close brought forward' : 'Close period changed';
      const out = c.group === 'LEFT_QUARTER' ? ` · out of ${label}` : c.group === 'ENTERED_QUARTER' ? ` · into ${label}` : '';
      return { text: `${verb}: ${m.from ?? 'none'} → ${m.to ?? 'none'}${out}`, tone: c.group === 'LEFT_QUARTER' ? 'red' : 'ink' };
    }
    case 'VALUE': {
      const cur = c.deal.currency ?? c.before?.currency ?? null;
      const diff = m.from !== null && m.to !== null ? ` (${displayDelta(String(Number(m.to) - Number(m.from)), 'currency', cur)})` : '';
      return { text: `Value ${displayValue(m.from, 'currency', cur)} → ${displayValue(m.to, 'currency', cur)}${diff}`, tone: 'ink' };
    }
    case 'PROBABILITY': {
      const diff = m.from !== null && m.to !== null ? ` (${displayDelta(String(Math.round((Number(m.to) - Number(m.from)) * 100)), 'percentage', null)})` : '';
      return { text: `Probability ${pct(m.from)} → ${pct(m.to)}${diff}`, tone: 'ink' };
    }
    case 'STAGE':
      return { text: `Stage ${m.from ?? 'none'} → ${m.to ?? 'none'}`, tone: 'ink' };
  }
}

const TONE = { ink: 'text-ink-700', red: 'text-red-700', green: 'text-emerald-700' };

/** A fall in the weighted figure is said in red only where it is a signal: a deal lost, or due later than the quarter. A won deal leaves the forecast because it is won. */
const SIGNAL: ReadonlySet<MoveGroup> = new Set(['LOST', 'LEFT_QUARTER', 'REVALUED']);

export function SinceLastWeek({ rows, previous, quarter, readable, source, live }: { rows: readonly PipelinePosition[]; previous: { at: string; rows: readonly PipelinePosition[] } | null; quarter: string; readable: PipelineReadable; source: string; live: boolean }) {
  const [only, setOnly] = useState<MoveGroup | null>(null);
  const [all, setAll] = useState(false);
  const label = quarterLabel(quarter);

  if (!previous) {
    return (
      <section id="moved" className="mt-10 scroll-mt-6">
        <SectionHead title="What moved since last week" caveat="two states of the pipeline side by side" />
        <p className="mt-3 max-w-reading text-ui text-ink-500">HELM holds no state of the pipeline from a week or more ago yet. Once it does, this says which deals moved and what that did to {label}.</p>
      </section>
    );
  }

  const since = day(previous.at);
  const m = pipelineMoves(previous.rows, rows, quarter);
  const lines = only ? m.changes.filter((c) => c.group === only) : m.changes;
  const shown = all ? lines : lines.slice(0, SHOWN);
  const weightedReadable = readable.value && readable.probability;
  const delta = (v: string | null, cur: string | null) => (weightedReadable ? displayDelta(v, 'currency', cur) : 'withheld');

  return (
    <section id="moved" className="mt-10 scroll-mt-6">
      <SectionHead title={`What moved since ${since}`} meta={`${m.changes.length} of ${m.changes.length + m.unchanged} deals changed`} caveat={`the state of ${since} against today’s · nothing is ranked`} />
      {m.changes.length === 0 ? (
        <p className="mt-3 max-w-reading text-ui text-ink-500">No deal changed in what HELM compares: state, close period, value, probability and stage.</p>
      ) : (
        <>
          {m.walk && m.walk.before.value === null && m.walk.now.value === null ? (
            <p className="mt-3 max-w-reading text-dense text-ink-600">No open deal with a value and a probability is due in {label}, then or now: there is no weighted figure to walk.</p>
          ) : m.walk ? (
            <table className="mt-3 w-full max-w-[560px] border-collapse">
              <thead>
                <tr>
                  <th className="ledger-th">From {since} to today</th>
                  <th className="ledger-th text-right">Deals</th>
                  <th className="ledger-th text-right">Weighted, due in {label}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="ledger-td text-dense text-ink-700">Weighted on {since}</td>
                  <td className="ledger-td" />
                  <td className="ledger-td text-right font-mono text-dense tabular text-ink-900">{weightedReadable ? moneyText(m.walk.before) : 'withheld'}</td>
                </tr>
                {m.walk.lines.map((l) => (
                  <tr key={l.group}>
                    <td className="ledger-td text-dense">
                      <button type="button" onClick={() => setOnly(only === l.group ? null : l.group)} aria-pressed={only === l.group} className={cn('text-left hover:text-accent-700 hover:underline', only === l.group ? 'font-medium text-accent-700' : 'text-ink-900')}>
                        {groupLabel(l.group, label, since)}
                      </button>
                    </td>
                    <td className="ledger-td text-right font-mono text-dense tabular text-ink-700">{l.count}</td>
                    <td className={cn('ledger-td whitespace-nowrap text-right font-mono text-dense tabular', l.group === 'WON' ? 'text-emerald-700' : Number(l.weighted.value) < 0 && SIGNAL.has(l.group) ? 'text-red-700' : 'text-ink-700')}>{delta(l.weighted.value, l.weighted.currency)}</td>
                  </tr>
                ))}
                <tr className="border-t-[3px] border-double border-ink-400">
                  <td className="px-3 py-[10px] text-dense font-medium text-ink-950">Weighted today</td>
                  <td className="px-3 py-[10px]" />
                  <td className="px-3 py-[10px] text-right font-mono text-dense font-medium tabular text-ink-950">{weightedReadable ? moneyText(m.walk.now) : 'withheld'}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p className="mt-3 max-w-reading text-dense text-ink-600">The walk is not drawn: the deals are in more than one currency, and HELM never converts.</p>
          )}
          {m.walk && (m.walk.before.value !== null || m.walk.now.value !== null) && <p className="mt-2 max-w-reading text-meta text-ink-500">Each changed deal is counted once, under the first line that applies. Weighted = value × probability, open deals due in {label}.</p>}

          <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label="Show only">
            <Chip on={only === null} onClick={() => setOnly(null)}>All · {m.changes.length}</Chip>
            {only && <Chip on onClick={() => setOnly(null)}>{groupLabel(only, label, since)} · {lines.length}</Chip>}
          </div>
          <ul className="mt-2">
            {shown.map((c) => {
              const effect = Math.round((c.weightedNow - c.weightedBefore) * 100) / 100;
              const cur = c.deal.currency ?? c.before?.currency ?? null;
              return (
                <li key={c.deal.opportunityId} className="border-b border-ink-200 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="min-w-0 flex-1 text-ui text-ink-950">
                      <span className="font-medium">{c.deal.opportunity}</span>
                      {c.deal.customer && <span className="text-ink-600"> · {c.deal.customer}</span>}
                    </span>
                    <span className="whitespace-nowrap font-mono text-dense tabular text-ink-700">
                      {c.deal.value === null ? '—' : displayValue(c.deal.value, 'currency', c.deal.currency)}
                      {weightedReadable && effect !== 0 ? <span className={c.group === 'WON' ? 'text-emerald-700' : effect < 0 && SIGNAL.has(c.group) ? 'text-red-700' : 'text-ink-500'}> · {displayDelta(String(effect), 'currency', cur)} weighted</span> : null}
                    </span>
                  </div>
                  <p className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-dense">
                    {c.moves.map((mv) => {
                      const s = said(mv, c, label, since);
                      return <span key={mv.kind} className={TONE[s.tone]}>{s.text}</span>;
                    })}
                    {live && c.deal.sourceId && (
                      <a href={memoireDealUrl(c.deal.sourceId)} target="_blank" rel="noreferrer" className="ml-auto whitespace-nowrap text-meta font-medium text-accent-700 hover:underline">
                        Open in {source} ↗
                      </a>
                    )}
                  </p>
                </li>
              );
            })}
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
