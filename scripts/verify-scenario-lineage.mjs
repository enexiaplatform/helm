/**
 * verify:scenario-lineage — every value in every future is traceable:
 *
 *   Future State Value → Calculation Run → Scenario Revision → Override(s)
 *     → Baseline Input(s) → Source Provenance
 *
 *   1. Every computed scenario value explains down to source facts through the
 *      Phase 3 lineage — one lineage system, not two.
 *   2. Every override an execution used appears as an override node, resolves
 *      to a stored override of the revision (or its pinned ancestor), and an
 *      ADD continues into the baseline observation it adjusted.
 *   3. Every calculation run of a simulation names the revision it executed.
 *   4. The scenario fingerprint is canonical: 0.9, 0.90 and 0.900 are one
 *      simulation; a different knowledge boundary is a different one.
 */

import { buildStack, scope } from '../packages/scenario-runtime/test/harness.mjs';
import { buildMeridianScenarios, Q4_2026 } from '../packages/scenario-runtime/src/index.ts';

const failures = [];
const check = (rule, cond, detail) => {
  if (!cond) failures.push({ rule, detail });
};
const must = (r, what) => {
  if (!r.ok) throw new Error(`${what}: ${r.error.code} — ${r.error.message}`);
  return r.value;
};

const s = await buildStack();
const built = must(
  await buildMeridianScenarios(s.runtime, scope, s.ids, { fork: s.fork, only: ['expedite-price-increase', 'delay-delivery'] }),
  'scenarios',
);

let explained = 0;
let overrideNodes = 0;
for (const key of Object.keys(built)) {
  const exec = must(await s.runtime.execute(scope, built[key].scenario.id), key);
  const chainRevisions = new Set([built[key].revision.id, built[key].revision.parentRevisionId].filter(Boolean));
  const known = new Map();
  for (const rid of chainRevisions) {
    for (const o of must(await s.runtime.listOverrides(scope, rid), 'overrides')) known.set(o.id, o);
  }

  // 3. runs name the revision
  for (const pr of exec.run.periodRuns) {
    const calc = must(await s.engine.getRun(scope, pr.calculationRunId), 'calc run');
    check('run-names-revision', calc.context.scenarioRevisionId === built[key].revision.id,
      `${key}: a calculation run does not name the revision it executed`);
  }

  for (const v of exec.futureState.values.filter((x) => x.origin === 'COMPUTED')) {
    const ex = must(await s.runtime.explain(scope, exec.run.id, v.nodeId, v.period), `explain ${v.nodeLabel}`);
    explained += 1;
    // 1. reaches source facts
    const nodes = [];
    const walk = (n) => { nodes.push(n); n.inputs.forEach(walk); };
    walk(ex.lineage);
    check('reaches-source', nodes.some((n) => n.source || n.override),
      `${key}: ${v.nodeLabel} does not explain down to a source fact or override`);
    // 2. overrides resolve
    for (const n of nodes.filter((x) => x.override)) {
      overrideNodes += 1;
      check('override-resolves', known.has(n.override.overrideId),
        `${key}: lineage cites override ${n.override.overrideId}, which is not in the revision chain`);
      if (n.override.operation === 'ADD') {
        check('add-reaches-baseline', n.inputs.length > 0 && n.inputs[0].source,
          `${key}: an ADD override does not continue into the baseline it adjusted`);
      }
    }
  }
}
check('coverage', explained >= 20, `only ${explained} values were explained`);
check('coverage', overrideNodes > 0, 'no override ever appeared in a lineage');

// 4. canonical fingerprint
const prints = [];
for (const [k, v] of [['fp-a', '0.9'], ['fp-b', '0.90'], ['fp-c', '0.900']]) {
  const c = must(await s.runtime.createScenario(scope, { key: k, name: k, fork: s.fork, periods: [Q4_2026] }), k);
  must(await s.runtime.addOverride(scope, c.revision.id, {
    overrideType: 'VALUE_OVERRIDE', targetNodeId: s.ids.oppProb, value: v, unit: 'ratio',
    provenanceKind: 'MANAGEMENT_ASSUMPTION', rationale: 'closing probability assumption', confidence: 0.6,
  }), `${k} override`);
  prints.push(must(await s.runtime.markReady(scope, c.revision.id), k).fingerprint);
}
check('fingerprint', new Set(prints).size === 1, `0.9 / 0.90 / 0.900 produced ${new Set(prints).size} fingerprints`);
const moved = must(await s.runtime.rebase(scope, must(await s.runtime.listScenarios(scope), 'list').find((x) => x.key === 'fp-a').id), 'rebase');
check('fingerprint', moved.fingerprint !== prints[0], 'a different knowledge boundary produced the same fingerprint');

if (failures.length === 0) {
  console.log(`verify:scenario-lineage — ok (${explained} scenario values explained to source; ${overrideNodes} override nodes resolved; canonical fingerprints)`);
  process.exit(0);
}
console.error(`verify:scenario-lineage — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
