/**
 * The Decision Workspace — a technical instrument for the Phase 5 kernel, not
 * the GM cockpit.
 *
 * It answers, in order: what are we deciding, why now, what alternatives
 * exist, what future does each create, what matters, what is uncertain, what
 * are we accepting, what did we choose, and why. Every number comes from the
 * scenario future state the alternative references; every judgement has an
 * author; nothing here ranks, scores or suggests an option.
 *
 * Replaces the pre-kernel decision analysis (retired in Phase 5 — see
 * docs/architecture/decision-engine-assessment.md).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CircleAlert, History, Lock, MessageSquareWarning, ShieldQuestion } from 'lucide-react';
import type {
  CriterionEvaluation,
  DecisionAlternative,
  DecisionExplanation,
  DecisionWorkspace,
} from '@helm/decision-runtime';
import { useHelmStore } from '../services/helmStore.ts';
import { cloudScope, demoScope } from '../services/ontologyGraph.ts';
import { PanelCard, EmptyState } from '../components/ui.tsx';
import {
  displayConfidence,
  displayDate,
  displayInstant,
  displayValue,
  readable,
  resolveDecisionContext,
  type DecisionWorkspaceContext,
} from '../services/decisionRuntime.ts';
import { alternativeOrder, criterionMatrix, loadWorkspace, targetLabel } from '../services/decisionWorkspace.ts';

const stateTone: Record<string, string> = {
  DRAFT: 'bg-ink-100 text-ink-600',
  INVESTIGATING: 'bg-accent-100 text-accent-800',
  MODELLING: 'bg-violet-100 text-violet-800',
  READY_FOR_DECISION: 'bg-amber-100 text-amber-800',
  COMMITTED: 'bg-emerald-100 text-emerald-800',
  EXECUTING: 'bg-accent-100 text-accent-800',
  COMPLETED: 'bg-ink-100 text-ink-600',
  REVIEWED: 'bg-ink-100 text-ink-500',
  CANCELLED: 'bg-ink-100 text-ink-500',
};

const outcomeTone: Record<string, string> = {
  SATISFIED: 'text-emerald-700',
  MEETS_TARGET: 'text-emerald-700',
  VIOLATED: 'text-red-700',
  MISSES_TARGET: 'text-amber-700',
  STATED: 'text-ink-700',
  ASSESSED: 'text-violet-800',
  NOT_ASSESSED: 'text-ink-500',
  UNKNOWN: 'text-ink-500',
};

const ratingTone: Record<string, string> = {
  STRONG_SUPPORT: 'text-emerald-700',
  SUPPORT: 'text-emerald-600',
  NEUTRAL: 'text-ink-500',
  CONCERN: 'text-amber-700',
  STRONG_CONCERN: 'text-red-700',
};

const statusTone: Record<string, string> = {
  MODELLED: 'bg-emerald-50 text-emerald-800',
  UNMODELLED: 'bg-amber-50 text-amber-800',
  WITHDRAWN: 'bg-ink-100 text-ink-500',
};

function Chip({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`rounded px-1.5 py-0.5 text-2xs font-medium ${tone}`}>{children}</span>;
}

// ================================================================== page

export function DecisionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const mode = useHelmStore((s) => s.mode);
  const activeOrgId = useHelmStore((s) => s.activeOrgId);
  const userId = useHelmStore((s) => s.userId);
  const myRole = useHelmStore((s) => s.myRole);

  const [ctx, setCtx] = useState<DecisionWorkspaceContext | null>(null);
  const [workspace, setWorkspace] = useState<DecisionWorkspace | null>(null);
  const [explanation, setExplanation] = useState<DecisionExplanation | null>(null);
  const [revisionId, setRevisionId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const scope = useMemo(
    () => (mode === 'demo' ? demoScope() : activeOrgId ? cloudScope(activeOrgId, userId ?? '', myRole()) : null),
    [mode, activeOrgId, userId, myRole],
  );

  const reload = useCallback(
    async (context: DecisionWorkspaceContext, decisionId: string, revision?: string) => {
      try {
        const view = await loadWorkspace(context, decisionId, revision);
        setWorkspace(view.workspace);
        setExplanation(view.explanation);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  useEffect(() => {
    let live = true;
    if (!scope || !id) return;
    void (async () => {
      try {
        const context = await resolveDecisionContext(mode ?? 'demo', scope);
        if (!live || !context) {
          if (live) setError('The decision runtime is unavailable in this mode.');
          return;
        }
        setCtx(context);
        await reload(context, id, revisionId);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [mode, scope, id, revisionId, reload]);

  if (error) {
    return (
      <EmptyState
        title="This decision could not be opened"
        detail={error}
        action={
          <Link to="/decisions" className="btn-secondary">
            Back to decisions
          </Link>
        }
      />
    );
  }
  if (!ctx || !workspace) {
    return <p className="p-6 text-sm text-ink-500">Opening the decision…</p>;
  }

  const { decision, revision, readiness, commitment } = workspace;
  const alternatives = alternativeOrder(workspace);

  return (
    <div className="mx-auto max-w-6xl space-y-4 pb-16">
      <Link to="/decisions" className="inline-flex items-center gap-1 text-xs text-ink-500 hover:text-ink-800">
        <ArrowLeft className="h-3.5 w-3.5" /> Decisions
      </Link>

      {/* -------------------------------------------- the management question */}
      <header className="rounded-lg border border-ink-200 bg-white px-6 py-5 shadow-panel">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase leading-4 tracking-wide text-ink-500">
              Management question
            </p>
            <h1
              className="mt-2 tracking-display text-ink-950"
              style={{ font: 'var(--type-question)', textWrap: 'balance' }}
            >
              {decision.managementQuestion}
            </h1>
            <p className="mt-1.5 text-xs text-ink-500">
              {[decision.title, decision.scope].filter((x) => x).join(' · ')}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Chip tone={stateTone[decision.state] ?? 'bg-ink-100 text-ink-600'}>{readable(decision.state)}</Chip>
            <span className="text-2xs text-ink-500">
              authority {readable(decision.authorityStatus)} · Phase 6
            </span>
          </div>
        </div>
        <ReadinessStrip readiness={readiness} />
      </header>

      {/* ------------------------------------------------- decision context */}
      <PanelCard title="Context">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2 text-xs text-ink-700">
            <p>{decision.context}</p>
            <p className="text-ink-500">{decision.problem}</p>
            {decision.objectives.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-4 text-ink-600">
                {decision.objectives.map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ul>
            )}
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <Field label="Why now" value={`${readable(decision.triggerType)}`} />
            <Field label="Owner" value={decision.owner ? `${decision.owner.label}` : 'nobody yet'} />
            <Field label="Business time" value={displayInstant(decision.fork.effectiveAsOf)} />
            <Field label="Known through" value={displayInstant(decision.fork.recordedThrough)} />
            <Field label="Decide by" value={displayDate(decision.horizon.decisionDeadline)} />
            <Field label="Effective from" value={displayDate(decision.horizon.effectiveFrom)} />
            <Field label="Outcome by" value={displayDate(decision.horizon.expectedOutcomeHorizon)} />
            <Field label="Review on" value={displayDate(decision.horizon.reviewDate)} />
            <Field
              label="Reversibility"
              value={`${readable(decision.reversibility)}${
                decision.reversalWindowDays ? ` · ${decision.reversalWindowDays} days` : ''
              }`}
            />
            <Field label="Revision" value={`r${revision.revisionNumber} · ${readable(revision.state)}`} />
          </dl>
        </div>
        {decision.triggerRefs.length > 0 && (
          <p className="mt-3 border-t border-ink-100 pt-2 text-2xs text-ink-500">
            Triggered by {decision.triggerRefs.map((t) => `${t.label}`).join(' · ')}
          </p>
        )}
        {workspace.revisions.length > 1 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-2">
            <span className="text-2xs text-ink-500">Revisions:</span>
            {workspace.revisions.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setRevisionId(r.id)}
                className={`rounded px-1.5 py-0.5 text-2xs ${
                  r.id === revision.id ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-600 hover:bg-ink-200'
                }`}
                title={r.reconsiderationReason ?? readable(r.reason)}>
                r{r.revisionNumber} · {readable(r.reason)}
              </button>
            ))}
          </div>
        )}
      </PanelCard>

      {/* ------------------------- alternatives and the future-state comparison */}
      <PanelCard
        title="Alternatives and what each future does"
        action={
          <span className="text-2xs text-ink-500">
            every value read from the alternative&rsquo;s own simulation
          </span>
        }>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead>
              <tr className="border-b border-ink-200 align-bottom">
                <th className="w-56 py-2 pr-3 text-2xs font-semibold uppercase tracking-wide text-ink-500">
                  What management said matters
                </th>
                {alternatives.map((a) => (
                  <th key={a.id} className="px-2 py-2">
                    <span className="block font-semibold text-ink-900">{a.label}</span>
                    <span className="mt-0.5 flex items-center gap-1">
                      <Chip tone={statusTone[a.status] ?? 'bg-ink-100 text-ink-500'}>{readable(a.status)}</Chip>
                      {commitment?.chosenAlternativeId === a.id && (
                        <Chip tone="bg-emerald-600 text-white">chosen</Chip>
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {criterionMatrix(workspace).map(({ criterionId, cells }) => {
                const criterion = workspace.criteria.find((c) => c.id === criterionId)!;
                return (
                  <tr key={criterionId} className="border-b border-ink-100 align-top">
                    <th scope="row" className="py-2 pr-3 font-normal">
                      <span className="block font-medium text-ink-900">{criterion.name}</span>
                      <span className="text-2xs text-ink-500">
                        {readable(criterion.style)}
                        {criterion.threshold !== null && ` · ${criterion.threshold}`}
                        {criterion.required && ' · required'}
                      </span>
                      <span className="mt-0.5 block text-2xs text-ink-500">
                        {criterion.author.label}
                        {criterion.demoPolicy && ' · demo management policy'}
                      </span>
                    </th>
                    {cells.map((e, i) => (
                      <td key={alternatives[i].id} className="px-2 py-2">
                        <CriterionCell evaluation={e} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <ul className="mt-3 space-y-1 border-t border-ink-100 pt-2 text-2xs text-ink-500">
          {alternatives
            .filter((a) => a.status !== 'MODELLED')
            .map((a) => (
              <li key={a.id}>
                <span className="font-medium text-ink-700">{a.label}:</span> {a.unmodelledReason}
              </li>
            ))}
        </ul>
      </PanelCard>

      {/* ------------------------------------------------------- trade-offs */}
      {workspace.tradeOffs && <TradeOffPanel workspace={workspace} />}

      {/* ---------------------------------------- assumptions and challenges */}
      <div className="grid gap-4 lg:grid-cols-2">
        <AssumptionsPanel workspace={workspace} />
        <ChallengesPanel workspace={workspace} />
      </div>

      <EvidencePanel workspace={workspace} />

      {/* ------------------------------------------------------- commitment */}
      {commitment ? (
        <CommitmentPanel workspace={workspace} explanation={explanation} />
      ) : (
        <PanelCard title="Commitment">
          <p className="text-xs text-ink-500">
            Nothing has been committed. HELM shows what each alternative does and how each stands against the criteria
            management wrote down; choosing between them is a management act, recorded here when it happens.
          </p>
        </PanelCard>
      )}

      <TimelinePanel workspace={workspace} />
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-ink-500">{label}</dt>
      <dd className="text-right font-medium text-ink-800">{value}</dd>
    </>
  );
}

// ============================================================== readiness

function ReadinessStrip({ readiness }: { readiness: DecisionWorkspace['readiness'] }) {
  const tone =
    readiness.state === 'READY'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
      : readiness.state === 'READY_WITH_GAPS'
        ? 'border-amber-200 bg-amber-50 text-amber-900'
        : 'border-red-200 bg-red-50 text-red-900';
  return (
    <div className={`mt-3 rounded-md border px-3 py-2 ${tone}`}>
      <p className="flex items-center gap-1.5 text-xs font-semibold">
        <ShieldQuestion className="h-3.5 w-3.5" />
        {readable(readiness.state)}
        <span className="font-normal opacity-80">· procedural completeness only, never a judgement of the choice</span>
      </p>
      {readiness.gaps.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-2xs">
          {readiness.gaps.map((g, i) => (
            <li key={`${g.code}-${i}`}>
              <span className="font-mono opacity-70">{g.severity === 'BLOCKING' ? 'blocking' : 'gap'}</span> · {g.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ========================================================= criterion cell

function CriterionCell({ evaluation }: { evaluation: CriterionEvaluation | undefined }) {
  if (!evaluation) return <span className="text-ink-300">—</span>;
  const { outcome, value, unit, currency, confidence, assessment } = evaluation;
  return (
    <span className="block" title={evaluation.explanation}>
      <span className={`font-mono ${outcomeTone[outcome] ?? 'text-ink-700'}`}>
        {assessment ? (
          <span className={ratingTone[assessment.rating] ?? 'text-ink-600'}>{readable(assessment.rating)}</span>
        ) : (
          displayValue(value, unit, currency)
        )}
      </span>
      <span className={`mt-0.5 block text-2xs ${outcomeTone[outcome] ?? 'text-ink-500'}`}>{readable(outcome)}</span>
      {confidence !== null && <span className="block text-2xs text-ink-500">c {displayConfidence(confidence)}</span>}
      {assessment && <span className="block text-2xs text-ink-500">{assessment.author.label}</span>}
    </span>
  );
}

// ============================================================= trade-offs

function TradeOffPanel({ workspace }: { workspace: DecisionWorkspace }) {
  const space = workspace.tradeOffs!;
  const reference = workspace.alternatives.find((a) => a.id === space.referenceAlternativeId);
  const columns = space.columns.filter((c) => c.alternativeId !== space.referenceAlternativeId);
  return (
    <PanelCard
      title="What each alternative gains, and what it gives up"
      action={`relative to ${reference?.label ?? 'the reference'}`}>
      <p className="mb-3 rounded-md border border-ink-200 bg-ink-50 px-3 py-2 text-2xs text-ink-600">{space.statement}</p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {columns.map((c) => (
          <div key={c.alternativeId} className="rounded-md border border-ink-200 p-3">
            <p className="text-xs font-semibold text-ink-900">{c.alternativeLabel}</p>
            <Lines title="Gains" tone="text-emerald-700" lines={c.gains} />
            <Lines title="Gives up" tone="text-amber-800" lines={c.concessions} />
            <Lines title="Not comparable" tone="text-ink-500" lines={c.unresolved} />
          </div>
        ))}
      </div>
      {space.dominance.length > 0 && (
        <div className="mt-3 border-t border-ink-100 pt-2">
          <p className="text-2xs font-semibold uppercase tracking-wide text-ink-500">Facts about the comparable criteria</p>
          <ul className="mt-1 space-y-1 text-2xs text-ink-600">
            {space.dominance.map((d, i) => (
              <li key={i}>{d.statement}</li>
            ))}
          </ul>
        </div>
      )}
      {space.comparability.some((c) => c.warnings.length > 0) && (
        <ul className="mt-2 space-y-1 text-2xs text-amber-800">
          {space.comparability.flatMap((c) =>
            c.warnings.map((w, i) => (
              <li key={`${c.state.runId}-${i}`} className="flex items-start gap-1">
                <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  {c.state.label}: {w}
                </span>
              </li>
            )),
          )}
        </ul>
      )}
    </PanelCard>
  );
}

function Lines({
  title,
  tone,
  lines,
}: {
  title: string;
  tone: string;
  lines: DecisionWorkspace['tradeOffs'] extends null ? never : NonNullable<DecisionWorkspace['tradeOffs']>['columns'][number]['gains'];
}) {
  if (lines.length === 0) return null;
  return (
    <div className="mt-2">
      <p className={`text-2xs font-semibold uppercase tracking-wide ${tone}`}>{title}</p>
      <ul className="mt-0.5 space-y-0.5 text-2xs text-ink-600">
        {lines.map((l, i) => (
          <li key={`${l.label}-${i}`} title={l.note ?? ''}>
            {l.label}:{' '}
            <span className="font-mono">
              {l.referenceValue ?? '—'} → {l.alternativeValue ?? '—'}
            </span>
            {l.delta && <span className="text-ink-500"> ({l.delta})</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ============================================================ assumptions

function AssumptionsPanel({ workspace }: { workspace: DecisionWorkspace }) {
  return (
    <PanelCard title="What this rests on" action="who stands behind each">
      <ul className="space-y-2 text-xs">
        {workspace.assumptions.map((a) => (
          <li key={a.id} className="border-b border-ink-100 pb-2 last:border-0 last:pb-0">
            <p className="text-ink-800">{a.statement}</p>
            <p className="mt-0.5 text-2xs text-ink-500">
              {a.owner ? (
                <span className="text-ink-700">{a.owner.label}</span>
              ) : (
                <span className="text-amber-700">nobody stands behind this</span>
              )}
              {' · '}
              {readable(a.criticality)}
              {a.confidence !== null && ` · confidence ${displayConfidence(a.confidence)}`}
              {a.source && ` · ${a.source}`}
            </p>
            {a.outcome !== 'PENDING' && (
              <p className="mt-0.5 text-2xs">
                <Chip tone={a.outcome === 'DISPROVED' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'}>
                  {readable(a.outcome)}
                </Chip>{' '}
                <span className="text-ink-500">{a.outcomeNote}</span>
              </p>
            )}
          </li>
        ))}
        {workspace.assumptions.length === 0 && <li className="text-ink-500">No assumptions have been written down.</li>}
      </ul>
    </PanelCard>
  );
}

function ChallengesPanel({ workspace }: { workspace: DecisionWorkspace }) {
  return (
    <PanelCard
      title="Who disagreed"
      action="decision evidence, not a conversation">
      <ul className="space-y-2 text-xs">
        {workspace.challenges.map((c) => (
          <li key={c.id} className="border-b border-ink-100 pb-2 last:border-0 last:pb-0">
            <p className="flex items-center gap-1.5">
              <MessageSquareWarning className="h-3.5 w-3.5 text-amber-600" />
              <span className="font-medium text-ink-800">{c.author.label}</span>
              <Chip tone={c.status === 'OPEN' ? 'bg-amber-50 text-amber-800' : 'bg-ink-100 text-ink-600'}>
                {readable(c.status)}
              </Chip>
            </p>
            <p className="mt-0.5 text-ink-700">{c.concern}</p>
            <p className="mt-0.5 text-2xs text-ink-500">
              on {targetLabel(workspace, c.targetKind, c.targetId)}
              {c.resolution && ` — ${c.resolution}`}
            </p>
          </li>
        ))}
        {workspace.challenges.length === 0 && <li className="text-ink-500">Nobody has challenged anything here.</li>}
      </ul>
    </PanelCard>
  );
}

function EvidencePanel({ workspace }: { workspace: DecisionWorkspace }) {
  if (workspace.evidence.length === 0) return null;
  return (
    <PanelCard title="Evidence" action="what it bears on, and how">
      <table className="w-full text-left text-xs">
        <thead className="text-2xs text-ink-500">
          <tr>
            <th className="py-1">Evidence</th>
            <th>Bears on</th>
            <th>How</th>
            <th>Source</th>
            <th>Known</th>
            <th>Conf.</th>
          </tr>
        </thead>
        <tbody>
          {workspace.evidence.map((e) => (
            <tr key={e.id} className="border-t border-ink-100 align-top">
              <td className="py-1.5 pr-2">
                <span className="block text-ink-800">{e.title}</span>
                <span className="text-2xs text-ink-500">{readable(e.kind)}</span>
              </td>
              <td className="pr-2 text-ink-600">{targetLabel(workspace, e.targetKind, e.targetId)}</td>
              <td className="pr-2">
                <Chip
                  tone={
                    e.relation === 'CHALLENGE' || e.relation === 'INVALIDATE'
                      ? 'bg-amber-50 text-amber-800'
                      : 'bg-ink-100 text-ink-600'
                  }>
                  {readable(e.relation)}
                </Chip>
              </td>
              <td className="pr-2 text-ink-500">
                {e.sourceSystem}
                {e.sourceRef && ` · ${e.sourceRef}`}
              </td>
              <td className="pr-2 text-2xs text-ink-500">{displayInstant(e.recordedAt)}</td>
              <td className="font-mono text-2xs text-ink-500">{displayConfidence(e.confidence)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </PanelCard>
  );
}

// ============================================================= commitment

function CommitmentPanel({
  workspace,
  explanation,
}: {
  workspace: DecisionWorkspace;
  explanation: DecisionExplanation | null;
}) {
  const c = workspace.commitment!;
  const chosen = workspace.alternatives.find((a) => a.id === c.chosenAlternativeId);
  const fresh = explanation?.evidenceAfterCommitment ?? [];
  return (
    <PanelCard
      title={
        <span className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-emerald-700" /> What management committed to
        </span>
      }
      action={
        <span className="text-2xs text-ink-500" title={c.fingerprint}>
          {readable(c.authorship)} · {displayInstant(c.committedAt)}
        </span>
      }>
      <p className="text-sm font-medium text-ink-900">{chosen?.label}</p>
      <p className="mt-1 text-xs text-ink-700">{c.summary}</p>
      <p className="mt-1 text-2xs text-ink-500">
        by {c.committedByLabel} · authority {readable(c.authorityStatus)} — whether the actor was permitted is Phase 6&rsquo;s
        question, not this record&rsquo;s
      </p>

      <Section title="Why">
        <ul className="space-y-1 text-xs">
          {c.rationale.map((r, i) => (
            <li key={i}>
              <span className="font-medium text-ink-800">[{r.label}]</span> <span className="text-ink-700">{r.statement}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="What management accepted by choosing it">
        <ul className="space-y-1.5 text-xs">
          {c.acceptedTradeOffs.map((t, i) => (
            <li key={i} className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-amber-900">
              <span className="font-medium">{t.label}.</span> {t.statement}
              {t.givenUp && (
                <span className="mt-0.5 block text-2xs opacity-80">
                  gave up {t.givenUp}
                  {t.inFavourOf && ` in favour of ${t.inFavourOf}`}
                </span>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <div className="grid gap-4 md:grid-cols-2">
        <Section title="Expected, from the future state it committed against">
          <ul className="space-y-1 text-xs">
            {c.expectedOutcomes.map((e, i) => (
              <li key={i} className="flex items-baseline justify-between gap-2">
                <span className="text-ink-600">{e.label}</span>
                <span className="text-right font-mono text-ink-900">
                  {e.kind === 'MODELLED' ? displayValue(e.expectedValue, e.unit, e.currency) : e.statement}
                </span>
              </li>
            ))}
          </ul>
        </Section>
        <Section title="Look again when">
          <ul className="space-y-1 text-xs text-ink-700">
            {c.reviewTriggers.map((t) => (
              <li key={t.key}>{t.description}</li>
            ))}
          </ul>
        </Section>
      </div>

      {workspace.actionIntents.length > 0 && (
        <Section title="What is meant to happen next">
          <ul className="space-y-1 text-xs">
            {workspace.actionIntents.map((a) => (
              <li key={a.id} className="flex items-baseline justify-between gap-2">
                <span className="text-ink-800">{a.title}</span>
                <span className="shrink-0 text-2xs text-ink-500">
                  {a.ownerLabel} · {displayDate(a.dueDate)} · {a.targetSystem}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-2xs text-ink-500">
            HELM records the intent. The system named beside each one does the work.
          </p>
        </Section>
      )}

      {workspace.snapshot && (
        <Section title="What was on the table, frozen">
          <p className="text-2xs text-ink-500">
            <span className="font-mono">{workspace.snapshot.fingerprint}</span> · captured{' '}
            {displayInstant(workspace.snapshot.capturedAt)} · known through {displayInstant(workspace.snapshot.fork.recordedThrough)}
          </p>
          <ul className="mt-1 space-y-0.5 text-2xs text-ink-600">
            {workspace.snapshot.alternatives.map((a) => (
              <li key={a.alternativeId}>
                {a.chosen ? '✓ ' : '· '}
                {a.label} — {a.scenarioKey ? `${a.scenarioKey} · ${a.scenarioFingerprint}` : readable(a.status)}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-2xs text-ink-500">
            {workspace.snapshot.criterionIds.length} criteria, {workspace.snapshot.assumptionIds.length} assumptions,{' '}
            {workspace.snapshot.evidenceIds.length} pieces of evidence, {workspace.snapshot.openChallenges.length} challenge
            {workspace.snapshot.openChallenges.length === 1 ? '' : 's'} still open when this was decided.
          </p>
        </Section>
      )}

      {fresh.length > 0 && (
        <div className="mt-3 rounded-md border border-accent-200 bg-accent-50 px-3 py-2">
          <p className="text-2xs font-semibold text-accent-900">
            {fresh.length} piece{fresh.length === 1 ? '' : 's'} of evidence arrived after this was decided
          </p>
          <ul className="mt-0.5 space-y-0.5 text-2xs text-accent-900">
            {fresh.map((e) => (
              <li key={e.id}>
                {e.title} · {displayInstant(e.recordedAt)}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-2xs text-accent-800 opacity-80">
            The record above is unchanged. Acting on this means reconsidering, which opens a new revision.
          </p>
        </div>
      )}

      {workspace.outcomeReviews.length > 0 && <OutcomeReviews workspace={workspace} />}
    </PanelCard>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 border-t border-ink-100 pt-2">
      <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-500">{title}</p>
      {children}
    </div>
  );
}

function OutcomeReviews({ workspace }: { workspace: DecisionWorkspace }) {
  return (
    <Section title="Expected against actual">
      {workspace.outcomeReviews.map((r) => (
        <div key={r.id} className="mb-2 last:mb-0">
          <p className="text-2xs text-ink-500">
            {r.reviewedByLabel} · {displayInstant(r.reviewedAt)}
          </p>
          <table className="mt-1 w-full text-left text-xs">
            <thead className="text-2xs text-ink-500">
              <tr>
                <th className="py-1">Value</th>
                <th className="text-right">Expected</th>
                <th className="text-right">Actual</th>
                <th className="text-right">Variance</th>
              </tr>
            </thead>
            <tbody>
              {r.variances.map((v, i) => (
                <tr key={i} className="border-t border-ink-100">
                  <td className="py-1 text-ink-700">{v.label}</td>
                  <td className="text-right font-mono text-ink-600">{v.expected ?? '—'}</td>
                  <td className="text-right font-mono text-ink-900">{v.actual ?? '—'}</td>
                  <td className="text-right font-mono text-ink-700">{v.variance ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {r.assumptionResults.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-2xs text-ink-600">
              {r.assumptionResults.map((a) => (
                <li key={a.assumptionId}>
                  <Chip tone={a.outcome === 'DISPROVED' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'}>
                    {readable(a.outcome)}
                  </Chip>{' '}
                  {a.statement}
                  {a.note && ` — ${a.note}`}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-2xs text-ink-500">{r.statement}</p>
        </div>
      ))}
    </Section>
  );
}

// =============================================================== timeline

function TimelinePanel({ workspace }: { workspace: DecisionWorkspace }) {
  return (
    <PanelCard
      title={
        <span className="flex items-center gap-2">
          <History className="h-4 w-4" /> What happened, and when
        </span>
      }>
      <ol className="space-y-1 text-xs">
        {workspace.timeline.map((e) => (
          <li key={e.id} className="flex items-baseline gap-2">
            <span className="w-40 shrink-0 text-2xs text-ink-500">{displayInstant(e.recordedAt)}</span>
            <span className="font-medium text-ink-800">{readable(e.eventType)}</span>
            <span className="truncate text-2xs text-ink-500">{summarize(e.payload)}</span>
          </li>
        ))}
      </ol>
    </PanelCard>
  );
}

const summarize = (payload: Readonly<Record<string, unknown>>): string =>
  Object.entries(payload)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`)
    .join(' · ');

export type { DecisionAlternative };
