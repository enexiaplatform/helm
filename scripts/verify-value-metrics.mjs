/**
 * verify:value-metrics — the metric vocabulary's semantic integrity.
 *
 * A metric known only by its name is useless to the aggregation logic and
 * agents that arrive in later phases, and a metric with contradictory semantics
 * is worse than useless: it will quietly produce wrong roll-ups.
 *
 *   1. No duplicates, no unknown dimensions, no thin descriptions.
 *   2. A proportion is never declared summable.
 *   3. A weighted average says what it is weighted by.
 *   4. A target-range metric declares its range.
 *   5. Currency defaults only on currency metrics.
 *   6. The canonical value chain only uses seeded metrics.
 *   7. The committed migration matches the TypeScript seed (no drift).
 *   8. The brief's required metric set is present.
 */

import { execFileSync } from 'node:child_process';
import {
  buildSeedValueRegistry,
  validateMetricRegistry,
} from '../packages/value-graph/src/registry.ts';
import { seedValueMetrics } from '../packages/value-graph/src/seed.ts';
import {
  canonicalValueNodeSpecs,
} from '../packages/value-graph/src/canonicalValueChain.ts';
import { valueDimensions } from '../packages/value-graph/src/types.ts';

const failures = [];
const fail = (rule, detail) => failures.push({ rule, detail });

const registry = buildSeedValueRegistry();

// ---------------------------------------------- 1-5: structural integrity

for (const p of validateMetricRegistry(registry)) {
  fail(p.kind, p.detail);
}

// ------------------------------------------ 6: canonical chain coverage

for (const spec of canonicalValueNodeSpecs) {
  if (!registry.metric(spec.metric)) {
    fail(
      'canonical-coverage',
      `the canonical value chain uses unseeded metric "${spec.metric}"`,
    );
  }
}

// ------------------------------------------------- 8: required metric set

const REQUIRED = [
  // commercial
  'OpportunityValue', 'OpportunityProbability', 'ExpectedRevenue', 'Revenue',
  'PipelineCoverage', 'CustomerValue',
  // operations
  'DemandQuantity', 'AvailableInventory', 'InventoryRequirement', 'InventoryGap',
  'ServiceLevel', 'LeadTime', 'CapacityUtilization',
  // finance
  'UnitCost', 'GrossMargin', 'GrossMarginPct', 'WorkingCapital', 'CashImpact',
  'Opex', 'Ebitda',
  // risk
  'SupplyRisk', 'CustomerRisk', 'InventoryRisk', 'ConcentrationRisk',
  // strategic
  'StrategicAlignment', 'GrowthPotential',
];
for (const key of REQUIRED) {
  if (!registry.metric(key)) fail('missing-required-metric', key);
}

// Every declared dimension should have at least one metric, or it is a label
// with nothing behind it.
for (const d of valueDimensions) {
  if (registry.byDimension(d).length === 0) {
    fail('empty-dimension', `dimension ${d} has no metrics`);
  }
}

// Enterprise value must stay multi-dimensional: no single metric may claim to
// be "the" enterprise value score.
for (const m of registry.allMetrics()) {
  if (/^enterprisevalue(score|index|total)?$/i.test(m.key)) {
    fail(
      'collapsed-enterprise-value',
      `"${m.key}" collapses enterprise value into one number. Enterprise value is ` +
        'represented as several dimension nodes that trade off against each other.',
    );
  }
}

// ------------------------------------------- 7: migration matches the seed

try {
  execFileSync(process.execPath, ['scripts/generate-value-graph-migration.mjs', '--check'], {
    stdio: 'pipe',
    cwd: process.cwd(),
  });
} catch (e) {
  const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
  fail('migration-drift', out || 'the generated migration no longer matches seed.ts');
}

// ---------------- 7b: the metric sync carries what the seed says NOW
//
// The Phase 2 migration reproduces the seed as it was applied; everything added
// or revised since reaches the database through the generated metric sync.
// Between them, every seeded metric must be accounted for.
try {
  execFileSync(process.execPath, ['scripts/generate-value-metric-sync.mjs', '--check'], {
    stdio: 'pipe',
    cwd: process.cwd(),
  });
} catch (e) {
  const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
  fail('metric-sync-drift', out || 'the metric sync migration no longer matches seed.ts');
}
for (const m of seedValueMetrics) {
  const revised = m.metadata?.revised;
  if (revised) {
    const ok = typeof revised.field === 'string' && revised.field in m && revised.from !== m[revised.field];
    if (!ok) {
      fail(
        'metric-revision',
        `"${m.key}" records a revision of "${revised.field}" that does not differ from its ` +
          'current value, so the applied Phase 2 migration can no longer be reconstructed',
      );
    }
    if ((m.version ?? 1) < 2) {
      fail('metric-revision', `"${m.key}" was revised but its version was not raised`);
    }
  }
}

// ------------------------------------------------------------------ report

if (failures.length === 0) {
  console.log(
    `verify:value-metrics — ok (${seedValueMetrics.length} metrics across ` +
      `${valueDimensions.length} dimensions, migration in sync)`,
  );
  process.exit(0);
}

console.error(`verify:value-metrics — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
