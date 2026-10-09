/**
 * Management genome — the Phase 9 technical instrument.
 *
 * What the enterprise remembers of how it met situations: the beliefs it held,
 * how management decided and what happened — kept in two sections that never
 * judge each other. An episode is a container over immutable kernel records;
 * a pattern is a hypothesis a person proposed and HELM can check; a lesson is
 * authored, reviewed by someone else and inert. Nothing is ranked, scored or
 * totalled, no person is rated, and HELM never finds a pattern.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { featureNames, type EpisodeView, type FeatureName, type GenomeScope, type LessonView, type PatternCharacteristic, type PatternView, type ProjectedGenome, type SimilarSituations } from '@helm/genome-runtime';
import type { ClaimView } from '@helm/causal-runtime';
import { Link } from 'react-router-dom';
import type { TwinViewer } from '@helm/twin-runtime';
import { IntelligencePanel } from '../components/intelligence/IntelligencePanel.tsx';
import { useHelmStore } from '../services/helmStore.ts';
import { cloudScope, demoScope } from '../services/ontologyGraph.ts';
import { entityLabels, genomeForViewer, lessonTone, patternTone, resolveGenomeContext, similarView, stanceTone, type GenomeContext } from '../services/genomeRuntime.ts';
import { statusTone } from '../services/causalRuntime.ts';
import { PageHeader } from '../components/ui/PageHeader.tsx';
import { ReaderSelect } from '../components/ui/ReaderSelect.tsx';
import { SectionHead } from '../components/ui/SectionHead.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { Notice } from '../components/ui/Notice.tsx';
import { FactRow } from '../components/ui/FactRow.tsx';
import { Pill } from '../components/ui/Pill.tsx';
import { cn } from '../lib/cn.ts';

const scopeText = (s: GenomeScope): string => (s.kind === 'ANCHORED' ? s.anchors.map((a) => a.label).join(' / ') : `Enterprise-wide — ${s.justification}`);
const characteristicText = (c: PatternCharacteristic): string =>
  c.kind === 'OUTCOME_VS_EXPECTATION'
    ? `${c.kind} · ${c.metricKey} · ${c.direction}`
    : c.kind === 'ASSUMPTION_OUTCOME'
      ? `${c.kind} · ${c.criticality} assumption ${c.outcome}`
      : `${c.kind} · ${c.feature}`;
const conditionsText = (p: PatternView): string => {
  const parts = Object.entries(p.pattern.conditions).map(([k, v]) => `${k}: ${(v ?? []).join(', ')}`);
  return parts.length === 0 ? 'no conditions beyond its scope' : parts.join(' · ');
};
const day = (iso: string): string => iso.slice(0, 10);

type Selection = { readonly kind: 'episode' | 'pattern'; readonly id: string };

function Row({ children, onClick, selected }: { children: ReactNode; onClick?: () => void; selected?: boolean }) {
  return (
    <li
      className={cn('border-b border-ink-200 py-3', onClick && 'cursor-pointer transition-colors duration-160 ease-helm hover:bg-ink-50', selected && 'bg-ink-50')}
      onClick={onClick}
    >
      {children}
    </li>
  );
}

function BeliefList({ title, empty, items }: { title: string; empty: string; items: readonly ClaimView[] }) {
  return (
    <div className="mt-4">
      <p className="helm-label">{title}</p>
      {items.length === 0 && <p className="mt-2 text-dense text-ink-600">{empty}</p>}
      <ul className="mt-2 grid gap-2">
        {items.map((v) => (
          <li key={v.claim.id} className="border-l border-ink-200 pl-3">
            <span className="flex flex-wrap items-baseline gap-2">
              <Pill tone={statusTone(v.evaluation.status)}>{v.evaluation.status}</Pill>
              <span className="font-mono text-meta text-ink-500">recorded {day(v.claim.recordedAt)}</span>
            </span>
            <span className="block text-dense text-ink-900">{v.revision.statement}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProcessSection({ v }: { v: EpisodeView }) {
  const p = v.process;
  return (
    <div className="mt-4">
      <p className="helm-label">How management decided</p>
      <p className="mt-2 text-dense text-ink-900">
        Chose <span className="font-medium">{p.chosen ?? 'nothing yet'}</span>
        {p.rejected.length > 0 && <> over {p.rejected.join('; ')}</>}.
      </p>
      <p className="mt-1 font-mono text-meta text-ink-500">
        {p.alternatives.total} alternatives · {p.alternatives.modelled} modelled · {p.alternatives.unmodelled} not modelled · {p.criteria} criteria · {p.evidenceCount} evidence
      </p>
      <ul className="mt-2 grid gap-2">
        {p.assumptions.map((a) => (
          <li key={a.id} className="border-l border-ink-200 pl-3">
            <span className="block font-mono text-meta text-ink-500">
              {a.criticality} assumption · {a.confidence === null ? 'confidence not stated' : `confidence ${a.confidence}`}
            </span>
            <span className="block text-dense text-ink-900">{a.statement}</span>
            {a.owner === null ? (
              <span className="block text-meta text-red-700">nobody stands behind this</span>
            ) : (
              <span className="block text-meta text-ink-500">owner {a.owner}</span>
            )}
          </li>
        ))}
        {p.challenges.map((c) => (
          <li key={c.id} className="border-l border-ink-200 pl-3">
            <span className={cn('block font-mono text-meta', c.openAtCommitment ? 'text-red-700' : 'text-ink-500')}>
              challenge · {c.status}
              {c.openAtCommitment ? ' · open at commitment' : ''}
            </span>
            <span className="block text-dense text-ink-900">{c.statement}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OutcomeSection({ v }: { v: EpisodeView }) {
  const o = v.outcome;
  return (
    <div className="mt-5">
      <p className="helm-label">What happened</p>
      {o.reviews.length === 0 && <p className="mt-2 text-dense text-ink-600">No outcome review is known at this point in time. The episode is OPEN — not a judgement.</p>}
      {o.reviews.map((r) => (
        <div key={r.id} className="mt-2 border-l border-ink-200 pl-3">
          <span className="block font-mono text-meta text-ink-500">review {day(r.reviewedAt)}</span>
          {r.variances.map((x) => (
            <span key={x.label} className="block font-mono text-meta text-ink-700">
              {x.label}: expected {x.expected ?? '—'} · actual {x.actual ?? '—'} · variance {x.variance ?? '—'}
            </span>
          ))}
          {r.assumptionResults.map((a) => (
            <span key={a.assumptionId} className={cn('block text-dense', a.outcome === 'DISPROVED' ? 'text-red-700' : 'text-ink-800')}>
              <span className="font-mono text-meta">{a.outcome}</span> — {a.statement}
            </span>
          ))}
        </div>
      ))}
      {o.governance && (
        <p className="mt-2 font-mono text-meta text-ink-500">
          governance at commitment · {o.governance.state ?? '—'} · {o.governance.policyResult ?? '—'}
        </p>
      )}
    </div>
  );
}

function SimilarPanel({ ctx, episode, lensKey, labels }: { ctx: GenomeContext; episode: EpisodeView; lensKey: string; labels: ReadonlyMap<string, string> }) {
  const [require, setRequire] = useState<readonly FeatureName[]>(['decisionType', 'businessUnit']);
  const [state, setState] = useState<{ key: string; value: SimilarSituations } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lens = ctx.lenses.find((l) => l.key === lensKey)?.lens ?? null;
  const key = `${episode.episode.id}|${require.join(',')}|${lensKey}`;

  useEffect(() => {
    let live = true;
    if (require.length === 0) return;
    void (async () => {
      try {
        const r = await similarView(ctx, episode.episode.id, require, lens);
        if (live) {
          setState({ key, value: r });
          setError(null);
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [ctx, episode.episode.id, require, lens, key]);

  const toggle = (f: FeatureName) => setRequire((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]));
  const result = state && state.key === key ? state.value : null;
  const labelled = (vals: readonly string[]): string => vals.map((x) => labels.get(x) ?? x).join(', ') || '—';

  return (
    <div className="mt-6">
      <p className="helm-label">Have we seen a situation like this before?</p>
      <p className="mt-1 text-dense text-ink-600">Episodes that agree on every feature you tick — listed in the order they were decided, never by resemblance.</p>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {featureNames.map((f) => (
          <label key={f} className="flex items-center gap-1 font-mono text-meta text-ink-700">
            <input type="checkbox" checked={require.includes(f)} onChange={() => toggle(f)} />
            {f}
            {episode.episode.situation.notStated.includes(f) ? ' (not stated)' : ''}
          </label>
        ))}
      </div>
      {error && <p className="mt-2 text-dense text-red-700">{error}</p>}
      {require.length === 0 && <p className="mt-2 text-dense text-red-700">Tick at least one feature: similar to everything is not a question.</p>}
      {result && (
        <div className="mt-3">
          <p className="text-dense text-ink-700">{result.statement}</p>
          <ul className="mt-2">
            {result.episodes.map((s) => (
              <li key={s.view.episode.id} className="border-b border-ink-200 py-2">
                <span className="block text-dense text-ink-900">{s.view.episode.title}</span>
                <span className="block font-mono text-meta text-ink-500">
                  {s.agreements.map((a) => `${a.feature}: ${labelled(a.other)}`).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function EpisodeDetail({ ctx, v, lensKey, labels, viewer }: { ctx: GenomeContext; v: EpisodeView; lensKey: string; labels: ReadonlyMap<string, string>; viewer: TwinViewer | null }) {
  const sit = v.episode.situation;
  const labelled = (vals: readonly string[]): string => vals.map((x) => labels.get(x) ?? x).join(', ');
  return (
    <div className="mt-3">
      <p className="font-serif text-read">{v.managementQuestion}</p>
      <p className="mt-2 text-dense text-ink-900">{v.episode.title}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Pill tone={v.status === 'COMPLETED' ? 'reviewed' : 'neutral'}>{v.status}</Pill>
        {v.episode.sensitivityClasses.map((c) => <Pill key={c} tone="neutral">{c}</Pill>)}
      </div>
      <p className="helm-caveat mt-3">{v.statement}</p>

      <div className="mt-4">
        <p className="helm-label">The situation at the decision boundary</p>
        <FactRow
          className="mt-2"
          facts={featureNames.map((f) => ({
            label: f,
            value: sit.notStated.includes(f) ? 'not stated' : labelled(sit.values[f]) || 'none',
            mono: true,
          }))}
        />
        <p className="mt-2 font-mono text-meta text-ink-500">
          known through {v.episode.boundary.recordedThrough.slice(0, 16).replace('T', ' ')} · scope {scopeText(v.episode.scope)}
        </p>
      </div>

      <ProcessSection v={v} />
      <OutcomeSection v={v} />
      <BeliefList title="What management believed at the decision" empty="No causal belief was on record when management decided." items={v.causal.atDecision} />
      <BeliefList title="Claimed since — hindsight, kept apart" empty="No causal claim has been recorded since." items={v.causal.since} />

      <div className="mt-5">
        <p className="helm-label">Bears on</p>
        {v.patterns.length === 0 && <p className="mt-2 text-dense text-ink-600">No pattern has been linked to this episode.</p>}
        <ul className="mt-2 grid gap-1">
          {v.patterns.map((p) => (
            <li key={p.patternId} className="flex flex-wrap items-baseline gap-2">
              <Pill tone={stanceTone(p.stance)}>{p.stance}</Pill>
              <span className="text-dense text-ink-800">{p.title}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-5">
        <p className="helm-label">What might have happened otherwise</p>
        {v.counterfactuals.length === 0 && <p className="mt-2 text-dense text-ink-600">No counterfactual case reviews this episode's decision.</p>}
        <ul className="mt-2 grid gap-2">
          {v.counterfactuals.map((c) => (
            <li key={c.caseId} className="border-l border-ink-200 pl-3">
              <span className="flex flex-wrap items-baseline gap-2">
                <Pill tone={c.status === 'REVIEWED' ? 'reviewed' : 'counterfactual'}>{c.status}</Pill>
                <span className="text-dense text-ink-900">{c.title}</span>
              </span>
              <span className="block font-mono text-meta text-ink-500">asks about {c.interventionLabel} · {c.lenses.asKnownThen ? 'as known then' : 'no world then'} · {c.lenses.withHindsight ? 'with hindsight' : 'no hindsight world'} · {c.reviews} reading(s)</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-meta text-ink-600">Kept beside, never inside, how management decided and what happened. <Link to="/counterfactuals" className="text-accent-700 underline">Open the counterfactual worlds →</Link></p>
      </div>

      <SimilarPanel ctx={ctx} episode={v} lensKey={lensKey} labels={labels} />
      <IntelligencePanel task="FIND_SIMILAR_SITUATIONS" params={{ episodeId: v.episode.id, require: 'decisionType,businessUnit' }} viewer={viewer} label="Find similar situations" detail="Earlier episodes that agree on the features named, and the patterns they bear on, in the order they were decided. Recurrence is described and never certified." />
    </div>
  );
}

function PatternDetail({ p }: { p: PatternView }) {
  const group = (title: string, items: PatternView['supporting']) =>
    items.length === 0 ? null : (
      <div className="mt-4">
        <p className="helm-label">{title}</p>
        <ul className="mt-2 grid gap-2">
          {items.map((x) => (
            <li key={x.evidence.id} className="border-l border-ink-200 pl-3">
              <span className="flex flex-wrap items-baseline gap-2">
                <Pill tone={stanceTone(x.evidence.stance)}>{x.evidence.stance}</Pill>
                <span className="font-mono text-meta text-ink-500">HELM observed {x.evidence.observed}</span>
              </span>
              <span className="block text-dense text-ink-900">{x.episode.episode.title}</span>
              <span className="block text-meta text-ink-600">{x.evidence.rationale}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="mt-3">
      <p className="font-serif text-read">{p.revision.statement}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Pill tone={patternTone(p.status)}>{p.status}</Pill>
        <span className="font-mono text-meta text-ink-600">{p.policy} · revision {p.revision.revision}</span>
      </div>
      <p className={cn('mt-2 text-dense', p.status === 'CONTESTED' ? 'text-red-700' : 'text-ink-700')}>{p.reasons.join(' ')}</p>
      <FactRow
        className="mt-4"
        facts={[
          { label: 'Scope', value: scopeText(p.pattern.scope) },
          { label: 'Characteristic', value: characteristicText(p.pattern.characteristic), mono: true },
          { label: 'Conditions', value: conditionsText(p), mono: true },
          { label: 'Proposed by', value: p.pattern.authoredByLabel },
        ]}
      />
      <p className="mt-3 font-mono text-meta text-ink-500">
        covers {p.coverage.linked} of {p.coverage.matching} matching recorded episodes
        {p.coverage.unlinkedMatching.length > 0 ? ` · ${p.coverage.unlinkedMatching.length} not yet reviewed against it` : ''}
      </p>
      {group('Supporting episodes', p.supporting)}
      {group('Contradictory episodes', p.contradictory)}
      {group('Outside its scope — context only', p.contextual)}
      <p className="helm-caveat mt-4">What it does not show: {p.revision.limitations}</p>
      <p className="helm-caveat mt-2">{p.caveat}</p>
    </div>
  );
}

export function GenomePage() {
  const mode = useHelmStore((st) => st.mode);
  const activeOrgId = useHelmStore((st) => st.activeOrgId);
  const userId = useHelmStore((st) => st.userId);
  const myRole = useHelmStore((st) => st.myRole);
  const scope = useMemo(
    () => (mode === 'demo' ? demoScope() : activeOrgId ? cloudScope(activeOrgId, userId ?? '', myRole()) : null),
    [mode, activeOrgId, userId, myRole],
  );

  const [ctx, setCtx] = useState<GenomeContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewerKey, setViewerKey] = useState('');
  const [lensKey, setLensKey] = useState('now');
  const [selected, setSelected] = useState<Selection | null>(null);
  // Async results are keyed by the inputs they were read for.
  const [genomeState, setGenomeState] = useState<{ key: string; value: ProjectedGenome; labels: ReadonlyMap<string, string> } | null>(null);

  useEffect(() => {
    let live = true;
    if (!scope) return;
    void (async () => {
      try {
        const c = await resolveGenomeContext(mode ?? 'demo', scope);
        if (!c) throw new Error('The management genome is unavailable in this mode.');
        if (!live) return;
        setCtx(c);
        setViewerKey(c.viewers.find((v) => v.key === 'countryGM')?.key ?? c.viewers[0]?.key ?? '');
        if (c.story) setSelected({ kind: 'episode', id: c.story.episodes.E1.episode.id });
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [mode, scope]);

  const viewer = ctx?.viewers.find((v) => v.key === viewerKey)?.viewer ?? null;
  const lens = ctx?.lenses.find((l) => l.key === lensKey)?.lens ?? null;
  const key = `${viewerKey}|${lensKey}`;

  useEffect(() => {
    let live = true;
    if (!ctx || !viewer) return;
    void (async () => {
      try {
        const g = await genomeForViewer(ctx, viewer, lens);
        const ids = new Set<string>();
        for (const e of g.episodes) {
          for (const f of ['businessUnit', 'country'] as const) for (const id of e.episode.situation.values[f]) ids.add(id);
        }
        const labels = await entityLabels(ctx, [...ids]);
        if (live) setGenomeState({ key, value: g, labels });
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [ctx, viewer, lens, key]);

  if (error) return <EmptyState title="The management genome could not be opened" detail={error} />;
  if (!ctx || !viewer) return <p className="text-ui text-ink-500">Reading the management genome…</p>;

  const g = genomeState && genomeState.key === key ? genomeState.value : null;
  const labels = genomeState && genomeState.key === key ? genomeState.labels : new Map<string, string>();
  const episode = selected?.kind === 'episode' ? g?.episodes.find((e) => e.episode.id === selected.id) ?? null : null;
  const pattern = selected?.kind === 'pattern' ? g?.patterns.find((p) => p.pattern.id === selected.id) ?? null : null;
  const select = 'max-w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-ui';

  return (
    <>
      <PageHeader
        kicker="Kernel instrument · Management genome"
        size="instrument"
        title="Management genome"
        lede="What the enterprise remembers of how it met situations — the beliefs it held, how management decided and what happened, kept apart. A pattern is a hypothesis a person proposed and HELM can check; a lesson is authored, reviewed by someone else and inert. Nothing is ranked, scored or totalled, no person is rated, and HELM never finds a pattern."
      />

      {ctx.story && (
        <Notice tone="neutral" label="Demo management episodes" className="mt-6">
          The decisions, reviews, patterns and lessons below are illustrative. None came from a company's books; they enter HELM through the
          kernels exactly as real ones would, and every one is labelled DEMO at its source.
        </Notice>
      )}
      <Notice tone="neutral" label="Process is not outcome" className="mt-4">
        How management decided and what happened are shown apart. A good outcome does not make a decision well made, and a poor one does not
        make it badly made. HELM records both and judges neither.
      </Notice>

      <div className="mt-6 flex flex-wrap items-end gap-4">
        <label className="grid max-w-full grid-cols-[minmax(0,1fr)] gap-1">
          <span className="helm-label">Read as</span>
          <ReaderSelect className={select} viewers={ctx.viewers} value={viewerKey} onChange={setViewerKey} />
        </label>
        <label className="grid max-w-full grid-cols-[minmax(0,1fr)] gap-1">
          <span className="helm-label">As known on</span>
          <select className={select} value={lensKey} onChange={(e) => setLensKey(e.target.value)}>
            {ctx.lenses.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
          </select>
        </label>
      </div>

      <div className="mt-9 flex flex-wrap gap-10">
        <div className="min-w-0 flex-[1_1_560px]">
          <section>
            <SectionHead title="Episodes" meta={g ? `${g.episodes.length} visible · ${g.withheld.episodes} withheld` : '…'} caveat="one container per management experience" />
            {g && g.withheld.episodes + g.withheld.patterns + g.withheld.lessons > 0 && <p className="mt-3 text-dense text-ink-600">{g.statement}</p>}
            {g && g.episodes.length === 0 && (
              <p className="mt-3 max-w-reading text-ui text-ink-500">
                No episode is known at this point in time, or none is readable by this reader. An episode wraps a decision that
                was committed and whose outcome was reviewed — it starts in{' '}
                <Link to="/decisions" className="text-accent-700 underline">Decisions</Link>. Patterns and lessons rest on episodes.
              </p>
            )}
            <ul>
              {(g?.episodes ?? []).map((v) => (
                <Row key={v.episode.id} onClick={() => setSelected({ kind: 'episode', id: v.episode.id })} selected={selected?.kind === 'episode' && selected.id === v.episode.id}>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Pill tone={v.status === 'COMPLETED' ? 'reviewed' : 'neutral'}>{v.status}</Pill>
                    <span className="text-dense text-ink-900">{v.episode.title}</span>
                  </div>
                  <p className="mt-1 font-mono text-meta text-ink-500">
                    {v.episode.situation.values.decisionType.join(', ') || 'decision type not stated'} · {scopeText(v.episode.scope)} · decided under knowledge through{' '}
                    {day(v.episode.boundary.recordedThrough)}
                  </p>
                </Row>
              ))}
            </ul>
          </section>

          <section className="mt-10">
            <SectionHead title="Patterns" meta={g ? `${g.patterns.length} visible` : '…'} caveat="a description of what recurred — not a law, not a prediction" />
            {g && g.patterns.length === 0 && <p className="mt-3 text-ui text-ink-500">No pattern is readable by this reader at this point in time.</p>}
            <ul>
              {(g?.patterns ?? []).map((p) => (
                <Row key={p.pattern.id} onClick={() => setSelected({ kind: 'pattern', id: p.pattern.id })} selected={selected?.kind === 'pattern' && selected.id === p.pattern.id}>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Pill tone={patternTone(p.status)}>{p.status}</Pill>
                    <span className="text-dense text-ink-900">{p.pattern.title}</span>
                    {p.weak && <span className="font-mono text-meta text-ink-500">weak</span>}
                  </div>
                  <p className="mt-1 font-mono text-meta text-ink-500">
                    {characteristicText(p.pattern.characteristic)} · {scopeText(p.pattern.scope)}
                  </p>
                  <p className="mt-1 font-mono text-meta text-ink-500">
                    {p.supporting.length} supporting · {p.contradictory.length} contradictory · {p.contextual.length} outside its scope · proposed by {p.pattern.authoredByLabel}
                  </p>
                </Row>
              ))}
            </ul>
          </section>

          <section className="mt-10">
            <SectionHead title="Lessons" meta={g ? `${g.lessons.length} visible` : '…'} caveat="authored, reviewed by someone else, and inert" />
            {g && g.lessons.length === 0 && <p className="mt-3 text-ui text-ink-500">No lesson is readable by this reader at this point in time.</p>}
            <ul>
              {(g?.lessons ?? []).map((l: LessonView) => (
                <Row key={l.lesson.id}>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Pill tone={lessonTone(l.status)}>{l.status}</Pill>
                    <span className="text-dense text-ink-900">{l.lesson.claim}</span>
                  </div>
                  <p className="mt-1 font-mono text-meta text-ink-500">
                    rests on {l.evidence.map((e) => e.label).join('; ')} · written by {l.lesson.authoredByLabel}
                  </p>
                  {l.reviews.map((r) => (
                    <p key={r.id} className="mt-1 text-meta text-ink-600">
                      <span className="font-mono">{r.status}</span> by {r.reviewedByLabel} — {r.note}
                    </p>
                  ))}
                </Row>
              ))}
            </ul>
          </section>
        </div>

        <aside className="w-full max-w-[360px] flex-[0_1_360px]">
          <SectionHead title={selected?.kind === 'pattern' ? 'What the records say' : 'How did we decide, and what happened?'} size="section-sm" />
          {!episode && !pattern && <p className="mt-3 text-ui text-ink-500">Choose an episode to see its situation, how management decided and what happened — or a pattern to see the episodes it rests on.</p>}
          {episode && <EpisodeDetail ctx={ctx} v={episode} lensKey={lensKey} labels={labels} viewer={viewer} />}
          {pattern && <PatternDetail p={pattern} />}
        </aside>
      </div>
    </>
  );
}
