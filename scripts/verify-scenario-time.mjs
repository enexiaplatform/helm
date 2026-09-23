/**
 * verify:scenario-time — every future knows which period it models and what
 * it was allowed to know.
 *
 *   1. Period identity: a Q4 read gets the Q4 claim and a Q1 read the Q1 claim
 *      when both exist; the furthest-out claim never answers for another period.
 *   2. A read that states no period refuses to choose between periods.
 *   3. A period nobody speaks to is TIME_CONTEXT_MISMATCH, not zero.
 *   4. The fork is pinned: a fact recorded after it never enters the scenario,
 *      however often the scenario is replayed.
 *   5. Replay keeps the boundary; rebase moves it, and says so.
 */

import { asValidTime } from '../packages/shared/src/index.ts';
import { buildStack, scope, valueOf } from '../packages/scenario-runtime/test/harness.mjs';
import { Q4_2026, Q1_2027 } from '../packages/scenario-runtime/src/index.ts';
import { policyOrder, selectObservation } from '../packages/propagation-engine/src/index.ts';

const failures = [];
const check = (rule, cond, detail) => {
  if (!cond) failures.push({ rule, detail });
};
const must = (r, what) => {
  if (!r.ok) throw new Error(`${what}: ${r.error.code} — ${r.error.message}`);
  return r.value;
};

const s = await buildStack();
must(
  await s.valueGraph.recordObservation(scope, {
    nodeId: s.ids.expRevenue, observationType: 'FORECAST', numericValue: 3_500_000_000, unitType: 'currency',
    currency: 'VND', periodStart: asValidTime(Q1_2027.start), periodEnd: asValidTime(Q1_2027.end),
    sourceSystem: 'finance', confidence: 0.6,
  }),
  'Q1 forecast',
);
const lens = { effectiveAsOf: new Date(s.fork.effectiveAsOf), recordedThrough: s.clock.now() };
const read = (period) => selectObservation(s.valueGraph, scope, s.ids.expRevenue, policyOrder.SOURCE_TRUTH, lens, null, period);

// 1–2
const q4 = must(await read(Q4_2026), 'Q4');
const q1 = must(await read(Q1_2027), 'Q1');
check('period-identity', q4?.numericValue === 2_940_000_000, `a Q4 read returned ${q4?.numericValue}`);
check('period-identity', q1?.numericValue === 3_500_000_000, `a Q1 read returned ${q1?.numericValue}`);
const none = await read(null);
check('no-guess', !none.ok && none.error.code === 'calculation.ambiguous_period',
  'a period-less read chose between two periods instead of refusing');

// 3
const q1only = await selectObservation(s.valueGraph, scope, s.ids.expRevenueNext, policyOrder.SOURCE_TRUTH, lens, null, Q1_2027);
check('mismatch', !q1only.ok && q1only.error.code === 'calculation.time_context_mismatch',
  'a Q1 read of a Q4-only node was not a TIME_CONTEXT_MISMATCH');

// 4–5
const created = must(
  await s.runtime.createScenario(scope, { key: 'pinned', name: 'pinned', fork: s.fork, periods: [Q4_2026] }),
  'create',
);
must(
  await s.runtime.addOverride(scope, created.revision.id, {
    overrideType: 'VALUE_OVERRIDE', targetNodeId: s.ids.freightOpex, operation: 'ADD', value: '80000000',
    unit: 'currency', currency: 'VND', provenanceKind: 'EXTERNAL_SIGNAL', rationale: 'forwarder premium quote', confidence: 0.8,
  }),
  'override',
);
const t1 = must(await s.runtime.execute(scope, created.scenario.id), 'T1');
s.clock.jump(3_600_000);
must(
  await s.valueGraph.recordObservation(scope, {
    nodeId: s.ids.freightOpex, observationType: 'FORECAST', numericValue: 160_000_000, unitType: 'currency',
    currency: 'VND', periodStart: asValidTime(Q4_2026.start), periodEnd: asValidTime(Q4_2026.end),
    sourceSystem: 'finance', confidence: 0.8,
  }),
  'late forecast',
);
const replay = must(await s.runtime.replay(scope, t1.run.id), 'replay');
const f = (e) => valueOf(e.futureState, s.ids.freightOpex, '2026-Q4')?.value;
check('pinned-fork', f(replay) === f(t1) && f(t1) === '220000000', `a replay saw a fact recorded after its fork (${f(replay)})`);
check('pinned-fork', replay.run.fork.recordedThrough === t1.run.fork.recordedThrough, 'replay moved the knowledge boundary');
const again = must(await s.runtime.execute(scope, created.scenario.id), 're-execute');
check('pinned-fork', f(again) === '220000000', 'executing the same sealed revision later gained new knowledge');

const rebased = must(await s.runtime.rebase(scope, created.scenario.id), 'rebase');
check('rebase', rebased.reason === 'REBASED' && rebased.fork.recordedThrough > t1.run.fork.recordedThrough,
  'rebase did not create a revision with a later boundary');
const t2 = must(await s.runtime.execute(scope, created.scenario.id), 'T2');
check('rebase', f(t2) === '240000000', `a rebase did not see the new world (${f(t2)})`);
check('rebase', t2.run.fingerprint !== t1.run.fingerprint, 'a new boundary kept the same fingerprint');

if (failures.length === 0) {
  console.log('verify:scenario-time — ok (period identity, no period guessing, mismatch surfaced, fork pinned, replay ≠ rebase)');
  process.exit(0);
}
console.error(`verify:scenario-time — ${failures.length} problem(s):\n`);
for (const x of failures) console.error(`  [${x.rule}] ${x.detail}`);
process.exit(1);
