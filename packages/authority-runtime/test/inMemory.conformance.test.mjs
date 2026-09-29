/**
 * The in-memory AuthorityStore against the shared conformance suite.
 * The Postgres adapter runs the SAME suite (postgres.conformance.test.mjs).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { asUserId, seqIdGen } from '@helm/shared';
import { createInMemoryAuthorityStore } from '../src/inMemoryStore.ts';
import { runAuthorityStoreConformanceSuite } from '../src/conformance.ts';
import { ORG_A, ORG_B, scopeFor, steppingClock } from './harness.mjs';

runAuthorityStoreConformanceSuite(
  { describe, it: test, assert },
  {
    name: 'InMemoryAuthorityStore',
    async create() {
      const clock = steppingClock();
      const idGen = seqIdGen('a');
      return {
        store: createInMemoryAuthorityStore({ clock, idGen }),
        scopeA: scopeFor(ORG_A),
        scopeB: scopeFor(ORG_B),
        fixtures: async () => ({
          roleId: 'role-a',
          roleLabel: 'Role A',
          otherRoleId: 'role-b',
          countryId: 'country-a',
          decisionId: 'decision-a',
          commitmentId: 'commitment-a',
          commitmentFingerprint: 'dfp_conformance_1',
          committer: asUserId('user-committer'),
          approver: asUserId('user-approver'),
        }),
        now: () => clock.peek(),
      };
    },
  },
);
