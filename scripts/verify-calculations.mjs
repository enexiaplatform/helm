/**
 * verify:calculations — every calculation is governed, and the code and the
 * database say the same thing about it.
 *
 *   1. The registry builds. An invalid definition never reaches a run.
 *   2. Governance is complete: owner, rationale, readable formula, version.
 *   3. The migration's metadata rows match the code registry exactly.
 *   4. The database stores NO executable code and no evaluator exists.
 *   5. Model honesty: a crude model declares less than full confidence, and
 *      every simplification is stated in the rationale rather than hidden.
 *   6. No business constant is hard-coded in a calculation's implementation.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildSeedValueRegistry } from '../packages/value-graph/src/registry.ts';
import { createCalculationRegistry } from '../packages/propagation-engine/src/registry.ts';
import { meridianValueModelV1 } from '../packages/propagation-engine/src/meridianValueModelV1.ts';

const failures = [];
const fail = (rule, detail) => failures.push({ rule, detail });
const check = (rule, cond, detail) => {
  if (!cond) fail(rule, detail);
};

const root = process.cwd();
const MIGRATION = join(root, 'supabase', 'migrations', '20260920090000_helm_propagation.sql');
const ENGINE_SRC = join(root, 'packages', 'propagation-engine', 'src');

// ------------------------------------------------- 1: the registry builds

const registry = createCalculationRegistry(meridianValueModelV1, buildSeedValueRegistry());
if (!registry.ok) {
  fail('registry', `${registry.error.code}: ${registry.error.message}`);
}

// -------------------------------------------------- 2: governance is complete

for (const calc of meridianValueModelV1) {
  const ref = `${calc.key}@${calc.version}`;
  check('governance', calc.owner.trim().length > 1, `${ref} has no owner`);
  check(
    'governance',
    calc.rationale.trim().length >= 40,
    `${ref} has no substantive business rationale — a calculation nobody can ` +
      'justify is anonymous magic',
  );
  check('governance', calc.expression.trim().length > 0, `${ref} has no readable formula`);
  check('governance', /^\d+\.\d+\.\d+$/.test(calc.version), `${ref} has a non-semver version`);
  check('governance', calc.inputs.length > 0, `${ref} declares no inputs`);
  check(
    'governance',
    calc.description.trim().length >= 20,
    `${ref} does not describe what it produces`,
  );
  for (const input of calc.inputs) {
    check(
      'governance',
      input.description.trim().length >= 10,
      `${ref} input "${input.name}" is undocumented`,
    );
  }
}

// --------------------------------------- 3: the migration matches the code

if (!existsSync(MIGRATION)) {
  fail('migration-sync', 'supabase/migrations/20260920090000_helm_propagation.sql is missing');
} else {
  const sql = readFileSync(MIGRATION, 'utf8');
  for (const calc of meridianValueModelV1) {
    const id = `calc_${calc.key}@${calc.version}`;
    check('migration-sync', sql.includes(`'${id}'`), `${id} has no governance row`);
    check(
      'migration-sync',
      sql.includes(calc.owner.replace(/'/g, "''")),
      `${calc.key}: the migration does not carry its owner`,
    );
    // The rationale is the longest field and the easiest to let drift.
    const head = calc.rationale.slice(0, 40).replace(/'/g, "''");
    check(
      'migration-sync',
      sql.includes(head),
      `${calc.key}: the migration's rationale does not match the code's`,
    );
  }

  // A row for a calculation that no longer exists in code would present a
  // manager with governance for a formula that cannot run.
  const ids = [...sql.matchAll(/'calc_([a-z0-9_]+)@(\d+\.\d+\.\d+)'/g)].map(
    (m) => `${m[1]}@${m[2]}`,
  );
  const inCode = new Set(meridianValueModelV1.map((c) => `${c.key}@${c.version}`));
  for (const id of new Set(ids)) {
    check('migration-sync', inCode.has(id), `${id} has a governance row but no implementation`);
  }
}

// ------------------------------- 4: no executable code in the database

const migrationSql = existsSync(MIGRATION) ? readFileSync(MIGRATION, 'utf8') : '';
const NO_CODE_IN_DB = [
  { re: /\bformula_js\b|\bexpression_js\b|\bcompute_sql\b|\bjavascript\b/i, why: 'a code column' },
  { re: /\bplv8\b|\bCREATE\s+EXTENSION\s+.*plv8/i, why: 'a JavaScript language extension' },
  { re: /\bEXECUTE\s+format\s*\(/i, why: 'dynamic SQL execution' },
];
for (const { re, why } of NO_CODE_IN_DB) {
  check(
    'no-code-in-db',
    !re.test(migrationSql),
    `the propagation migration contains ${why}. Executable logic lives in typed ` +
      'functions, never in the database (§13, ADR-0017 §1)',
  );
}

// A trigger may enforce integrity; it must not compute a business value.
const triggerBodies = [...migrationSql.matchAll(/AS\s+\$fn\$([\s\S]*?)\$fn\$/g)].map((m) => m[1]);
for (const body of triggerBodies) {
  check(
    'no-formula-in-trigger',
    !/\bNEW\.(output_value|numeric_value|confidence)\s*:?=/i.test(body),
    'a trigger assigns a computed business value. Business formulas in triggers ' +
      'are invisible to tests, impossible to version and impossible to explain (§28)',
  );
}

// No evaluator anywhere in the engine.
const stripNonCode = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');

const NO_EVAL = [
  { re: /\beval\s*\(/, why: 'eval()' },
  { re: /new\s+Function\s*\(/, why: 'new Function()' },
  { re: /\bvm\.runIn/, why: 'the vm module' },
  { re: /\bimportScripts\b/, why: 'dynamic script loading' },
];
for (const f of readdirSync(ENGINE_SRC)) {
  if (!f.endsWith('.ts')) continue;
  const src = stripNonCode(readFileSync(join(ENGINE_SRC, f), 'utf8'));
  for (const { re, why } of NO_EVAL) {
    check(
      'no-eval',
      !re.test(src),
      `packages/propagation-engine/src/${f} uses ${why}. A formula HELM cannot ` +
        'read is a formula HELM cannot explain (§13)',
    );
  }
}

// ------------------------------------------------- 5: the model is honest

for (const calc of meridianValueModelV1) {
  const ref = `${calc.key}@${calc.version}`;
  check(
    'model-honesty',
    calc.definitionConfidence >= 0 && calc.definitionConfidence <= 1,
    `${ref} declares a definition confidence outside 0..1`,
  );
  // A rationale that admits a simplification must not also claim a perfect
  // model. This is the check that keeps "v1, ignores payment terms" from
  // shipping alongside a confidence of 1.
  const admitsSimplification = /\bv1\b|MODEL v1|ignores|no safety stock|deliberately simple|crude/i.test(
    calc.rationale,
  );
  if (admitsSimplification) {
    check(
      'model-honesty',
      calc.definitionConfidence < 1,
      `${ref} states a model simplification in its rationale but declares full ` +
        'confidence. A model that admits it is crude must say so in its number too',
    );
  }
}

// ------------------------------- 6: no business constants in implementations

// A magic number in a compute() is a business decision nobody owns. Small
// integers used for arithmetic identity are fine; a business quantity is not.
const modelSrc = stripNonCode(
  readFileSync(join(ENGINE_SRC, 'meridianValueModelV1.ts'), 'utf8'),
);
const computeBodies = [...modelSrc.matchAll(/compute\s*\([^)]*\)\s*\{([\s\S]*?)\n\s{4}\}/g)].map(
  (m) => m[1],
);
check(
  'no-hidden-constants',
  computeBodies.length >= meridianValueModelV1.length - 1,
  'the compute bodies could not be located, so this check proved nothing',
);
for (const body of computeBodies) {
  const numbers = [...body.matchAll(/(?<![\w.])\d[\d_]*(?:\.\d+)?/g)].map((m) =>
    Number(m[0].replace(/_/g, '')),
  );
  for (const n of numbers) {
    check(
      'no-hidden-constants',
      n === 0 || n === 1,
      `a calculation implementation contains the constant ${n}. A business ` +
        'constant belongs in an ASSUMPTION observation where it can be owned ' +
        'and reviewed, not in code (§20)',
    );
  }
}

// Every metric a calculation reads must be a real metric, and every assumption
// the model needs must be declared rather than assumed to exist.
const metrics = buildSeedValueRegistry();
for (const calc of meridianValueModelV1) {
  for (const input of calc.inputs) {
    check(
      'declared-inputs',
      metrics.metric(input.metricKey) !== null,
      `${calc.key} reads "${input.metricKey}", which is not a registered metric`,
    );
  }
  check(
    'declared-inputs',
    metrics.metric(calc.outputMetricKey) !== null,
    `${calc.key} writes "${calc.outputMetricKey}", which is not a registered metric`,
  );
}

// ------------------------------------------------------------------ report

if (failures.length === 0) {
  console.log(
    `verify:calculations — ok (${meridianValueModelV1.length} governed calculations, ` +
      'migration in sync, no executable code in the database)',
  );
  process.exit(0);
}

console.error(`verify:calculations — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
