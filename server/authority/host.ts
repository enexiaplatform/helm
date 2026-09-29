/**
 * The host of the trusted authority service (ADR-0024) — what the Supabase
 * edge function `helm-authority` runs, bundled by scripts/build-authority-function.mjs.
 *
 * Two clients, two jobs, never mixed:
 *
 *   caller   the request's own JWT, under RLS. Used for exactly two things:
 *            verifying who is calling (Supabase Auth), and asking whether that
 *            person may SEE the decision (the helm_decisions select policy).
 *   service  the service role. Loads every fact the verdict rests on — the
 *            commitment, the chosen run and its trace, the graph, the policy,
 *            the occupancies — and writes the evaluation, its requirements and
 *            approval acts, which no client may write any more.
 *
 * Nothing from the request body reaches the stores except two identifiers
 * (the organization and the commitment or requirement); everything else is
 * refused by name in trusted.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { buildSeedRegistry } from '@helm/ontology';
import { asOrgId, fail, ok, systemClock, type OrgRole, type Scope, type UserId } from '@helm/shared';
import { createPostgresGraphStore } from '@helm/graph-store/postgres';
import { buildSeedValueRegistry } from '@helm/value-graph';
import { createPostgresValueGraph } from '@helm/value-graph/postgres';
import { createCalculationRegistry, createPropagationEngine, meridianValueModelV1_1 } from '@helm/propagation-engine';
import { createPostgresCalculationStore } from '@helm/propagation-engine/postgres';
import { createScenarioRuntime, meridianConstraintsV1, meridianStateFrame } from '@helm/scenario-runtime';
import { createPostgresScenarioStore } from '@helm/scenario-runtime/postgres';
import { createPostgresDecisionStore } from '@helm/decision-runtime/postgres';
import {
  TRUSTED_HOST_EDGE,
  createAuthorityRuntime,
  createTrustedAuthorityService,
  type TrustedResponse,
  type VerifiedIdentity,
} from '@helm/authority-runtime';
import { createPostgresAuthorityStore } from '@helm/authority-runtime/postgres';

export type AuthorityHostClients = {
  /** Service-role client: reads every fact and writes the verdict. */
  readonly service: SupabaseClient;
  /** The caller's own client (their JWT): identity and visibility only. */
  readonly caller: SupabaseClient;
};

export async function handleAuthorityRequest(
  clients: AuthorityHostClients,
  identity: VerifiedIdentity | null,
  body: unknown,
): Promise<TrustedResponse> {
  const { service, caller } = clients;
  const clock = systemClock;
  const ontology = buildSeedRegistry();
  const metrics = buildSeedValueRegistry();
  const registry = createCalculationRegistry(meridianValueModelV1_1, metrics);
  if (!registry.ok) return { status: 422, body: { ok: false, error: registry.error } };

  const graph = createPostgresGraphStore({ client: service, registry: ontology, clock });
  const valueGraph = createPostgresValueGraph({ client: service, metrics, ontology, graphStore: graph, clock });
  const calcStore = createPostgresCalculationStore({ client: service, metrics, clock });
  const engine = createPropagationEngine({ registry: registry.value, valueGraph, graphStore: graph, ontology, store: calcStore, clock });
  if (!engine.ok) return { status: 422, body: { ok: false, error: engine.error } };
  const scenarios = createScenarioRuntime({
    engine: engine.value,
    registry: registry.value,
    valueGraph,
    graphStore: graph,
    store: createPostgresScenarioStore({ client: service, clock }),
    clock,
    constraints: meridianConstraintsV1,
    stateFrame: meridianStateFrame,
  });
  const decisions = createPostgresDecisionStore({ client: service, clock });
  const store = createPostgresAuthorityStore({ client: service, clock });
  const runtime = createAuthorityRuntime({
    store,
    decisions,
    scenarios,
    graph,
    clock,
    evaluator: { kind: 'TRUSTED_SERVICE', host: TRUSTED_HOST_EDGE },
  });

  const service_ = createTrustedAuthorityService({
    runtime,
    store,
    decisions,
    scenarios,
    engine: engine.value,
    registry: registry.value,
    valueGraph,
    async membershipOf(userId: UserId, orgId) {
      const { data, error } = await service
        .from('organization_memberships')
        .select('role')
        .eq('org_id', orgId)
        .eq('user_id', userId)
        .maybeSingle();
      if (error) return fail('authority.read_failed', error.message);
      if (!data) return ok(null);
      const units = await service.from('org_unit_memberships').select('unit_id').eq('org_id', orgId).eq('user_id', userId);
      if (units.error) return fail('authority.read_failed', units.error.message);
      return ok({
        orgRole: ((data as { role: string | null }).role ?? 'member') as OrgRole,
        memberUnitIds: ((units.data as { unit_id: string }[] | null) ?? []).map((u) => u.unit_id),
      });
    },
    async callerCanSeeDecision(scope: Scope, decisionId: string) {
      // Asked AS THE CALLER: RLS on helm_decisions answers it.
      const { data, error } = await caller.from('helm_decisions').select('id').eq('org_id', asOrgId(scope.orgId)).eq('id', decisionId).maybeSingle();
      if (error) return fail('authority.read_failed', error.message);
      return ok(data !== null);
    },
  });
  return service_.handle(identity, body);
}
