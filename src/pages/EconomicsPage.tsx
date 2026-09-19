import { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useHelmStore } from '../services/helmStore.ts';
import { PanelCard, EmptyState } from '../components/ui.tsx';
import { buildMarginLadder, buildVariances, type MarginLadder } from '../domain/engines/economics.ts';
import { formatMoney, formatPercent, periodLabel } from '../domain/format.ts';
import { costObjectKindLabels } from '../domain/types.ts';

/**
 * Economics: the margin ladder per cost object. The point of this page is the
 * distinction accountants blur — segment margin (decision-relevant) vs
 * reported net after allocation (misleading) — with the trap flagged.
 */
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
  const selected = ladders.find((l) => l.costObjectId === selectedId) ?? null;

  if (ladders.length === 0) {
    return (
      <div className="mx-auto max-w-5xl">
        <h1 className="mb-4 text-xl font-semibold">Economics</h1>
        <EmptyState
          title="No economics data yet"
          detail="Add cost objects (products, customers, business units) and their period economics to see the margin ladder and allocation-trap flags."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header>
        <h1 className="text-xl font-semibold">Economics</h1>
        <p className="text-sm text-ink-500">
          The margin ladder per cost object. Segment margin is the decision line — allocated overhead is shown, not
          obeyed.
        </p>
      </header>

      <div className="grid gap-4 xl:grid-cols-3">
        <PanelCard className="xl:col-span-2" title="Margin ladder by cost object">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="border-b border-ink-100">
                  <th className="table-th">Cost object</th>
                  <th className="table-th text-right">Revenue</th>
                  <th className="table-th text-right">CM</th>
                  <th className="table-th text-right">Segment margin</th>
                  <th className="table-th text-right">Reported net</th>
                  <th className="table-th" />
                </tr>
              </thead>
              <tbody>
                {ladders.map((l) => (
                  <tr
                    key={l.costObjectId}
                    className={`cursor-pointer border-b border-ink-50 last:border-0 hover:bg-ink-50/60 ${
                      selectedId === l.costObjectId ? 'bg-accent-50/50' : ''
                    }`}
                    onClick={() => setSelectedId(l.costObjectId)}
                  >
                    <td className="table-td">
                      <p className="font-medium">{l.name}</p>
                      <p className="text-2xs text-ink-400">
                        {costObjectKindLabels[l.kind]} · {l.periods.map(periodLabel).join(', ')}
                      </p>
                    </td>
                    <td className="table-td text-right tabular-nums">{formatMoney(l.revenue, currency)}</td>
                    <td className="table-td text-right tabular-nums">
                      {formatMoney(l.contributionMargin, currency)}
                      {l.contributionMarginRatio !== null && (
                        <span className="block text-2xs text-ink-400">{formatPercent(l.contributionMarginRatio)}</span>
                      )}
                    </td>
                    <td className={`table-td text-right font-semibold tabular-nums ${l.segmentMargin >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                      {formatMoney(l.segmentMargin, currency)}
                    </td>
                    <td className={`table-td text-right tabular-nums ${l.reportedNet >= 0 ? '' : 'text-red-700'}`}>
                      {formatMoney(l.reportedNet, currency)}
                    </td>
                    <td className="table-td">
                      {l.allocationTrapped && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-2xs font-semibold text-amber-800"
                          title="Reported net is negative only because of allocated overhead — the segment still funds common costs."
                        >
                          <AlertTriangle size={11} />
                          Allocation trap
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PanelCard>

        <div className="space-y-4">
          {selected ? (
            <LadderDetail ladder={selected} currency={currency} />
          ) : (
            <PanelCard title="Detail">
              <p className="text-xs text-ink-400">Select a row to see its full ladder.</p>
            </PanelCard>
          )}

          <PanelCard title="Budget vs actual (latest)">
            {variances.length === 0 ? (
              <p className="text-xs text-ink-400">No budget rows to compare.</p>
            ) : (
              <ul className="space-y-1.5 text-xs">
                {variances
                  .filter((v) => v.period === variances.map((x) => x.period).sort().at(-1))
                  .map((v) => (
                    <li key={`${v.costObjectId}:${v.period}`} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-ink-600">{v.name}</span>
                      <span
                        className={`shrink-0 font-medium tabular-nums ${
                          (v.revenueVariancePct ?? 0) < 0 ? 'text-red-700' : 'text-emerald-700'
                        }`}
                      >
                        {v.revenueVariancePct !== null
                          ? `${v.revenueVariancePct > 0 ? '+' : ''}${formatPercent(v.revenueVariancePct)}`
                          : '—'}{' '}
                        <span className="text-ink-400">vs budget</span>
                      </span>
                    </li>
                  ))}
              </ul>
            )}
          </PanelCard>
        </div>
      </div>
    </div>
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
    <PanelCard title={ladder.name}>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className={r.muted ? 'text-ink-400' : ''}>
              <td className={`py-1 ${r.strong ? 'font-semibold' : ''}`}>{r.label}</td>
              <td className={`py-1 text-right tabular-nums ${r.strong ? 'font-semibold' : ''} ${r.amount < 0 && r.strong ? 'text-red-700' : ''}`}>
                {formatMoney(r.amount, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {ladder.allocationTrapped && (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800">
          <strong>Allocation trap:</strong> reported net is negative, but this segment covers all its own costs and
          contributes {formatMoney(ladder.segmentMargin, currency)} toward common overhead. Dropping it would make the
          company worse off by that amount — the allocated costs would simply land elsewhere.
        </p>
      )}
      {ladder.segmentMargin < 0 && (
        <p className="mt-3 rounded-md border border-red-200 bg-red-50 p-2.5 text-xs text-red-700">
          Segment margin is negative before any allocation — this is a real economics problem, worth a keep-vs-drop
          decision.
        </p>
      )}
    </PanelCard>
  );
}
