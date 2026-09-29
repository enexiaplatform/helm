/**
 * verify:causal-security — causal knowledge is read whole, or not at all.
 *
 * The kernel statement of helm_private.can_see_causal_claim(): a claim
 * restricted to Pharma is not read by Industrial; a claim about fulfilment cost
 * inherits the FINANCIAL class; a claim whose evidence is STRATEGIC is
 * STRATEGIC; a claim resting on a decision the viewer cannot see is withheld
 * with its title; admins read everything; visibility is not authority. And the
 * SQL twin of every one of those rules exists.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADMIN, DEMO_UNITS, MEMBERSHIP, UNITS, USERS, buildCausalStory, contract, unwrap } from './lib/causalStack.mjs';

const c = contract('verify:causal-security');
const s = await buildCausalStory();
const pharma = { kind: 'ANCHORED', anchors: [{ entityId: s.governance.entities.buPharma.entityId, label: 'Pharma BU', dimension: '' }] };
const clearance = (userId, sensitivity) => ({ id: `${userId}-${sensitivity}`, orgId: 'o', userId, sensitivity, validFrom: '2026-01-01T00:00:00.000Z', validTo: null, reason: 'contract', grantedBy: ADMIN, recordedAt: '2026-01-01T00:00:00.000Z' });
const viewer = (userId, classes = [], orgRole = 'member') => ({ userId, orgRole, memberUnitIds: MEMBERSHIP[userId] ?? [], clearances: classes.map((k) => clearance(userId, k)) });
const see = async (v, facts = { decisionVisible: () => true }) => new Set(unwrap(await s.causal.projectForViewer(s.scope, v, DEMO_UNITS, facts), 'project').claims.map((x) => x.claim.id));

const restricted = unwrap(await s.causal.createClaim(s.scope, { causeKey: 'DELIVERY_SPEED', effectKey: 'CUSTOMER_SATISFACTION', relationshipType: 'INCREASES', scope: pharma, visibility: 'RESTRICTED', grantedUnitIds: [UNITS.pharma], authoredByLabel: 'contract', statement: 'restricted', rationale: 'r' }), 'restricted');
const strategic = unwrap(await s.causal.createClaim(s.scope, { causeKey: 'MARKET_DEMAND', effectKey: 'SALES_VOLUME', relationshipType: 'INCREASES', scope: pharma, authoredByLabel: 'contract', statement: 'general title', rationale: 'r' }), 'strategic');
const secret = unwrap(await s.causal.recordEvidence(s.scope, { type: 'EXTERNAL_RESEARCH', statement: 'board paper', assessedStrength: 'MEDIUM', strengthRationale: 'x', provenance: { sourceSystem: 'manual', sourceReference: 'board', method: 'EXTERNAL', assertedByLabel: 'x' }, sensitivity: 'STRATEGIC_RESTRICTED' }), 'secret');
unwrap(await s.causal.supportClaim(s.scope, strategic.claim.id, secret.id, 'x'), 'link');

c.check('bu-restriction', (await see(viewer(USERS.pharmaAnalyst))).has(restricted.claim.id), 'Pharma cannot read a claim restricted to Pharma');
c.check('bu-restriction', !(await see(viewer(USERS.industrialHead))).has(restricted.claim.id), 'Industrial reads a claim restricted to Pharma');
c.check('bu-restriction', (await see(viewer(USERS.countryGM, ['FINANCIAL_SENSITIVE']))).has(restricted.claim.id), 'the Country GM above Pharma cannot read it');
c.check('sensitivity', !(await see(viewer(USERS.industrialHead))).has(s.causalStory.claims.H1.claim.id), 'an uncleared viewer reads a claim about fulfilment cost');
c.check('sensitivity', (await see(viewer(USERS.financeDirector, ['FINANCIAL_SENSITIVE']))).has(s.causalStory.claims.H1.claim.id), 'a cleared viewer cannot read H1');
c.check('evidence-restricts-claim', !(await see(viewer(USERS.countryGM, ['FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL']))).has(strategic.claim.id), 'a claim resting on STRATEGIC evidence is readable without that clearance');
c.check('admin', (await see(viewer(ADMIN, [], 'admin'))).has(strategic.claim.id), 'an admin cannot read every claim');
const blind = { decisionVisible: (id) => id !== s.story.decisionId };
c.check('decision-capture', !(await see(viewer(USERS.pharmaAnalyst), blind)).has(s.causalStory.claims.C3.claim.id), 'a claim resting on an invisible decision is readable');
const withheld = unwrap(await s.causal.projectForViewer(s.scope, viewer(USERS.industrialHead), DEMO_UNITS, { decisionVisible: () => true }), 'withheld');
c.check('stated', withheld.withheld > 0 && /withheld whole/.test(withheld.statement), 'withheld claims are not stated');

const src = ['runtime.ts', 'integration.ts', 'policy.ts', 'scope.ts'].map((f) => readFileSync(join(process.cwd(), 'packages', 'causal-runtime', 'src', f), 'utf8')).join('\n');
c.check('visibility-not-authority', !/evaluateAuthority|createAuthorityRuntime|recordApproval|\.evaluate\(/.test(src), 'the causal runtime consults the authority engine');

const sql = readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260930090000_helm_causal_graph.sql'), 'utf8');
for (const [rule, re] of [
  ['sql-twin', /FUNCTION helm_private\.can_see_causal_claim/],
  ['sql-twin', /FUNCTION helm_private\.causal_claim_classes/],
  ['sql-twin', /FUNCTION helm_private\.causal_claim_decisions/],
  ['sql-twin', /FUNCTION helm_private\.can_see_causal_evidence/],
  ['sql-twin', /FUNCTION helm_private\.causal_claim_row_visible/],
  ['sql-twin', /CREATE POLICY "Scoped read causal evidence"[\s\S]*?causal_evidence_row_visible\(org_id, sensitivity, refs\)/],
  ['sql-twin', /CREATE POLICY "Members record causal evidence"[\s\S]*?has_clearance\(org_id, sensitivity\)/],
  ['sql-twin', /CREATE POLICY "Scoped read causal questions"[\s\S]*?causal_question_row_visible\(org_id, asked_by, granted_unit_ids, target\)/],
]) c.check(rule, re.test(sql), `the database lacks ${re}`);

c.finish('Pharma-restricted claim hidden from Industrial, read by the GM above; FINANCIAL and STRATEGIC classes inherited from variables and evidence; decision capture; admins read all; visibility ≠ authority; SQL twin present');
