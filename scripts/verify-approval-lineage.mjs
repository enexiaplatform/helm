/**
 * verify:approval-lineage — "on what authority was this approved?" resolves
 * all the way down to a source fact.
 *
 *   approval act → required approval → authority evaluation → authority rule
 *   (and its policy version) → role + scope → commitment → chosen scenario
 *   run → computed consequence → calculation trace → source observation
 *
 * Every step is a REFERENCE into something that already exists. And the
 * decision timeline records the governance acts in order, appended, never
 * rewritten: commitment recorded, authority evaluated, approval requested,
 * approval granted.
 */

import { buildAuthorityStack, unwrap, USERS } from './lib/authorityStack.mjs';

const failures = [];
const check = (rule, cond, detail) => {
  if (!cond) failures.push({ rule, detail });
};

const stack = await buildAuthorityStack();
const { authority, scope } = stack;
const canonical = await stack.commitCanonical();
const { evaluation, required } = unwrap(await authority.evaluate(scope, canonical.commitment.id), 'evaluate');
const act = unwrap(await authority.recordApproval(stack.as(USERS.countryGM), required[0].id, { comments: 'Approved within Country GM authority.' }), 'approve');
const lineage = unwrap(await authority.explainApproval(scope, act.id), 'lineage');

// act → requirement → evaluation
check('act', lineage.act.id === act.id && lineage.act.requiredApprovalId === required[0].id, 'the act does not resolve its requirement');
check('requirement', lineage.requirement.evaluationId === evaluation.id, 'the requirement does not resolve its evaluation');
check('requirement', lineage.requirement.commitmentFingerprint === canonical.commitment.fingerprint, 'the requirement is not bound to the commitment fingerprint');
check('evaluation', lineage.evaluation.fingerprint === evaluation.fingerprint && lineage.evaluation.commitmentId === canonical.commitment.id,
  'the evaluation does not resolve the commitment it judged');

// evaluation → rule → policy → role + scope
check('rule', lineage.basisRule.id === required[0].basisRuleId && lineage.basisRule.key === 'country-gm-inventory-allocation',
  'the approval does not rest on the Country GM\'s rule');
check('policy', lineage.basisPolicy.reference === 'DOA-2026-04' && lineage.basisPolicy.version === 1 && lineage.basisPolicy.demo === true,
  'the rule does not resolve its policy version and its DEMO provenance');
check('policy', lineage.basisPolicy.rationale.length > 20, 'the policy does not say why the authority exists');
check('role', lineage.basisRule.holder.kind === 'ROLE' && lineage.basisRule.holder.roleId === lineage.act.approverRoleId, 'the rule\'s role is not the approver\'s role');
check('role', lineage.approverOccupancy?.userId === USERS.countryGM && lineage.approverOccupancy?.roleId === lineage.act.approverRoleId,
  'the approver\'s seat does not resolve to an occupancy of the required role');
check('scope', lineage.basisRule.scope.some((s) => s.dimension === 'COUNTRY'), 'the rule\'s scope is not resolvable');
check('scope', lineage.evaluation.scope.touched.length > 0 && lineage.evaluation.scope.touched.every((t) => t.path.length > 0),
  'the scope the rule was checked against does not carry its graph paths');

// commitment → chosen run → consequence → calculation → observation
check('commitment', lineage.commitment.id === canonical.commitment.id && lineage.commitment.chosenAlternativeId === canonical.commitment.chosenAlternativeId,
  'the lineage does not resolve the commitment and its chosen alternative');
const chosen = Object.values(canonical.alternatives).find((a) => a.id === canonical.commitment.chosenAlternativeId);
check('run', lineage.chosenRunId === chosen.scenarioRunId, 'the consequences do not come from the chosen alternative\'s run');
const cash = lineage.valueLineage.find((l) => l.value.metricKey === 'CashImpact');
check('consequence', cash && cash.value.value === '-1735500000', 'the cash consequence does not resolve to its computed value');
check('calculation', cash?.calculationRunId && cash?.lineage, 'the cash consequence has no calculation trace');
/** Walks the engine's lineage to the leaves: facts that were observed, not calculated. */
const leaves = (node, out = []) => {
  if (!node || typeof node !== 'object') return out;
  if (node.source && node.source.method && node.source.method !== 'calculated') out.push(node);
  for (const input of node.inputs ?? []) leaves(input, out);
  return out;
};
const facts = leaves(cash?.lineage);
check('source', facts.length > 0, 'the calculation trace does not reach a source observation');
check('source', facts.some((f) => f.source.system === 'memoire' || f.source.system === 'scm'),
  'no leaf of the trace is a fact from a source system (Memoire or SCM)');
check('source', lineage.valueLineage.length >= 2, 'fewer than two consequences resolve to lineage');

// the timeline
const timeline = unwrap(await stack.decisions.timeline(scope, canonical.decision.id), 'timeline').map((e) => e.eventType);
const order = ['COMMITTED', 'AUTHORITY_EVALUATED', 'APPROVAL_REQUESTED', 'APPROVAL_GRANTED'];
for (const t of order) check('timeline', timeline.includes(t), `${t} is not on the decision timeline`);
check('timeline', order.every((t, i) => i === 0 || timeline.indexOf(order[i - 1]) < timeline.indexOf(t)), 'the governance events are out of order');

if (failures.length === 0) {
  console.log(
    'verify:approval-lineage — ok (act → requirement → evaluation → rule DOA-2026-04 v1 → Country GM seat and scope → commitment → ' +
      'chosen run → cash impact → calculation trace → source observation; timeline in order)',
  );
  process.exit(0);
}
console.error(`verify:approval-lineage — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
