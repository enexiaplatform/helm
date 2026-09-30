/**
 * verify:twin-security — who may read which management state (ADR-0025).
 * The kernel statement of the RLS the migration installs; the live-database
 * proof (24 refusals, 12 controls) is in docs/architecture/layers/management-twin.md.
 *
 *   1. A BU-scoped snapshot is invisible across BUs; the Country GM reads the
 *      country and both BUs; nobody reads up the tree.
 *   2. Restricted financial state follows its class per item: an uncleared
 *      reader is told how many items were withheld, nothing disappears silently;
 *      an expired clearance is none; classes are compartments.
 *   3. Restricted scenario data does not leak: binding captures a scenario.
 *   4. Visibility and authority stay independent, both ways.
 *   5. The twin relies on the trusted verdict: a client-computed one degrades it.
 */

import { MERIDIAN_DEMO_UNITS } from '@helm/authority-runtime';
import { canSeeScenario, isCleared } from '@helm/twin-runtime';
import { ADMIN, MEMBERSHIP, USERS, buildStory, contract, itemsOf, unwrap } from './lib/twinStack.mjs';

const { check, finish } = contract('verify:twin-security');
const units = MERIDIAN_DEMO_UNITS;
const s = await buildStory();
const { story } = s;
for (const [userId, sensitivity, validTo] of [
  [USERS.countryGM, 'FINANCIAL_SENSITIVE', null],
  [USERS.financeDirector, 'FINANCIAL_SENSITIVE', null],
  [USERS.pharmaAnalyst, 'FINANCIAL_SENSITIVE', '2026-06-30T00:00:00.000Z'],
]) {
  unwrap(await s.twin.grantClearance(s.scope, { userId, sensitivity, validFrom: '2026-01-01T00:00:00.000Z', validTo, reason: 'contract clearance' }), 'clearance');
}
const clearances = unwrap(await s.twin.listClearances(s.scope), 'clearances');
const viewer = (userId, orgRole = 'member') => ({ userId, orgRole, memberUnitIds: MEMBERSHIP[userId] ?? [], clearances: clearances.filter((c) => c.userId === userId) });
const sees = async (snap, v) => (await s.twin.projectForViewer(s.scope, snap.snapshot.id, v, units)).ok;

// 1
check('scope', !(await sees(story.industrialS2, viewer(USERS.pharmaAnalyst))), 'Pharma reads the Industrial snapshot');
check('scope', !(await sees(story.pharmaS2, viewer(USERS.industrialHead))), 'Industrial reads the Pharma snapshot');
check('scope', await sees(story.pharmaS2, viewer(USERS.pharmaAnalyst)), 'Pharma cannot read its own snapshot');
for (const snap of [story.S2, story.pharmaS2, story.industrialS2]) check('scope', await sees(snap, viewer(USERS.countryGM)), `the Country GM cannot read ${snap.snapshot.spec.label}`);
check('scope', !(await sees(story.S2, viewer(USERS.pharmaAnalyst))), 'a BU member reads the country-wide snapshot above them');

// 2
const analyst = unwrap(await s.twin.projectForViewer(s.scope, story.pharmaS2.snapshot.id, viewer(USERS.pharmaAnalyst), units), 'analyst');
check('sensitivity', analyst.items.every((i) => i.sensitivity === 'GENERAL_MANAGEMENT'), 'an uncleared reader sees a restricted item');
check('sensitivity', analyst.withheld.some((w) => w.sensitivity === 'FINANCIAL_SENSITIVE' && w.count > 0) && /withheld/.test(analyst.statement), 'withheld financial items are not stated');
check('sensitivity', analyst.items.length + analyst.withheld.reduce((n, w) => n + w.count, 0) === story.pharmaS2.items.length, 'items disappeared silently');
check('sensitivity', !isCleared(viewer(USERS.pharmaAnalyst), 'FINANCIAL_SENSITIVE', '2027-01-12T00:00:00.000Z'), 'an expired clearance still clears');
const gmView = unwrap(await s.twin.projectForViewer(s.scope, story.S2.snapshot.id, viewer(USERS.countryGM), units), 'GM');
check('sensitivity', gmView.items.some((i) => i.state.metricKey === 'GrossMarginPct') && gmView.withheld.some((w) => w.sensitivity === 'COMMERCIAL_CONFIDENTIAL'), 'financial clearance opened commercial items, or did not open margins');
const admin = unwrap(await s.twin.projectForViewer(s.scope, story.S2.snapshot.id, { ...viewer(ADMIN, 'admin'), clearances: [] }, units), 'admin');
check('sensitivity', admin.withheld.length === 0, 'an org admin is withheld items');
check('sensitivity', itemsOf(story.CF1, 'VALUE').find((v) => v.state.metricKey === 'GrossMarginPct')?.sensitivity === 'FINANCIAL_SENSITIVE', 'a committed future\'s margin lost its class');

// 3
const base = { createdBy: USERS.commercialDirector, visibility: 'ORG_WIDE', grantedUnitIds: [], boundDecisions: [] };
const bound = { ...base, boundDecisions: [{ createdBy: USERS.commercialDirector, grantedUnitIds: ['unit-vn-pharma'] }] };
check('scenario', canSeeScenario(viewer(USERS.industrialHead), base, units).visible, 'an unbound org-wide scenario is hidden');
check('scenario', !canSeeScenario(viewer(USERS.industrialHead), bound, units).visible, 'a scenario bound to a Pharma decision is read by Industrial');
check('scenario', canSeeScenario(viewer(USERS.countryGM), bound, units).visible && canSeeScenario(viewer(USERS.pharmaAnalyst), bound, units).visible, 'a captured scenario is hidden from its decision\'s audience');

// 4
const fdSeesPharma = await sees(story.pharmaS2, viewer(USERS.financeDirector));
check('independence', !fdSeesPharma, 'a financial clearance widened visibility');
const t = await buildStory();
const evals = unwrap(await t.authority.listEvaluations(t.scope, { decisionId: t.story.decisionId }), 'evaluations');
const req = unwrap(await t.authorityStore.listRequiredApprovals(t.scope, { evaluationId: evals[0].id }), 'requirements')[0];
const analystApproves = await t.trusted.handle({ userId: USERS.pharmaAnalyst }, { op: 'approve', orgId: t.scope.orgId, requiredApprovalId: req.id, comments: 'looks fine' });
check('independence', analystApproves.status !== 200, 'seeing a commitment conferred authority to approve it');

// 5
unwrap(await t.authority.evaluate(t.scope, t.story.commitmentId), 'client evaluation');
const after = unwrap(await t.twin.buildSnapshot(t.as(USERS.countryGM), { kind: 'CURRENT', label: 'after a client verdict', scope: t.story.scopes.vietnam, periods: ['2026-Q4'] }), 'snapshot');
check('trusted', itemsOf(after, 'GOVERNANCE')[0]?.state.evaluator === 'CLIENT_RUNTIME' && after.snapshot.completenessReasons.some((r) => r.code === 'AUTHORITY_VERDICT_UNTRUSTED'), 'the twin relied on a client-computed verdict');

finish('BU snapshots scoped both ways; per-item sensitivity with nothing silently removed; captured scenarios; visibility ≠ authority; trusted verdicts only');
