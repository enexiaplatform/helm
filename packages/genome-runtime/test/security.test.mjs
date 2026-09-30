/**
 * Who may read the genome (ADR-0028 §9): the kernel statement of the
 * helm_private row rules. An episode is read whole or not at all — its unit
 * audience, every sensitivity class it carries, the decision it wraps — and a
 * pattern or lesson only when every episode it rests on is. Visibility is not
 * authority.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canSeeDecision } from '@helm/authority-runtime';
import { ADMIN, DEMO_UNITS, MEMBERSHIP, UNITS, USERS, buildGenomeStory, unwrap } from './harness.mjs';

let s;
let g;
const clearance = (userId, sensitivity) => ({ id: `${userId}-${sensitivity}`, orgId: 'o', userId, sensitivity, validFrom: '2026-01-01T00:00:00.000Z', validTo: null, reason: 'test', grantedBy: ADMIN, recordedAt: '2026-01-01T00:00:00.000Z' });
const viewer = (userId, classes = [], orgRole = 'member') => ({ userId, orgRole, memberUnitIds: MEMBERSHIP[userId] ?? [], clearances: classes.map((k) => clearance(userId, k)) });
const project = async (v, decisionVisible = () => true) => unwrap(await s.genome.projectForViewer(s.scope, v, DEMO_UNITS, { decisionVisible }), 'project');
const ids = (xs, pick) => new Set(xs.map(pick));

before(async () => {
  s = await buildGenomeStory();
  g = s.genomeStory;
});

describe('sensitivity: an episode carries the classes of the metrics it expected to move', () => {
  it('the Rohto episode is FINANCIAL: gross margin and cash impact are margin-grade', () => {
    assert.deepEqual([...g.episodes.E1.episode.sensitivityClasses].sort(), ['FINANCIAL_SENSITIVE', 'GENERAL_MANAGEMENT']);
  });

  it('a viewer without the clearance sees no episode — and no pattern or lesson resting on them; the statement says so', async () => {
    const p = await project(viewer(USERS.industrialHead));
    assert.equal(p.episodes.length, 0);
    assert.equal(p.patterns.length, 0, 'every pattern rests on an episode the viewer cannot read');
    assert.equal(p.lessons.length, 0);
    assert.equal(p.withheld.episodes, 5);
    assert.match(p.statement, /withheld whole/);
  });

  it('with the clearance the same viewer reads them; an admin reads everything', async () => {
    const gm = await project(viewer(USERS.countryGM, ['FINANCIAL_SENSITIVE']));
    assert.equal(gm.episodes.length, 5);
    assert.equal(gm.patterns.length, 3);
    assert.equal(gm.lessons.length, 2);
    assert.equal(gm.withheld.episodes + gm.withheld.patterns + gm.withheld.lessons, 0);
    const admin = await project(viewer(ADMIN, [], 'admin'), () => false);
    assert.equal(admin.episodes.length, 5, 'an admin needs no decision grant');
  });
});

describe('read whole or not at all', () => {
  it('an episode resting on a decision the viewer cannot see is withheld, and so is every pattern and lesson that rests on it', async () => {
    const blind = (id) => id !== s.story.decisionId;
    const p = await project(viewer(USERS.countryGM, ['FINANCIAL_SENSITIVE']), blind);
    assert.ok(!ids(p.episodes, (v) => v.episode.decisionId).has(s.story.decisionId));
    assert.equal(p.episodes.length, 4);
    assert.equal(p.patterns.length, 0, 'P1, P2 and P3 all link the Rohto episode');
    assert.equal(p.lessons.length, 0, 'both lessons cite the Rohto episode');
    assert.equal(p.withheld.patterns, 3);
  });

  it('withholding one unrelated decision leaves what does not rest on it', async () => {
    const blind = (id) => id !== g.episodes.E3.episode.decisionId;
    const p = await project(viewer(USERS.countryGM, ['FINANCIAL_SENSITIVE']), blind);
    assert.equal(p.episodes.length, 4);
    assert.equal(p.patterns.length, 2, 'P2 and P3 never link the Thailand episode; P1 links it as context, so P1 is withheld');
    assert.deepEqual(ids(p.patterns, (v) => v.pattern.id), new Set([g.patterns.P2.pattern.id, g.patterns.P3.pattern.id]));
  });

  it('a RESTRICTED pattern follows its unit grants: read by Pharma, by the Country GM above, never by Industrial', async () => {
    const p = unwrap(
      await s.genome.proposePattern(s.scope, {
        title: 'restricted to Pharma',
        scope: { kind: 'ANCHORED', anchors: [{ entityId: s.governance.entities.buPharma.entityId, label: 'Pharma BU', dimension: '' }] },
        conditions: { decisionType: ['INVENTORY_ALLOCATION'] },
        characteristic: { kind: 'PROCESS_FEATURE', feature: 'ALTERNATIVE_UNMODELLED' },
        statement: 'Pharma-only.',
        limitations: 'Fixture.',
        visibility: 'RESTRICTED',
        grantedUnitIds: [UNITS.pharma],
        authoredByLabel: 'test',
      }),
      'pattern',
    );
    const readers = async (userId, classes) => ids((await project(viewer(userId, classes))).patterns, (v) => v.pattern.id);
    assert.ok((await readers(USERS.pharmaAnalyst, ['FINANCIAL_SENSITIVE'])).has(p.pattern.id));
    assert.ok((await readers(USERS.countryGM, ['FINANCIAL_SENSITIVE'])).has(p.pattern.id));
    assert.ok(!(await readers(USERS.industrialHead, ['FINANCIAL_SENSITIVE'])).has(p.pattern.id));
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
    return unwrap(await stack.genome.projectForViewer(stack.scope, v, DEMO_UNITS, { decisionVisible: (id) => visible.has(id) }), 'project');
  };

  it('with each demonstration decision shared with the Pharma unit: the GM above and Pharma read it (cleared); Industrial and the uncleared analyst do not', async () => {
    const read = readerFor(await buildGenomeStory({ shareWith: [{ unitId: UNITS.pharma, label: 'Pharma BU' }] }));
    const gm = await read(viewer(USERS.countryGM, ['FINANCIAL_SENSITIVE']));
    assert.equal(gm.episodes.length, 5, 'the Country GM reads every episode, each resting on a decision shared with the unit below');
    assert.equal(gm.patterns.length, 3);
    assert.equal(gm.lessons.length, 2);
    const analyst = await read(viewer(USERS.pharmaAnalyst, ['FINANCIAL_SENSITIVE']));
    assert.equal(analyst.episodes.length, 5, 'a cleared member of the Pharma unit reads them too');
    const uncleared = await read(viewer(USERS.pharmaAnalyst));
    assert.equal(uncleared.episodes.length, 0, 'the decision is visible, but the episode carries FINANCIAL_SENSITIVE and the analyst is not cleared');
    const industrial = await read(viewer(USERS.industrialHead, ['FINANCIAL_SENSITIVE']));
    assert.equal(industrial.episodes.length, 0, 'cleared, but the decisions were never shared with the Industrial unit');
    assert.equal(industrial.withheld.episodes, 5);
  });

  it('unshared, the same decisions stay with the people who made them: not even the cleared Country GM reads the episodes', async () => {
    const read = readerFor(await buildGenomeStory());
    const gm = await read(viewer(USERS.countryGM, ['FINANCIAL_SENSITIVE']));
    assert.equal(gm.episodes.length, 0);
    assert.equal(gm.patterns.length, 0, 'a pattern resting on an unreadable episode is withheld whole');
    assert.equal(gm.lessons.length, 0);
    assert.equal(gm.withheld.episodes, 5);
  });
});

describe('visibility is not authority, and no person is a feature', () => {
  it('the genome never consults the authority engine or a person\'s standing', () => {
    const dir = new URL('../src/', import.meta.url);
    const src = ['runtime.ts', 'policy.ts', 'situation.ts'].map((f) => readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')).join('\n');
    assert.doesNotMatch(src, /evaluateAuthority|createAuthorityRuntime|recordApproval|\.evaluate\(/);
  });

  it('no situation feature, pattern condition or episode field is about a person', () => {
    const e = g.episodes.E1.episode;
    for (const key of [...Object.keys(e.situation.values), ...Object.keys(g.patterns.P1.pattern.conditions)]) {
      assert.doesNotMatch(key, /committed|manager|owner|author|person|user|reviewer|performance|rating/i, key);
    }
    const view = JSON.stringify(g.patterns.P1.supporting.map((x) => x.episode.episode.situation));
    assert.doesNotMatch(view, /Country GM Vietnam \(demo\)|userId/, 'the situation names no person');
  });

  it('the genome offers no per-person view: nothing groups episodes, patterns or outcomes by committer, owner or reviewer', () => {
    for (const m of Object.keys(s.genome)) assert.doesNotMatch(m, /byPerson|byManager|byAuthor|byOwner|leaderboard|performance/i, m);
  });
});
