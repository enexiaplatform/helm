/**
 * verify:authority-scope — enterprise scope is derived from the graph and
 * never flattened.
 *
 *   1. A commitment's scope is DERIVED: from its consequences and the chosen
 *      scenario's overrides, walking the anchoring edges — nobody types
 *      "Vietnam, Pharma, Rohto". Each touched entity carries its path.
 *   2. Vietnam authority does not reach Thailand — even when the threshold fits.
 *   3. Vietnam Pharma authority does not reach the Vietnam Industrial BU; the
 *      country-wide rule does.
 *   4. Coverage is per touched entity: a commitment spanning Pharma and
 *      Industrial is covered by neither BU rule (scope intersection).
 *   5. An entity anchored above a rule's level (a regional pool under a
 *      country rule) is OUTSIDE it, not "unknown" and not "inside".
 *   6. An entity the graph cannot place makes the result INDETERMINATE.
 *   7. An explicit exception on a named strategic account beats a grant.
 */

import { checkCoverage, evaluateAuthority, scopeOf } from '@helm/authority-runtime';
import { buildAuthorityStack, unwrap, USERS } from './lib/authorityStack.mjs';

const failures = [];
const check = (rule, cond, detail) => {
  if (!cond) failures.push({ rule, detail });
};

const stack = await buildAuthorityStack();
const { authority, scope, entities: E } = stack;

// 1. derived scope
const canonical = await stack.commitCanonical();
const { evaluation } = unwrap(await authority.evaluate(scope, canonical.commitment.id), 'evaluate');
const labels = (d) => (evaluation.scope.summary[d] ?? []).map((r) => r.label);
check('derived', labels('COUNTRY').includes('Vietnam'), 'Vietnam was not derived from the graph');
check('derived', labels('BUSINESS_UNIT').includes('Pharma BU'), 'Pharma BU was not derived from the graph');
check('derived', labels('CUSTOMER').includes('Rohto Vietnam'), 'Rohto was not derived from the graph');
check('derived', evaluation.scope.touched.every((t) => t.origin !== 'DECLARED_SUBJECT'), 'the canonical scope relied on a declared subject');
check('derived', evaluation.scope.touched.some((t) => t.origin === 'CONSEQUENCE') && evaluation.scope.touched.some((t) => t.origin === 'SCENARIO_OVERRIDE'),
  'the scope did not come from both the consequences and the chosen scenario\'s overrides');
check('derived', evaluation.scope.touched.every((t) => t.path.length > 0), 'a touched entity carries no path explaining where it sits');
check('derived', evaluation.scope.touched.some((t) => t.path.some((p) => /is owned by → Pharma BU → belongs to → Vietnam/.test(p))),
  'the path through the portfolio owner to Vietnam is not shown');

// 2. Thailand
const thai = await stack.commitProof('call-off', 'Thailand Pharma allocation', [E.buThPharma]);
const t = unwrap(await authority.evaluate(scope, thai.commitment.id), 'thai').evaluation;
const cdThai = t.rules.find((r) => r.ruleKey === 'commercial-director-inventory-allocation');
check('thailand', t.result === 'NOT_AUTHORIZED', `a Thailand commitment by the Vietnam Commercial Director is ${t.result}`);
check('thailand', cdThai?.conditionChecks[0]?.outcome === 'PASS', 'the proof is weaker than claimed: the threshold did not fit');
check('thailand', cdThai?.scopeChecks.find((s) => s.dimension === 'COUNTRY')?.outcome === 'OUTSIDE', 'the country check did not fail on Thailand');

// 3. Industrial BU
const industrial = await stack.commitProof('call-off', 'Industrial BU allocation', [E.buIndustrial]);
const i = unwrap(await authority.evaluate(scope, industrial.commitment.id), 'industrial').evaluation;
check('business-unit', i.result === 'NOT_AUTHORIZED', `a Vietnam Industrial commitment by the Pharma Commercial Director is ${i.result}`);
check('business-unit', i.rules.find((r) => r.ruleKey === 'commercial-director-inventory-allocation')?.scopeChecks.find((s) => s.dimension === 'BUSINESS_UNIT')?.outcome === 'OUTSIDE',
  'the BU check did not fail on the Industrial BU');
check('business-unit', i.authoritiesInScope.some((a) => a.roleLabel === 'Country GM Vietnam'), 'the country-wide rule does not reach the Industrial BU');

// 4-6. pure coverage semantics over hand-placed entities
const ref = (id, label) => ({ entityId: id, label });
const VN = ref('vn', 'Vietnam');
const SEA = ref('sea', 'Southeast Asia');
const PH = ref('ph', 'Pharma');
const IN = ref('in', 'Industrial');
const touched = (label, coordinates) => ({ entityId: label, label, entityTypeKey: 'Opportunity', origin: 'CONSEQUENCE', via: 'contract', coordinates, path: [] });
const pharmaThing = touched('pharma order', { BUSINESS_UNIT: [PH], COUNTRY: [VN], REGION: [SEA] });
const industrialThing = touched('industrial stock', { BUSINESS_UNIT: [IN], COUNTRY: [VN], REGION: [SEA] });
const pool = touched('regional pool', { REGION: [SEA] });
const pharmaRule = [{ dimension: 'COUNTRY', entities: [VN] }, { dimension: 'BUSINESS_UNIT', entities: [PH] }];
const industrialRule = [{ dimension: 'COUNTRY', entities: [VN] }, { dimension: 'BUSINESS_UNIT', entities: [IN] }];
const outcome = (constraints, things) => {
  const checks = checkCoverage(constraints, scopeOf(things));
  return checks.some((c) => c.outcome === 'OUTSIDE') ? 'OUTSIDE' : checks.some((c) => c.outcome === 'UNKNOWN') ? 'UNKNOWN' : 'WITHIN';
};
check('intersection', outcome(pharmaRule, [pharmaThing, industrialThing]) === 'OUTSIDE', 'a Pharma rule covered a commitment that also touches Industrial');
check('intersection', outcome(industrialRule, [pharmaThing, industrialThing]) === 'OUTSIDE', 'an Industrial rule covered a commitment that also touches Pharma');
check('intersection', outcome([{ dimension: 'COUNTRY', entities: [VN] }], [pharmaThing, industrialThing]) === 'WITHIN', 'the country rule did not cover both BUs');
check('above', outcome([{ dimension: 'COUNTRY', entities: [VN] }], [pharmaThing, pool]) === 'OUTSIDE', 'a regional pool was treated as inside Vietnam');
check('unknown', outcome([{ dimension: 'COUNTRY', entities: [VN] }], [touched('floating', { CUSTOMER: [ref('c', 'Customer')] })]) === 'UNKNOWN',
  'an entity with no place on the org chain was treated as inside or outside rather than unknown');

// 6. unresolved scope → INDETERMINATE
{
  const base = evaluation;
  const e = evaluateAuthority({
    act: 'COMMIT',
    actAt: base.actAt,
    actor: { userId: USERS.commercialDirector, label: 'CD' },
    committerUserId: USERS.commercialDirector,
    decisionTypeKey: 'INVENTORY_ALLOCATION',
    knownDecisionTypes: ['INVENTORY_ALLOCATION'],
    scope: scopeOf(base.scope.touched, ['a cost HELM cannot place']),
    consequences: base.consequences,
    policies: unwrap(await authority.listPolicies(scope), 'policies'),
    rules: unwrap(await authority.listRules(scope), 'rules'),
    occupancies: unwrap(await authority.listOccupancies(scope), 'occupancies'),
    delegations: [],
  });
  check('unknown', e.result === 'INDETERMINATE' && e.gaps.some((g) => g.code === 'SCOPE_UNRESOLVED'), 'an unresolved scope did not make the result INDETERMINATE');
}

// 7. exception beats grant
{
  const policies = unwrap(await authority.listPolicies(scope), 'policies');
  const grant = {
    id: 'x-grant', orgId: scope.orgId, policyId: policies[0].id, key: 'cd-pricing', holder: { kind: 'ROLE', roleId: 'r-cd', label: 'CD' },
    effect: 'GRANT', decisionTypes: ['PRICING'], acts: ['COMMIT'], scope: [{ dimension: 'COUNTRY', entities: [VN] }], conditions: [],
    escalationRoleId: 'r-gm', escalationRoleLabel: 'GM', approvalIndependence: 'INDEPENDENT_OF_COMMITTER', approvalSequence: 1, rationale: 'contract', recordedAt: '2026-01-01T00:00:00.000Z',
  };
  const exception = { ...grant, id: 'x-restrict', key: 'rohto-exception', effect: 'RESTRICT', scope: [{ dimension: 'CUSTOMER', entities: [ref('rohto', 'Rohto')] }] };
  const gm = { ...grant, id: 'x-gm', key: 'gm-pricing', holder: { kind: 'ROLE', roleId: 'r-gm', label: 'GM' }, acts: ['COMMIT', 'APPROVE'], escalationRoleId: null };
  const occ = (userId, roleId) => ({ id: `o-${roleId}`, orgId: scope.orgId, roleId, roleLabel: roleId, userId, personEntityId: null, personLabel: userId, kind: 'SUBSTANTIVE', validFrom: '2025-01-01T00:00:00.000Z', validTo: null, basis: 'x', recordedAt: '2025-01-01T00:00:00.000Z', recordedBy: null });
  const run = (things, rules) =>
    evaluateAuthority({
      act: 'COMMIT', actAt: '2026-09-19T10:00:00.000Z', actor: { userId: 'u-cd', label: 'CD' }, committerUserId: 'u-cd',
      decisionTypeKey: 'PRICING', knownDecisionTypes: ['PRICING'], scope: scopeOf(things), consequences: [],
      policies: [{ ...policies[0], validFrom: '2026-01-01T00:00:00.000Z', recordedAt: '2026-01-01T00:00:00.000Z' }], rules,
      occupancies: [occ('u-cd', 'r-cd'), occ('u-gm', 'r-gm')], delegations: [],
    }).result;
  const rohtoDeal = touched('rohto deal', { COUNTRY: [VN], REGION: [SEA], CUSTOMER: [ref('rohto', 'Rohto')] });
  check('precedence', run([rohtoDeal], [grant, exception, gm]) === 'REQUIRES_APPROVAL', 'the named-account exception did not beat the grant');
  check('precedence', run([rohtoDeal], [gm, exception, grant]) === 'REQUIRES_APPROVAL', 'the outcome depended on insertion order');
  check('precedence', run([touched('other deal', { COUNTRY: [VN], REGION: [SEA], CUSTOMER: [ref('x', 'Other')] })], [grant, exception, gm]) === 'AUTHORIZED',
    'the exception reached a customer it does not name');
}

if (failures.length === 0) {
  console.log(
    'verify:authority-scope — ok (scope derived from the graph with paths; Thailand and Industrial refused though the cash fit; ' +
      'per-entity coverage, never flattened; above-level OUTSIDE; unplaceable INDETERMINATE; the exception beats the grant)',
  );
  process.exit(0);
}
console.error(`verify:authority-scope — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
