/**
 * verify:causal-vs-calculation — CALCULATION_DEPENDENCY ≠ CAUSAL_RELATIONSHIP.
 *
 *   - the whole causal story leaves calculation definitions, scenario runs and
 *     observations byte-identical;
 *   - a claim between two metrics the model links has no evidence and stays a
 *     HYPOTHESIS: the dependency is reported beside it, never counted;
 *   - the model dependency and the causal claim are separate objects;
 *   - coincidence (a correlation, a co-movement) creates no claim, and asking
 *     why returns OPEN;
 *   - the causal runtime has no method that infers, discovers, promotes or
 *     re-computes, and never calls a write method below it.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { explainTwinDifferenceCausally } from '../packages/causal-runtime/src/index.ts';
import { buildCausalStack, buildCausalStory, contract, unwrap, valueKey } from './lib/causalStack.mjs';

const c = contract('verify:causal-vs-calculation');

const fingerprint = async (s) => {
  const calcs = s.registry.all().map((d) => `${d.key}@${d.version}:${d.outputMetricKey}<-${d.inputs.map((i) => i.metricKey).join(',')}`).sort();
  const runs = unwrap(await s.scenarios.listRuns(s.scope), 'runs').map((x) => `${x.id}:${x.fingerprint}:${x.status}`).sort();
  const obs = [];
  for (const n of unwrap(await s.valueGraph.findValueNodes(s.scope), 'nodes')) {
    obs.push(...unwrap(await s.valueGraph.getObservations(s.scope, { nodeId: n.id }), 'obs').map((o) => `${o.id}:${o.observationType}:${o.numericValue}`));
  }
  return JSON.stringify({ calcs, runs, obs: obs.sort() });
};

const stack = await buildCausalStack();
const before = await fingerprint(stack);
const s = await buildCausalStory(stack);
const after = await fingerprint(s);
c.check('model-untouched', before === after, 'recording causal claims and evidence changed the calculation model, a scenario run or an observation');

const k = s.causalStory.claims;
const dep = unwrap(await s.causal.modelDependency(s.scope, 'FULFILMENT_COST', 'GROSS_MARGIN_PCT'), 'dependency');
c.check('dependency-reported', dep?.kind === 'KNOWN_VALUE_DEPENDENCY', 'the model dependency of gross margin on fulfilment cost is not reported');
c.check('dependency-not-evidence', /does not count towards any causal claim/.test(dep?.statement ?? ''), 'the model dependency is not declared non-evidential');
const bare = unwrap(
  await s.causal.createClaim(s.scope, {
    causeKey: 'FULFILMENT_COST', effectKey: 'GROSS_MARGIN_PCT', relationshipType: 'DECREASES',
    scope: { kind: 'ANCHORED', anchors: [{ entityId: s.governance.entities.buIndustrial.entityId, label: 'Industrial BU', dimension: '' }] },
    authoredByLabel: 'contract', statement: 'claimed with no evidence', rationale: 'the model says so',
  }),
  'bare claim',
);
c.check('dependency-not-evidence', bare.evaluation.status === 'HYPOTHESIS' && bare.evaluation.confidence === 'NONE' && bare.evaluation.assessments.length === 0, `a claim the model already "explains" is ${bare.evaluation.status}/${bare.evaluation.confidence} with no evidence`);
c.check('separate', k.C2.evaluation.assessments.every((a) => a.evidence.type !== 'KNOWN_VALUE_DEPENDENCY'), 'the dependency was counted as C2\'s evidence');

const cfKey = s.story.CF1.items.find((i) => i.kind === 'VALUE' && i.state.nodeId === s.nodeIds.grossMarginPctOpp).key;
const x = unwrap(await explainTwinDifferenceCausally({ twin: s.twin, causal: s.causal }, s.scope, { fromId: s.story.CF1.snapshot.id, toId: s.story.S2.snapshot.id, itemKey: cfKey, toItemKey: valueKey(s.nodeIds.grossMarginPctOpp, 'ACTUAL') }), 'twin');
c.check('separate', x.model.movedInputs.length > 0 && x.causal.length === x.model.movedInputs.length, 'the model explanation and the causal investigation are not reported side by side');
c.check('separate', /not itself evidence/.test(x.important), 'the explanation does not say the dependency is not evidence');
c.check('separate', x.causal.find((ci) => ci.moved.metricKey === 'GrossMargin')?.state === 'NO_CAUSAL_KNOWLEDGE', 'a cause was attached to a model input nobody made a claim about');

const coincident = unwrap(await s.causal.listClaims(s.scope, { causeKey: 'INVENTORY_ALLOCATION_CHANGE' }), 'coincidence');
c.check('coincidence', coincident.length === 0, 'a correlation became a causal claim');
const why = unwrap(await s.causal.investigate(s.scope, s.causalStory.questions.satisfaction.id), 'why');
c.check('coincidence', why.status === 'OPEN', `asking why satisfaction improved returned ${why.status}`);

const methods = Object.keys(s.causal);
c.check('no-inference', methods.every((m) => !/infer|discover|promote|recalculat|propagat|simulate|learn|recommend|optimi/i.test(m)), `the causal runtime exposes ${methods.filter((m) => /infer|discover|promote|recalculat|propagat|simulate|learn|recommend|optimi/i.test(m)).join(', ')}`);
const dir = join(process.cwd(), 'packages', 'causal-runtime', 'src');
for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
  const code = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const w = /\.(recordObservation|execute|executeBaseline|addOverride|createScenario|register\w*|upsertValueNode|createValueNode|appendStep|createRelationship|upsertEntity)\s*\(/.exec(code);
  c.check('no-write-below', !w, `${f} calls ${w?.[1]} — a causal claim never changes the model`);
}

c.finish('the causal story leaves formulas, runs and observations identical; a modelled dependency is reported, never counted; coincidence creates no claim; no inference method, no write below');
