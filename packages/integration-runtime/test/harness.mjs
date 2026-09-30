/**
 * Test harness: the full Phase 1–7 stack with the canonical twin story (so there
 * is a real committed, approved Rohto decision with action intents), plus the
 * integration runtime over it.
 *
 * Not a test file itself (no `.test.` in the name).
 */

import { seqIdGen } from '@helm/shared';
import {
  createFixtureMemoireReader,
  createIngestionPipeline,
  createInMemoryIntegrationStore,
  createMemoireAdapter,
  createMemoireWritebackAdapter,
  createWritebackGateway,
} from '../src/index.ts';
import { ADMIN, MEMBERSHIP, UNITS, USERS, buildStory, expectFail, unwrap } from '../../twin-runtime/test/harness.mjs';

export { ADMIN, MEMBERSHIP, UNITS, USERS, expectFail, unwrap };

/** A Memoire `opportunities` row, filling in what a test does not care about. */
export const row = (over) => ({
  id: 'opp-x',
  account_id: 'acc-x',
  account_name: 'Account X',
  opportunity_name: 'Opportunity X',
  title: null,
  stage: 'Proposal',
  estimated_value: 1000000,
  currency: 'VND',
  pipeline_probability: 50,
  status: 'open',
  expected_close_period: '2026-Q4',
  updated_at: '2026-10-01T02:00:00.000Z',
  ...over,
});

export async function buildIntegrationStack() {
  const s = await buildStory();
  const store = createInMemoryIntegrationStore({ clock: s.clock, idGen: seqIdGen('ig') });
  const reader = createFixtureMemoireReader([]);
  const adapter = createMemoireAdapter(reader);
  const pipeline = createIngestionPipeline({ graph: s.graph, valueGraph: s.valueGraph, store, clock: s.clock });
  const gateway = createWritebackGateway({ decisions: s.decisionStore, authority: s.authority, store, adapters: [createMemoireWritebackAdapter()] });
  return { ...s, integrationStore: store, reader, adapter, pipeline, gateway };
}
