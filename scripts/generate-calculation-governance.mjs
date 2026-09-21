/**
 * Generates the calculation governance-sync migration from the code registry.
 *
 * Why this exists separately from `generate-calculation-migration.mjs`:
 * the Phase 3 migration has been APPLIED to the shared database, and an applied
 * migration is history — regenerating it in place would make the file describe
 * a schema the database never ran. It is frozen. Changes to what the code
 * registry declares about a calculation — owner, rationale, expression, and the
 * declared inputs including how each one resolves — are carried forward by this
 * idempotent UPDATE migration instead.
 *
 * `verify:calculations` diffs this file against the registry, so the governance
 * row a manager reads cannot drift from the implementation that actually runs.
 *
 *   node scripts/generate-calculation-governance.mjs           # write
 *   node scripts/generate-calculation-governance.mjs --check   # diff only
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { meridianValueModelV1 } from '../packages/propagation-engine/src/meridianValueModelV1.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOVERNANCE_MIGRATION =
  'supabase/migrations/20260921090100_helm_calculation_governance_sync.sql';

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const jsonb = (v) => `${q(JSON.stringify(v ?? {}))}::jsonb`;

const calculationRowId = (key, version) => `calc_${key}@${version}`;

/** The declared inputs, as data — including where each one comes from. */
function inputsJson(calc) {
  return calc.inputs.map((i) => ({
    name: i.name,
    metricKey: i.metricKey,
    binding: i.binding,
    // Where the value comes from: the persistent source world, or this run's
    // own upstream output. Explicit so the database can answer "is this an
    // execution dependency?" without reading any code.
    resolution: i.resolution ?? 'SOURCE_POLICY_ONLY',
    required: i.required,
    expectUnit: i.expectUnit,
    preference: i.preference ?? null,
    horizon: i.horizon ?? null,
    allowCrossPeriod: i.allowCrossPeriod ?? false,
    description: i.description,
  }));
}

function syncStatements() {
  return meridianValueModelV1
    .map(
      (c) =>
        `UPDATE public.helm_calculations SET\n` +
        `  name = ${q(c.name)},\n` +
        `  description = ${q(c.description)},\n` +
        `  rationale = ${q(c.rationale)},\n` +
        `  owner = ${q(c.owner)},\n` +
        `  expression = ${q(c.expression)},\n` +
        `  definition_confidence = ${c.definitionConfidence},\n` +
        `  inputs = ${jsonb(inputsJson(c))}\n` +
        `WHERE id = ${q(calculationRowId(c.key, c.version))} AND org_id IS NULL;`,
    )
    .join('\n\n');
}

const sql = `-- ============================================================================
-- HELM calculation governance sync
--
-- GENERATED FILE -- produced by scripts/generate-calculation-governance.mjs from
-- packages/propagation-engine/src/meridianValueModelV1.ts. Do not hand-edit.
--
-- Carries the code registry's current declarations onto the governance rows
-- the Phase 3 migration created. Metadata only: no executable code, no change
-- to what any calculation computes. Idempotent.
--
-- The substantive change this sync carries is \`resolution\` on every declared
-- input: whether it reads the persistent source world under an observation
-- policy (SOURCE_POLICY_ONLY) or is an execution dependency bound to the run
-- that produced it upstream (RUN_OUTPUT_IF_PLANNED).
-- ============================================================================

${syncStatements()}
`;

const target = join(root, GOVERNANCE_MIGRATION);
const check = process.argv.includes('--check');
// Compared with line endings normalized: with core.autocrlf a Windows checkout
// rewrites this file to CRLF, and a byte-for-byte check would then fail for
// anyone who cloned the repository rather than generated the file.
const lf = (text) => text.replace(/\r\n/g, '\n');
const existing = existsSync(target) ? lf(readFileSync(target, 'utf8')) : null;

if (check) {
  if (existing === lf(sql)) {
    console.log(`governance sync in sync (${meridianValueModelV1.length} calculations)`);
    process.exit(0);
  }
  console.error(
    `${GOVERNANCE_MIGRATION} is out of sync with the calculation registry.\n` +
      'Run: node scripts/generate-calculation-governance.mjs',
  );
  process.exit(1);
}

writeFileSync(target, sql, 'utf8');
console.log(`wrote ${GOVERNANCE_MIGRATION} (${meridianValueModelV1.length} calculations)`);
