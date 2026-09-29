/**
 * The two-time model, held: replay, knowledge boundaries, the CURRENT chain,
 * and write-once snapshots.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { composeSnapshot, snapshotFingerprint } from '../src/index.ts';
import { buildStory, item, itemsOf, unwrap, valueKey } from './harness.mjs';

let s;
before(async () => {
  s = await buildStory();
});

describe('historical replay', () => {
  it('every snapshot of the story recomposes byte-identically after everything that happened later', async () => {
    for (const key of ['S0', 'S1a', 'S1', 'CF1', 'H23', 'S2', 'pharmaS2', 'industrialS2', 'H23now']) {
      const r = unwrap(await s.twin.replaySnapshot(s.scope, s.story[key].snapshot.id), `replay ${key}`);
      assert.equal(r.identical, true, `${key}: ${r.differences.map((d) => d.itemKey).join(', ')}`);
      assert.equal(r.replayedFingerprint, s.story[key].snapshot.fingerprint);
    }
  });

  it('"as management knew the enterprise on 23 Sep" stays exactly that, while the same instant known later differs only in knowledge', async () => {
    const { H23, H23now } = s.story;
    // On 23 Sep at 14:00 the approval had not happened, and HELM had not heard of Q4.
    assert.equal(itemsOf(H23, 'GOVERNANCE')[0].state.state, 'PENDING_APPROVAL');
    assert.equal(item(H23, valueKey(s.nodeIds.capUtil, 'ACTUAL')).state.value, '78');
    assert.equal(item(H23, valueKey(s.nodeIds.grossMarginPctOpp, 'ACTUAL')), null);
    // The same business instant under a later knowledge boundary.
    assert.equal(itemsOf(H23now, 'GOVERNANCE')[0].state.state, 'PENDING_APPROVAL', 'an approval of 24 Sep is not part of 23 Sep, however late the boundary');
    const d = unwrap(await s.twin.compareSnapshots(s.scope, H23.snapshot.id, H23now.snapshot.id), 'H23→H23now');
    assert.equal(d.valueChanges.length, 0, 'the world at 23 Sep did not move');
    assert.equal(d.decisionChanges.length, 0);
    assert.equal(d.governanceChanges.length, 0);
    const restated = d.knowledgeChanges.find((c) => c.after?.state.nodeId === s.nodeIds.capUtil);
    assert.equal(restated.delta, '3', 'SCM\'s restatement: 78 → 81');
    assert.ok(d.knowledgeChanges.some((c) => c.change === 'ADDED' && c.after.state.nodeId === s.nodeIds.grossMarginPctOpp && c.after.layer === 'ACTUAL'));
    const cd = d.structuralChanges.find((c) => c.kind === 'ROLE_OCCUPANCY');
    assert.ok(cd.fields.some((f) => f.field === 'validTo' && f.before === null), 'the end of a role, learned later, is knowledge — the role existed on 23 Sep');
  });

  it('a snapshot of a lens reads the entity as it was believed then, even after the entity is updated', async () => {
    const rohto = s.governance.entities.rohto.entityId;
    unwrap(await s.graph.updateEntity(s.scope, rohto, { name: 'Rohto Pharmaceutical Vietnam' }), 'rename');
    const r = unwrap(await s.twin.replaySnapshot(s.scope, s.story.S1.snapshot.id), 'replay after rename');
    assert.equal(r.identical, true, 'the rename, recorded later, does not reach back into S1');
    const now = unwrap(await s.twin.buildSnapshot(s.as(s.story.S2.snapshot.builtBy), { kind: 'CURRENT', label: 'after rename', scope: s.story.scopes.vietnam, periods: ['2026-Q4'] }), 'current');
    assert.equal(item(now, `entity:${rohto}`).label, 'Rohto Pharmaceutical Vietnam');
    const d = unwrap(await s.twin.compareSnapshots(s.scope, s.story.S2.snapshot.id, now.snapshot.id), 'S2→now');
    assert.ok(d.structuralChanges.some((c) => c.itemKey === `entity:${rohto}` && c.fields.some((f) => f.field === 'name')));
  });
});

describe('current state is versioned, never mutated', () => {
  it('each CURRENT snapshot follows the previous one of its scope, which stays exactly as it was', async () => {
    const { S0, S1a, S1, S2 } = s.story;
    assert.equal(S0.snapshot.previousSnapshotId, null);
    assert.equal(S1a.snapshot.previousSnapshotId, S0.snapshot.id);
    assert.equal(S1.snapshot.previousSnapshotId, S1a.snapshot.id);
    assert.equal(S2.snapshot.previousSnapshotId, S1.snapshot.id);
    const stored = unwrap(await s.twin.getSnapshot(s.scope, S0.snapshot.id), 'S0 reloaded');
    assert.equal(stored.snapshot.fingerprint, S0.snapshot.fingerprint);
    assert.equal(stored.items.length, S0.items.length);
    const latest = unwrap(await s.twin.currentState(s.scope, s.story.scopes.vietnam), 'current state');
    assert.notEqual(latest.snapshot.id, S0.snapshot.id, 'current state is the latest CURRENT snapshot');
  });

  it('a stored snapshot cannot be altered in place', async () => {
    const stored = unwrap(await s.twin.getSnapshot(s.scope, s.story.S1.snapshot.id), 'S1');
    assert.throws(() => {
      stored.items[0].label = 'rewritten';
    }, TypeError);
    assert.throws(() => {
      stored.snapshot.completeness = 'COMPLETE';
    }, TypeError);
  });

  it('the store refuses a manifest whose fingerprint it does not produce', async () => {
    const { S1 } = s.story;
    const tampered = S1.items.map((i) => (i.kind === 'VALUE' && i.layer === 'COMMITTED_FUTURE' && i.state.metricKey === 'GrossMarginPct' ? { ...i, state: { ...i.state, value: '40' } } : i));
    const header = { ...S1.snapshot, previousSnapshotId: null };
    delete header.id;
    delete header.orgId;
    const refused = await s.twinStore.saveSnapshot(s.scope, header, tampered);
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'twin.fingerprint_mismatch');
  });

  it('equivalent state under the same context fingerprints identically, and a different lens does not', async () => {
    const spec = s.story.H23.snapshot.spec;
    const a = unwrap(await composeSnapshot(s.sources, s.scope, spec), 'compose');
    const b = unwrap(await composeSnapshot(s.sources, s.scope, spec), 'compose again');
    assert.equal(snapshotFingerprint(spec, a.model, a.items), snapshotFingerprint(spec, b.model, b.items));
    assert.equal(snapshotFingerprint(spec, a.model, a.items), s.story.H23.snapshot.fingerprint);
    const shifted = { ...spec, lens: { ...spec.lens, recordedThrough: '2026-09-23T07:00:01.000Z' } };
    const c = unwrap(await composeSnapshot(s.sources, s.scope, shifted), 'shifted');
    assert.notEqual(snapshotFingerprint(shifted, c.model, c.items), s.story.H23.snapshot.fingerprint, 'the lens is part of identity');
    const relabelled = { ...spec, label: 'another name for the same state' };
    assert.equal(snapshotFingerprint(relabelled, a.model, a.items), s.story.H23.snapshot.fingerprint, 'a label is not state');
  });

  it('refuses a knowledge boundary in the future, and a HISTORICAL snapshot of now', async () => {
    const future = await s.twin.buildSnapshot(s.scope, { kind: 'HISTORICAL', label: 'x', scope: s.story.scopes.vietnam, lens: { effectiveAsOf: '2030-01-01T00:00:00.000Z', recordedThrough: '2030-01-01T00:00:00.000Z' } });
    assert.equal(future.ok, false);
    assert.match(future.error.message, /not been recorded yet/);
    const missing = await s.twin.buildSnapshot(s.scope, { kind: 'EXPECTED', label: 'x', scope: s.story.scopes.vietnam });
    assert.equal(missing.ok, false, 'every non-CURRENT snapshot states its lens');
  });

  it('a scope that did not exist at the lens is INVALID, not empty', async () => {
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
    assert.equal(early.snapshot.completeness, 'INVALID');
    assert.equal(early.items.length, 0);
    assert.equal(early.snapshot.completenessReasons[0].code, 'SCOPE_UNRESOLVED');
  });
});

describe('structural state is time-aware', () => {
  it('the structural delta S1 → S2 holds the reclassification and the role-holder change, apart from every value change', async () => {
    const d = unwrap(await s.twin.compareSnapshots(s.scope, s.story.S1.snapshot.id, s.story.S2.snapshot.id), 'S1→S2');
    const rohto = d.structuralChanges.find((c) => c.itemKey === `entity:${s.governance.entities.rohto.entityId}`);
    assert.deepEqual(rohto.fields.map((f) => [f.field, f.before, f.after]), [['classification', 'KEY_ACCOUNT', 'STRATEGIC_ACCOUNT']]);
    assert.ok(d.structuralChanges.some((c) => c.kind === 'RELATIONSHIP' && c.change === 'REMOVED' && /Key Account/.test(c.label)));
    assert.ok(d.structuralChanges.some((c) => c.kind === 'RELATIONSHIP' && c.change === 'ADDED' && /Strategic Account/.test(c.label)));
    const seat = d.structuralChanges.find((c) => c.kind === 'ROLE_OCCUPANCY');
    assert.ok(seat.fields.some((f) => f.field === 'personLabel' && f.before === 'Tran Van Binh' && f.after === 'Hoang Thu Trang'));
    assert.ok(d.structuralChanges.every((c) => ['ENTITY', 'RELATIONSHIP', 'ROLE_OCCUPANCY'].includes(c.kind)));
    assert.ok(d.valueChanges.every((c) => c.kind === 'VALUE' || c.kind === 'OBJECTIVE'), 'no structural change is reported as a value change');
    assert.ok(d.valueChanges.length > 0);
  });

  it('the governance delta shows DOA v1 → v2 without rewriting the evaluation made under v1', async () => {
    const d = unwrap(await s.twin.compareSnapshots(s.scope, s.story.S1.snapshot.id, s.story.S2.snapshot.id), 'S1→S2');
    const policy = d.governanceChanges.find((c) => c.kind === 'POLICY');
    assert.ok(policy.fields.some((f) => f.field === 'version' && f.before === 1 && f.after === 2));
    assert.ok(policy.fields.some((f) => f.field === 'reference' && f.before === 'DOA-2026-04' && f.after === 'DOA-2026-10'));
    assert.ok(!d.governanceChanges.some((c) => c.kind === 'GOVERNANCE'), 'the Rohto verdict did not move');
    const g2 = itemsOf(s.story.S2, 'GOVERNANCE')[0];
    assert.deepEqual(g2.state.policies, ['DOA-2026-04 v1'], 'judged under the policy in force when it was made');
  });

  it('a delta across futures says it is one, and points at the trajectory', async () => {
    const d = unwrap(await s.twin.compareSnapshots(s.scope, s.story.CF1.snapshot.id, s.story.S2.snapshot.id), 'CF1→S2');
    assert.ok(d.comparability.warnings.some((w) => /read the trajectory/.test(w)));
  });

  it('comparisons raise deterioration as a named condition, never as a score', async () => {
    const d = unwrap(await s.twin.compareSnapshots(s.scope, s.story.S1.snapshot.id, s.story.S2.snapshot.id), 'S1→S2');
    const det = d.deltaAttention.find((a) => a.condition === 'MATERIAL_VALUE_DETERIORATION' && /Gross Margin %/.test(a.statement));
    assert.ok(det, d.deltaAttention.map((a) => a.statement).join('\n'));
    assert.match(det.rule, /helm-demo-materiality@1/);
    assert.ok(!('score' in d) && !('ranking' in d));
  });
});
