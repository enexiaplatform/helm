/**
 * The IntegrationStore conformance suite against InMemoryIntegrationStore.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asOrgId, asUserId, seqIdGen } from '@helm/shared';
import { createInMemoryIntegrationStore } from '../src/inMemoryStore.ts';
import { runIntegrationStoreConformanceSuite } from '../src/conformance.ts';

const user = asUserId('u-1');
const scope = (org) => ({ orgId: asOrgId(org), actorId: user, role: 'admin', orgUnitIds: [], functions: [] });

runIntegrationStoreConformanceSuite(
  { describe, it, assert },
  {
    name: 'InMemoryIntegrationStore',
    async create() {
      return {
        store: createInMemoryIntegrationStore({ clock: { now: () => new Date() }, idGen: seqIdGen('is') }),
        scopeA: scope('org-a'),
        scopeB: scope('org-b'),
        commitmentId: 'commitment-a',
        decisionId: 'decision-a',
        actionIntentId: 'intent-a',
        userId: user,
      };
    },
  },
);
