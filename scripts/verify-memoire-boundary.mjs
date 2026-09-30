/**
 * verify:memoire-boundary — the non-negotiable separation, made executable.
 *
 * HELM and Memoire share one database, so nothing physical stops a careless
 * query crossing the line. That is precisely why the boundary must be a test.
 *
 * Rules (docs/architecture/helm-vs-memoire.md §2.1):
 *   1. No kernel package reads or writes a Memoire-owned table.
 *   2. The app reads Memoire only through the designated bridge module.
 *   3. HELM never writes to Memoire — no insert, upsert, update or delete on a Memoire table anywhere.
 *   4. No migration alters or drops a Memoire-owned object.
 *   5. HELM never claims a Memoire-owned table name (see ADR-0005).
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = process.cwd();
const failures = [];
const fail = (rule, file, detail) =>
  failures.push({ rule, file: relative(root, file).split(sep).join('/'), detail });

/** Tables Memoire owns. HELM may reference these only via the bridge. */
const MEMOIRE_TABLES = [
  'accounts', 'contacts', 'stakeholders', 'opportunities', 'interactions',
  'objections', 'actions', 'pipeline_defense_briefs', 'sales_activities',
  'sales_assets', 'review_packs', 'action_outcomes', 'import_batches',
  'import_row_results', 'operating_context', 'opportunity_outcomes', 'quotes',
  'weekly_commitments', 'plan_items', 'nudges', 'account_merges',
  'commercial_threads', 'commercial_commitments', 'commercial_events',
  'commercial_value_outcomes', 'commercial_targets', 'commercial_evidence',
  'order_milestones', 'supplier_commitments', 'digest_deliveries', 'expenses',
  'order_costs', 'order_receivables', 'knowledge_notes', 'user_profiles',
  'entities', 'relationships', 'captures', 'activity_log', 'usage_monthly',
  'early_access_requests', 'product_funnel_events', 'product_events',
];

/** The one module allowed to read Memoire. */
const BRIDGE = 'src/services/memoireBridge.ts';

function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', 'coverage'].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

// --------------------------------- 1 & 2: who touches a Memoire table at all

const codeFiles = [
  ...walk(join(root, 'packages'), ['.ts', '.tsx']),
  ...walk(join(root, 'src'), ['.ts', '.tsx']),
  ...walk(join(root, 'connectors'), ['.ts']),
];

for (const file of codeFiles) {
  const rel = relative(root, file).split(sep).join('/');
  const src = readFileSync(file, 'utf8');
  const isKernel = rel.startsWith('packages/');
  const isBridge = rel === BRIDGE;

  for (const m of src.matchAll(/\.from\(\s*['"]([a-z_]+)['"]\s*\)/g)) {
    const table = m[1];
    if (!MEMOIRE_TABLES.includes(table)) continue;

    if (isKernel) {
      fail(
        'kernel-reads-memoire',
        file,
        `kernel package queries the Memoire-owned table "${table}"`,
      );
    } else if (!isBridge) {
      fail(
        'memoire-access-outside-bridge',
        file,
        `queries Memoire-owned "${table}" outside ${BRIDGE}`,
      );
    }
  }
}

// --------------------------------------------- 3: HELM never writes to Memoire

// The bridge once appended a `commercial_events` row when a decision was approved. That write is
// retired: a commitment produces action INTENTS, and the integration fabric turns an intent into a
// DRY-RUN request that sends nothing. So no file — bridge or otherwise — may mutate a Memoire table.
if (existsSync(join(root, BRIDGE))) {
  for (const file of codeFiles) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\.from\(\s*['"]([a-z_]+)['"]\s*\)\s*\.\s*(insert|upsert|update|delete)\b/g)) {
      const [, table, op] = m;
      if (!MEMOIRE_TABLES.includes(table)) continue;
      fail('memoire-write', file, `${op}() on Memoire-owned "${table}" — HELM never writes to Memoire`);
    }
  }
} else {
  failures.push({
    rule: 'bridge-missing',
    file: BRIDGE,
    detail: 'the designated Memoire bridge module is missing; update this script if it moved',
  });
}

// --------------------------- 4 & 5: migrations never touch a Memoire object

const migrationsDir = join(root, 'supabase', 'migrations');
const SHARED_CORE = [
  'organizations', 'organization_memberships', 'org_units', 'org_unit_memberships',
];

for (const file of walk(migrationsDir, ['.sql'])) {
  const src = readFileSync(file, 'utf8');
  // Strip comments so prose mentioning a table name is not a false positive.
  const sql = src
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  for (const m of sql.matchAll(
    /\b(?:ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER|POLICY|FUNCTION)\b[\s\S]{0,200}?\bpublic\.([a-z_]+)/gi,
  )) {
    const object = m[1].toLowerCase();
    if (MEMOIRE_TABLES.includes(object)) {
      fail('migration-alters-memoire', file, `ALTER/DROP targets Memoire-owned "${object}"`);
    }
  }

  // Every table a HELM migration creates must be helm_*-prefixed, except the
  // documented shared-core org layer (ADR-0005).
  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.([a-z_]+)/gi)) {
    const table = m[1].toLowerCase();
    if (table.startsWith('helm_')) continue;
    if (SHARED_CORE.includes(table)) continue;
    fail(
      'table-namespace',
      file,
      `creates "${table}" — HELM tables must be helm_*-prefixed (ADR-0005)`,
    );
  }
}

// ------------------------------------------------------------------ report

if (failures.length === 0) {
  console.log('verify:memoire-boundary — ok (boundary intact)');
  process.exit(0);
}

console.error(`verify:memoire-boundary — ${failures.length} violation(s):\n`);
for (const f of failures) {
  console.error(`  [${f.rule}] ${f.file}`);
  console.error(`      ${f.detail}`);
}
process.exit(1);
