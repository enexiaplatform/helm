/**
 * verify:schema — the database invariants, asserted against the migration files.
 *
 * Static (no database connection required), so it runs in CI and offline:
 *   1. Every HELM table is helm_*-prefixed (ADR-0005), shared-core excepted.
 *   2. Every org-scoped HELM table carries org_id.
 *   3. Every HELM table has RLS enabled.
 *   4. Every HELM table has at least SELECT and INSERT policies, and every
 *      policy predicate is org-scoped.
 *   5. Audit tables have no DELETE policy (append-only by construction).
 *   6. Temporal tables carry both time dimensions (ADR-0014).
 *   7. No migration contains an unguarded destructive statement.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = process.cwd();
const failures = [];
const warnings = [];
const fail = (rule, detail) => failures.push({ rule, detail });

const migrationsDir = join(root, 'supabase', 'migrations');
if (!existsSync(migrationsDir)) {
  console.error('verify:schema — supabase/migrations not found');
  process.exit(1);
}

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const stripComments = (sql) =>
  sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

const SHARED_CORE = [
  'organizations', 'organization_memberships', 'org_units', 'org_unit_memberships',
];

/** Tables that must never be client-deletable: history and audit. */
const APPEND_ONLY = [
  'helm_decision_events',
  'helm_entity_versions',
  'helm_provenance',
  // A recorded claim about what was, what we expected or what we wanted must
  // not be quietly rewritten later.
  'helm_value_observations',
  // A scenario's revisions, its simulations and their feasibility results are
  // the record a later decision review reads. Revising creates; nothing deletes.
  'helm_scenario_revisions',
  'helm_scenario_runs',
  'helm_scenario_constraint_results',
  // What management decided, on what grounds, and how it turned out. A sealed
  // revision, a commitment, its frozen snapshot and a review of it are the
  // record — superseded by a later revision or review, never removed.
  'helm_decision_revisions',
  'helm_decision_commitments',
  'helm_decision_commitment_snapshots',
  'helm_decision_outcome_reviews',
  // What the enterprise believed about causes, and on what evidence. A belief
  // changes by a new revision, a correction or a new link — never by an edit.
  'helm_causal_variables',
  'helm_causal_claims',
  'helm_causal_claim_revisions',
  'helm_causal_evidence',
  'helm_causal_evidence_links',
  'helm_correlation_findings',
  'helm_causal_questions',
  'helm_causal_question_candidates',
];

/**
 * Registry tables are global config, not org data — org_id is nullable there,
 * because a NULL org means "shipped by HELM" and a tenant's own rows carry theirs.
 */
const REGISTRY_TABLES = [
  'helm_entity_types',
  'helm_relationship_types',
  'helm_value_metrics',
  'helm_calculations',
  // Phase 6: governance classification; NULL org = shipped by HELM.
  'helm_decision_types',
];

/** Tables carrying facts about the world, which need both time dimensions. */
const TEMPORAL_TABLES = ['helm_entities', 'helm_relationships'];

const combined = files
  .map((f) => stripComments(readFileSync(join(migrationsDir, f), 'utf8')))
  .join('\n');

// --------------------------------------------- collect table definitions

/**
 * Brace-matched rather than regex-terminated: a column definition can contain
 * its own parentheses (CHECK constraints, numeric precision), so a lazy
 * `[\s\S]*?\)` would cut the body short and silently skip later columns.
 */
function extractTables(sql) {
  const out = new Map();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.([a-z_]+)\s*\(/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1].toLowerCase();
    let depth = 1;
    let i = re.lastIndex;
    while (i < sql.length && depth > 0) {
      if (sql[i] === '(') depth += 1;
      else if (sql[i] === ')') depth -= 1;
      i += 1;
    }
    out.set(name, sql.slice(re.lastIndex, i - 1));
  }
  return out;
}

const tableBodies = extractTables(combined);

// -------------------------------------------------------------- assertions

for (const [name, body] of tableBodies) {
  const isHelm = name.startsWith('helm_');
  const isSharedCore = SHARED_CORE.includes(name);

  // (1) namespace
  if (!isHelm && !isSharedCore) {
    fail('table-namespace', `"${name}" is neither helm_*-prefixed nor documented shared core`);
    continue;
  }
  if (!isHelm) continue;

  // (2) org scoping
  if (!/\borg_id\b/.test(body)) {
    fail('org-scope', `helm table "${name}" has no org_id column`);
  } else if (
    !REGISTRY_TABLES.includes(name) &&
    // PRIMARY KEY implies NOT NULL, so either form satisfies the invariant.
    !/org_id\s+uuid\s+(?:NOT\s+NULL|PRIMARY\s+KEY)/i.test(body)
  ) {
    fail('org-scope', `"${name}".org_id must be NOT NULL (registry tables excepted)`);
  }

  // (6) both time dimensions on fact-bearing tables
  if (TEMPORAL_TABLES.includes(name)) {
    for (const col of ['valid_from', 'valid_to', 'observed_at', 'ingested_at', 'updated_at']) {
      if (!new RegExp(`\\b${col}\\b`).test(body)) {
        fail('bitemporal', `"${name}" is missing ${col} (ADR-0014 requires both dimensions)`);
      }
    }
  }
}

// (3) RLS enabled
for (const name of tableBodies.keys()) {
  if (!name.startsWith('helm_')) continue;
  const re = new RegExp(
    `ALTER\\s+TABLE\\s+public\\.${name}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`,
    'i',
  );
  if (!re.test(combined)) {
    fail('rls-enabled', `"${name}" never has ROW LEVEL SECURITY enabled`);
  }
}

// (4) policy coverage + org-scoped predicates
const policies = []; // { name, table, command, body }
{
  // Policy names may be bare identifiers or double-quoted with spaces, and the
  // command may be ALL — which grants SELECT, INSERT, UPDATE and DELETE at once.
  const re =
    /CREATE\s+POLICY\s+(?:"([^"]+)"|([a-z_]+))\s+ON\s+public\.([a-z_]+)\s+FOR\s+([A-Z]+)([\s\S]*?);/gi;
  let m;
  while ((m = re.exec(combined)) !== null) {
    policies.push({
      name: m[1] ?? m[2],
      table: m[3].toLowerCase(),
      command: m[4].toUpperCase(),
      body: m[5],
    });
  }
}

/**
 * Policies created inside a DO block via EXECUTE format(..., public.%I, ...) are
 * invisible to the regex above, because the table name is a substitution. The
 * Phase 0 migration uses exactly that pattern to apply one policy set across a
 * list of working tables, so the loop is parsed here: the table list comes from
 * the block's ARRAY[...] literal, and each CREATE POLICY template inside the
 * block is credited to every table in it.
 */
for (const block of combined.matchAll(/DO\s+\$\$([\s\S]*?)\$\$\s*;/g)) {
  const body = block[1];
  const arrayMatch = body.match(/ARRAY\s*\[([^\]]+)\]/);
  if (!arrayMatch) continue;
  const loopTables = [...arrayMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  if (loopTables.length === 0) continue;

  for (const tmpl of body.matchAll(
    /CREATE\s+POLICY\s+"([^"]*)"\s+ON\s+public\.%I\s+FOR\s+([A-Z]+)([\s\S]*?)(?:'|;\s*')/gi,
  )) {
    for (const table of loopTables) {
      policies.push({
        name: `${tmpl[1].replace('%s', table)} (DO-block)`,
        table,
        command: tmpl[2].toUpperCase(),
        body: tmpl[3],
      });
    }
  }
}

// (4b) A read policy never re-reads its OWN row by id. A STABLE helper that
// looks the row up again cannot see a row inserted in the same statement, and
// Postgres applies SELECT policies to INSERT … RETURNING — so every client
// write that reads its record back is refused. Found live in Phase 8 on four
// tables. Only the LAST definition of each policy counts (later migrations
// replace earlier ones).
{
  const last = new Map();
  for (const p of policies) last.set(`${p.table}|${p.name}`, p);
  for (const p of last.values()) {
    if (!p.table.startsWith('helm_') || (p.command !== 'SELECT' && p.command !== 'ALL')) continue;
    const m = /helm_private\.([a-z_]+)\(\s*id\s*\)/i.exec(p.body);
    if (m) {
      fail(
        'rls-returning',
        `policy "${p.name}" on "${p.table}" calls helm_private.${m[1]}(id), re-reading its own row — ` +
          'INSERT … RETURNING is refused; pass the row\'s columns to a …_row_visible rule instead',
      );
    }
  }
}

/** Does this policy grant `command`? FOR ALL grants every command. */
const grants = (p, command) => p.command === command || p.command === 'ALL';

for (const name of tableBodies.keys()) {
  if (!name.startsWith('helm_')) continue;
  const mine = policies.filter((p) => p.table === name);
  if (mine.length === 0) {
    fail('rls-coverage', `"${name}" has RLS enabled but no policies — it is unreachable`);
    continue;
  }
  for (const required of ['SELECT', 'INSERT']) {
    if (!mine.some((p) => grants(p, required))) {
      fail('rls-coverage', `"${name}" has no ${required} policy`);
    }
  }
  // (5) append-only — FOR ALL would smuggle in DELETE, so check the grant, not
  // just a literal DELETE policy.
  if (APPEND_ONLY.includes(name)) {
    const del = mine.find((p) => grants(p, 'DELETE'));
    if (del) {
      fail(
        'append-only',
        `"${name}" must not permit DELETE (policy "${del.name}" is FOR ${del.command}) — ` +
          `history is immutable`,
      );
    }
  }
}

for (const p of policies) {
  if (!p.table.startsWith('helm_')) continue;
  // Registry tables legitimately expose global rows via `org_id IS NULL`.
  const orgScoped =
    /is_org_member\s*\(\s*org_id\s*\)/i.test(p.body) ||
    /has_org_role\s*\(\s*org_id\s*,/i.test(p.body) ||
    /org_id\s+IS\s+NULL/i.test(p.body);
  if (!orgScoped) {
    fail(
      'org-scoped-policy',
      `policy "${p.name}" on "${p.table}" does not reference org_id — the tenant wall leaks`,
    );
  }
}

// (7) destructive statements
for (const f of files) {
  const sql = stripComments(readFileSync(join(migrationsDir, f), 'utf8'));
  // TRUNCATE as a STATEMENT is destructive; revoking the TRUNCATE privilege
  // (REVOKE … TRUNCATE … FROM authenticated) protects, so only the statement counts.
  for (const m of sql.matchAll(/\b(DROP\s+TABLE|DROP\s+COLUMN)\b[^;]*|(?:^|;)\s*TRUNCATE\b[^;]*/gi)) {
    fail('destructive-migration', `${f}: ${m[0].trim().slice(0, 90)}`);
  }

  // A CHECK constraint on a HELM-owned table may be REPLACED, never simply
  // removed. Two forms count as replacement:
  //
  //   widened   -- dropped with IF EXISTS and re-added under the SAME name
  //   superseded-- dropped with IF EXISTS and a DIFFERENT constraint added to
  //                the SAME table in the same migration
  //
  // The second form exists because a widened rule sometimes deserves a new name.
  // Phase 3 replaces `helm_value_obs_no_calculation` ("a run id is always NULL")
  // with `helm_value_obs_calculation_coherent` ("a run id belongs only on a
  // DERIVED or SCENARIO observation"). Keeping the old name would have left a
  // constraint whose name asserted the opposite of what it enforced.
  //
  // Dropping a constraint and adding nothing to that table is destructive, and
  // dropping one on a Memoire table never qualifies (verify:memoire-boundary
  // also refuses it).
  const addedByTable = new Map();
  for (const m of sql.matchAll(
    /ALTER\s+TABLE\s+public\.([a-z_]+)\s+(?:[\s\S]{0,80}?)ADD\s+CONSTRAINT\s+([a-z_]+)/gi,
  )) {
    const table = m[1].toLowerCase();
    if (!addedByTable.has(table)) addedByTable.set(table, new Set());
    addedByTable.get(table).add(m[2].toLowerCase());
  }
  for (const m of sql.matchAll(
    /ALTER\s+TABLE\s+public\.([a-z_]+)\s+DROP\s+CONSTRAINT\s+(IF\s+EXISTS\s+)?([a-z_]+)/gi,
  )) {
    const [, rawTable, guard, constraint] = m;
    const table = rawTable.toLowerCase();
    const added = addedByTable.get(table) ?? new Set();
    const replaced = added.has(constraint.toLowerCase()) || added.size > 0;
    const isWidening = table.startsWith('helm_') && Boolean(guard) && replaced;
    if (!isWidening) {
      fail(
        'destructive-migration',
        `${f}: DROP CONSTRAINT ${constraint} on ${table} replaces nothing — ` +
          'a constraint may be widened or superseded, never simply removed',
      );
    }
  }
  // DROP POLICY/TRIGGER/FUNCTION are fine when guarded with IF EXISTS — that is
  // the idempotency pattern, not a destructive change.
  for (const m of sql.matchAll(/\bDROP\s+(POLICY|TRIGGER|FUNCTION)\s+(?!IF\s+EXISTS)/gi)) {
    warnings.push(`${f}: unguarded DROP ${m[1]} — add IF EXISTS for idempotency`);
  }
}

// (8) every HELM function pins its search_path
//
// A function that resolves names through the CALLER'S search_path can be made
// to call a different object than it was written against — a temp table named
// helm_entities, a shadowing function. Supabase flags it as
// function_search_path_mutable. The HELM convention is `public, pg_temp`, with
// pg_temp last so a temporary object can never shadow a real one.
//
// Either the CREATE carries `SET search_path`, or a later migration pins it
// with `ALTER FUNCTION ... SET search_path`. Checked across ALL migrations, so
// a fix in a later file satisfies a function defined in an earlier one.
{
  const helmFunctions = new Map();
  for (const m of combined.matchAll(
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(helm_[a-z_]+)\s*\(([\s\S]*?)\$(\w*)\$/gi,
  )) {
    const name = m[1].toLowerCase();
    const header = m[2];
    const pinnedInCreate = /SET\s+search_path/i.test(header);
    helmFunctions.set(name, (helmFunctions.get(name) ?? false) || pinnedInCreate);
  }
  for (const m of combined.matchAll(
    /ALTER\s+FUNCTION\s+public\.(helm_[a-z_]+)\s*\([^;]*?\)\s*SET\s+search_path/gi,
  )) {
    helmFunctions.set(m[1].toLowerCase(), true);
  }
  for (const [name, pinned] of helmFunctions) {
    if (!pinned) {
      fail(
        'function-search-path',
        `function public.${name} does not pin its search_path. Add ` +
          "SET search_path TO 'public', 'pg_temp' to it, or pin it with ALTER FUNCTION " +
          'in a later migration',
      );
    }
  }
  if (helmFunctions.size === 0) {
    fail('function-search-path', 'no helm_* functions were found, so this rule proved nothing');
  }
}

// ------------------------------------------------------------------ report

const tableCount = [...tableBodies.keys()].filter((t) => t.startsWith('helm_')).length;

for (const w of warnings) console.error(`  [warn] ${w}`);

if (failures.length === 0) {
  console.log(
    `verify:schema — ok (${tableCount} helm_* tables, ${policies.length} policies, ` +
      `${files.length} migrations)`,
  );
  process.exit(0);
}

console.error(`\nverify:schema — ${failures.length} violation(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
