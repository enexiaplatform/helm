/**
 * Scenario Runtime semantics — the §74 categories not covered by the canonical
 * proofs: lifecycle, revisions, validation, inheritance limits, replay versus
 * rebase, period selection, fingerprints, tenancy, concurrency, lineage and
 * model-version preservation.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { asValidTime, quarterPeriod } from '@helm/shared';
import {
  createCalculationRegistry,
  createPropagationEngine,
  meridianValueModelV1,
} from '@helm/propagation-engine';
import { buildSeedValueRegistry } from '@helm/value-graph';
import { buildSeedRegistry } from '@helm/ontology';
import {
  buildMeridianScenarios,
  createScenarioRuntime,
  meridianConstraintsV1,
  meridianStateFrame,
  scenarioFingerprint,
  Q4_2026,
  Q1_2027,
} from '../src/index.ts';
import { ORG_A, ORG_B, buildStack, scope, scopeFor, unwrap, valueOf } from './harness.mjs';

const freight = (ids, value, extra = {}) => ({
  overrideType: 'VALUE_OVERRIDE', targetNodeId: ids.freightOpex, operation: 'ADD', value,
  unit: 'currency', currency: 'VND', provenanceKind: 'EXTERNAL_SIGNAL',
  rationale: 'Air-freight premium from the forwarder quote.', confidence: 0.85, ...extra,
});
const probability = (ids, value) => ({
  overrideType: 'VALUE_OVERRIDE', targetNodeId: ids.oppProb, value, unit: 'ratio',
  provenanceKind: 'MANAGEMENT_ASSUMPTION', rationale: 'Sales leadership expects to close at this level.',
  confidence: 0.6,
});

async function scenarioWith(s, key, overrides, extra = {}) {
  const created = unwrap(
    await s.runtime.createScenario(scope, { key, name: key, fork: s.fork, periods: [Q4_2026], ...extra }),
    `create ${key}`,
  );
  for (const o of overrides) unwrap(await s.runtime.addOverride(scope, created.revision.id, o), `override ${key}`);
  return created;
}

const gm = (exec, s, period = '2026-Q4') => valueOf(exec.futureState, s.ids.grossMargin, period)?.value;

// ============================================================ 1. creation

describe('1. scenario creation', () => {
  test('a scenario is a branch: identity, a draft revision, a pinned fork — and no copied data', async () => {
    const s = await buildStack();
    const before = unwrap(await s.valueGraph.getObservations(scope, { nodeId: s.ids.grossMargin }), 'obs').length;
    const { scenario, revision } = unwrap(
      await s.runtime.createScenario(scope, { key: 'branch', name: 'Branch', periods: [Q4_2026] }),
      'create',
    );
    assert.equal(scenario.status, 'DRAFT');
    assert.equal(revision.revisionNumber, 1);
    assert.equal(revision.state, 'DRAFT');
    assert.equal(revision.reason, 'CREATED');
    assert.equal(revision.fork.policy, 'SOURCE_TRUTH');
    assert.ok(Date.parse(revision.fork.recordedThrough) <= s.clock.peek().getTime());
    const entity = unwrap(await s.graphStore.getEntity(scope, scenario.scenarioEntityId), 'entity');
    assert.equal(entity.entityTypeKey, 'Scenario');
    const after = unwrap(await s.valueGraph.getObservations(scope, { nodeId: s.ids.grossMargin }), 'obs').length;
    assert.equal(after, before, 'creating a scenario copies nothing into the value graph');
  });

  test('keys are validated and unique per organization', async () => {
    const s = await buildStack();
    assert.equal((await s.runtime.createScenario(scope, { key: 'Bad Key', name: 'x', periods: [Q4_2026] })).ok, false);
    unwrap(await s.runtime.createScenario(scope, { key: 'dup', name: 'x', periods: [Q4_2026] }), 'first');
    const again = await s.runtime.createScenario(scope, { key: 'dup', name: 'y', periods: [Q4_2026] });
    assert.equal(again.ok, false);
    assert.equal(again.error.code, 'scenario.duplicate_key');
  });

  test('a fork cannot claim knowledge from the future, nor read under the SCENARIO policy', async () => {
    const s = await buildStack();
    const future = await s.runtime.createScenario(scope, {
      key: 'future', name: 'x', periods: [Q4_2026],
      fork: { recordedThrough: '2030-01-01T00:00:00.000Z' },
    });
    assert.equal(future.ok, false);
    assert.match(future.error.message, /cannot be in the future/);
    const policy = await s.runtime.createScenario(scope, {
      key: 'pol', name: 'x', periods: [Q4_2026], fork: { policy: 'SCENARIO' },
    });
    assert.equal(policy.ok, false);
  });
});

// ============================================== 2. revision and immutability

describe('2. revisions (§37–38, §65)', () => {
  test('freight 80M → 120M: the historical execution is unchanged, the new revision reflects 120M', async () => {
    const s = await buildStack();
    const a = await scenarioWith(s, 'a', [freight(s.ids, '80000000')]);
    const r1 = unwrap(await s.runtime.execute(scope, a.scenario.id), 'r1');
    assert.equal(gm(r1, s), '897200000');

    // The sealed revision refuses edits, from the runtime and from the store.
    const sealedEdit = await s.runtime.addOverride(scope, a.revision.id, probability(s.ids, '0.9'));
    assert.equal(sealedEdit.ok, false);
    assert.equal(sealedEdit.error.code, 'scenario.revision_sealed');
    const own = unwrap(await s.runtime.listOverrides(scope, a.revision.id), 'overrides');
    assert.equal((await s.store.removeOverride(scope, own[0].id)).ok, false);

    const r2rev = unwrap(await s.runtime.createRevision(scope, a.scenario.id, { notes: 'new quote' }), 'revise');
    assert.equal(r2rev.revisionNumber, 2);
    assert.equal(r2rev.reason, 'EDITED');
    assert.equal(r2rev.basedOnRevisionId, a.revision.id);
    const carried = unwrap(await s.runtime.listOverrides(scope, r2rev.id), 'carried');
    unwrap(await s.runtime.removeOverride(scope, carried[0].id), 'remove from draft');
    unwrap(await s.runtime.addOverride(scope, r2rev.id, freight(s.ids, '120000000')), 'new freight');
    const r2 = unwrap(await s.runtime.execute(scope, a.scenario.id), 'r2');
    assert.equal(gm(r2, s), '857200000');
    assert.notEqual(r2.run.fingerprint, r1.run.fingerprint);

    // History, re-read after the new revision ran:
    const old = unwrap(await s.runtime.getFutureState(scope, r1.run.id), 'old state');
    assert.equal(valueOf(old, s.ids.grossMargin, '2026-Q4').value, '897200000');
    assert.equal(old.revision.revisionNumber, 1);
    const sealed1 = unwrap(await s.store.getRevision(scope, a.revision.id), 'r1 row');
    assert.equal(sealed1.state, 'SEALED');
  });

  test('only one draft at a time; a new draft carries the pin and the fork', async () => {
    const s = await buildStack();
    const a = await scenarioWith(s, 'a', [freight(s.ids, '80000000')]);
    const again = await s.runtime.createRevision(scope, a.scenario.id);
    assert.equal(again.ok, false, 'revision 1 is still a draft');
    unwrap(await s.runtime.markReady(scope, a.revision.id), 'seal');
    const r2 = unwrap(await s.runtime.createRevision(scope, a.scenario.id), 'r2');
    assert.deepEqual(r2.fork, a.revision.fork);
  });
});

// ================================================ 3. override validation

describe('3. override validation', () => {
  test('every malformed override is refused with a reason', async () => {
    const s = await buildStack();
    const { revision } = unwrap(
      await s.runtime.createScenario(scope, { key: 'v', name: 'v', fork: s.fork, periods: [Q4_2026] }),
      'create',
    );
    const expectFail = async (input, code) => {
      const r = await s.runtime.addOverride(scope, revision.id, input);
      assert.equal(r.ok, false, JSON.stringify(input));
      if (code) assert.equal(r.error.code, code);
      return r;
    };
    await expectFail({ ...probability(s.ids, '1.2') }, 'scenario.override_invalid'); // ratio > 1
    await expectFail({ ...probability(s.ids, '0.9'), unit: 'percentage' }, 'scenario.override_invalid');
    await expectFail({ ...freight(s.ids, '1'), currency: null }, 'scenario.override_invalid');
    await expectFail({ ...probability(s.ids, '0.9'), rationale: '' }, 'scenario.override_invalid');
    await expectFail({ ...probability(s.ids, 'abc') }, 'scenario.override_invalid');
    await expectFail({ ...probability(s.ids, '0.9'), targetNodeId: 'no-such-node' }, 'scenario.not_found');
    await expectFail({ ...probability(s.ids, '0.9'), period: Q1_2027 }, 'scenario.period_not_in_revision');
    await expectFail({ ...probability(s.ids, '0.9'), confidence: 1.5 }, 'scenario.override_invalid');
  });

  test('an outcome cannot be overridden: the model computes it', async () => {
    const s = await buildStack();
    const { revision } = unwrap(
      await s.runtime.createScenario(scope, { key: 'v', name: 'v', fork: s.fork, periods: [Q4_2026] }),
      'create',
    );
    const r = await s.runtime.addOverride(scope, revision.id, {
      overrideType: 'VALUE_OVERRIDE', targetNodeId: s.ids.grossMargin, value: '1000000000',
      unit: 'currency', currency: 'VND', provenanceKind: 'USER_OVERRIDE',
      rationale: 'Just set the margin to what we want.', confidence: 1,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'scenario.override_targets_computed_node');
  });

  test('the engine refuses it too, if an overlay ever reached it', async () => {
    const s = await buildStack();
    const { scenario, revision } = unwrap(
      await s.runtime.createScenario(scope, { key: 'v', name: 'v', fork: s.fork, periods: [Q4_2026] }),
      'create',
    );
    const r = await s.engine.execute(scope, {
      effectiveAsOf: new Date(s.fork.effectiveAsOf), period: Q4_2026,
      scenarioEntityId: scenario.scenarioEntityId, scenarioRevisionId: revision.id,
      overlay: {
        scenarioId: scenario.id, revisionId: revision.id,
        entries: new Map([[s.ids.grossMargin, {
          overrideId: 'forged', nodeId: s.ids.grossMargin, operation: 'SET', value: '1', unit: 'currency',
          currency: 'VND', confidence: 1, scenarioId: scenario.id, revisionId: revision.id,
          inheritedFromScenarioId: null, shadowedOverrideIds: [], provenanceKind: 'USER_OVERRIDE',
        }]]),
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'calculation.override_targets_computed_node');
  });

  test('structural overrides have an interface and are refused, not faked', async () => {
    const s = await buildStack();
    const { revision } = unwrap(
      await s.runtime.createScenario(scope, { key: 'v', name: 'v', fork: s.fork, periods: [Q4_2026] }),
      'create',
    );
    const r = await s.runtime.addOverride(scope, revision.id, {
      overrideType: 'STRUCTURAL_OVERRIDE', targetNodeId: s.ids.leadTime, value: '0', unit: 'days',
      provenanceKind: 'MANAGEMENT_ASSUMPTION', rationale: 'Supplier B becomes available.',
      structuralChange: { kind: 'ADD_RELATIONSHIP', relationshipTypeKey: 'SUPPLIED_BY', fromEntityId: 'x', toEntityId: 'y' },
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'scenario.structural_override_deferred');
  });

  test('validation warns about an override no calculation reads', async () => {
    const s = await buildStack();
    const { revision } = await scenarioWith(s, 'lead', [{
      overrideType: 'ASSUMPTION_OVERRIDE', targetNodeId: s.ids.leadTime, value: '7', unit: 'days',
      provenanceKind: 'MANAGEMENT_ASSUMPTION', rationale: 'Expedited lead time from Supplier A.', confidence: 0.7,
    }]);
    const report = unwrap(await s.runtime.validate(scope, revision.id), 'validate');
    assert.equal(report.valid, true);
    assert.ok(report.issues.some((i) => i.code === 'scenario.inert_override'));
  });
});

// ======================================== 4–5. inheritance and conflict

describe('4–5. inheritance: bounded, pinned, child wins', () => {
  test('a parent edited later does not change the child it already fed', async () => {
    const s = await buildStack();
    const parent = await scenarioWith(s, 'parent', [freight(s.ids, '80000000')]);
    unwrap(await s.runtime.markReady(scope, parent.revision.id), 'seal parent');
    const child = await scenarioWith(s, 'child', [probability(s.ids, '0.8')], { parentScenarioId: parent.scenario.id, fork: undefined });
    const before = unwrap(await s.runtime.execute(scope, child.scenario.id), 'child run');

    // The parent moves to +200M in a new revision.
    const p2 = unwrap(await s.runtime.createRevision(scope, parent.scenario.id), 'p2');
    const carried = unwrap(await s.runtime.listOverrides(scope, p2.id), 'carried');
    unwrap(await s.runtime.removeOverride(scope, carried[0].id), 'remove');
    unwrap(await s.runtime.addOverride(scope, p2.id, freight(s.ids, '200000000')), 'p2 freight');
    unwrap(await s.runtime.markReady(scope, p2.id), 'seal p2');

    const after = unwrap(await s.runtime.execute(scope, child.scenario.id), 'child again');
    assert.equal(gm(after, s), gm(before, s), 'the child still inherits the revision it pinned');
    assert.equal(valueOf(after.futureState, s.ids.freightOpex, '2026-Q4').value, '220000000');
  });

  test('depth is bounded: parent and grandparent, no further', async () => {
    const s = await buildStack();
    let parentId = null;
    const keys = ['g0', 'g1', 'g2'];
    for (const key of keys) {
      const c = unwrap(
        await s.runtime.createScenario(scope, {
          key, name: key, periods: [Q4_2026], fork: parentId ? undefined : s.fork, parentScenarioId: parentId,
        }),
        key,
      );
      unwrap(await s.runtime.markReady(scope, c.revision.id), `seal ${key}`);
      parentId = c.scenario.id;
    }
    const tooDeep = await s.runtime.createScenario(scope, { key: 'g3', name: 'g3', parentScenarioId: parentId });
    assert.equal(tooDeep.ok, false);
    assert.equal(tooDeep.error.code, 'scenario.inheritance_too_deep');
  });

  test('a child cannot inherit an unsealed parent', async () => {
    const s = await buildStack();
    const parent = await scenarioWith(s, 'parent', [freight(s.ids, '80000000')]);
    const child = await s.runtime.createScenario(scope, { key: 'child', name: 'c', parentScenarioId: parent.scenario.id });
    assert.equal(child.ok, false);
    assert.equal(child.error.code, 'scenario.parent_not_sealed');
  });

  test('one target has one assumption per revision', async () => {
    const s = await buildStack();
    const { revision } = await scenarioWith(s, 'dup', [freight(s.ids, '80000000')]);
    const again = await s.runtime.addOverride(scope, revision.id, freight(s.ids, '90000000'));
    assert.equal(again.ok, false);
    assert.equal(again.error.code, 'scenario.override_duplicate');
  });
});

// ================================================ 9. replay, 10. rebase

describe('9–10. replay reproduces; rebase re-asks (§11, §61, §64)', () => {
  test('replay after new source data: identical outputs; rebase: same assumptions, new world', async () => {
    const s = await buildStack();
    const a = await scenarioWith(s, 'expedite', [freight(s.ids, '80000000')]);
    const t1 = unwrap(await s.runtime.execute(scope, a.scenario.id), 'T1');
    assert.equal(gm(t1, s), '897200000', '140M + 80M freight');

    // T2: Finance files a Q4 freight forecast of 160M.
    s.clock.jump(3600_000);
    unwrap(
      await s.valueGraph.recordObservation(scope, {
        nodeId: s.ids.freightOpex, observationType: 'FORECAST', numericValue: 160_000_000, unitType: 'currency',
        currency: 'VND', periodStart: asValidTime(Q4_2026.start), periodEnd: asValidTime(Q4_2026.end),
        sourceSystem: 'finance', confidence: 0.8,
      }),
      'finance forecast',
    );

    const replay = unwrap(await s.runtime.replay(scope, t1.run.id), 'replay');
    assert.equal(replay.run.kind, 'REPLAY');
    assert.equal(replay.run.replayOfRunId, t1.run.id);
    assert.equal(replay.run.fingerprint, t1.run.fingerprint);
    assert.deepEqual(replay.run.fork, t1.run.fork);
    for (const v of t1.futureState.values) {
      const w = valueOf(replay.futureState, v.nodeId, '2026-Q4');
      assert.equal(w?.value, v.value, `replay reproduces ${v.nodeLabel}`);
    }

    const rebased = unwrap(await s.runtime.rebase(scope, a.scenario.id), 'rebase');
    assert.equal(rebased.reason, 'REBASED');
    assert.equal(rebased.state, 'SEALED');
    assert.ok(Date.parse(rebased.fork.recordedThrough) > Date.parse(t1.run.fork.recordedThrough));
    assert.notEqual(rebased.fingerprint, t1.run.fingerprint, 'a different boundary is a different simulation');
    const t2 = unwrap(await s.runtime.execute(scope, a.scenario.id), 'T2');
    assert.equal(valueOf(t2.futureState, s.ids.freightOpex, '2026-Q4').value, '240000000', '160M + the same 80M');
    assert.equal(gm(t2, s), '877200000');

    const cmp = unwrap(
      await s.runtime.compare(scope, { baselineRunId: t1.run.id, alternativeRunIds: [t2.run.id] }),
      'compare',
    );
    const d = cmp.metricDeltas.find((x) => x.nodeId === s.ids.grossMargin);
    assert.equal(d.absoluteDelta, '-20000000', 'the rebase delta is what Finance learned');
    const c = cmp.comparability[0];
    assert.equal(c.sameFork, false);
    assert.match(c.warnings[0], /different boundary/);

    // The T1 run is still exactly what it was.
    const history = unwrap(await s.runtime.getFutureState(scope, t1.run.id), 'history');
    assert.equal(valueOf(history, s.ids.grossMargin, '2026-Q4').value, '897200000');
  });

  test('the engine will not replay a scenario run behind the runtime\'s back', async () => {
    const s = await buildStack();
    const a = await scenarioWith(s, 'a', [freight(s.ids, '80000000')]);
    const run = unwrap(await s.runtime.execute(scope, a.scenario.id), 'run');
    const r = await s.engine.replay(scope, run.run.periodRuns[0].calculationRunId);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'calculation.replay_requires_scenario_runtime');
  });
});

// ============================================ 11–12. period selection

describe('11–12. period selection and time mismatch in scenarios (§62)', () => {
  test('a Q4 simulation reads the Q4 claim and a Q1 simulation the Q1 claim', async () => {
    const s = await buildStack();
    // Freight now has a Q1 estimate as well as the Q4 one.
    unwrap(
      await s.valueGraph.recordObservation(scope, {
        nodeId: s.ids.freightOpex, observationType: 'ESTIMATE', numericValue: 50_000_000, unitType: 'currency',
        currency: 'VND', periodStart: asValidTime(Q1_2027.start), periodEnd: asValidTime(Q1_2027.end),
        sourceSystem: 'scm', confidence: 0.6,
      }),
      'q1 freight',
    );
    const fork = { ...s.fork, recordedThrough: s.clock.now().toISOString() };
    const two = unwrap(
      await s.runtime.createScenario(scope, { key: 'two', name: 'Q4 and Q1', fork, periods: [Q4_2026, Q1_2027] }),
      'create',
    );
    const run = unwrap(await s.runtime.execute(scope, two.scenario.id), 'run');
    assert.equal(valueOf(run.futureState, s.ids.freightOpex, '2026-Q4').value, '140000000', 'Q4 reads Q4');
    assert.equal(valueOf(run.futureState, s.ids.freightOpex, '2027-Q1').value, '50000000', 'Q1 reads Q1');
    // NEGATIVE: the pre-Phase-4 rule would have answered 2026-Q4 with the later period's 50M.
    assert.notEqual(valueOf(run.futureState, s.ids.freightOpex, '2026-Q4').value, '50000000');
  });

  test('a period nobody speaks to is BLOCKED with TIME_CONTEXT_MISMATCH, not read as zero', async () => {
    const s = await buildStack();
    const q1 = unwrap(
      await s.runtime.createScenario(scope, { key: 'q1', name: 'Q1 only', fork: s.fork, periods: [Q1_2027] }),
      'create',
    );
    const run = unwrap(await s.runtime.execute(scope, q1.scenario.id), 'run');
    const margin = valueOf(run.futureState, s.ids.grossMargin, '2027-Q1');
    assert.equal(margin.origin, 'BLOCKED');
    assert.equal(margin.value, null);
    assert.match(margin.reason, /time_context_mismatch/);
    assert.equal(run.futureState.completeness, 'PARTIAL');
    assert.equal(run.run.status, 'PARTIAL');
  });
});

// ============================================ 13. propagation execution

describe('13. execution goes through the Phase 3 engine', () => {
  test('each simulated period is an engine run carrying both lenses, the period and the revision', async () => {
    const s = await buildStack();
    const a = await scenarioWith(s, 'a', [freight(s.ids, '80000000')]);
    const run = unwrap(await s.runtime.execute(scope, a.scenario.id), 'run');
    const calc = unwrap(await s.engine.getRun(scope, run.run.periodRuns[0].calculationRunId), 'calc run');
    assert.equal(calc.context.effectiveAsOf, s.fork.effectiveAsOf);
    assert.equal(calc.context.recordedThrough, s.fork.recordedThrough);
    assert.equal(calc.context.preference, 'SOURCE_TRUTH');
    assert.equal(calc.context.scenarioRevisionId, a.revision.id);
    assert.equal(calc.context.scenarioEntityId, a.scenario.scenarioEntityId);
    assert.equal(calc.context.period.start, Q4_2026.start);
    assert.equal(calc.triggerType, 'SCENARIO');
  });

  test('lifecycle: DRAFT → READY → RUNNING → COMPUTED; archived is terminal but readable', async () => {
    const s = await buildStack();
    const a = await scenarioWith(s, 'a', [freight(s.ids, '80000000')]);
    assert.equal(unwrap(await s.runtime.getScenario(scope, a.scenario.id), 'get').status, 'DRAFT');
    unwrap(await s.runtime.markReady(scope, a.revision.id), 'ready');
    assert.equal(unwrap(await s.runtime.getScenario(scope, a.scenario.id), 'get').status, 'READY');
    const run = unwrap(await s.runtime.execute(scope, a.scenario.id), 'run');
    assert.equal(unwrap(await s.runtime.getScenario(scope, a.scenario.id), 'get').status, 'COMPUTED');
    unwrap(await s.runtime.archive(scope, a.scenario.id), 'archive');
    const again = await s.runtime.execute(scope, a.scenario.id);
    assert.equal(again.ok, false);
    assert.equal(again.error.code, 'scenario.not_executable');
    assert.equal((await s.runtime.createRevision(scope, a.scenario.id)).ok, false);
    unwrap(await s.runtime.getFutureState(scope, run.run.id), 'still readable');
    assert.equal((await s.store.setScenarioStatus(scope, a.scenario.id, 'DRAFT')).ok, false, 'terminal');
    const b = await scenarioWith(s, 'b', []);
    assert.equal((await s.runtime.invalidate(scope, b.scenario.id, 'x')).ok, false, 'needs a reason');
    unwrap(await s.runtime.invalidate(scope, b.scenario.id, 'depends on a retired unit-cost feed'), 'invalidate');
  });
});

// ============================================== 17–18. confidence, lineage

describe('17–18. confidence and lineage (§50, §69)', () => {
  test('an override\'s confidence flows into what depends on it', async () => {
    const s = await buildStack();
    const low = await scenarioWith(s, 'low', [{ ...probability(s.ids, '0.9'), confidence: 0.3 }]);
    const run = unwrap(await s.runtime.execute(scope, low.scenario.id), 'run');
    const rev = valueOf(run.futureState, s.ids.expRevenue, '2026-Q4');
    assert.ok(rev.confidence <= 0.3, `expected revenue can be no surer than its 0.3 assumption, got ${rev.confidence}`);
    assert.equal(rev.value, '3780000000');
  });

  test('future-state value → calculation run → revision → override → baseline input → source provenance', async () => {
    const s = await buildStack();
    const a = await scenarioWith(s, 'a', [freight(s.ids, '80000000')]);
    const run = unwrap(await s.runtime.execute(scope, a.scenario.id), 'run');
    const ex = unwrap(await s.runtime.explain(scope, run.run.id, s.ids.grossMargin), 'explain');

    assert.equal(ex.state.scenarioKey, 'a');
    assert.equal(ex.fingerprint, run.run.fingerprint);
    assert.equal(ex.lineage.derivation.calculationKey, 'gross_margin');
    const calc = unwrap(await s.engine.getRun(scope, ex.lineage.derivation.runId), 'calc run');
    assert.equal(calc.context.scenarioRevisionId, a.revision.id, 'the run names the revision');

    const overrideNode = ex.lineage.inputs.find((i) => i.override);
    assert.ok(overrideNode, 'the freight override is a node of the lineage');
    assert.equal(overrideNode.override.operation, 'ADD');
    assert.equal(overrideNode.override.baseline.value, '140000000');
    assert.equal(overrideNode.value, '220000000');
    const baseline = overrideNode.inputs[0];
    assert.equal(baseline.observationType, 'ESTIMATE');
    assert.equal(baseline.source.system, 'scm', 'and on to the source it came from');

    // Deeper: COGS → demand → expected revenue → the commercial facts.
    const cogs = ex.lineage.inputs.find((i) => i.metricKey === 'Cogs');
    assert.ok(cogs.derivation);
    const walk = (n, acc = []) => { acc.push(n); n.inputs.forEach((c) => walk(c, acc)); return acc; };
    assert.ok(walk(ex.lineage).some((n) => n.metricKey === 'OpportunityProbability' && n.source?.system === 'memoire'));
  });

  test('an overridden input explains itself and its baseline', async () => {
    const s = await buildStack();
    const a = await scenarioWith(s, 'a', [freight(s.ids, '80000000')]);
    const run = unwrap(await s.runtime.execute(scope, a.scenario.id), 'run');
    const ex = unwrap(await s.runtime.explain(scope, run.run.id, s.ids.freightOpex), 'explain');
    assert.equal(ex.value.origin, 'OVERRIDDEN');
    assert.equal(ex.lineage.observationId.startsWith('override:'), true);
    assert.equal(ex.lineage.inputs[0].source.system, 'scm');
  });
});

// ================================================== 19. fingerprints

describe('19. deterministic fingerprints (§39, §70, §71)', () => {
  test('0.9, 0.90 and 0.900 are one simulation', async () => {
    const s = await buildStack();
    const prints = [];
    for (const [key, v] of [['p1', '0.9'], ['p2', '0.90'], ['p3', '0.900']]) {
      const c = await scenarioWith(s, key, [probability(s.ids, v)]);
      prints.push(unwrap(await s.runtime.markReady(scope, c.revision.id), key).fingerprint);
    }
    assert.equal(new Set(prints).size, 1);
  });

  test('names, rationale and provenance do not change a number, so they do not change the fingerprint', async () => {
    const s = await buildStack();
    const a = await scenarioWith(s, 'a', [probability(s.ids, '0.9')]);
    const b = await scenarioWith(s, 'b', [{ ...probability(s.ids, '0.9'), rationale: 'A completely different story.', provenanceKind: 'USER_OVERRIDE' }]);
    const fa = unwrap(await s.runtime.markReady(scope, a.revision.id), 'a').fingerprint;
    const fb = unwrap(await s.runtime.markReady(scope, b.revision.id), 'b').fingerprint;
    assert.equal(fa, fb);
    const c = await scenarioWith(s, 'c', [probability(s.ids, '0.91')]);
    assert.notEqual(unwrap(await s.runtime.markReady(scope, c.revision.id), 'c').fingerprint, fa);
  });

  test('the same overrides against a different baseline boundary are not the same simulation', () => {
    const o = {
      override: {
        targetNodeId: 'n', operation: 'SET', value: '0.9', unit: 'ratio', currency: null, confidence: 0.6,
      },
      inheritedFromScenarioId: null,
      shadowed: [],
    };
    const model = { engineVersion: '4.0.0', calculations: ['x@1.0.0'] };
    const base = { orgId: ORG_A, periods: [Q4_2026], model, effective: [{ period: Q4_2026, overrides: [o] }] };
    const t1 = scenarioFingerprint({ ...base, fork: { effectiveAsOf: '2026-09-19T12:00:00.000Z', recordedThrough: '2026-09-21T16:34:00.000Z', policy: 'SOURCE_TRUTH' } });
    const t2 = scenarioFingerprint({ ...base, fork: { effectiveAsOf: '2026-09-19T12:00:00.000Z', recordedThrough: '2026-09-25T09:00:00.000Z', policy: 'SOURCE_TRUTH' } });
    const otherOrg = scenarioFingerprint({ ...base, orgId: ORG_B, fork: { effectiveAsOf: '2026-09-19T12:00:00.000Z', recordedThrough: '2026-09-21T16:34:00.000Z', policy: 'SOURCE_TRUTH' } });
    const otherModel = scenarioFingerprint({ ...base, model: { engineVersion: '4.0.0', calculations: ['x@2.0.0'] }, fork: { effectiveAsOf: '2026-09-19T12:00:00.000Z', recordedThrough: '2026-09-21T16:34:00.000Z', policy: 'SOURCE_TRUTH' } });
    assert.equal(new Set([t1, t2, otherOrg, otherModel]).size, 4);
  });

  test('a child and a standalone scenario with the same effective overrides are equivalent', async () => {
    const s = await buildStack();
    const parent = await scenarioWith(s, 'parent', [freight(s.ids, '80000000')]);
    unwrap(await s.runtime.markReady(scope, parent.revision.id), 'seal');
    const child = unwrap(await s.runtime.createScenario(scope, { key: 'child', name: 'child', parentScenarioId: parent.scenario.id }), 'child');
    const alone = await scenarioWith(s, 'alone', [freight(s.ids, '80000000')]);
    const fc = unwrap(await s.runtime.markReady(scope, child.revision.id), 'c').fingerprint;
    const fa = unwrap(await s.runtime.markReady(scope, alone.revision.id), 'a').fingerprint;
    assert.equal(fc, fa);
  });
});

// ================================================ 20. tenant isolation

describe('20. tenant isolation (§76)', () => {
  test('another organization cannot read, compare, execute or override into a scenario', async () => {
    const s = await buildStack({ orgs: [ORG_A, ORG_B] });
    const scopeB = scopeFor(ORG_B);
    const idsB = s.nodeIdsByOrg[ORG_B];
    const a = await scenarioWith(s, 'mine', [freight(s.ids, '80000000')]);
    const run = unwrap(await s.runtime.execute(scope, a.scenario.id), 'run');

    assert.equal(unwrap(await s.runtime.getScenario(scopeB, a.scenario.id), 'b get'), null);
    assert.equal((await s.runtime.getFutureState(scopeB, run.run.id)).ok, false);
    assert.equal((await s.runtime.execute(scopeB, a.scenario.id)).ok, false);
    assert.equal((await s.runtime.replay(scopeB, run.run.id)).ok, false);
    const cmpB = await s.runtime.compare(scopeB, { baselineRunId: run.run.id, alternativeRunIds: [] });
    assert.equal(cmpB.ok, false);
    assert.equal(unwrap(await s.runtime.listScenarios(scopeB), 'b list').length, 0);

    // B's own scenario may reuse the key, and may not name A's nodes.
    const b = unwrap(await s.runtime.createScenario(scopeB, { key: 'mine', name: 'B', periods: [Q4_2026] }), 'b create');
    const cross = await s.runtime.addOverride(scopeB, b.revision.id, freight(s.ids, '1'));
    assert.equal(cross.ok, false);
    assert.equal(cross.error.code, 'scenario.not_found');
    unwrap(await s.runtime.addOverride(scopeB, b.revision.id, freight(idsB, '5')), 'own node');

    // A's scenario outputs are invisible to B's value graph reads.
    const bObs = unwrap(await s.valueGraph.getObservations(scopeB, { nodeId: idsB.grossMargin }), 'b obs');
    assert.ok(bObs.every((o) => o.orgId === ORG_B));
    assert.equal((await s.valueGraph.getObservations(scopeB, { nodeId: s.ids.grossMargin })).value?.length ?? 0, 0);
  });
});

// ================================================ 21. concurrency

describe('21. concurrent scenarios do not contaminate each other', () => {
  test('three scenarios executed at once each see only their own overrides', async () => {
    const s = await buildStack();
    const a = await scenarioWith(s, 'a', [freight(s.ids, '80000000')]);
    const b = await scenarioWith(s, 'b', [freight(s.ids, '25000000')]);
    const c = await scenarioWith(s, 'c', [probability(s.ids, '0.9')]);
    const [ra, rb, rc] = await Promise.all([a, b, c].map((x) => s.runtime.execute(scope, x.scenario.id)));
    assert.equal(gm(unwrap(ra, 'a'), s), '897200000');
    assert.equal(gm(unwrap(rb, 'b'), s), '952200000');
    assert.equal(valueOf(unwrap(rc, 'c').futureState, s.ids.expRevenue, '2026-Q4').value, '3780000000');
    assert.equal(valueOf(unwrap(rc, 'c').futureState, s.ids.freightOpex, '2026-Q4').value, '140000000');
    assert.equal(valueOf(unwrap(ra, 'a').futureState, s.ids.oppProb, '2026-Q4').value, '0.7');

    // Every output of each run is tagged with that run's scenario.
    for (const [x, r] of [[a, ra], [b, rb], [c, rc]]) {
      const trace = unwrap(await s.engine.getTrace(scope, r.value.run.periodRuns[0].calculationRunId), 'trace');
      for (const step of trace.filter((t) => t.status === 'CALCULATED')) {
        const obs = unwrap(await s.valueGraph.getObservations(scope, { nodeId: step.outputNodeId }), 'obs');
        const o = obs.find((y) => y.id === step.outputObservationId);
        assert.equal(o.scenarioEntityId, x.scenario.scenarioEntityId);
      }
    }
  });
});

// ================================== 22. calculation version preservation

describe('22. a sealed revision keeps its model; history is never rewritten (§41)', () => {
  test('under a different model the old revision is refused, stays readable, and a new revision runs', async () => {
    const s = await buildStack();
    const a = await scenarioWith(s, 'a', [freight(s.ids, '80000000')]);
    const run = unwrap(await s.runtime.execute(scope, a.scenario.id), 'v1.1 run');
    const sealed = unwrap(await s.store.getRevision(scope, a.revision.id), 'rev');
    assert.ok(sealed.modelRef.calculations.includes('revenue_at_risk@1.0.0'));

    // The organization moves to a model without the scenario calculations.
    const registry = unwrap(createCalculationRegistry(meridianValueModelV1, buildSeedValueRegistry()), 'v1');
    const engine = unwrap(
      createPropagationEngine({
        registry, valueGraph: s.valueGraph, graphStore: s.graphStore, ontology: buildSeedRegistry(),
        store: s.calcStore, clock: s.clock,
      }),
      'engine',
    );
    const runtime = createScenarioRuntime({
      engine, registry, valueGraph: s.valueGraph, graphStore: s.graphStore, store: s.store, clock: s.clock,
      constraints: meridianConstraintsV1, stateFrame: meridianStateFrame,
    });
    const refused = await runtime.execute(scope, a.scenario.id);
    assert.equal(refused.ok, false);
    assert.match(refused.error.message, /sealed under a different model/);
    assert.equal((await runtime.replay(scope, run.run.id)).ok, false, 'a replay under another model is not a replay');

    const history = unwrap(await runtime.getFutureState(scope, run.run.id), 'history');
    assert.equal(valueOf(history, s.ids.grossMargin, '2026-Q4').value, '897200000');

    unwrap(await runtime.createRevision(scope, a.scenario.id), 'new revision');
    const rerun = unwrap(await runtime.execute(scope, a.scenario.id), 'v1 run');
    assert.equal(gm(rerun, s), '897200000', 'v1 computes margin the same way');
    assert.equal(valueOf(rerun.futureState, s.ids.revenueAtRisk, '2026-Q4'), undefined, 'v1 has no revenue-at-risk');
  });
});

// ================================================ canonical builder

describe('the canonical builder uses the same path as a user', () => {
  test('building a subset builds its ancestors first', async () => {
    const s = await buildStack();
    const built = unwrap(
      await buildMeridianScenarios(s.runtime, scope, s.ids, { fork: s.fork, only: ['expedite-price-increase'] }),
      'subset',
    );
    assert.deepEqual(Object.keys(built).sort(), ['expedite', 'expedite-price-increase']);
    assert.equal(built.expedite.revision.state, 'SEALED');
    void quarterPeriod;
  });
});
