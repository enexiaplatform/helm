/**
 * The canonical Rohto causal investigation (DEMO CAUSAL HYPOTHESES), and the
 * separation it exists to prove: observed difference, model explanation and
 * causal investigation are three different things.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Q4_ACTUAL_FULFILMENT_COST } from '@helm/twin-runtime';
import { DEPENDENCY_IS_NOT_CAUSALITY, explainTwinDifferenceCausally } from '../src/index.ts';
import { buildCausalStory, unwrap, valueKey } from './harness.mjs';

let s;
let c;
before(async () => {
  s = await buildCausalStory();
  c = s.causalStory.claims;
});

const explainGm = async () => {
  const cfKey = s.story.CF1.items.find((i) => i.kind === 'VALUE' && i.state.nodeId === s.nodeIds.grossMarginPctOpp).key;
  return unwrap(
    await explainTwinDifferenceCausally({ twin: s.twin, causal: s.causal }, s.scope, {
      fromId: s.story.CF1.snapshot.id,
      toId: s.story.S2.snapshot.id,
      itemKey: cfKey,
      toItemKey: valueKey(s.nodeIds.grossMarginPctOpp, 'ACTUAL'),
    }),
    'explain',
  );
};

describe('the observed difference and its model explanation', () => {
  it('CF1 → S2: gross margin 32.3878 → 31.7, −0.6878 pts; the model says fulfilment cost moved 165 000 000 → 185 220 000', async () => {
    const x = await explainGm();
    assert.equal(x.observed.from, '32.3878');
    assert.equal(x.observed.to, '31.7');
    assert.equal(x.observed.delta, '-0.6878');
    const opex = x.model.movedInputs.find((m) => m.metricKey === 'Opex');
    assert.equal(opex.before, '165000000', 'the committed plan: SCM\'s 140M estimate plus the 25M transfer allowance');
    assert.equal(opex.after, Q4_ACTUAL_FULFILMENT_COST);
    assert.match(x.model.disclaimer, /not a causal claim/);
  });

  it('the question states the overrun honestly against both baselines', () => {
    const q = s.causalStory.questions.fulfilment;
    assert.equal(q.target.observedChange, '+20220000', '185 220 000 − 165 000 000: what the twin difference measures');
    assert.match(q.statement, /20 220 000 VND above the committed plan/);
    assert.match(q.statement, /45 220 000 VND above SCM's original 140 000 000 VND estimate/);
  });
});

describe('the causal investigation of the fulfilment-cost overrun', () => {
  it('lists only claims people proposed or authored — H1 SUPPORTED, H2 and H3 UNRESOLVED, H4 WEAKENED', async () => {
    const inv = unwrap(await s.causal.investigate(s.scope, s.causalStory.questions.fulfilment.id), 'investigate');
    const by = (key) => inv.candidates.find((k) => k.view.claim.causeKey === key);
    assert.equal(by('EXPEDITED_TRANSFER').view.evaluation.status, 'SUPPORTED');
    assert.equal(by('SUPPLIER_SURCHARGE').view.evaluation.status, 'UNRESOLVED');
    assert.equal(by('CUSTOMS_HANDLING').view.evaluation.status, 'UNRESOLVED');
    assert.equal(by('SUPPLIER_PRICE_REVISION').view.evaluation.status, 'WEAKENED');
    for (const k of inv.candidates) {
      assert.ok(k.via === 'QUESTION' || (k.via === 'CLAIM_ON_TARGET' && k.view.claim.effectKey === 'FULFILMENT_COST'), 'every candidate is a person\'s claim about this variable');
    }
    assert.equal(inv.status, 'SUPPORTED_EXPLANATION_EXISTS');
    assert.match(inv.statement, /does not apportion the change/);
  });

  it('H1: SUPPORTED, MODERATE, two supporting kinds, none contradicting; the mechanism is the air-freight surcharge', async () => {
    const ex = unwrap(await s.causal.explainClaim(s.scope, c.H1.claim.id), 'explain');
    assert.equal(ex.view.evaluation.status, 'SUPPORTED');
    assert.equal(ex.view.evaluation.confidence, 'MODERATE');
    assert.equal(ex.supporting.length, 3);
    assert.equal(ex.contradicting.length + ex.challenging.length, 0);
    assert.deepEqual(ex.mechanism.map((m) => m.variableKey), ['EXPEDITED_TRANSFER', 'AIR_FREIGHT_USAGE', 'FULFILMENT_COST']);
    assert.match(ex.mechanism[2].description, /air-freight surcharge/);
    assert.equal(ex.view.claim.scope.kind, 'ANCHORED');
    assert.deepEqual(ex.view.claim.scope.anchors.map((a) => a.label), ['Pharma BU', 'Rohto Vietnam']);
    assert.match(ex.externalValidity, /external validity unknown/);
  });

  it('the final explanation keeps model and cause apart and never quantifies a causal share', async () => {
    const x = await explainGm();
    const cost = x.causal.find((ci) => ci.moved.metricKey === 'Opex');
    assert.equal(cost.variable.key, 'FULFILMENT_COST');
    assert.equal(cost.state, 'SUPPORTED_EXPLANATION_EXISTS');
    assert.match(cost.statement, /How much of the change it explains is not quantified/);
    const gm = x.causal.find((ci) => ci.moved.metricKey === 'GrossMargin');
    assert.equal(gm.state, 'NO_CAUSAL_KNOWLEDGE', 'no claim exists about gross margin value, and none is inferred');
    assert.equal(x.important, DEPENDENCY_IS_NOT_CAUSALITY);
    const text = JSON.stringify(x);
    assert.doesNotMatch(text, /\d+(\.\d+)?\s*%\s*of the (change|variance|gap)/i, 'no causal contribution percentages');
    assert.doesNotMatch(text, /definitely caused|caused the entire/i);
  });

  it('C2 exists as a causal claim AND as a model dependency — reported apart', async () => {
    const x = await explainGm();
    const c2 = x.claimsAboutObserved.find((o) => o.view.claim.id === c.C2.claim.id);
    assert.equal(c2.view.evaluation.status, 'SUPPORTED');
    assert.equal(c2.modelDependency.kind, 'KNOWN_VALUE_DEPENDENCY');
    assert.deepEqual(c2.modelDependency.calculations, ['gross_margin@1.0.0', 'gross_margin_pct@1.0.0']);
    assert.match(c2.modelDependency.statement, /does not count towards any causal claim/);
    const counted = c2.view.evaluation.assessments.map((a) => a.evidence.type).sort();
    assert.deepEqual(counted, ['LONGITUDINAL_OBSERVATION', 'PROCESS_MECHANISM'], 'only the linked evidence is counted');
  });

  it('C3 stays a HYPOTHESIS: HELM resists over-claiming on judgement alone', () => {
    assert.equal(c.C3.evaluation.status, 'HYPOTHESIS');
    assert.equal(c.C3.evaluation.confidence, 'LOW');
    assert.match(c.C3.evaluation.reasons.join(' '), /more of the same does not add up/);
  });
});
