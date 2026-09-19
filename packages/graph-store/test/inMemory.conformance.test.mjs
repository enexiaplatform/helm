/**
 * The in-memory adapter against the shared conformance suite.
 *
 * The Postgres adapter runs the SAME suite (see postgres.conformance.test.mjs),
 * which is what makes the abstraction real rather than asserted — ADR-0004.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedRegistry } from '@helm/ontology';
import { fixedClock, seqIdGen } from '@helm/shared';
import { createInMemoryGraphStore } from '../src/inMemory.ts';
import { runConformanceSuite } from '../src/conformance.ts';

runConformanceSuite(
  { describe, it: test, assert },
  {
    name: 'InMemoryGraphStore',
    async create() {
      // Deterministic clock and ids: identical fixtures, identical results,
      // every run. Real time would make the temporal assertions flaky.
      let tick = 0;
      const base = Date.parse('2026-09-19T08:00:00.000Z');
      const clock = {
        now: () => {
          // Advance one second per read so record-time windows are orderable.
          tick += 1;
          return new Date(base + tick * 1000);
        },
      };
      void fixedClock;
      return {
        store: createInMemoryGraphStore({
          registry: buildSeedRegistry(),
          clock,
          idGen: seqIdGen('mem'),
        }),
      };
    },
  },
);
