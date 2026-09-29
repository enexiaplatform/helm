/**
 * The trusted authority service (ADR-0024): what a client can and cannot make
 * it do. Every test drives it the way the edge function does — a verified
 * identity and an untrusted JSON body — over the real Phase 1–6 stack.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asUserId } from '@helm/shared';
import { createAuthorityRuntime, createTrustedAuthorityService, TrustedErrors } from '../src/index.ts';
import { ADMIN, ORG_A, ORG_B, USERS, buildGovernanceStack, commitCanonical, unwrap } from './harness.mjs';

const STRANGER = asUserId('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
const OUTSIDER = asUserId('dddddddd-dddd-4ddd-8ddd-dddddddddddd');

/** The service over the stack's stores, as the edge function builds it over Postgres. */
function trustedOver(stack, overrides = {}) {
  const runtime = createAuthorityRuntime({
    store: stack.authorityStore,
    decisions: stack.decisionStore,
    scenarios: overrides.scenarios ?? stack.scenarios,
    graph: stack.graph,
    clock: stack.clock,
    evaluator: { kind: 'TRUSTED_SERVICE', host: 'test' },
  });
  return createTrustedAuthorityService({
    runtime,
    store: stack.authorityStore,
    decisions: stack.decisionStore,
    scenarios: overrides.scenarios ?? stack.scenarios,
    engine: overrides.engine ?? stack.engine,
    registry: stack.registry,
    valueGraph: overrides.valueGraph ?? stack.valueGraph,
    membershipOf: async (userId, orgId) => {
      if (orgId !== ORG_A || userId === STRANGER) return { ok: true, value: null };
      return { ok: true, value: { orgRole: userId === ADMIN ? 'admin' : 'member', memberUnitIds: [] } };
    },
    callerCanSeeDecision: async (scope) => ({ ok: true, value: scope.actorId !== OUTSIDER }),
  });
}

async function canonical() {
  const stack = await buildGovernanceStack();
  const built = await commitCanonical(stack);
  return { stack, built, service: trustedOver(stack) };
}

const evaluate = (commitmentId) => ({ op: 'evaluate', orgId: ORG_A, commitmentId });

describe('the trusted authority service evaluates from HELM\'s own records', () => {
  it('evaluates the canonical commitment, re-derives its consequences first, and stamps the verdict TRUSTED_SERVICE', async () => {
    const { stack, built, service } = await canonical();
    // Asked by the Country GM — the verdict is still about the Commercial Director who committed.
    const res = await service.handle({ userId: USERS.countryGM }, evaluate(built.commitment.id));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const e = res.body.evaluation;
    assert.equal(e.result, 'REQUIRES_APPROVAL');
    assert.equal(e.actorUserId, USERS.commercialDirector, 'the actor is the recorded committer, not the caller');
    assert.equal(e.evaluator.kind, 'TRUSTED_SERVICE');
    assert.equal(e.evaluator.consequenceCheck.status, 'TRACE_VERIFIED');
    assert.ok(e.evaluator.consequenceCheck.checkedSteps >= 10, `re-derived ${e.evaluator.consequenceCheck.checkedSteps} steps`);
    const cash = e.consequences.find((c) => c.metricKey === 'CashImpact');
    assert.equal(cash.value, '-1735500000', 'the consequence came from the chosen run');
    assert.equal(res.body.required[0].roleLabel, 'Country GM Vietnam');
    const stored = unwrap(await stack.authority.listEvaluations(stack.scope, { commitmentId: built.commitment.id }), 'list');
    assert.equal(stored.length, 1);
  });

  it('refuses a request that supplies a consequence value, and records nothing', async () => {
    const { stack, built, service } = await canonical();
    const res = await service.handle({ userId: USERS.commercialDirector }, { ...evaluate(built.commitment.id), cashImpact: '-700000000' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, TrustedErrors.CLIENT_SUPPLIED_FACTS);
    assert.deepEqual(res.body.error.refusedFields, ['cashImpact']);
    const stored = unwrap(await stack.authority.listEvaluations(stack.scope, { commitmentId: built.commitment.id }), 'list');
    assert.equal(stored.length, 0, 'a refused request writes no evaluation');
  });

  for (const [what, field, value] of [
    ['a role', 'role', 'COUNTRY_GM'],
    ['an actor', 'actorUserId', USERS.countryGM],
    ['a scope', 'scope', { touched: [] }],
    ['a policy', 'policyId', 'meridian-vn-doa@2'],
    ['consequences', 'consequences', [{ metricKey: 'CashImpact', value: '-1' }]],
    ['an evaluator', 'evaluator', { kind: 'TRUSTED_SERVICE' }],
  ]) {
    it(`refuses a request that supplies ${what}`, async () => {
      const { built, service } = await canonical();
      const res = await service.handle({ userId: USERS.commercialDirector }, { ...evaluate(built.commitment.id), [field]: value });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, TrustedErrors.CLIENT_SUPPLIED_FACTS);
      assert.deepEqual(res.body.error.refusedFields, [field]);
    });
  }

  it('takes the approver from the verified identity: a body cannot name one, and the committer cannot approve their own commitment', async () => {
    const { built, service } = await canonical();
    const evaluated = await service.handle({ userId: USERS.countryGM }, evaluate(built.commitment.id));
    const requirementId = evaluated.body.required[0].id;

    const spoofed = await service.handle(
      { userId: USERS.commercialDirector },
      { op: 'approve', orgId: ORG_A, requiredApprovalId: requirementId, comments: 'Approved.', approverUserId: USERS.countryGM },
    );
    assert.equal(spoofed.status, 400);
    assert.deepEqual(spoofed.body.error.refusedFields, ['approverUserId']);

    const self = await service.handle({ userId: USERS.commercialDirector }, { op: 'approve', orgId: ORG_A, requiredApprovalId: requirementId, comments: 'Approved.' });
    assert.equal(self.status, 409);
    assert.equal(self.body.error.code, 'authority.separation_of_duties');

    const gm = await service.handle({ userId: USERS.countryGM }, { op: 'approve', orgId: ORG_A, requiredApprovalId: requirementId, comments: 'Approved.' });
    assert.equal(gm.status, 200, JSON.stringify(gm.body));
    assert.equal(gm.body.act.approverUserId, USERS.countryGM);
    assert.equal(gm.body.act.approverLabel, 'Nguyen Thi Mai');
  });

  it('refuses an unauthenticated caller, a non-member, a caller who cannot see the decision, and an unknown operation', async () => {
    const { built, service } = await canonical();
    assert.equal((await service.handle(null, evaluate(built.commitment.id))).status, 401);
    const stranger = await service.handle({ userId: STRANGER }, evaluate(built.commitment.id));
    assert.equal(stranger.status, 403);
    const otherOrg = await service.handle({ userId: USERS.countryGM }, { op: 'evaluate', orgId: ORG_B, commitmentId: built.commitment.id });
    assert.equal(otherOrg.status, 403, 'membership is checked against the named organization');
    const outsider = await service.handle({ userId: OUTSIDER }, evaluate(built.commitment.id));
    assert.equal(outsider.status, 404, 'a decision the caller cannot see does not exist to them');
    assert.equal((await service.handle({ userId: USERS.countryGM }, { op: 'authorize', orgId: ORG_A })).status, 400);
    assert.equal((await service.handle({ userId: USERS.countryGM }, 'evaluate')).status, 400);
  });
});

describe('a tampered future is caught before authority is judged', () => {
  it('refuses a run whose recorded output does not re-derive from its inputs', async () => {
    const stack = await buildGovernanceStack();
    const built = await commitCanonical(stack);
    // A client edited the stored trace: the cash impact now reads −700M.
    const engine = {
      ...stack.engine,
      getTrace: async (scope, runId) => {
        const t = await stack.engine.getTrace(scope, runId);
        if (!t.ok) return t;
        return { ok: true, value: t.value.map((s) => (s.outputMetricKey === 'CashImpact' ? { ...s, outputValue: '-700000000' } : s)) };
      },
    };
    const service = trustedOver(stack, { engine });
    const res = await service.handle({ userId: USERS.countryGM }, evaluate(built.commitment.id));
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, TrustedErrors.CONSEQUENCES_UNVERIFIED);
    assert.ok(res.body.error.problems.some((p) => /CashImpact/.test(p) && /-700000000/.test(p)), res.body.error.problems.join('\n'));
    const stored = unwrap(await stack.authority.listEvaluations(stack.scope, { commitmentId: built.commitment.id }), 'list');
    assert.equal(stored.length, 0, 'no verdict is recorded on an unverified future');
    const timeline = unwrap(await stack.decisionStore.listEvents(stack.scope, built.decision.id), 'events');
    assert.ok(timeline.some((e) => e.eventType === 'AUTHORITY_REFUSED'), 'the refusal is on the decision timeline');
  });

  it('refuses a run whose source input no longer matches the stored observation', async () => {
    const stack = await buildGovernanceStack();
    const built = await commitCanonical(stack);
    const unitCost = stack.nodeIds.unitCost;
    const valueGraph = {
      ...stack.valueGraph,
      getObservations: async (scope, q) => {
        const r = await stack.valueGraph.getObservations(scope, q);
        if (!r.ok || q.nodeId !== unitCost) return r;
        return { ok: true, value: r.value.map((o) => (o.observationType === 'ACTUAL' ? { ...o, numericValue: 150000000 } : o)) };
      },
    };
    const res = await trustedOver(stack, { valueGraph }).handle({ userId: USERS.countryGM }, evaluate(built.commitment.id));
    assert.equal(res.status, 422);
    assert.ok(res.body.error.problems.some((p) => /150000000/.test(p)), res.body.error.problems.join('\n'));
  });

  it('refuses a run that applies an override the sealed revision does not state', async () => {
    const stack = await buildGovernanceStack();
    const built = await commitCanonical(stack);
    const scenarios = {
      ...stack.scenarios,
      listOverrides: async (scope, revisionId) => {
        const r = await stack.scenarios.listOverrides(scope, revisionId);
        if (!r.ok) return r;
        return { ok: true, value: r.value.map((o) => (o.metricKey === 'Opex' ? { ...o, value: '5000000' } : o)) };
      },
    };
    const res = await trustedOver(stack, { scenarios }).handle({ userId: USERS.countryGM }, evaluate(built.commitment.id));
    assert.equal(res.status, 422);
    assert.ok(res.body.error.problems.some((p) => /revision states ADD 5000000/.test(p)), res.body.error.problems.join('\n'));
  });

  it('a verdict computed by the client runtime is labelled CLIENT_RUNTIME, never TRUSTED_SERVICE', async () => {
    const stack = await buildGovernanceStack();
    const built = await commitCanonical(stack);
    const e = unwrap(await stack.authority.evaluate(stack.scope, built.commitment.id), 'client evaluate').evaluation;
    assert.equal(e.evaluator.kind, 'CLIENT_RUNTIME');
    assert.equal(e.evaluator.consequenceCheck.status, 'NOT_CHECKED');
  });
});
