/**
 * Generates the value-metric sync migration from the TypeScript seed.
 *
 * The Phase 2 value-graph migration is applied history and is regenerated only
 * as it was applied (see generate-value-graph-migration.mjs). What the seed
 * says NOW — metrics added by later phases, and definitions revised since —
 * reaches the database through this idempotent upsert instead, exactly as the
 * calculation registry does through its governance sync.
 *
 * `verify:value-metrics` diffs this file against the seed, so the metric a
 * comparison reads its directionality from cannot drift from the one the code
 * reasons with.
 *
 *   node scripts/generate-value-metric-sync.mjs           # write
 *   node scripts/generate-value-metric-sync.mjs --check   # diff only
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedValueMetrics } from '../packages/value-graph/src/seed.ts';
import { valueMetricId } from '../packages/value-graph/src/registry.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const METRIC_SYNC_MIGRATION = 'supabase/migrations/20260922090000_helm_value_metric_sync.sql';

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const jsonb = (v) => `${q(JSON.stringify(v ?? {}))}::jsonb`;
const arr = (v) =>
  v === null || v === undefined ? 'NULL' : `ARRAY[${v.map(q).join(', ')}]::text[]`;

const rows = seedValueMetrics
  .map(
    (m) =>
      `  (${q(valueMetricId(m.key))}, NULL, ${q(m.key)}, ${q(m.name)}, ${q(m.description)}, ` +
      `${q(m.dimension)}, ${q(m.unitType)}, ${q(m.defaultCurrency ?? null)}, ` +
      `${q(m.dataType ?? 'numeric')}, ${q(m.aggregation)}, ${q(m.directionality)}, ` +
      `${q(m.timeBehavior)}, ${arr(m.scopeCategories ?? null)}, ${m.version ?? 1}, 'active', true, ` +
      `${jsonb(m.metadata)})`,
  )
  .join(',\n');

const introduced = seedValueMetrics.filter((m) => m.metadata?.introducedIn).map((m) => m.key);
const revised = seedValueMetrics
  .filter((m) => m.metadata?.revised)
  .map((m) => `${m.key}.${m.metadata.revised.field} (was ${m.metadata.revised.from})`);

const sql = `-- ============================================================================
-- HELM value-metric sync
--
-- GENERATED FILE -- produced by scripts/generate-value-metric-sync.mjs from
-- packages/value-graph/src/seed.ts. Do not hand-edit.
--
-- Brings the system metric vocabulary (org_id IS NULL) to exactly what the seed
-- declares. Idempotent: an upsert of every system metric, touching nothing an
-- organization defined for itself. Only helm_value_metrics is written.
--
-- Metrics introduced since the Phase 2 migration: ${introduced.join(', ') || 'none'}.
-- Definitions revised since: ${revised.join('; ') || 'none'}.
-- ============================================================================

INSERT INTO public.helm_value_metrics
  (id, org_id, key, name, description, dimension, unit_type, default_currency, data_type,
   aggregation, directionality, time_behavior, scope_categories, version, status, is_system,
   metadata)
VALUES
${rows}
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  dimension = EXCLUDED.dimension,
  unit_type = EXCLUDED.unit_type,
  default_currency = EXCLUDED.default_currency,
  data_type = EXCLUDED.data_type,
  aggregation = EXCLUDED.aggregation,
  directionality = EXCLUDED.directionality,
  time_behavior = EXCLUDED.time_behavior,
  scope_categories = EXCLUDED.scope_categories,
  version = EXCLUDED.version,
  metadata = EXCLUDED.metadata
WHERE public.helm_value_metrics.org_id IS NULL;
`;

const target = join(root, METRIC_SYNC_MIGRATION);
const check = process.argv.includes('--check');
const lf = (text) => text.replace(/\r\n/g, '\n');
const existing = existsSync(target) ? lf(readFileSync(target, 'utf8')) : null;

if (check) {
  if (existing === lf(sql)) {
    console.log(`metric sync in sync (${seedValueMetrics.length} metrics)`);
    process.exit(0);
  }
  console.error(
    `${METRIC_SYNC_MIGRATION} is out of sync with the value-metric seed.\n` +
      'Run: node scripts/generate-value-metric-sync.mjs',
  );
  process.exit(1);
}

writeFileSync(target, sql, 'utf8');
console.log(`wrote ${METRIC_SYNC_MIGRATION} (${seedValueMetrics.length} metrics)`);
