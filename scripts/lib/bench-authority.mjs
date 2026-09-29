/**
 * Phase 6 performance, measured in memory over the canonical Meridian stack.
 * Run with: node scripts/lib/bench-authority.mjs
 *
 * It measures the authority layer's own work: evaluation, scope resolution,
 * threshold evaluation, approval recording and the explain traversal.
 * Postgres numbers are NOT produced here and are not guessed.
 */

import { checkConditions, evaluateAuthority, resolveCommitmentScope } from '@helm/authority-runtime';
import { buildAuthorityStack, unwrap, USERS } from './authorityStack.mjs';

const ms = (t) => `${(Number(t) / 1e6).toFixed(2)} ms`;
const time = async (label, fn, n = 1) => {
  const t0 = process.hrtime.bigint();
  let last;
  for (let i = 0; i < n; i += 1) last = await fn(i);
  const total = process.hrtime.bigint() - t0;
  console.log(`${label.padEnd(58)} ${ms(total).padStart(10)}${n > 1 ? `  (${ms(total / BigInt(n))} each)` : ''}`);
  return last;
};

const start = process.hrtime.bigint();
const stack = await buildAuthorityStack();
console.log(`${'stack build (graph, values, 8 scenarios, governance seed)'.padEnd(58)} ${ms(process.hrtime.bigint() - start).padStart(10)}`);
const { authority, scope } = stack;

const canonical = await time('canonical decision committed + classified', () => stack.commitCanonical());
const first = await time('evaluate (assemble + engine + record), first', async () =>
  unwrap(await authority.evaluate(scope, canonical.commitment.id), 'evaluate'),
);
await time('evaluate (re-evaluation, supersedes)', async () => unwrap(await authority.evaluate(scope, canonical.commitment.id), 'evaluate'), 20);

const e = first.evaluation;
await time('scope resolution alone (5 touched entities, graph walk)', async () =>
  unwrap(
    await resolveCommitmentScope(
      stack.graph,
      scope,
      e.scope.touched.map((t) => ({ entityId: t.entityId, origin: t.origin, via: t.via })),
      e.actAt,
    ),
    'scope',
  ), 20);

const rules = unwrap(await authority.listRules(scope), 'rules');
const policies = unwrap(await authority.listPolicies(scope), 'policies');
const occupancies = unwrap(await authority.listOccupancies(scope), 'occupancies');
await time('threshold evaluation alone (every condition of 6 rules)', async () => {
  for (const r of rules) checkConditions(r.conditions, e.consequences);
}, 200);
await time('pure engine (6 rules, scope and thresholds, no I/O)', async () =>
  evaluateAuthority({
    act: 'COMMIT', actAt: e.actAt, actor: { userId: e.actorUserId, label: e.actorLabel }, committerUserId: e.actorUserId,
    decisionTypeKey: 'INVENTORY_ALLOCATION', knownDecisionTypes: ['INVENTORY_ALLOCATION'], scope: e.scope, consequences: e.consequences,
    policies, rules, occupancies, delegations: [],
  }), 200);

const fresh = unwrap(await authority.evaluate(scope, canonical.commitment.id), 'fresh');
const act = await time('recordApproval (identity, seat, SoD, sequence checks)', async () =>
  unwrap(await authority.recordApproval(stack.as(USERS.countryGM), fresh.required[0].id, { comments: 'Approved.' }), 'approve'),
);
await time('getGovernanceState (projection)', async () => unwrap(await authority.getGovernanceState(scope, canonical.commitment.id), 'state'), 50);
await time('explainApproval (act → … → source observation)', async () => unwrap(await authority.explainApproval(scope, act.id), 'explain'), 20);
