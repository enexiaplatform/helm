/** The TwinStore conformance suite against InMemoryTwinStore. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asOrgId, asUserId, seqIdGen } from '@helm/shared';
import { createInMemoryTwinStore } from '../src/index.ts';
import { runTwinStoreConformanceSuite } from '../src/conformance.ts';

const clock = { now: () => new Date('2027-01-12T05:00:00.000Z') };
const mk = (org) => ({ orgId: asOrgId(org), actorId: asUserId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), role: 'admin', orgUnitIds: [], functions: [] });

runTwinStoreConformanceSuite(
  { describe, it, assert },
  {
    name: 'InMemoryTwinStore',
    async create() {
      return {
        store: createInMemoryTwinStore({ clock, idGen: seqIdGen('twc') }),
        scopeA: mk('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
        scopeB: mk('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
        anchorEntityId: 'e-conformance-vn',
        userId: asUserId('d6000000-0000-4000-8000-000000000005'),
        now: () => clock.now(),
      };
    },
  },
);
