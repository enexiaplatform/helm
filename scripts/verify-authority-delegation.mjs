/**
 * verify:authority-delegation — delegated authority ≤ delegator authority,
 * for a stated time, and never more.
 *
 *   1. A delegation that would reach a scope, a decision type, an act or a
 *      threshold the delegator does not hold is refused when created.
 *   2. Inside its window and its limits, it authorizes — and says so.
 *   3. Outside its window, above its line, outside its scope, before it was
 *      recorded, after it was revoked, or once the delegator has left the
 *      seat, it authorizes nothing.
 *   4. The delegate's effective authority is the INTERSECTION of the
 *      delegation and the delegator's own rule: a delegation claiming more
 *      than the delegator holds still cannot pass the delegator's line.
 *   5. Delegation is not acting: an acting occupancy carries the seat itself.
 */

import { evaluateAuthority } from '@helm/authority-runtime';
import { buildAuthorityStack, unwrap, expectFail, USERS } from './lib/authorityStack.mjs';

const failures = [];
const check = (rule, cond, detail) => {
  if (!cond) failures.push({ rule, detail });
};

const stack = await buildAuthorityStack();
const { authority, scope, entities: E } = stack;
const gm = stack.as(USERS.countryGM);
const cash = (threshold) => ({ metricKey: 'CashImpact', label: 'Cash impact', comparator: 'GTE', threshold, unit: 'currency', currency: 'VND' });
const coverage = { metricKey: 'DemandCoverage', label: 'Demand coverage', comparator: 'GTE', threshold: '90', unit: 'percentage', currency: null };
const leave = (over = {}) => ({
  delegatorRoleId: E.roleGM.entityId,
  delegateUserId: USERS.commercialDirector,
  delegateLabel: 'Tran Van Binh',
  decisionTypes: ['INVENTORY_ALLOCATION'],
  acts: ['COMMIT'],
  scope: [{ dimension: 'COUNTRY', entities: [E.vn] }, { dimension: 'BUSINESS_UNIT', entities: [E.buPharma] }],
  conditions: [cash('-2000000000'), coverage],
  validFrom: '2026-09-19T00:00:00.000Z',
  validTo: '2026-09-30T00:00:00.000Z',
  reason: 'Country GM on annual leave',
  ...over,
});

// 1. refused at creation
for (const [over, what] of [
  [{ scope: [{ dimension: 'REGION', entities: [E.sea] }] }, 'regional authority the Country GM does not possess'],
  [{ conditions: [cash('-5000000000'), coverage] }, 'a cash line looser than the Country GM\'s own 3.0B'],
  [{ conditions: [cash('-2000000000')] }, 'dropping the Country GM\'s 90% coverage floor'],
  [{ decisionTypes: ['PRICING'] }, 'a decision type the Country GM holds no rule for'],
  [{ acts: ['OVERRIDE_POLICY'] }, 'an act the Country GM does not hold'],
  [{ validTo: '2026-09-19T00:00:00.000Z' }, 'a delegation without an end'],
]) {
  const r = await authority.createDelegation(gm, leave(over));
  check('bounded', !r.ok && r.error.code === 'authority.delegation_exceeds_authority', `a delegation of ${what} was accepted`);
}
const stranger = await authority.createDelegation(stack.as(USERS.financeDirector), leave({ delegateUserId: USERS.pharmaAnalyst }));
check('bounded', !stranger.ok, 'someone who does not occupy the Country GM seat delegated its authority');

// 2. inside the window and limits
const delegation = unwrap(await authority.createDelegation(gm, leave()), 'delegation');
const canonical = await stack.commitCanonical();
const inside = unwrap(await authority.evaluate(scope, canonical.commitment.id), 'inside').evaluation;
check('window', inside.result === 'AUTHORIZED' && inside.basisDelegationId === delegation.id, `inside the window the result is ${inside.result}`);
check('window', inside.delegations.find((d) => d.delegationId === delegation.id)?.outcome === 'APPLIED', 'the delegation check is not APPLIED');

// 3. above the delegated line (inside the window)
const alt = await stack.commitProof('alternative-product', 'Alternative analyzer');
const above = unwrap(await authority.evaluate(scope, alt.commitment.id), 'above').evaluation;
check('limit', above.delegations[0]?.outcome === 'EXCEEDED' && above.result !== 'AUTHORIZED', `above the delegated line the result is ${above.result}`);

// outside the delegated scope (inside the window)
const ind = await stack.commitProof('call-off', 'Industrial BU allocation', [E.buIndustrial]);
const outside = unwrap(await authority.evaluate(scope, ind.commitment.id), 'outside scope').evaluation;
check('scope', outside.delegations[0]?.outcome === 'OUTSIDE_SCOPE' && outside.result === 'NOT_AUTHORIZED', `outside the delegated scope the result is ${outside.result}`);

// outside the window
stack.clock.jump(14 * 24 * 3600 * 1000);
const late = await stack.commitCanonical();
const afterWindow = unwrap(await authority.evaluate(scope, late.commitment.id), 'after').evaluation;
check('window', afterWindow.delegations[0]?.outcome === 'NOT_VALID_AT_ACT' && afterWindow.result === 'REQUIRES_APPROVAL',
  `after the window the result is ${afterWindow.result}`);

// revoked, and revoked twice
const second = unwrap(await authority.createDelegation(gm, leave({ validFrom: stack.clock.peek().toISOString(), validTo: '2026-12-31T00:00:00.000Z' })), 'second');
unwrap(await authority.revokeDelegation(gm, second.id, 'Back from leave early'), 'revoke');
expectFail(await authority.revokeDelegation(gm, second.id, 'again'), 'revoke twice');
const afterRevoke = await stack.commitCanonical();
const revoked = unwrap(await authority.evaluate(scope, afterRevoke.commitment.id), 'revoked').evaluation;
check('revoked', revoked.delegations.some((d) => d.delegationId === second.id && d.outcome === 'REVOKED') && revoked.result !== 'AUTHORIZED',
  'a revoked delegation still authorized');

// 4 & 5. intersection, delegator leaving, acting ≠ delegation (pure engine over the real policy)
{
  const policies = unwrap(await authority.listPolicies(scope), 'policies');
  const rules = unwrap(await authority.listRules(scope), 'rules');
  const occupancies = unwrap(await authority.listOccupancies(scope), 'occupancies');
  const base = {
    act: 'COMMIT', actAt: '2026-09-20T10:00:00.000Z', actor: { userId: USERS.commercialDirector, label: 'CD' }, committerUserId: USERS.commercialDirector,
    decisionTypeKey: 'INVENTORY_ALLOCATION', knownDecisionTypes: ['INVENTORY_ALLOCATION'], scope: inside.scope, policies, rules, occupancies,
  };
  const withCash = (v) => [...inside.consequences.filter((c) => c.metricKey !== 'CashImpact'), { ...inside.consequences.find((c) => c.metricKey === 'CashImpact'), value: v }];
  const greedy = { ...delegation, id: 'greedy', conditions: [cash('-9000000000'), coverage], recordedAt: '2026-09-01T00:00:00.000Z', validFrom: '2026-09-01T00:00:00.000Z' };
  const e = evaluateAuthority({ ...base, consequences: withCash('-4000000000'), delegations: [greedy] });
  check('intersection', e.delegations[0].outcome === 'EXCEEDED' && e.result !== 'AUTHORIZED', 'a delegation claiming more than the delegator holds passed the delegator\'s 3.0B line');
  const left = occupancies.map((o) => (o.userId === USERS.countryGM ? { ...o, validTo: '2026-09-20T00:00:00.000Z' } : o));
  const e2 = evaluateAuthority({ ...base, occupancies: left, consequences: withCash('-1735500000'), delegations: [{ ...delegation, recordedAt: '2026-09-01T00:00:00.000Z', validFrom: '2026-09-01T00:00:00.000Z' }] });
  check('seat', e2.delegations[0].outcome === 'DELEGATOR_NOT_IN_ROLE' && e2.result !== 'AUTHORIZED', 'a delegation outlived the delegator\'s seat');
  const notYet = { ...delegation, recordedAt: '2026-09-21T00:00:00.000Z', validFrom: '2026-09-01T00:00:00.000Z' };
  const e3 = evaluateAuthority({ ...base, consequences: withCash('-1735500000'), delegations: [notYet] });
  check('retroactive', e3.delegations[0].outcome === 'NOT_RECORDED_AT_ACT' && e3.result !== 'AUTHORIZED', 'a back-dated delegation authorized an earlier act');
  const acting = { ...occupancies.find((o) => o.userId === USERS.countryGM), id: 'acting', userId: USERS.commercialDirector, personLabel: 'Tran Van Binh', kind: 'ACTING', validFrom: '2026-09-15T00:00:00.000Z', recordedAt: '2026-09-15T00:00:00.000Z' };
  const e4 = evaluateAuthority({ ...base, occupancies: [...occupancies, acting], consequences: withCash('-1735500000'), delegations: [] });
  check('acting', e4.result === 'AUTHORIZED' && e4.basisDelegationId === null && e4.actorRoles.some((r) => r.kind === 'ACTING'),
    'an acting occupancy did not carry the seat\'s own authority, or was confused with a delegation');
}

if (failures.length === 0) {
  console.log(
    'verify:authority-delegation — ok (6 over-reaching delegations refused; inside the window AUTHORIZED; above the line, outside the scope, ' +
      'after the window, after revocation, back-dated or seatless: nothing; effective authority is the intersection; acting ≠ delegation)',
  );
  process.exit(0);
}
console.error(`verify:authority-delegation — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
