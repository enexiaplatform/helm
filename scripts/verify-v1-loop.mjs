/**
 * verify:v1-loop — the whole management loop, once, end to end.
 *
 *   sources → truth → twin → scenarios → decision → authority → commitment → outcome → causal evidence → genome →
 *   counterfactual review → management review → AI / council → and back to sources.
 *
 * The enterprise story is lived through the kernels (two reviews woven through it). Then the loop closes: a source
 * system moves after the reviews, HELM ingests it as source truth, the next review is prepared with exactly that
 * change since the last review closed, the AI briefs it from governed evidence, the writeback stays a dry run — and
 * every closed review, every decision and every commitment is byte-identical to what it was.
 */

import { seqIdGen } from '@helm/shared';
import { createFixtureMemoireReader, createIngestionPipeline, createInMemoryIntegrationStore, createMemoireAdapter, createMemoireWritebackAdapter, createWritebackGateway } from '../packages/integration-runtime/src/index.ts';
import { UNITS, adminCaller, buildCouncil, buildIntelligence, buildIntelligenceStory, contract, row, unwrap } from './lib/v1Stack.mjs';

const c = contract('verify:v1-loop');
const s = await buildIntelligenceStory();
const r1 = s.reviewStory.first;
const r2 = s.reviewStory.second;

// The story leaves every layer populated, and each one references the one before by id.
c.check('story', !!s.story.decisionId && !!s.story.commitmentId && !!s.causalStory && !!s.genomeStory && !!s.counterfactualStory && r1.status === 'CLOSED' && r2.status === 'CLOSED', 'the story is missing a layer or a review is not closed');
c.check('chain', r2.review.previousReviewId === r1.review.id && r2.items.some((i) => i.kind === 'COUNTERFACTUAL_CASE' && i.ref.id === s.counterfactualStory.cases.CF1.case.id) && r2.items.some((i) => i.kind === 'EPISODE' && i.ref.id === s.genomeStory.episodes.E1.episode.id) && r2.items.some((i) => i.kind === 'CAUSAL_CLAIM'), 'Review 2 does not bind the causal claim, the episode and the counterfactual case by reference');
const episodeRefs = unwrap(await s.genome.getEpisode(s.scope, s.genomeStory.episodes.E1.episode.id), 'episode');
c.check('chain', JSON.stringify(episodeRefs).includes(s.counterfactualStory.cases.CF1.case.id), 'the genome episode does not reference the counterfactual case');

const snapshotOfState = async () => JSON.stringify({
  d: unwrap(await s.decisionStore.listDecisions(s.scope), 'd').map((x) => `${x.id}:${x.state}`),
  cm: (await Promise.all(unwrap(await s.decisionStore.listDecisions(s.scope), 'd').map(async (d) => unwrap(await s.decisionStore.listCommitments(s.scope, d.id), 'c').map((x) => `${x.id}:${x.fingerprint}`)))).flat(),
  cl: unwrap(await s.causal.listClaims(s.scope), 'c').map((v) => `${v.claim.id}:${v.revision.revision}`),
  ep: unwrap(await s.genome.listEpisodes(s.scope), 'g').map((e) => e.episode.id),
  cf: unwrap(await s.counterfactual.listCases(s.scope), 'f').map((x) => x.case.id),
  rv: unwrap(await s.review.listReviews(s.scope), 'r').map((x) => `${x.review.id}:${x.status}:${x.items.length}`),
});
const before = await snapshotOfState();
const storedBefore = [];
for (const v of [r1, r2]) for (const which of ['PREPARATION', 'CLOSING']) storedBefore.push(unwrap(await s.review.reproduce(s.gm, v.review.id, which), 'before').storedFingerprint);

// The loop closes: a source system moves.
s.clock.jumpTo('2027-06-02T02:00:00.000Z');
const reader = createFixtureMemoireReader([]);
const adapter = createMemoireAdapter(reader);
const store = createInMemoryIntegrationStore({ clock: s.clock, idGen: seqIdGen('loop') });
const pipeline = createIngestionPipeline({ graph: s.graph, valueGraph: s.valueGraph, store, clock: s.clock });
const gateway = createWritebackGateway({ decisions: s.decisionStore, authority: s.authority, store, adapters: [createMemoireWritebackAdapter()] });
reader.rows.push(row({ id: 'opp-8821', account_id: 'acc-rohto', account_name: 'Rohto Vietnam', opportunity_name: 'Rohto Q4 tender', estimated_value: 4200000000, pipeline_probability: 70, updated_at: '2026-09-18T11:02:00.000Z' }));
unwrap(await pipeline.run(s.scope, adapter), 'settle: what Memoire already said');
const closed = unwrap(await s.twin.buildSnapshot(s.scope, { kind: 'CURRENT', label: 'the day before Memoire moves', scope: s.story.scopes.vietnam, periods: ['2026-Q4'], grantedUnitIds: [UNITS.vietnam] }), 'baseline');
s.clock.jumpTo('2027-06-03T02:00:00.000Z');
reader.rows[0] = { ...reader.rows[0], pipeline_probability: 15, updated_at: '2027-06-03T01:00:00.000Z' };
const sync = unwrap(await pipeline.run(s.scope, adapter), 'memoire moves');
c.check('ingested', sync.outcome === 'SUCCEEDED' && sync.counts.observationsRecorded === 1 && !!sync.ingestionEventId, 'Memoire\'s change was not ingested as exactly one source observation');
const opp = unwrap(await s.graph.getEntityByCanonicalKey(s.scope, 'Opportunity', 'memoire:opportunity:opp-8821'), 'opportunity');
const node = unwrap(await s.valueGraph.findNodesForEntity(s.scope, opp.id), 'nodes').find((n) => n.metricKey === 'OpportunityProbability');
const latest = unwrap(await s.valueGraph.getLatestObservation(s.scope, { nodeId: node.id, type: 'ACTUAL', scenarioEntityId: null }), 'latest');
c.check('source-truth', latest.numericValue === 0.15 && latest.sourceSystem === 'memoire' && latest.metadata.sourceObjectId === 'opp-8821', 'the ingested value is not source truth naming its system and object');

// The next review: prepared with exactly what changed since the last one closed, and Review 3 is not Review 2.
const r3 = unwrap(await s.review.openReview(s.gm, { title: 'Monthly review (loop proof)', cadence: r2.review.cadence, periodLabel: '2027-06', scope: s.story.scopes.vietnam, periods: ['2026-Q4'], grantedUnitIds: [UNITS.vietnam], openedByLabel: 'Country GM Vietnam (demo)' }), 'review 3');
c.check('follows', r3.review.previousReviewId === r2.review.id, 'the next review does not follow the last closed one');
const pack3 = unwrap(await s.review.prepare(s.gm, r3.review.id), 'pack 3');
c.check('since-last-close', pack3.changed.fromSnapshotId === r2.closure.closingSnapshotId && pack3.changed.toSnapshotId === r3.review.openingSnapshotId && pack3.changed.changes.length > 0, 'the next review is not prepared with what changed since the last one closed');
const delta = unwrap(await s.twin.compareSnapshots(s.scope, r2.closure.closingSnapshotId, r3.review.openingSnapshotId), 'delta');
const moved = [...delta.valueChanges, ...delta.knowledgeChanges].find((k) => k.itemKey === `value:${node.id}:ACTUAL`);
c.check('source-change-visible', moved?.after.state.value === '0.15' && moved.after.state.sourceSystem === 'memoire', 'the twin does not show the source change between the last review and this one, naming its system');
c.check('unchanged-baseline', closed.snapshot.id !== r3.review.openingSnapshotId, 'a stale snapshot was reused');

// The AI briefs it from governed evidence and cannot change anything.
const ai = buildIntelligence(s);
const brief = unwrap(await ai.intelligence.run(s.scope, adminCaller(), { task: 'DRAFT_MANAGEMENT_BRIEF', params: { reviewId: r3.review.id } }), 'brief');
const ids = new Set(brief.evidence.map((e) => e.id));
c.check('ai-grounded', brief.statements.length > 0 && brief.grounding.removed === 0 && brief.statements.every((st) => st.evidenceIds.every((id) => ids.has(id))), 'the brief for the next review is not grounded in governed evidence');
c.check('ai-not-truth', /not enterprise truth/.test(brief.notice) && !/recommend|should approve|best option/i.test(JSON.stringify(brief.statements)), 'the brief passes itself off as truth or recommends');
const council = unwrap(await buildCouncil(s).convene(s.scope, adminCaller(), { question: 'What does each function make of the next review?', decisionId: s.story.decisionId, reviewId: r3.review.id }), 'council');
c.check('council-does-not-choose', council.accountable === 'HUMAN_MANAGEMENT' && council.perspectives.length >= 3 && council.notInstantiated.some((n) => n.perspective === 'PEOPLE'), 'the council chose, or spoke for People');

// The writeback stays a dry run against a commitment governance permits.
const dry = unwrap(await gateway.dispatch(s.scope, { commitmentId: s.story.commitmentId }), 'dispatch');
c.check('dry-run', dry.requests.length === 1 && dry.requests[0].mode === 'DRY_RUN' && dry.requests[0].receipt.sent === false, 'the loop wrote outward, or did not stay a dry run');

// Nothing that closed was rewritten; nothing that was decided was changed by the loop.
const closeR3 = unwrap(await s.review.getReview(s.gm, r3.review.id), 'view');
unwrap(await s.review.closeReview(s.gm, r3.review.id, { summary: 'Loop proof closed.', dispositions: closeR3.items.map((i) => ({ itemId: i.id, disposition: 'RESOLVED', reason: 'Proof only.' })), closedByLabel: 't' }), 'close 3');
const storedAfter = [];
for (const v of [r1, r2]) for (const which of ['PREPARATION', 'CLOSING']) {
  const rr = unwrap(await s.review.reproduce(s.gm, v.review.id, which), 'after');
  c.check('closed-stays-closed', rr.identical === true, `${which} of ${v.review.periodLabel} was rewritten by a later source change`);
  storedAfter.push(rr.storedFingerprint);
}
c.check('closed-stays-closed', JSON.stringify(storedAfter) === JSON.stringify(storedBefore), 'a stored review fingerprint moved');
const after = JSON.parse(await snapshotOfState());
const was = JSON.parse(before);
c.check('nothing-decided-by-the-loop', JSON.stringify(after.d) === JSON.stringify(was.d) && JSON.stringify(after.cm) === JSON.stringify(was.cm) && JSON.stringify(after.cl) === JSON.stringify(was.cl) && JSON.stringify(after.ep) === JSON.stringify(was.ep) && JSON.stringify(after.cf) === JSON.stringify(was.cf), 'ingesting, reviewing, briefing or the dry run changed a decision, commitment, claim, episode or case');
c.check('only-a-review-added', after.rv.length === was.rv.length + 1, 'something other than the next review was added');

c.finish('the whole loop from source to source: two reviews lived through the kernels, a source moves, is ingested as source truth, the next review is prepared with that change since the last one closed, the AI briefs it grounded, the writeback stays a dry run, and no closed review, decision or commitment was touched');
