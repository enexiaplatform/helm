/**
 * A mutation harness for the Phase 5 and Phase 6 verification contracts.
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
const A = 'packages/authority-runtime/src';
const MIGRATION = 'supabase/migrations/20260923100000_helm_decision_runtime.sql';
const MIGRATION6 = 'supabase/migrations/20260928100000_helm_decision_authority.sql';

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

  // ================================================================ Phase 6

  // ------------------------------------------------- verify:authority-schema
  {
    verifier: 'verify-authority-schema.mjs',
    invariant: 'the committer cannot be their own independent approval (separation of duties)',
    file: MIGRATION6,
    from: '  IF req.independent_of_user_id IS NOT NULL AND NEW.approver_user_id = req.independent_of_user_id THEN',
    to: '  IF false THEN',
  },
  {
    verifier: 'verify-authority-schema.mjs',
    invariant: 'an authority evaluation is never edited',
    file: MIGRATION6,
    from: "    RAISE EXCEPTION 'helm_authority_evaluations: an evaluation is a record of a judgement; it is never edited or deleted';",
    to: '    RETURN COALESCE(NEW, OLD);',
  },
  {
    verifier: 'verify-authority-schema.mjs',
    invariant: 'an approval is recorded only as the authenticated caller',
    file: MIGRATION6,
    from: '    AND approver_user_id = (select auth.uid())\n',
    to: '',
  },
  {
    verifier: 'verify-authority-schema.mjs',
    invariant: 'a decision is no longer readable by every organization member',
    file: MIGRATION6,
    from: '  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND public.helm_can_see_decision(id));',
    to: '  FOR SELECT TO authenticated USING (public.is_org_member(org_id));',
  },
  {
    verifier: 'verify-authority-schema.mjs',
    invariant: 'no typed economics in the authority schema',
    file: MIGRATION6,
    from: "  comments text NOT NULL DEFAULT '',",
    to: "  approval_amount numeric,\n  comments text NOT NULL DEFAULT '',",
  },

  // ------------------------------------------------ verify:authority-runtime
  {
    verifier: 'verify-authority-runtime.mjs',
    invariant: 'the actor is the identity that committed, not whoever evaluates',
    file: `${A}/runtime.ts`,
    from: '        actor: { userId: committer, label: seat?.personLabel ?? c.commitment.committedByLabel },',
    to: '        actor: { userId: scope.actorId, label: seat?.personLabel ?? c.commitment.committedByLabel },',
  },
  {
    verifier: 'verify-authority-runtime.mjs',
    invariant: 'an escalated approval must be independent of the committer',
    file: `${A}/engine.ts`,
    from: "    rule.approvalIndependence === 'INDEPENDENT_OF_COMMITTER' ? input.committerUserId : null;",
    to: '    null;',
  },
  {
    verifier: 'verify-authority-runtime.mjs',
    invariant: 'a pending approval is not reported as approved',
    file: `${A}/state.ts`,
    from: "  else progress = 'PENDING';",
    to: "  else progress = 'APPROVED';",
  },

  // -------------------------------------------------- verify:authority-scope
  {
    verifier: 'verify-authority-scope.mjs',
    invariant: 'scope is derived through the portfolio owner, not typed',
    file: `${A}/scope.ts`,
    from: "  { relationshipTypeKey: 'OWNS', direction: 'in', reads: 'is owned by' },",
    to: '',
  },
  {
    verifier: 'verify-authority-scope.mjs',
    invariant: 'a touched entity outside the rule\u2019s scope is noticed',
    file: `${A}/scope.ts`,
    from: '          const stray = here.filter((r) => !allowed.has(r.entityId));',
    to: '          const stray = here.filter((r) => !allowed.has(r.entityId) && false);',
  },
  {
    verifier: 'verify-authority-scope.mjs',
    invariant: 'an entity anchored above a rule\u2019s level is outside it',
    file: `${A}/scope.ts`,
    from: '        if (above) outside.push(`${t.label} (sits above ${readableDimension(d)} level)`);',
    to: '        if (above) unknown.push(t.label);',
  },

  // ---------------------------------------------- verify:authority-threshold
  {
    verifier: 'verify-authority-threshold.mjs',
    invariant: 'the line itself is inside a ≥ line (exact boundary)',
    file: `${A}/conditions.ts`,
    from: '      return cmp >= 0;',
    to: '      return cmp > 0;',
  },
  {
    verifier: 'verify-authority-threshold.mjs',
    invariant: 'an UNKNOWN line never passes',
    file: `${A}/conditions.ts`,
    from: "  if (checks.some((c) => c.outcome === 'UNKNOWN')) return 'UNKNOWN';",
    to: "  if (checks.some((c) => c.outcome === 'UNKNOWN')) return 'PASS';",
  },
  {
    verifier: 'verify-authority-threshold.mjs',
    invariant: 'thresholds compare exact decimals, not floats',
    file: `${A}/conditions.ts`,
    from: '  const cmp = compare(decimal(v.value), decimal(condition.threshold));',
    to: '  const cmp = Math.sign(Number(v.value) - Number(condition.threshold)) as -1 | 0 | 1;',
  },

  // --------------------------------------------- verify:authority-delegation
  {
    verifier: 'verify-authority-delegation.mjs',
    invariant: 'delegated authority is intersected with the delegator\u2019s own',
    file: `${A}/engine.ts`,
    from: '  const checks = [...own.deciding.conditionChecks, ...checkConditions(d.conditions, input.consequences)];',
    to: '  const checks = [...checkConditions(d.conditions, input.consequences)];',
  },
  {
    verifier: 'verify-authority-delegation.mjs',
    invariant: 'outside its window a delegation does not exist',
    file: `${A}/engine.ts`,
    from: '  if (!openAt(d.validFrom, d.validTo, at)) {',
    to: '  if (false) {',
  },
  {
    verifier: 'verify-authority-delegation.mjs',
    invariant: 'a delegation cannot reach beyond the delegator\u2019s scope',
    file: `${A}/delegation.ts`,
    from: '        const scope = constraintsWithin(draft.scope, rule.scope, input.ancestry);',
    to: '        const scope = { within: true, problems: [] as string[] };',
  },

  // ------------------------------------------------ verify:approval-lineage
  {
    verifier: 'verify-approval-lineage.mjs',
    invariant: 'an approval resolves to the value lineage of its consequences',
    file: `${A}/runtime.ts`,
    from: '        if (l.ok) valueLineage.push(l.value);',
    to: '        void l;',
  },
  {
    verifier: 'verify-approval-lineage.mjs',
    invariant: 'the authority evaluation is on the decision timeline',
    file: `${A}/runtime.ts`,
    from: "      await event(scope, c.decisionId, 'AUTHORITY_EVALUATED', {",
    to: "      await event(scope, c.decisionId, 'EVALUATED', {",
  },

  // ---------------------------------------------- verify:decision-visibility
  {
    verifier: 'verify-decision-visibility.mjs',
    invariant: 'unit membership reaches the units below it',
    file: `${A}/visibility.ts`,
    from: '    stack.push(...(children.get(id) ?? []));',
    to: '    void children;',
  },
  {
    verifier: 'verify-decision-visibility.mjs',
    invariant: 'the server-side helper admits only admins, the creator and granted units',
    file: MIGRATION6,
    from: '        OR d.created_by = auth.uid()',
    to: '        OR true',
  },

  // --------------------------------------------------- verify:phase-boundary
  {
    verifier: 'verify-phase-boundary.mjs',
    invariant: 'nothing approves automatically',
    file: `${A}/engine.ts`,
    from: 'const MAX_ESCALATION_STEPS = 6;',
    to: 'const MAX_ESCALATION_STEPS = 6;\nconst autoApproveBelow = 0;',
  },
  {
    verifier: 'verify-phase-boundary.mjs',
    invariant: 'the decision runtime knows nothing of authority',
    file: `${K}/index.ts`,
    from: "export type { MeridianDecisionResult } from './meridianDecision.ts';",
    to: "export type { MeridianDecisionResult } from './meridianDecision.ts';\nexport type { AuthorityEvaluation } from '@helm/authority-runtime';",
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
