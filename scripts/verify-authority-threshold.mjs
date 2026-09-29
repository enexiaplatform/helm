/**
 * verify:authority-threshold — thresholds are exact lines on COMPUTED
 * consequences.
 *
 *   1. The boundary is exact: 999 999 999, 1 000 000 000 and 1 000 000 001 VND
 *      are three different answers, on both sides of the sign, with no
 *      floating-point ambiguity (ADR-0016).
 *   2. The values come from the chosen scenario run's future state — the node,
 *      the period and the run are named — not from anything typed.
 *   3. A multi-metric rule explains each line on its own.
 *   4. A BLOCKED, missing or foreign-currency value is UNKNOWN; UNKNOWN never
 *      passes and makes the verdict INDETERMINATE.
 *   5. There is no field for a typed amount anywhere in the authority types.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkCondition } from '@helm/authority-runtime';
import { buildAuthorityStack, unwrap } from './lib/authorityStack.mjs';

const failures = [];
const check = (rule, cond, detail) => {
  if (!cond) failures.push({ rule, detail });
};

const value = (v, currency = 'VND') => ({
  metricKey: 'CashImpact', label: 'Cash impact', nodeId: 'n', nodeLabel: 'n', runId: 'r', period: null, value: v,
  unit: 'currency', currency, origin: v === null ? 'BLOCKED' : 'COMPUTED', source: 'EXPECTED_OUTCOME', reason: v === null ? 'BLOCKED' : null,
});
const line = (comparator, threshold) => ({ metricKey: 'CashImpact', label: 'Cash impact', comparator, threshold, unit: 'currency', currency: 'VND' });
const at = (c, v) => checkCondition(c, [value(v)]).outcome;

// 1. exact boundaries
for (const [c, cases] of [
  [line('LTE', '1000000000'), [['999999999', 'PASS'], ['1000000000', 'PASS'], ['1000000001', 'FAIL']]],
  [line('GTE', '-1000000000'), [['-999999999', 'PASS'], ['-1000000000', 'PASS'], ['-1000000001', 'FAIL']]],
  [line('LT', '1000000000'), [['999999999', 'PASS'], ['1000000000', 'FAIL'], ['1000000001', 'FAIL']]],
  [line('GT', '-1000000000'), [['-999999999', 'PASS'], ['-1000000000', 'FAIL'], ['-1000000001', 'FAIL']]],
]) {
  for (const [v, expected] of cases) {
    const got = at(c, v);
    check('boundary', got === expected, `${v} against ${c.comparator} ${c.threshold} is ${got}, expected ${expected}`);
  }
}
check('precision', at(line('GTE', '-1000000000'), '-1000000000.0000000000000000000001') === 'FAIL', 'a difference at the 22nd decimal place was lost');
check('precision', at(line('GTE', '-1000000000'), '-1000000000.000') === 'PASS', 'trailing zeros changed the answer');
check('precision', checkCondition(line('GTE', '-1000000000'), [value('-999999999')]).value === '-999999999', 'the value was not kept exact');

// 4. unknown never passes
check('unknown', checkCondition(line('GTE', '0'), [value(null)]).outcome === 'UNKNOWN', 'a BLOCKED value was not UNKNOWN');
check('unknown', checkCondition(line('GTE', '0'), []).outcome === 'UNKNOWN', 'a missing value was not UNKNOWN');
check('unknown', checkCondition(line('GTE', '0'), [value('5', 'USD')]).outcome === 'UNKNOWN', 'a USD value was compared with a VND line');

// 2 & 3 on the real stack
const stack = await buildAuthorityStack();
const canonical = await stack.commitCanonical();
const { evaluation } = unwrap(await stack.authority.evaluate(stack.scope, canonical.commitment.id), 'evaluate');
const chosen = Object.values(canonical.alternatives).find((a) => a.id === canonical.commitment.chosenAlternativeId);
const state = unwrap(await stack.scenarios.getFutureState(stack.scope, chosen.scenarioRunId), 'future state');
for (const c of evaluation.consequences.filter((x) => x.value !== null)) {
  const v = state.values.find((x) => x.nodeId === c.nodeId);
  check('computed', c.runId === chosen.scenarioRunId, `${c.metricKey} was not read from the chosen run`);
  check('computed', v && v.value === c.value, `${c.metricKey} does not match the chosen future state`);
  check('computed', c.period !== null && c.nodeId !== null, `${c.metricKey} does not name its node and period`);
}
const gm = evaluation.rules.find((r) => r.ruleKey === 'country-gm-inventory-allocation');
check('multi-metric', gm?.conditionChecks.length === 2, 'the Country GM rule does not depend on two values');
check('multi-metric', gm?.conditionChecks.every((c) => c.outcome === 'PASS' && /against a line of/.test(c.statement)),
  'each line of the multi-metric rule is not explained on its own');
check('multi-metric', new Set(gm?.conditionChecks.map((c) => c.metricKey)).size === 2, 'the two lines are not on two different metrics');

// 4, end to end: the canonical evaluation with its cash impact BLOCKED is INDETERMINATE.
{
  const { evaluateAuthority } = await import('@helm/authority-runtime');
  const blocked = evaluation.consequences.map((c) =>
    c.metricKey === 'CashImpact' ? { ...c, value: null, origin: 'BLOCKED', reason: 'BLOCKED: an input is missing' } : c,
  );
  const e = evaluateAuthority({
    act: 'COMMIT',
    actAt: evaluation.actAt,
    actor: { userId: evaluation.actorUserId, label: evaluation.actorLabel },
    committerUserId: evaluation.actorUserId,
    decisionTypeKey: 'INVENTORY_ALLOCATION',
    knownDecisionTypes: ['INVENTORY_ALLOCATION'],
    scope: evaluation.scope,
    consequences: blocked,
    policies: unwrap(await stack.authority.listPolicies(stack.scope), 'policies'),
    rules: unwrap(await stack.authority.listRules(stack.scope), 'rules'),
    occupancies: unwrap(await stack.authority.listOccupancies(stack.scope), 'occupancies'),
    delegations: [],
  });
  check('unknown', e.result === 'INDETERMINATE', `a BLOCKED cash impact produced ${e.result}, not INDETERMINATE`);
  check('unknown', e.gaps.some((g) => g.code === 'METRIC_UNAVAILABLE' && g.blocking), 'the unavailable metric is not named');
}

// 5. no typed amounts in the authority types
{
  const types = readFileSync(join(process.cwd(), 'packages', 'authority-runtime', 'src', 'types.ts'), 'utf8');
  for (const word of ['approvalAmount', 'approvalMargin', 'approvalCash', 'amountAtStake', 'thresholdAmount']) {
    check('no-typed-economics', !new RegExp(`\\b${word}\\b`).test(types), `the authority types carry a typed economic field: ${word}`);
  }
}

if (failures.length === 0) {
  console.log(
    'verify:authority-threshold — ok (exact boundaries at ±1 000 000 000 with no float ambiguity; values read from the chosen run, ' +
      'node and period named; multi-metric lines explained apart; UNKNOWN never passes)',
  );
  process.exit(0);
}
console.error(`verify:authority-threshold — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
