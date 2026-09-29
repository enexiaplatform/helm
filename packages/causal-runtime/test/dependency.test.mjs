/**
 * CALCULATION_DEPENDENCY ≠ CAUSAL_RELATIONSHIP, and coincidence ≠ cause.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCausalGraph } from '../src/index.ts';
import { buildCausalStack, buildCausalStory, unwrap } from './harness.mjs';

const fingerprintModel = async (s) => {
  const calcs = s.registry.all().map((d) => `${d.key}@${d.version}:${d.outputMetricKey}<-${d.inputs.map((i) => i.metricKey).join(',')}`).sort();
  const runs = unwrap(await s.scenarios.listRuns(s.scope), 'runs').map((x) => `${x.id}:${x.fingerprint}:${x.status}`).sort();
  const obs = [];
  for (const n of unwrap(await s.valueGraph.findValueNodes(s.scope), 'nodes')) {
    obs.push(...unwrap(await s.valueGraph.getObservations(s.scope, { nodeId: n.id }), 'observations').map((o) => `${o.id}:${o.observationType}:${o.numericValue}`));
  }
  return JSON.stringify({ calcs, runs, obs: obs.sort() });
};

describe('a causal claim never changes the model', () => {
  it('the whole causal story leaves calculations, runs and observations exactly as they were', async () => {
    const s = await buildCausalStack();
    const before = await fingerprintModel(s);
    assert.ok(before.length > 1000, 'the fingerprint covers a real model');
    const story = await buildCausalStory(s);
    assert.equal(Object.keys(story.causalStory.claims).length, 14, 'the story ran on this very stack');
    const after = await fingerprintModel(s);
    assert.equal(after, before);
  });

  it('adding a claim between two metrics the model already links adds no calculation dependency and no evidence', async () => {
    const s = await buildCausalStory();
    const causesBefore = s.registry.findByInputMetric('Opex').map((d) => d.key);
    const claim = unwrap(
      await s.causal.createClaim(s.scope, {
        causeKey: 'FULFILMENT_COST',
        effectKey: 'GROSS_MARGIN_PCT',
        relationshipType: 'DECREASES',
        scope: { kind: 'ANCHORED', anchors: [{ entityId: s.governance.entities.buIndustrial.entityId, label: 'Industrial BU', dimension: '' }] },
        authoredByLabel: 'test',
        statement: 'The same relationship, claimed in another scope with no evidence.',
        rationale: 'the model says so',
      }),
      'claim',
    );
    assert.deepEqual(s.registry.findByInputMetric('Opex').map((d) => d.key), causesBefore);
    const dep = unwrap(await s.causal.modelDependency(s.scope, 'FULFILMENT_COST', 'GROSS_MARGIN_PCT'), 'dependency');
    assert.equal(dep.kind, 'KNOWN_VALUE_DEPENDENCY', 'the model links them');
    assert.equal(claim.evaluation.status, 'HYPOTHESIS', 'and still the claim has no evidence');
    assert.equal(claim.evaluation.confidence, 'NONE');
    assert.equal(claim.evaluation.assessments.length, 0);
  });

  it('the causal runtime holds the calculation registry read-only and has no write path into lower layers', () => {
    const readOnly = { findByOutputMetric: () => [], findByInputMetric: () => [], all: () => [], active: () => [], get: () => null };
    const g = createCausalGraph({ store: {}, graph: {}, metrics: {}, calculations: readOnly, clock: { now: () => new Date() } });
    for (const name of Object.keys(g)) {
      assert.doesNotMatch(name, /propagat|recalculat|register|simulate|execute|infer|discover|promote|learn|recommend|optimi/i, name);
    }
  });
});

describe('coincidence is not a cause', () => {
  let s;
  before(async () => {
    s = await buildCausalStory();
  });

  it('allocation changed and satisfaction improved in the same quarter: a correlation is recorded, and no claim links them', async () => {
    const corr = s.causalStory.correlation;
    assert.equal(corr.xKey, 'INVENTORY_ALLOCATION_CHANGE');
    assert.equal(corr.yKey, 'CUSTOMER_SATISFACTION');
    const claims = unwrap(await s.causal.listClaims(s.scope, { causeKey: 'INVENTORY_ALLOCATION_CHANGE' }), 'claims');
    assert.equal(claims.length, 0);
    const onSatisfaction = unwrap(await s.causal.getCauses(s.scope, 'CUSTOMER_SATISFACTION'), 'causes');
    assert.equal(onSatisfaction.length, 0);
  });

  it('asking why satisfaction improved returns OPEN — "we do not know yet" — not the co-moving variable', async () => {
    const inv = unwrap(await s.causal.investigate(s.scope, s.causalStory.questions.satisfaction.id), 'investigate');
    assert.equal(inv.status, 'OPEN');
    assert.equal(inv.candidates.length, 0);
    assert.match(inv.statement, /does not infer one/);
  });

  it('evidence that cites a correlation is capped at LOW, whatever it is graded', async () => {
    const e = unwrap(
      await s.causal.recordEvidence(s.scope, {
        type: 'STATISTICAL_ANALYSIS',
        statement: 'The Q4 co-movement, cited as evidence.',
        assessedStrength: 'MEDIUM',
        strengthRationale: 'graded generously',
        provenance: { sourceSystem: 'finance', sourceReference: 'correlation', method: 'ANALYSIS', assertedByLabel: 'test' },
        statistical: { method: 'co-movement', population: 'key accounts', period: '2026-Q4', effectEstimate: '+6', uncertainty: 'one wave', limitations: 'one quarter' },
        correlationFindingId: s.causalStory.correlation.id,
      }),
      'evidence',
    );
    const claim = unwrap(
      await s.causal.createClaim(s.scope, {
        causeKey: 'INVENTORY_ALLOCATION_CHANGE',
        effectKey: 'CUSTOMER_SATISFACTION',
        relationshipType: 'INCREASES',
        scope: { kind: 'ANCHORED', anchors: [{ entityId: s.governance.entities.buPharma.entityId, label: 'Pharma BU', dimension: '' }] },
        authoredByLabel: 'test',
        statement: 'Authored explicitly by a person, to test the cap.',
        rationale: 'test',
      }),
      'claim',
    );
    const v = unwrap(await s.causal.supportClaim(s.scope, claim.claim.id, e.id, 'the correlation'), 'link');
    assert.equal(v.evaluation.assessments[0].strength, 'LOW');
    assert.match(v.evaluation.assessments[0].strengthNote, /correlation does not establish influence/);
    assert.equal(v.evaluation.status, 'HYPOTHESIS');
  });
});
