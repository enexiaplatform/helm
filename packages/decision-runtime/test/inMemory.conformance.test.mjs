/**
 * The in-memory DecisionStore against the shared conformance suite.
 * The Postgres adapter runs the SAME suite (postgres.conformance.test.mjs).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { seqIdGen } from '@helm/shared';
import { createInMemoryDecisionStore } from '../src/inMemoryStore.ts';
import { runDecisionStoreConformanceSuite } from '../src/conformance.ts';
import { ORG_A, ORG_B, scopeFor, steppingClock } from './harness.mjs';

runDecisionStoreConformanceSuite(
  { describe, it: test, assert },
  {
    name: 'InMemoryDecisionStore',
    async create() {
      const clock = steppingClock();
      const idGen = seqIdGen('k');
      return {
        store: createInMemoryDecisionStore({ clock, idGen }),
        scopeA: scopeFor(ORG_A),
        scopeB: scopeFor(ORG_B),
        scenarioRun: async () => ({
          scenarioId: `scenario-${idGen.next()}`,
          scenarioRevisionId: `revision-${idGen.next()}`,
          scenarioRunId: `run-${idGen.next()}`,
        }),
        now: () => clock.peek(),
      };
    },
  },
);
