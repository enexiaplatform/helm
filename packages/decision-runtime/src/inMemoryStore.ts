/**
 * InMemoryDecisionStore — decisions, revisions and everything they are made
 * of, in memory, held to the same contract as the Postgres adapter
 * (`runDecisionStoreConformanceSuite`).
 *
 * The immutability rules live HERE, not only in the runtime: a sealed revision
 * refuses every change whoever asks, a commitment and its snapshot are
 * write-once, and the timeline is append-only — the same guarantees the
 * database gives through its triggers.
 */

import { fail, ok, type Clock, type IdGen, type Scope } from '@helm/shared';
import {
  DecisionErrors,
  decisionTransitions,
  type ActionIntent,
  type CommitmentSnapshot,
  type CriterionAssessment,
  type Decision,
  type DecisionAlternative,
  type DecisionAssumption,
  type DecisionChallenge,
  type DecisionCommitment,
  type DecisionCriterion,
  type DecisionEvidence,
  type DecisionOutcomeReview,
  type DecisionRevision,
  type DecisionTimelineEvent,
  type ManagementWeighting,
} from './types.ts';
import type { DecisionStore } from './port.ts';

export type InMemoryDecisionStoreOptions = { clock: Clock; idGen: IdGen };

export function createInMemoryDecisionStore(opts: InMemoryDecisionStoreOptions): DecisionStore {
  const { clock, idGen } = opts;
  const decisions = new Map<string, Decision>();
  const revisions = new Map<string, DecisionRevision>();
  const alternatives = new Map<string, DecisionAlternative>();
  const criteria = new Map<string, DecisionCriterion>();
  const assessments = new Map<string, CriterionAssessment>();
  const weightings = new Map<string, ManagementWeighting>();
  const assumptions = new Map<string, DecisionAssumption>();
  const challenges = new Map<string, DecisionChallenge>();
  const evidence = new Map<string, DecisionEvidence>();
  const commitments = new Map<string, DecisionCommitment>();
  const snapshots = new Map<string, CommitmentSnapshot>();
  const intents = new Map<string, ActionIntent>();
  const reviews = new Map<string, DecisionOutcomeReview>();
  const events = new Map<string, DecisionTimelineEvent>();

  const now = () => clock.now().toISOString();
  const mine = <T extends { orgId: string }>(scope: Scope, row: T | undefined): T | null =>
    row && row.orgId === scope.orgId ? row : null;

  /** Every write into a revision goes through this. A sealed revision is history. */
  const draftRevision = (scope: Scope, revisionId: string) => {
    const r = mine(scope, revisions.get(revisionId));
    if (!r) return { error: fail(DecisionErrors.NOT_FOUND, `Decision revision ${revisionId} not found.`) };
    if (r.state === 'SEALED') {
      return {
        error: fail(
          DecisionErrors.REVISION_SEALED,
          `Revision ${r.revisionNumber} is sealed: its basis is what management saw, and it does not change. Open a new revision.`,
        ),
      };
    }
    return { revision: r };
  };

  const byRevision = <T extends { orgId: string; revisionId: string }>(
    scope: Scope,
    map: Map<string, T>,
    revisionId: string,
  ): readonly T[] => [...map.values()].filter((x) => x.orgId === scope.orgId && x.revisionId === revisionId);

  return {
    // ------------------------------------------------------------ decisions
    async createDecision(scope, input) {
      const at = now();
      const d: Decision = { ...input, id: idGen.next(), orgId: scope.orgId, createdAt: at, updatedAt: at };
      decisions.set(d.id, d);
      return ok(d);
    },

    async getDecision(scope, id) {
      return ok(mine(scope, decisions.get(id)));
    },

    async listDecisions(scope) {
      return ok(
        [...decisions.values()]
          .filter((d) => d.orgId === scope.orgId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      );
    },

    async setDecisionState(scope, id, state) {
      const d = mine(scope, decisions.get(id));
      if (!d) return fail(DecisionErrors.NOT_FOUND, `Decision ${id} not found.`);
      if (d.state !== state && !decisionTransitions[d.state].includes(state)) {
        return fail(
          DecisionErrors.INVALID_TRANSITION,
          `A ${d.state} decision cannot become ${state}.`,
        );
      }
      const next = { ...d, state, updatedAt: now() };
      decisions.set(id, next);
      return ok(next);
    },

    async updateDecisionFraming(scope, id, patch) {
      const d = mine(scope, decisions.get(id));
      if (!d) return fail(DecisionErrors.NOT_FOUND, `Decision ${id} not found.`);
      if (d.state === 'COMMITTED' || d.state === 'EXECUTING' || d.state === 'COMPLETED' || d.state === 'REVIEWED') {
        return fail(
          DecisionErrors.COMMITMENT_IMMUTABLE,
          'The framing of a committed decision does not change: the question management answered is part of the record.',
        );
      }
      const next: Decision = { ...d, ...patch, updatedAt: now() };
      decisions.set(id, next);
      return ok(next);
    },

    // ------------------------------------------------------------ revisions
    async createRevision(scope, input) {
      const d = mine(scope, decisions.get(input.decisionId));
      if (!d) return fail(DecisionErrors.NOT_FOUND, `Decision ${input.decisionId} not found.`);
      const open = [...revisions.values()].find(
        (r) => r.orgId === scope.orgId && r.decisionId === input.decisionId && r.state === 'DRAFT',
      );
      if (open) {
        return fail(
          DecisionErrors.DRAFT_EXISTS,
          `Decision revision ${open.revisionNumber} is still open. Seal it before starting another.`,
        );
      }
      const r: DecisionRevision = { ...input, id: idGen.next(), orgId: scope.orgId, createdAt: now(), sealedAt: null };
      revisions.set(r.id, r);
      return ok(r);
    },

    async getRevision(scope, id) {
      return ok(mine(scope, revisions.get(id)));
    },

    async listRevisions(scope, decisionId) {
      return ok(
        [...revisions.values()]
          .filter((r) => r.orgId === scope.orgId && r.decisionId === decisionId)
          .sort((a, b) => a.revisionNumber - b.revisionNumber),
      );
    },

    async sealRevision(scope, id) {
      const r = mine(scope, revisions.get(id));
      if (!r) return fail(DecisionErrors.NOT_FOUND, `Decision revision ${id} not found.`);
      if (r.state === 'SEALED') return fail(DecisionErrors.REVISION_SEALED, `Revision ${r.revisionNumber} is already sealed.`);
      const next: DecisionRevision = { ...r, state: 'SEALED', sealedAt: now() };
      revisions.set(id, next);
      return ok(next);
    },

    // --------------------------------------------------------- alternatives
    async addAlternative(scope, input) {
      const guard = draftRevision(scope, input.revisionId);
      if (guard.error) return guard.error;
      const a: DecisionAlternative = { ...input, id: idGen.next(), orgId: scope.orgId, createdAt: now() };
      alternatives.set(a.id, a);
      return ok(a);
    },

    async setAlternativeBinding(scope, id, binding) {
      const a = mine(scope, alternatives.get(id));
      if (!a) return fail(DecisionErrors.NOT_FOUND, `Alternative ${id} not found.`);
      const guard = draftRevision(scope, a.revisionId);
      if (guard.error) return guard.error;
      const next: DecisionAlternative = { ...a, ...binding };
      alternatives.set(id, next);
      return ok(next);
    },

    async listAlternatives(scope, revisionId) {
      return ok(
        byRevision(scope, alternatives, revisionId)
          .slice()
          .sort((a, b) => a.sort - b.sort || a.createdAt.localeCompare(b.createdAt)),
      );
    },

    // -------------------------------------------------------------- criteria
    async addCriterion(scope, input) {
      const guard = draftRevision(scope, input.revisionId);
      if (guard.error) return guard.error;
      const dup = byRevision(scope, criteria, input.revisionId).find((c) => c.key === input.key);
      if (dup) return fail(DecisionErrors.INVALID_INPUT, `Criterion "${input.key}" is already stated on this revision.`);
      const c: DecisionCriterion = { ...input, id: idGen.next(), orgId: scope.orgId, createdAt: now() };
      criteria.set(c.id, c);
      return ok(c);
    },

    async listCriteria(scope, revisionId) {
      return ok(
        byRevision(scope, criteria, revisionId)
          .slice()
          .sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key)),
      );
    },

    async recordAssessment(scope, input) {
      const guard = draftRevision(scope, input.revisionId);
      if (guard.error) return guard.error;
      const existing = byRevision(scope, assessments, input.revisionId).find(
        (a) => a.criterionId === input.criterionId && a.alternativeId === input.alternativeId,
      );
      const a: CriterionAssessment = { ...input, id: existing?.id ?? idGen.next(), orgId: scope.orgId };
      assessments.set(a.id, a);
      return ok(a);
    },

    async listAssessments(scope, revisionId) {
      return ok(byRevision(scope, assessments, revisionId));
    },

    async declareWeighting(scope, input) {
      const guard = draftRevision(scope, input.revisionId);
      if (guard.error) return guard.error;
      const w: ManagementWeighting = { ...input, id: idGen.next(), orgId: scope.orgId };
      weightings.set(w.id, w);
      return ok(w);
    },

    async getWeighting(scope, revisionId) {
      return ok(byRevision(scope, weightings, revisionId)[0] ?? null);
    },

    // ----------------------------------------------------------- assumptions
    async addAssumption(scope, input) {
      const guard = draftRevision(scope, input.revisionId);
      if (guard.error) return guard.error;
      const a: DecisionAssumption = { ...input, id: idGen.next(), orgId: scope.orgId, createdAt: now() };
      assumptions.set(a.id, a);
      return ok(a);
    },

    async listAssumptions(scope, revisionId) {
      return ok(byRevision(scope, assumptions, revisionId));
    },

    async setAssumptionOutcome(scope, id, outcome, note) {
      const a = mine(scope, assumptions.get(id));
      if (!a) return fail(DecisionErrors.NOT_FOUND, `Assumption ${id} not found.`);
      // The outcome is learned AFTER the fact, so it is the one field a sealed
      // revision still accepts — and the only one.
      const next: DecisionAssumption = { ...a, outcome, outcomeNote: note };
      assumptions.set(id, next);
      return ok(next);
    },

    // ------------------------------------------------------------ challenges
    async addChallenge(scope, input) {
      const guard = draftRevision(scope, input.revisionId);
      if (guard.error) return guard.error;
      const c: DecisionChallenge = { ...input, id: idGen.next(), orgId: scope.orgId, raisedAt: now() };
      challenges.set(c.id, c);
      return ok(c);
    },

    async resolveChallenge(scope, id, outcome) {
      const c = mine(scope, challenges.get(id));
      if (!c) return fail(DecisionErrors.NOT_FOUND, `Challenge ${id} not found.`);
      if (c.status !== 'OPEN') {
        return fail(DecisionErrors.INVALID_TRANSITION, `That challenge is already ${c.status}.`);
      }
      const next: DecisionChallenge = {
        ...c,
        status: outcome.status,
        resolution: outcome.resolution,
        resolvedBy: outcome.resolvedBy,
        resolvedAt: now(),
      };
      challenges.set(id, next);
      return ok(next);
    },

    async listChallenges(scope, revisionId) {
      return ok(byRevision(scope, challenges, revisionId));
    },

    // -------------------------------------------------------------- evidence
    async addEvidence(scope, input) {
      // Evidence recorded after a commitment is still recorded — it simply
      // does not enter the frozen manifest (§80).
      const r = mine(scope, revisions.get(input.revisionId));
      if (!r) return fail(DecisionErrors.NOT_FOUND, `Decision revision ${input.revisionId} not found.`);
      const e: DecisionEvidence = { ...input, id: idGen.next(), orgId: scope.orgId, createdAt: now() };
      evidence.set(e.id, e);
      return ok(e);
    },

    async listEvidence(scope, revisionId) {
      return ok(
        byRevision(scope, evidence, revisionId)
          .slice()
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      );
    },

    // ------------------------------------------------------------ commitment
    async createCommitment(scope, input) {
      const r = mine(scope, revisions.get(input.revisionId));
      if (!r) return fail(DecisionErrors.NOT_FOUND, `Decision revision ${input.revisionId} not found.`);
      const existing = [...commitments.values()].find(
        (c) => c.orgId === scope.orgId && c.revisionId === input.revisionId,
      );
      if (existing) {
        return fail(
          DecisionErrors.ALREADY_COMMITTED,
          'That revision has already been committed. Reconsidering creates a new revision; it does not rewrite this one.',
        );
      }
      const c: DecisionCommitment = { ...input, id: idGen.next(), orgId: scope.orgId };
      commitments.set(c.id, c);
      return ok(c);
    },

    async getCommitment(scope, id) {
      return ok(mine(scope, commitments.get(id)));
    },

    async getCommitmentForRevision(scope, revisionId) {
      return ok([...commitments.values()].find((c) => c.orgId === scope.orgId && c.revisionId === revisionId) ?? null);
    },

    async listCommitments(scope, decisionId) {
      return ok(
        [...commitments.values()]
          .filter((c) => c.orgId === scope.orgId && c.decisionId === decisionId)
          .sort((a, b) => a.committedAt.localeCompare(b.committedAt)),
      );
    },

    async createSnapshot(scope, input) {
      const s: CommitmentSnapshot = { ...input, id: idGen.next(), orgId: scope.orgId };
      snapshots.set(s.id, s);
      return ok(s);
    },

    async getSnapshot(scope, id) {
      return ok(mine(scope, snapshots.get(id)));
    },

    // --------------------------------------------------------- action intent
    async addActionIntent(scope, input) {
      const c = mine(scope, commitments.get(input.commitmentId));
      if (!c) return fail(DecisionErrors.NOT_FOUND, `Commitment ${input.commitmentId} not found.`);
      const a: ActionIntent = { ...input, id: idGen.next(), orgId: scope.orgId, createdAt: now() };
      intents.set(a.id, a);
      return ok(a);
    },

    async setActionIntentStatus(scope, id, status) {
      const a = mine(scope, intents.get(id));
      if (!a) return fail(DecisionErrors.NOT_FOUND, `Action intent ${id} not found.`);
      const next: ActionIntent = { ...a, status };
      intents.set(id, next);
      return ok(next);
    },

    async listActionIntents(scope, commitmentId) {
      return ok(
        [...intents.values()]
          .filter((a) => a.orgId === scope.orgId && a.commitmentId === commitmentId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      );
    },

    // -------------------------------------------------------- outcome review
    async recordOutcomeReview(scope, input) {
      const c = mine(scope, commitments.get(input.commitmentId));
      if (!c) return fail(DecisionErrors.NOT_FOUND, `Commitment ${input.commitmentId} not found.`);
      const r: DecisionOutcomeReview = { ...input, id: idGen.next(), orgId: scope.orgId };
      reviews.set(r.id, r);
      return ok(r);
    },

    async listOutcomeReviews(scope, decisionId) {
      return ok(
        [...reviews.values()]
          .filter((r) => r.orgId === scope.orgId && r.decisionId === decisionId)
          .sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt)),
      );
    },

    // -------------------------------------------------------------- timeline
    async appendEvent(scope, input) {
      const e: DecisionTimelineEvent = { ...input, id: idGen.next(), orgId: scope.orgId, recordedAt: now() };
      events.set(e.id, e);
      return ok(e);
    },

    async listEvents(scope, decisionId) {
      // Ties on the instant are broken by the order the events were recorded,
      // not by id: a decision seeded in one millisecond must still read as the
      // sequence it happened in. (Map preserves insertion order.)
      const all = [...events.values()];
      const recorded = new Map(all.map((e, i) => [e.id, i]));
      return ok(
        all
          .filter((e) => e.orgId === scope.orgId && e.decisionId === decisionId)
          .sort(
            (a, b) =>
              a.recordedAt.localeCompare(b.recordedAt) || recorded.get(a.id)! - recorded.get(b.id)!,
          ),
      );
    },
  };
}
