/**
 * verify:scenario-schema — the Phase 4 persistence keeps its promises.
 *
 *   1. Every scenario table is org-scoped, RLS-protected and has a guard trigger.
 *   2. History is immutable: no DELETE policy on revisions, simulations or
 *      constraint results; overrides deletable only through the draft guard.
 *   3. A sealed revision cannot change (the guard refuses every UPDATE of one),
 *      and a scenario run must execute its revision's own fork.
 *   4. STRUCTURAL_OVERRIDE is not storable — its execution is deferred and the
 *      schema must not suggest otherwise.
 *   5. Exact decimals are stored as text, never as float.
 *   6. The legacy helm_scenarios table is migrated additively: no column
 *      dropped, and a kernel row carries both key and ontology entity.
 *   7. The calculation-run scenario rule is WIDENED, not removed.
 *   8. Triggers enforce integrity only — no business value is computed in one.
 *   9. Both ScenarioStore adapters run the same conformance suite.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const MIGRATION = join(root, 'supabase', 'migrations', '20260922090100_helm_scenario_runtime.sql');
const failures = [];
const check = (rule, cond, detail) => {
  if (!cond) failures.push({ rule, detail });
};

if (!existsSync(MIGRATION)) {
  console.error('verify:scenario-schema — the Phase 4 migration is missing');
  process.exit(1);
}
const raw = readFileSync(MIGRATION, 'utf8');
const sql = raw.replace(/--[^\n]*/g, ' ');

const TABLES = [
  'helm_scenario_revisions',
  'helm_scenario_overrides',
  'helm_scenario_runs',
  'helm_scenario_constraint_results',
];
const HISTORY = ['helm_scenario_revisions', 'helm_scenario_runs', 'helm_scenario_constraint_results'];

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

// 1. org scope, RLS, guard
for (const t of TABLES) {
  const body = tableBody(t);
  check('tables', body !== null, `${t} is not created`);
  if (!body) continue;
  check('tables', /org_id\s+uuid\s+NOT\s+NULL/i.test(body), `${t}.org_id must be NOT NULL`);
  check('rls', new RegExp(`ALTER\\s+TABLE\\s+public\\.${t}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i').test(sql), `${t} has no RLS`);
  check(
    'guard',
    new RegExp(`CREATE\\s+TRIGGER\\s+${t}_guard\\s+BEFORE\\s+INSERT\\s+OR\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+public\\.${t}`, 'i').test(sql),
    `${t} has no guard trigger covering INSERT, UPDATE and DELETE`,
  );
}
check('guard', /CREATE\s+TRIGGER\s+helm_scenarios_guard\s+BEFORE\s+INSERT\s+OR\s+UPDATE\s+ON\s+public\.helm_scenarios/i.test(sql),
  'helm_scenarios has no identity/lifecycle guard');

// 2. history immutable
for (const t of HISTORY) {
  const del = new RegExp(`CREATE\\s+POLICY\\s+"[^"]*"\\s+ON\\s+public\\.${t}\\s+FOR\\s+(DELETE|ALL)`, 'i').exec(sql);
  check('history', !del, `${t} has a ${del?.[1]} policy — scenario history must not be deletable`);
  const guard = functionBody(`${t}_guard`) ?? '';
  check('history', /TG_OP\s*=\s*'DELETE'|TG_OP\s*<>\s*'INSERT'/i.test(guard), `${t}_guard does not refuse DELETE`);
}

// 3. sealed revisions immutable; runs use their revision's fork
{
  const g = functionBody('helm_scenario_revisions_guard') ?? '';
  check('sealed', /OLD\.state\s*=\s*'SEALED'[\s\S]{0,120}RAISE\s+EXCEPTION/i.test(g), 'a sealed revision can be updated');
  check('sealed', /helm_scenario_revisions_sealed_coherent/i.test(sql), 'sealing coherence (fingerprint, model, time) is not enforced');
  check('sealed', /helm_scenario_revisions_one_draft_idx[\s\S]{0,120}WHERE\s+state\s*=\s*'DRAFT'/i.test(sql), 'more than one draft revision is possible');
  const o = functionBody('helm_scenario_overrides_guard') ?? '';
  check('sealed', /rev\.state\s*<>\s*'DRAFT'/i.test(o), 'an override can be added to a sealed revision');
  check('sealed', /TG_OP\s*=\s*'UPDATE'[\s\S]{0,40}RAISE/i.test(o), 'an override can be edited in place');
  const r = functionBody('helm_scenario_runs_guard') ?? '';
  check('fork', /rev\.recorded_through\s*<>\s*NEW\.recorded_through/i.test(r), 'a scenario run may use a different knowledge boundary than its revision');
  check('fork', /rev\.state\s*<>\s*'SEALED'/i.test(r), 'a draft revision can be simulated');
  check('fork', /OLD\.status\s*<>\s*'RUNNING'[\s\S]{0,80}RAISE/i.test(r), 'a completed simulation can be changed');
}

// 4. structural overrides not storable
{
  const body = tableBody('helm_scenario_overrides') ?? '';
  const m = /override_type\s+text\s+NOT\s+NULL\s+CHECK\s*\(\s*override_type\s+IN\s*\(([^)]*)\)/i.exec(body);
  check('structural-deferred', m !== null, 'override_type has no CHECK');
  check('structural-deferred', m && !/STRUCTURAL_OVERRIDE/.test(m[1]), 'STRUCTURAL_OVERRIDE is storable, but its execution is deferred');
}

// 5. exact decimals
{
  const body = tableBody('helm_scenario_overrides') ?? '';
  check('exact-decimal', /\bvalue\s+text\s+NOT\s+NULL/i.test(body), 'an override value is not stored as exact text');
  check('exact-decimal', !/\b(float|real|double\s+precision)\b/i.test(sql), 'a floating-point column appears in the scenario schema');
}

// 6. legacy table migrated additively
check('additive', !/DROP\s+COLUMN|DROP\s+TABLE|TRUNCATE/i.test(sql), 'the Phase 4 migration drops or truncates');
check('additive', /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+key\b/i.test(sql), 'helm_scenarios does not gain its kernel identity');
check('additive', /helm_scenarios_kernel_coherent[\s\S]{0,120}\(key\s+IS\s+NULL\)\s*=\s*\(scenario_entity_id\s+IS\s+NULL\)/i.test(sql),
  'a kernel scenario row could lack its ontology entity');
for (const m of sql.matchAll(/(?:CREATE|ALTER)\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+public\.([a-z_]+)/gi)) {
  check('additive', m[1].startsWith('helm_'), `the Phase 4 migration touches non-HELM table ${m[1]}`);
}

// 7. widened, not removed
check('widened', /DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+helm_calculation_runs_scenario_coherent[\s\S]*ADD\s+CONSTRAINT\s+helm_calculation_runs_scenario_coherent/i.test(sql),
  'the calculation-run scenario rule is dropped without being re-added');

// 8. integrity only in triggers
for (const m of sql.matchAll(/AS\s+\$fn\$([\s\S]*?)\$fn\$/g)) {
  const body = m[1];
  check('no-formula-in-trigger', !/\bNEW\.[a-z_]+\s*:=/i.test(body), 'a Phase 4 trigger assigns a value to NEW');
  check('no-formula-in-trigger', !/\b(SUM|AVG)\s*\(/i.test(body), 'a Phase 4 trigger aggregates values');
}

// 9. two adapters, one suite
for (const f of ['inMemory.conformance.test.mjs', 'postgres.conformance.test.mjs']) {
  const p = join(root, 'packages', 'scenario-runtime', 'test', f);
  check('conformance', existsSync(p) && /runScenarioStoreConformanceSuite/.test(readFileSync(p, 'utf8')),
    `${f} does not run the ScenarioStore conformance suite`);
}

if (failures.length === 0) {
  console.log('verify:scenario-schema — ok (4 scenario tables guarded, history immutable, sealed revisions frozen, additive)');
  process.exit(0);
}
console.error(`verify:scenario-schema — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
