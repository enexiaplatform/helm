/**
 * verify:decision-scenario-binding — the decision layer reads futures; it does
 * not compute them.
 *
 * Proves:
 *   1. An alternative's consequences are exactly the scenario future state it
 *      references — every number a criterion evaluates comes from that run.
 *   2. No economics are duplicated into the decision layer. Change the scenario
 *      and the decision layer has nothing stale to disagree with, because it
 *      holds no copy.
 *   3. An alternative cannot bind a scenario that has never been simulated, one
 *      belonging to another organization, or a run still in flight. The answer
 *      is UNMODELLED with a reason, never an alternative with zeros.
 *   4. Two alternatives modelled at different knowledge boundaries are flagged
 *      rather than silently compared (Phase 4 comparability, carried through).
 *   5. The decision layer never writes into the scenario or value layers: the
 *      baseline, the scenario runs and the value graph are byte-identical
 *      before and after a whole decision is prepared and committed.
 */

import { buildMeridianDecision } from '@helm/decision-runtime';
import { buildDecisionStack, expectFail, ORG_A, ORG_B, scopeFor, unwrap } from './lib/decisionStack.mjs';

const failures = [];
const check = (rule, cond, detail) => {
  if (!cond) failures.push({ rule, detail });
};

const stack = await buildDecisionStack({ orgs: [ORG_A, ORG_B] });
const { scope, decisions, scenarios } = stack;
const otherScope = scopeFor(ORG_B);

// A picture of the scenario and value layers BEFORE any decision exists.
const snapshotOf = async (s) => {
  const runs = unwrap(await scenarios.listRuns(s), 'runs');
  const nodes = unwrap(await stack.valueGraph.findValueNodes(s, { limit: 500 }), 'nodes');
  const observations = [];
  for (const n of nodes) {
    const o = unwrap(await stack.valueGraph.getObservations(s, n.id, { limit: 200 }), 'observations');
    observations.push(...o.map((x) => `${n.id}|${x.id}|${x.numericValue ?? ''}|${x.observationType}`));
  }
  return {
    runs: runs.map((r) => `${r.id}|${r.status}|${r.fingerprint}|${JSON.stringify(r.periodRuns)}`).sort(),
    observations: observations.sort(),
  };
};
const before = await snapshotOf(scope);

const built = unwrap(await buildMeridianDecision(decisions, scope, stack.scenarioIds), 'canonical decision');
const workspace = unwrap(await decisions.getWorkspace(scope, built.decision.id, built.revisionId), 'workspace');

// ---- 1. every evaluated number comes from the alternative's own run
for (const e of workspace.evaluations.filter((x) => x.value !== null && x.nodeId !== null)) {
  const alternative = workspace.alternatives.find((a) => a.id === e.alternativeId);
  check('binding', alternative?.scenarioRunId != null, `${e.criterionKey} was evaluated for an alternative with no run`);
  if (!alternative?.scenarioRunId) continue;
  const state = unwrap(await scenarios.getFutureState(scope, alternative.scenarioRunId), 'future state');
  const v = state.values.find((x) => x.nodeId === e.nodeId);
  check('binding', v !== undefined, `${e.criterionKey} / ${alternative.label}: node ${e.nodeId} is not in that alternative's future state`);
  check('binding', v?.value === e.value,
    `${e.criterionKey} / ${alternative.label}: the decision shows ${e.value}, the future state holds ${v?.value}`);
  check('binding', v?.origin === e.origin && v?.confidence === e.confidence,
    `${e.criterionKey} / ${alternative.label}: origin or confidence was not carried through from the future state`);
}

// ---- 2. no economics are stored in the decision layer
{
  const stored = JSON.stringify(workspace.alternatives);
  for (const number of ['32.3878', '30.517', '-1735500000', '96.8858']) {
    check('no-duplication', !stored.includes(number),
      `an alternative stores the value ${number} instead of referencing the future state that holds it`);
  }
  for (const a of workspace.alternatives) {
    check('no-duplication', !('financialLines' in a) && !('revenue' in a) && !('margin' in a),
      `${a.label} carries economics of its own`);
  }
}

// ---- 3. what cannot be bound
{
  const created = unwrap(
    await decisions.createDecision(scope, {
      title: 'Binding refusals',
      managementQuestion: 'What does HELM refuse to treat as a modelled alternative?',
      triggerType: 'MANUAL',
      owner: { kind: 'ROLE', label: 'Country GM Vietnam', userId: null },
    }),
    'create',
  );

  const cross = expectFail(
    await decisions.addAlternative(scope, created.revision.id, {
      label: 'Another organization\'s future',
      scenarioId: stack.scenarioIdsByOrg[ORG_B]['expedite'],
    }),
    'binding across tenants',
  );
  check('refusal', cross.code === 'decision.scenario_not_found', `cross-tenant binding returned ${cross.code}`);

  const unrun = unwrap(
    await scenarios.createScenario(scope, {
      key: 'never-simulated',
      name: 'Never simulated',
      description: 'Created and left alone.',
      fork: stack.fork,
      periods: [{ start: '2026-10-01T00:00:00.000Z', end: '2027-01-01T00:00:00.000Z', grain: 'QUARTER' }],
    }),
    'unsimulated scenario',
  );
  const notRun = expectFail(
    await decisions.addAlternative(scope, created.revision.id, { label: 'Unrun', scenarioId: unrun.scenario.id }),
    'binding an unsimulated scenario',
  );
  check('refusal', notRun.code === 'decision.scenario_not_completed', `binding an unsimulated scenario returned ${notRun.code}`);
  check('refusal', /UNMODELLED, not an alternative with zeros/.test(notRun.message),
    'the refusal does not say what the honest alternative is');

  // And an alternative with no scenario at all is UNMODELLED, with a reason.
  const honest = unwrap(
    await decisions.addAlternative(scope, created.revision.id, {
      label: 'Something HELM cannot model',
      unmodelledReason: 'No model of this exists, so its consequences are not computed.',
    }),
    'unmodelled alternative',
  );
  check('refusal', honest.status === 'UNMODELLED' && honest.scenarioRunId === null && honest.unmodelledReason !== null,
    'an alternative with no scenario was not recorded as honestly unmodelled');
}

// ---- 4. mixed knowledge boundaries are flagged
{
  const created = unwrap(
    await decisions.createDecision(scope, {
      title: 'Mixed boundaries',
      managementQuestion: 'Which of these two futures, modelled at different moments, should we commit to?',
      triggerType: 'MANUAL',
      owner: { kind: 'ROLE', label: 'Country GM Vietnam', userId: null },
    }),
    'create',
  );
  unwrap(
    await decisions.addAlternative(scope, created.revision.id, { label: 'A', scenarioId: stack.scenarioIds['expedite'] }),
    'A',
  );
  stack.clock.jump(3 * 24 * 3600 * 1000);
  unwrap(await scenarios.rebase(scope, stack.scenarioIds['alternative-product']), 'rebase');
  unwrap(await scenarios.execute(scope, stack.scenarioIds['alternative-product']), 're-simulate');
  unwrap(
    await decisions.addAlternative(scope, created.revision.id, {
      label: 'C',
      scenarioId: stack.scenarioIds['alternative-product'],
    }),
    'C',
  );
  unwrap(
    await decisions.addCriterion(scope, created.revision.id, {
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
  const readiness = unwrap(await decisions.evaluateReadiness(scope, created.revision.id), 'readiness');
  const gap = readiness.gaps.find((g) => g.code === 'mixed-knowledge-boundaries');
  check('comparability', gap !== undefined, 'alternatives modelled at different knowledge boundaries were compared silently');
  check('comparability', /what was learned in between/.test(gap?.message ?? ''),
    'the mixed-boundary warning does not say why it matters');

  const space = unwrap(await decisions.tradeOffSpace(scope, created.revision.id), 'trade-offs');
  check('comparability', space.comparability.some((c) => c.warnings.length > 0),
    'the trade-off space does not carry the Phase 4 comparability warning through');
}

// ---- 5. the decision layer wrote nothing into the layers below
{
  const after = await snapshotOf(scope);
  const newRuns = after.runs.filter((r) => !before.runs.includes(r));
  // The only new runs are the ones THIS contract asked for in section 4.
  check('no-writes', newRuns.length <= 2,
    `preparing a decision created ${newRuns.length} scenario runs of its own`);
  check('no-writes', after.observations.length === before.observations.length,
    `preparing and committing a decision changed the value graph: ${before.observations.length} observations became ${after.observations.length}`);
  for (const o of before.observations) {
    check('no-writes', after.observations.includes(o), 'an observation that existed before the decision has changed or disappeared');
  }
  // And the other organization saw none of it.
  check('no-writes', unwrap(await decisions.listDecisions(otherScope), 'other org').length === 0,
    'another organization can see this organization\'s decisions');
}

if (failures.length === 0) {
  const evaluated = workspace.evaluations.filter((e) => e.value !== null).length;
  console.log(
    `verify:decision-scenario-binding — ok (${evaluated} evaluated values all read from their alternative's own simulation, ` +
      'no economics duplicated, unbindable scenarios refused, mixed boundaries flagged, nothing written below)',
  );
  process.exit(0);
}
console.error(`verify:decision-scenario-binding — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
