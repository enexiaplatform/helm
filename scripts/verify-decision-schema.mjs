/**
 * verify:decision-schema — the Phase 5 persistence keeps its promises.
 *
 *   1. Every decision table is org-scoped, RLS-protected and guarded.
 *   2. History is immutable: a commitment, its manifest, a challenge and a
 *      review are never updated or deleted, and a revision is never deleted.
 *   3. A sealed revision freezes the whole basis — alternatives, criteria,
 *      assessments, weightings, assumptions — with exactly two exceptions the
 *      schema states out loud: evidence may still be recorded, and an
 *      assumption's OUTCOME may still be written.
 *   4. A revision is committed once, and only a person authors a commitment.
 *   5. AUTHORITY IS NOT HERE: authority_status can only ever be NOT_EVALUATED.
 *   6. An alternative carries no economics: it binds a completed simulation of
 *      the scenario revision it names, or says why it has no future state.
 *   7. Thresholds and weights are exact decimals as text, never floats, and a
 *      weight only exists where management stated one.
 *   8. The legacy decision tables are migrated additively: nothing dropped.
 *   9. Triggers enforce integrity only — none computes a business value.
 *  10. Both DecisionStore adapters run the same conformance suite.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const MIGRATION = join(root, 'supabase', 'migrations', '20260923100000_helm_decision_runtime.sql');
const failures = [];
const check = (rule, cond, detail) => {
  if (!cond) failures.push({ rule, detail });
};

if (!existsSync(MIGRATION)) {
  console.error('verify:decision-schema — the Phase 5 migration is missing');
  process.exit(1);
}
const raw = readFileSync(MIGRATION, 'utf8');
const sql = raw.replace(/--[^\n]*/g, ' ');

const NEW_TABLES = [
  'helm_decision_revisions',
  'helm_decision_criteria',
  'helm_decision_criterion_assessments',
  'helm_decision_weightings',
  'helm_decision_challenges',
  'helm_decision_evidence',
  'helm_decision_commitments',
  'helm_decision_commitment_snapshots',
  'helm_decision_outcome_reviews',
];
/** Rows that record what happened: never deleted, and only ever appended to. */
const HISTORY = [
  'helm_decision_revisions',
  'helm_decision_challenges',
  'helm_decision_commitments',
  'helm_decision_commitment_snapshots',
  'helm_decision_outcome_reviews',
];

const tableBody = (name) => {
  const m = new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+public\\.${name}\\s*\\(`, 'i').exec(sql);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < sql.length && depth > 0) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') depth -= 1;
    i += 1;
  }
  return sql.slice(start, i - 1);
};
const functionBody = (name) => {
  const m = new RegExp(`FUNCTION\\s+public\\.${name}\\s*\\([^)]*\\)[\\s\\S]*?AS\\s+\\$fn\\$([\\s\\S]*?)\\$fn\\$`, 'i').exec(sql);
  return m ? m[1] : null;
};
const hasTrigger = (table) =>
  new RegExp(`CREATE\\s+TRIGGER\\s+[a-z_]+\\s+BEFORE\\s+INSERT\\s+OR\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+public\\.${table}\\b`, 'i').test(sql);

// 1. org scope, RLS, guard
for (const t of NEW_TABLES) {
  const body = tableBody(t);
  check('tables', body !== null, `${t} is not created`);
  if (!body) continue;
  check('tables', /org_id\s+uuid\s+NOT\s+NULL/i.test(body), `${t}.org_id must be NOT NULL`);
  check('rls', new RegExp(`ALTER\\s+TABLE\\s+public\\.${t}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i').test(sql), `${t} has no RLS`);
  check('guard', hasTrigger(t), `${t} has no guard trigger covering INSERT, UPDATE and DELETE`);
}
for (const t of ['helm_decisions', 'helm_decision_alternatives', 'helm_decision_assumptions']) {
  check('guard', new RegExp(`CREATE\\s+TRIGGER\\s+[a-z_]+\\s+BEFORE\\s+INSERT\\s+OR\\s+UPDATE`, 'i').test(sql) && sql.includes(`ON public.${t}`),
    `${t} has no kernel guard`);
}

// 2. history immutable
for (const t of HISTORY) {
  const del = new RegExp(`CREATE\\s+POLICY\\s+"[^"]*"\\s+ON\\s+public\\.${t}\\s+FOR\\s+(DELETE|ALL)`, 'i').exec(sql);
  check('history', !del, `${t} has a ${del?.[1]} policy — decision history must not be deletable`);
}
for (const [fn, what] of [
  ['helm_decision_commitments_guard', 'a commitment'],
  ['helm_decision_snapshots_guard', 'the evidence manifest'],
  ['helm_decision_outcome_reviews_guard', 'an outcome review'],
]) {
  const g = functionBody(fn) ?? '';
  check('history', /TG_OP\s*<>\s*'INSERT'[\s\S]{0,160}RAISE\s+EXCEPTION/i.test(g), `${what} can be edited or deleted`);
}
{
  const g = functionBody('helm_decision_revisions_guard') ?? '';
  check('history', /TG_OP\s*=\s*'DELETE'[\s\S]{0,160}RAISE\s+EXCEPTION/i.test(g), 'a decision revision can be deleted');
  const c = functionBody('helm_decision_challenges_guard') ?? '';
  check('history', /TG_OP\s*=\s*'DELETE'[\s\S]{0,160}RAISE\s+EXCEPTION/i.test(c), 'a recorded disagreement can be deleted');
  check('history', /OLD\.status\s*<>\s*'OPEN'[\s\S]{0,120}RAISE\s+EXCEPTION/i.test(c), 'a resolved challenge can be resolved again');
}

// 3. a sealed revision freezes the basis
{
  const g = functionBody('helm_decision_revisions_guard') ?? '';
  check('sealed', /OLD\.state\s*=\s*'SEALED'[\s\S]{0,140}RAISE\s+EXCEPTION/i.test(g), 'a sealed decision revision can be updated');
  check('sealed', /helm_decision_revisions_one_draft_idx[\s\S]{0,140}WHERE\s+state\s*=\s*'DRAFT'/i.test(sql),
    'more than one draft decision revision is possible');
  check('sealed', functionBody('helm_decision_revision_is_draft') !== null, 'there is no single place that answers "is this revision still open?"');

  const basis = functionBody('helm_decision_basis_guard') ?? '';
  check('sealed', /rev\.state\s*<>\s*'DRAFT'[\s\S]{0,140}RAISE\s+EXCEPTION/i.test(basis), 'the decision basis can be changed after sealing');
  // The two stated exceptions, and only those two.
  check('sealed', /helm_decision_evidence[\s\S]{0,200}RETURN\s+NEW/i.test(basis),
    'evidence recorded after a commitment is refused — it should be recorded and left out of the manifest');
  const a = functionBody('helm_decision_assumptions_guard') ?? '';
  check('sealed', /rev\.state\s*=\s*'SEALED'[\s\S]{0,700}only\s+the\s+outcome/i.test(a),
    'a sealed revision\'s assumption does not allow its outcome, or allows more than its outcome');
  const alt = functionBody('helm_decision_alternatives_guard') ?? '';
  check('sealed', /rev\.state\s*<>\s*'DRAFT'[\s\S]{0,140}RAISE\s+EXCEPTION/i.test(alt), 'an alternative can be changed after sealing');
}

// 4. committed once, authored by a person
{
  check('commitment', /helm_decision_commitments_once\s+UNIQUE\s*\(\s*revision_id\s*\)/i.test(sql), 'a revision can be committed more than once');
  check('commitment', /helm_decision_commitments_reasoned\s+CHECK\s*\(\s*jsonb_array_length\(rationale\)\s*>=\s*1\s*\)/i.test(sql),
    'a commitment with no rationale is storable');
  const body = tableBody('helm_decision_commitments') ?? '';
  const m = /authorship\s+text\s+NOT\s+NULL\s+CHECK\s*\(\s*authorship\s+IN\s*\(([^)]*)\)/i.exec(body);
  check('commitment', m !== null, 'authorship has no CHECK');
  check('commitment', m && /MANAGEMENT_AUTHORED/.test(m[1]) && !/HELM|SYSTEM|AI/i.test(m[1]),
    'a commitment could be authored by something other than management');
  const g = functionBody('helm_decision_commitments_guard') ?? '';
  check('commitment', /WITHDRAWN[\s\S]{0,140}RAISE\s+EXCEPTION/i.test(g), 'a withdrawn alternative can be the one chosen');
  const s = functionBody('helm_decision_snapshots_guard') ?? '';
  check('commitment', /recorded_through\s*<>\s*rev\.recorded_through/i.test(s),
    'the frozen manifest need not record its revision\'s knowledge boundary');
}

// 5. authority is Phase 6's
{
  const decisionAuthority = /helm_decisions_authority_status_check\s+CHECK\s*\(\s*authority_status\s*=\s*'NOT_EVALUATED'\s*\)/i.test(sql);
  check('no-authority', decisionAuthority, 'a decision could carry an authority verdict');
  const body = tableBody('helm_decision_commitments') ?? '';
  check('no-authority', /authority_status\s+text\s+NOT\s+NULL\s+DEFAULT\s+'NOT_EVALUATED'\s+CHECK\s*\(\s*authority_status\s*=\s*'NOT_EVALUATED'\s*\)/i.test(body),
    'a commitment could carry an authority verdict');
  for (const word of ['AUTHORIZED', 'REQUIRES_APPROVAL', 'ESCALATED']) {
    check('no-authority', !new RegExp(`'${word}'`).test(sql), `the Phase 5 schema can store the authority verdict ${word}`);
  }
}

// 6. an alternative references a future; it does not contain one
{
  check('alternative-binding', /helm_decision_alternatives_kernel_coherent/i.test(sql), 'an alternative has no MODELLED/UNMODELLED coherence rule');
  check('alternative-binding', /status\s*=\s*'MODELLED'[\s\S]{0,260}scenario_run_id\s+IS\s+NOT\s+NULL/i.test(sql),
    'a MODELLED alternative need not reference the simulation that computed its future');
  check('alternative-binding', /status\s+IN\s*\('UNMODELLED',\s*'WITHDRAWN'\)[\s\S]{0,180}unmodelled_reason\s+IS\s+NOT\s+NULL/i.test(sql),
    'an alternative with no future state need not say why');
  const g = functionBody('helm_decision_alternatives_guard') ?? '';
  check('alternative-binding', /run\.status\s*=\s*'RUNNING'[\s\S]{0,180}RAISE\s+EXCEPTION/i.test(g),
    'an alternative can bind a simulation that has not completed');
  check('alternative-binding', /run\.revision_id\s+IS\s+DISTINCT\s+FROM\s+NEW\.scenario_revision_id/i.test(g),
    'an alternative can bind a run belonging to a different scenario revision');
  check('alternative-binding', /run\.org_id\s*<>\s*NEW\.org_id/i.test(g), 'an alternative can reach another organization\'s simulation');
  // No economics of its own.
  const body = tableBody('helm_decision_criteria') ?? '';
  check('alternative-binding', !/revenue|margin|cash/i.test(body.replace(/metric_key|subject_hint/g, '')),
    'the decision schema stores an economic quantity of its own');
}

// 7. exact decimals, and weights only where stated
{
  const body = tableBody('helm_decision_criteria') ?? '';
  check('exact-decimal', /threshold\s+text[\s\S]{0,120}\^-\?\[0-9\]\+/i.test(body), 'a criterion threshold is not an exact decimal as text');
  check('exact-decimal', /weight\s+text[\s\S]{0,120}\^-\?\[0-9\]\+/i.test(body), 'a criterion weight is not an exact decimal as text');
  check('exact-decimal', !/\b(float|real|double\s+precision)\b/i.test(sql), 'a floating-point column appears in the decision schema');
  check('no-default-weight', /helm_decision_criteria_weight_coherent\s+CHECK\s*\(\s*\(style\s*=\s*'OPTIONAL_WEIGHTED'\)\s*=\s*\(weight\s+IS\s+NOT\s+NULL\)/i.test(sql),
    'a weight can exist without management asking for one, or a weighted criterion without a weight');
  check('no-default-weight', /helm_decision_weightings_once\s+UNIQUE\s*\(\s*revision_id\s*\)/i.test(sql),
    'a revision can hold more than one weighting method');
  check('no-default-weight', !/DEFAULT\s+[0-9.]+\s*[,)][\s\S]{0,40}weight/i.test(sql), 'a weight has a system default');
}

// 8. additive
check('additive', !/DROP\s+COLUMN|DROP\s+TABLE|TRUNCATE/i.test(sql), 'the Phase 5 migration drops or truncates');
check('additive', /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+management_question\b/i.test(sql), 'helm_decisions does not gain its management question');
check('additive', /helm_decisions_kernel_coherent/i.test(sql), 'a kernel decision row could lack its question or its knowledge boundary');
for (const m of sql.matchAll(/(?:CREATE|ALTER)\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+public\.([a-z_]+)/gi)) {
  check('additive', m[1].startsWith('helm_'), `the Phase 5 migration touches non-HELM table ${m[1]}`);
}
// The retired pre-kernel columns are kept and said to be retired.
for (const col of ['recommendation', 'is_recommended', 'financial_lines']) {
  check('additive', new RegExp(`COMMENT\\s+ON\\s+COLUMN[^;]*\\.${col}\\s+IS\\s+'RETIRED`, 'i').test(raw),
    `${col} is not marked RETIRED — a reader cannot tell it is no longer the decision model`);
}

// 9. integrity only in triggers
for (const m of sql.matchAll(/AS\s+\$fn\$([\s\S]*?)\$fn\$/g)) {
  const body = m[1];
  check('no-formula-in-trigger', !/\bNEW\.[a-z_]+\s*:=/i.test(body), 'a Phase 5 trigger assigns a value to NEW');
  check('no-formula-in-trigger', !/\b(SUM|AVG)\s*\(/i.test(body), 'a Phase 5 trigger aggregates values');
}

// 10. two adapters, one suite
for (const f of ['inMemory.conformance.test.mjs', 'postgres.conformance.test.mjs']) {
  const p = join(root, 'packages', 'decision-runtime', 'test', f);
  check('conformance', existsSync(p) && /runDecisionStoreConformanceSuite/.test(readFileSync(p, 'utf8')),
    `${f} does not run the DecisionStore conformance suite`);
}

if (failures.length === 0) {
  console.log(
    `verify:decision-schema — ok (${NEW_TABLES.length} decision tables guarded, commitments frozen, authority deferred, additive)`,
  );
  process.exit(0);
}
console.error(`verify:decision-schema — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
