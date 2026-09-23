/**
 * The in-memory ScenarioStore against the shared conformance suite.
 * The Postgres adapter runs the SAME suite (postgres.conformance.test.mjs).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { asEntityId, seqIdGen } from '@helm/shared';
import { createInMemoryScenarioStore } from '../src/inMemoryStore.ts';
import { runScenarioStoreConformanceSuite } from '../src/conformance.ts';
import { ORG_A, ORG_B, scopeFor, steppingClock } from './harness.mjs';

runScenarioStoreConformanceSuite(
  { describe, it: test, assert },
  {
    name: 'InMemoryScenarioStore',
    async create() {
      const clock = steppingClock();
      const idGen = seqIdGen('c');
      return {
        store: createInMemoryScenarioStore({ clock, idGen }),
        scopeA: scopeFor(ORG_A),
        scopeB: scopeFor(ORG_B),
        scenarioEntity: async (key) => asEntityId(`entity-${key}`),
        targetNodeId: 'node-available-inventory',
        targetMetricKey: 'AvailableInventory',
        calculationRun: async () => `calc-${idGen.next()}`,
        now: () => clock.peek(),
      };
    },
  },
);
