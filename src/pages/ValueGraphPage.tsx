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
import { PageHeader } from '../components/ui/PageHeader.tsx';
import { SectionHead } from '../components/ui/SectionHead.tsx';
import { Notice } from '../components/ui/Notice.tsx';
import { FactRow } from '../components/ui/FactRow.tsx';
import { controlSmClass } from '../components/ui/Field.tsx';
import { NodeIndex, DIM_PILL, type Dimension } from '../components/graph/NodeIndex.tsx';
import { NodeDetail } from '../components/graph/NodeDetail.tsx';
import { cn } from '../lib/cn.ts';

type Loaded = { valueGraph: ValueGraph; graphStore: GraphStore; scope: Scope };

const ORDER: Dimension[] = ['FINANCIAL', 'COMMERCIAL', 'CUSTOMER', 'OPERATIONAL', 'RESOURCE', 'CAPITAL', 'RISK', 'STRATEGIC', 'RESILIENCE'];

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

  // The first node in the index opens until someone picks one.
  const activeId = selectedId ?? nodes[0]?.id ?? null;

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
    if (!loaded || !activeId) return;
    let cancelled = false;
    (async () => {
      const scenarioArg = scenarioId ? (scenarioId as Entity['id']) : null;
      const node = await loaded.valueGraph.getValueNode(loaded.scope, activeId);
      if (!node.ok || !node.value) return;

      const [obs, up, down, chainUp, chainDown, metric] = await Promise.all([
        loaded.valueGraph.getObservations(loaded.scope, { nodeId: activeId }),
        loaded.valueGraph.getValueNeighborhood(loaded.scope, activeId, 'upstream'),
        loaded.valueGraph.getValueNeighborhood(loaded.scope, activeId, 'downstream'),
        loaded.valueGraph.getValueChain(loaded.scope, {
          start: [activeId],
          maxDepth: depth,
          direction: 'upstream',
          scenarioEntityId: scenarioArg,
        }),
        loaded.valueGraph.getValueChain(loaded.scope, {
          start: [activeId],
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
        forId: activeId,
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
  }, [loaded, activeId, depth, scenarioId]);

  const current =
    detail && detail.forId === activeId && detail.atDepth === depth && detail.scenarioKey === scenarioId ? detail : null;

  const indexNodes = useMemo(
    () =>
      nodes.map((n) => ({
        id: n.id,
        label: n.label,
        dimension: (valueMetrics.metric(n.metricKey)?.dimension ?? 'FINANCIAL') as Dimension,
      })),
    [nodes],
  );

  const scenarioName = (id: string | null) => (id ? (scenarios.find((s) => s.id === id)?.name ?? 'scenario') : null);

  const contentionFor = (id: string) => {
    const c = contention.find((x) => x.node.id === id);
    if (!c) return undefined;
    return (
      `${c.claimants.length} value streams draw on this — ${c.claimants.map((cl) => cl.node.label).join(', ')}` +
      (c.totalClaimedWeight !== null ? ` · ${c.totalClaimedWeight} units claimed` : '')
    );
  };

  return (
    <>
      <PageHeader kicker="Kernel instrument · Value Graph" title="How enterprise value is connected, node by node" size="instrument" />
      <p className="mt-2 max-w-[720px] text-read text-ink-600">
        Read-only. {valueMetrics.allMetrics().length} metrics across {valueDimensions.length} value dimensions. Structure
        only — nothing here is calculated; select a link to walk the graph.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search value nodes…"
          className={cn(controlSmClass, 'w-56')}
        />
        <select
          value={dimFilter}
          onChange={(e) => setDimFilter(e.target.value as ValueDimension | '')}
          className={controlSmClass}
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
          className={controlSmClass}
          aria-label="Observation context"
        >
          <option value="">Reality (actual / forecast / target)</option>
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <span className="helm-meta ml-1">{nodes.length} nodes</span>
      </div>

      {error && (
        <Notice tone="error" className="mt-5">
          {error}
        </Notice>
      )}

      {contention.length > 0 && (
        <Notice tone="warning" label={`Shared constrained resources · ${contention.length}`} className="mt-5">
          {contention.map((c) => (
            <p key={c.node.id}>
              <button type="button" onClick={() => setSelectedId(c.node.id)} className="font-medium underline-offset-[3px] hover:underline">
                {c.node.label}
              </button>{' '}
              — {c.claimants.length} value streams draw on this
              {c.totalClaimedWeight !== null && ` · ${c.totalClaimedWeight} units claimed`}
            </p>
          ))}
        </Notice>
      )}

      <div className="mt-7 flex flex-wrap items-start gap-10">
        {nodes.length === 0 && !error ? (
          <p className="text-base text-ink-600">No value nodes match.</p>
        ) : (
          <NodeIndex nodes={indexNodes} selected={activeId ?? ''} onSelect={setSelectedId} order={ORDER} />
        )}
        {current ? (
          <NodeDetail
            dimension={(current.metric?.dimension ?? 'FINANCIAL') as Dimension}
            metricKey={current.node.metricKey}
            label={current.node.label}
            description={current.metric?.description ?? ''}
            facts={[
              { label: 'Unit', value: current.metric?.unitType ?? '—', mono: true },
              { label: 'Aggregation', value: current.metric?.aggregation ?? '—', mono: true },
              { label: 'Direction', value: current.metric?.directionality ?? '—', mono: true },
              { label: 'Time', value: current.metric?.timeBehavior ?? '—', mono: true },
              { label: 'Horizon', value: current.node.timeHorizon ?? '—', mono: true },
              { label: 'Subject key', value: current.subject?.canonicalKey ?? 'scoped, no single entity', mono: true },
            ]}
            contention={contentionFor(current.node.id)}
            up={current.upstream.map((n) => ({ id: n.node.id, label: n.node.label, type: n.via.linkType, weight: n.via.weight, confidence: n.via.confidence }))}
            down={current.downstream.map((n) => ({ id: n.node.id, label: n.node.label, type: n.via.linkType, weight: n.via.weight, confidence: n.via.confidence }))}
            observations={current.observations.map((o) => ({
              kind: o.observationType,
              value: formatValue(o),
              when: o.effectiveAt ? o.effectiveAt.slice(0, 10) : `${o.periodStart?.slice(0, 10)} → ${o.periodEnd?.slice(0, 10)}`,
              source: o.sourceSystem,
              confidence: o.confidence === null ? '—' : o.confidence.toFixed(2),
              scenario: scenarioName(o.scenarioEntityId) ?? undefined,
            }))}
            onSelect={setSelectedId}
          >
            {current.subject && (
              <div className="mt-8">
                <SectionHead title="The enterprise entity it describes" size="section-sm" caveat="referenced, never copied" className="pb-2" />
                <FactRow
                  className="mt-3"
                  facts={[
                    { label: 'Entity', value: current.subject.name },
                    { label: 'Type', value: current.subject.entityTypeKey, mono: true },
                    { label: 'Canonical key', value: current.subject.canonicalKey, mono: true },
                    { label: 'Source system', value: current.subject.sourceSystem, mono: true },
                  ]}
                />
              </div>
            )}
            <div className="mt-8">
              <SectionHead
                title="The value chain"
                size="section-sm"
                meta={`depth ${depth}`}
                caveat={
                  <span className="flex gap-1 not-italic">
                    {[1, 2, 3, 4, 5].map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setDepth(d)}
                        aria-pressed={depth === d}
                        className={cn('rounded-md px-2 font-mono text-meta', depth === d ? 'bg-accent-800 text-white' : 'bg-ink-100 text-ink-700 hover:bg-ink-200')}
                      >
                        {d}
                      </button>
                    ))}
                  </span>
                }
                className="pb-2"
              />
              {scenarioId && (
                <p className="mt-3 text-dense text-amber-800">
                  Showing <span className="font-semibold">{scenarioName(scenarioId)}</span> observations. Reality is hidden in this view.
                </p>
              )}
              {(['chainUp', 'chainDown'] as const).map((key) => {
                const chain = current[key];
                if (!chain) return null;
                const label = key === 'chainUp' ? 'Upstream' : 'Downstream';
                const rows = chain.nodes.filter((n) => n.depth > 0);
                return (
                  <div key={key} className="mt-4">
                    <p className="helm-label mb-1">
                      {label} · {rows.length}
                    </p>
                    {rows.map((n) => {
                      const latest = n.observations[0];
                      const dim = n.metric.dimension as Dimension;
                      return (
                        <div
                          key={n.node.id}
                          className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 border-b border-ink-100 py-2"
                          style={{ paddingLeft: (n.depth - 1) * 20 }}
                        >
                          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="font-mono text-dense text-ink-400">└</span>
                            <button type="button" onClick={() => setSelectedId(n.node.id)} className="truncate text-left text-dense font-medium text-accent-700 hover:underline">
                              {n.node.label}
                            </button>
                            <span className={cn('rounded-full px-2 py-px font-mono text-tag font-semibold', DIM_PILL[dim])}>{dim}</span>
                          </span>
                          <span className="text-right font-mono text-meta">
                            {latest ? (
                              <>
                                {formatValue(latest)} <span className="text-ink-500">{latest.observationType}</span>
                              </>
                            ) : (
                              <span className="text-ink-400">no value</span>
                            )}
                            <span className="ml-2 text-ink-500">conf {n.pathConfidence.toFixed(3)}</span>
                          </span>
                        </div>
                      );
                    })}
                    {rows.length === 0 && <p className="text-dense text-ink-500">Nothing {label.toLowerCase()}.</p>}
                  </div>
                );
              })}
              <p className="mt-3 text-meta text-ink-500">
                Values shown are the observations attached to each node. Nothing is computed through the chain — a
                downstream node with no observation stays empty, by design.
              </p>
            </div>
          </NodeDetail>
        ) : (
          activeId && <p className="min-w-0 flex-[1_1_560px] text-ui text-ink-500">Reading the node…</p>
        )}
      </div>
    </>
  );
}
