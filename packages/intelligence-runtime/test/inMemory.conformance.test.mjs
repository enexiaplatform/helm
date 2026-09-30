/**
 * The AiRunStore conformance suite against InMemoryAiRunStore.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asOrgId, asUserId, seqIdGen } from '@helm/shared';
import { createInMemoryAiRunStore } from '../src/inMemoryStore.ts';
import { runAiRunStoreConformanceSuite } from '../src/conformance.ts';

const user = asUserId('u-1');
const scope = (org) => ({ orgId: asOrgId(org), actorId: user, role: 'admin', orgUnitIds: [], functions: [] });

runAiRunStoreConformanceSuite(
  { describe, it, assert },
  {
    name: 'InMemoryAiRunStore',
    async create() {
      return { store: createInMemoryAiRunStore({ clock: { now: () => new Date() }, idGen: seqIdGen('ar') }), scopeA: scope('org-a'), scopeB: scope('org-b'), userId: user };
    },
  },
);
