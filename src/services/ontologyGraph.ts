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
import { asOrgId, asUserId, systemClock, uuidIdGen, type Scope } from '@helm/shared';
import { supabaseClient } from '../lib/supabaseClient.ts';

export const registry: OntologyRegistry = buildSeedRegistry();

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

let demoStore: GraphStore | null = null;
let demoReady: Promise<GraphStore> | null = null;

/**
 * The demo graph, built once per session. Never syncs: this store is memory
 * only, so nothing here can reach the shared database.
 */
export function getDemoGraphStore(): Promise<GraphStore> {
  if (demoReady) return demoReady;
  demoReady = (async () => {
    const store = createInMemoryGraphStore({
      registry,
      clock: systemClock,
      idGen: uuidIdGen,
    });
    const built = await buildCanonicalScenario(store, demoScope());
    if (!built.ok) {
      throw new Error(`demo graph failed to build: ${built.error.code} ${built.error.message}`);
    }
    demoStore = store;
    return store;
  })();
  return demoReady;
}

/** The cloud graph, backed by Postgres with RLS doing the isolation. */
export function getCloudGraphStore(): GraphStore | null {
  if (!supabaseClient) return null;
  return createPostgresGraphStore({
    client: supabaseClient,
    registry,
    clock: systemClock,
  });
}

export function resolveGraphStore(mode: 'demo' | 'cloud'): Promise<GraphStore | null> {
  return mode === 'demo' ? getDemoGraphStore() : Promise.resolve(getCloudGraphStore());
}

export const demoStoreIfBuilt = (): GraphStore | null => demoStore;
