import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useHelmStore } from '../services/helmStore.ts';
import { PanelCard, EmptyState, Field } from '../components/ui.tsx';
import { evaluateScenario, sensitivity } from '../domain/engines/scenario.ts';
import { formatDelta, formatMoney, formatNumber, formatPercent } from '../domain/format.ts';
import type { Scenario, ScenarioDeltas, ScenarioVariant } from '../domain/types.ts';

export function ScenarioDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const scenario = useHelmStore((s) => s.scenarios.find((sc) => sc.id === id));
  const decisions = useHelmStore((s) => s.decisions);
  const updateScenario = useHelmStore((s) => s.updateScenario);
  const removeScenario = useHelmStore((s) => s.removeScenario);

  if (!scenario) {
    return (
      <EmptyState
        title="Scenario not found"
        action={
          <Link to="/scenarios" className="btn-secondary">
            Back to scenarios
          </Link>
        }
      />
    );
  }

  const decision = decisions.find((d) => d.id === scenario.decisionId);
  const save = (fields: Parameters<typeof updateScenario>[1]) => void updateScenario(scenario.id, fields);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <input
            className="w-full bg-transparent text-xl font-semibold focus:outline-none"
            defaultValue={scenario.name}
            onBlur={(e) => e.target.value !== scenario.name && save({ name: e.target.value })}
          />
          <p className="text-sm text-ink-500">
            Per-period P&L model in {scenario.baseline.currency}
            {decision && (
              <>
                {' '}
                · attached to{' '}
                <Link className="text-accent-700 hover:underline" to={`/decisions/${decision.id}`}>
                  {decision.title}
                </Link>
              </>
            )}
          </p>
        </div>
        <button
          className="btn-danger shrink-0"
          onClick={() => {
            void removeScenario(scenario.id);
            navigate('/scenarios');
          }}
        >
          <Trash2 size={14} /> Delete
        </button>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <BaselinePanel scenario={scenario} onSave={save} />
        <div className="space-y-4 lg:col-span-2">
          <OutcomesPanel scenario={scenario} onSave={save} />
          <TornadoPanel scenario={scenario} />
        </div>
      </div>

      <p className="pb-2 text-2xs text-ink-400">
        <button className="hover:text-ink-700" onClick={() => navigate('/scenarios')}>
          <ArrowLeft size={11} className="mr-1 inline" />
          All scenarios
        </button>
      </p>
    </div>
  );
}

function BaselinePanel({
  scenario,
  onSave,
}: {
  scenario: Scenario;
  onSave: (fields: { baseline: Scenario['baseline'] }) => void;
}) {
  const b = scenario.baseline;
  const num = (key: keyof typeof b) => ({
    defaultValue: String(b[key] ?? 0),
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
      const v = Number(e.target.value);
      if (v !== b[key]) onSave({ baseline: { ...b, [key]: v } });
    },
  });

  return (
    <PanelCard title="Baseline (per period)">
      <div className="space-y-3">
        <Field label={`Selling price / unit (${b.currency})`}>
          <input className="field-input tabular-nums" type="number" {...num('unitPrice')} />
        </Field>
        <Field label="Units / period">
          <input className="field-input tabular-nums" type="number" {...num('unitsPerPeriod')} />
        </Field>
        <Field label={`Variable cost / unit (${b.currency})`}>
          <input className="field-input tabular-nums" type="number" {...num('variableCostPerUnit')} />
        </Field>
        <Field label={`Fixed costs / period (${b.currency})`}>
          <input className="field-input tabular-nums" type="number" {...num('fixedCostsPerPeriod')} />
        </Field>
        <p className="text-2xs text-ink-400">
          The engine derives contribution, break-even, and profit deterministically; variants perturb these four
          drivers.
        </p>
      </div>
    </PanelCard>
  );
}

const deltaFields: { key: keyof ScenarioDeltas; label: string; suffix: string }[] = [
  { key: 'unitPricePct', label: 'Price', suffix: '%' },
  { key: 'unitsPct', label: 'Volume', suffix: '%' },
  { key: 'variableCostPerUnitPct', label: 'Var. cost', suffix: '%' },
  { key: 'fixedCostsPct', label: 'Fixed', suffix: '%' },
];

function OutcomesPanel({
  scenario,
  onSave,
}: {
  scenario: Scenario;
  onSave: (fields: { variants: ScenarioVariant[] }) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const outcomes = useMemo(
    () => [evaluateScenario(scenario.baseline), ...scenario.variants.map((v) => evaluateScenario(scenario.baseline, v))],
    [scenario],
  );
  const cur = scenario.baseline.currency;

  const setVariant = (variantId: string, patch: Partial<ScenarioVariant>) => {
    onSave({ variants: scenario.variants.map((v) => (v.id === variantId ? { ...v, ...patch } : v)) });
  };

  return (
    <PanelCard
      title="Outcomes"
      action={
        <button
          className="btn-secondary px-2.5 py-1 text-xs"
          onClick={() =>
            onSave({
              variants: [
                ...scenario.variants,
                { id: crypto.randomUUID(), name: `Variant ${scenario.variants.length + 1}`, deltas: {} },
              ],
            })
          }
        >
          <Plus size={13} /> Add variant
        </button>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-ink-100">
              <th className="table-th">Scenario</th>
              <th className="table-th text-right">Revenue</th>
              <th className="table-th text-right">CM %</th>
              <th className="table-th text-right">Operating profit</th>
              <th className="table-th text-right">Δ vs baseline</th>
              <th className="table-th text-right">Break-even units</th>
              <th className="table-th" />
            </tr>
          </thead>
          <tbody>
            {outcomes.map((o, i) => {
              const variant = i === 0 ? null : scenario.variants[i - 1];
              return (
                <tr key={variant?.id ?? 'baseline'} className={`border-b border-ink-50 last:border-0 ${i === 0 ? 'bg-ink-50/60' : ''}`}>
                  <td className="table-td">
                    {variant ? (
                      <div>
                        <input
                          className="w-full bg-transparent font-medium focus:outline-none"
                          defaultValue={variant.name}
                          onBlur={(e) => e.target.value !== variant.name && setVariant(variant.id, { name: e.target.value })}
                        />
                        {editing === variant.id ? (
                          <div className="mt-1.5 flex flex-wrap gap-2">
                            {deltaFields.map((f) => (
                              <label key={f.key} className="flex items-center gap-1 text-2xs text-ink-500">
                                {f.label}
                                <input
                                  className="w-14 rounded border border-ink-200 px-1 py-0.5 text-right text-2xs tabular-nums"
                                  type="number"
                                  defaultValue={variant.deltas[f.key] ?? 0}
                                  onBlur={(e) =>
                                    setVariant(variant.id, {
                                      deltas: { ...variant.deltas, [f.key]: Number(e.target.value) || undefined },
                                    })
                                  }
                                />
                                {f.suffix}
                              </label>
                            ))}
                            <button className="text-2xs font-medium text-accent-700" onClick={() => setEditing(null)}>
                              done
                            </button>
                          </div>
                        ) : (
                          <button className="text-2xs text-ink-400 hover:text-accent-700" onClick={() => setEditing(variant.id)}>
                            {deltaSummary(variant.deltas) || 'set deltas…'}
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="font-medium text-ink-600">{scenario.baseline.label}</span>
                    )}
                  </td>
                  <td className="table-td text-right tabular-nums">{formatMoney(o.revenue, cur)}</td>
                  <td className="table-td text-right tabular-nums">{formatPercent(o.contributionMarginRatio)}</td>
                  <td className={`table-td text-right font-semibold tabular-nums ${o.operatingProfit >= 0 ? '' : 'text-red-700'}`}>
                    {formatMoney(o.operatingProfit, cur)}
                  </td>
                  <td className={`table-td text-right tabular-nums ${o.profitVsBaseline > 0 ? 'text-emerald-700' : o.profitVsBaseline < 0 ? 'text-red-700' : 'text-ink-400'}`}>
                    {i === 0 ? '—' : formatDelta(o.profitVsBaseline, cur)}
                  </td>
                  <td className="table-td text-right tabular-nums">{o.breakEvenUnits !== null ? formatNumber(o.breakEvenUnits) : '—'}</td>
                  <td className="table-td text-right">
                    {variant && (
                      <button
                        className="text-ink-300 hover:text-red-600"
                        onClick={() => onSave({ variants: scenario.variants.filter((v) => v.id !== variant.id) })}
                        aria-label={`Remove ${variant.name}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </PanelCard>
  );
}

function deltaSummary(d: ScenarioDeltas): string {
  const parts: string[] = [];
  const pct = (v: number | undefined, label: string) => {
    if (v) parts.push(`${label} ${v > 0 ? '+' : ''}${v}%`);
  };
  pct(d.unitPricePct, 'price');
  pct(d.unitsPct, 'volume');
  pct(d.variableCostPerUnitPct, 'var-cost');
  pct(d.fixedCostsPct, 'fixed');
  if (d.unitPriceAbs) parts.push(`price ${d.unitPriceAbs > 0 ? '+' : ''}${d.unitPriceAbs} abs`);
  if (d.variableCostPerUnitAbs) parts.push(`var-cost ${d.variableCostPerUnitAbs > 0 ? '+' : ''}${d.variableCostPerUnitAbs} abs`);
  if (d.fixedCostsAbs) parts.push(`fixed ${d.fixedCostsAbs > 0 ? '+' : ''}${d.fixedCostsAbs} abs`);
  if (d.unitsAbs) parts.push(`volume ${d.unitsAbs > 0 ? '+' : ''}${d.unitsAbs} abs`);
  return parts.join(' · ');
}

function TornadoPanel({ scenario }: { scenario: Scenario }) {
  const bars = useMemo(() => sensitivity(scenario.baseline, 10), [scenario.baseline]);
  const base = useMemo(() => evaluateScenario(scenario.baseline), [scenario.baseline]);
  const maxSwing = Math.max(...bars.map((b) => b.swing), 1);
  const cur = scenario.baseline.currency;

  if (scenario.baseline.unitPrice === 0 && scenario.baseline.unitsPerPeriod === 0) {
    return null;
  }

  return (
    <PanelCard title="Sensitivity (±10% one-way)" action={<span className="text-2xs text-ink-400">which assumption deserves the argument</span>}>
      <div className="space-y-2">
        {bars.map((b) => (
          <div key={b.variable} className="flex items-center gap-3 text-xs">
            <span className="w-32 shrink-0 text-ink-600">{b.label}</span>
            <div className="relative h-5 flex-1 rounded bg-ink-50">
              <div
                className="absolute inset-y-0 rounded bg-accent-300"
                style={{
                  left: `${((Math.min(b.profitLow, b.profitHigh) - base.operatingProfit + maxSwing) / (2 * maxSwing)) * 100}%`,
                  width: `${(b.swing / (2 * maxSwing)) * 100}%`,
                }}
                title={`${formatMoney(b.profitLow, cur)} … ${formatMoney(b.profitHigh, cur)}`}
              />
              <div className="absolute inset-y-0 left-1/2 w-px bg-ink-300" />
            </div>
            <span className="w-28 shrink-0 text-right tabular-nums text-ink-500">±{formatMoney(b.swing / 2, cur)}</span>
          </div>
        ))}
        <p className="text-2xs text-ink-400">
          Center line is baseline profit ({formatMoney(base.operatingProfit, cur)}). Longer bars mean the profit is
          more exposed to that driver.
        </p>
      </div>
    </PanelCard>
  );
}
