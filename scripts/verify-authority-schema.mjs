/**
 * verify:authority-schema — the Phase 6 persistence keeps its promises.
 *
 *   1. Every authority table is org-scoped, RLS-protected and guarded.
 *   2. Governance history is write-once: policies, rules, evaluations,
 *      requirements and approval acts are never updated or deleted; an
 *      occupancy is only ended, a delegation only revoked.
 *   3. No parallel economics: no amount, margin or cash column anywhere in the
 *      authority schema. Thresholds are exact-decimal lines inside a rule.
 *   4. An evaluation judges exactly one commitment fingerprint, by the identity
 *      that committed it; AUTHORIZED names a rule that identity held.
 *   5. An approval act is the caller's own, answers one requirement of the same
 *      fingerprint once, rests on a real seat or delegation, and cannot be given
 *      by the person it must be independent of.
 *   6. The commitment is untouched: Phase 5's authority_status pin stands and
 *      this migration does not alter the commitment table.
 *   7. helm_approval_rules is RETIRED and nothing can write to it.
 *   8. Every decision table's read policy is scoped by helm_can_see_decision —
 *      the Phase 5 "any member reads every decision" gap is closed.
 *   9. Additive: helm_* only, nothing dropped.
 *  10. Both AuthorityStore adapters run the same conformance suite.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const MIGRATION = join(root, 'supabase', 'migrations', '20260928100000_helm_decision_authority.sql');
const PHASE5 = join(root, 'supabase', 'migrations', '20260923100000_helm_decision_runtime.sql');
const failures = [];
const check = (rule, cond, detail) => {
  if (!cond) failures.push({ rule, detail });
};

if (!existsSync(MIGRATION)) {
  console.error('verify:authority-schema — the Phase 6 migration is missing');
  process.exit(1);
}
const raw = readFileSync(MIGRATION, 'utf8');
const sql = raw.replace(/--[^\n]*/g, ' ');

const TABLES = [
  'helm_authority_policies',
  'helm_authority_rules',
  'helm_role_occupancies',
  'helm_delegations',
  'helm_decision_governance_profiles',
  'helm_decision_visibility',
  'helm_authority_evaluations',
  'helm_required_approvals',
  'helm_approval_acts',
];
const WRITE_ONCE = [
  ['helm_authority_policies_guard', 'a policy version'],
  ['helm_authority_rules_guard', 'an authority rule'],
  ['helm_authority_evaluations_guard', 'an authority evaluation'],
  ['helm_required_approvals_guard', 'a required approval'],
  ['helm_approval_acts_guard', 'an approval act'],
];

const tableBody = (name) => {
  const m = new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+public\\.${name}\\s*\\(`, 'i').exec(sql);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < sql.length && depth > 0) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') depth -= 1;
    i += 1;
  }
  return sql.slice(start, i - 1);
};
const functionBody = (name) => {
  const m = new RegExp(`FUNCTION\\s+public\\.${name}\\s*\\([^)]*\\)[\\s\\S]*?AS\\s+\\$fn\\$([\\s\\S]*?)\\$fn\\$`, 'i').exec(sql);
  return m ? m[1] : null;
};
const policy = (name) => {
  const m = new RegExp(`CREATE\\s+POLICY\\s+"${name}"[\\s\\S]*?;`, 'i').exec(sql);
  return m ? m[0] : null;
};

// 1. org scope, RLS, guard
for (const t of TABLES) {
  const body = tableBody(t);
  check('tables', body !== null, `${t} is not created`);
  if (!body) continue;
  check('tables', /org_id\s+uuid\s+NOT\s+NULL/i.test(body), `${t}.org_id must be NOT NULL`);
  check('rls', new RegExp(`ALTER\\s+TABLE\\s+public\\.${t}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i').test(sql), `${t} has no RLS`);
  check('guard', new RegExp(`BEFORE\\s+INSERT\\s+OR\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+public\\.${t}\\b`, 'i').test(sql),
    `${t} has no guard covering INSERT, UPDATE and DELETE`);
}
check('rls', /ALTER\s+TABLE\s+public\.helm_decision_types\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(sql), 'helm_decision_types has no RLS');

// 2. write-once history
for (const [fn, what] of WRITE_ONCE) {
  const g = functionBody(fn) ?? '';
  check('history', /TG_OP\s*<>\s*'INSERT'[\s\S]{0,200}RAISE\s+EXCEPTION/i.test(g), `${what} can be edited or deleted`);
}
for (const t of ['helm_authority_policies', 'helm_authority_rules', 'helm_authority_evaluations', 'helm_required_approvals', 'helm_approval_acts', 'helm_role_occupancies', 'helm_delegations']) {
  const bad = new RegExp(`CREATE\\s+POLICY\\s+"[^"]*"\\s+ON\\s+public\\.${t}\\s+FOR\\s+(DELETE|ALL)`, 'i').exec(sql);
  check('history', !bad, `${t} has a ${bad?.[1]} policy — governance history must not be deletable`);
}
{
  const o = functionBody('helm_role_occupancies_guard') ?? '';
  check('history', /OLD\.valid_to\s+IS\s+NOT\s+NULL[\s\S]{0,160}RAISE\s+EXCEPTION/i.test(o), 'an ended occupancy can be rewritten');
  check('history', /TG_OP\s*=\s*'DELETE'[\s\S]{0,160}RAISE\s+EXCEPTION/i.test(o), 'an occupancy can be deleted');
  const d = functionBody('helm_delegations_guard') ?? '';
  check('history', /OLD\.revoked_at\s+IS\s+NOT\s+NULL[\s\S]{0,160}RAISE\s+EXCEPTION/i.test(d), 'a revoked delegation can be revoked again');
  check('history', /helm_role_occupancies[\s\S]{0,400}delegator_role_id/i.test(d), 'a delegation needs no seat behind it');
  check('versions', /helm_authority_policies_version_once\s+UNIQUE\s*\(\s*org_id\s*,\s*key\s*,\s*version\s*\)/i.test(sql),
    'a policy version can be recorded twice');
}

// 3. no parallel economics
for (const t of TABLES) {
  const body = (tableBody(t) ?? '').toLowerCase();
  for (const word of ['amount', 'approval_margin', 'approval_cash', 'cash_impact', 'margin_pct', 'revenue']) {
    check('no-typed-economics', !new RegExp(`\\b\\w*${word}\\w*\\s+(numeric|text|integer|bigint|double|real)`).test(body),
      `${t} stores an economic quantity (${word}); authority reads consequences from the chosen future state`);
  }
}
{
  const r = functionBody('helm_authority_rules_guard') ?? '';
  check('exact-decimal', /threshold[\s\S]{0,80}\^-\?\[0-9\]\+/i.test(r), 'a rule condition\'s threshold is not checked as an exact decimal');
  check('exact-decimal', !/\b(float|real|double\s+precision)\b/i.test(sql), 'a floating-point column appears in the authority schema');
}

// 4. evaluation integrity
{
  const e = functionBody('helm_authority_evaluations_guard') ?? '';
  check('evaluation', /c\.fingerprint\s*<>\s*NEW\.commitment_fingerprint[\s\S]{0,160}RAISE/i.test(e),
    'an evaluation can name a fingerprint the commitment does not carry');
  check('evaluation', /NEW\.actor_user_id\s+IS\s+DISTINCT\s+FROM\s+c\.committed_by[\s\S]{0,160}RAISE/i.test(e),
    'an evaluation\'s actor need not be the identity that committed');
  check('evaluation', /helm_role_occupancies[\s\S]{0,600}helm_delegations[\s\S]{0,600}RAISE/i.test(e),
    'an AUTHORIZED basis need not be a rule the actor held');
  check('evaluation', /helm_authority_evaluations_authorized_has_basis\s+CHECK\s*\(\s*result\s*<>\s*'AUTHORIZED'\s+OR\s+basis_rule_id\s+IS\s+NOT\s+NULL\s*\)/i.test(sql),
    'an AUTHORIZED verdict need not name its rule');
  check('evaluation', /result\s*<>\s*'INDETERMINATE'\s+OR\s+jsonb_array_length\(gaps\)\s*>=\s*1/i.test(sql),
    'an INDETERMINATE verdict need not name what is missing');
  const req = functionBody('helm_required_approvals_guard') ?? '';
  check('evaluation', /commitment_fingerprint\s*<>\s*NEW\.commitment_fingerprint[\s\S]{0,200}RAISE/i.test(req),
    'a requirement can belong to a fingerprint its evaluation never judged');
}

// 5. approval acts
{
  const a = functionBody('helm_approval_acts_guard') ?? '';
  check('approval', /independent_of_user_id[\s\S]{0,120}NEW\.approver_user_id\s*=\s*req\.independent_of_user_id[\s\S]{0,160}RAISE/i.test(a),
    'separation of duties is not enforced: the committer can be their own independent approval');
  check('approval', /req\.commitment_fingerprint\s*<>\s*NEW\.commitment_fingerprint/i.test(a), 'an act can answer another fingerprint');
  check('approval', /NEW\.approver_role_id\s*<>\s*req\.role_id[\s\S]{0,120}RAISE/i.test(a), 'an act can claim a role the requirement is not for');
  check('approval', /basis_kind\s*=\s*'ROLE_OCCUPANCY'[\s\S]{0,500}helm_role_occupancies[\s\S]{0,400}RAISE/i.test(a),
    'an act\'s role is not resolved from a real seat');
  check('approval', /helm_approval_acts_once\s+UNIQUE\s*\(\s*required_approval_id\s*\)/i.test(sql), 'a requirement can be answered twice');
  const p = policy('Approvers record their own acts') ?? '';
  check('approval', /approver_user_id\s*=\s*\(\s*select\s+auth\.uid\(\)\s*\)/i.test(p),
    'a client can record an approval as someone else — the approver is not the authenticated caller');
  check('approval', /decision\s*=\s*'APPROVE'\s+OR\s+char_length/i.test(sql), 'a rejection need not say why');
}

// 6. the commitment is untouched
{
  check('commitment-untouched', !/ALTER\s+TABLE\s+public\.helm_decision_commitments/i.test(sql),
    'the Phase 6 migration alters the commitment table');
  const p5 = existsSync(PHASE5) ? readFileSync(PHASE5, 'utf8') : '';
  check('commitment-untouched', /authority_status\s+text\s+NOT\s+NULL\s+DEFAULT\s+'NOT_EVALUATED'\s+CHECK\s*\(\s*authority_status\s*=\s*'NOT_EVALUATED'\s*\)/i.test(p5),
    'the commitment\'s NOT_EVALUATED pin is gone — the commitment would carry a verdict');
}

// 7. retired approval rules
check('retired', /COMMENT\s+ON\s+TABLE\s+public\.helm_approval_rules\s+IS\s+'RETIRED/i.test(raw), 'helm_approval_rules is not marked RETIRED');
check('retired', /DROP\s+POLICY\s+IF\s+EXISTS\s+"Managers manage approval rules"\s+ON\s+public\.helm_approval_rules/i.test(sql),
  'helm_approval_rules can still be written');

// 8. scoped visibility on every decision table
{
  const can = functionBody('helm_can_see_decision') ?? '';
  check('visibility', /has_org_role\(d\.org_id,\s*'admin'\)/i.test(can) && /d\.created_by\s*=\s*auth\.uid\(\)/i.test(can),
    'helm_can_see_decision does not admit admins and the creator');
  check('visibility', /helm_decision_visibility[\s\S]{0,300}helm_visible_org_units/i.test(can), 'helm_can_see_decision does not consult unit grants');
  const units = functionBody('helm_visible_org_units') ?? '';
  check('visibility', /WITH\s+RECURSIVE/i.test(units) && /org_unit_memberships/i.test(units) && /parent_id\s*=\s*r\.id/i.test(units),
    'unit visibility is not subtree-inclusive through org_unit_memberships');
  check('visibility', /SECURITY\s+DEFINER/i.test(sql.slice(sql.indexOf('helm_can_see_decision'))), 'the visibility helper is not SECURITY DEFINER');
  const DECISION_TABLES = [
    'helm_decisions', 'helm_decision_alternatives', 'helm_decision_assumptions', 'helm_actions', 'helm_decision_revisions',
    'helm_decision_criteria', 'helm_decision_challenges', 'helm_decision_evidence', 'helm_decision_commitments',
    'helm_decision_commitment_snapshots', 'helm_decision_outcome_reviews', 'helm_decision_criterion_assessments',
    'helm_decision_weightings', 'helm_decision_events',
  ];
  const loops = [...sql.matchAll(/FOREACH\s+t\s+IN\s+ARRAY\s+ARRAY\[([\s\S]*?)\]\s+LOOP([\s\S]*?)END\s+LOOP/gi)];
  const inScopedLoop = (t) =>
    loops.some(
      (m) =>
        m[1].includes(`'${t}'`) &&
        /DROP\s+POLICY\s+IF\s+EXISTS\s+"Members read %s"/i.test(m[2]) &&
        /"Scoped read %s"[\s\S]*?FOR\s+SELECT[\s\S]*?helm_can_see_(decision\(decision_id\)|revision\(revision_id\))/i.test(m[2]),
    );
  for (const t of DECISION_TABLES) {
    const direct =
      new RegExp(`DROP\\s+POLICY\\s+IF\\s+EXISTS\\s+"Members read (${t}|decision events)"`, 'i').test(sql) &&
      new RegExp(`"Scoped read (${t}|decision events)"[\\s\\S]{0,240}helm_can_see_decision`, 'i').test(sql);
    check('visibility', direct || inScopedLoop(t), `${t}: the org-wide read policy is not replaced by a scoped one`);
  }
  check('visibility', /helm_can_see_revision\(revision_id\)/i.test(sql), 'assessments and weightings are not scoped');
  check('visibility', /"Scoped read helm_decisions"[\s\S]{0,200}helm_can_see_decision\(id\)/i.test(sql), 'helm_decisions itself is not scoped');
  check('visibility', /"Scoped read decision events"[\s\S]{0,200}helm_can_see_decision\(decision_id\)/i.test(sql), 'the decision timeline is not scoped');
}

// 9. additive
check('additive', !/DROP\s+COLUMN|DROP\s+TABLE|TRUNCATE/i.test(sql), 'the Phase 6 migration drops or truncates');
for (const m of sql.matchAll(/(?:CREATE|ALTER)\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+public\.([a-z_]+)/gi)) {
  check('additive', m[1].startsWith('helm_'), `the Phase 6 migration touches non-HELM table ${m[1]}`);
}
for (const m of sql.matchAll(/AS\s+\$fn\$([\s\S]*?)\$fn\$/g)) {
  check('no-formula-in-trigger', !/\bNEW\.[a-z_]+\s*:=/i.test(m[1]), 'a Phase 6 function assigns a value to NEW');
  check('no-formula-in-trigger', !/\b(SUM|AVG|MIN|MAX)\s*\(/i.test(m[1]), 'a Phase 6 function aggregates values');
}

// 10. two adapters, one suite
for (const f of ['inMemory.conformance.test.mjs', 'postgres.conformance.test.mjs']) {
  const p = join(root, 'packages', 'authority-runtime', 'test', f);
  check('conformance', existsSync(p) && /runAuthorityStoreConformanceSuite/.test(readFileSync(p, 'utf8')),
    `${f} does not run the AuthorityStore conformance suite`);
}

if (failures.length === 0) {
  console.log(
    `verify:authority-schema — ok (${TABLES.length} authority tables guarded and write-once, no typed economics, ` +
      'approvals bound to identity and fingerprint, every decision table scoped, commitment untouched, additive)',
  );
  process.exit(0);
}
console.error(`verify:authority-schema — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
