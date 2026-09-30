/**
 * verify:boundaries — every layer does its own job, and only that one.
 *
 * HELM is one stack, not a list of features. Each layer sits on the ones below and knows nothing of the
 * ones above; each concept has ONE home and is only read (never redefined) higher up; and there are things
 * HELM never does anywhere: recommend, rank, score a person, vote, average, predict, optimize, learn a
 * pattern nobody proposed, or let an AI or an agent write enterprise truth.
 *
 *   1. Dependency direction — a package imports only layers strictly below it (integration is a lateral
 *      ingestion layer), never by relative path, and nobody below imports the layers above.
 *   2. Concept homes — the words of a layer's concept are confined to its package and the packages above it.
 *   3. Permanent absences — anywhere in packages, server and the app's services and pages: no recommendation,
 *      ranking, health score, person score, vote, consensus, regret, outcome prediction, pattern learning,
 *      optimizer, automated management act, governance simulation, notification platform, agent debate.
 *   4. Writes below — a layer never calls the write methods of the layers beneath it. The AI layer and the
 *      council call NO kernel write at all; the integration fabric writes only what it ingests.
 *   5. No eval, no code in the database, no formula in a trigger, additive migrations only.
 *   6. Required artifacts — the absence checks cut both ways: a layer that is missing files fails.
 *
 * Every source scan strips comments and string literals first: prose must not trip a code check.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const failures = [];
const fail = (rule, detail) => failures.push({ rule, detail });
const check = (rule, cond, detail) => {
  if (!cond) fail(rule, detail);
};

const root = process.cwd();
const rel = (p) => p.slice(root.length + 1).replaceAll('\\', '/');

/** The stack, bottom to top. `uses` is what a layer may import; rank drives the concept homes. */
const STACK = [
  { pkg: 'shared', rank: 0, uses: [] },
  { pkg: 'ontology', rank: 1, uses: ['shared'] },
  { pkg: 'graph-store', rank: 2, uses: ['shared', 'ontology'] },
  { pkg: 'value-graph', rank: 3, uses: ['shared', 'ontology', 'graph-store'] },
  { pkg: 'propagation-engine', rank: 4, uses: ['shared', 'ontology', 'graph-store', 'value-graph'] },
  { pkg: 'scenario-runtime', rank: 5, uses: ['shared', 'ontology', 'graph-store', 'value-graph', 'propagation-engine'] },
  { pkg: 'decision-runtime', rank: 6, uses: ['shared', 'ontology', 'graph-store', 'value-graph', 'propagation-engine', 'scenario-runtime'] },
  { pkg: 'authority-runtime', rank: 7, uses: ['shared', 'ontology', 'graph-store', 'value-graph', 'propagation-engine', 'scenario-runtime', 'decision-runtime'] },
  { pkg: 'twin-runtime', rank: 8, uses: ['shared', 'ontology', 'graph-store', 'value-graph', 'propagation-engine', 'scenario-runtime', 'decision-runtime', 'authority-runtime'] },
  { pkg: 'causal-runtime', rank: 9, uses: ['shared', 'ontology', 'graph-store', 'value-graph', 'propagation-engine', 'scenario-runtime', 'decision-runtime', 'authority-runtime', 'twin-runtime'] },
  { pkg: 'counterfactual-runtime', rank: 10, uses: ['shared', 'ontology', 'graph-store', 'value-graph', 'propagation-engine', 'scenario-runtime', 'decision-runtime', 'authority-runtime', 'twin-runtime', 'causal-runtime'] },
  { pkg: 'genome-runtime', rank: 11, uses: ['shared', 'ontology', 'graph-store', 'value-graph', 'propagation-engine', 'scenario-runtime', 'decision-runtime', 'authority-runtime', 'twin-runtime', 'causal-runtime', 'counterfactual-runtime'] },
  // The ingestion fabric sits BESIDE the reasoning layers: it brings source-typed observations in, through the
  // value graph, and reads decisions and commitments only to decide what may be written back (dry-run).
  { pkg: 'integration-runtime', rank: 8, uses: ['shared', 'ontology', 'graph-store', 'value-graph', 'decision-runtime', 'authority-runtime'] },
  { pkg: 'review-runtime', rank: 12, uses: ['shared', 'ontology', 'graph-store', 'value-graph', 'propagation-engine', 'scenario-runtime', 'decision-runtime', 'authority-runtime', 'twin-runtime', 'causal-runtime', 'counterfactual-runtime', 'genome-runtime'] },
  { pkg: 'intelligence-runtime', rank: 13, uses: ['shared', 'ontology', 'graph-store', 'value-graph', 'propagation-engine', 'scenario-runtime', 'decision-runtime', 'authority-runtime', 'twin-runtime', 'causal-runtime', 'counterfactual-runtime', 'genome-runtime', 'review-runtime'] },
  { pkg: 'agent-runtime', rank: 14, uses: ['shared', 'intelligence-runtime'] },
];
const rankOf = (pkg) => STACK.find((l) => l.pkg === pkg)?.rank ?? -1;
const pkgOfFile = (file) => /^packages\/([a-z-]+)\//.exec(file)?.[1] ?? null;

/** Strips comments and string literals so prose cannot trip a code check. */
const stripNonCode = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');

function walk(dir, pred, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'coverage', '.git'].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, pred, out);
    else if (pred(e.name)) out.push(p);
  }
  return out;
}

/** Every file the boundary is checked against: package sources, the trusted host, the app's services, pages, components. */
const scanned = new Map();
const raw = new Map();
for (const dir of ['packages', 'server', 'src']) {
  const base = join(root, dir);
  const files = walk(base, (n) => /\.(ts|tsx)$/.test(n)).filter((p) => !/[\\/]test[\\/]/.test(p));
  for (const p of files) {
    const r = readFileSync(p, 'utf8');
    raw.set(rel(p), r);
    scanned.set(rel(p), stripNonCode(r));
  }
}
const inPackages = (file) => file.startsWith('packages/');
/** Demo seed files play management through the kernels as a person would; they are the one exemption. */
const isSeed = (file) => /\/meridian[A-Za-z]*\.ts$/.test(file);

// ----------------------------------------------------------- 1. dependency direction

for (const layer of STACK) {
  const dir = join(root, 'packages', layer.pkg, 'src');
  check('layers', existsSync(dir), `the ${layer.pkg} package is missing`);
  for (const [file, src] of raw) {
    if (!file.startsWith(`packages/${layer.pkg}/`)) continue;
    for (const m of src.matchAll(/from\s+'(@helm\/[a-z-]+)(?:\/[a-z-]+)?'/g)) {
      const dep = m[1].slice('@helm/'.length);
      if (dep === layer.pkg) continue;
      check('layering', layer.uses.includes(dep), `${file} imports ${m[1]} — ${layer.pkg} sits ${rankOf(dep) > layer.rank ? 'below' : 'beside'} it and must not depend on it`);
    }
    check('layering', !/from\s+'\.\.\/\.\.\/[a-z-]+\//.test(src), `${file} reaches into another package by relative path`);
  }
}
// Nothing in a package imports the app, and nobody but the app imports the integration fabric or the AI layers.
for (const [file, src] of raw) {
  if (!inPackages(file)) continue;
  check('layering', !/from\s+'(?:\.\.\/)+src\//.test(src) && !/from\s+'react/.test(src), `${file} imports the app or a UI framework`);
}
for (const [file, src] of raw) {
  const own = pkgOfFile(file);
  for (const sealed of ['integration-runtime', 'agent-runtime']) {
    if (own && own !== sealed && src.includes(`'@helm/${sealed}`)) fail('layering', `${file} imports @helm/${sealed}, which only the app composes`);
  }
}

// ----------------------------------------------------------------- 2. concept homes

const CONCEPTS = [
  { name: 'authority', rank: 7, extra: (f) => f === 'server/authority/host.ts', patterns: [/\bcanApprove\b/, /\bauthorityLimit\b|\bauthorityThreshold\b/i, /\brequiresApproval\b/, /\bapprovalChain\b/i, /\bescalationRule\w*|\bescalateTo\b/i, /\bdecisionRights?\b/, /\bevaluateAuthority\b|\bAuthorityEngine\b/, /\b(?:AUTHORIZED|REQUIRES_APPROVAL|ESCALATED)\b/], why: 'decision authority judged outside @helm/authority-runtime' },
  { name: 'twin', rank: 8, patterns: [/\bdigitalTwin\w*/i, /\bmanagementTwin\w*/i, /\bTwinSnapshot\b/, /\bcomposeSnapshot\b/], why: 'the management twin below @helm/twin-runtime' },
  { name: 'causal', rank: 9, patterns: [/\bcausal\w*/i, /\bCausalClaim\b/], why: 'causal knowledge below @helm/causal-runtime' },
  { name: 'counterfactual', rank: 10, patterns: [/\bcounterfactual\w*/i, /\bCounterfactualCase\b/], why: 'a counterfactual world below @helm/counterfactual-runtime' },
  { name: 'genome', rank: 11, patterns: [/\bmanagementGenome\b/i, /\bManagementEpisode\b/, /\bManagementPattern\b/, /\bgenomeEpisode\w*/i], why: 'the management genome below @helm/genome-runtime' },
  { name: 'review', rank: 12, patterns: [/\bManagementReview\b/, /\bReviewPack\b/, /\bcarryForward\w*|\bCARRIED_FORWARD\b/], why: 'a management review below @helm/review-runtime' },
  { name: 'intelligence', rank: 13, patterns: [/\bAiProvider\b/, /\bgroundDraft\w*|\bgroundAnswer\w*/, /\bAiRun\b/], why: 'the AI intelligence runtime below @helm/intelligence-runtime' },
  { name: 'council', rank: 14, patterns: [/\bcreateCouncil\b/, /\bPerspectiveId\b/], why: 'the multi-agent council below @helm/agent-runtime' },
  { name: 'integration', rank: 99, only: ['integration-runtime'], patterns: [/\bSourceAdapter\b/, /\bIngestionPipeline\b/, /\bSchemaDriftDetector\b/, /\bWritebackGateway\b/], why: 'the integration fabric outside @helm/integration-runtime' },
];
for (const [file, code] of scanned) {
  const pkg = pkgOfFile(file);
  if (!pkg) continue; // the app composes every layer; it defines none of them (checked by the layering rules above)
  for (const c of CONCEPTS) {
    const allowed = c.only ? c.only.includes(pkg) || (c.extra?.(file) ?? false) : rankOf(pkg) >= c.rank && pkg !== 'integration-runtime';
    if (allowed) continue;
    for (const re of c.patterns) check('concept-home', !re.test(code), `${file} contains ${c.why} (${re})`);
  }
}

// --------------------------------------------------------------- 3. permanent absences

const ABSENT = [
  { rule: 'no-recommendation', why: 'automatic recommendation, ranking or scoring', patterns: [/\brecommend\w*/i, /\bbest(?:Scenario|Alternative|Option|Action)\b/i, /\bwinningScenario\b|\bwinner\b/i, /\brank(?:Scenarios?|Alternatives?|Options?|Actions?)\b|\bscenarioRank\w*|\branking\b/i, /\b(?:scenario|decision|composite|overall|enterprise|quality|readiness)Score\b/i, /\bpreferred(?:Scenario|Alternative)\b|\bchosenScenario\b/i] },
  { rule: 'no-health-score', why: 'a single health, priority or attention score', patterns: [/\bhealthScore\w*|\bcompanyHealth\w*|\benterpriseHealth\w*|\boverallHealth\w*/i, /\battentionScore\w*|\bpriorityScore\w*|\burgencyScore\w*/i, /\bprioriti[sz]e\w*\s*\(/i] },
  { rule: 'no-person-score', why: 'a score, rating or rank of a person or of decision quality', patterns: [/\bdecisionQuality\w*|\bdecisionScore\w*|\boutcomeScore\w*|\bprocessScore\w*/i, /\bmanager(?:Score|Rating|Rank)\w*|\bpersonScore\w*|\bperformanceRating\w*|\bleaderboard\w*/i] },
  { rule: 'no-vote', why: 'a vote, consensus or averaged agreement between perspectives', patterns: [/\bconsensus\w*/i, /\bmajority\w*/i, /\btally\w*/i, /\bvot(?:e|es|ed|ing)\b/i, /\bagreementScore\w*|\bconfidenceScore\w*|\bevidenceScore\w*/i] },
  { rule: 'no-regret', why: 'regret, a verdict on a past decision by its outcome', patterns: [/\bregret\w*/i, /\bshouldHave\w*/i, /\bwrongDecision\b|\bgoodDecision\b|\bbadDecision\b/i] },
  { rule: 'no-prediction', why: 'an outcome prediction or probability', patterns: [/\bpredictOutcome\w*|\boutcomePrediction\w*|\bsuccessProbability\w*/i, /\bpathProbability\b/i, /\bforecast\w*\s*\(/i] },
  { rule: 'no-pattern-learning', why: 'pattern learning or mining', patterns: [/\blearnPattern\w*|\bpatternLearning\b|\bpatternMining\b|\bminePatterns?\b/i, /\bdiscoverPatterns?\b|\binferPatterns?\b|\bautoPattern\w*|\bsuggestPattern\w*/i, /\bclustering\b|\bkmeans\b|\bembedding\w*|\bcosineSimilarity\b|\bsimilarityScore\w*/i, /\bbestPractice\w*|\bgoldenPattern\w*/i, /\bapplyLesson\w*|\bapplyPattern\w*|\benforceLesson\w*|\bautoUpdatePolicy\w*|\bpromoteLesson\w*/i] },
  { rule: 'no-causal-inference', why: 'automatic causal discovery or inference', patterns: [/\bdoCalculus\b/i, /\bcausalDiscovery\b|\bdiscover\w*Caus\w*/i, /\bcausalInference\b|\binfer\w*Caus\w*/i, /\bbayesianNetwork\w*|\bstructuralEquation\w*|\buplift\w*|\bpropensityScore\w*|\bbackdoorAdjust\w*|\binterventionEffect\b/i, /\bcausalScore\w*|\bcontributionP(?:ct|ercent)\w*/i] },
  { rule: 'no-optimizer', why: 'an optimizer', patterns: [/\boptimi[sz]e\w*\s*\(/, /\bsolve\s*\(/, /\bsolver\b/i, /\b(?:maximi|minimi)[sz]e\s*\(/, /\blinearProgram\w*|\bsimplex\b/] },
  { rule: 'no-automated-act', why: 'an automated management act', patterns: [/\bautoApprove\w*|\bautoCommit\w*|\bautoAuthori[sz]e\w*|\bautoExecute\w*|\bautoEscalate\w*|\bautoClose\w*|\bautoResolve\w*/i] },
  { rule: 'no-governance-simulation', why: 'governance scenario modelling', patterns: [/\bsimulatePolicy\w*|\bwhatIfPolicy\w*|\bpolicySimulation\w*|\bsimulateAuthority\w*/i] },
  { rule: 'no-notification-platform', why: 'a notification or delivery platform', patterns: [/\bsendEmail\w*|\bnotificationCenter\b|\bpushNotification\w*|\bsmtp\w*/i, /\bslack\w*\s*\(/i] },
  { rule: 'no-agent-debate', why: 'agents that debate, negotiate or deliberate towards a conclusion', patterns: [/\bagentDebate\b|\bdebate\w*\s*\(|\bnegotiat\w*\s*\(|\bdeliberat\w*\s*\(/i, /\bswarm\w*|\bautonomousAgent\w*/i] },
];
/** The guard that REMOVES a recommendation has to name one; that file (and its export) is the one place the word lives. */
const GUARD_FILES = { 'no-recommendation': ['packages/intelligence-runtime/src/grounding.ts', 'packages/intelligence-runtime/src/index.ts'] };
check('ai-governance', /RECOMMENDATION\.test\(/.test(scanned.get('packages/intelligence-runtime/src/grounding.ts') ?? ''), 'the grounding guard does not test for recommendations');
for (const [file, code] of scanned) {
  for (const { rule, why, patterns } of ABSENT) {
    if (GUARD_FILES[rule]?.includes(file)) continue;
    for (const re of patterns) check(rule, !re.test(code), `${file} contains ${why} (${re}) — never in HELM`);
  }
}
// No real model or network call from a kernel package: providers are ports; an adapter is composed by the app.
for (const [file, src] of raw) {
  if (!inPackages(file)) continue;
  check('no-model-call', !/api\.(?:openai|anthropic)\.com|generativelanguage\.googleapis|\bfrom\s+'(?:openai|@anthropic-ai\/[a-z-]+|@google\/generative-ai)'/.test(src), `${file} calls a model provider directly — a provider is a port, composed at the edge`);
}

// -------------------------------------------------------------------- 4. writes below

const KERNEL_WRITES = 'recordObservation|createEntity|updateEntity|upsertEntity|createRelationship|removeRelationship|execute|executeBaseline|addOverride|createScenario|createRevision|rebase|register\\w*|createValueNode|upsertValueNode|createValueLink|appendStep|commit|createCommitment|recordApproval|recordRejection|evaluate|recordOutcomeReview|appendEvent|setDecisionState|setActionIntentStatus|saveSnapshot|buildSnapshot|grantClearance|createClaim|reviseClaim|retireClaim|recordEvidence|supportClaim|contradictClaim|declareGovernanceProfile|recordPolicy|recordOccupancy|endOccupancy|createDelegation|openEpisode|proposePattern|recordLesson|reviewLesson|openCase|estimate|setDecisionState|addAlternative|updateDecisionFraming|sealRevision|resolveChallenge|recordAssessment|setAlternativeBinding|createSnapshot';
const BELOW = {
  'authority-runtime': { calls: /\b(?:decisions|decisionStore)\.(createCommitment|createSnapshot|setDecisionState|sealRevision|updateDecisionFraming|addAlternative|setAlternativeBinding|recordAssessment|resolveChallenge|commit)\s*\(|\b(?:scenarios|engine)\.(execute|addOverride|createScenario|rebase|createRevision)\s*\(/, why: 'the authority runtime judges commitments and reads consequences; it changes neither' },
  // A snapshot is the twin's OWN append-only derived record; building one is the twin composing, not writing below it.
  'twin-runtime': { calls: new RegExp(`\\.(${KERNEL_WRITES.replace('|saveSnapshot|buildSnapshot|grantClearance', '')})\\s*\\(`), why: 'the twin reads the kernel, it does not change it' },
  'causal-runtime': { calls: new RegExp(`\\.(${KERNEL_WRITES.replace('|createClaim|reviseClaim|retireClaim|recordEvidence|supportClaim|contradictClaim', '')})\\s*\\(`), why: 'a causal claim never changes the model or any layer below it' },
  'counterfactual-runtime': { calls: new RegExp(`\\.(${KERNEL_WRITES.replace('|openCase|estimate', '').replace('|execute|executeBaseline|addOverride|createScenario|createRevision|rebase', '')})\\s*\\(`), why: 'a counterfactual world reads the record as it stood; it changes none of it' },
  'genome-runtime': { calls: new RegExp(`\\.(${KERNEL_WRITES.replace('|openEpisode|proposePattern|recordLesson|reviewLesson', '')})\\s*\\(`), why: 'the genome remembers the kernel, it does not change it' },
  // A review asks the twin to compose its opening snapshot (the twin's own derived record); it writes nothing else below.
  'review-runtime': { calls: new RegExp(`\\.(${KERNEL_WRITES.replace('|saveSnapshot|buildSnapshot', '')}|openEpisode|proposePattern|recordLesson|reviewLesson)\\s*\\(`), why: 'a review binds by reference; it writes nothing below itself' },
  'intelligence-runtime': { calls: new RegExp(`\\.(${KERNEL_WRITES}|openEpisode|proposePattern|recordLesson|reviewLesson|openReview|addItem|closeReview)\\s*\\(`), why: 'AI interpretation is not enterprise truth: the AI layer calls no write on any kernel layer' },
  'agent-runtime': { calls: new RegExp(`\\.(${KERNEL_WRITES}|openEpisode|proposePattern|recordLesson|reviewLesson|openReview|addItem|closeReview|recordRun|appendRun)\\s*\\(`), why: 'an agent perspective is not decision authority: the council calls no write at all' },
  'integration-runtime': { calls: /\.(createCommitment|commit|recordApproval|recordRejection|evaluate|recordOutcomeReview|setDecisionState|setActionIntentStatus|appendEvent|createSnapshot|sealRevision|createClaim|openEpisode|openReview|closeReview|grantClearance|recordPolicy|createDelegation)\s*\(/, why: 'the integration fabric brings source truth in; it never decides, approves or rewrites management' },
};
for (const [file, code] of scanned) {
  const pkg = pkgOfFile(file);
  const rule = pkg && BELOW[pkg];
  if (!rule || isSeed(file)) continue;
  const m = rule.calls.exec(code);
  check('writes-below', !m, `${file} calls ${m?.[1] ?? m?.[2] ?? m?.[0]} — ${rule.why}`);
}
// The app surfaces of the AI layer and the council read; they never write enterprise truth either.
for (const [file, code] of scanned) {
  if (!/^src\/components\/intelligence\//.test(file)) continue;
  const m = new RegExp(`\\.(${KERNEL_WRITES})\\s*\\(`).exec(code);
  check('writes-below', !m, `${file} calls ${m?.[1]} — an AI panel reads and asks; it writes no enterprise truth`);
}
// The tool catalogue is READ_ONLY: every tool declares it, and none names a write.
{
  const tools = raw.get('packages/intelligence-runtime/src/tools.ts') ?? '';
  check('ai-governance', /READ_ONLY/.test(tools), 'the AI tool catalogue does not declare its tools READ_ONLY');
  check('ai-governance', !/\bmutates\s*:\s*true|\bwrite\s*:\s*true|\bside_?effects?\s*:\s*true/i.test(tools), 'an AI tool declares a side effect');
}

// ------------------------------------------------------------ 5. eval, database code, additive

const NO_EVAL = [
  { re: /\beval\s*\(/, why: 'eval()' },
  { re: /new\s+Function\s*\(/, why: 'new Function()' },
  { re: /\bvm\.runIn/, why: "node's vm module" },
];
for (const [file, code] of scanned) {
  for (const { re, why } of NO_EVAL) check('no-eval', !re.test(code), `${file} uses ${why}. A formula HELM cannot read is a formula HELM cannot explain (§13)`);
}

const migrationsDir = join(root, 'supabase', 'migrations');
const migrations = existsSync(migrationsDir) ? readdirSync(migrationsDir).filter((f) => f.startsWith('2026092') || f.startsWith('20260930')).sort() : [];
check('migrations', migrations.length >= 12, `only ${migrations.length} kernel migrations were found`);
for (const name of migrations) {
  const sql = readFileSync(join(migrationsDir, name), 'utf8').replace(/--[^\n]*/g, ' ');
  for (const re of [/\bformula_js\b/i, /\bexpression_js\b/i, /\bcode\s+text\b/i, /\bjavascript\b/i, /\bscript\b/i]) {
    check('no-code-in-db', !re.test(sql), `${name} defines something matching ${re}. HELM stores metadata; implementations are typed functions in code (ADR-0017 §1)`);
  }
  const bodies = [...sql.matchAll(/AS\s+\$fn\$([\s\S]*?)\$fn\$/g)].map((m) => m[1]);
  for (const body of bodies) {
    // Stamping the record time of a change is not a formula: it says WHEN HELM learned something.
    check('no-formula-in-trigger', !/\bNEW\.[a-z_]+\s*:=(?!\s*now\(\);)/i.test(body), `${name}: a trigger assigns to a NEW column — business formulas in triggers are invisible to tests (§28)`);
    check('no-formula-in-trigger', !/\b(SUM|AVG|MIN|MAX)\s*\(/i.test(body), `${name}: a trigger aggregates values — aggregation is a calculation, and calculations live in the engine (§28)`);
  }
  for (const m of sql.matchAll(/(?:CREATE|ALTER|DROP)\s+TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?\s+public\.([a-z_]+)/gi)) {
    check('additive-only', m[1].toLowerCase().startsWith('helm_'), `${name} touches "${m[1]}", which is not a HELM-owned table`);
  }
  for (const m of sql.matchAll(/\b(DROP\s+TABLE|DROP\s+COLUMN)\b|(?:^|;)\s*(TRUNCATE)\b/gi)) fail('additive-only', `${name} contains ${m[1] ?? m[2]}`);
}
{
  const sql5 = readFileSync(join(migrationsDir, '20260923100000_helm_decision_runtime.sql'), 'utf8');
  check('no-authority', /authority_status\s*=\s*'NOT_EVALUATED'/.test(sql5), 'the decision schema does not pin authority_status to NOT_EVALUATED');
  for (const word of ['AUTHORIZED', 'REQUIRES_APPROVAL', 'ESCALATED']) {
    check('no-authority', !new RegExp(`'${word}'`).test(sql5), `the decision schema can store the authority verdict ${word}, which only the authority runtime produces`);
  }
}

// -------------------------------------------------------------- 6. required artifacts

const REQUIRED = {
  'propagation-engine': ['engine.ts', 'registry.ts', 'dependencyGraph.ts', 'conformance.ts', 'postgres.ts', 'meridianValueModelV1.ts'],
  'scenario-runtime': ['runtime.ts', 'comparison.ts', 'constraints.ts', 'overlay.ts', 'fingerprint.ts', 'postgres.ts', 'conformance.ts'],
  'decision-runtime': ['runtime.ts', 'criteria.ts', 'tradeoff.ts', 'readiness.ts', 'fingerprint.ts', 'postgres.ts', 'conformance.ts', 'meridianDecision.ts'],
  'authority-runtime': ['engine.ts', 'scope.ts', 'conditions.ts', 'delegation.ts', 'policy.ts', 'state.ts', 'visibility.ts', 'fingerprint.ts', 'runtime.ts', 'postgres.ts', 'conformance.ts', 'meridianGovernance.ts', 'trusted.ts'],
  'twin-runtime': ['compose.ts', 'structure.ts', 'values.ts', 'management.ts', 'attention.ts', 'delta.ts', 'explain.ts', 'trajectory.ts', 'fingerprint.ts', 'sensitivity.ts', 'runtime.ts', 'postgres.ts', 'conformance.ts', 'managementApi.ts', 'meridianTwin.ts'],
  'causal-runtime': ['types.ts', 'policy.ts', 'scope.ts', 'runtime.ts', 'integration.ts', 'postgres.ts', 'conformance.ts', 'meridianCausal.ts'],
  'counterfactual-runtime': ['types.ts', 'policy.ts', 'port.ts', 'runtime.ts', 'inMemoryStore.ts', 'postgres.ts', 'conformance.ts', 'meridianCounterfactual.ts'],
  'genome-runtime': ['types.ts', 'policy.ts', 'situation.ts', 'runtime.ts', 'inMemoryStore.ts', 'postgres.ts', 'conformance.ts', 'meridianGenome.ts'],
  'integration-runtime': ['types.ts', 'port.ts', 'drift.ts', 'identity.ts', 'pipeline.ts', 'memoire.ts', 'truth.ts', 'writeback.ts', 'inMemoryStore.ts', 'postgres.ts', 'conformance.ts'],
  'review-runtime': ['types.ts', 'port.ts', 'pack.ts', 'runtime.ts', 'inMemoryStore.ts', 'postgres.ts', 'conformance.ts', 'meridianReviews.ts'],
  'intelligence-runtime': ['types.ts', 'refs.ts', 'grounding.ts', 'provider.ts', 'tools.ts', 'templates.ts', 'gather.ts', 'runtime.ts', 'port.ts', 'inMemoryStore.ts', 'postgres.ts', 'conformance.ts'],
  'agent-runtime': ['types.ts', 'perspectives.ts', 'provider.ts', 'council.ts'],
};
for (const [pkg, files] of Object.entries(REQUIRED)) {
  for (const f of files) check('artifacts', existsSync(join(root, 'packages', pkg, 'src', f)), `packages/${pkg}/src/${f} is missing`);
}
check('artifacts', existsSync(join(root, 'supabase', 'functions', 'helm-authority', 'index.ts')), 'the helm-authority edge function is missing');
check('artifacts', /verifyCalculationTrace\s*\(/.test(scanned.get('packages/authority-runtime/src/trusted.ts') ?? ''), 'the trusted authority service does not re-derive the chosen run before believing it');
check('artifacts', /GENOME_PATTERN_POLICY\s*=\s*'helm-genome-pattern@1'/.test(raw.get('packages/genome-runtime/src/policy.ts') ?? ''), 'the pattern policy is not versioned');
check('artifacts', /EVIDENCE_CEILING/.test(scanned.get('packages/causal-runtime/src/policy.ts') ?? ''), 'the causal evidence policy has no evidence hierarchy');
check('artifacts', /recordObservation/.test(scanned.get('packages/propagation-engine/src/engine.ts') ?? '') && /appendStep/.test(scanned.get('packages/propagation-engine/src/engine.ts') ?? ''), 'the engine does not record observations and trace steps, so nothing propagates or is auditable');
check('artifacts', /scenarios\.getFutureState\s*\(/.test(scanned.get('packages/decision-runtime/src/runtime.ts') ?? ''), 'the decision runtime does not read its numbers from scenario future states');
check('artifacts', /scenarios\.getFutureState\s*\(/.test(scanned.get('packages/authority-runtime/src/runtime.ts') ?? ''), 'the authority runtime does not read consequences from the chosen future state');
check('artifacts', /MEMOIRE_CONNECTOR/.test(raw.get('packages/integration-runtime/src/memoire.ts') ?? ''), 'the Memoire connector is not versioned');
check('artifacts', /DRY_RUN/.test(raw.get('packages/integration-runtime/src/writeback.ts') ?? ''), 'the writeback gateway has no DRY_RUN mode');
for (const app of ['CockpitPage', 'ReviewsPage', 'CounterfactualsPage', 'SourcesPage', 'TwinPage', 'CausalPage', 'GenomePage', 'DecisionsPage', 'ScenariosPage', 'GovernancePage']) {
  check('artifacts', existsSync(join(root, 'src', 'pages', `${app}.tsx`)), `the ${app} surface is missing`);
}
// Retired: the pre-kernel management apps must not come back as a second meaning for the same things.
for (const dead of ['src/domain/engines', 'src/pages/AttentionPage.tsx', 'src/pages/EconomicsPage.tsx', 'src/pages/OperationsPage.tsx', 'src/components/attention', 'test/unit']) {
  check('no-legacy', !existsSync(join(root, dead)), `${dead} is a retired pre-kernel surface and must stay deleted`);
}

// ------------------------------------------------------------------ report

if (failures.length === 0) {
  console.log(
    `verify:boundaries — ok (${scanned.size} files across ${STACK.length} layers: dependencies point down; each concept confined to its home; ` +
      'no recommendation, health score, person score, vote, regret, prediction, pattern learning, optimizer or automated act anywhere; ' +
      'the AI layer and the council write nothing; the fabric only ingests; migrations additive; every layer present)',
  );
  process.exit(0);
}
console.error(`verify:boundaries — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
