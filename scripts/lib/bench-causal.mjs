/**
 * Phase 8 performance, measured in memory over the canonical causal story.
 * Run with: node scripts/lib/bench-causal.mjs
 *
 * It measures the causal graph's own work: claim retrieval, evidence
 * evaluation, bounded traversal, claim explanation and the twin difference →
 * causal hypotheses lookup. Postgres numbers are NOT produced here and are not
 * guessed.
 */

import { evaluateAt, explainTwinDifferenceCausally } from '../../packages/causal-runtime/src/index.ts';
import { buildCausalStory, unwrap, valueKey } from './causalStack.mjs';

const ms = (t) => `${(Number(t) / 1e6).toFixed(2)} ms`;
const time = async (label, fn, n = 1) => {
  const t0 = process.hrtime.bigint();
  let last;
  for (let i = 0; i < n; i += 1) last = await fn(i);
  const total = process.hrtime.bigint() - t0;
  console.log(`${label.padEnd(62)} ${ms(total).padStart(10)}${n > 1 ? `  (${ms(total / BigInt(n))} each)` : ''}`);
  return last;
};

const start = process.hrtime.bigint();
const s = await buildCausalStory();
console.log(`${'stack + twin story + causal story (14 claims, 14 evidence)'.padEnd(62)} ${ms(process.hrtime.bigint() - start).padStart(10)}`);
const { causal, scope, causalStory } = s;
const H1 = causalStory.claims.H1.claim.id;

await time('claim retrieval — getClaim(H1), evaluated at now', async () => unwrap(await causal.getClaim(scope, H1), 'get'), 200);
await time('claim listing — all claims, each evaluated', async () => unwrap(await causal.listClaims(scope), 'list'), 100);
await time('historical view — viewAt(19 Jan), reconstructed', async () => unwrap(await causal.viewAt(scope, { effectiveAsOf: '2027-01-19T00:00:00.000Z', recordedThrough: '2027-01-19T00:00:00.000Z' }), 'view'), 100);

const records = {
  variables: unwrap(await s.causalStore.listVariables(scope), 'v'),
  claims: unwrap(await s.causalStore.listClaims(scope), 'c'),
  revisions: unwrap(await s.causalStore.listRevisions(scope), 'r'),
  evidence: unwrap(await s.causalStore.listEvidence(scope), 'e'),
  links: unwrap(await s.causalStore.listLinks(scope), 'l'),
  correlations: [],
  questions: [],
  candidates: [],
};
const claim = records.claims.find((c) => c.id === H1);
const now = s.clock.now().toISOString();
await time('evidence evaluation alone — evaluateAt(H1), pure', async () => evaluateAt(claim, records, { effectiveAsOf: now, recordedThrough: now }), 2000);

await time('causal traversal — downstream from EXPEDITED_TRANSFER, depth 4', async () => unwrap(await causal.traverse(scope, { from: 'EXPEDITED_TRANSFER', direction: 'DOWNSTREAM', maxDepth: 4 }), 'traverse'), 100);
await time('causal traversal — the feedback loop, depth 8 (terminates)', async () => unwrap(await causal.traverse(scope, { from: 'SERVICE_FAILURE', direction: 'DOWNSTREAM', maxDepth: 8 }), 'loop'), 100);
await time('paths — EXPEDITED_TRANSFER → GROSS_MARGIN_PCT', async () => unwrap(await causal.paths(scope, { from: 'EXPEDITED_TRANSFER', to: 'GROSS_MARGIN_PCT', maxDepth: 4 }), 'paths'), 100);
await time('claim explanation — explainClaim(H1) with history', async () => unwrap(await causal.explainClaim(scope, H1), 'explain'), 100);
await time('question investigation — the fulfilment-cost question', async () => unwrap(await causal.investigate(scope, causalStory.questions.fulfilment.id), 'investigate'), 50);

const cfKey = s.story.CF1.items.find((i) => i.kind === 'VALUE' && i.state.nodeId === s.nodeIds.grossMarginPctOpp).key;
await time('twin difference → causal hypotheses (CF1 → S2 gross margin)', async () =>
  unwrap(await explainTwinDifferenceCausally({ twin: s.twin, causal }, scope, { fromId: s.story.CF1.snapshot.id, toId: s.story.S2.snapshot.id, itemKey: cfKey, toItemKey: valueKey(s.nodeIds.grossMarginPctOpp, 'ACTUAL') }), 'twin'),
  20,
);
