/**
 * The evidence policy (ADR-0027): a hierarchy with ceilings, count never
 * decides, contradiction is weighed not outvoted, order eliminates but does not
 * prove, corrections supersede, judgement is labelled as judgement.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EVIDENCE_CEILING } from '../src/index.ts';
import { at, buildCausalStory, expectFail, unwrap } from './harness.mjs';

let s;
let claimN = 0;
before(async () => {
  s = await buildCausalStory();
});

const anchors = () => ({ kind: 'ANCHORED', anchors: [{ entityId: s.governance.entities.buPharma.entityId, label: 'Pharma BU', dimension: '' }] });
const newClaim = async () =>
  unwrap(
    await s.causal.createClaim(s.scope, {
      causeKey: 'PRICE_DISCOUNT',
      effectKey: 'SALES_VOLUME',
      relationshipType: 'INCREASES',
      scope: anchors(),
      conditions: [{ statement: `policy fixture ${(claimN += 1)}`, refs: [] }],
      authoredByLabel: 'policy test',
      statement: 'A fixture claim for the evidence policy.',
      rationale: 'fixture',
    }),
    'claim',
  );
const evidence = async (type, strength, extra = {}) =>
  unwrap(
    await s.causal.recordEvidence(s.scope, {
      type,
      statement: `${type} fixture`,
      assessedStrength: strength,
      strengthRationale: 'fixture',
      provenance: { sourceSystem: 'manual', sourceReference: 'fixture', method: type === 'MANAGEMENT_EXPERTISE' ? 'JUDGEMENT' : 'ANALYSIS', assertedByLabel: 'fixture' },
      ...extra,
    }),
    'evidence',
  );
const link = async (claim, ev, stance = 'SUPPORTS') => unwrap(await s.causal.linkEvidence(s.scope, claim.claim.id, ev.id, stance, 'fixture'), 'link');

describe('the hierarchy', () => {
  it('each type has a ceiling; only experiments can be HIGH; judgement is LOW', () => {
    assert.equal(EVIDENCE_CEILING.CONTROLLED_EXPERIMENT, 'HIGH');
    assert.equal(EVIDENCE_CEILING.NATURAL_EXPERIMENT, 'HIGH');
    assert.equal(EVIDENCE_CEILING.MANAGEMENT_EXPERTISE, 'LOW');
    for (const t of ['INTERVENTION', 'LONGITUDINAL_OBSERVATION', 'REPEATED_PATTERN', 'STATISTICAL_ANALYSIS', 'PROCESS_MECHANISM', 'EXTERNAL_RESEARCH', 'CONTRADICTORY_CASE']) {
      assert.equal(EVIDENCE_CEILING[t], 'MEDIUM', t);
    }
  });

  it('a judgement graded HIGH is counted LOW, and says so', async () => {
    const claim = await newClaim();
    const view = await link(claim, await evidence('MANAGEMENT_EXPERTISE', 'HIGH'));
    const a = view.evaluation.assessments[0];
    assert.equal(a.strength, 'LOW');
    assert.match(a.strengthNote, /Assessed HIGH; counted as LOW/);
  });

  it('judgement is never presented as a measurement, nor a measurement as judgement', async () => {
    const e1 = await s.causal.recordEvidence(s.scope, {
      type: 'MANAGEMENT_EXPERTISE', statement: 'x', assessedStrength: 'LOW', strengthRationale: 'x',
      provenance: { sourceSystem: 'manual', sourceReference: 'x', method: 'MEASUREMENT', assertedByLabel: 'x' },
    });
    expectFail(e1, 'judgement as measurement');
    const e2 = await s.causal.recordEvidence(s.scope, {
      type: 'PROCESS_MECHANISM', statement: 'x', assessedStrength: 'LOW', strengthRationale: 'x',
      provenance: { sourceSystem: 'manual', sourceReference: 'x', method: 'JUDGEMENT', assertedByLabel: 'x' },
    });
    expectFail(e2, 'judgement as a document');
  });

  it('evidence without provenance, or a statistic without its method and limitations, is refused', async () => {
    expectFail(await s.causal.recordEvidence(s.scope, { type: 'REPEATED_PATTERN', statement: 'x', assessedStrength: 'LOW', strengthRationale: 'x', provenance: { sourceSystem: '', sourceReference: '', method: 'ANALYSIS', assertedByLabel: '' } }), 'no provenance');
    expectFail(await s.causal.recordEvidence(s.scope, { type: 'STATISTICAL_ANALYSIS', statement: 'x', assessedStrength: 'MEDIUM', strengthRationale: 'x', provenance: { sourceSystem: 'finance', sourceReference: 'r', method: 'ANALYSIS', assertedByLabel: 'x' } }), 'no statistics');
    const ok = await evidence('STATISTICAL_ANALYSIS', 'MEDIUM', {
      statistical: { method: 'difference in means', population: '40 accounts', period: '2026-Q3', effectEstimate: '+4.1 units', uncertainty: '95% CI 0.8–7.4', limitations: 'not randomized' },
    });
    assert.equal(ok.statistical.limitations, 'not randomized');
  });
});

describe('count never decides', () => {
  it('five LOW supports leave a claim a HYPOTHESIS; one HIGH controlled experiment makes another SUPPORTED', async () => {
    const weak = await newClaim();
    let v;
    for (let i = 0; i < 5; i += 1) v = await link(weak, await evidence('MANAGEMENT_EXPERTISE', 'LOW'));
    assert.equal(v.evaluation.status, 'HYPOTHESIS');
    assert.equal(v.evaluation.counts.supporting, 5);
    const strong = await newClaim();
    const w = await link(strong, await evidence('CONTROLLED_EXPERIMENT', 'HIGH'));
    assert.equal(w.evaluation.status, 'SUPPORTED');
    assert.equal(w.evaluation.confidence, 'HIGH');
  });

  it('two MEDIUM items of the SAME kind are not independent — still a HYPOTHESIS', async () => {
    const claim = await newClaim();
    await link(claim, await evidence('REPEATED_PATTERN', 'MEDIUM'));
    const v = await link(claim, await evidence('REPEATED_PATTERN', 'MEDIUM'));
    assert.equal(v.evaluation.status, 'HYPOTHESIS');
  });

  it('three supports do not outvote one credible contradiction', async () => {
    const claim = await newClaim();
    await link(claim, await evidence('REPEATED_PATTERN', 'MEDIUM'));
    await link(claim, await evidence('INTERVENTION', 'MEDIUM'));
    await link(claim, await evidence('MANAGEMENT_EXPERTISE', 'LOW'));
    const v = await link(claim, await evidence('NATURAL_EXPERIMENT', 'MEDIUM'), 'CONTRADICTS');
    assert.equal(v.evaluation.status, 'CONTESTED');
    assert.match(v.evaluation.reasons.join(' '), /Neither is outvoted by counting/);
  });

  it('HIGH contradiction without HIGH support refutes; the supporting evidence stays on record', async () => {
    const claim = await newClaim();
    await link(claim, await evidence('INTERVENTION', 'MEDIUM'));
    await link(claim, await evidence('REPEATED_PATTERN', 'MEDIUM'));
    const v = await link(claim, await evidence('CONTROLLED_EXPERIMENT', 'HIGH'), 'CONTRADICTS');
    assert.equal(v.evaluation.status, 'REFUTED');
    assert.equal(v.evaluation.counts.supporting, 2, 'nothing was deleted');
  });
});

describe('contradiction over time (the canonical discount claim)', () => {
  it('D1 was SUPPORTED on 1 Feb and is CONTESTED after Finance\'s comparison; D2 is stored beside it, not merged', async () => {
    const c = s.causalStory.claims;
    const then = unwrap(await s.causal.getClaim(s.scope, c.D1.claim.id, at('2027-02-01T00:00:00.000Z')), 'then');
    assert.equal(then.evaluation.status, 'SUPPORTED');
    assert.equal(c.D1.evaluation.status, 'CONTESTED');
    assert.equal(c.D1.evaluation.counts.supporting, 2, 'the earlier support is kept');
    assert.equal(c.D1.evaluation.counts.contradicting, 1);
    assert.notEqual(c.D2.claim.id, c.D1.claim.id);
    assert.equal(c.D2.claim.authoredByLabel, 'Finance Director Vietnam (demo)');
    assert.deepEqual(c.D1.revision.confounders.map((x) => x.variableKey), ['MARKET_DEMAND']);
  });

  it('a contradictory case can never be linked as support', async () => {
    const claim = await newClaim();
    const counter = await evidence('CONTRADICTORY_CASE', 'MEDIUM');
    expectFail(await s.causal.linkEvidence(s.scope, claim.claim.id, counter.id, 'SUPPORTS', 'x'), 'counter-case as support');
  });
});

describe('order eliminates, it does not prove', () => {
  it('H4: the supplier price revision took effect after the Q4 cost was recorded — TEMPORAL_CONFLICT, counted against, WEAKENED', () => {
    const h4 = s.causalStory.claims.H4;
    assert.equal(h4.evaluation.status, 'WEAKENED');
    assert.equal(h4.evaluation.temporalConflicts, 1);
    const a = h4.evaluation.assessments[0];
    assert.equal(a.link.stance, 'SUPPORTS', 'it was offered as support');
    assert.equal(a.countedAs, 'CHALLENGE', 'the policy counts it against the claim');
    assert.match(a.note, /A cause cannot follow its effect/);
  });

  it('the right order is noted as necessary, not sufficient', () => {
    const e2 = s.causalStory.claims.H1.evaluation.assessments.find((a) => a.evidence.id === s.causalStory.evidence.E2.id);
    assert.equal(e2.temporal, 'CAUSE_PRECEDES_EFFECT');
    assert.match(e2.note, /does not show influence/);
  });
});

describe('corrections supersede, never edit', () => {
  it('a correction changes the reading from its record time on; the original remains and earlier lenses still read it', async () => {
    const claim = await newClaim();
    const first = await evidence('INTERVENTION', 'MEDIUM');
    await link(claim, first);
    const v1 = await link(claim, await evidence('REPEATED_PATTERN', 'MEDIUM'));
    assert.equal(v1.evaluation.status, 'SUPPORTED');
    const before = s.clock.now().toISOString();
    const corrected = unwrap(
      await s.causal.correctEvidence(s.scope, first.id, {
        type: 'INTERVENTION',
        statement: 'Correction: the promotion also coincided with a competitor stock-out.',
        assessedStrength: 'LOW',
        strengthRationale: 'the intervention was confounded',
        provenance: { sourceSystem: 'erp', sourceReference: 'correction', method: 'ANALYSIS', assertedByLabel: 'fixture' },
      }),
      'correct',
    );
    assert.equal(corrected.supersedesId, first.id);
    const now = unwrap(await s.causal.getClaim(s.scope, claim.claim.id), 'now');
    assert.equal(now.evaluation.status, 'HYPOTHESIS', 'the corrected (LOW) version is what counts now');
    const then = unwrap(await s.causal.getClaim(s.scope, claim.claim.id, at(before)), 'then');
    assert.equal(then.evaluation.status, 'SUPPORTED', 'the earlier lens still reads the original');
    const all = unwrap(await s.causal.listEvidence(s.scope), 'list');
    assert.ok(all.some((e) => e.id === first.id), 'the original is kept');
    expectFail(await s.causal.correctEvidence(s.scope, first.id, { type: 'INTERVENTION', statement: 'again', assessedStrength: 'LOW', strengthRationale: 'x', provenance: { sourceSystem: 'erp', sourceReference: 'x', method: 'ANALYSIS', assertedByLabel: 'x' } }), 'second correction');
  });
});
