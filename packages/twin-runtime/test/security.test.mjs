/**
 * Visibility and sensitivity (ADR-0025), and their independence from authority.
 * The kernel statement of what RLS enforces server-side; the live-database
 * proof is recorded in docs/architecture/layers/management-twin.md.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MERIDIAN_DEMO_UNITS } from '@helm/authority-runtime';
import { canSeeScenario, containerSensitivity, isCleared } from '../src/index.ts';
import { ADMIN, MEMBERSHIP, USERS, buildStory, itemsOf, unwrap } from './harness.mjs';

const units = MERIDIAN_DEMO_UNITS;
let s;
let clearances;
before(async () => {
  s = await buildStory();
  const grant = async (userId, sensitivity, validTo = null) =>
    unwrap(await s.twin.grantClearance(s.scope, { userId, sensitivity, validFrom: '2026-01-01T00:00:00.000Z', validTo, reason: 'demo clearance' }), 'clearance');
  await grant(USERS.countryGM, 'FINANCIAL_SENSITIVE');
  await grant(USERS.countryGM, 'COMMERCIAL_CONFIDENTIAL');
  await grant(USERS.financeDirector, 'FINANCIAL_SENSITIVE');
  await grant(USERS.pharmaAnalyst, 'FINANCIAL_SENSITIVE', '2026-06-30T00:00:00.000Z'); // expired before the story
  clearances = unwrap(await s.twin.listClearances(s.scope), 'clearances');
});

const viewer = (userId, orgRole = 'member') => ({ userId, orgRole, memberUnitIds: MEMBERSHIP[userId] ?? [], clearances: clearances.filter((c) => c.userId === userId) });
const project = (snapshot, v) => s.twin.projectForViewer(s.scope, snapshot.snapshot.id, v, units);

describe('scoped snapshots follow the unit tree', () => {
  it('a Pharma BU snapshot is not visible to the Industrial BU, and the reverse', async () => {
    const pharmaSeesIndustrial = await project(s.story.industrialS2, viewer(USERS.pharmaAnalyst));
    assert.equal(pharmaSeesIndustrial.ok, false);
    assert.equal(pharmaSeesIndustrial.error.code, 'twin.not_visible');
    const industrialSeesPharma = await project(s.story.pharmaS2, viewer(USERS.industrialHead));
    assert.equal(industrialSeesPharma.ok, false);
    assert.equal((await project(s.story.pharmaS2, viewer(USERS.pharmaAnalyst))).ok, true, 'Pharma reads its own');
    assert.equal((await project(s.story.industrialS2, viewer(USERS.industrialHead))).ok, true, 'Industrial reads its own');
  });

  it('the Country GM reads the country snapshot and both BU snapshots under it', async () => {
    for (const snap of [s.story.S2, s.story.pharmaS2, s.story.industrialS2]) {
      assert.equal((await project(snap, viewer(USERS.countryGM))).ok, true, snap.snapshot.spec.label);
    }
  });

  it('a BU member does not read the country-wide snapshot above them', async () => {
    const r = await project(s.story.S2, viewer(USERS.pharmaAnalyst));
    assert.equal(r.ok, false, 'visibility runs down the tree, never up');
  });
});

describe('restricted financial state follows sensitivity, per item', () => {
  it('an uncleared reader sees the Pharma structure and decisions, and is told how many financial items were withheld', async () => {
    const p = unwrap(await project(s.story.pharmaS2, viewer(USERS.pharmaAnalyst)), 'analyst');
    assert.ok(p.items.length > 0);
    assert.ok(p.items.every((i) => i.sensitivity === 'GENERAL_MANAGEMENT'));
    assert.ok(p.items.some((i) => i.kind === 'DECISION'), 'the decision is visible');
    assert.ok(!p.items.some((i) => i.kind === 'VALUE' && i.state.metricKey === 'GrossMarginPct'), 'the margin is not');
    const financial = p.withheld.find((w) => w.sensitivity === 'FINANCIAL_SENSITIVE');
    assert.ok(financial.count > 0);
    assert.match(p.statement, /withheld/);
    assert.equal(
      p.items.length + p.withheld.reduce((n, w) => n + w.count, 0),
      s.story.pharmaS2.items.length,
      'nothing disappears silently: shown + withheld = the snapshot',
    );
  });

  it('an expired clearance is no clearance', () => {
    assert.equal(isCleared(viewer(USERS.pharmaAnalyst), 'FINANCIAL_SENSITIVE', '2027-01-12T00:00:00.000Z'), false);
    assert.equal(isCleared(viewer(USERS.pharmaAnalyst), 'FINANCIAL_SENSITIVE', '2026-03-01T00:00:00.000Z'), true);
  });

  it('classes are compartments: financial clearance opens margins, not commercial terms', async () => {
    const p = unwrap(await project(s.story.S2, viewer(USERS.countryGM)), 'GM');
    assert.ok(p.items.some((i) => i.state.metricKey === 'GrossMarginPct'));
    assert.ok(p.items.some((i) => i.state.metricKey === 'ExpectedRevenue'));
    assert.ok(p.withheld.some((w) => w.sensitivity === 'STRATEGIC_RESTRICTED'), 'the GM holds no strategic clearance');
    const admin = unwrap(await project(s.story.S2, { ...viewer(ADMIN, 'admin'), clearances: [] }), 'admin');
    assert.equal(admin.withheld.length, 0, 'org admins hold every class');
  });

  it('a container\'s label is derived from its contents, never declared', () => {
    assert.deepEqual([...s.story.S2.snapshot.sensitivityClasses], containerSensitivity(s.story.S2.items));
    const gm = itemsOf(s.story.CF1, 'VALUE').find((v) => v.state.metricKey === 'GrossMarginPct');
    assert.equal(gm.sensitivity, 'FINANCIAL_SENSITIVE', 'a committed future called "Reallocate" still carries its margin\'s class');
  });

  it('only an org admin grants a clearance, and GENERAL_MANAGEMENT needs none', async () => {
    const refused = await s.twin.grantClearance({ ...s.as(USERS.countryGM), role: 'member' }, { userId: USERS.pharmaAnalyst, sensitivity: 'FINANCIAL_SENSITIVE', validFrom: '2026-01-01T00:00:00.000Z', validTo: null, reason: 'self-service' });
    assert.equal(refused.ok, false);
    const general = await s.twin.grantClearance(s.scope, { userId: USERS.pharmaAnalyst, sensitivity: 'GENERAL_MANAGEMENT', validFrom: '2026-01-01T00:00:00.000Z', validTo: null, reason: 'nothing to grant' });
    assert.equal(general.ok, false);
  });
});

describe('scenario visibility', () => {
  const facts = (over = {}) => ({ createdBy: USERS.commercialDirector, visibility: 'ORG_WIDE', grantedUnitIds: [], boundDecisions: [], ...over });

  it('an org-wide scenario no decision has bound is readable across the organization', () => {
    assert.equal(canSeeScenario(viewer(USERS.industrialHead), facts(), units).visible, true);
  });

  it('binding it to a restricted decision captures it: readers of that decision only', () => {
    const bound = facts({ boundDecisions: [{ createdBy: USERS.commercialDirector, grantedUnitIds: ['unit-vn-pharma'] }] });
    assert.equal(canSeeScenario(viewer(USERS.industrialHead), bound, units).visible, false, 'restricted scenario data does not leak across BUs');
    assert.equal(canSeeScenario(viewer(USERS.pharmaAnalyst), bound, units).visible, true);
    assert.equal(canSeeScenario(viewer(USERS.countryGM), bound, units).visible, true);
    assert.equal(canSeeScenario(viewer(USERS.commercialDirector), bound, units).visible, true, 'the creator keeps it');
  });

  it('a restricted scenario is readable only where it is shared', () => {
    const restricted = facts({ visibility: 'RESTRICTED', grantedUnitIds: ['unit-vn-finance'] });
    assert.equal(canSeeScenario(viewer(USERS.financeDirector), restricted, units).visible, true);
    assert.equal(canSeeScenario(viewer(USERS.pharmaAnalyst), restricted, units).visible, false);
  });
});

describe('visibility and authority stay independent', () => {
  it('seeing a commitment does not confer authority over it', async () => {
    // The Pharma analyst can read the Pharma snapshot and its governance item ...
    const p = unwrap(await project(s.story.pharmaS2, viewer(USERS.pharmaAnalyst)), 'analyst');
    assert.ok(p.items.some((i) => i.kind === 'GOVERNANCE'));
    // ... and still has no authority: a fresh commitment's approval is refused.
    const story2 = await buildStory();
    const decisionId = story2.story.decisionId;
    const evaluations = unwrap(await story2.authority.listEvaluations(story2.scope, { decisionId }), 'evaluations');
    assert.ok(evaluations.length > 0);
    const req = unwrap(await story2.authorityStore.listRequiredApprovals(story2.scope, { evaluationId: evaluations[0].id }), 'reqs')[0];
    const analyst = await story2.trusted.handle({ userId: USERS.pharmaAnalyst }, { op: 'approve', orgId: story2.scope.orgId, requiredApprovalId: req.id, comments: 'looks fine' });
    assert.notEqual(analyst.status, 200);
  });

  it('holding authority does not confer visibility: the Finance Director reads no BU snapshot nobody shared with Finance', async () => {
    const r = await project(s.story.pharmaS2, viewer(USERS.financeDirector));
    assert.equal(r.ok, false);
  });

  it('the twin relies only on a trusted verdict: a client-computed one degrades the snapshot', async () => {
    const t = await buildStory();
    // A second evaluation of the same commitment, computed in-process by the client runtime.
    unwrap(await t.authority.evaluate(t.scope, t.story.commitmentId), 'client evaluation');
    const snap = unwrap(await t.twin.buildSnapshot(t.as(USERS.countryGM), { kind: 'CURRENT', label: 'after a client verdict', scope: t.story.scopes.vietnam, periods: ['2026-Q4'] }), 'snapshot');
    const g = itemsOf(snap, 'GOVERNANCE')[0];
    assert.equal(g.state.evaluator, 'CLIENT_RUNTIME');
    assert.equal(snap.snapshot.completeness, 'DEGRADED');
    assert.ok(snap.snapshot.completenessReasons.some((r) => r.code === 'AUTHORITY_VERDICT_UNTRUSTED'));
  });
});
