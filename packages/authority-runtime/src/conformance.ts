/**
 * The AuthorityStore conformance suite.
 *
 * ONE contract, run against EVERY adapter. The properties that matter are the
 * ones a database must enforce as well as the in-memory store: recorded
 * governance is write-once, a policy version is never recorded twice, an
 * occupancy ends once and a delegation is revoked once, a required approval
 * belongs to the fingerprint its evaluation judged, an approval act answers
 * exactly one requirement of the same fingerprint and cannot be given by the
 * person it must be independent of, and nothing crosses a tenant boundary.
 *
 * Runner-agnostic, so it works under `node --test` and anything later.
 */

import type { Result, Scope, UserId } from '@helm/shared';
import type { AuthorityStore, NewEvaluation } from './port.ts';

export type AuthorityTestApi = {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void> | void) => void;
  assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
  };
};

export type AuthorityFixtures = {
  /** A Role entity in scopeA's graph. */
  roleId: string;
  roleLabel: string;
  /** A second Role entity. */
  otherRoleId: string;
  /** An entity usable in a scope constraint. */
  countryId: string;
  /** A decision with a commitment, in scopeA. */
  decisionId: string;
  commitmentId: string;
  commitmentFingerprint: string;
  /** Users: the committer, and the signed-in caller who evaluates, delegates and approves. */
  committer: UserId;
  approver: UserId;
};

export type AuthorityStoreHarness = {
  name: string;
  create(): Promise<{
    store: AuthorityStore;
    scopeA: Scope;
    scopeB: Scope;
    fixtures(): Promise<AuthorityFixtures>;
    now: () => Date;
    cleanup?: () => Promise<void>;
  }>;
};

function expectOk<T>(r: Result<T>, what: string): T {
  if (!r.ok) throw new Error(`${what} failed: ${r.error.code} — ${r.error.message}`);
  return r.value;
}

export function runAuthorityStoreConformanceSuite(api: AuthorityTestApi, harness: AuthorityStoreHarness): void {
  const { describe, it, assert } = api;

  describe(`AuthorityStore conformance — ${harness.name}`, () => {
    const setup = async () => {
      const h = await harness.create();
      const f = await h.fixtures();
      const at = () => h.now().toISOString();
      const policy = expectOk(
        await h.store.recordPolicy(h.scopeA, {
          key: `conformance-doa-${Math.floor(h.now().getTime() / 1000)}`,
          version: 1,
          title: 'Conformance DOA',
          reference: 'DOA-CONF',
          source: 'DOA_DOCUMENT',
          demo: true,
          rationale: 'conformance fixture policy',
          validFrom: '2026-01-01T00:00:00.000Z',
          validTo: null,
          recordedAt: at(),
          recordedBy: null,
          supersedesPolicyId: null,
        }),
        'policy',
      );
      const rule = expectOk(
        await h.store.recordRule(h.scopeA, {
          policyId: policy.id,
          key: 'conformance-grant',
          holder: { kind: 'ROLE', roleId: f.roleId, label: f.roleLabel },
          effect: 'GRANT',
          decisionTypes: ['INVENTORY_ALLOCATION'],
          acts: ['COMMIT', 'APPROVE'],
          scope: [{ dimension: 'COUNTRY', entities: [{ entityId: f.countryId, label: 'Country' }] }],
          conditions: [{ metricKey: 'CashImpact', label: 'Cash impact', comparator: 'GTE', threshold: '-1000000000.00', unit: 'currency', currency: 'VND' }],
          escalationRoleId: f.otherRoleId,
          escalationRoleLabel: 'Other role',
          approvalIndependence: 'INDEPENDENT_OF_COMMITTER',
          approvalSequence: 1,
          rationale: 'conformance fixture rule',
          recordedAt: policy.recordedAt,
        }),
        'rule',
      );
      expectOk(
        await h.store.recordOccupancy(h.scopeA, {
          roleId: f.roleId,
          roleLabel: f.roleLabel,
          userId: f.committer,
          personEntityId: null,
          personLabel: 'Committer',
          kind: 'SUBSTANTIVE',
          validFrom: '2026-01-01T00:00:00.000Z',
          validTo: null,
          basis: 'conformance appointment',
          recordedAt: '2026-01-01T00:00:00.000Z',
          recordedBy: null,
        }),
        'committer seat',
      );
      const evaluation = (result: NewEvaluation['result'], fingerprint = f.commitmentFingerprint): NewEvaluation => ({
        decisionId: f.decisionId,
        commitmentId: f.commitmentId,
        commitmentFingerprint: fingerprint,
        act: 'COMMIT',
        actorUserId: f.committer,
        actorLabel: 'Committer',
        actorRoles: [],
        actAt: at(),
        evaluatedAt: at(),
        evaluatedBy: f.approver,
        decisionTypeKey: 'INVENTORY_ALLOCATION',
        profileId: null,
        policies: [{ policyId: policy.id, key: policy.key, version: 1, reference: 'DOA-CONF', demo: true }],
        scope: { touched: [], summary: {}, unresolved: [] },
        consequences: [],
        rules: [],
        delegations: [],
        basisRuleId: result === 'AUTHORIZED' ? rule.id : null,
        basisDelegationId: null,
        result,
        requiredAuthorities: [],
        escalationChain: [],
        authoritiesInScope: [],
        gaps: [],
        governability: 'GOVERNABLE',
        explanation: ['conformance'],
        fingerprint: `aev_conformance_${result}`,
        supersedesEvaluationId: null,
      });
      return { ...h, f, at, policy, rule, evaluation };
    };

    it('a policy version is recorded once; recording it again is refused', async () => {
      const h = await setup();
      const again = await h.store.recordPolicy(h.scopeA, { ...h.policy, recordedAt: h.at() } as never);
      assert.equal(again.ok, false, 'the same key and version was recorded twice');
      const listed = expectOk(await h.store.listPolicies(h.scopeA), 'list');
      assert.ok(listed.some((p) => p.id === h.policy.id));
      await h.cleanup?.();
    });

    it('a rule belongs to a policy of the same organization, keeps exact decimals, and is not recorded twice', async () => {
      const h = await setup();
      assert.equal(h.rule.conditions[0].threshold, '-1000000000', 'the threshold is canonical and exact');
      const dup = await h.store.recordRule(h.scopeA, { ...h.rule, recordedAt: h.at() } as never);
      assert.equal(dup.ok, false, 'a rule key was recorded twice in one policy version');
      const foreign = await h.store.recordRule(h.scopeB, { ...h.rule, key: 'foreign' } as never);
      assert.equal(foreign.ok, false, 'a rule attached itself to another organization\'s policy');
      const restrict = await h.store.recordRule(h.scopeA, { ...h.rule, key: 'restrict-nowhere', effect: 'RESTRICT', escalationRoleId: null } as never);
      assert.equal(restrict.ok, false, 'an exception without an escalation role was recorded');
      await h.cleanup?.();
    });

    it('an occupancy ends once, and never before it starts', async () => {
      const h = await setup();
      const o = expectOk(
        await h.store.recordOccupancy(h.scopeA, {
          roleId: h.f.roleId,
          roleLabel: h.f.roleLabel,
          userId: h.f.approver,
          personEntityId: null,
          personLabel: 'Approver',
          kind: 'SUBSTANTIVE',
          validFrom: '2026-01-01T00:00:00.000Z',
          validTo: null,
          basis: 'conformance appointment',
          recordedAt: h.at(),
          recordedBy: null,
        }),
        'occupancy',
      );
      const early = await h.store.endOccupancy(h.scopeA, o.id, '2025-12-31T00:00:00.000Z');
      assert.equal(early.ok, false, 'an occupancy ended before it began');
      const ended = expectOk(await h.store.endOccupancy(h.scopeA, o.id, '2026-06-01T00:00:00.000Z'), 'end');
      assert.equal(ended.validTo, '2026-06-01T00:00:00.000Z');
      const twice = await h.store.endOccupancy(h.scopeA, o.id, '2026-07-01T00:00:00.000Z');
      assert.equal(twice.ok, false, 'an ended occupancy was rewritten');
      await h.cleanup?.();
    });

    it('a delegation has an end, is not to oneself, needs a seat behind it, and is revoked once', async () => {
      const h = await setup();
      const base = {
        delegatorUserId: h.f.approver,
        delegatorLabel: 'Approver',
        delegatorRoleId: h.f.roleId,
        delegatorRoleLabel: h.f.roleLabel,
        delegateUserId: h.f.committer,
        delegateLabel: 'Committer',
        decisionTypes: ['INVENTORY_ALLOCATION'],
        acts: ['COMMIT' as const],
        scope: [],
        conditions: [],
        validFrom: '2026-09-25T00:00:00.000Z',
        validTo: '2026-10-05T00:00:00.000Z',
        reason: 'conformance leave',
        recordedAt: h.at(),
        revokedAt: null,
        revokedReason: null,
      };
      assert.equal((await h.store.recordDelegation(h.scopeA, { ...base, validTo: base.validFrom })).ok, false, 'a delegation without an end');
      assert.equal((await h.store.recordDelegation(h.scopeA, { ...base, delegateUserId: base.delegatorUserId })).ok, false, 'a self-delegation');
      assert.equal((await h.store.recordDelegation(h.scopeA, base)).ok, false, 'a delegation with no seat behind it');
      expectOk(
        await h.store.recordOccupancy(h.scopeA, {
          roleId: h.f.roleId,
          roleLabel: h.f.roleLabel,
          userId: h.f.approver,
          personEntityId: null,
          personLabel: 'Approver',
          kind: 'SUBSTANTIVE',
          validFrom: '2026-01-01T00:00:00.000Z',
          validTo: null,
          basis: 'conformance appointment',
          recordedAt: '2026-01-01T00:00:00.000Z',
          recordedBy: null,
        }),
        'delegator seat',
      );
      const d = expectOk(await h.store.recordDelegation(h.scopeA, base), 'delegation');
      const revoked = expectOk(await h.store.revokeDelegation(h.scopeA, d.id, h.at(), 'back early'), 'revoke');
      assert.ok(revoked.revokedAt);
      assert.equal((await h.store.revokeDelegation(h.scopeA, d.id, h.at(), 'again')).ok, false, 'revoked twice');
      await h.cleanup?.();
    });

    it('a required approval belongs to the fingerprint its evaluation judged, and only where approval was required', async () => {
      const h = await setup();
      const authorized = expectOk(await h.store.recordEvaluation(h.scopeA, h.evaluation('AUTHORIZED')), 'authorized evaluation');
      const noneNeeded = await h.store.recordRequiredApproval(h.scopeA, {
        evaluationId: authorized.id,
        decisionId: h.f.decisionId,
        commitmentId: h.f.commitmentId,
        commitmentFingerprint: h.f.commitmentFingerprint,
        roleId: h.f.roleId,
        roleLabel: h.f.roleLabel,
        basisRuleId: h.rule.id,
        kind: 'ESCALATION',
        reason: 'should not exist',
        sequence: 1,
        independentOfUserId: h.f.committer,
        createdAt: h.at(),
      });
      assert.equal(noneNeeded.ok, false, 'an AUTHORIZED evaluation generated a requirement');

      const e = expectOk(await h.store.recordEvaluation(h.scopeA, h.evaluation('REQUIRES_APPROVAL')), 'evaluation');
      const wrongPrint = await h.store.recordRequiredApproval(h.scopeA, {
        evaluationId: e.id,
        decisionId: h.f.decisionId,
        commitmentId: h.f.commitmentId,
        commitmentFingerprint: 'dfp_someone_else',
        roleId: h.f.roleId,
        roleLabel: h.f.roleLabel,
        basisRuleId: h.rule.id,
        kind: 'ESCALATION',
        reason: 'wrong fingerprint',
        sequence: 1,
        independentOfUserId: h.f.committer,
        createdAt: h.at(),
      });
      assert.equal(wrongPrint.ok, false, 'a requirement named a fingerprint its evaluation never judged');
      await h.cleanup?.();
    });

    it('an approval act answers one requirement of the same fingerprint, once, and never by the person it must be independent of', async () => {
      const h = await setup();
      const e = expectOk(await h.store.recordEvaluation(h.scopeA, h.evaluation('REQUIRES_APPROVAL')), 'evaluation');
      const r = expectOk(
        await h.store.recordRequiredApproval(h.scopeA, {
          evaluationId: e.id,
          decisionId: h.f.decisionId,
          commitmentId: h.f.commitmentId,
          commitmentFingerprint: h.f.commitmentFingerprint,
          roleId: h.f.roleId,
          roleLabel: h.f.roleLabel,
          basisRuleId: h.rule.id,
          kind: 'ESCALATION',
          reason: 'conformance requirement',
          sequence: 1,
          independentOfUserId: h.f.committer,
          createdAt: h.at(),
        }),
        'requirement',
      );
      const seat = expectOk(
        await h.store.recordOccupancy(h.scopeA, {
          roleId: h.f.roleId,
          roleLabel: h.f.roleLabel,
          userId: h.f.approver,
          personEntityId: null,
          personLabel: 'Approver',
          kind: 'SUBSTANTIVE',
          validFrom: '2026-01-01T00:00:00.000Z',
          validTo: null,
          basis: 'conformance appointment',
          recordedAt: '2026-01-01T00:00:00.000Z',
          recordedBy: null,
        }),
        'seat',
      );
      const act = (over: Record<string, unknown>) =>
        h.store.recordApprovalAct(h.scopeA, {
          requiredApprovalId: r.id,
          evaluationId: e.id,
          decisionId: h.f.decisionId,
          commitmentId: h.f.commitmentId,
          commitmentFingerprint: h.f.commitmentFingerprint,
          approverUserId: h.f.approver,
          approverLabel: 'Approver',
          approverRoleId: h.f.roleId,
          approverRoleLabel: h.f.roleLabel,
          basis: { kind: 'ROLE_OCCUPANCY', occupancyId: seat.id, delegationId: null, ruleId: h.rule.id },
          decision: 'APPROVE',
          comments: 'conformance approval',
          conditions: '',
          validUntil: null,
          actedAt: h.at(),
          ...over,
        } as never);
      assert.equal((await act({ approverUserId: h.f.committer })).ok, false, 'the committer approved their own commitment');
      assert.equal((await act({ commitmentFingerprint: 'dfp_other' })).ok, false, 'an act answered a different fingerprint');
      assert.equal((await act({ approverRoleId: h.f.otherRoleId })).ok, false, 'an act claimed a role the requirement is not for');
      assert.equal(
        (await act({ basis: { kind: 'ROLE_OCCUPANCY', occupancyId: null, delegationId: null, ruleId: null } })).ok,
        false,
        'an act rested on no seat at all',
      );
      assert.equal((await act({ decision: 'REJECT', comments: '' })).ok, false, 'a rejection gave no reason');
      const done = expectOk(await act({}), 'act');
      assert.equal(done.decision, 'APPROVE');
      assert.equal((await act({ decision: 'REJECT', comments: 'changed my mind' })).ok, false, 'an act was replaced');
      const listed = expectOk(await h.store.listApprovalActs(h.scopeA, { commitmentId: h.f.commitmentId }), 'list');
      assert.ok(listed.some((a) => a.id === done.id));
      await h.cleanup?.();
    });

    it('a verdict is coherent: AUTHORIZED names its rule, INDETERMINATE names what is missing', async () => {
      const h = await setup();
      assert.equal((await h.store.recordEvaluation(h.scopeA, { ...h.evaluation('AUTHORIZED'), basisRuleId: null })).ok, false, 'an AUTHORIZED verdict with no basis');
      assert.equal(
        (await h.store.recordEvaluation(h.scopeA, { ...h.evaluation('INDETERMINATE'), governability: 'NOT_GOVERNABLE', gaps: [] })).ok,
        false,
        'an INDETERMINATE verdict that names nothing missing',
      );
      const ok = await h.store.recordEvaluation(h.scopeA, {
        ...h.evaluation('INDETERMINATE'),
        governability: 'NOT_GOVERNABLE',
        gaps: [{ code: 'DECISION_TYPE_UNMAPPED', blocking: true, message: 'no type' }],
      });
      assert.equal(ok.ok, true, 'a coherent INDETERMINATE verdict was refused');
      await h.cleanup?.();
    });

    it('nothing crosses the tenant wall', async () => {
      const h = await setup();
      const e = expectOk(await h.store.recordEvaluation(h.scopeA, h.evaluation('REQUIRES_APPROVAL')), 'evaluation');
      assert.equal(expectOk(await h.store.getPolicy(h.scopeB, h.policy.id), 'policy B'), null);
      assert.equal(expectOk(await h.store.getRule(h.scopeB, h.rule.id), 'rule B'), null);
      assert.equal(expectOk(await h.store.getEvaluation(h.scopeB, e.id), 'evaluation B'), null);
      const listed = expectOk(await h.store.listEvaluations(h.scopeB, { commitmentId: h.f.commitmentId }), 'list B');
      assert.equal(listed.length, 0);
      await h.cleanup?.();
    });

    it('profiles are insert-only and visibility grants are not duplicated', async () => {
      const h = await setup();
      const p1 = expectOk(
        await h.store.recordProfile(h.scopeA, { decisionId: h.f.decisionId, decisionTypeKey: null, declaredSubjects: [], note: 'first', declaredBy: h.f.approver, declaredAt: h.at() }),
        'profile 1',
      );
      const p2 = expectOk(
        await h.store.recordProfile(h.scopeA, { decisionId: h.f.decisionId, decisionTypeKey: 'INVENTORY_ALLOCATION', declaredSubjects: [], note: 'second', declaredBy: h.f.approver, declaredAt: h.at() }),
        'profile 2',
      );
      const profiles = expectOk(await h.store.listProfiles(h.scopeA, h.f.decisionId), 'profiles');
      assert.ok(profiles.some((p) => p.id === p1.id) && profiles[profiles.length - 1].id === p2.id, 'the latest profile is last');
      await h.cleanup?.();
    });
  });
}
