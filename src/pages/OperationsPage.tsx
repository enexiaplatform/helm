import { useMemo } from 'react';
import { useHelmStore } from '../services/helmStore.ts';
import { PageHeader } from '../components/ui/PageHeader.tsx';
import { SectionHead } from '../components/ui/SectionHead.tsx';
import { MetricList, type Metric } from '../components/ui/MetricList.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { Pill } from '../components/ui/Pill.tsx';
import { analyzeProcess } from '../domain/engines/capacity.ts';
import { analyzeInventoryItem, analyzeWorkingCapital } from '../domain/engines/inventory.ts';
import { demoWorkingCapital } from '../data/demoOrg.ts';
import { formatMoney, formatNumber, formatPercent } from '../domain/format.ts';
import { cn } from '../lib/cn.ts';

/**
 * Operations: managerial diagnosis of processes (capacity, bottleneck, flow)
 * and inventory viewed as capital, risk, and service level. Not a BPM, not a
 * WMS — the outputs lead into decisions.
 */

const NUM = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const word = (n: number) => NUM[n] ?? String(n);
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

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
  const days = (n: number | null) => (n !== null ? formatNumber(n) : '—');
  const wcMetrics: Metric[] | null = wc && [
    { label: 'Days of inventory', sub: 'DOI', value: days(wc.doi), unit: 'd' },
    { label: 'Days sales outstanding', sub: 'DSO', value: days(wc.dso), unit: 'd' },
    { label: 'Days payables outstanding', sub: 'DPO', value: days(wc.dpo), unit: 'd' },
    {
      label: 'Cash conversion',
      sub: 'DOI + DSO − DPO',
      value: days(wc.cashConversionCycleDays),
      unit: 'd',
      tone: (wc.cashConversionCycleDays ?? 0) > 60 ? 'warn' : 'neutral',
    },
    (() => {
      const text = formatMoney(wc.workingCapital, currency);
      const i = text.lastIndexOf(' ');
      return { label: 'Working capital', value: text.slice(0, i), unit: text.slice(i + 1) };
    })(),
  ];

  const over = processAnalyses.filter(({ analysis }) => analysis.utilization !== null && analysis.utilization >= 1).length;
  const stockouts = inventoryAnalyses.filter(({ analysis }) => analysis.stockoutRisk).length;
  const expiring = inventoryAnalyses.filter(({ analysis }) => (analysis.expiryExposureUnits ?? 0) > 0).length;
  const sentences = [
    over > 0 && `${word(over)} ${plural(over, 'process runs', 'processes run')} past ${plural(over, 'its', 'their')} capacity.`,
    stockouts > 0 && `${word(stockouts)} ${plural(stockouts, 'item risks', 'items risk')} a stock-out.`,
    expiring > 0 && `${word(expiring)} ${plural(expiring, 'item carries', 'items carry')} expiry risk.`,
  ].filter(Boolean);
  const headline =
    processAnalyses.length === 0 && inventoryAnalyses.length === 0
      ? 'Nothing operational is mapped yet.'
      : sentences.join(' ') || 'Every process has headroom and no item is at risk.';

  return (
    <>
      <PageHeader
        kicker="Management · Operations"
        title={headline}
        lede="Capacity, bottlenecks, and inventory as capital — diagnosis, not execution."
      />
      <div className="mt-9 flex flex-wrap items-start gap-10">
        <div className="grid min-w-0 flex-[1_1_560px] gap-10">
          <section>
            <SectionHead title="Processes and capacity" meta={`${processAnalyses.length} mapped`} />
            {processAnalyses.length === 0 ? (
              <EmptyState className="mt-4" title="No processes mapped" detail="Map a process's activities to see capacity, utilization, and the bottleneck." />
            ) : (
              processAnalyses.map(({ process, analysis }) => {
                const u = analysis.utilization;
                return (
                  <article key={process.id} className="border-b border-ink-200 py-5">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <h3 className="text-section-sm">{process.name}</h3>
                      <span className={cn('font-mono text-dense font-medium', u !== null && u >= 1 ? 'text-red-700' : u !== null && u >= 0.85 ? 'text-amber-700' : 'text-emerald-700')}>
                        {u !== null ? formatPercent(u, 0) : '—'} utilization
                      </span>
                    </div>
                    <p className="mt-1 max-w-reading text-base text-ink-700">{process.description}</p>
                    <p className="helm-meta mt-1">
                      demand {formatNumber(process.demandPerWeek)}/wk · capacity{' '}
                      {analysis.processCapacityPerWeek !== null ? formatNumber(analysis.processCapacityPerWeek) : '—'}/wk
                    </p>
                    <div className="mt-3 grid gap-[6px]">
                      {analysis.activities.map((a) => {
                        const au = a.utilization ?? 0;
                        return (
                          <div key={a.activityId} className="grid grid-cols-[200px_minmax(0,1fr)_56px_110px] items-center gap-3 max-sm:grid-cols-[1fr_56px]">
                            <span className="truncate text-dense">
                              {a.name}
                              {a.isBottleneck && <Pill tone="blocked" className="ml-2">bottleneck</Pill>}
                            </span>
                            <div className="relative h-[6px] overflow-hidden rounded-full bg-ink-100 max-sm:hidden">
                              <div
                                className={cn('absolute inset-y-0 left-0 rounded-full', au >= 1 ? 'bg-red-500' : au >= 0.85 ? 'bg-amber-500' : 'bg-accent-500')}
                                style={{ width: `${Math.min(100, au * 100)}%` }}
                              />
                            </div>
                            <span className="text-right font-mono text-meta">{formatPercent(au, 0)}</span>
                            <span className="text-right font-mono text-meta text-ink-500 max-sm:hidden">
                              {Number.isFinite(a.weeklyCapacity) ? `${formatNumber(a.weeklyCapacity)}/wk cap` : '—'}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </article>
                );
              })
            )}
          </section>

          <section>
            <SectionHead title="Inventory as capital" meta={`${inventoryAnalyses.length} items`} />
            {inventoryAnalyses.length === 0 ? (
              <EmptyState className="mt-4" title="No inventory items" detail="Track items with demand, lead time, and stock to see reorder points, stock-out and expiry risk." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] border-collapse">
                  <thead>
                    <tr>
                      {['Item', 'On hand + inbound', 'Reorder point', 'Safety stock', 'Days of cover', 'Capital tied up', 'Risk'].map((h, i) => (
                        <th key={h} className={cn('helm-label pb-2 pt-[14px]', i === 0 || i === 6 ? 'text-left' : 'pl-3 text-right', i === 6 && 'pl-3')}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {inventoryAnalyses.map(({ item, analysis }) => (
                      <tr key={item.id} className="border-t border-ink-200 align-top">
                        <td className="py-3">
                          <span className="block text-ui font-semibold">{item.name}</span>
                          <span className="helm-meta">
                            {item.sku} · demand {formatNumber(item.avgDailyDemand, 1)}/day · lead {formatNumber(item.leadTimeDays)}d
                          </span>
                        </td>
                        <td className="py-3 pl-3 text-right font-mono text-dense">
                          {formatNumber(item.stockOnHand)}
                          {item.stockInbound > 0 && <span className="text-ink-500"> +{formatNumber(item.stockInbound)}</span>}
                        </td>
                        <td className="py-3 pl-3 text-right font-mono text-dense">{formatNumber(analysis.reorderPoint)}</td>
                        <td className="py-3 pl-3 text-right font-mono text-dense">{formatNumber(analysis.safetyStock)}</td>
                        <td className="py-3 pl-3 text-right font-mono text-dense">
                          {analysis.daysUntilStockout !== null ? `${formatNumber(analysis.daysUntilStockout)} d` : '—'}
                        </td>
                        <td className="py-3 pl-3 text-right font-mono text-dense font-medium">{formatMoney(analysis.capitalTiedUp, currency)}</td>
                        <td className="py-3 pl-3">
                          <span className="flex flex-wrap gap-1">
                            {analysis.stockoutRisk && <Pill tone="blocked">stock-out</Pill>}
                            {(analysis.expiryExposureUnits ?? 0) > 0 && (
                              <span title={`${formatNumber(analysis.expiryExposureUnits ?? 0)} units ≈ ${formatMoney(analysis.expiryExposureValue ?? 0, currency)} at risk`}>
                                <Pill tone="accepted">expiry {formatMoney(analysis.expiryExposureValue ?? 0, currency)}</Pill>
                              </span>
                            )}
                            {!analysis.stockoutRisk && (analysis.expiryExposureUnits ?? 0) === 0 && (
                              <span className="text-meta text-ink-500">healthy</span>
                            )}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
        <aside className="grid max-w-[360px] flex-[1_1_280px] gap-7">
          {wcMetrics ? (
            <MetricList title="Working capital" kind={{ label: 'Actual', tone: 'actual' }} metrics={wcMetrics} />
          ) : (
            <p className="text-dense text-ink-500">
              Working capital needs real balances; they arrive with the finance connector rather than being estimated here.
            </p>
          )}
        </aside>
      </div>
    </>
  );
}
