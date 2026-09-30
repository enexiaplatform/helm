/**
 * verify:review-security — who may read a review.
 *
 * A review is read whole or not at all: its unit audience and every sensitivity class of its opening state. An item
 * about a decision is read only where the decision can be seen; patterns, lessons and claims only through their own
 * layers' rules. A pack prepared for one viewer says how much was withheld, and keeps its identity. Visibility is not
 * authority, and nobody is scored.
 */

import { canSeeDecision } from '../packages/authority-runtime/src/index.ts';
import { ADMIN, ALL_CLASSES, DEMO_UNITS, MEMBERSHIP, UNITS, USERS, buildReviewStory, contract, unwrap } from './lib/v1Stack.mjs';

const c = contract('verify:review-security');
const s = await buildReviewStory();

const clearance = (userId, sensitivity) => ({ id: `${userId}-${sensitivity}`, orgId: 'o', userId, sensitivity, validFrom: '2026-01-01T00:00:00.000Z', validTo: null, reason: 'test', grantedBy: ADMIN, recordedAt: '2026-01-01T00:00:00.000Z' });
const viewer = (userId, classes = [], orgRole = 'member') => ({ userId, orgRole, memberUnitIds: MEMBERSHIP[userId] ?? [], clearances: classes.map((k) => clearance(userId, k)) });
const project = async (v, decisionVisible = () => true) => unwrap(await s.review.projectForViewer(s.scope, v, DEMO_UNITS, { decisionVisible }), 'project');
const prepared = (v, visible = () => true, id = s.reviewStory.second.review.id) => s.review.preparedFor(s.scope, id, v, DEMO_UNITS, { decisionVisible: visible });

// Whole or not at all.
const classes = [...s.reviewStory.first.review.sensitivityClasses];
c.check('classes-carried', classes.length > 1 || classes[0] !== 'GENERAL_MANAGEMENT', 'the Vietnam state carries no sensitive class');
const uncleared = await project(viewer(USERS.pharmaAnalyst));
c.check('read-whole', uncleared.reviews.length === 0 && uncleared.withheld === 2 && /read whole or not at all/.test(uncleared.statement), 'an uncleared viewer read a review, or was not told what was withheld');
c.check('read-whole', (await project(viewer(USERS.countryGM, ALL_CLASSES))).reviews.length === 2, 'a viewer cleared for every class of the state cannot read both reviews');
c.check('admin', (await project(viewer(ADMIN, [], 'admin'), () => false)).reviews.length === 2, 'an admin cannot read reviews without a decision grant');

const restricted = unwrap(await s.review.openReview(s.gm, { title: 'restricted', cadence: 'STRATEGIC', periodLabel: '2027-S9', scope: s.story.scopes.vietnam, periods: ['2026-Q4'], visibility: 'RESTRICTED', grantedUnitIds: [UNITS.pharma], openedByLabel: 't' }), 'open');
const titles = async (userId) => new Set((await project(viewer(userId, ALL_CLASSES))).reviews.map((r) => r.review.title));
c.check('unit-grants', (await titles(USERS.pharmaAnalyst)).has('restricted') && (await titles(USERS.countryGM)).has('restricted') && !(await titles(USERS.industrialHead)).has('restricted'), 'a restricted review did not follow its unit grants: read by the unit and the GM above, never by the unit beside');
unwrap(await s.review.closeReview(s.gm, restricted.review.id, { summary: 'x', dispositions: [], closedByLabel: 't' }), 'close');

// Decision visibility.
const blind = (id) => id !== s.story.decisionId;
const gm = viewer(USERS.countryGM, ALL_CLASSES);
const withheld = await project(gm, blind);
const second = withheld.reviews.find((r) => r.review.id === s.reviewStory.second.review.id);
c.check('decision-follows', !!second && second.items.every((i) => i.decisionId !== s.story.decisionId) && second.items.some((i) => i.kind === 'QUESTION'), 'an item resting on an invisible decision remained, or the review\'s own questions did not');
c.check('layers-own-rules', !second.items.some((i) => i.kind === 'PATTERN'), 'a pattern the viewer cannot read is named by a review: a review widened the genome\'s rule');

// The real decision-visibility rule.
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
const analyst = viewer(USERS.pharmaAnalyst, ALL_CLASSES);
const industrial = viewer(USERS.industrialHead, ALL_CLASSES);
const rohtoItems = (p) => p.reviews.flatMap((r) => r.items).filter((x) => x.decisionId === s.story.decisionId).length;
c.check('real-rule', rohtoItems(await project(analyst, await visibleTo(analyst))) > 0 && rohtoItems(await project(industrial, await visibleTo(industrial))) === 0, 'the decision was read by a unit it was never shared with, or not by the one it was');

// The pack as one viewer may read it.
const refused = await prepared(viewer(USERS.pharmaAnalyst));
c.check('pack-refused', refused.ok === false && /read whole or not at all/.test(refused.error.message), 'an uncleared viewer was handed the pack');
const full = unwrap(await prepared(gm), 'full');
const narrow = unwrap(await prepared(gm, blind), 'narrow');
c.check('pack-withheld', full.withheld === 0 && narrow.withheld > 0 && narrow.pack.commitmentsOffTrack.items.length === 0 && narrow.pack.outcomesArrived.items.every((o) => o.decisionId !== s.story.decisionId) && /withheld/.test(narrow.statement), 'the pack for a viewer who cannot see the decision still holds what rests on it, or does not say how much was withheld');
c.check('pack-identity', narrow.pack.fingerprint === full.pack.fingerprint, 'withholding changed the pack\'s identity: it names what management was shown');

// Visibility is not authority; nobody is scored.
for (const m of Object.keys(s.review)) c.check('no-person-view', !/byPerson|byManager|byAuthor|byOwner|byAttendee|leaderboard|performance|rank/i.test(m), `the review runtime offers ${m}`);

c.finish('read whole or not at all by unit and class; items follow their decision; layers keep their own rules; the real visibility rule; a pack says what was withheld and keeps its identity; visibility is not authority; nobody scored');
