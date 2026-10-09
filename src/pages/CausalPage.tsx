/**
 * Causal graph — the Phase 8 technical instrument.
 *
 * What the enterprise has evidence to believe influences its outcomes, kept
 * visibly apart from what the model computes and from what merely moved
 * together. Every claim opens on "why do we believe this?": mechanism,
 * evidence for and against, scope, period, status and confidence under a named
 * policy, and how the belief changed. Nothing is ranked, weighted or totalled,
 * and HELM never proposes a cause.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ClaimExplanation, ClaimView, CorrelationFinding, EvidenceAssessment, ModelDependency, ProjectedCausalView, QuestionInvestigation, Traversal } from '@helm/causal-runtime';
import { IntelligencePanel } from '../components/intelligence/IntelligencePanel.tsx';
import { Link } from 'react-router-dom';
import { useHelmStore } from '../services/helmStore.ts';
import { cloudScope, demoScope } from '../services/ontologyGraph.ts';
import {
  claimsForViewer,
  correlationsView,
  dependenciesView,
  explainClaimView,
  pathsView,
  questionsView,
  resolveCausalContext,
  statusTone,
  type CausalContext,
} from '../services/causalRuntime.ts';
import { PageHeader } from '../components/ui/PageHeader.tsx';
import { ReaderSelect } from '../components/ui/ReaderSelect.tsx';
import { SectionHead } from '../components/ui/SectionHead.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { Notice } from '../components/ui/Notice.tsx';
import { FactRow } from '../components/ui/FactRow.tsx';
import { Pill } from '../components/ui/Pill.tsx';
import { cn } from '../lib/cn.ts';

const scopeText = (v: ClaimView): string =>
  v.claim.scope.kind === 'ANCHORED' ? v.claim.scope.anchors.map((a) => a.label).join(' / ') : `Enterprise-wide — ${v.claim.scope.justification}`;
const periodText = (p: { from: string | null; to: string | null }): string =>
  p.from === null && p.to === null ? 'open' : `${p.from?.slice(0, 10) ?? '…'} – ${p.to?.slice(0, 10) ?? '…'}`;
const edgeText = (v: ClaimView): string => `${v.cause.label} → ${v.claim.relationshipType} → ${v.effect.label}`;

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

function EvidenceList({ title, items }: { title: string; items: readonly EvidenceAssessment[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-4">
      <p className="helm-label">{title}</p>
      <ul className="mt-2 grid gap-3">
        {items.map((a) => (
          <li key={a.link.id} className="border-l border-ink-200 pl-3">
            <span className="block font-mono text-meta text-ink-500">
              {a.evidence.type} · counted {a.strength}
              {a.strength !== a.evidence.assessedStrength ? ` (assessed ${a.evidence.assessedStrength})` : ''}
            </span>
            <span className="block text-dense text-ink-900">{a.evidence.statement}</span>
            <span className="block text-meta text-ink-500">
              {a.evidence.provenance.sourceSystem} · {a.evidence.provenance.sourceReference} · asserted by {a.evidence.provenance.assertedByLabel} · {a.evidence.provenance.method}
            </span>
            {a.evidence.type === 'MANAGEMENT_EXPERTISE' && <span className="helm-caveat block">A person's judgement, not a measurement.</span>}
            {a.note && <span className={cn('block text-meta', a.temporal === 'TEMPORAL_CONFLICT' ? 'text-red-700' : 'text-ink-500')}>{a.note}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DependencyNote({ dependency }: { dependency: ModelDependency }) {
  return (
    <div className="mt-4 rounded-xl border border-ink-200 bg-white px-4 py-3">
      <Pill tone="computed">Known value dependency</Pill>
      <p className="mt-2 font-mono text-meta text-ink-600">{dependency.calculations.join(' → ')}</p>
      <p className="mt-1 text-dense text-ink-700">{dependency.statement}</p>
    </div>
  );
}

export function CausalPage() {
  const mode = useHelmStore((st) => st.mode);
  const activeOrgId = useHelmStore((st) => st.activeOrgId);
  const userId = useHelmStore((st) => st.userId);
  const myRole = useHelmStore((st) => st.myRole);
  const scope = useMemo(
    () => (mode === 'demo' ? demoScope() : activeOrgId ? cloudScope(activeOrgId, userId ?? '', myRole()) : null),
    [mode, activeOrgId, userId, myRole],
  );

  const [ctx, setCtx] = useState<CausalContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewerKey, setViewerKey] = useState('');
  const [lensKey, setLensKey] = useState('now');
  const [selected, setSelected] = useState<string | null>(null);
  // Async results are keyed by the inputs they were read for.
  const [claimsState, setClaimsState] = useState<{ key: string; value: ProjectedCausalView } | null>(null);
  const [questionsState, setQuestionsState] = useState<{ key: string; value: readonly QuestionInvestigation[] } | null>(null);
  const [depsState, setDepsState] = useState<{ key: string; value: readonly { claim: ClaimView; dependency: ModelDependency }[] } | null>(null);
  const [explainState, setExplainState] = useState<{ key: string; value: ClaimExplanation; paths: { up: Traversal; down: Traversal } } | null>(null);
  const [correlations, setCorrelations] = useState<readonly CorrelationFinding[]>([]);

  useEffect(() => {
    let live = true;
    if (!scope) return;
    void (async () => {
      try {
        const c = await resolveCausalContext(mode ?? 'demo', scope);
        if (!c) throw new Error('The causal graph is unavailable in this mode.');
        const corr = await correlationsView(c);
        if (!live) return;
        setCtx(c);
        setCorrelations(corr);
        setViewerKey(c.viewers.find((v) => v.key === 'countryGM')?.key ?? c.viewers[0]?.key ?? '');
        if (c.story) setSelected(c.story.claims.H1.claim.id);
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
        const claims = await claimsForViewer(ctx, viewer, lens);
        const questions = await questionsView(ctx, lens);
        const deps = await dependenciesView(ctx, claims.claims);
        if (!live) return;
        setClaimsState({ key, value: claims });
        setQuestionsState({ key, value: questions });
        setDepsState({ key, value: deps });
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [ctx, viewer, lens, key]);

  const claims = claimsState && claimsState.key === key ? claimsState.value : null;
  const visibleIds = useMemo(() => new Set(claims?.claims.map((v) => v.claim.id) ?? []), [claims]);
  const selectedVisible = selected !== null && visibleIds.has(selected);

  useEffect(() => {
    let live = true;
    if (!ctx || !selected || !selectedVisible) return;
    void (async () => {
      try {
        const ex = await explainClaimView(ctx, selected, lens);
        const paths = await pathsView(ctx, ex.view.claim.effectKey, lens);
        if (live) setExplainState({ key: `${selected}|${key}`, value: ex, paths });
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [ctx, selected, selectedVisible, lens, key]);

  if (error) return <EmptyState title="The causal graph could not be opened" detail={error} />;
  if (!ctx || !viewer) return <p className="text-ui text-ink-500">Reading the causal graph…</p>;

  const questions = questionsState && questionsState.key === key ? questionsState.value : [];
  const deps = depsState && depsState.key === key ? depsState.value : [];
  const explanation = explainState && explainState.key === `${selected}|${key}` && selectedVisible ? explainState : null;
  const select = 'max-w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-ui';
  const supported = claims?.claims.filter((v) => v.evaluation.status === 'SUPPORTED').length ?? 0;

  return (
    <>
      <PageHeader
        kicker="Kernel instrument · Causal graph"
        size="instrument"
        title="Enterprise causal graph"
        lede="What the enterprise has evidence to believe influences its outcomes — each belief scoped, its evidence for and against shown, judged under a named policy, and kept apart from what the model computes and from what merely moved together. Nothing is ranked, weighted or totalled, and HELM never proposes a cause."
      />

      {ctx.story && (
        <Notice tone="neutral" label="Demo causal hypotheses" className="mt-6">
          The invoices, ledgers, analyses and judgements below are illustrative. None came from a company's books; they enter HELM exactly as
          real evidence would, and every one is labelled DEMO at its source.
        </Notice>
      )}

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
        <div className="flex flex-wrap items-center gap-2 pb-2">
          <Pill tone="computed">Known value dependency</Pill>
          <Pill tone="hypothesis">Causal hypothesis</Pill>
          <Pill tone="supported">Supported claim</Pill>
          <Pill tone="contested">Contested claim</Pill>
          <Pill tone="correlation">Correlation</Pill>
        </div>
      </div>

      <div className="mt-9 flex flex-wrap gap-10">
        <div className="min-w-0 flex-[1_1_560px]">
          <section>
            <SectionHead title="Questions" meta={`${questions.length}`} caveat="candidates are claims people proposed; HELM never proposes one" />
            {questions.length === 0 && (
              <p className="mt-3 max-w-reading text-ui text-ink-500">
                No causal question has been asked at this point in time. A question is a person&rsquo;s — usually raised when an
                outcome differs from what a commitment expected. It starts from a decision in{' '}
                <Link to="/decisions" className="text-accent-700 underline">Decisions</Link>; HELM never proposes a cause.
              </p>
            )}
            <ul>
              {questions.map((q) => (
                <li key={q.question.id} className="border-b border-ink-200 py-4">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Pill tone={q.status === 'SUPPORTED_EXPLANATION_EXISTS' ? 'supported' : 'hypothesis'}>{q.status}</Pill>
                    <p className="font-serif text-read">{q.question.statement}</p>
                  </div>
                  <p className={cn('mt-1 text-dense', q.status === 'OPEN' || q.status === 'UNRESOLVED' ? 'text-red-700' : 'text-ink-700')}>{q.statement}</p>
                  <ul className="mt-2">
                    {q.candidates.map((cand) => {
                      const hidden = !visibleIds.has(cand.view.claim.id);
                      return (
                        <Row key={cand.view.claim.id} onClick={hidden ? undefined : () => setSelected(cand.view.claim.id)} selected={selected === cand.view.claim.id}>
                          {hidden ? (
                            <span className="text-dense text-ink-500">A candidate withheld from this reader.</span>
                          ) : (
                            <div className="flex flex-wrap items-baseline gap-2">
                              <Pill tone={statusTone(cand.view.evaluation.status)}>{cand.view.evaluation.status}</Pill>
                              <span className="text-dense text-ink-900">{cand.view.revision.statement}</span>
                              <span className="font-mono text-meta text-ink-500">
                                {cand.via === 'QUESTION' ? 'proposed' : 'claim on this variable'} · {cand.applicability?.verdict ?? '—'}
                              </span>
                            </div>
                          )}
                        </Row>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-10">
            <SectionHead
              title="Claims"
              meta={claims ? `${claims.claims.length} visible · ${supported} supported · ${claims.withheld} withheld` : '…'}
              caveat="nothing is ranked, weighted or totalled"
            />
            {claims && claims.withheld > 0 && <p className="mt-3 text-dense text-ink-600">{claims.statement}</p>}
            <ul>
              {(claims?.claims ?? []).map((v) => (
                <Row key={v.claim.id} onClick={() => setSelected(v.claim.id)} selected={selected === v.claim.id}>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Pill tone={statusTone(v.evaluation.status)}>{v.evaluation.status}</Pill>
                    <span className="font-mono text-meta text-ink-600">{edgeText(v)}</span>
                  </div>
                  <p className="mt-1 text-dense text-ink-900">{v.revision.statement}</p>
                  <p className="mt-1 font-mono text-meta text-ink-500">
                    {scopeText(v)} · confidence {v.evaluation.confidence} · {v.evaluation.counts.supporting} for · {v.evaluation.counts.challenging + v.evaluation.counts.contradicting} against
                  </p>
                </Row>
              ))}
            </ul>
          </section>

          <section className="mt-10">
            <SectionHead title="Known value dependencies" meta={`${deps.length}`} caveat="arithmetic in the model — not evidence of influence" />
            <ul>
              {deps.map((d) => (
                <Row key={d.claim.claim.id}>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Pill tone="computed">Known value dependency</Pill>
                    <span className="font-mono text-meta text-ink-600">{d.dependency.fromMetricKey} → {d.dependency.toMetricKey}</span>
                  </div>
                  <p className="mt-1 font-mono text-meta text-ink-500">{d.dependency.calculations.join(' → ')}</p>
                  <p className="mt-1 text-dense text-ink-700">Shown beside the causal claim "{d.claim.revision.statement}", never counted in it.</p>
                </Row>
              ))}
            </ul>
          </section>

          <section className="mt-10">
            <SectionHead title="Correlations" meta={`${correlations.length}`} caveat="moved together — not a claim that one moves the other" />
            <ul>
              {correlations.map((f) => (
                <Row key={f.id}>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Pill tone="correlation">Correlation</Pill>
                    <span className="font-mono text-meta text-ink-600">{f.xKey} ~ {f.yKey} · {f.direction}</span>
                  </div>
                  <p className="mt-1 text-dense text-ink-900">{f.effectEstimate}</p>
                  <p className="mt-1 font-mono text-meta text-ink-500">{f.method} · {f.population} · {f.period} · uncertainty: {f.uncertainty}</p>
                  <p className="helm-caveat mt-1">{f.limitations}</p>
                </Row>
              ))}
            </ul>
          </section>
        </div>

        <aside className="w-full max-w-[360px] flex-[0_1_360px]">
          <SectionHead title="Why do we believe this?" size="section-sm" />
          {!explanation && <p className="mt-3 text-ui text-ink-500">Choose a claim to see its mechanism, its evidence for and against, where it holds and how the belief changed.</p>}
          {explanation && (() => {
            const ex = explanation.value;
            const v = ex.view;
            return (
              <div className="mt-3">
                <p className="font-serif text-read">{ex.question}</p>
                <p className="mt-2 text-dense text-ink-900">{v.revision.statement}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Pill tone={statusTone(v.evaluation.status)}>{v.evaluation.status}</Pill>
                  <span className="font-mono text-meta text-ink-600">confidence {v.evaluation.confidence} · {v.evaluation.policy}</span>
                </div>
                <p className={cn('mt-2 text-dense', v.evaluation.status === 'SUPPORTED' ? 'text-ink-700' : 'text-red-700')}>{v.evaluation.reasons.join(' ')}</p>

                {ex.mechanism.length > 0 && (
                  <div className="mt-4">
                    <p className="helm-label">Mechanism</p>
                    <ol className="mt-2 grid gap-1">
                      {ex.mechanism.map((m, i) => (
                        <li key={i} className="text-dense text-ink-800">
                          <span className="font-mono text-meta text-ink-500">{m.variableKey ?? '—'}</span> {m.description}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                <EvidenceList title="Evidence supporting" items={ex.supporting} />
                <EvidenceList title="Evidence challenging" items={ex.challenging} />
                <EvidenceList title="Evidence contradicting" items={ex.contradicting} />
                <EvidenceList title="Context" items={ex.contextual} />

                <FactRow
                  className="mt-5"
                  facts={[
                    { label: 'Scope', value: scopeText(v) },
                    { label: 'Applicable period', value: periodText(ex.applicablePeriod), mono: true },
                    { label: 'Author', value: v.claim.authoredByLabel },
                  ]}
                />
                <IntelligencePanel task="SUMMARIZE_CAUSAL_EVIDENCE" params={{ causeKey: v.claim.causeKey, effectKey: v.claim.effectKey }} viewer={viewer} label="Summarize the evidence" detail="The evidence for and against every claim about this cause and effect, each keeping its own status. A hypothesis stays a hypothesis." />
                {ex.conditions.map((c, i) => <p key={i} className="mt-2 font-mono text-meta text-ink-600">{c.statement}</p>)}
                {ex.confounders.map((c) => (
                  <p key={c.variableKey} className="mt-2 text-dense text-ink-700">
                    <span className="font-mono text-meta">Possible confounder {c.variableKey}</span> — {c.note}
                  </p>
                ))}
                <p className="helm-caveat mt-3">{ex.externalValidity}</p>

                {ex.modelDependency && <DependencyNote dependency={ex.modelDependency} />}

                <div className="mt-5">
                  <p className="helm-label">How the belief changed</p>
                  <ol className="mt-2 grid gap-2">
                    {ex.history.map((h, i) => (
                      <li key={i} className="border-l border-ink-200 pl-3">
                        <span className="block font-mono text-meta text-ink-500">{h.recordedAt.slice(0, 16).replace('T', ' ')} · {h.status} · {h.confidence}</span>
                        <span className="block text-dense text-ink-800">{h.event}</span>
                      </li>
                    ))}
                  </ol>
                </div>

                <div className="mt-5">
                  <p className="helm-label">Paths around {v.effect.label}</p>
                  <ul className="mt-2 grid gap-1">
                    {[...explanation.paths.up.edges, ...explanation.paths.down.edges].map((e, i) => (
                      <li key={i} className="font-mono text-meta text-ink-600">
                        {e.from} → {e.relationshipType} → {e.to} · {e.status}
                        {e.closesCycle ? ' · closes a loop' : ''}
                      </li>
                    ))}
                  </ul>
                  <p className="helm-caveat mt-2">Traversal stops at depth 3. A path is as supported as its weakest claim; confidences are never multiplied.</p>
                </div>
              </div>
            );
          })()}
        </aside>
      </div>
    </>
  );
}
