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
 * docs/architecture/scenario-engine-assessment.md).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { GitBranch, Play, Plus, RotateCcw, Archive, Lock, History, CircleAlert, X } from 'lucide-react';
import {
  COMPARISON_STATEMENT,
  overrideProvenanceKinds,
  type AssumptionDelta,
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
import { Field, Modal, PanelCard } from '../components/ui.tsx';

const interpretationTone: Record<string, string> = {
  FAVORABLE: 'text-emerald-700',
  UNFAVORABLE: 'text-red-700',
  NEUTRAL: 'text-ink-500',
  CONTEXT_DEPENDENT: 'text-sky-700',
};
const originTone: Record<string, string> = {
  COMPUTED: 'bg-violet-50 text-violet-800',
  OVERRIDDEN: 'bg-amber-50 text-amber-900',
  INHERITED: 'bg-ink-50 text-ink-600',
  BLOCKED: 'bg-red-50 text-red-700',
  UNAVAILABLE: 'bg-ink-50 text-ink-400',
};
const statusTone: Record<string, string> = {
  DRAFT: 'bg-ink-100 text-ink-700',
  READY: 'bg-sky-100 text-sky-800',
  RUNNING: 'bg-amber-100 text-amber-800',
  COMPUTED: 'bg-emerald-100 text-emerald-800',
  ARCHIVED: 'bg-ink-100 text-ink-400',
  INVALIDATED: 'bg-red-100 text-red-700',
};
const arrow = (d: ValueDelta | undefined) =>
  !d ? '' : d.direction === 'UP' ? '▲' : d.direction === 'DOWN' ? '▼' : d.direction === 'UNCHANGED' ? '=' : '?';

function Chip({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`rounded px-1.5 py-0.5 text-2xs font-medium ${tone}`}>{children}</span>;
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
  const act = useCallback(
    async (fn: () => Promise<{ ok: boolean; error?: { code: string; message: string } }>) => {
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
      else setLineage(r.value);
    },
    [ws, period],
  );

  if (error && !ws) {
    return <PanelCard title="Scenario Runtime"><p className="text-sm text-red-700">{error}</p></PanelCard>;
  }
  if (!ws || !data) {
    return <p className="p-4 text-sm text-ink-500">Branching the enterprise model…</p>;
  }

  const baselineState = data.baselineRun ? data.states[data.baselineRun.id] : null;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-ink-900">
            <GitBranch className="h-5 w-5" /> Scenario Runtime
          </h1>
          <p className="max-w-3xl text-xs text-ink-500">
            Branching future states over one pinned baseline. Every number is computed by the propagation
            engine from explicit overrides; HELM compares the futures and does not choose between them.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-secondary inline-flex items-center gap-1.5 px-2.5 py-1 text-xs"
            disabled={busy}
            onClick={() =>
              void act(() =>
                ws.runtime.executeBaseline(ws.scope, { fork: ws.defaultFork, periods: ws.periodChoices.slice(0, 1) }),
              )
            }
          >
            <Play className="h-3.5 w-3.5" /> Simulate baseline
          </button>
          <button type="button" className="btn-primary inline-flex items-center gap-1.5 px-2.5 py-1 text-xs" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" /> New scenario
          </button>
        </div>
      </header>

      <ForkStrip ws={ws} data={data} />

      {error && (
        <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {periods.length > 1 && (
        <div className="flex items-center gap-1 text-xs">
          <span className="text-ink-500">Period:</span>
          {periods.map((p) => (
            <button
              key={periodKey(p)}
              className={`rounded px-2 py-0.5 ${period && periodKey(p) === periodKey(period) ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-700'}`}
              onClick={() => setPeriodKeyShown(periodKey(p))}
            >
              {periodKey(p)}
            </button>
          ))}
          <span className="ml-2 text-2xs text-ink-400">periods are never compared across one another</span>
        </div>
      )}

      {period && (
        <BranchView
          data={data}
          baselineState={baselineState}
          period={period}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        {selected ? (
          <ScenarioPanel key={selected.scenario.id} ws={ws} snapshot={selected} busy={busy} act={act} data={data} />
        ) : (
          <PanelCard title="Scenario"><p className="text-xs text-ink-500">Create a scenario to branch the baseline.</p></PanelCard>
        )}
        <LineagePanel lineage={lineage} onClose={() => setLineage(null)} />
      </div>

      {data.overview && period && (
        <ComparisonView
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
          onExplain={explain}
        />
      )}

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
    </div>
  );
}

// ============================================================ fork strip

function ForkStrip({ ws, data }: { ws: ScenarioWorkspace; data: ExplorerData }) {
  const fork = data.baselineRun?.fork ?? ws.defaultFork;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded border border-ink-200 bg-ink-50/60 px-3 py-2 text-2xs text-ink-600">
      <span className="font-semibold uppercase tracking-wide text-ink-500">Baseline boundary</span>
      <span>business time <b className="text-ink-800">{displayInstant(fork.effectiveAsOf)}</b></span>
      <span>known through <b className="text-ink-800">{displayInstant(fork.recordedThrough)}</b></span>
      <span>policy <b className="text-ink-800">{fork.policy}</b></span>
      <span>mode <b className="text-ink-800">{ws.mode === 'demo' ? 'demo (in memory)' : 'cloud (RLS)'}</b></span>
      {data.baselineRun && (
        <span className="font-mono" title="baseline fingerprint">{data.baselineRun.fingerprint.slice(0, 24)}…</span>
      )}
    </div>
  );
}

// =========================================================== branch view

/** Baseline at the root, every future beneath it, the same five values each. */
function BranchView({
  data,
  baselineState,
  period,
  selectedId,
  onSelect,
}: {
  data: ExplorerData;
  baselineState: FutureState | null;
  period: Period;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const deltaFor = (runId: string | undefined, nodeId: string | undefined) =>
    data.overview?.metricDeltas.find(
      (d) => d.state.runId === runId && d.nodeId === nodeId && periodKey(d.period) === periodKey(period),
    );
  const tree = branchOrder(data.scenarios);

  return (
    <section className="rounded-lg border border-ink-200 bg-white p-4 shadow-panel">
      <div className="mx-auto w-full max-w-xs">
        <StateCard title="Baseline" subtitle="the enterprise as known at the boundary" state={baselineState} period={period} />
      </div>
      <div className="mx-auto h-4 w-px bg-ink-300" />
      <div className="border-t border-ink-300 pt-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {tree.map(({ snapshot, depth }) => {
            const state = snapshot.latestRun ? data.states[snapshot.latestRun.id] : null;
            return (
              <button
                key={snapshot.scenario.id}
                type="button"
                onClick={() => onSelect(snapshot.scenario.id)}
                className={`text-left ${selectedId === snapshot.scenario.id ? 'ring-2 ring-accent-500' : ''} rounded-md`}
              >
                <StateCard
                  title={`${depth > 0 ? '↳ ' : ''}${snapshot.scenario.name}`}
                  subtitle={`${snapshot.scenario.status.toLowerCase()} · r${snapshot.latestRevision?.revisionNumber ?? '?'}${
                    snapshot.scenario.parentScenarioId ? ' · inherits' : ''
                  }`}
                  state={state}
                  period={period}
                  deltaFor={(nodeId) => deltaFor(snapshot.latestRun?.id, nodeId)}
                />
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function StateCard({
  title,
  subtitle,
  state,
  period,
  deltaFor,
}: {
  title: string;
  subtitle: string;
  state: FutureState | null;
  period: Period;
  deltaFor?: (nodeId: string | undefined) => ValueDelta | undefined;
}) {
  const breached = state?.constraints.filter((c) => periodKey(c.period) === periodKey(period) && c.status === 'BREACHED') ?? [];
  return (
    <div className="rounded-md border border-ink-200 bg-white p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink-900">{title}</p>
          <p className="text-2xs text-ink-500">{subtitle}</p>
        </div>
        {state && (
          <Chip tone={state.completeness === 'COMPLETE' ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}>
            {state.completeness}
          </Chip>
        )}
      </div>
      {!state ? (
        <p className="mt-2 text-2xs text-ink-400">not simulated yet</p>
      ) : (
        <dl className="mt-2 space-y-0.5">
          {BRANCH_METRICS.map((m) => {
            const v = pickValue(state, m.metricKey, period, m.subjectHint);
            const d = deltaFor?.(v?.nodeId);
            return (
              <div key={m.label} className="flex items-baseline justify-between gap-2 text-xs">
                <dt className="text-ink-500">{m.label}</dt>
                <dd className="text-right font-mono" title={v?.value ?? v?.reason ?? ''}>
                  {v?.value === null || !v ? <span className="text-ink-400">{v?.origin ?? '—'}</span> : displayValue(v.value, v.unit, v.currency)}
                  {d && d.direction !== 'UNCHANGED' && (
                    <span
                      className={`ml-1 ${
                        d.direction === 'UNRESOLVED'
                          ? 'text-ink-400'
                          : (interpretationTone[d.directionalInterpretation ?? 'NEUTRAL'] ?? 'text-ink-400')
                      }`}
                      title={d.unresolvedReason ?? d.directionalInterpretation ?? ''}>
                      {d.direction === 'UNRESOLVED'
                        ? 'unresolved'
                        : `${arrow(d)} ${displayDelta(d.absoluteDelta, d.unit, d.currency)}`}
                    </span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      {breached.length > 0 && (
        <p className="mt-2 text-2xs text-red-700">
          {breached.map((c) => `${c.name}: breached by ${c.breachAmount} ${c.unit ?? ''}`).join(' · ')}
        </p>
      )}
    </div>
  );
}

// ======================================================== scenario panel

function ScenarioPanel({
  ws,
  snapshot,
  busy,
  act,
  data,
}: {
  ws: ScenarioWorkspace;
  snapshot: ScenarioSnapshot;
  busy: boolean;
  act: (fn: () => Promise<{ ok: boolean; error?: { code: string; message: string } }>) => Promise<void>;
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

  return (
    <PanelCard
      title={
        <span className="flex items-center gap-2">
          {scenario.name} <Chip tone={statusTone[scenario.status]}>{scenario.status}</Chip>
        </span>
      }
    >
      <div className="space-y-3 text-xs">
        <p className="text-ink-600">{scenario.description || '—'}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-ink-500">
          <span>key <b className="font-mono text-ink-700">{scenario.key}</b></span>
          {parent && <span>inherits from <b className="text-ink-700">{parent.name}</b> (pinned revision)</span>}
          {latestRevision && (
            <>
              <span>fork: known through <b className="text-ink-700">{displayInstant(latestRevision.fork.recordedThrough)}</b></span>
              <span>periods <b className="text-ink-700">{latestRevision.periods.map(periodKey).join(', ')}</b></span>
            </>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {draft && (
            <button className="btn-secondary inline-flex items-center gap-1 px-2 py-1 text-xs" disabled={busy || terminal}
              onClick={() => void act(() => ws.runtime.markReady(ws.scope, latestRevision.id))}>
              <Lock className="h-3.5 w-3.5" /> Seal revision
            </button>
          )}
          <button className="btn-primary inline-flex items-center gap-1 px-2 py-1 text-xs" disabled={busy || terminal}
            onClick={() => void act(() => ws.runtime.execute(ws.scope, scenario.id))}>
            <Play className="h-3.5 w-3.5" /> Simulate
          </button>
          {!draft && (
            <button className="btn-secondary inline-flex items-center gap-1 px-2 py-1 text-xs" disabled={busy || terminal}
              onClick={() => void act(() => ws.runtime.createRevision(ws.scope, scenario.id))}>
              <Plus className="h-3.5 w-3.5" /> New revision
            </button>
          )}
          {!draft && (
            <button className="btn-secondary inline-flex items-center gap-1 px-2 py-1 text-xs" disabled={busy || terminal}
              title="Same assumptions, today's knowledge: a new REBASED revision"
              onClick={() => void act(() => ws.runtime.rebase(ws.scope, scenario.id))}>
              <History className="h-3.5 w-3.5" /> Rebase to now
            </button>
          )}
          {latestRun && (
            <button className="btn-secondary inline-flex items-center gap-1 px-2 py-1 text-xs" disabled={busy}
              title="Same revision, same boundary: must reproduce the future state"
              onClick={() => void act(() => ws.runtime.replay(ws.scope, latestRun.id))}>
              <RotateCcw className="h-3.5 w-3.5" /> Replay
            </button>
          )}
          {!terminal && (
            <button className="btn-ghost inline-flex items-center gap-1 px-2 py-1 text-xs" disabled={busy}
              onClick={() => void act(() => ws.runtime.archive(ws.scope, scenario.id))}>
              <Archive className="h-3.5 w-3.5" /> Archive
            </button>
          )}
        </div>

        <section>
          <h3 className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-500">Assumptions (what changed)</h3>
          {effective.length === 0 ? (
            <p className="text-ink-400">No overrides: this revision simulates the baseline itself.</p>
          ) : (
            <table className="w-full text-left">
              <thead className="text-2xs text-ink-400">
                <tr><th className="py-1">Target</th><th>Change</th><th>Period</th><th>Source</th><th>Conf.</th><th /></tr>
              </thead>
              <tbody>
                {effective.map(({ e }) => {
                  const o = e.override;
                  return (
                    <tr key={o.id} className="border-t border-ink-100 align-top">
                      <td className="py-1 pr-2">
                        <span className="text-ink-800">{data.nodeLabels[o.targetNodeId] ?? o.metricKey}</span>
                        {e.inheritedFromScenarioId && <span className="ml-1 text-2xs text-sky-700">inherited</span>}
                        {e.shadowed.length > 0 && (
                          <span className="ml-1 text-2xs text-amber-700" title={e.shadowed.map((x) => `${x.operation} ${x.value}`).join('; ')}>
                            shadows {e.shadowed.length}
                          </span>
                        )}
                        <p className="text-2xs text-ink-500">{o.rationale}</p>
                      </td>
                      <td className="pr-2 font-mono">{o.operation === 'ADD' ? '+' : '='}{displayValue(o.value, o.unit, o.currency)}</td>
                      <td className="pr-2">{o.period ? periodKey(o.period) : 'all'}</td>
                      <td className="pr-2 text-2xs">{o.provenanceKind.replaceAll('_', ' ').toLowerCase()}<br /><span className="text-ink-400">{o.overrideType === 'ASSUMPTION_OVERRIDE' ? 'assumption' : 'value'}</span></td>
                      <td className="pr-2">{displayConfidence(o.confidence)}</td>
                      <td>
                        {draft && !e.inheritedFromScenarioId && (
                          <button className="text-2xs text-red-700 hover:underline" disabled={busy}
                            onClick={() => void act(() => ws.runtime.removeOverride(ws.scope, o.id))}>remove</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {draft && !terminal && (
            adding ? (
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
              <button className="mt-2 inline-flex items-center gap-1 text-xs text-accent-700 hover:underline" onClick={() => setAdding(true)}>
                <Plus className="h-3.5 w-3.5" /> Add an override
              </button>
            )
          )}
        </section>

        {report && report.issues.some((i) => i.severity !== 'INFO') && (
          <section>
            <h3 className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-500">Validation</h3>
            <ul className="space-y-1">
              {report.issues.filter((i) => i.severity !== 'INFO').map((i, n) => (
                <li key={n} className={i.severity === 'ERROR' ? 'text-red-700' : 'text-amber-800'}>
                  <b>{i.severity}</b> {i.message}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h3 className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-500">Revisions</h3>
          <ul className="space-y-0.5 text-2xs text-ink-600">
            {revisions.map((r) => (
              <li key={r.id} className="flex flex-wrap gap-x-3">
                <b>r{r.revisionNumber}</b>
                <span>{r.state.toLowerCase()}</span>
                <span>{r.reason.toLowerCase()}</span>
                <span>known through {displayInstant(r.fork.recordedThrough)}</span>
                {r.fingerprint && <span className="font-mono text-ink-400">{r.fingerprint.slice(0, 22)}…</span>}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </PanelCard>
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
      className="mt-2 grid gap-2 rounded border border-ink-200 bg-ink-50/50 p-2 sm:grid-cols-2"
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
        <select className="field-input" value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
          {nodes.map((n) => <option key={n.id} value={n.id}>{n.label} · {n.unitType}</option>)}
        </select>
      </Field>
      <Field label="Change">
        <div className="flex gap-1">
          <select className="field-input w-24" value={operation} onChange={(e) => setOperation(e.target.value as 'SET' | 'ADD')}>
            <option value="SET">set to</option>
            <option value="ADD">adjust by</option>
          </select>
          <input className="field-input" value={value} onChange={(e) => setValue(e.target.value)} placeholder={node?.unitType ?? ''} required />
        </div>
      </Field>
      <Field label="Period">
        <select className="field-input" value={periodChoice} onChange={(e) => setPeriodChoice(e.target.value)}>
          <option value="all">every period</option>
          {periods.map((p) => <option key={periodKey(p)} value={periodKey(p)}>{periodKey(p)}</option>)}
        </select>
      </Field>
      <Field label="Kind">
        <select className="field-input" value={overrideType} onChange={(e) => setOverrideType(e.target.value as OverrideType)}>
          <option value="VALUE_OVERRIDE">value override</option>
          <option value="ASSUMPTION_OVERRIDE">assumption override</option>
        </select>
      </Field>
      <Field label="Provenance">
        <select className="field-input" value={provenanceKind} onChange={(e) => setProvenanceKind(e.target.value as OverrideProvenanceKind)}>
          {overrideProvenanceKinds.map((k) => <option key={k} value={k}>{k.replaceAll('_', ' ').toLowerCase()}</option>)}
        </select>
      </Field>
      <Field label="Confidence (0–1)">
        <input className="field-input" value={confidence} onChange={(e) => setConfidence(e.target.value)} />
      </Field>
      <Field label="Rationale" className="sm:col-span-2">
        <input className="field-input" value={rationale} onChange={(e) => setRationale(e.target.value)} required minLength={8} />
      </Field>
      <div className="flex justify-end gap-2 sm:col-span-2">
        <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={onCancel}>Cancel</button>
        <button className="btn-primary px-2 py-1 text-xs">Add override</button>
      </div>
    </form>
  );
}

// ======================================================= comparison view

function ComparisonView({
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
  const rows = comparison.rows.filter((r) => periodKey(r.period) === pk);
  const delta = (runId: string, nodeId: string) =>
    comparison.metricDeltas.find((d) => d.state.runId === runId && d.nodeId === nodeId && periodKey(d.period) === pk);
  const moved = (nodeId: string) =>
    shown.some((a) => {
      const d = delta(a.runId, nodeId);
      return d && d.direction !== 'UNCHANGED';
    });
  const assumptions: AssumptionDelta[] = comparison.assumptionDeltas.filter(
    (a) => !hidden.has(a.state.runId) && (a.period === null || periodKey(a.period) === pk),
  );

  return (
    <PanelCard title={`Comparison · ${pk}`}>
      <p className="mb-3 rounded border border-ink-200 bg-ink-50 px-3 py-2 text-2xs text-ink-600">{COMPARISON_STATEMENT}</p>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-ink-500">States:</span>
        {comparison.alternatives.map((a) => (
          <label key={a.runId} className="inline-flex items-center gap-1">
            <input type="checkbox" checked={!hidden.has(a.runId)} onChange={() => onToggle(a.runId)} /> {a.label}
          </label>
        ))}
        <label className="ml-auto inline-flex items-center gap-1 text-2xs text-ink-500">
          <input type="checkbox" checked={changedOnly} onChange={(e) => onChangedOnly(e.target.checked)} /> only values that moved
        </label>
      </div>

      <h3 className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-500">Assumption delta — what each future changes</h3>
      <div className="mb-4 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-2xs text-ink-400">
            <tr><th className="py-1">Future</th><th>Assumption</th><th>Baseline</th><th>Future</th><th>Change</th><th>Why</th></tr>
          </thead>
          <tbody>
            {assumptions.map((a, i) => (
              <tr key={i} className="border-t border-ink-100 align-top">
                <td className="py-1 pr-2">{a.state.label}</td>
                <td className="pr-2">
                  {a.nodeLabel}
                  {a.inheritedFromScenarioId && <span className="ml-1 text-2xs text-sky-700">inherited</span>}
                  {!a.consumed && <span className="ml-1 text-2xs text-ink-400" title="No calculation reads this value: stated, not propagated">not modelled</span>}
                </td>
                <td className="pr-2 font-mono">{displayValue(a.baselineValue, a.unit, a.currency)}</td>
                <td className="pr-2 font-mono">{displayValue(a.scenarioValue, a.unit, a.currency)}</td>
                <td className="pr-2 font-mono">{a.operation === 'ADD' ? displayDelta(a.overrideValue, a.unit, a.currency) : 'set'}</td>
                <td className="text-2xs text-ink-500">{a.rationale} <span className="text-ink-400">({a.provenanceKind.replaceAll('_', ' ').toLowerCase()}, conf {displayConfidence(a.confidence)})</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-500">Outcome delta — what the model computes from them</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-2xs text-ink-400">
            <tr>
              <th className="py-1">Value</th>
              <th>Baseline</th>
              {shown.map((a) => <th key={a.runId}>{a.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows
              .filter((r) => !changedOnly || moved(r.nodeId))
              .map((r) => {
                const base = r.cells[0];
                return (
                  <tr key={r.nodeId} className="border-t border-ink-100 align-top">
                    <td className="py-1 pr-2">
                      <span className="text-ink-800">{r.nodeLabel}</span>
                      <span className="ml-1 text-2xs text-ink-400">{r.dimension.toLowerCase()}</span>
                    </td>
                    <td className="pr-2">
                      <Cell value={base.value} origin={base.origin} confidence={base.confidence} reason={base.reason}
                        unit={comparison.metricDeltas.find((d) => d.nodeId === r.nodeId)?.unit ?? null}
                        currency={comparison.metricDeltas.find((d) => d.nodeId === r.nodeId)?.currency ?? null}
                        onClick={() => onExplain(comparison.baseline.runId, r.nodeId)} />
                    </td>
                    {shown.map((a) => {
                      const cell = r.cells.find((c) => c.state.runId === a.runId);
                      const d = delta(a.runId, r.nodeId);
                      return (
                        <td key={a.runId} className="pr-2">
                          <Cell value={cell?.value ?? null} origin={cell?.origin ?? null} confidence={cell?.confidence ?? null}
                            reason={cell?.reason ?? null} unit={d?.unit ?? null} currency={d?.currency ?? null}
                            onClick={() => onExplain(a.runId, r.nodeId)} />
                          {d && d.direction !== 'UNCHANGED' && (
                            <div className={`font-mono text-2xs ${interpretationTone[d.directionalInterpretation ?? ''] ?? 'text-ink-400'}`}
                              title={d.unresolvedReason ?? d.directionalInterpretation ?? ''}>
                              {d.direction === 'UNRESOLVED' ? 'unresolved' : `${arrow(d)} ${displayDelta(d.absoluteDelta, d.unit, d.currency)}`}
                              {d.directionalInterpretation === 'CONTEXT_DEPENDENT' && ' · context'}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <section>
          <h3 className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-500">Feasibility</h3>
          <ul className="space-y-1 text-2xs">
            {comparison.constraints
              .filter((c) => c.state.runId === comparison.baseline.runId || !hidden.has(c.state.runId))
              .flatMap((c) =>
                c.results.filter((x) => periodKey(x.period) === pk).map((x) => (
                  <li key={`${c.state.runId}-${x.constraintKey}`} className={x.status === 'BREACHED' ? 'text-red-700' : x.status === 'UNKNOWN' ? 'text-ink-500' : 'text-emerald-700'}>
                    <b>{c.state.label}</b> · {x.name}: {x.status}{x.breachAmount ? ` by ${x.breachAmount} ${x.unit ?? ''}` : ''} — {x.explanation}
                  </li>
                )),
              )}
          </ul>
        </section>
        <section>
          <h3 className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-500">Comparability</h3>
          <ul className="space-y-1 text-2xs text-ink-600">
            {comparison.comparability.filter((c) => !hidden.has(c.state.runId)).map((c) => (
              <li key={c.state.runId}>
                <b>{c.state.label}</b>: {c.warnings.length === 0 ? 'same boundary, periods and model as the baseline' : c.warnings.join('; ')}
              </li>
            ))}
            {comparison.completeness.map((c) => (
              <li key={`c-${c.state.runId}`} className="text-ink-500">{c.state.label} is {c.completeness}</li>
            ))}
          </ul>
        </section>
      </div>
    </PanelCard>
  );
}

function Cell({
  value, origin, confidence, reason, unit, currency, onClick,
}: {
  value: string | null; origin: string | null; confidence: number | null; reason: string | null;
  unit: ValueDelta['unit']; currency: string | null; onClick: () => void;
}) {
  return (
    <button type="button" className="text-left hover:underline" onClick={onClick} title={value ?? reason ?? ''}>
      <span className="font-mono">{value === null ? '—' : displayValue(value, unit, currency)}</span>
      {origin && <Chip tone={`ml-1 ${originTone[origin] ?? ''}`}>{origin.toLowerCase()}</Chip>}
      {confidence !== null && <span className="ml-1 text-2xs text-ink-400">c {displayConfidence(confidence)}</span>}
    </button>
  );
}

// ========================================================= lineage panel

function LineagePanel({ lineage, onClose }: { lineage: ScenarioExplanation | null; onClose: () => void }) {
  return (
    <PanelCard
      title="Lineage"
      action={lineage && <button className="text-2xs text-ink-500 hover:underline" onClick={onClose}>clear</button>}
    >
      {!lineage ? (
        <p className="text-xs text-ink-500">
          Click any value in the comparison: future-state value → calculation run → scenario revision →
          overrides → baseline inputs → source provenance.
        </p>
      ) : (
        <div className="space-y-2 text-xs">
          <div className="text-2xs text-ink-500">
            <b className="text-ink-800">{lineage.state.label}</b> · {periodKey(lineage.period)} · run{' '}
            <span className="font-mono">{lineage.calculationRunId?.slice(0, 8) ?? '—'}</span> · revision{' '}
            <span className="font-mono">{lineage.state.revisionId?.slice(0, 8) ?? 'baseline'}</span> · known through{' '}
            {displayInstant(lineage.fork.recordedThrough)}
          </div>
          <p>
            <b>{lineage.value.nodeLabel}</b> = <span className="font-mono">{lineage.value.value ?? '—'}</span>{' '}
            <Chip tone={originTone[lineage.value.origin]}>{lineage.value.origin.toLowerCase()}</Chip>
            {lineage.value.reason && <span className="ml-1 text-2xs text-ink-500">{lineage.value.reason}</span>}
          </p>
          {lineage.lineage ? <LineageNode node={lineage.lineage} /> : <p className="text-ink-500">No derivation: this value was not computed.</p>}
        </div>
      )}
    </PanelCard>
  );
}

function LineageNode({ node, depth = 0 }: { node: Explanation; depth?: number }) {
  return (
    <div className={depth === 0 ? '' : 'border-l border-ink-200 pl-3'}>
      <div className="py-0.5">
        <span className="font-medium text-ink-900">{node.metricKey}</span>{' '}
        <span className="font-mono text-ink-700">{node.value}</span>{' '}
        <Chip tone={node.override ? 'bg-amber-50 text-amber-900' : node.derivation ? 'bg-violet-50 text-violet-800' : 'bg-emerald-50 text-emerald-800'}>
          {node.override ? `override ${node.override.operation}` : node.observationType}
        </Chip>
        {node.derivation && (
          <p className="font-mono text-2xs text-ink-500">
            {node.derivation.calculationKey}@{node.derivation.calculationVersion} · {node.derivation.renderedExpression}
          </p>
        )}
        {node.override && (
          <p className="text-2xs text-amber-800">
            scenario override {node.override.operation} {node.override.value} ({node.override.provenanceKind.toLowerCase()})
            {node.override.inheritedFromScenarioId ? ' · inherited' : ''}
            {node.override.shadowedOverrideIds.length > 0 ? ` · shadows ${node.override.shadowedOverrideIds.length}` : ''}
          </p>
        )}
        {!node.derivation && !node.override && node.source && (
          <p className="text-2xs text-ink-500">stated by {node.source.system}{node.source.method ? ` · ${node.source.method}` : ''}</p>
        )}
      </div>
      {node.inputs.map((c, i) => <LineageNode key={`${c.observationId}-${i}`} node={c} depth={depth + 1} />)}
    </div>
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
        className="space-y-3"
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
          <input className="field-input" value={key} onChange={(e) => setKey(e.target.value)} required pattern="[a-z0-9][a-z0-9\-]{0,62}" />
        </Field>
        <Field label="Name">
          <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Description">
          <input className="field-input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Inherit from" hint="a child pins its parent's latest sealed revision, and forks where the parent forked">
          <select className="field-input" value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">— branch from the baseline —</option>
            {sealedParents.map((s) => <option key={s.scenario.id} value={s.scenario.id}>{s.scenario.name}</option>)}
          </select>
        </Field>
        {!parentId && (
          <>
            <Field label="Periods to simulate">
              <div className="flex gap-3 text-xs">
                {ws.periodChoices.map((p) => (
                  <label key={periodKey(p)} className="inline-flex items-center gap-1">
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
            </Field>
            <p className="text-2xs text-ink-500">
              Forks at the baseline boundary: business time {displayInstant(ws.defaultFork.effectiveAsOf)}, known through{' '}
              {displayInstant(ws.defaultFork.recordedThrough)}. That knowledge boundary stays pinned until you rebase.
            </p>
          </>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary">Create draft</button>
        </div>
      </form>
    </Modal>
  );
}
