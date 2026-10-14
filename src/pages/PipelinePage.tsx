/**
 * Pipeline — every deal HELM reads, as a table the reader sorts and filters (audit 2026-10-13: "not ranking is right;
 * not letting me sort is wrong — separate the two"). The order is the reader's choice, said back in the caption; HELM
 * itself still ranks nothing. Each row links to the deal in Memoire, where it is corrected.
 */

import { useMemo, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { closesIn, quarterOf, readQuarter, staleDeals, type PipelinePosition } from '@helm/twin-runtime';
import { PageHeader } from '../components/ui/PageHeader.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { memoireDealUrl, usePipeline } from '../services/pipelineView.ts';
import { displayValue } from '../services/scenarioRuntime.ts';
import { cn } from '../lib/cn.ts';
import { Button } from '../components/ui/Button.tsx';
import { RateControl } from '../components/ui/RateControl.tsx';
import { converted, readRate, useReadingRate } from '../lib/readingRate.ts';
import { quarterLabel } from '../components/cockpit/QuarterPanel.tsx';

type SortKey = 'deal' | 'customer' | 'brand' | 'stage' | 'close' | 'value' | 'probability' | 'weighted' | 'touch';
const SORT_LABEL: Record<SortKey, string> = { deal: 'deal', customer: 'customer', brand: 'brand', stage: 'stage', close: 'close period', value: 'value', probability: 'probability', weighted: 'weighted value', touch: 'last touch' };

const STATES = [
  ['open', 'Open'],
  ['won', 'Won'],
  ['lost', 'Lost'],
  ['hold', 'On hold'],
  ['all', 'All'],
] as const;
const WHEN = [
  ['all', 'Any close period'],
  ['quarter', 'Closing this quarter'],
  ['overdue', 'Past their close period'],
  ['noclose', 'No close period'],
] as const;
const FIX = [
  ['', 'Any data'],
  ['zero', 'Value of 0'],
  ['novalue', 'No value'],
  ['noprob', 'No probability'],
  ['noclose', 'No close period'],
  ['nocustomer', 'No customer'],
  ['stale', 'Untouched 30+ days'],
] as const;

const weighted = (r: PipelinePosition): number | null => (r.value === null || r.probability === null ? null : Number(r.value) * Number(r.probability));
const closeIndex = (r: PipelinePosition): number | null => {
  const q = quarterOf(r.expectedClosePeriod);
  return q && q.year ? Number(q.year) * 4 + q.quarter : null;
};

function sortValue(r: PipelinePosition, k: SortKey): string | number | null {
  switch (k) {
    case 'deal': return r.opportunity.toLowerCase();
    case 'customer': return r.customer?.toLowerCase() ?? null;
    case 'brand': return r.brand?.toLowerCase() ?? null;
    case 'stage': return r.stage?.toLowerCase() ?? null;
    case 'close': return closeIndex(r);
    case 'value': return r.value === null ? null : Number(r.value);
    case 'probability': return r.probability === null ? null : Number(r.probability);
    case 'weighted': return weighted(r);
    case 'touch': return r.lastTouchAt ? Date.parse(r.lastTouchAt) : null;
  }
}

/** The deals shown, as a CSV the reader saves: exact values, not the rounded ones on screen. */
function downloadCsv(rows: readonly PipelinePosition[], name: string) {
  const cell = (v: string | number | null) => {
    const s = v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // A reader who reads in another currency gets that column too, headed with the rate it used.
  const rate = readRate();
  const head = ['Deal', 'Customer', 'Brand', 'Stage', 'State', 'Close period', 'Value', 'Currency', 'Probability', 'Weighted', 'Last touch', 'Memoire id', ...(rate ? [`Value in ${rate.to} at 1 ${rate.from} = ${rate.rate}`] : [])];
  const lines = rows.map((r) => [r.opportunity, r.customer, r.brand, r.stage, r.state, r.expectedClosePeriod, r.value, r.currency, r.probability, weighted(r), r.lastTouchAt?.slice(0, 10) ?? null, r.sourceId, ...(rate ? [converted(r.value, r.currency, rate)] : [])].map(cell).join(','));
  // A byte-order mark so Excel reads Vietnamese names as UTF-8.
  const blob = new Blob(['﻿' + [head.join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const money = (v: number | string | null, currency: string | null) => (v === null ? '—' : displayValue(String(v), 'currency', currency));
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

export function PipelinePage() {
  const { data, error, empty } = usePipeline();
  // Read before any early return, as every hook must be.
  const readingRate = useReadingRate();
  const [params, setParams] = useSearchParams();
  const state = params.get('state') ?? 'open';
  const when = params.get('when') ?? 'all';
  const fix = params.get('fix') ?? '';
  const brand = params.get('brand') ?? '';
  const text = params.get('q') ?? '';
  const sort = (params.get('sort') as SortKey | null) ?? null;
  const dir = params.get('dir') === 'asc' ? 'asc' : 'desc';
  const set = (k: string, v: string | null) => {
    const n = new URLSearchParams(params);
    if (v === null || v === '') n.delete(k);
    else n.set(k, v);
    setParams(n, { replace: true });
  };

  const view = useMemo(() => {
    if (!data) return null;
    const { rows, quarter, now } = data;
    const stale = new Set(staleDeals(rows, now).stale.map((r) => r.opportunityId));
    const [y, q] = quarter.split('-Q');
    const nowIndex = Number(y) * 4 + Number(q);
    const matches = rows.filter((r) => {
      if (state === 'open' && r.state !== 'OPEN') return false;
      if (state === 'won' && r.state !== 'WON') return false;
      if (state === 'lost' && r.state !== 'LOST') return false;
      if (state === 'hold' && r.state !== 'ON_HOLD') return false;
      if (when === 'quarter' && closesIn(r.expectedClosePeriod, quarter) === 'NO') return false;
      if (when === 'overdue' && !((closeIndex(r) ?? Infinity) < nowIndex)) return false;
      if (when === 'noclose' && r.expectedClosePeriod !== null) return false;
      if (fix === 'zero' && !(r.value !== null && Number(r.value) === 0)) return false;
      if (fix === 'novalue' && r.value !== null) return false;
      if (fix === 'noprob' && r.probability !== null) return false;
      if (fix === 'noclose' && r.expectedClosePeriod !== null) return false;
      if (fix === 'nocustomer' && r.customer !== null) return false;
      if (fix === 'stale' && !stale.has(r.opportunityId)) return false;
      if (brand === '—' ? r.brand !== null : brand && r.brand !== brand) return false;
      if (text && !`${r.opportunity} ${r.customer ?? ''} ${r.brand ?? ''}`.toLowerCase().includes(text.toLowerCase())) return false;
      return true;
    });
    const sorted = sort
      ? [...matches].sort((a, b) => {
          const va = sortValue(a, sort);
          const vb = sortValue(b, sort);
          // Rows without the value sit at the end whichever way the reader sorts.
          if (va === null && vb === null) return 0;
          if (va === null) return 1;
          if (vb === null) return -1;
          const c = va < vb ? -1 : va > vb ? 1 : 0;
          return dir === 'asc' ? c : -c;
        })
      : matches;
    const brands = [...new Set(rows.map((r) => r.brand).filter((b): b is string => b !== null))].sort((a, b) => a.localeCompare(b));
    return { sorted, brands, totals: readQuarter(matches, quarter), stale };
  }, [data, state, when, fix, brand, text, sort, dir]);

  if (error) return <EmptyState title="The pipeline could not be read" detail={error} />;
  if (empty) return <EmptyState title="No pipeline yet" detail="HELM has not composed a state from your source yet. Press Refresh at the top to read it." />;
  if (!data || !view) return <p className="text-ui text-ink-500">Reading the pipeline…</p>;

  const live = data.mode === 'cloud';
  const reading = readingRate;
  const currency = view.totals.open.value.currency ?? view.totals.won.value.currency;
  const allValue = view.sorted.reduce<number | null>((t, r) => (r.value === null ? t : (t ?? 0) + Number(r.value)), null);
  const allWeighted = view.sorted.reduce<number | null>((t, r) => (weighted(r) === null ? t : (t ?? 0) + weighted(r)!), null);
  const currencies = new Set(view.sorted.filter((r) => r.value !== null).map((r) => r.currency));
  const select = 'max-w-full rounded-md border border-ink-200 bg-white px-2 py-[6px] text-dense';
  const th = (k: SortKey, label: string, align: 'left' | 'right' = 'left'): ReactNode => (
    <th scope="col" className={cn('ledger-th whitespace-nowrap', align === 'right' && 'text-right')}>
      <button
        type="button"
        className="uppercase hover:text-ink-950"
        onClick={() => {
          const n = new URLSearchParams(params);
          if (sort === k && dir === 'desc') n.set('dir', 'asc');
          else if (sort === k) {
            n.delete('sort');
            n.delete('dir');
          } else {
            n.set('sort', k);
            n.set('dir', 'desc');
          }
          setParams(n, { replace: true });
        }}
        aria-sort={sort === k ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {label}
        {sort === k ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  );

  return (
    <>
      <PageHeader
        kicker={`Management · Pipeline · as read on ${day(data.composedAt)}`}
        title={`${view.sorted.length} ${view.sorted.length === 1 ? 'deal' : 'deals'} shown${allValue !== null && currencies.size === 1 ? `, worth ${money(allValue, currency)}` : ''}.`}
        lede={live ? 'Every deal HELM reads from Memoire. Sort and filter it as you need; open a deal in Memoire to correct it.' : 'Every deal of the demo organization. Sort and filter it as you need.'}
        size="instrument"
      />

      <div className="mt-5 flex flex-wrap items-end gap-3">
        <label className="grid gap-1">
          <span className="helm-label">Deals</span>
          <select className={select} value={state} onChange={(e) => set('state', e.target.value === 'open' ? null : e.target.value)}>
            {STATES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="helm-label">Close</span>
          <select className={select} value={when} onChange={(e) => set('when', e.target.value === 'all' ? null : e.target.value)}>
            {WHEN.map(([v, l]) => <option key={v} value={v}>{v === 'quarter' ? `Closing in ${quarterLabel(data.quarter)}` : l}</option>)}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="helm-label">Brand</span>
          <select className={select} value={brand} onChange={(e) => set('brand', e.target.value)}>
            <option value="">All brands</option>
            {view.brands.map((b) => <option key={b} value={b}>{b}</option>)}
            <option value="—">No brand stated</option>
          </select>
        </label>
        <label className="grid gap-1">
          <span className="helm-label">Data</span>
          <select className={select} value={fix} onChange={(e) => set('fix', e.target.value)}>
            {FIX.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="grid min-w-[200px] flex-1 gap-1">
          <span className="helm-label">Search</span>
          <input className={select} value={text} onChange={(e) => set('q', e.target.value)} placeholder="Deal, customer or brand" />
        </label>
        <Button variant="secondary" size="sm" className="mb-[2px]" onClick={() => downloadCsv(view.sorted, `helm-pipeline-${data.composedAt.slice(0, 10)}.csv`)} disabled={view.sorted.length === 0}>
          Download CSV
        </Button>
        {(state !== 'open' || when !== 'all' || fix || brand || text || sort) && (
          <button type="button" className="pb-[7px] text-dense font-medium text-accent-700 hover:underline" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
            Clear
          </button>
        )}
      </div>

      <p className="mt-3 font-mono text-meta text-ink-500">
        {sort ? `Sorted by you: ${SORT_LABEL[sort]}, ${dir === 'asc' ? 'low to high' : 'high to low'}.` : 'In the order HELM read them. Click a column to sort.'}
        {allWeighted !== null && currencies.size === 1 ? ` Weighted value of these deals: ${money(allWeighted, currency)}.` : ''}
        {currencies.size > 1 ? ` These deals carry ${[...currencies].join(', ')}; HELM does not convert currencies, so no total is shown.` : ''}
        {allValue !== null && currencies.size === 1 && converted(allValue, currency, reading) !== null ? ` ≈ ${money(Math.round(converted(allValue, currency, reading)!), reading!.to)} at your rate.` : ''}
      </p>
      <p className="mt-1"><RateControl from={currencies.size === 1 ? currency : null} /></p>

      {view.sorted.length === 0 ? (
        <p className="mt-6 text-ui text-ink-500">No deal matches these filters.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[960px] border-collapse">
            <thead>
              <tr>
                {th('deal', 'Deal')}
                {th('customer', 'Customer')}
                {th('brand', 'Brand')}
                {th('stage', 'Stage')}
                {th('close', 'Close')}
                {th('value', 'Value', 'right')}
                {th('probability', 'Prob.', 'right')}
                {th('weighted', 'Weighted', 'right')}
                {th('touch', 'Last touch')}
                {live && <th scope="col" className="ledger-th"><span className="sr-only">Open in Memoire</span></th>}
              </tr>
            </thead>
            <tbody>
              {view.sorted.map((r) => {
                const w = weighted(r);
                const year = quarterOf(r.expectedClosePeriod);
                return (
                  <tr key={r.opportunityId} className="border-b border-ink-200 align-top">
                    <td className="max-w-[280px] px-3 py-2 text-dense text-ink-950">{r.opportunity}</td>
                    <td className="max-w-[240px] px-3 py-2 text-dense text-ink-700">
                      <span className="line-clamp-2" title={r.customer ?? undefined}>{r.customer ?? <span className="text-red-700">No customer</span>}</span>
                    </td>
                    <td className="px-3 py-2 text-dense text-ink-700">{r.brand ?? '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-dense text-ink-700">
                      {r.stage ?? '—'}
                      {r.state === 'LOST' && <span className="ml-1 font-mono text-tag text-red-700">LOST</span>}
                      {r.state === 'WON' && <span className="ml-1 font-mono text-tag text-ink-950">WON</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-dense text-ink-700">
                      {r.expectedClosePeriod ?? <span className="text-red-700">none</span>}
                      {year && year.year === null && <span className="ml-1 text-tag text-amber-700" title="Memoire states the quarter without a year">no year</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-dense tabular text-ink-950">{r.value === null ? <span className="text-red-700">none</span> : money(r.value, r.currency)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-dense tabular text-ink-700">{r.probability === null ? <span className="text-red-700">none</span> : `${Math.round(Number(r.probability) * 100)}%`}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-dense tabular text-ink-700">{w === null || r.state !== 'OPEN' ? '—' : money(w, r.currency)}</td>
                    <td className={cn('whitespace-nowrap px-3 py-2 font-mono text-dense', view.stale.has(r.opportunityId) ? 'text-amber-700' : 'text-ink-500')}>{day(r.lastTouchAt)}</td>
                    {live && (
                      <td className="whitespace-nowrap px-3 py-2 text-right text-dense">
                        {r.sourceId ? (
                          <a href={memoireDealUrl(r.sourceId)} target="_blank" rel="noreferrer" className="font-medium text-accent-700 hover:underline">Memoire ↗</a>
                        ) : null}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 max-w-reading text-meta text-ink-500">
        Weighted = value × probability, for open deals only. Lost and won deals are never weighted. A close period written as a bare quarter (“Q4”) has no year; it is shown in this quarter and marked.{' '}
        <Link to="/" className="text-accent-700 hover:underline">Back to the Cockpit</Link>
      </p>
    </>
  );
}
