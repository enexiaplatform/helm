/**
 * verify:phase-boundary — Phase 7 does what Phase 7 does, and no more.
 *
 * Every phase ships a verifier that asserts the ABSENCE of the next phase's
 * work, because the most expensive mistake in a layered build is a layer that
 * quietly starts doing the next one's job. Phase 3's verifier forbade scenario
 * comparison; Phase 4 took comparison and forbade decisions; Phase 5 took
 * decisions and forbade authority; Phase 6 took decision authority and forbade
 * a digital twin; Phase 7 now owns the Management Digital Twin — but ONLY in
 * @helm/twin-runtime and the twin surfaces, reading every layer below it and
 * writing none of them. Scanned across the propagation engine, the scenario,
 * decision, authority and twin runtimes, the trusted authority host and the
 * explorers:
 *
 *   1. No automatic recommendation, ranking or scoring — of a scenario OR of a
 *      decision alternative. HELM shows the trade-off space and evaluates
 *      management's own criteria; choosing is management's.
 *   2. Decision AUTHORITY lives only in the authority runtime. The engine,
 *      the scenario runtime and the decision runtime still hold none of it,
 *      and the commitment's authority_status stays NOT_EVALUATED for ever.
 *      Nothing approves, commits or authorizes automatically — anywhere.
 *   2b. No governance simulation ("what if the DOA changed") and no
 *      notification platform: both are later phases.
 *   2c. The authority runtime never mutates a decision or a commitment.
 *   3. No counterfactual or causal inference. A value link is not a causal
 *      claim; the causal graph is a later phase.
 *   4. No optimization solver. A constraint is checked, never solved for.
 *   5. No agent debate or multi-agent deliberation, and no AI recommendation:
 *      the Intelligence Runtime is Phase 11.
 *   6. No Management Genome: outcome review records variance and assumption
 *      outcomes; it does not learn patterns or score decision quality.
 *   7. No management surfaces beyond the technical explorers: no GM cockpit.
 *   7b. The twin composes; it never writes a kernel layer below it, and its
 *       attention is conditions — never an AI priority or a score.
 *   8. No eval, no executable code in the database, no formula in a trigger.
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
const SCENARIO_SRC = join(root, 'packages', 'scenario-runtime', 'src');
const DECISION_SRC = join(root, 'packages', 'decision-runtime', 'src');
const AUTHORITY_SRC = join(root, 'packages', 'authority-runtime', 'src');
const TWIN_SRC = join(root, 'packages', 'twin-runtime', 'src');
const PHASE7_MIGRATION = join(root, 'supabase', 'migrations', '20260929090000_helm_management_twin.sql');
const MIGRATION = join(root, 'supabase', 'migrations', '20260920090000_helm_propagation.sql');
const PHASE4_MIGRATION = join(root, 'supabase', 'migrations', '20260922090100_helm_scenario_runtime.sql');
const PHASE5_MIGRATION = join(root, 'supabase', 'migrations', '20260923100000_helm_decision_runtime.sql');
const PHASE6_MIGRATION = join(root, 'supabase', 'migrations', '20260928100000_helm_decision_authority.sql');
/** The Phase 4 and Phase 5 surfaces: the technical explorers and their services. */
const KERNEL_APP = [
  join(root, 'src', 'pages', 'ScenariosPage.tsx'),
  join(root, 'src', 'services', 'scenarioRuntime.ts'),
  join(root, 'src', 'pages', 'DecisionDetailPage.tsx'),
  join(root, 'src', 'services', 'decisionRuntime.ts'),
  join(root, 'src', 'services', 'decisionWorkspace.ts'),
];
/** The Phase 7 surfaces: where the twin may be SHOWN, and the trusted host. */
const TWIN_APP = [
  join(root, 'src', 'pages', 'TwinPage.tsx'),
  join(root, 'src', 'services', 'twinRuntime.ts'),
];
const TRUSTED_HOST = [join(root, 'server', 'authority', 'host.ts')];
const rel = (p) => p.slice(root.length + 1).replaceAll('\\', '/');
/** The Phase 6 surfaces: where authority may be SHOWN. */
const GOVERNANCE_APP = [
  join(root, 'src', 'pages', 'GovernancePage.tsx'),
  join(root, 'src', 'services', 'authorityRuntime.ts'),
  join(root, 'src', 'components', 'decision', 'GovernancePanel.tsx'),
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

const tsFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.ts')) : []);
const engineFiles = tsFiles(ENGINE_SRC);
const scenarioFiles = tsFiles(SCENARIO_SRC);
const decisionFiles = tsFiles(DECISION_SRC);
const authorityFiles = tsFiles(AUTHORITY_SRC);
const twinFiles = tsFiles(TWIN_SRC);
const engineCode = new Map(engineFiles.map((f) => [f, stripNonCode(readFileSync(join(ENGINE_SRC, f), 'utf8'))]));

/** Every file the phase boundary is checked against, by readable path. */
const scanned = new Map([
  ...[...engineCode].map(([f, code]) => [`packages/propagation-engine/src/${f}`, code]),
  ...scenarioFiles.map((f) => [
    `packages/scenario-runtime/src/${f}`,
    stripNonCode(readFileSync(join(SCENARIO_SRC, f), 'utf8')),
  ]),
  ...decisionFiles.map((f) => [
    `packages/decision-runtime/src/${f}`,
    stripNonCode(readFileSync(join(DECISION_SRC, f), 'utf8')),
  ]),
  ...authorityFiles.map((f) => [
    `packages/authority-runtime/src/${f}`,
    stripNonCode(readFileSync(join(AUTHORITY_SRC, f), 'utf8')),
  ]),
  ...twinFiles.map((f) => [
    `packages/twin-runtime/src/${f}`,
    stripNonCode(readFileSync(join(TWIN_SRC, f), 'utf8')),
  ]),
  ...[...KERNEL_APP, ...GOVERNANCE_APP, ...TWIN_APP, ...TRUSTED_HOST].filter(existsSync).map((p) => [
    p.slice(root.length + 1).replaceAll('\\', '/'),
    stripNonCode(readFileSync(p, 'utf8')),
  ]),
]);

/** Where decision authority is allowed to exist at all. */
const authorityHome = (file) =>
  file.startsWith('packages/authority-runtime/') ||
  file === 'server/authority/host.ts' ||
  GOVERNANCE_APP.some((p) => p.slice(root.length + 1).replaceAll('\\', '/') === file) ||
  file === 'src/pages/DecisionDetailPage.tsx';

// ------------------------------- 1-7: the next phases have not started here

const NOT_YET = [
  {
    rule: 'no-recommendation',
    // Comparing futures is Phase 4; evaluating management's criteria is
    // Phase 5. Concluding which one to take is neither.
    patterns: [
      /\brecommend\w*/i,
      /\bbestScenario\b|\bbestAlternative\b|\bbestOption\b/i,
      /\bwinningScenario\b|\bwinner\b/i,
      /\brankScenarios?\b|\brankAlternatives?\b|\bscenarioRank\w*|\branking\b/i,
      /\bscenarioScore\b|\bdecisionScore\b|\bcompositeScore\b|\boverallScore\b|\benterpriseScore\b/i,
      /\bqualityScore\b|\breadinessScore\b/i,
      /\bpreferredScenario\b|\bchosenScenario\b/i,
      /\boptimizeAlternatives?\b/i,
    ],
    why: 'automatic recommendation, ranking or scoring',
    phase: 'never — HELM shows the trade-off space and evaluates stated criteria; management chooses',
  },
  {
    rule: 'no-authority-outside-its-home',
    // Authority is Phase 6's, and it lives in ONE place. The engine, the
    // scenario runtime and the decision runtime still record, compute and
    // commit — they never judge who was allowed to.
    skip: authorityHome,
    patterns: [
      /\bcanApprove\b/,
      /\bauthorityLimit\b|\bauthorityThreshold\b/i,
      /\brequiresApproval\b/,
      /\bapprovalThreshold\b|\bapprovalChain\b/i,
      /\bescalationRule\w*|\bescalateTo\b/i,
      /\bvisibilityRule\b/,
      /\bdecisionRights?\b/,
      /\bevaluateAuthority\b|\bAuthorityEngine\b/,
      /\b(?:AUTHORIZED|REQUIRES_APPROVAL|ESCALATED)\b/,
    ],
    why: 'decision authority, approval or escalation outside @helm/authority-runtime',
    phase: 'the authority runtime — authority is judged in one place, over commitments it never changes',
  },
  {
    rule: 'no-automated-decision',
    // Anywhere, including the authority runtime: HELM judges and records; a
    // person approves, commits and executes.
    patterns: [/\bautoApprove\w*/i, /\bautoCommit\w*/i, /\bautoAuthori[sz]e\w*/i, /\bautoExecute\w*/i, /\bautoEscalate\w*/i],
    why: 'an automated management act',
    phase: 'never — the authority runtime evaluates; people act',
  },
  {
    rule: 'no-governance-simulation',
    patterns: [/\bsimulatePolicy\w*/i, /\bwhatIfPolicy\w*/i, /\bpolicySimulation\w*/i, /\bsimulateAuthority\w*/i],
    why: 'governance scenario modelling',
    phase: 'a later phase — Phase 6 evaluates the authority in force, it does not simulate a different one',
  },
  {
    rule: 'no-notification-platform',
    patterns: [/\bsendEmail\w*/i, /\bslack\w*\s*\(/i, /\bnotificationCenter\b/i, /\bpushNotification\w*/i, /\bsmtp\w*/i],
    why: 'a notification or delivery platform',
    phase: 'a later phase — Phase 6 stores governance state; delivery integrations come later',
  },
  {
    rule: 'twin-in-its-home',
    // The twin is Phase 7's, and it lives in ONE place: the layers below
    // compose into it; none of them composes a twin of its own.
    skip: (file) => file.startsWith('packages/twin-runtime/') || TWIN_APP.some((p) => rel(p) === file),
    patterns: [/\bdigitalTwin\w*/i, /\btwinState\w*/i, /\bmanagementTwin\w*/i, /\bTwinSnapshot\b/, /\bcomposeSnapshot\b/],
    why: 'a management digital twin outside @helm/twin-runtime',
    phase: 'the twin runtime — one composition of management state, over layers it never changes',
  },
  {
    rule: 'no-ai-prioritization',
    patterns: [/\battentionScore\w*/i, /\bpriorityScore\w*/i, /\bprioriti[sz]e\w*\s*\(/i, /\burgencyScore\w*/i],
    why: 'a priority or attention score',
    phase: 'never in Phase 7 — attention is a named condition with a cause, not a ranking',
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
    patterns: [/\bagentDebate\b/i, /\bdebate\w*\s*\(/i, /\bmultiAgent\w*/i, /\bdeliberat\w*\s*\(/i, /\bllm\w*\s*\(/i],
    why: 'agent debate or an AI call',
    phase: 'Phase 11 — the Intelligence Runtime. Phase 5 is deterministic',
  },
  {
    rule: 'no-genome',
    // Preserving what is needed to learn later is Phase 5. Learning from it is not.
    patterns: [
      /\bmanagementGenome\b/i,
      /\blearnPattern\w*|\bpatternLearning\b/i,
      /\bdecisionQuality\w*/i,
      /\bsimilarDecisions?\b/i,
      /\bpredictOutcome\w*/i,
    ],
    why: 'decision-pattern learning or a decision-quality judgement',
    phase: 'Phase 9 — Management Genome. Phase 5 preserves the evidence it will need',
  },
  {
    rule: 'no-management-surface',
    patterns: [/\bdashboard\b/i, /\bbriefing\b/i, /\bexecutiveSummary\b/, /\bcockpit\w*/i],
    why: 'a management surface',
    phase: 'Phase 14 — the Country GM Cockpit and management surfaces',
  },
];

for (const [file, code] of scanned) {
  for (const { rule, patterns, why, phase, skip } of NOT_YET) {
    if (skip && skip(file)) continue;
    for (const re of patterns) {
      if (re.test(code)) {
        fail(rule, `${file} contains ${why} (${re}). That is ${phase}.`);
      }
    }
  }
}

// ------------------------------------------------------- layering downward

const LAYERS = [
  {
    dir: ENGINE_SRC,
    files: engineFiles,
    label: 'packages/propagation-engine/src',
    allowed: ['@helm/shared', '@helm/ontology', '@helm/graph-store', '@helm/value-graph'],
    self: '@helm/propagation-engine',
    note: 'the engine sits below the scenario runtime',
  },
  {
    dir: SCENARIO_SRC,
    files: scenarioFiles,
    label: 'packages/scenario-runtime/src',
    allowed: ['@helm/shared', '@helm/ontology', '@helm/graph-store', '@helm/value-graph', '@helm/propagation-engine'],
    self: '@helm/scenario-runtime',
    note: 'the scenario runtime sits below the decision runtime',
  },
  {
    dir: DECISION_SRC,
    files: decisionFiles,
    label: 'packages/decision-runtime/src',
    allowed: [
      '@helm/shared',
      '@helm/ontology',
      '@helm/graph-store',
      '@helm/value-graph',
      '@helm/propagation-engine',
      '@helm/scenario-runtime',
    ],
    self: '@helm/decision-runtime',
    note: 'the decision runtime sits below the authority runtime, and knows nothing of it',
  },
  {
    dir: AUTHORITY_SRC,
    files: authorityFiles,
    label: 'packages/authority-runtime/src',
    allowed: [
      '@helm/shared',
      '@helm/ontology',
      '@helm/graph-store',
      '@helm/value-graph',
      '@helm/propagation-engine',
      '@helm/scenario-runtime',
      '@helm/decision-runtime',
    ],
    self: '@helm/authority-runtime',
    note: 'the authority runtime sits below the twin runtime, and knows nothing of it',
  },
  {
    dir: TWIN_SRC,
    files: twinFiles,
    label: 'packages/twin-runtime/src',
    allowed: [
      '@helm/shared',
      '@helm/ontology',
      '@helm/graph-store',
      '@helm/value-graph',
      '@helm/propagation-engine',
      '@helm/scenario-runtime',
      '@helm/decision-runtime',
      '@helm/authority-runtime',
    ],
    self: '@helm/twin-runtime',
    note: 'the twin runtime is the top of the kernel',
  },
];
for (const { dir, files, label, allowed, self, note } of LAYERS) {
  for (const file of files) {
    const raw = readFileSync(join(dir, file), 'utf8');
    for (const m of raw.matchAll(/from\s+'(@helm\/[a-z-]+)'/g)) {
      check('layering', allowed.includes(m[1]) || m[1].startsWith(self), `${label}/${file} imports ${m[1]} — ${note}`);
    }
  }
}

// ----------------- 8: no eval, no code in the database, no formula in a trigger

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

const MIGRATIONS = [
  { path: MIGRATION, phase: 'Phase 3' },
  { path: PHASE4_MIGRATION, phase: 'Phase 4' },
  { path: PHASE5_MIGRATION, phase: 'Phase 5' },
  { path: PHASE6_MIGRATION, phase: 'Phase 6' },
  { path: PHASE7_MIGRATION, phase: 'Phase 7' },
];
for (const { path, phase } of MIGRATIONS) {
  if (!existsSync(path)) {
    fail('phase-artifacts', `the ${phase} migration is missing`);
    continue;
  }
  const sql = readFileSync(path, 'utf8').replace(/--[^\n]*/g, ' ');

  for (const re of [/\bformula_js\b/i, /\bexpression_js\b/i, /\bcode\s+text\b/i, /\bjavascript\b/i, /\bscript\b/i]) {
    check(
      'no-code-in-db',
      !re.test(sql),
      `the ${phase} migration defines something matching ${re}. HELM stores metadata; ` +
        'implementations are typed functions in code (ADR-0017 §1)',
    );
  }

  const bodies = [...sql.matchAll(/AS\s+\$fn\$([\s\S]*?)\$fn\$/g)].map((m) => m[1]);
  check('no-formula-in-trigger', bodies.length > 0, `no ${phase} trigger bodies were found, so this check proved nothing`);
  for (const body of bodies) {
    // Stamping the record time of a change (`NEW.ended_at := now()`) is not a
    // formula: it says WHEN HELM learned something, which is what record time is.
    check('no-formula-in-trigger', !/\bNEW\.[a-z_]+\s*:=(?!\s*now\(\);)/i.test(body),
      `a ${phase} trigger assigns to a NEW column. Business formulas in triggers are invisible to tests, ` +
        'impossible to version and impossible to explain (§28)');
    check('no-formula-in-trigger', !/\b(SUM|AVG|MIN|MAX)\s*\(/i.test(body),
      `a ${phase} trigger aggregates values. Aggregation is a calculation, and calculations live in the engine (§28)`);
  }

  for (const m of sql.matchAll(/(?:CREATE|ALTER|DROP)\s+TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?\s+public\.([a-z_]+)/gi)) {
    check('additive-only', m[1].toLowerCase().startsWith('helm_'),
      `the ${phase} migration touches "${m[1]}", which is not a HELM-owned table`);
  }
  for (const m of sql.matchAll(/\b(DROP\s+TABLE|TRUNCATE|DROP\s+COLUMN)\b/gi)) {
    fail('additive-only', `the ${phase} migration contains ${m[1]}`);
  }
}

// Phase 5's database must not be able to express an authority verdict at all.
if (existsSync(PHASE5_MIGRATION)) {
  const sql5 = readFileSync(PHASE5_MIGRATION, 'utf8');
  check('no-authority', /authority_status\s*=\s*'NOT_EVALUATED'/.test(sql5),
    'the Phase 5 schema does not pin authority_status to NOT_EVALUATED');
  for (const word of ['AUTHORIZED', 'REQUIRES_APPROVAL', 'ESCALATED']) {
    check('no-authority', !new RegExp(`'${word}'`).test(sql5),
      `the Phase 5 schema can store the authority verdict ${word}, which is Phase 6's to produce`);
  }
}

// The authority runtime judges commitments; it never changes one, and it
// never writes below itself. meridianGovernance.ts is demo SEED data: it plays
// management, building and committing the proof decisions through the decision
// runtime as a person would, so it is the one file exempt.
for (const [file, code] of scanned) {
  if (!file.startsWith('packages/authority-runtime/') || file.endsWith('meridianGovernance.ts')) continue;
  const writes = /\b(?:decisions|decisionStore)\.(createCommitment|createSnapshot|setDecisionState|sealRevision|updateDecisionFraming|addAlternative|setAlternativeBinding|recordAssessment|resolveChallenge|commit)\s*\(/;
  const m = writes.exec(code);
  check('authority-never-mutates', !m, `${file} calls ${m?.[1]} on the decision layer — the authority runtime judges commitments, it does not change them`);
  const model = /\b(?:scenarios|engine)\.(execute|addOverride|createScenario|rebase|createRevision)\s*\(/.exec(code);
  check('authority-never-mutates', !model, `${file} calls ${model?.[1]} — the authority runtime reads consequences, it does not compute them`);
}

// The twin composes; it writes nothing below itself. meridianTwin.ts is demo
// SEED data — it lives the story through the kernels as management would — so
// it is the one file exempt.
for (const [file, code] of scanned) {
  if (!file.startsWith('packages/twin-runtime/') || file.endsWith('meridianTwin.ts')) continue;
  const writes = /\.(createCommitment|commit|recordApproval|recordRejection|evaluate|recordObservation|createEntity|updateEntity|createRelationship|removeRelationship|execute|executeBaseline|addOverride|recordPolicy|recordOccupancy|endOccupancy|createDelegation|setActionIntentStatus|recordOutcomeReview|appendEvent|setDecisionState)\s*\(/.exec(code);
  check('twin-never-writes-below', !writes, `${file} calls ${writes?.[1]} — the twin reads the kernel, it does not change it`);
}
const trusted = scanned.get('packages/authority-runtime/src/trusted.ts') ?? '';
check('phase-artifacts', /verifyCalculationTrace\s*\(/.test(trusted), 'the trusted authority service does not re-derive the chosen run before believing it');
check('phase-artifacts', existsSync(join(root, 'supabase', 'functions', 'helm-authority', 'index.ts')), 'the helm-authority edge function is missing');
for (const { file, why } of [
  { file: 'compose.ts', why: 'the snapshot composer' },
  { file: 'structure.ts', why: 'time-aware enterprise structure' },
  { file: 'values.ts', why: 'layered value readings' },
  { file: 'management.ts', why: 'decision and governance state as of a boundary' },
  { file: 'attention.ts', why: 'rule-based attention' },
  { file: 'delta.ts', why: 'the twin delta' },
  { file: 'explain.ts', why: 'item lineage and dependency attribution' },
  { file: 'trajectory.ts', why: 'current state against committed future' },
  { file: 'fingerprint.ts', why: 'the snapshot fingerprint' },
  { file: 'sensitivity.ts', why: 'sensitivity and visibility' },
  { file: 'runtime.ts', why: 'the twin runtime' },
  { file: 'postgres.ts', why: 'the production twin store' },
  { file: 'conformance.ts', why: 'the twin store contract' },
  { file: 'managementApi.ts', why: 'the management API foundation' },
  { file: 'meridianTwin.ts', why: 'the canonical twin story' },
]) {
  check('phase-artifacts', twinFiles.includes(file), `${why} (packages/twin-runtime/src/${file}) is missing`);
}

// ------------------- what Phase 5 MUST have: the absence checks cut both ways

// A boundary verifier that only proved absence could pass on an empty phase.
for (const { file, why } of [
  { file: 'engine.ts', why: 'the propagation engine' },
  { file: 'registry.ts', why: 'the calculation registry' },
  { file: 'dependencyGraph.ts', why: 'the executable dependency graph' },
  { file: 'conformance.ts', why: 'the shared adapter contract' },
  { file: 'postgres.ts', why: 'the production adapter' },
  { file: 'meridianValueModelV1.ts', why: 'the first executable management model' },
]) {
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
  check('phase-artifacts', scenarioFiles.includes(file), `${why} (packages/scenario-runtime/src/${file}) is missing`);
}
for (const { file, why } of [
  { file: 'runtime.ts', why: 'the decision runtime' },
  { file: 'criteria.ts', why: 'criterion evaluation' },
  { file: 'tradeoff.ts', why: 'the decision trade-off space' },
  { file: 'readiness.ts', why: 'decision readiness' },
  { file: 'fingerprint.ts', why: 'the commitment fingerprint' },
  { file: 'postgres.ts', why: 'the production decision store' },
  { file: 'conformance.ts', why: 'the decision store contract' },
  { file: 'meridianDecision.ts', why: 'the canonical Rohto decision' },
]) {
  check('phase-artifacts', decisionFiles.includes(file), `${why} (packages/decision-runtime/src/${file}) is missing`);
}

// Comparison — forbidden in Phase 3 — exists and still chooses nothing.
const scenarioRuntimeCode = scanned.get('packages/scenario-runtime/src/runtime.ts') ?? '';
check('phase-artifacts', /\bcompare\s*\(|async\s+compare\b/.test(scenarioRuntimeCode), 'the scenario runtime cannot compare states');
check('phase-artifacts', /engine\.execute\s*\(/.test(scenarioRuntimeCode), 'the scenario runtime does not simulate through the engine');

for (const { file, why } of [
  { file: 'engine.ts', why: 'the authority engine' },
  { file: 'scope.ts', why: 'enterprise scope derivation' },
  { file: 'conditions.ts', why: 'consequence thresholds' },
  { file: 'delegation.ts', why: 'delegation bounds' },
  { file: 'policy.ts', why: 'the authority in force at an instant' },
  { file: 'state.ts', why: 'the governance state projection' },
  { file: 'visibility.ts', why: 'decision visibility' },
  { file: 'fingerprint.ts', why: 'the evaluation fingerprint' },
  { file: 'runtime.ts', why: 'the authority runtime' },
  { file: 'postgres.ts', why: 'the production authority store' },
  { file: 'conformance.ts', why: 'the authority store contract' },
  { file: 'meridianGovernance.ts', why: 'the canonical demo governance policy' },
]) {
  check('phase-artifacts', authorityFiles.includes(file), `${why} (packages/authority-runtime/src/${file}) is missing`);
}
const authorityRuntimeCode = scanned.get('packages/authority-runtime/src/runtime.ts') ?? '';
check('phase-artifacts', /scenarios\.getFutureState\s*\(/.test(authorityRuntimeCode),
  'the authority runtime does not read consequences from the chosen future state');
check('phase-artifacts', /evaluationFingerprint\s*\(/.test(authorityRuntimeCode), 'an evaluation is not fingerprinted');
check('phase-artifacts', /commitmentFingerprint/.test(authorityRuntimeCode), 'an evaluation is not bound to the commitment fingerprint');

// Commitment — forbidden in Phase 4 — exists, and rests on scenario futures.
const decisionRuntimeCode = scanned.get('packages/decision-runtime/src/runtime.ts') ?? '';
check('phase-artifacts', /async\s+commit\b/.test(decisionRuntimeCode), 'the decision runtime cannot record a commitment');
check('phase-artifacts', /scenarios\.getFutureState\s*\(/.test(decisionRuntimeCode),
  'the decision runtime does not read its numbers from scenario future states');
check('phase-artifacts', /snapshotFingerprint\s*\(|commitmentFingerprint\s*\(/.test(decisionRuntimeCode),
  'a commitment is not fingerprinted, so nobody can tell when its basis moved');

// And the engine really does write derived observations — the thing Phase 2 could not do.
const engineSrc = engineCode.get('engine.ts') ?? '';
check('phase-artifacts', /recordObservation/.test(engineSrc), 'the engine never records an observation, so nothing propagates');
check('phase-artifacts', /appendStep/.test(engineSrc), 'the engine never appends a trace step, so nothing is auditable');

// ------------------------------------------------------------------ report

if (failures.length === 0) {
  console.log(
    `verify:phase-boundary — ok (${scanned.size} files: twin runtime present, confined to its package and writing nothing ` +
      'below it; authority confined to its package; no recommendation, automated act, attention score, governance ' +
      'simulation, notification platform, cockpit, causal inference, optimization, agent debate or pattern learning)',
  );
  process.exit(0);
}

console.error(`verify:phase-boundary — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
