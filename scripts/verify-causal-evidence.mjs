/**
 * verify:causal-evidence — the evidence policy (ADR-0027).
 *
 * The hierarchy caps each kind of evidence; count never decides; a credible
 * contradiction contests, a HIGH one refutes; the cause after the effect counts
 * against; a correlation cited as evidence is LOW; judgement is labelled as
 * judgement; a correction supersedes and the original stays.
 */

import { EVIDENCE_CEILING } from '../packages/causal-runtime/src/index.ts';
import { at, buildCausalStory, contract, unwrap } from './lib/causalStack.mjs';

const c = contract('verify:causal-evidence');
const s = await buildCausalStory();
const pharma = { kind: 'ANCHORED', anchors: [{ entityId: s.governance.entities.buPharma.entityId, label: 'Pharma BU', dimension: '' }] };
let n = 0;
const claim = async () =>
  unwrap(
    await s.causal.createClaim(s.scope, {
      causeKey: 'PRICE_DISCOUNT', effectKey: 'SALES_VOLUME', relationshipType: 'INCREASES', scope: pharma,
      conditions: [{ statement: `contract fixture ${(n += 1)}`, refs: [] }], authoredByLabel: 'contract', statement: 'fixture', rationale: 'fixture',
    }),
    'claim',
  );
const ev = async (type, strength, extra = {}) =>
  unwrap(await s.causal.recordEvidence(s.scope, { type, statement: type, assessedStrength: strength, strengthRationale: 'contract', provenance: { sourceSystem: 'manual', sourceReference: 'contract', method: type === 'MANAGEMENT_EXPERTISE' ? 'JUDGEMENT' : 'ANALYSIS', assertedByLabel: 'contract' }, ...extra }), 'evidence');
const link = async (cl, e, stance = 'SUPPORTS') => unwrap(await s.causal.linkEvidence(s.scope, cl.claim.id, e.id, stance, 'contract'), 'link');

c.check('hierarchy', EVIDENCE_CEILING.CONTROLLED_EXPERIMENT === 'HIGH' && EVIDENCE_CEILING.NATURAL_EXPERIMENT === 'HIGH', 'experiments cannot be HIGH');
c.check('hierarchy', EVIDENCE_CEILING.MANAGEMENT_EXPERTISE === 'LOW', 'judgement is not capped at LOW');
c.check('hierarchy', ['INTERVENTION', 'REPEATED_PATTERN', 'PROCESS_MECHANISM', 'LONGITUDINAL_OBSERVATION', 'STATISTICAL_ANALYSIS', 'EXTERNAL_RESEARCH'].every((t) => EVIDENCE_CEILING[t] === 'MEDIUM'), 'observational evidence is not capped at MEDIUM');

// Count never decides.
const weak = await claim();
let v;
for (let i = 0; i < 6; i += 1) v = await link(weak, await ev('MANAGEMENT_EXPERTISE', 'HIGH'));
c.check('count-never-decides', v.evaluation.status === 'HYPOTHESIS', `six judgements made a claim ${v.evaluation.status}`);
c.check('ceiling', v.evaluation.assessments.every((a) => a.strength === 'LOW'), 'a judgement graded HIGH was counted above LOW');
const same = await claim();
await link(same, await ev('REPEATED_PATTERN', 'MEDIUM'));
v = await link(same, await ev('REPEATED_PATTERN', 'MEDIUM'));
c.check('independence', v.evaluation.status === 'HYPOTHESIS', 'two MEDIUM items of the same kind made a claim SUPPORTED');
const strong = await claim();
v = await link(strong, await ev('CONTROLLED_EXPERIMENT', 'HIGH'));
c.check('strength', v.evaluation.status === 'SUPPORTED' && v.evaluation.confidence === 'HIGH', 'one HIGH controlled experiment did not support a claim');

// Contradiction is weighed, not outvoted.
const contested = await claim();
await link(contested, await ev('INTERVENTION', 'MEDIUM'));
await link(contested, await ev('REPEATED_PATTERN', 'MEDIUM'));
await link(contested, await ev('MANAGEMENT_EXPERTISE', 'LOW'));
v = await link(contested, await ev('NATURAL_EXPERIMENT', 'MEDIUM'), 'CONTRADICTS');
c.check('contradiction', v.evaluation.status === 'CONTESTED', `three supports against one credible contradiction gave ${v.evaluation.status}`);
c.check('contradiction', v.evaluation.counts.supporting === 3, 'supporting evidence disappeared when a contradiction arrived');
const refuted = await claim();
await link(refuted, await ev('INTERVENTION', 'MEDIUM'));
v = await link(refuted, await ev('CONTROLLED_EXPERIMENT', 'HIGH'), 'CONTRADICTS');
c.check('contradiction', v.evaluation.status === 'REFUTED', `a HIGH contradiction gave ${v.evaluation.status}`);
const d1Then = unwrap(await s.causal.getClaim(s.scope, s.causalStory.claims.D1.claim.id, at('2027-02-01T00:00:00.000Z')), 'D1 then');
c.check('contradiction', d1Then.evaluation.status === 'SUPPORTED' && s.causalStory.claims.D1.evaluation.status === 'CONTESTED', 'the canonical discount claim did not move SUPPORTED → CONTESTED');

// Order eliminates, it does not prove.
const h4 = s.causalStory.claims.H4.evaluation;
c.check('temporal', h4.temporalConflicts === 1 && h4.status !== 'SUPPORTED' && h4.assessments[0].countedAs === 'CHALLENGE', 'a cause observed after its effect was counted as support');
const e2 = s.causalStory.claims.H1.evaluation.assessments.find((a) => a.evidence.id === s.causalStory.evidence.E2.id);
c.check('temporal', e2?.temporal === 'CAUSE_PRECEDES_EFFECT' && /does not show influence/.test(e2.note ?? ''), 'the right order is presented as proof');

// Correlation is LOW; judgement is labelled.
const corrEv = await ev('STATISTICAL_ANALYSIS', 'MEDIUM', {
  statistical: { method: 'co-movement', population: 'p', period: 'q', effectEstimate: 'e', uncertainty: 'u', limitations: 'l' },
  correlationFindingId: s.causalStory.correlation.id,
});
v = await link(await claim(), corrEv);
c.check('correlation', v.evaluation.assessments[0].strength === 'LOW', 'evidence citing a correlation counted above LOW');
const mislabelled = await s.causal.recordEvidence(s.scope, { type: 'MANAGEMENT_EXPERTISE', statement: 'x', assessedStrength: 'LOW', strengthRationale: 'x', provenance: { sourceSystem: 'manual', sourceReference: 'x', method: 'MEASUREMENT', assertedByLabel: 'x' } });
c.check('judgement', !mislabelled.ok, 'a judgement was recorded as a measurement');
const counterCase = await ev('CONTRADICTORY_CASE', 'MEDIUM');
const asSupport = await s.causal.linkEvidence(s.scope, (await claim()).claim.id, counterCase.id, 'SUPPORTS', 'x');
c.check('contradictory-case', !asSupport.ok, 'a contradictory case was linked as support');

// Corrections supersede.
const fixed = await claim();
const first = await ev('INTERVENTION', 'MEDIUM');
await link(fixed, first);
await link(fixed, await ev('REPEATED_PATTERN', 'MEDIUM'));
const beforeCorrection = s.clock.now().toISOString();
unwrap(await s.causal.correctEvidence(s.scope, first.id, { type: 'INTERVENTION', statement: 'confounded', assessedStrength: 'LOW', strengthRationale: 'x', provenance: { sourceSystem: 'erp', sourceReference: 'x', method: 'ANALYSIS', assertedByLabel: 'x' } }), 'correct');
const nowV = unwrap(await s.causal.getClaim(s.scope, fixed.claim.id), 'now');
const thenV = unwrap(await s.causal.getClaim(s.scope, fixed.claim.id, at(beforeCorrection)), 'then');
c.check('correction', nowV.evaluation.status === 'HYPOTHESIS' && thenV.evaluation.status === 'SUPPORTED', 'a correction did not supersede from its record time, or rewrote the past');
c.check('correction', unwrap(await s.causal.listEvidence(s.scope), 'all').some((e) => e.id === first.id), 'the corrected original was removed');

c.finish('ceilings by kind, count never decides, contradiction contests or refutes, cause-after-effect counts against, correlation LOW, judgement labelled, corrections supersede');
