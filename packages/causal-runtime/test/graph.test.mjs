/**
 * Scope, context, mechanism, mediators, confounders, many causes and effects,
 * feedback loops and bounded traversal (ADR-0026 §3–§4).
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCausalStory, expectFail, unwrap } from './harness.mjs';

let s;
let c;
let e;
before(async () => {
  s = await buildCausalStory();
  c = s.causalStory.claims;
  e = s.governance.entities;
});

describe('scope', () => {
  it('a claim supported for Vietnam Pharma / Rohto is OUTSIDE Thailand Pharma, and nothing about fulfilment cost applies there', async () => {
    const a = unwrap(await s.causal.applicability(s.scope, c.H1.claim.id, e.buThPharma.entityId), 'TH');
    assert.equal(a.verdict, 'OUTSIDE');
    assert.match(a.reason, /external validity is unknown/);
    const there = unwrap(await s.causal.claimsFor(s.scope, { effectKey: 'FULFILMENT_COST', context: e.buThPharma.entityId }), 'claims for TH');
    assert.equal(there.applicable.length, 0);
    assert.ok(there.notApplicable.some((v) => v.claim.id === c.H1.claim.id));
  });

  it('it APPLIES to its own context and APPLIES_TO_PART of Vietnam — never upward to the whole', async () => {
    assert.equal(unwrap(await s.causal.applicability(s.scope, c.H1.claim.id, [e.buPharma.entityId, e.rohto.entityId]), 'own').verdict, 'APPLIES');
    const vn = unwrap(await s.causal.applicability(s.scope, c.H1.claim.id, e.vn.entityId), 'VN');
    assert.equal(vn.verdict, 'APPLIES_TO_PART');
    assert.match(vn.reason, /says nothing about the rest/);
    assert.equal(unwrap(await s.causal.applicability(s.scope, c.D1.claim.id, e.buPharma.entityId), 'D1 in Pharma').verdict, 'OUTSIDE');
  });

  it('a claim is never global by default', async () => {
    const base = { causeKey: 'PRICE_DISCOUNT', effectKey: 'SALES_VOLUME', relationshipType: 'INCREASES', authoredByLabel: 't', statement: 's', rationale: 'r' };
    assert.equal(expectFail(await s.causal.createClaim(s.scope, { ...base, scope: { kind: 'ANCHORED', anchors: [] } }), 'no anchors').code, 'causal.unscoped_claim');
    assert.equal(expectFail(await s.causal.createClaim(s.scope, { ...base, scope: { kind: 'ENTERPRISE_WIDE', justification: '' } }), 'unjustified').code, 'causal.unscoped_claim');
    const wide = unwrap(await s.causal.createClaim(s.scope, { ...base, scope: { kind: 'ENTERPRISE_WIDE', justification: 'Price elasticity studies across every market we operate in agree.' } }), 'justified');
    assert.equal(wide.claim.scope.kind, 'ENTERPRISE_WIDE');
  });

  it('the vocabulary is small and has no unconditional CAUSES; MEDIATES names the claim it qualifies', async () => {
    const base = { causeKey: 'PRICE_DISCOUNT', effectKey: 'SALES_VOLUME', authoredByLabel: 't', statement: 's', rationale: 'r', scope: { kind: 'ANCHORED', anchors: [{ entityId: e.buIndustrial.entityId, label: 'Industrial BU', dimension: '' }] } };
    expectFail(await s.causal.createClaim(s.scope, { ...base, relationshipType: 'CAUSES' }), 'CAUSES');
    expectFail(await s.causal.createClaim(s.scope, { ...base, relationshipType: 'MEDIATES' }), 'MEDIATES without a target');
    assert.equal(c.MED.claim.relationshipType, 'MEDIATES');
    assert.equal(c.MED.claim.targetClaimId, c.H1.claim.id);
  });

  it('context conditions are part of the claim', () => {
    assert.deepEqual(c.H1.claim.conditions.map((x) => x.statement), ['WHEN the transfer is flown rather than trucked']);
    assert.deepEqual(c.D1.claim.conditions.map((x) => x.statement), ['WHEN the segment is price-sensitive']);
  });
});

describe('the shape of the graph', () => {
  it('an effect may have several causes, a cause several effects', async () => {
    const causes = unwrap(await s.causal.getCauses(s.scope, 'FULFILMENT_COST'), 'causes');
    assert.deepEqual(new Set(causes.map((v) => v.claim.causeKey)), new Set(['EXPEDITED_TRANSFER', 'SUPPLIER_SURCHARGE', 'CUSTOMS_HANDLING', 'SUPPLIER_PRICE_REVISION', 'AIR_FREIGHT_USAGE']));
    const effects = unwrap(await s.causal.getEffects(s.scope, 'EXPEDITED_TRANSFER'), 'effects');
    assert.deepEqual(new Set(effects.map((v) => v.claim.effectKey)), new Set(['FULFILMENT_COST', 'AIR_FREIGHT_USAGE']));
  });

  it('paths keep the mediator, and a path is as supported as its weakest claim — never a multiplied probability', async () => {
    const paths = unwrap(await s.causal.paths(s.scope, { from: 'EXPEDITED_TRANSFER', to: 'GROSS_MARGIN_PCT', maxDepth: 4 }), 'paths');
    const direct = paths.find((p) => p.variables.length === 3);
    const mediated = paths.find((p) => p.variables.includes('AIR_FREIGHT_USAGE'));
    assert.deepEqual(direct.variables, ['EXPEDITED_TRANSFER', 'FULFILMENT_COST', 'GROSS_MARGIN_PCT']);
    assert.equal(direct.weakest, 'SUPPORTED');
    assert.deepEqual(mediated.variables, ['EXPEDITED_TRANSFER', 'AIR_FREIGHT_USAGE', 'FULFILMENT_COST', 'GROSS_MARGIN_PCT']);
    assert.equal(mediated.weakest, 'HYPOTHESIS');
    for (const p of paths) {
      assert.match(p.statement, /does not multiply confidences/);
      assert.ok(!('probability' in p) && !('score' in p));
    }
    const direct2 = unwrap(await s.causal.listClaims(s.scope, { causeKey: 'EXPEDITED_TRANSFER', effectKey: 'GROSS_MARGIN_PCT' }), 'no direct claim');
    assert.equal(direct2.length, 0, 'the chain was not collapsed into a direct claim');
  });

  it('confounders are explicit on the claim they threaten', () => {
    assert.equal(c.D1.revision.confounders[0].variableKey, 'MARKET_DEMAND');
    assert.match(c.D1.revision.confounders[0].note, /drives both/);
  });
});

describe('feedback loops', () => {
  it('a causal cycle is allowed and kept', async () => {
    const loop = [c.L1, c.L2, c.L3, c.L4];
    assert.equal(loop[3].claim.effectKey, loop[0].claim.causeKey, 'the loop closes');
  });

  it('traversal needs a maxDepth, terminates, and marks the edge that closes the loop', async () => {
    assert.equal(expectFail(await s.causal.traverse(s.scope, { from: 'SERVICE_FAILURE', direction: 'DOWNSTREAM' }), 'no depth').code, 'causal.traversal_unbounded');
    expectFail(await s.causal.traverse(s.scope, { from: 'SERVICE_FAILURE', direction: 'DOWNSTREAM', maxDepth: 1000 }), 'unbounded depth');
    const t = unwrap(await s.causal.traverse(s.scope, { from: 'SERVICE_FAILURE', direction: 'DOWNSTREAM', maxDepth: 8 }), 'loop');
    assert.equal(t.edges.length, 4, 'each claim once');
    assert.equal(t.cycles, 1);
    assert.ok(t.edges.find((x) => x.from === 'COST_CUTTING').closesCycle);
    const short = unwrap(await s.causal.traverse(s.scope, { from: 'SERVICE_FAILURE', direction: 'DOWNSTREAM', maxDepth: 2 }), 'short');
    assert.equal(short.edges.length, 2);
    assert.equal(short.truncated, true);
    const paths = unwrap(await s.causal.paths(s.scope, { from: 'SERVICE_FAILURE', to: 'SERVICE_FAILURE', maxDepth: 8 }), 'loop paths');
    assert.equal(paths.length, 0, 'a loop is not a path');
  });
});
