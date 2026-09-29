/**
 * verify:causal-scope — causality is not global by default.
 *
 * A claim supported for Vietnam Pharma / Rohto is OUTSIDE Thailand Pharma and
 * the Industrial BU, APPLIES in its own context and only APPLIES_TO_PART of
 * Vietnam; an unscoped claim is refused, an enterprise-wide one needs a stated
 * reason; conditions are part of a claim's identity; claims are never
 * de-duplicated on cause and effect alone.
 */

import { buildCausalStory, contract, unwrap } from './lib/causalStack.mjs';

const c = contract('verify:causal-scope');
const s = await buildCausalStory();
const k = s.causalStory.claims;
const e = s.governance.entities;
const verdict = async (claimId, ctx) => unwrap(await s.causal.applicability(s.scope, claimId, ctx), 'applicability').verdict;

c.check('outside', (await verdict(k.H1.claim.id, e.buThPharma.entityId)) === 'OUTSIDE', 'a Vietnam Pharma claim applies in Thailand Pharma');
c.check('outside', (await verdict(k.H1.claim.id, e.buIndustrial.entityId)) === 'OUTSIDE', 'a Vietnam Pharma claim applies in the Industrial BU');
c.check('outside', (await verdict(k.D1.claim.id, e.buPharma.entityId)) === 'OUTSIDE', 'an Industrial claim applies in Pharma');
c.check('applies', (await verdict(k.H1.claim.id, [e.buPharma.entityId, e.rohto.entityId])) === 'APPLIES', 'a claim does not apply in its own context');
c.check('no-upward', (await verdict(k.H1.claim.id, e.vn.entityId)) === 'APPLIES_TO_PART', 'a Pharma claim applies to all of Vietnam');
const th = unwrap(await s.causal.claimsFor(s.scope, { effectKey: 'FULFILMENT_COST', context: e.buThPharma.entityId }), 'Thailand');
c.check('outside', th.applicable.length === 0, `${th.applicable.length} fulfilment-cost claims are presented as applicable in Thailand Pharma`);

const base = { causeKey: 'PRICE_DISCOUNT', effectKey: 'SALES_VOLUME', relationshipType: 'INCREASES', authoredByLabel: 'contract', statement: 's', rationale: 'r' };
const unscoped = await s.causal.createClaim(s.scope, { ...base, scope: { kind: 'ANCHORED', anchors: [] } });
c.check('scoped', !unscoped.ok && unscoped.error.code === 'causal.unscoped_claim', 'an unscoped claim was accepted');
const unjustified = await s.causal.createClaim(s.scope, { ...base, scope: { kind: 'ENTERPRISE_WIDE', justification: 'yes' } });
c.check('scoped', !unjustified.ok, 'an enterprise-wide claim was accepted without a reason');
const causes = await s.causal.createClaim(s.scope, { ...base, relationshipType: 'CAUSES', scope: { kind: 'ANCHORED', anchors: [{ entityId: e.buIndustrial.entityId, label: 'Industrial BU', dimension: '' }] } });
c.check('vocabulary', !causes.ok, 'an unconditional CAUSES was accepted');

c.check('conditions', k.H1.claim.conditions.length === 1 && /flown/.test(k.H1.claim.conditions[0].statement), 'the H1 condition is not part of the claim');
const twin = unwrap(await s.causal.createClaim(s.scope, { ...base, scope: { kind: 'ANCHORED', anchors: [{ entityId: e.buIndustrial.entityId, label: 'Industrial BU', dimension: '' }] }, conditions: [{ statement: 'WHEN demand is flat', refs: [] }] }), 'same cause and effect');
c.check('identity', twin.claim.id !== k.D1.claim.id, 'a claim with the same cause and effect was merged into D1');
c.check('external-validity', /external validity unknown/.test(k.H1.revision.externalValidity), 'H1 does not state that its external validity is unknown');

c.finish('Vietnam Pharma claims OUTSIDE Thailand Pharma and Industrial, APPLIES_TO_PART of Vietnam; no unscoped claim, no CAUSES; conditions are identity; no de-duplication');
