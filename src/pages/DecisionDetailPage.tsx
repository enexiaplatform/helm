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
 * docs/archive/decision-engine-assessment.md).
 */

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  CriterionEvaluation,
  DecisionAlternative,
  DecisionExplanation,
  DecisionWorkspace,
} from '@helm/decision-runtime';
import { useHelmStore } from '../services/helmStore.ts';
import { cloudScope, demoScope } from '../services/ontologyGraph.ts';
import { SectionHead } from '../components/ui/SectionHead.tsx';
import { FactRow } from '../components/ui/FactRow.tsx';
import { Pill, type PillTone } from '../components/ui/Pill.tsx';
import { Notice } from '../components/ui/Notice.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { IntelligencePanel } from '../components/intelligence/IntelligencePanel.tsx';
import { useDefaultViewer } from '../components/intelligence/useDefaultViewer.ts';
import { CommitmentBanner } from '../components/decision/CommitmentBanner.tsx';
import { CriteriaMatrix, type MatrixAlt, type MatrixCell, type MatrixRow } from '../components/decision/CriteriaMatrix.tsx';
import { AssumptionList } from '../components/decision/AssumptionList.tsx';
import { ChallengeList } from '../components/decision/ChallengeList.tsx';
import { DecisionAuthoring } from '../components/decision/DecisionAuthoring.tsx';
import { cn } from '../lib/cn.ts';
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
import {
  GovernancePanel,
  type ApprovalRequestView,
  type GovernanceView,
} from '../components/decision/GovernancePanel.tsx';
import {
  actingScope,
  loadApprovalRequest,
  loadGovernanceView,
  resolveGovernanceContext,
  type GovernanceContext,
} from '../services/authorityRuntime.ts';
import { asUserId, type Scope } from '@helm/shared';

/** "A — Expedite supply" → mark "A", label "Expedite supply". */
function splitMark(label: string, index: number): { mark: string; label: string } {
  const m = /^([A-Z])\s+—\s+(.+)$/.exec(label);
  return m ? { mark: m[1], label: m[2] } : { mark: String.fromCharCode(65 + index), label };
}

const OUTCOME_TONE: Record<string, PillTone> = {
  CONFIRMED: 'actual',
  PARTIALLY_CONFIRMED: 'accepted',
  DISPROVED: 'open',
  UNKNOWN: 'neutral',
};

function toCell(e: CriterionEvaluation | undefined): MatrixCell {
  if (!e) return { display: '—', outcome: 'NOT_ASSESSED' };
  const note = [e.confidence !== null ? `c ${displayConfidence(e.confidence)}` : null, e.assessment?.author.label ?? null]
    .filter(Boolean)
    .join(' · ');
  return e.assessment
    ? { display: readable(e.assessment.rating), judgement: e.assessment.rating, outcome: e.outcome, note, title: e.explanation }
    : { display: displayValue(e.value, e.unit, e.currency), outcome: e.outcome, note: note || undefined, title: e.explanation };
}

// ================================================================== page

export function DecisionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const aiViewer = useDefaultViewer();
  const mode = useHelmStore((s) => s.mode);
  const activeOrgId = useHelmStore((s) => s.activeOrgId);
  const userId = useHelmStore((s) => s.userId);
  const userEmail = useHelmStore((s) => s.userEmail);
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
        action={<Link to="/decisions">Back to decisions →</Link>}
      />
    );
  }
  if (!ctx || !workspace) {
    return <p className="text-ui text-ink-500">Opening the decision…</p>;
  }

  const { decision, revision, readiness, commitment } = workspace;
  const ordered = alternativeOrder(workspace);
  const modelled = ordered.filter((a) => a.status === 'MODELLED');
  const offMatrix = ordered.filter((a) => a.status !== 'MODELLED');
  const chosen = commitment ? workspace.alternatives.find((a) => a.id === commitment.chosenAlternativeId) : undefined;

  const alts: MatrixAlt[] = modelled.map((a) => ({
    ...splitMark(a.label, ordered.indexOf(a)),
    chosen: commitment?.chosenAlternativeId === a.id,
  }));
  const rows: MatrixRow[] = criterionMatrix(workspace).map(({ criterionId, cells }) => {
    const c = workspace.criteria.find((x) => x.id === criterionId)!;
    return {
      name: c.name,
      meta: [
        readable(c.style),
        c.threshold !== null ? c.threshold : null,
        c.required ? 'required' : null,
        c.author.label,
        c.demoPolicy ? 'demo management policy' : null,
      ]
        .filter(Boolean)
        .join(' · '),
      cells: modelled.map((a) => toCell(cells[workspace.alternatives.indexOf(a)])),
    };
  });

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-[14px] gap-y-2">
        <Link to="/decisions" className="text-dense font-medium">
          ← Decisions
        </Link>
        <span className="helm-label">Management · Decision</span>
        <span className="helm-meta">
          {[decision.scope || decision.title, `r${revision.revisionNumber}`].join(' · ')}
        </span>
      </div>
      <h1 className="mt-3 max-w-[900px] text-title">{decision.managementQuestion}</h1>
      <FactRow
        className="mt-5 border-b border-ink-200 pb-[22px]"
        facts={[
          { label: 'Owner', value: decision.owner?.label ?? 'nobody yet' },
          { label: 'State', value: readable(decision.state) },
          { label: 'Decide by', value: displayDate(decision.horizon.decisionDeadline), mono: true },
          { label: 'Look again on', value: displayDate(decision.horizon.reviewDate), mono: true },
          {
            label: 'Reversibility',
            value: `${readable(decision.reversibility)}${decision.reversalWindowDays ? ` · ${decision.reversalWindowDays} days` : ''}`,
          },
          {
            label: 'Triggered by',
            value: decision.triggerRefs.length > 0 ? decision.triggerRefs.map((t) => t.label).join(' · ') : readable(decision.triggerType),
          },
          { label: 'Commitment carries', value: 'no authority verdict — see governance below' },
        ]}
      />

      {commitment && chosen && (
        <div className="mt-7">
          <CommitmentBanner
            chosen={chosen.label}
            summary={commitment.summary}
            committedAt={displayInstant(commitment.committedAt)}
            by={`${commitment.committedByLabel} · ${readable(commitment.authorship)}`}
            fingerprint={commitment.fingerprint.slice(0, 12)}
          />
        </div>
      )}

      <Readiness readiness={readiness} />

      <IntelligencePanel task="SUMMARIZE_ASSUMPTIONS" params={{ decisionId: decision.id }} viewer={aiViewer} label="Summarize the unresolved assumptions" detail="The assumptions this decision rests on, which are unresolved or challenged, and the questions that would settle them, grounded in the decision's own records." />
      {commitment && <IntelligencePanel task="EXPLAIN_DECISION" params={{ decisionId: decision.id }} viewer={aiViewer} label="Explain why management chose this" detail="The rationale, the accepted trade-offs and the governance state: records, never a verdict on the decision." />}

      {/* ------------------------------------------------- why it is on the table */}
      <section className="mt-10">
        <SectionHead title="Why this is on the table" meta={`revision r${revision.revisionNumber} · ${readable(revision.state)}`} />
        <div className="mt-4 flex flex-wrap items-start gap-x-10 gap-y-6">
          <div className="grid min-w-0 flex-[1_1_480px] gap-3">
            <p className="max-w-reading text-read text-ink-800">{decision.context}</p>
            {decision.problem && <p className="max-w-reading text-base text-ink-600">{decision.problem}</p>}
            {decision.objectives.length > 0 && (
              <div>
                <p className="helm-label mb-1">Objectives</p>
                {decision.objectives.map((o) => (
                  <p key={o} className="border-t border-ink-200 py-2 text-base text-ink-700">
                    {o}
                  </p>
                ))}
              </div>
            )}
          </div>
          <dl className="grid min-w-[260px] flex-[0_1_340px] grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            {[
              ['Business time', displayInstant(decision.fork.effectiveAsOf)],
              ['Known through', displayInstant(decision.fork.recordedThrough)],
              ['Effective from', displayDate(decision.horizon.effectiveFrom)],
              ['Outcome by', displayDate(decision.horizon.expectedOutcomeHorizon)],
            ].map(([label, value]) => (
              <Fragment key={label}>
                <dt className="text-meta text-ink-500">{label}</dt>
                <dd className="text-right font-mono text-dense font-medium">{value}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
        {workspace.revisions.length > 1 && (
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <span className="helm-label mr-1">Revisions</span>
            {workspace.revisions.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setRevisionId(r.id)}
                title={r.reconsiderationReason ?? readable(r.reason)}
                className={cn(
                  'rounded-lg px-[10px] py-1 font-mono text-meta',
                  r.id === revision.id ? 'bg-accent-800 text-white' : 'bg-ink-100 text-ink-700 hover:bg-ink-200',
                )}
              >
                r{r.revisionNumber} · {readable(r.reason)}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* ------------------------------------------------------ the matrix */}
      <section className="mt-10">
        <SectionHead
          title="What each alternative does, on the criteria management wrote down"
          caveat="nothing is ranked, weighted or totalled"
        />
        {alts.length > 0 ? (
          <CriteriaMatrix alternatives={alts} rows={rows} />
        ) : (
          <p className="mt-4 text-base text-ink-600">No alternative has a computed future yet, so there is nothing to read against the criteria.</p>
        )}
        {offMatrix.map((a) => (
          <p key={a.id} className="mt-3 text-dense text-ink-500">
            <span className="font-medium text-ink-700">{a.label}</span> is on the table but {readable(a.status)}
            {a.unmodelledReason ? ` — ${a.unmodelledReason}` : '.'}
          </p>
        ))}
      </section>

      {workspace.tradeOffs && <TradeOffs workspace={workspace} />}

      {/* ---------------------------------------- assumptions and challenges */}
      <div className="mt-11 flex flex-wrap items-start gap-10">
        <section className="min-w-0 flex-[1_1_440px]">
          <SectionHead title="What this rests on" caveat="who stands behind each" />
          {workspace.assumptions.length === 0 ? (
            <p className="mt-3 text-base text-ink-600">No assumptions have been written down.</p>
          ) : (
            <AssumptionList
              items={workspace.assumptions.map((a) => ({
                id: a.id,
                statement: a.statement,
                owner: a.owner?.label ?? null,
                criticality: a.criticality,
                confidence: a.confidence,
                source: a.source || undefined,
                outcome:
                  a.outcome === 'PENDING'
                    ? undefined
                    : { word: a.outcome.replace('_', ' '), tone: OUTCOME_TONE[a.outcome] ?? 'neutral', note: a.outcomeNote },
              }))}
            />
          )}
        </section>
        <section className="min-w-0 flex-[1_1_360px]">
          <SectionHead title="Who disagreed" caveat="decision evidence" />
          {workspace.challenges.length === 0 ? (
            <p className="mt-3 text-base text-ink-600">Nobody has challenged anything here.</p>
          ) : (
            <ChallengeList
              items={workspace.challenges.map((c) => ({
                id: c.id,
                author: c.author.label,
                status: c.status,
                concern: c.concern,
                target: targetLabel(workspace, c.targetKind, c.targetId),
                resolution: c.resolution ?? undefined,
              }))}
            />
          )}
        </section>
      </div>

      <Evidence workspace={workspace} />

      {!commitment && revision.state === 'DRAFT' && (
        <DecisionAuthoring
          ctx={ctx}
          workspace={workspace}
          author={{ label: userEmail ?? 'Management', userId: userId ? asUserId(userId) : null }}
          onChanged={() => void reload(ctx, decision.id, revisionId)}
        />
      )}

      {commitment ? (
        <CommitmentRecord workspace={workspace} explanation={explanation} />
      ) : (
        <section className="mt-11">
          <SectionHead title="Commitment" />
          <p className="mt-3 max-w-reading text-base text-ink-600">
            Nothing has been committed. HELM shows what each alternative does and how each stands against the criteria
            management wrote down; choosing between them is a management act, recorded here when it happens.
          </p>
        </section>
      )}

      {commitment && scope && (
        <Governance
          scope={scope}
          mode={mode ?? 'demo'}
          commitmentId={commitment.id}
          onChanged={() => void reload(ctx, decision.id, revisionId)}
        />
      )}

      <Timeline workspace={workspace} />
    </>
  );
}

// ============================================================= governance

/**
 * Phase 6: was the commitment within authority, and what has been done about
 * it. Everything is read from the authority runtime; this component only
 * loads, shows and passes an act back.
 */
function Governance({ scope, mode, commitmentId, onChanged }: { scope: Scope; mode: 'demo' | 'cloud'; commitmentId: string; onChanged: () => void }) {
  const [gov, setGov] = useState<GovernanceContext | null>(null);
  const [view, setView] = useState<GovernanceView | null>(null);
  const [request, setRequest] = useState<ApprovalRequestView | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const refresh = useCallback(async (context: GovernanceContext) => {
    setView(await loadGovernanceView(context, commitmentId));
    setLoaded(true);
  }, [commitmentId]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const context = await resolveGovernanceContext(mode, scope);
        if (!live || !context) return;
        setGov(context);
        await refresh(context);
      } catch (e) {
        if (live) setFailure(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [mode, scope, refresh]);

  if (failure) return <Notice tone="error" label="Governance could not be read" className="mt-11">{failure}</Notice>;
  if (!gov || !loaded) return <p className="mt-11 text-ui text-ink-500">Reading the authority evaluation…</p>;

  return (
    <GovernancePanel
      view={view}
      identities={gov.demoIdentities.map((i) => ({ userId: i.userId, label: i.label, seat: i.seat }))}
      request={request}
      busy={busy}
      refusal={refusal}
      onOpenRequest={(id) => void loadApprovalRequest(gov, id).then(setRequest).catch((e) => setRefusal(String(e)))}
      onEvaluate={() => {
        setBusy(true);
        void gov.evaluate(asUserId(String(gov.scope.actorId)), commitmentId).then(async (r) => {
          setBusy(false);
          if (!r.ok) setRefusal(r.message);
          await refresh(gov);
          onChanged();
        });
      }}
      onAct={(requirementId, decision, comments, asUserId_) => {
        setBusy(true);
        setRefusal(null);
        const as = actingScope(gov, asUserId_ ? asUserId(asUserId_) : null);
        void gov.act(asUserId(String(as.actorId)), requirementId, decision, comments).then(async (r) => {
          setBusy(false);
          if (!r.ok) setRefusal(r.message);
          else setRequest(null);
          await refresh(gov);
          onChanged();
        });
      }}
    />
  );
}

// ============================================================== readiness

function Readiness({ readiness }: { readiness: DecisionWorkspace['readiness'] }) {
  const tone = readiness.state === 'READY' ? 'text-emerald-700' : readiness.state === 'READY_WITH_GAPS' ? 'text-amber-700' : 'text-red-700';
  return (
    <section className="mt-10">
      <SectionHead
        title="Is the preparation complete?"
        meta={<span className={cn('font-medium', tone)}>{readiness.state}</span>}
        caveat="procedural completeness only, never a judgement of the choice"
      />
      {readiness.gaps.length === 0 ? (
        <p className="mt-3 text-base text-ink-600">{readiness.statement || 'Nothing the procedure asks for is missing.'}</p>
      ) : (
        readiness.gaps.map((g, i) => (
          <div key={`${g.code}-${i}`} className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-4 border-b border-ink-200 py-[10px]">
            <span className={cn('font-mono text-[11px] font-semibold leading-5 tracking-[0.04em]', g.severity === 'BLOCKING' ? 'text-red-700' : 'text-amber-700')}>
              {g.severity}
            </span>
            <span className="text-dense text-ink-700">{g.message}</span>
          </div>
        ))
      )}
    </section>
  );
}

// ============================================================= trade-offs

type TradeLine = NonNullable<DecisionWorkspace['tradeOffs']>['columns'][number]['gains'][number];

function TradeOffs({ workspace }: { workspace: DecisionWorkspace }) {
  const space = workspace.tradeOffs!;
  const reference = workspace.alternatives.find((a) => a.id === space.referenceAlternativeId);
  const columns = space.columns.filter((c) => c.alternativeId !== space.referenceAlternativeId);
  const warnings = space.comparability.flatMap((c) => c.warnings.map((w, i) => ({ key: `${c.state.runId}-${i}`, text: `${c.state.label}: ${w}` })));
  return (
    <section className="mt-11">
      <SectionHead title="What each alternative gains, and what it gives up" caveat={`relative to ${reference?.label ?? 'the reference'}`} />
      <p className="mt-3 max-w-reading text-base text-ink-700">{space.statement}</p>
      <div className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-x-10 gap-y-7">
        {columns.map((c) => (
          <div key={c.alternativeId}>
            <p className="border-b border-ink-950 pb-2 font-serif text-panel font-medium">{c.alternativeLabel}</p>
            <Lines title="Gains" tone="text-emerald-700" lines={c.gains} />
            <Lines title="Gives up" tone="text-amber-700" lines={c.concessions} />
            <Lines title="Not comparable" tone="text-ink-500" lines={c.unresolved} />
          </div>
        ))}
      </div>
      {space.dominance.length > 0 && (
        <div className="mt-6">
          <p className="helm-label mb-1">Facts about the comparable criteria</p>
          {space.dominance.map((d, i) => (
            <p key={i} className="border-t border-ink-200 py-2 text-dense text-ink-700">
              {d.statement}
            </p>
          ))}
        </div>
      )}
      {warnings.length > 0 && (
        <Notice tone="warning" label="Read with care" className="mt-5">
          {warnings.map((w) => (
            <p key={w.key}>{w.text}</p>
          ))}
        </Notice>
      )}
    </section>
  );
}

function Lines({ title, tone, lines }: { title: string; tone: string; lines: readonly TradeLine[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="mt-3">
      <p className={cn('font-sans text-label font-medium uppercase', tone)}>{title}</p>
      {lines.map((l, i) => (
        <div key={`${l.label}-${i}`} title={l.note ?? ''} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-ink-100 py-[6px]">
          <span className="text-dense text-ink-700">{l.label}</span>
          <span className="text-right font-mono text-meta text-ink-800">
            {l.referenceValue ?? '—'} → {l.alternativeValue ?? '—'}
            {l.delta && <span className="block text-ink-500">{l.delta}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

// =============================================================== evidence

function Evidence({ workspace }: { workspace: DecisionWorkspace }) {
  if (workspace.evidence.length === 0) return null;
  return (
    <section className="mt-11">
      <SectionHead title="Evidence" caveat="what it bears on, and how" />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse">
          <thead>
            <tr>
              {['Evidence', 'Bears on', 'How', 'Source', 'Known', 'Conf.'].map((h, i) => (
                <th key={h} className={cn('helm-label pb-2 pt-[14px] text-left', i > 0 && 'pl-3', i === 5 && 'text-right')}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {workspace.evidence.map((e) => (
              <tr key={e.id} className="border-t border-ink-200 align-top">
                <td className="py-3 pr-3">
                  <span className="block text-ui font-medium">{e.title}</span>
                  <span className="helm-meta">{e.kind}</span>
                </td>
                <td className="py-3 pl-3 text-dense text-ink-700">{targetLabel(workspace, e.targetKind, e.targetId)}</td>
                <td className="py-3 pl-3">
                  <Pill tone={e.relation === 'CHALLENGE' || e.relation === 'INVALIDATE' ? 'accepted' : 'neutral'}>{e.relation}</Pill>
                </td>
                <td className="py-3 pl-3 font-mono text-meta text-ink-600">
                  {e.sourceSystem}
                  {e.sourceRef && ` · ${e.sourceRef}`}
                </td>
                <td className="py-3 pl-3 font-mono text-meta text-ink-600">{displayInstant(e.recordedAt)}</td>
                <td className="py-3 pl-3 text-right font-mono text-dense">{displayConfidence(e.confidence)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ============================================================= commitment

function Rows({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-[6px] text-dense font-semibold">{label}</p>
      {children}
    </div>
  );
}

function CommitmentRecord({ workspace, explanation }: { workspace: DecisionWorkspace; explanation: DecisionExplanation | null }) {
  const c = workspace.commitment!;
  const fresh = explanation?.evidenceAfterCommitment ?? [];
  const snap = workspace.snapshot;
  return (
    <section className="mt-11">
      <SectionHead
        title="What management committed to, and why"
        meta={`${readable(c.authorship)} · ${displayInstant(c.committedAt)}`}
        caveat={`authority ${readable(c.authorityStatus)} on the commitment itself — judged separately, below`}
      />
      <div className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-x-10 gap-y-7">
        <Rows label="Why">
          {c.rationale.map((r, i) => (
            <p key={i} className="border-t border-ink-200 py-2 text-base text-ink-700">
              <span className="font-medium text-ink-950">{r.label}.</span> {r.statement}
            </p>
          ))}
        </Rows>
        <Rows label="What management accepted by choosing it">
          {c.acceptedTradeOffs.map((t, i) => (
            <div key={i} className="border-t border-ink-200 py-2">
              <p className="text-base text-ink-700">
                <span className="font-medium text-amber-800">{t.label}.</span> {t.statement}
              </p>
              {t.givenUp && (
                <p className="text-meta text-ink-500">
                  gave up {t.givenUp}
                  {t.inFavourOf && ` in favour of ${t.inFavourOf}`}
                </p>
              )}
            </div>
          ))}
        </Rows>
        <Rows label="Expected, from the future state it committed against">
          {c.expectedOutcomes.map((e, i) => (
            <div key={i} className="flex items-baseline justify-between gap-4 border-t border-ink-200 py-2">
              <span className="text-dense text-ink-600">{e.label}</span>
              <span className="text-right font-mono text-dense font-medium">
                {e.kind === 'MODELLED' ? displayValue(e.expectedValue, e.unit, e.currency) : e.statement}
              </span>
            </div>
          ))}
        </Rows>
        <Rows label="Look again when">
          {c.reviewTriggers.map((t) => (
            <p key={t.key} className="border-t border-ink-200 py-2 text-base text-ink-700">
              {t.description}
            </p>
          ))}
        </Rows>
      </div>

      {workspace.actionIntents.length > 0 && (
        <div className="mt-8">
          <Rows label="What is meant to happen next">
            {workspace.actionIntents.map((a) => (
              <div key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-4 border-t border-ink-200 py-2">
                <span className="text-base text-ink-800">{a.title}</span>
                <span className="helm-meta">
                  {a.ownerLabel} · {displayDate(a.dueDate)} · {a.targetSystem}
                </span>
              </div>
            ))}
            <p className="mt-2 text-meta text-ink-500">HELM records the intent. The system named beside each one does the work.</p>
          </Rows>
        </div>
      )}

      {snap && (
        <div className="mt-8">
          <Rows label="What was on the table, frozen">
            <p className="helm-meta">
              {snap.fingerprint} · captured {displayInstant(snap.capturedAt)} · known through {displayInstant(snap.fork.recordedThrough)}
            </p>
            <div className="mt-2">
              {snap.alternatives.map((a) => (
                <div key={a.alternativeId} className="flex flex-wrap items-baseline justify-between gap-x-4 border-t border-ink-200 py-2">
                  <span className={cn('text-dense', a.chosen ? 'font-semibold text-ink-950' : 'text-ink-700')}>
                    {a.label}
                    {a.chosen && ' ✓'}
                  </span>
                  <span className="helm-meta">{a.scenarioKey ? `${a.scenarioKey} · ${a.scenarioFingerprint}` : a.status}</span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-meta text-ink-500">
              {snap.criterionIds.length} criteria, {snap.assumptionIds.length} assumptions, {snap.evidenceIds.length} pieces of
              evidence, {snap.openChallenges.length} challenge{snap.openChallenges.length === 1 ? '' : 's'} still open when
              this was decided.
            </p>
          </Rows>
        </div>
      )}

      {fresh.length > 0 && (
        <Notice tone="after" label="Arrived after the commitment" className="mt-6">
          {fresh.map((e) => (
            <p key={e.id}>
              {e.title} <span className="font-mono text-meta text-accent-700">· {displayInstant(e.recordedAt)}</span>
            </p>
          ))}
          <p className="mt-1 text-meta text-accent-700">
            The record above is unchanged. Acting on this means reconsidering, which opens a new revision.
          </p>
        </Notice>
      )}

      {workspace.outcomeReviews.length > 0 && <OutcomeReviews workspace={workspace} />}
    </section>
  );
}

function OutcomeReviews({ workspace }: { workspace: DecisionWorkspace }) {
  return (
    <div className="mt-8">
      <Rows label="Expected against actual">
        {workspace.outcomeReviews.map((r) => (
          <div key={r.id} className="mb-5 last:mb-0">
            <p className="helm-meta">
              {r.reviewedByLabel} · {displayInstant(r.reviewedAt)}
            </p>
            <table className="mt-1 w-full border-collapse">
              <thead>
                <tr>
                  {['Value', 'Expected', 'Actual', 'Variance'].map((h, i) => (
                    <th key={h} className={cn('helm-label pb-2', i ? 'pl-3 text-right' : 'text-left')}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.variances.map((v, i) => (
                  <tr key={i} className="border-t border-ink-200">
                    <td className="py-[10px] text-dense text-ink-700">{v.label}</td>
                    <td className="py-[10px] pl-3 text-right font-mono text-dense text-ink-600">{v.expected ?? '—'}</td>
                    <td className="py-[10px] pl-3 text-right font-mono text-dense font-medium">{v.actual ?? '—'}</td>
                    <td className="py-[10px] pl-3 text-right font-mono text-dense font-medium">{v.variance ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {r.assumptionResults.map((a) => (
              <div key={a.assumptionId} className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 border-t border-ink-200 py-2">
                <Pill tone={OUTCOME_TONE[a.outcome] ?? 'neutral'}>{a.outcome.replace('_', ' ')}</Pill>
                <span className="font-serif text-base">
                  {a.statement}
                  {a.note && <span className="block font-sans text-meta text-ink-500">{a.note}</span>}
                </span>
              </div>
            ))}
            <p className="mt-3 font-serif text-read italic leading-[23px] text-ink-800">“{r.statement}”</p>
          </div>
        ))}
      </Rows>
    </div>
  );
}

// =============================================================== timeline

function Timeline({ workspace }: { workspace: DecisionWorkspace }) {
  return (
    <section className="mt-11">
      <SectionHead title="What happened, and when" meta={`${workspace.timeline.length} events`} />
      {workspace.timeline.map((e) => (
        <div key={e.id} className="grid grid-cols-[190px_minmax(0,1fr)] gap-x-4 border-b border-ink-200 py-2 max-sm:grid-cols-1">
          <span className="font-mono text-meta text-ink-500">{displayInstant(e.recordedAt)}</span>
          <span className="min-w-0 text-dense">
            <span className="font-medium text-ink-950">{readable(e.eventType)}</span>
            <span className="ml-2 break-words text-meta text-ink-500">{summarize(e.payload)}</span>
          </span>
        </div>
      ))}
    </section>
  );
}

const summarize = (payload: Readonly<Record<string, unknown>>): string =>
  Object.entries(payload)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`)
    .join(' · ');

export type { DecisionAlternative };
