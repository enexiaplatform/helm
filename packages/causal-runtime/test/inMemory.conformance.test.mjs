/**
 * The CausalStore conformance suite against InMemoryCausalStore.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asOrgId, asUserId, seqIdGen } from '@helm/shared';
import { createInMemoryCausalStore } from '../src/inMemoryStore.ts';
import { runCausalStoreConformanceSuite } from '../src/conformance.ts';

const scope = (org) => ({ orgId: asOrgId(org), actorId: asUserId('u-1'), role: 'admin', orgUnitIds: [], functions: [] });

runCausalStoreConformanceSuite(
  { describe, it, assert },
  {
    name: 'InMemoryCausalStore',
    async create() {
      const clock = { now: () => new Date() };
      return {
        store: createInMemoryCausalStore({ clock, idGen: seqIdGen('cs') }),
        scopeA: scope('org-a'),
        scopeB: scope('org-b'),
        anchorEntityId: 'entity-a',
        now: () => new Date(),
      };
    },
  },
);
