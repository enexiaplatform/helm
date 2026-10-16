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
 *
 * Severity decides treatment (audit 2026-10-13): a condition that cannot wait gets a full row with
 * what it is about and where to act; one that needs a look gets one line; commitments without an
 * authority verdict are one standing line. Kernel sentences are shown for reading (src/lib/format.ts)
 * with the exact text one hover away.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { canSeeSnapshot, quarterKeyOf, readPipeline, type ComposedSnapshot, type ProjectedSnapshot, type Trajectory, type TrajectoryLine, type TwinItem, type TwinItemExplanation, type TwinSnapshot } from '@helm/twin-runtime';
import type { QuantityUnit } from '@helm/shared';
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
import { displayDelta, displayValue } from '../services/scenarioRuntime.ts';
import { attentionTiers, conditionOf } from '../services/attentionTiers.ts';
import { readable, readInstant } from '../lib/format.ts';
import { PageHeader } from '../components/ui/PageHeader.tsx';
import { ReaderSelect } from '../components/ui/ReaderSelect.tsx';
import { SectionHead } from '../components/ui/SectionHead.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { Notice } from '../components/ui/Notice.tsx';
import { Pill } from '../components/ui/Pill.tsx';
import { IntelligencePanel } from '../components/intelligence/IntelligencePanel.tsx';
import { AskHelm } from '../components/intelligence/AskHelm.tsx';
import { suggestedQuestions } from '../components/intelligence/suggestedQuestions.ts';
import { Button } from '../components/ui/Button.tsx';
import { cn } from '../lib/cn.ts';

const NUM = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
const word = (n: number) => NUM[n] ?? String(n);

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

const unitOf = (u: string | null): QuantityUnit | null => (u as QuantityUnit | null) ?? null;
const measure = (v: string | null, unit: string | null, currency: string | null): string => (v === null ? '—' : displayValue(v, unitOf(unit), currency));
const st = <T,>(i: TwinItem | undefined, key: string): T | undefined => (i ? ((i.state as Record<string, unknown>)[key] as T | undefined) : undefined);

/** A kernel sentence shown for reading, with the exact text one hover away. */
const Said = ({ text, className }: { text: string; className?: string }) => {
  const shown = readable(text);
  return <span className={className} title={shown === text ? undefined : text}>{shown}</span>;
};

/** The kernel name of a condition, for its pill: an enum, said as the kernel says it. */
const conditionName = (c: string): string => (c === 'AUTHORITY_UNRESOLVED' ? 'NO AUTHORITY VERDICT' : c.replaceAll('_', ' '));

export function CockpitPage() {
  const mode = useHelmStore((s) => s.mode);
  const activeOrgId = useHelmStore((s) => s.activeOrgId);
  const userId = useHelmStore((s) => s.userId);
  const myRole = useHelmStore((s) => s.myRole);
  const navigate = useNavigate();
  // A new current state composed from Memoire is a reason to read the cockpit again (ADR-0034).
  const memoireVersion = useMemoireLive((s) => s.version);
  const livePhase = useMemoireLive((s) => s.phase);
  const caughtUpAt = useMemoireLive((s) => s.caughtUpAt);
  const scope = useMemo(() => (mode === 'demo' ? demoScope() : activeOrgId ? cloudScope(activeOrgId, userId ?? '', myRole()) : null), [mode, activeOrgId, userId, myRole]);

  const [ic, setIc] = useState<IntelligenceContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewerKey, setViewerKey] = useState('');
  const [loaded, setLoaded] = useState<{ key: string; version: number; value: Loaded | null; note: string | null } | null>(null);
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
          if (live) setLoaded({ key, version: memoireVersion, value: null, note: 'No current enterprise state is visible to this reader yet.' });
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
        if (live) setLoaded({ key, version: memoireVersion, value: { ic, integration, current: view.composed, projection: view.projection, trajectory, claims: claims.claims, genome, counterfactuals, reviews }, note: view.refusal });
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
  const tiers = attentionTiers(items, [...items, ...(d?.current.items ?? [])]);
  const decisions = items.filter((i) => i.kind === 'DECISION');
  // A cancelled decision stays on record in Decisions; the Cockpit lists what is in play (audit 2026-10-13: a cancelled test decision sat here).
  const isCancelled = (i: TwinItem) => /CANCELLED/.test(String(st<string>(i, 'decisionState') ?? st<string>(i, 'state') ?? ''));
  const liveDecisions = decisions.filter((i) => !isCancelled(i));
  const cancelledDecisions = decisions.length - liveDecisions.length;
  const governance = new Map(items.filter((i) => i.kind === 'GOVERNANCE').map((i) => [String(st<string>(i, 'commitmentId') ?? i.key), i]));
  const currentItems = d?.current.items ?? [];
  const itemByKey = new Map(currentItems.map((i) => [i.key, i]));
  const twinCtx = ic.reviews.genome.causal.twin;
  const select = 'max-w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-ui';
  const latestReview = d?.reviews.reviews.at(-1) ?? null;
  const now = d?.current.snapshot.spec.lens.effectiveAsOf ?? new Date().toISOString();
  const source = ic.mode === 'demo' ? 'the demo source' : 'Memoire';

  // Where a condition is acted on: the decision it is about, when it is about one.
  const decisionIdOf = (i: TwinItem | undefined): string | null => {
    if (!i) return null;
    const direct = st<string>(i, 'decisionId');
    if (direct) return direct;
    if (i.kind === 'DECISION') return i.refs.find((r) => r.kind === 'DECISION')?.id ?? (i.key.startsWith('decision:') ? i.key.slice('decision:'.length) : null);
    if (i.kind === 'GOVERNANCE') {
      const title = i.label.replace(/^Governance of /, '');
      return decisionIdOf(decisions.find((x) => x.label === title));
    }
    return null;
  };
  const decisionTitle = (id: string | null): string | null => (id ? decisions.find((x) => decisionIdOf(x) === id)?.label ?? null : null);
  const causesOf = (a: TwinItem): TwinItem[] => (st<string[]>(a, 'causeItemKeys') ?? []).map((k) => itemByKey.get(k)).filter((x): x is TwinItem => !!x);
  const decisionOfCondition = (a: TwinItem): string | null => causesOf(a).map(decisionIdOf).find((x) => x !== null) ?? null;

  /** What a cannot-wait condition says: a title naming what moved, and the line under it naming where it comes from. */
  const present = (a: TwinItem): { title: ReactNode; cause: ReactNode } => {
    const c = conditionOf(a);
    const statement = String(st<string>(a, 'statement') ?? a.label);
    const causes = causesOf(a);
    const decision = decisionTitle(decisionOfCondition(a));
    if (c === 'COMMITTED_FUTURE_OFF_TRACK') {
      const cf = causes.find((x) => x.layer === 'COMMITTED_FUTURE');
      const actual = causes.find((x) => x !== cf);
      if (cf && actual) {
        const unit = st<string>(cf, 'unit') ?? null;
        const currency = st<string>(cf, 'currency') ?? null;
        const committed = st<string>(cf, 'value') ?? null;
        const reading = st<string>(actual, 'value') ?? null;
        const diff = committed !== null && reading !== null ? String(Number(reading) - Number(committed)) : null;
        const metric = cf.label.replace(/ — committed future$/, '');
        const period = st<string>(cf, 'period');
        return {
          title: `${metric} landed ${Number(diff) < 0 ? 'below' : 'above'} what was committed${decision ? ` for “${decision}”` : ''}.`,
          cause: (
            <>
              {period ? `${period}: ` : ''}committed {measure(committed, unit, currency)}, {actual.layer?.toLowerCase()} {measure(reading, unit, currency)} ({displayDelta(diff, unitOf(unit), currency)}). Not a verdict on the decision.
            </>
          ),
        };
      }
    }
    if (c === 'CRITICAL_ASSUMPTION_DISPROVED') {
      const as = causes.find((x) => x.kind === 'ASSUMPTION');
      if (as) {
        const note = st<string>(as, 'outcomeNote');
        return {
          title: `Disproved: “${as.label.replace(/\.$/, '')}.”`,
          cause: <>A {String(st<string>(as, 'criticality') ?? '').toLowerCase()} assumption{decision ? ` behind “${decision}”` : ''}.{note ? ` ${note}` : ''}</>,
        };
      }
    }
    return { title: <Said text={statement} />, cause: decision ? <>About “{decision}”.</> : null };
  };

  const whyBlock = (a: TwinItem) => {
    const causes = causesOf(a);
    return (
      <div className="mt-3 border-l border-ink-300 pl-4">
        <p className="helm-label">What it rests on</p>
        {causes.length === 0 && <p className="mt-1 text-dense text-ink-600">The condition names no cause item: it rests on the state itself.</p>}
        <ul className="mt-1 grid gap-1">
          {causes.map((c) => (
            <li key={c.key} className="text-dense text-ink-800">
              <Said text={c.label} /> <span className="font-mono text-meta text-ink-500">· {c.kind.toLowerCase()} · {c.status.toLowerCase()}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 font-mono text-meta text-ink-500">{String(st<string>(a, 'rule') ?? '')}</p>
      </div>
    );
  };

  const actOn = (a: TwinItem) => {
    const id = decisionOfCondition(a);
    if (id) return { to: `/decisions/${id}`, label: 'Open the decision' };
    if (conditionOf(a) === 'APPROVAL_PENDING' || conditionOf(a) === 'COMMITMENT_NOT_AUTHORIZED') return { to: '/governance', label: 'Open Governance' };
    return { to: '/twin', label: 'Open it in the Twin' };
  };

  const explainLine = async (l: TrajectoryLine) => {
    if (!d) return;
    const item = d.current.items.find((i) => (i.state as { nodeId?: string }).nodeId === l.nodeId && i.kind === 'VALUE' && (i.layer ?? null) === l.currentLayer && ((i.state as { period?: string | null }).period ?? null) === l.period);
    if (!item) {
      setWhy({ title: `Why is ${l.label} where it is?`, statement: 'This reading is not part of the current state as you may see it.', lines: [] });
      return;
    }
    try {
      const ex: TwinItemExplanation = await explainView(twinCtx, d.current.snapshot.id, item.key);
      setWhy({ title: `Why is ${l.label} ${measure(l.current, l.unit, l.currency)}?`, statement: ex.statement, lines: ex.chain.map((s) => ({ depth: s.depth, label: s.label, detail: s.detail })) });
    } catch (e) {
      setWhy({ title: l.label, statement: e instanceof Error ? e.message : String(e), lines: [] });
    }
  };

  // A state that is not COMPLETE cannot vouch for "nothing needs attention": it may be silent because it cannot see.
  const gaps = d?.current.snapshot.completenessReasons ?? [];
  const urgent = tiers.cannotWait.length;
  const look = tiers.look.length + (tiers.noAuthorityVerdict.length > 0 ? 1 : 0);
  // The quarter of the state on screen: the demo's clock is its own, and a reading is about the moment it was composed.
  const quarter = quarterKeyOf(now);
  // HELM consumes the commercial truth Memoire produces; the forecast, deal changes and next steps are Memoire's own
  // (docs/architecture/helm-vs-memoire.md §5). The Cockpit says how much it read, and answers about management.
  const opportunities = d ? readPipeline(items).length : 0;
  const lookWord = (n: number) => `${n === 1 ? 'needs' : 'need'} a look`;
  const headline = !d
    ? 'Reading the enterprise…'
    : urgent > 0
      ? `${word(urgent)} ${urgent === 1 ? 'management condition cannot' : 'management conditions cannot'} wait.${look > 0 ? ` ${word(look)} ${lookWord(look)}.` : ''}`
      : look > 0
        ? `${word(look)} ${look === 1 ? 'management condition' : 'management conditions'} ${lookWord(look)}; none cannot wait.`
        : liveDecisions.length === 0
          ? 'No management decision is on record yet, so HELM has nothing to watch.'
          : gaps.length > 0
            ? 'Nothing needs management attention in what HELM can see; the state it reads is incomplete.'
            : 'Nothing needs management attention.';

  const firstCompose = ic.mode === 'cloud' && !d && (livePhase === 'starting' || livePhase === 'reading' || livePhase === 'composing');
  // A newer state was composed while this one is on screen: say so until it is read, so the page never passes off the older one as current.
  const rereading = ic.mode === 'cloud' && !!d && data!.version !== memoireVersion;
  // A state is on screen while Memoire is still being read: it is the last one known, and the page says how old it is.
  // Only until the first pass of this session catches up, or while a new state is composed: a routine probe every minute is not news.
  const catchingUp = ic.mode === 'cloud' && !!d && ((caughtUpAt === null && (livePhase === 'starting' || livePhase === 'reading')) || livePhase === 'composing');
  const trajectoryDecision = d?.trajectory ? decisionTitle(decisionIdOf(governance.get(d.trajectory.commitmentId))) : null;

  return (
    <>
      <PageHeader
        kicker={`Management · ${twinCtx.story ? twinCtx.story.scopes.vietnam.label : 'Enterprise'} · ${d ? `state as known on ${readInstant(d.current.snapshot.spec.lens.recordedThrough)}` : '…'}`}
        title={headline}
        lede="What needs management attention, the decisions in play and their governance, and what HELM has learned."
      >
        {d && (
          <button type="button" onClick={() => window.print()} className="mt-2 text-meta font-medium text-accent-700 hover:underline print:hidden">
            Print or save as PDF
          </button>
        )}
      </PageHeader>

      {ic.mode === 'demo' && (
        <Notice tone="neutral" label="Demo organization" className="mt-6">
          Meridian Vietnam is a fictional enterprise; nothing syncs to any real system. What you add lives in this tab until it is reloaded.
        </Notice>
      )}
      {firstCompose ? (
        <Notice tone="neutral" label="Memoire" className="mt-4">HELM is reading your Memoire opportunities and composing the first current state of the enterprise.</Notice>
      ) : rereading ? (
        <Notice tone="neutral" label="Newer state" className="mt-4">A newer current state has been composed. HELM is reading it; what is shown below is the one before it.</Notice>
      ) : catchingUp ? (
        // Audit 2026-10-12: for minutes after sign-in the page showed an older state's warnings as if they were today's.
        <Notice tone="neutral" label="Memoire" className="mt-4">
          Shown: the state as known on {readInstant(d!.current.snapshot.spec.lens.recordedThrough)}. HELM is {livePhase === 'composing' ? 'composing a newer state' : 'reading newer changes from Memoire'}; this page re-reads it when it is ready.
        </Notice>
      ) : (
        data?.note && <Notice tone="warning" label="Withheld" className="mt-4">{data.note}</Notice>
      )}

      <div className="mt-2 flex flex-wrap gap-10">
        <div className="min-w-0 flex-[1_1_560px]">
          {d && (
            // One line on where the commercial truth comes from: HELM reads it and never rebuilds Memoire's views of it.
            <p className="mt-8 max-w-reading text-dense text-ink-600">
              <span className="helm-label mr-2">Commercial truth</span>
              {opportunities} {opportunities === 1 ? 'opportunity' : 'opportunities'} read from {source}, as known on {readInstant(d.current.snapshot.spec.lens.recordedThrough)}.
              {ic.mode === 'cloud' && (
                <>
                  {' '}The forecast, deal changes and next steps are kept in Memoire.{' '}
                  <a href="https://www.memoire-official.com/app" target="_blank" rel="noreferrer" className="whitespace-nowrap font-medium text-accent-700 hover:underline">Open Memoire ↗</a>
                </>
              )}
            </p>
          )}

          {d && liveDecisions.length === 0 && urgent === 0 && look === 0 && (
            <EmptyState
              className="mt-8"
              title="No management decision is on record."
              detail="A decision in HELM holds the question, the alternatives and what each one costs elsewhere in the enterprise, who may decide, and what was expected — so it can be looked at again against what happened."
              action={<Button variant="primary" onClick={() => navigate('/decisions')}>Frame a decision</Button>}
            />
          )}

          {urgent > 0 && (
          <section className="mt-10">
            <SectionHead title="Cannot wait" meta={String(urgent)} caveat="management conditions, each with its cause" dot="warning" />
            <ul>
              {tiers.cannotWait.map((a) => {
                const { title, cause } = present(a);
                const act = actOn(a);
                const isOpen = openAttention === a.key;
                return (
                  <li key={a.key} className="border-b border-ink-200 py-5">
                    <Pill tone="open">{conditionName(conditionOf(a))}</Pill>
                    <h3 className="mt-2 max-w-reading font-serif text-signal text-ink-950">{title}</h3>
                    {cause && <p className="mt-1 max-w-reading text-read text-ink-700">{cause}</p>}
                    <p className="mt-2 flex flex-wrap gap-4 text-meta font-medium">
                      <Link to={act.to} className="text-accent-700 hover:underline">{act.label} →</Link>
                      <button type="button" onClick={() => setOpenAttention(isOpen ? null : a.key)} aria-expanded={isOpen} className="text-accent-700 hover:underline">{isOpen ? 'Hide why' : 'Why?'}</button>
                    </p>
                    {isOpen && whyBlock(a)}
                  </li>
                );
              })}
            </ul>
          </section>
          )}

          {look > 0 && (
          <section className="mt-10">
            <SectionHead title="Needs a look" meta={String(look)} caveat="management conditions, one line each" />
            <ul>
              {tiers.look.map((a) => {
                const act = actOn(a);
                const isOpen = openAttention === a.key;
                return (
                  <li key={a.key} className="border-b border-ink-200 py-3">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <Pill tone="accepted">{tiers.favourable.has(a.key) ? 'LANDED BETTER THAN COMMITTED' : conditionName(conditionOf(a))}</Pill>
                      {tiers.favourable.has(a.key) ? (
                        <span className="min-w-0 flex-1 text-dense text-ink-900">{present(a).title} {present(a).cause}</span>
                      ) : (
                        <Said text={String(st<string>(a, 'statement') ?? a.label)} className="min-w-0 flex-1 text-dense text-ink-900" />
                      )}
                      <span className="flex gap-3 text-meta font-medium">
                        <Link to={act.to} className="text-accent-700 hover:underline">Open</Link>
                        <button type="button" onClick={() => setOpenAttention(isOpen ? null : a.key)} aria-expanded={isOpen} className="text-accent-700 hover:underline">{isOpen ? 'Hide' : 'Why?'}</button>
                      </span>
                    </div>
                    {isOpen && whyBlock(a)}
                  </li>
                );
              })}
              {tiers.noAuthorityVerdict.length > 0 && (
                <li className="border-b border-ink-200 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <Pill tone="accepted">NO AUTHORITY VERDICT</Pill>
                    <span className="min-w-0 flex-1 text-dense text-ink-900">
                      {word(tiers.noAuthorityVerdict.length)} {tiers.noAuthorityVerdict.length === 1 ? 'commitment carries' : 'commitments carry'} no authority verdict:{' '}
                      {tiers.noAuthorityVerdict.map((a, i) => {
                        const id = decisionOfCondition(a);
                        const name = decisionTitle(id) ?? String(st<string>(a, 'statement') ?? a.label);
                        return (
                          <span key={a.key}>
                            {i > 0 ? '; ' : ''}
                            {id ? <Link to={`/decisions/${id}`} className="text-accent-700 hover:underline">{name}</Link> : name}
                          </span>
                        );
                      })}
                      .
                    </span>
                    <span className="flex gap-3 text-meta font-medium">
                      <Link to="/governance" className="text-accent-700 hover:underline">Governance</Link>
                      <button type="button" onClick={() => setOpenAttention(openAttention === 'authority' ? null : 'authority')} aria-expanded={openAttention === 'authority'} className="text-accent-700 hover:underline">{openAttention === 'authority' ? 'Hide' : 'Why?'}</button>
                    </span>
                  </div>
                  {openAttention === 'authority' && (
                    <p className="mt-3 max-w-reading border-l border-ink-300 pl-4 text-dense text-ink-700">
                      Each was committed, and no authority evaluation is recorded for it. Only HELM&rsquo;s trusted authority service records one, against the delegation-of-authority policy in force when the commitment was made; until it has, nobody — HELM included — can say whether the commitment was within authority. Nothing here undoes or questions the commitment itself.
                    </p>
                  )}
                </li>
              )}
            </ul>
          </section>
          )}

          {d?.trajectory && (
          <section className="mt-10">
            <SectionHead title="Now, against the committed future" meta={d?.trajectory ? (d.trajectory.relation === 'EXPECTED_VS_ACTUAL' ? 'period ended' : 'period running') : '…'} caveat="the distance is a fact, not a verdict" />
            {d?.trajectory && (
              <>
                <p className="mt-3 max-w-reading font-serif text-read italic text-ink-600">
                  {trajectoryDecision ? `“${trajectoryDecision}”. ` : ''}
                  {d.trajectory.statement}
                </p>
                <div className="mt-3 overflow-x-auto rounded-xl border border-ink-200 bg-white">
                  <table className="w-full min-w-[600px] border-collapse text-left">
                    <thead>
                      <tr className="border-b border-ink-200 helm-label"><th className="px-4 py-3">Position</th><th className="px-4 py-3 text-right">Now</th><th className="px-4 py-3 text-right">Committed future</th><th className="px-4 py-3 text-right">Distance</th><th className="px-4 py-3" /></tr>
                    </thead>
                    <tbody>
                      {d.trajectory.lines.map((l) => (
                        <tr key={`${l.nodeId}-${l.period}`} className="border-b border-ink-200 last:border-b-0">
                          <td className="px-4 py-3 text-dense text-ink-900">{l.label}<span className="block font-mono text-meta text-ink-500">{l.currentLayer?.toLowerCase() ?? '—'}{l.period ? ` · ${l.period}` : ''}</span></td>
                          <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-ui tabular" title={l.current ?? undefined}>{measure(l.current, l.unit, l.currency)}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-ui tabular text-ink-600" title={l.committed ?? undefined}>{measure(l.committed, l.unit, l.currency)}</td>
                          <td className={cn('whitespace-nowrap px-4 py-3 text-right font-mono text-dense', l.beyondMateriality ? 'text-red-700' : 'text-ink-600')}>
                            {displayDelta(l.difference, unitOf(l.unit), l.currency)}
                            {l.beyondMateriality ? <span className="block text-meta">beyond materiality</span> : null}
                          </td>
                          <td className="px-4 py-3 text-right"><button type="button" onClick={() => void explainLine(l)} className="text-meta font-medium text-accent-700 hover:underline">Why?</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {d.trajectory.unresolved.length > 0 && (
                  <ul className="mt-3 grid gap-1">
                    {d.trajectory.unresolved.map((u) => (
                      <li key={u.itemKey} className="text-dense text-ink-800">
                        <span className="font-mono text-meta text-red-700">{u.why}</span> · {u.label}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {why && (
              <div className="mt-4 rounded-xl border border-ink-200 bg-white px-5 py-4">
                <div className="flex items-baseline justify-between gap-3"><h3 className="font-serif text-panel">{why.title}</h3><button type="button" onClick={() => setWhy(null)} className="text-meta text-ink-500 hover:text-ink-900">close</button></div>
                <p className="mt-1 text-dense text-ink-700"><Said text={why.statement} /></p>
                <ol className="mt-3 grid gap-1">
                  {why.lines.map((l, i) => (
                    <li key={i} className="text-dense text-ink-800" style={{ paddingLeft: `${l.depth * 16}px` }}>
                      <span className="font-medium">{l.label}</span> <Said text={l.detail} className="font-mono text-meta text-ink-500" />
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </section>
          )}

          {liveDecisions.length > 0 && (
          <section className="mt-10">
            <SectionHead title="Decisions and governance" meta={String(liveDecisions.length)} caveat="visibility is not authority" />
            <ul>
              {liveDecisions.map((dec) => {
                const cid = String(st<string | null>(dec, 'commitmentId') ?? '');
                const gov = governance.get(cid) ?? [...governance.values()].find((g) => g.label === `Governance of ${dec.label}`);
                const gs = gov?.state as { state?: string; statement?: string } | undefined;
                const id = decisionIdOf(dec);
                return (
                  <li key={dec.key} className="border-b border-ink-200 py-3">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <Pill tone={dec.status === 'KNOWN' ? 'reviewed' : 'open'}>{String(st<string>(dec, 'decisionState') ?? st<string>(dec, 'state') ?? dec.status)}</Pill>
                      {gs?.state && <Pill tone={gs.state === 'AUTHORIZED' || gs.state === 'APPROVED' ? 'committed' : 'accepted'}>{gs.state.replaceAll('_', ' ')}</Pill>}
                      {id ? <Link to={`/decisions/${id}`} className="text-dense text-ink-900 hover:text-accent-700 hover:underline">{dec.label}</Link> : <span className="text-dense text-ink-900">{dec.label}</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 text-meta text-ink-600">{cancelledDecisions > 0 ? `${word(cancelledDecisions)} cancelled ${cancelledDecisions === 1 ? 'decision is' : 'decisions are'} kept on record in Decisions. ` : ''}Frame, weigh and commit in <Link to="/decisions" className="text-accent-700 underline">Decisions</Link>; see who must approve in <Link to="/governance" className="text-accent-700 underline">Governance</Link>.</p>
          </section>
          )}

          {((d?.claims.length ?? 0) > 0 || (d?.genome.patterns.length ?? 0) > 0 || (d?.counterfactuals.cases.length ?? 0) > 0) && (
          <section className="mt-10">
            <SectionHead title="What we believe, and what we have learned" caveat="a belief keeps its own evidence status" />
            <div className="mt-3 grid gap-6 md:grid-cols-2">
              <div>
                <p className="helm-label">Causal understanding</p>
                <ul className="mt-2 grid gap-2">
                  {(d?.claims ?? []).slice(0, 4).map((c) => (
                    <li key={c.claim.id} className="border-l border-ink-200 pl-3">
                      <Pill tone={statusTone(c.evaluation.status)}>{c.evaluation.status}</Pill>
                      <Link to={`/causal?claim=${encodeURIComponent(c.claim.id)}`} className="mt-1 block text-dense text-ink-900 hover:text-accent-700 hover:underline">{c.revision.statement}</Link>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-meta"><Link to="/causal" className="text-accent-700 underline">All causal claims →</Link></p>
              </div>
              <div>
                <p className="helm-label">Management memory</p>
                <ul className="mt-2 grid gap-2">
                  {(d?.genome.patterns ?? []).slice(0, 3).map((p) => (
                    <li key={p.pattern.id} className="border-l border-ink-200 pl-3">
                      <Pill tone={patternTone(p.status)}>{p.status}</Pill>
                      <Link to={`/genome?pattern=${encodeURIComponent(p.pattern.id)}`} className="mt-1 block text-dense text-ink-900 hover:text-accent-700 hover:underline">{p.pattern.title}</Link>
                    </li>
                  ))}
                  {(d?.counterfactuals.cases ?? []).slice(0, 2).map((c) => (
                    <li key={c.case.id} className="border-l border-ink-200 pl-3">
                      <Pill tone={caseTone(c.status)}>counterfactual · {c.status}</Pill>
                      <Link to="/counterfactuals" className="mt-1 block text-dense text-ink-900 hover:text-accent-700 hover:underline">{c.case.title}</Link>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-meta"><Link to="/genome" className="text-accent-700 underline">Genome →</Link> · <Link to="/counterfactuals" className="text-accent-700 underline">Counterfactual worlds →</Link></p>
              </div>
            </div>
          </section>
          )}
        </div>

        <aside className="w-full max-w-[360px] flex-[0_1_360px] pt-8">
          <SectionHead title="Management brief" size="section-sm" />
          <IntelligencePanel
            task="DRAFT_MANAGEMENT_BRIEF"
            params={{ ...(latestReview && latestReview.status === 'OPEN' ? { reviewId: latestReview.review.id } : {}), quarter }}
            viewer={viewer}
            label="Draft the management brief"
            detail={`What needs attention, the decisions in play${latestReview?.status === 'OPEN' ? `, the ${latestReview.review.periodLabel} review` : ''} and the commercial state HELM read — each statement grounded in what HELM holds.`}
          />
          <p className="mt-3 text-meta text-ink-600"><Link to="/reviews" className="text-accent-700 underline">Reviews →</Link> · <Link to="/decisions" className="text-accent-700 underline">Decisions →</Link></p>
        </aside>
      </div>

      {/* Full width: an answer that lists deals is a table (audit 2026-10-13: it was a narrow column of paragraphs). */}
      <section className="mt-12 max-w-[960px]">
        <SectionHead title="Ask HELM" size="section-sm" caveat="answers only from what HELM holds, as you" />
        <div className="mt-3"><AskHelm viewer={viewer} suggestions={suggestedQuestions(items)} /></div>
      </section>

      {ic.reviews.viewers.length > 1 && (
        <div className="mt-6 flex flex-wrap items-end gap-4">
          <label className="grid max-w-full grid-cols-[minmax(0,1fr)] gap-1">
            <span className="helm-label">Read as</span>
            <ReaderSelect className={select} viewers={ic.reviews.viewers} value={viewerKey} onChange={setViewerKey} />
          </label>
          <p className="max-w-reading pb-2 text-meta text-ink-500">Switch reader to see how clearance and decision visibility change what is shown — and what is withheld, said out loud.</p>
        </div>
      )}
      {d && (d.projection?.withheld.length ?? 0) > 0 && (
        <p className="mt-3 max-w-reading text-dense text-ink-700">
          Withheld from this reader: {d.projection!.withheld.map((w) => `${w.count} ${w.sensitivity.replaceAll('_', ' ').toLowerCase()} ${w.count === 1 ? 'item' : 'items'}`).join(', ')} — above their clearance, not absent.
        </p>
      )}
    </>
  );
}
