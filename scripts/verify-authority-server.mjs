/**
 * verify:authority-server — the trusted authority path (ADR-0024), executable.
 *
 *   1. The edge function's bundle builds, and the BUNDLED host refuses an
 *      unauthenticated call, every client-supplied fact by name, and a caller
 *      who is not a member — before any store is touched.
 *   2. The trusted service over the real Phase 1–6 stack evaluates the
 *      canonical commitment as TRUSTED_SERVICE, having re-derived the chosen
 *      run's trace; the actor is the committer, whoever asks.
 *   3. A tampered run (an edited output) is refused with no verdict recorded.
 *   4. The approver is the verified identity: a body naming one is refused,
 *      and the committer cannot approve their own commitment.
 *   5. The database takes authority records from the service only: the client
 *      write policies are gone, INSERT is revoked from authenticated, the
 *      evaluator column admits only TRUSTED_SERVICE, and an approver must be a
 *      member.
 *   6. The edge function takes identity from Supabase Auth, never from the body.
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createAuthorityRuntime, createTrustedAuthorityService, TrustedErrors } from '@helm/authority-runtime';
import { buildAuthorityStack, unwrap, USERS } from './lib/authorityStack.mjs';

const failures = [];
const check = (rule, cond, detail) => {
  if (!cond) failures.push({ rule, detail });
};

// 1. the bundle, as the edge function runs it
execFileSync(process.execPath, ['scripts/build-authority-function.mjs'], { stdio: 'pipe' });
const bundlePath = 'supabase/functions/helm-authority/kernel.mjs';
check('bundle', existsSync(bundlePath), 'the edge function bundle was not built');
const { handleAuthorityRequest } = await import(pathToFileURL(bundlePath).href);
check('bundle', typeof handleAuthorityRequest === 'function', 'the bundle does not export handleAuthorityRequest');
let touched = 0;
const chain = (result) => {
  const q = new Proxy({}, {
    get: (_, key) => {
      touched += 1;
      if (key === 'maybeSingle' || key === 'single') return async () => result;
      if (key === 'then') return (resolve) => resolve(result);
      return () => q;
    },
  });
  return q;
};
const fake = (result = { data: null, error: null }) => ({ from: () => chain(result), rpc: async () => result });
const clients = { service: fake(), caller: fake() };
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const anon = await handleAuthorityRequest(clients, null, { op: 'evaluate', orgId: ORG, commitmentId: 'c' });
check('bundle', anon.status === 401, `an unauthenticated call got ${anon.status}`);
for (const field of ['cashImpact', 'consequences', 'role', 'scope', 'policyId', 'actorUserId', 'evaluator']) {
  touched = 0;
  const r = await handleAuthorityRequest(clients, { userId: USERS.countryGM }, { op: 'evaluate', orgId: ORG, commitmentId: 'c', [field]: 'x' });
  check('bundle', r.status === 400 && r.body.error.code === TrustedErrors.CLIENT_SUPPLIED_FACTS && r.body.error.refusedFields.includes(field),
    `a request supplying "${field}" was not refused as a client-supplied fact`);
  check('bundle', touched === 0, `a request supplying "${field}" reached the stores before it was refused`);
}
const spoof = await handleAuthorityRequest(clients, { userId: USERS.commercialDirector }, { op: 'approve', orgId: ORG, requiredApprovalId: 'r', comments: 'ok', approverUserId: USERS.countryGM });
check('bundle', spoof.status === 400 && spoof.body.error.refusedFields?.includes('approverUserId'), 'a body naming its approver was not refused');
const stranger = await handleAuthorityRequest(clients, { userId: USERS.countryGM }, { op: 'evaluate', orgId: ORG, commitmentId: 'c' });
check('bundle', stranger.status === 403, `a caller with no membership got ${stranger.status}`);

// 2–4. the service over the real stack
const stack = await buildAuthorityStack();
const trustedOver = (overrides = {}) =>
  createTrustedAuthorityService({
    runtime: createAuthorityRuntime({ store: stack.authorityStore, decisions: stack.decisionStore, scenarios: stack.scenarios, graph: stack.graph, clock: stack.clock, evaluator: { kind: 'TRUSTED_SERVICE', host: 'contract' } }),
    store: stack.authorityStore,
    decisions: stack.decisionStore,
    scenarios: stack.scenarios,
    engine: overrides.engine ?? stack.engine,
    registry: stack.registry,
    valueGraph: stack.valueGraph,
    membershipOf: async () => ({ ok: true, value: { orgRole: 'member', memberUnitIds: [] } }),
    callerCanSeeDecision: async () => ({ ok: true, value: true }),
  });
const canonical = await stack.commitCanonical();
const service = trustedOver();
const orgId = stack.scope.orgId;
const res = await service.handle({ userId: USERS.financeDirector }, { op: 'evaluate', orgId, commitmentId: canonical.commitment.id });
check('trusted', res.status === 200, `the canonical evaluation returned ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
const e = res.body.evaluation;
check('trusted', e?.evaluator?.kind === 'TRUSTED_SERVICE' && e?.evaluator?.consequenceCheck?.status === 'TRACE_VERIFIED', 'the verdict is not stamped TRUSTED_SERVICE with a verified trace');
check('trusted', (e?.evaluator?.consequenceCheck?.checkedSteps ?? 0) >= 10, 'the chosen run was not re-derived step by step');
check('trusted', e?.actorUserId === USERS.commercialDirector, 'the actor is the caller, not the committer');
check('trusted', e?.result === 'REQUIRES_APPROVAL', `the canonical verdict is ${e?.result}`);
const self = await service.handle({ userId: USERS.commercialDirector }, { op: 'approve', orgId, requiredApprovalId: res.body.required[0].id, comments: 'Approved.' });
check('approver', self.status === 409 && self.body.error.code === 'authority.separation_of_duties', 'the committer approved their own commitment');

const tampered = await buildAuthorityStack();
const tc = await tampered.commitCanonical();
const forgedEngine = {
  ...tampered.engine,
  getTrace: async (scope, runId) => {
    const t = await tampered.engine.getTrace(scope, runId);
    return t.ok ? { ok: true, value: t.value.map((s) => (s.outputMetricKey === 'GrossMarginPct' ? { ...s, outputValue: '45' } : s)) } : t;
  },
};
const forged = await createTrustedAuthorityService({
  runtime: createAuthorityRuntime({ store: tampered.authorityStore, decisions: tampered.decisionStore, scenarios: tampered.scenarios, graph: tampered.graph, clock: tampered.clock, evaluator: { kind: 'TRUSTED_SERVICE', host: 'contract' } }),
  store: tampered.authorityStore,
  decisions: tampered.decisionStore,
  scenarios: tampered.scenarios,
  engine: forgedEngine,
  registry: tampered.registry,
  valueGraph: tampered.valueGraph,
  membershipOf: async () => ({ ok: true, value: { orgRole: 'member', memberUnitIds: [] } }),
  callerCanSeeDecision: async () => ({ ok: true, value: true }),
}).handle({ userId: USERS.countryGM }, { op: 'evaluate', orgId: tampered.scope.orgId, commitmentId: tc.commitment.id });
check('tamper', forged.status === 422 && forged.body.error.code === TrustedErrors.CONSEQUENCES_UNVERIFIED, 'an edited run output was not refused');
const recorded = unwrap(await tampered.authority.listEvaluations(tampered.scope, { commitmentId: tc.commitment.id }), 'evaluations');
check('tamper', recorded.length === 0, 'a verdict was recorded on an unverified future');

// 5. the database
const sql = readFileSync('supabase/migrations/20260929090000_helm_management_twin.sql', 'utf8');
for (const p of ['Scoped record authority evaluations', 'Scoped record required approvals', 'Approvers record their own acts']) {
  check('schema', new RegExp(`DROP\\s+POLICY\\s+IF\\s+EXISTS\\s+"${p}"`).test(sql), `the client write policy "${p}" is not dropped`);
}
check('schema', /REVOKE\s+INSERT,\s*UPDATE,\s*DELETE\s+ON\s+TABLE\s+public\.helm_authority_evaluations,\s*public\.helm_required_approvals,\s*public\.helm_approval_acts\s+FROM\s+authenticated/i.test(sql),
  'INSERT on the authority records is not revoked from authenticated');
check('schema', /evaluator\s+jsonb\s+NOT\s+NULL[\s\S]{0,300}CHECK\s*\(evaluator->>'kind'\s*=\s*'TRUSTED_SERVICE'\)/i.test(sql), 'the evaluator column admits a non-trusted verdict');
check('schema', /helm_approval_acts_member_guard[\s\S]{0,500}organization_memberships[\s\S]{0,120}approver_user_id/i.test(sql), 'an approver is not required to be a member');

// 6. the edge function
const fn = readFileSync('supabase/functions/helm-authority/index.ts', 'utf8');
check('edge', /caller\.auth\.getUser\(\)/.test(fn), 'the edge function does not verify the caller with Supabase Auth');
check('edge', /identity\s*=\s*data\?\.user\s*\?\s*\{\s*userId:\s*data\.user\.id\s*\}/.test(fn), 'the identity is not taken from the verified user');
check('edge', !/body\??\.(userId|actorUserId|approverUserId)/.test(fn), 'the edge function reads an identity from the body');
check('edge', /SUPABASE_SERVICE_ROLE_KEY/.test(fn), 'the edge function does not write as the service');

if (failures.length === 0) {
  console.log('verify:authority-server — ok (bundle refuses 7 client-supplied facts before any read; trusted verdict re-derived; tampered run refused; service-only writes in the schema)');
  process.exit(0);
}
console.error(`verify:authority-server — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
