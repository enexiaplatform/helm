import { useMemo, useState } from 'react';
import { useHelmStore } from '../services/helmStore.ts';
import { PageHeader } from '../components/ui/PageHeader.tsx';
import { SectionHead } from '../components/ui/SectionHead.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { Notice } from '../components/ui/Notice.tsx';
import { Pill } from '../components/ui/Pill.tsx';
import { buildMarginLadder, buildVariances, type MarginLadder } from '../domain/engines/economics.ts';
import { formatMoney, formatPercent, periodLabel } from '../domain/format.ts';
import { costObjectKindLabels } from '../domain/types.ts';
import { cn } from '../lib/cn.ts';

/**
 * Economics: the margin ladder per cost object. The point of this page is the
 * distinction accountants blur — segment margin (decision-relevant) vs
 * reported net after allocation (misleading) — with the trap flagged.
 */

const NUM = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const word = (n: number) => NUM[n] ?? String(n);
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function EconomicsPage() {
  const costObjects = useHelmStore((s) => s.costObjects);
  const economics = useHelmStore((s) => s.economics);
  const currency = useHelmStore((s) => s.currency)();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const ladders = useMemo(
    () =>
      costObjects
        .filter((c) => c.active)
        .map((c) => buildMarginLadder(c, economics))
        .filter((l) => l.periods.length > 0)
        .sort((a, b) => b.revenue - a.revenue),
    [costObjects, economics],
  );

  const variances = useMemo(() => buildVariances(costObjects, economics), [costObjects, economics]);
  // The largest cost object opens until someone picks one.
  const selected = ladders.find((l) => l.costObjectId === selectedId) ?? ladders[0] ?? null;

  if (ladders.length === 0) {
    return (
      <>
        <PageHeader kicker="Management · Economics" title="No economics data yet." />
        <EmptyState
          className="mt-9"
          title="Nothing to put on the margin ladder"
          detail="Add cost objects (products, customers, business units) and their period economics to see the margin ladder and allocation-trap flags."
        />
      </>
    );
  }

  const trapped = ladders.filter((l) => l.allocationTrapped).length;
  const negative = ladders.filter((l) => l.segmentMargin < 0).length;
  const headline =
    [
      trapped > 0 && `${word(trapped)} ${plural(trapped, 'cost object looks', 'cost objects look')} unprofitable only after allocation.`,
      negative > 0 && `${word(negative)} ${plural(negative, 'loses', 'lose')} money before any allocation.`,
    ]
      .filter(Boolean)
      .join(' ') || 'Every cost object covers its own costs.';

  const latest = variances.map((x) => x.period).sort().at(-1);

  return (
    <>
      <PageHeader
        kicker="Management · Economics"
        title={headline}
        lede="The margin ladder per cost object. Segment margin is the decision line — allocated overhead is shown, not obeyed."
      />
      <div className="mt-9 flex flex-wrap items-start gap-10">
        <section className="min-w-0 flex-[1_1_620px]">
          <SectionHead title="Margin ladder by cost object" meta={`${ladders.length} cost objects`} caveat="select a row to read its ladder" />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] border-collapse">
              <thead>
                <tr>
                  {['Cost object', 'Revenue', 'CM', 'Segment margin', 'Reported net', ''].map((h, i) => (
                    <th key={i} className={cn('helm-label pb-2 pt-[14px]', i === 0 || i === 5 ? 'text-left' : 'pl-3 text-right')}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ladders.map((l) => (
                  <tr
                    key={l.costObjectId}
                    className={cn('cursor-pointer border-t border-ink-200 align-top hover:bg-white/60', selected?.costObjectId === l.costObjectId && 'bg-accent-50 hover:bg-accent-50')}
                    onClick={() => setSelectedId(l.costObjectId)}
                  >
                    <td className="py-3 pl-2">
                      <span className="block text-ui font-semibold">{l.name}</span>
                      <span className="helm-meta">
                        {costObjectKindLabels[l.kind]} · {l.periods.map(periodLabel).join(', ')}
                      </span>
                    </td>
                    <td className="py-3 pl-3 text-right font-mono text-dense">{formatMoney(l.revenue, currency)}</td>
                    <td className="py-3 pl-3 text-right font-mono text-dense">
                      {formatMoney(l.contributionMargin, currency)}
                      {l.contributionMarginRatio !== null && <span className="helm-meta block">{formatPercent(l.contributionMarginRatio)}</span>}
                    </td>
                    <td className={cn('py-3 pl-3 text-right font-mono text-dense font-semibold', l.segmentMargin >= 0 ? 'text-emerald-700' : 'text-red-700')}>
                      {formatMoney(l.segmentMargin, currency)}
                    </td>
                    <td className={cn('py-3 pl-3 text-right font-mono text-dense', l.reportedNet < 0 && 'text-red-700')}>
                      {formatMoney(l.reportedNet, currency)}
                    </td>
                    <td className="py-3 pl-3 pr-2">
                      {l.allocationTrapped && (
                        <span title="Reported net is negative only because of allocated overhead — the segment still funds common costs.">
                          <Pill tone="accepted">allocation trap</Pill>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="grid max-w-[380px] flex-[1_1_300px] gap-8">
          {selected && <LadderDetail ladder={selected} currency={currency} />}
          <div>
            <h2 className="mb-1 text-panel">Budget against actual</h2>
            <p className="helm-caveat mb-[10px]">{latest ? `revenue, ${periodLabel(latest)}` : 'no budget rows to compare'}</p>
            {variances
              .filter((v) => v.period === latest)
              .map((v) => (
                <div key={`${v.costObjectId}:${v.period}`} className="flex items-baseline justify-between gap-3 border-t border-ink-200 py-2">
                  <span className="min-w-0 truncate text-dense text-ink-700">{v.name}</span>
                  <span className={cn('shrink-0 font-mono text-dense font-medium', (v.revenueVariancePct ?? 0) < 0 ? 'text-red-700' : 'text-emerald-700')}>
                    {v.revenueVariancePct !== null ? `${v.revenueVariancePct > 0 ? '+' : ''}${formatPercent(v.revenueVariancePct)}` : '—'}
                  </span>
                </div>
              ))}
          </div>
        </aside>
      </div>
    </>
  );
}

function LadderDetail({ ladder, currency }: { ladder: MarginLadder; currency: string }) {
  const rows: { label: string; amount: number; strong?: boolean; muted?: boolean }[] = [
    { label: 'Revenue', amount: ladder.revenue, strong: true },
    { label: '− Variable cost', amount: -ladder.variableCost },
    { label: '= Contribution margin', amount: ladder.contributionMargin, strong: true },
    { label: '− Traceable fixed costs', amount: -ladder.traceableFixedCost },
    { label: '= Segment margin', amount: ladder.segmentMargin, strong: true },
    { label: '− Allocated corporate costs', amount: -ladder.allocatedFixedCost, muted: true },
    { label: '= Reported net', amount: ladder.reportedNet, muted: true },
  ];
  return (
    <section className="rounded-xl border border-ink-200 bg-white">
      <div className="border-b border-ink-200 px-5 py-[14px]">
        <h2 className="text-panel">{ladder.name}</h2>
        <p className="helm-meta">{costObjectKindLabels[ladder.kind]}</p>
      </div>
      <div className="px-5 pb-4 pt-[6px]">
        {rows.map((r, i) => (
          <div key={r.label} className={cn('flex items-baseline justify-between gap-3 py-2', i < rows.length - 1 && 'border-b border-ink-100', r.muted && 'text-ink-500')}>
            <span className={cn('text-dense', r.strong && 'font-semibold')}>{r.label}</span>
            <span className={cn('font-mono text-dense', r.strong && 'font-semibold', r.amount < 0 && r.strong && 'text-red-700')}>
              {formatMoney(r.amount, currency)}
            </span>
          </div>
        ))}
        {ladder.allocationTrapped && (
          <Notice tone="warning" label="Allocation trap" className="mt-3">
            Reported net is negative, but this segment covers all its own costs and contributes{' '}
            {formatMoney(ladder.segmentMargin, currency)} toward common overhead. Dropping it would make the company worse
            off by that amount — the allocated costs would simply land elsewhere.
          </Notice>
        )}
        {ladder.segmentMargin < 0 && (
          <Notice tone="error" className="mt-3">
            Segment margin is negative before any allocation — this is a real economics problem, worth a keep-vs-drop decision.
          </Notice>
        )}
      </div>
    </section>
  );
}
