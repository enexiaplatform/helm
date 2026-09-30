/**
 * verify:genome-temporality — what the enterprise knew, and when.
 *
 * The genome is reconstructed at a lens from append-only records: an episode
 * that was not yet opened does not exist earlier; P1 read RECURRING before the
 * contradiction was linked and stays RECURRING for that lens; a snapshot
 * recorded after the decision is hindsight and is refused as the situation;
 * the beliefs of the day are kept apart from the beliefs since; a revision
 * keeps its earlier wording; a future knowledge boundary is refused.
 */

import { MERIDIAN_GENOME_TIMES as T } from '../packages/genome-runtime/src/index.ts';
import { at, buildGenomeStory, contract, expectFail, unwrap } from './lib/genomeStack.mjs';

const c = contract('verify:genome-temporality');
const s = await buildGenomeStory();
const g = s.genomeStory;
const rohto = g.episodes.E1.episode;
const pharma = { kind: 'ANCHORED', anchors: [{ entityId: s.governance.entities.buPharma.entityId, label: 'Pharma BU', dimension: '' }] };

// An episode is only what the lens can know.
const early = await s.genome.getEpisode(s.scope, rohto.id, at(T.reviews));
c.check('knowledge-boundary', !early.ok && early.error.code === 'genome.not_known_at_lens', 'an episode recorded later was visible at an earlier boundary');
const opened = unwrap(await s.genome.getEpisode(s.scope, rohto.id, at('2027-04-02T03:00:00.000Z')), 'at opening');
c.check('historical', opened.status === 'COMPLETED', 'the episode does not read COMPLETED once the review it references is known');
const future = await s.genome.viewAt(s.scope, at(new Date(s.clock.peek().getTime() + 86_400_000).toISOString()));
c.check('knowledge-boundary', !future.ok && future.error.code === 'genome.knowledge_in_future', 'a knowledge boundary in the future was accepted');

// A pattern is what was known about it then.
const then = unwrap(await s.genome.getPattern(s.scope, g.patterns.P1.pattern.id, at(T.beforeContradictionLinked)), 'then');
const now = unwrap(await s.genome.getPattern(s.scope, g.patterns.P1.pattern.id), 'now');
const again = unwrap(await s.genome.getPattern(s.scope, g.patterns.P1.pattern.id, at(T.beforeContradictionLinked)), 'then again');
c.check('historical', then.status === 'RECURRING' && then.contradictory.length === 0, `P1 before the contradiction was linked reads ${then.status}`);
c.check('historical', now.status === 'CONTESTED', `P1 now reads ${now.status}`);
c.check('historical', JSON.stringify(again.status) === JSON.stringify(then.status) && again.supporting.length === then.supporting.length, 'later links rewrote what was known on 6 April');
const p3 = unwrap(await s.genome.getPattern(s.scope, g.patterns.P3.pattern.id, at(T.beforeContradictionLinked)), 'P3 then');
c.check('historical', p3.status === 'EMERGING', 'P3 changed under an earlier lens');
const whole = unwrap(await s.genome.viewAt(s.scope, at(T.beforeContradictionLinked)), 'view');
c.check('view-at', whole.patterns.length === 3 && whole.lessons.length === 0 && whole.episodes.length === 5, `the genome on 6 April holds ${whole.episodes.length} episodes, ${whole.patterns.length} patterns and ${whole.lessons.length} lessons; expected 5, 3 and 0 (the lessons came on the 8th)`);

// A link is knowledge too: a stance made later did not exist earlier.
const before = s.clock.now().toISOString();
const proposed = unwrap(await s.genome.proposePattern(s.scope, { title: 'late link', scope: pharma, conditions: { decisionType: ['INVENTORY_ALLOCATION'] }, characteristic: { kind: 'PROCESS_FEATURE', feature: 'ALTERNATIVE_UNMODELLED' }, statement: 's', limitations: 'l', authoredByLabel: 'contract' }), 'pattern');
const beforeLink = s.clock.now().toISOString();
const linked = unwrap(await s.genome.linkEpisode(s.scope, proposed.pattern.id, g.episodes.E4.episode.id, 'SUPPORTING_EPISODE', 'seen'), 'link');
const unlinked = unwrap(await s.genome.getPattern(s.scope, proposed.pattern.id, at(beforeLink)), 'before the link');
c.check('link-is-knowledge', linked.supporting.length === 1 && unlinked.supporting.length === 0, `a link made later counted at an earlier knowledge boundary (${unlinked.supporting.length} supporting then, ${linked.supporting.length} now)`);
const predates = await s.genome.getPattern(s.scope, proposed.pattern.id, at(before));
c.check('knowledge-boundary', !predates.ok && predates.error.code === 'genome.not_known_at_lens', 'a pattern proposed later was visible at an earlier boundary');

// Hindsight is never the situation.
for (const snap of [s.story.S1a, s.story.S1, s.story.S2]) {
  const r = await s.genome.openEpisode(s.scope, { decisionId: s.story.decisionId, title: 'x', scope: pharma, situationSnapshotId: snap.snapshot.id, authoredByLabel: 'contract' });
  c.check('no-hindsight', expectFail(r, snap.snapshot.spec.label).code === 'genome.hindsight_as_situation', `snapshot ${snap.snapshot.spec.label} was opened as the situation of a decision made before it`);
}
const bound = await s.genome.bindRef(s.scope, rohto.id, 'SITUATION_SNAPSHOT', { kind: 'TWIN_SNAPSHOT', id: s.story.S2.snapshot.id, pin: null, label: null });
c.check('no-hindsight', !bound.ok && bound.error.code === 'genome.hindsight_as_situation', 'a later snapshot was bound to an existing episode as its situation');

// What management believed then and what has arrived since are two lists.
c.check('beliefs', g.episodes.E1.causal.atDecision.length === 0, 'a belief recorded after the decision is presented as what management believed');
c.check('beliefs', g.episodes.E1.causal.since.every((v) => Date.parse(v.claim.recordedAt) > Date.parse(rohto.boundary.recordedThrough)), 'a claim recorded before the boundary is listed as arriving since');
const eventual = unwrap(await s.genome.getEpisode(s.scope, rohto.id), 'now');
c.check('beliefs', /hindsight/i.test(eventual.statement) || eventual.causal.since.length === 4, 'the episode does not keep hindsight apart');

// The boundary itself is a lens of the decision, and never after the episode.
c.check('boundary', Date.parse(rohto.boundary.effectiveAsOf) <= Date.parse(rohto.boundary.recordedThrough), 'the boundary is known before it happened');
c.check('boundary', Date.parse(rohto.boundary.recordedThrough) < Date.parse(rohto.recordedAt), 'the episode was recorded before the decision boundary it describes');

// Revisions keep their wording.
const revBefore = s.clock.now().toISOString();
const revised = unwrap(await s.genome.revisePattern(s.scope, g.patterns.P3.pattern.id, { limitations: 'One episode, and its tender assumption was the postponed one.' }), 'revise');
const old = unwrap(await s.genome.getPattern(s.scope, g.patterns.P3.pattern.id, at(revBefore)), 'old');
c.check('versioned', revised.revision.revision === 2 && old.revision.revision === 1 && old.revision.limitations !== revised.revision.limitations, 'a revision rewrote the earlier wording');

// Lessons: PROPOSED when recorded, whatever they became.
const l1 = g.lessons.L1.lesson;
const lessonThen = unwrap(await s.genome.listLessons(s.scope, at(l1.recordedAt)), 'lessons then').find((x) => x.lesson.id === l1.id);
c.check('lesson-status', lessonThen?.status === 'PROPOSED' && g.lessons.L1.status === 'ENDORSED', 'a lesson endorsed later was ENDORSED at the moment it was recorded');

c.finish('an episode is unknown before it was opened; P1 RECURRING on 6 April and unchanged, CONTESTED now; hindsight refused as the situation; beliefs of the day kept apart from those since; revisions keep their wording; no future knowledge');
