/**
 * The app's access to the Phase 9 Management Genome.
 *
 * Wires ports together and holds no domain logic: every episode, situation,
 * pattern status and lesson comes from @helm/genome-runtime.
 *
 * Demo mode builds on the causal demo (which builds on the twin's in-memory
 * enterprise, its story clock standing after the causal hypotheses) and lives
 * the DEMO MANAGEMENT EPISODES story through it once per session
 * (packages/genome-runtime/src/meridianGenome.ts). Every record of that story
 * is labelled DEMO; none came from a company's books.
 *
 * Cloud mode reads and writes helm_genome_* under the signed-in user's RLS.
 * Like the twin's and the causal graph's, that path has not been exercised
 * end to end: the Postgres conformance suite has never run in an isolated
 * authenticated environment
 * (docs/architecture/trusted-runtime-deployment-gate.md, Blocker B).
 */

import {
  MERIDIAN_GENOME_TIMES,
  createInMemoryGenomeStore,
  createManagementGenome,
  runMeridianGenomeStory,
  type EpisodeView,
  type FeatureName,
  type GenomeLens,
  type LessonStatus,
  type ManagementGenome,
  type MeridianGenomeStory,
  type PatternStatus,
  type PatternStance,
  type ProjectedGenome,
  type SimilarSituations,
} from '@helm/genome-runtime';
import { createPostgresGenomeStore } from '@helm/genome-runtime/postgres';
import { createPostgresCounterfactualStore } from '@helm/counterfactual-runtime/postgres';
import { createInMemoryCounterfactualStore, type CounterfactualRuntime, type MeridianCounterfactualStory } from '@helm/counterfactual-runtime';
import type { TwinViewer } from '@helm/twin-runtime';
import { MERIDIAN_DEMO_USERS, buildCallOffScenario } from '@helm/authority-runtime';
import { asEntityId, seqIdGen, type Scope, type UserId } from '@helm/shared';
import { supabaseClient } from '../lib/supabaseClient.ts';
import { decisionVisibility, resolveCausalContext, type CausalContext } from './causalRuntime.ts';
import { counterfactualOver, liveDemoCounterfactualStory } from './counterfactualRuntime.ts';
import type { TwinViewerPreset } from './twinRuntime.ts';
import type { PillTone } from '../components/ui/Pill.tsx';

export type GenomeLensPreset = { readonly key: string; readonly label: string; readonly lens: GenomeLens | null };

export type GenomeContext = {
  readonly genome: ManagementGenome;
  readonly scope: Scope;
  readonly mode: 'demo' | 'cloud';
  readonly causal: CausalContext;
  /** Demo: the canonical management episodes. Null in the cloud. */
  readonly story: MeridianGenomeStory | null;
  /** The counterfactual runtime the genome references cases through — and, in the demo, the canonical review. */
  readonly counterfactual: { readonly runtime: CounterfactualRuntime; readonly story: MeridianCounterfactualStory | null };
  readonly viewers: readonly TwinViewerPreset[];
  /** Moments the explorer can read the genome AS OF. Null lens = now. */
  readonly lenses: readonly GenomeLensPreset[];
};

let demoGenome: Promise<GenomeContext> | null = null;

const must = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }, what: string): T => {
  if (!r.ok) throw new Error(`${what}: ${r.error.message}`);
  return r.value;
};

const at = (iso: string): GenomeLens => ({ effectiveAsOf: iso, recordedThrough: iso });

function sourcesOf(c: CausalContext, counterfactual: CounterfactualRuntime) {
  const k = c.twin.kernel;
  return { graph: k.graph, decisions: k.decisionStore, scenarios: k.scenarios, authority: k.authority, twin: c.twin.twin, causal: c.causal, counterfactual };
}

function getDemoGenome(scope: Scope): Promise<GenomeContext> {
  if (demoGenome) return demoGenome;
  demoGenome = (async () => {
    const causal = await resolveCausalContext('demo', scope);
    if (!causal || !causal.story || !causal.twin.story || !causal.twin.kernel.governance || !causal.twin.kernel.scenarioIds) throw new Error('The demo causal graph is unavailable.');
    const k = causal.twin.kernel;
    const twinStory = causal.twin.story;
    const e = k.governance!.entities;
    const claims = causal.story.claims;
    const counterfactual = counterfactualOver(causal, createInMemoryCounterfactualStore({ clock: k.clock, idGen: seqIdGen('cf') }));
    const genome = createManagementGenome({
      store: createInMemoryGenomeStore({ clock: k.clock, idGen: seqIdGen('gn') }),
      sources: sourcesOf(causal, counterfactual),
      clock: k.clock,
    });
    // The planned Rohto call-off is one of the demonstration decisions; its computed future is built here,
    // beside the twin's canonical scenarios, exactly as the governance proofs build it.
    const scenarioIds: Record<string, string> = { ...k.scenarioIds };
    if (!scenarioIds['call-off'] && k.nodeIds) {
      const fork = { effectiveAsOf: '2026-09-19T12:00:00.000Z', recordedThrough: k.clock.now().toISOString(), policy: 'SOURCE_TRUTH' as const };
      scenarioIds['call-off'] = must(await buildCallOffScenario(k.scenarios, scope, k.nodeIds, fork), 'call-off scenario').scenarioId;
    }
    const story = must(
      await runMeridianGenomeStory({
        genome,
        admin: scope,
        as: (userId: UserId) => ({ ...scope, actorId: userId }),
        users: MERIDIAN_DEMO_USERS,
        decisions: k.decisions,
        decisionStore: k.decisionStore,
        authority: k.authority,
        scenarioIds,
        entities: { buPharma: e.buPharma, rohto: e.rohto, buThPharma: e.buThPharma, vn: e.vn },
        twin: {
          decisionId: twinStory.decisionId,
          commitmentId: twinStory.commitmentId,
          S0: twinStory.S0.snapshot.id,
          CF1: twinStory.CF1.snapshot.id,
          S2: twinStory.S2.snapshot.id,
        },
        causalClaimIds: [claims.C3.claim.id, claims.H1.claim.id, claims.H2.claim.id, claims.H3.claim.id],
        shareWith: causal.twin.units.filter((u) => u.id === 'unit-vn-pharma').map((u) => ({ unitId: u.id, label: u.label })),
        advanceTo: (iso) => k.clock.jumpTo?.(iso),
      }),
      'the genome story',
    );
    // The counterfactual review comes after the outcome it reviews; the Rohto episode then REFERENCES its first case.
    const cfStory = await liveDemoCounterfactualStory(causal, counterfactual, scope);
    must(
      await genome.bindRef(scope, story.episodes.E1.episode.id, 'COUNTERFACTUAL_CASE', { kind: 'COUNTERFACTUAL_CASE', id: cfStory.cases.CF1.case.id, pin: null, label: cfStory.cases.CF1.case.title }, 'Expedite instead of reallocating (demo)'),
      'binding the counterfactual case to the Rohto episode',
    );
    const T = MERIDIAN_GENOME_TIMES;
    return {
      genome,
      scope,
      mode: 'demo' as const,
      causal,
      story,
      counterfactual: { runtime: counterfactual, story: cfStory },
      viewers: causal.viewers,
      lenses: [
        { key: 'now', label: 'Now', lens: null },
        { key: 'apr6', label: '6 Apr 2027 — before the contradiction was linked', lens: at(T.beforeContradictionLinked) },
        { key: 'apr2', label: '2 Apr 2027 — the day the episodes were opened', lens: at('2027-04-02T03:00:00.000Z') },
      ],
    };
  })();
  return demoGenome;
}

async function getCloudGenome(scope: Scope): Promise<GenomeContext | null> {
  const causal = await resolveCausalContext('cloud', scope);
  if (!causal || !supabaseClient) return null;
  const counterfactual = counterfactualOver(causal, createPostgresCounterfactualStore({ client: supabaseClient }));
  const genome = createManagementGenome({
    store: createPostgresGenomeStore({ client: supabaseClient }),
    sources: sourcesOf(causal, counterfactual),
    clock: causal.twin.kernel.clock,
  });
  return { genome, scope, mode: 'cloud', causal, story: null, counterfactual: { runtime: counterfactual, story: null }, viewers: causal.viewers, lenses: [{ key: 'now', label: 'Now', lens: null }] };
}

export async function resolveGenomeContext(mode: 'demo' | 'cloud', scope: Scope): Promise<GenomeContext | null> {
  return mode === 'demo' ? getDemoGenome(scope) : getCloudGenome(scope);
}

// ----------------------------------------------------------------- read models

/** The genome as this reader may see it — the same rule RLS applies (helm_private.can_see_genome_*). */
export async function genomeForViewer(ctx: GenomeContext, viewer: TwinViewer, lens: GenomeLens | null): Promise<ProjectedGenome> {
  const decisionVisible = await decisionVisibility(ctx.causal, viewer);
  return must(await ctx.genome.projectForViewer(ctx.scope, viewer, ctx.causal.twin.units, { decisionVisible }, lens ?? undefined), 'genome');
}

export async function similarView(ctx: GenomeContext, episodeId: string, require: readonly FeatureName[], lens: GenomeLens | null): Promise<SimilarSituations> {
  return must(await ctx.genome.findSimilar(ctx.scope, { episodeId, require, lens: lens ?? undefined }), 'similar situations');
}

/** Labels for the entities a situation names, resolved from the graph — an id is never shown where a name exists. */
export async function entityLabels(ctx: GenomeContext, ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  for (const id of ids) {
    const r = await ctx.causal.twin.kernel.graph.getEntity(ctx.scope, asEntityId(id));
    if (r.ok && r.value) out.set(id, r.value.name);
  }
  return out;
}

export type { EpisodeView };

/** The fixed visual vocabulary: recurrence is described, never certified. */
export const patternTone = (s: PatternStatus): PillTone =>
  s === 'SUPPORTED' ? 'supported' : s === 'CONTESTED' ? 'contested' : s === 'RECURRING' ? 'recurring' : s === 'RETIRED' ? 'reviewed' : 'hypothesis';

export const lessonTone = (s: LessonStatus): PillTone => (s === 'ENDORSED' ? 'endorsed' : s === 'DISPUTED' ? 'contested' : s === 'RETIRED' ? 'reviewed' : 'neutral');

export const stanceTone = (s: PatternStance): PillTone => (s === 'SUPPORTING_EPISODE' ? 'supported' : s === 'CONTRADICTORY_EPISODE' ? 'contested' : 'neutral');
