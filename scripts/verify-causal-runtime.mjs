/**
 * verify:causal-runtime — the canonical Rohto causal investigation.
 *
 * Why did fulfilment cost rise? H1 (expedited transfer by air) SUPPORTED on
 * two independent kinds of MEDIUM evidence; H2 and H3 UNRESOLVED; H4 WEAKENED
 * because its cause came after the effect; C3 left a HYPOTHESIS. Candidates are
 * only claims people proposed or authored; the question is answered without
 * apportioning the change; nothing is scored or ranked; traversal is bounded.
 */

import { buildCausalStory, contract, unwrap } from './lib/causalStack.mjs';

const c = contract('verify:causal-runtime');
const s = await buildCausalStory();
const k = s.causalStory.claims;

const expect = { H1: ['SUPPORTED', 'MODERATE'], H2: ['UNRESOLVED', 'LOW'], H3: ['UNRESOLVED', 'LOW'], H4: ['WEAKENED', 'NONE'], C2: ['SUPPORTED', 'MODERATE'], C3: ['HYPOTHESIS', 'LOW'], D1: ['CONTESTED', 'LOW'], L1: ['HYPOTHESIS', 'NONE'] };
for (const [name, [status, confidence]] of Object.entries(expect)) {
  c.check('canonical-status', k[name].evaluation.status === status, `${name} is ${k[name].evaluation.status}, expected ${status}`);
  c.check('canonical-confidence', k[name].evaluation.confidence === confidence, `${name} confidence is ${k[name].evaluation.confidence}, expected ${confidence}`);
  c.check('reasons', k[name].evaluation.reasons.length > 0, `${name} has a status with no reason`);
  c.check('policy', k[name].evaluation.policy === 'helm-causal-evidence@1', `${name} was judged under ${k[name].evaluation.policy}`);
}

const inv = unwrap(await s.causal.investigate(s.scope, s.causalStory.questions.fulfilment.id), 'investigate');
c.check('investigation', inv.status === 'SUPPORTED_EXPLANATION_EXISTS', `the fulfilment question is ${inv.status}`);
c.check('investigation', /does not apportion the change/.test(inv.statement), 'the investigation apportions the change among its explanations');
const proposed = inv.candidates.filter((x) => x.via === 'QUESTION').map((x) => x.view.claim.id).sort();
c.check('no-invented-causes', JSON.stringify(proposed) === JSON.stringify([k.H1, k.H2, k.H3, k.H4].map((v) => v.claim.id).sort()), 'the proposed candidates are not exactly H1–H4');
for (const x of inv.candidates) {
  c.check('no-invented-causes', x.via === 'QUESTION' || x.view.claim.effectKey === s.causalStory.questions.fulfilment.target.variableKey, `candidate ${x.view.claim.id} is neither proposed nor a claim about fulfilment cost`);
}
const sat = unwrap(await s.causal.investigate(s.scope, s.causalStory.questions.satisfaction.id), 'satisfaction');
c.check('unresolved-is-an-answer', sat.status === 'OPEN' && sat.candidates.length === 0, 'the satisfaction question produced a cause nobody proposed');

const text = JSON.stringify(inv);
c.check('no-scoring', !/"(score|rank|priority|probability|weight)"/i.test(text), 'the investigation carries a score, rank, priority, probability or weight');

const t = await s.causal.traverse(s.scope, { from: 'SERVICE_FAILURE', direction: 'DOWNSTREAM' });
c.check('bounded', !t.ok && t.error.code === 'causal.traversal_unbounded', 'traversal without maxDepth was allowed');
const loop = unwrap(await s.causal.traverse(s.scope, { from: 'SERVICE_FAILURE', direction: 'DOWNSTREAM', maxDepth: 8 }), 'loop');
c.check('cycles', loop.edges.length === 4 && loop.cycles === 1, `the feedback loop traversed ${loop.edges.length} edges with ${loop.cycles} cycles`);
const paths = unwrap(await s.causal.paths(s.scope, { from: 'EXPEDITED_TRANSFER', to: 'GROSS_MARGIN_PCT', maxDepth: 4 }), 'paths');
c.check('mediators', paths.length === 2 && paths.some((p) => p.variables.includes('AIR_FREIGHT_USAGE')), 'the mediated path through air-freight usage is missing');
c.check('no-scoring', paths.every((p) => /does not multiply confidences/.test(p.statement) && !('probability' in p)), 'a path carries a multiplied probability');
c.check('weakest-link', paths.find((p) => p.variables.length === 4)?.weakest === 'HYPOTHESIS', 'a path is not as supported as its weakest claim');

c.finish('Rohto: H1 SUPPORTED, H2/H3 UNRESOLVED, H4 WEAKENED, C3 HYPOTHESIS, D1 CONTESTED; candidates only from people; unresolved is an answer; bounded loops; no path probability');
