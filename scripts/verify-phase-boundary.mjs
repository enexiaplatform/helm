/**
 * verify:phase-boundary — Phase 4 does what Phase 4 does, and no more.
 *
 * Every phase ships a verifier that asserts the ABSENCE of the next phase's
 * work, because the most expensive mistake in a layered build is a layer that
 * quietly starts doing the next one's job. Phase 3's verifier forbade scenario
 * comparison; Phase 4 now owns comparison, so that rule is retired and replaced
 * by what Phase 4 must not do. Scanned across the propagation engine, the
 * scenario runtime and the scenario explorer:
 *
 *   1. No automatic recommendation, ranking or scoring of scenarios. HELM
 *      shows the trade-off space; choosing within it is management's (Phase 5).
 *   2. No decisions: recording, approving or governing one is Phase 5.
 *   3. No decision authority or visibility rules. That is Phase 6.
 *   4. No counterfactual or causal inference. A value link is not a causal
 *      claim; the causal graph is a later phase.
 *   5. No optimization solver. A constraint is checked, never solved for.
 *   6. No agent debate or multi-agent deliberation.
 *   7. No management surfaces beyond the technical explorer.
 *   8. No eval, no executable code in the database, no formula in a trigger —
 *      Phase 3's migration and Phase 4's.
 *   9. The additive discipline: nothing outside helm_*.
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
const RUNTIME_SRC = join(root, 'packages', 'scenario-runtime', 'src');
const MIGRATION = join(root, 'supabase', 'migrations', '20260920090000_helm_propagation.sql');
const PHASE4_MIGRATION = join(root, 'supabase', 'migrations', '20260922090100_helm_scenario_runtime.sql');
/** The Phase 4 surface: the technical explorer and the service behind it. */
const PHASE4_APP = [
  join(root, 'src', 'pages', 'ScenariosPage.tsx'),
  join(root, 'src', 'services', 'scenarioRuntime.ts'),
];

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
const runtimeFiles = existsSync(RUNTIME_SRC) ? readdirSync(RUNTIME_SRC).filter((f) => f.endsWith('.ts')) : [];
/** Every file the Phase 4 boundary is checked against, by readable path. */
const scanned = new Map([
  ...[...engineCode].map(([f, code]) => [`packages/propagation-engine/src/${f}`, code]),
  ...runtimeFiles.map((f) => [
    `packages/scenario-runtime/src/${f}`,
    stripNonCode(readFileSync(join(RUNTIME_SRC, f), 'utf8')),
  ]),
  ...PHASE4_APP.filter(existsSync).map((p) => [
    p.slice(root.length + 1).replaceAll('\\', '/'),
    stripNonCode(readFileSync(p, 'utf8')),
  ]),
]);

// ------------------------------- 1-7: the next phases have not started here

const NOT_YET = [
  {
    rule: 'no-recommendation',
    // Comparing futures is Phase 4. Choosing between them — or ordering them so
    // one reads as the answer — is a management decision (Phase 5).
    patterns: [
      /\brecommend\w*/i,
      /\bbestScenario\b/i,
      /\bwinningScenario\b|\bwinner\b/i,
      /\brankScenarios?\b|\bscenarioRank\w*|\branking\b/i,
      /\bscenarioScore\b|\bcompositeScore\b|\boverallScore\b|\benterpriseScore\b/i,
      /\bpreferredScenario\b|\bchosenScenario\b/i,
    ],
    why: 'automatic scenario recommendation, ranking or scoring',
    phase: 'Phase 5 — management chooses; HELM shows the trade-off space',
  },
  {
    rule: 'no-decisions',
    patterns: [
      /\bcreateDecision\b/,
      /\bapproveDecision\b/,
      /\bapprove(?:Scenario)?\s*\(/,
      /\bDecisionState\b/,
      /\brecordDecision\b/,
      /\bdecisionWorkflow\b/,
      /\bcommitScenario\b/,
    ],
    why: 'decision recording, approval or commitment',
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
      /\bdecisionRights?\b/,
    ],
    why: 'decision authority or visibility rules',
    phase: 'Phase 6 — Authority and Visibility',
  },
  {
    rule: 'no-causal-inference',
    patterns: [/\bcounterfactual\w*/i, /\bcausal\w*/i, /\bdoCalculus\b/i, /\binterventionEffect\b/i],
    why: 'counterfactual or causal inference',
    phase: 'the causal graph phase — a value link is not a causal claim',
  },
  {
    rule: 'no-optimization',
    // HELM checks a constraint; it never searches for the state that satisfies it.
    patterns: [
      /\boptimi[sz]e\w*\s*\(/,
      /\bsolve\s*\(/,
      /\bsolver\b/i,
      /\bmaximi[sz]e\s*\(/,
      /\bminimi[sz]e\s*\(/,
      /\blinearProgram\w*/,
      /\bsimplex\b/,
    ],
    why: 'an optimizer',
    phase: 'never — HELM quantifies trade-offs; managers resolve them',
  },
  {
    rule: 'no-agent-debate',
    patterns: [/\bagentDebate\b/i, /\bdebate\w*\s*\(/i, /\bmultiAgent\w*/i, /\bdeliberat\w*\s*\(/i],
    why: 'agent debate',
    phase: 'a later phase — Phase 4 is deterministic',
  },
  {
    rule: 'no-management-surface',
    patterns: [/\bdashboard\b/i, /\bbriefing\b/i, /\bexecutiveSummary\b/],
    why: 'a management surface',
    phase: 'Phase 14 — Management Surfaces',
  },
];

for (const [file, code] of scanned) {
  for (const { rule, patterns, why, phase } of NOT_YET) {
    for (const re of patterns) {
      if (re.test(code)) {
        fail(rule, `${file} contains ${why} (${re}). That is ${phase}.`);
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
      `packages/propagation-engine/src/${file} imports ${m[1]} — the engine sits below the scenario runtime`,
    );
  }
}
for (const file of runtimeFiles) {
  const raw = readFileSync(join(RUNTIME_SRC, file), 'utf8');
  for (const m of raw.matchAll(/from\s+'(@helm\/[a-z-]+)'/g)) {
    const allowed = ['@helm/shared', '@helm/ontology', '@helm/graph-store', '@helm/value-graph', '@helm/propagation-engine'];
    check(
      'layering',
      allowed.includes(m[1]),
      `packages/scenario-runtime/src/${file} imports ${m[1]}, which is not a Phase 0-4 kernel package`,
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
for (const [file, code] of scanned) {
  for (const { re, why } of NO_EVAL) {
    check(
      'no-eval',
      !re.test(code),
      `${file} uses ${why}. A formula HELM cannot read ` +
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

if (!existsSync(PHASE4_MIGRATION)) {
  fail('phase-artifacts', 'the Phase 4 migration is missing');
} else {
  const sql4 = readFileSync(PHASE4_MIGRATION, 'utf8').replace(/--[^\n]*/g, ' ');
  const bodies4 = [...sql4.matchAll(/AS\s+\$fn\$([\s\S]*?)\$fn\$/g)].map((m) => m[1]);
  check('no-formula-in-trigger', bodies4.length > 0, 'no Phase 4 trigger bodies were found, so this check proved nothing');
  for (const body of bodies4) {
    check('no-formula-in-trigger', !/\bNEW\.[a-z_]+\s*:=/i.test(body), 'a Phase 4 trigger assigns to a NEW column');
    check('no-formula-in-trigger', !/\b(SUM|AVG|MIN|MAX)\s*\(/i.test(body), 'a Phase 4 trigger aggregates values');
  }
  for (const m of sql4.matchAll(/(?:CREATE|ALTER|DROP)\s+TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?\s+public\.([a-z_]+)/gi)) {
    check('additive-only', m[1].toLowerCase().startsWith('helm_'), `the Phase 4 migration touches "${m[1]}"`);
  }
  for (const m of sql4.matchAll(/\b(DROP\s+TABLE|TRUNCATE|DROP\s+COLUMN)\b/gi)) {
    fail('additive-only', `the Phase 4 migration contains ${m[1]}`);
  }
  for (const re of [/\bformula_js\b/i, /\bexpression_js\b/i, /\bcode\s+text\b/i, /\bjavascript\b/i]) {
    check('no-code-in-db', !re.test(sql4), `the Phase 4 migration defines something matching ${re}`);
  }
}

// ------------------- what Phase 4 MUST have: the absence checks cut both ways

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
for (const { file, why } of [
  { file: 'runtime.ts', why: 'the scenario runtime' },
  { file: 'comparison.ts', why: 'the comparison of future states' },
  { file: 'constraints.ts', why: 'feasibility constraints' },
  { file: 'overlay.ts', why: 'inheritance and the override overlay' },
  { file: 'fingerprint.ts', why: 'the scenario fingerprint' },
  { file: 'postgres.ts', why: 'the production scenario store' },
  { file: 'conformance.ts', why: 'the scenario store contract' },
]) {
  check('phase-artifacts', runtimeFiles.includes(file), `${why} (packages/scenario-runtime/src/${file}) is missing`);
}
// And comparison — forbidden in Phase 3 — now exists, and still chooses nothing.
const runtimeCode = scanned.get('packages/scenario-runtime/src/runtime.ts') ?? '';
check('phase-artifacts', /\bcompare\s*\(|async\s+compare\b/.test(runtimeCode), 'the runtime cannot compare states');
check('phase-artifacts', /engine\.execute\s*\(/.test(runtimeCode), 'the runtime does not simulate through the engine');

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
    `verify:phase-boundary — ok (${scanned.size} files: scenario runtime and comparison present; no ` +
      'recommendation, decisions, authority, causal inference, optimization or agent debate)',
  );
  process.exit(0);
}

console.error(`verify:phase-boundary — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
