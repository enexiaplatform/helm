/**
 * Who may read a review (ADR-0031): the kernel statement of the helm_private row
 * rules. A review is read whole — its unit audience and every sensitivity class of
 * its opening state — and an item about a decision only where the decision can be
 * seen. Visibility is not authority.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canSeeDecision } from '@helm/authority-runtime';
import { ADMIN, DEMO_UNITS, MEMBERSHIP, UNITS, USERS, buildReviewStory, unwrap } from './harness.mjs';

let s;
before(async () => {
  s = await buildReviewStory();
});

const clearance = (userId, sensitivity) => ({ id: `${userId}-${sensitivity}`, orgId: 'o', userId, sensitivity, validFrom: '2026-01-01T00:00:00.000Z', validTo: null, reason: 'test', grantedBy: ADMIN, recordedAt: '2026-01-01T00:00:00.000Z' });
const viewer = (userId, classes = [], orgRole = 'member') => ({ userId, orgRole, memberUnitIds: MEMBERSHIP[userId] ?? [], clearances: classes.map((k) => clearance(userId, k)) });
const project = async (v, decisionVisible = () => true) => unwrap(await s.review.projectForViewer(s.scope, v, DEMO_UNITS, { decisionVisible }), 'project');

describe('a review is read whole or not at all', () => {
  it('it carries the classes of its opening state; a viewer without the clearance reads no review, and is told', async () => {
    const classes = [...s.reviewStory.first.review.sensitivityClasses];
    assert.ok(classes.length > 1 || classes[0] !== 'GENERAL_MANAGEMENT', `the Vietnam state carries sensitive classes (${classes})`);
    const p = await project(viewer(USERS.pharmaAnalyst));
    assert.equal(p.reviews.length, 0);
    assert.equal(p.withheld, 2);
    assert.match(p.statement, /read whole or not at all/);
  });

  it('a viewer cleared for every class of the state reads both reviews; an admin reads them without any decision grant', async () => {
    const all = ['FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL', 'HR_RESTRICTED', 'STRATEGIC_RESTRICTED'];
    assert.equal((await project(viewer(USERS.countryGM, all))).reviews.length, 2);
    const admin = await project(viewer(ADMIN, [], 'admin'), () => false);
    assert.equal(admin.reviews.length, 2);
  });

  it('a restricted review follows its unit grants: read by the unit and by the GM above, never by the unit beside', async () => {
    const all = ['FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL', 'HR_RESTRICTED', 'STRATEGIC_RESTRICTED'];
    const a = unwrap(await s.review.openReview(s.gm, { title: 'restricted', cadence: 'STRATEGIC', periodLabel: '2027-S9', scope: s.story.scopes.vietnam, periods: ['2026-Q4'], visibility: 'RESTRICTED', grantedUnitIds: [UNITS.pharma], openedByLabel: 't' }), 'open');
    const titles = async (userId) => new Set((await project(viewer(userId, all))).reviews.map((r) => r.review.title));
    assert.ok((await titles(USERS.pharmaAnalyst)).has('restricted'));
    assert.ok((await titles(USERS.countryGM)).has('restricted'));
    assert.ok(!(await titles(USERS.industrialHead)).has('restricted'));
    unwrap(await s.review.closeReview(s.gm, a.review.id, { summary: 'x', dispositions: [], closedByLabel: 't' }), 'close');
  });
});

describe('an item about a decision is read only where the decision can be seen', () => {
  const all = ['FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL', 'HR_RESTRICTED', 'STRATEGIC_RESTRICTED'];

  it('withholding the Rohto decision removes every item that rests on it from a review the viewer can still read', async () => {
    const blind = (id) => id !== s.story.decisionId;
    const p = await project(viewer(USERS.countryGM, all), blind);
    const second = p.reviews.find((r) => r.review.id === s.reviewStory.second.review.id);
    assert.ok(second, 'the review itself is still read');
    assert.ok(second.items.every((i) => i.decisionId !== s.story.decisionId), 'no item about the decision remains');
    assert.ok(second.items.some((i) => i.kind === 'QUESTION'), 'the review\'s own questions remain');
    const full = await project(viewer(USERS.countryGM, all));
    assert.ok(full.reviews.find((r) => r.review.id === second.review.id).items.length > second.items.length);
  });

  it('patterns, lessons and causal claims are read through the genome\'s and the causal graph\'s own rules — a review never widens them', async () => {
    const gmAll = viewer(USERS.countryGM, all);
    const blind = (id) => id !== s.story.decisionId;
    const p = await project(gmAll, blind);
    const second = p.reviews.find((r) => r.review.id === s.reviewStory.second.review.id);
    // Every pattern rests on the Rohto episode; with its decision withheld the pattern is withheld whole, and so is the review item that names it.
    assert.ok(!second.items.some((i) => i.kind === 'PATTERN'), 'a pattern the viewer cannot read is not named by a review');
  });

  it('the real decision-visibility rule, not a stub: shared with the Pharma unit, the analyst reads the items; the industrial head, cleared but not shared with, does not', async () => {
    const visibleTo = async (v) => {
      const set = new Set();
      for (const d of unwrap(await s.decisionStore.listDecisions(s.scope), 'decisions')) {
        const grants = await s.authorityStore.listVisibility(s.scope, d.id);
        const grantedUnitIds = grants.ok ? grants.value.map((x) => x.orgUnitId) : [];
        if (canSeeDecision({ userId: v.userId, orgRole: v.orgRole, memberUnitIds: v.memberUnitIds }, { createdBy: d.createdBy, grantedUnitIds }, DEMO_UNITS).visible) set.add(d.id);
      }
      return (id) => set.has(id);
    };
    unwrap(await s.authority.grantVisibility(s.as(USERS.commercialDirector), s.story.decisionId, { orgUnitId: UNITS.pharma, orgUnitLabel: 'Pharma BU', reason: 'Demo: the units this decision concerns' }), 'share');
    const analyst = viewer(USERS.pharmaAnalyst, all);
    const industrial = viewer(USERS.industrialHead, all);
    const a = await project(analyst, await visibleTo(analyst));
    const i = await project(industrial, await visibleTo(industrial));
    const rohtoItems = (p) => p.reviews.flatMap((r) => r.items).filter((x) => x.decisionId === s.story.decisionId).length;
    assert.ok(rohtoItems(a) > 0, 'the analyst, in a unit the decision was shared with, reads the items');
    assert.equal(rohtoItems(i), 0, 'the industrial head was never shared with');
  });
});

describe('visibility is not authority; nobody is scored', () => {
  it('the runtime never consults the authority engine or a person\'s standing', () => {
    const dir = new URL('../src/', import.meta.url);
    const src = ['runtime.ts', 'pack.ts'].map((f) => readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')).join('\n');
    assert.doesNotMatch(src, /evaluateAuthority|createAuthorityRuntime|recordApproval|\.evaluate\(/);
  });

  it('no view is about a person: nothing groups reviews or items by owner, attendee or author', () => {
    for (const m of Object.keys(s.review)) assert.doesNotMatch(m, /byPerson|byManager|byAuthor|byOwner|byAttendee|leaderboard|performance|rank/i, m);
  });
});

describe('the pack as one viewer may read it', () => {
  const all = ['FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL', 'HR_RESTRICTED', 'STRATEGIC_RESTRICTED'];
  const prepared = (v, visible = () => true, id = s.reviewStory.second.review.id) => s.review.preparedFor(s.scope, id, v, DEMO_UNITS, { decisionVisible: visible });

  it('an uncleared viewer is refused the review whole', async () => {
    const r = await prepared(viewer(USERS.pharmaAnalyst));
    assert.equal(r.ok, false);
    assert.match(r.error.message, /read whole or not at all/);
  });

  it('a cleared viewer who cannot see the Rohto decision gets a pack without anything that rests on it — and is told how much was withheld', async () => {
    const full = unwrap(await prepared(viewer(USERS.countryGM, all)), 'full');
    const blind = unwrap(await prepared(viewer(USERS.countryGM, all), (id) => id !== s.story.decisionId), 'blind');
    assert.equal(full.withheld, 0);
    assert.ok(blind.withheld > 0);
    assert.equal(blind.pack.commitmentsOffTrack.items.length, 0);
    assert.ok(blind.pack.outcomesArrived.items.every((o) => o.decisionId !== s.story.decisionId));
    assert.ok(blind.pack.learning.episodes.items.every((e) => e.decisionId !== s.story.decisionId));
    assert.equal(blind.pack.fingerprint, full.pack.fingerprint, 'the pack keeps its identity: it names what management was shown');
    assert.match(blind.statement, /withheld/);
  });
});
