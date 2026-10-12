/**
 * A page of records is ingested side by side where the records touch nothing in common (audit 2026-10-12: one after
 * another, a first read of a hundred opportunities took minutes). Side by side must write exactly what one after
 * another writes: one customer per account, one membership per account, one value node per opportunity, the same
 * counts — and a second run still writes nothing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createIngestionPipeline } from '../src/index.ts';
import { buildIntegrationStack, row, unwrap } from './harness.mjs';

const ACCOUNTS = [
  { id: 'acc-a', name: 'Alpha Co', flag: true },
  { id: 'acc-b', name: 'Beta Co', flag: false },
  { id: 'acc-c', name: 'Gamma Co', flag: true },
  { id: 'acc-d', name: 'Delta Co', flag: null },
];

function page() {
  return Array.from({ length: 24 }, (_, i) => {
    const acc = ACCOUNTS[i % ACCOUNTS.length];
    return row({
      id: `opp-${String(i).padStart(2, '0')}`,
      opportunity_name: `Opportunity ${i}`,
      account_id: acc.id,
      account_name: acc.name,
      account_ka_flag: acc.flag,
      estimated_value: 1000 * (i + 1),
      pipeline_probability: (i % 9) * 10,
      updated_at: `2026-10-01T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
    });
  });
}

async function ingest(concurrency) {
  const s = await buildIntegrationStack();
  const pipeline = createIngestionPipeline({ graph: s.graph, valueGraph: s.valueGraph, store: s.integrationStore, clock: s.clock, concurrency });
  s.reader.rows.push(...page());
  const first = unwrap(await pipeline.run(s.scope, s.adapter), 'first run');
  const second = unwrap(await pipeline.run(s.scope, s.adapter), 'second run');
  const customers = unwrap(await s.graph.findEntities(s.scope, { entityTypeKeys: ['Customer'] }), 'customers');
  const segments = unwrap(await s.graph.findEntities(s.scope, { entityTypeKeys: ['Segment'] }), 'segments');
  const memberships = unwrap(await s.graph.findRelationships(s.scope, { relationshipTypeKeys: ['BELONGS_TO'] }), 'memberships');
  return { first, second, customers, segments, memberships };
}

describe('ingesting a page side by side writes what one record after another writes', () => {
  it('the same counts, one customer and one membership per account, and a second run writes nothing', async () => {
    const one = await ingest(1);
    const many = await ingest(8);
    assert.equal(many.first.outcome, 'SUCCEEDED');
    assert.deepEqual(many.first.quarantined, []);
    assert.deepEqual(many.first.counts, one.first.counts, 'side by side counts what sequential counts');
    const memoireCustomers = (r) => r.customers.filter((c) => String(c.canonicalKey).startsWith('memoire:account:'));
    assert.equal(memoireCustomers(many).length, ACCOUNTS.length, 'one customer per account, never two');
    const memoireSegments = (r) => r.segments.filter((x) => String(x.canonicalKey).startsWith('memoire:account_class:'));
    assert.equal(memoireSegments(many).length, 2, 'KEY_ACCOUNT and STANDARD_CUSTOMER, once each');
    const memoireMemberships = (r) => r.memberships.filter((m) => memoireCustomers(r).some((c) => c.id === m.sourceEntityId));
    assert.equal(memoireMemberships(many).length, 3, 'one membership per account that states a flag');
    assert.equal(memoireMemberships(many).length, memoireMemberships(one).length);
    assert.equal(many.second.counts.observationsRecorded + many.second.counts.entitiesCreated + many.second.counts.relationshipsCreated, 0, 'idempotent');
  });
});
