/**
 * The DecisionStore conformance suite.
 *
 * ONE contract, run against EVERY adapter. The properties that matter are the
 * ones a database must enforce as well as the in-memory store: a sealed
 * revision and everything hanging off it are immutable, a revision is
 * committed once, a commitment and its snapshot are write-once, evidence may
 * still be recorded after a commitment without joining it, the timeline is
 * append-only, and nothing crosses a tenant boundary.
 *
 * Runner-agnostic, so it works under `node --test` and anything later.
 */

import type { Result, Scope } from '@helm/shared';
import type { DecisionStore } from './port.ts';
import type { Decision, DecisionRevision } from './types.ts';

export type DecisionTestApi = {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void> | void) => void;
  assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
  };
};

export type DecisionStoreHarness = {
  name: string;
  /**
   * A fresh store and two organizations. `scenarioRun` returns ids that a
   * database can accept as foreign keys into the scenario runtime (a sealed
   * revision and its completed run).
   */
  create(): Promise<{
    store: DecisionStore;
    scopeA: Scope;
    scopeB: Scope;
    scenarioRun(): Promise<{ scenarioId: string; scenarioRevisionId: string; scenarioRunId: string }>;
    now: () => Date;
    cleanup?: () => Promise<void>;
  }>;
};

function expectOk<T>(r: Result<T>, what: string): T {
  if (!r.ok) throw new Error(`${what} failed: ${r.error.code} — ${r.error.message}`);
  return r.value;
}

/** A row the suite expects to exist. */
function must<T>(v: T | null, what: string): T {
  if (v === null) throw new Error(`${what} was not found`);
  return v;
}

const FORK = {
  effectiveAsOf: '2026-09-19T12:00:00.000Z',
  recordedThrough: '2026-09-19T12:00:00.000Z',
  policy: 'SOURCE_TRUTH' as const,
};

export function runDecisionStoreConformanceSuite(api: DecisionTestApi, harness: DecisionStoreHarness): void {
  const { describe, it, assert } = api;

  describe(`DecisionStore conformance — ${harness.name}`, () => {
    const newDecision = (overrides: Partial<Decision> = {}): Parameters<DecisionStore['createDecision']>[1] => ({
      title: 'Conformance decision',
      managementQuestion: 'How should we handle the constrained position this quarter?',
      context: '',
      problem: '',
      scope: '',
      triggerType: 'MANUAL',
      triggerRefs: [],
      state: 'DRAFT',
      owner: { kind: 'ROLE', label: 'Country GM', userId: null },
      fork: FORK,
      horizon: { decisionDeadline: null, effectiveFrom: null, expectedOutcomeHorizon: null, reviewDate: null },
      objectives: [],
      reversibility: 'UNASSESSED',
      reversalWindowDays: null,
      authorityStatus: 'NOT_EVALUATED',
      createdBy: null,
      metadata: {},
      ...overrides,
    });

    const newRevision = (
      decisionId: string,
      overrides: Partial<DecisionRevision> = {},
    ): Parameters<DecisionStore['createRevision']>[1] => ({
      decisionId,
      revisionNumber: 1,
      state: 'DRAFT',
      reason: 'OPENED',
      basedOnRevisionId: null,
      reconsidersCommitmentId: null,
      reconsiderationReason: null,
      fork: FORK,
      notes: null,
      createdBy: null,
      ...overrides,
    });

    const setup = async () => {
      const h = await harness.create();
      const decision = expectOk(await h.store.createDecision(h.scopeA, newDecision()), 'create decision');
      const revision = expectOk(await h.store.createRevision(h.scopeA, newRevision(decision.id)), 'create revision');
      return { h, decision, revision };
    };

    const addAlternative = async (
      h: Awaited<ReturnType<DecisionStoreHarness['create']>>,
      decisionId: string,
      revisionId: string,
      label: string,
      bound?: { scenarioId: string; scenarioRevisionId: string; scenarioRunId: string },
    ) =>
      expectOk(
        await h.store.addAlternative(h.scopeA, {
          decisionId,
          revisionId,
          label,
          description: '',
          status: bound ? 'MODELLED' : 'UNMODELLED',
          scenarioId: bound?.scenarioId ?? null,
          scenarioRevisionId: bound?.scenarioRevisionId ?? null,
          scenarioRunId: bound?.scenarioRunId ?? null,
          unmodelledReason: bound ? null : 'nothing models this yet',
          sort: 0,
          createdBy: null,
          metadata: {},
        }),
        `add alternative ${label}`,
      );

    const commitOn = async (
      h: Awaited<ReturnType<DecisionStoreHarness['create']>>,
      decisionId: string,
      revisionId: string,
      chosenAlternativeId: string,
    ) => {
      const snapshot = expectOk(
        await h.store.createSnapshot(h.scopeA, {
          decisionId,
          revisionId,
          capturedAt: h.now().toISOString(),
          fork: FORK,
          modelRef: { engineVersion: '4.0.0', calculations: ['a@1.0.0'] },
          alternatives: [],
          criterionIds: [],
          assumptionIds: [],
          challengeIds: [],
          evidenceIds: [],
          criterionEvaluations: [],
          openChallenges: [],
          fingerprint: 'dsn_0000000000000000_1',
        }),
        'snapshot',
      );
      const commitment = expectOk(
        await h.store.createCommitment(h.scopeA, {
          decisionId,
          revisionId,
          chosenAlternativeId,
          authorship: 'MANAGEMENT_AUTHORED',
          committedBy: null,
          committedByLabel: 'Country GM',
          committedAt: h.now().toISOString(),
          summary: 'Chosen for the conformance suite.',
          rationale: [{ kind: 'JUDGEMENT', ref: null, label: 'Because', statement: 'The suite says so.' }],
          acceptedTradeOffs: [],
          expectedOutcomes: [],
          reviewTriggers: [],
          authorityStatus: 'NOT_EVALUATED',
          fingerprint: 'dfp_0000000000000000_1',
          snapshotId: snapshot.id,
        }),
        'commitment',
      );
      expectOk(await h.store.sealRevision(h.scopeA, revisionId), 'seal');
      return { snapshot, commitment };
    };

    it('creates a decision with its management question and knowledge boundary', async () => {
      const { h, decision } = await setup();
      const read = must(expectOk(await h.store.getDecision(h.scopeA, decision.id), 'read'), 'the decision');
      assert.equal(read.managementQuestion, 'How should we handle the constrained position this quarter?');
      assert.equal(read.fork.recordedThrough, FORK.recordedThrough);
      assert.equal(read.authorityStatus, 'NOT_EVALUATED');
      await h.cleanup?.();
    });

    it('enforces the decision lifecycle', async () => {
      const { h, decision } = await setup();
      const bad = await h.store.setDecisionState(h.scopeA, decision.id, 'REVIEWED');
      assert.equal(bad.ok, false, 'a DRAFT decision cannot jump to REVIEWED');
      const good = expectOk(await h.store.setDecisionState(h.scopeA, decision.id, 'INVESTIGATING'), 'transition');
      assert.equal(good.state, 'INVESTIGATING');
      await h.cleanup?.();
    });

    it('allows one open revision at a time', async () => {
      const { h, decision } = await setup();
      const second = await h.store.createRevision(h.scopeA, newRevision(decision.id, { revisionNumber: 2 }));
      assert.equal(second.ok, false, 'a second draft revision is refused while one is open');
      await h.cleanup?.();
    });

    it('binds an alternative to a scenario run, and reads it back', async () => {
      const { h, decision, revision } = await setup();
      const bound = await h.scenarioRun();
      const alternative = await addAlternative(h, decision.id, revision.id, 'A — bound', bound);
      assert.equal(alternative.status, 'MODELLED');
      assert.equal(alternative.scenarioRunId, bound.scenarioRunId);
      assert.equal(alternative.scenarioRevisionId, bound.scenarioRevisionId);

      const listed = expectOk(await h.store.listAlternatives(h.scopeA, revision.id), 'list');
      assert.equal(listed.length, 1);
      assert.equal(listed[0].label, 'A — bound');
      await h.cleanup?.();
    });

    it('keeps an unmodelled alternative unmodelled, with its reason', async () => {
      const { h, decision, revision } = await setup();
      const alternative = await addAlternative(h, decision.id, revision.id, 'B — not modelled');
      assert.equal(alternative.status, 'UNMODELLED');
      assert.equal(alternative.scenarioRunId, null);
      assert.equal(alternative.unmodelledReason, 'nothing models this yet');
      await h.cleanup?.();
    });

    it('freezes the whole basis when a revision is sealed', async () => {
      const { h, decision, revision } = await setup();
      const bound = await h.scenarioRun();
      const chosen = await addAlternative(h, decision.id, revision.id, 'A', bound);
      await addAlternative(h, decision.id, revision.id, 'B');
      expectOk(
        await h.store.addCriterion(h.scopeA, {
          decisionId: decision.id,
          revisionId: revision.id,
          key: 'margin',
          name: 'Margin',
          description: '',
          style: 'PREFERENCE',
          required: false,
          metricKey: 'GrossMarginPct',
          subjectHint: null,
          threshold: null,
          unit: 'percentage',
          direction: 'HIGHER_IS_BETTER',
          weight: null,
          author: { kind: 'ROLE', label: 'Finance', userId: null },
          rationale: 'Margin is under pressure.',
          demoPolicy: false,
          sort: 0,
        }),
        'criterion',
      );
      await commitOn(h, decision.id, revision.id, chosen.id);

      const addAfter = await h.store.addAlternative(h.scopeA, {
        decisionId: decision.id,
        revisionId: revision.id,
        label: 'C — too late',
        description: '',
        status: 'UNMODELLED',
        scenarioId: null,
        scenarioRevisionId: null,
        scenarioRunId: null,
        unmodelledReason: 'after the fact',
        sort: 9,
        createdBy: null,
        metadata: {},
      });
      assert.equal(addAfter.ok, false, 'an alternative cannot be added to a sealed revision');

      const rebind = await h.store.setAlternativeBinding(h.scopeA, chosen.id, {
        status: 'UNMODELLED',
        scenarioId: null,
        scenarioRevisionId: null,
        scenarioRunId: null,
        unmodelledReason: 'unbinding after the fact',
      });
      assert.equal(rebind.ok, false, 'a sealed revision\'s alternative cannot be re-bound');

      const criterionAfter = await h.store.addCriterion(h.scopeA, {
        decisionId: decision.id,
        revisionId: revision.id,
        key: 'late',
        name: 'Late criterion',
        description: '',
        style: 'PREFERENCE',
        required: false,
        metricKey: null,
        subjectHint: null,
        threshold: null,
        unit: null,
        direction: 'NONE',
        weight: null,
        author: { kind: 'ROLE', label: 'Someone', userId: null },
        rationale: 'thought of later',
        demoPolicy: false,
        sort: 1,
      });
      assert.equal(criterionAfter.ok, false, 'a criterion cannot be added to a sealed revision');

      const assumptionAfter = await h.store.addAssumption(h.scopeA, {
        decisionId: decision.id,
        revisionId: revision.id,
        statement: 'Something we believed all along.',
        owner: null,
        source: '',
        rationale: '',
        confidence: null,
        criticality: 'MATERIAL',
        scenarioRevisionId: null,
        scenarioOverrideId: null,
        alternativeIds: [],
        outcome: 'PENDING',
        outcomeNote: null,
        createdBy: null,
      });
      assert.equal(assumptionAfter.ok, false, 'an assumption cannot be added to a sealed revision');
      await h.cleanup?.();
    });

    it('commits a revision once', async () => {
      const { h, decision, revision } = await setup();
      const bound = await h.scenarioRun();
      const chosen = await addAlternative(h, decision.id, revision.id, 'A', bound);
      const { commitment } = await commitOn(h, decision.id, revision.id, chosen.id);

      const second = await h.store.createCommitment(h.scopeA, {
        decisionId: decision.id,
        revisionId: revision.id,
        chosenAlternativeId: chosen.id,
        authorship: 'MANAGEMENT_AUTHORED',
        committedBy: null,
        committedByLabel: 'Someone else',
        committedAt: h.now().toISOString(),
        summary: 'A second go at the same revision.',
        rationale: [],
        acceptedTradeOffs: [],
        expectedOutcomes: [],
        reviewTriggers: [],
        authorityStatus: 'NOT_EVALUATED',
        fingerprint: 'dfp_1111111111111111_1',
        snapshotId: commitment.snapshotId,
      });
      assert.equal(second.ok, false, 'a revision is committed once');
      await h.cleanup?.();
    });

    it('records evidence after a commitment without changing the frozen manifest', async () => {
      const { h, decision, revision } = await setup();
      const bound = await h.scenarioRun();
      const chosen = await addAlternative(h, decision.id, revision.id, 'A', bound);
      const { snapshot } = await commitOn(h, decision.id, revision.id, chosen.id);

      const later = expectOk(
        await h.store.addEvidence(h.scopeA, {
          decisionId: decision.id,
          revisionId: revision.id,
          kind: 'MARKET_SIGNAL',
          title: 'Learned afterwards',
          detail: '',
          relation: 'CHALLENGE',
          targetKind: 'CONTEXT',
          targetId: null,
          sourceSystem: 'market',
          sourceRef: null,
          effectiveAt: null,
          recordedAt: h.now().toISOString(),
          confidence: null,
          author: null,
        }),
        'later evidence',
      );
      assert.ok(later.id, 'evidence after a commitment is still recorded');

      const read = must(expectOk(await h.store.getSnapshot(h.scopeA, snapshot.id), 'snapshot'), 'the snapshot');
      assert.deepEqual(read.evidenceIds, [], 'the frozen manifest does not grow');
      assert.equal(read.fingerprint, snapshot.fingerprint);
      await h.cleanup?.();
    });

    it('resolves a challenge once', async () => {
      const { h, decision, revision } = await setup();
      const challenge = expectOk(
        await h.store.addChallenge(h.scopeA, {
          decisionId: decision.id,
          revisionId: revision.id,
          targetKind: 'CONTEXT',
          targetId: null,
          author: { kind: 'ROLE', label: 'Finance', userId: null },
          concern: 'The freight estimate may be low.',
          evidenceId: null,
          status: 'OPEN',
          resolution: null,
          resolvedBy: null,
          resolvedAt: null,
        }),
        'challenge',
      );
      expectOk(
        await h.store.resolveChallenge(h.scopeA, challenge.id, {
          status: 'ACCEPTED_RISK',
          resolution: 'Management accepts the uncertainty.',
          resolvedBy: null,
        }),
        'resolve',
      );
      const again = await h.store.resolveChallenge(h.scopeA, challenge.id, {
        status: 'REJECTED',
        resolution: 'Actually, no.',
        resolvedBy: null,
      });
      assert.equal(again.ok, false, 'a resolved challenge is not resolved twice');
      await h.cleanup?.();
    });

    it('keeps the timeline append-only and in record order', async () => {
      const { h, decision } = await setup();
      for (const eventType of ['DECISION_OPENED', 'ALTERNATIVE_ADDED', 'COMMITTED']) {
        expectOk(
          await h.store.appendEvent(h.scopeA, { decisionId: decision.id, eventType, actorId: null, payload: { eventType } }),
          eventType,
        );
      }
      const events = expectOk(await h.store.listEvents(h.scopeA, decision.id), 'timeline');
      assert.deepEqual(
        events.map((e) => e.eventType),
        ['DECISION_OPENED', 'ALTERNATIVE_ADDED', 'COMMITTED'],
      );
      await h.cleanup?.();
    });

    it('records an assumption outcome after the fact, and only the outcome', async () => {
      const { h, decision, revision } = await setup();
      const assumption = expectOk(
        await h.store.addAssumption(h.scopeA, {
          decisionId: decision.id,
          revisionId: revision.id,
          statement: 'The supplier will deliver in seven days.',
          owner: { kind: 'ROLE', label: 'Supply Chain', userId: null },
          source: 'verbal',
          rationale: 'recent shipments',
          confidence: 0.7,
          criticality: 'CRITICAL',
          scenarioRevisionId: null,
          scenarioOverrideId: null,
          alternativeIds: [],
          outcome: 'PENDING',
          outcomeNote: null,
          createdBy: null,
        }),
        'assumption',
      );
      const bound = await h.scenarioRun();
      const chosen = await addAlternative(h, decision.id, revision.id, 'A', bound);
      await commitOn(h, decision.id, revision.id, chosen.id);

      const updated = expectOk(
        await h.store.setAssumptionOutcome(h.scopeA, assumption.id, 'DISPROVED', 'It took eleven days.'),
        'outcome',
      );
      assert.equal(updated.outcome, 'DISPROVED');
      assert.equal(updated.statement, assumption.statement, 'the statement itself never changes');
      assert.equal(updated.confidence, assumption.confidence);
      await h.cleanup?.();
    });

    it('walls one organization off from another', async () => {
      const { h, decision, revision } = await setup();
      const bound = await h.scenarioRun();
      const chosen = await addAlternative(h, decision.id, revision.id, 'A', bound);
      const { commitment, snapshot } = await commitOn(h, decision.id, revision.id, chosen.id);

      assert.equal(expectOk(await h.store.getDecision(h.scopeB, decision.id), 'cross-read'), null);
      assert.equal(expectOk(await h.store.listDecisions(h.scopeB), 'cross-list').length, 0);
      assert.equal(expectOk(await h.store.getRevision(h.scopeB, revision.id), 'cross-revision'), null);
      assert.equal(expectOk(await h.store.listAlternatives(h.scopeB, revision.id), 'cross-alternatives').length, 0);
      assert.equal(expectOk(await h.store.getCommitment(h.scopeB, commitment.id), 'cross-commitment'), null);
      assert.equal(expectOk(await h.store.getSnapshot(h.scopeB, snapshot.id), 'cross-snapshot'), null);
      assert.equal(expectOk(await h.store.listEvents(h.scopeB, decision.id), 'cross-timeline').length, 0);

      const cross = await h.store.setDecisionState(h.scopeB, decision.id, 'INVESTIGATING');
      assert.equal(cross.ok, false, 'another organization cannot move this decision');
      await h.cleanup?.();
    });
  });
}
