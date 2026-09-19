/**
 * The in-memory ValueGraph adapter against the shared conformance suite.
 * The Postgres adapter runs the SAME suite — ADR-0015.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedRegistry } from '@helm/ontology';
import { asOrgId, asUserId, seqIdGen } from '@helm/shared';
import { createInMemoryGraphStore } from '@helm/graph-store';
import { createInMemoryValueGraph } from '../src/inMemory.ts';
import { buildSeedValueRegistry } from '../src/registry.ts';
import { runValueConformanceSuite } from '../src/conformance.ts';

const mkScope = (org, user) => ({
  orgId: asOrgId(org),
  actorId: asUserId(user),
  role: 'admin',
  orgUnitIds: [],
  functions: [],
});

runValueConformanceSuite(
  { describe, it: test, assert },
  {
    name: 'InMemoryValueGraph',
    async create() {
      // Deterministic clock and ids so temporal assertions cannot flake.
      let tick = 0;
      const base = Date.parse('2026-09-19T08:00:00.000Z');
      const clock = { now: () => new Date(base + (tick += 1) * 1000) };
      const idGen = seqIdGen('v');
      const ontology = buildSeedRegistry();

      const graphStore = createInMemoryGraphStore({ registry: ontology, clock, idGen });
      const valueGraph = createInMemoryValueGraph({
        metrics: buildSeedValueRegistry(),
        ontology,
        graphStore,
        clock,
        idGen,
      });

      return {
        valueGraph,
        graphStore,
        scopeA: mkScope('11111111-1111-4111-8111-111111111111', 'aaaa1111-1111-4111-8111-111111111111'),
        scopeB: mkScope('22222222-2222-4222-8222-222222222222', 'bbbb2222-2222-4222-8222-222222222222'),
      };
    },
  },
);
