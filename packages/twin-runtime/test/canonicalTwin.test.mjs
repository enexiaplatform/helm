/**
 * The canonical Phase 7 proof: the Rohto decision as a management state that
 * moves through time.
 *
 *   S0   the enterprise before the decision
 *   S1a  committed, the Country GM's approval pending
 *   S1   committed and approved — intent changed, reality did not
 *   CF1  the committed future, read from the frozen run
 *   S2   the enterprise after the Q4 outcome
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ATTRIBUTION_DISCLAIMER, Q4_ACTUAL_FULFILMENT_COST } from '../src/index.ts';
import { buildStory, item, itemsOf, unwrap, valueKey } from './harness.mjs';

let s;
before(async () => {
  s = await buildStory();
});

const gov = (snapshot) => itemsOf(snapshot, 'GOVERNANCE')[0] ?? null;
const decision = (snapshot) => itemsOf(snapshot, 'DECISION')[0] ?? null;
const attention = (snapshot, condition) => itemsOf(snapshot, 'ATTENTION').filter((a) => a.state.condition === condition);

describe('S0 — the enterprise before the decision', () => {
  it('holds the opportunity, the inventory constraint, current margin, cash and service, an open decision and the authority context', () => {
    const { S0 } = s.story;
    assert.equal(S0.snapshot.spec.kind, 'CURRENT');
    assert.ok(item(S0, `entity:${s.governance.entities.rohto.entityId}`), 'Rohto is in the Vietnam twin');
    assert.ok(itemsOf(S0, 'ENTITY').some((e) => e.state.entityTypeKey === 'Opportunity' && e.label.includes('Rohto')));
    const constraint = item(S0, 'constraint:rohto-order-fulfilment:2026-Q4');
    assert.equal(constraint.state.status, 'BREACHED');
    assert.equal(constraint.state.actual, '12');
    assert.equal(constraint.state.threshold, '4');
    assert.equal(item(S0, valueKey(s.nodeIds.grossMarginPctOpp, 'MODELLED')).state.value, '33.2381', 'current modelled margin');
    assert.equal(item(S0, valueKey(s.nodeIds.cashOpp, 'MODELLED')).state.value, '-1710500000', 'current modelled cash');
    assert.equal(item(S0, valueKey(s.nodeIds.availOwn, 'ACTUAL', null)).state.value, '4', 'own stock as SCM reported it');
    const d = decision(S0);
    assert.equal(d.state.state, 'READY_FOR_DECISION');
    assert.equal(d.state.open, true);
    assert.equal(itemsOf(S0, 'COMMITMENT').length, 0, 'nothing is committed yet');
    assert.equal(gov(S0), null, 'no governance item before a commitment exists');
    assert.ok(itemsOf(S0, 'POLICY').some((p) => p.state.reference === 'DOA-2026-04' && p.state.version === 1), 'the authority policy in force');
    assert.ok(itemsOf(S0, 'ROLE_OCCUPANCY').some((o) => o.label === 'Country GM Vietnam: Nguyen Thi Mai'));
    assert.equal(attention(S0, 'CONSTRAINT_BREACHED').length, 1);
    assert.equal(attention(S0, 'DECISION_AWAITING_COMMITMENT').length, 1);
  });
});

describe('S0 → S1: management intent and governance change; physical state does not', () => {
  it('S1a: the decision is committed and the Country GM approval is pending', () => {
    const { S1a } = s.story;
    assert.equal(decision(S1a).state.state, 'COMMITTED');
    const g = gov(S1a);
    assert.equal(g.state.state, 'PENDING_APPROVAL');
    assert.equal(g.state.policyResult, 'REQUIRES_APPROVAL');
    assert.deepEqual(g.state.pending, ['Country GM Vietnam']);
    assert.equal(g.state.evaluator, 'TRUSTED_SERVICE', 'the twin reads the trusted verdict');
    assert.equal(g.state.consequenceCheck, 'TRACE_VERIFIED');
    assert.equal(attention(S1a, 'APPROVAL_PENDING').length, 1);
  });

  it('S1: approved, a committed future and action intents exist — and the stock is exactly where it was', () => {
    const { S0, S1 } = s.story;
    assert.equal(gov(S1).state.state, 'APPROVED');
    assert.equal(gov(S1).state.acted[0].approver, 'Nguyen Thi Mai');
    const cf = itemsOf(S1, 'VALUE').filter((v) => v.layer === 'COMMITTED_FUTURE');
    assert.deepEqual(cf.map((v) => v.state.metricKey).sort(), ['CashImpact', 'DemandCoverage', 'GrossMarginPct']);
    assert.equal(cf.find((v) => v.state.metricKey === 'GrossMarginPct').state.value, '32.3878');
    assert.equal(itemsOf(S1, 'ACTION_INTENT').length, 3);
    assert.ok(itemsOf(S1, 'ACTION_INTENT').every((i) => i.state.status === 'INTENDED'));
    // Committing changed intent, not reality.
    for (const key of [valueKey(s.nodeIds.availOwn, 'ACTUAL', null), valueKey(s.nodeIds.availDist, 'ACTUAL', null), valueKey(s.nodeIds.grossMarginPctOpp, 'MODELLED')]) {
      assert.deepEqual(item(S1, key).state, item(S0, key).state, `${key} did not move when management committed`);
    }
    assert.equal(item(S1, 'constraint:rohto-order-fulfilment:2026-Q4').state.status, 'BREACHED', 'the shortfall is still real');
  });

  it('the delta states Open → Committed → Approved as management-state transitions', async () => {
    const { S0, S1a, S1 } = s.story;
    const a = unwrap(await s.twin.compareSnapshots(s.scope, S0.snapshot.id, S1a.snapshot.id), 'S0→S1a');
    const moved = a.decisionChanges.find((c) => c.kind === 'DECISION');
    assert.ok(moved.fields.some((f) => f.field === 'state' && f.before === 'READY_FOR_DECISION' && f.after === 'COMMITTED'));
    assert.ok(a.decisionChanges.some((c) => c.kind === 'COMMITMENT' && c.change === 'ADDED'));
    assert.ok(a.governanceChanges.some((c) => c.kind === 'GOVERNANCE' && c.change === 'ADDED' && c.after.state.state === 'PENDING_APPROVAL'));
    assert.equal(a.structuralChanges.length, 0, 'committing is not a structural change');
    const b = unwrap(await s.twin.compareSnapshots(s.scope, S1a.snapshot.id, S1.snapshot.id), 'S1a→S1');
    const approved = b.governanceChanges.find((c) => c.kind === 'GOVERNANCE');
    assert.ok(approved.fields.some((f) => f.field === 'state' && f.before === 'PENDING_APPROVAL' && f.after === 'APPROVED'));
    assert.equal(b.valueChanges.length, 0, 'approval moved no value');
  });
});

describe('CF1 — the committed future', () => {
  it('references the exact run the commitment froze, and does not rerun today\'s model', () => {
    const { CF1 } = s.story;
    assert.equal(CF1.snapshot.spec.kind, 'COMMITTED_FUTURE');
    const commitment = itemsOf(CF1, 'COMMITMENT')[0];
    const runRef = commitment.refs.find((r) => r.kind === 'SCENARIO_RUN');
    const values = itemsOf(CF1, 'VALUE');
    assert.ok(values.length > 10);
    assert.ok(values.every((v) => v.layer === 'COMMITTED_FUTURE'), 'a committed future is never shown as actual or modelled state');
    assert.ok(values.every((v) => v.refs.some((r) => r.kind === 'SCENARIO_RUN' && r.id === runRef.id)), 'every value points at the frozen run');
    assert.ok(CF1.snapshot.sourceReferences.some((r) => r.kind === 'COMMITMENT_SNAPSHOT'));
    const gm = values.find((v) => v.state.nodeId === s.nodeIds.grossMarginPctOpp);
    assert.equal(gm.state.value, '32.3878');
    assert.equal(gm.state.expectedOutcome, true);
    assert.equal(values.find((v) => v.state.nodeId === s.nodeIds.cashOpp).state.value, '-1735500000');
    // The overrides the future assumed are stated beside it, as assumptions.
    assert.ok(itemsOf(CF1, 'ASSUMPTION').some((a) => a.state.source === 'SCENARIO_OVERRIDE' && a.state.metricKey === 'Opex' && a.state.value === '25000000'));
  });
});

describe('S2 — after the Q4 outcome: expected against actual', () => {
  it('CF1 → S2: gross margin 32.3878 committed, 31.7 actual, −0.6878 pts', async () => {
    const t = unwrap(await s.twin.getTrajectory(s.scope, s.story.S2.snapshot.id, s.story.CF1.snapshot.id), 'trajectory');
    assert.equal(t.relation, 'EXPECTED_VS_ACTUAL', 'Q4 has ended, so this is expected against actual');
    const gm = t.lines.find((l) => l.metricKey === 'GrossMarginPct');
    assert.equal(gm.committed, '32.3878');
    assert.equal(gm.current, '31.7');
    assert.equal(gm.currentLayer, 'ACTUAL', 'the actual is Finance\'s, not the model\'s');
    assert.equal(gm.difference, '-0.6878');
    assert.equal(gm.differenceUnit, ' pts');
    assert.equal(gm.beyondMateriality, true);
    assert.match(t.statement, /not a verdict on the decision/);
    assert.ok(!('score' in t) && !('quality' in t), 'no decision-quality judgement');
  });

  it('S1 → CF1 is distance to intent, not a variance: the period has not ended', async () => {
    const t = unwrap(await s.twin.getTrajectory(s.scope, s.story.S1.snapshot.id, s.story.CF1.snapshot.id), 'trajectory');
    assert.equal(t.relation, 'DISTANCE_TO_INTENT');
    assert.match(t.statement, /not a variance/);
    const coverage = t.lines.find((l) => l.metricKey === 'DemandCoverage');
    assert.equal(coverage.committed, '96.8858');
    assert.equal(coverage.current, '32.2953', 'today\'s model still reads the stock that is actually there');
    assert.ok(t.unresolved.some((u) => /action intent intended/.test(u.why)));
  });

  it('surfaces the committed future off track and the disproved assumption as attention, with lineage', () => {
    const { S2 } = s.story;
    const off = attention(S2, 'COMMITTED_FUTURE_OFF_TRACK');
    assert.equal(off.length, 1);
    assert.match(off[0].state.statement, /committed 32\.3878, actual 31\.7 \(−0\.6878 pts\)/);
    assert.equal(off[0].state.causeItemKeys.length, 2, 'both the committed and the actual reading are named');
    assert.ok(off[0].refs.some((r) => r.kind === 'COMMITMENT'), 'attention reaches the commitment');
    assert.equal(attention(S2, 'CRITICAL_ASSUMPTION_DISPROVED').length, 1);
    assert.equal(item(S2, 'constraint:rohto-order-fulfilment:2026-Q4').state.status, 'SATISFIED', 'after the transfer, the order ships');
    assert.ok(!itemsOf(S2, 'ATTENTION').some((a) => 'score' in a.state || 'priority' in a.state || 'rank' in a.state));
  });

  it('traces the expected and the actual branches separately, then attributes the gap through the model', async () => {
    const cfKey = itemsOf(s.story.CF1, 'VALUE').find((v) => v.state.nodeId === s.nodeIds.grossMarginPctOpp).key;
    const ex = unwrap(
      await s.twin.explainDifference(s.scope, s.story.CF1.snapshot.id, s.story.S2.snapshot.id, cfKey, valueKey(s.nodeIds.grossMarginPctOpp, 'ACTUAL')),
      'explain',
    );
    assert.equal(ex.delta, '-0.6878');
    // Expected branch: the committed run's calculation, down to its inputs.
    assert.ok(ex.from.lineage.some((l) => /gross_margin_pct@1\.0\.0/.test(l.detail)));
    assert.ok(ex.from.lineage.some((l) => /expected_revenue@1\.0\.0/.test(l.detail)));
    // Actual branch: Finance's observation.
    assert.ok(ex.to.lineage.some((l) => l.ref?.kind === 'OBSERVATION' && /finance/.test(l.detail)));
    // Attribution: margin moved because fulfilment cost moved — override on one side, recorded fact on the other.
    const gmInput = ex.attribution.find((a) => a.metricKey === 'GrossMargin');
    assert.equal(gmInput.before, '952200000');
    assert.equal(gmInput.after, '931980000');
    const opex = gmInput.changedBecause.find((a) => a.metricKey === 'Opex');
    assert.equal(opex.before, '165000000');
    assert.equal(opex.after, Q4_ACTUAL_FULFILMENT_COST);
    assert.match(opex.beforeSource, /scenario override ADD 25000000/);
    assert.match(opex.afterSource, /ACTUAL observation \(finance\)/);
    assert.equal(gmInput.changedBecause.length, 1, 'nothing else in the model moved');
    assert.equal(ex.disclaimer, ATTRIBUTION_DISCLAIMER);
    assert.match(ex.disclaimer, /not a causal claim/);
    assert.doesNotMatch(ex.statement, /\bcaus/i, 'the statement never claims causation');
  });
});
