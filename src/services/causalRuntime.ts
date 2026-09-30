/**
 * The app's access to the Phase 8 Causal Graph.
 *
 * Wires ports together and holds no domain logic: every claim, evaluation,
 * investigation and path comes from @helm/causal-runtime.
 *
 * Demo mode builds on the twin's own in-memory enterprise (its story clock
 * already stands at the Q4 close) and lives the DEMO CAUSAL HYPOTHESES story
 * through it once per session (packages/causal-runtime/src/meridianCausal.ts).
 * Every record of that story is labelled DEMO; none came from a company's books.
 *
 * Cloud mode reads and writes helm_causal_* under the signed-in user's RLS.
 * Like the twin's, that path has not been exercised end to end: the Postgres
 * conformance suite has never run in an isolated authenticated environment
 * (docs/architecture/trusted-runtime-deployment-gate.md, Blocker B).
 */

import { canSeeDecision } from '@helm/authority-runtime';
import {
  claimsReferencing,
  createCausalGraph,
  createInMemoryCausalStore,
  explainTwinDifferenceCausally,
  runMeridianCausalStory,
  type CausalGraph,
  type CausalLens,
  type CausalQuestion,
  type ClaimExplanation,
  type ClaimStatus,
  type ClaimView,
  type CorrelationFinding,
  type MeridianCausalStory,
  type ModelDependency,
  type ProjectedCausalView,
  type QuestionInvestigation,
  type Traversal,
  type TwinCausalExplanation,
} from '@helm/causal-runtime';
import { createPostgresCausalStore } from '@helm/causal-runtime/postgres';
import type { TwinViewer } from '@helm/twin-runtime';
import { MERIDIAN_DEMO_USERS } from '@helm/authority-runtime';
import { seqIdGen, type Scope, type UserId } from '@helm/shared';
import { supabaseClient } from '../lib/supabaseClient.ts';
import { calculations, valueMetrics } from './ontologyGraph.ts';
import { resolveTwinContext, type TwinContext, type TwinViewerPreset } from './twinRuntime.ts';
import type { PillTone } from '../components/ui/Pill.tsx';

export type LensPreset = { readonly key: string; readonly label: string; readonly lens: CausalLens | null };

export type CausalContext = {
  readonly causal: CausalGraph;
  readonly scope: Scope;
  readonly mode: 'demo' | 'cloud';
  readonly twin: TwinContext;
  /** Demo: the canonical causal story. Null in the cloud. */
  readonly story: MeridianCausalStory | null;
  readonly viewers: readonly TwinViewerPreset[];
  /** Moments the explorer can read the causal graph AS OF. Null lens = now. */
  readonly lenses: readonly LensPreset[];
};

let demoCausal: Promise<CausalContext> | null = null;

const must = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }, what: string): T => {
  if (!r.ok) throw new Error(`${what}: ${r.error.message}`);
  return r.value;
};

const at = (iso: string): CausalLens => ({ effectiveAsOf: iso, recordedThrough: iso });

function getDemoCausal(scope: Scope): Promise<CausalContext> {
  if (demoCausal) return demoCausal;
  demoCausal = (async () => {
    const twin = await resolveTwinContext('demo', scope);
    if (!twin || !twin.story || !twin.kernel.governance || !twin.kernel.nodeIds) throw new Error('The demo twin is unavailable.');
    const k = twin.kernel;
    const governance = twin.kernel.governance;
    const nodeIds = twin.kernel.nodeIds;
    const causal = createCausalGraph({
      store: createInMemoryCausalStore({ clock: k.clock, idGen: seqIdGen('cg') }),
      graph: k.graph,
      metrics: valueMetrics,
      calculations,
      clock: k.clock,
    });
    const revisions = must(await k.decisionStore.listRevisions(scope, twin.story.decisionId), 'revisions');
    const assumptions = [];
    for (const r of revisions) assumptions.push(...must(await k.decisionStore.listAssumptions(scope, r.id), 'assumptions'));
    const e = governance.entities;
    const opexItem = twin.story.CF1.items.find((i) => i.kind === 'VALUE' && i.state.nodeId === nodeIds.freightOpex);
    const story = must(
      await runMeridianCausalStory({
        causal,
        admin: scope,
        as: (userId: UserId) => ({ ...scope, actorId: userId }),
        users: MERIDIAN_DEMO_USERS,
        entities: { vn: e.vn, buPharma: e.buPharma, rohto: e.rohto, buIndustrial: e.buIndustrial, buThPharma: e.buThPharma },
        nodeIds: { freightOpex: nodeIds.freightOpex, grossMarginPctOpp: nodeIds.grossMarginPctOpp },
        twin: {
          decisionId: twin.story.decisionId,
          cf1SnapshotId: twin.story.CF1.snapshot.id,
          s2SnapshotId: twin.story.S2.snapshot.id,
          fulfilmentItemKey: opexItem?.key ?? '',
        },
        assumptions,
        advanceTo: (iso) => k.clock.jumpTo?.(iso),
      }),
      'the causal story',
    );
    return {
      causal,
      scope,
      mode: 'demo' as const,
      twin,
      story,
      viewers: twin.viewers,
      lenses: [
        { key: 'now', label: 'Now', lens: null },
        { key: 'jan19', label: '19 Jan 2027 — before SCM\'s evidence', lens: at('2027-01-19T00:00:00.000Z') },
        { key: 'feb01', label: '1 Feb 2027 — before Finance\'s comparison', lens: at('2027-02-01T00:00:00.000Z') },
        { key: 'q4close', label: '12 Jan 2027 — at the Q4 close (S2)', lens: twin.story.S2.snapshot.spec.lens },
      ],
    };
  })();
  return demoCausal;
}

async function getCloudCausal(scope: Scope): Promise<CausalContext | null> {
  const twin = await resolveTwinContext('cloud', scope);
  if (!twin || !supabaseClient) return null;
  const causal = createCausalGraph({
    store: createPostgresCausalStore({ client: supabaseClient }),
    graph: twin.kernel.graph,
    metrics: valueMetrics,
    calculations,
    clock: twin.kernel.clock,
  });
  return { causal, scope, mode: 'cloud', twin, story: null, viewers: twin.viewers, lenses: [{ key: 'now', label: 'Now', lens: null }] };
}

export async function resolveCausalContext(mode: 'demo' | 'cloud', scope: Scope): Promise<CausalContext | null> {
  return mode === 'demo' ? getDemoCausal(scope) : getCloudCausal(scope);
}

// ----------------------------------------------------------------- read models

/** Which decisions this reader may see — the same rule RLS applies (helm_private.can_see_decision). */
export async function decisionVisibility(ctx: CausalContext, viewer: TwinViewer): Promise<(id: string) => boolean> {
  const k = ctx.twin.kernel;
  const decisions = must(await k.decisionStore.listDecisions(ctx.scope), 'decisions');
  const visible = new Set<string>();
  for (const d of decisions) {
    const grants = await k.authorityStore.listVisibility(ctx.scope, d.id);
    const grantedUnitIds = grants.ok ? grants.value.map((g) => g.orgUnitId) : [];
    if (canSeeDecision({ userId: viewer.userId, orgRole: viewer.orgRole, memberUnitIds: viewer.memberUnitIds }, { createdBy: d.createdBy, grantedUnitIds }, ctx.twin.units).visible) {
      visible.add(d.id);
    }
  }
  return (id: string) => visible.has(id);
}

export async function claimsForViewer(ctx: CausalContext, viewer: TwinViewer, lens: CausalLens | null): Promise<ProjectedCausalView> {
  const decisionVisible = await decisionVisibility(ctx, viewer);
  return must(await ctx.causal.projectForViewer(ctx.scope, viewer, ctx.twin.units, { decisionVisible }, lens ?? undefined), 'claims');
}

export async function explainClaimView(ctx: CausalContext, claimId: string, lens: CausalLens | null): Promise<ClaimExplanation> {
  return must(await ctx.causal.explainClaim(ctx.scope, claimId, lens ?? undefined), 'explanation');
}

export async function questionsView(ctx: CausalContext, lens: CausalLens | null): Promise<readonly QuestionInvestigation[]> {
  const all = must(await ctx.causal.listQuestions(ctx.scope), 'questions');
  const out: QuestionInvestigation[] = [];
  for (const q of all) {
    const inv = await ctx.causal.investigate(ctx.scope, q.id, lens ?? undefined);
    if (inv.ok) out.push(inv.value);
  }
  return out;
}

export async function correlationsView(ctx: CausalContext): Promise<readonly CorrelationFinding[]> {
  return must(await ctx.causal.listCorrelations(ctx.scope), 'correlations');
}

export async function dependenciesView(ctx: CausalContext, claims: readonly ClaimView[]): Promise<readonly { claim: ClaimView; dependency: ModelDependency }[]> {
  const out: { claim: ClaimView; dependency: ModelDependency }[] = [];
  for (const v of claims) {
    const d = await ctx.causal.modelDependency(ctx.scope, v.claim.causeKey, v.claim.effectKey);
    if (d.ok && d.value) out.push({ claim: v, dependency: d.value });
  }
  return out;
}

export async function pathsView(ctx: CausalContext, variableKey: string, lens: CausalLens | null): Promise<{ up: Traversal; down: Traversal }> {
  const up = must(await ctx.causal.traverse(ctx.scope, { from: variableKey, direction: 'UPSTREAM', maxDepth: 3, lens: lens ?? undefined }), 'upstream');
  const down = must(await ctx.causal.traverse(ctx.scope, { from: variableKey, direction: 'DOWNSTREAM', maxDepth: 3, lens: lens ?? undefined }), 'downstream');
  return { up, down };
}

export async function claimsOnDecision(ctx: CausalContext, decisionId: string): Promise<readonly ClaimView[]> {
  return must(await claimsReferencing(ctx.causal, ctx.scope, { kind: 'DECISION', id: decisionId }), 'claims on decision');
}

/** The twin difference, with the model explanation and the causal investigation kept apart. */
export async function causalDifferenceView(ctx: CausalContext, fromId: string, toId: string, fromKey: string, toKey: string): Promise<TwinCausalExplanation> {
  return must(await explainTwinDifferenceCausally({ twin: ctx.twin.twin, causal: ctx.causal }, ctx.scope, { fromId, toId, itemKey: fromKey, toItemKey: toKey }), 'causal difference');
}

export type { CausalQuestion };

/** The fixed visual vocabulary: a status never shares a look with a dependency or a correlation. */
export const statusTone = (s: ClaimStatus): PillTone =>
  s === 'SUPPORTED' ? 'supported' : s === 'CONTESTED' || s === 'WEAKENED' ? 'contested' : s === 'REFUTED' ? 'refuted' : s === 'RETIRED' ? 'reviewed' : 'hypothesis';
