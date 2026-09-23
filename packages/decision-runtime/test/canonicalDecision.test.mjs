/**
 * The canonical Rohto decision, end to end.
 *
 * One management question, five alternatives (four modelled, one honestly
 * not), six criteria management wrote down, five assumptions with owners —
 * except the one deliberately without — two challenges, evidence, a seeded
 * management commitment, its frozen manifest, and the action intents that
 * follow.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMeridianDecision, MERIDIAN_MANAGEMENT_QUESTION } from '../src/index.ts';
import { buildStack, evalOf, expectFail, scope, unwrap } from './harness.mjs';

describe('the canonical Rohto decision', () => {
  it('frames one management question, not a topic', async () => {
    const stack = await buildStack();
    const built = unwrap(await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds), 'build');
    assert.equal(built.decision.managementQuestion, MERIDIAN_MANAGEMENT_QUESTION);
    assert.match(built.decision.managementQuestion, /^How should/);
    assert.equal(built.decision.triggerType, 'ISSUE');
    assert.equal(built.decision.owner?.label, 'Country GM Vietnam');
    // Four dates, four different questions.
    assert.equal(built.decision.horizon.decisionDeadline, '2026-09-30');
    assert.equal(built.decision.horizon.effectiveFrom, '2026-10-01');
    assert.equal(built.decision.horizon.expectedOutcomeHorizon, '2026-12-31');
    assert.equal(built.decision.horizon.reviewDate, '2026-10-23');
    assert.equal(built.decision.reversibility, 'PARTIALLY_REVERSIBLE');
    assert.equal(built.decision.authorityStatus, 'NOT_EVALUATED');
  });

  it('refuses a decision whose "question" is a label', async () => {
    const stack = await buildStack({ simulate: false });
    const e = expectFail(
      await stack.decisions.createDecision(scope, {
        title: 'Inventory',
        managementQuestion: 'Inventory',
        triggerType: 'MANUAL',
      }),
      'label as question',
    );
    assert.equal(e.code, 'decision.invalid_input');
    assert.match(e.message, /management question/i);
  });

  it('binds four alternatives to scenario futures and leaves the fifth UNMODELLED', async () => {
    const stack = await buildStack();
    const built = unwrap(await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds), 'build');
    const ws = unwrap(await stack.decisions.getWorkspace(scope, built.decision.id, built.revisionId), 'workspace');

    assert.equal(ws.alternatives.length, 5);
    const modelled = ws.alternatives.filter((a) => a.status === 'MODELLED');
    assert.equal(modelled.length, 4);
    for (const a of modelled) {
      assert.ok(a.scenarioRevisionId, `${a.label} should reference a scenario revision`);
      assert.ok(a.scenarioRunId, `${a.label} should reference the run that computed its future`);
    }
    const unmodelled = ws.alternatives.find((a) => a.status === 'UNMODELLED');
    assert.match(unmodelled.label, /Replace the distributor/);
    assert.match(unmodelled.unmodelledReason, /no model of a second distributor/i);
    // And it carries no invented economics.
    assert.equal(unmodelled.scenarioRunId, null);
  });

  it('evaluates each criterion against each alternative as a fact, with no total', async () => {
    const stack = await buildStack();
    const built = unwrap(await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds), 'build');
    const evaluations = unwrap(
      await stack.decisions.evaluateCriteria(scope, built.revisionId),
      'evaluate',
    );

    // Service: the stated 90% line.
    assert.equal(evalOf(evaluations, 'customer-service', 'Expedite').outcome, 'SATISFIED');
    assert.equal(evalOf(evaluations, 'customer-service', 'Expedite').value, '96.8858');
    assert.equal(evalOf(evaluations, 'customer-service', 'Reallocate').outcome, 'SATISFIED');
    assert.equal(evalOf(evaluations, 'customer-service', 'Reallocate').value, '96.8858');
    assert.equal(evalOf(evaluations, 'customer-service', 'alternative analyzer').value, '91.3495');

    // Margin: every modelled alternative misses the 35% target — which is a
    // fact about the target, not a reason to pick one.
    assert.equal(evalOf(evaluations, 'gross-margin', 'Expedite').outcome, 'MISSES_TARGET');
    assert.equal(evalOf(evaluations, 'gross-margin', 'Expedite').value, '30.517');
    assert.equal(evalOf(evaluations, 'gross-margin', 'Reallocate').outcome, 'MISSES_TARGET');
    assert.equal(evalOf(evaluations, 'gross-margin', 'Reallocate').value, '32.3878');
    assert.equal(evalOf(evaluations, 'gross-margin', 'alternative analyzer').value, '22.9048');

    // A preference states the value and does not judge it.
    assert.equal(evalOf(evaluations, 'cash-impact', 'Reallocate').outcome, 'STATED');
    assert.equal(evalOf(evaluations, 'cash-impact', 'Reallocate').value, '-1735500000');
    assert.equal(evalOf(evaluations, 'cash-impact', 'Expedite').value, '-1790500000');

    // Nothing anywhere combines them.
    for (const e of evaluations) {
      assert.ok(!('score' in e), 'a criterion evaluation must not carry a score');
      assert.ok(!('rank' in e), 'a criterion evaluation must not carry a rank');
    }
  });

  it('shows a blocked metric as blocked, and keeps the alternative in the decision', async () => {
    const stack = await buildStack();
    const built = unwrap(await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds), 'build');
    const evaluations = unwrap(await stack.decisions.evaluateCriteria(scope, built.revisionId), 'evaluate');

    const delayMargin = evalOf(evaluations, 'gross-margin', 'Delay');
    assert.equal(delayMargin.outcome, 'UNKNOWN');
    assert.equal(delayMargin.value, null);
    assert.equal(delayMargin.origin, 'BLOCKED');
    assert.match(delayMargin.explanation, /divide_by_zero|BLOCKED/i);

    // The alternative is still there, and its other criteria still evaluate.
    assert.equal(evalOf(evaluations, 'customer-service', 'Delay').outcome, 'SATISFIED');
  });

  it('reads qualitative criteria only from authored assessments', async () => {
    const stack = await buildStack();
    const built = unwrap(await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds), 'build');
    const evaluations = unwrap(await stack.decisions.evaluateCriteria(scope, built.revisionId), 'evaluate');

    const optionality = evalOf(evaluations, 'inventory-optionality', 'Reallocate');
    assert.equal(optionality.outcome, 'ASSESSED');
    assert.equal(optionality.assessment.rating, 'CONCERN');
    assert.equal(optionality.assessment.author.label, 'Supply Chain Director Vietnam');
    assert.match(optionality.assessment.rationale, /buffer goes to zero/);

    // Nobody assessed the unmodelled alternative, so HELM does not either.
    const unassessed = evalOf(evaluations, 'inventory-optionality', 'Replace the distributor');
    assert.equal(unassessed.outcome, 'NOT_ASSESSED');
    assert.equal(unassessed.assessment, null);
  });

  it('refuses to rate a qualitative criterion without a reason, and refuses to rate a measured one at all', async () => {
    const stack = await buildStack();
    const built = unwrap(await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds, { commit: false }), 'build');

    const noReason = expectFail(
      await stack.decisions.recordAssessment(scope, {
        criterionId: built.criteria['inventory-optionality'].id,
        alternativeId: built.alternatives['expedite'].id,
        rating: 'SUPPORT',
        rationale: 'ok',
        author: { kind: 'ROLE', label: 'Someone', userId: null },
      }),
      'rating without a reason',
    );
    assert.match(noReason.message, /needs a reason/);

    const measured = expectFail(
      await stack.decisions.recordAssessment(scope, {
        criterionId: built.criteria['gross-margin'].id,
        alternativeId: built.alternatives['expedite'].id,
        rating: 'SUPPORT',
        rationale: 'it feels about right',
        author: { kind: 'ROLE', label: 'Someone', userId: null },
      }),
      'rating a measured criterion',
    );
    assert.match(measured.message, /evaluated from the model/);
  });

  it('states the trade-off space as gains and concessions, and never a ranking', async () => {
    const stack = await buildStack();
    const built = unwrap(await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds), 'build');
    const space = unwrap(
      await stack.decisions.tradeOffSpace(scope, built.revisionId, built.alternatives['expedite'].id),
      'trade-offs',
    );

    assert.equal(space.referenceAlternativeId, built.alternatives['expedite'].id);
    const reallocate = space.columns.find((c) => c.alternativeLabel.includes('Reallocate'));
    // More margin, more cash, same service — and a concession on optionality.
    const margin = reallocate.gains.find((g) => g.metricKey === 'GrossMarginPct');
    assert.ok(margin, 'reallocation gains margin against expediting');
    assert.equal(margin.referenceValue, '30.517');
    assert.equal(margin.alternativeValue, '32.3878');
    assert.equal(margin.delta, '1.8708');
    const cash = reallocate.gains.find((g) => g.metricKey === 'CashImpact');
    assert.equal(cash.delta, '55000000');
    const optionality = reallocate.concessions.find((c) => c.label === 'Inventory optionality');
    assert.ok(optionality, 'reallocation concedes inventory optionality');

    assert.match(space.statement, /does not decide which concession is acceptable/i);
    assert.ok(!('winner' in space));
    assert.ok(!('ranking' in space));
  });

  it('states factual dominance without concluding anything from it', async () => {
    const stack = await buildStack();
    const built = unwrap(await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds), 'build');
    const space = unwrap(await stack.decisions.tradeOffSpace(scope, built.revisionId), 'trade-offs');

    // A is better than C on every comparable criterion and worse on none.
    const aOverC = space.dominance.find(
      (d) =>
        d.alternativeId === built.alternatives['expedite'].id &&
        d.overAlternativeId === built.alternatives['alternative-product'].id,
    );
    assert.ok(aOverC, 'expediting dominates the alternative analyzer on the comparable criteria');
    assert.match(aOverC.statement, /Under the current model/);
    assert.match(aOverC.statement, /management's call, not the model's/);
    assert.ok(!/choose/i.test(aOverC.statement), 'a dominance statement must not tell anyone what to choose');

    // B does NOT dominate C — it concedes inventory optionality — and the
    // alternative management actually committed to is not a dominant one.
    assert.equal(
      space.dominance.find(
        (d) =>
          d.alternativeId === built.alternatives['reallocate'].id &&
          d.overAlternativeId === built.alternatives['alternative-product'].id,
      ),
      undefined,
      'reallocation gives up optionality, so it does not dominate',
    );
    assert.equal(
      space.dominance.filter((d) => d.alternativeId === built.alternatives['reallocate'].id).length,
      0,
      'the committed alternative dominates nothing, and HELM does not mind',
    );

    // And nothing dominates in both directions.
    for (const d of space.dominance) {
      const reverse = space.dominance.find(
        (x) => x.alternativeId === d.overAlternativeId && x.overAlternativeId === d.alternativeId,
      );
      assert.equal(reverse, undefined, 'dominance cannot run both ways');
    }
  });

  it('reports readiness as named gaps, with no score', async () => {
    const stack = await buildStack();
    const built = unwrap(await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds, { commit: false }), 'build');
    const readiness = unwrap(await stack.decisions.evaluateReadiness(scope, built.revisionId), 'readiness');

    assert.equal(readiness.state, 'READY_WITH_GAPS');
    assert.ok(!('score' in readiness), 'readiness must never be a number');
    const codes = readiness.gaps.map((g) => g.code);
    assert.ok(codes.includes('alternative-unmodelled'), 'the unmodelled alternative is a gap');
    assert.ok(codes.includes('critical-assumption-unowned'), 'the unowned critical assumption is a gap');
    assert.ok(codes.includes('open-challenge'), 'the open challenge is a gap');
    assert.ok(readiness.gaps.every((g) => g.message.length > 20), 'every gap explains itself');
    assert.equal(readiness.gaps.filter((g) => g.severity === 'BLOCKING').length, 0);
  });

  it('records a management-authored commitment with rationale, trade-offs and expected outcomes', async () => {
    const stack = await buildStack();
    const built = unwrap(await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds), 'build');
    const commitment = built.commitment;

    assert.equal(commitment.authorship, 'MANAGEMENT_AUTHORED_DEMO');
    assert.equal(commitment.chosenAlternativeId, built.alternatives['reallocate'].id);
    assert.equal(commitment.authorityStatus, 'NOT_EVALUATED');
    assert.match(commitment.fingerprint, /^dfp_[0-9a-f]{16}_\d+$/);

    // The rationale says why this one AND why not the others.
    const kinds = commitment.rationale.map((r) => r.kind);
    assert.ok(kinds.includes('CRITERION'));
    assert.ok(kinds.includes('SCENARIO_DELTA'));
    assert.ok(kinds.includes('ASSUMPTION'));
    assert.equal(commitment.rationale.filter((r) => r.label.startsWith('Why not')).length, 2);

    // Trade-offs are explicit, and say what was given up in favour of what.
    assert.equal(commitment.acceptedTradeOffs.length, 2);
    assert.match(commitment.acceptedTradeOffs[0].givenUp, /consignment units of headroom/);
    assert.match(commitment.acceptedTradeOffs[0].inFavourOf, /gross margin/);

    // Expected outcomes are READ from the chosen future state, not typed.
    const gm = commitment.expectedOutcomes.find((e) => e.metricKey === 'GrossMarginPct');
    assert.equal(gm.kind, 'MODELLED');
    assert.equal(gm.expectedValue, '32.3878');
    assert.ok(gm.nodeId, 'an expected outcome points at the value node it came from');
    const coverage = commitment.expectedOutcomes.find((e) => e.metricKey === 'DemandCoverage');
    assert.equal(coverage.expectedValue, '96.8858');
    const qualitative = commitment.expectedOutcomes.find((e) => e.kind === 'QUALITATIVE');
    assert.equal(qualitative.expectedValue, null);
    assert.match(qualitative.statement, /framework renewal/);
  });

  it('records the action intents and the integration payload, and sends nothing', async () => {
    const stack = await buildStack();
    const built = unwrap(await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds), 'build');
    const ws = unwrap(await stack.decisions.getWorkspace(scope, built.decision.id, built.revisionId), 'workspace');

    assert.equal(ws.actionIntents.length, 3);
    assert.deepEqual(
      ws.actionIntents.map((a) => a.targetSystem).sort(),
      ['finance', 'memoire', 'scm'],
    );
    // The commercial conversation is Memoire's work; HELM only records the intent.
    const toMemoire = ws.actionIntents.find((a) => a.targetSystem === 'memoire');
    assert.match(toMemoire.detail, /happens in Memoire/);
    assert.equal(toMemoire.handoffRef, null, 'Phase 5 hands nothing over');
    assert.equal(toMemoire.status, 'INTENDED');

    const payload = unwrap(await stack.decisions.committedEvent(scope, built.commitment.id), 'event');
    assert.equal(payload.type, 'DecisionCommitted');
    assert.equal(payload.managementQuestion, built.decision.managementQuestion);
    assert.equal(payload.chosenAlternative.scenarioKey, 'reallocate');
    assert.deepEqual(payload.targetSystems, ['finance', 'memoire', 'scm']);
  });

  it('keeps every rejected future accessible after the commitment', async () => {
    const stack = await buildStack();
    const built = unwrap(await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds), 'build');
    const explained = unwrap(await stack.decisions.explainDecision(scope, built.decision.id), 'explain');

    assert.equal(explained.rejected.length, 4);
    const labels = explained.rejected.map((a) => a.label).sort();
    assert.deepEqual(labels, [
      'A — Expedite supply',
      'C — Offer the alternative analyzer',
      'D — Delay delivery to 2027-Q1',
      'E — Replace the distributor',
    ]);
    // And the futures they referenced are still readable.
    for (const a of explained.rejected.filter((x) => x.scenarioRunId)) {
      const state = unwrap(await stack.scenarios.getFutureState(scope, a.scenarioRunId), a.label);
      assert.ok(state.values.length > 0);
    }
  });

  it('builds a timeline of what happened, in record time', async () => {
    const stack = await buildStack();
    const built = unwrap(await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds), 'build');
    const timeline = unwrap(await stack.decisions.timeline(scope, built.decision.id), 'timeline');

    const types = timeline.map((e) => e.eventType);
    assert.equal(types[0], 'DECISION_OPENED');
    for (const wanted of [
      'ALTERNATIVE_ADDED',
      'CRITERION_ADDED',
      'ASSESSMENT_RECORDED',
      'ASSUMPTION_ADDED',
      'EVIDENCE_ADDED',
      'ASSUMPTION_CHALLENGED',
      'CHALLENGE_RESOLVED',
      'REVISION_SEALED',
      'COMMITTED',
      'ACTION_INTENT_ADDED',
    ]) {
      assert.ok(types.includes(wanted), `the timeline should record ${wanted}`);
    }
    assert.ok(types.indexOf('COMMITTED') > types.indexOf('ALTERNATIVE_ADDED'));
    const committed = timeline.find((e) => e.eventType === 'COMMITTED');
    assert.equal(committed.payload.chosenLabel, 'B — Reallocate distributor stock');
    assert.equal(committed.payload.readinessAtCommitment, 'READY_WITH_GAPS');
    assert.equal(committed.payload.openChallenges.length, 1);
  });
});
