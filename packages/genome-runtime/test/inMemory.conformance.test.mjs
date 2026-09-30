/**
 * The GenomeStore conformance suite against InMemoryGenomeStore.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asOrgId, asUserId, seqIdGen } from '@helm/shared';
import { createInMemoryGenomeStore } from '../src/inMemoryStore.ts';
import { runGenomeStoreConformanceSuite } from '../src/conformance.ts';

const user = asUserId('u-1');
const scope = (org) => ({ orgId: asOrgId(org), actorId: user, role: 'admin', orgUnitIds: [], functions: [] });

runGenomeStoreConformanceSuite(
  { describe, it, assert },
  {
    name: 'InMemoryGenomeStore',
    async create() {
      return {
        store: createInMemoryGenomeStore({ clock: { now: () => new Date() }, idGen: seqIdGen('gs') }),
        scopeA: scope('org-a'),
        scopeB: scope('org-b'),
        decisionId: 'decision-a',
        userId: user,
        now: () => new Date(),
      };
    },
  },
);
