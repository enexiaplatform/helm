/**
 * Causal knowledge and who may read it (ADR-0026 §7): the kernel statement of
 * helm_private.can_see_causal_claim(). A claim is read whole or not at all —
 * its unit audience, every class it carries (its own, its variables', its
 * evidence's) and every decision it rests on. Visibility is not authority.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { causalAttention, claimsReferencing } from '../src/index.ts';
import { ADMIN, DEMO_UNITS, MEMBERSHIP, UNITS, USERS, buildCausalStory, unwrap } from './harness.mjs';

let s;
let restricted;
let strategic;
const clearanceOf = (userId, sensitivity) => ({ id: `cl-${userId}-${sensitivity}`, orgId: 'org', userId, sensitivity, validFrom: '2026-01-01T00:00:00.000Z', validTo: null, reason: 'test', grantedBy: ADMIN, recordedAt: '2026-01-01T00:00:00.000Z' });
const viewer = (userId, clearances = [], orgRole = 'member') => ({ userId, orgRole, memberUnitIds: MEMBERSHIP[userId] ?? [], clearances: clearances.map((c) => clearanceOf(userId, c)) });
const allVisible = { decisionVisible: () => true };
const ids = (p) => new Set(p.claims.map((v) => v.claim.id));

before(async () => {
  s = await buildCausalStory();
  const pharma = { kind: 'ANCHORED', anchors: [{ entityId: s.governance.entities.buPharma.entityId, label: 'Pharma BU', dimension: '' }] };
  restricted = unwrap(
    await s.causal.createClaim(s.scope, {
      causeKey: 'DELIVERY_SPEED',
      effectKey: 'CUSTOMER_SATISFACTION',
      relationshipType: 'INCREASES',
      scope: pharma,
      visibility: 'RESTRICTED',
      grantedUnitIds: [UNITS.pharma],
      authoredByLabel: 'Pharma analyst (demo)',
      statement: 'Pharma-only belief.',
      rationale: 'test',
    }),
    'restricted',
  );
  strategic = unwrap(
    await s.causal.createClaim(s.scope, {
      causeKey: 'MARKET_DEMAND',
      effectKey: 'SALES_VOLUME',
      relationshipType: 'INCREASES',
      scope: pharma,
      authoredByLabel: 'GM (demo)',
      statement: 'A belief whose only evidence is strategic.',
      rationale: 'test',
    }),
    'strategic claim',
  );
  const e = unwrap(
    await s.causal.recordEvidence(s.scope, {
      type: 'EXTERNAL_RESEARCH',
      statement: 'Board paper on a market exit (restricted).',
      assessedStrength: 'MEDIUM',
      strengthRationale: 'test',
      provenance: { sourceSystem: 'manual', sourceReference: 'board paper', method: 'EXTERNAL', assertedByLabel: 'GM (demo)' },
      sensitivity: 'STRATEGIC_RESTRICTED',
    }),
    'strategic evidence',
  );
  unwrap(await s.causal.supportClaim(s.scope, strategic.claim.id, e.id, 'test'), 'link');
});

describe('unit restriction', () => {
  it('a claim restricted to Pharma is read by Pharma and by the Country GM above it, not by Industrial', async () => {
    const pharma = unwrap(await s.causal.projectForViewer(s.scope, viewer(USERS.pharmaAnalyst), DEMO_UNITS, allVisible), 'pharma');
    const gm = unwrap(await s.causal.projectForViewer(s.scope, viewer(USERS.countryGM, ['FINANCIAL_SENSITIVE']), DEMO_UNITS, allVisible), 'gm');
    const industrial = unwrap(await s.causal.projectForViewer(s.scope, viewer(USERS.industrialHead), DEMO_UNITS, allVisible), 'industrial');
    assert.ok(ids(pharma).has(restricted.claim.id));
    assert.ok(ids(gm).has(restricted.claim.id));
    assert.ok(!ids(industrial).has(restricted.claim.id));
    assert.ok(industrial.withheld > 0);
    assert.match(industrial.statement, /withheld whole — its title too/);
  });
});

describe('sensitivity inherited from variables and evidence', () => {
  it('a claim about fulfilment cost is FINANCIAL: withheld from a viewer without that clearance', async () => {
    const uncleared = unwrap(await s.causal.projectForViewer(s.scope, viewer(USERS.industrialHead), DEMO_UNITS, allVisible), 'uncleared');
    assert.ok(!ids(uncleared).has(s.causalStory.claims.H1.claim.id));
    const cleared = unwrap(await s.causal.projectForViewer(s.scope, viewer(USERS.financeDirector, ['FINANCIAL_SENSITIVE']), DEMO_UNITS, allVisible), 'cleared');
    assert.ok(ids(cleared).has(s.causalStory.claims.H1.claim.id));
  });

  it('STRATEGIC evidence makes its claim STRATEGIC: the GM without that clearance cannot read the claim, an admin can', async () => {
    const gm = unwrap(await s.causal.projectForViewer(s.scope, viewer(USERS.countryGM, ['FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL']), DEMO_UNITS, allVisible), 'gm');
    assert.ok(!ids(gm).has(strategic.claim.id), 'a general claim title, restricted by what supports it');
    const admin = unwrap(await s.causal.projectForViewer(s.scope, viewer(ADMIN, [], 'admin'), DEMO_UNITS, allVisible), 'admin');
    assert.ok(ids(admin).has(strategic.claim.id));
    assert.equal(admin.withheld, 0);
  });
});

describe('decisions a claim rests on', () => {
  it('C3 names the Rohto decision: a viewer who cannot see that decision cannot see the claim, title included', async () => {
    const c3 = s.causalStory.claims.C3.claim.id;
    const blind = { decisionVisible: (id) => id !== s.story.decisionId };
    const hidden = unwrap(await s.causal.projectForViewer(s.scope, viewer(USERS.pharmaAnalyst), DEMO_UNITS, blind), 'blind');
    assert.ok(!ids(hidden).has(c3));
    const seen = unwrap(await s.causal.projectForViewer(s.scope, viewer(USERS.pharmaAnalyst), DEMO_UNITS, allVisible), 'seen');
    assert.ok(ids(seen).has(c3));
  });

  it('visibility is not authority: the causal runtime never consults the authority engine', async () => {
    const { readFileSync } = await import('node:fs');
    const src = ['runtime.ts', 'integration.ts', 'policy.ts'].map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')).join('\n');
    assert.doesNotMatch(src, /evaluateAuthority|createAuthorityRuntime|recordApproval|\.evaluate\(/);
  });
});

describe('decision and scenario integration', () => {
  it('the claims resting on a decision are found by reference; the decision runtime is not touched', async () => {
    const refs = unwrap(await claimsReferencing(s.causal, s.scope, { kind: 'DECISION', id: s.story.decisionId }), 'refs');
    assert.deepEqual(refs.map((v) => v.claim.id), [s.causalStory.claims.C3.claim.id]);
  });

  it('a decision assumption resting on an unsupported causal belief is attention, by named rule, unscored', async () => {
    const views = unwrap(await s.causal.listClaims(s.scope), 'claims');
    const attention = causalAttention(views, s.assumptions);
    const onC3 = attention.find((a) => a.claimId === s.causalStory.claims.C3.claim.id);
    assert.equal(onC3.rule, 'DECISION_ASSUMPTION_CAUSALLY_UNSUPPORTED@1');
    assert.match(onC3.statement, /on-time delivery/);
    const temporal = attention.find((a) => a.claimId === s.causalStory.claims.H4.claim.id);
    assert.equal(temporal.rule, 'TEMPORAL_CONFLICT_IN_EVIDENCE@1');
    for (const a of attention) assert.ok(!('score' in a) && !('priority' in a) && !('rank' in a));
  });
});
