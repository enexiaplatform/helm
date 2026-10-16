/**
 * The app's access to the Integration Fabric.
 *
 * Wires ports together and holds no domain logic: every adapter, identity, sync,
 * drift report, source-versus-model reading and dry-run writeback comes from
 * @helm/integration-runtime.
 *
 * Demo mode connects a FIXTURE Memoire (createFixtureMemoireReader) to the demo
 * enterprise and lives the canonical proof through it once per session: a new
 * opportunity enters the ontology and the value graph without being typed in; the
 * same sync run twice changes nothing; Memoire moves a probability and the source
 * value changes beside the model's estimate, neither overwriting the other; an
 * additive schema change is reported and a breaking one blocks; and the approved
 * Rohto commitment's Memoire intent is written back as a DRY RUN, twice, once.
 *
 * Cloud mode reads the signed-in user's own Memoire opportunities (src/services/
 * memoireBridge.ts) and writes source observations through the kernel's own
 * stores. It writes NOTHING into Memoire, and a live writeback does not exist in v1.
 */

import {
  createFixtureMemoireReader,
  createIngestionPipeline,
  createInMemoryIntegrationStore,
  createMemoireAdapter,
  createMemoireOrderCostAdapter,
  createFixtureOrderCostReader,
  createMemoireWritebackAdapter,
  createWritebackGateway,
  sourceAndModel,
  type IngestionPipeline,
  type IntegrationStore,
  type MemoireOpportunityRow,
  type SourceAdapter,
  type SourceAndModel,
  type SyncRecord,
  type WritebackGateway,
  type WritebackRequest,
} from '@helm/integration-runtime';
import { createPostgresIntegrationStore } from '@helm/integration-runtime/postgres';
import { MERIDIAN_DEMO_USERS, scopeAs } from '@helm/authority-runtime';
import { asValidTime, seqIdGen, type Result, type Scope } from '@helm/shared';
import { supabaseClient } from '../lib/supabaseClient.ts';
import { getCloudGraphs } from './ontologyGraph.ts';
import { createMemoireOpportunityReader, createMemoireOrderCostReader } from './memoireBridge.ts';
import { resolveReviewContext } from './reviewRuntime.ts';
import { resolveTwinContext, type TwinContext } from './twinRuntime.ts';

export type IntegrationContext = {
  readonly scope: Scope;
  readonly mode: 'demo' | 'cloud';
  readonly twin: TwinContext;
  readonly store: IntegrationStore;
  readonly pipeline: IngestionPipeline;
  readonly gateway: WritebackGateway;
  readonly adapter: SourceAdapter;
  /** Step 3: Memoire's order costs, read after the opportunities they name (a cost needs its opportunity first). */
  readonly costAdapter: SourceAdapter;
  /** Demo: what the canonical proof did. Null in the cloud. */
  readonly proof: IntegrationProof | null;
  /** Demo: change what the fixture Memoire says, and sync. */
  readonly memoire: { readonly rows: MemoireOpportunityRow[] } | null;
};

export type IntegrationProof = {
  readonly firstSync: SyncRecord;
  readonly repeatSync: SyncRecord;
  readonly changedSync: SyncRecord;
  readonly driftBlocked: SyncRecord;
  readonly writebacks: readonly (WritebackRequest & { readonly replayed: boolean })[];
  readonly replayed: readonly (WritebackRequest & { readonly replayed: boolean })[];
  readonly sourceVsModel: SourceAndModel | null;
  readonly sourceVsModelLabel: string;
};

let demoIntegration: Promise<IntegrationContext> | null = null;

const must = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }, what: string): T => {
  if (!r.ok) throw new Error(`${what}: ${r.error.message}`);
  return r.value;
};

const row = (over: Partial<MemoireOpportunityRow> & { id: string }): MemoireOpportunityRow => ({
  account_id: null,
  account_name: null,
  opportunity_name: null,
  title: null,
  stage: 'Proposal',
  estimated_value: null,
  currency: 'VND',
  pipeline_probability: null,
  status: 'open',
  expected_close_period: '2026-Q4',
  updated_at: '2026-10-01T02:00:00.000Z',
  account_ka_flag: null,
  brand: null,
  channel: null,
  last_touch_at: null,
  next_action_date: null,
  closed_on: null,
  ...over,
});

function getDemoIntegration(scope: Scope): Promise<IntegrationContext> {
  if (demoIntegration) return demoIntegration;
  demoIntegration = (async () => {
    // The integration proof happens AFTER the rest of the demo enterprise: Memoire cannot have said in April what HELM recorded in January.
    await resolveReviewContext('demo', scope);
    const twin = await resolveTwinContext('demo', scope);
    if (!twin || !twin.story || !twin.kernel.valueGraph) throw new Error('The demo enterprise is unavailable.');
    const k = twin.kernel;
    const gm = scopeAs(scope, MERIDIAN_DEMO_USERS.countryGM);
    const store = createInMemoryIntegrationStore({ clock: k.clock, idGen: seqIdGen('ig') });
    const rows: MemoireOpportunityRow[] = [
      // The Rohto Q4 tender the value chain already holds: Memoire says what the model was seeded with — nothing new.
      row({ id: 'opp-8821', account_id: 'acc-rohto', account_name: 'Rohto Vietnam', opportunity_name: 'Rohto Q4 tender', estimated_value: 4200000000, pipeline_probability: 70, updated_at: '2026-09-18T11:02:00.000Z' }),
      // A NEW opportunity: it enters HELM from Memoire alone. Nobody types it in.
      row({ id: 'opp-9001', account_id: 'acc-9001', account_name: 'Hanoi General Hospital', opportunity_name: 'Hanoi hospital tender', estimated_value: 2500000000, pipeline_probability: 60, updated_at: '2027-04-20T02:00:00.000Z' }),
    ];
    const reader = createFixtureMemoireReader(rows);
    // The fixture reader holds its own rows: what Memoire "says" changes only by changing THESE.
    const said = reader.rows;
    const adapter = createMemoireAdapter(reader);
    // The Hanoi tender, once ordered: Memoire records what it cost to land it. Nobody types it into HELM.
    const costAdapter = createMemoireOrderCostAdapter(
      createFixtureOrderCostReader([
        { id: 'cost-9001', opportunity_id: 'opp-9001', amount: 1650000000, currency: 'VND', duty_amount: 82500000, freight_amount: 41000000, other_amount: null, extras_currency: null, is_sample: false, created_at: '2027-04-21T02:00:00.000Z', updated_at: '2027-04-21T02:00:00.000Z' },
      ]),
    );
    const pipeline = createIngestionPipeline({ graph: k.graph, valueGraph: k.valueGraph!, store, clock: k.clock });
    const gateway = createWritebackGateway({ decisions: k.decisionStore, authority: k.authority, store, adapters: [createMemoireWritebackAdapter()] });

    k.clock.jumpTo?.('2027-04-20T03:00:00.000Z');
    const firstSync = must(await pipeline.run(gm, adapter), 'first sync');
    const repeatSync = must(await pipeline.run(gm, adapter), 'repeat sync');
    // The model estimates the Hanoi tender's probability itself; Memoire then moves its own. Neither overwrites the other.
    const hanoi = must(await k.graph.getEntityByCanonicalKey(gm, 'Opportunity', 'memoire:opportunity:opp-9001'), 'the Hanoi opportunity');
    const node = hanoi ? must(await k.valueGraph!.findNodesForEntity(gm, hanoi.id), 'value nodes').find((n) => n.metricKey === 'OpportunityProbability') : undefined;
    if (node) must(await k.valueGraph!.recordObservation(gm, { nodeId: node.id, observationType: 'ESTIMATE', numericValue: 0.35, unitType: 'ratio', effectiveAt: asValidTime('2027-04-20T03:00:00.000Z'), observedAt: asValidTime('2027-04-20T03:00:00.000Z'), sourceSystem: 'helm', confidence: 0.5 }), 'model estimate');
    k.clock.jumpTo?.('2027-04-22T03:00:00.000Z');
    said[1] = { ...said[1]!, pipeline_probability: 40, updated_at: '2027-04-22T02:00:00.000Z' };
    const changedSync = must(await pipeline.run(gm, adapter), 'changed sync');
    must(await pipeline.run(gm, costAdapter), 'order costs');
    const sv = node ? must(await sourceAndModel(k.valueGraph!, gm, node.id), 'source and model') : null;
    k.clock.jumpTo?.('2027-04-23T03:00:00.000Z');
    // A source that changed its schema is stopped, not guessed at.
    said.push({ ...row({ id: 'opp-9002', account_id: 'acc-9001', opportunity_name: 'Hanoi hospital consumables', updated_at: '2027-04-23T02:00:00.000Z' }), stage: null });
    const driftBlocked = must(await pipeline.run(gm, adapter), 'drifted sync');
    said.pop();
    k.clock.jumpTo?.('2027-04-24T03:00:00.000Z');
    // HELM commitment → action intent → Memoire, as a DRY RUN — twice; the second is the first.
    const dispatched = must(await gateway.dispatch(gm, { commitmentId: twin.story.commitmentId }), 'dispatch');
    const again = must(await gateway.dispatch(gm, { commitmentId: twin.story.commitmentId }), 'dispatch again');
    return {
      scope,
      mode: 'demo' as const,
      twin,
      store,
      pipeline,
      gateway,
      adapter,
      costAdapter,
      memoire: { rows: said },
      proof: { firstSync, repeatSync, changedSync, driftBlocked, writebacks: dispatched.requests, replayed: again.requests, sourceVsModel: sv, sourceVsModelLabel: 'Opportunity Probability — Hanoi hospital tender' },
    };
  })();
  return demoIntegration;
}

async function getCloudIntegration(scope: Scope): Promise<IntegrationContext | null> {
  const twin = await resolveTwinContext('cloud', scope);
  const graphs = getCloudGraphs();
  if (!twin || !graphs || !supabaseClient) return null;
  const store = createPostgresIntegrationStore({ client: supabaseClient });
  const adapter = createMemoireAdapter(createMemoireOpportunityReader());
  const costAdapter = createMemoireOrderCostAdapter(createMemoireOrderCostReader());
  return {
    scope,
    mode: 'cloud',
    twin,
    store,
    pipeline: createIngestionPipeline({ graph: graphs.graphStore, valueGraph: graphs.valueGraph, store, clock: twin.kernel.clock }),
    gateway: createWritebackGateway({ decisions: twin.kernel.decisionStore, authority: twin.kernel.authority, store, adapters: [createMemoireWritebackAdapter()] }),
    adapter,
    costAdapter,
    proof: null,
    memoire: null,
  };
}

export async function resolveIntegrationContext(mode: 'demo' | 'cloud', scope: Scope): Promise<IntegrationContext | null> {
  return mode === 'demo' ? getDemoIntegration(scope) : getCloudIntegration(scope);
}

export async function syncNow(ctx: IntegrationContext): Promise<SyncRecord> {
  const opportunities = must(await ctx.pipeline.run(ctx.scope, ctx.adapter), 'sync');
  must(await ctx.pipeline.run(ctx.scope, ctx.costAdapter), 'order costs');
  return opportunities;
}

/**
 * One page of the live read: opportunities first; once they have nothing new, the order costs that name them. A cost
 * read before its opportunity would be quarantined, so the costs wait for the opportunities to catch up.
 */
export async function syncNextPage(ctx: IntegrationContext, limit: number): Promise<Result<SyncRecord>> {
  const opportunities = await ctx.pipeline.run(ctx.scope, ctx.adapter, { limit });
  if (!opportunities.ok || opportunities.value.counts.records > 0) return opportunities;
  return ctx.pipeline.run(ctx.scope, ctx.costAdapter, { limit });
}

/** Whether the source holds anything after the checkpoint — one row read through the adapter, nothing recorded. */
export async function sourceHasNews(ctx: IntegrationContext): Promise<boolean> {
  for (const adapter of [ctx.adapter, ctx.costAdapter]) {
    const cp = must(await ctx.store.checkpointOf(ctx.scope, adapter.system, adapter.connector), 'checkpoint');
    if (must(await adapter.pull(ctx.scope, cp.cursor, 1), 'source probe').records.length > 0) return true;
  }
  return false;
}

export async function syncHistory(ctx: IntegrationContext): Promise<readonly SyncRecord[]> {
  return must(await ctx.store.listSyncs(ctx.scope, { system: 'memoire' }), 'sync history');
}

export async function writebackHistory(ctx: IntegrationContext): Promise<readonly WritebackRequest[]> {
  return must(await ctx.gateway.list(ctx.scope), 'writebacks');
}
