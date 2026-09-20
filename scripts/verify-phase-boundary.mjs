/**
 * verify:phase-boundary — Phase 3 does what Phase 3 does, and no more.
 *
 * Every phase so far has shipped a verifier that asserts the ABSENCE of the
 * next phase's work, because the most expensive mistake in a layered build is
 * a layer that quietly started doing the next one's job. Phase 2's verifier
 * asserted that nothing propagated. This one asserts what Phase 3 must not do:
 *
 *   1. No scenario MANAGEMENT. Phase 3 can compute a scenario; comparing,
 *      ranking and recommending between scenarios is Phase 4.
 *   2. No decisions. Recording, approving or governing a decision is Phase 5.
 *   3. No authority or visibility rules. That is Phase 6.
 *   4. No management surfaces. Dashboards and briefings begin at Phase 14.
 *   5. No optimization. HELM shows the trade-off; it does not resolve it.
 *   6. No eval, no executable code in the database, no formula in a trigger.
 *   7. The phase's own additive discipline: nothing outside helm_*.
 *
 * As learned in Phase 2, text in comments and documentation must not trip this.
 * Every source scan strips comments and string literals before matching.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const failures = [];
const fail = (rule, detail) => failures.push({ rule, detail });
const check = (rule, cond, detail) => {
  if (!cond) fail(rule, detail);
};

const root = process.cwd();
const ENGINE_SRC = join(root, 'packages', 'propagation-engine', 'src');
const MIGRATION = join(root, 'supabase', 'migrations', '20260920090000_helm_propagation.sql');

/**
 * Strips comments and string literals so prose cannot trip a code check.
 * Phase 2 tripped on the word "propagate" inside an explanatory comment; the
 * lesson is that a verifier scanning source must scan CODE.
 */
const stripNonCode = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');

const engineFiles = readdirSync(ENGINE_SRC).filter((f) => f.endsWith('.ts'));
const engineCode = new Map(
  engineFiles.map((f) => [f, stripNonCode(readFileSync(join(ENGINE_SRC, f), 'utf8'))]),
);

// -------------------------------- 1-5: the next phases have not started here

const NOT_YET = [
  {
    rule: 'no-scenario-management',
    // Computing a scenario is Phase 3. Comparing, ranking or recommending
    // between them is Phase 4, and the difference is the whole boundary.
    patterns: [
      /\bcompareScenarios?\b/,
      /\brankScenarios?\b/,
      /\bbestScenario\b/,
      /\brecommendScenario\b/,
      /\bscenarioComparison\b/,
    ],
    why: 'scenario comparison or ranking',
    phase: 'Phase 4 — Scenario Modelling',
  },
  {
    rule: 'no-decisions',
    patterns: [
      /\bcreateDecision\b/,
      /\bapproveDecision\b/,
      /\bDecisionState\b/,
      /\brecordDecision\b/,
      /\bdecisionWorkflow\b/,
    ],
    why: 'decision recording or governance',
    phase: 'Phase 5 — Decision Intelligence',
  },
  {
    rule: 'no-authority',
    patterns: [
      /\bcanApprove\b/,
      /\bauthorityLimit\b/,
      /\brequiresApproval\b/,
      /\bvisibilityRule\b/,
      /\bapprovalThreshold\b/,
    ],
    why: 'authority or visibility rules',
    phase: 'Phase 6 — Authority and Visibility',
  },
  {
    rule: 'no-management-surface',
    patterns: [/\bdashboard\b/i, /\bbriefing\b/i, /\bexecutiveSummary\b/],
    why: 'a management surface',
    phase: 'Phase 14 — Management Surfaces',
  },
  {
    rule: 'no-optimization',
    // HELM quantifies a trade-off so a manager can make the call. A system that
    // resolved it would be making the call, which is a different product.
    patterns: [
      /\boptimi[sz]e\w*\s*\(/,
      /\bsolve\s*\(/,
      /\bmaximi[sz]e\s*\(/,
      /\bminimi[sz]e\s*\(/,
      /\blinearProgram\w*/,
      /\bsimplex\b/,
    ],
    why: 'an optimizer',
    phase: 'never — HELM quantifies trade-offs; managers resolve them',
  },
];

for (const [file, code] of engineCode) {
  for (const { rule, patterns, why, phase } of NOT_YET) {
    for (const re of patterns) {
      if (re.test(code)) {
        fail(
          rule,
          `packages/propagation-engine/src/${file} contains ${why} (${re}). That is ${phase}.`,
        );
      }
    }
  }
}

// The engine must not import from a later phase's package either.
for (const [file, code] of engineCode) {
  for (const m of code.matchAll(/from\s+''/g)) void m;
  const raw = readFileSync(join(ENGINE_SRC, file), 'utf8');
  for (const m of raw.matchAll(/from\s+'(@helm\/[a-z-]+)'/g)) {
    const allowed = ['@helm/shared', '@helm/ontology', '@helm/graph-store', '@helm/value-graph'];
    check(
      'layering',
      allowed.includes(m[1]) || m[1].startsWith('@helm/propagation-engine'),
      `packages/propagation-engine/src/${file} imports ${m[1]}, which is not a Phase 0-3 kernel package`,
    );
  }
}

// ----------------- 6: no eval, no code in the database, no formula in a trigger

const NO_EVAL = [
  { re: /\beval\s*\(/, why: 'eval()' },
  { re: /new\s+Function\s*\(/, why: 'new Function()' },
  { re: /\bvm\.runIn/, why: "node's vm module" },
  { re: /\bFunction\s*\(\s*''\s*\)/, why: 'a dynamically constructed function' },
];
for (const [file, code] of engineCode) {
  for (const { re, why } of NO_EVAL) {
    check(
      'no-eval',
      !re.test(code),
      `packages/propagation-engine/src/${file} uses ${why}. A formula HELM cannot read ` +
        'is a formula HELM cannot explain, and a formula from the database is an ' +
        'injection surface (§13)',
    );
  }
}

if (!existsSync(MIGRATION)) {
  fail('phase-artifacts', 'the Phase 3 migration is missing');
} else {
  const sql = readFileSync(MIGRATION, 'utf8');
  const sqlNoComments = sql.replace(/--[^\n]*/g, ' ');

  // No column may hold executable code.
  for (const re of [/\bformula_js\b/i, /\bexpression_js\b/i, /\bcode\s+text\b/i, /\bscript\b/i]) {
    check(
      'no-code-in-db',
      !re.test(sqlNoComments),
      `the Phase 3 migration defines something matching ${re}. helm_calculations ` +
        'stores metadata; implementations are typed functions in code (ADR-0017 §1)',
    );
  }

  // A trigger may enforce integrity. It must not compute a business value.
  const triggerBodies = [...sqlNoComments.matchAll(/AS\s+\$fn\$([\s\S]*?)\$fn\$/g)].map((m) => m[1]);
  check(
    'no-formula-in-trigger',
    triggerBodies.length > 0,
    'no trigger bodies were found, so this check proved nothing',
  );
  for (const body of triggerBodies) {
    check(
      'no-formula-in-trigger',
      !/\bNEW\.[a-z_]+\s*:=/i.test(body),
      'a Phase 3 trigger assigns to a NEW column. Business formulas in triggers are ' +
        'invisible to tests, impossible to version and impossible to explain (§28)',
    );
    check(
      'no-formula-in-trigger',
      !/\b(SUM|AVG|MIN|MAX)\s*\(/i.test(body),
      'a Phase 3 trigger aggregates values. Aggregation is a calculation, and ' +
        'calculations live in the engine where they can be traced (§28)',
    );
  }

  // 7: additive discipline — the Phase 3 migration touches only helm_* objects.
  for (const m of sqlNoComments.matchAll(
    /(?:CREATE|ALTER|DROP)\s+TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?\s+public\.([a-z_]+)/gi,
  )) {
    check(
      'additive-only',
      m[1].toLowerCase().startsWith('helm_'),
      `the Phase 3 migration touches "${m[1]}", which is not a HELM-owned table`,
    );
  }
  for (const m of sqlNoComments.matchAll(/\b(DROP\s+TABLE|TRUNCATE|DROP\s+COLUMN)\b/gi)) {
    fail('additive-only', `the Phase 3 migration contains ${m[1]}`);
  }
}

// ------------------- what Phase 3 MUST have: the absence checks cut both ways

// A boundary verifier that only proved absence could pass on an empty phase.
const REQUIRED = [
  { file: 'engine.ts', why: 'the propagation engine' },
  { file: 'registry.ts', why: 'the calculation registry' },
  { file: 'dependencyGraph.ts', why: 'the executable dependency graph' },
  { file: 'conformance.ts', why: 'the shared adapter contract' },
  { file: 'postgres.ts', why: 'the production adapter' },
  { file: 'meridianValueModelV1.ts', why: 'the first executable management model' },
];
for (const { file, why } of REQUIRED) {
  check('phase-artifacts', engineCode.has(file), `${why} (${file}) is missing`);
}

// And the engine really does write derived observations — the thing Phase 2 could not do.
const engineSrc = engineCode.get('engine.ts') ?? '';
check(
  'phase-artifacts',
  /recordObservation/.test(engineSrc),
  'the engine never records an observation, so nothing propagates',
);
check(
  'phase-artifacts',
  /appendStep/.test(engineSrc),
  'the engine never appends a trace step, so nothing is auditable',
);

// ------------------------------------------------------------------ report

if (failures.length === 0) {
  console.log(
    'verify:phase-boundary — ok (propagation and lineage present; no scenario ' +
      'management, decisions, authority, surfaces or optimization)',
  );
  process.exit(0);
}

console.error(`verify:phase-boundary — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
