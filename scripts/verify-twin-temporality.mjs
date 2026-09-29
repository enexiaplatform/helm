/**
 * verify:twin-temporality — the two-time model, held through the twin.
 *
 *   1. Replay: every canonical snapshot recomposes byte-identically after
 *      everything recorded later (DOA v2, a reclassification, a new Commercial
 *      Director, a restatement, the Q4 actuals and re-run).
 *   2. Historical knowledge: "23 Sep as management knew it" differs from "23
 *      Sep as HELM knows it now" only in KNOWLEDGE — never in value, decision
 *      or governance changes — and an approval of 24 Sep is not part of 23 Sep.
 *   3. Current state is versioned: each CURRENT snapshot follows the previous
 *      one of its scope, which stays exactly as it was.
 *   4. A snapshot cannot know the future, and a scope that did not exist at
 *      the lens is INVALID rather than empty.
 *   5. An entity updated later is read as it was believed at the lens.
 */

import { buildStory, contract, item, itemsOf, unwrap, valueKey } from './lib/twinStack.mjs';

const { check, finish } = contract('verify:twin-temporality');
const s = await buildStory();
const { story } = s;

// 1
let replayed = 0;
for (const key of ['S0', 'S1a', 'S1', 'CF1', 'H23', 'S2', 'pharmaS2', 'industrialS2', 'H23now']) {
  const r = unwrap(await s.twin.replaySnapshot(s.scope, story[key].snapshot.id), `replay ${key}`);
  check('replay', r.identical, `${key} does not replay identically: ${r.differences.map((d) => d.itemKey).slice(0, 5).join(', ')}`);
  if (r.identical) replayed += 1;
}

// 2
check('historical', itemsOf(story.H23, 'GOVERNANCE')[0]?.state.state === 'PENDING_APPROVAL', '23 Sep shows an approval given on 24 Sep');
check('historical', itemsOf(story.H23now, 'GOVERNANCE')[0]?.state.state === 'PENDING_APPROVAL', 'a later knowledge boundary pulled a later act into 23 Sep');
check('historical', item(story.H23, valueKey(s.nodeIds.capUtil, 'ACTUAL'))?.state.value === '78', '23 Sep does not read the capacity figure known then');
const k = unwrap(await s.twin.compareSnapshots(s.scope, story.H23.snapshot.id, story.H23now.snapshot.id), 'H23→H23now');
check('historical', k.valueChanges.length === 0 && k.decisionChanges.length === 0 && k.governanceChanges.length === 0,
  `the same business instant changed in value (${k.valueChanges.length}), decisions (${k.decisionChanges.length}) or governance (${k.governanceChanges.length})`);
check('historical', k.knowledgeChanges.some((c) => c.after?.state.nodeId === s.nodeIds.capUtil && c.delta === '3'), 'the restatement 78 → 81 is not a knowledge change');

// 3
check('current', story.S1.snapshot.previousSnapshotId === story.S1a.snapshot.id && story.S2.snapshot.previousSnapshotId === story.S1.snapshot.id, 'the CURRENT chain is broken');
const again = unwrap(await s.twin.getSnapshot(s.scope, story.S0.snapshot.id), 'S0');
check('current', again.snapshot.fingerprint === story.S0.snapshot.fingerprint && again.items.length === story.S0.items.length, 'a later CURRENT snapshot altered an earlier one');
const latest = unwrap(await s.twin.currentState(s.scope, story.scopes.vietnam), 'current state');
check('current', latest?.snapshot.id === story.S2.snapshot.id, 'current state is not the latest CURRENT snapshot');

// 4
const future = await s.twin.buildSnapshot(s.scope, { kind: 'HISTORICAL', label: 'x', scope: story.scopes.vietnam, lens: { effectiveAsOf: '2031-01-01T00:00:00.000Z', recordedThrough: '2031-01-01T00:00:00.000Z' } });
check('future', !future.ok, 'a snapshot was built from knowledge not yet recorded');
const early = unwrap(
  await s.twin.buildSnapshot(s.scope, {
    kind: 'HISTORICAL',
    label: 'before Thailand',
    scope: { kind: 'ENTITY', entityId: s.governance.entities.th.entityId, entityTypeKey: 'Country', label: 'Thailand' },
    lens: { effectiveAsOf: '2026-09-19T12:00:00.000Z', recordedThrough: '2026-09-19T07:00:00.000Z' },
    periods: ['2026-Q4'],
  }),
  'early',
);
check('scope', early.snapshot.completeness === 'INVALID' && early.items.length === 0, 'a scope that did not exist yet produced a snapshot');

// 5
const rohto = s.governance.entities.rohto.entityId;
unwrap(await s.graph.updateEntity(s.scope, rohto, { name: 'Rohto (renamed later)' }), 'rename');
const r = unwrap(await s.twin.replaySnapshot(s.scope, story.S1.snapshot.id), 'replay after rename');
check('structure', r.identical, 'a later rename reached back into S1');

finish(`${replayed} snapshots replay byte-identically; 23 Sep known later differs only in knowledge; current state versioned`);
