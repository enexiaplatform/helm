/**
 * PostgresCalculationStore — the production CalculationStore adapter.
 *
 * Held to the same conformance suite as the in-memory store, which is the
 * reference semantics (ADR-0015). Tenant isolation is enforced twice: every
 * query filters on `scope.orgId`, and RLS filters again server-side.
 *
 * There is deliberately no `PostgresPropagationEngine`. The engine is pure
 * orchestration over ports, so it has one implementation and works against
 * whichever adapters it is given — which is also what makes the in-memory tests
 * meaningful evidence about production behaviour.
 *
 * Append-only is enforced by the database, not by this file: `helm_calculation_steps`
 * has no UPDATE and no DELETE policy, so a recorded derivation cannot be
 * rewritten even by code that tried (§51).
 */

import {
  asRecordTime,
  fail,
  ok,
  type Clock,
  type PeriodGrain,
  type Confidence,
  type EntityId,
  type OrgId,
  type QuantityUnit,
  type Scope,
  type UserId,
} from '@helm/shared';
import { valueMetricId, type ValueMetricRegistry } from '@helm/value-graph';
import type { TimeHorizon } from '@helm/value-graph';
import {
  CalculationErrors,
  type CalculationRun,
  type CalculationStep,
  type RunObservationPolicy,
  type RunStatus,
  type StepStatus,
  type TracedInput,
  type TriggerType,
} from './types.ts';
import type { CalculationStore } from './port.ts';

export type SupabaseLike = {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  from(table: string): any;
};

export type PostgresCalculationStoreOptions = {
  client: SupabaseLike;
  /**
   * Needed to translate a metric key into the `vm_*` id the schema references.
   * The store does not otherwise care what a metric means.
   */
  metrics: ValueMetricRegistry;
  clock: Clock;
};

type RunRow = {
  id: string;
  org_id: string;
  status: RunStatus;
  trigger_type: TriggerType;
  effective_as_of: string;
  recorded_through: string;
  horizon: TimeHorizon | null;
  preference: RunObservationPolicy;
  scenario_entity_id: EntityId | null;
  root_node_ids: string[] | null;
  root_metric_keys: string[] | null;
  subject_entity_ids: EntityId[] | null;
  engine_version: string;
  period_start: string | null;
  period_end: string | null;
  period_grain: PeriodGrain | null;
  scenario_revision_id: string | null;
  started_at: string;
  completed_at: string | null;
  replay_of_run_id: string | null;
  notes: string | null;
  created_by: UserId | null;
};

type StepRow = {
  id: string;
  org_id: string;
  run_id: string;
  sequence: number;
  calculation_key: string;
  calculation_version: string;
  output_node_id: string;
  output_metric_id: string;
  status: StepStatus;
  output_value: string | null;
  output_value_raw: string | null;
  output_unit: QuantityUnit | null;
  output_currency: string | null;
  output_observation_id: string | null;
  rendered_expression: string | null;
  inputs: TracedInput[] | null;
  confidence: number | string | null;
  input_fingerprint: string | null;
  error_code: string | null;
  error_message: string | null;
  recorded_at: string;
};

const num = (v: number | string | null | undefined): number | null =>
  v === null || v === undefined ? null : typeof v === 'number' ? v : Number(v);

const RUN_COLS =
  'id, org_id, status, trigger_type, effective_as_of, recorded_through, horizon, ' +
  'preference, scenario_entity_id, ' +
  'root_node_ids, root_metric_keys, subject_entity_ids, engine_version, period_start, period_end, period_grain, scenario_revision_id, ' +
  'started_at, completed_at, replay_of_run_id, notes, created_by';
const STEP_COLS =
  'id, org_id, run_id, sequence, calculation_key, calculation_version, output_node_id, ' +
  'output_metric_id, status, output_value, output_value_raw, output_unit, output_currency, ' +
  'output_observation_id, rendered_expression, inputs, confidence, input_fingerprint, ' +
  'error_code, error_message, recorded_at';

export function createPostgresCalculationStore(
  opts: PostgresCalculationStoreOptions,
): CalculationStore {
  const { client, metrics, clock } = opts;

  /**
   * The run's context is stored as columns rather than a JSON blob, so "which
   * runs read scenario values?" is a WHERE clause instead of a full scan. The
   * port still presents it as one nested object, because that is the shape a
   * caller reasons about.
   */
  const toRun = (r: RunRow): CalculationRun => ({
    id: r.id,
    orgId: r.org_id as OrgId,
    status: r.status,
    triggerType: r.trigger_type,
    context: {
      effectiveAsOf: r.effective_as_of,
      recordedThrough: r.recorded_through,
      horizon: r.horizon,
      preference: r.preference,
      scenarioEntityId: r.scenario_entity_id,
      rootNodeIds: r.root_node_ids ?? [],
      rootMetricKeys: r.root_metric_keys ?? [],
      subjectEntityIds: r.subject_entity_ids ?? [],
      engineVersion: r.engine_version,
      // Timestamps come back in Postgres' own spelling; normalized to the ISO
      // form every Period is built with, so equal periods compare equal.
      period:
        r.period_start && r.period_end && r.period_grain
          ? {
              start: new Date(r.period_start).toISOString(),
              end: new Date(r.period_end).toISOString(),
              grain: r.period_grain,
            }
          : null,
      scenarioRevisionId: r.scenario_revision_id,
    },
    startedAt: asRecordTime(r.started_at),
    completedAt: r.completed_at === null ? null : asRecordTime(r.completed_at),
    replayOfRunId: r.replay_of_run_id,
    notes: r.notes,
    createdBy: r.created_by,
  });

  const toStep = (r: StepRow): CalculationStep => ({
    id: r.id,
    orgId: r.org_id as OrgId,
    runId: r.run_id,
    sequence: r.sequence,
    calculationKey: r.calculation_key,
    calculationVersion: r.calculation_version,
    outputNodeId: r.output_node_id,
    // The schema stores the metric id; the port speaks in keys, and the
    // registry is the only thing that knows the mapping.
    outputMetricKey: metricKeyOf(r.output_metric_id),
    status: r.status,
    outputValue: r.output_value,
    outputValueRaw: r.output_value_raw,
    outputUnit: r.output_unit,
    outputCurrency: r.output_currency,
    outputObservationId: r.output_observation_id,
    renderedExpression: r.rendered_expression,
    inputs: r.inputs ?? [],
    confidence: num(r.confidence) as Confidence | null,
    inputFingerprint: r.input_fingerprint,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    recordedAt: asRecordTime(r.recorded_at),
  });

  /** Reverse of `valueMetricId`, resolved through the registry rather than guessed. */
  function metricKeyOf(metricId: string): string {
    for (const m of metrics.allMetrics()) {
      if (valueMetricId(m.key) === metricId) return m.key;
    }
    // A metric that has been retired from the registry but still appears in a
    // historical trace. The id is more useful than an empty string.
    return metricId;
  }

  return {
    async createRun(scope, run) {
      const { data, error } = await client
        .from('helm_calculation_runs')
        .insert({
          org_id: scope.orgId,
          status: run.status,
          trigger_type: run.triggerType,
          effective_as_of: run.context.effectiveAsOf,
          recorded_through: run.context.recordedThrough,
          horizon: run.context.horizon,
          preference: run.context.preference,
          scenario_entity_id: run.context.scenarioEntityId,
          root_node_ids: run.context.rootNodeIds,
          root_metric_keys: run.context.rootMetricKeys,
          subject_entity_ids: run.context.subjectEntityIds,
          engine_version: run.context.engineVersion,
          period_start: run.context.period?.start ?? null,
          period_end: run.context.period?.end ?? null,
          period_grain: run.context.period?.grain ?? null,
          scenario_revision_id: run.context.scenarioRevisionId,
          // Both ends of a run come from the same clock: started_at defaulting to the server's now() while completeRun
          // stamps the injected clock let a run "complete" before it started (2026-10-09, run 7de54cfe).
          started_at: clock.now().toISOString(),
          completed_at: run.completedAt,
          replay_of_run_id: run.replayOfRunId,
          notes: run.notes,
          created_by: run.createdBy,
        })
        .select(RUN_COLS)
        .single();
      if (error) {
        return fail(
          CalculationErrors.WRITE_FAILED,
          `Could not open a calculation run: ${error.message}`,
        );
      }
      return ok(toRun(data as RunRow));
    },

    async completeRun(scope, runId, status, notes) {
      const patch: Record<string, unknown> = {
        status,
        completed_at: clock.now().toISOString(),
      };
      if (notes !== undefined) patch.notes = notes;

      const { data, error } = await client
        .from('helm_calculation_runs')
        .update(patch)
        .eq('org_id', scope.orgId)
        .eq('id', runId)
        .select(RUN_COLS)
        .single();
      if (error) {
        return fail(
          CalculationErrors.WRITE_FAILED,
          `Could not close calculation run ${runId}: ${error.message}`,
        );
      }
      return ok(toRun(data as RunRow));
    },

    async getRun(scope, runId) {
      const { data, error } = await client
        .from('helm_calculation_runs')
        .select(RUN_COLS)
        .eq('org_id', scope.orgId)
        .eq('id', runId)
        .maybeSingle();
      if (error) {
        return fail(CalculationErrors.READ_FAILED, `Run read failed: ${error.message}`);
      }
      return ok(data ? toRun(data as RunRow) : null);
    },

    async listRuns(scope, limit) {
      const { data, error } = await client
        .from('helm_calculation_runs')
        .select(RUN_COLS)
        .eq('org_id', scope.orgId)
        .order('started_at', { ascending: false })
        .limit(limit);
      if (error) {
        return fail(CalculationErrors.READ_FAILED, `Run list failed: ${error.message}`);
      }
      return ok(((data ?? []) as RunRow[]).map(toRun));
    },

    async appendStep(scope, step) {
      const { data, error } = await client
        .from('helm_calculation_steps')
        .insert({
          org_id: scope.orgId,
          run_id: step.runId,
          sequence: step.sequence,
          calculation_key: step.calculationKey,
          calculation_version: step.calculationVersion,
          output_node_id: step.outputNodeId,
          output_metric_id: valueMetricId(step.outputMetricKey),
          status: step.status,
          output_value: step.outputValue,
          output_value_raw: step.outputValueRaw,
          output_unit: step.outputUnit,
          output_currency: step.outputCurrency,
          output_observation_id: step.outputObservationId,
          rendered_expression: step.renderedExpression,
          inputs: step.inputs,
          confidence: step.confidence,
          input_fingerprint: step.inputFingerprint,
          error_code: step.errorCode,
          error_message: step.errorMessage,
        })
        .select(STEP_COLS)
        .single();
      if (error) {
        return fail(
          CalculationErrors.WRITE_FAILED,
          `Could not append a calculation step: ${error.message}`,
        );
      }
      return ok(toStep(data as StepRow));
    },

    async getSteps(scope, runId) {
      const { data, error } = await client
        .from('helm_calculation_steps')
        .select(STEP_COLS)
        .eq('org_id', scope.orgId)
        .eq('run_id', runId)
        .order('sequence', { ascending: true });
      if (error) {
        return fail(CalculationErrors.READ_FAILED, `Trace read failed: ${error.message}`);
      }
      return ok(((data ?? []) as StepRow[]).map(toStep));
    },

    async findStepByOutputObservation(scope, observationId) {
      // A partial unique index guarantees at most one step per observation, so
      // "the step that produced this number" is a single row, not a guess.
      const { data, error } = await client
        .from('helm_calculation_steps')
        .select(STEP_COLS)
        .eq('org_id', scope.orgId)
        .eq('output_observation_id', observationId)
        .maybeSingle();
      if (error) {
        return fail(CalculationErrors.READ_FAILED, `Lineage lookup failed: ${error.message}`);
      }
      return ok(data ? toStep(data as StepRow) : null);
    },

    async findLatestStepForNode(scope, nodeId) {
      const { data, error } = await client
        .from('helm_calculation_steps')
        .select(STEP_COLS)
        .eq('org_id', scope.orgId)
        .eq('output_node_id', nodeId)
        .in('status', ['CALCULATED', 'UNCHANGED'])
        .order('recorded_at', { ascending: false })
        .limit(1);
      if (error) {
        return fail(CalculationErrors.READ_FAILED, `Freshness lookup failed: ${error.message}`);
      }
      const rows = (data ?? []) as StepRow[];
      return ok(rows.length > 0 ? toStep(rows[0]) : null);
    },

  };
}

/** Deterministic id for a calculation's governance row, matching the migration. */
export const calculationRowId = (key: string, version: string): string =>
  `calc_${key}@${version}`;

/**
 * Reads the governance rows and reports any disagreement with the code registry.
 *
 * The database holds metadata and the code holds implementations (ADR-0017 §1);
 * if they drift, a manager reading the owner and rationale of a calculation is
 * reading about something other than the formula that produced their number.
 * `verify:calculations` runs this against the generated migration; this function
 * exists so it can also be run against a live database.
 */
export async function readCalculationMetadata(
  client: SupabaseLike,
  scope: Scope,
): Promise<
  ReturnType<typeof ok<readonly { id: string; key: string; version: string; status: string }[]>>
  | ReturnType<typeof fail>
> {
  const { data, error } = await client
    .from('helm_calculations')
    .select('id, key, version, status, owner, rationale, expression, inputs, org_id')
    .or(`org_id.is.null,org_id.eq.${scope.orgId}`);
  if (error) {
    return fail(CalculationErrors.READ_FAILED, `Calculation metadata read failed: ${error.message}`);
  }
  return ok(
    (data ?? []) as readonly { id: string; key: string; version: string; status: string }[],
  );
}
