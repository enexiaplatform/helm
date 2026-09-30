/**
 * Who may read a counterfactual case (ADR-0029 §8): the kernel statement of the
 * helm_private row rules. A case is read whole or not at all — its unit
 * audience, every sensitivity class of what it compares and declares, the
 * decision it reviews. Visibility is not authority.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canSeeDecision } from '@helm/authority-runtime';
import { ADMIN, DEMO_UNITS, MEMBERSHIP, UNITS, USERS, buildCounterfactualStory, rohtoAlternatives, unwrap } from './harness.mjs';

let s;
let g;
before(async () => {
  s = await buildCounterfactualStory();
  g = s.counterfactualStory;
});

const clearance = (userId, sensitivity) => ({ id: `${userId}-${sensitivity}`, orgId: 'o', userId, sensitivity, validFrom: '2026-01-01T00:00:00.000Z', validTo: null, reason: 'test', grantedBy: ADMIN, recordedAt: '2026-01-01T00:00:00.000Z' });
const viewer = (userId, classes = [], orgRole = 'member') => ({ userId, orgRole, memberUnitIds: MEMBERSHIP[userId] ?? [], clearances: classes.map((k) => clearance(userId, k)) });
const project = async (stack, v, decisionVisible = () => true) => unwrap(await stack.counterfactual.projectForViewer(stack.scope, v, DEMO_UNITS, { decisionVisible }), 'project');
const titles = (p) => new Set(p.cases.map((c) => c.case.title));

describe('sensitivity: a case carries the classes of what it compares, and of what it declares', () => {
  it('CF1 and CF2 carry FINANCIAL and COMMERCIAL_CONFIDENTIAL (the tender\'s probability, the price); CF3 only FINANCIAL', () => {
    assert.deepEqual([...g.cases.CF1.case.sensitivityClasses].sort(), ['COMMERCIAL_CONFIDENTIAL', 'FINANCIAL_SENSITIVE', 'GENERAL_MANAGEMENT']);
    assert.deepEqual([...g.cases.CF2.case.sensitivityClasses].sort(), ['COMMERCIAL_CONFIDENTIAL', 'FINANCIAL_SENSITIVE', 'GENERAL_MANAGEMENT']);
    assert.deepEqual([...g.cases.CF3.case.sensitivityClasses].sort(), ['FINANCIAL_SENSITIVE', 'GENERAL_MANAGEMENT']);
  });

  it('an uncleared viewer reads no case, and the statement says it was withheld whole', async () => {
    const p = await project(s, viewer(USERS.industrialHead));
    assert.equal(p.cases.length, 0);
    assert.equal(p.withheld, 3);
    assert.match(p.statement, /read whole or not at all/);
  });

  it('a viewer cleared for FINANCIAL only reads CF3; cleared for both reads all three; an admin reads everything without a decision grant', async () => {
    assert.deepEqual([...titles(await project(s, viewer(USERS.financeDirector, ['FINANCIAL_SENSITIVE'])))], [g.cases.CF3.case.title]);
    const both = await project(s, viewer(USERS.countryGM, ['FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL']));
    assert.equal(both.cases.length, 3);
    assert.equal(both.withheld, 0);
    assert.equal((await project(s, viewer(ADMIN, [], 'admin'), () => false)).cases.length, 3);
  });
});

describe('read whole or not at all', () => {
  it('a case reviewing a decision the viewer cannot see is withheld', async () => {
    const p = await project(s, viewer(USERS.countryGM, ['FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL']), (id) => id !== s.story.decisionId);
    assert.equal(p.cases.length, 0);
    assert.equal(p.withheld, 3);
  });

  it('a RESTRICTED case follows its unit grants: read by Pharma, by the Country GM above, never by Industrial', async () => {
    const alts = await rohtoAlternatives(s);
    const restricted = unwrap(
      await s.counterfactual.openCase(s.scope, {
        decisionId: s.story.decisionId,
        title: 'restricted to Pharma',
        question: 'Restricted?',
        intervention: { kind: 'CHOOSE_ALTERNATIVE', alternativeId: alts.expedite.id },
        anchorSnapshotId: s.story.S0.snapshot.id,
        scope: { kind: 'ANCHORED', anchors: [{ entityId: s.governance.entities.buPharma.entityId, label: 'Pharma BU', dimension: '' }] },
        visibility: 'RESTRICTED',
        grantedUnitIds: [UNITS.pharma],
        authoredByLabel: 'test',
      }),
      'restricted',
    );
    const readers = async (userId) => titles(await project(s, viewer(userId, ['FINANCIAL_SENSITIVE'])));
    assert.ok((await readers(USERS.pharmaAnalyst)).has(restricted.case.title));
    assert.ok((await readers(USERS.countryGM)).has(restricted.case.title));
    assert.ok(!(await readers(USERS.industrialHead)).has(restricted.case.title));
  });
});

describe('who may read follows the decision-visibility rule, not a shortcut', () => {
  // The real rule (canSeeDecision over the recorded visibility grants), not a stub.
  const readerFor = (stack) => async (v) => {
    const visible = new Set();
    for (const d of unwrap(await stack.decisionStore.listDecisions(stack.scope), 'decisions')) {
      const grants = await stack.authorityStore.listVisibility(stack.scope, d.id);
      const grantedUnitIds = grants.ok ? grants.value.map((x) => x.orgUnitId) : [];
      if (canSeeDecision({ userId: v.userId, orgRole: v.orgRole, memberUnitIds: v.memberUnitIds }, { createdBy: d.createdBy, grantedUnitIds }, DEMO_UNITS).visible) visible.add(d.id);
    }
    return project(stack, v, (id) => visible.has(id));
  };

  it('shared with the Pharma unit: the GM above and cleared Pharma members read the cases; Industrial and the uncleared analyst do not', async () => {
    const stack = await buildCounterfactualStory();
    unwrap(await stack.authority.grantVisibility(stack.as(USERS.commercialDirector), stack.story.decisionId, { orgUnitId: UNITS.pharma, orgUnitLabel: 'Pharma BU', reason: 'Demo: the units this decision concerns' }), 'share');
    const read = readerFor(stack);
    const both = ['FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL'];
    assert.equal((await read(viewer(USERS.countryGM, both))).cases.length, 3, 'the GM above Pharma reads all three');
    assert.equal((await read(viewer(USERS.pharmaAnalyst, both))).cases.length, 3, 'a cleared member of Pharma reads them');
    assert.equal((await read(viewer(USERS.pharmaAnalyst, ['FINANCIAL_SENSITIVE']))).cases.length, 1, 'cleared for FINANCIAL only: CF3 alone');
    assert.equal((await read(viewer(USERS.pharmaAnalyst))).cases.length, 0, 'the decision is visible but the classes are not cleared');
    assert.equal((await read(viewer(USERS.industrialHead, both))).cases.length, 0, 'cleared, but the decision was never shared with Industrial');
  });

  it('unshared, the decision stays with the people who made it: not even the cleared Country GM reads its cases', async () => {
    const read = readerFor(await buildCounterfactualStory());
    const gm = await read(viewer(USERS.countryGM, ['FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL']));
    assert.equal(gm.cases.length, 0);
    assert.equal(gm.withheld, 3);
  });
});

describe('visibility is not authority, and a counterfactual is not a verdict on anyone', () => {
  it('the runtime never consults the authority engine or a person\'s standing', () => {
    const dir = new URL('../src/', import.meta.url);
    const src = ['runtime.ts', 'policy.ts'].map((f) => readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')).join('\n');
    assert.doesNotMatch(src, /evaluateAuthority|createAuthorityRuntime|recordApproval|\.evaluate\(/);
  });

  it('no view is about a person: nothing groups cases, worlds or reviews by committer, owner or reviewer', () => {
    for (const m of Object.keys(s.counterfactual)) assert.doesNotMatch(m, /byPerson|byManager|byAuthor|byOwner|leaderboard|performance|regret|rank/i, m);
  });
});
