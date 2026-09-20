/**
 * Engine semantics — the rules that decide whether a derived number can be
 * trusted, each one tested by making it fail.
 *
 * The canonical proof next door shows the model computing the right answers.
 * This file covers the other half of the phase brief: that HELM refuses, loudly
 * and specifically, in every case where continuing would produce a number that
 * looks right and is not. Registry validation, cycles, observation selection,
 * time context, scenario isolation, versioning, tenant isolation, and the
 * refusal to write anything at all on a dry run.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedRegistry } from '@helm/ontology';
import {
  asOrgId,
  asUserId,
  asValidTime,
  difference,
  mustQuantity,
  decimal,
  ok,
  seqIdGen,
  sum,
} from '@helm/shared';
import { createInMemoryGraphStore, buildCanonicalScenario } from '@helm/graph-store';
import {
  createInMemoryValueGraph,
  buildSeedValueRegistry,
  buildCanonicalValueChain,
} from '@helm/value-graph';
import {
  CalculationErrors,
  createCalculationRegistry,
  createInMemoryCalculationStore,
  createPropagationEngine,
  meridianValueModelV1,
} from '../src/index.ts';

const ORG_A = asOrgId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const ORG_B = asOrgId('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
const ACTOR = asUserId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

const scopeFor = (orgId) => ({ orgId, actorId: ACTOR, role: 'admin', orgUnitIds: [], functions: [] });
const scope = scopeFor(ORG_A);
const otherOrg = scopeFor(ORG_B);

const AS_OF = new Date('2026-09-19T12:00:00.000Z');
const BASELINE_ROOTS = [
  'OpportunityValue',
  'OpportunityProbability',
  'UnitCost',
  'AverageSellingPrice',
];

const unwrap = (r, what) => {
  assert.equal(r.ok, true, `${what}: ${r.ok ? '' : r.error.code + ' — ' + r.error.message}`);
  return r.value;
};
const expectFail = (r, code, what) => {
  assert.equal(r.ok, false, `${what}: expected a refusal, got success`);
  assert.equal(r.error.code, code, `${what}: ${r.error.message}`);
  return r.error;
};

/** A minimal well-formed definition, for tests that break exactly one rule. */
function definition(overrides = {}) {
  return {
    key: 'test_calc',
    version: '1.0.0',
    name: 'Test Calculation',
    description: 'A definition used to exercise one validation rule at a time.',
    rationale:
      'Exists only so a single validation rule can be broken in isolation and the ' +
      'resulting refusal observed.',
    owner: 'Architecture',
    status: 'ACTIVE',
    effectiveFrom: '2026-10-01',
    outputMetricKey: 'CashImpact',
    outputUnit: 'currency',
    scopeCompatibility: null,
    definitionConfidence: 1,
    expression: 'gross_margin',
    inputs: [
      {
        name: 'gross_margin',
        metricKey: 'GrossMargin',
        binding: { kind: 'SAME_SUBJECT' },
        required: true,
        expectUnit: 'currency',
        description: 'Gross margin in currency for this subject.',
      },
    ],
    compute: (_ctx, inputs) => ok(inputs.gross_margin),
    ...overrides,
  };
}

const registryOf = (defs) => createCalculationRegistry(defs, buildSeedValueRegistry());

/** Full stack over the canonical graph, with an optional extra definition set. */
async function buildStack({ definitions = meridianValueModelV1, fixedClock = false } = {}) {
  let tick = 0;
  const base = Date.parse('2026-09-19T08:00:00.000Z');
  const clock = fixedClock
    ? { now: () => new Date(base) }
    : { now: () => new Date(base + (tick += 1) * 1000) };
  const idGen = seqIdGen('s');
  const ontology = buildSeedRegistry();

  const graphStore = createInMemoryGraphStore({ registry: ontology, clock, idGen });
  unwrap(await buildCanonicalScenario(graphStore, scope), 'entity graph');
  const valueGraph = createInMemoryValueGraph({
    metrics: buildSeedValueRegistry(),
    ontology,
    graphStore,
    clock,
    idGen,
  });
  const chain = unwrap(await buildCanonicalValueChain(valueGraph, graphStore, scope), 'value chain');
  const registry = unwrap(registryOf(definitions), 'calculation registry');
  const store = createInMemoryCalculationStore({ clock, idGen });
  const engine = unwrap(
    createPropagationEngine({ registry, valueGraph, graphStore, ontology, store, clock }),
    'engine',
  );
  return { engine, valueGraph, graphStore, ontology, registry, store, clock, ids: chain.nodeIds, scenarios: chain.scenarioIds };
}

const entityBy = async (graphStore, key) =>
  unwrap(await graphStore.findEntities(scope, { canonicalKeys: [key] }), key)[0];

const latest = async (valueGraph, nodeId, type) => {
  const r = await valueGraph.getLatestObservation(scope, { nodeId, type });
  if (!r.ok || !r.value) return null;
  return r.value.metadata?.exactValue ?? String(r.value.numericValue);
};

// ============================================================ registry rules

describe('the calculation registry refuses a definition that could produce a wrong number', () => {
  test('an unknown output metric', () => {
    const e = expectFail(
      registryOf([definition({ outputMetricKey: 'Vibes' })]),
      CalculationErrors.CALCULATION_NOT_FOUND,
      'unknown output metric',
    );
    assert.match(e.message, /unknown_output_metric/);
  });

  test('an output unit that contradicts its metric', () => {
    const e = expectFail(
      registryOf([definition({ outputUnit: 'percentage' })]),
      CalculationErrors.CALCULATION_NOT_FOUND,
      'output unit',
    );
    assert.match(e.message, /output_unit_mismatch/);
  });

  test('an input unit that contradicts its metric', () => {
    const broken = definition();
    broken.inputs = [{ ...broken.inputs[0], expectUnit: 'units' }];
    assert.match(
      expectFail(registryOf([broken]), CalculationErrors.CALCULATION_NOT_FOUND, 'input unit').message,
      /input_unit_mismatch/,
    );
  });

  test('no inputs at all — a constant masquerading as a calculation (§20)', () => {
    const e = expectFail(
      registryOf([definition({ inputs: [] })]),
      CalculationErrors.CALCULATION_NOT_FOUND,
      'no inputs',
    );
    assert.match(e.message, /no_inputs/);
    assert.match(e.message, /assumption observation/);
  });

  test('no business rationale — an anonymous management calculation (§63)', () => {
    assert.match(
      expectFail(registryOf([definition({ rationale: 'because' })]), CalculationErrors.CALCULATION_NOT_FOUND, 'rationale').message,
      /missing_rationale/,
    );
  });

  test('no owner', () => {
    assert.match(
      expectFail(registryOf([definition({ owner: '' })]), CalculationErrors.CALCULATION_NOT_FOUND, 'owner').message,
      /missing_owner/,
    );
  });

  test('no human-readable formula, so its trace could not explain itself', () => {
    assert.match(
      expectFail(registryOf([definition({ expression: '' })]), CalculationErrors.CALCULATION_NOT_FOUND, 'expression').message,
      /missing_expression/,
    );
  });

  test('an undocumented input', () => {
    const broken = definition();
    broken.inputs = [{ ...broken.inputs[0], description: 'gm' }];
    assert.match(
      expectFail(registryOf([broken]), CalculationErrors.CALCULATION_NOT_FOUND, 'undocumented').message,
      /undocumented_input/,
    );
  });

  test('a non-semver version', () => {
    assert.match(
      expectFail(registryOf([definition({ version: '1.0' })]), CalculationErrors.CALCULATION_NOT_FOUND, 'version').message,
      /invalid_version/,
    );
  });

  test('the same key and version registered twice', () => {
    assert.match(
      expectFail(registryOf([definition(), definition()]), CalculationErrors.CALCULATION_NOT_FOUND, 'duplicate').message,
      /duplicate_calculation/,
    );
  });

  test('a confidence outside 0..1', () => {
    assert.match(
      expectFail(registryOf([definition({ definitionConfidence: 1.5 })]), CalculationErrors.CALCULATION_NOT_FOUND, 'confidence').message,
      /invalid_definition_confidence/,
    );
  });

  test('the real Meridian model passes every rule', () => {
    const registry = unwrap(registryOf(meridianValueModelV1), 'meridian');
    assert.equal(registry.active().length, 9, 'nine active calculations');
    for (const calc of registry.all()) {
      assert.ok(calc.rationale.length > 20, `${calc.key} explains itself`);
      assert.ok(calc.owner.length > 0, `${calc.key} has an owner`);
    }
  });
});

// =============================================================== versioning

describe('versioning — a meaning change is a new version, never an edit', () => {
  const v1 = definition({ version: '1.0.0', status: 'DEPRECATED' });
  const v2 = definition({
    version: '2.0.0',
    expression: 'gross_margin − gross_margin',
    compute: (_ctx, inputs) => difference(inputs.gross_margin, inputs.gross_margin),
  });

  test('two versions of one key coexist; the latest ACTIVE one wins for new runs', () => {
    const registry = unwrap(registryOf([v1, v2]), 'versions');
    assert.equal(registry.get('test_calc').version, '2.0.0', 'new runs use the latest active');
    assert.equal(registry.active().length, 1, 'only one is active');
  });

  test('the superseded version stays resolvable, so old traces still explain', () => {
    const registry = unwrap(registryOf([v1, v2]), 'versions');
    const old = registry.get('test_calc', '1.0.0');
    assert.ok(old, 'the deprecated definition is still retrievable by exact version');
    assert.equal(old.expression, 'gross_margin', 'with the formula it actually used');
  });

  test('two ACTIVE definitions of the same key and version is a conflict', () => {
    const a = definition({ version: '3.0.0' });
    const b = definition({ version: '3.0.0', name: 'Rival' });
    assert.match(
      expectFail(registryOf([a, b]), CalculationErrors.CALCULATION_NOT_FOUND, 'conflict').message,
      /duplicate_calculation|conflicting_active_definitions/,
    );
  });

  test('a trace records the version it ran, not the version that is current now', async () => {
    const { engine } = await buildStack();
    const result = unwrap(
      await engine.execute(scope, { fromMetricKeys: BASELINE_ROOTS, asOf: AS_OF, horizon: 'quarter' }),
      'run',
    );
    for (const step of result.steps) {
      assert.match(step.calculationVersion, /^\d+\.\d+\.\d+$/);
      assert.equal(step.calculationVersion, '1.0.0', 'the version in force when it ran');
    }
  });
});

// ============================================================ cycle refusal

describe('cycles are refused at construction, not discovered at runtime', () => {
  const loopA = definition({
    key: 'loop_a',
    outputMetricKey: 'CashImpact',
    expression: 'gross_margin',
  });
  const loopB = definition({
    key: 'loop_b',
    outputMetricKey: 'GrossMargin',
    expression: 'cash_impact',
    inputs: [
      {
        name: 'cash_impact',
        metricKey: 'CashImpact',
        binding: { kind: 'SAME_SUBJECT' },
        required: true,
        expectUnit: 'currency',
        description: 'Cash impact of this subject, in currency.',
      },
    ],
    compute: (_ctx, inputs) => ok(inputs.cash_impact),
  });

  test('an engine cannot be built around a circular model', async () => {
    const registry = unwrap(registryOf([loopA, loopB]), 'circular registry');
    const graphStore = createInMemoryGraphStore({
      registry: buildSeedRegistry(),
      clock: { now: () => AS_OF },
      idGen: seqIdGen('c'),
    });
    const ontology = buildSeedRegistry();
    const valueGraph = createInMemoryValueGraph({
      metrics: buildSeedValueRegistry(),
      ontology,
      graphStore,
      clock: { now: () => AS_OF },
      idGen: seqIdGen('c'),
    });
    const store = createInMemoryCalculationStore({ clock: { now: () => AS_OF }, idGen: seqIdGen('c') });

    const e = expectFail(
      createPropagationEngine({ registry, valueGraph, graphStore, ontology, store, clock: { now: () => AS_OF } }),
      CalculationErrors.CYCLE_DETECTED,
      'circular model',
    );
    // The message must name the loop, not merely assert that one exists.
    assert.match(e.message, /CashImpact/);
    assert.match(e.message, /GrossMargin/);
  });

  test('the real model has no cycle and a deterministic order', async () => {
    const { registry } = await buildStack();
    const { buildDependencyGraph, downstreamOf } = await import('../src/dependencyGraph.ts');
    const first = unwrap(buildDependencyGraph(registry), 'graph');
    const second = unwrap(buildDependencyGraph(registry), 'graph again');
    assert.deepEqual([...second.order], [...first.order], 'ordering is stable across builds');

    // Determinism is what makes a trace reproducible, so the tie-break has to be
    // total: two metrics at the same depth always come out in the same order.
    const downstream = downstreamOf(first, ['UnitCost']);
    assert.deepEqual(
      [...downstream],
      [...downstreamOf(second, ['UnitCost'])],
      'the affected set is stable too',
    );
    assert.ok(downstream.includes('WorkingCapital'));
    assert.ok(!downstream.includes('ExpectedRevenue'), 'revenue does not depend on cost');
  });
});

// ================================================== observation selection

describe('observation selection is policy, never "the latest number"', () => {
  test('a TARGET is never selected — it is what we want, not what we believe', async () => {
    const readsServiceLevel = definition({
      key: 'service_readthrough',
      outputMetricKey: 'GrossMarginPct',
      outputUnit: 'percentage',
      expression: 'service_level',
      inputs: [
        {
          name: 'service_level',
          metricKey: 'ServiceLevel',
          binding: { kind: 'SAME_SUBJECT' },
          required: true,
          expectUnit: 'percentage',
          horizon: 'quarter',
          description: 'Service level achieved over the period, as a percentage.',
        },
      ],
      compute: (_ctx, inputs) => ok(inputs.service_level),
    });

    const { engine, valueGraph, graphStore } = await buildStack({
      definitions: [readsServiceLevel],
    });
    // Put the output on the same subject as the service-level commitment.
    const sla = await entityBy(graphStore, 'helm:servicelevel:rohto-98');
    const out = unwrap(
      await valueGraph.upsertValueNode(scope, {
        metricKey: 'GrossMarginPct',
        subjectEntityId: sla.id,
        timeHorizon: 'quarter',
        label: 'Readthrough — service level',
      }),
      'output node',
    );

    const result = unwrap(
      await engine.execute(scope, { fromMetricKeys: ['ServiceLevel'], asOf: AS_OF, horizon: 'quarter' }),
      'run',
    );
    const step = result.steps.find((s) => s.outputNodeId === out.id);
    assert.ok(step, 'the step ran');
    assert.equal(step.status, 'CALCULATED');
    // The node carries a TARGET of 98 and a FORECAST of 84. The 98 is higher,
    // more authoritative-looking, and completely wrong to plan against.
    assert.equal(step.outputValue, '84');
    assert.equal(step.inputs[0].observationType, 'FORECAST');
  });

  test('ASSUMPTION_ONLY does not quietly fall back to a measured actual', async () => {
    const pretendsCostIsAnAssumption = definition({
      key: 'assumed_cost',
      expression: 'assumed_unit_cost',
      inputs: [
        {
          name: 'assumed_unit_cost',
          metricKey: 'UnitCost',
          binding: { kind: 'SAME_SUBJECT' },
          required: true,
          expectUnit: 'currency',
          horizon: 'current',
          preference: 'ASSUMPTION_ONLY',
          description: 'Assumed landed cost per unit of the product.',
        },
      ],
      compute: (_ctx, inputs) => ok(inputs.assumed_unit_cost),
    });

    const { engine, valueGraph, graphStore } = await buildStack({
      definitions: [pretendsCostIsAnAssumption],
    });
    const skuX = await entityBy(graphStore, 'helm:product:sku-x');
    const out = unwrap(
      await valueGraph.upsertValueNode(scope, {
        metricKey: 'CashImpact',
        subjectEntityId: skuX.id,
        timeHorizon: 'quarter',
        label: 'Cash from assumed cost',
      }),
      'output node',
    );

    const result = unwrap(
      await engine.execute(scope, { fromMetricKeys: ['UnitCost'], asOf: AS_OF, horizon: 'quarter' }),
      'run',
    );
    const step = result.steps.find((s) => s.outputNodeId === out.id);
    // Unit cost exists — as an ACTUAL from the ERP. Under ASSUMPTION_ONLY that
    // is not an answer, and inventing one would misstate where it came from.
    assert.equal(step.status, 'BLOCKED');
    assert.equal(step.errorCode, CalculationErrors.MISSING_INPUT);
    assert.match(step.errorMessage, /ASSUMPTION_ONLY/);
  });

  test('two identical claims — same valid time, same record time — are ambiguous, not arbitrary', async () => {
    // A frozen clock makes both observations share a record time, which is the
    // only situation where nothing can distinguish them.
    const { engine, valueGraph, ids } = await buildStack({ fixedClock: true });
    for (const value of [0.6, 0.8]) {
      unwrap(
        await valueGraph.recordObservation(scope, {
          nodeId: ids.oppProb,
          observationType: 'ACTUAL',
          numericValue: value,
          unitType: 'ratio',
          effectiveAt: asValidTime('2026-09-19T11:00:00.000Z'),
          observedAt: asValidTime('2026-09-19T11:00:00.000Z'),
          sourceSystem: 'memoire',
          confidence: 0.8,
        }),
        `probability ${value}`,
      );
    }

    const result = unwrap(
      await engine.execute(scope, { fromMetricKeys: ['OpportunityProbability'], asOf: AS_OF, horizon: 'quarter' }),
      'run',
    );
    const step = result.steps.find((s) => s.outputNodeId === ids.expRevenue);
    assert.equal(step.status, 'BLOCKED');
    assert.equal(step.errorCode, CalculationErrors.AMBIGUOUS_INPUT);
    assert.match(step.errorMessage, /will not pick one arbitrarily/);
  });

  test('the later RECORD of two equally-valid claims supersedes', async () => {
    const { engine, valueGraph, ids } = await buildStack();
    unwrap(
      await engine.execute(scope, { fromMetricKeys: BASELINE_ROOTS, asOf: AS_OF, horizon: 'quarter' }),
      'baseline',
    );
    // Same effectiveAt as the original 0.7 observation: only the record time
    // differs, and that is precisely what makes this the current belief.
    unwrap(
      await valueGraph.recordObservation(scope, {
        nodeId: ids.oppProb,
        observationType: 'ACTUAL',
        numericValue: 0.5,
        unitType: 'ratio',
        effectiveAt: asValidTime('2026-09-19T00:00:00.000Z'),
        observedAt: asValidTime('2026-09-19T00:00:00.000Z'),
        sourceSystem: 'memoire',
        confidence: 1,
      }),
      'corrected probability',
    );
    unwrap(
      await engine.propagateFrom(scope, 'OpportunityProbability', { asOf: AS_OF, horizon: 'quarter' }),
      'propagate',
    );
    assert.equal(await latest(valueGraph, ids.expRevenue, 'DERIVED'), '2100000000');
  });

  test('a claim HELM did not yet know at asOf is not used', async () => {
    const { engine, valueGraph, ids } = await buildStack();
    unwrap(
      await valueGraph.recordObservation(scope, {
        nodeId: ids.oppProb,
        observationType: 'ACTUAL',
        numericValue: 0.95,
        unitType: 'ratio',
        effectiveAt: asValidTime('2026-09-19T11:00:00.000Z'),
        // Observed AFTER the run's asOf: the model must not read the future.
        observedAt: asValidTime('2026-09-20T09:00:00.000Z'),
        sourceSystem: 'memoire',
        confidence: 1,
      }),
      'tomorrow\'s probability',
    );
    unwrap(
      await engine.execute(scope, { fromMetricKeys: BASELINE_ROOTS, asOf: AS_OF, horizon: 'quarter' }),
      'run',
    );
    assert.equal(
      await latest(valueGraph, ids.expRevenue, 'DERIVED'),
      '2940000000',
      'still the 0.70 answer — tomorrow has not happened yet',
    );
  });

  test('a period forecast IS usable before its period starts', async () => {
    // The mirror of the previous test, and the reason eligibility is judged on
    // record time: a Q4 forecast made in September must be usable in September.
    const { engine, valueGraph, graphStore } = await buildStack({
      definitions: [
        definition({
          key: 'reads_forecast_revenue',
          expression: 'expected_revenue',
          inputs: [
            {
              name: 'expected_revenue',
              metricKey: 'ExpectedRevenue',
              binding: { kind: 'SAME_SUBJECT' },
              required: true,
              expectUnit: 'currency',
              horizon: 'quarter',
              preference: 'ACTUALS_FIRST',
              description: 'Probability-weighted revenue for this opportunity.',
            },
          ],
          compute: (_ctx, inputs) => ok(inputs.expected_revenue),
        }),
      ],
    });
    const opp = await entityBy(graphStore, 'memoire:opportunity:opp-8821');
    const out = unwrap(
      await valueGraph.upsertValueNode(scope, {
        metricKey: 'CashImpact',
        subjectEntityId: opp.id,
        timeHorizon: 'quarter',
        label: 'Cash from the stated forecast',
      }),
      'output node',
    );
    const result = unwrap(
      await engine.execute(scope, { fromMetricKeys: ['ExpectedRevenue'], asOf: AS_OF, horizon: 'quarter' }),
      'run',
    );
    const step = result.steps.find((s) => s.outputNodeId === out.id);
    assert.equal(step.status, 'CALCULATED');
    assert.equal(step.inputs[0].observationType, 'FORECAST');
    assert.equal(step.outputValue, '2940000000', 'the Q4 forecast, read in September');
  });
});

// ================================================================ ambiguity

describe('structural ambiguity is refused rather than resolved by guesswork', () => {
  test('two candidate nodes and no declared aggregation', async () => {
    const { engine, valueGraph, graphStore } = await buildStack({
      definitions: [
        definition({
          key: 'unaggregated',
          expression: 'opex',
          inputs: [
            {
              name: 'opex',
              metricKey: 'Opex',
              binding: { kind: 'SAME_SUBJECT' },
              required: true,
              expectUnit: 'currency',
              horizon: 'quarter',
              description: 'Operating expense attributable to this cost object.',
            },
          ],
        }),
      ],
    });
    const cost = await entityBy(graphStore, 'helm:cost:expedited-freight');
    // A second Opex node on the same subject and horizon, distinguished only by
    // its scope. Both legitimately answer "what is the opex here?".
    unwrap(
      await valueGraph.upsertValueNode(scope, {
        metricKey: 'Opex',
        subjectEntityId: cost.id,
        scopeKind: 'function',
        scopeRef: 'supply-chain',
        timeHorizon: 'quarter',
        label: 'Operating Expense — freight, supply chain view',
      }),
      'second opex node',
    );
    const out = unwrap(
      await valueGraph.upsertValueNode(scope, {
        metricKey: 'CashImpact',
        subjectEntityId: cost.id,
        timeHorizon: 'quarter',
        label: 'Cash from freight',
      }),
      'output',
    );

    const result = unwrap(
      await engine.execute(scope, { fromMetricKeys: ['Opex'], asOf: AS_OF, horizon: 'quarter' }),
      'run',
    );
    const step = result.steps.find((s) => s.outputNodeId === out.id);
    assert.equal(step.status, 'BLOCKED');
    assert.equal(step.errorCode, CalculationErrors.AMBIGUOUS_INPUT);
    assert.match(step.errorMessage, /does not declare aggregation/);
  });

  test('aggregating across mixed currencies needs a rate HELM does not have', async () => {
    const { engine, valueGraph, graphStore } = await buildStack({
      definitions: [
        definition({
          key: 'aggregated_opex',
          expression: 'Σ opex',
          inputs: [
            {
              name: 'opex',
              metricKey: 'Opex',
              binding: {
                kind: 'RELATED_ENTITY',
                relationshipTypeKey: 'INCURS',
                direction: 'out',
                aggregate: true,
              },
              required: true,
              expectUnit: 'currency',
              horizon: 'quarter',
              description: 'Every operating expense this opportunity incurs.',
            },
          ],
          compute: (_ctx, inputs) => ok(inputs.opex),
        }),
      ],
    });
    const opp = await entityBy(graphStore, 'memoire:opportunity:opp-8821');
    // A second cost, denominated in USD — an air-freight invoice from abroad.
    const usdCost = unwrap(
      await graphStore.upsertEntity(scope, {
        entityTypeKey: 'Cost',
        canonicalKey: 'helm:cost:osaka-handling',
        name: 'Osaka handling charge',
        sourceSystem: 'erp',
        attributes: { behaviour: 'variable', currency: 'USD' },
      }),
      'usd cost',
    ).entity;
    unwrap(
      await graphStore.createRelationship(scope, {
        relationshipTypeKey: 'INCURS',
        sourceEntityId: opp.id,
        targetEntityId: usdCost.id,
        sourceSystem: 'erp',
      }),
      'incurs',
    );
    const usdNode = unwrap(
      await valueGraph.upsertValueNode(scope, {
        metricKey: 'Opex',
        subjectEntityId: usdCost.id,
        timeHorizon: 'quarter',
        label: 'Operating Expense — Osaka handling',
      }),
      'usd opex node',
    );
    unwrap(
      await valueGraph.recordObservation(scope, {
        nodeId: usdNode.id,
        observationType: 'ACTUAL',
        numericValue: 1800,
        unitType: 'currency',
        currency: 'USD',
        periodStart: asValidTime('2026-10-01T00:00:00.000Z'),
        periodEnd: asValidTime('2027-01-01T00:00:00.000Z'),
        sourceSystem: 'erp',
        confidence: 1,
      }),
      'usd observation',
    );
    const out = unwrap(
      await valueGraph.upsertValueNode(scope, {
        metricKey: 'CashImpact',
        subjectEntityId: opp.id,
        timeHorizon: 'quarter',
        label: 'Cash from total opex',
      }),
      'output',
    );

    const result = unwrap(
      await engine.execute(scope, { fromMetricKeys: ['Opex'], asOf: AS_OF, horizon: 'quarter' }),
      'run',
    );
    const step = result.steps.find((s) => s.outputNodeId === out.id);
    assert.equal(step.status, 'BLOCKED');
    assert.equal(step.errorCode, CalculationErrors.CURRENCY_MISMATCH);
    assert.match(step.errorMessage, /mix units or currencies/);
  });

  test('HELM never invents an FX rate, at the quantity layer either', () => {
    const r = sum(
      mustQuantity(decimal('1000'), 'currency', 'VND'),
      mustQuantity(decimal('1000'), 'currency', 'USD'),
    );
    expectFail(r, 'calculation.fx_rate_required', 'mixed currency addition');
  });
});

// ============================================================= time context

describe('time context', () => {
  test('a metric that exists only at the wrong horizon is a MISMATCH, not a gap', async () => {
    const { engine, valueGraph, graphStore } = await buildStack({
      definitions: [
        definition({
          key: 'wants_a_year',
          expression: 'expected_revenue',
          inputs: [
            {
              name: 'expected_revenue',
              metricKey: 'ExpectedRevenue',
              binding: { kind: 'SAME_SUBJECT' },
              required: true,
              expectUnit: 'currency',
              horizon: 'year',
              description: 'Probability-weighted revenue for the year.',
            },
          ],
          compute: (_ctx, inputs) => ok(inputs.expected_revenue),
        }),
      ],
    });
    const opp = await entityBy(graphStore, 'memoire:opportunity:opp-8821');
    const out = unwrap(
      await valueGraph.upsertValueNode(scope, {
        metricKey: 'CashImpact',
        subjectEntityId: opp.id,
        timeHorizon: 'quarter',
        label: 'Cash from annual revenue',
      }),
      'output',
    );
    const result = unwrap(
      await engine.execute(scope, { fromMetricKeys: ['ExpectedRevenue'], asOf: AS_OF, horizon: 'quarter' }),
      'run',
    );
    const step = result.steps.find((s) => s.outputNodeId === out.id);
    assert.equal(step.status, 'BLOCKED');
    assert.equal(step.errorCode, CalculationErrors.TIME_CONTEXT_MISMATCH);
    // The distinction that matters to a reader: the data is there, the period is wrong.
    assert.match(step.errorMessage, /exists for this subject but only at quarter/);
    assert.match(step.errorMessage, /needs year/);
  });

  test('allowCrossPeriod accepts it, and says so in the definition', async () => {
    const { engine, valueGraph, graphStore } = await buildStack({
      definitions: [
        definition({
          key: 'explicitly_cross_period',
          expression: 'expected_revenue',
          inputs: [
            {
              name: 'expected_revenue',
              metricKey: 'ExpectedRevenue',
              binding: { kind: 'SAME_SUBJECT' },
              required: true,
              expectUnit: 'currency',
              horizon: 'year',
              allowCrossPeriod: true,
              description: 'Probability-weighted revenue, period deliberately ignored.',
            },
          ],
          compute: (_ctx, inputs) => ok(inputs.expected_revenue),
        }),
      ],
    });
    const opp = await entityBy(graphStore, 'memoire:opportunity:opp-8821');
    const out = unwrap(
      await valueGraph.upsertValueNode(scope, {
        metricKey: 'CashImpact',
        subjectEntityId: opp.id,
        timeHorizon: 'quarter',
        label: 'Cash, cross-period',
      }),
      'output',
    );
    const result = unwrap(
      await engine.execute(scope, { fromMetricKeys: ['ExpectedRevenue'], asOf: AS_OF, horizon: 'quarter' }),
      'run',
    );
    const step = result.steps.find((s) => s.outputNodeId === out.id);
    assert.equal(step.status, 'CALCULATED');
  });

  test('a stock is written with an instant and a flow with a period', async () => {
    const { engine, valueGraph, ids } = await buildStack();
    unwrap(
      await engine.execute(scope, { fromMetricKeys: BASELINE_ROOTS, asOf: AS_OF, horizon: 'quarter' }),
      'run',
    );
    const wc = unwrap(
      await valueGraph.getLatestObservation(scope, { nodeId: ids.wcProduct, type: 'DERIVED' }),
      'working capital',
    );
    // WorkingCapital is POINT_IN_TIME: a balance, even over a quarter's demand.
    assert.ok(wc.effectiveAt, 'the balance is anchored at an instant');
    assert.equal(wc.periodStart, null);

    const revenue = unwrap(
      await valueGraph.getLatestObservation(scope, { nodeId: ids.expRevenue, type: 'DERIVED' }),
      'revenue',
    );
    assert.ok(revenue.periodStart && revenue.periodEnd, 'the flow is measured over an interval');
    assert.equal(revenue.effectiveAt, null);
  });
});

// ======================================================== scope and depth

describe('scope compatibility and depth', () => {
  test('a deal-level calculation refuses an enterprise-level subject', async () => {
    const { engine, ids } = await buildStack();
    const plan = unwrap(
      await engine.planPropagation(scope, { fromMetricKeys: BASELINE_ROOTS, asOf: AS_OF, horizon: 'quarter' }),
      'plan',
    );
    const refused = plan.uncomputable.find((u) => u.nodeId === ids.evCash);
    assert.ok(refused, 'the enterprise cash dimension is declared uncomputable');
    assert.match(refused.reason, /does not apply to a value subject/);
    assert.match(refused.reason, /allowed: commercial, market/);

    // And it is NOT silently attempted and blocked — the distinction between
    // "the model does not claim to do this" and "it tried and failed".
    const run = unwrap(
      await engine.execute(scope, { fromMetricKeys: BASELINE_ROOTS, asOf: AS_OF, horizon: 'quarter' }),
      'run',
    );
    assert.ok(!run.steps.some((s) => s.outputNodeId === ids.evCash), 'no step was attempted');
  });

  test('the ontology, not a hand-kept list, decides what a category is', async () => {
    const { ontology } = await buildStack();
    assert.equal(ontology.categoryOf('Opportunity'), 'commercial');
    assert.equal(ontology.categoryOf('EnterpriseValue'), 'value');
    assert.equal(ontology.categoryOf('BusinessUnit'), 'organization');
    assert.equal(ontology.categoryOf('NotAnEntityType'), null);
  });

  test('an out-of-range depth is refused', async () => {
    const { engine } = await buildStack();
    expectFail(
      await engine.planPropagation(scope, { asOf: AS_OF, horizon: 'quarter', maxDepth: 99 }),
      CalculationErrors.DEPTH_EXCEEDED,
      'excessive depth',
    );
    expectFail(
      await engine.planPropagation(scope, { asOf: AS_OF, horizon: 'quarter', maxDepth: -1 }),
      CalculationErrors.DEPTH_EXCEEDED,
      'negative depth',
    );
  });

  test('a calculation whose implementation returns the wrong unit FAILS, and nothing is stored', async () => {
    const { engine, valueGraph, graphStore } = await buildStack({
      definitions: [
        definition({
          key: 'buggy_unit',
          expression: 'gross_margin (mis-implemented)',
          // Declares currency, returns a ratio. This is a code bug, and the
          // engine must catch it before the number reaches the value graph.
          compute: (_ctx, inputs) =>
            ok(mustQuantity(inputs.gross_margin.amount, 'ratio', null)),
        }),
      ],
    });
    const opp = await entityBy(graphStore, 'memoire:opportunity:opp-8821');
    const out = unwrap(
      await valueGraph.upsertValueNode(scope, {
        metricKey: 'CashImpact',
        subjectEntityId: opp.id,
        timeHorizon: 'quarter',
        label: 'Cash, mis-implemented',
      }),
      'output',
    );
    const result = unwrap(
      await engine.execute(scope, { fromMetricKeys: ['GrossMargin'], asOf: AS_OF, horizon: 'quarter' }),
      'run',
    );
    const step = result.steps.find((s) => s.outputNodeId === out.id);
    assert.equal(step.status, 'FAILED');
    assert.equal(step.errorCode, CalculationErrors.UNIT_MISMATCH);
    assert.equal(await latest(valueGraph, out.id, 'DERIVED'), null, 'nothing was written');
  });
});

// ========================================================= scenario isolation

describe('scenario isolation — a scenario never leaks into reality', () => {
  test('a scenario run writes SCENARIO observations, leaving the baseline intact', async () => {
    const { engine, valueGraph, ids, scenarios } = await buildStack();
    unwrap(
      await engine.execute(scope, { fromMetricKeys: BASELINE_ROOTS, asOf: AS_OF, horizon: 'quarter' }),
      'baseline',
    );
    const baseline = await latest(valueGraph, ids.expRevenue, 'DERIVED');
    assert.equal(baseline, '2940000000');

    // The scenario's premise: the tender closes at 90%.
    unwrap(
      await valueGraph.recordObservation(scope, {
        nodeId: ids.oppProb,
        observationType: 'SCENARIO',
        numericValue: 0.9,
        unitType: 'ratio',
        effectiveAt: asValidTime('2026-09-19T10:00:00.000Z'),
        scenarioEntityId: scenarios.expedite,
        sourceSystem: 'helm',
        confidence: 0.6,
      }),
      'scenario probability',
    );

    const run = unwrap(
      await engine.execute(scope, {
        fromMetricKeys: BASELINE_ROOTS,
        asOf: AS_OF,
        horizon: 'quarter',
        scenarioEntityId: scenarios.expedite,
      }),
      'scenario run',
    );
    assert.ok(run.summary.CALCULATED > 0);
    assert.equal(run.run.context.preference, 'SCENARIO', 'a scenario run defaults to scenario reads');

    const scenarioRevenue = unwrap(
      await valueGraph.getObservations(scope, {
        nodeId: ids.expRevenue,
        types: ['SCENARIO'],
        scenarioEntityId: scenarios.expedite,
      }),
      'scenario revenue',
    );
    assert.equal(scenarioRevenue.length, 1);
    assert.equal(scenarioRevenue[0].metadata?.exactValue, '3780000000');

    // Reality is exactly as it was.
    assert.equal(
      await latest(valueGraph, ids.expRevenue, 'DERIVED'),
      baseline,
      'the baseline derived value was not touched',
    );
  });

  test('a baseline run cannot read a scenario value, even a newer one', async () => {
    const { engine, valueGraph, ids, scenarios } = await buildStack();
    unwrap(
      await valueGraph.recordObservation(scope, {
        nodeId: ids.oppProb,
        observationType: 'SCENARIO',
        numericValue: 0.99,
        unitType: 'ratio',
        effectiveAt: asValidTime('2026-09-19T11:00:00.000Z'),
        scenarioEntityId: scenarios.expedite,
        sourceSystem: 'helm',
        confidence: 0.5,
      }),
      'optimistic scenario',
    );
    unwrap(
      await engine.execute(scope, { fromMetricKeys: BASELINE_ROOTS, asOf: AS_OF, horizon: 'quarter' }),
      'baseline',
    );
    assert.equal(
      await latest(valueGraph, ids.expRevenue, 'DERIVED'),
      '2940000000',
      'the baseline used the ACTUAL 0.70, not the scenario 0.99',
    );
  });

  test('two scenarios on one node stay separate', async () => {
    const { engine, valueGraph, ids, scenarios } = await buildStack();
    for (const [handle, probability] of [['expedite', 0.9], ['reallocate', 0.6]]) {
      unwrap(
        await valueGraph.recordObservation(scope, {
          nodeId: ids.oppProb,
          observationType: 'SCENARIO',
          numericValue: probability,
          unitType: 'ratio',
          effectiveAt: asValidTime('2026-09-19T10:00:00.000Z'),
          scenarioEntityId: scenarios[handle],
          sourceSystem: 'helm',
          confidence: 0.6,
        }),
        `${handle} premise`,
      );
      unwrap(
        await engine.execute(scope, {
          fromMetricKeys: BASELINE_ROOTS,
          asOf: AS_OF,
          horizon: 'quarter',
          scenarioEntityId: scenarios[handle],
        }),
        `${handle} run`,
      );
    }

    const expedite = unwrap(
      await valueGraph.getObservations(scope, {
        nodeId: ids.expRevenue,
        types: ['SCENARIO'],
        scenarioEntityId: scenarios.expedite,
      }),
      'expedite',
    );
    const reallocate = unwrap(
      await valueGraph.getObservations(scope, {
        nodeId: ids.expRevenue,
        types: ['SCENARIO'],
        scenarioEntityId: scenarios.reallocate,
      }),
      'reallocate',
    );
    assert.equal(expedite[0].metadata?.exactValue, '3780000000');
    assert.equal(reallocate[0].metadata?.exactValue, '2520000000');
  });
});

// ================================================================== dry run

describe('a dry run plans and writes nothing', () => {
  test('no observation, no run and no trace are created', async () => {
    const { engine, valueGraph, store, ids } = await buildStack();
    const result = unwrap(
      await engine.execute(scope, {
        fromMetricKeys: BASELINE_ROOTS,
        asOf: AS_OF,
        horizon: 'quarter',
        dryRun: true,
      }),
      'dry run',
    );
    assert.equal(result.steps.length, 0);
    assert.equal(result.written.length, 0);
    assert.equal(result.run.id, 'dry-run');
    assert.equal(await latest(valueGraph, ids.expRevenue, 'DERIVED'), null);
    assert.equal(unwrap(await store.listRuns(scope, 50), 'runs').length, 0);
  });

  test('but the plan it returns is the plan that would run', async () => {
    const { engine } = await buildStack();
    const plan = unwrap(
      await engine.planPropagation(scope, { fromMetricKeys: BASELINE_ROOTS, asOf: AS_OF, horizon: 'quarter' }),
      'plan',
    );
    assert.equal(plan.nodes.length, 11, 'eleven value positions are computable');
    // Ordered: a step never precedes one it depends on.
    const seen = new Set();
    for (const node of plan.nodes) {
      for (const dep of node.dependsOn) {
        assert.ok(
          !plan.nodes.some((n) => n.calculation.outputMetricKey === dep && !seen.has(dep)),
          `${node.calculation.key} runs after ${dep}`,
        );
      }
      seen.add(node.calculation.outputMetricKey);
    }
  });
});

// =========================================================== tenant isolation

describe('tenant isolation', () => {
  test('another organization sees none of these runs, steps or derived values', async () => {
    const { engine, valueGraph, store, ids } = await buildStack();
    const run = unwrap(
      await engine.execute(scope, { fromMetricKeys: BASELINE_ROOTS, asOf: AS_OF, horizon: 'quarter' }),
      'run',
    );
    assert.ok(run.summary.CALCULATED > 0);

    assert.equal(unwrap(await store.listRuns(otherOrg, 50), 'org B runs').length, 0);
    assert.equal(unwrap(await store.getRun(otherOrg, run.run.id), 'org B run'), null);
    assert.equal(unwrap(await store.getSteps(otherOrg, run.run.id), 'org B steps').length, 0);

    const crossRead = await valueGraph.getValueNode(otherOrg, ids.expRevenue);
    assert.ok(!crossRead.ok || crossRead.value === null, 'org B cannot read org A value nodes');
  });

  test('org B cannot explain an observation it cannot see', async () => {
    const { engine, valueGraph, ids } = await buildStack();
    unwrap(
      await engine.execute(scope, { fromMetricKeys: BASELINE_ROOTS, asOf: AS_OF, horizon: 'quarter' }),
      'run',
    );
    const obs = unwrap(
      await valueGraph.getLatestObservation(scope, { nodeId: ids.expRevenue, type: 'DERIVED' }),
      'observation',
    );
    const r = await engine.explain(otherOrg, obs.id);
    assert.ok(!r.ok, 'a cross-tenant explanation is refused');
  });
});

// ================================================================= exactness

describe('exactness end to end', () => {
  test('every derived number in the canonical chain is exact, with no float drift', async () => {
    const { engine, valueGraph, ids } = await buildStack();
    unwrap(
      await engine.execute(scope, { fromMetricKeys: BASELINE_ROOTS, asOf: AS_OF, horizon: 'quarter' }),
      'run',
    );

    // 12 × 0.7 is 8.399999999999999 in IEEE-754. The demand here is a different
    // route to the same quantity, and it is exactly 8.4.
    assert.equal(await latest(valueGraph, ids.demand, 'DERIVED'), '8.4');
    assert.notEqual(String(0.7 * 12), '8.4', 'the float route really is wrong');

    assert.equal(await latest(valueGraph, ids.expRevenue, 'DERIVED'), '2940000000');
    assert.equal(await latest(valueGraph, ids.cogsOpp, 'DERIVED'), '1822800000');
    assert.equal(await latest(valueGraph, ids.grossMargin, 'DERIVED'), '977200000');
    // 1.395B ÷ 350M recurs; it is carried to the declared scale and no further.
    assert.equal(await latest(valueGraph, ids.demandNext, 'DERIVED'), '3.985714285714');
    assert.equal(await latest(valueGraph, ids.invRequirement, 'DERIVED'), '12.385714285714');
    assert.equal(await latest(valueGraph, ids.invGap, 'DERIVED'), '8.385714285714');
  });

  test('the recurring value is carried, not silently rounded to a tidy number', async () => {
    const { engine, valueGraph, ids } = await buildStack();
    unwrap(
      await engine.execute(scope, { fromMetricKeys: BASELINE_ROOTS, asOf: AS_OF, horizon: 'quarter' }),
      'run',
    );
    const wc = await latest(valueGraph, ids.wcProduct, 'DERIVED');
    assert.equal(wc, '2687699999.999938');
    assert.notEqual(wc, '2687700000', 'the residue of a recurring division is not hidden');
  });
});
