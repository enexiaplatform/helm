/**
 * verify:value-schema — the value graph's database invariants, statically.
 *
 * Complements verify:schema (which covers all helm_* tables generically) with
 * the rules specific to representing value:
 *
 *   1. The four value tables exist and are org-scoped.
 *   2. Observations are append-only (no UPDATE, no DELETE policy).
 *   3. A SCENARIO observation must carry a scenario, and no other type may.
 *   4. Unit/currency coherence is enforced at the database, not just in TS.
 *   5. Phase 2 cannot write a calculation run.
 *   6. Metric semantics are constrained (no summable proportions).
 *   7. Value nodes reference entities by FK rather than copying them.
 *   8. Causal link types are absent from the value link vocabulary.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
const fail = (rule, detail) => failures.push({ rule, detail });

const migrationsDir = join(root, 'supabase', 'migrations');
if (!existsSync(migrationsDir)) {
  console.error('verify:value-schema — supabase/migrations not found');
  process.exit(1);
}

const stripComments = (sql) =>
  sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

const combined = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => stripComments(readFileSync(join(migrationsDir, f), 'utf8')))
  .join('\n');

/**
 * Returns a table's column body, brace-matched. Located by plain string search
 * rather than a built regex: CHECK constraints contain their own parentheses,
 * so a lazy regex would truncate the body and silently skip later constraints.
 */
function tableBody(name) {
  const marker = `public.${name}`;
  const at = combined.indexOf(marker);
  if (at === -1) return null;
  const open = combined.indexOf('(', at);
  if (open === -1) return null;
  let depth = 1;
  let i = open + 1;
  while (i < combined.length && depth > 0) {
    if (combined[i] === '(') depth += 1;
    else if (combined[i] === ')') depth -= 1;
    i += 1;
  }
  return combined.slice(open + 1, i - 1);
}

const VALUE_TABLES = [
  'helm_value_metrics',
  'helm_value_nodes',
  'helm_value_links',
  'helm_value_observations',
];

// ------------------------------------------------- 1: tables and scoping

const bodies = new Map();
for (const t of VALUE_TABLES) {
  const body = tableBody(t);
  if (!body) {
    fail('missing-table', `${t} is not created by any migration`);
    continue;
  }
  bodies.set(t, body);
  if (!/\borg_id\b/.test(body)) fail('org-scope', `${t} has no org_id column`);
}

// ---------------------------------------------- 2: observations append-only

const obsPolicies = [
  ...combined.matchAll(
    /CREATE\s+POLICY\s+(?:"([^"]+)"|([a-z_]+))\s+ON\s+public\.helm_value_observations\s+FOR\s+([A-Z]+)/gi,
  ),
].map((m) => ({ name: m[1] ?? m[2], command: m[3].toUpperCase() }));

for (const forbidden of ['UPDATE', 'DELETE', 'ALL']) {
  const found = obsPolicies.find((p) => p.command === forbidden);
  if (found) {
    fail(
      'append-only',
      `helm_value_observations has a ${forbidden} policy ("${found.name}"). A recorded ` +
        'claim about what was, what we expected or what we wanted must not be rewritten.',
    );
  }
}
if (!obsPolicies.some((p) => p.command === 'SELECT')) {
  fail('rls-coverage', 'helm_value_observations has no SELECT policy');
}
if (!obsPolicies.some((p) => p.command === 'INSERT')) {
  fail('rls-coverage', 'helm_value_observations has no INSERT policy');
}

// ------------------------------------- 3-5: observation semantic constraints

const obsBody = bodies.get('helm_value_observations') ?? '';

if (!/scenario_entity_id\s+IS\s+NOT\s+NULL/i.test(obsBody) ||
    !/observation_type\s*=\s*'SCENARIO'/i.test(obsBody)) {
  fail(
    'scenario-context',
    'helm_value_observations does not constrain SCENARIO observations to carry a scenario',
  );
}
if (!/observation_type\s*<>\s*'SCENARIO'\s+AND\s+scenario_entity_id\s+IS\s+NULL/i.test(obsBody)) {
  fail(
    'scenario-context',
    'a non-SCENARIO observation is not prevented from carrying a scenario reference — ' +
      'reality and a modelled alternative would become indistinguishable',
  );
}
if (!/unit_type\s*=\s*'currency'\s+AND\s+currency\s+IS\s+NOT\s+NULL/i.test(obsBody)) {
  fail('unit-coherence', 'currency is not required on currency-typed observations');
}
if (!/calculation_run_id\s+IS\s+NULL/i.test(obsBody)) {
  fail(
    'phase-boundary',
    'helm_value_observations does not forbid calculation_run_id — Phase 2 computes nothing',
  );
}
if (!/effective_at\s+IS\s+NOT\s+NULL\s+OR\s*\(\s*period_start/i.test(obsBody)) {
  fail('time-context', 'an observation is not required to carry a time context');
}

// A trigger must compare the observation's unit against its metric's unit:
// a column CHECK cannot reach across tables.
if (!/helm_value_observation_units/i.test(combined)) {
  fail(
    'unit-coherence',
    'no trigger enforces that an observation unit matches its metric — the rule would ' +
      'hold only in TypeScript',
  );
}

// ------------------------------------------- 6: metric semantic constraints

const metricBody = bodies.get('helm_value_metrics') ?? '';
if (!/aggregation\s*<>\s*'SUM'\s+OR\s+unit_type\s+NOT\s+IN/i.test(metricBody)) {
  fail(
    'metric-semantics',
    'nothing prevents a percentage/ratio metric declaring SUM aggregation — adding two ' +
      'percentages is meaningless',
  );
}

// ------------------------------------ 7: value nodes reference, not duplicate

const nodeBody = bodies.get('helm_value_nodes') ?? '';
if (!/subject_entity_id\s+uuid\s+REFERENCES\s+public\.helm_entities/i.test(nodeBody)) {
  fail(
    'reference-not-duplicate',
    'helm_value_nodes.subject_entity_id is not a foreign key into helm_entities',
  );
}
for (const copied of ['source_entity_id', 'canonical_key', 'entity_type_id', 'attributes']) {
  if (new RegExp(`\\b${copied}\\b`).test(nodeBody)) {
    fail(
      'reference-not-duplicate',
      `helm_value_nodes carries "${copied}", which duplicates ontology state`,
    );
  }
}

// ------------------------------------------- 8: no causal link vocabulary

const linkBody = bodies.get('helm_value_links') ?? '';
for (const causal of ['CAUSES', 'CAUSED_BY', 'CORRELATES_WITH']) {
  if (new RegExp(`'${causal}'`).test(linkBody)) {
    fail(
      'causal-leak',
      `"${causal}" is in the value link vocabulary. A value link is a management ` +
        'dependency, not a validated causal claim — the Causal Graph is Phase 8.',
    );
  }
}

// ------------------------------------------------------------------ report

if (failures.length === 0) {
  console.log(`verify:value-schema — ok (${VALUE_TABLES.length} value tables, constraints intact)`);
  process.exit(0);
}

console.error(`verify:value-schema — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
