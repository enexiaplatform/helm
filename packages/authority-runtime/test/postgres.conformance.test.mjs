/**
 * The SAME AuthorityStore conformance suite, against PostgresAuthorityStore.
 *
 * Needs an authenticated session against a Supabase project, which cannot be
 * fabricated here, so it SKIPS with instructions until credentials are given —
 * the same debt the Phase 1–5 Postgres suites carry.
 *
 *   HELM_TEST_SUPABASE_URL=...        # project URL
 *   HELM_TEST_SUPABASE_KEY=...        # anon key (RLS stays enforced)
 *   HELM_TEST_ACCESS_TOKEN=...        # a signed-in user's access token (the approver)
 *   HELM_TEST_ORG_A=<uuid>            # an org that user is an ADMIN of
 *   HELM_TEST_ORG_B=<uuid>            # a second org they are NOT a member of
 *   HELM_TEST_SECOND_USER_ID=<uuid>   # another auth user, member of org A (the committer)
 *   npm test
 *
 * Use a Supabase BRANCH, never production. Governance history is append-only
 * by design, so the suite leaves its rows behind on the branch.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.HELM_TEST_SUPABASE_URL;
const key = process.env.HELM_TEST_SUPABASE_KEY;
const token = process.env.HELM_TEST_ACCESS_TOKEN;
const orgA = process.env.HELM_TEST_ORG_A;
const orgB = process.env.HELM_TEST_ORG_B;
const secondUser = process.env.HELM_TEST_SECOND_USER_ID;

if (!(url && key && token && orgA && orgB && secondUser)) {
  describe('AuthorityStore conformance — PostgresAuthorityStore', () => {
    test('skipped: no test database credentials configured', (t) => {
      t.skip(
        'Set HELM_TEST_SUPABASE_URL / _KEY / _ACCESS_TOKEN / _ORG_A / _ORG_B / _SECOND_USER_ID ' +
          '(against a Supabase branch, not production) to run the Postgres half of the ' +
          'authority store conformance suite. See the header of this file.',
      );
    });
  });
} else {
  const { createClient } = await import('@supabase/supabase-js');
  const { buildSeedRegistry, canonicalKey } = await import('@helm/ontology');
  const { asOrgId, asUserId } = await import('@helm/shared');
  const { createPostgresGraphStore } = await import('@helm/graph-store/postgres');
  const { createPostgresDecisionStore } = await import('@helm/decision-runtime/postgres');
  const { createPostgresAuthorityStore } = await import('../src/postgres.ts');
  const { runAuthorityStoreConformanceSuite } = await import('../src/conformance.ts');

  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData } = await client.auth.getUser(token);
  const actorId = userData?.user?.id;
  assert.ok(actorId, 'HELM_TEST_ACCESS_TOKEN did not resolve to a user');

  const clock = { now: () => new Date() };
  const graphStore = createPostgresGraphStore({ client, registry: buildSeedRegistry(), clock });
  const decisions = createPostgresDecisionStore({ client, clock });
  const mk = (org) => ({ orgId: asOrgId(org), actorId: asUserId(actorId), role: 'admin', orgUnitIds: [], functions: [] });
  const run = `${Date.now()}`;
  let seq = 0;

  runAuthorityStoreConformanceSuite(
    { describe, it: test, assert },
    {
      name: 'PostgresAuthorityStore',
      async create() {
        const scopeA = mk(orgA);
        return {
          store: createPostgresAuthorityStore({ client, clock }),
          scopeA,
          scopeB: mk(orgB),
          /** Real Role entities and a real committed decision, so every foreign key and guard has something true to check. */
          async fixtures() {
            seq += 1;
            const entity = async (type, ref, name) => {
              const r = await graphStore.upsertEntity(scopeA, {
                entityTypeKey: type,
                canonicalKey: canonicalKey('helm', type.toLowerCase(), `authority-conformance-${run}-${seq}-${ref}`),
                name,
                sourceSystem: 'helm',
              });
              assert.ok(r.ok, `${type} entity`);
              return r.value.entity.id;
            };
            const roleId = await entity('Role', 'role-a', 'Conformance role A');
            const otherRoleId = await entity('Role', 'role-b', 'Conformance role B');
            const countryId = await entity('Country', 'country', 'Conformance country');
            const fork = { effectiveAsOf: '2026-09-19T12:00:00.000Z', recordedThrough: new Date(Date.now() - 60_000).toISOString(), policy: 'SOURCE_TRUTH' };
            const decision = await decisions.createDecision(scopeA, {
              title: 'Authority conformance decision',
              managementQuestion: 'How should the conformance position be allocated this quarter?',
              context: '', problem: '', scope: '', triggerType: 'MANUAL', triggerRefs: [], state: 'DRAFT',
              owner: { kind: 'ROLE', label: 'Conformance role A', userId: null }, fork,
              horizon: { decisionDeadline: null, effectiveFrom: null, expectedOutcomeHorizon: null, reviewDate: null },
              objectives: [], reversibility: 'UNASSESSED', reversalWindowDays: null, authorityStatus: 'NOT_EVALUATED',
              createdBy: scopeA.actorId, metadata: {},
            });
            assert.ok(decision.ok, 'decision');
            const revision = await decisions.createRevision(scopeA, {
              decisionId: decision.value.id, revisionNumber: 1, state: 'DRAFT', reason: 'OPENED', basedOnRevisionId: null,
              reconsidersCommitmentId: null, reconsiderationReason: null, fork, notes: null, createdBy: scopeA.actorId,
            });
            assert.ok(revision.ok, 'revision');
            const alternative = await decisions.addAlternative(scopeA, {
              decisionId: decision.value.id, revisionId: revision.value.id, label: 'Hold', description: '', status: 'UNMODELLED',
              scenarioId: null, scenarioRevisionId: null, scenarioRunId: null, unmodelledReason: 'conformance: no scenario',
              sort: 0, createdBy: scopeA.actorId, metadata: {},
            });
            assert.ok(alternative.ok, 'alternative');
            const snapshot = await decisions.createSnapshot(scopeA, {
              decisionId: decision.value.id, revisionId: revision.value.id, capturedAt: new Date().toISOString(), fork, modelRef: null,
              alternatives: [], criterionIds: [], assumptionIds: [], challengeIds: [], evidenceIds: [], criterionEvaluations: [],
              openChallenges: [], fingerprint: `dsn_authority_conformance_${run}_${seq}`,
            });
            assert.ok(snapshot.ok, 'snapshot');
            const fingerprint = `dfp_authority_conformance_${run}_${seq}`;
            const commitment = await decisions.createCommitment(scopeA, {
              decisionId: decision.value.id, revisionId: revision.value.id, chosenAlternativeId: alternative.value.id,
              authorship: 'MANAGEMENT_AUTHORED_DEMO', committedBy: asUserId(secondUser), committedByLabel: 'Committer',
              committedAt: new Date().toISOString(), summary: 'conformance',
              rationale: [{ kind: 'JUDGEMENT', ref: null, label: 'Conformance', statement: 'A fixture commitment for the authority suite.' }],
              acceptedTradeOffs: [], expectedOutcomes: [], reviewTriggers: [], authorityStatus: 'NOT_EVALUATED',
              fingerprint, snapshotId: snapshot.value.id,
            });
            assert.ok(commitment.ok, 'commitment');
            return {
              roleId,
              roleLabel: 'Conformance role A',
              otherRoleId,
              countryId,
              decisionId: decision.value.id,
              commitmentId: commitment.value.id,
              commitmentFingerprint: fingerprint,
              committer: asUserId(secondUser),
              approver: asUserId(actorId),
            };
          },
          now: () => new Date(),
        };
      },
    },
  );
}
