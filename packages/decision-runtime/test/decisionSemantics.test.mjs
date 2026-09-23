/**
 * Decision semantics: the rules that make a commitment worth keeping.
 *
 * Immutability of the committed basis, the knowledge boundary, evidence
 * freshness, reconsideration, readiness, weighting, isolation and the
 * distinction between a decision's quality and its outcome.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMeridianDecision } from '../src/index.ts';
import { Q4_2026 } from '@helm/scenario-runtime';
import { buildStack, expectFail, ORG_A, ORG_B, scope, scopeFor, unwrap } from './harness.mjs';

const otherScope = scopeFor(ORG_B);

describe('commitment immutability', () => {
  it('freezes the evidence basis: nothing about the committed revision can be changed', async () => {
    const stack = await buildStack();
    const built = unwrap(await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds), 'build');
    const { revisionId } = built;

    // 1. the chosen alternative cannot be re-bound to another future
    const rebind = expectFail(
      await stack.decisions.bindScenario(scope, built.alternatives['reallocate'].id, stack.scenarioIds['expedite']),
      'rebinding the chosen alternative',
    );
    assert.equal(rebind.code, 'decision.revision_sealed');

    // 2. no alternative can be added, withdrawn or re-bound
    assert.equal(
      expectFail(
        await stack.decisions.addAlternative(scope, revisionId, { label: 'F — something new' }),
        'adding an alternative after the commitment',
      ).code,
      'decision.revision_sealed',
    );
    assert.equal(
      expectFail(
        await stack.decisions.withdrawAlternative(scope, built.alternatives['delay'].id, 'changed my mind'),
        'withdrawing after the commitment',
      ).code,
      'decision.revision_sealed',
    );

    // 3. no criterion can be added or re-stated
    assert.equal(
      expectFail(
        await stack.decisions.addCriterion(scope, revisionId, {
          key: 'after-the-fact',
          name: 'Added later',
          style: 'PREFERENCE',
          author: { kind: 'ROLE', label: 'Someone', userId: null },
          rationale: 'thought of it afterwards',
        }),
        'adding a criterion after the commitment',
      ).code,
      'decision.revision_sealed',
    );

    // 4. no assumption, challenge or assessment can be added
    assert.equal(
      expectFail(
        await stack.decisions.addAssumption(scope, revisionId, { statement: 'Something we thought all along.' }),
        'adding an assumption after the commitment',
      ).code,
      'decision.revision_sealed',
    );
    assert.equal(
      expectFail(
        await stack.decisions.challenge(scope, revisionId, {
          targetKind: 'CONTEXT',
          author: { kind: 'ROLE', label: 'Someone', userId: null },
          concern: 'A concern raised after the decision was taken.',
        }),
        'challenging after the commitment',
      ).code,
      'decision.revision_sealed',
    );

    // 5. the decision cannot be committed twice
    assert.equal(
      expectFail(
        await stack.decisions.commit(scope, revisionId, {
          chosenAlternativeId: built.alternatives['expedite'].id,
          authorship: 'MANAGEMENT_AUTHORED',
          committedByLabel: 'Someone else',
          summary: 'Actually, expedite.',
          rationale: [{ kind: 'JUDGEMENT', ref: null, label: 'Changed mind', statement: 'On reflection.' }],
          acceptedTradeOffs: [],
        }),
        'committing twice',
      ).code,
      'decision.revision_sealed',
    );

    // 6. the framing of a committed decision is part of the record
    assert.equal(
      expectFail(
        await stack.decisions.updateFraming(scope, built.decision.id, {
          managementQuestion: 'A different question entirely, asked afterwards.',
        }),
        'rewriting the question after the fact',
      ).code,
      'decision.commitment_immutable',
    );
  });

  it('keeps the snapshot and its fingerprint exactly as they were', async () => {
    const stack = await buildStack();
    const built = unwrap(await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds), 'build');
    const before = unwrap(await stack.decisions.getCommitmentSnapshot(scope, built.commitment.id), 'snapshot');

    // Everything that changed afterwards — a new simulation, new evidence —
    // leaves the manifest alone.
    unwrap(await stack.scenarios.execute(scope, stack.scenarioIds['reallocate']), 're-simulate');
    unwrap(
      await stack.decisions.addEvidence(scope, built.revisionId, {
        kind: 'MARKET_SIGNAL',
        title: 'Something learned the next morning',
        relation: 'CHALLENGE',
        targetKind: 'CONTEXT',
        sourceSystem: 'market',
      }),
      'later evidence',
    );

    const after = unwrap(await stack.decisions.getCommitmentSnapshot(scope, built.commitment.id), 'snapshot again');
    assert.deepEqual(after, before);
    assert.equal(after.fingerprint, before.fingerprint);
    assert.match(after.fingerprint, /^dsn_[0-9a-f]{16}_\d+$/);
  });

  it('records the exact future state management committed against, not today\'s re-simulation', async () => {
    const stack = await buildStack();
    const built = unwrap(await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds), 'build');
    const snapshot = unwrap(await stack.decisions.getCommitmentSnapshot(scope, built.commitment.id), 'snapshot');
    const chosen = snapshot.alternatives.find((a) => a.chosen);
    assert.equal(chosen.scenarioKey, 'reallocate');

    const committedRunId = chosen.scenarioRunId;
    const committedFingerprint = chosen.scenarioFingerprint;

    // Simulate the same scenario again: a NEW run with a new id.
    const again = unwrap(await stack.scenarios.execute(scope, stack.scenarioIds['reallocate']), 're-simulate');
    assert.notEqual(again.run.id, committedRunId, 'a re-simulation is a different run');

    // The commitment still points at the original run, and that run still reads.
    const state = unwrap(await stack.scenarios.getFutureState(scope, committedRunId), 'committed future');
    assert.equal(state.run.fingerprint, committedFingerprint);
    const gm = state.values.find((v) => v.metricKey === 'GrossMarginPct' && v.nodeLabel.includes('Rohto'));
    assert.equal(gm.value, '32.3878');
  });

  it('refuses to commit over an open challenge unless management says so explicitly', async () => {
    const stack = await buildStack();
    const built = unwrap(
      await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds, { commit: false }),
      'build',
    );
    const quiet = expectFail(
      await stack.decisions.commit(scope, built.revisionId, {
        chosenAlternativeId: built.alternatives['reallocate'].id,
        authorship: 'MANAGEMENT_AUTHORED',
        committedByLabel: 'Country GM Vietnam',
        summary: 'Reallocate.',
        rationale: [{ kind: 'JUDGEMENT', ref: null, label: 'Because', statement: 'It reads best on the numbers.' }],
        acceptedTradeOffs: [],
      }),
      'committing over an open challenge',
    );
    assert.match(quiet.message, /still open/);
    assert.match(quiet.message, /acknowledgeOpenChallenges/);

    // With the acknowledgement it goes through, and the challenge stays OPEN.
    const done = unwrap(
      await stack.decisions.commit(scope, built.revisionId, {
        chosenAlternativeId: built.alternatives['reallocate'].id,
        authorship: 'MANAGEMENT_AUTHORED',
        committedByLabel: 'Country GM Vietnam',
        summary: 'Reallocate.',
        rationale: [{ kind: 'JUDGEMENT', ref: null, label: 'Because', statement: 'It reads best on the numbers.' }],
        acceptedTradeOffs: [],
        acknowledgeOpenChallenges: true,
      }),
      'committing with the acknowledgement',
    );
    assert.equal(done.snapshot.openChallenges.length, 1);
  });

  it('refuses to commit a decision that is NOT_READY', async () => {
    const stack = await buildStack();
    const created = unwrap(
      await stack.decisions.createDecision(scope, {
        title: 'Half a decision',
        managementQuestion: 'Should we do the only thing anyone has proposed?',
        triggerType: 'MANUAL',
        owner: { kind: 'ROLE', label: 'Country GM Vietnam', userId: null },
      }),
      'create',
    );
    const only = unwrap(
      await stack.decisions.addAlternative(scope, created.revision.id, {
        label: 'The only option',
        scenarioId: stack.scenarioIds['expedite'],
      }),
      'alternative',
    );
    const readiness = unwrap(await stack.decisions.evaluateReadiness(scope, created.revision.id), 'readiness');
    assert.equal(readiness.state, 'NOT_READY');
    assert.ok(readiness.gaps.some((g) => g.code === 'too-few-alternatives'));
    assert.ok(readiness.gaps.some((g) => g.code === 'no-criteria'));

    const refused = expectFail(
      await stack.decisions.commit(scope, created.revision.id, {
        chosenAlternativeId: only.id,
        authorship: 'MANAGEMENT_AUTHORED',
        committedByLabel: 'Someone',
        summary: 'Do the only thing.',
        rationale: [{ kind: 'JUDGEMENT', ref: null, label: 'Because', statement: 'There is nothing else.' }],
        acceptedTradeOffs: [],
      }),
      'committing a NOT_READY decision',
    );
    assert.equal(refused.code, 'decision.not_ready');
  });
});

describe('the knowledge boundary', () => {
  it('keeps the committed analysis reproducible when the world moves on', async () => {
    const stack = await buildStack();
    const built = unwrap(await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds), 'build');
    const snapshot = unwrap(await stack.decisions.getCommitmentSnapshot(scope, built.commitment.id), 'snapshot');
    const t1 = snapshot.fork.recordedThrough;

    // T2: four days pass and Finance files a new view of the world.
    stack.clock.jump(4 * 24 * 3600 * 1000);
    const t2 = stack.clock.peek().toISOString();
    assert.ok(new Date(t2).getTime() > new Date(t1).getTime());

    // The committed run still replays, at ITS OWN pinned boundary, to the same
    // numbers — four days of new knowledge do not reach it.
    const chosen = snapshot.alternatives.find((a) => a.chosen);
    const committedRun = unwrap(await stack.scenarios.getFutureState(scope, chosen.scenarioRunId), 'committed run');
    const replayed = unwrap(await stack.scenarios.replay(scope, chosen.scenarioRunId), 'replay');
    assert.equal(replayed.run.fingerprint, chosen.scenarioFingerprint);
    assert.equal(replayed.run.fork.recordedThrough, committedRun.run.fork.recordedThrough);
    assert.ok(new Date(replayed.run.fork.recordedThrough).getTime() < new Date(t2).getTime());
    const gm = replayed.futureState.values.find(
      (v) => v.metricKey === 'GrossMarginPct' && v.nodeLabel.includes('Rohto'),
    );
    assert.equal(gm.value, '32.3878');

    // And the decision's own knowledge boundary is untouched.
    const after = unwrap(await stack.decisions.getCommitmentSnapshot(scope, built.commitment.id), 'snapshot again');
    assert.equal(after.fork.recordedThrough, t1);
  });

  it('flags alternatives modelled at different knowledge boundaries as a gap', async () => {
    const stack = await buildStack();
    const created = unwrap(
      await stack.decisions.createDecision(scope, {
        title: 'Mixed boundaries',
        managementQuestion: 'Which of these two futures should we commit to?',
        triggerType: 'MANUAL',
        owner: { kind: 'ROLE', label: 'Country GM Vietnam', userId: null },
      }),
      'create',
    );
    unwrap(
      await stack.decisions.addAlternative(scope, created.revision.id, {
        label: 'A — Expedite',
        scenarioId: stack.scenarioIds['expedite'],
      }),
      'A',
    );
    // Rebase and re-simulate the other scenario: a later boundary.
    stack.clock.jump(3 * 24 * 3600 * 1000);
    unwrap(await stack.scenarios.rebase(scope, stack.scenarioIds['reallocate']), 'rebase');
    unwrap(await stack.scenarios.execute(scope, stack.scenarioIds['reallocate']), 're-simulate');
    unwrap(
      await stack.decisions.addAlternative(scope, created.revision.id, {
        label: 'B — Reallocate',
        scenarioId: stack.scenarioIds['reallocate'],
      }),
      'B',
    );
    unwrap(
      await stack.decisions.addCriterion(scope, created.revision.id, {
        key: 'gm',
        name: 'Gross margin %',
        style: 'PREFERENCE',
        metricKey: 'GrossMarginPct',
        subjectHint: 'Rohto',
        direction: 'HIGHER_IS_BETTER',
        author: { kind: 'ROLE', label: 'Finance Director Vietnam', userId: null },
        rationale: 'Margin is the thing under pressure this quarter.',
      }),
      'criterion',
    );

    const readiness = unwrap(await stack.decisions.evaluateReadiness(scope, created.revision.id), 'readiness');
    const gap = readiness.gaps.find((g) => g.code === 'mixed-knowledge-boundaries');
    assert.ok(gap, 'mixed knowledge boundaries must be surfaced');
    assert.match(gap.message, /mix the alternative's effect with what was learned in between/);
  });
});

describe('evidence freshness', () => {
  it('records evidence after a commitment without folding it into the frozen basis', async () => {
    const stack = await buildStack();
    const built = unwrap(await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds), 'build');
    const snapshot = unwrap(await stack.decisions.getCommitmentSnapshot(scope, built.commitment.id), 'snapshot');
    const evidenceAtCommitment = snapshot.evidenceIds.length;

    stack.clock.jump(2 * 24 * 3600 * 1000);
    const later = unwrap(
      await stack.decisions.addEvidence(scope, built.revisionId, {
        kind: 'SUPPLIER_COMMITMENT',
        title: 'Distributor D confirms release in writing, 25 Sep',
        detail: 'Arrived two days after the decision was taken.',
        relation: 'SUPPORT',
        targetKind: 'CONTEXT',
        sourceSystem: 'scm',
      }),
      'later evidence',
    );

    const explained = unwrap(await stack.decisions.explainDecision(scope, built.decision.id), 'explain');
    assert.equal(explained.evidenceAfterCommitment.length, 1);
    assert.equal(explained.evidenceAfterCommitment[0].id, later.id);
    assert.ok(!explained.evidence.some((e) => e.id === later.id), 'the committed evidence set does not grow');

    const after = unwrap(await stack.decisions.getCommitmentSnapshot(scope, built.commitment.id), 'snapshot again');
    assert.equal(after.evidenceIds.length, evidenceAtCommitment);
    assert.ok(!after.evidenceIds.includes(later.id));
  });
});

describe('reconsideration', () => {
  it('creates a new revision and leaves the commitment exactly as it was', async () => {
    const stack = await buildStack();
    const built = unwrap(await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds), 'build');
    const before = unwrap(await stack.decisions.getCommitmentSnapshot(scope, built.commitment.id), 'snapshot');

    stack.clock.jump(4 * 24 * 3600 * 1000);
    const r2 = unwrap(
      await stack.decisions.reconsider(scope, built.decision.id, {
        reason: 'Supplier A notified a three-day delay, and Finance filed a new quarter forecast.',
        rebaseScenarios: true,
      }),
      'reconsider',
    );

    assert.equal(r2.revisionNumber, 2);
    assert.equal(r2.reason, 'RECONSIDERED');
    assert.equal(r2.reconsidersCommitmentId, built.commitment.id);
    assert.ok(new Date(r2.fork.recordedThrough).getTime() > new Date(before.fork.recordedThrough).getTime());

    // The old commitment and its manifest are untouched.
    const after = unwrap(await stack.decisions.getCommitmentSnapshot(scope, built.commitment.id), 'snapshot again');
    assert.deepEqual(after, before);

    // The carried-forward alternatives are rebased and NOT yet simulated, so
    // they are honestly unmodelled rather than silently re-valued.
    const ws = unwrap(await stack.decisions.getWorkspace(scope, built.decision.id, r2.id), 'workspace');
    const modelledNow = ws.alternatives.filter((a) => a.status === 'MODELLED');
    assert.equal(modelledNow.length, 0);
    const rebased = ws.alternatives.find((a) => a.label.includes('Reallocate'));
    assert.match(rebased.unmodelledReason, /not yet simulated/);
    assert.match(rebased.unmodelledReason, /committed future remains exactly as it was/);
    assert.ok(rebased.scenarioRevisionId, 'the rebased scenario revision is referenced');

    // Criteria and assumptions came across.
    assert.equal(ws.criteria.length, 6);
    assert.equal(ws.assumptions.length, 5);
    assert.ok(ws.assumptions.every((a) => a.outcome === 'PENDING'));

    const timeline = unwrap(await stack.decisions.timeline(scope, built.decision.id), 'timeline');
    const event = timeline.find((e) => e.eventType === 'RECONSIDERED');
    assert.equal(event.payload.rebased, true);
    assert.match(event.payload.reason, /three-day delay/);
  });

  it('refuses to reconsider a decision nobody has committed', async () => {
    const stack = await buildStack();
    const built = unwrap(
      await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds, { commit: false }),
      'build',
    );
    const e = expectFail(
      await stack.decisions.reconsider(scope, built.decision.id, { reason: 'Something changed already.' }),
      'reconsidering nothing',
    );
    assert.equal(e.code, 'decision.not_committed');
  });
});

describe('weights and scores', () => {
  it('refuses a weighted view unless management declares the method', async () => {
    const stack = await buildStack();
    const built = unwrap(
      await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds, { commit: false }),
      'build',
    );
    const e = expectFail(await stack.decisions.weightedView(scope, built.revisionId), 'weighted view');
    assert.equal(e.code, 'decision.weighting_not_declared');
    assert.match(e.message, /unless management states the method/);
  });

  it('refuses a weighted criterion with no weight, and computes one only from a declared method', async () => {
    const stack = await buildStack();
    const created = unwrap(
      await stack.decisions.createDecision(scope, {
        title: 'Weighted by hand',
        managementQuestion: 'Which of these should we commit to, weighting margin over cash?',
        triggerType: 'MANUAL',
        owner: { kind: 'ROLE', label: 'Country GM Vietnam', userId: null },
      }),
      'create',
    );
    const author = { kind: 'PERSON', label: 'Country GM Vietnam', userId: null };

    assert.match(
      expectFail(
        await stack.decisions.addCriterion(scope, created.revision.id, {
          key: 'unweighted',
          name: 'Weighted with no weight',
          style: 'OPTIONAL_WEIGHTED',
          metricKey: 'GrossMarginPct',
          author,
          rationale: 'Someone forgot the weight.',
        }),
        'weighted criterion without a weight',
      ).message,
      /no default weight/,
    );

    unwrap(
      await stack.decisions.addAlternative(scope, created.revision.id, {
        label: 'A — Expedite',
        scenarioId: stack.scenarioIds['expedite'],
      }),
      'A',
    );
    unwrap(
      await stack.decisions.addAlternative(scope, created.revision.id, {
        label: 'B — Reallocate',
        scenarioId: stack.scenarioIds['reallocate'],
      }),
      'B',
    );
    for (const [key, metricKey, weight, direction] of [
      ['margin', 'GrossMarginPct', 0.7, 'HIGHER_IS_BETTER'],
      ['cash', 'CashImpact', 0.3, 'HIGHER_IS_BETTER'],
    ]) {
      unwrap(
        await stack.decisions.addCriterion(scope, created.revision.id, {
          key,
          name: key,
          style: 'OPTIONAL_WEIGHTED',
          metricKey,
          subjectHint: 'Rohto',
          weight,
          direction,
          author,
          rationale: 'The GM chose this weight explicitly for this decision.',
        }),
        key,
      );
    }

    unwrap(
      await stack.decisions.declareWeighting(scope, created.revision.id, {
        method: 'Min-max normalize each weighted criterion across the alternatives, then sum weight × normalized value.',
        rationale: 'The GM wants a single comparable number for this decision only, and accepts what that hides.',
        author,
      }),
      'declare weighting',
    );

    const view = unwrap(await stack.decisions.weightedView(scope, created.revision.id), 'weighted view');
    assert.equal(view.weighting.author.label, 'Country GM Vietnam');
    assert.match(view.statement, /management's own/);
    const b = view.perAlternative.find((p) => p.alternativeLabel.includes('Reallocate'));
    // B is best on both weighted criteria here, so it normalizes to 1 on each.
    assert.equal(b.total, '1');
    assert.equal(b.incomplete, false);
    const a = view.perAlternative.find((p) => p.alternativeLabel.includes('Expedite'));
    assert.equal(a.total, '0');
  });
});

describe('isolation', () => {
  it('does not let a decision bind another organization\'s scenario', async () => {
    const stack = await buildStack({ orgs: [ORG_A, ORG_B] });
    const created = unwrap(
      await stack.decisions.createDecision(scope, {
        title: 'Cross-tenant attempt',
        managementQuestion: 'Can a decision here reach into another organization?',
        triggerType: 'MANUAL',
      }),
      'create',
    );
    const e = expectFail(
      await stack.decisions.addAlternative(scope, created.revision.id, {
        label: 'Their scenario',
        scenarioId: stack.scenarioIdsByOrg[ORG_B]['expedite'],
      }),
      'binding across tenants',
    );
    assert.equal(e.code, 'decision.scenario_not_found');
  });

  it('does not show one organization\'s decisions to another', async () => {
    const stack = await buildStack({ orgs: [ORG_A, ORG_B] });
    const built = unwrap(await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds), 'build');

    assert.equal(unwrap(await stack.decisions.listDecisions(otherScope), 'other list').length, 0);
    assert.equal(unwrap(await stack.decisions.getDecision(otherScope, built.decision.id), 'other get'), null);
    assert.equal(
      expectFail(await stack.decisions.explainDecision(otherScope, built.decision.id), 'other explain').code,
      'decision.not_found',
    );
    assert.equal(
      expectFail(await stack.decisions.getCommitmentSnapshot(otherScope, built.commitment.id), 'other snapshot').code,
      'decision.not_found',
    );
    assert.equal(unwrap(await stack.decisions.timeline(otherScope, built.decision.id), 'other timeline').length, 0);
  });
});

describe('a scenario that cannot be bound', () => {
  it('refuses to bind a scenario that has never been simulated', async () => {
    const stack = await buildStack({ simulate: false });
    const scenario = unwrap(
      await stack.scenarios.createScenario(scope, {
        key: 'never-run',
        name: 'Never simulated',
        description: 'Created and left alone.',
        fork: stack.fork,
        periods: [Q4_2026],
      }),
      'scenario',
    );
    const created = unwrap(
      await stack.decisions.createDecision(scope, {
        title: 'Binding an unsimulated scenario',
        managementQuestion: 'What happens if an alternative points at a scenario nobody ran?',
        triggerType: 'MANUAL',
      }),
      'create',
    );
    const e = expectFail(
      await stack.decisions.addAlternative(scope, created.revision.id, {
        label: 'Unrun',
        scenarioId: scenario.scenario.id,
      }),
      'binding an unsimulated scenario',
    );
    assert.equal(e.code, 'decision.scenario_not_completed');
    assert.match(e.message, /UNMODELLED, not an alternative with zeros/);
  });
});

describe('expected versus actual', () => {
  it('reports variance and assumption outcomes without judging the decision', async () => {
    const stack = await buildStack();
    const built = unwrap(await buildMeridianDecision(stack.decisions, scope, stack.scenarioIds), 'build');

    stack.clock.jump(30 * 24 * 3600 * 1000);
    const review = unwrap(
      await stack.decisions.recordOutcomeReview(scope, built.commitment.id, {
        reviewedByLabel: 'Finance Director Vietnam',
        actuals: [
          { label: 'Gross margin %', metricKey: 'GrossMarginPct', actual: '31.7' },
          { label: 'Customer service', metricKey: 'DemandCoverage', actual: '92' },
        ],
        assumptionResults: [
          {
            assumptionId: built.assumptions['distributor-release'].id,
            outcome: 'CONFIRMED',
            note: 'Distributor D released all eight units on 2 October.',
          },
          {
            assumptionId: built.assumptions['tender-material'].id,
            outcome: 'DISPROVED',
            note: 'The provincial tender was postponed to Q1.',
          },
        ],
        notes: 'Margin came in below the modelled figure because the re-labelling cost Finance flagged was real.',
      }),
      'review',
    );

    const gm = review.variances.find((v) => v.metricKey === 'GrossMarginPct');
    assert.equal(gm.expected, '32.3878');
    assert.equal(gm.actual, '31.7');
    assert.equal(gm.variance, '-0.6878');
    const service = review.variances.find((v) => v.metricKey === 'DemandCoverage');
    assert.equal(service.expected, '96.8858');
    assert.equal(service.variance, '-4.8858');

    assert.equal(review.assumptionResults.length, 2);
    assert.match(review.statement, /not a verdict on the decision/);
    assert.ok(!('quality' in review), 'an outcome review does not score the decision');
    assert.ok(!('outcomeScore' in review));

    // The assumption outcomes are recorded on the assumptions themselves.
    const ws = unwrap(await stack.decisions.getWorkspace(scope, built.decision.id, built.revisionId), 'workspace');
    assert.equal(ws.assumptions.find((a) => a.id === built.assumptions['distributor-release'].id).outcome, 'CONFIRMED');
    assert.equal(ws.assumptions.find((a) => a.id === built.assumptions['tender-material'].id).outcome, 'DISPROVED');
    // And the frozen manifest still says what was believed at the time.
    const snapshot = unwrap(await stack.decisions.getCommitmentSnapshot(scope, built.commitment.id), 'snapshot');
    assert.ok(snapshot.assumptionIds.includes(built.assumptions['tender-material'].id));
  });
});
