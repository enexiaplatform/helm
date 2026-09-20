/**
 * The calculation registry — the same discipline as the ontology and metric
 * registries, applied to executable definitions.
 *
 * Executable logic lives in code; governance metadata lives in the database
 * (ADR-0017 §1). This registry is the code half, and it refuses to accept a
 * definition that could not be executed safely.
 */

import { fail, ok, type Result } from '@helm/shared';
import type { ValueMetricRegistry } from '@helm/value-graph';
import {
  CalculationErrors,
  calculationRef,
  observationPreferences,
  type CalculationDefinition,
} from './types.ts';

export interface CalculationRegistry {
  get(key: string, version?: string): CalculationDefinition | null;
  all(): readonly CalculationDefinition[];
  /** Active definitions only — what a new run may use. */
  active(): readonly CalculationDefinition[];
  findByOutputMetric(metricKey: string): readonly CalculationDefinition[];
  /** Which calculations consume this metric. Drives incremental propagation. */
  findByInputMetric(metricKey: string): readonly CalculationDefinition[];
}

export type RegistryProblem = { kind: string; detail: string };

const SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * Builds a registry, validating every definition against the metric registry.
 * A definition that references a metric that does not exist, or declares a unit
 * its output metric contradicts, is rejected here rather than failing at
 * execution time in front of a manager.
 */
export function createCalculationRegistry(
  definitions: readonly CalculationDefinition[],
  metrics: ValueMetricRegistry,
): Result<CalculationRegistry> {
  const problems = validateDefinitions(definitions, metrics);
  if (problems.length > 0) {
    return fail(
      CalculationErrors.CALCULATION_NOT_FOUND,
      `Calculation registry is invalid:\n${problems.map((p) => `  [${p.kind}] ${p.detail}`).join('\n')}`,
      { problems },
    );
  }

  const byRef = new Map(definitions.map((d) => [calculationRef(d), d]));
  // Latest ACTIVE version per key, by semver ordering.
  const latestActive = new Map<string, CalculationDefinition>();
  for (const d of definitions) {
    if (d.status !== 'ACTIVE') continue;
    const current = latestActive.get(d.key);
    if (!current || compareSemver(d.version, current.version) > 0) {
      latestActive.set(d.key, d);
    }
  }

  return ok({
    get(key, version) {
      if (version) return byRef.get(`${key}@${version}`) ?? null;
      return latestActive.get(key) ?? null;
    },
    all: () => definitions,
    active: () => [...latestActive.values()],
    findByOutputMetric: (metricKey) =>
      [...latestActive.values()].filter((d) => d.outputMetricKey === metricKey),
    findByInputMetric: (metricKey) =>
      [...latestActive.values()].filter((d) => d.inputs.some((i) => i.metricKey === metricKey)),
  });
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * Registry validation (§6). Every rule here exists because breaking it would
 * produce a wrong number rather than an error.
 */
export function validateDefinitions(
  definitions: readonly CalculationDefinition[],
  metrics: ValueMetricRegistry,
): RegistryProblem[] {
  const problems: RegistryProblem[] = [];
  const seenRefs = new Set<string>();
  const activeByKey = new Map<string, CalculationDefinition[]>();

  for (const d of definitions) {
    const ref = calculationRef(d);

    if (!SEMVER.test(d.version)) {
      problems.push({ kind: 'invalid_version', detail: `${ref}: version must be x.y.z` });
    }
    if (seenRefs.has(ref)) {
      problems.push({ kind: 'duplicate_calculation', detail: ref });
    }
    seenRefs.add(ref);

    if (d.status === 'ACTIVE') {
      const list = activeByKey.get(d.key) ?? [];
      list.push(d);
      activeByKey.set(d.key, list);
    }

    // --- output metric must exist and agree on units ---
    const outMetric = metrics.metric(d.outputMetricKey);
    if (!outMetric) {
      problems.push({
        kind: 'unknown_output_metric',
        detail: `${ref} outputs "${d.outputMetricKey}", which is not a registered metric`,
      });
    } else if (outMetric.unitType !== d.outputUnit) {
      problems.push({
        kind: 'output_unit_mismatch',
        detail:
          `${ref} declares output unit ${d.outputUnit} but metric "${d.outputMetricKey}" ` +
          `is measured in ${outMetric.unitType}`,
      });
    }

    // --- inputs ---
    const seenInputNames = new Set<string>();
    for (const input of d.inputs) {
      if (seenInputNames.has(input.name)) {
        problems.push({
          kind: 'duplicate_input_name',
          detail: `${ref} declares input "${input.name}" twice`,
        });
      }
      seenInputNames.add(input.name);

      const inMetric = metrics.metric(input.metricKey);
      if (!inMetric) {
        problems.push({
          kind: 'unknown_input_metric',
          detail: `${ref} input "${input.name}" references unknown metric "${input.metricKey}"`,
        });
        continue;
      }
      if (inMetric.unitType !== input.expectUnit) {
        problems.push({
          kind: 'input_unit_mismatch',
          detail:
            `${ref} input "${input.name}" expects ${input.expectUnit} but metric ` +
            `"${input.metricKey}" is measured in ${inMetric.unitType}`,
        });
      }
      if (input.preference && !observationPreferences.includes(input.preference)) {
        problems.push({
          kind: 'unknown_preference',
          detail: `${ref} input "${input.name}" uses unknown preference "${input.preference}"`,
        });
      }
      if (!input.description || input.description.trim().length < 10) {
        problems.push({
          kind: 'undocumented_input',
          detail: `${ref} input "${input.name}" has no meaningful description`,
        });
      }
    }

    if (d.inputs.length === 0) {
      problems.push({
        kind: 'no_inputs',
        detail: `${ref} declares no inputs — a calculation with no inputs is a constant, ` +
          'and a business constant belongs in an assumption observation (§20)',
      });
    }

    // --- governance (§63): a management calculation must not be anonymous ---
    if (!d.rationale || d.rationale.trim().length < 20) {
      problems.push({
        kind: 'missing_rationale',
        detail: `${ref} has no business rationale`,
      });
    }
    if (!d.owner || d.owner.trim().length === 0) {
      problems.push({ kind: 'missing_owner', detail: ref });
    }
    if (!d.expression || d.expression.trim().length === 0) {
      problems.push({
        kind: 'missing_expression',
        detail: `${ref} has no human-readable formula, so its trace cannot explain itself`,
      });
    }
    if (d.definitionConfidence < 0 || d.definitionConfidence > 1) {
      problems.push({
        kind: 'invalid_definition_confidence',
        detail: `${ref} confidence must be 0..1, got ${d.definitionConfidence}`,
      });
    }
  }

  // Two ACTIVE definitions of the same key and version is a conflict; two
  // different versions both ACTIVE is legitimate (the latest wins for new runs,
  // older ones stay resolvable for historical traces).
  for (const [key, list] of activeByKey) {
    const versions = list.map((d) => d.version);
    if (new Set(versions).size !== versions.length) {
      problems.push({
        kind: 'conflicting_active_definitions',
        detail: `${key} has duplicate ACTIVE versions: ${versions.join(', ')}`,
      });
    }
  }

  return problems;
}
