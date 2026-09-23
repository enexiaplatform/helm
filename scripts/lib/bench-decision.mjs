/**
 * Phase 5 performance, measured in memory over the canonical Meridian stack.
 * Run with: node scripts/lib/bench-decision.mjs
 *
 * It measures the decision layer's own work over the canonical stack, in
 * memory. Postgres numbers are NOT produced here and are not guessed: the
 * shared-database conformance run still needs test-branch credentials.
 */

import { buildDecisionStack, unwrap } from './decisionStack.mjs';
import { buildMeridianDecision } from '@helm/decision-runtime';

const ms = (t) => `${(Number(t) / 1e6).toFixed(2)} ms`;
const time = async (label, fn, n = 1) => {
  const t0 = process.hrtime.bigint();
  let last;
  for (let i = 0; i < n; i += 1) last = await fn(i);
  const t1 = process.hrtime.bigint();
  const total = t1 - t0;
  console.log(`${label.padEnd(52)} ${ms(total).padStart(10)}${n > 1 ? `  (${ms(total / BigInt(n))} each)` : ''}`);
  return last;
};

const stackStart = process.hrtime.bigint();
const stack = await buildDecisionStack();
console.log(`${'stack build (graph + values + 7 scenarios simulated)'.padEnd(52)} ${ms(process.hrtime.bigint() - stackStart).padStart(10)}`);

const { scope, decisions } = stack;

const built = await time('canonical decision: build, prepare and commit', async () =>
  unwrap(await buildMeridianDecision(decisions, scope, stack.scenarioIds), 'canonical decision'),
);

await time('createDecision', async (i) => {
  unwrap(
    await decisions.createDecision(scope, {
      title: `Bench ${i}`,
      managementQuestion: `How should we handle bench case ${i}?`,
      context: 'bench',
      problem: 'bench',
      triggerType: 'ISSUE',
      triggerRefs: [],
    }),
    'createDecision',
  );
}, 50);

const revisionId = built.revisionId;

await time('getWorkspace (6 criteria x 5 alternatives, readiness)', async () => {
  unwrap(await decisions.getWorkspace(scope, built.decision.id, revisionId), 'workspace');
}, 20);

await time('evaluateReadiness alone', async () => {
  unwrap(await decisions.evaluateReadiness(scope, revisionId), 'readiness');
}, 20);

await time('tradeOffSpace (5 alternatives, dominance)', async () => {
  unwrap(await decisions.tradeOffSpace(scope, revisionId, built.alternatives['expedite'].id), 'trade-offs');
}, 20);

await time('getCommitmentSnapshot (frozen manifest read)', async () => {
  unwrap(await decisions.getCommitmentSnapshot(scope, built.commitment.id), 'snapshot');
}, 20);

await time('explainDecision (full lineage to source facts)', async () => {
  unwrap(await decisions.explainDecision(scope, built.decision.id), 'explain');
}, 10);

// A decision bound to one more alternative: the marginal cost of a future.
const explained = unwrap(await decisions.explainDecision(scope, built.decision.id), 'explain');
console.log(
  `\nshape: ${explained.criterionEvaluations.length} criterion evaluations, ` +
    `${explained.valueLineage.length} expected outcomes traced, ` +
    `${explained.rationale.length} rationale items, ${explained.assumptions.length} assumptions, ` +
    `${explained.challenges.length} challenges, ${explained.evidence.length} pieces of evidence.`,
);
