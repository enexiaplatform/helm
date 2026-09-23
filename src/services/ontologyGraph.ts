/**
 * The app's access to the Phase 1 ontology kernel.
 *
 * One place decides which GraphStore adapter the app uses, so no page ever
 * imports an adapter directly. Demo mode gets the in-memory store preloaded
 * with the canonical scenario and never touches the network — the same rule the
 * rest of HELM's demo mode follows.
 *
 * Note the shape of this module: it wires ports together and holds no domain
 * logic. Every rule it relies on lives in @helm/ontology or @helm/graph-store,
 * where it is unit-tested.
 */

import { buildSeedRegistry, type OntologyRegistry } from '@helm/ontology';
import {
  createInMemoryGraphStore,
  buildCanonicalScenario,
  type GraphStore,
} from '@helm/graph-store';
import { createPostgresGraphStore } from '@helm/graph-store/postgres';
import {
  buildSeedValueRegistry,
  buildCanonicalScenarioExtension,
  buildCanonicalValueChain,
  createInMemoryValueGraph,
  type ValueGraph,
  type ValueMetricRegistry,
} from '@helm/value-graph';
import { createPostgresValueGraph } from '@helm/value-graph/postgres';
import {
  createCalculationRegistry,
  createInMemoryCalculationStore,
  createPropagationEngine,
  meridianValueModelV1_1,
  type CalculationRegistry,
  type CalculationStore,
  type PropagationEngine,
} from '@helm/propagation-engine';
import { createPostgresCalculationStore } from '@helm/propagation-engine/postgres';
import { asOrgId, asUserId, systemClock, uuidIdGen, type Scope } from '@helm/shared';
import { supabaseClient } from '../lib/supabaseClient.ts';

export const registry: OntologyRegistry = buildSeedRegistry();
export const valueMetrics: ValueMetricRegistry = buildSeedValueRegistry();

/** The demo organization id. Fixed so the in-memory graph is stable per session. */
export const DEMO_ORG_ID = asOrgId('00000000-0000-4000-8000-00000000d3m0');
const DEMO_USER_ID = asUserId('00000000-0000-4000-8000-00000000d3mu');

export function demoScope(): Scope {
  return {
    orgId: DEMO_ORG_ID,
    actorId: DEMO_USER_ID,
    role: 'admin',
    orgUnitIds: [],
    functions: [],
  };
}

export function cloudScope(orgId: string, userId: string, role: Scope['role']): Scope {
  return {
    orgId: asOrgId(orgId),
    actorId: asUserId(userId),
    role,
    orgUnitIds: [],
    functions: [],
  };
}

export type HelmGraphs = {
  graphStore: GraphStore;
  valueGraph: ValueGraph;
  /** Phase 3: the executable layer over the two graphs above. */
  engine: PropagationEngine;
  store: CalculationStore;
  /**
   * Demo only: the canonical value-node handles (value chain plus the Phase 4
   * extension), so canonical scenarios can name their targets. Null in cloud
   * mode, where an organization's nodes are its own.
   */
  nodeHandles: Readonly<Record<string, string>> | null;
};

/**
 * The calculation registry, built once: Meridian model v1.1 (v1 plus the four
 * scenario calculations). It validates every definition against the metric
 * registry, so a model that could produce a wrong number fails here rather than
 * in front of a manager.
 */
export const calculations: CalculationRegistry = (() => {
  const built = createCalculationRegistry(meridianValueModelV1_1, valueMetrics);
  if (!built.ok) {
    throw new Error(`calculation registry invalid: ${built.error.message}`);
  }
  return built.value;
})();

function buildEngine(
  graphStore: GraphStore,
  valueGraph: ValueGraph,
  store: CalculationStore,
): PropagationEngine {
  const engine = createPropagationEngine({
    registry: calculations,
    valueGraph,
    graphStore,
    ontology: registry,
    store,
    clock: systemClock,
  });
  if (!engine.ok) {
    throw new Error(`propagation engine could not be built: ${engine.error.message}`);
  }
  return engine.value;
}

let demoStore: GraphStore | null = null;
let demoReady: Promise<HelmGraphs> | null = null;

/**
 * The demo graphs, built once per session: the Phase 1 entity graph and the
 * Phase 2 value layer over it. Never syncs — both are memory only, so nothing
 * here can reach the shared database.
 */
export function getDemoGraphs(): Promise<HelmGraphs> {
  if (demoReady) return demoReady;
  demoReady = (async () => {
    const scope = demoScope();
    const graphStore = createInMemoryGraphStore({
      registry,
      clock: systemClock,
      idGen: uuidIdGen,
    });
    const entities = await buildCanonicalScenario(graphStore, scope);
    if (!entities.ok) {
      throw new Error(`demo graph failed to build: ${entities.error.code} ${entities.error.message}`);
    }

    const valueGraph = createInMemoryValueGraph({
      metrics: valueMetrics,
      ontology: registry,
      graphStore,
      clock: systemClock,
      idGen: uuidIdGen,
    });
    const values = await buildCanonicalValueChain(valueGraph, graphStore, scope);
    if (!values.ok) {
      throw new Error(`demo value chain failed: ${values.error.code} ${values.error.message}`);
    }
    const extension = await buildCanonicalScenarioExtension(valueGraph, graphStore, scope, values.value.nodeIds);
    if (!extension.ok) {
      throw new Error(`demo scenario extension failed: ${extension.error.code} ${extension.error.message}`);
    }

    const store = createInMemoryCalculationStore({ clock: systemClock, idGen: uuidIdGen });
    demoStore = graphStore;
    return {
      graphStore,
      valueGraph,
      engine: buildEngine(graphStore, valueGraph, store),
      store,
      nodeHandles: { ...values.value.nodeIds, ...extension.value.nodeIds },
    };
  })();
  return demoReady;
}

/** The cloud graphs, backed by Postgres with RLS doing the isolation. */
export function getCloudGraphs(): HelmGraphs | null {
  if (!supabaseClient) return null;
  const graphStore = createPostgresGraphStore({
    client: supabaseClient,
    registry,
    clock: systemClock,
  });
  const valueGraph = createPostgresValueGraph({
    client: supabaseClient,
    metrics: valueMetrics,
    ontology: registry,
    graphStore,
    clock: systemClock,
  });
  const store = createPostgresCalculationStore({
    client: supabaseClient,
    metrics: valueMetrics,
    clock: systemClock,
  });
  return {
    graphStore,
    valueGraph,
    engine: buildEngine(graphStore, valueGraph, store),
    store,
    nodeHandles: null,
  };
}

export function resolveGraphs(mode: 'demo' | 'cloud'): Promise<HelmGraphs | null> {
  return mode === 'demo' ? getDemoGraphs() : Promise.resolve(getCloudGraphs());
}

/** Entity-graph-only convenience for the Ontology Explorer. */
export async function resolveGraphStore(mode: 'demo' | 'cloud'): Promise<GraphStore | null> {
  const graphs = await resolveGraphs(mode);
  return graphs?.graphStore ?? null;
}

export const demoStoreIfBuilt = (): GraphStore | null => demoStore;
