/**
 * The in-memory CalculationStore against the shared conformance suite.
 * The Postgres adapter runs the SAME suite — ADR-0015.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedRegistry } from '@helm/ontology';
import { asOrgId, asUserId, seqIdGen } from '@helm/shared';
import { createInMemoryGraphStore, buildCanonicalScenario } from '@helm/graph-store';
import {
  createInMemoryValueGraph,
  buildSeedValueRegistry,
  buildCanonicalValueChain,
} from '@helm/value-graph';
import { createCalculationRegistry } from '../src/registry.ts';
import { createInMemoryCalculationStore } from '../src/inMemoryStore.ts';
import { createPropagationEngine } from '../src/engine.ts';
import { meridianValueModelV1 } from '../src/meridianValueModelV1.ts';
import { runCalculationConformanceSuite } from '../src/conformance.ts';

const mkScope = (org, user) => ({
  orgId: asOrgId(org),
  actorId: asUserId(user),
  role: 'admin',
  orgUnitIds: [],
  functions: [],
});

const unwrap = (r, what) => {
  assert.equal(r.ok, true, `${what}: ${r.ok ? '' : r.error.code + ' — ' + r.error.message}`);
  return r.value;
};

runCalculationConformanceSuite(
  { describe, it: test, assert },
  {
    name: 'InMemoryCalculationStore',
    async create() {
      // Deterministic clock and ids so replay equality is meaningful.
      let tick = 0;
      const base = Date.parse('2026-09-19T08:00:00.000Z');
      const clock = { now: () => new Date(base + (tick += 1) * 1000) };
      const idGen = seqIdGen('k');
      const ontology = buildSeedRegistry();

      const scopeA = mkScope(
        '11111111-1111-4111-8111-111111111111',
        'aaaa1111-1111-4111-8111-111111111111',
      );
      const scopeB = mkScope(
        '22222222-2222-4222-8222-222222222222',
        'bbbb2222-2222-4222-8222-222222222222',
      );

      const graphStore = createInMemoryGraphStore({ registry: ontology, clock, idGen });
      unwrap(await buildCanonicalScenario(graphStore, scopeA), 'entity graph');
      const valueGraph = createInMemoryValueGraph({
        metrics: buildSeedValueRegistry(),
        ontology,
        graphStore,
        clock,
        idGen,
      });
      const chain = unwrap(
        await buildCanonicalValueChain(valueGraph, graphStore, scopeA),
        'value chain',
      );

      const registry = unwrap(
        createCalculationRegistry(meridianValueModelV1, buildSeedValueRegistry()),
        'calculation registry',
      );
      const store = createInMemoryCalculationStore({ clock, idGen });
      const engine = unwrap(
        createPropagationEngine({ registry, valueGraph, graphStore, ontology, store, clock }),
        'engine',
      );

      return {
        engine,
        store,
        valueGraph,
        graphStore,
        scopeA,
        scopeB,
        nodeIds: chain.nodeIds,
        asOf: new Date('2026-09-19T12:00:00.000Z'),
      };
    },
  },
);
