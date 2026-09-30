/**
 * The ReviewStore conformance suite against InMemoryReviewStore.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asOrgId, asUserId, seqIdGen } from '@helm/shared';
import { createInMemoryReviewStore } from '../src/inMemoryStore.ts';
import { runReviewStoreConformanceSuite } from '../src/conformance.ts';

const user = asUserId('u-1');
const scope = (org) => ({ orgId: asOrgId(org), actorId: user, role: 'admin', orgUnitIds: [], functions: [] });

runReviewStoreConformanceSuite(
  { describe, it, assert },
  {
    name: 'InMemoryReviewStore',
    async create() {
      return {
        store: createInMemoryReviewStore({ clock: { now: () => new Date() }, idGen: seqIdGen('rs') }),
        scopeA: scope('org-a'),
        scopeB: scope('org-b'),
        snapshotId: 'snapshot-a',
        userId: user,
        now: () => new Date(),
      };
    },
  },
);
