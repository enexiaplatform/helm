/**
 * verify:genome-process-outcome — Decision Process Quality ≠ Outcome Quality.
 *
 *   - the genome never rates a decision, a person or a pattern: no view, at any
 *     depth, carries a quality, score, rating, verdict, rank, grade, weight or
 *     probability; nothing groups episodes by a person;
 *   - how management decided and what happened are separate sections, and a
 *     later outcome review changes the outcome and leaves the process
 *     byte-identical (hindsight does not rewrite the decision);
 *   - genome operations leave the kernel byte-identical: decisions,
 *     commitments, snapshots, causal claims, formulas, runs, observations;
 *   - there is no method that infers, discovers, learns, predicts, recommends,
 *     applies or promotes, and nothing below the genome is ever written to;
 *   - a pattern is only ever a person's proposal; HELM checks it, never finds it.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_UNITS, MEMBERSHIP, USERS, buildGenomeStory, contract, unwrap } from './lib/genomeStack.mjs';

const c = contract('verify:genome-process-outcome');
const s = await buildGenomeStory();
const g = s.genomeStory;

const kernelFingerprint = async () => {
  const decisions = unwrap(await s.decisionStore.listDecisions(s.scope), 'decisions');
  const parts = [];
  for (const d of decisions) {
    const commitments = unwrap(await s.decisionStore.listCommitments(s.scope, d.id), 'commitments').map((x) => `${x.id}:${x.summary}`);
    const reviews = unwrap(await s.decisionStore.listOutcomeReviews(s.scope, d.id), 'reviews').map((x) => `${x.id}:${JSON.stringify(x.actuals)}`);
    parts.push(`${d.id}:${d.title}|${commitments.join(',')}|${reviews.join(',')}`);
  }
  const snapshots = unwrap(await s.twin.listSnapshots(s.scope), 'snapshots').map((x) => `${x.id}:${x.fingerprint}`).sort();
  const claims = unwrap(await s.causal.listClaims(s.scope), 'claims').map((v) => `${v.claim.id}:${v.revision.revision}:${v.evaluation.status}`).sort();
  const calcs = s.registry.all().map((d) => `${d.key}@${d.version}`).sort();
  const runs = unwrap(await s.scenarios.listRuns(s.scope), 'runs').map((x) => `${x.id}:${x.fingerprint}:${x.status}`).sort();
  const obs = [];
  for (const n of unwrap(await s.valueGraph.findValueNodes(s.scope), 'nodes')) {
    obs.push(...unwrap(await s.valueGraph.getObservations(s.scope, { nodeId: n.id }), 'obs').map((o) => `${o.id}:${o.observationType}:${o.numericValue}`));
  }
  return JSON.stringify({ decisions: parts.sort(), snapshots, claims, calcs, runs, obs: obs.sort() });
};

// ---- genome operations leave the kernel byte-identical.
const before = await kernelFingerprint();
const pharma = { kind: 'ANCHORED', anchors: [{ entityId: s.governance.entities.buPharma.entityId, label: 'Pharma BU', dimension: '' }] };
const member = (userId) => ({ ...s.as(userId), role: 'member' });
const p = unwrap(await s.genome.proposePattern(s.scope, { title: 'kernel untouched', scope: pharma, conditions: { decisionType: ['INVENTORY_ALLOCATION'] }, characteristic: { kind: 'PROCESS_FEATURE', feature: 'ALTERNATIVE_UNMODELLED' }, statement: 's', limitations: 'l', authoredByLabel: 'contract' }), 'propose');
unwrap(await s.genome.linkEpisode(s.scope, p.pattern.id, g.episodes.E4.episode.id, 'SUPPORTING_EPISODE', 'seen'), 'link');
unwrap(await s.genome.revisePattern(s.scope, p.pattern.id, { statement: 'revised' }), 'revise');
const lesson = unwrap(await s.genome.recordLesson(member(s.causalStory.claims.C3.claim.authoredBy), { claim: 'A lesson.', scope: pharma, evidence: [{ kind: 'MANAGEMENT_PATTERN', id: p.pattern.id, pin: null, label: null }], authoredByLabel: 'author' }), 'lesson');
unwrap(await s.genome.reviewLesson(member(s.causalStory.claims.D1.claim.authoredBy), lesson.lesson.id, 'ENDORSED', 'Supported by the pattern.', 'reviewer'), 'review');
unwrap(await s.genome.retirePattern(s.scope, p.pattern.id, 'Done with the contract.'), 'retire');
unwrap(await s.genome.findSimilar(s.scope, { episodeId: g.episodes.E1.episode.id, require: ['decisionType'] }), 'similar');
unwrap(await s.genome.situationOf(s.scope, g.episodes.E5.episode.decisionId), 'situation');
unwrap(await s.genome.viewAt(s.scope), 'view');
unwrap(await s.genome.projectForViewer(s.scope, { userId: USERS.countryGM, orgRole: 'member', memberUnitIds: MEMBERSHIP[USERS.countryGM] ?? [], clearances: [] }, DEMO_UNITS, { decisionVisible: () => true }), 'project');
const after = await kernelFingerprint();
c.check('kernel-untouched', before === after, 'a genome operation changed a decision, a commitment, a snapshot, a causal claim, a formula, a run or an observation');

// situationOf is a question: it records nothing.
const countBefore = unwrap(await s.genome.listEpisodes(s.scope), 'episodes').length;
const sit1 = unwrap(await s.genome.situationOf(s.scope, g.episodes.E5.episode.decisionId), 'situation 1');
const sit2 = unwrap(await s.genome.situationOf(s.scope, g.episodes.E5.episode.decisionId), 'situation 2');
c.check('situation-is-derived', JSON.stringify(sit1) === JSON.stringify(sit2) && unwrap(await s.genome.listEpisodes(s.scope), 'episodes').length === countBefore, 'asking for a situation recorded something or answered differently twice');

// ---- a later outcome changes the outcome section and never the process section.
const e5 = g.episodes.E5.episode;
const first = unwrap(await s.genome.getEpisode(s.scope, e5.id), 'first');
c.check('outcome-vs-process', first.outcome.reviews.length === 1, `E5 holds ${first.outcome.reviews.length} outcome reviews, expected 1`);
const processBefore = JSON.stringify(first.process);
const causalBefore = first.causal.atDecision.length;
unwrap(await s.decisionsRuntime.recordOutcomeReview(s.scope, e5.commitmentId, { reviewedByLabel: 'contract', actuals: [{ label: 'Gross margin %', metricKey: 'GrossMarginPct', actual: '1.0000' }], notes: 'A terrible outcome, recorded after the fact.' }), 'late review');
const later = unwrap(await s.genome.getEpisode(s.scope, e5.id), 'later');
c.check('outcome-vs-process', later.outcome.reviews.length === 2, `the late review was not reflected in the outcome section (${later.outcome.reviews.length} reviews)`);
c.check('outcome-vs-process', JSON.stringify(later.process) === processBefore, 'a bad outcome rewrote how the decision was made: hindsight leaked into the process section');
c.check('outcome-vs-process', later.causal.atDecision.length === causalBefore, 'a later outcome changed what management believed at the decision');
c.check('no-verdict', !/good decision|bad decision|poor decision|well decided|badly decided|mistake/i.test(JSON.stringify(later)), 'the genome called a decision good or bad after an outcome');

// ---- nothing is rated, scored, ranked or weighted.
const FORBIDDEN = /^(quality|score|scores|rating|ratings|verdict|rank|ranking|grade|weight|weights|probability|priority|leaderboard|performance|health|bestPractice)$/i;
const offending = (o, path = '', acc = []) => {
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      // The causal beliefs are Phase 8's own records; the genome only carries them.
      if (k === 'causal') continue;
      if (FORBIDDEN.test(k)) acc.push(`${path}.${k}`);
      offending(v, `${path}.${k}`, acc);
    }
  }
  return acc;
};
const all = unwrap(await s.genome.viewAt(s.scope), 'all');
c.check('no-score', offending(all).length === 0, `a genome view carries ${offending(all).slice(0, 5).join(', ')}`);
const sim = unwrap(await s.genome.findSimilar(s.scope, { episodeId: g.episodes.E1.episode.id, require: ['decisionType', 'businessUnit'] }), 'sim');
c.check('no-score', offending(sim).length === 0, `a similarity result carries ${offending(sim).slice(0, 5).join(', ')}`);
c.check('no-person-view', Object.keys(s.genome).every((m) => !/byPerson|byManager|byAuthor|byOwner|byCommitter|leaderboard|performance/i.test(m)), 'the genome offers a per-person view');
const statuses = new Set(all.patterns.map((v) => v.status));
c.check('no-score', [...statuses].every((x) => ['EMERGING', 'RECURRING', 'SUPPORTED', 'CONTESTED', 'RETIRED'].includes(x)), 'a pattern status outside the five');

// ---- no inference: a pattern is a person's proposal and HELM checks it.
const methods = Object.keys(s.genome);
const FORBIDDEN_METHOD = /infer|discover|mine|learn|predict|recommend|optimi|apply|promote|enforce|autoUpdate|setPolicy|recalculat|propagat|simulate|forecast/i;
c.check('no-inference', methods.every((m) => !FORBIDDEN_METHOD.test(m)), `the genome exposes ${methods.filter((m) => FORBIDDEN_METHOD.test(m)).join(', ')}`);
c.check('no-inference', !methods.includes('suggestPattern') && !methods.includes('proposePatternFrom'), 'the genome can propose a pattern by itself');
const dir = join(process.cwd(), 'packages', 'genome-runtime', 'src');
// meridianGenome.ts is the demonstration's seed: it builds DECISIONS through the decision runtime so there is
// something to remember, exactly as an application would. It is a consumer of the kernel, not part of the genome.
for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && x !== 'meridianGenome.ts')) {
  const code = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\r\n]*/g, ' ');
  const w = /\.(recordObservation|execute|executeBaseline|addOverride|createScenario|commit|createCommitment|recordApproval|recordOutcomeReview|createClaim|reviseClaim|recordEvidence|linkEvidence|supportClaim|declareGovernanceProfile|appendEvent|setState|saveSnapshot|buildSnapshot|register\w*|upsertValueNode|createValueNode|appendStep|createRelationship|upsertEntity)\s*\(/.exec(code);
  c.check('no-write-below', !w, `${f} calls ${w?.[1]} — the genome never changes what it remembers`);
  c.check('no-inference', !/\b(mlPredict|regression|clustering|kmeans|embedding|cosineSimilarity|levenshtein)\b/i.test(code), `${f} uses a statistical similarity or learning technique`);
}

c.finish('genome operations leave decisions, snapshots, claims, formulas, runs and observations identical; a terrible outcome recorded later changes only the outcome section; no score, rank, weight or verdict at any depth; no inference method; nothing written below');
