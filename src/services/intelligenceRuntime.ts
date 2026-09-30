/**
 * The app's access to the governed AI layer and the management council.
 *
 * Wires ports together and holds no domain logic: every tool, grounding rule,
 * audit record and perspective comes from @helm/intelligence-runtime and
 * @helm/agent-runtime. The provider is the deterministic reference provider — no
 * model, no network, no credentials; a language-model adapter implementing the
 * same port replaces it without touching anything here.
 *
 * The AI reads as the person asking: every call passes the viewer, their units
 * and the decisions they may see, so it can never read past them.
 */

import {
  TEMPLATES,
  createGovernedTools,
  createInMemoryAiRunStore,
  createIntelligenceRuntime,
  createReferenceProvider,
  type AiRun,
  type Caller,
  type IntelligenceAnswer,
  type IntelligenceRuntime,
  type OutputClass,
  type TaskName,
  type TaskParams,
} from '@helm/intelligence-runtime';
import { createPostgresAiRunStore } from '@helm/intelligence-runtime/postgres';
import { createCouncil, createReferencePerspectiveProvider, type Council, type CouncilRequest, type CouncilResult } from '@helm/agent-runtime';
import type { TwinViewer } from '@helm/twin-runtime';
import { seqIdGen, type Scope } from '@helm/shared';
import { supabaseClient } from '../lib/supabaseClient.ts';
import { decisionVisibility } from './causalRuntime.ts';
import { resolveReviewContext, type ReviewContext } from './reviewRuntime.ts';
import type { PillTone } from '../components/ui/Pill.tsx';

export type IntelligenceContext = {
  readonly intelligence: IntelligenceRuntime;
  readonly council: Council;
  readonly scope: Scope;
  readonly mode: 'demo' | 'cloud';
  readonly reviews: ReviewContext;
  readonly providerLabel: string;
};

let demoIntelligence: Promise<IntelligenceContext> | null = null;

function build(reviews: ReviewContext, store: ReturnType<typeof createInMemoryAiRunStore>, mode: 'demo' | 'cloud', scope: Scope): IntelligenceContext {
  const g = reviews.genome;
  const twin = g.causal.twin;
  const tools = createGovernedTools({
    twin: twin.twin,
    decisions: twin.kernel.decisions,
    authority: twin.kernel.authority,
    causal: g.causal.causal,
    genome: g.genome,
    counterfactual: g.counterfactual.runtime,
    review: reviews.review,
  });
  const clock = twin.kernel.clock;
  const provider = createReferenceProvider();
  const council = createCouncil({ provider: createReferencePerspectiveProvider(provider), tools, store, clock });
  return { intelligence: createIntelligenceRuntime({ provider, tools, store, clock }), council, scope, mode, reviews, providerLabel: `${provider.id} · ${provider.model} ${provider.modelVersion}` };
}

export async function resolveIntelligenceContext(mode: 'demo' | 'cloud', scope: Scope): Promise<IntelligenceContext | null> {
  if (mode === 'cloud') {
    const reviews = await resolveReviewContext('cloud', scope);
    if (!reviews || !supabaseClient) return null;
    return build(reviews, createPostgresAiRunStore({ client: supabaseClient }), 'cloud', scope);
  }
  if (!demoIntelligence) {
    demoIntelligence = (async () => {
      const reviews = await resolveReviewContext('demo', scope);
      if (!reviews) throw new Error('The demo reviews are unavailable.');
      const clock = reviews.genome.causal.twin.kernel.clock;
      return build(reviews, createInMemoryAiRunStore({ clock, idGen: seqIdGen('ai') }), 'demo', scope);
    })();
  }
  return demoIntelligence;
}

/** Who is asking: the viewer, their units and the decisions they may see — the AI's only access. */
export async function callerFor(ctx: IntelligenceContext, viewer: TwinViewer): Promise<Caller> {
  return { viewer, units: ctx.reviews.genome.causal.twin.units, facts: { decisionVisible: await decisionVisibility(ctx.reviews.genome.causal, viewer) } };
}

export async function askHelm(ctx: IntelligenceContext, viewer: TwinViewer, task: TaskName, params: TaskParams): Promise<IntelligenceAnswer> {
  const r = await ctx.intelligence.run(ctx.scope, await callerFor(ctx, viewer), { task, params });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

export async function conveneCouncil(ctx: IntelligenceContext, viewer: TwinViewer, request: CouncilRequest): Promise<CouncilResult> {
  const r = await ctx.council.convene(ctx.scope, await callerFor(ctx, viewer), request);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

export async function auditTrail(ctx: IntelligenceContext, viewer: TwinViewer): Promise<readonly AiRun[]> {
  const r = await ctx.intelligence.listRuns(ctx.scope, await callerFor(ctx, viewer));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

export const taskTitle = (t: TaskName): string => TEMPLATES[t].id.replaceAll('-', ' ');

/** The fixed visual vocabulary for what an AI statement IS. */
export const classTone = (c: OutputClass): PillTone =>
  c === 'SOURCE_FACT' ? 'actual'
  : c === 'MODEL_RESULT' ? 'derived'
  : c === 'SCENARIO' ? 'scenario'
  : c === 'CAUSAL_CLAIM' ? 'hypothesis'
  : c === 'COUNTERFACTUAL_RESULT' ? 'counterfactual'
  : c === 'MANAGEMENT_ASSUMPTION' ? 'assumption'
  : c === 'MANAGEMENT_RECORD' ? 'reviewed'
  : c === 'UNKNOWN' ? 'unknown'
  : c === 'AI_INFERENCE' ? 'inference'
  : 'neutral';

export const classLabel = (c: OutputClass): string => c.toLowerCase().replaceAll('_', ' ');
