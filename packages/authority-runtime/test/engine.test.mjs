/**
 * The pure Authority Engine, against hand-built inputs.
 *
 * No graph, no scenarios: every scope and consequence is stated here, so each
 * test isolates one rule of the engine — exact thresholds, precedence, scope
 * intersection, unknown data, escalation, delegation bounds.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { asOrgId, asUserId } from '@helm/shared';
import {
  checkCondition,
  evaluateAuthority,
  findAuthorities,
  scopeOf,
  validateDelegation,
  canSeeDecision,
} from '../src/index.ts';

const ORG = asOrgId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const ACT_AT = '2026-09-19T10:00:00.000Z';
const U = {
  cd: asUserId('u-cd'),
  gm: asUserId('u-gm'),
  rmd: asUserId('u-rmd'),
  fd: asUserId('u-fd'),
  analyst: asUserId('u-analyst'),
  nobody: asUserId('u-nobody'),
};
const E = {
  group: { entityId: 'e-group', label: 'Meridian' },
  sea: { entityId: 'e-sea', label: 'Southeast Asia' },
  vn: { entityId: 'e-vn', label: 'Vietnam' },
  th: { entityId: 'e-th', label: 'Thailand' },
  pharma: { entityId: 'e-pharma', label: 'Pharma BU' },
  industrial: { entityId: 'e-industrial', label: 'Industrial BU' },
  thPharma: { entityId: 'e-th-pharma', label: 'Thailand Pharma BU' },
  rohto: { entityId: 'e-rohto', label: 'Rohto Vietnam' },
  other: { entityId: 'e-other', label: 'Other customer' },
};
const R = {
  cd: { kind: 'ROLE', roleId: 'r-cd', label: 'Commercial Director Vietnam' },
  gm: { kind: 'ROLE', roleId: 'r-gm', label: 'Country GM Vietnam' },
  rmd: { kind: 'ROLE', roleId: 'r-rmd', label: 'Regional MD' },
  fd: { kind: 'ROLE', roleId: 'r-fd', label: 'Finance Director Vietnam' },
  analyst: { kind: 'ROLE', roleId: 'r-analyst', label: 'Analyst' },
};

/** A touched entity anchored in the org chain: product → BU → country → region → group. */
const pharmaVn = (label = 'Rohto order', extra = {}) => ({
  entityId: `t-${label}`,
  label,
  entityTypeKey: 'Opportunity',
  origin: 'CONSEQUENCE',
  via: 'test',
  coordinates: { BUSINESS_UNIT: [E.pharma], COUNTRY: [E.vn], REGION: [E.sea], ENTERPRISE: [E.group], ...extra },
  path: [],
});
const at = (label, coordinates) => ({ entityId: `t-${label}`, label, entityTypeKey: 'Opportunity', origin: 'CONSEQUENCE', via: 'test', coordinates, path: [] });

const cash = (value) => ({
  metricKey: 'CashImpact',
  label: 'Cash impact',
  nodeId: 'n-cash',
  nodeLabel: 'Cash Impact — Rohto',
  runId: 'run-1',
  period: null,
  value,
  unit: 'currency',
  currency: 'VND',
  origin: value === null ? 'BLOCKED' : 'COMPUTED',
  source: 'EXPECTED_OUTCOME',
  reason: value === null ? 'BLOCKED: divide by zero' : null,
});
const coverage = (value) => ({ ...cash(value), metricKey: 'DemandCoverage', label: 'Demand coverage', nodeId: 'n-cov', unit: 'percentage', currency: null });
const margin = (value) => ({ ...cash(value), metricKey: 'GrossMarginPct', label: 'Gross margin %', nodeId: 'n-gm', unit: 'percentage', currency: null });

const cashLine = (comparator, threshold) => ({ metricKey: 'CashImpact', label: 'Cash impact', comparator, threshold, unit: 'currency', currency: 'VND' });

const POLICY = {
  id: 'p1', orgId: ORG, key: 'doa', version: 1, title: 'DOA', reference: 'DOA-TEST', source: 'DOA_DOCUMENT', demo: true,
  rationale: 'test policy', validFrom: '2026-01-01T00:00:00.000Z', validTo: null, recordedAt: '2026-01-01T00:00:00.000Z',
  recordedBy: null, supersedesPolicyId: null,
};
let seq = 0;
const rule = (over) => ({
  id: over.id ?? `rule-${(seq += 1)}`,
  orgId: ORG,
  policyId: 'p1',
  key: over.key ?? `rule-${seq}`,
  holder: R.cd,
  effect: 'GRANT',
  decisionTypes: ['INVENTORY_ALLOCATION'],
  acts: ['COMMIT', 'APPROVE'],
  scope: [],
  conditions: [],
  escalationRoleId: null,
  escalationRoleLabel: null,
  approvalIndependence: 'INDEPENDENT_OF_COMMITTER',
  approvalSequence: 1,
  rationale: 'test rule',
  recordedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});
const occupancy = (userId, role, over = {}) => ({
  id: `occ-${userId}-${role.roleId}`, orgId: ORG, roleId: role.roleId, roleLabel: role.label, userId, personEntityId: null,
  personLabel: `person ${userId}`, kind: 'SUBSTANTIVE', validFrom: '2025-01-01T00:00:00.000Z', validTo: null, basis: 'test',
  recordedAt: '2025-01-01T00:00:00.000Z', recordedBy: null, ...over,
});
const OCCUPANCIES = [occupancy(U.cd, R.cd), occupancy(U.gm, R.gm), occupancy(U.rmd, R.rmd), occupancy(U.fd, R.fd), occupancy(U.analyst, R.analyst)];

/** The canonical-shaped policy: CD ≤ 1B in VN Pharma → GM ≤ 3B and coverage ≥ 90 in VN → RMD ≤ 10B in SEA. */
const canonicalRules = (cdLine = '-1000000000') => [
  rule({ key: 'cd', holder: R.cd, acts: ['PREPARE', 'RECOMMEND', 'COMMIT'], scope: [{ dimension: 'COUNTRY', entities: [E.vn] }, { dimension: 'BUSINESS_UNIT', entities: [E.pharma] }], conditions: [cashLine('GTE', cdLine)], escalationRoleId: 'r-gm', escalationRoleLabel: R.gm.label }),
  rule({ key: 'gm', holder: R.gm, scope: [{ dimension: 'COUNTRY', entities: [E.vn] }], conditions: [cashLine('GTE', '-3000000000'), { metricKey: 'DemandCoverage', label: 'Demand coverage', comparator: 'GTE', threshold: '90', unit: 'percentage', currency: null }], escalationRoleId: 'r-rmd', escalationRoleLabel: R.rmd.label }),
  rule({ key: 'rmd', holder: R.rmd, scope: [{ dimension: 'REGION', entities: [E.sea] }], conditions: [cashLine('GTE', '-10000000000')] }),
  rule({ key: 'fd', holder: R.fd, effect: 'REQUIRE_APPROVAL', acts: ['COMMIT'], scope: [{ dimension: 'COUNTRY', entities: [E.vn] }], conditions: [cashLine('LT', '-2000000000')], approvalSequence: 2 }),
  rule({ key: 'analyst', holder: R.analyst, acts: ['PREPARE', 'RECOMMEND'], scope: [{ dimension: 'COUNTRY', entities: [E.vn] }] }),
];

const input = (over = {}) => ({
  act: 'COMMIT',
  actAt: ACT_AT,
  actor: { userId: U.cd, label: 'Tran Van Binh' },
  committerUserId: over.actor?.userId ?? U.cd,
  decisionTypeKey: 'INVENTORY_ALLOCATION',
  knownDecisionTypes: ['INVENTORY_ALLOCATION', 'PRICING'],
  scope: scopeOf([pharmaVn()]),
  consequences: [cash('-1735500000'), coverage('96.8858')],
  policies: [POLICY],
  rules: canonicalRules(),
  occupancies: OCCUPANCIES,
  delegations: [],
  ...over,
});

describe('authority engine — exact thresholds', () => {
  test('999 999 999, 1 000 000 000 and 1 000 000 001 are three different answers', () => {
    const line = cashLine('GTE', '-1000000000');
    assert.equal(checkCondition(line, [cash('-999999999')]).outcome, 'PASS');
    assert.equal(checkCondition(line, [cash('-1000000000')]).outcome, 'PASS', 'the line itself is inside it');
    assert.equal(checkCondition(line, [cash('-1000000001')]).outcome, 'FAIL');
    const upper = cashLine('LTE', '1000000000');
    assert.equal(checkCondition(upper, [cash('999999999')]).outcome, 'PASS');
    assert.equal(checkCondition(upper, [cash('1000000000')]).outcome, 'PASS');
    assert.equal(checkCondition(upper, [cash('1000000001')]).outcome, 'FAIL');
    const strict = cashLine('LT', '1000000000');
    assert.equal(checkCondition(strict, [cash('1000000000')]).outcome, 'FAIL', 'a strict line excludes itself');
  });

  test('no floating ambiguity at scale: a sub-unit difference still decides', () => {
    const line = cashLine('GTE', '-1000000000');
    assert.equal(checkCondition(line, [cash('-1000000000.0000000001')]).outcome, 'FAIL');
    assert.equal(checkCondition(line, [cash('-999999999.9999999999')]).outcome, 'PASS');
  });

  test('the boundary decides the evaluation, not just the condition', () => {
    const r = (v) => evaluateAuthority(input({ consequences: [cash(v), coverage('96')] })).result;
    assert.equal(r('-999999999'), 'AUTHORIZED');
    assert.equal(r('-1000000000'), 'AUTHORIZED');
    assert.equal(r('-1000000001'), 'REQUIRES_APPROVAL');
  });

  test('a BLOCKED value, a missing metric and a foreign currency are UNKNOWN — never a pass', () => {
    const line = cashLine('GTE', '-1000000000');
    assert.equal(checkCondition(line, [cash(null)]).outcome, 'UNKNOWN');
    assert.equal(checkCondition(line, []).outcome, 'UNKNOWN');
    assert.equal(checkCondition(line, [{ ...cash('-5'), currency: 'USD' }]).outcome, 'UNKNOWN');
    const e = evaluateAuthority(input({ consequences: [cash(null), coverage('96')] }));
    assert.equal(e.result, 'INDETERMINATE');
    assert.equal(e.governability, 'NOT_GOVERNABLE');
    assert.ok(e.gaps.some((g) => g.code === 'METRIC_UNAVAILABLE' && g.blocking));
  });
});

describe('authority engine — the canonical shape', () => {
  test('Commercial Director beyond 1.0B → REQUIRES_APPROVAL from the Country GM, independent of the committer', () => {
    const e = evaluateAuthority(input());
    assert.equal(e.result, 'REQUIRES_APPROVAL');
    assert.deepEqual(e.requiredAuthorities.map((r) => r.roleLabel), ['Country GM Vietnam']);
    assert.equal(e.requiredAuthorities[0].independentOfUserId, U.cd);
    const deciding = e.rules.find((r) => r.deciding);
    assert.equal(deciding.ruleKey, 'cd');
    assert.equal(deciding.conditionChecks[0].outcome, 'FAIL');
    assert.ok(e.explanation.some((l) => /Threshold exceeded/.test(l)));
  });

  test('the Country GM committing the same thing is AUTHORIZED — a multi-metric rule, each line explained on its own', () => {
    const e = evaluateAuthority(input({ actor: { userId: U.gm, label: 'Nguyen Thi Mai' }, committerUserId: U.gm }));
    assert.equal(e.result, 'AUTHORIZED');
    const gm = e.rules.find((r) => r.ruleKey === 'gm');
    assert.equal(gm.conditionChecks.length, 2);
    assert.deepEqual(gm.conditionChecks.map((c) => [c.metricKey, c.outcome]), [['CashImpact', 'PASS'], ['DemandCoverage', 'PASS']]);
    for (const c of gm.conditionChecks) assert.match(c.statement, /against a line of/);
  });

  test('multi-metric: one line failing is named, the other still reported as passing', () => {
    const e = evaluateAuthority(input({ actor: { userId: U.gm, label: 'GM' }, committerUserId: U.gm, consequences: [cash('-1735500000'), coverage('85')] }));
    const gm = e.rules.find((r) => r.ruleKey === 'gm');
    assert.deepEqual(gm.conditionChecks.map((c) => c.outcome), ['PASS', 'FAIL']);
    assert.equal(e.result, 'REQUIRES_APPROVAL', 'the excess goes to the Regional MD');
    assert.equal(e.requiredAuthorities[0].roleLabel, 'Regional MD');
  });

  test('beyond the Country GM too → ESCALATED to the Regional MD, with the chain written out', () => {
    const e = evaluateAuthority(input({ consequences: [cash('-4000000000'), coverage('96')] }));
    assert.equal(e.result, 'ESCALATED');
    assert.deepEqual(e.escalationChain.map((s) => [s.roleLabel, s.outcome]), [['Country GM Vietnam', 'EXCEEDED'], ['Regional MD', 'COVERS']]);
    assert.ok(e.requiredAuthorities.some((r) => r.roleLabel === 'Regional MD' && r.kind === 'ESCALATION'));
    assert.ok(e.requiredAuthorities.some((r) => r.roleLabel === 'Finance Director Vietnam' && r.kind === 'MATRIX'), 'the matrix requirement still applies');
  });

  test('beyond every authority the policy names → INDETERMINATE; HELM does not assume a CEO', () => {
    const e = evaluateAuthority(input({ consequences: [cash('-20000000000'), coverage('96')] }));
    assert.equal(e.result, 'INDETERMINATE');
    assert.ok(e.gaps.some((g) => g.code === 'ESCALATION_PATH_MISSING'));
    assert.ok(!e.explanation.join(' ').includes('CEO') || e.explanation.join(' ').includes('does not assume'));
  });

  test('a matrix requirement is parallel to the escalation and ordered by the policy', () => {
    const e = evaluateAuthority(input({ consequences: [cash('-2462250000'), coverage('91.3495')] }));
    assert.equal(e.result, 'REQUIRES_APPROVAL');
    assert.deepEqual(e.requiredAuthorities.map((r) => [r.roleLabel, r.kind, r.sequence]), [
      ['Country GM Vietnam', 'ESCALATION', 1],
      ['Finance Director Vietnam', 'MATRIX', 2],
    ]);
  });

  test('PREPARE and RECOMMEND are not COMMIT', () => {
    const e = evaluateAuthority(input({ actor: { userId: U.analyst, label: 'Analyst' }, committerUserId: U.analyst, consequences: [cash('-1'), coverage('99')] }));
    assert.equal(e.result, 'NOT_AUTHORIZED');
    assert.ok(e.explanation.some((l) => /not COMMIT/.test(l)), e.explanation.join(' | '));
    const found = findAuthorities({ act: 'PREPARE', at: ACT_AT, decisionTypeKey: 'INVENTORY_ALLOCATION', scope: scopeOf([pharmaVn()]), consequences: [], policies: [POLICY], rules: canonicalRules(), occupancies: OCCUPANCIES });
    assert.ok(found.some((h) => h.roleLabel === 'Analyst' && h.covers));
  });
});

describe('authority engine — scope is never flattened', () => {
  test('Vietnam authority does not reach a Thailand commitment, even when the threshold fits', () => {
    const thai = at('Thai order', { BUSINESS_UNIT: [E.thPharma], COUNTRY: [E.th], REGION: [E.sea], ENTERPRISE: [E.group] });
    const e = evaluateAuthority(input({ scope: scopeOf([thai]), consequences: [cash('-500000000'), coverage('96')] }));
    assert.equal(e.result, 'NOT_AUTHORIZED');
    const cd = e.rules.find((r) => r.ruleKey === 'cd');
    assert.equal(cd.conditionChecks[0].outcome, 'PASS', 'the money was within the line');
    assert.equal(cd.scopeChecks.find((s) => s.dimension === 'COUNTRY').outcome, 'OUTSIDE');
    assert.deepEqual(e.authoritiesInScope.map((a) => a.roleLabel), ['Regional MD']);
  });

  test('Vietnam Pharma authority does not reach the Industrial BU, while the country-wide rule does', () => {
    const industrial = at('Industrial order', { BUSINESS_UNIT: [E.industrial], COUNTRY: [E.vn], REGION: [E.sea], ENTERPRISE: [E.group] });
    const e = evaluateAuthority(input({ scope: scopeOf([industrial]), consequences: [cash('-500000000'), coverage('96')] }));
    assert.equal(e.result, 'NOT_AUTHORIZED');
    assert.ok(e.authoritiesInScope.some((a) => a.roleLabel === 'Country GM Vietnam'));
  });

  test('scope intersection: one Pharma entity and one Industrial entity — the Pharma rule covers neither the whole nor half', () => {
    const industrial = at('Industrial stock', { BUSINESS_UNIT: [E.industrial], COUNTRY: [E.vn], REGION: [E.sea] });
    const e = evaluateAuthority(input({ scope: scopeOf([pharmaVn(), industrial]), consequences: [cash('-500000000'), coverage('96')] }));
    assert.equal(e.result, 'NOT_AUTHORIZED');
    const cd = e.rules.find((r) => r.ruleKey === 'cd');
    assert.match(cd.scopeChecks.find((s) => s.dimension === 'BUSINESS_UNIT').statement, /Industrial stock/);
  });

  test('a regional pool sits above Vietnam: a country rule does not reach it', () => {
    const pool = at('Regional inventory pool', { REGION: [E.sea], ENTERPRISE: [E.group] });
    const e = evaluateAuthority(input({ actor: { userId: U.gm, label: 'GM' }, committerUserId: U.gm, scope: scopeOf([pharmaVn(), pool]), consequences: [cash('-500000000'), coverage('96')] }));
    const gm = e.rules.find((r) => r.ruleKey === 'gm');
    assert.equal(gm.scopeChecks[0].outcome, 'OUTSIDE');
    assert.match(gm.scopeChecks[0].statement, /sits above country level/);
    assert.equal(e.result, 'NOT_AUTHORIZED');
  });

  test('an entity the graph cannot place makes the scope unknown → INDETERMINATE, never allowed', () => {
    const e = evaluateAuthority(input({ scope: scopeOf([pharmaVn()], ['Mystery cost sits in no dimension HELM can place']) }));
    assert.equal(e.result, 'INDETERMINATE');
    assert.ok(e.gaps.some((g) => g.code === 'SCOPE_UNRESOLVED'));
    const floating = at('Floating', { CUSTOMER: [E.rohto] });
    const f = evaluateAuthority(input({ scope: scopeOf([floating]), consequences: [cash('-5'), coverage('99')] }));
    assert.equal(f.result, 'INDETERMINATE', 'a customer with no country is an unknown country, not "outside Vietnam"');
  });
});

describe('authority engine — precedence', () => {
  const vnPricing = (over) => rule({ decisionTypes: ['PRICING'], acts: ['COMMIT'], scope: [{ dimension: 'COUNTRY', entities: [E.vn] }], ...over });

  test('an explicit exception beats the grant: a named strategic account needs the Country GM', () => {
    const rules = [
      vnPricing({ key: 'cd-pricing', holder: R.cd, conditions: [cashLine('GTE', '-1000000000')], escalationRoleId: 'r-gm', escalationRoleLabel: R.gm.label }),
      vnPricing({ key: 'rohto-exception', effect: 'RESTRICT', holder: R.cd, scope: [{ dimension: 'CUSTOMER', entities: [E.rohto] }], escalationRoleId: 'r-gm', escalationRoleLabel: R.gm.label }),
      vnPricing({ key: 'gm-pricing', holder: R.gm, acts: ['COMMIT', 'APPROVE'] }),
    ];
    const withRohto = evaluateAuthority(input({ decisionTypeKey: 'PRICING', rules, scope: scopeOf([pharmaVn('Rohto deal', { CUSTOMER: [E.rohto] })]), consequences: [cash('-10')] }));
    assert.equal(withRohto.result, 'REQUIRES_APPROVAL');
    assert.equal(withRohto.requiredAuthorities[0].kind, 'RESTRICTION');
    const other = evaluateAuthority(input({ decisionTypeKey: 'PRICING', rules, scope: scopeOf([pharmaVn('Other deal', { CUSTOMER: [E.other] })]), consequences: [cash('-10')] }));
    assert.equal(other.result, 'AUTHORIZED', 'the exception touches only Rohto');
  });

  test('the more specific grant decides over the broader one — in either insertion order', () => {
    const broad = rule({ key: 'cd-country', holder: R.cd, acts: ['COMMIT'], scope: [{ dimension: 'COUNTRY', entities: [E.vn] }], conditions: [cashLine('GTE', '-5000000000')], escalationRoleId: 'r-gm', escalationRoleLabel: R.gm.label });
    const narrow = rule({ key: 'cd-pharma', holder: R.cd, acts: ['COMMIT'], scope: [{ dimension: 'COUNTRY', entities: [E.vn] }, { dimension: 'BUSINESS_UNIT', entities: [E.pharma] }], conditions: [cashLine('GTE', '-500000000')], escalationRoleId: 'r-gm', escalationRoleLabel: R.gm.label });
    const gm = canonicalRules().find((r) => r.key === 'gm');
    for (const rules of [[broad, narrow, gm], [gm, narrow, broad]]) {
      const e = evaluateAuthority(input({ rules, consequences: [cash('-1000000000'), coverage('96')] }));
      assert.equal(e.rules.find((r) => r.deciding).ruleKey, 'cd-pharma');
      assert.equal(e.result, 'REQUIRES_APPROVAL', 'the narrower 0.5B line decides, not the broader 5B one');
    }
  });

  test('two equally specific rules that disagree are a conflict → INDETERMINATE, not first-wins', () => {
    const a = rule({ key: 'a', holder: R.cd, acts: ['COMMIT'], scope: [{ dimension: 'COUNTRY', entities: [E.vn] }], conditions: [cashLine('GTE', '-5000000000')] });
    const b = rule({ key: 'b', holder: R.cd, acts: ['COMMIT'], scope: [{ dimension: 'COUNTRY', entities: [E.vn] }], conditions: [cashLine('GTE', '-500000000')] });
    for (const rules of [[a, b], [b, a]]) {
      const e = evaluateAuthority(input({ rules, consequences: [cash('-1000000000')] }));
      assert.equal(e.result, 'INDETERMINATE');
      assert.ok(e.gaps.some((g) => g.code === 'RULE_CONFLICT'));
    }
  });
});

describe('authority engine — unknown governance data', () => {
  test('no decision type, an unknown one, no actor, no role, no policy: each INDETERMINATE with the field named', () => {
    const cases = [
      [{ decisionTypeKey: null }, 'DECISION_TYPE_UNMAPPED'],
      [{ decisionTypeKey: 'CAPEX' }, 'DECISION_TYPE_UNMAPPED'],
      [{ actor: { userId: null, label: 'unknown' }, committerUserId: null }, 'ACTOR_UNKNOWN'],
      [{ actor: { userId: U.nobody, label: 'Nobody' }, committerUserId: U.nobody }, 'ACTOR_ROLE_MISSING'],
      [{ policies: [] }, 'NO_POLICY_IN_FORCE'],
      [{ decisionTypeKey: 'PRICING' }, 'NO_RULE_FOR_DECISION_TYPE'],
    ];
    for (const [over, code] of cases) {
      const e = evaluateAuthority(input(over));
      assert.equal(e.result, 'INDETERMINATE', `${code} should be INDETERMINATE`);
      assert.ok(e.gaps.some((g) => g.code === code && g.blocking), `${code} not named`);
      assert.equal(e.requiredAuthorities.length, 0);
    }
  });

  test('a vacant approving seat is named as a gap, without hiding the requirement', () => {
    const e = evaluateAuthority(input({ occupancies: OCCUPANCIES.filter((o) => o.userId !== U.gm) }));
    assert.equal(e.result, 'REQUIRES_APPROVAL');
    assert.ok(e.gaps.some((g) => g.code === 'NO_CURRENT_OCCUPANT' && !g.blocking));
    assert.equal(e.governability, 'GOVERNABLE_WITH_GAPS');
  });
});

describe('authority engine — time', () => {
  test('a policy not yet recorded at the act does not reach it, even if back-dated', () => {
    const late = { ...POLICY, recordedAt: '2026-09-20T00:00:00.000Z' };
    const e = evaluateAuthority(input({ policies: [late] }));
    assert.equal(e.result, 'INDETERMINATE');
    assert.ok(e.gaps.some((g) => g.code === 'NO_POLICY_IN_FORCE'));
  });

  test('the version in force is the latest validFrom at the act; earlier versions are not edited', () => {
    const v2 = { ...POLICY, id: 'p2', version: 2, reference: 'DOA-V2', validFrom: '2026-10-01T00:00:00.000Z', recordedAt: '2026-09-01T00:00:00.000Z' };
    const rules = [...canonicalRules(), ...canonicalRules('-2000000000').map((r) => ({ ...r, id: `${r.id}-v2`, policyId: 'p2' }))];
    const sept = evaluateAuthority(input({ policies: [POLICY, v2], rules }));
    assert.equal(sept.result, 'REQUIRES_APPROVAL');
    assert.deepEqual(sept.policies.map((p) => p.version), [1]);
    const oct = evaluateAuthority(input({ policies: [POLICY, v2], rules, actAt: '2026-10-03T10:00:00.000Z' }));
    assert.equal(oct.result, 'AUTHORIZED');
    assert.deepEqual(oct.policies.map((p) => p.version), [2]);
  });

  test('an acting occupancy carries the seat\'s authority; one that ended does not', () => {
    const acting = occupancy(U.cd, R.gm, { id: 'occ-acting', kind: 'ACTING', validFrom: '2026-09-15T00:00:00.000Z', validTo: '2026-09-25T00:00:00.000Z', recordedAt: '2026-09-15T00:00:00.000Z' });
    const inside = evaluateAuthority(input({ occupancies: [...OCCUPANCIES, acting] }));
    assert.equal(inside.result, 'AUTHORIZED');
    assert.ok(inside.actorRoles.some((r) => r.kind === 'ACTING'));
    const after = evaluateAuthority(input({ occupancies: [...OCCUPANCIES, acting], actAt: '2026-09-26T00:00:00.000Z' }));
    assert.equal(after.result, 'REQUIRES_APPROVAL');
  });
});

describe('authority engine — delegation', () => {
  const delegation = (over = {}) => ({
    id: 'del-1', orgId: ORG, delegatorUserId: U.gm, delegatorLabel: 'Nguyen Thi Mai', delegatorRoleId: 'r-gm', delegatorRoleLabel: R.gm.label,
    delegateUserId: U.cd, delegateLabel: 'Tran Van Binh', decisionTypes: ['INVENTORY_ALLOCATION'], acts: ['COMMIT'],
    scope: [{ dimension: 'COUNTRY', entities: [E.vn] }, { dimension: 'BUSINESS_UNIT', entities: [E.pharma] }],
    conditions: [cashLine('GTE', '-2000000000')], validFrom: '2026-09-15T00:00:00.000Z', validTo: '2026-09-25T00:00:00.000Z',
    reason: 'Country GM on leave', recordedAt: '2026-09-14T00:00:00.000Z', revokedAt: null, revokedReason: null, ...over,
  });

  test('inside its window and limits a delegation authorizes; the basis says so', () => {
    const e = evaluateAuthority(input({ delegations: [delegation()] }));
    assert.equal(e.result, 'AUTHORIZED');
    assert.equal(e.basisDelegationId, 'del-1');
    assert.equal(e.delegations[0].outcome, 'APPLIED');
  });

  test('outside its window, above its line, outside its scope, before it was recorded, after revocation: nothing', () => {
    const cases = [
      [{ actAt: '2026-09-26T00:00:00.000Z' }, {}, 'NOT_VALID_AT_ACT'],
      [{ consequences: [cash('-2462250000'), coverage('96')] }, {}, 'EXCEEDED'],
      [{ scope: scopeOf([at('Industrial', { BUSINESS_UNIT: [E.industrial], COUNTRY: [E.vn], REGION: [E.sea] })]) }, {}, 'OUTSIDE_SCOPE'],
      [{}, { recordedAt: '2026-09-19T11:00:00.000Z' }, 'NOT_RECORDED_AT_ACT'],
      [{}, { revokedAt: '2026-09-18T00:00:00.000Z', revokedReason: 'returned early' }, 'REVOKED'],
      [{}, { acts: ['APPROVE'] }, 'TYPE_OR_ACT_NOT_DELEGATED'],
    ];
    for (const [over, dOver, outcome] of cases) {
      const e = evaluateAuthority(input({ ...over, delegations: [delegation(dOver)] }));
      assert.equal(e.delegations[0].outcome, outcome);
      assert.notEqual(e.result, 'AUTHORIZED', `${outcome} must not authorize`);
      assert.equal(e.basisDelegationId, null);
    }
  });

  test('a delegation lapses when the delegator leaves the seat', () => {
    const left = OCCUPANCIES.map((o) => (o.userId === U.gm ? { ...o, validTo: '2026-09-18T00:00:00.000Z' } : o));
    const e = evaluateAuthority(input({ occupancies: left, delegations: [delegation()] }));
    assert.equal(e.delegations[0].outcome, 'DELEGATOR_NOT_IN_ROLE');
    assert.notEqual(e.result, 'AUTHORIZED');
  });

  test('delegated authority ≤ delegator authority: the intersection decides, never the delegation alone', () => {
    // A delegation claiming a looser line than the GM's own 3B still cannot pass 3B.
    const e = evaluateAuthority(input({ delegations: [delegation({ conditions: [cashLine('GTE', '-9000000000')] })], consequences: [cash('-4000000000'), coverage('96')] }));
    assert.equal(e.delegations[0].outcome, 'EXCEEDED');
    assert.match(e.delegations[0].statement, /3 000 000 000/);
  });

  test('validateDelegation refuses anything the delegator does not hold', () => {
    const ancestry = (id) => ({ 'e-pharma': ['e-pharma', 'e-vn', 'e-sea', 'e-group'], 'e-vn': ['e-vn', 'e-sea', 'e-group'], 'e-sea': ['e-sea', 'e-group'], 'e-industrial': ['e-industrial', 'e-vn', 'e-sea', 'e-group'] })[id] ?? [id];
    const base = {
      delegatorUserId: U.gm, delegatorRoleId: 'r-gm', delegateUserId: U.cd, decisionTypes: ['INVENTORY_ALLOCATION'], acts: ['COMMIT'],
      scope: [{ dimension: 'COUNTRY', entities: [E.vn] }, { dimension: 'BUSINESS_UNIT', entities: [E.pharma] }],
      conditions: [cashLine('GTE', '-2000000000'), { metricKey: 'DemandCoverage', label: 'Demand coverage', comparator: 'GTE', threshold: '90', unit: 'percentage', currency: null }],
      validFrom: '2026-09-25T00:00:00.000Z', validTo: '2026-10-05T00:00:00.000Z', reason: 'Country GM on leave',
    };
    const v = (draft) => validateDelegation({ draft: { ...base, ...draft }, now: ACT_AT, policies: [POLICY], rules: canonicalRules(), occupancies: OCCUPANCIES, ancestry });
    assert.equal(v({}).valid, true, v({}).problems.join('; '));
    assert.equal(v({ scope: [{ dimension: 'REGION', entities: [E.sea] }] }).valid, false, 'regional authority the GM does not possess');
    assert.equal(v({ conditions: [cashLine('GTE', '-5000000000'), base.conditions[1]] }).valid, false, 'a looser cash line');
    assert.equal(v({ conditions: [cashLine('GTE', '-2000000000')] }).valid, false, 'dropping the coverage floor');
    assert.equal(v({ decisionTypes: ['PRICING'] }).valid, false, 'a type the GM holds no rule for');
    assert.equal(v({ acts: ['OVERRIDE_POLICY'] }).valid, false, 'an act the GM does not hold');
    assert.equal(v({ delegatorUserId: U.fd }).valid, false, 'someone not in the seat');
    assert.equal(v({ validTo: base.validFrom }).valid, false, 'no end');
    assert.equal(v({ scope: [{ dimension: 'BUSINESS_UNIT', entities: [E.industrial] }] }).valid, true, 'a narrower scope inside Vietnam');
  });
});

describe('visibility is not authority', () => {
  const units = [
    { id: 'vn', parentId: null, label: 'Vietnam', unitType: 'country' },
    { id: 'pharma', parentId: 'vn', label: 'Pharma', unitType: 'business_unit' },
    { id: 'industrial', parentId: 'vn', label: 'Industrial', unitType: 'business_unit' },
    { id: 'finance', parentId: 'vn', label: 'Finance', unitType: 'department' },
  ];
  const viewer = (userId, memberUnitIds, orgRole = 'member') => ({ userId, orgRole, memberUnitIds });
  const pharmaDecision = { createdBy: 'someone', grantedUnitIds: ['pharma'] };
  const industrialDecision = { createdBy: 'someone', grantedUnitIds: ['industrial'] };

  test('BU members see their own BU, the country GM sees both, an unrelated BU sees neither', () => {
    assert.equal(canSeeDecision(viewer('a', ['pharma']), pharmaDecision, units).visible, true);
    assert.equal(canSeeDecision(viewer('a', ['pharma']), industrialDecision, units).visible, false);
    assert.equal(canSeeDecision(viewer('b', ['industrial']), pharmaDecision, units).visible, false);
    assert.equal(canSeeDecision(viewer('gm', ['vn']), pharmaDecision, units).visible, true);
    assert.equal(canSeeDecision(viewer('gm', ['vn']), industrialDecision, units).visible, true);
  });

  test('a cross-functional decision is shared, not copied; no grant means creator and admins only', () => {
    const shared = { createdBy: 'someone', grantedUnitIds: ['pharma', 'finance'] };
    assert.equal(canSeeDecision(viewer('fd', ['finance']), shared, units).visible, true);
    const ungranted = { createdBy: 'maker', grantedUnitIds: [] };
    assert.equal(canSeeDecision(viewer('x', ['vn']), ungranted, units).visible, false);
    assert.equal(canSeeDecision(viewer('maker', []), ungranted, units).visible, true);
    assert.equal(canSeeDecision(viewer('boss', [], 'admin'), ungranted, units).visible, true);
  });

  test('seeing a decision confers no authority, and authority needs no visibility grant', () => {
    // The Finance Director can see the Pharma decision through the grant, and holds no COMMIT right over it.
    const e = evaluateAuthority(input({ actor: { userId: U.fd, label: 'Le Thi Hoa' }, committerUserId: U.fd }));
    assert.equal(e.result, 'NOT_AUTHORIZED');
    // The engine's input has no visibility field at all.
    assert.equal('visibility' in input(), false);
  });
});
