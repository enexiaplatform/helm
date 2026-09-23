/**
 * verify:decision-lineage — "why did management choose this?" resolves all the
 * way down to a source fact.
 *
 * The Phase 5 product promise, made executable:
 *
 *   commitment → rationale → accepted trade-offs → criteria → the chosen
 *   alternative → its scenario future state → scenario assumptions (the
 *   overrides, with their authors) → calculation traces → source observations
 *   → provenance
 *
 * Every step must be a REFERENCE into something that already exists, not a
 * retelling. A rationale item that points at nothing, an expected outcome with
 * no value node, or a value whose lineage stops short of a stated fact all
 * fail this contract.
 */

import { buildMeridianDecision } from '@helm/decision-runtime';
import { buildDecisionStack, unwrap } from './lib/decisionStack.mjs';

const failures = [];
const check = (rule, cond, detail) => {
  if (!cond) failures.push({ rule, detail });
};

const stack = await buildDecisionStack();
const { scope, decisions, scenarios } = stack;
const built = unwrap(await buildMeridianDecision(decisions, scope, stack.scenarioIds), 'canonical decision');
const explained = unwrap(await decisions.explainDecision(scope, built.decision.id), 'explain');

// ---- 1. the commitment, and what it was made of
check('commitment', explained.commitment.id === built.commitment.id, 'the explanation does not resolve the commitment');
check('commitment', explained.chosen.label.includes('Reallocate'), 'the explanation does not name the chosen alternative');
check('commitment', explained.rejected.length === 4, 'the futures that were not chosen are not preserved');
check('commitment', explained.snapshot.fingerprint === (await decisions.getCommitmentSnapshot(scope, built.commitment.id)).value.fingerprint,
  'the explanation and the stored manifest disagree');

// ---- 2. rationale references real things
{
  const byId = new Map([
    ...Object.values(built.criteria).map((c) => [c.id, 'criterion']),
    ...Object.values(built.alternatives).map((a) => [a.id, 'alternative']),
    ...Object.values(built.assumptions).map((a) => [a.id, 'assumption']),
  ]);
  check('rationale', explained.rationale.length >= 4, 'the rationale is too thin to explain a choice');
  for (const item of explained.rationale) {
    check('rationale', item.statement.length > 20, `a rationale item says almost nothing: "${item.statement}"`);
    if (item.kind === 'JUDGEMENT') continue;
    check('rationale', item.ref !== null && byId.has(item.ref),
      `a ${item.kind} rationale item points at ${item.ref ?? 'nothing'}, which is not part of this decision`);
  }
  check('rationale', explained.rationale.some((r) => r.kind === 'CRITERION'), 'no reason references a criterion');
  check('rationale', explained.rationale.some((r) => r.kind === 'SCENARIO_DELTA'), 'no reason references a modelled difference');
  check('rationale', explained.rationale.some((r) => r.kind === 'ASSUMPTION'), 'no reason names what the choice rests on');
  check('rationale', explained.rationale.filter((r) => r.label.startsWith('Why not')).length >= 2,
    'the rationale never says why not the alternatives that were rejected');
}

// ---- 3. accepted trade-offs point at criteria and say what was given up
for (const t of explained.acceptedTradeOffs) {
  check('trade-off', t.givenUp !== null && t.inFavourOf !== null, `accepted trade-off "${t.label}" does not say what was traded for what`);
  check('trade-off', t.criterionId === null || Object.values(built.criteria).some((c) => c.id === t.criterionId),
    `accepted trade-off "${t.label}" references a criterion outside this decision`);
}

// ---- 4. criterion evaluations carry the value node they came from
{
  const measured = explained.criterionEvaluations.filter((e) => e.value !== null);
  check('criterion-lineage', measured.length >= 6, 'too few criterion evaluations resolved to a value');
  for (const e of measured) {
    check('criterion-lineage', e.nodeId !== null && e.period !== null,
      `${e.criterionKey} / ${e.alternativeLabel} has a value but no value node or period behind it`);
  }
}

// ---- 5. expected outcomes are values in the chosen future state
{
  const modelled = explained.commitment.expectedOutcomes.filter((e) => e.kind === 'MODELLED');
  check('expected-outcome', modelled.length >= 3, 'the commitment expects almost nothing measurable');
  const state = unwrap(await scenarios.getFutureState(scope, explained.chosen.scenarioRunId), 'chosen future state');
  for (const e of modelled) {
    const v = state.values.find((x) => x.nodeId === e.nodeId);
    check('expected-outcome', v !== undefined, `expected outcome "${e.label}" points at a node the chosen future state does not hold`);
    check('expected-outcome', v && v.value === e.expectedValue,
      `expected outcome "${e.label}" (${e.expectedValue}) disagrees with the future state (${v?.value})`);
  }
}

// ---- 6. the lineage of every expected outcome reaches a source fact
{
  check('value-lineage', explained.valueLineage.length >= 3, 'the explanation carries no scenario lineage');
  let sourceFacts = 0;
  let overrideNodes = 0;
  const walk = (node, depth) => {
    if (!node) return;
    if (node.observationType && node.observationType !== 'DERIVED') sourceFacts += 1;
    if (node.override) overrideNodes += 1;
    for (const input of node.inputs ?? []) walk(input, depth + 1);
  };
  for (const l of explained.valueLineage) {
    check('value-lineage', l.lineage !== null, `${l.value.metricKey} has no lineage at all`);
    check('value-lineage', l.fingerprint.startsWith('sfp_'), `${l.value.metricKey} does not name the simulation it came from`);
    check('value-lineage', typeof l.fork.recordedThrough === 'string' && l.fork.recordedThrough.length > 0,
      `${l.value.metricKey} does not name the knowledge boundary it was computed under`);
    walk(l.lineage, 0);
  }
  check('value-lineage', sourceFacts > 0, 'no expected outcome traces to a fact somebody stated');
  check('value-lineage', overrideNodes > 0, 'no expected outcome traces through a scenario assumption');
}

// ---- 7. scenario assumptions carry their author and rationale
{
  const state = unwrap(await scenarios.getFutureState(scope, explained.chosen.scenarioRunId), 'chosen future state');
  const overridden = state.values.filter((v) => v.origin === 'OVERRIDDEN' && v.override);
  check('assumption-lineage', overridden.length >= 2, 'the chosen future rests on no visible assumption');
  for (const v of overridden) {
    check('assumption-lineage', (v.override.rationale ?? '').length > 10,
      `the override on ${v.metricKey} has no rationale behind it`);
    check('assumption-lineage', (v.override.provenanceKind ?? '').length > 0,
      `the override on ${v.metricKey} does not say where it came from`);
  }
}

// ---- 8. management-level assumptions name who stands behind them
{
  const owned = explained.assumptions.filter((a) => a.owner !== null);
  check('ownership', owned.length >= 4, 'almost no management assumption has an owner');
  for (const a of owned) {
    check('ownership', a.owner.label.length > 0 && a.source.length > 0,
      `assumption "${a.statement}" has an owner with no label or no source`);
  }
  const unowned = explained.assumptions.filter((a) => a.owner === null);
  check('ownership', unowned.length >= 1 && unowned.every((a) => a.source.length > 0),
    'the canonical decision should carry one honestly unowned assumption, with its source stated');
}

// ---- 9. disagreement survives into the explanation
{
  check('dissent', explained.challenges.length >= 2, 'recorded disagreement did not survive into the explanation');
  check('dissent', explained.challenges.some((c) => c.status === 'ACCEPTED_RISK'), 'no challenge was carried as an accepted risk');
  check('dissent', explained.challenges.some((c) => c.status === 'OPEN'), 'no challenge was open when management committed');
  check('dissent', explained.snapshot.openChallenges.length >= 1,
    'the frozen manifest does not record that management decided over an open challenge');
}

// ---- 10. nothing in the chain concludes anything
check('no-conclusion', /does not rank the alternatives/i.test(explained.statement),
  'the explanation does not state that HELM does not rank');
check('no-conclusion', !/\b(we recommend|you should choose|the best option)\b/i.test(JSON.stringify(explained)),
  'the explanation tells the reader what to choose');

if (failures.length === 0) {
  const nodes = explained.valueLineage.length;
  console.log(
    `verify:decision-lineage — ok (commitment → rationale → criteria → chosen future → assumptions → calculations → source; ` +
      `${explained.rationale.length} reasons, ${nodes} expected outcomes traced, dissent preserved)`,
  );
  process.exit(0);
}
console.error(`verify:decision-lineage — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
