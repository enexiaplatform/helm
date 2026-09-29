/**
 * verify:twin-snapshot — the canonical snapshots S0, S1a, S1, CF1 and S2.
 *
 *   1. S0 holds the Rohto opportunity, the breached inventory constraint, the
 *      current margin, cash and stock, an open decision and the authority
 *      context (policy in force, who holds which role).
 *   2. S1 is management state, not physical state: committed, approved, a
 *      committed future and action intents exist — and the stock and model
 *      readings are exactly those of S0.
 *   3. CF1 reads the frozen run the commitment names, every value in the
 *      COMMITTED_FUTURE layer; nothing is re-run.
 *   4. Every snapshot's fingerprint is reproduced from its own manifest, every
 *      item names a kernel object, and a snapshot that is not COMPLETE says why.
 *   5. The management state is queryable by all eleven categories.
 *   6. Layers never merge: an actual, a model value and a committed future of
 *      the same position are three items.
 */

import { managementCategories, snapshotFingerprint } from '@helm/twin-runtime';
import { buildStory, contract, item, itemsOf, unwrap, valueKey } from './lib/twinStack.mjs';

const { check, finish } = contract('verify:twin-snapshot');
const s = await buildStory();
const { S0, S1a, S1, CF1, S2 } = s.story;

// 1
check('S0', S0.snapshot.spec.kind === 'CURRENT', 'S0 is not a CURRENT snapshot');
check('S0', itemsOf(S0, 'ENTITY').some((e) => e.state.entityTypeKey === 'Opportunity' && /Rohto/.test(e.label)), 'S0 does not hold the Rohto opportunity');
check('S0', item(S0, 'constraint:rohto-order-fulfilment:2026-Q4')?.state.status === 'BREACHED', 'S0 does not hold the breached inventory constraint');
check('S0', item(S0, valueKey(s.nodeIds.grossMarginPctOpp, 'MODELLED'))?.state.value === '33.2381', 'S0 does not hold the current modelled margin');
check('S0', item(S0, valueKey(s.nodeIds.cashOpp, 'MODELLED'))?.state.value === '-1710500000', 'S0 does not hold the current modelled cash');
check('S0', item(S0, valueKey(s.nodeIds.availOwn, 'ACTUAL', null))?.state.value === '4', 'S0 does not hold the stock SCM reported');
check('S0', itemsOf(S0, 'DECISION')[0]?.state.state === 'READY_FOR_DECISION' && itemsOf(S0, 'COMMITMENT').length === 0, 'S0 does not hold an open, uncommitted decision');
check('S0', itemsOf(S0, 'POLICY').some((p) => p.state.reference === 'DOA-2026-04') && itemsOf(S0, 'ROLE_OCCUPANCY').length > 0, 'S0 lacks the authority context');

// 2
check('S1', itemsOf(S1, 'DECISION')[0]?.state.state === 'COMMITTED', 'S1 is not committed');
check('S1', itemsOf(S1, 'GOVERNANCE')[0]?.state.state === 'APPROVED', 'S1 is not approved');
check('S1', itemsOf(S1, 'VALUE').filter((v) => v.layer === 'COMMITTED_FUTURE').length === 3, 'S1 does not hold the committed future\'s three expected outcomes');
check('S1', itemsOf(S1, 'ACTION_INTENT').length === 3 && itemsOf(S1, 'ACTION_INTENT').every((i) => i.state.status === 'INTENDED'), 'S1 does not hold three intended action intents');
for (const key of [valueKey(s.nodeIds.availOwn, 'ACTUAL', null), valueKey(s.nodeIds.grossMarginPctOpp, 'MODELLED'), 'constraint:rohto-order-fulfilment:2026-Q4']) {
  check('S1', JSON.stringify(item(S1, key)?.state) === JSON.stringify(item(S0, key)?.state), `${key} moved when management committed — commitment was treated as reality`);
}
check('S1a', itemsOf(S1a, 'GOVERNANCE')[0]?.state.state === 'PENDING_APPROVAL', 'S1a is not awaiting approval');

// 3
const commitmentRun = itemsOf(CF1, 'COMMITMENT')[0]?.refs.find((r) => r.kind === 'SCENARIO_RUN');
const cfValues = itemsOf(CF1, 'VALUE');
check('CF1', CF1.snapshot.spec.kind === 'COMMITTED_FUTURE' && Boolean(commitmentRun), 'CF1 names no committed run');
check('CF1', cfValues.length > 10 && cfValues.every((v) => v.layer === 'COMMITTED_FUTURE'), 'a committed-future value is shown in another layer');
check('CF1', cfValues.every((v) => v.refs.some((r) => r.kind === 'SCENARIO_RUN' && r.id === commitmentRun?.id)), 'a committed-future value is not read from the frozen run');
check('CF1', cfValues.find((v) => v.state.nodeId === s.nodeIds.grossMarginPctOpp)?.state.value === '32.3878', 'CF1 margin is not the committed 32.3878');
check('CF1', CF1.snapshot.sourceReferences.some((r) => r.kind === 'COMMITMENT_SNAPSHOT'), 'CF1 does not reference the frozen commitment snapshot');

// 4
for (const [name, snap] of Object.entries({ S0, S1a, S1, CF1, S2 })) {
  const again = snapshotFingerprint(snap.snapshot.spec, snap.snapshot.model, snap.items);
  check('fingerprint', again === snap.snapshot.fingerprint, `${name}: the fingerprint does not reproduce from the manifest`);
  check('lineage', snap.items.every((i) => i.refs.length > 0), `${name}: an item names no kernel object`);
  check('completeness', snap.snapshot.completeness === 'COMPLETE' || snap.snapshot.completenessReasons.length > 0, `${name} is ${snap.snapshot.completeness} and does not say why`);
  check('completeness', !snap.items.some((i) => i.kind === 'VALUE' && i.status !== 'KNOWN' && i.state.value === '0'), `${name}: a gap was filled with zero`);
}

// 5
const state = unwrap(await s.twin.getManagementState(s.scope, S2.snapshot.id), 'management state');
check('categories', managementCategories.every((c) => Array.isArray(state.categories[c])), 'the management state is not queryable by every category');
for (const c of ['STRUCTURE', 'VALUE', 'PERFORMANCE', 'CONSTRAINTS', 'RISKS', 'OBJECTIVES', 'DECISIONS', 'COMMITMENTS', 'GOVERNANCE', 'ASSUMPTIONS', 'ATTENTION']) {
  check('categories', state.categories[c].length > 0, `S2 holds nothing in ${c}`);
}

// 6
const layers = new Set(S2.items.filter((i) => i.kind === 'VALUE' && i.state.nodeId === s.nodeIds.grossMarginPctOpp).map((i) => i.layer));
check('layers', layers.has('ACTUAL') && layers.has('MODELLED') && layers.has('COMMITTED_FUTURE'), `S2 merged the margin's layers: ${[...layers].join(', ')}`);

finish('S0 before, S1 intent not reality, CF1 from the frozen run, fingerprints reproduce, eleven categories, layers apart');
