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

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type { GraphStore } from '@helm/graph-store';
import type { ValueGraph, ValueNode } from '@helm/value-graph';
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
import { PageHeader } from '../components/ui/PageHeader.tsx';
import { SectionHead } from '../components/ui/SectionHead.tsx';
import { Button } from '../components/ui/Button.tsx';
import { Pill, type PillTone } from '../components/ui/Pill.tsx';
import { Notice } from '../components/ui/Notice.tsx';
import { LineageTree, type LineageNode } from '../components/scenario/LineageTree.tsx';
import { cn } from '../lib/cn.ts';

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

const STATUS_TONE: Record<StepStatus, PillTone> = {
  CALCULATED: 'computed',
  UNCHANGED: 'neutral',
  BLOCKED: 'accepted',
  FAILED: 'blocked',
  SKIPPED: 'neutral',
};

/**
 * Shortens a long decimal string for reading. Never used to round a business
 * value — that is the precision policy's job, done once at storage. The full
 * stored value and the raw computation are both in the title attribute.
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

/** An explanation, as the lineage rows read it: every branch ends in a stated fact. */
function toLineage(node: Explanation): LineageNode {
  const conf = node.confidence !== null ? ` · conf ${confidenceLabel(node.confidence)}` : '';
  return {
    metricKey: node.metricKey,
    value: `${shorten(node.value)}${node.currency ? ` ${node.currency}` : ''}`,
    kind: node.derivation ? 'COMPUTED' : node.observationType,
    foot: node.derivation
      ? `${node.derivation.calculationKey}@${node.derivation.calculationVersion} · ${node.derivation.renderedExpression}${conf}`
      : `stated by ${node.source?.system ?? 'an unknown source'}${node.source?.method ? ` · ${node.source.method}` : ''}${conf}`,
    inputs: node.inputs.map(toLineage),
  };
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

  // --- the last baseline run on record, so a reload does not claim nothing has ever run ---
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    (async () => {
      const runs = await loaded.engine.listRuns(loaded.scope, 20);
      if (cancelled || !runs.ok) return;
      const last = runs.value.find((r) => r.context.scenarioEntityId === null && r.context.scenarioRevisionId === null);
      if (!last) return;
      const trace = await loaded.engine.getTrace(loaded.scope, last.id);
      if (cancelled || !trace.ok) return;
      const summary = { CALCULATED: 0, UNCHANGED: 0, BLOCKED: 0, FAILED: 0, SKIPPED: 0 } as Record<StepStatus, number>;
      for (const st of trace.value) summary[st.status] += 1;
      setResult((current) => current ?? { run: last, steps: trace.value, written: [], summary, uncomputable: [] });
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded]);

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
      requestAnimationFrame(() => document.getElementById('why')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    },
    [loaded],
  );

  const selected: CalculationDefinition | null =
    calculations.active().find((c) => c.key === selectedCalc) ?? null;

  const steps = result?.steps ?? [];
  const summary = result?.summary;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <PageHeader
          kicker="Kernel instrument · Calculations"
          title={`${calculations.active().length} governed calculations over ${dependencyOrder?.roots.length ?? 0} source facts`}
          size="instrument"
        />
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || !loaded} onClick={() => run(['UnitCost'], 'Propagate a unit cost change')}>
            Propagate from Unit Cost
          </Button>
          <Button variant="primary" disabled={busy || !loaded} onClick={() => run(ROOT_METRICS, 'Full model run from source facts')}>
            Run the whole model
          </Button>
        </div>
      </div>
      <p className="mt-2 max-w-[760px] text-read text-ink-600">
        Read-only, except for running the model. A run writes DERIVED observations and an append-only trace; it never
        overwrites a stated fact.
      </p>

      {error && (
        <Notice tone="error" className="mt-5" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}

      <div className="mt-7 flex flex-wrap items-start gap-10">
        {/* ------------------------------------------------ the model itself */}
        <nav className="grid min-w-[240px] flex-[0_1_320px] gap-7">
          <div>
            <p className="helm-label mb-[6px]">Calculations</p>
            {calculations.active().map((calc) => (
              <button
                key={calc.key}
                type="button"
                onClick={() => setSelectedCalc(calc.key)}
                className={cn('grid w-full rounded-lg px-[10px] py-[7px] text-left hover:bg-ink-100', selectedCalc === calc.key && 'bg-accent-50')}
              >
                <span className={cn('text-dense leading-[19px]', selectedCalc === calc.key ? 'font-semibold text-accent-800' : 'text-ink-800')}>
                  {calc.name} <span className="font-mono text-meta font-normal text-ink-500">@{calc.version}</span>
                </span>
                <span className="break-words font-mono text-meta text-ink-500">{calc.expression}</span>
              </button>
            ))}
          </div>

          {dependencyOrder && (
            <div>
              <p className="helm-label mb-1">Execution order</p>
              <p className="helm-caveat mb-2">topological — a step never runs before what it depends on</p>
              <p className="text-meta text-ink-500">Source facts — nothing computes these</p>
              {dependencyOrder.roots.map((metric) => (
                <p key={metric} className="grid grid-cols-[24px_1fr] border-b border-ink-100 py-[5px] font-mono text-meta text-ink-600">
                  <span className="text-ink-400">·</span>
                  {metric}
                </p>
              ))}
              <p className="mt-3 text-meta text-ink-500">Then, in order</p>
              {dependencyOrder.order.map((metric, i) => (
                <p key={metric} className="grid grid-cols-[24px_1fr] border-b border-ink-100 py-[5px] font-mono text-meta">
                  <span className="text-ink-500">{i + 1}</span>
                  {metric}
                </p>
              ))}
            </div>
          )}
        </nav>

        {/* --------------------------------------------- governance and trace */}
        <div className="min-w-0 flex-[1_1_560px]">
          {selected && (
            <section>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Pill tone="computed">{selected.status}</Pill>
                <span className="helm-meta font-medium">
                  {selected.key}@{selected.version}
                </span>
              </div>
              <h2 className="mt-2 text-[26px] leading-[33px] tracking-[-0.01em]">{selected.name}</h2>
              <p className="mt-2 font-mono text-read font-medium text-ink-800">{selected.expression}</p>
              <dl className="mt-4 grid grid-cols-[160px_minmax(0,1fr)] gap-x-4">
                {(
                  [
                    ['Produces', `${selected.outputMetricKey} (${selected.outputUnit})`, true],
                    ['Owner', selected.owner, false],
                    ['Status', `${selected.status} from ${selected.effectiveFrom}`, true],
                    ['Applies to', selected.scopeCompatibility?.join(', ') ?? 'any subject', false],
                    ['Model confidence', `${selected.definitionConfidence} — how well the model represents reality, independent of input quality`, false],
                  ] as const
                ).map(([label, value, mono]) => (
                  <Fragment key={label}>
                    <dt className="border-b border-ink-100 py-[7px] text-meta text-ink-500">{label}</dt>
                    <dd className={cn('border-b border-ink-100 py-[7px] text-dense', mono && 'font-mono')}>{value}</dd>
                  </Fragment>
                ))}
              </dl>
              <p className="helm-label mb-1 mt-5">Why it exists</p>
              <p className="max-w-reading font-serif text-read italic leading-[23px] text-ink-800">{selected.rationale}</p>
              <p className="helm-label mb-1 mt-5">Declared inputs</p>
              {selected.inputs.map((input) => (
                <div key={input.name} className="border-b border-ink-200 py-2">
                  <p className="text-dense">
                    <span className="font-mono font-semibold">{input.name}</span>
                    <span className="text-ink-500"> = </span>
                    <span className="font-mono">{input.metricKey}</span>
                  </p>
                  <p className="helm-meta">
                    {input.binding.kind === 'RELATED_ENTITY'
                      ? `via ${input.binding.relationshipTypeKey} (${input.binding.direction})`
                      : input.binding.kind === 'SCOPED'
                        ? `scoped to ${input.binding.scopeKind}`
                        : 'same subject'}
                    {input.horizon ? ` · ${input.horizon}` : ''}
                    {input.preference ? ` · ${input.preference}` : ''}
                    {input.required ? '' : ' · optional'}
                  </p>
                  <p className="text-meta text-ink-600">{input.description}</p>
                </div>
              ))}
            </section>
          )}

          <section className="mt-10">
            <SectionHead
              title="The last run"
              meta={
                summary &&
                (Object.keys(summary) as StepStatus[])
                  .filter((k) => summary[k] > 0)
                  .map((k) => `${summary[k]} ${k.toLowerCase()}`)
                  .join(' · ')
              }
            />
            {busy && <p className="mt-3 text-base text-ink-600">Running the model over every value position it can compute…</p>}
            {!result ? (
              !busy && (
                <p className="mt-3 text-base text-ink-600">
                  Nothing has been run yet. Running the model writes DERIVED observations and an append-only trace; it never
                  overwrites a stated fact.
                </p>
              )
            ) : (
              <>
                <p className="helm-meta mt-3">
                  run {result.run.id} · modelling {result.run.context.effectiveAsOf} · knowledge through{' '}
                  {result.run.context.recordedThrough} · {result.run.context.preference} · {result.run.status}
                </p>
                {steps.length === 0 && (
                  <p className="mt-3 max-w-reading text-base text-red-700">
                    This run computed nothing: no value position carries a result of these calculations. A model result needs
                    a position to live on — an expected revenue needs an opportunity that has both a value and a probability.
                    Check the inputs on the <a href="/value-graph" className="underline">value graph</a>.
                  </p>
                )}
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] border-collapse">
                    <thead>
                      <tr>
                        {['#', 'Calculation', 'Value position', 'Result', 'Conf.', 'Status'].map((h, i) => (
                          <th key={h} className={cn('helm-label pb-2 pt-[14px] text-left', i > 0 && 'pl-3', i === 4 && 'text-right')}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {steps.map((step) => (
                        <tr key={step.id} className="border-t border-ink-200 align-top">
                          <td className="py-3 font-mono text-meta text-ink-500">{step.sequence}</td>
                          <td className="py-3 pl-3">
                            <span className="block font-mono text-dense">{step.calculationKey}</span>
                            <span className="helm-meta">@{step.calculationVersion}</span>
                          </td>
                          <td className="py-3 pl-3 text-dense text-ink-700">
                            {nodeLabels.get(step.outputNodeId)?.label ?? step.outputMetricKey}
                          </td>
                          <td
                            className="py-3 pl-3"
                            title={
                              step.outputValueRaw
                                ? `stored ${step.outputValue} · computed ${step.outputValueRaw}`
                                : (step.outputValue ?? undefined)
                            }
                          >
                            <span className="block font-mono text-ui font-medium">
                              {shorten(step.outputValue)}
                              {step.outputCurrency ? ` ${step.outputCurrency}` : ''}
                            </span>
                            {step.outputValueRaw && <span className="helm-meta block">normalized from {shorten(step.outputValueRaw)}</span>}
                            {step.renderedExpression && <span className="helm-meta block break-words">{step.renderedExpression}</span>}
                            {step.errorMessage && <span className="block text-meta text-amber-800">{step.errorMessage}</span>}
                          </td>
                          <td className="py-3 pl-3 text-right font-mono text-dense">{confidenceLabel(step.confidence)}</td>
                          <td className="py-3 pl-3">
                            <Pill tone={STATUS_TONE[step.status]}>{step.status}</Pill>
                            {step.outputObservationId && (
                              <button
                                type="button"
                                onClick={() => explain(step)}
                                className="ml-2 text-meta font-medium text-accent-700 hover:underline"
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
                  <div className="mt-6">
                    <p className="helm-label mb-1">Declared uncomputable</p>
                    <p className="text-meta text-ink-500">
                      Value positions the model does not claim to produce. Saying so is the difference between
                      &ldquo;not applicable&rdquo; and &ldquo;forgotten&rdquo;.
                    </p>
                    {result.uncomputable.map((u: { nodeId: string; metricKey: string; reason: string }) => (
                      <p key={`${u.nodeId}-${u.metricKey}`} className="border-b border-ink-200 py-2 text-dense text-ink-700">
                        <span className="font-mono font-medium">{u.metricKey}</span>
                        <span className="text-ink-500"> — {u.reason}</span>
                      </p>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>

          {explaining && (
            <section id="why" className="mt-10 scroll-mt-6">
              <SectionHead
                title="Why is this number what it is?"
                caveat={
                  <button type="button" onClick={() => setExplaining(null)} className="hover:underline">
                    close
                  </button>
                }
              />
              <p className="mt-3 text-dense text-ink-600">
                Every branch ends in a fact a source system asserted or a person assumed. Nothing below is HELM&rsquo;s
                opinion.
              </p>
              <div className="mt-2">
                <LineageTree node={toLineage(explaining)} />
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
