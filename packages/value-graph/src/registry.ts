/**
 * The value metric registry — validation over metric semantics.
 *
 * Pure. This is where "a percentage metric may not receive a currency unit"
 * stops being a comment and becomes a rejection.
 */

import { fail, ok, type Result } from '@helm/shared';
import {
  currencyBearingUnits,
  unitBounds,
  valueDimensions,
  type ObservationType,
  type ValueDimension,
  type ValueMetricDefinition,
  type ValueNodeInput,
  type ValueObservationInput,
} from './types.ts';
import { seedValueMetrics } from './seed.ts';

/** Error codes this package emits. Namespaced like the Phase 1 taxonomy. */
export const ValueErrorCodes = {
  UNKNOWN_METRIC: 'value.unknown_metric',
  INACTIVE_METRIC: 'value.inactive_metric',
  DUPLICATE_METRIC: 'value.duplicate_metric',
  INVALID_UNIT: 'value.invalid_unit',
  UNIT_MISMATCH: 'value.unit_mismatch',
  MISSING_CURRENCY: 'value.missing_currency',
  UNEXPECTED_CURRENCY: 'value.unexpected_currency',
  VALUE_OUT_OF_RANGE: 'value.out_of_range',
  MISSING_VALUE: 'value.missing_value',
  WRONG_DATA_TYPE: 'value.wrong_data_type',
  MISSING_TIME_CONTEXT: 'value.missing_time_context',
  MISSING_SCENARIO: 'value.missing_scenario_context',
  UNEXPECTED_SCENARIO: 'value.unexpected_scenario_context',
  MISSING_PROVENANCE: 'value.missing_provenance',
  SCOPE_INCOMPATIBLE: 'value.scope_incompatible',
  NODE_NOT_FOUND: 'value.node_not_found',
  NODE_SUBJECT_REQUIRED: 'value.node_subject_required',
  DUPLICATE_NODE: 'value.duplicate_node',
  LINK_SELF_REFERENCE: 'value.link_self_reference',
  LINK_CROSS_ORG: 'value.link_cross_org',
  LINK_NOT_FOUND: 'value.link_not_found',
  DEPTH_REQUIRED: 'value.depth_required',
  DEPTH_EXCEEDED: 'value.depth_exceeded',
  CROSS_ORG: 'value.cross_org_reference',
  WRITE_FAILED: 'value.write_failed',
  READ_FAILED: 'value.read_failed',
} as const;

export interface ValueMetricRegistry {
  metric(key: string): ValueMetricDefinition | null;
  allMetrics(): readonly ValueMetricDefinition[];
  byDimension(dimension: ValueDimension): readonly ValueMetricDefinition[];
  /** Is this metric allowed to attach to an entity of this type category? */
  acceptsScope(metricKey: string, entityCategory: string | null): boolean;
  validateNode(input: ValueNodeInput, subjectCategory: string | null): Result<ValueNodeInput>;
  validateObservation(input: ValueObservationInput, metricKey: string): Result<ValueObservationInput>;
}

export function valueMetricId(key: string): string {
  return `vm_${key.toLowerCase()}`;
}

export function createValueMetricRegistry(
  metrics: readonly ValueMetricDefinition[],
): ValueMetricRegistry {
  const byKey = new Map(metrics.map((m) => [m.key, m]));

  const acceptsScope = (metricKey: string, category: string | null): boolean => {
    const m = byKey.get(metricKey);
    if (!m) return false;
    if (m.scopeCategories === null) return true;
    if (category === null) return true; // scoped nodes are not entity-bound
    return m.scopeCategories.includes(category);
  };

  return {
    metric: (key) => byKey.get(key) ?? null,
    allMetrics: () => metrics,
    byDimension: (d) => metrics.filter((m) => m.dimension === d),
    acceptsScope,

    validateNode(input, subjectCategory) {
      const m = byKey.get(input.metricKey);
      if (!m) {
        return fail(
          ValueErrorCodes.UNKNOWN_METRIC,
          `Unknown value metric "${input.metricKey}". Register it in helm_value_metrics first.`,
          { metricKey: input.metricKey },
        );
      }
      if (m.status === 'deprecated') {
        return fail(
          ValueErrorCodes.INACTIVE_METRIC,
          `Value metric "${m.key}" is deprecated and cannot take new nodes.`,
        );
      }
      // A node must be about something: either an entity or an explicit scope.
      if (!input.subjectEntityId && !input.scopeKind) {
        return fail(
          ValueErrorCodes.NODE_SUBJECT_REQUIRED,
          `A value node needs either a subject entity or a scope — "${m.key}" has neither.`,
        );
      }
      if (!acceptsScope(input.metricKey, subjectCategory)) {
        return fail(
          ValueErrorCodes.SCOPE_INCOMPATIBLE,
          `Metric "${m.key}" cannot attach to a ${subjectCategory} entity ` +
            `(allowed categories: ${m.scopeCategories?.join(', ')}).`,
          { metricKey: m.key, subjectCategory },
        );
      }
      return ok(input);
    },

    validateObservation(input, metricKey) {
      const m = byKey.get(metricKey);
      if (!m) {
        return fail(
          ValueErrorCodes.UNKNOWN_METRIC,
          `Unknown value metric "${metricKey}".`,
        );
      }

      // --- unit must match the metric's declared unit type ---
      const unit = input.unitType ?? m.unitType;
      if (unit !== m.unitType) {
        return fail(
          ValueErrorCodes.UNIT_MISMATCH,
          `Metric "${m.key}" is measured in ${m.unitType}; the observation supplied ${unit}. ` +
            `A number without its correct unit is not a fact.`,
          { metricKey: m.key, expected: m.unitType, received: unit },
        );
      }

      // --- currency must be present exactly when the unit needs one ---
      const needsCurrency = currencyBearingUnits.includes(m.unitType);
      const currency = input.currency ?? m.defaultCurrency ?? null;
      if (needsCurrency && !currency) {
        return fail(
          ValueErrorCodes.MISSING_CURRENCY,
          `Metric "${m.key}" is a currency amount and needs an explicit currency.`,
          { metricKey: m.key },
        );
      }
      if (!needsCurrency && input.currency) {
        return fail(
          ValueErrorCodes.UNEXPECTED_CURRENCY,
          `Metric "${m.key}" is measured in ${m.unitType}, so a currency is meaningless here.`,
          { metricKey: m.key, currency: input.currency },
        );
      }

      // --- a value must actually be present, of the right kind ---
      const hasNumeric = input.numericValue !== undefined && input.numericValue !== null;
      const hasText = input.textValue !== undefined && input.textValue !== null;
      if (!hasNumeric && !hasText) {
        return fail(
          ValueErrorCodes.MISSING_VALUE,
          `Observation for "${m.key}" carries no value.`,
        );
      }
      if (m.dataType === 'numeric' && !hasNumeric) {
        return fail(
          ValueErrorCodes.WRONG_DATA_TYPE,
          `Metric "${m.key}" is numeric; a text value was supplied.`,
        );
      }
      if (m.dataType !== 'numeric' && hasNumeric && !hasText) {
        return fail(
          ValueErrorCodes.WRONG_DATA_TYPE,
          `Metric "${m.key}" is ${m.dataType}; a numeric value alone is not valid.`,
        );
      }

      // --- unit bounds: 0.7 is not 70%, and 70% is not 0.7 ---
      if (hasNumeric) {
        const bounds = unitBounds[m.unitType];
        const v = input.numericValue as number;
        if (!Number.isFinite(v)) {
          return fail(ValueErrorCodes.VALUE_OUT_OF_RANGE, `Observation value for "${m.key}" is not finite.`);
        }
        if (bounds.min !== null && v < bounds.min) {
          return fail(
            ValueErrorCodes.VALUE_OUT_OF_RANGE,
            `"${m.key}" is a ${m.unitType} and must be >= ${bounds.min}, got ${v}.`,
            { metricKey: m.key, unitType: m.unitType, value: v },
          );
        }
        if (bounds.max !== null && v > bounds.max) {
          return fail(
            ValueErrorCodes.VALUE_OUT_OF_RANGE,
            `"${m.key}" is a ${m.unitType} and must be <= ${bounds.max}, got ${v}. ` +
              (m.unitType === 'ratio'
                ? 'A ratio is 0..1 — did you mean a percentage?'
                : m.unitType === 'percentage'
                  ? 'A percentage is 0..100 — did you mean a ratio?'
                  : ''),
            { metricKey: m.key, unitType: m.unitType, value: v },
          );
        }
      }

      // --- temporal context must match the metric's time behaviour ---
      const hasPeriod = Boolean(input.periodStart && input.periodEnd);
      const hasEffective = Boolean(input.effectiveAt);
      if (m.timeBehavior === 'POINT_IN_TIME' && !hasEffective) {
        return fail(
          ValueErrorCodes.MISSING_TIME_CONTEXT,
          `"${m.key}" is a point-in-time metric and needs an effectiveAt.`,
          { metricKey: m.key, timeBehavior: m.timeBehavior },
        );
      }
      if ((m.timeBehavior === 'PERIOD' || m.timeBehavior === 'CUMULATIVE') && !hasPeriod) {
        return fail(
          ValueErrorCodes.MISSING_TIME_CONTEXT,
          `"${m.key}" is a ${m.timeBehavior.toLowerCase()} metric and needs periodStart and periodEnd.`,
          { metricKey: m.key, timeBehavior: m.timeBehavior },
        );
      }

      // --- observation typing rules ---
      const type: ObservationType = input.observationType;
      if (type === 'SCENARIO' && !input.scenarioEntityId) {
        return fail(
          ValueErrorCodes.MISSING_SCENARIO,
          'A SCENARIO observation must name the scenario it belongs to.',
        );
      }
      if (type !== 'SCENARIO' && input.scenarioEntityId) {
        return fail(
          ValueErrorCodes.UNEXPECTED_SCENARIO,
          `A ${type} observation must not carry a scenario reference — that would make ` +
            'reality and a modelled alternative indistinguishable.',
        );
      }
      if (type === 'ACTUAL' && !input.provenanceId && input.sourceSystem === 'manual') {
        // An actual is a claim about what happened. If nobody can say where it
        // came from, it is an assumption wearing a fact's clothes.
        return fail(
          ValueErrorCodes.MISSING_PROVENANCE,
          'An ACTUAL observation entered manually must carry provenance.',
        );
      }
      if (type === 'ASSUMPTION' && !input.assumptionEntityId && !input.provenanceId) {
        return fail(
          ValueErrorCodes.MISSING_PROVENANCE,
          'An ASSUMPTION observation must reference the assumption or its provenance.',
        );
      }

      return ok(input);
    },
  };
}

/** Builds the registry from the shipped seed. Ids are deterministic. */
export function buildSeedValueRegistry(): ValueMetricRegistry {
  const metrics: ValueMetricDefinition[] = seedValueMetrics.map((m) => ({
    id: valueMetricId(m.key),
    orgId: null,
    key: m.key,
    name: m.name,
    description: m.description,
    dimension: m.dimension,
    unitType: m.unitType,
    defaultCurrency: m.defaultCurrency ?? null,
    dataType: m.dataType ?? 'numeric',
    aggregation: m.aggregation,
    directionality: m.directionality,
    timeBehavior: m.timeBehavior,
    scopeCategories: m.scopeCategories ?? null,
    version: 1,
    status: 'active',
    isSystem: true,
    metadata: m.metadata ?? {},
  }));
  return createValueMetricRegistry(metrics);
}

// --------------------------------------------------- registry self-check

export type MetricProblem = { kind: string; detail: string };

/**
 * Structural integrity of the metric vocabulary itself — run by
 * `verify:value-metrics`. Catches the semantic contradictions that would
 * silently corrupt a future aggregation engine.
 */
export function validateMetricRegistry(registry: ValueMetricRegistry): MetricProblem[] {
  const problems: MetricProblem[] = [];
  const seen = new Set<string>();

  for (const m of registry.allMetrics()) {
    if (seen.has(m.key)) problems.push({ kind: 'duplicate_metric', detail: m.key });
    seen.add(m.key);

    if (!valueDimensions.includes(m.dimension)) {
      problems.push({ kind: 'unknown_dimension', detail: `${m.key} -> ${m.dimension}` });
    }
    if (!m.description || m.description.trim().length < 20) {
      problems.push({ kind: 'thin_description', detail: m.key });
    }

    // A proportion cannot be summed: adding two percentages is meaningless.
    if (
      m.aggregation === 'SUM' &&
      (m.unitType === 'percentage' || m.unitType === 'ratio' || m.unitType === 'score')
    ) {
      problems.push({
        kind: 'non_summable_summed',
        detail: `${m.key} is a ${m.unitType} but declares SUM aggregation`,
      });
    }

    // A weighted average needs to say what it is weighted by.
    if (m.aggregation === 'WEIGHTED_AVERAGE' && !m.metadata.weightBy) {
      problems.push({
        kind: 'unweighted_weighted_average',
        detail: `${m.key} declares WEIGHTED_AVERAGE but no metadata.weightBy`,
      });
    }

    // A target range without a range is not actionable.
    if (m.directionality === 'TARGET_RANGE' && !m.metadata.typicalTargetRange) {
      problems.push({
        kind: 'target_range_without_range',
        detail: `${m.key} declares TARGET_RANGE but no metadata.typicalTargetRange`,
      });
    }

    // Currency metrics must be currency-typed and vice versa.
    const needsCurrency = currencyBearingUnits.includes(m.unitType);
    if (!needsCurrency && m.defaultCurrency) {
      problems.push({
        kind: 'currency_on_non_currency_metric',
        detail: `${m.key} is ${m.unitType} but declares a default currency`,
      });
    }

    if (m.scopeCategories !== null && m.scopeCategories.length === 0) {
      problems.push({
        kind: 'empty_scope',
        detail: `${m.key} declares an empty scope list, so it can attach to nothing`,
      });
    }
  }

  return problems;
}
