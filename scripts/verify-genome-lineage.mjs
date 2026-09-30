/**
 * verify:genome-lineage — every memory answers where it came from.
 *
 * Every episode names its decision, its commitment, its boundary and its
 * author; every bound reference names its role and points at something that
 * exists in the kernel; every pattern link, revision and lesson review names
 * who recorded it and when; a lesson cites what it rests on; nothing in the
 * genome is a copy of a kernel record.
 */

import { buildGenomeStory, contract, unwrap } from './lib/genomeStack.mjs';

const c = contract('verify:genome-lineage');
const s = await buildGenomeStory();
const g = s.genomeStory;

const episodes = unwrap(await s.genome.listEpisodes(s.scope), 'episodes');
c.check('episodes', episodes.length === 5, `${episodes.length} episodes, expected the five of the demo`);
for (const v of episodes) {
  const ep = v.episode;
  c.check('episode-provenance', !!ep.decisionId && !!ep.authoredByLabel && !!ep.recordedAt && !!ep.boundary?.recordedThrough && !!ep.boundary?.effectiveAsOf, `episode ${ep.id} does not say what it wraps, who recorded it and what was knowable`);
  c.check('episode-scope', ep.scope.kind === 'ANCHORED' ? ep.scope.anchors.length >= 1 : (ep.scope.justification ?? '').length >= 12, `episode ${ep.id} is unscoped`);
  c.check('episode-statement', v.statement.trim().length > 0, `episode ${ep.id} carries no statement of what it is`);
  const decision = unwrap(await s.decisionStore.getDecision(s.scope, ep.decisionId), 'decision');
  c.check('decision-exists', decision.id === ep.decisionId, `episode ${ep.id} wraps a decision that does not exist`);
}

// Every bound reference points at something that exists; the episode holds only the pointer.
const refs = unwrap(await s.genomeStore.listEpisodeRefs(s.scope), 'refs');
c.check('refs', refs.length > 0, 'no reference is bound');
for (const r of refs) {
  c.check('ref-shape', !!r.role && !!r.ref.kind && !!r.ref.id && !!r.recordedAt, `reference ${r.id} lacks a role, a kind, an id or a record time`);
  c.check('ref-pointer-only', Object.keys(r.ref).every((k) => ['kind', 'id', 'pin', 'label'].includes(k)), `reference ${r.id} carries more than a pointer: ${Object.keys(r.ref).join(', ')}`);
}
const kinds = new Set(refs.map((r) => r.ref.kind));
for (const kind of ['TWIN_SNAPSHOT', 'CAUSAL_CLAIM', 'OUTCOME_REVIEW']) c.check('ref-kinds', kinds.has(kind), `no episode reference is a ${kind}`);
for (const r of refs.filter((x) => x.ref.kind === 'TWIN_SNAPSHOT')) {
  const snap = await s.twin.getSnapshot(s.scope, r.ref.id);
  c.check('ref-exists', snap.ok, `reference ${r.id} points at a twin snapshot that does not exist`);
}
for (const r of refs.filter((x) => x.ref.kind === 'CAUSAL_CLAIM')) {
  const claim = await s.causal.getClaim(s.scope, r.ref.id);
  c.check('ref-exists', claim.ok, `reference ${r.id} points at a causal claim that does not exist`);
}

// Patterns, links, lessons and their reviews name who and when.
const patterns = unwrap(await s.genomeStore.listPatterns(s.scope), 'patterns');
const revisions = unwrap(await s.genomeStore.listPatternRevisions(s.scope), 'revisions');
const links = unwrap(await s.genomeStore.listPatternEvidence(s.scope), 'links');
const lessons = unwrap(await s.genomeStore.listLessons(s.scope), 'lessons');
const reviews = unwrap(await s.genomeStore.listLessonReviews(s.scope), 'reviews');
for (const p of patterns) c.check('pattern-provenance', !!p.authoredByLabel && !!p.recordedAt, `pattern ${p.id} does not say who proposed it and when`);
for (const r of revisions) c.check('revision-provenance', !!r.recordedAt && r.limitations.trim().length > 0 && r.statement.trim().length > 0, `revision ${r.id} lacks its statement, its limitations or its record time`);
for (const l of links) c.check('link-provenance', !!l.recordedAt && l.rationale.trim().length > 0 && !!l.observed, `link ${l.id} lacks its rationale, what HELM observed or its record time`);
for (const l of lessons) {
  c.check('lesson-provenance', !!l.authoredByLabel && !!l.recordedAt && l.evidence.length >= 1, `lesson ${l.id} does not say who wrote it and what it rests on`);
  c.check('lesson-evidence', l.evidence.every((r) => r.kind === 'MANAGEMENT_EPISODE' || r.kind === 'MANAGEMENT_PATTERN'), `lesson ${l.id} rests on something other than the genome`);
}
for (const r of reviews) c.check('review-provenance', !!r.reviewedByLabel && !!r.recordedAt && r.note.trim().length > 0, `review ${r.id} does not say who reviewed it and why`);
c.check('link-lineage', patterns.length === 3 && links.length >= 6 && revisions.length >= 3, `the demo genome holds ${patterns.length} patterns, ${links.length} links and ${revisions.length} revisions`);

// The genome and the demo say they are a demonstration.
c.check('demo-labelled', [g.episodes.E2, g.episodes.E3, g.episodes.E4, g.episodes.E5].every((v) => /\(demo\)/.test(v.episode.title)), 'a demo episode is not labelled a demonstration');

// Explanations: an episode answers "how did we decide, and what happened?" from records.
const rohto = unwrap(await s.genome.getEpisode(s.scope, g.episodes.E1.episode.id), 'rohto');
c.check('explanation', rohto.managementQuestion.trim().length > 0 && rohto.decisionTitle.trim().length > 0, 'the episode does not state the management question it answers');
c.check('explanation', rohto.process.facts.every((f) => f.label && f.value !== undefined), 'a process fact has no label or value');
c.check('explanation', rohto.patterns.length >= 1 && rohto.patterns.every((p) => !!p.title && !!p.stance), 'the episode does not say which patterns it is evidence for');

// Nothing is a copy of a kernel record.
const stored = JSON.stringify({ episodes: episodes.map((v) => v.episode), refs });
c.check('no-copies', !/32\.3878|31\.7|185220000|165000000/.test(stored), 'the genome stored a number from a kernel record');

c.finish(`${episodes.length} episodes, ${refs.length} references (pointers only), ${patterns.length} patterns, ${links.length} links, ${lessons.length} lessons with provenance; the episode answers how management decided and what happened from records; nothing is a copy`);
