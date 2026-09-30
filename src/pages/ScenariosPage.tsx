/**
 * The Scenario Explorer — a technical instrument for the Phase 4 kernel, not
 * the GM cockpit.
 *
 * It lets a reviewer confirm that HELM branches the enterprise into futures:
 * pick the baseline boundary, create a scenario, state its overrides, simulate
 * it through the propagation engine, and compare the resulting future states —
 * assumptions and outcomes shown separately, confidence beside every value,
 * feasibility checked, lineage one click away. It never ranks, scores or
 * recommends: the trade-off space is shown, and choosing within it is a
 * management decision (Phase 5).
 *
 * Replaces the pre-kernel CVP what-if pages (retired in Phase 4 — see
 * docs/archive/scenario-engine-assessment.md).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  COMPARISON_STATEMENT,
  overrideProvenanceKinds,
  type EffectiveOverride,
  type FutureState,
  type OverrideProvenanceKind,
  type OverrideType,
  type ScenarioComparison,
  type ScenarioExplanation,
  type ValueDelta,
} from '@helm/scenario-runtime';
import type { Explanation } from '@helm/propagation-engine';
import { periodKey, type Period } from '@helm/shared';
import { useHelmStore } from '../services/helmStore.ts';
import { cloudScope, demoScope } from '../services/ontologyGraph.ts';
import {
  BRANCH_METRICS,
  displayConfidence,
  displayDelta,
  displayInstant,
  displayValue,
  pickValue,
  resolveScenarioWorkspace,
  type ScenarioWorkspace,
} from '../services/scenarioRuntime.ts';
import {
  branchOrder,
  listOverridableNodes,
  loadExplorer,
  type ExplorerData,
  type OverridableNode,
  type ScenarioSnapshot,
} from '../services/scenarioExplorer.ts';
import { PageHeader } from '../components/ui/PageHeader.tsx';
import { SectionHead } from '../components/ui/SectionHead.tsx';
import { FactRow } from '../components/ui/FactRow.tsx';
import { Button } from '../components/ui/Button.tsx';
import { Pill } from '../components/ui/Pill.tsx';
import { Modal } from '../components/ui/Modal.tsx';
import { Notice } from '../components/ui/Notice.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { Field, controlClass } from '../components/ui/Field.tsx';
import { ScenarioCompare, type CompareCell, type CompareCol, type CompareRow, type Interp } from '../components/scenario/ScenarioCompare.tsx';
import { OverrideList } from '../components/scenario/OverrideList.tsx';
import { FeasibilityList, type FeasibilityView } from '../components/scenario/FeasibilityList.tsx';
import { LineageTree, type LineageNode } from '../components/scenario/LineageTree.tsx';
import { cn } from '../lib/cn.ts';

type Act = (fn: () => Promise<{ ok: boolean; error?: { code: string; message: string } }>) => Promise<void>;

const BASE = 'baseline';
const arrow = (d: ValueDelta) =>
  d.direction === 'UP' ? '▲' : d.direction === 'DOWN' ? '▼' : d.direction === 'UNCHANGED' ? '=' : '?';

/** "B — Reallocate distributor stock" → mark "B"; otherwise the scenario key. */
const markOf = (name: string, key: string) => /^([A-Z])\s+—\s+/.exec(name)?.[1] ?? key;

/** A delta as the compare table reads it, coloured by the metric's own direction. */
function deltaLine(d: ValueDelta | undefined): Pick<CompareCell, 'delta' | 'interp'> {
  if (!d || d.direction === 'UNCHANGED') return {};
  if (d.direction === 'UNRESOLVED') return { delta: 'unresolved', interp: 'UNRESOLVED' };
  const context = d.directionalInterpretation === 'CONTEXT_DEPENDENT' ? ' · context' : '';
  return {
    delta: `${arrow(d)} ${displayDelta(d.absoluteDelta, d.unit, d.currency)}${context}`,
    interp: (d.directionalInterpretation ?? 'NEUTRAL') as Interp,
  };
}

/** The kernel's explanation tree, as the lineage rows read it. */
function toLineage(node: Explanation): LineageNode {
  const kind = node.override ? 'OVERRIDDEN' : node.derivation ? 'COMPUTED' : node.observationType;
  const foot = node.override
    ? `scenario override ${node.override.operation} ${node.override.value} · ${node.override.provenanceKind.toLowerCase()}` +
      (node.override.inheritedFromScenarioId ? ' · inherited' : '') +
      (node.override.shadowedOverrideIds.length > 0 ? ` · shadows ${node.override.shadowedOverrideIds.length}` : '')
    : node.derivation
      ? `${node.derivation.calculationKey}@${node.derivation.calculationVersion} · ${node.derivation.renderedExpression}`
      : node.source
        ? `stated by ${node.source.system}${node.source.method ? ` · ${node.source.method}` : ''}`
        : 'stated';
  return { metricKey: node.metricKey, value: node.value ?? '—', kind, foot, inputs: node.inputs.map(toLineage) };
}

// ================================================================ page

export function ScenariosPage() {
  const mode = useHelmStore((s) => s.mode);
  const activeOrgId = useHelmStore((s) => s.activeOrgId);
  const userId = useHelmStore((s) => s.userId);
  const myRole = useHelmStore((s) => s.myRole);

  const [ws, setWs] = useState<ScenarioWorkspace | null>(null);
  const [data, setData] = useState<ExplorerData | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [periodKeyShown, setPeriodKeyShown] = useState<string | null>(null);
  const [lineage, setLineage] = useState<ScenarioExplanation | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changedOnly, setChangedOnly] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const scope = mode === 'demo' ? demoScope() : cloudScope(activeOrgId ?? '', userId ?? '', myRole());
        const w = await resolveScenarioWorkspace(mode === 'demo' ? 'demo' : 'cloud', scope);
        if (cancelled) return;
        if (!w) {
          setError('Cloud mode is not configured, so there is no scenario store to open.');
          return;
        }
        setWs(w);
        const d = await loadExplorer(w);
        if (cancelled) return;
        setData(d);
        setSelectedId(d.scenarios[0]?.scenario.id ?? null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, activeOrgId, userId, myRole]);

  const reload = useCallback(async () => {
    if (!ws) return;
    setData(await loadExplorer(ws));
  }, [ws]);

  /** Runs one runtime action, then reloads; errors are shown, never swallowed. */
  const act: Act = useCallback(
    async (fn) => {
      setBusy(true);
      setError(null);
      try {
        const r = await fn();
        if (!r.ok && r.error) setError(`${r.error.code}: ${r.error.message}`);
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const periods: Period[] = useMemo(() => {
    const all = new Map<string, Period>();
    for (const s of Object.values(data?.states ?? {})) for (const p of s.run.periods) all.set(periodKey(p), p);
    return [...all.values()].sort((a, b) => a.start.localeCompare(b.start));
  }, [data]);
  const period = periods.find((p) => periodKey(p) === periodKeyShown) ?? periods[0] ?? null;
  const selected = data?.scenarios.find((s) => s.scenario.id === selectedId) ?? null;

  const explain = useCallback(
    async (runId: string, nodeId: string) => {
      if (!ws || !period) return;
      const r = await ws.runtime.explain(ws.scope, runId, nodeId, period);
      if (!r.ok) setError(`${r.error.code}: ${r.error.message}`);
      else {
        setLineage(r.value);
        requestAnimationFrame(() => document.getElementById('lineage')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      }
    },
    [ws, period],
  );

  if (error && !ws) return <EmptyState title="The scenario runtime could not be opened" detail={error} />;
  if (!ws || !data) return <p className="text-ui text-ink-500">Branching the enterprise model…</p>;

  const baselineState = data.baselineRun ? data.states[data.baselineRun.id] : null;
  const fork = data.baselineRun?.fork ?? ws.defaultFork;
  const tree = branchOrder(data.scenarios);
  const simulated = data.scenarios.filter((s) => s.latestRun).length;
  const title =
    data.scenarios.length === 0
      ? 'No futures branched from the baseline yet'
      : `${data.scenarios.length} ${data.scenarios.length === 1 ? 'future' : 'futures'} branched from one baseline` +
        (simulated < data.scenarios.length ? ` — ${simulated} simulated` : '');

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <PageHeader kicker="Kernel instrument · Scenarios" title={title} size="instrument" />
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy}
            onClick={() =>
              void act(() =>
                ws.runtime.executeBaseline(ws.scope, { fork: ws.defaultFork, periods: ws.periodChoices.slice(0, 1) }),
              )
            }
          >
            Simulate baseline
          </Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            New scenario
          </Button>
        </div>
      </div>
      <p className="mt-2 max-w-[760px] text-read text-ink-600">
        Branching future states over one pinned baseline. Every number is computed by the propagation engine from
        explicit overrides; HELM compares the futures and does not choose between them.
      </p>
      <FactRow
        className="mt-[18px] border-b border-ink-200 pb-5"
        facts={[
          { label: 'Effective as of', value: displayInstant(fork.effectiveAsOf), mono: true },
          { label: 'Recorded through', value: displayInstant(fork.recordedThrough), mono: true },
          { label: 'Fork policy', value: fork.policy, mono: true },
          { label: 'Baseline run', value: data.baselineRun ? data.baselineRun.id.slice(0, 8) : 'not simulated', mono: true },
          { label: 'Fingerprint', value: data.baselineRun ? `${data.baselineRun.fingerprint.slice(0, 16)}…` : '—', mono: true },
          { label: 'Mode', value: ws.mode === 'demo' ? 'DEMO · in memory' : 'CLOUD · RLS', mono: true },
        ]}
      />

      {error && (
        <Notice tone="error" className="mt-5" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}

      {periods.length > 1 && (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <span className="helm-label mr-1">Period</span>
          {periods.map((p) => (
            <button
              key={periodKey(p)}
              type="button"
              onClick={() => setPeriodKeyShown(periodKey(p))}
              className={cn(
                'rounded-lg px-[10px] py-1 font-mono text-meta',
                period && periodKey(p) === periodKey(period) ? 'bg-accent-800 text-white' : 'bg-ink-100 text-ink-700 hover:bg-ink-200',
              )}
            >
              {periodKey(p)}
            </button>
          ))}
          <span className="helm-caveat ml-2">periods are never compared across one another</span>
        </div>
      )}

      {period && (
        <section className="mt-8">
          <SectionHead title="What each future does to the enterprise" caveat="HELM does not rank, score or recommend" />
          <HeadlineCompare
            data={data}
            tree={tree}
            baselineState={baselineState}
            period={period}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onExplain={(runId, nodeId) => void explain(runId, nodeId)}
          />
          <p className="mt-3 max-w-[820px] text-dense text-ink-500">
            Deltas are read against the baseline, in the metric's own direction: ▲▼ in sea green are favourable, in
            brick unfavourable; harbour means it depends on context. Select a column to read its overrides; select a
            value to see where it comes from.
          </p>
        </section>
      )}

      <div className="mt-10 flex flex-wrap items-start gap-10">
        <section className="min-w-0 flex-[1_1_560px]">
          {selected ? (
            <ScenarioDetail key={selected.scenario.id} ws={ws} snapshot={selected} busy={busy} act={act} data={data} />
          ) : (
            <>
              <SectionHead title="What was changed" />
              <p className="mt-3 text-base text-ink-600">Create a scenario to branch the baseline.</p>
            </>
          )}
        </section>
        {period && (
          <section className="min-w-0 max-w-[440px] flex-[1_1_320px]">
            <SectionHead title="Can it be done?" meta={periodKey(period)} />
            <Feasibility data={data} baselineState={baselineState} period={period} />
          </section>
        )}
      </div>

      {data.overview && period && (
        <Comparison
          comparison={data.overview}
          period={period}
          hidden={hidden}
          onToggle={(runId) =>
            setHidden((h) => {
              const next = new Set(h);
              if (next.has(runId)) next.delete(runId);
              else next.add(runId);
              return next;
            })
          }
          changedOnly={changedOnly}
          onChangedOnly={setChangedOnly}
          onExplain={(runId, nodeId) => void explain(runId, nodeId)}
        />
      )}

      <section id="lineage" className="mt-11 max-w-[980px] scroll-mt-6">
        <SectionHead
          title="Where one number comes from"
          meta={
            lineage
              ? `${lineage.state.label} · ${periodKey(lineage.period)} · run ${lineage.calculationRunId?.slice(0, 8) ?? '—'} · revision ${lineage.state.revisionId?.slice(0, 8) ?? 'baseline'} · known through ${displayInstant(lineage.fork.recordedThrough)}`
              : undefined
          }
          caveat={lineage ? <button type="button" onClick={() => setLineage(null)} className="hover:underline">clear</button> : undefined}
        />
        {!lineage ? (
          <p className="mt-3 text-base text-ink-600">
            Select any value above: future-state value → calculation run → scenario revision → overrides → baseline inputs
            → source provenance.
          </p>
        ) : (
          <>
            <p className="mt-3 flex flex-wrap items-baseline gap-2 text-base">
              <span className="font-semibold">{lineage.value.nodeLabel}</span>
              <span className="font-mono">= {lineage.value.value ?? '—'}</span>
              <Pill tone={lineage.value.origin === 'BLOCKED' ? 'blocked' : lineage.value.origin === 'OVERRIDDEN' ? 'overridden' : lineage.value.origin === 'COMPUTED' ? 'computed' : 'neutral'}>
                {lineage.value.origin}
              </Pill>
              {lineage.value.reason && <span className="text-meta text-ink-500">{lineage.value.reason}</span>}
            </p>
            {lineage.lineage ? (
              <div className="mt-2">
                <LineageTree node={toLineage(lineage.lineage)} />
              </div>
            ) : (
              <p className="mt-2 text-base text-ink-600">No derivation: this value was not computed.</p>
            )}
          </>
        )}
      </section>

      {creating && (
        <NewScenarioModal
          ws={ws}
          data={data}
          onClose={() => setCreating(false)}
          onCreate={async (input) => {
            setCreating(false);
            await act(async () => {
              const r = await ws.runtime.createScenario(ws.scope, input);
              if (r.ok) setSelectedId(r.value.scenario.id);
              return r;
            });
          }}
        />
      )}
    </>
  );
}

// ====================================================== headline compare

/** Baseline first, then every future in branch order — the same five values each. */
function HeadlineCompare({
  data,
  tree,
  baselineState,
  period,
  selectedId,
  onSelect,
  onExplain,
}: {
  data: ExplorerData;
  tree: { snapshot: ScenarioSnapshot; depth: number }[];
  baselineState: FutureState | null;
  period: Period;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onExplain: (runId: string, nodeId: string) => void;
}) {
  const deltaFor = (runId: string | undefined, nodeId: string | undefined) =>
    data.overview?.metricDeltas.find(
      (d) => d.state.runId === runId && d.nodeId === nodeId && periodKey(d.period) === periodKey(period),
    );

  const cols: CompareCol[] = [
    {
      key: BASE,
      mark: 'BASE',
      title: 'Baseline',
      state: baselineState ? baselineState.completeness : 'NOT SIMULATED',
      partial: baselineState?.completeness !== 'COMPLETE',
      selectable: false,
    },
    ...tree.map(({ snapshot: s, depth }) => {
      const state = s.latestRun ? data.states[s.latestRun.id] : null;
      return {
        key: s.scenario.id,
        mark: markOf(s.scenario.name, s.scenario.key),
        title: `${depth > 0 ? '↳ ' : ''}${s.scenario.name.replace(/^[A-Z]\s+—\s+/, '')}`,
        state: `${s.scenario.status} · r${s.latestRevision?.revisionNumber ?? '?'}${state ? ` · ${state.completeness}` : ''}${s.scenario.parentScenarioId ? ' · inherits' : ''}`,
        partial: state ? state.completeness !== 'COMPLETE' : false,
      };
    }),
  ];

  const cellFor = (state: FutureState | null, metricKey: string, hint: string | undefined, withDelta: boolean): CompareCell => {
    if (!state) return { value: 'not simulated', title: 'this future has no simulation yet' };
    const v = pickValue(state, metricKey, period, hint);
    if (!v) return { value: '—' };
    const explainIt = () => onExplain(state.run.id, v.nodeId);
    if (v.value === null)
      return { value: v.origin, blocked: v.origin === 'BLOCKED', delta: v.reason ?? undefined, interp: 'UNFAVORABLE', title: v.reason ?? '', onExplain: explainIt };
    return {
      value: displayValue(v.value, v.unit, v.currency),
      title: v.value,
      onExplain: explainIt,
      ...(withDelta ? deltaLine(deltaFor(state.run.id, v.nodeId)) : {}),
    };
  };

  const rows: CompareRow[] = BRANCH_METRICS.map((m) => ({
    label: m.label,
    cells: [
      cellFor(baselineState, m.metricKey, m.subjectHint, false),
      ...tree.map(({ snapshot: s }) => cellFor(s.latestRun ? data.states[s.latestRun.id] : null, m.metricKey, m.subjectHint, true)),
    ],
  }));

  return <ScenarioCompare cols={cols} rows={rows} selected={selectedId ?? ''} onSelect={onSelect} />;
}

// =========================================================== feasibility

function Feasibility({ data, baselineState, period }: { data: ExplorerData; baselineState: FutureState | null; period: Period }) {
  const states = [baselineState, ...data.scenarios.map((s) => (s.latestRun ? data.states[s.latestRun.id] : null))].filter(
    (s): s is FutureState => s !== null,
  );
  const items: FeasibilityView[] = states.flatMap((s) =>
    s.constraints
      .filter((c) => periodKey(c.period) === periodKey(period))
      .map((c) => ({
        key: `${s.run.id}-${c.constraintKey}`,
        state: s.label,
        name: c.name,
        status: c.status,
        explanation: `${c.explanation}${c.status === 'BREACHED' && c.breachAmount ? ` Breached by ${c.breachAmount}${c.unit ? ` ${c.unit}` : ''}.` : ''}`,
      })),
  );
  if (items.length === 0) return <p className="mt-3 text-base text-ink-600">No constraint was checked for this period.</p>;
  return <FeasibilityList items={items} />;
}

// ======================================================= scenario detail

function ScenarioDetail({
  ws,
  snapshot,
  busy,
  act,
  data,
}: {
  ws: ScenarioWorkspace;
  snapshot: ScenarioSnapshot;
  busy: boolean;
  act: Act;
  data: ExplorerData;
}) {
  const { scenario, revisions, latestRevision, latestRun, report } = snapshot;
  const terminal = scenario.status === 'ARCHIVED' || scenario.status === 'INVALIDATED';
  const draft = latestRevision?.state === 'DRAFT';
  const parent = data.scenarios.find((s) => s.scenario.id === scenario.parentScenarioId)?.scenario ?? null;
  const [adding, setAdding] = useState(false);

  // One row per effective override; an all-period override appears once.
  const effective = useMemo(() => {
    const seen = new Map<string, { period: Period; e: EffectiveOverride }>();
    for (const { period, overrides } of report?.effective ?? []) {
      for (const e of overrides) {
        if (!seen.has(e.override.id)) seen.set(e.override.id, { period, e });
      }
    }
    return [...seen.values()];
  }, [report]);

  const baselineFor = (nodeId: string, runId: string | undefined) =>
    data.overview?.assumptionDeltas.find((a) => a.nodeId === nodeId && a.state.runId === runId);

  return (
    <>
      <SectionHead
        title={`What was changed in ${scenario.name}`}
        meta={[
          scenario.status,
          latestRevision ? `r${latestRevision.revisionNumber} ${latestRevision.state}` : null,
          latestRun ? `run ${latestRun.id.slice(0, 8)}` : 'not simulated',
        ]
          .filter(Boolean)
          .join(' · ')}
      />
      <p className="mt-3 text-base text-ink-700">{scenario.description || 'No description was written for this scenario.'}</p>
      <p className="helm-meta mt-2">
        key {scenario.key}
        {parent && ` · inherits from ${parent.name} (pinned revision)`}
        {latestRevision && ` · known through ${displayInstant(latestRevision.fork.recordedThrough)} · periods ${latestRevision.periods.map(periodKey).join(', ')}`}
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={busy || terminal} onClick={() => void act(() => ws.runtime.execute(ws.scope, scenario.id))}>
          Simulate
        </Button>
        {draft && (
          <Button size="sm" disabled={busy || terminal} onClick={() => void act(() => ws.runtime.markReady(ws.scope, latestRevision.id))}>
            Seal revision
          </Button>
        )}
        {!draft && (
          <Button size="sm" disabled={busy || terminal} onClick={() => void act(() => ws.runtime.createRevision(ws.scope, scenario.id))}>
            New revision
          </Button>
        )}
        {!draft && (
          <Button
            size="sm"
            disabled={busy || terminal}
            title="Same assumptions, today's knowledge: a new REBASED revision"
            onClick={() => void act(() => ws.runtime.rebase(ws.scope, scenario.id))}
          >
            Rebase to now
          </Button>
        )}
        {latestRun && (
          <Button
            size="sm"
            disabled={busy}
            title="Same revision, same boundary: must reproduce the future state"
            onClick={() => void act(() => ws.runtime.replay(ws.scope, latestRun.id))}
          >
            Replay
          </Button>
        )}
        {!terminal && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => ws.runtime.archive(ws.scope, scenario.id))}>
            Archive
          </Button>
        )}
      </div>

      {effective.length === 0 ? (
        <p className="mt-4 text-base text-ink-600">No overrides: this revision simulates the baseline itself.</p>
      ) : (
        <div className="mt-2">
          <OverrideList
            items={effective.map(({ e }) => {
              const o = e.override;
              const delta = baselineFor(o.targetNodeId, latestRun?.id);
              return {
                id: o.id,
                target: data.nodeLabels[o.targetNodeId] ?? o.metricKey,
                rationale: o.rationale,
                change: `${o.operation === 'ADD' ? displayDelta(o.value, o.unit, o.currency) : `= ${displayValue(o.value, o.unit, o.currency)}`}`,
                baseline: delta ? displayValue(delta.baselineValue, delta.unit, delta.currency) : '—',
                future: delta ? displayValue(delta.scenarioValue, delta.unit, delta.currency) : '—',
                provenance: o.provenanceKind,
                type: o.overrideType,
                confidence: displayConfidence(o.confidence),
                period: o.period ? periodKey(o.period) : 'all periods',
                note: [e.inheritedFromScenarioId ? 'inherited' : null, e.shadowed.length > 0 ? `shadows ${e.shadowed.length}` : null]
                  .filter(Boolean)
                  .join(' · ') || undefined,
                action:
                  draft && !e.inheritedFromScenarioId ? (
                    <button
                      type="button"
                      className="text-meta font-medium text-red-700 hover:underline"
                      disabled={busy}
                      onClick={() => void act(() => ws.runtime.removeOverride(ws.scope, o.id))}
                    >
                      remove
                    </button>
                  ) : undefined,
              };
            })}
          />
        </div>
      )}

      {draft && !terminal && latestRevision &&
        (adding ? (
          <AddOverrideForm
            ws={ws}
            periods={latestRevision.periods}
            onCancel={() => setAdding(false)}
            onAdd={async (input) => {
              setAdding(false);
              await act(() => ws.runtime.addOverride(ws.scope, latestRevision.id, input));
            }}
          />
        ) : (
          <button type="button" className="mt-3 text-dense font-medium text-accent-700 hover:underline" onClick={() => setAdding(true)}>
            + Add an override
          </button>
        ))}

      {report && report.issues.some((i) => i.severity !== 'INFO') && (
        <div className="mt-6">
          <p className="helm-label mb-1">Validation</p>
          {report.issues
            .filter((i) => i.severity !== 'INFO')
            .map((i, n) => (
              <div key={n} className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-4 border-b border-ink-200 py-2">
                <span className={cn('font-mono text-[11px] font-semibold leading-5', i.severity === 'ERROR' ? 'text-red-700' : 'text-amber-700')}>
                  {i.severity}
                </span>
                <span className="text-dense text-ink-700">{i.message}</span>
              </div>
            ))}
        </div>
      )}

      <div className="mt-6">
        <p className="helm-label mb-1">Revisions</p>
        {revisions.map((r) => (
          <div key={r.id} className="flex flex-wrap gap-x-4 border-b border-ink-200 py-2 font-mono text-meta text-ink-600">
            <span className="font-semibold text-ink-950">r{r.revisionNumber}</span>
            <span>{r.state}</span>
            <span>{r.reason}</span>
            <span>known through {displayInstant(r.fork.recordedThrough)}</span>
            {r.fingerprint && <span className="text-ink-500">{r.fingerprint.slice(0, 22)}…</span>}
          </div>
        ))}
      </div>
    </>
  );
}

function AddOverrideForm({
  ws,
  periods,
  onAdd,
  onCancel,
}: {
  ws: ScenarioWorkspace;
  periods: readonly Period[];
  onAdd: (input: Parameters<ScenarioWorkspace['runtime']['addOverride']>[2]) => Promise<void>;
  onCancel: () => void;
}) {
  const [nodes, setNodes] = useState<OverridableNode[]>([]);
  const [nodeId, setNodeId] = useState('');
  const [operation, setOperation] = useState<'SET' | 'ADD'>('SET');
  const [value, setValue] = useState('');
  const [periodChoice, setPeriodChoice] = useState('all');
  const [overrideType, setOverrideType] = useState<OverrideType>('VALUE_OVERRIDE');
  const [provenanceKind, setProvenanceKind] = useState<OverrideProvenanceKind>('MANAGEMENT_ASSUMPTION');
  const [confidence, setConfidence] = useState('0.7');
  const [rationale, setRationale] = useState('');

  useEffect(() => {
    void listOverridableNodes(ws, periods).then((n) => {
      setNodes(n);
      setNodeId((current) => current || n[0]?.id || '');
    });
  }, [ws, periods]);
  const node = nodes.find((n) => n.id === nodeId);

  return (
    <form
      className="mt-4 grid gap-[14px] rounded-xl border border-ink-200 bg-white p-5 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!node) return;
        void onAdd({
          overrideType,
          targetNodeId: node.id,
          operation,
          value,
          unit: node.unitType,
          currency: node.unitType === 'currency' ? node.defaultCurrency : null,
          period: periodChoice === 'all' ? null : periods.find((p) => periodKey(p) === periodChoice) ?? null,
          provenanceKind,
          rationale,
          confidence: confidence === '' ? null : Number(confidence),
        });
      }}
    >
      <Field label="Target (inputs only — outcomes are derived)" className="sm:col-span-2">
        <select className={controlClass} value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label} · {n.unitType}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Change">
        <div className="flex gap-2">
          <select className={controlClass + ' w-32'} value={operation} onChange={(e) => setOperation(e.target.value as 'SET' | 'ADD')}>
            <option value="SET">set to</option>
            <option value="ADD">adjust by</option>
          </select>
          <input className={controlClass + ' font-mono'} value={value} onChange={(e) => setValue(e.target.value)} placeholder={node?.unitType ?? ''} required />
        </div>
      </Field>
      <Field label="Period">
        <select className={controlClass} value={periodChoice} onChange={(e) => setPeriodChoice(e.target.value)}>
          <option value="all">every period</option>
          {periods.map((p) => (
            <option key={periodKey(p)} value={periodKey(p)}>
              {periodKey(p)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Kind">
        <select className={controlClass} value={overrideType} onChange={(e) => setOverrideType(e.target.value as OverrideType)}>
          <option value="VALUE_OVERRIDE">value override</option>
          <option value="ASSUMPTION_OVERRIDE">assumption override</option>
        </select>
      </Field>
      <Field label="Provenance">
        <select className={controlClass} value={provenanceKind} onChange={(e) => setProvenanceKind(e.target.value as OverrideProvenanceKind)}>
          {overrideProvenanceKinds.map((k) => (
            <option key={k} value={k}>
              {k.replaceAll('_', ' ').toLowerCase()}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Confidence (0–1)">
        <input className={controlClass + ' font-mono'} value={confidence} onChange={(e) => setConfidence(e.target.value)} />
      </Field>
      <Field label="Rationale" className="sm:col-span-2">
        <input className={controlClass} value={rationale} onChange={(e) => setRationale(e.target.value)} required minLength={8} />
      </Field>
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit">
          Add override
        </Button>
      </div>
    </form>
  );
}

// ======================================================= full comparison

function Comparison({
  comparison,
  period,
  hidden,
  onToggle,
  changedOnly,
  onChangedOnly,
  onExplain,
}: {
  comparison: ScenarioComparison;
  period: Period;
  hidden: ReadonlySet<string>;
  onToggle: (runId: string) => void;
  changedOnly: boolean;
  onChangedOnly: (v: boolean) => void;
  onExplain: (runId: string, nodeId: string) => void;
}) {
  const pk = periodKey(period);
  const shown = comparison.alternatives.filter((a) => !hidden.has(a.runId));
  const delta = (runId: string, nodeId: string) =>
    comparison.metricDeltas.find((d) => d.state.runId === runId && d.nodeId === nodeId && periodKey(d.period) === pk);
  const moved = (nodeId: string) =>
    shown.some((a) => {
      const d = delta(a.runId, nodeId);
      return d && d.direction !== 'UNCHANGED';
    });
  const assumptions = comparison.assumptionDeltas.filter(
    (a) => !hidden.has(a.state.runId) && (a.period === null || periodKey(a.period) === pk),
  );
  const unitOf = (nodeId: string) => comparison.metricDeltas.find((d) => d.nodeId === nodeId);

  const cols: CompareCol[] = [
    { key: comparison.baseline.runId, mark: 'BASE', title: comparison.baseline.label, state: 'baseline', selectable: false },
    ...shown.map((a) => ({
      key: a.runId,
      mark: markOf(a.label, 'FUTURE'),
      title: a.label.replace(/^[A-Z]\s+—\s+/, ''),
      state: `run ${a.runId.slice(0, 8)}`,
      selectable: false,
    })),
  ];
  const rows: CompareRow[] = comparison.rows
    .filter((r) => periodKey(r.period) === pk)
    .filter((r) => !changedOnly || moved(r.nodeId))
    .map((r) => {
      const u = unitOf(r.nodeId);
      const cell = (runId: string, withDelta: boolean): CompareCell => {
        const c = r.cells.find((x) => x.state.runId === runId);
        const value = c?.value ?? null;
        return {
          value: value === null ? (c?.origin ?? '—') : displayValue(value, u?.unit ?? null, u?.currency ?? null),
          blocked: c?.origin === 'BLOCKED',
          title: [value ?? c?.reason ?? '', c?.confidence != null ? `confidence ${displayConfidence(c.confidence)}` : '', c?.origin ?? '']
            .filter(Boolean)
            .join(' · '),
          onExplain: () => onExplain(runId, r.nodeId),
          ...(withDelta ? deltaLine(delta(runId, r.nodeId)) : {}),
        };
      };
      return {
        key: r.nodeId,
        label: r.nodeLabel,
        meta: r.dimension.toLowerCase(),
        cells: [cell(comparison.baseline.runId, false), ...shown.map((a) => cell(a.runId, true))],
      };
    });

  return (
    <>
      <section className="mt-11">
        <SectionHead title="What each future changes" meta={pk} caveat="assumptions, kept apart from outcomes" />
        <p className="mt-3 max-w-reading text-base text-ink-700">{COMPARISON_STATEMENT}</p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="helm-label">States</span>
          {comparison.alternatives.map((a) => (
            <label key={a.runId} className="inline-flex items-center gap-2 text-dense">
              <input type="checkbox" checked={!hidden.has(a.runId)} onChange={() => onToggle(a.runId)} /> {a.label}
            </label>
          ))}
        </div>
        {assumptions.length === 0 ? (
          <p className="mt-3 text-base text-ink-600">No shown future changes an assumption in this period.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[880px] border-collapse">
              <thead>
                <tr>
                  {['Future', 'Assumption', 'Baseline', 'Future', 'Change', 'Why'].map((h, i) => (
                    <th key={i} className={cn('helm-label pb-2 pt-[14px] text-left', i > 0 && 'pl-3', (i === 2 || i === 3 || i === 4) && 'text-right')}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {assumptions.map((a, i) => (
                  <tr key={i} className="border-t border-ink-200 align-top">
                    <td className="py-3 pr-3 text-dense font-semibold">{a.state.label}</td>
                    <td className="py-3 pl-3 text-dense">
                      {a.nodeLabel}
                      {a.inheritedFromScenarioId && <span className="helm-meta ml-2 text-sky-700">inherited</span>}
                      {!a.consumed && (
                        <span className="helm-meta ml-2" title="No calculation reads this value: stated, not propagated">
                          not modelled
                        </span>
                      )}
                    </td>
                    <td className="py-3 pl-3 text-right font-mono text-dense text-ink-600">{displayValue(a.baselineValue, a.unit, a.currency)}</td>
                    <td className="py-3 pl-3 text-right font-mono text-dense font-medium">{displayValue(a.scenarioValue, a.unit, a.currency)}</td>
                    <td className="py-3 pl-3 text-right font-mono text-dense font-semibold text-amber-700">
                      {a.operation === 'ADD' ? displayDelta(a.overrideValue, a.unit, a.currency) : 'set'}
                    </td>
                    <td className="py-3 pl-3">
                      <span className="block font-serif text-base italic text-ink-800">{a.rationale}</span>
                      <span className="helm-meta">
                        {a.provenanceKind} · confidence {displayConfidence(a.confidence)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-11">
        <SectionHead
          title="What the model computes from them"
          meta={pk}
          caveat={
            <label className="inline-flex items-center gap-2 font-sans text-meta not-italic">
              <input type="checkbox" checked={changedOnly} onChange={(e) => onChangedOnly(e.target.checked)} /> only values that moved
            </label>
          }
        />
        {rows.length === 0 ? (
          <p className="mt-3 text-base text-ink-600">No value moved in the shown futures for this period.</p>
        ) : (
          <ScenarioCompare cols={cols} rows={rows} selected="" onSelect={() => undefined} />
        )}
      </section>

      <section className="mt-11 max-w-[980px]">
        <SectionHead title="Can the futures be compared?" size="section-sm" />
        {comparison.comparability
          .filter((c) => !hidden.has(c.state.runId))
          .map((c) => (
            <p key={c.state.runId} className="border-b border-ink-200 py-2 text-dense text-ink-700">
              <span className="font-semibold text-ink-950">{c.state.label}</span> —{' '}
              {c.warnings.length === 0 ? 'same boundary, periods and model as the baseline' : c.warnings.join('; ')}
            </p>
          ))}
        {comparison.completeness.map((c) => (
          <p key={`c-${c.state.runId}`} className="border-b border-ink-200 py-2 text-dense text-ink-500">
            {c.state.label} is <span className="font-mono">{c.completeness}</span>
          </p>
        ))}
      </section>
    </>
  );
}

// ===================================================== new scenario modal

function NewScenarioModal({
  ws,
  data,
  onClose,
  onCreate,
}: {
  ws: ScenarioWorkspace;
  data: ExplorerData;
  onClose: () => void;
  onCreate: (input: Parameters<ScenarioWorkspace['runtime']['createScenario']>[1]) => Promise<void>;
}) {
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [parentId, setParentId] = useState('');
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set([periodKey(ws.periodChoices[0])]));
  const sealedParents = data.scenarios.filter((s) => s.revisions.some((r) => r.state === 'SEALED'));

  return (
    <Modal title="New scenario" onClose={onClose}>
      <form
        className="grid gap-[14px]"
        onSubmit={(e) => {
          e.preventDefault();
          void onCreate({
            key,
            name,
            description,
            parentScenarioId: parentId || null,
            fork: parentId ? undefined : ws.defaultFork,
            periods: parentId ? undefined : ws.periodChoices.filter((p) => chosen.has(periodKey(p))),
          });
        }}
      >
        <Field label="Key" hint="lowercase letters, digits and hyphens — unique in this organization">
          <input className={controlClass + ' font-mono'} value={key} onChange={(e) => setKey(e.target.value)} required pattern="[a-z0-9][a-z0-9\-]{0,62}" />
        </Field>
        <Field label="Name">
          <input className={controlClass} value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Description">
          <input className={controlClass} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Inherit from" hint="a child pins its parent's latest sealed revision, and forks where the parent forked">
          <select className={controlClass} value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">— branch from the baseline —</option>
            {sealedParents.map((s) => (
              <option key={s.scenario.id} value={s.scenario.id}>
                {s.scenario.name}
              </option>
            ))}
          </select>
        </Field>
        {!parentId && (
          <>
            <div className="grid gap-[6px]">
              <span className="text-meta font-medium text-ink-600">Periods to simulate</span>
              <div className="flex gap-4 text-dense">
                {ws.periodChoices.map((p) => (
                  <label key={periodKey(p)} className="inline-flex items-center gap-2 font-mono">
                    <input
                      type="checkbox"
                      checked={chosen.has(periodKey(p))}
                      onChange={() =>
                        setChosen((c) => {
                          const next = new Set(c);
                          if (next.has(periodKey(p))) next.delete(periodKey(p));
                          else next.add(periodKey(p));
                          return next;
                        })
                      }
                    />
                    {periodKey(p)}
                  </label>
                ))}
              </div>
            </div>
            <p className="text-meta text-ink-500">
              Forks at the baseline boundary: business time {displayInstant(ws.defaultFork.effectiveAsOf)}, known through{' '}
              {displayInstant(ws.defaultFork.recordedThrough)}. That knowledge boundary stays pinned until you rebase.
            </p>
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit">
            Create draft
          </Button>
        </div>
      </form>
    </Modal>
  );
}
