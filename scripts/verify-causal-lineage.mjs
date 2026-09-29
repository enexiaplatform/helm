/**
 * verify:causal-lineage — every belief answers where it came from.
 *
 * Every claim names its author and record time; every piece of evidence its
 * source system, reference, asserter and method; H1 links to the twin
 * snapshots it explains, the value node and the customer; "why do we believe
 * X influences Y?" returns mechanism, evidence for and against, scope, period
 * and status; C3 links the decision assumption it rests on; the twin
 * difference is traced model-side and cause-side separately.
 */

import { explainTwinDifferenceCausally } from '../packages/causal-runtime/src/index.ts';
import { buildCausalStory, contract, unwrap, valueKey } from './lib/causalStack.mjs';

const c = contract('verify:causal-lineage');
const s = await buildCausalStory();
const k = s.causalStory.claims;

const all = unwrap(await s.causal.listClaims(s.scope), 'claims');
for (const v of all) {
  c.check('claim-provenance', !!v.claim.authoredByLabel && !!v.claim.recordedAt && v.claim.authoredBy !== undefined, `claim ${v.claim.id} does not say who authored it and when`);
  c.check('claim-rationale', v.revision.rationale.trim().length > 0, `claim ${v.claim.id} gives no rationale`);
}
const evidence = unwrap(await s.causal.listEvidence(s.scope), 'evidence');
for (const e of evidence) {
  const p = e.provenance;
  c.check('evidence-provenance', !!p.sourceSystem && !!p.sourceReference && !!p.assertedByLabel && !!p.method && !!e.recordedAt, `evidence ${e.id} does not answer where it came from and who asserted it`);
}
c.check('demo-labelled', Object.values(s.causalStory.evidence).every((e) => /DEMO CAUSAL HYPOTHESES/.test(e.provenance.sourceReference)), 'a piece of demo evidence is not labelled DEMO');

const ex = unwrap(await s.causal.explainClaim(s.scope, k.H1.claim.id), 'explain');
const kinds = new Set(ex.lineage.map((r) => r.kind));
for (const kind of ['TWIN_SNAPSHOT', 'VALUE_NODE', 'ENTITY', 'SOURCE_DOCUMENT']) c.check('claim-lineage', kinds.has(kind), `H1 lineage has no ${kind}`);
c.check('claim-lineage', ex.lineage.some((r) => r.kind === 'TWIN_SNAPSHOT' && r.id === s.story.CF1.snapshot.id) && ex.lineage.some((r) => r.kind === 'TWIN_SNAPSHOT' && r.id === s.story.S2.snapshot.id), 'H1 does not link CF1 and S2');
c.check('explanation', /Why do we believe/.test(ex.question), 'the explanation does not state the question it answers');
c.check('explanation', ex.mechanism.length === 3 && ex.supporting.length === 3 && ex.scope.kind === 'ANCHORED' && ex.applicablePeriod !== undefined && ex.view.evaluation.status === 'SUPPORTED', 'the explanation lacks mechanism, evidence, scope, period or status');
c.check('explanation', ex.supporting.every((a) => a.strengthNote.length > 0), 'a piece of evidence is not explained against the hierarchy');

const c3 = k.C3.revision.links;
c.check('decision-lineage', c3.some((r) => r.kind === 'DECISION' && r.id === s.story.decisionId), 'C3 does not link the decision it rests on');
c.check('decision-lineage', c3.some((r) => r.kind === 'ASSUMPTION' && r.pin === s.story.decisionId && /on-time delivery/.test(r.label ?? '')), 'C3 does not link the decision assumption');

const cfKey = s.story.CF1.items.find((i) => i.kind === 'VALUE' && i.state.nodeId === s.nodeIds.grossMarginPctOpp).key;
const x = unwrap(await explainTwinDifferenceCausally({ twin: s.twin, causal: s.causal }, s.scope, { fromId: s.story.CF1.snapshot.id, toId: s.story.S2.snapshot.id, itemKey: cfKey, toItemKey: valueKey(s.nodeIds.grossMarginPctOpp, 'ACTUAL') }), 'twin');
const cost = x.causal.find((ci) => ci.moved.metricKey === 'Opex');
c.check('twin-lineage', cost?.moved.before === '165000000' && /ACTUAL observation \(finance\)/.test(cost?.moved.afterSource ?? ''), 'the model side does not trace fulfilment cost to Finance\'s actual');
c.check('twin-lineage', cost?.questions[0]?.question.target.fromSnapshotId === s.story.CF1.snapshot.id, 'the causal side does not trace to the question about this very difference');

c.finish(`${all.length} claims and ${evidence.length} evidence items with provenance; H1 → CF1, S2, value node, customer, invoice; C3 → decision and assumption; model and cause traced apart`);
