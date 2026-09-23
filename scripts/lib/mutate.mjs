/**
 * A mutation harness for the Phase 5 verification contracts.
 *
 * A verifier that passes proves nothing on its own: it might assert nothing at
 * all, or assert something that cannot fail. So each contract is also run
 * against deliberately broken code. For every mutation below, the named
 * verifier MUST fail — if it still passes, the assertion it was supposed to
 * make is vacuous and the contract is a decoration.
 *
 * Mutations are applied to the file on disk and reverted immediately, whatever
 * happens. Nothing is left behind: `git status` is unchanged after a run.
 *
 * Usage: node scripts/lib/mutate.mjs [verifier-name-substring]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.cwd();
const K = 'packages/decision-runtime/src';
const MIGRATION = 'supabase/migrations/20260923100000_helm_decision_runtime.sql';

/**
 * Each mutation: which contract must catch it, which invariant it attacks, and
 * the smallest edit that breaks that invariant.
 */
const MUTATIONS = [
  // -------------------------------------------------- verify:decision-schema
  {
    verifier: 'verify-decision-schema.mjs',
    invariant: 'a commitment cannot be edited after the fact',
    file: MIGRATION,
    from: "    RAISE EXCEPTION 'helm_decision_commitments: a commitment is what management decided; it is never edited or deleted';",
    to: '    RETURN COALESCE(NEW, OLD);',
  },
  {
    verifier: 'verify-decision-schema.mjs',
    invariant: 'the database cannot store an authority verdict',
    file: MIGRATION,
    from: "CHECK (authority_status = 'NOT_EVALUATED')",
    to: "CHECK (authority_status IN ('NOT_EVALUATED', 'AUTHORIZED'))",
    all: true,
  },
  {
    verifier: 'verify-decision-schema.mjs',
    invariant: 'a MODELLED alternative must reference the simulation behind it',
    file: MIGRATION,
    from: '      AND scenario_id IS NOT NULL AND scenario_revision_id IS NOT NULL AND scenario_run_id IS NOT NULL',
    to: '      AND TRUE',
  },
  {
    verifier: 'verify-decision-schema.mjs',
    invariant: 'a weight exists only where management asked for one',
    file: MIGRATION,
    from: 'CONSTRAINT helm_decision_criteria_weight_coherent CHECK',
    to: 'CONSTRAINT helm_decision_criteria_weight_relaxed CHECK',
  },
  {
    verifier: 'verify-decision-schema.mjs',
    invariant: 'the migration is additive',
    file: MIGRATION,
    from: '-- ---------------------------------------------------------------------- RLS',
    to: 'ALTER TABLE public.helm_decisions DROP COLUMN IF EXISTS context;\n-- ---------------------------------------------------------------------- RLS',
  },

  // ------------------------------------------------- verify:decision-runtime
  {
    verifier: 'verify-decision-runtime.mjs',
    invariant: 'HELM does not rate a qualitative criterion nobody assessed',
    file: `${K}/criteria.ts`,
    from: "        const outcome = assessment ? ('ASSESSED' as const) : ('NOT_ASSESSED' as const);",
    to: "        const outcome = 'ASSESSED' as const;",
  },
  {
    verifier: 'verify-decision-runtime.mjs',
    invariant: 'a blocked metric stays blocked instead of becoming a zero',
    file: `${K}/criteria.ts`,
    from: '      const v = criterion.metricKey ? pickCriterionValue(state, criterion, period) : undefined;',
    to: '      const v0 = criterion.metricKey ? pickCriterionValue(state, criterion, period) : undefined;\n      const v = v0 && v0.value === null ? { ...v0, value: \'0\' } : v0;',
  },
  {
    verifier: 'verify-decision-runtime.mjs',
    invariant: 'readiness names each gap by its own code',
    file: `${K}/readiness.ts`,
    from: "        code: 'alternative-unmodelled',",
    to: "        code: 'noted',",
  },
  {
    verifier: 'verify-decision-runtime.mjs',
    invariant: 'no dominance statement tells the reader what to do',
    file: `${K}/tradeoff.ts`,
    from: '          `Under the current model, ${x.alternative.label} is better than ${y.alternative.label} on ` +',
    to: '          `Under the current model, you should choose ${x.alternative.label} over ${y.alternative.label} on ` +',
  },
  {
    verifier: 'verify-decision-runtime.mjs',
    invariant: 'nothing in the decision layer carries a score',
    file: `${K}/readiness.ts`,
    from: '  return {\n    decisionId: input.decisionId,\n    revisionId: input.revisionId,\n    state,',
    to: '  return {\n    score: 100 - gaps.length * 10,\n    decisionId: input.decisionId,\n    revisionId: input.revisionId,\n    state,',
  },

  // ------------------------------------------------- verify:decision-lineage
  {
    verifier: 'verify-decision-lineage.mjs',
    invariant: 'an expected outcome names the value node it was read from',
    file: `${K}/runtime.ts`,
    from: "        kind: 'MODELLED',\n        nodeId: value.nodeId,",
    to: "        kind: 'MODELLED',\n        nodeId: null,",
  },
  {
    verifier: 'verify-decision-lineage.mjs',
    invariant: 'a criterion evaluation carries the node and period behind its value',
    file: `${K}/criteria.ts`,
    from: '        nodeId: v.nodeId,\n        period: v.period,',
    to: '        nodeId: null,\n        period: null,',
  },
  {
    verifier: 'verify-decision-lineage.mjs',
    invariant: 'an expected outcome agrees with the chosen future state',
    file: `${K}/runtime.ts`,
    from: '        expectedValue: value.value,\n        unit: value.unit,',
    to: "        expectedValue: value.value === null ? null : '0',\n        unit: value.unit,",
  },

  // -------------------------------------------- verify:decision-immutability
  {
    verifier: 'verify-decision-immutability.mjs',
    invariant: 'a sealed revision refuses every edit',
    file: `${K}/inMemoryStore.ts`,
    from: "    if (r.state === 'SEALED') {\n      return {\n        error: fail(",
    to: '    if (r.state === (\'NEVER\' as unknown as typeof r.state)) {\n      return {\n        error: fail(',
  },
  {
    verifier: 'verify-decision-immutability.mjs',
    invariant: 'reconsidering opens a new revision that links back to what it reconsiders',
    file: `${K}/runtime.ts`,
    from: "        reason: 'RECONSIDERED',",
    to: "        reason: 'REVISED',",
  },
  {
    verifier: 'verify-decision-immutability.mjs',
    invariant: 'an outcome review reports variance without passing judgement',
    file: `${K}/runtime.ts`,
    from: "          'Expected against actual, and how the assumptions turned out. This is not a verdict on the ' +",
    to: "          'Expected against actual. This says whether the decision was good. ' +",
  },

  // -------------------------------------- verify:decision-scenario-binding
  {
    verifier: 'verify-decision-scenario-binding.mjs',
    invariant: 'a criterion value is read from its own alternative’s simulation',
    file: `${K}/criteria.ts`,
    from: '  for (const criterion of criteria) {\n    for (const { alternative, state } of alternatives) {',
    to: '  for (const criterion of criteria) {\n    for (const [i, { alternative }] of alternatives.entries()) {\n      const state = alternatives[(i + 1) % alternatives.length].state;',
  },
  {
    verifier: 'verify-decision-scenario-binding.mjs',
    invariant: 'mixed knowledge boundaries are surfaced, not silently compared',
    file: `${K}/readiness.ts`,
    from: "      code: 'mixed-knowledge-boundaries',",
    to: "      code: 'noted',",
  },
];

const only = process.argv[2] ?? '';
const selected = MUTATIONS.filter((m) => m.verifier.includes(only));
const results = [];

for (let m of selected) {
  const path = join(root, m.file);
  const original = readFileSync(path, 'utf8');
  // The repository is mixed CRLF/LF (Windows development), so a multi-line
  // pattern is written with \n and adapted to whatever the file actually uses.
  const crlf = original.includes('\r\n');
  if (crlf) {
    m = { ...m, from: m.from.replaceAll('\n', '\r\n'), to: m.to.replaceAll('\n', '\r\n') };
  }
  const count = original.split(m.from).length - 1;
  if (count === 0 || (!m.all && count > 1)) {
    results.push({ ...m, outcome: 'NOT_APPLIED', note: `the target text appears ${count} time(s)` });
    continue;
  }
  const mutated = m.all ? original.split(m.from).join(m.to) : original.replace(m.from, m.to);
  let outcome;
  let note = '';
  try {
    writeFileSync(path, mutated);
    const r = spawnSync(process.execPath, [join('scripts', m.verifier)], { cwd: root, encoding: 'utf8' });
    outcome = r.status === 0 ? 'SURVIVED' : 'CAUGHT';
    const lines = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n');
    note = outcome === 'CAUGHT' ? (lines.find((l) => /^\s*\[/.test(l)) ?? lines[0] ?? '').trim() : '';
  } finally {
    writeFileSync(path, original);
  }
  results.push({ ...m, outcome, note });
}

const pad = (s, n) => String(s).padEnd(n);
const survived = results.filter((r) => r.outcome !== 'CAUGHT');
const contracts = new Set(results.map((r) => r.verifier)).size;
console.log(`\nmutation testing — ${results.length} mutation(s) across ${contracts} contract(s)\n`);
for (const r of results) {
  const mark = r.outcome === 'CAUGHT' ? 'caught  ' : r.outcome === 'SURVIVED' ? 'SURVIVED' : 'skipped ';
  console.log(`  ${mark} ${pad(r.verifier.replace(/^verify-|\.mjs$/g, ''), 26)} ${r.invariant}`);
  if (r.note) console.log(`           ↳ ${r.note}`);
}
console.log();
if (survived.length === 0) {
  console.log('mutation testing — ok (every mutation was caught by the contract that claims to cover it)');
  process.exit(0);
}
console.error(`mutation testing — ${survived.length} mutation(s) were not caught:`);
for (const r of survived) console.error(`  [${r.outcome}] ${r.verifier}: ${r.invariant}${r.note ? ` — ${r.note}` : ''}`);
process.exit(1);
