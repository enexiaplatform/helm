/**
 * verify:scenario-isolation — futures branch from the baseline without
 * touching it, and without touching each other.
 *
 *   1. No baseline mutation: after scenarios run, every source observation is
 *      exactly what it was, and a fresh baseline simulation reproduces the
 *      baseline numbers.
 *   2. Scenario outputs are SCENARIO observations tagged with their own
 *      scenario entity and revision — never DERIVED, never untagged.
 *   3. Scenarios executed concurrently see only their own overrides.
 *   4. No persisted scenario output is ever read back as an input: overlay
 *      runs read the source world under a source policy, and the engine
 *      refuses an overlay combined with the SCENARIO policy.
 *   5. Tenants: another organization can read, run, replay or compare none of it.
 */

import { buildStack, scope, scopeFor, ORG_A, ORG_B, valueOf } from '../packages/scenario-runtime/test/harness.mjs';
import { Q4_2026 } from '../packages/scenario-runtime/src/index.ts';

const failures = [];
const check = (rule, cond, detail) => {
  if (!cond) failures.push({ rule, detail });
};
const must = (r, what) => {
  if (!r.ok) throw new Error(`${what}: ${r.error.code} — ${r.error.message}`);
  return r.value;
};

const s = await buildStack({ orgs: [ORG_A, ORG_B] });
const scopeB = scopeFor(ORG_B);

const sourceSnapshot = async () => {
  const out = [];
  for (const [handle, nodeId] of Object.entries(s.ids)) {
    const obs = must(await s.valueGraph.getObservations(scope, { nodeId, scenarioEntityId: null, limit: 500 }), handle);
    for (const o of obs.filter((x) => x.observationType !== 'DERIVED')) out.push(`${o.id}:${o.numericValue}:${o.observationType}`);
  }
  return out.sort().join('\n');
};

const before = await sourceSnapshot();
const base1 = must(await s.runtime.executeBaseline(scope, { fork: s.fork, periods: [Q4_2026] }), 'baseline');

const mk = async (key, overrides) => {
  const c = must(await s.runtime.createScenario(scope, { key, name: key, fork: s.fork, periods: [Q4_2026] }), key);
  for (const o of overrides) must(await s.runtime.addOverride(scope, c.revision.id, o), `${key} override`);
  return c;
};
const freight = (v) => ({
  overrideType: 'VALUE_OVERRIDE', targetNodeId: s.ids.freightOpex, operation: 'ADD', value: v, unit: 'currency',
  currency: 'VND', provenanceKind: 'EXTERNAL_SIGNAL', rationale: 'forwarder quote for the premium', confidence: 0.8,
});
const a = await mk('iso-a', [freight('80000000'), {
  overrideType: 'VALUE_OVERRIDE', targetNodeId: s.ids.oppProb, value: '0.9', unit: 'ratio',
  provenanceKind: 'MANAGEMENT_ASSUMPTION', rationale: 'sales leadership expects to close', confidence: 0.6,
}]);
const b = await mk('iso-b', [freight('25000000')]);

// 3. concurrently
const [ra, rb] = await Promise.all([s.runtime.execute(scope, a.scenario.id), s.runtime.execute(scope, b.scenario.id)]);
const ea = must(ra, 'A');
const eb = must(rb, 'B');
check('concurrency', valueOf(eb.futureState, s.ids.oppProb, '2026-Q4')?.value === '0.7', 'B saw A\'s probability override');
check('concurrency', valueOf(eb.futureState, s.ids.freightOpex, '2026-Q4')?.value === '165000000', 'B saw A\'s freight override');
check('concurrency', valueOf(ea.futureState, s.ids.freightOpex, '2026-Q4')?.value === '220000000', 'A lost its own freight override');
// Derived values too: a run that consumed the other run's outputs would get
// these wrong even though every input it was handed looks right.
for (const [e, rev, demand, gm] of [[ea, '3780000000', '10.8', '1216400000'], [eb, '2940000000', '8.4', '952200000']]) {
  check('concurrency', valueOf(e.futureState, s.ids.expRevenue, '2026-Q4')?.value === rev, `expected revenue leaked between concurrent runs`);
  check('concurrency', valueOf(e.futureState, s.ids.demand, '2026-Q4')?.value === demand, `demand leaked between concurrent runs`);
  check('concurrency', valueOf(e.futureState, s.ids.grossMargin, '2026-Q4')?.value === gm, `gross margin leaked between concurrent runs`);
}

// 1. baseline untouched
const after = await sourceSnapshot();
check('no-baseline-mutation', before === after, 'a source observation changed while scenarios ran');
const base2 = must(await s.runtime.executeBaseline(scope, { fork: s.fork, periods: [Q4_2026] }), 'baseline again');
for (const h of ['expRevenue', 'grossMargin', 'cashOpp', 'wcProduct', 'oppProb']) {
  check('no-baseline-mutation',
    valueOf(base1.futureState, s.ids[h], '2026-Q4')?.value === valueOf(base2.futureState, s.ids[h], '2026-Q4')?.value,
    `the baseline ${h} moved after scenarios ran`);
}
check('no-baseline-mutation', valueOf(base2.futureState, s.ids.oppProb, '2026-Q4')?.value === '0.7', 'baseline probability is no longer 0.7');

// 2. outputs tagged
for (const [x, e] of [[a, ea], [b, eb]]) {
  const trace = must(await s.engine.getTrace(scope, e.run.periodRuns[0].calculationRunId), 'trace');
  for (const step of trace.filter((t) => t.status === 'CALCULATED')) {
    const obs = must(await s.valueGraph.getObservations(scope, { nodeId: step.outputNodeId, limit: 500 }), 'obs');
    const o = obs.find((y) => y.id === step.outputObservationId);
    check('tagged-outputs', o?.observationType === 'SCENARIO', `a scenario output is ${o?.observationType}`);
    check('tagged-outputs', o?.scenarioEntityId === x.scenario.scenarioEntityId, 'a scenario output names another scenario');
    check('tagged-outputs', o?.metadata?.scenarioRevisionId === x.revision.id, 'a scenario output does not name its revision');
  }
  const calc = must(await s.engine.getRun(scope, e.run.periodRuns[0].calculationRunId), 'calc');
  check('source-policy', calc.context.preference === 'SOURCE_TRUTH', `an overlay run read under ${calc.context.preference}`);
}

// 4. no persisted scenario output as input
{
  const trace = must(await s.engine.getTrace(scope, eb.run.periodRuns[0].calculationRunId), 'trace B');
  for (const step of trace) {
    for (const input of step.inputs) {
      const parts = input.components ?? [input];
      for (const p of parts) {
        const bound = p.boundTo ?? input.boundTo;
        if (bound === 'SOURCE_OBSERVATION') {
          check('no-output-as-input', p.observationType !== 'SCENARIO' && p.observationType !== 'DERIVED',
            `${step.calculationKey} read a persisted ${p.observationType} as a source input`);
        }
      }
    }
  }
  const forged = await s.engine.execute(scope, {
    effectiveAsOf: new Date(s.fork.effectiveAsOf), period: Q4_2026, preference: 'SCENARIO',
    scenarioEntityId: a.scenario.scenarioEntityId, scenarioRevisionId: a.revision.id,
    overlay: { scenarioId: a.scenario.id, revisionId: a.revision.id, entries: new Map() },
  });
  check('no-output-as-input', !forged.ok && forged.error.code === 'calculation.invalid_overlay',
    'the engine accepted an overlay under the SCENARIO policy');
}

// 5. tenants
check('tenant', must(await s.runtime.getScenario(scopeB, a.scenario.id), 'B get') === null, 'org B can read org A\'s scenario');
check('tenant', !(await s.runtime.getFutureState(scopeB, ea.run.id)).ok, 'org B can read org A\'s future state');
check('tenant', !(await s.runtime.execute(scopeB, a.scenario.id)).ok, 'org B can execute org A\'s scenario');
check('tenant', !(await s.runtime.replay(scopeB, ea.run.id)).ok, 'org B can replay org A\'s simulation');
check('tenant', !(await s.runtime.compare(scopeB, { baselineRunId: base1.run.id, alternativeRunIds: [ea.run.id] })).ok,
  'org B can compare org A\'s states');
{
  const bScenario = must(await s.runtime.createScenario(scopeB, { key: 'iso-a', name: 'B', periods: [Q4_2026] }), 'B create');
  const cross = await s.runtime.addOverride(scopeB, bScenario.revision.id, freight('1'));
  check('tenant', !cross.ok, 'org B can override org A\'s value node');
}

if (failures.length === 0) {
  console.log('verify:scenario-isolation — ok (baseline untouched, outputs tagged, concurrent futures separate, no output read as input, tenants walled)');
  process.exit(0);
}
console.error(`verify:scenario-isolation — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
