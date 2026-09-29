/**
 * verify:twin-lineage — no disconnected materialized values.
 *
 *   1. Every item of every canonical snapshot names at least one kernel object.
 *   2. "Why is this value here?" — for every calculated value in S2, the chain
 *      runs snapshot → item → calculation → source observation.
 *   3. A reported actual traces to its observation and source system.
 *   4. Attention reaches its cause items and, through them, kernel objects.
 *   5. "Why did gross margin differ between CF1 and S2?" — both branches are
 *      traced separately, and the attribution walks the traces to the one
 *      input that moved (fulfilment cost: the scenario override on one side,
 *      Finance's actual on the other), with the dependency-not-causality
 *      disclaimer.
 *   6. The governance item reaches the approval act, the rule and the policy
 *      version.
 */

import { ATTRIBUTION_DISCLAIMER } from '@helm/twin-runtime';
import { buildStory, contract, itemsOf, unwrap, valueKey } from './lib/twinStack.mjs';

const { check, finish } = contract('verify:twin-lineage');
const s = await buildStory();
const { story } = s;

// 1
let items = 0;
for (const key of ['S0', 'S1a', 'S1', 'CF1', 'S2', 'H23', 'pharmaS2', 'industrialS2']) {
  for (const i of story[key].items) {
    items += 1;
    check('refs', i.refs.length > 0, `${key}: ${i.key} names no kernel object`);
  }
}

// 2
const modelled = itemsOf(story.S2, 'VALUE').filter((v) => v.layer === 'MODELLED' && v.status === 'KNOWN');
check('calculated', modelled.length >= 8, `only ${modelled.length} modelled values in S2`);
let traced = 0;
for (const v of modelled) {
  const ex = unwrap(await s.twin.explainItem(s.scope, story.S2.snapshot.id, v.key), `explain ${v.key}`);
  const reachesCalc = ex.chain.some((l) => l.ref?.kind === 'CALCULATION_RUN');
  const reachesSource = ex.chain.some((l) => l.ref?.kind === 'OBSERVATION' && !/DERIVED/.test(l.ref.label ?? ''));
  check('calculated', reachesCalc && reachesSource, `${v.label}: the chain does not reach a calculation and a source observation`);
  if (reachesCalc && reachesSource) traced += 1;
}

// 3
const actual = unwrap(await s.twin.explainItem(s.scope, story.S2.snapshot.id, valueKey(s.nodeIds.grossMarginPctOpp, 'ACTUAL')), 'explain actual');
check('actual', actual.chain.some((l) => l.ref?.kind === 'OBSERVATION' && /finance/.test(l.detail)), 'the reported actual does not trace to Finance\'s observation');

// 4
for (const a of itemsOf(story.S2, 'ATTENTION')) {
  const ex = unwrap(await s.twin.explainItem(s.scope, story.S2.snapshot.id, a.key), `explain ${a.key}`);
  check('attention', a.state.causeItemKeys.every((k) => ex.chain.some((l) => l.ref?.kind === 'TWIN_ITEM' && l.ref.id === k)), `attention "${a.label}" does not reach its causes`);
  check('attention', a.refs.some((r) => r.kind !== 'TWIN_ITEM'), `attention "${a.label}" reaches no kernel object`);
}

// 5
const cfKey = itemsOf(story.CF1, 'VALUE').find((v) => v.state.nodeId === s.nodeIds.grossMarginPctOpp).key;
const d = unwrap(await s.twin.explainDifference(s.scope, story.CF1.snapshot.id, story.S2.snapshot.id, cfKey, valueKey(s.nodeIds.grossMarginPctOpp, 'ACTUAL')), 'difference');
check('difference', d.delta === '-0.6878', `the margin difference is ${d.delta}`);
check('difference', d.from.lineage.some((l) => /gross_margin_pct@1\.0\.0/.test(l.detail)) && d.to.lineage.some((l) => l.ref?.kind === 'OBSERVATION'), 'the expected and the actual branches are not both traced');
const gm = d.attribution.find((x) => x.metricKey === 'GrossMargin');
const opex = gm?.changedBecause.find((x) => x.metricKey === 'Opex');
check('difference', gm?.before === '952200000' && gm?.after === '931980000', 'gross margin is not attributed through the trace');
check('difference', opex?.before === '165000000' && opex?.after === '185220000' && /scenario override/.test(opex.beforeSource) && /ACTUAL observation \(finance\)/.test(opex.afterSource),
  'the moved input is not traced to the override on one side and the actual on the other');
check('difference', gm?.changedBecause.length === 1, 'inputs that did not move were attributed');
check('difference', d.disclaimer === ATTRIBUTION_DISCLAIMER && /not a causal claim/.test(d.disclaimer) && !/\bcaus/i.test(d.statement), 'the attribution is presented as causation');

// 6
const g = itemsOf(story.S2, 'GOVERNANCE')[0];
const gx = unwrap(await s.twin.explainItem(s.scope, story.S2.snapshot.id, g.key), 'explain governance');
check('governance', gx.chain.some((l) => l.ref?.kind === 'APPROVAL_ACT') && gx.chain.some((l) => l.ref?.kind === 'POLICY' && l.ref.pin === 'v1'), 'the governance item does not reach the act and the policy version');

finish(`${items} items all referenced; ${traced} modelled values traced to source; the CF1 → S2 margin gap attributed to fulfilment cost, not causation`);
