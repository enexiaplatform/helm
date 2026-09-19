/**
 * The Value Graph Explorer — an engineering instrument, not the GM Cockpit.
 *
 * Its job is to let a reviewer confirm the Phase 2 kernel is real: that value
 * nodes attach to ontology entities, that typed links connect them into chains,
 * that observations of different kinds coexist without collapsing, and that a
 * constrained resource shared by two value streams is visible.
 *
 * Deliberately plain. No charts, no scores, no recommendations.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Info, Layers } from 'lucide-react';
import type {
  ContentionPoint,
  ValueChain,
  ValueGraph,
  ValueMetricDefinition,
  ValueNeighbor,
  ValueNode,
  ValueObservation,
  ValueDimension,
} from '@helm/value-graph';
import { valueDimensions } from '@helm/value-graph';
import type { Entity } from '@helm/ontology';
import type { GraphStore } from '@helm/graph-store';
import type { Scope } from '@helm/shared';
import { useHelmStore } from '../services/helmStore.ts';
import { cloudScope, demoScope, resolveGraphs, valueMetrics } from '../services/ontologyGraph.ts';
import { PanelCard } from '../components/ui.tsx';

type Loaded = { valueGraph: ValueGraph; graphStore: GraphStore; scope: Scope };

const dimensionTone: Record<ValueDimension, string> = {
  FINANCIAL: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  COMMERCIAL: 'bg-accent-50 text-accent-800 border-accent-200',
  CUSTOMER: 'bg-violet-50 text-violet-800 border-violet-200',
  OPERATIONAL: 'bg-sky-50 text-sky-800 border-sky-200',
  CAPITAL: 'bg-amber-50 text-amber-800 border-amber-200',
  RISK: 'bg-red-50 text-red-700 border-red-200',
  STRATEGIC: 'bg-indigo-50 text-indigo-800 border-indigo-200',
  RESOURCE: 'bg-teal-50 text-teal-800 border-teal-200',
  RESILIENCE: 'bg-lime-50 text-lime-800 border-lime-200',
};

const obsTone: Record<string, string> = {
  ACTUAL: 'bg-emerald-100 text-emerald-900',
  FORECAST: 'bg-accent-100 text-accent-900',
  TARGET: 'bg-indigo-100 text-indigo-900',
  SCENARIO: 'bg-amber-100 text-amber-900',
  ESTIMATE: 'bg-ink-100 text-ink-700',
  DERIVED: 'bg-violet-100 text-violet-900',
  ASSUMPTION: 'bg-orange-100 text-orange-900',
};

/** Formats a value with its unit so a bare number never appears. */
function formatValue(o: ValueObservation): string {
  if (o.numericValue === null) return o.textValue ?? '—';
  const v = o.numericValue;
  switch (o.unitType) {
    case 'currency': {
      const abs = Math.abs(v);
      const compact =
        abs >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : abs >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v.toLocaleString();
      return `${compact} ${o.currency ?? ''}`.trim();
    }
    case 'percentage':
      return `${v}%`;
    case 'ratio':
      return v.toFixed(2);
    case 'days':
      return `${v} days`;
    case 'units':
    case 'count':
      return `${v} units`;
    case 'hours':
      return `${v} h`;
    case 'score':
    case 'index':
      return `${v}`;
    default:
      return `${v}`;
  }
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="w-36 shrink-0 text-2xs uppercase tracking-wide text-ink-400">{label}</span>
      <span className="text-xs text-ink-800">{value}</span>
    </div>
  );
}

export function ValueGraphPage() {
  const mode = useHelmStore((s) => s.mode);
  const activeOrgId = useHelmStore((s) => s.activeOrgId);
  const userId = useHelmStore((s) => s.userId);
  const myRole = useHelmStore((s) => s.myRole);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nodes, setNodes] = useState<ValueNode[]>([]);
  const [dimFilter, setDimFilter] = useState<ValueDimension | ''>('');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [depth, setDepth] = useState(3);
  const [scenarioId, setScenarioId] = useState<string>('');
  const [scenarios, setScenarios] = useState<Entity[]>([]);
  const [contention, setContention] = useState<ContentionPoint[]>([]);

  type Detail = {
    forId: string;
    atDepth: number;
    scenarioKey: string;
    node: ValueNode;
    metric: ValueMetricDefinition | null;
    subject: Entity | null;
    observations: ValueObservation[];
    upstream: ValueNeighbor[];
    downstream: ValueNeighbor[];
    chainUp: ValueChain | null;
    chainDown: ValueChain | null;
  };
  const [detail, setDetail] = useState<Detail | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const graphs = await resolveGraphs(mode === 'demo' ? 'demo' : 'cloud');
        if (cancelled) return;
        if (!graphs) {
          setError('No value graph available. Check the Supabase configuration.');
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

  // --- node list, scenarios, contention ---
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    (async () => {
      const [list, scen, cont] = await Promise.all([
        loaded.valueGraph.findValueNodes(loaded.scope, {
          dimensions: dimFilter ? [dimFilter] : undefined,
          search: search || undefined,
          limit: 300,
        }),
        loaded.graphStore.findEntities(loaded.scope, { entityTypeKeys: ['Scenario'], limit: 50 }),
        loaded.valueGraph.findContention(loaded.scope),
      ]);
      if (cancelled) return;
      if (!list.ok) {
        setError(`${list.error.code}: ${list.error.message}`);
        return;
      }
      setError(null);
      setNodes(list.value as ValueNode[]);
      setScenarios(scen.ok ? (scen.value as Entity[]) : []);
      setContention(cont.ok ? (cont.value as ContentionPoint[]) : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded, dimFilter, search]);

  // --- detail for the selected node ---
  useEffect(() => {
    if (!loaded || !selectedId) return;
    let cancelled = false;
    (async () => {
      const scenarioArg = scenarioId ? (scenarioId as Entity['id']) : null;
      const node = await loaded.valueGraph.getValueNode(loaded.scope, selectedId);
      if (!node.ok || !node.value) return;

      const [obs, up, down, chainUp, chainDown, metric] = await Promise.all([
        loaded.valueGraph.getObservations(loaded.scope, { nodeId: selectedId }),
        loaded.valueGraph.getValueNeighborhood(loaded.scope, selectedId, 'upstream'),
        loaded.valueGraph.getValueNeighborhood(loaded.scope, selectedId, 'downstream'),
        loaded.valueGraph.getValueChain(loaded.scope, {
          start: [selectedId],
          maxDepth: depth,
          direction: 'upstream',
          scenarioEntityId: scenarioArg,
        }),
        loaded.valueGraph.getValueChain(loaded.scope, {
          start: [selectedId],
          maxDepth: depth,
          direction: 'downstream',
          scenarioEntityId: scenarioArg,
        }),
        loaded.valueGraph.getMetricDefinition(loaded.scope, node.value.metricKey),
      ]);

      let subject: Entity | null = null;
      if (node.value.subjectEntityId) {
        const e = await loaded.graphStore.getEntity(loaded.scope, node.value.subjectEntityId);
        subject = e.ok ? (e.value as Entity | null) : null;
      }
      if (cancelled) return;

      setDetail({
        forId: selectedId,
        atDepth: depth,
        scenarioKey: scenarioId,
        node: node.value as ValueNode,
        metric: metric.ok ? (metric.value as ValueMetricDefinition | null) : null,
        subject,
        observations: obs.ok ? (obs.value as ValueObservation[]) : [],
        upstream: up.ok ? (up.value as ValueNeighbor[]) : [],
        downstream: down.ok ? (down.value as ValueNeighbor[]) : [],
        chainUp: chainUp.ok ? chainUp.value : null,
        chainDown: chainDown.ok ? chainDown.value : null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded, selectedId, depth, scenarioId]);

  const current =
    detail && detail.forId === selectedId && detail.atDepth === depth && detail.scenarioKey === scenarioId
      ? detail
      : null;

  const byDimension = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of nodes) {
      const m = valueMetrics.metric(n.metricKey);
      if (m) counts.set(m.dimension, (counts.get(m.dimension) ?? 0) + 1);
    }
    return counts;
  }, [nodes]);

  const scenarioName = (id: string | null) =>
    id ? (scenarios.find((s) => s.id === id)?.name ?? 'scenario') : null;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink-900">Value Graph Explorer</h1>
          <p className="text-xs text-ink-500">
            Read-only kernel instrument. {valueMetrics.allMetrics().length} metrics across{' '}
            {valueDimensions.length} value dimensions. Structure only — nothing here is calculated.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search value nodes…"
            className="w-52 rounded border border-ink-200 px-2 py-1 text-xs"
          />
          <select
            value={dimFilter}
            onChange={(e) => setDimFilter(e.target.value as ValueDimension | '')}
            className="rounded border border-ink-200 px-2 py-1 text-xs"
            aria-label="Filter by value dimension"
          >
            <option value="">All dimensions</option>
            {valueDimensions.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <select
            value={scenarioId}
            onChange={(e) => setScenarioId(e.target.value)}
            className="rounded border border-ink-200 px-2 py-1 text-xs"
            aria-label="Observation context"
          >
            <option value="">Reality (actual / forecast / target)</option>
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      <div className="flex flex-wrap gap-2 text-2xs">
        {valueDimensions
          .filter((d) => byDimension.has(d))
          .map((d) => (
            <span
              key={d}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${dimensionTone[d]}`}
            >
              <Layers className="h-3 w-3" /> {d}: {byDimension.get(d)}
            </span>
          ))}
      </div>

      {contention.length > 0 && (
        <PanelCard
          title={
            <span className="flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-600" /> Shared constrained resources (
              {contention.length})
            </span>
          }
        >
          <ul className="space-y-2">
            {contention.map((c) => (
              <li key={c.node.id} className="rounded border border-amber-200 bg-amber-50/40 p-2">
                <button
                  onClick={() => setSelectedId(c.node.id)}
                  className="text-xs font-medium text-accent-700 hover:underline"
                >
                  {c.node.label}
                </button>
                <p className="mt-1 text-2xs text-ink-600">
                  {c.claimants.length} value streams draw on this
                  {c.totalClaimedWeight !== null && <> · {c.totalClaimedWeight} units claimed</>}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {c.claimants.map((cl) => (
                    <li key={cl.via.id} className="text-2xs text-ink-600">
                      <span className="rounded bg-ink-100 px-1">{cl.via.linkType}</span>{' '}
                      <button
                        onClick={() => setSelectedId(cl.node.id)}
                        className="text-accent-700 hover:underline"
                      >
                        {cl.node.label}
                      </button>
                      {cl.via.weight !== null && <> · {cl.via.weight} units</>}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </PanelCard>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        <PanelCard title={`Value nodes (${nodes.length})`}>
          <ul className="max-h-[34rem] divide-y divide-ink-100 overflow-auto">
            {nodes.map((n) => {
              const m = valueMetrics.metric(n.metricKey);
              return (
                <li key={n.id}>
                  <button
                    onClick={() => setSelectedId(n.id)}
                    className={`flex w-full items-center gap-2 px-1 py-1.5 text-left hover:bg-ink-50 ${
                      selectedId === n.id ? 'bg-accent-50' : ''
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-ink-900">
                        {n.label}
                      </span>
                      <span className="block truncate text-2xs text-ink-400">
                        {n.metricKey}
                        {n.timeHorizon && ` · ${n.timeHorizon}`}
                      </span>
                    </span>
                    {m && (
                      <span
                        className={`shrink-0 rounded border px-1.5 py-0.5 text-2xs ${dimensionTone[m.dimension]}`}
                      >
                        {m.dimension}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
            {nodes.length === 0 && !error && (
              <li className="py-6 text-center text-xs text-ink-400">No value nodes yet.</li>
            )}
          </ul>
        </PanelCard>

        <div className="space-y-4">
          {!current && (
            <PanelCard title="Value node detail">
              <p className="py-8 text-center text-xs text-ink-400">
                Select a value node to inspect its metric semantics, observations, provenance and
                position in the value chain.
              </p>
            </PanelCard>
          )}

          {current && (
            <>
              <PanelCard
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {current.node.label}
                    {current.metric && (
                      <span
                        className={`rounded border px-1.5 py-0.5 text-2xs font-normal ${dimensionTone[current.metric.dimension]}`}
                      >
                        {current.metric.dimension}
                      </span>
                    )}
                  </span>
                }
              >
                {current.metric && (
                  <>
                    <p className="mb-2 text-xs text-ink-600">{current.metric.description}</p>
                    <Field label="Metric" value={current.metric.key} />
                    <Field label="Unit" value={current.metric.unitType} />
                    <Field label="Aggregation" value={current.metric.aggregation} />
                    <Field label="Direction" value={current.metric.directionality} />
                    <Field label="Time behaviour" value={current.metric.timeBehavior} />
                  </>
                )}
                <Field label="Time horizon" value={current.node.timeHorizon ?? '—'} />
                <div className="my-2 border-t border-ink-100" />
                <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-500">
                  Linked enterprise entity
                </p>
                {current.subject ? (
                  <>
                    <Field label="Entity" value={current.subject.name} />
                    <Field label="Type" value={current.subject.entityTypeKey} />
                    <Field label="Canonical key" value={current.subject.canonicalKey} />
                    <Field label="Source system" value={current.subject.sourceSystem} />
                    <p className="mt-1 text-2xs text-ink-400">
                      The value node references this entity. It holds no copy of its attributes.
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-ink-400">Scoped node, not bound to a single entity.</p>
                )}
              </PanelCard>

              <PanelCard
                title={
                  <span className="flex items-center gap-1.5">
                    <Info className="h-3.5 w-3.5" /> Observations ({current.observations.length})
                  </span>
                }
              >
                {current.observations.length === 0 && (
                  <p className="text-xs text-ink-400">No observations recorded for this node.</p>
                )}
                {current.observations.length > 0 && (
                  <table className="w-full text-2xs">
                    <thead>
                      <tr className="text-left text-ink-400">
                        <th className="pb-1 font-medium">Type</th>
                        <th className="pb-1 font-medium">Value</th>
                        <th className="pb-1 font-medium">When</th>
                        <th className="pb-1 font-medium">Source</th>
                        <th className="pb-1 font-medium">Conf.</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100">
                      {current.observations.map((o) => (
                        <tr key={o.id}>
                          <td className="py-1">
                            <span
                              className={`rounded px-1.5 py-0.5 font-semibold ${obsTone[o.observationType] ?? 'bg-ink-100'}`}
                            >
                              {o.observationType}
                            </span>
                            {o.scenarioEntityId && (
                              <span className="ml-1 text-ink-500">
                                {scenarioName(o.scenarioEntityId)}
                              </span>
                            )}
                          </td>
                          <td className="py-1 font-mono text-ink-900">{formatValue(o)}</td>
                          <td className="py-1 text-ink-500">
                            {o.effectiveAt
                              ? o.effectiveAt.slice(0, 10)
                              : `${o.periodStart?.slice(0, 10)} → ${o.periodEnd?.slice(0, 10)}`}
                          </td>
                          <td className="py-1 text-ink-600">{o.sourceSystem}</td>
                          <td className="py-1 text-ink-500">
                            {o.confidence === null ? '—' : o.confidence.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p className="mt-2 text-2xs text-ink-400">
                  These coexist: an actual, a forecast, a target and a scenario value are different
                  kinds of fact about the same quantity, and none supersedes another.
                </p>
              </PanelCard>

              <PanelCard
                title={
                  <span className="flex items-center gap-1.5">
                    <ArrowUp className="h-3.5 w-3.5" /> Upstream — what this depends on (
                    {current.upstream.length})
                  </span>
                }
              >
                <ul className="divide-y divide-ink-100">
                  {current.upstream.map((n) => (
                    <li key={n.via.id} className="flex items-center gap-2 py-1.5">
                      <span className="shrink-0 rounded bg-violet-50 px-1.5 py-0.5 text-2xs font-semibold text-violet-800">
                        {n.via.linkType}
                      </span>
                      <button
                        onClick={() => setSelectedId(n.node.id)}
                        className="min-w-0 flex-1 truncate text-left text-xs text-accent-700 hover:underline"
                      >
                        {n.node.label}
                      </button>
                      <span className="shrink-0 text-2xs text-ink-400">
                        {n.via.weight !== null && `w=${n.via.weight} `}
                        {n.via.confidence !== null && `c=${n.via.confidence}`}
                      </span>
                    </li>
                  ))}
                  {current.upstream.length === 0 && (
                    <li className="py-2 text-xs text-ink-400">Origin node — nothing upstream.</li>
                  )}
                </ul>
              </PanelCard>

              <PanelCard
                title={
                  <span className="flex items-center gap-1.5">
                    <ArrowDown className="h-3.5 w-3.5" /> Downstream — what this affects (
                    {current.downstream.length})
                  </span>
                }
              >
                <ul className="divide-y divide-ink-100">
                  {current.downstream.map((n) => (
                    <li key={n.via.id} className="flex items-center gap-2 py-1.5">
                      <span className="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-2xs font-semibold text-emerald-800">
                        {n.via.linkType}
                      </span>
                      <button
                        onClick={() => setSelectedId(n.node.id)}
                        className="min-w-0 flex-1 truncate text-left text-xs text-accent-700 hover:underline"
                      >
                        {n.node.label}
                      </button>
                      <span className="shrink-0 text-2xs text-ink-400">
                        {n.via.weight !== null && `w=${n.via.weight} `}
                        {n.via.confidence !== null && `c=${n.via.confidence}`}
                      </span>
                    </li>
                  ))}
                  {current.downstream.length === 0 && (
                    <li className="py-2 text-xs text-ink-400">
                      Terminal node — nothing downstream.
                    </li>
                  )}
                </ul>
              </PanelCard>

              <PanelCard
                title={`Value chain (depth ${depth})`}
                action={
                  <div className="flex gap-1">
                    {[1, 2, 3, 4, 5].map((d) => (
                      <button
                        key={d}
                        onClick={() => setDepth(d)}
                        className={`rounded px-1.5 py-0.5 text-2xs ${
                          depth === d ? 'bg-accent-600 text-white' : 'bg-ink-100 text-ink-600'
                        }`}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                }
              >
                {scenarioId && (
                  <p className="mb-2 rounded bg-amber-50 px-2 py-1 text-2xs text-amber-900">
                    Showing <strong>{scenarioName(scenarioId)}</strong> observations. Reality is
                    hidden in this view.
                  </p>
                )}
                {(['chainUp', 'chainDown'] as const).map((key) => {
                  const chain = current[key];
                  if (!chain) return null;
                  const label = key === 'chainUp' ? 'Upstream' : 'Downstream';
                  const rows = chain.nodes.filter((n) => n.depth > 0);
                  return (
                    <div key={key} className="mb-3">
                      <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-500">
                        {label} ({rows.length})
                      </p>
                      <ul className="space-y-0.5">
                        {rows.map((n) => {
                          const latest = n.observations[0];
                          return (
                            <li key={n.node.id} className="flex items-center gap-2 text-2xs">
                              <span
                                className="shrink-0 text-ink-300"
                                style={{ paddingLeft: `${(n.depth - 1) * 12}px` }}
                              >
                                └
                              </span>
                              <button
                                onClick={() => setSelectedId(n.node.id)}
                                className="truncate text-accent-700 hover:underline"
                              >
                                {n.node.label}
                              </button>
                              <span
                                className={`shrink-0 rounded border px-1 ${dimensionTone[n.metric.dimension]}`}
                              >
                                {n.metric.dimension}
                              </span>
                              {latest ? (
                                <span className="shrink-0 font-mono text-ink-700">
                                  {formatValue(latest)}
                                  <span className="ml-1 text-ink-400">
                                    {latest.observationType}
                                  </span>
                                </span>
                              ) : (
                                <span className="shrink-0 text-ink-300">no value</span>
                              )}
                              <span className="shrink-0 text-ink-400">
                                conf {n.pathConfidence.toFixed(3)}
                              </span>
                            </li>
                          );
                        })}
                        {rows.length === 0 && (
                          <li className="text-2xs text-ink-400">Nothing {label.toLowerCase()}.</li>
                        )}
                      </ul>
                    </div>
                  );
                })}
                <p className="mt-2 text-2xs text-ink-400">
                  Values shown are the observations attached to each node. Nothing is computed
                  through the chain — a downstream node with no observation stays empty, by design.
                  Propagation is Phase 3.
                </p>
              </PanelCard>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
