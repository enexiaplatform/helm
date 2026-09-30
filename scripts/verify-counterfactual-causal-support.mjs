/**
 * verify:counterfactual-causal-support — Scenario ≠ Counterfactual, and an
 * executable formula proves nothing about causes.
 *
 *   - causal support is derived at the world's OWN lens, per moved input ×
 *     compared metric, from the Causal Graph — never from the formula that
 *     computed the value; the known value dependency is shown apart;
 *   - it is a statement about evidence (MODEL_ONLY … CAUSALLY_SUPPORTED),
 *     carries no number, and even the strongest level leaves the value a
 *     model result;
 *   - a scenario is an ex-ante exploration, a counterfactual an ex-post
 *     alternative anchored to history: computing a world writes nothing below
 *     it except scenarios labelled as counterfactual, and leaves decisions,
 *     commitments, reviews, snapshots, claims, formulas and observations
 *     byte-identical.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildCounterfactualStory, contract, rohtoAlternatives, unwrap } from './lib/counterfactualStack.mjs';

const c = contract('verify:counterfactual-causal-support');
const s = await buildCounterfactualStory();
const g = s.counterfactualStory;

// ---- support is derived at each world's own lens.
const then = g.worlds.cf1Then.causal;
const hind = g.worlds.cf1Hindsight.causal;
c.check('own-lens', JSON.stringify(then.lens) === JSON.stringify(g.worlds.cf1Then.world.knowledge), 'support for the as-known-then world was read at another lens than the world\'s');
c.check('own-lens', then.level === 'MODEL_ONLY', `as known then, the January claims did not exist yet: support should be MODEL_ONLY, got ${then.level}`);
c.check('own-lens', hind.level !== 'MODEL_ONLY' && hind.pairs.some((p) => p.state === 'SUPPORTED_PATH'), 'with hindsight the recorded claim supports no link');
c.check('own-lens', hind.pairs.filter((p) => p.state === 'SUPPORTED_PATH').every((p) => p.claims.every((k) => k.status === 'SUPPORTED' && k.applies)), 'a link counted as supported rests on a claim that is not SUPPORTED or does not apply to the case\'s scope');

// ---- a formula is not a cause.
c.check('formula-not-cause', hind.pairs.every((p) => p.modelDependency === null || typeof p.modelDependency === 'string'), 'the known value dependency is not shown apart');
const pathOnlyByFormula = hind.pairs.filter((p) => p.modelDependency !== null && p.state === 'NO_CAUSAL_KNOWLEDGE');
c.check('formula-not-cause', pathOnlyByFormula.every((p) => p.claims.length === 0), 'a pair with only a value dependency carries causal claims');
c.check('statement', /not a causal finding/.test(then.statement) && /not identification of the effect/.test(hind.level === 'CAUSALLY_SUPPORTED' ? hind.statement : 'not identification of the effect'), 'the support statement claims more than evidence');
for (const key of Object.keys(hind)) c.check('no-number', !/score|probab|weight|confidence/i.test(key), `causal support carries a ${key}`);
for (const p of hind.pairs) for (const key of Object.keys(p)) c.check('no-number', !/score|probab|weight|contribution|percent/i.test(key), `a pair carries ${key}`);
const stmt = JSON.stringify([g.worlds.cf1Hindsight.causal, g.comparison]);
c.check('no-attribution', !/\b\d+(\.\d+)?%\s+(of the|due to|caused)/i.test(stmt) && !/caused the difference|because of the reallocation/i.test(stmt), 'a comparison attributes a percentage of the difference to a cause');

// ---- Scenario ≠ Counterfactual.
const scenarios = unwrap(await s.scenarios.listScenarios(s.scope), 'scenarios');
const labelled = scenarios.filter((x) => /^cf-/.test(x.key));
c.check('scenario-label', labelled.length >= 2, 'no scenario was created for the computed counterfactual worlds');
for (const sc of labelled) {
  c.check('scenario-label', !!sc.metadata?.counterfactual?.caseId, `scenario ${sc.key} is not labelled as a counterfactual world`);
  c.check('scenario-label', sc.status === 'COMPUTED' || sc.status === 'ARCHIVED', `scenario ${sc.key} was left ${sc.status}`);
}
const decisionScenarios = unwrap(await s.decisionStore.listAlternatives(s.scope, unwrap(await s.decisionStore.listRevisions(s.scope, s.story.decisionId), 'revisions')[0].id), 'alternatives').map((a) => a.scenarioId).filter(Boolean);
c.check('scenario-label', labelled.every((sc) => !decisionScenarios.includes(sc.id)), 'a counterfactual scenario was bound to a decision alternative: an ex-post world became an ex-ante option');

// ---- computing a world leaves the kernel byte-identical (except labelled scenarios).
const alts = await rohtoAlternatives(s);
const fingerprint = async () => {
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
  const own = unwrap(await s.scenarios.listScenarios(s.scope), 'scenarios').filter((x) => !/^cf-/.test(x.key)).map((x) => `${x.id}:${x.key}:${x.status}`).sort();
  const obs = [];
  for (const n of unwrap(await s.valueGraph.findValueNodes(s.scope), 'nodes')) {
    obs.push(...unwrap(await s.valueGraph.getObservations(s.scope, { nodeId: n.id }), 'obs').filter((o) => o.observationType !== 'SCENARIO').map((o) => `${o.id}:${o.observationType}:${o.numericValue}`));
  }
  return JSON.stringify({ parts: parts.sort(), snapshots, claims, calcs, own, obs: obs.sort() });
};
const before = await fingerprint();
const extra = unwrap(
  await s.counterfactual.openCase(s.scope, {
    decisionId: s.story.decisionId,
    title: 'kernel untouched',
    question: 'Untouched?',
    intervention: { kind: 'CHOOSE_ALTERNATIVE', alternativeId: alts.expedite.id },
    anchorSnapshotId: s.story.S0.snapshot.id,
    scope: { kind: 'ANCHORED', anchors: [{ entityId: s.governance.entities.buPharma.entityId, label: 'Pharma BU', dimension: '' }] },
    authoredByLabel: 'contract',
  }),
  'open',
);
unwrap(await s.counterfactual.estimate(s.scope, extra.case.id, { lens: 'AS_KNOWN_THEN', byLabel: 'contract' }), 'estimate');
unwrap(await s.counterfactual.compare(s.scope, extra.case.id), 'compare');
unwrap(await s.counterfactual.recordReview(s.scope, extra.case.id, { statement: 'A reading.', limitations: 'A limitation.', reviewedByLabel: 'contract' }), 'review');
c.check('kernel-untouched', before === (await fingerprint()), 'a counterfactual operation changed a decision, commitment, review, snapshot, claim, formula, non-counterfactual scenario or observation');

// ---- the source never writes below the scenario runtime, and never rebases an alternative.
const dir = join(process.cwd(), 'packages', 'counterfactual-runtime', 'src');
for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && x !== 'meridianCounterfactual.ts')) {
  const code = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\r\n]*/g, ' ');
  const w = /\.(recordObservation|commit|createCommitment|recordApproval|recordOutcomeReview|createClaim|reviseClaim|recordEvidence|linkEvidence|supportClaim|declareGovernanceProfile|appendEvent|saveSnapshot|buildSnapshot|register\w*|upsertValueNode|createValueNode|appendStep|createRelationship|upsertEntity|rebase\w*|createRevision|reviseScenario)\s*\(/.exec(code);
  c.check('no-write-below', !w, `${f} calls ${w?.[1]} — a counterfactual never changes what it reviews`);
  c.check('no-inference', !/\b(doCalculus|causalDiscovery|propensity|regression|bayesian|structuralEquation)\w*/i.test(code), `${f} infers or estimates causes statistically`);
}

c.finish('support derived at each world\'s own lens, per input × metric, never from a formula, no number; labelled counterfactual scenarios only; kernel byte-identical; no write below, no inference');
