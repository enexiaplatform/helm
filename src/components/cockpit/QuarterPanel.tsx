import { Link } from 'react-router-dom';
import { byBrand, readQuarter, staleDeals, pipelineFacts, type Money, type PipelinePosition, type PipelineReadable } from '@helm/twin-runtime';
import { displayValue } from '../../services/scenarioRuntime.ts';
import { SectionHead } from '../ui/SectionHead.tsx';
import { TargetLine } from './TargetLine.tsx';
import { RateControl } from '../ui/RateControl.tsx';
import { MarginEditor } from './MarginEditor.tsx';
import type { BrandMargin } from '../../services/brandMargins.ts';
import { converted, useReadingRate, type ReadingRate } from '../../lib/readingRate.ts';
import type { QuarterTarget } from '../../services/quarterTargets.ts';

/**
 * The quarter on the Cockpit, as a manager reads it (audit 2026-10-13, Manager and GM: "how much will we close this
 * quarter, which deals are at risk, what must the team fix this week"). Every figure is arithmetic on Memoire's own
 * facts, by deal state: lost and won deals are never in the forecast, and each deal counts in the quarter it is due to
 * close in. Each risk and each gap links to the Pipeline table filtered to exactly those deals.
 */

export const moneyText = (m: Money): string =>
  m.value === null ? (m.mixed.length > 1 ? `mixed ${m.mixed.join('/')}` : '—') : displayValue(m.value, 'currency', m.currency);

export const quarterLabel = (q: string): string => {
  const [y, n] = q.split('-');
  return `${n} ${y}`;
};

/** The Cockpit's headline: what the quarter holds, in one sentence with its numbers. */
export function quarterHeadline(rows: readonly PipelinePosition[], quarter: string): string {
  const q = readQuarter(rows, quarter);
  const label = quarterLabel(quarter);
  if (q.open.count === 0) return `${label}: no open deal is in the pipeline.`;
  const closing =
    q.inQuarter.count === 0
      ? `no open deal is due to close in ${label}`
      : `${q.inQuarter.count} open ${q.inQuarter.count === 1 ? 'deal' : 'deals'} worth ${moneyText(q.inQuarter.value)} ${q.inQuarter.count === 1 ? 'is' : 'are'} due to close, ${moneyText(q.inQuarter.weighted)} weighted by probability`;
  const late = q.overdue.count > 0 ? ` ${q.overdue.count} more ${q.overdue.count === 1 ? 'is' : 'are'} past ${q.overdue.count === 1 ? 'its' : 'their'} close date.` : '';
  return `${label}: ${closing}.${late}`;
}

/** "≈ 21.5B VND": a figure read at the reader's own rate, or nothing. */
const inReading = (m: Money, r: ReadingRate | null): string | null => {
  const v = converted(m.value, m.currency, r);
  return v === null || !r ? null : `≈ ${displayValue(String(Math.round(v)), 'currency', r.to)}`;
};

const Figure = ({ label, value, sub, to, change, alt }: { label: string; value: string; sub: string; to?: string; change?: string | null; alt?: string | null }) => (
  <div className="min-w-0">
    <dt className="text-meta text-ink-500">{label}</dt>
    <dd className="font-serif text-figure-sm text-ink-950">{to ? <Link to={to} className="hover:text-accent-700">{value}</Link> : value}</dd>
    {alt && <dd className="font-mono text-meta text-ink-600">{alt}</dd>}
    <dd className="font-mono text-meta text-ink-500">{sub}</dd>
    {change && <dd className="font-mono text-meta text-ink-600">{change}</dd>}
  </div>
);

/** "+12.5K SGD since 6 Oct": the difference of two sums in one currency, or nothing. */
const changeOf = (now: Money, before: Money | undefined, since: string): string | null => {
  if (!before || now.value === null || before.value === null || now.currency !== before.currency) return null;
  const d = Number(now.value) - Number(before.value);
  if (d === 0) return `unchanged since ${since}`;
  return `${d > 0 ? '+' : '−'}${displayValue(String(Math.abs(d)), 'currency', now.currency)} since ${since}`;
};

export function QuarterPanel({ rows, previous, quarter, now, readable, source, target = null, onSetTarget = null, margins = null, onSetMargins = null }: { rows: readonly PipelinePosition[]; previous?: { at: string; rows: readonly PipelinePosition[] } | null; quarter: string; now: string; readable: PipelineReadable; source: string; target?: QuarterTarget | null; onSetTarget?: ((amount: number, currency: string) => Promise<void>) | null; margins?: ReadonlyMap<string, BrandMargin> | null; onSetMargins?: ((rows: { brand: string; pct: number }[]) => Promise<void>) | null }) {
  const rate = useReadingRate();
  if (rows.length === 0) return null;
  const q = readQuarter(rows, quarter);
  const p = previous ? readQuarter(previous.rows, quarter) : null;
  const since = previous ? new Date(previous.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '';
  const label = quarterLabel(quarter);
  const { stale, neverTouched } = staleDeals(rows, now);
  const open = rows.filter((r) => r.state === 'OPEN');
  const f = pipelineFacts(open, readable);
  const brands = byBrand(rows, quarter).filter((b) => b.open > 0 || b.won > 0);
  const anyBrand = brands.some((b) => b.brand !== null);

  const risks = [
    q.overdue.count > 0 && { text: `${q.overdue.count} open ${q.overdue.count === 1 ? 'deal is' : 'deals are'} past ${q.overdue.count === 1 ? 'its' : 'their'} close date (${moneyText(q.overdue.value)}): close, lose or re-date ${q.overdue.count === 1 ? 'it' : 'them'} in ${source}.`, to: '/pipeline?when=overdue' },
    stale.length > 0 && { text: `${stale.length} open ${stale.length === 1 ? 'deal has' : 'deals have'} not been touched for 30 days or more.`, to: '/pipeline?fix=stale&sort=touch&dir=asc' },
    q.inQuarter.noProbability > 0 && { text: `${q.inQuarter.noProbability} of the deals due in ${label} carry no probability, so they add nothing to the weighted figure.`, to: '/pipeline?when=quarter&fix=noprob' },
    q.inQuarter.yearNotStated > 0 && { text: `${q.inQuarter.yearNotStated} ${q.inQuarter.yearNotStated === 1 ? 'deal states' : 'deals state'} “Q${quarter.slice(-1)}” without a year; ${q.inQuarter.yearNotStated === 1 ? 'it is' : 'they are'} counted in ${label}.`, to: '/pipeline?when=quarter' },
  ].filter((x): x is { text: string; to: string } => typeof x === 'object' && x !== null);

  const gaps = [
    f.zeroValue > 0 && { text: `${f.zeroValue} open ${f.zeroValue === 1 ? 'deal states' : 'deals state'} a value of 0`, to: '/pipeline?fix=zero' },
    f.noValue > 0 && { text: `${f.noValue} have no value`, to: '/pipeline?fix=novalue' },
    f.noProbability > 0 && { text: `${f.noProbability} have no probability`, to: '/pipeline?fix=noprob' },
    f.noClosePeriod > 0 && { text: `${f.noClosePeriod} have no close period`, to: '/pipeline?fix=noclose' },
    f.withoutCustomer > 0 && { text: `${f.withoutCustomer} have no customer`, to: '/pipeline?fix=nocustomer' },
    neverTouched.length > 0 && { text: `${neverTouched.length} have no recorded touch`, to: null },
  ].filter((x): x is { text: string; to: string | null } => typeof x === 'object' && x !== null);

  return (
    <section id="pipeline" className="mt-8 scroll-mt-6">
      <SectionHead title={`This quarter · ${label}`} meta={`${q.open.count} open`} caveat={`from ${source}, by deal state`} />
      <p className="mt-2"><RateControl from={q.open.value.currency} /></p>
      <dl className="mt-3 flex flex-wrap gap-x-10 gap-y-4">
        <Figure label={`Weighted, due in ${label}`} value={readable.value && readable.probability ? moneyText(q.inQuarter.weighted) : 'withheld'} sub={`value × probability · ${q.inQuarter.count} deals`} to="/pipeline?when=quarter&sort=weighted" alt={inReading(q.inQuarter.weighted, rate)} change={readable.value && readable.probability ? changeOf(q.inQuarter.weighted, p?.inQuarter.weighted, since) : null} />
        <Figure label={`Due to close in ${label}`} value={readable.value ? moneyText(q.inQuarter.value) : 'withheld'} sub="full value, open deals" to="/pipeline?when=quarter&sort=value" alt={inReading(q.inQuarter.value, rate)} change={readable.value ? changeOf(q.inQuarter.value, p?.inQuarter.value, since) : null} />
        <Figure label={`Won in ${label}`} value={readable.value ? moneyText(q.won.inQuarterValue) : 'withheld'} sub={`${q.won.inQuarter} won · as ${source} records it`} to="/pipeline?state=won" />
        <Figure label="Open pipeline" value={readable.value ? moneyText(q.open.value) : 'withheld'} sub={`${q.open.count} open deals, any quarter`} to="/pipeline" alt={inReading(q.open.value, rate)} change={readable.value ? changeOf(q.open.value, p?.open.value, since) : null} />
        <Figure label="Lost" value={String(q.lost.count)} sub={readable.value ? `${moneyText(q.lost.value)} · never forecast` : 'never forecast'} to="/pipeline?state=lost" />
      </dl>

      {readable.value && readable.probability && <TargetLine q={q} label={label} target={target} onSet={onSetTarget} />}

      {(risks.length > 0 || gaps.length > 0) && (
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          {risks.length > 0 && (
            <div>
              <p className="helm-label">At risk</p>
              <ul className="mt-1 grid">
                {risks.map((r) => (
                  <li key={r.text} className="border-b border-ink-200 py-2 text-dense text-ink-800">
                    {r.text} <Link to={r.to} className="whitespace-nowrap font-medium text-accent-700 hover:underline">See them →</Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {gaps.length > 0 && (
            <div>
              <p className="helm-label">Data to fix in {source}</p>
              <ul className="mt-1 grid">
                {gaps.map((g) => (
                  <li key={g.text} className="border-b border-ink-200 py-2 text-dense text-ink-800">
                    {g.text}. {g.to && <Link to={g.to} className="whitespace-nowrap font-medium text-accent-700 hover:underline">List →</Link>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {anyBrand && readable.value && (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse">
            <thead>
              <tr>
                <th className="ledger-th">Brand</th>
                <th className="ledger-th text-right">Open</th>
                <th className="ledger-th text-right">Open value</th>
                <th className="ledger-th text-right">Due {label}</th>
                <th className="ledger-th text-right">Weighted</th>
                <th className="ledger-th text-right">Won · lost</th>
                {margins && margins.size > 0 && <th className="ledger-th text-right">Margin % (assumed)</th>}
                {margins && margins.size > 0 && <th className="ledger-th text-right">Est. margin on weighted</th>}
              </tr>
            </thead>
            <tbody>
              {brands.map((b) => (
                <tr key={b.brand ?? '—'} className="border-b border-ink-200">
                  <td className="px-3 py-2 text-dense text-ink-900">
                    <Link to={`/pipeline?brand=${encodeURIComponent(b.brand ?? '—')}`} className="hover:text-accent-700 hover:underline">{b.brand ?? 'No brand stated'}</Link>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-dense">{b.open}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-dense">{moneyText(b.openValue)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-dense">{moneyText(b.inQuarterValue)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-dense">{readable.probability ? moneyText(b.weighted) : 'withheld'}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-dense text-ink-600">{b.won} · {b.lost}</td>
                  {margins && margins.size > 0 && (() => {
                    const m = b.brand ? margins.get(b.brand) : undefined;
                    const est = m && b.weighted.value !== null ? (Number(b.weighted.value) * m.pct) / 100 : null;
                    return (
                      <>
                        <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-dense text-ink-600" title={m ? `stated ${m.recordedAt.slice(0, 10)}` : undefined}>{m ? `${m.pct}%` : '—'}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-dense text-ink-600">{est === null ? '—' : displayValue(String(Math.round(est)), 'currency', b.weighted.currency)}</td>
                      </>
                    );
                  })()}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 font-mono text-meta text-ink-500">In the order brands first appear in {source}. Sort them on the <Link to="/pipeline" className="text-accent-700 hover:underline">Pipeline</Link>.</p>
          {margins && margins.size > 0 && <p className="mt-1 text-meta text-ink-500">Margins are assumptions stated in HELM, not measured: no cost of goods is connected. The estimate is weighted value × assumed margin %.</p>}
          {onSetMargins && margins && <MarginEditor brands={brands.map((b) => b.brand).filter((x): x is string => x !== null)} margins={margins} onSave={onSetMargins} />}
        </div>
      )}
    </section>
  );
}
