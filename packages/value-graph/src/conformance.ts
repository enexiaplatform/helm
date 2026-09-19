/**
 * The ValueGraph conformance suite.
 *
 * ONE contract, run against EVERY adapter — the same discipline as the Phase 1
 * GraphStore suite, for the same reason: an adapter-specific assumption fails
 * here immediately rather than years later.
 *
 * Runner-agnostic, so it works under `node --test` and anything later.
 */

import { asValidTime, type EntityId, type Result, type Scope } from '@helm/shared';
import type { GraphStore } from '@helm/graph-store';
import { canonicalKey } from '@helm/ontology';
import type { ValueGraph } from './port.ts';

export type TestApi = {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void> | void) => void;
  assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
  };
};

export type ValueAdapterHarness = {
  name: string;
  /** Fresh, empty value graph plus the entity graph it references. */
  create(): Promise<{
    valueGraph: ValueGraph;
    graphStore: GraphStore;
    scopeA: Scope;
    scopeB: Scope;
    cleanup?: () => Promise<void>;
  }>;
  skip?: readonly string[];
};

function expectOk<T>(r: Result<T>, what: string): T {
  if (!r.ok) throw new Error(`${what} failed: ${r.error.code} — ${r.error.message}`);
  return r.value;
}

const T0 = asValidTime('2026-09-19T00:00:00.000Z');
const P_START = asValidTime('2026-10-01T00:00:00.000Z');
const P_END = asValidTime('2027-01-01T00:00:00.000Z');

/** Creates an ontology entity to hang value nodes from. */
async function mkEntity(
  store: GraphStore,
  scope: Scope,
  typeKey: string,
  ref: string,
  name: string,
): Promise<EntityId> {
  const r = await store.createEntity(scope, {
    entityTypeKey: typeKey,
    canonicalKey: canonicalKey('helm', typeKey.toLowerCase(), ref),
    name,
    sourceSystem: 'helm',
  });
  return expectOk(r, `create ${typeKey}`).entity.id;
}

export function runValueConformanceSuite(api: TestApi, harness: ValueAdapterHarness): void {
  const { describe, it, assert } = api;
  const skip = new Set(harness.skip ?? []);
  const test = (name: string, fn: () => Promise<void>) => {
    if (skip.has(name)) return;
    it(name, fn);
  };

  describe(`ValueGraph conformance — ${harness.name}`, () => {
    // ----------------------------------------------- metric definitions

    test('ships metric definitions with machine-readable semantics', async () => {
      const h = await harness.create();
      try {
        const m = expectOk(
          await h.valueGraph.getMetricDefinition(h.scopeA, 'GrossMarginPct'),
          'get metric',
        );
        assert.ok(m, 'GrossMarginPct is seeded');
        assert.equal(m!.dimension, 'FINANCIAL');
        assert.equal(m!.unitType, 'percentage');
        assert.equal(m!.aggregation, 'WEIGHTED_AVERAGE', 'a ratio of sums cannot be summed');
        assert.equal(m!.directionality, 'HIGHER_IS_BETTER');
        assert.equal(m!.timeBehavior, 'PERIOD');
      } finally {
        await h.cleanup?.();
      }
    });

    test('metrics are filterable by value dimension', async () => {
      const h = await harness.create();
      try {
        const risk = expectOk(
          await h.valueGraph.findMetricDefinitions(h.scopeA, { dimensions: ['RISK'] }),
          'risk metrics',
        );
        assert.ok(risk.length >= 4, `expected several risk metrics, got ${risk.length}`);
        assert.ok(risk.every((m) => m.dimension === 'RISK'));

        const capital = expectOk(
          await h.valueGraph.findMetricDefinitions(h.scopeA, { dimensions: ['CAPITAL'] }),
          'capital metrics',
        );
        assert.ok(capital.length >= 2, 'capital is a distinct dimension from financial');
      } finally {
        await h.cleanup?.();
      }
    });

    // ------------------------------------------------------ value nodes

    test('creates a value node against an ontology entity', async () => {
      const h = await harness.create();
      try {
        const product = await mkEntity(h.graphStore, h.scopeA, 'Product', 'sku-x', 'SKU-X');
        const node = expectOk(
          await h.valueGraph.createValueNode(h.scopeA, {
            metricKey: 'InventoryGap',
            subjectEntityId: product,
            timeHorizon: 'current',
            label: 'Inventory Gap — SKU-X',
          }),
          'create node',
        );
        assert.equal(node.metricKey, 'InventoryGap');
        assert.equal(node.subjectEntityId, product, 'references the entity, never copies it');
        assert.equal(node.timeHorizon, 'current');
      } finally {
        await h.cleanup?.();
      }
    });

    test('one entity carries many value nodes — its value profile', async () => {
      const h = await harness.create();
      try {
        const product = await mkEntity(h.graphStore, h.scopeA, 'Product', 'sku-x', 'SKU-X');
        for (const metricKey of ['InventoryGap', 'UnitCost', 'GrossMargin', 'SupplyRisk']) {
          expectOk(
            await h.valueGraph.createValueNode(h.scopeA, {
              metricKey,
              subjectEntityId: product,
              timeHorizon: metricKey === 'GrossMargin' ? 'quarter' : 'current',
            }),
            metricKey,
          );
        }
        const profile = expectOk(
          await h.valueGraph.findNodesForEntity(h.scopeA, product),
          'profile',
        );
        assert.equal(profile.length, 4, 'SKU-X participates in four value dimensions');
      } finally {
        await h.cleanup?.();
      }
    });

    test('rejects an unknown metric', async () => {
      const h = await harness.create();
      try {
        const product = await mkEntity(h.graphStore, h.scopeA, 'Product', 'sku-x', 'SKU-X');
        const r = await h.valueGraph.createValueNode(h.scopeA, {
          metricKey: 'NotAMetric',
          subjectEntityId: product,
        });
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.error.code, 'value.unknown_metric');
      } finally {
        await h.cleanup?.();
      }
    });

    test('rejects a metric attached to an incompatible entity category', async () => {
      const h = await harness.create();
      try {
        const person = await mkEntity(h.graphStore, h.scopeA, 'Person', 'p1', 'A Person');
        // DemandQuantity is an operations/commercial metric; a Person is organization.
        const r = await h.valueGraph.createValueNode(h.scopeA, {
          metricKey: 'DemandQuantity',
          subjectEntityId: person,
        });
        assert.equal(r.ok, false, 'demand cannot be a property of a person');
        if (!r.ok) assert.equal(r.error.code, 'value.scope_incompatible');
      } finally {
        await h.cleanup?.();
      }
    });

    test('upsertValueNode is idempotent', async () => {
      const h = await harness.create();
      try {
        const product = await mkEntity(h.graphStore, h.scopeA, 'Product', 'sku-x', 'SKU-X');
        const input = {
          metricKey: 'UnitCost',
          subjectEntityId: product,
          timeHorizon: 'current' as const,
        };
        const a = expectOk(await h.valueGraph.upsertValueNode(h.scopeA, input), 'first');
        const b = expectOk(await h.valueGraph.upsertValueNode(h.scopeA, input), 'second');
        assert.equal(b.id, a.id, 'the same node, not a duplicate');
        const all = expectOk(await h.valueGraph.findNodesForEntity(h.scopeA, product), 'all');
        assert.equal(all.length, 1);
      } finally {
        await h.cleanup?.();
      }
    });

    // ------------------------------------------------------ value links

    test('links value nodes with typed value semantics', async () => {
      const h = await harness.create();
      try {
        const opp = await mkEntity(h.graphStore, h.scopeA, 'Opportunity', 'o1', 'Deal');
        const product = await mkEntity(h.graphStore, h.scopeA, 'Product', 'sku-x', 'SKU-X');
        const rev = expectOk(
          await h.valueGraph.createValueNode(h.scopeA, {
            metricKey: 'ExpectedRevenue',
            subjectEntityId: opp,
            timeHorizon: 'quarter',
          }),
          'revenue node',
        );
        const demand = expectOk(
          await h.valueGraph.createValueNode(h.scopeA, {
            metricKey: 'DemandQuantity',
            subjectEntityId: product,
            timeHorizon: 'quarter',
          }),
          'demand node',
        );
        const link = expectOk(
          await h.valueGraph.createValueLink(h.scopeA, {
            linkType: 'DRIVES',
            sourceNodeId: rev.id,
            targetNodeId: demand.id,
            weight: 12,
            confidence: 0.7,
            sourceSystem: 'helm',
          }),
          'link',
        );
        assert.equal(link.linkType, 'DRIVES');
        assert.equal(link.weight, 12);
        assert.equal(link.confidence, 0.7);
      } finally {
        await h.cleanup?.();
      }
    });

    test('rejects a self-referencing value link', async () => {
      const h = await harness.create();
      try {
        const product = await mkEntity(h.graphStore, h.scopeA, 'Product', 'sku-x', 'SKU-X');
        const n = expectOk(
          await h.valueGraph.createValueNode(h.scopeA, {
            metricKey: 'UnitCost',
            subjectEntityId: product,
            timeHorizon: 'current',
          }),
          'node',
        );
        const r = await h.valueGraph.createValueLink(h.scopeA, {
          linkType: 'DRIVES',
          sourceNodeId: n.id,
          targetNodeId: n.id,
          sourceSystem: 'helm',
        });
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.error.code, 'value.link_self_reference');
      } finally {
        await h.cleanup?.();
      }
    });

    test('removeValueLink closes validity instead of deleting', async () => {
      const h = await harness.create();
      try {
        const opp = await mkEntity(h.graphStore, h.scopeA, 'Opportunity', 'o1', 'Deal');
        const product = await mkEntity(h.graphStore, h.scopeA, 'Product', 'p1', 'SKU');
        const a = expectOk(
          await h.valueGraph.createValueNode(h.scopeA, {
            metricKey: 'ExpectedRevenue', subjectEntityId: opp, timeHorizon: 'quarter',
          }), 'a');
        const b = expectOk(
          await h.valueGraph.createValueNode(h.scopeA, {
            metricKey: 'DemandQuantity', subjectEntityId: product, timeHorizon: 'quarter',
          }), 'b');
        const link = expectOk(
          await h.valueGraph.createValueLink(h.scopeA, {
            linkType: 'DRIVES', sourceNodeId: a.id, targetNodeId: b.id, sourceSystem: 'helm',
          }), 'link');

        expectOk(await h.valueGraph.removeValueLink(h.scopeA, link.id), 'remove');

        const now = expectOk(
          await h.valueGraph.findValueLinks(h.scopeA, { eitherEndpoint: a.id }), 'current');
        assert.equal(now.length, 0, 'closed link is not current');

        const then = expectOk(
          await h.valueGraph.findValueLinks(h.scopeA, {
            eitherEndpoint: a.id, asOf: link.validFrom,
          }), 'historical');
        assert.equal(then.length, 1, 'still visible at its valid time');
      } finally {
        await h.cleanup?.();
      }
    });

    // ------------------------------------------------------ observations

    test('records observations of different types on one node without collapsing them', async () => {
      const h = await harness.create();
      try {
        const bu = await mkEntity(h.graphStore, h.scopeA, 'BusinessUnit', 'bu1', 'Pharma BU');
        const node = expectOk(
          await h.valueGraph.createValueNode(h.scopeA, {
            metricKey: 'GrossMarginPct', subjectEntityId: bu, timeHorizon: 'quarter',
          }), 'node');

        const base = {
          nodeId: node.id,
          unitType: 'percentage' as const,
          periodStart: P_START,
          periodEnd: P_END,
          sourceSystem: 'erp' as const,
        };
        expectOk(await h.valueGraph.recordObservation(h.scopeA, {
          ...base, observationType: 'ACTUAL', numericValue: 38 }), 'actual');
        expectOk(await h.valueGraph.recordObservation(h.scopeA, {
          ...base, observationType: 'FORECAST', numericValue: 35, sourceSystem: 'finance' }), 'forecast');
        expectOk(await h.valueGraph.recordObservation(h.scopeA, {
          ...base, observationType: 'TARGET', numericValue: 40, sourceSystem: 'manual' }), 'target');

        const all = expectOk(
          await h.valueGraph.getObservations(h.scopeA, { nodeId: node.id }), 'all');
        assert.equal(all.length, 3, 'three coexisting claims, none superseding another');

        const actual = expectOk(
          await h.valueGraph.getLatestObservation(h.scopeA, { nodeId: node.id, type: 'ACTUAL' }),
          'latest actual');
        assert.equal(actual!.numericValue, 38);
        const target = expectOk(
          await h.valueGraph.getLatestObservation(h.scopeA, { nodeId: node.id, type: 'TARGET' }),
          'latest target');
        assert.equal(target!.numericValue, 40, 'the target is a different fact from the actual');
      } finally {
        await h.cleanup?.();
      }
    });

    test('a SCENARIO observation must name its scenario, and others must not', async () => {
      const h = await harness.create();
      try {
        const bu = await mkEntity(h.graphStore, h.scopeA, 'BusinessUnit', 'bu1', 'Pharma BU');
        const scenario = await mkEntity(h.graphStore, h.scopeA, 'Scenario', 's1', 'Option A');
        const node = expectOk(
          await h.valueGraph.createValueNode(h.scopeA, {
            metricKey: 'GrossMarginPct', subjectEntityId: bu, timeHorizon: 'quarter',
          }), 'node');

        const missing = await h.valueGraph.recordObservation(h.scopeA, {
          nodeId: node.id, observationType: 'SCENARIO', numericValue: 34,
          unitType: 'percentage', periodStart: P_START, periodEnd: P_END, sourceSystem: 'helm',
        });
        assert.equal(missing.ok, false, 'a scenario value without a scenario is meaningless');
        if (!missing.ok) assert.equal(missing.error.code, 'value.missing_scenario_context');

        const leaked = await h.valueGraph.recordObservation(h.scopeA, {
          nodeId: node.id, observationType: 'ACTUAL', numericValue: 38,
          unitType: 'percentage', periodStart: P_START, periodEnd: P_END,
          sourceSystem: 'erp', scenarioEntityId: scenario,
        });
        assert.equal(leaked.ok, false, 'an actual must not carry a scenario');
        if (!leaked.ok) assert.equal(leaked.error.code, 'value.unexpected_scenario_context');

        const good = expectOk(await h.valueGraph.recordObservation(h.scopeA, {
          nodeId: node.id, observationType: 'SCENARIO', numericValue: 34,
          unitType: 'percentage', periodStart: P_START, periodEnd: P_END,
          sourceSystem: 'helm', scenarioEntityId: scenario,
        }), 'scenario obs');
        assert.equal(good.scenarioEntityId, scenario);

        // Reality and the scenario must be separable.
        const reality = expectOk(await h.valueGraph.getObservations(h.scopeA, {
          nodeId: node.id, scenarioEntityId: null }), 'reality');
        assert.equal(reality.length, 0, 'the scenario value is not part of reality');
      } finally {
        await h.cleanup?.();
      }
    });

    test('rejects a unit that contradicts the metric', async () => {
      const h = await harness.create();
      try {
        const bu = await mkEntity(h.graphStore, h.scopeA, 'BusinessUnit', 'bu1', 'Pharma BU');
        const node = expectOk(
          await h.valueGraph.createValueNode(h.scopeA, {
            metricKey: 'GrossMarginPct', subjectEntityId: bu, timeHorizon: 'quarter',
          }), 'node');

        const r = await h.valueGraph.recordObservation(h.scopeA, {
          nodeId: node.id, observationType: 'ACTUAL', numericValue: 38,
          unitType: 'currency', currency: 'VND',
          periodStart: P_START, periodEnd: P_END, sourceSystem: 'erp',
        });
        assert.equal(r.ok, false, 'a percentage metric may not take a currency');
        if (!r.ok) assert.equal(r.error.code, 'value.unit_mismatch');
      } finally {
        await h.cleanup?.();
      }
    });

    test('rejects a currency amount with no currency', async () => {
      const h = await harness.create();
      try {
        const opp = await mkEntity(h.graphStore, h.scopeA, 'Opportunity', 'o1', 'Deal');
        const node = expectOk(
          await h.valueGraph.createValueNode(h.scopeA, {
            metricKey: 'OpportunityValue', subjectEntityId: opp, timeHorizon: 'current',
          }), 'node');
        const r = await h.valueGraph.recordObservation(h.scopeA, {
          nodeId: node.id, observationType: 'ACTUAL', numericValue: 4.2e9,
          unitType: 'currency', effectiveAt: T0, sourceSystem: 'memoire',
        });
        assert.equal(r.ok, false, '4200000000 of what?');
        if (!r.ok) assert.equal(r.error.code, 'value.missing_currency');
      } finally {
        await h.cleanup?.();
      }
    });

    test('distinguishes a ratio from a percentage', async () => {
      const h = await harness.create();
      try {
        const opp = await mkEntity(h.graphStore, h.scopeA, 'Opportunity', 'o1', 'Deal');
        const node = expectOk(
          await h.valueGraph.createValueNode(h.scopeA, {
            metricKey: 'OpportunityProbability', subjectEntityId: opp, timeHorizon: 'current',
          }), 'node');

        // 70 is not a probability; 0.7 is.
        const wrong = await h.valueGraph.recordObservation(h.scopeA, {
          nodeId: node.id, observationType: 'ACTUAL', numericValue: 70,
          unitType: 'ratio', effectiveAt: T0, sourceSystem: 'memoire',
        });
        assert.equal(wrong.ok, false);
        if (!wrong.ok) assert.equal(wrong.error.code, 'value.out_of_range');

        expectOk(await h.valueGraph.recordObservation(h.scopeA, {
          nodeId: node.id, observationType: 'ACTUAL', numericValue: 0.7,
          unitType: 'ratio', effectiveAt: T0, sourceSystem: 'memoire',
        }), '0.7 is valid');
      } finally {
        await h.cleanup?.();
      }
    });

    test('requires the time context the metric implies', async () => {
      const h = await harness.create();
      try {
        const opp = await mkEntity(h.graphStore, h.scopeA, 'Opportunity', 'o1', 'Deal');
        const node = expectOk(
          await h.valueGraph.createValueNode(h.scopeA, {
            metricKey: 'ExpectedRevenue', subjectEntityId: opp, timeHorizon: 'quarter',
          }), 'node');

        // ExpectedRevenue is a PERIOD metric: a point in time is not enough.
        const r = await h.valueGraph.recordObservation(h.scopeA, {
          nodeId: node.id, observationType: 'FORECAST', numericValue: 2.94e9,
          unitType: 'currency', currency: 'VND', effectiveAt: T0, sourceSystem: 'memoire',
        });
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.error.code, 'value.missing_time_context');
      } finally {
        await h.cleanup?.();
      }
    });

    // --------------------------------------------------------- traversal

    test('traverses downstream through the value chain', async () => {
      const h = await harness.create();
      try {
        const opp = await mkEntity(h.graphStore, h.scopeA, 'Opportunity', 'o1', 'Deal');
        const product = await mkEntity(h.graphStore, h.scopeA, 'Product', 'p1', 'SKU');
        const wc = await mkEntity(h.graphStore, h.scopeA, 'WorkingCapital', 'wc1', 'WC');

        const rev = expectOk(await h.valueGraph.createValueNode(h.scopeA, {
          metricKey: 'ExpectedRevenue', subjectEntityId: opp, timeHorizon: 'quarter' }), 'rev');
        const demand = expectOk(await h.valueGraph.createValueNode(h.scopeA, {
          metricKey: 'DemandQuantity', subjectEntityId: product, timeHorizon: 'quarter' }), 'dem');
        const wcNode = expectOk(await h.valueGraph.createValueNode(h.scopeA, {
          metricKey: 'WorkingCapital', subjectEntityId: wc, timeHorizon: 'current' }), 'wc');

        expectOk(await h.valueGraph.createValueLink(h.scopeA, {
          linkType: 'DRIVES', sourceNodeId: rev.id, targetNodeId: demand.id,
          confidence: 0.7, sourceSystem: 'helm' }), 'l1');
        expectOk(await h.valueGraph.createValueLink(h.scopeA, {
          linkType: 'CONSUMES', sourceNodeId: demand.id, targetNodeId: wcNode.id,
          confidence: 0.9, sourceSystem: 'helm' }), 'l2');

        const down = expectOk(
          await h.valueGraph.findDownstreamValueNodes(h.scopeA, rev.id, 3), 'downstream');
        assert.equal(down.nodes.length, 3, 'revenue reaches working capital');

        const wcReached = down.nodes.find((n) => n.node.id === wcNode.id);
        assert.ok(wcReached, 'working capital reached');
        assert.equal(wcReached!.depth, 2);
        assert.equal(Math.round(wcReached!.pathConfidence * 1000) / 1000, 0.63,
          'chain confidence is the product of its links');

        const up = expectOk(
          await h.valueGraph.findUpstreamValueNodes(h.scopeA, wcNode.id, 3), 'upstream');
        assert.equal(up.nodes.length, 3, 'and the chain is walkable backwards');
      } finally {
        await h.cleanup?.();
      }
    });

    test('value traversal must be bounded', async () => {
      const h = await harness.create();
      try {
        const opp = await mkEntity(h.graphStore, h.scopeA, 'Opportunity', 'o1', 'Deal');
        const n = expectOk(await h.valueGraph.createValueNode(h.scopeA, {
          metricKey: 'ExpectedRevenue', subjectEntityId: opp, timeHorizon: 'quarter' }), 'n');
        const r = await h.valueGraph.getValueChain(h.scopeA, {
          start: [n.id], maxDepth: 99, direction: 'both' });
        assert.equal(r.ok, false, 'excessive depth must be refused, not clamped');
        if (!r.ok) assert.equal(r.error.code, 'value.depth_exceeded');
      } finally {
        await h.cleanup?.();
      }
    });

    test('traversal attaches observations but never combines them', async () => {
      const h = await harness.create();
      try {
        const opp = await mkEntity(h.graphStore, h.scopeA, 'Opportunity', 'o1', 'Deal');
        const product = await mkEntity(h.graphStore, h.scopeA, 'Product', 'p1', 'SKU');
        const rev = expectOk(await h.valueGraph.createValueNode(h.scopeA, {
          metricKey: 'ExpectedRevenue', subjectEntityId: opp, timeHorizon: 'quarter' }), 'rev');
        const demand = expectOk(await h.valueGraph.createValueNode(h.scopeA, {
          metricKey: 'DemandQuantity', subjectEntityId: product, timeHorizon: 'quarter' }), 'dem');
        expectOk(await h.valueGraph.createValueLink(h.scopeA, {
          linkType: 'DRIVES', sourceNodeId: rev.id, targetNodeId: demand.id,
          weight: 12, confidence: 0.7, sourceSystem: 'helm' }), 'link');

        expectOk(await h.valueGraph.recordObservation(h.scopeA, {
          nodeId: rev.id, observationType: 'FORECAST', numericValue: 2.94e9,
          unitType: 'currency', currency: 'VND',
          periodStart: P_START, periodEnd: P_END, sourceSystem: 'memoire' }), 'rev obs');

        const chain = expectOk(
          await h.valueGraph.findDownstreamValueNodes(h.scopeA, rev.id, 2), 'chain');
        const revNode = chain.nodes.find((n) => n.node.id === rev.id)!;
        const demNode = chain.nodes.find((n) => n.node.id === demand.id)!;

        assert.equal(revNode.observations.length, 1, 'upstream observation is attached');
        assert.equal(
          demNode.observations.length, 0,
          'downstream has NO value: Phase 2 represents, it does not propagate',
        );
      } finally {
        await h.cleanup?.();
      }
    });

    // ------------------------------------------------------- contention

    test('shared constrained resources are structurally queryable', async () => {
      const h = await harness.create();
      try {
        const oppA = await mkEntity(h.graphStore, h.scopeA, 'Opportunity', 'oa', 'Deal A');
        const oppB = await mkEntity(h.graphStore, h.scopeA, 'Opportunity', 'ob', 'Deal B');
        const inv = await mkEntity(h.graphStore, h.scopeA, 'Inventory', 'inv1', 'Stock X');

        const demandA = expectOk(await h.valueGraph.createValueNode(h.scopeA, {
          metricKey: 'DemandQuantity', subjectEntityId: oppA, timeHorizon: 'quarter' }), 'da');
        const demandB = expectOk(await h.valueGraph.createValueNode(h.scopeA, {
          metricKey: 'DemandQuantity', subjectEntityId: oppB, timeHorizon: 'quarter' }), 'db');
        const avail = expectOk(await h.valueGraph.createValueNode(h.scopeA, {
          metricKey: 'AvailableInventory', subjectEntityId: inv, timeHorizon: 'current' }), 'av');

        expectOk(await h.valueGraph.createValueLink(h.scopeA, {
          linkType: 'CONSUMES', sourceNodeId: demandA.id, targetNodeId: avail.id,
          weight: 4, sourceSystem: 'helm' }), 'ca');
        expectOk(await h.valueGraph.createValueLink(h.scopeA, {
          linkType: 'CONSUMES', sourceNodeId: demandB.id, targetNodeId: avail.id,
          weight: 4, sourceSystem: 'helm' }), 'cb');

        const contention = expectOk(await h.valueGraph.findContention(h.scopeA), 'contention');
        assert.equal(contention.length, 1, 'exactly one contended resource');
        assert.equal(contention[0].node.id, avail.id);
        assert.equal(contention[0].claimants.length, 2, 'two value streams want the same stock');
        assert.equal(contention[0].totalClaimedWeight, 8, 'claimed quantity is visible');
      } finally {
        await h.cleanup?.();
      }
    });

    // --------------------------------------------------- tenant isolation

    test('organization A cannot see organization B value nodes', async () => {
      const h = await harness.create();
      try {
        const bEntity = await mkEntity(h.graphStore, h.scopeB, 'Product', 'b-sku', 'B SKU');
        const bNode = expectOk(await h.valueGraph.createValueNode(h.scopeB, {
          metricKey: 'UnitCost', subjectEntityId: bEntity, timeHorizon: 'current' }), 'b node');

        const aEntity = await mkEntity(h.graphStore, h.scopeA, 'Product', 'a-sku', 'A SKU');
        expectOk(await h.valueGraph.createValueNode(h.scopeA, {
          metricKey: 'UnitCost', subjectEntityId: aEntity, timeHorizon: 'current' }), 'a node');

        const direct = expectOk(await h.valueGraph.getValueNode(h.scopeA, bNode.id), 'cross get');
        assert.equal(direct, null, 'org A must not read an org B value node');

        const listed = expectOk(await h.valueGraph.findValueNodes(h.scopeA, {}), 'list');
        assert.equal(listed.length, 1, 'only org A nodes');
        assert.ok(listed.every((n) => n.orgId === h.scopeA.orgId));
      } finally {
        await h.cleanup?.();
      }
    });

    test('a value link cannot span two organizations', async () => {
      const h = await harness.create();
      try {
        const aEntity = await mkEntity(h.graphStore, h.scopeA, 'Product', 'a-sku', 'A SKU');
        const bEntity = await mkEntity(h.graphStore, h.scopeB, 'Product', 'b-sku', 'B SKU');
        const aNode = expectOk(await h.valueGraph.createValueNode(h.scopeA, {
          metricKey: 'UnitCost', subjectEntityId: aEntity, timeHorizon: 'current' }), 'a');
        const bNode = expectOk(await h.valueGraph.createValueNode(h.scopeB, {
          metricKey: 'UnitCost', subjectEntityId: bEntity, timeHorizon: 'current' }), 'b');

        const r = await h.valueGraph.createValueLink(h.scopeA, {
          linkType: 'DRIVES', sourceNodeId: aNode.id, targetNodeId: bNode.id,
          sourceSystem: 'helm' });
        assert.equal(r.ok, false, 'cross-org value link must be refused');
      } finally {
        await h.cleanup?.();
      }
    });

    test('observations are organization-scoped', async () => {
      const h = await harness.create();
      try {
        const bEntity = await mkEntity(h.graphStore, h.scopeB, 'Product', 'b-sku', 'B SKU');
        const bNode = expectOk(await h.valueGraph.createValueNode(h.scopeB, {
          metricKey: 'UnitCost', subjectEntityId: bEntity, timeHorizon: 'current' }), 'b node');
        expectOk(await h.valueGraph.recordObservation(h.scopeB, {
          nodeId: bNode.id, observationType: 'ACTUAL', numericValue: 100,
          unitType: 'currency', currency: 'USD', effectiveAt: T0, sourceSystem: 'erp' }), 'b obs');

        const seen = await h.valueGraph.getObservations(h.scopeA, { nodeId: bNode.id });
        // Either a clean empty result or a not-found error is acceptable; a leak is not.
        if (seen.ok) {
          assert.equal(seen.value.length, 0, 'org A must not read org B observations');
        }
      } finally {
        await h.cleanup?.();
      }
    });

    test('a value node cannot attach to another organization entity', async () => {
      const h = await harness.create();
      try {
        const bEntity = await mkEntity(h.graphStore, h.scopeB, 'Product', 'b-sku', 'B SKU');
        const r = await h.valueGraph.createValueNode(h.scopeA, {
          metricKey: 'UnitCost', subjectEntityId: bEntity, timeHorizon: 'current' });
        assert.equal(r.ok, false, 'cannot hang a value node off a foreign entity');
        if (!r.ok) assert.equal(r.error.code, 'value.cross_org_reference');
      } finally {
        await h.cleanup?.();
      }
    });
  });
}
