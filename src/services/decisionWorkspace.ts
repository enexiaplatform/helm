/**
 * Read helpers for the Decision Workspace. Wiring and selection only — every
 * number shown comes from the runtime (criterion evaluations, trade-offs,
 * explanations); nothing here computes a value, a delta or a verdict.
 */

import type {
  CriterionEvaluation,
  Decision,
  DecisionAlternative,
  DecisionExplanation,
  DecisionRevision,
  DecisionWorkspace,
} from '@helm/decision-runtime';
import type { Result } from '@helm/shared';
import type { DecisionWorkspaceContext } from './decisionRuntime.ts';

export type DecisionListItem = {
  decision: Decision;
  revisions: readonly DecisionRevision[];
  latestRevision: DecisionRevision | null;
  committed: boolean;
};

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

export async function loadDecisions(ctx: DecisionWorkspaceContext): Promise<DecisionListItem[]> {
  const decisions = unwrap(await ctx.runtime.listDecisions(ctx.scope));
  const out: DecisionListItem[] = [];
  for (const decision of decisions) {
    const revisions = unwrap(await ctx.runtime.listRevisions(ctx.scope, decision.id));
    out.push({
      decision,
      revisions,
      latestRevision: revisions.length > 0 ? revisions[revisions.length - 1] : null,
      committed: decision.state === 'COMMITTED' || decision.state === 'EXECUTING' || decision.state === 'COMPLETED' || decision.state === 'REVIEWED',
    });
  }
  return out;
}

/** What a list row needs to say about a decision without opening it. Read, never computed. */
export type DecisionSummary = DecisionListItem & {
  /** The alternative management committed to, if it has. */
  chosenLabel: string | null;
  committedAt: string | null;
  committedByLabel: string | null;
  /** The latest outcome review, if the decision has been looked at again. */
  reviewedAt: string | null;
  openChallenges: number;
  unownedAssumptions: number;
};

export async function loadDecisionSummaries(ctx: DecisionWorkspaceContext): Promise<DecisionSummary[]> {
  const items = await loadDecisions(ctx);
  const out: DecisionSummary[] = [];
  for (const item of items) {
    const { workspace } = await loadWorkspace(ctx, item.decision.id);
    const commitment = workspace.commitment;
    const review = workspace.outcomeReviews.at(-1) ?? null;
    out.push({
      ...item,
      chosenLabel: commitment
        ? (workspace.alternatives.find((a) => a.id === commitment.chosenAlternativeId)?.label ?? null)
        : null,
      committedAt: commitment?.committedAt ?? null,
      committedByLabel: commitment?.committedByLabel ?? null,
      reviewedAt: review?.reviewedAt ?? null,
      openChallenges: workspace.challenges.filter((c) => c.status === 'OPEN').length,
      unownedAssumptions: workspace.assumptions.filter((a) => a.owner === null).length,
    });
  }
  return out;
}

export type WorkspaceView = {
  workspace: DecisionWorkspace;
  /** Present once something has been committed. */
  explanation: DecisionExplanation | null;
};

export async function loadWorkspace(
  ctx: DecisionWorkspaceContext,
  decisionId: string,
  revisionId?: string,
): Promise<WorkspaceView> {
  const workspace = unwrap(await ctx.runtime.getWorkspace(ctx.scope, decisionId, revisionId));
  const explained = await ctx.runtime.explainDecision(ctx.scope, decisionId);
  return { workspace, explanation: explained.ok ? explained.value : null };
}

/** The criterion × alternative matrix, in the order the page reads it. */
export type CriterionRow = {
  criterionId: string;
  cells: (CriterionEvaluation | undefined)[];
};

export function criterionMatrix(workspace: DecisionWorkspace): CriterionRow[] {
  return workspace.criteria.map((c) => ({
    criterionId: c.id,
    cells: workspace.alternatives.map((a) =>
      workspace.evaluations.find((e) => e.criterionId === c.id && e.alternativeId === a.id),
    ),
  }));
}

/** Alternatives in reading order: on the table first, withdrawn last. */
export function alternativeOrder(workspace: DecisionWorkspace): readonly DecisionAlternative[] {
  return [...workspace.alternatives].sort((a, b) => {
    const rank = (x: DecisionAlternative) => (x.status === 'WITHDRAWN' ? 1 : 0);
    return rank(a) - rank(b) || a.sort - b.sort;
  });
}

/** What each evidence item and challenge is about, for the reader. */
export function targetLabel(
  workspace: DecisionWorkspace,
  kind: string,
  id: string | null,
): string {
  if (kind === 'CONTEXT' || id === null) return 'the decision itself';
  return (
    workspace.alternatives.find((a) => a.id === id)?.label ??
    workspace.criteria.find((c) => c.id === id)?.name ??
    workspace.assumptions.find((a) => a.id === id)?.statement ??
    'something no longer on this revision'
  );
}

/** The scenario key behind an alternative, read from the frozen manifest or the runtime. */
export async function scenarioKeyOf(
  ctx: DecisionWorkspaceContext,
  alternative: DecisionAlternative,
): Promise<string | null> {
  if (!alternative.scenarioId) return null;
  const s = await ctx.scenarios.runtime.getScenario(ctx.scope, alternative.scenarioId);
  return s.ok ? (s.value?.key ?? null) : null;
}
