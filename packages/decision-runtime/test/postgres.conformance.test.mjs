/**
 * The SAME DecisionStore conformance suite, against PostgresDecisionStore.
 *
 * Needs an authenticated session against a Supabase project, which cannot be
 * fabricated here, so it SKIPS with instructions until credentials are given —
 * the same debt the Phase 1–4 Postgres suites carry.
 *
 *   HELM_TEST_SUPABASE_URL=...      # project URL
 *   HELM_TEST_SUPABASE_KEY=...      # anon key (RLS stays enforced)
 *   HELM_TEST_ACCESS_TOKEN=...      # a signed-in user's access token
 *   HELM_TEST_ORG_A=<uuid>          # an org that user is a member of
 *   HELM_TEST_ORG_B=<uuid>          # a second org they are NOT a member of
 *   npm test
 *
 * Use a Supabase BRANCH, never production. Decision history is append-only by
 * design (revisions, commitments, snapshots and the timeline cannot be
 * deleted), so the suite leaves its rows behind on the branch.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.HELM_TEST_SUPABASE_URL;
const key = process.env.HELM_TEST_SUPABASE_KEY;
const token = process.env.HELM_TEST_ACCESS_TOKEN;
const orgA = process.env.HELM_TEST_ORG_A;
const orgB = process.env.HELM_TEST_ORG_B;

if (!(url && key && token && orgA && orgB)) {
  describe('DecisionStore conformance — PostgresDecisionStore', () => {
    test('skipped: no test database credentials configured', (t) => {
      t.skip(
        'Set HELM_TEST_SUPABASE_URL / _KEY / _ACCESS_TOKEN / _ORG_A / _ORG_B ' +
          '(against a Supabase branch, not production) to run the Postgres half of the ' +
          'decision store conformance suite. See the header of this file.',
      );
    });
  });
} else {
  const { createClient } = await import('@supabase/supabase-js');
  const { buildSeedRegistry, canonicalKey } = await import('@helm/ontology');
  const { asOrgId, asUserId, quarterPeriod } = await import('@helm/shared');
  const { createPostgresGraphStore } = await import('@helm/graph-store/postgres');
  const { createPostgresValueGraph, buildSeedValueRegistry } = await import('@helm/value-graph');
  const { createPostgresScenarioStore } = await import('@helm/scenario-runtime/postgres');
  const { createPostgresCalculationStore, ENGINE_VERSION } = await import('@helm/propagation-engine');
  const { createPostgresDecisionStore } = await import('../src/postgres.ts');
  const { runDecisionStoreConformanceSuite } = await import('../src/conformance.ts');

  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData } = await client.auth.getUser(token);
  const actorId = userData?.user?.id;
  assert.ok(actorId, 'HELM_TEST_ACCESS_TOKEN did not resolve to a user');

  const clock = { now: () => new Date() };
  const ontology = buildSeedRegistry();
  const graphStore = createPostgresGraphStore({ client, registry: ontology, clock });
  const valueGraph = createPostgresValueGraph({
    client, metrics: buildSeedValueRegistry(), ontology, graphStore, clock,
  });
  const scenarioStore = createPostgresScenarioStore({ client, clock });
  const calcStore = createPostgresCalculationStore({ client, metrics: buildSeedValueRegistry(), clock });
  const mk = (org) => ({ orgId: asOrgId(org), actorId: asUserId(actorId), role: 'admin', orgUnitIds: [], functions: [] });
  const run = `${Date.now()}`;
  const Q4 = quarterPeriod(2026, 4);
  let seq = 0;

  runDecisionStoreConformanceSuite(
    { describe, it: test, assert },
    {
      name: 'PostgresDecisionStore',
      async create() {
        const scopeA = mk(orgA);
        return {
          store: createPostgresDecisionStore({ client, clock }),
          scopeA,
          scopeB: mk(orgB),
          /**
           * A real sealed scenario revision with a completed simulation, so
           * the database's foreign keys and its "an alternative may only bind
           * a completed run" guard both have something true to check.
           */
          async scenarioRun() {
            seq += 1;
            const fork = {
              effectiveAsOf: '2026-09-19T12:00:00.000Z',
              recordedThrough: new Date(Date.now() - 60_000).toISOString(),
              policy: 'SOURCE_TRUTH',
            };
            const entity = await graphStore.upsertEntity(scopeA, {
              entityTypeKey: 'Scenario',
              canonicalKey: canonicalKey('helm', 'scenario', `decision-conformance-${run}-${seq}`),
              name: `Decision conformance ${seq}`,
              sourceSystem: 'helm',
              attributes: { kind: 'variant' },
            });
            assert.ok(entity.ok, 'scenario entity');
            const scenario = await scenarioStore.createScenario(scopeA, {
              key: `decision-conformance-${run}-${seq}`,
              name: `Decision conformance ${seq}`,
              description: 'A scenario a decision alternative can bind to.',
              parentScenarioId: null,
              scenarioEntityId: entity.value.entity.id,
              metadata: {},
              createdBy: scopeA.actorId,
            });
            assert.ok(scenario.ok, 'scenario');
            const revision = await scenarioStore.createRevision(scopeA, {
              scenarioId: scenario.value.id,
              reason: 'CREATED',
              basedOnRevisionId: null,
              parentRevisionId: null,
              fork,
              periods: [Q4],
              notes: null,
              createdBy: scopeA.actorId,
            });
            assert.ok(revision.ok, 'scenario revision');
            const model = { engineVersion: ENGINE_VERSION, calculations: [] };
            const sealed = await scenarioStore.sealRevision(scopeA, revision.value.id, {
              modelRef: model,
              fingerprint: `sfp_conformance_${run}_${seq}`,
            });
            assert.ok(sealed.ok, 'seal scenario revision');
            const simulation = await scenarioStore.createRun(scopeA, {
              stateKind: 'SCENARIO',
              scenarioId: scenario.value.id,
              revisionId: revision.value.id,
              kind: 'EXECUTE',
              replayOfRunId: null,
              fork,
              periods: [Q4],
              fingerprint: `sfp_conformance_${run}_${seq}`,
              modelRef: model,
              createdBy: scopeA.actorId,
              notes: 'conformance',
            });
            assert.ok(simulation.ok, 'scenario run');
            const calc = await calcStore.createRun(scopeA, {
              status: 'COMPLETED',
              triggerType: 'MANUAL',
              context: {
                effectiveAsOf: fork.effectiveAsOf,
                recordedThrough: fork.recordedThrough,
                horizon: 'quarter',
                preference: fork.policy,
                scenarioEntityId: entity.value.entity.id,
                rootNodeIds: [],
                rootMetricKeys: [],
                subjectEntityIds: [],
                engineVersion: ENGINE_VERSION,
                period: Q4,
                scenarioRevisionId: revision.value.id,
              },
              completedAt: new Date().toISOString(),
              replayOfRunId: null,
              notes: 'conformance',
              createdBy: scopeA.actorId,
            });
            assert.ok(calc.ok, 'calculation run');
            const attached = await scenarioStore.attachPeriodRun(scopeA, simulation.value.id, {
              period: Q4,
              calculationRunId: calc.value.id,
            });
            assert.ok(attached.ok, 'attach period run');
            const completed = await scenarioStore.completeRun(scopeA, simulation.value.id, {
              status: 'COMPLETED',
              completeness: 'COMPLETE',
            });
            assert.ok(completed.ok, 'complete scenario run');
            return {
              scenarioId: scenario.value.id,
              scenarioRevisionId: revision.value.id,
              scenarioRunId: simulation.value.id,
            };
          },
          now: () => new Date(),
        };
      },
    },
  );
}
