/**
 * verify:value-observations — the observation model's rules, executed.
 *
 * An observation is a typed claim, and the type matters more than the number:
 * an actual, a forecast, a target and a scenario value are different kinds of
 * fact. If HELM cannot keep them apart it cannot later compare scenarios,
 * measure forecast accuracy, or learn whether a decision was wrong.
 *
 *   1. A SCENARIO observation must carry a scenario; no other type may.
 *   2. Units must match the metric; a percentage is not a ratio.
 *   3. Currency present exactly when the unit needs one.
 *   4. The time context the metric implies is required.
 *   5. Observation types coexist without superseding one another.
 *   6. Every observation in the canonical chain has traceable provenance.
 *   7. An ACTUAL entered by hand cannot be provenance-free.
 *   8. Reality is separable from modelled alternatives.
 */

import { buildSeedRegistry } from '../packages/ontology/src/index.ts';
import { asOrgId, asUserId, asValidTime, seqIdGen } from '../packages/shared/src/index.ts';
import { createInMemoryGraphStore } from '../packages/graph-store/src/inMemory.ts';
import { buildCanonicalScenario } from '../packages/graph-store/src/canonicalScenario.ts';
import { createInMemoryValueGraph } from '../packages/value-graph/src/inMemory.ts';
import { buildSeedValueRegistry } from '../packages/value-graph/src/registry.ts';
import { buildCanonicalValueChain } from '../packages/value-graph/src/canonicalValueChain.ts';
import { observationTypes, unitBounds } from '../packages/value-graph/src/types.ts';

const failures = [];
const fail = (rule, detail) => failures.push({ rule, detail });
const check = (rule, cond, detail) => {
  if (!cond) fail(rule, detail);
};
/** Asserts a write was refused, and refused for the right reason. */
const expectRefused = (rule, result, code, what) => {
  if (result.ok) {
    fail(rule, `${what} was accepted but should have been refused`);
  } else if (result.error.code !== code) {
    fail(rule, `${what} failed with ${result.error.code}, expected ${code}`);
  }
};

const scope = {
  orgId: asOrgId('11111111-1111-4111-8111-111111111111'),
  actorId: asUserId('aaaa1111-1111-4111-8111-111111111111'),
  role: 'admin',
  orgUnitIds: [],
  functions: [],
};

let tick = 0;
const base = Date.parse('2026-09-19T08:00:00.000Z');
const clock = { now: () => new Date(base + (tick += 1) * 1000) };
const idGen = seqIdGen('vo');
const ontology = buildSeedRegistry();
const graphStore = createInMemoryGraphStore({ registry: ontology, clock, idGen });
const valueGraph = createInMemoryValueGraph({
  metrics: buildSeedValueRegistry(),
  ontology,
  graphStore,
  clock,
  idGen,
});

const entities = await buildCanonicalScenario(graphStore, scope);
if (!entities.ok) {
  console.error(`verify:value-observations — entity graph failed: ${entities.error.code}`);
  process.exit(1);
}
const built = await buildCanonicalValueChain(valueGraph, graphStore, scope);
if (!built.ok) {
  console.error(`verify:value-observations — value chain failed: ${built.error.code}`);
  process.exit(1);
}
const { nodeIds, scenarioIds } = built.value;

const P_START = asValidTime('2026-10-01T00:00:00.000Z');
const P_END = asValidTime('2027-01-01T00:00:00.000Z');
const T0 = asValidTime('2026-09-19T00:00:00.000Z');

// ------------------------------------------------- 1: scenario context

expectRefused(
  'scenario-context',
  await valueGraph.recordObservation(scope, {
    nodeId: nodeIds.grossMarginPct,
    observationType: 'SCENARIO',
    numericValue: 30,
    unitType: 'percentage',
    periodStart: P_START,
    periodEnd: P_END,
    sourceSystem: 'helm',
  }),
  'value.missing_scenario_context',
  'a SCENARIO observation with no scenario',
);

expectRefused(
  'scenario-context',
  await valueGraph.recordObservation(scope, {
    nodeId: nodeIds.grossMarginPct,
    observationType: 'FORECAST',
    numericValue: 30,
    unitType: 'percentage',
    periodStart: P_START,
    periodEnd: P_END,
    sourceSystem: 'finance',
    scenarioEntityId: scenarioIds.expedite,
  }),
  'value.unexpected_scenario_context',
  'a FORECAST carrying a scenario reference',
);

// --------------------------------------------------- 2: unit integrity

expectRefused(
  'unit-integrity',
  await valueGraph.recordObservation(scope, {
    nodeId: nodeIds.grossMarginPct,
    observationType: 'ACTUAL',
    numericValue: 38,
    unitType: 'currency',
    currency: 'VND',
    periodStart: P_START,
    periodEnd: P_END,
    sourceSystem: 'erp',
  }),
  'value.unit_mismatch',
  'a percentage metric receiving a currency unit',
);

expectRefused(
  'unit-integrity',
  await valueGraph.recordObservation(scope, {
    nodeId: nodeIds.oppProb,
    observationType: 'ACTUAL',
    numericValue: 70,
    unitType: 'ratio',
    effectiveAt: T0,
    sourceSystem: 'memoire',
  }),
  'value.out_of_range',
  '70 recorded as a ratio (it is a percentage)',
);

// The honest limit of bounds checking: 0.84 is inside 0..100, so recording a
// proportion as a percentage cannot be caught by range alone. This is exactly
// why unit_type is explicit and required on every observation rather than
// inferred from the number — the declaration is the defence, not the range.
// Asserted against the bounds table rather than by writing, so the check leaves
// no stray observation behind.
check(
  'unit-integrity',
  unitBounds.percentage.min === 0 && unitBounds.percentage.max === 100,
  'percentage bounds are not 0..100',
);
check(
  'unit-integrity',
  unitBounds.ratio.min === 0 && unitBounds.ratio.max === 1,
  'ratio bounds are not 0..1 — a ratio and a percentage would be interchangeable',
);

// ------------------------------------------------------- 3: currency

expectRefused(
  'currency',
  await valueGraph.recordObservation(scope, {
    nodeId: nodeIds.oppValue,
    observationType: 'ACTUAL',
    numericValue: 4.2e9,
    unitType: 'currency',
    effectiveAt: T0,
    sourceSystem: 'memoire',
  }),
  'value.missing_currency',
  'a currency amount with no currency',
);

expectRefused(
  'currency',
  await valueGraph.recordObservation(scope, {
    nodeId: nodeIds.oppProb,
    observationType: 'ACTUAL',
    numericValue: 0.8,
    unitType: 'ratio',
    currency: 'VND',
    effectiveAt: T0,
    sourceSystem: 'memoire',
  }),
  'value.unexpected_currency',
  'a currency on a ratio metric',
);

// --------------------------------------------------- 4: time context

expectRefused(
  'time-context',
  await valueGraph.recordObservation(scope, {
    nodeId: nodeIds.expRevenue,
    observationType: 'FORECAST',
    numericValue: 1e9,
    unitType: 'currency',
    currency: 'VND',
    effectiveAt: T0,
    sourceSystem: 'memoire',
  }),
  'value.missing_time_context',
  'a period metric given only a point in time',
);

expectRefused(
  'time-context',
  await valueGraph.recordObservation(scope, {
    nodeId: nodeIds.availOwn,
    observationType: 'ACTUAL',
    numericValue: 4,
    unitType: 'units',
    periodStart: P_START,
    periodEnd: P_END,
    sourceSystem: 'scm',
  }),
  'value.missing_time_context',
  'a point-in-time metric given only a period',
);

// -------------------------------------- 5 & 8: coexistence and separation

const gm = await valueGraph.getObservations(scope, { nodeId: nodeIds.grossMarginPct });
if (!gm.ok) {
  fail('coexistence', gm.error.code);
} else {
  const types = new Set(gm.value.map((o) => o.observationType));
  for (const t of ['ACTUAL', 'FORECAST', 'TARGET', 'SCENARIO']) {
    check('coexistence', types.has(t), `no ${t} observation on gross margin %`);
  }
  check(
    'coexistence',
    gm.value.filter((o) => o.observationType === 'SCENARIO').length >= 2,
    'fewer than two scenario values to compare',
  );

  const reality = await valueGraph.getObservations(scope, {
    nodeId: nodeIds.grossMarginPct,
    scenarioEntityId: null,
  });
  check(
    'scenario-separation',
    reality.ok && reality.value.every((o) => o.scenarioEntityId === null),
    'a scenario observation leaked into the reality view',
  );
  check(
    'scenario-separation',
    reality.ok && reality.value.length < gm.value.length,
    'the reality view is not narrower than the full set',
  );
}

// Every observation type the model declares should be reachable, or the model
// claims a distinction it never uses.
const usedTypes = new Set();
for (const nodeId of Object.values(nodeIds)) {
  const obs = await valueGraph.getObservations(scope, { nodeId });
  if (!obs.ok) continue;
  for (const o of obs.value) usedTypes.add(o.observationType);
}
for (const t of ['ACTUAL', 'FORECAST', 'TARGET', 'SCENARIO', 'ESTIMATE', 'ASSUMPTION']) {
  check(
    'type-coverage',
    usedTypes.has(t),
    `the canonical chain never demonstrates a ${t} observation`,
  );
}
check(
  'type-coverage',
  !usedTypes.has('DERIVED'),
  'a DERIVED observation exists — nothing derives values until Phase 3',
);

// --------------------------------------------------- 6 & 7: provenance

let checked = 0;
let missing = 0;
for (const nodeId of Object.values(nodeIds)) {
  const obs = await valueGraph.getObservations(scope, { nodeId });
  if (!obs.ok) continue;
  for (const o of obs.value) {
    checked += 1;
    if (!o.provenanceId) {
      missing += 1;
      continue;
    }
    const prov = await valueGraph.getObservationProvenance(scope, o.id);
    if (!prov.ok || prov.value.length === 0) missing += 1;
    else if (!prov.value[0].system || !prov.value[0].method) missing += 1;
  }
}
check('provenance', missing === 0, `${missing} of ${checked} observations lack traceable provenance`);
check('provenance', checked >= 35, `only ${checked} observations found to check`);

expectRefused(
  'provenance',
  await valueGraph.recordObservation(scope, {
    nodeId: nodeIds.availOwn,
    observationType: 'ACTUAL',
    numericValue: 5,
    unitType: 'units',
    effectiveAt: T0,
    sourceSystem: 'manual',
  }),
  'value.missing_provenance',
  'a hand-entered ACTUAL with no provenance',
);

// ------------------------------------------------------------------ report

if (failures.length === 0) {
  console.log(
    `verify:value-observations — ok (${observationTypes.length} types modelled, ` +
      `${checked} observations traceable)`,
  );
  process.exit(0);
}

console.error(`verify:value-observations — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
