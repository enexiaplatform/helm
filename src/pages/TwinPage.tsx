/**
 * Twin — a technical instrument over the Phase 7 twin runtime, not a cockpit.
 *
 * It reads the enterprise as a versioned management state: which snapshot,
 * under which two-time lens, for which scope, read by whom. Then STATE (the
 * management state by category), CHANGE (snapshot A → B, by category),
 * TRAJECTORY (now against the committed future) and DEPENDENCY (why an item is
 * there, and why a value moved). Everything is read from the runtime; nothing
 * here ranks, scores, recommends or approves.
 *
 * Phase 8: a difference also shows the CAUSAL HYPOTHESES people have recorded
 * about the inputs that moved — beside the model explanation, never merged
 * with it. The model says which input moved; only a claim and its evidence say
 * why it moved in the world.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  managementCategories,
  type AttributionNode,
  type ItemChange,
  type ManagementCategory,
  type TwinItem,
  type TwinSnapshot,
} from '@helm/twin-runtime';
import { useHelmStore } from '../services/helmStore.ts';
import { useMemoireLive } from '../services/memoireLiveSync.ts';
import { cloudScope, demoScope } from '../services/ontologyGraph.ts';
import {
  compareView,
  differenceView,
  explainView,
  lensText,
  listSnapshots,
  loadSnapshotView,
  resolveTwinContext,
  trajectoryView,
  type SnapshotView,
  type TwinContext,
} from '../services/twinRuntime.ts';
import { displayValue } from '../services/decisionRuntime.ts';
import type { TwinCausalExplanation } from '@helm/causal-runtime';
import { causalDifferenceView, resolveCausalContext, statusTone } from '../services/causalRuntime.ts';
import { PageHeader } from '../components/ui/PageHeader.tsx';
import { SectionHead } from '../components/ui/SectionHead.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { Notice } from '../components/ui/Notice.tsx';
import { IntelligencePanel } from '../components/intelligence/IntelligencePanel.tsx';
import { FactRow } from '../components/ui/FactRow.tsx';
import { Pill, type PillTone } from '../components/ui/Pill.tsx';
import { cn } from '../lib/cn.ts';

const CATEGORY_LABEL: Record<ManagementCategory, string> = {
  STRUCTURE: 'Structure',
  VALUE: 'Value',
  PERFORMANCE: 'Performance',
  CONSTRAINTS: 'Constraints',
  RISKS: 'Risks',
  OBJECTIVES: 'Objectives',
  DECISIONS: 'Decisions',
  COMMITMENTS: 'Commitments',
  GOVERNANCE: 'Governance',
  ASSUMPTIONS: 'Assumptions',
  ATTENTION: 'Attention',
};

const LAYER_TONE: Record<string, PillTone> = {
  ACTUAL: 'actual',
  FORECAST: 'forecast',
  ESTIMATE: 'estimate',
  ASSUMED: 'assumption',
  TARGET: 'target',
  MODELLED: 'derived',
  SCENARIO: 'scenario',
  COMMITTED_FUTURE: 'committed',
};

const COMPLETENESS_TONE: Record<string, PillTone> = { COMPLETE: 'actual', PARTIAL: 'accepted', DEGRADED: 'accepted', INVALID: 'blocked' };

type DeltaGroup = { key: string; title: string; changes: readonly ItemChange[] };

/** Reading only: the true minus (−) for a negative figure. */
const show = (value: string | null, unit: string | null, currency: string | null): string => displayValue(value, unit, currency).replace(/^-/, '−');

const s = (i: TwinItem, k: string): string | null => {
  const v = i.state[k];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
};

/** One line of reading for an item: the value for a value, the state for everything else. */
function reading(i: TwinItem): string {
  switch (i.kind) {
    case 'VALUE':
      return i.status === 'KNOWN' ? show(s(i, 'value'), s(i, 'unit'), s(i, 'currency')) : i.status;
    case 'OBJECTIVE':
      return `target ${show(s(i, 'target'), s(i, 'unit'), s(i, 'currency'))} · current ${show(s(i, 'current'), s(i, 'unit'), s(i, 'currency'))}`;
    case 'CONSTRAINT':
      return `${s(i, 'status')} · ${s(i, 'actual') ?? '—'} of ${s(i, 'threshold') ?? '—'}`;
    case 'DECISION':
    case 'GOVERNANCE':
      return String(s(i, 'state') ?? '').replaceAll('_', ' ');
    case 'ACTION_INTENT':
      return String(s(i, 'status') ?? '');
    case 'ASSUMPTION':
      return s(i, 'source') === 'SCENARIO_OVERRIDE' ? `${s(i, 'operation')} ${s(i, 'value')}` : `${s(i, 'criticality') ?? ''} · ${s(i, 'outcome') ?? ''}`;
    case 'POLICY':
      return `${s(i, 'reference')} v${s(i, 'version')}`;
    case 'ROLE_OCCUPANCY':
      return String(s(i, 'kind') ?? '');
    case 'ATTENTION':
      return String(s(i, 'condition') ?? '').replaceAll('_', ' ').toLowerCase();
    case 'ENTITY':
      return [s(i, 'entityTypeKey'), s(i, 'membership'), s(i, 'classification')].filter(Boolean).join(' · ');
    default:
      return i.kind.replaceAll('_', ' ').toLowerCase();
  }
}

type LineageLine = { depth: number; label: string; detail: string; ref: string | null };

/** The attribution tree, flattened for reading: each moved input, then what moved it. */
function attributionLines(n: AttributionNode, depth: number): LineageLine[] {
  return [
    {
      depth,
      label: `${n.input} (${n.metricKey}): ${n.before ?? '—'} → ${n.after ?? '—'}`,
      detail: `${n.beforeSource} → ${n.afterSource}`,
      ref: n.afterRef ? `${n.afterRef.kind} ${n.afterRef.id.slice(0, 12)}` : null,
    },
    ...n.changedBecause.flatMap((c) => attributionLines(c, depth + 1)),
  ];
}

function Row({ children, onClick, selected }: { children: ReactNode; onClick?: () => void; selected?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'grid w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 border-b border-ink-200 py-[10px] text-left transition-colors duration-160 ease-helm hover:bg-ink-50',
        selected && 'bg-accent-50',
      )}
    >
      {children}
    </button>
  );
}

export function TwinPage() {
  const mode = useHelmStore((st) => st.mode);
  const activeOrgId = useHelmStore((st) => st.activeOrgId);
  const userId = useHelmStore((st) => st.userId);
  const myRole = useHelmStore((st) => st.myRole);
  const memoireVersion = useMemoireLive((st) => st.version);
  const scope = useMemo(
    () => (mode === 'demo' ? demoScope() : activeOrgId ? cloudScope(activeOrgId, userId ?? '', myRole()) : null),
    [mode, activeOrgId, userId, myRole],
  );

  const [ctx, setCtx] = useState<TwinContext | null>(null);
  const [snapshots, setSnapshots] = useState<readonly TwinSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scopeKey, setScopeKey] = useState<string>('');
  const [viewerKey, setViewerKey] = useState<string>('');
  const [aId, setAId] = useState<string>('');
  const [bId, setBId] = useState<string>('');
  const [category, setCategory] = useState<ManagementCategory>('ATTENTION');
  const [view, setView] = useState<SnapshotView | null>(null);
  // Async results are keyed by the inputs they were read for; what is shown is derived from that key.
  const [deltaState, setDeltaState] = useState<{ key: string; value: Awaited<ReturnType<typeof compareView>> } | null>(null);
  const [trajectoryState, setTrajectoryState] = useState<{ key: string; value: Awaited<ReturnType<typeof trajectoryView>> | null } | null>(null);
  const [lineage, setLineage] = useState<{ title: string; statement: string; lines: readonly LineageLine[]; disclaimer?: string; causal?: TwinCausalExplanation | null } | null>(null);

  useEffect(() => {
    let live = true;
    if (!scope) return;
    void (async () => {
      try {
        const c = await resolveTwinContext(mode ?? 'demo', scope);
        if (!c) throw new Error('The twin runtime is unavailable in this mode.');
        const list = await listSnapshots(c);
        if (!live) return;
        setCtx(c);
        setSnapshots(list);
        setViewerKey(c.viewers.find((v) => v.key === 'countryGM')?.key ?? c.viewers[0]?.key ?? '');
        const vn = c.scopes[0];
        setScopeKey(vn ? (vn.kind === 'ENTERPRISE' ? 'ENTERPRISE' : vn.entityId) : '');
        if (c.story) {
          setAId(c.story.S1.snapshot.id);
          setBId(c.story.S2.snapshot.id);
        } else if (list.length > 0) {
          setAId(list[0].id);
          setBId(list[list.length - 1].id);
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [mode, scope]);

  // A state composed from Memoire while this page is open joins the list; what the reader selected stays selected (ADR-0034).
  useEffect(() => {
    let live = true;
    if (!ctx || ctx.mode !== 'cloud' || memoireVersion === 0) return;
    void (async () => {
      try {
        const list = await listSnapshots(ctx);
        if (!live) return;
        setSnapshots(list);
        if (list.length > 0) {
          setAId((a) => a || list[0].id);
          setBId((b) => b || list[list.length - 1].id);
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [ctx, memoireVersion]);

  const viewer = ctx?.viewers.find((v) => v.key === viewerKey)?.viewer ?? null;
  const inScope = useMemo(
    () => snapshots.filter((x) => (x.spec.scope.kind === 'ENTERPRISE' ? 'ENTERPRISE' : x.spec.scope.entityId) === scopeKey),
    [snapshots, scopeKey],
  );

  useEffect(() => {
    let live = true;
    if (!ctx || !viewer || !aId) return;
    void loadSnapshotView(ctx, aId, viewer).then((v) => live && setView(v)).catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [ctx, viewer, aId]);

  useEffect(() => {
    let live = true;
    if (!ctx || !aId || !bId || aId === bId) return;
    void compareView(ctx, aId, bId).then((d) => live && setDeltaState({ key: `${aId}|${bId}`, value: d })).catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [ctx, aId, bId]);

  useEffect(() => {
    let live = true;
    const cf = ctx?.story?.CF1 ?? null;
    const current = snapshots.find((x) => x.id === bId);
    if (!ctx || !cf || !current || current.spec.kind === 'COMMITTED_FUTURE' || current.spec.kind === 'SCENARIO') return;
    void trajectoryView(ctx, current.id, cf.snapshot.id)
      .then((t) => live && setTrajectoryState({ key: bId, value: t }))
      .catch(() => live && setTrajectoryState({ key: bId, value: null }));
    return () => {
      live = false;
    };
  }, [ctx, snapshots, bId]);

  if (error) return <EmptyState title="The twin could not be opened" detail={error} />;
  if (!ctx || !viewer) return <p className="text-ui text-ink-500">Composing the management state…</p>;

  const delta = deltaState && deltaState.key === `${aId}|${bId}` ? deltaState.value : null;
  const trajectory = trajectoryState && trajectoryState.key === bId ? trajectoryState.value : null;
  const a = snapshots.find((x) => x.id === aId) ?? null;
  const b = snapshots.find((x) => x.id === bId) ?? null;
  const scopeLabel = ctx.scopes.find((x) => (x.kind === 'ENTERPRISE' ? 'ENTERPRISE' : x.entityId) === scopeKey)?.label ?? 'Enterprise';
  const shown = view?.projection?.items ?? [];
  const byCategory = (c: ManagementCategory) => shown.filter((i) => i.categories.includes(c));
  const items = byCategory(category);

  const openItem = (snapshotId: string, item: TwinItem) =>
    void explainView(ctx, snapshotId, item.key)
      .then((ex) =>
        setLineage({
          title: item.label,
          statement: ex.statement,
          lines: ex.chain.map((l) => ({ depth: l.depth, label: l.label, detail: l.detail, ref: l.ref ? `${l.ref.kind} ${l.ref.id.slice(0, 12)}` : null })),
        }),
      )
      .catch((e) => setLineage({ title: item.label, statement: String(e), lines: [] }));

  const openDifference = (fromKey: string, toKey: string, label: string) =>
    void differenceView(ctx, aId, bId, fromKey, toKey)
      .then(async (d) => {
        // The causal investigation is read separately and may be unavailable; the model explanation stands alone.
        let causal: TwinCausalExplanation | null = null;
        try {
          const cctx = scope ? await resolveCausalContext(mode ?? 'demo', scope) : null;
          causal = cctx ? await causalDifferenceView(cctx, aId, bId, fromKey, toKey) : null;
        } catch {
          causal = null;
        }
        setLineage({
          title: `Why did ${label} change?`,
          statement: d.statement,
          disclaimer: d.disclaimer,
          lines: d.attribution.flatMap((node) => attributionLines(node, 0)),
          causal,
        });
      })
      .catch((e) => setLineage({ title: label, statement: String(e), lines: [] }));

  const groups: DeltaGroup[] = delta
    ? [
        { key: 'structural', title: 'Structure', changes: delta.structuralChanges },
        { key: 'value', title: 'Value', changes: delta.valueChanges },
        { key: 'knowledge', title: 'Knowledge', changes: delta.knowledgeChanges },
        { key: 'decision', title: 'Decision', changes: delta.decisionChanges },
        { key: 'assumption', title: 'Assumption', changes: delta.assumptionChanges },
        { key: 'governance', title: 'Governance', changes: delta.governanceChanges },
        { key: 'constraint', title: 'Constraint', changes: delta.constraintChanges },
        { key: 'attention', title: 'Attention', changes: delta.attentionChanges },
      ]
    : [];

  const select = 'max-w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-ui';

  return (
    <>
      <PageHeader
        kicker="Kernel instrument · Digital twin"
        size="instrument"
        title={`Management digital twin — ${scopeLabel}`}
        lede="The enterprise as a versioned management state: what existed and how it was connected, what value state existed, what management knew, which future it committed to, what authority governed it and what changed afterwards. Every item points into the kernel; nothing here is ranked, weighted or totalled."
      />

      {ctx.story && (
        <Notice tone="neutral" label="Demo twin data" className="mt-6">
          The Rohto story is lived through the kernels on a demo clock. The reclassification, the change of Commercial Director, the
          capacity restatement and the Q4 actuals are illustrative, and they enter HELM exactly as a real fact would.
        </Notice>
      )}

      <div className="mt-6 flex flex-wrap gap-4">
        <label className="grid max-w-full grid-cols-[minmax(0,1fr)] gap-1">
          <span className="helm-label">Scope</span>
          <select className={select} value={scopeKey} onChange={(e) => setScopeKey(e.target.value)}>
            {ctx.scopes.map((x) => {
              const k = x.kind === 'ENTERPRISE' ? 'ENTERPRISE' : x.entityId;
              return <option key={k} value={k}>{x.label}</option>;
            })}
          </select>
        </label>
        <label className="grid max-w-full grid-cols-[minmax(0,1fr)] gap-1">
          <span className="helm-label">Read as</span>
          <select className={select} value={viewerKey} onChange={(e) => setViewerKey(e.target.value)}>
            {ctx.viewers.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
          </select>
        </label>
        <label className="grid max-w-full grid-cols-[minmax(0,1fr)] gap-1">
          <span className="helm-label">State</span>
          <select className={select} value={aId} onChange={(e) => setAId(e.target.value)}>
            {snapshots.map((x) => <option key={x.id} value={x.id}>{x.spec.label}</option>)}
          </select>
        </label>
        <label className="grid max-w-full grid-cols-[minmax(0,1fr)] gap-1">
          <span className="helm-label">Compared with</span>
          <select className={select} value={bId} onChange={(e) => setBId(e.target.value)}>
            {snapshots.map((x) => <option key={x.id} value={x.id}>{x.spec.label}</option>)}
          </select>
        </label>
      </div>

      <div className="mt-9 flex flex-wrap gap-10">
        <div className="min-w-0 flex-[1_1_560px]">
          <section>
            <SectionHead title="Snapshots" meta={`${inScope.length} of ${snapshots.length} in this scope`} caveat="each one immutable; a correction is a new snapshot" />
            {inScope.map((x) => (
              <Row key={x.id} onClick={() => setAId(x.id)} selected={x.id === aId}>
                <span className="min-w-0">
                  <span className="text-ui font-medium">{x.spec.label}</span>
                  <span className="mt-[2px] block font-mono text-meta text-ink-500">{lensText(x)}</span>
                </span>
                <span className="flex flex-wrap items-center justify-end gap-2">
                  <Pill tone="neutral">{x.spec.kind}</Pill>
                  <Pill tone={COMPLETENESS_TONE[x.completeness]}>{x.completeness}</Pill>
                  <span className="font-mono text-meta text-ink-500">{x.fingerprint.slice(0, 20)}</span>
                </span>
              </Row>
            ))}
          </section>

          {a && view && (
            <section className="mt-11">
              <SectionHead title={`State — ${a.spec.label}`} meta={`${a.itemCount} items · ${a.spec.kind}`} caveat="actual, modelled and committed future are never merged" />
              <FactRow
                className="mt-4"
                facts={[
                  { label: 'Effective', value: a.spec.lens.effectiveAsOf.slice(0, 16).replace('T', ' '), mono: true },
                  { label: 'Known through', value: a.spec.lens.recordedThrough.slice(0, 16).replace('T', ' '), mono: true },
                  { label: 'Periods', value: a.spec.periods.join(', '), mono: true },
                  { label: 'Completeness', value: a.completeness, mono: true },
                  { label: 'Sensitivity', value: a.sensitivityClasses.join(', ').toLowerCase().replaceAll('_', ' '), mono: false },
                ]}
              />
              {view.refusal && <Notice tone="error" label="Not visible to this reader" className="mt-4">{view.refusal}</Notice>}
              {view.projection && view.projection.withheld.length > 0 && (
                <Notice tone="warning" label="Withheld by sensitivity" className="mt-4">{view.projection.statement}</Notice>
              )}
              {a.completenessReasons.length > 0 && (
                <details className="mt-4">
                  <summary className="cursor-pointer text-ui text-accent-700">Why this snapshot is {a.completeness.toLowerCase()} ({a.completenessReasons.length})</summary>
                  <ul className="mt-2 grid gap-1">
                    {a.completenessReasons.map((r, i) => (
                      <li key={i} className="text-dense text-ink-700">
                        <span className="font-mono text-meta text-ink-500">{r.code}</span> {r.message}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {view.projection && (
                <>
                  <div className="mt-5 flex flex-wrap gap-2">
                    {managementCategories.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setCategory(c)}
                        className={cn(
                          'rounded-full border px-3 py-1 text-dense transition-colors duration-160 ease-helm',
                          c === category ? 'border-accent-800 bg-accent-800 text-white' : 'border-ink-200 bg-white text-ink-700 hover:border-ink-400',
                        )}
                      >
                        {CATEGORY_LABEL[c]} <span className="font-mono text-meta">{byCategory(c).length}</span>
                      </button>
                    ))}
                  </div>
                  <div className="mt-3">
                    {items.length === 0 && <p className="py-3 text-ui text-ink-500">Nothing in {CATEGORY_LABEL[category].toLowerCase()} for this reader at this lens.</p>}
                    {items.map((i) => (
                      <Row key={i.key} onClick={() => openItem(a.id, i)}>
                        <span className="min-w-0">
                          <span className={cn('text-ui', i.kind === 'ATTENTION' && 'font-serif text-read')}>{i.label}</span>
                          {i.reason && <span className="mt-[2px] block text-dense text-red-700">{i.reason}</span>}
                        </span>
                        <span className="flex flex-wrap items-center justify-end gap-2">
                          {i.layer && <Pill tone={LAYER_TONE[i.layer] ?? 'neutral'}>{i.layer.replaceAll('_', ' ')}</Pill>}
                          {i.status !== 'KNOWN' && <Pill tone="blocked">{i.status}</Pill>}
                          <span className="font-mono text-meta text-ink-700">{reading(i)}</span>
                        </span>
                      </Row>
                    ))}
                  </div>
                </>
              )}
            </section>
          )}

          {delta && a && b && (
            <section className="mt-11">
              <SectionHead title={`Change — ${a.spec.label} → ${b.spec.label}`} meta={`${delta.unchangedCount} unchanged`} caveat="a change is not a verdict" />
              <p className="mt-3 text-ui text-ink-600">{delta.statement}</p>
              {delta.comparability.warnings.map((w) => (
                <Notice key={w} tone="warning" className="mt-3">{w}</Notice>
              ))}
              {groups.filter((g) => g.changes.length > 0).map((g) => (
                <div key={g.key} className="mt-6">
                  <p className="helm-label">{g.title} <span className="font-mono">{g.changes.length}</span></p>
                  <div className="mt-1 grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)] gap-x-4 border-b border-ink-950 pb-1 pt-2">
                    <span className="helm-label">Before</span>
                    <span className="helm-label">Change</span>
                    <span className="helm-label">After</span>
                  </div>
                  {g.changes.map((c) => (
                    <button
                      type="button"
                      key={c.itemKey}
                      onClick={() => (c.kind === 'VALUE' && c.before && c.after ? openDifference(c.itemKey, c.itemKey, c.label) : c.after ? openItem(b.id, c.after) : c.before && openItem(a.id, c.before))}
                      className="grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)] gap-x-4 border-b border-ink-200 py-[10px] text-left transition-colors duration-160 ease-helm hover:bg-ink-50"
                    >
                      <span className="font-mono text-meta text-ink-600">{c.before ? reading(c.before) : '—'}</span>
                      <span className="text-dense text-ink-800">{c.statement}</span>
                      <span className="font-mono text-meta text-ink-800">{c.after ? reading(c.after) : '—'}</span>
                    </button>
                  ))}
                </div>
              ))}
              {delta.deltaAttention.length > 0 && (
                <div className="mt-6">
                  <p className="helm-label">Conditions only a comparison can see</p>
                  {delta.deltaAttention.map((x, i) => (
                    <p key={i} className="border-b border-ink-200 py-[10px] font-serif text-read">
                      {x.statement} <span className="font-mono text-meta text-ink-500">{x.rule.split(':')[0]}</span>
                    </p>
                  ))}
                </div>
              )}
              <IntelligencePanel task="EXPLAIN_TWIN_CHANGE" params={{ fromId: a.id, toId: b.id }} viewer={viewer} label="Explain what changed" detail="A grounded reading of the change above: each statement is classed as a source fact or a model result and points at the twin item it rests on." />
            </section>
          )}

          {trajectory && (
            <section className="mt-11">
              <SectionHead
                title={trajectory.relation === 'EXPECTED_VS_ACTUAL' ? 'Expected against actual' : 'Now against the committed future'}
                meta={trajectory.relation}
                caveat="no path is drawn between them"
              />
              <p className="mt-3 max-w-[640px] font-serif text-read italic text-ink-600">{trajectory.statement}</p>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse">
                  <thead>
                    <tr>
                      {['Position', 'Committed', 'Now', 'Read from', trajectory.relation === 'EXPECTED_VS_ACTUAL' ? 'Expected vs actual' : 'Distance to intent'].map((h, i) => (
                        <th key={h} className={cn('helm-label pb-2 text-left', i > 0 && 'pl-3')}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {trajectory.lines.map((l) => (
                      <tr key={l.nodeId} className="border-t border-ink-200">
                        <td className="py-3 text-dense text-ink-800">{l.label}</td>
                        <td className="py-3 pl-3 font-mono text-meta">{show(l.committed, l.unit, l.currency)}</td>
                        <td className="py-3 pl-3 font-mono text-meta">{show(l.current, l.unit, l.currency)}</td>
                        <td className="py-3 pl-3">{l.currentLayer && <Pill tone={LAYER_TONE[l.currentLayer] ?? 'neutral'}>{l.currentLayer}</Pill>}</td>
                        <td className={cn('py-3 pl-3 font-mono text-meta', l.beyondMateriality ? 'text-red-700' : 'text-ink-700')}>
                          {l.difference === null ? '—' : `${l.difference.startsWith('-') ? '−' + l.difference.slice(1) : '+' + l.difference}${l.differenceUnit ?? ''}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {trajectory.unresolved.length > 0 && (
                <div className="mt-5">
                  <p className="helm-label">What still stands between them</p>
                  {trajectory.unresolved.map((u) => (
                    <p key={u.itemKey} className="border-b border-ink-200 py-[10px] text-dense text-ink-800">
                      {u.label} <span className="font-mono text-meta text-ink-500">{u.why}</span>
                    </p>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>

        <aside className="w-full max-w-[360px] flex-[0_1_360px]">
          <SectionHead title="Lineage" size="section-sm" />
          {!lineage && <p className="mt-3 text-ui text-ink-500">Choose an item or a change to trace it into the kernel: calculation, scenario, decision, governance, source.</p>}
          {lineage && (
            <div className="mt-3">
              <p className="font-serif text-read">{lineage.title}</p>
              {lineage.causal && <p className="helm-label mt-3">Model explanation</p>}
              <p className="mt-2 whitespace-pre-line text-dense text-ink-700">{lineage.statement}</p>
              <ol className="mt-4 grid gap-2">
                {lineage.lines.map((l, i) => (
                  <li key={i} className="border-l border-ink-200 pl-3" style={{ marginLeft: Math.min(l.depth, 6) * 10 }}>
                    <span className="block text-dense text-ink-900">{l.label}</span>
                    <span className="block text-meta text-ink-500">{l.detail}</span>
                    {l.ref && <span className="block font-mono text-meta text-ink-500">{l.ref}</span>}
                  </li>
                ))}
              </ol>
              {lineage.disclaimer && <p className="helm-caveat mt-4">{lineage.disclaimer}</p>}
              {lineage.causal && (
                <div className="mt-6 border-t-2 border-ink-950 pt-3">
                  <p className="helm-label">Causal hypotheses</p>
                  {lineage.causal.causal.map((ci) => {
                    const candidates = ci.questions[0]?.candidates.map((k) => k.view) ?? ci.claims;
                    return (
                      <div key={`${ci.moved.metricKey}:${ci.moved.nodeId}`} className="mt-3">
                        <p className="text-dense text-ink-900">
                          Why did <span className="font-mono">{ci.variable?.label ?? ci.moved.input}</span> move?
                        </p>
                        <p className={cn('text-meta', ci.state === 'SUPPORTED_EXPLANATION_EXISTS' ? 'text-ink-600' : 'text-red-700')}>{ci.statement}</p>
                        <ul className="mt-2 grid gap-2">
                          {candidates.map((v) => (
                            <li key={v.claim.id} className="border-l border-ink-200 pl-3">
                              <Pill tone={statusTone(v.evaluation.status)}>{v.evaluation.status}</Pill>
                              <span className="mt-1 block text-dense text-ink-800">{v.revision.statement}</span>
                              <span className="block font-mono text-meta text-ink-500">
                                {v.evaluation.counts.supporting} for · {v.evaluation.counts.challenging + v.evaluation.counts.contradicting} against · confidence {v.evaluation.confidence}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                  <p className="helm-caveat mt-4">{lineage.causal.important}</p>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
