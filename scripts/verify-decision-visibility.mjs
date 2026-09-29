/**
 * verify:decision-visibility — who may READ a decision, kept apart from who
 * may COMMIT one.
 *
 *   1. The canonical case: a Pharma BU member cannot read an Industrial
 *      decision, an Industrial member cannot read a Pharma decision, and the
 *      Country GM — a member of the country unit — reads both.
 *   2. A cross-functional decision is shared with several units, not copied.
 *   3. Deny by default: no grant means the creator and admins only.
 *   4. The kernel twin and the server-side helper say the same thing: the SQL
 *      helper is subtree-inclusive over org_unit_memberships, admits admins
 *      and the creator, and every decision table reads through it.
 *   5. Visibility is not authority: the visibility module and the authority
 *      engine never import each other, the engine's input has no visibility
 *      field, and a user who can read a decision holds no authority by it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canSeeDecision, MERIDIAN_DEMO_UNITS } from '@helm/authority-runtime';

const root = process.cwd();
const failures = [];
const check = (rule, cond, detail) => {
  if (!cond) failures.push({ rule, detail });
};

const units = MERIDIAN_DEMO_UNITS;
const viewer = (userId, memberUnitIds, orgRole = 'member') => ({ userId, orgRole, memberUnitIds });
const pharma = { createdBy: 'maker', grantedUnitIds: ['unit-vn-pharma'] };
const industrial = { createdBy: 'maker', grantedUnitIds: ['unit-vn-industrial'] };
const userA = viewer('user-a', ['unit-vn-pharma']);
const userB = viewer('user-b', ['unit-vn-industrial']);
const countryGM = viewer('country-gm', ['unit-vn']);

// 1. the canonical three
check('scoped', canSeeDecision(userA, pharma, units).visible, 'user A (Pharma) cannot read the Pharma decision');
check('scoped', !canSeeDecision(userA, industrial, units).visible, 'user A (Pharma) can read the unrelated Industrial decision');
check('scoped', !canSeeDecision(userB, pharma, units).visible, 'user B (Industrial) can read the unrelated Pharma decision');
check('scoped', canSeeDecision(userB, industrial, units).visible, 'user B (Industrial) cannot read the Industrial decision');
check('scoped', canSeeDecision(countryGM, pharma, units).visible && canSeeDecision(countryGM, industrial, units).visible,
  'the Country GM cannot read across the country\'s units');
check('scoped', !canSeeDecision(viewer('regional-peer', ['unit-sea-other']), pharma, units).visible, 'a member of no relevant unit can read it');

// 2. cross-functional
const shared = { createdBy: 'maker', grantedUnitIds: ['unit-vn-pharma', 'unit-vn-finance'] };
check('cross-functional', canSeeDecision(viewer('fd', ['unit-vn-finance']), shared, units).visible, 'Finance cannot read a decision shared with Finance');
check('cross-functional', !canSeeDecision(viewer('fd', ['unit-vn-finance']), pharma, units).visible, 'Finance can read a Pharma decision not shared with it');

// 3. deny by default
const ungranted = { createdBy: 'maker', grantedUnitIds: [] };
check('deny-default', !canSeeDecision(countryGM, ungranted, units).visible, 'an ungranted decision is visible to members');
check('deny-default', canSeeDecision(viewer('maker', []), ungranted, units).visible, 'the creator cannot read their own decision');
check('deny-default', canSeeDecision(viewer('admin', [], 'admin'), ungranted, units).visible, 'an org admin cannot read it');

// 4. the SQL twin
const sql = readFileSync(join(root, 'supabase', 'migrations', '20260928100000_helm_decision_authority.sql'), 'utf8').replace(/--[^\n]*/g, ' ');
const fn = (name) => new RegExp(`FUNCTION\\s+public\\.${name}\\s*\\([^)]*\\)[\\s\\S]*?AS\\s+\\$fn\\$([\\s\\S]*?)\\$fn\\$`, 'i').exec(sql)?.[1] ?? '';
const unitsFn = fn('helm_visible_org_units');
check('sql', /WITH\s+RECURSIVE/i.test(unitsFn) && /org_unit_memberships/i.test(unitsFn) && /u\.parent_id\s*=\s*r\.id/i.test(unitsFn),
  'helm_visible_org_units is not subtree-inclusive over org_unit_memberships');
check('sql', /m\.user_id\s*=\s*auth\.uid\(\)/i.test(unitsFn), 'helm_visible_org_units is not the caller\'s own memberships');
const see = fn('helm_can_see_decision');
check('sql', /has_org_role\(d\.org_id,\s*'admin'\)/i.test(see) && /d\.created_by\s*=\s*auth\.uid\(\)/i.test(see) && /helm_visible_org_units/i.test(see),
  'helm_can_see_decision does not implement admin ∨ creator ∨ granted unit');
for (const t of [
  'helm_decision_alternatives', 'helm_decision_assumptions', 'helm_actions', 'helm_decision_revisions', 'helm_decision_criteria',
  'helm_decision_challenges', 'helm_decision_evidence', 'helm_decision_commitments', 'helm_decision_commitment_snapshots',
  'helm_decision_outcome_reviews',
]) {
  const scoped = [...sql.matchAll(/FOREACH\s+t\s+IN\s+ARRAY\s+ARRAY\[([\s\S]*?)\]\s+LOOP([\s\S]*?)END\s+LOOP/gi)].some(
    (m) => m[1].includes(`'${t}'`) && /"Scoped read %s"[\s\S]*?FOR\s+SELECT[\s\S]*?helm_can_see_decision\(decision_id\)/i.test(m[2]),
  );
  check('sql', scoped, `${t} is not read through helm_can_see_decision`);
}
check('sql', /"Scoped read helm_decisions"[\s\S]{0,200}helm_can_see_decision\(id\)/i.test(sql), 'helm_decisions is not read through helm_can_see_decision');
for (const t of ['helm_authority_evaluations', 'helm_required_approvals', 'helm_approval_acts', 'helm_decision_governance_profiles']) {
  check('sql', new RegExp(`ON\\s+public\\.${t}\\s+FOR\\s+SELECT[\\s\\S]{0,160}helm_can_see_decision\\(decision_id\\)`, 'i').test(sql),
    `${t} is not visible exactly where its decision is`);
}

// 4b. Phase 7 moved the helpers into helm_private and re-pointed every policy.
// The EFFECTIVE definitions are those, so they must say the same thing.
const sql7 = readFileSync(join(root, 'supabase', 'migrations', '20260929090000_helm_management_twin.sql'), 'utf8').replace(/--[^\n]*/g, ' ');
const fn7 = (name) => new RegExp(`FUNCTION\\s+helm_private\\.${name}\\s*\\([^)]*\\)[\\s\\S]*?AS\\s+\\$fn\\$([\\s\\S]*?)\\$fn\\$`, 'i').exec(sql7)?.[1] ?? '';
const units7 = fn7('visible_org_units');
check('sql7', /WITH\s+RECURSIVE/i.test(units7) && /u\.parent_id\s*=\s*r\.id/i.test(units7) && /m\.user_id\s*=\s*auth\.uid\(\)/i.test(units7),
  'helm_private.visible_org_units is not the caller\'s subtree-inclusive memberships');
const see7 = fn7('can_see_decision');
check('sql7', /has_org_role\(d\.org_id,\s*'admin'\)/i.test(see7) && /d\.created_by\s*=\s*auth\.uid\(\)/i.test(see7) && /helm_private\.visible_org_units/i.test(see7),
  'helm_private.can_see_decision does not implement admin ∨ creator ∨ granted unit');
for (const t of [
  'helm_decision_alternatives', 'helm_decision_assumptions', 'helm_actions', 'helm_decision_revisions', 'helm_decision_criteria',
  'helm_decision_challenges', 'helm_decision_evidence', 'helm_decision_commitments', 'helm_decision_commitment_snapshots',
  'helm_decision_outcome_reviews',
]) {
  const scoped = [...sql7.matchAll(/FOREACH\s+t\s+IN\s+ARRAY\s+ARRAY\[([\s\S]*?)\]\s+LOOP([\s\S]*?)END\s+LOOP/gi)].some(
    (m) => m[1].includes(`'${t}'`) && /"Scoped read %s"[\s\S]*?FOR\s+SELECT[\s\S]*?helm_private\.can_see_decision\(decision_id\)/i.test(m[2]),
  );
  check('sql7', scoped, `${t} is not re-pointed at helm_private.can_see_decision`);
}
check('sql7', /"Scoped read helm_decisions"[\s\S]{0,200}helm_private\.can_see_decision\(id\)/i.test(sql7), 'helm_decisions is not re-pointed');
check('sql7', /DROP\s+FUNCTION\s+IF\s+EXISTS\s+public\.helm_can_see_decision\(uuid\)/i.test(sql7), 'the exposed public helper was not dropped');

// 5. visibility is not authority
const src = (f) => readFileSync(join(root, 'packages', 'authority-runtime', 'src', f), 'utf8');
check('separate', !/from\s+'\.\/engine\.ts'/.test(src('visibility.ts')), 'the visibility module imports the authority engine');
check('separate', !/from\s+'\.\/visibility\.ts'/.test(src('engine.ts')), 'the authority engine imports the visibility module');
check('separate', !/visib/i.test(/export type EvaluationInput = \{([\s\S]*?)\n\};/.exec(src('engine.ts'))?.[1] ?? 'visib'),
  'the engine\'s input carries visibility — authority would depend on who can see what');
{
  const { evaluateAuthority, scopeOf } = await import('@helm/authority-runtime');
  const e = evaluateAuthority({
    act: 'COMMIT', actAt: '2026-09-19T10:00:00.000Z', actor: { userId: 'finance-director', label: 'FD' }, committerUserId: 'finance-director',
    decisionTypeKey: 'INVENTORY_ALLOCATION', knownDecisionTypes: ['INVENTORY_ALLOCATION'], scope: scopeOf([]), consequences: [],
    policies: [], rules: [], occupancies: [], delegations: [],
  });
  check('separate', e.result !== 'AUTHORIZED', 'reading a decision conferred authority over it');
}

if (failures.length === 0) {
  console.log(
    'verify:decision-visibility — ok (Pharma member ✗ Industrial, Industrial member ✗ Pharma, Country GM ✓ both; shared not copied; ' +
      'deny by default; SQL helper subtree-inclusive on every decision table, now in helm_private; visibility and authority never import each other)',
  );
  process.exit(0);
}
console.error(`verify:decision-visibility — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
