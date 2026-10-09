/**
 * The Country GM cockpit — the senior-management product layer.
 *
 * Not a KPI dashboard: there is no health score and no traffic light for the enterprise. The one
 * question is "what requires my management attention?", and every answer walks the same road:
 *
 *   attention → enterprise state → value impact → why → dependencies → causal understanding →
 *   possible futures → decision → governance → commitment → actual outcome → learning
 *
 * without the reader having to know that an ontology, a value graph or a scenario revision exists.
 * The central interaction is NOW against the COMMITTED FUTURE, with the distance between them and
 * a "Why?" that opens the lineage. Everything here is read from the kernels as the person reading;
 * nothing is ranked, weighted or totalled, and HELM recommends nothing.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { canSeeSnapshot, type ComposedSnapshot, type ProjectedSnapshot, type Trajectory, type TrajectoryLine, type TwinItem, type TwinItemExplanation, type TwinSnapshot } from '@helm/twin-runtime';
import type { ClaimView } from '@helm/causal-runtime';
import type { ProjectedReviews } from '@helm/review-runtime';
import type { ProjectedGenome } from '@helm/genome-runtime';
import type { ProjectedCounterfactuals } from '@helm/counterfactual-runtime';
import { useHelmStore } from '../services/helmStore.ts';
import { useMemoireLive } from '../services/memoireLiveSync.ts';
import { cloudScope, demoScope } from '../services/ontologyGraph.ts';
import { resolveIntelligenceContext, type IntelligenceContext } from '../services/intelligenceRuntime.ts';
import { explainView, listSnapshots, loadSnapshotView, trajectoryView } from '../services/twinRuntime.ts';
import { claimsForViewer, statusTone } from '../services/causalRuntime.ts';
import { genomeForViewer, patternTone } from '../services/genomeRuntime.ts';
import { counterfactualsForViewer, caseTone } from '../services/counterfactualRuntime.ts';
import { reviewsForViewer } from '../services/reviewRuntime.ts';
import { resolveIntegrationContext, type IntegrationContext } from '../services/integrationRuntime.ts';
import { PageHeader } from '../components/ui/PageHeader.tsx';
import { SectionHead } from '../components/ui/SectionHead.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { Notice } from '../components/ui/Notice.tsx';
import { Pill } from '../components/ui/Pill.tsx';
import { MetricList } from '../components/ui/MetricList.tsx';
import { IntelligencePanel } from '../components/intelligence/IntelligencePanel.tsx';
import { AskHelm } from '../components/intelligence/AskHelm.tsx';
import { CouncilPanel } from '../components/intelligence/CouncilPanel.tsx';
import { cn } from '../lib/cn.ts';

const NUM = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const word = (n: number) => NUM[n] ?? String(n);
const day = (iso: string): string => iso.slice(0, 10);

type Loaded = {
  readonly ic: IntelligenceContext;
  readonly integration: IntegrationContext | null;
  readonly current: ComposedSnapshot;
  readonly projection: ProjectedSnapshot | null;
  readonly trajectory: Trajectory | null;
  readonly claims: readonly ClaimView[];
  readonly genome: ProjectedGenome;
  readonly counterfactuals: ProjectedCounterfactuals;
  readonly reviews: ProjectedReviews;
};

type Lineage = { title: string; statement: string; lines: { depth: number; label: string; detail: string }[] };

const formatDistance = (l: TrajectoryLine): string => (l.difference === null ? '—' : `${l.difference}${l.differenceUnit ? ` ${l.differenceUnit}` : ''}`);
const measure = (v: string | null, l: TrajectoryLine): string => (v === null ? '—' : `${v}${l.unit && l.unit !== 'currency' ? ` ${l.unit}` : ''}${l.currency ? ` ${l.currency}` : ''}`);

export function CockpitPage() {
  const mode = useHelmStore((st) => st.mode);
  const activeOrgId = useHelmStore((st) => st.activeOrgId);
  const userId = useHelmStore((st) => st.userId);
  const myRole = useHelmStore((st) => st.myRole);
  // A new current state composed from Memoire is a reason to read the cockpit again (ADR-0034).
  const memoireVersion = useMemoireLive((st) => st.version);
  const livePhase = useMemoireLive((st) => st.phase);
  const scope = useMemo(() => (mode === 'demo' ? demoScope() : activeOrgId ? cloudScope(activeOrgId, userId ?? '', myRole()) : null), [mode, activeOrgId, userId, myRole]);

  const [ic, setIc] = useState<IntelligenceContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewerKey, setViewerKey] = useState('');
  const [loaded, setLoaded] = useState<{ key: string; value: Loaded | null; note: string | null } | null>(null);
  const [why, setWhy] = useState<Lineage | null>(null);
  const [openAttention, setOpenAttention] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (!scope) return;
    void (async () => {
      try {
        const c = await resolveIntelligenceContext(mode ?? 'demo', scope);
        if (!c) throw new Error('The cockpit is unavailable in this mode.');
        if (!live) return;
        setIc(c);
        setViewerKey(c.reviews.viewers.find((v) => v.key === 'countryGM')?.key ?? c.reviews.viewers[0]?.key ?? '');
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [mode, scope]);

  const viewer = ic?.reviews.viewers.find((v) => v.key === viewerKey)?.viewer ?? null;
  const key = viewerKey;

  useEffect(() => {
    let live = true;
    if (!ic || !viewer || !scope) return;
    void (async () => {
      try {
        const g = ic.reviews.genome;
        const twin = g.causal.twin;
        const all = await listSnapshots(twin);
        const visible = (s: TwinSnapshot) => canSeeSnapshot(viewer, s, twin.units).visible;
        const currentHeader = [...all].filter((s) => s.spec.kind === 'CURRENT' && visible(s)).at(-1);
        if (!currentHeader) {
          if (live) setLoaded({ key, value: null, note: 'No current enterprise state is visible to this reader yet.' });
          return;
        }
        const view = await loadSnapshotView(twin, currentHeader.id, viewer);
        const cfHeader = [...all].filter((s) => s.spec.kind === 'COMMITTED_FUTURE' && visible(s)).at(-1);
        const trajectory = cfHeader ? await trajectoryView(twin, currentHeader.id, cfHeader.id).catch(() => null) : null;
        const [claims, genome, counterfactuals, reviews] = await Promise.all([
          claimsForViewer(g.causal, viewer, null),
          genomeForViewer(g, viewer, null),
          counterfactualsForViewer({ counterfactual: g.counterfactual.runtime, scope, mode: ic.mode, causal: g.causal, story: g.counterfactual.story, viewers: g.viewers, lenses: [] }, viewer, null),
          reviewsForViewer(ic.reviews, viewer, null),
        ]);
        const integration = await resolveIntegrationContext(ic.mode, scope).catch(() => null);
        if (live) setLoaded({ key, value: { ic, integration, current: view.composed, projection: view.projection, trajectory, claims: claims.claims, genome, counterfactuals, reviews }, note: view.refusal });
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [ic, viewer, scope, key, memoireVersion]);

  if (error) return <EmptyState title="The cockpit could not be opened" detail={error} />;
  if (!ic || !viewer) return <p className="text-ui text-ink-500">Reading the enterprise…</p>;
  const data = loaded && loaded.key === key ? loaded : null;
  const d = data?.value ?? null;
  const items: readonly TwinItem[] = d?.projection?.items ?? [];
  const attention = items.filter((i) => i.kind === 'ATTENTION');
  const decisions = items.filter((i) => i.kind === 'DECISION');
  const governance = new Map(items.filter((i) => i.kind === 'GOVERNANCE').map((i) => [String((i.state as { commitmentId?: string }).commitmentId ?? i.key), i]));
  const off = d?.trajectory?.lines.filter((l) => l.beyondMateriality === true) ?? [];
  // Grouped by the named condition, in the order the kernel holds them — grouping is for scanning, never for ranking.
  const groups: [string, TwinItem[]][] = [];
  for (const a of attention) {
    const c = String((a.state as { condition?: string }).condition ?? 'ATTENTION');
    const g = groups.find(([k]) => k === c);
    if (g) g[1].push(a);
    else groups.push([c, [a]]);
  }
  const twinCtx = ic.reviews.genome.causal.twin;
  const select = 'max-w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-ui';
  const latestReview = d?.reviews.reviews.at(-1) ?? null;

  const explainLine = async (l: TrajectoryLine) => {
    if (!d) return;
    const item = d.current.items.find((i) => (i.state as { nodeId?: string }).nodeId === l.nodeId && i.kind === 'VALUE' && (i.layer ?? null) === l.currentLayer && ((i.state as { period?: string | null }).period ?? null) === l.period);
    if (!item) {
      setWhy({ title: `Why is ${l.label} where it is?`, statement: 'This reading is not part of the current state as you may see it.', lines: [] });
      return;
    }
    try {
      const ex: TwinItemExplanation = await explainView(twinCtx, d.current.snapshot.id, item.key);
      setWhy({ title: `Why is ${l.label} ${measure(l.current, l)}?`, statement: ex.statement, lines: ex.chain.map((s) => ({ depth: s.depth, label: s.label, detail: s.detail })) });
    } catch (e) {
      setWhy({ title: l.label, statement: e instanceof Error ? e.message : String(e), lines: [] });
    }
  };

  const headline = !d
    ? 'Reading what needs your attention…'
    : attention.length === 0 && off.length === 0
      ? 'Nothing needs your attention this week. What management committed to is where it said it would be.'
      : `${word(attention.length)} ${attention.length === 1 ? 'condition needs' : 'conditions need'} your attention${off.length > 0 ? `; ${word(off.length).toLowerCase()} ${off.length === 1 ? 'commitment sits' : 'commitment readings sit'} away from the committed future` : ''}.`;

  const firstCompose = ic.mode === 'cloud' && !d && (livePhase === 'starting' || livePhase === 'reading' || livePhase === 'composing');
  const proof = d?.integration?.proof ?? null;
  const focusDecision = decisions[0];

  return (
    <>
      <PageHeader
        kicker={`Management · ${twinCtx.story ? twinCtx.story.scopes.vietnam.label : 'Enterprise'} · ${d ? `state as known through ${day(d.current.snapshot.spec.lens.recordedThrough)}` : '…'}`}
        title={headline}
        lede="What requires management attention, why, and what management has already decided — read from the kernels as you, never ranked or scored. There is no health number: an enterprise is not one figure."
      />

      {ic.mode === 'demo' && (
        <Notice tone="neutral" label="Demo organization" className="mt-6">
          Meridian Vietnam is a fictional enterprise. Its data, decisions, reviews and the AI reading below are illustrative and labelled DEMO at their source; nothing syncs to any real system.
        </Notice>
      )}
      {firstCompose ? (
        <Notice tone="neutral" label="Memoire" className="mt-4">HELM is reading your Memoire opportunities and composing the first current state of the enterprise.</Notice>
      ) : (
        data?.note && <Notice tone="warning" label="Withheld" className="mt-4">{data.note}</Notice>
      )}

      <div className="mt-6 flex flex-wrap items-end gap-4">
        <label className="grid max-w-full grid-cols-[minmax(0,1fr)] gap-1">
          <span className="helm-label">Read as</span>
          <select className={select} value={viewerKey} onChange={(e) => setViewerKey(e.target.value)}>{ic.reviews.viewers.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}</select>
        </label>
        <p className="max-w-reading pb-2 text-meta text-ink-500">Switch reader to see how clearance and decision visibility change what is shown — and what is withheld, said out loud.</p>
      </div>

      <div className="mt-9 flex flex-wrap gap-10">
        <div className="min-w-0 flex-[1_1_560px]">
          <section>
            <SectionHead title="What requires your attention" meta={d ? String(attention.length) : '…'} caveat="named conditions with a cause — not a ranking" dot={attention.length > 0 ? 'warning' : undefined} />
            {d && attention.length === 0 && <p className="mt-3 text-ui text-ink-500">No attention condition holds in the state you may read.</p>}
            {groups.map(([condition, group]) => (
              <div key={condition} className="mt-5">
                <p className="flex flex-wrap items-baseline gap-3">
                  <Pill tone="open">{condition.replaceAll('_', ' ')}</Pill>
                  <span className="font-mono text-meta text-ink-500">{group.length} · {String((group[0]!.state as { rule?: string }).rule ?? '')}</span>
                </p>
            <ul>
              {group.map((a) => {
                const st = a.state as { condition?: string; statement?: string; rule?: string; causeItemKeys?: string[] };
                const causes = (st.causeItemKeys ?? []).map((k) => d?.current.items.find((i) => i.key === k)).filter((x): x is TwinItem => !!x);
                const isOpen = openAttention === a.key;
                return (
                  <li key={a.key} className="border-b border-ink-200 py-4">
                    <div className="flex flex-wrap items-baseline gap-3">
                      <p className="max-w-reading text-read text-ink-900">{st.statement ?? a.label}</p>
                      <button type="button" onClick={() => setOpenAttention(isOpen ? null : a.key)} aria-expanded={isOpen} className="ml-auto text-meta font-medium text-accent-700 hover:underline">{isOpen ? 'Hide why' : 'Why?'}</button>
                    </div>
                    {isOpen && (
                      <div className="mt-3 border-l border-ink-300 pl-4">
                        <p className="helm-label">What it rests on</p>
                        {causes.length === 0 && <p className="mt-1 text-dense text-ink-600">The condition names no cause item: it rests on the state itself.</p>}
                        <ul className="mt-1 grid gap-1">
                          {causes.map((c) => (
                            <li key={c.key} className="text-dense text-ink-800">
                              {c.label} <span className="font-mono text-meta text-ink-500">· {c.kind.toLowerCase()} · {c.status.toLowerCase()}</span>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-2 text-meta text-ink-600">
                          Open it in <Link to="/twin" className="text-accent-700 underline">the Twin</Link>, follow its <Link to="/causal" className="text-accent-700 underline">causal understanding</Link>, or see the <Link to="/scenarios" className="text-accent-700 underline">possible futures</Link>.
                        </p>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
              </div>
            ))}
          </section>

          <section className="mt-10">
            <SectionHead title="Now, against the committed future" meta={d?.trajectory ? d.trajectory.relation : '…'} caveat="the distance is a fact, not a verdict" />
            {d && !d.trajectory && <p className="mt-3 text-ui text-ink-500">No commitment you may see has a committed future to measure against yet.</p>}
            {d?.trajectory && (
              <>
                <p className="mt-3 max-w-reading font-serif text-read italic text-ink-600">{d.trajectory.statement}</p>
                <div className="mt-3 overflow-x-auto rounded-xl border border-ink-200 bg-white">
                  <table className="w-full min-w-[640px] border-collapse text-left">
                    <thead>
                      <tr className="border-b border-ink-200 helm-label"><th className="px-4 py-3">Position</th><th className="px-4 py-3">Now</th><th className="px-4 py-3">Committed future</th><th className="px-4 py-3">Distance</th><th className="px-4 py-3" /></tr>
                    </thead>
                    <tbody>
                      {d.trajectory.lines.map((l) => (
                        <tr key={`${l.nodeId}-${l.period}`} className="border-b border-ink-200 last:border-b-0">
                          <td className="px-4 py-3 text-dense text-ink-900">{l.label}<span className="block font-mono text-meta text-ink-500">{l.currentLayer ?? '—'}{l.period ? ` · ${l.period}` : ''}</span></td>
                          <td className="px-4 py-3 font-serif text-figure-sm tabular">{measure(l.current, l)}</td>
                          <td className="px-4 py-3 font-serif text-figure-sm tabular text-ink-700">{measure(l.committed, l)}</td>
                          <td className={cn('px-4 py-3 font-mono text-dense', l.beyondMateriality ? 'text-red-700' : 'text-ink-600')}>{formatDistance(l)}{l.beyondMateriality ? ' · beyond materiality' : ''}</td>
                          <td className="px-4 py-3 text-right"><button type="button" onClick={() => void explainLine(l)} className="text-meta font-medium text-accent-700 hover:underline">Why?</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {d.trajectory.unresolved.length > 0 && <ul className="mt-2 grid gap-1">{d.trajectory.unresolved.map((u) => <li key={u.itemKey} className="text-dense text-red-700">{u.label}: {u.why}</li>)}</ul>}
              </>
            )}
            {why && (
              <div className="mt-4 rounded-xl border border-ink-200 bg-white px-5 py-4">
                <div className="flex items-baseline justify-between gap-3"><h3 className="font-serif text-panel">{why.title}</h3><button type="button" onClick={() => setWhy(null)} className="text-meta text-ink-500 hover:text-ink-900">close</button></div>
                <p className="mt-1 text-dense text-ink-700">{why.statement}</p>
                <ol className="mt-3 grid gap-1">
                  {why.lines.map((l, i) => (
                    <li key={i} className="text-dense text-ink-800" style={{ paddingLeft: `${l.depth * 16}px` }}>
                      <span className="font-medium">{l.label}</span> <span className="font-mono text-meta text-ink-500">{l.detail}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </section>

          <section className="mt-10">
            <SectionHead title="Decisions and governance" meta={d ? String(decisions.length) : '…'} caveat="visibility is not authority" />
            {d && decisions.length === 0 && <p className="mt-3 text-ui text-ink-500">No decision is visible to this reader.</p>}
            <ul>
              {decisions.map((dec) => {
                const cid = String((dec.state as { commitmentId?: string | null }).commitmentId ?? '');
                const gov = governance.get(cid);
                const gs = gov?.state as { state?: string; statement?: string } | undefined;
                return (
                  <li key={dec.key} className="border-b border-ink-200 py-3">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <Pill tone={dec.status === 'KNOWN' ? 'reviewed' : 'open'}>{String((dec.state as { decisionState?: string; state?: string }).decisionState ?? (dec.state as { state?: string }).state ?? dec.status)}</Pill>
                      {gs?.state && <Pill tone={gs.state === 'AUTHORIZED' || gs.state === 'APPROVED' ? 'committed' : 'accepted'}>{gs.state.replaceAll('_', ' ')}</Pill>}
                      <span className="text-dense text-ink-900">{dec.label}</span>
                    </div>
                    {gs?.statement && <p className="mt-1 text-meta text-ink-600">{gs.statement}</p>}
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 text-meta text-ink-600">Frame, weigh and commit in <Link to="/decisions" className="text-accent-700 underline">Decisions</Link>; see who must approve in <Link to="/governance" className="text-accent-700 underline">Governance</Link>.</p>
          </section>

          <section className="mt-10">
            <SectionHead title="What we believe, and what we have learned" caveat="a belief keeps its own evidence status" />
            <div className="mt-3 grid gap-6 md:grid-cols-2">
              <div>
                <p className="helm-label">Causal understanding</p>
                <ul className="mt-2 grid gap-2">
                  {(d?.claims ?? []).slice(0, 4).map((c) => (
                    <li key={c.claim.id} className="border-l border-ink-200 pl-3">
                      <Pill tone={statusTone(c.evaluation.status)}>{c.evaluation.status}</Pill>
                      <span className="mt-1 block text-dense text-ink-900">{c.revision.statement}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-meta"><Link to="/causal" className="text-accent-700 underline">All causal claims →</Link></p>
              </div>
              <div>
                <p className="helm-label">Management memory</p>
                <ul className="mt-2 grid gap-2">
                  {(d?.genome.patterns ?? []).slice(0, 3).map((p) => (
                    <li key={p.pattern.id} className="border-l border-ink-200 pl-3"><Pill tone={patternTone(p.status)}>{p.status}</Pill><span className="mt-1 block text-dense text-ink-900">{p.pattern.title}</span></li>
                  ))}
                  {(d?.counterfactuals.cases ?? []).slice(0, 2).map((c) => (
                    <li key={c.case.id} className="border-l border-ink-200 pl-3"><Pill tone={caseTone(c.status)}>counterfactual · {c.status}</Pill><span className="mt-1 block text-dense text-ink-900">{c.case.title}</span></li>
                  ))}
                </ul>
                <p className="mt-2 text-meta"><Link to="/genome" className="text-accent-700 underline">Genome →</Link> · <Link to="/counterfactuals" className="text-accent-700 underline">Counterfactual worlds →</Link></p>
              </div>
            </div>
          </section>
        </div>

        <aside className="w-full max-w-[360px] flex-[0_1_360px]">
          <MetricList
            title="This review"
            kind={latestReview ? { label: latestReview.status, tone: latestReview.status === 'OPEN' ? 'open' : 'reviewed' } : undefined}
            metrics={[
              { label: 'Latest review', sub: latestReview?.review.cadence.toLowerCase(), value: latestReview ? latestReview.review.periodLabel : 'none' },
              { label: 'Carried forward', sub: 'the same objects, not retyped', value: String(latestReview?.items.filter((i) => i.carriedFromItemId).length ?? 0) },
              { label: 'Decisions needed', value: String(attention.filter((a) => /AWAITING|READY/i.test(String((a.state as { condition?: string }).condition ?? ''))).length) },
            ]}
          />
          <p className="mt-2 text-meta text-ink-600"><Link to="/reviews" className="text-accent-700 underline">Open the reviews →</Link></p>

          <div className="mt-8">
            <SectionHead title="Ask, or open the council" size="section-sm" />
            <div className="mt-3"><AskHelm viewer={viewer} /></div>
            {latestReview && (
              <IntelligencePanel task="DRAFT_MANAGEMENT_BRIEF" params={{ reviewId: latestReview.review.id }} viewer={viewer} label="Draft the management brief" detail="A grounded brief for the latest review: what changed, what matters, what is off-track, what is uncertain, what decisions are required, which assumptions are challenged, which outcomes arrived." />
            )}
          </div>

          <div className="mt-8">
            <SectionHead title="Connected sources" size="section-sm" />
            {proof ? (
              <div className="mt-3 text-dense text-ink-700">
                <p>Memoire owns the commercial fact; HELM references it. A new opportunity entered the enterprise without being typed in, and the same sync run twice changed nothing.</p>
                <p className="mt-2 font-mono text-meta text-ink-500">first sync {proof.firstSync.outcome.toLowerCase()} · {proof.firstSync.counts.entitiesCreated} entities · {proof.firstSync.counts.observationsRecorded} observations · repeat {proof.repeatSync.counts.observationsRecorded + proof.repeatSync.counts.entitiesCreated} written</p>
                <p className="mt-2 text-meta text-ink-600"><Link to="/sources" className="text-accent-700 underline">Sources, identity and dry-run writeback →</Link></p>
              </div>
            ) : (
              <p className="mt-3 text-dense text-ink-600">Memoire is read as you, and only read. <Link to="/sources" className="text-accent-700 underline">Sources →</Link></p>
            )}
          </div>
        </aside>
      </div>

      {focusDecision && <CouncilPanel question={`What does each management function make of ${focusDecision.label}?`} request={{ ...(latestReview ? { reviewId: latestReview.review.id } : {}) }} viewer={viewer} />}
    </>
  );
}
