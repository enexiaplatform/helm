/**
 * verify:scenario-runtime — HELM can branch the enterprise into several
 * futures, and every future is computed by the one propagation engine.
 *
 *   1. There is no second calculation engine: the scenario runtime never calls
 *      a calculation's compute(), never does value arithmetic of its own, and
 *      reaches every number through PropagationEngine.execute().
 *   2. The canonical futures execute and differ because of their overrides:
 *      Expedite, Reallocate, Alternative product, Delay (two periods), and the
 *      P/T allocations of one stock position.
 *   3. An outcome cannot be overridden — the runtime and the engine both refuse.
 *   4. Feasibility: Delay's 2027-Q1 order is BREACHED by exactly 4 units.
 *   5. A comparison states differences and carries no score, rank or choice.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildStack, scope, valueOf } from '../packages/scenario-runtime/test/harness.mjs';
import { buildMeridianScenarios, Q4_2026 } from '../packages/scenario-runtime/src/index.ts';

const root = process.cwd();
const failures = [];
const check = (rule, cond, detail) => {
  if (!cond) failures.push({ rule, detail });
};
const must = (r, what) => {
  if (!r.ok) throw new Error(`${what}: ${r.error.code} — ${r.error.message}`);
  return r.value;
};

// ------------------------------------------------ 1. no second engine
const SRC = join(root, 'packages', 'scenario-runtime', 'src');
const stripNonCode = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
const VALUE_ARITHMETIC = ['scaleByRatio', 'scaleByCount', 'unitsPurchasable', 'percentageOf', 'ratioOf', 'difference', 'multiply'];
for (const f of readdirSync(SRC).filter((x) => x.endsWith('.ts'))) {
  const code = stripNonCode(readFileSync(join(SRC, f), 'utf8'));
  check('one-engine', !/\.compute\s*\(/.test(code), `scenario-runtime/src/${f} calls a calculation's compute() directly`);
  for (const fn of VALUE_ARITHMETIC) {
    check('one-engine', !new RegExp(`\\b${fn}\\s*\\(`).test(code),
      `scenario-runtime/src/${f} performs value arithmetic (${fn}) — outcomes come from the engine`);
  }
}
const runtimeSrc = readFileSync(join(SRC, 'runtime.ts'), 'utf8');
check('one-engine', /engine\.execute\s*\(/.test(runtimeSrc), 'the runtime never calls the propagation engine');

// ------------------------------------------- 2–5. the canonical futures
const s = await buildStack();
const built = must(await buildMeridianScenarios(s.runtime, scope, s.ids, { fork: s.fork }), 'canonical scenarios');
const base = must(await s.runtime.executeBaseline(scope, { fork: s.fork, periods: [Q4_2026] }), 'baseline');
const exec = {};
for (const key of Object.keys(built)) exec[key] = must(await s.runtime.execute(scope, built[key].scenario.id), key);
const v = (e, h, p = '2026-Q4') => valueOf(e.futureState, s.ids[h], p)?.value ?? null;

check('baseline', v(base, 'grossMargin') === '977200000', `baseline gross margin is ${v(base, 'grossMargin')}, expected 977200000`);
const margins = new Set(['expedite', 'reallocate', 'alternative-product', 'prioritize-rohto'].map((k) => v(exec[k], 'grossMargin')));
check('distinct', margins.size >= 3, 'the canonical futures do not differ in gross margin');
check('distinct', v(exec.expedite, 'coverage') !== v(base, 'coverage'), 'expediting does not move coverage');
check('periods', exec['delay-delivery'].run.periodRuns.length === 2, 'Delay does not simulate two periods');
check('periods', v(exec['delay-delivery'], 'expRevenue', '2026-Q4') === '0' && v(exec['delay-delivery'], 'expRevenue', '2027-Q1') === '2940000000',
  'Delay does not move Rohto revenue from 2026-Q4 to 2027-Q1');
check('allocation', v(exec['prioritize-rohto'], 'revenueAtRisk') === '1960000000' && v(exec['preserve-tender'], 'revenueAtRisk') === '2940000000',
  'the P/T allocations do not produce their revenue-at-risk trade-off');

// 3. outcomes cannot be overridden
{
  const c = must(await s.runtime.createScenario(scope, { key: 'forged', name: 'forged', fork: s.fork, periods: [Q4_2026] }), 'create');
  const r = await s.runtime.addOverride(scope, c.revision.id, {
    overrideType: 'VALUE_OVERRIDE', targetNodeId: s.ids.grossMargin, value: '1', unit: 'currency', currency: 'VND',
    provenanceKind: 'USER_OVERRIDE', rationale: 'state the answer instead of deriving it', confidence: 1,
  });
  check('derived-outcomes', !r.ok && r.error.code === 'scenario.override_targets_computed_node', 'an outcome was accepted as an override');
}

// 4. feasibility
{
  const c = exec['delay-delivery'].futureState.constraints.find(
    (x) => x.constraintKey === 'rohto-order-fulfilment' && x.period.start.startsWith('2027-01'),
  );
  check('constraints', c?.status === 'BREACHED' && c?.breachAmount === '4', `Delay 2027-Q1 is ${c?.status} by ${c?.breachAmount}, expected BREACHED by 4`);
}

// 5. comparison chooses nothing
{
  const cmp = must(
    await s.runtime.compare(scope, { baselineRunId: base.run.id, alternativeRunIds: Object.values(exec).map((e) => e.run.id) }),
    'compare',
  );
  // Field NAMES, not values: "score" is also a unit a metric can be measured in.
  const keys = new Set();
  const walk = (o) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') for (const [k, val] of Object.entries(o)) { keys.add(k.toLowerCase()); walk(val); }
  };
  walk(cmp);
  for (const word of ['recommend', 'winner', 'best', 'score', 'rank', 'preferred', 'chosen']) {
    const hit = [...keys].find((k) => k.includes(word));
    check('no-choice', !hit, `the comparison carries a "${hit}" field`);
  }
  check('no-choice', cmp.metricDeltas.length > 0 && cmp.assumptionDeltas.length > 0, 'the comparison is empty');
}

if (failures.length === 0) {
  console.log(
    `verify:scenario-runtime — ok (${Object.keys(exec).length} futures + baseline through one engine, ` +
      'outcomes derived, Delay breached by 4, comparison chooses nothing)',
  );
  process.exit(0);
}
console.error(`verify:scenario-runtime — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
