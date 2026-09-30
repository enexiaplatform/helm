/**
 * The CounterfactualStore conformance suite against InMemoryCounterfactualStore.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asOrgId, asUserId, seqIdGen } from '@helm/shared';
import { createInMemoryCounterfactualStore } from '../src/inMemoryStore.ts';
import { runCounterfactualStoreConformanceSuite } from '../src/conformance.ts';

const user = asUserId('u-1');
const scope = (org) => ({ orgId: asOrgId(org), actorId: user, role: 'admin', orgUnitIds: [], functions: [] });

runCounterfactualStoreConformanceSuite(
  { describe, it, assert },
  {
    name: 'InMemoryCounterfactualStore',
    async create() {
      return {
        store: createInMemoryCounterfactualStore({ clock: { now: () => new Date() }, idGen: seqIdGen('cs') }),
        scopeA: scope('org-a'),
        scopeB: scope('org-b'),
        decisionId: 'decision-a',
        commitmentId: 'commitment-a',
        snapshotId: 'snapshot-a',
        scenario: { scenarioId: 'scenario-a', revisionId: 'revision-a', runId: 'run-a' },
        boundaryIso: new Date(Date.now() - 24 * 3_600_000).toISOString(),
        userId: user,
        now: () => new Date(),
      };
    },
  },
);
