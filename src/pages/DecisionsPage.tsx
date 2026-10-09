/**
 * Decisions — the list of management questions this organization is deciding
 * or has decided.
 *
 * It shows the question, not a title; the state of the preparation, not an
 * approval status; and whether a commitment exists, not whether HELM likes it.
 * Rows are grouped by what they wait on, most urgent first. Opening one leads
 * to the Decision Workspace.
 *
 * Replaces the pre-kernel decision list (retired in Phase 5 — see
 * docs/archive/decision-engine-assessment.md).
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { DecisionState } from '@helm/decision-runtime';
import { useHelmStore } from '../services/helmStore.ts';
import { cloudScope, demoScope } from '../services/ontologyGraph.ts';
import { PageHeader } from '../components/ui/PageHeader.tsx';
import { SectionHead } from '../components/ui/SectionHead.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { DecisionRow, type DecisionRowView } from '../components/decision/DecisionRow.tsx';
import type { PillTone } from '../components/ui/Pill.tsx';
import { displayDate, readable, resolveDecisionContext, type DecisionWorkspaceContext } from '../services/decisionRuntime.ts';
import { FrameDecisionModal } from '../components/decision/DecisionAuthoring.tsx';
import { Button } from '../components/ui/Button.tsx';
import { asUserId } from '@helm/shared';
import { loadDecisionSummaries, type DecisionSummary } from '../services/decisionWorkspace.ts';
import { latestCommitmentId, resolveGovernanceContext } from '../services/authorityRuntime.ts';

const NUM = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const word = (n: number) => NUM[n] ?? String(n);
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const PREPARING: readonly DecisionState[] = ['DRAFT', 'INVESTIGATING', 'MODELLING', 'READY_FOR_DECISION'];

const TONE: Partial<Record<DecisionState, PillTone>> = {
  COMMITTED: 'committed',
  EXECUTING: 'committed',
  COMPLETED: 'committed',
  REVIEWED: 'reviewed',
};

/** Governance state per decision, for the note line. Read from the authority runtime. */
type Governed = Readonly<Record<string, { state: string; waitingOn: string[] }>>;

function note(d: DecisionSummary, governed: Governed): DecisionRowView['note'] {
  const g = governed[d.decision.id];
  if (g && (g.state === 'PENDING_APPROVAL' || g.state === 'ESCALATED')) return { text: `Waiting on ${g.waitingOn.join(' and ')} approval`, alarm: true };
  if (g && ['NOT_AUTHORIZED', 'INDETERMINATE', 'REJECTED'].includes(g.state)) return { text: `Authority: ${g.state.replaceAll('_', ' ')}`, alarm: true };
  if (d.openChallenges > 0)
    return { text: `${word(d.openChallenges)} ${plural(d.openChallenges, 'challenge', 'challenges')} still open`, alarm: true };
  if (d.unownedAssumptions > 0)
    return {
      text: `${word(d.unownedAssumptions)} ${plural(d.unownedAssumptions, 'assumption', 'assumptions')} nobody stands behind`,
      alarm: true,
    };
  if (d.reviewedAt) return { text: 'Outcome recorded against what was expected' };
  if (d.committed) return { text: 'Waiting for its review date' };
  return undefined;
}

function toRow(d: DecisionSummary, governed: Governed): DecisionRowView {
  const { decision, latestRevision } = d;
  const dates = d.reviewedAt
    ? [
        { label: 'Committed', value: displayDate(d.committedAt) },
        { label: 'Reviewed', value: displayDate(d.reviewedAt) },
      ]
    : d.committed
      ? [
          { label: 'Committed', value: displayDate(d.committedAt) },
          { label: 'Look again on', value: displayDate(decision.horizon.reviewDate) },
        ]
      : [{ label: 'Decide by', value: displayDate(decision.horizon.decisionDeadline) }];
  return {
    id: decision.id,
    question: decision.managementQuestion,
    line: d.chosenLabel ? `Committed to ${d.chosenLabel}` : `Not committed — ${readable(decision.state)}`,
    meta: [
      decision.scope || decision.title,
      readable(decision.triggerType),
      decision.owner?.label ?? 'no owner',
      latestRevision ? `r${latestRevision.revisionNumber}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
    state: decision.state.replaceAll('_', ' '),
    tone: TONE[decision.state] ?? 'neutral',
    dates,
    note: note(d, governed),
  };
}

export function DecisionsPage() {
  const navigate = useNavigate();
  const mode = useHelmStore((s) => s.mode);
  const activeOrgId = useHelmStore((s) => s.activeOrgId);
  const userId = useHelmStore((s) => s.userId);
  const userEmail = useHelmStore((s) => s.userEmail);
  const myRole = useHelmStore((s) => s.myRole);
  const [items, setItems] = useState<DecisionSummary[] | null>(null);
  const [ctx, setCtx] = useState<DecisionWorkspaceContext | null>(null);
  const [framing, setFraming] = useState(false);
  const [governed, setGoverned] = useState<Governed>({});
  const [error, setError] = useState<string | null>(null);

  const scope = useMemo(
    () => (mode === 'demo' ? demoScope() : activeOrgId ? cloudScope(activeOrgId, userId ?? '', myRole()) : null),
    [mode, activeOrgId, userId, myRole],
  );

  useEffect(() => {
    let live = true;
    if (!scope) return;
    void (async () => {
      try {
        // Governance first: in the demo it also seeds the governance proof decisions.
        const gov = await resolveGovernanceContext(mode ?? 'demo', scope).catch(() => null);
        const ctx = await resolveDecisionContext(mode ?? 'demo', scope);
        if (!live) return;
        if (!ctx) {
          setError('The decision runtime is unavailable in this mode.');
          return;
        }
        setCtx(ctx);
        const loaded = await loadDecisionSummaries(ctx);
        const states: Record<string, { state: string; waitingOn: string[] }> = {};
        if (gov) {
          for (const d of loaded.filter((x) => x.committed)) {
            const id = await latestCommitmentId(gov, d.decision.id);
            const s = id ? await gov.runtime.getGovernanceState(scope, id) : null;
            if (s?.ok) states[d.decision.id] = { state: s.value.state, waitingOn: s.value.requirements.filter((r) => !r.satisfied).map((r) => r.requirement.roleLabel) };
          }
        }
        if (live) {
          setGoverned(states);
          setItems(loaded);
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [mode, scope]);

  if (error) return <EmptyState title="Decisions could not be opened" detail={error} />;
  if (!items) return <p className="text-ui text-ink-500">Opening decisions…</p>;

  const preparing = items.filter((d) => PREPARING.includes(d.decision.state));
  const reviewed = items.filter((d) => d.decision.state === 'REVIEWED' || d.reviewedAt);
  const awaiting = items.filter((d) => d.committed && !reviewed.includes(d));
  const cancelled = items.filter((d) => d.decision.state === 'CANCELLED');
  const groups = [
    { title: 'Needs a decision', items: preparing },
    { title: 'Committed, awaiting review', items: awaiting },
    { title: 'Reviewed', items: reviewed },
    { title: 'Cancelled', items: cancelled },
  ];

  const sentences = [
    preparing.length > 0 &&
      `${word(preparing.length)} ${plural(preparing.length, 'question is', 'questions are')} still being prepared.`,
    awaiting.length > 0 &&
      `${word(awaiting.length)} ${plural(awaiting.length, 'commitment is waiting for its review.', 'commitments are waiting for their review.')}`,
    reviewed.length > 0 && `${word(reviewed.length)} ${plural(reviewed.length, 'has', 'have')} been looked at again.`,
  ].filter(Boolean);
  const headline = items.length === 0 ? 'No decision has been framed yet.' : sentences.join(' ') || 'Every decision here was cancelled.';
  const frame = ctx ? (
    <Button variant="primary" onClick={() => setFraming(true)}>
      Frame a decision
    </Button>
  ) : null;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <PageHeader
          kicker="Management · Decisions"
          title={headline}
          lede="One management question each — the alternatives considered, the futures computed for them, what mattered, who disagreed and what was committed. HELM preserves the reasoning; it does not do the deciding."
        />
        {items.length > 0 && frame}
      </div>
      {items.length === 0 ? (
        <EmptyState
          className="mt-9"
          title="No decisions yet"
          detail="A decision starts with a question — not a topic. Frame it here; bind the futures it chooses between now, or branch them on Scenarios first and add them as alternatives later."
          action={
            <span className="flex flex-wrap items-center gap-4">
              {frame}
              <Link to="/scenarios">Branch futures on Scenarios →</Link>
            </span>
          }
        />
      ) : (
        <div className="mt-9 grid gap-9">
          {groups
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <section key={g.title}>
                <SectionHead title={g.title} size="section-sm" meta={String(g.items.length)} />
                {g.items.map((d) => (
                  <DecisionRow key={d.decision.id} d={toRow(d, governed)} onOpen={(id) => navigate(`/decisions/${id}`)} />
                ))}
              </section>
            ))}
        </div>
      )}
      {framing && ctx && (
        <FrameDecisionModal
          ctx={ctx}
          author={{ label: userEmail ?? 'Management', userId: userId ? asUserId(userId) : null }}
          onClose={() => setFraming(false)}
          onFramed={(id) => {
            setFraming(false);
            navigate(`/decisions/${id}`);
          }}
        />
      )}
    </>
  );
}
