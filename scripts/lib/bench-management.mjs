/**
 * Performance of the layers above the kernel, measured in memory over the canonical story.
 * Run with: node scripts/lib/bench-management.mjs
 *
 * Measures the counterfactual comparison, ingestion (idempotent re-read and a changed row), a review's
 * preparation and reproduction, the per-viewer review projection, and one AI run and one council on the
 * deterministic reference providers (no model, no network — a language-model provider adds its own latency,
 * which is not measured or guessed here). Postgres numbers are NOT produced here.
 */

import { seqIdGen } from '@helm/shared';
import { createFixtureMemoireReader, createIngestionPipeline, createInMemoryIntegrationStore, createMemoireAdapter } from '../../packages/integration-runtime/src/index.ts';
import { ADMIN, DEMO_UNITS, USERS, adminCaller, buildCouncil, buildCouncilStory, row, unwrap } from './v1Stack.mjs';

const ms = (t) => `${(Number(t) / 1e6).toFixed(2)} ms`;
const time = async (label, fn, n = 1) => {
  const t0 = process.hrtime.bigint();
  let last;
  for (let i = 0; i < n; i += 1) last = await fn(i);
  const total = process.hrtime.bigint() - t0;
  console.log(`${label.padEnd(72)} ${ms(total).padStart(10)}${n > 1 ? `  (${ms(total / BigInt(n))} each)` : ''}`);
  return last;
};

const start = process.hrtime.bigint();
const s = await buildCouncilStory();
console.log(`${'whole story: kernels + counterfactual + 2 reviews + AI + council'.padEnd(72)} ${ms(process.hrtime.bigint() - start).padStart(10)}`);
const gm = s.gm;
const r2 = s.reviewStory.second.review.id;

await time('counterfactual — compare(CF1), four layers', async () => unwrap(await s.counterfactual.compare(s.scope, s.counterfactualStory.cases.CF1.case.id), 'compare'), 50);

const reader = createFixtureMemoireReader(Array.from({ length: 200 }, (_, i) => row({ id: `opp-${i}`, account_id: `acc-${i % 40}`, account_name: `Account ${i % 40}`, opportunity_name: `Opportunity ${i}`, updated_at: new Date(Date.UTC(2027, 5, 1, 0, 0, i)).toISOString() })));
const adapter = createMemoireAdapter(reader);
const pipeline = createIngestionPipeline({ graph: s.graph, valueGraph: s.valueGraph, store: createInMemoryIntegrationStore({ clock: s.clock, idGen: seqIdGen('b') }), clock: s.clock });
await time('ingestion — 200 opportunities, first run (entities, aliases, observations)', async () => unwrap(await pipeline.run(s.scope, adapter), 'first'), 1);
const fresh = createIngestionPipeline({ graph: s.graph, valueGraph: s.valueGraph, store: createInMemoryIntegrationStore({ clock: s.clock, idGen: seqIdGen('c') }), clock: s.clock });
await time('ingestion — the same 200 re-read from a blank checkpoint (idempotent, no writes)', async () => unwrap(await fresh.run(s.scope, adapter), 'again'), 1);

await time('review — prepare(Review 2): pack from the kernel at the review lens', async () => unwrap(await s.review.prepare(gm, r2), 'prepare'), 20);
await time('review — reproduce(Review 2, PREPARATION): recomputed and fingerprint-compared', async () => unwrap(await s.review.reproduce(gm, r2, 'PREPARATION'), 'reproduce'), 20);
const viewer = { userId: ADMIN, orgRole: 'admin', memberUnitIds: [], clearances: [] };
await time('review — projectForViewer (admin, both reviews)', async () => unwrap(await s.review.projectForViewer(s.scope, viewer, DEMO_UNITS, { decisionVisible: () => true }), 'project'), 20);
const uncleared = { userId: USERS.pharmaAnalyst, orgRole: 'member', memberUnitIds: [], clearances: [] };
await time('review — projectForViewer (uncleared: read whole or not at all)', async () => unwrap(await s.review.projectForViewer(s.scope, uncleared, DEMO_UNITS, { decisionVisible: () => true }), 'project'), 20);

const ask = (task, params) => s.intelligence.run(s.scope, adminCaller(), { task, params });
await time('AI — EXPLAIN_DECISION (governed tools, grounding, audit; reference provider)', async () => unwrap(await ask('EXPLAIN_DECISION', { decisionId: s.story.decisionId }), 'explain'), 20);
await time('AI — DRAFT_MANAGEMENT_BRIEF for Review 2', async () => unwrap(await ask('DRAFT_MANAGEMENT_BRIEF', { reviewId: r2 }), 'brief'), 10);
await time('AI — ASK_HELM (planned tool calls, at most eight)', async () => unwrap(await ask('ASK_HELM', { question: 'What matters right now, and what do we believe about why?' }), 'ask'), 10);
const council = buildCouncil(s);
await time('council — convene: evidence once, eight perspectives considered, tensions, audited', async () => unwrap(await council.convene(s.scope, adminCaller(), { question: 'What does each function think of the Rohto outcome?', decisionId: s.story.decisionId, reviewId: r2 }), 'council'), 5);
