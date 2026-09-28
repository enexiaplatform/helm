import { useMemo } from 'react';
import { Factory } from 'lucide-react';
import { useHelmStore } from '../services/helmStore.ts';
import { PageHeader, PanelCard, EmptyState, Stat } from '../components/ui.tsx';
import { analyzeProcess } from '../domain/engines/capacity.ts';
import { analyzeInventoryItem, analyzeWorkingCapital } from '../domain/engines/inventory.ts';
import { demoWorkingCapital } from '../data/demoOrg.ts';
import { formatMoney, formatNumber, formatPercent } from '../domain/format.ts';

/**
 * Operations: managerial diagnosis of processes (capacity, bottleneck, flow)
 * and inventory viewed as capital, risk, and service level. Not a BPM, not a
 * WMS — the outputs lead into decisions.
 */
export function OperationsPage() {
  const processes = useHelmStore((s) => s.processes);
  const activities = useHelmStore((s) => s.processActivities);
  const inventory = useHelmStore((s) => s.inventory);
  const mode = useHelmStore((s) => s.mode);
  const currency = useHelmStore((s) => s.currency)();

  const processAnalyses = useMemo(
    () => processes.map((p) => ({ process: p, analysis: analyzeProcess(p, activities.filter((a) => a.processId === p.id)) })),
    [processes, activities],
  );

  const inventoryAnalyses = useMemo(
    () => inventory.map((item) => ({ item, analysis: analyzeInventoryItem(item) })),
    [inventory],
  );

  // Working-capital inputs come from the demo dataset in demo mode; cloud
  // orgs will plug real balances in a later iteration rather than fake them.
  const wc = mode === 'demo' ? analyzeWorkingCapital(demoWorkingCapital) : null;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        icon={Factory}
        title="Operations"
        description="Capacity, bottlenecks, and inventory as capital — diagnosis, not execution."
      />

      {wc && (
        <div className="grid grid-cols-2 gap-4 rounded-lg border border-ink-200 bg-white px-5 py-4 shadow-panel sm:grid-cols-5">
          <Stat label="DOI" value={wc.doi !== null ? `${formatNumber(wc.doi)} d` : '—'} sub="days of inventory" />
          <Stat label="DSO" value={wc.dso !== null ? `${formatNumber(wc.dso)} d` : '—'} sub="days sales outstanding" />
          <Stat label="DPO" value={wc.dpo !== null ? `${formatNumber(wc.dpo)} d` : '—'} sub="days payables outstanding" />
          <Stat
            label="Cash conversion"
            value={wc.cashConversionCycleDays !== null ? `${formatNumber(wc.cashConversionCycleDays)} d` : '—'}
            sub="DOI + DSO − DPO"
            tone={(wc.cashConversionCycleDays ?? 0) > 60 ? 'warn' : 'neutral'}
          />
          <Stat label="Working capital" value={formatMoney(wc.workingCapital, currency)} />
        </div>
      )}

      <PanelCard title="Processes & capacity">
        {processAnalyses.length === 0 ? (
          <EmptyState title="No processes mapped" detail="Map a process's activities to see capacity, utilization, and the bottleneck." />
        ) : (
          <div className="space-y-5">
            {processAnalyses.map(({ process, analysis }) => (
              <div key={process.id}>
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold">{process.name}</h3>
                    <p className="text-2xs text-ink-500">{process.description}</p>
                  </div>
                  <p className="text-xs text-ink-600">
                    Demand {formatNumber(process.demandPerWeek)}/wk · capacity{' '}
                    {analysis.processCapacityPerWeek !== null ? formatNumber(analysis.processCapacityPerWeek) : '—'}/wk ·{' '}
                    <span className={`font-semibold ${analysis.utilization !== null && analysis.utilization >= 1 ? 'text-red-700' : analysis.utilization !== null && analysis.utilization >= 0.85 ? 'text-amber-700' : 'text-emerald-700'}`}>
                      {analysis.utilization !== null ? formatPercent(analysis.utilization, 0) : '—'} utilization
                    </span>
                  </p>
                </div>
                <div className="space-y-1.5">
                  {analysis.activities.map((a) => {
                    const u = a.utilization ?? 0;
                    return (
                      <div key={a.activityId} className="flex items-center gap-3 text-xs">
                        <span className="w-44 shrink-0 truncate">
                          {a.name}
                          {a.isBottleneck && (
                            <span className="ml-1.5 rounded bg-red-100 px-1.5 py-0.5 text-2xs font-semibold text-red-700">bottleneck</span>
                          )}
                        </span>
                        <div className="relative h-4 flex-1 overflow-hidden rounded bg-ink-50">
                          <div
                            className={`absolute inset-y-0 left-0 rounded ${u >= 1 ? 'bg-red-500' : u >= 0.85 ? 'bg-amber-500' : 'bg-accent-300'}`}
                            style={{ width: `${Math.min(100, u * 100)}%` }}
                          />
                        </div>
                        <span className="w-16 shrink-0 text-right tabular-nums text-ink-500">{formatPercent(u, 0)}</span>
                        <span className="w-24 shrink-0 text-right text-2xs text-ink-500">
                          {Number.isFinite(a.weeklyCapacity) ? `${formatNumber(a.weeklyCapacity)}/wk cap` : '—'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </PanelCard>

      <PanelCard title="Inventory as capital">
        {inventoryAnalyses.length === 0 ? (
          <EmptyState title="No inventory items" detail="Track items with demand, lead time, and stock to see reorder points, stock-out and expiry risk." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-ink-100">
                  <th className="table-th">Item</th>
                  <th className="table-th text-right">On hand + inbound</th>
                  <th className="table-th text-right">Reorder point</th>
                  <th className="table-th text-right">Safety stock</th>
                  <th className="table-th text-right">Days of cover</th>
                  <th className="table-th text-right">Capital tied up</th>
                  <th className="table-th">Risk</th>
                </tr>
              </thead>
              <tbody>
                {inventoryAnalyses.map(({ item, analysis }) => (
                  <tr key={item.id} className="border-b border-ink-50 last:border-0">
                    <td className="table-td">
                      <p className="font-medium">{item.name}</p>
                      <p className="text-2xs text-ink-500">
                        {item.sku} · demand {formatNumber(item.avgDailyDemand, 1)}/day · lead {formatNumber(item.leadTimeDays)}d
                      </p>
                    </td>
                    <td className="table-td text-right tabular-nums">
                      {formatNumber(item.stockOnHand)}
                      {item.stockInbound > 0 && <span className="text-ink-500"> +{formatNumber(item.stockInbound)}</span>}
                    </td>
                    <td className="table-td text-right tabular-nums">{formatNumber(analysis.reorderPoint)}</td>
                    <td className="table-td text-right tabular-nums">{formatNumber(analysis.safetyStock)}</td>
                    <td className="table-td text-right tabular-nums">
                      {analysis.daysUntilStockout !== null ? `${formatNumber(analysis.daysUntilStockout)} d` : '—'}
                    </td>
                    <td className="table-td text-right tabular-nums">{formatMoney(analysis.capitalTiedUp, currency)}</td>
                    <td className="table-td">
                      <div className="flex flex-wrap gap-1">
                        {analysis.stockoutRisk && (
                          <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-2xs font-semibold text-red-700">
                            stock-out
                          </span>
                        )}
                        {(analysis.expiryExposureUnits ?? 0) > 0 && (
                          <span
                            className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-2xs font-semibold text-amber-800"
                            title={`${formatNumber(analysis.expiryExposureUnits ?? 0)} units ≈ ${formatMoney(analysis.expiryExposureValue ?? 0, currency)} at risk`}
                          >
                            expiry {formatMoney(analysis.expiryExposureValue ?? 0, currency)}
                          </span>
                        )}
                        {!analysis.stockoutRisk && (analysis.expiryExposureUnits ?? 0) === 0 && (
                          <span className="text-2xs text-ink-500">healthy</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PanelCard>
    </div>
  );
}
