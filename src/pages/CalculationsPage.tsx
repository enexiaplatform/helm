/**
 * The Calculation Explorer — an engineering instrument, not a management surface.
 *
 * Its only job is to let a reviewer confirm the Phase 3 kernel is real:
 *
 *   * that calculations are GOVERNED — owned, justified, versioned, and honest
 *     about how crude the model is;
 *   * that a change PROPAGATES through declared dependencies and nowhere else;
 *   * that every derived number EXPLAINS itself down to stated facts.
 *
 * Deliberately plain, deliberately without a chart, and deliberately capable of
 * writing: running the model is the only way to demonstrate that it runs. In
 * demo mode nothing leaves the browser. In cloud mode a run writes DERIVED
 * observations and a trace, which is exactly what the phase is for.
 *
 * Management surfaces begin at Phase 14, after Phase 6's authority rules exist.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Calculator, CircleAlert, GitBranch, Info, Play } from 'lucide-react';
import type { GraphStore } from '@helm/graph-store';
import type { ValueGraph, ValueNode, ValueObservation } from '@helm/value-graph';
import type {
  CalculationDefinition,
  CalculationStep,
  Explanation,
  PropagationEngine,
  PropagationResult,
  StepStatus,
} from '@helm/propagation-engine';
import { buildDependencyGraph } from '@helm/propagation-engine';
import type { Scope } from '@helm/shared';
import { useHelmStore } from '../services/helmStore.ts';
import { calculations, cloudScope, demoScope, resolveGraphs } from '../services/ontologyGraph.ts';
import { PanelCard } from '../components/ui.tsx';

type Loaded = {
  engine: PropagationEngine;
  valueGraph: ValueGraph;
  graphStore: GraphStore;
  scope: Scope;
};

/** The source facts the canonical model starts from. */
const ROOT_METRICS = [
  'OpportunityValue',
  'OpportunityProbability',
  'UnitCost',
  'AverageSellingPrice',
];

const statusTone: Record<StepStatus, string> = {
  CALCULATED: 'bg-emerald-100 text-emerald-900',
  UNCHANGED: 'bg-ink-100 text-ink-600',
  BLOCKED: 'bg-amber-100 text-amber-900',
  FAILED: 'bg-red-100 text-red-700',
  SKIPPED: 'bg-ink-100 text-ink-500',
};

/**
 * Exact decimal strings, shortened for reading but never rounded silently:
 * the full value is always in the title attribute, because the residue of a
 * recurring division is a real part of the number and hiding it is a lie.
 */
function shorten(value: string | null): string {
  if (!value) return '—';
  if (value.length <= 16) return value;
  const [whole, fraction] = value.split('.');
  if (!fraction) return value;
  return `${whole}.${fraction.slice(0, 4)}…`;
}

function confidenceLabel(c: number | null): string {
  if (c === null) return '—';
  return c.toFixed(2);
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="w-40 shrink-0 text-2xs uppercase tracking-wide text-ink-400">{label}</span>
      <span className={`text-xs text-ink-800 ${mono ? 'font-mono break-all' : ''}`}>{value}</span>
    </div>
  );
}

/** One node of an explanation tree, rendered as an indented derivation. */
function ExplanationNode({ node, depth = 0 }: { node: Explanation; depth?: number }) {
  return (
    <div className={depth === 0 ? '' : 'border-l border-ink-200 pl-3'}>
      <div className="py-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-xs font-medium text-ink-900">{node.metricKey}</span>
          <span className="font-mono text-xs text-ink-700" title={node.value ?? undefined}>
            {shorten(node.value)}
            {node.currency ? ` ${node.currency}` : ''}
          </span>
          <span
            className={`rounded px-1.5 py-0.5 text-2xs font-medium ${
              node.derivation ? 'bg-violet-100 text-violet-900' : 'bg-emerald-100 text-emerald-900'
            }`}
          >
            {node.observationType}
          </span>
          {node.confidence !== null && (
            <span className="text-2xs text-ink-400">conf {confidenceLabel(node.confidence)}</span>
          )}
        </div>
        {node.derivation ? (
          <p className="mt-0.5 font-mono text-2xs text-ink-500">
            {node.derivation.calculationKey}@{node.derivation.calculationVersion} ·{' '}
            {node.derivation.renderedExpression}
          </p>
        ) : (
          <p className="mt-0.5 text-2xs text-ink-500">
            stated by {node.source?.system ?? 'an unknown source'}
            {node.source?.method ? ` · ${node.source.method}` : ''}
          </p>
        )}
      </div>
      {node.inputs.map((input) => (
        <ExplanationNode key={`${input.observationId}-${input.metricKey}`} node={input} depth={depth + 1} />
      ))}
    </div>
  );
}

export function CalculationsPage() {
  const mode = useHelmStore((s) => s.mode);
  const activeOrgId = useHelmStore((s) => s.activeOrgId);
  const userId = useHelmStore((s) => s.userId);
  const myRole = useHelmStore((s) => s.myRole);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PropagationResult | null>(null);
  const [selectedCalc, setSelectedCalc] = useState<string>(calculations.active()[0]?.key ?? '');
  const [explaining, setExplaining] = useState<Explanation | null>(null);
  const [nodeLabels, setNodeLabels] = useState<Map<string, ValueNode>>(new Map());

  // --- open the right stack for the current mode ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const graphs = await resolveGraphs(mode === 'demo' ? 'demo' : 'cloud');
        if (cancelled) return;
        if (!graphs) {
          setError('No graphs available. Check the Supabase configuration.');
          return;
        }
        const scope =
          mode === 'demo' ? demoScope() : cloudScope(activeOrgId ?? '', userId ?? '', myRole());
        setLoaded({ ...graphs, scope });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, activeOrgId, userId, myRole]);

  // --- value node labels, so a trace reads as positions rather than uuids ---
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    (async () => {
      const r = await loaded.valueGraph.findValueNodes(loaded.scope, { limit: 500 });
      if (cancelled || !r.ok) return;
      setNodeLabels(new Map(r.value.map((n) => [n.id, n])));
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded, result]);

  const dependencyOrder = useMemo(() => {
    const graph = buildDependencyGraph(calculations);
    return graph.ok ? graph.value : null;
  }, []);

  const run = useCallback(
    async (fromMetricKeys: readonly string[], label: string) => {
      if (!loaded) return;
      setBusy(true);
      setError(null);
      setExplaining(null);
      const r = await loaded.engine.execute(loaded.scope, {
        fromMetricKeys: [...fromMetricKeys],
        horizon: 'quarter',
        triggerType: 'MANUAL',
        notes: label,
      });
      setBusy(false);
      if (!r.ok) {
        setError(`${r.error.code}: ${r.error.message}`);
        return;
      }
      setResult(r.value);
    },
    [loaded],
  );

  const explain = useCallback(
    async (step: CalculationStep) => {
      if (!loaded || !step.outputObservationId) return;
      const r = await loaded.engine.explain(loaded.scope, step.outputObservationId);
      if (!r.ok) {
        setError(`${r.error.code}: ${r.error.message}`);
        return;
      }
      setExplaining(r.value);
    },
    [loaded],
  );

  const selected: CalculationDefinition | null =
    calculations.active().find((c) => c.key === selectedCalc) ?? null;

  const steps = result?.steps ?? [];
  const summary = result?.summary;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink-900">Calculation Explorer</h1>
          <p className="text-xs text-ink-500">
            Read-only kernel instrument, except for running the model.{' '}
            {calculations.active().length} active calculations,{' '}
            {dependencyOrder?.roots.length ?? 0} source facts.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy || !loaded}
            onClick={() => run(ROOT_METRICS, 'Full model run from source facts')}
            className="inline-flex items-center gap-1.5 rounded border border-ink-300 bg-white px-2.5 py-1 text-xs font-medium text-ink-800 hover:bg-ink-50 disabled:opacity-40"
          >
            <Play className="h-3.5 w-3.5" /> Run the whole model
          </button>
          <button
            type="button"
            disabled={busy || !loaded}
            onClick={() => run(['UnitCost'], 'Propagate a unit cost change')}
            className="inline-flex items-center gap-1.5 rounded border border-ink-300 bg-white px-2.5 py-1 text-xs font-medium text-ink-800 hover:bg-ink-50 disabled:opacity-40"
          >
            <ArrowRight className="h-3.5 w-3.5" /> Propagate from Unit Cost
          </button>
        </div>
      </header>

      {error && (
        <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        {/* ------------------------------------------------ the model itself */}
        <div className="space-y-4">
          <PanelCard title={<span className="flex items-center gap-1.5"><Calculator className="h-4 w-4" /> Calculations</span>}>
            <ul className="space-y-1">
              {calculations.active().map((calc) => (
                <li key={calc.key}>
                  <button
                    type="button"
                    onClick={() => setSelectedCalc(calc.key)}
                    className={`w-full rounded px-2 py-1.5 text-left text-xs ${
                      selectedCalc === calc.key ? 'bg-accent-50 text-accent-900' : 'hover:bg-ink-50'
                    }`}
                  >
                    <span className="font-medium">{calc.name}</span>
                    <span className="ml-1.5 font-mono text-2xs text-ink-400">
                      @{calc.version}
                    </span>
                    <span className="block font-mono text-2xs text-ink-500">{calc.expression}</span>
                  </button>
                </li>
              ))}
            </ul>
          </PanelCard>

          {dependencyOrder && (
            <PanelCard title={<span className="flex items-center gap-1.5"><GitBranch className="h-4 w-4" /> Execution order</span>}>
              <p className="mb-2 text-2xs text-ink-500">
                Topological. A step never runs before something it depends on.
              </p>
              <p className="text-2xs uppercase tracking-wide text-ink-400">
                Source facts — nothing computes these
              </p>
              <ul className="mb-3 mt-1 space-y-0.5">
                {dependencyOrder.roots.map((metric) => (
                  <li key={metric} className="flex items-baseline gap-2 text-xs text-ink-500">
                    <span className="w-5 shrink-0 text-right font-mono text-2xs text-ink-300">·</span>
                    <span>{metric}</span>
                  </li>
                ))}
              </ul>
              <p className="text-2xs uppercase tracking-wide text-ink-400">Then, in order</p>
              <ol className="mt-1 space-y-0.5">
                {dependencyOrder.order.map((metric, i) => (
                  <li key={metric} className="flex items-baseline gap-2 text-xs">
                    <span className="w-5 shrink-0 text-right font-mono text-2xs text-ink-400">
                      {i + 1}
                    </span>
                    <span className="text-ink-900">{metric}</span>
                  </li>
                ))}
              </ol>
            </PanelCard>
          )}
        </div>

        {/* --------------------------------------------- governance and trace */}
        <div className="space-y-4">
          {selected && (
            <PanelCard
              title={
                <span>
                  {selected.name}{' '}
                  <span className="font-mono text-2xs font-normal text-ink-400">
                    {selected.key}@{selected.version}
                  </span>
                </span>
              }
            >
              <Row label="Formula" value={selected.expression} mono />
              <Row label="Produces" value={`${selected.outputMetricKey} (${selected.outputUnit})`} />
              <Row label="Owner" value={selected.owner} />
              <Row label="Status" value={`${selected.status} from ${selected.effectiveFrom}`} />
              <Row
                label="Applies to"
                value={selected.scopeCompatibility?.join(', ') ?? 'any subject'}
              />
              <Row
                label="Model confidence"
                value={`${selected.definitionConfidence} — how well the MODEL represents reality, independent of input quality`}
              />
              <div className="mt-3 rounded border border-ink-100 bg-ink-50 px-3 py-2">
                <p className="text-2xs uppercase tracking-wide text-ink-400">Why it exists</p>
                <p className="mt-1 text-xs leading-relaxed text-ink-700">{selected.rationale}</p>
              </div>
              <div className="mt-3">
                <p className="text-2xs uppercase tracking-wide text-ink-400">Declared inputs</p>
                <ul className="mt-1 space-y-1.5">
                  {selected.inputs.map((input) => (
                    <li key={input.name} className="text-xs text-ink-700">
                      <span className="font-mono text-ink-900">{input.name}</span>
                      <span className="text-ink-400"> = </span>
                      <span>{input.metricKey}</span>
                      <span className="ml-1.5 text-2xs text-ink-400">
                        {input.binding.kind === 'RELATED_ENTITY'
                          ? `via ${input.binding.relationshipTypeKey} (${input.binding.direction})`
                          : input.binding.kind === 'SCOPED'
                            ? `scoped to ${input.binding.scopeKind}`
                            : 'same subject'}
                        {input.horizon ? ` · ${input.horizon}` : ''}
                        {input.preference ? ` · ${input.preference}` : ''}
                        {input.required ? '' : ' · optional'}
                      </span>
                      <span className="block text-2xs text-ink-500">{input.description}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </PanelCard>
          )}

          <PanelCard
            title="Last run"
            action={
              summary && (
                <span className="flex flex-wrap gap-1.5">
                  {(Object.keys(summary) as StepStatus[])
                    .filter((k) => summary[k] > 0)
                    .map((k) => (
                      <span key={k} className={`rounded px-1.5 py-0.5 text-2xs font-medium ${statusTone[k]}`}>
                        {summary[k]} {k.toLowerCase()}
                      </span>
                    ))}
                </span>
              )
            }
          >
            {!result ? (
              <p className="text-xs text-ink-500">
                Nothing has been run yet. Running the model writes DERIVED observations and an
                append-only trace; it never overwrites a stated fact.
              </p>
            ) : (
              <>
                <p className="mb-3 text-2xs text-ink-500">
                  Run {result.run.id} · as of {result.run.context.asOf} ·{' '}
                  {result.run.context.preference} · {result.run.status}
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-ink-100 text-2xs uppercase tracking-wide text-ink-400">
                        <th className="py-1.5 pr-2 font-medium">#</th>
                        <th className="py-1.5 pr-2 font-medium">Calculation</th>
                        <th className="py-1.5 pr-2 font-medium">Value position</th>
                        <th className="py-1.5 pr-2 font-medium">Result</th>
                        <th className="py-1.5 pr-2 font-medium">Conf</th>
                        <th className="py-1.5 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {steps.map((step) => (
                        <tr key={step.id} className="border-b border-ink-50 align-top">
                          <td className="py-1.5 pr-2 font-mono text-2xs text-ink-400">
                            {step.sequence}
                          </td>
                          <td className="py-1.5 pr-2">
                            <span className="text-ink-900">{step.calculationKey}</span>
                            <span className="block font-mono text-2xs text-ink-400">
                              @{step.calculationVersion}
                            </span>
                          </td>
                          <td className="py-1.5 pr-2 text-ink-700">
                            {nodeLabels.get(step.outputNodeId)?.label ?? step.outputMetricKey}
                          </td>
                          <td className="py-1.5 pr-2 font-mono text-ink-900" title={step.outputValue ?? undefined}>
                            {shorten(step.outputValue)}
                            {step.outputCurrency ? ` ${step.outputCurrency}` : ''}
                            {step.renderedExpression && (
                              <span className="block font-mono text-2xs text-ink-400">
                                {step.renderedExpression}
                              </span>
                            )}
                            {step.errorMessage && (
                              <span className="block text-2xs text-amber-800">
                                {step.errorMessage}
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 pr-2 font-mono text-2xs text-ink-500">
                            {confidenceLabel(step.confidence)}
                          </td>
                          <td className="py-1.5">
                            <span className={`rounded px-1.5 py-0.5 text-2xs font-medium ${statusTone[step.status]}`}>
                              {step.status}
                            </span>
                            {step.outputObservationId && (
                              <button
                                type="button"
                                onClick={() => explain(step)}
                                className="ml-1.5 text-2xs text-accent-700 underline hover:text-accent-900"
                              >
                                why?
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {result.uncomputable.length > 0 && (
                  <div className="mt-3 rounded border border-ink-100 bg-ink-50 px-3 py-2">
                    <p className="flex items-center gap-1.5 text-2xs uppercase tracking-wide text-ink-400">
                      <Info className="h-3 w-3" /> Declared uncomputable
                    </p>
                    <p className="mt-1 text-2xs text-ink-500">
                      Value positions the model does not claim to produce. Saying so is the
                      difference between &ldquo;not applicable&rdquo; and &ldquo;forgotten&rdquo;.
                    </p>
                    <ul className="mt-1.5 space-y-0.5">
                      {result.uncomputable.map((u: { nodeId: string; metricKey: string; reason: string }) => (
                        <li key={`${u.nodeId}-${u.metricKey}`} className="text-xs text-ink-700">
                          <span className="font-medium">{u.metricKey}</span>
                          <span className="text-ink-400"> — {u.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </PanelCard>

          {explaining && (
            <PanelCard
              title="Why is this number what it is?"
              action={
                <button
                  type="button"
                  onClick={() => setExplaining(null)}
                  className="text-2xs text-ink-500 underline hover:text-ink-800"
                >
                  close
                </button>
              }
            >
              <p className="mb-2 text-2xs text-ink-500">
                Every branch ends in a fact a source system asserted or a person assumed. Nothing
                below is HELM&rsquo;s opinion.
              </p>
              <ExplanationNode node={explaining} />
            </PanelCard>
          )}
        </div>
      </div>
    </div>
  );
}

/** Kept for the type import above; the page renders observations only via explain(). */
export type { ValueObservation };
