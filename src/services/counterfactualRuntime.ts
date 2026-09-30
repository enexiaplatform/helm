/**
 * The app's access to the Counterfactual Engine.
 *
 * Wires ports together and holds no domain logic: every case, world,
 * comparison and causal-support statement comes from
 * @helm/counterfactual-runtime.
 *
 * Demo mode builds on the causal demo (which builds on the twin's in-memory
 * enterprise) and lives the DEMO COUNTERFACTUAL REVIEW through it once per
 * session (packages/counterfactual-runtime/src/meridianCounterfactual.ts).
 * Every record of that story is labelled DEMO; none came from a company's books.
 *
 * Cloud mode reads and writes helm_counterfactual_* under the signed-in user's
 * RLS. That path has not been exercised end to end: the Postgres conformance
 * suite has never run in an isolated authenticated environment
 * (docs/architecture/trusted-runtime-deployment-gate.md, Blocker B).
 */

import {
  MERIDIAN_COUNTERFACTUAL_TIMES,
  createCounterfactualRuntime,
  createInMemoryCounterfactualStore,
  runMeridianCounterfactualStory,
  type CaseView,
  type CounterfactualComparison,
  type CounterfactualLens,
  type CounterfactualRuntime,
  type MeridianCounterfactualStory,
  type ProjectedCounterfactuals,
} from '@helm/counterfactual-runtime';
import { createPostgresCounterfactualStore } from '@helm/counterfactual-runtime/postgres';
import type { TwinViewer } from '@helm/twin-runtime';
import { MERIDIAN_DEMO_USERS } from '@helm/authority-runtime';
import { seqIdGen, type Scope, type UserId } from '@helm/shared';
import { supabaseClient } from '../lib/supabaseClient.ts';
import { decisionVisibility, resolveCausalContext, type CausalContext } from './causalRuntime.ts';
import type { TwinViewerPreset } from './twinRuntime.ts';
import type { PillTone } from '../components/ui/Pill.tsx';

export type CounterfactualLensPreset = { readonly key: string; readonly label: string; readonly lens: CounterfactualLens | null };

export type CounterfactualContext = {
  readonly counterfactual: CounterfactualRuntime;
  readonly scope: Scope;
  readonly mode: 'demo' | 'cloud';
  readonly causal: CausalContext;
  /** Demo: the canonical counterfactual review. Null in the cloud. */
  readonly story: MeridianCounterfactualStory | null;
  readonly viewers: readonly TwinViewerPreset[];
  readonly lenses: readonly CounterfactualLensPreset[];
};

let demoCounterfactual: Promise<CounterfactualContext> | null = null;

const must = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }, what: string): T => {
  if (!r.ok) throw new Error(`${what}: ${r.error.message}`);
  return r.value;
};

const at = (iso: string): CounterfactualLens => ({ effectiveAsOf: iso, recordedThrough: iso });

/** The counterfactual runtime over a causal context — the one place its sources are wired. */
export function counterfactualOver(causal: CausalContext, store: Parameters<typeof createCounterfactualRuntime>[0]['store']): CounterfactualRuntime {
  const k = causal.twin.kernel;
  return createCounterfactualRuntime({
    store,
    sources: { decisions: k.decisionStore, scenarios: k.scenarios, twin: causal.twin.twin, causal: causal.causal },
    clock: k.clock,
  });
}

/** The demo runtime, built once and shared by every surface that needs to read or reference a case. */
export function demoCounterfactualRuntime(causal: CausalContext): CounterfactualRuntime {
  const k = causal.twin.kernel;
  return counterfactualOver(causal, createInMemoryCounterfactualStore({ clock: k.clock, idGen: seqIdGen('cf') }));
}

/** Lives the canonical counterfactual review through an already-built runtime. Idempotent per session by the caller. */
export async function liveDemoCounterfactualStory(causal: CausalContext, counterfactual: CounterfactualRuntime, scope: Scope): Promise<MeridianCounterfactualStory> {
  const twin = causal.twin;
  if (!twin.story || !twin.kernel.governance || !twin.kernel.nodeIds) throw new Error('The demo twin is unavailable.');
  const k = twin.kernel;
  const e = k.governance!.entities;
  return must(
    await runMeridianCounterfactualStory({
      counterfactual,
      as: (userId: UserId) => ({ ...scope, actorId: userId }),
      users: MERIDIAN_DEMO_USERS,
      decisionStore: k.decisionStore,
      scenarios: k.scenarios,
      decisionId: twin.story.decisionId,
      anchorSnapshotId: twin.story.S0.snapshot.id,
      entities: { buPharma: e.buPharma },
      nodeIds: { oppProbNext: k.nodeIds!['oppProbNext']!, aspProduct: k.nodeIds!['aspProduct']! },
      advanceTo: (iso) => k.clock.jumpTo?.(iso),
    }),
    'the counterfactual story',
  );
}

function getDemoCounterfactual(scope: Scope): Promise<CounterfactualContext> {
  if (demoCounterfactual) return demoCounterfactual;
  demoCounterfactual = (async () => {
    // The genome service builds the counterfactual review as part of the shared demo, so the episode that
    // references CF1 and this instrument read the same case.
    const { resolveGenomeContext } = await import('./genomeRuntime.ts');
    const genome = await resolveGenomeContext('demo', scope);
    if (!genome || !genome.counterfactual) throw new Error('The demo counterfactual review is unavailable.');
    const T = MERIDIAN_COUNTERFACTUAL_TIMES;
    return {
      counterfactual: genome.counterfactual.runtime,
      scope,
      mode: 'demo' as const,
      causal: genome.causal,
      story: genome.counterfactual.story,
      viewers: genome.viewers,
      lenses: [
        { key: 'now', label: 'Now', lens: null },
        { key: 'between', label: '12 Apr 2027 — before the hindsight world', lens: at(T.betweenWorlds) },
      ],
    };
  })();
  return demoCounterfactual;
}

async function getCloudCounterfactual(scope: Scope): Promise<CounterfactualContext | null> {
  const causal = await resolveCausalContext('cloud', scope);
  if (!causal || !supabaseClient) return null;
  const counterfactual = counterfactualOver(causal, createPostgresCounterfactualStore({ client: supabaseClient }));
  return { counterfactual, scope, mode: 'cloud', causal, story: null, viewers: causal.viewers, lenses: [{ key: 'now', label: 'Now', lens: null }] };
}

export async function resolveCounterfactualContext(mode: 'demo' | 'cloud', scope: Scope): Promise<CounterfactualContext | null> {
  return mode === 'demo' ? getDemoCounterfactual(scope) : getCloudCounterfactual(scope);
}

// ----------------------------------------------------------------- read models

/** Cases as this reader may see them — the same rule RLS applies (helm_private.can_see_counterfactual_case). */
export async function counterfactualsForViewer(ctx: CounterfactualContext, viewer: TwinViewer, lens: CounterfactualLens | null): Promise<ProjectedCounterfactuals> {
  const decisionVisible = await decisionVisibility(ctx.causal, viewer);
  return must(await ctx.counterfactual.projectForViewer(ctx.scope, viewer, ctx.causal.twin.units, { decisionVisible }, lens ?? undefined), 'counterfactuals');
}

export async function comparisonOf(ctx: CounterfactualContext, caseId: string, lens: CounterfactualLens | null): Promise<CounterfactualComparison> {
  return must(await ctx.counterfactual.compare(ctx.scope, caseId, lens ?? undefined), 'comparison');
}

export type { CaseView, CounterfactualComparison };

/** Visual vocabulary: support is described, never certified. */
export const supportTone = (level: string): PillTone =>
  level === 'CAUSALLY_SUPPORTED' ? 'supported' : level === 'PARTIALLY_SUPPORTED' ? 'recurring' : level === 'CONTESTED' ? 'contested' : 'hypothesis';

export const caseTone = (s: CaseView['status']): PillTone => (s === 'REVIEWED' ? 'reviewed' : s === 'ESTIMATED' ? 'recurring' : 'neutral');
