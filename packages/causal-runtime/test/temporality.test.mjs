/**
 * What management believed, and when (ADR-0026 §5): the causal graph is
 * reconstructed at a lens from append-only records, never copied, and evidence
 * learned later never rewrites earlier knowledge.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MERIDIAN_CAUSAL_TIMES as T } from '../src/index.ts';
import { at, buildCausalStory, expectFail, unwrap } from './harness.mjs';

let s;
let c;
before(async () => {
  s = await buildCausalStory();
  c = s.causalStory.claims;
});

describe('historical causal knowledge', () => {
  it('H1 was a HYPOTHESIS on 19 Jan (judgement only) and is SUPPORTED after SCM\'s evidence of 20 Jan', async () => {
    const t1 = unwrap(await s.causal.getClaim(s.scope, c.H1.claim.id, at(T.beforeScmEvidence)), 'T1');
    assert.equal(t1.evaluation.status, 'HYPOTHESIS');
    assert.equal(t1.evaluation.confidence, 'LOW');
    assert.equal(t1.evaluation.counts.supporting, 1);
    const t2 = unwrap(await s.causal.getClaim(s.scope, c.H1.claim.id), 'T2');
    assert.equal(t2.evaluation.status, 'SUPPORTED');
    // And T1 is still T1 afterwards.
    const again = unwrap(await s.causal.getClaim(s.scope, c.H1.claim.id, at(T.beforeScmEvidence)), 'T1 again');
    assert.deepEqual(again.evaluation, t1.evaluation);
  });

  it('the claim history records each moment the belief changed', async () => {
    const ex = unwrap(await s.causal.explainClaim(s.scope, c.H1.claim.id), 'explain');
    const statuses = ex.history.map((h) => h.status);
    assert.equal(statuses[0], 'HYPOTHESIS');
    assert.equal(statuses[statuses.length - 1], 'SUPPORTED');
    assert.ok(ex.history.some((h) => /REPEATED_PATTERN/.test(h.event)));
  });

  it('a claim recorded after the knowledge boundary does not exist at that lens', async () => {
    const r = await s.causal.getClaim(s.scope, c.D1.claim.id, at(T.beforeScmEvidence));
    assert.equal(expectFail(r, 'D1 before it existed').code, 'causal.not_known_at_lens');
    const view = unwrap(await s.causal.viewAt(s.scope, at(T.beforeScmEvidence)), 'view');
    assert.ok(!view.claims.some((v) => v.claim.id === c.D1.claim.id));
    assert.ok(view.claims.some((v) => v.claim.id === c.H1.claim.id));
  });

  it('the causal view is reconstructed, not stored: the same lens gives the same view', async () => {
    const a = unwrap(await s.causal.viewAt(s.scope, at(T.discountSupported)), 'a');
    const b = unwrap(await s.causal.viewAt(s.scope, at(T.discountSupported)), 'b');
    assert.deepEqual(a.claims.map((v) => [v.claim.id, v.evaluation.status]), b.claims.map((v) => [v.claim.id, v.evaluation.status]));
  });

  it('a link is knowledge too: evidence that already existed counts only from the moment it was linked', async () => {
    const claim = unwrap(await s.causal.createClaim(s.scope, { causeKey: 'DELIVERY_SPEED', effectKey: 'CUSTOMER_SATISFACTION', relationshipType: 'INCREASES', scope: { kind: 'ANCHORED', anchors: [{ entityId: s.governance.entities.buPharma.entityId, label: 'Pharma BU', dimension: '' }] }, authoredByLabel: 'test', statement: 'late link', rationale: 'r' }), 'claim');
    const beforeLink = s.clock.now().toISOString();
    unwrap(await s.causal.supportClaim(s.scope, claim.claim.id, s.causalStory.evidence.E3.id, 'linked later'), 'link');
    const then = unwrap(await s.causal.getClaim(s.scope, claim.claim.id, at(beforeLink)), 'then');
    assert.equal(then.evaluation.counts.supporting, 0);
  });

  it('refuses a knowledge boundary in the future', async () => {
    const future = new Date(s.clock.peek().getTime() + 86_400_000).toISOString();
    assert.equal(expectFail(await s.causal.viewAt(s.scope, at(future)), 'future').code, 'causal.knowledge_in_future');
  });

  it('reuses the twin\'s lens: at S2\'s knowledge boundary no causal claim yet existed', async () => {
    const lens = s.story.S2.snapshot.spec.lens;
    const view = unwrap(await s.causal.viewAt(s.scope, lens), 'at S2');
    assert.equal(view.claims.length, 0, 'the causal investigation started the day after the Q4 close');
  });

  it('the applicable period is business time: H4 is about Q4 2026', async () => {
    const inQ4 = unwrap(await s.causal.getClaim(s.scope, c.H4.claim.id, { effectiveAsOf: '2026-11-15T00:00:00.000Z', recordedThrough: T.coincidence }), 'Q4');
    assert.equal(inQ4.evaluation.applicableAtEffective, true);
    const later = unwrap(await s.causal.getClaim(s.scope, c.H4.claim.id, { effectiveAsOf: '2027-02-01T00:00:00.000Z', recordedThrough: T.coincidence }), 'Feb');
    assert.equal(later.evaluation.applicableAtEffective, false);
  });
});

describe('claims are versioned, never rewritten', () => {
  it('a revision supersedes the wording from its record time; the earlier revision stays readable', async () => {
    const before = s.clock.now().toISOString();
    const revised = unwrap(await s.causal.reviseClaim(s.as(s.causalStory.claims.C3.claim.authoredBy), c.C3.claim.id, { statement: 'Faster delivery improves Rohto\'s on-time service measure.' }), 'revise');
    assert.equal(revised.revision.revision, 2);
    const then = unwrap(await s.causal.getClaim(s.scope, c.C3.claim.id, at(before)), 'then');
    assert.equal(then.revision.revision, 1);
    assert.equal(then.revision.statement, 'Faster delivery improves Rohto\'s service outcome.');
  });

  it('only its author or an admin retires a claim; a retired claim takes no revision', async () => {
    const member = (userId) => ({ ...s.as(userId), role: 'member' });
    const finance = member(s.causalStory.claims.H2.claim.authoredBy);
    const other = member(s.causalStory.claims.D1.claim.authoredBy);
    expectFail(await s.causal.retireClaim(other, c.H2.claim.id, 'not mine'), 'someone else retires');
    const retired = unwrap(await s.causal.retireClaim(finance, c.H2.claim.id, 'Superseded by the invoice search.'), 'retire');
    assert.equal(retired.evaluation.status, 'RETIRED');
    expectFail(await s.causal.reviseClaim(finance, c.H2.claim.id, { statement: 'after' }), 'revise after retirement');
  });
});
