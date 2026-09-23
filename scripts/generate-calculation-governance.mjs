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
import { meridianValueModelV1_1 } from '../packages/propagation-engine/src/meridianValueModelV1_1.ts';
import { valueMetricId } from '../packages/value-graph/src/registry.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOVERNANCE_MIGRATION =
  'supabase/migrations/20260921090100_helm_calculation_governance_sync.sql';
/**
 * Model v1.1's governance. The sync above is itself applied history now, and
 * it can only UPDATE rows that exist; v1.1 adds calculations, so its rows are
 * upserted by a migration of their own. Every v1.1 calculation — including the
 * nine v1 ones, unchanged — is written, so this one file states the whole
 * governed model.
 */
export const GOVERNANCE_V1_1_MIGRATION =
  'supabase/migrations/20260922090200_helm_calculation_governance_v1_1.sql';

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const jsonb = (v) => `${q(JSON.stringify(v ?? {}))}::jsonb`;
const arr = (v) =>
  v === null || v === undefined ? 'NULL' : `ARRAY[${v.map(q).join(', ')}]::text[]`;

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

const v11Rows = meridianValueModelV1_1
  .map(
    (c) =>
      `  (${q(calculationRowId(c.key, c.version))}, NULL, ${q(c.key)}, ${q(c.version)}, ` +
      `${q(c.name)}, ${q(c.description)}, ${q(c.rationale)}, ${q(c.owner)}, ${q(c.status)}, ` +
      `${q(c.effectiveFrom)}, ${q(valueMetricId(c.outputMetricKey))}, ${q(c.outputUnit)}, ` +
      `${arr(c.scopeCompatibility)}, ${c.definitionConfidence}, ${q(c.expression)}, ` +
      `${jsonb(inputsJson(c))}, true, ${jsonb(c.metadata ?? {})})`,
  )
  .join(',\n');

const v11Sql = `-- ============================================================================
-- HELM calculation governance — Meridian Pharma Value Model v1.1
--
-- GENERATED FILE -- produced by scripts/generate-calculation-governance.mjs from
-- packages/propagation-engine/src/meridianValueModelV1_1.ts. Do not hand-edit.
--
-- Upserts the governance row of every v1.1 calculation: the nine v1 rows are
-- restated unchanged, and the four scenario calculations (order_quantity,
-- demand_coverage, unserved_demand, revenue_at_risk) are added. Metadata only:
-- no executable code reaches the database. Depends on the value-metric sync,
-- which registers the metrics these calculations write.
-- ============================================================================

INSERT INTO public.helm_calculations
  (id, org_id, key, version, name, description, rationale, owner, status,
   effective_from, output_metric_id, output_unit, scope_compatibility,
   definition_confidence, expression, inputs, is_system, metadata)
VALUES
${v11Rows}
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  rationale = EXCLUDED.rationale,
  owner = EXCLUDED.owner,
  status = EXCLUDED.status,
  expression = EXCLUDED.expression,
  definition_confidence = EXCLUDED.definition_confidence,
  scope_compatibility = EXCLUDED.scope_compatibility,
  inputs = EXCLUDED.inputs,
  metadata = EXCLUDED.metadata
WHERE public.helm_calculations.org_id IS NULL;
`;

const check = process.argv.includes('--check');
// Compared with line endings normalized: with core.autocrlf a Windows checkout
// rewrites these files to CRLF, and a byte-for-byte check would then fail for
// anyone who cloned the repository rather than generated the file.
const lf = (text) => text.replace(/\r\n/g, '\n');
const outputs = [
  { path: GOVERNANCE_MIGRATION, sql, count: meridianValueModelV1.length },
  { path: GOVERNANCE_V1_1_MIGRATION, sql: v11Sql, count: meridianValueModelV1_1.length },
];

if (check) {
  let drift = false;
  for (const o of outputs) {
    const target = join(root, o.path);
    const existing = existsSync(target) ? lf(readFileSync(target, 'utf8')) : null;
    if (existing !== lf(o.sql)) {
      drift = true;
      console.error(
        `${o.path} is out of sync with the calculation registry.\n` +
          'Run: node scripts/generate-calculation-governance.mjs',
      );
    }
  }
  if (drift) process.exit(1);
  console.log(
    `governance in sync (v1 sync: ${meridianValueModelV1.length}, v1.1: ` +
      `${meridianValueModelV1_1.length} calculations)`,
  );
  process.exit(0);
}

for (const o of outputs) {
  writeFileSync(join(root, o.path), o.sql, 'utf8');
  console.log(`wrote ${o.path} (${o.count} calculations)`);
}
