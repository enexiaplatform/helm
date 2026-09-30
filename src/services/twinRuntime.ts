/**
 * The app's access to the Phase 7 Twin Runtime.
 *
 * Wires ports together and holds no domain logic: every snapshot, delta,
 * trajectory and explanation comes from @helm/twin-runtime.
 *
 * Demo mode builds its OWN in-memory enterprise once per session, on a clock
 * it can move forward, and lives the canonical Rohto story through it (see
 * packages/twin-runtime/src/meridianTwin.ts): S0 before the decision, S1a and
 * S1 after the commitment and the Country GM's approval, CF1 the committed
 * future, S2 after the Q4 outcome, and 23 September as it was known then and
 * as it is known now. Everything later in that story is labelled DEMO TWIN
 * DATA; it enters HELM through the kernels exactly as a real fact would.
 *
 * Cloud mode composes over the Postgres stores under the signed-in user's RLS
 * and stores snapshots in helm_twin_snapshots. It has not been exercised end to
 * end (docs/architecture/phase-7-implemented.md, "Cloud-path status").
 */

import { createInMemoryGraphStore, buildCanonicalScenario, type GraphStore } from '@helm/graph-store';
import { createInMemoryValueGraph, buildCanonicalValueChain, buildCanonicalScenarioExtension } from '@helm/value-graph';
import { createInMemoryCalculationStore, createPropagationEngine } from '@helm/propagation-engine';
import { buildMeridianScenarios, createInMemoryScenarioStore, createScenarioRuntime, meridianConstraintsV1, meridianStateFrame, type ScenarioRuntime } from '@helm/scenario-runtime';
import { createDecisionRuntime, createInMemoryDecisionStore, type DecisionRuntime, type DecisionStore } from '@helm/decision-runtime';
import { createPostgresDecisionStore } from '@helm/decision-runtime/postgres';
import {
  MERIDIAN_DEMO_PEOPLE,
  MERIDIAN_DEMO_UNITS,
  MERIDIAN_DEMO_USERS,
  buildMeridianGovernanceGraph,
  createAuthorityRuntime,
  createInMemoryAuthorityStore,
  createTrustedAuthorityService,
  recordMeridianDoaV1,
  recordMeridianOccupancies,
  scopeAs,
  type AuthorityRuntime,
  type AuthorityStore,
  type MeridianGovernanceGraph,
  type OrgUnit,
} from '@helm/authority-runtime';
import { createPostgresAuthorityStore } from '@helm/authority-runtime/postgres';
import {
  createInMemoryTwinStore,
  createTwinRuntime,
  runMeridianTwinStory,
  type ComposedSnapshot,
  type DifferenceExplanation,
  type MeridianTwinStory,
  type ProjectedSnapshot,
  type SensitivityClearance,
  type Trajectory,
  type TwinDelta,
  type TwinItemExplanation,
  type TwinRuntime,
  type TwinScope,
  type TwinSnapshot,
  type TwinSources,
  type TwinViewer,
} from '@helm/twin-runtime';
import { createPostgresTwinStore } from '@helm/twin-runtime/postgres';
import { seqIdGen, systemClock, type Clock, type Scope, type UserId } from '@helm/shared';
import { supabaseClient } from '../lib/supabaseClient.ts';
import { calculations, getCloudGraphs, registry, valueMetrics } from './ontologyGraph.ts';
import { resolveScenarioWorkspace } from './scenarioRuntime.ts';

export type TwinViewerPreset = { readonly key: string; readonly label: string; readonly viewer: TwinViewer };

export type TwinContext = {
  readonly twin: TwinRuntime;
  readonly scope: Scope;
  readonly mode: 'demo' | 'cloud';
  /** Demo: the canonical story's snapshots, by name. Null in the cloud. */
  readonly story: MeridianTwinStory | null;
  /** Scopes the explorer offers. */
  readonly scopes: readonly TwinScope[];
  /** Demo: the fictional readers the explorer can read AS. Cloud: the signed-in user only. */
  readonly viewers: readonly TwinViewerPreset[];
  readonly units: readonly OrgUnit[];
  /** The kernel handles the layers above the twin (the causal graph, the genome) build on. */
  readonly kernel: {
    readonly graph: GraphStore;
    readonly clock: Clock & { jumpTo?(iso: string): void };
    readonly decisionStore: DecisionStore;
    readonly authorityStore: AuthorityStore;
    readonly scenarios: ScenarioRuntime;
    readonly authority: AuthorityRuntime;
    readonly decisions: DecisionRuntime;
    readonly governance: MeridianGovernanceGraph | null;
    readonly nodeIds: Readonly<Record<string, string>> | null;
    /** Demo: the canonical scenarios by key. Null in the cloud. */
    readonly scenarioIds: Readonly<Record<string, string>> | null;
  };
};

let demoTwin: Promise<TwinContext> | null = null;

/** A clock that ticks one second per read and can be moved forward — never back. */
function storyClock(startIso: string): Clock & { jumpTo(iso: string): void } {
  let t = Date.parse(startIso);
  return {
    now: () => new Date((t += 1000)),
    jumpTo: (iso: string) => {
      const target = Date.parse(iso);
      if (target > t) t = target;
    },
  };
}

const must = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }, what: string): T => {
  if (!r.ok) throw new Error(`${what}: ${r.error.message}`);
  return r.value;
};

const MEMBERSHIP: Readonly<Record<string, readonly string[]>> = {
  [MERIDIAN_DEMO_USERS.countryGM]: ['unit-vn'],
  [MERIDIAN_DEMO_USERS.financeDirector]: ['unit-vn-finance'],
  [MERIDIAN_DEMO_USERS.pharmaAnalyst]: ['unit-vn-pharma'],
  [MERIDIAN_DEMO_USERS.industrialHead]: ['unit-vn-industrial'],
};

function getDemoTwin(scope: Scope): Promise<TwinContext> {
  if (demoTwin) return demoTwin;
  demoTwin = (async () => {
    const clock = storyClock('2026-09-19T08:00:00.000Z');
    const idGen = seqIdGen('tw');
    const graph = createInMemoryGraphStore({ registry, clock, idGen });
    const valueGraph = createInMemoryValueGraph({ metrics: valueMetrics, ontology: registry, graphStore: graph, clock, idGen });
    must(await buildCanonicalScenario(graph, scope), 'entity graph');
    const chain = must(await buildCanonicalValueChain(valueGraph, graph, scope), 'value chain');
    const ext = must(await buildCanonicalScenarioExtension(valueGraph, graph, scope, chain.nodeIds), 'extension');
    const nodeIds = { ...chain.nodeIds, ...ext.nodeIds };
    const engine = must(
      createPropagationEngine({ registry: calculations, valueGraph, graphStore: graph, ontology: registry, store: createInMemoryCalculationStore({ clock, idGen }), clock }),
      'engine',
    );
    const scenarios = createScenarioRuntime({
      engine,
      registry: calculations,
      valueGraph,
      graphStore: graph,
      store: createInMemoryScenarioStore({ clock, idGen }),
      clock,
      constraints: meridianConstraintsV1,
      stateFrame: meridianStateFrame,
    });
    const fork = { effectiveAsOf: '2026-09-19T12:00:00.000Z', recordedThrough: clock.now().toISOString(), policy: 'SOURCE_TRUTH' as const };
    const built = must(await buildMeridianScenarios(scenarios, scope, nodeIds, { fork }), 'canonical scenarios');
    const scenarioIds: Record<string, string> = {};
    for (const [key, { scenario }] of Object.entries(built)) {
      scenarioIds[key] = scenario.id;
      must(await scenarios.execute(scope, scenario.id), `simulate ${key}`);
    }
    const decisionStore = createInMemoryDecisionStore({ clock, idGen });
    const decisions = createDecisionRuntime({ store: decisionStore, scenarios, clock });
    const authorityStore = createInMemoryAuthorityStore({ clock, idGen });
    const authority = createAuthorityRuntime({ store: authorityStore, decisions: decisionStore, scenarios, graph, clock });
    const governance = must(await buildMeridianGovernanceGraph(graph, scope), 'governance graph');
    const occupancies = must(await recordMeridianOccupancies(authority, scope, governance), 'occupancies');
    const doa = must(await recordMeridianDoaV1(authority, scope, governance), 'DOA v1');
    const trusted = createTrustedAuthorityService({
      runtime: createAuthorityRuntime({ store: authorityStore, decisions: decisionStore, scenarios, graph, clock, evaluator: { kind: 'TRUSTED_SERVICE', host: 'in-process (demo)' } }),
      store: authorityStore,
      decisions: decisionStore,
      scenarios,
      engine,
      registry: calculations,
      valueGraph,
      membershipOf: async () => ({ ok: true, value: { orgRole: 'member', memberUnitIds: [] } }),
      callerCanSeeDecision: async () => ({ ok: true, value: true }),
    });
    const sources: TwinSources = {
      graph,
      valueGraph,
      engine,
      registry: calculations,
      scenarios,
      decisions: decisionStore,
      authority,
      authorityStore,
      constraints: meridianConstraintsV1,
    };
    const twin = createTwinRuntime({ store: createInMemoryTwinStore({ clock, idGen }), sources, clock });
    const story = must(
      await runMeridianTwinStory({
        admin: scope,
        as: (userId: UserId) => scopeAs(scope, userId),
        graph,
        valueGraph,
        scenarios,
        decisions,
        authority,
        trusted,
        twin,
        governance,
        doaV1: doa.policy,
        occupancies,
        scenarioIds,
        nodeIds,
        advanceTo: (iso) => clock.jumpTo(iso),
        units: { vietnam: 'unit-vn', pharma: 'unit-vn-pharma', industrial: 'unit-vn-industrial' },
      }),
      'the twin story',
    );

    // Demo clearances: who may read which class.
    const grant = async (userId: UserId, sensitivity: SensitivityClearance['sensitivity']) =>
      must(await twin.grantClearance(scope, { userId, sensitivity, validFrom: '2026-01-01T00:00:00.000Z', validTo: null, reason: 'Demo clearance' }), 'clearance');
    await grant(MERIDIAN_DEMO_USERS.countryGM, 'FINANCIAL_SENSITIVE');
    await grant(MERIDIAN_DEMO_USERS.countryGM, 'COMMERCIAL_CONFIDENTIAL');
    await grant(MERIDIAN_DEMO_USERS.financeDirector, 'FINANCIAL_SENSITIVE');
    const clearances = must(await twin.listClearances(scope), 'clearances');
    const preset = (key: keyof typeof MERIDIAN_DEMO_USERS, seat: string): TwinViewerPreset => {
      const userId = MERIDIAN_DEMO_USERS[key];
      return {
        key,
        label: `${MERIDIAN_DEMO_PEOPLE[key]} · ${seat}`,
        viewer: { userId, orgRole: 'member', memberUnitIds: MEMBERSHIP[userId] ?? [], clearances: clearances.filter((c) => c.userId === userId) },
      };
    };
    return {
      twin,
      scope,
      mode: 'demo' as const,
      story,
      scopes: [story.scopes.vietnam, story.scopes.pharma, story.scopes.industrial],
      viewers: [
        { key: 'admin', label: 'Organization admin (demo)', viewer: { userId: String(scope.actorId), orgRole: 'admin', memberUnitIds: [], clearances: [] } },
        preset('countryGM', 'Country GM Vietnam'),
        preset('financeDirector', 'Finance Director Vietnam'),
        preset('pharmaAnalyst', 'Pharma Commercial Analyst'),
        preset('industrialHead', 'Industrial BU Head'),
      ],
      units: MERIDIAN_DEMO_UNITS,
      kernel: { graph, clock, decisionStore, authorityStore, scenarios, authority, decisions, governance, nodeIds, scenarioIds },
    };
  })();
  return demoTwin;
}

async function getCloudTwin(scope: Scope): Promise<TwinContext | null> {
  const graphs = getCloudGraphs();
  const workspace = await resolveScenarioWorkspace('cloud', scope);
  if (!graphs || !workspace || !supabaseClient) return null;
  const decisionStore = createPostgresDecisionStore({ client: supabaseClient, clock: systemClock });
  const authorityStore = createPostgresAuthorityStore({ client: supabaseClient, clock: systemClock });
  const authority = createAuthorityRuntime({ store: authorityStore, decisions: decisionStore, scenarios: workspace.runtime, graph: graphs.graphStore, clock: systemClock });
  const twin = createTwinRuntime({
    store: createPostgresTwinStore({ client: supabaseClient }),
    sources: {
      graph: graphs.graphStore,
      valueGraph: graphs.valueGraph,
      engine: graphs.engine,
      registry: calculations,
      scenarios: workspace.runtime,
      decisions: decisionStore,
      authority,
      authorityStore,
      constraints: meridianConstraintsV1,
    },
    clock: systemClock,
  });
  const { data } = await supabaseClient.from('org_units').select('id, parent_id, name, unit_type').eq('org_id', scope.orgId);
  const units = ((data as { id: string; parent_id: string | null; name: string; unit_type: string }[] | null) ?? []).map((u) => ({
    id: u.id,
    parentId: u.parent_id,
    label: u.name,
    unitType: u.unit_type,
  }));
  const clearances = await twin.listClearances(scope, scope.actorId);
  const memberships = await supabaseClient.from('org_unit_memberships').select('unit_id').eq('org_id', scope.orgId).eq('user_id', scope.actorId);
  return {
    twin,
    scope,
    mode: 'cloud',
    story: null,
    scopes: [{ kind: 'ENTERPRISE', label: 'Enterprise' }],
    viewers: [
      {
        key: 'me',
        label: 'You',
        viewer: {
          userId: String(scope.actorId),
          orgRole: scope.role,
          memberUnitIds: ((memberships.data as { unit_id: string }[] | null) ?? []).map((m) => m.unit_id),
          clearances: clearances.ok ? clearances.value : [],
        },
      },
    ],
    units,
    kernel: {
      graph: graphs.graphStore,
      clock: systemClock,
      decisionStore,
      authorityStore,
      scenarios: workspace.runtime,
      authority,
      decisions: createDecisionRuntime({ store: decisionStore, scenarios: workspace.runtime, clock: systemClock }),
      governance: null,
      nodeIds: null,
      scenarioIds: null,
    },
  };
}

export async function resolveTwinContext(mode: 'demo' | 'cloud', scope: Scope): Promise<TwinContext | null> {
  return mode === 'demo' ? getDemoTwin(scope) : getCloudTwin(scope);
}

// ----------------------------------------------------------------- read models

export type SnapshotView = {
  readonly composed: ComposedSnapshot;
  /** What the chosen reader may see of it; null when the snapshot itself is not visible to them. */
  readonly projection: ProjectedSnapshot | null;
  readonly refusal: string | null;
};

export async function loadSnapshotView(ctx: TwinContext, snapshotId: string, viewer: TwinViewer): Promise<SnapshotView> {
  const composed = must(await ctx.twin.getSnapshot(ctx.scope, snapshotId), 'snapshot');
  const projected = await ctx.twin.projectForViewer(ctx.scope, snapshotId, viewer, ctx.units);
  return projected.ok ? { composed, projection: projected.value, refusal: null } : { composed, projection: null, refusal: projected.error.message };
}

export async function listSnapshots(ctx: TwinContext): Promise<readonly TwinSnapshot[]> {
  return must(await ctx.twin.listSnapshots(ctx.scope), 'snapshots');
}

export async function compareView(ctx: TwinContext, fromId: string, toId: string): Promise<TwinDelta> {
  return must(await ctx.twin.compareSnapshots(ctx.scope, fromId, toId), 'comparison');
}

export async function trajectoryView(ctx: TwinContext, currentId: string, committedId: string): Promise<Trajectory> {
  return must(await ctx.twin.getTrajectory(ctx.scope, currentId, committedId), 'trajectory');
}

export async function explainView(ctx: TwinContext, snapshotId: string, itemKey: string): Promise<TwinItemExplanation> {
  return must(await ctx.twin.explainItem(ctx.scope, snapshotId, itemKey), 'explanation');
}

export async function differenceView(ctx: TwinContext, fromId: string, toId: string, fromKey: string, toKey: string): Promise<DifferenceExplanation> {
  return must(await ctx.twin.explainDifference(ctx.scope, fromId, toId, fromKey, toKey), 'difference');
}

export async function buildCurrentSnapshot(ctx: TwinContext, twinScope: TwinScope): Promise<ComposedSnapshot> {
  return must(await ctx.twin.buildSnapshot(ctx.scope, { kind: 'CURRENT', label: `Current — ${twinScope.label}`, scope: twinScope }), 'current snapshot');
}

/** Reading helpers: exact strings, formatted for the eye only. */
export const lensText = (s: TwinSnapshot): string =>
  `effective ${s.spec.lens.effectiveAsOf.slice(0, 16).replace('T', ' ')} · known through ${s.spec.lens.recordedThrough.slice(0, 16).replace('T', ' ')} UTC`;

