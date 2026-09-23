/**
 * PostgresScenarioStore — the ScenarioStore over Supabase.
 *
 * The I/O boundary of @helm/scenario-runtime, held to the same conformance
 * suite as the in-memory store. Two layers enforce the contract: this adapter
 * checks what it can before writing (so a caller gets a typed error), and the
 * database's guard triggers and RLS refuse the rest (so a client that bypasses
 * this adapter gets nowhere either). Tenant isolation is RLS's job; every
 * query is ALSO filtered by org_id, so a policy mistake could never widen a
 * read by itself.
 *
 * Exact decimals travel as text. Timestamps come back in Postgres' spelling
 * and are normalized to ISO so periods and forks compare equal.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  fail,
  ok,
  type Clock,
  type EntityId,
  type OrgId,
  type Period,
  type PeriodGrain,
  type QuantityUnit,
  type Result,
  type Scope,
  type UserId,
} from '@helm/shared';
import {
  ScenarioErrors,
  scenarioTransitions,
  type Completeness,
  type ConstraintKind,
  type ConstraintSeverity,
  type ConstraintStatus,
  type ModelRef,
  type OverrideProvenanceKind,
  type OverrideType,
  type RevisionReason,
  type RevisionState,
  type Scenario,
  type ScenarioConstraintResult,
  type ScenarioOverride,
  type ScenarioRevision,
  type ScenarioRun,
  type ScenarioRunKind,
  type ScenarioRunStatus,
  type ScenarioStatus,
  type StateKind,
} from './types.ts';
import type { ScenarioStore } from './port.ts';

export type PostgresScenarioStoreOptions = {
  client: SupabaseClient;
  clock: Clock;
};

const iso = (t: string | null): string | null => (t === null ? null : new Date(t).toISOString());
const num = (v: number | string | null | undefined): number | null =>
  v === null || v === undefined ? null : typeof v === 'number' ? v : Number(v);
const periodOf = (start: string | null, end: string | null, grain: string | null): Period | null =>
  start && end && grain ? { start: iso(start)!, end: iso(end)!, grain: grain as PeriodGrain } : null;
const periodsOf = (json: unknown): Period[] =>
  (Array.isArray(json) ? json : []).map((p: { start: string; end: string; grain: PeriodGrain }) => ({
    start: iso(p.start)!,
    end: iso(p.end)!,
    grain: p.grain,
  }));
const periodJson = (p: Period) => ({ start: new Date(p.start).toISOString(), end: new Date(p.end).toISOString(), grain: p.grain });

const SCENARIO_COLS =
  'id, org_id, key, name, description, parent_scenario_id, scenario_entity_id, status, ' +
  'status_reason, created_by, created_at, updated_at, metadata';
const REVISION_COLS =
  'id, org_id, scenario_id, revision_number, state, reason, based_on_revision_id, ' +
  'parent_revision_id, effective_as_of, recorded_through, observation_policy, periods, ' +
  'model_ref, fingerprint, sealed_at, notes, created_by, created_at';
const OVERRIDE_COLS =
  'id, org_id, scenario_id, revision_id, override_type, target_node_id, metric_key, ' +
  'subject_entity_id, operation, value, unit_type, currency, period_start, period_end, ' +
  'period_grain, provenance_kind, source_system, rationale, confidence, created_by, created_at';
const RUN_COLS =
  'id, org_id, state_kind, scenario_id, revision_id, kind, replay_of_run_id, status, ' +
  'completeness, effective_as_of, recorded_through, observation_policy, periods, fingerprint, ' +
  'model_ref, period_runs, started_at, completed_at, created_by, notes';
const RESULT_COLS =
  'constraint_key, constraint_version, name, kind, period_start, period_end, period_grain, ' +
  'status, threshold, actual, breach_amount, unit_type, severity, explanation';

type Row = Record<string, unknown>;

const toScenario = (r: Row): Scenario => ({
  id: r.id as string,
  orgId: r.org_id as OrgId,
  key: r.key as string,
  name: r.name as string,
  description: (r.description as string) ?? '',
  parentScenarioId: (r.parent_scenario_id as string) ?? null,
  scenarioEntityId: r.scenario_entity_id as EntityId,
  status: r.status as ScenarioStatus,
  statusReason: (r.status_reason as string) ?? null,
  createdBy: (r.created_by as UserId) ?? null,
  createdAt: iso(r.created_at as string)!,
  updatedAt: iso(r.updated_at as string)!,
  metadata: (r.metadata as Record<string, unknown>) ?? {},
});

const toRevision = (r: Row): ScenarioRevision => ({
  id: r.id as string,
  orgId: r.org_id as OrgId,
  scenarioId: r.scenario_id as string,
  revisionNumber: r.revision_number as number,
  state: r.state as RevisionState,
  reason: r.reason as RevisionReason,
  basedOnRevisionId: (r.based_on_revision_id as string) ?? null,
  parentRevisionId: (r.parent_revision_id as string) ?? null,
  fork: {
    effectiveAsOf: iso(r.effective_as_of as string)!,
    recordedThrough: iso(r.recorded_through as string)!,
    policy: r.observation_policy as ScenarioRevision['fork']['policy'],
  },
  periods: periodsOf(r.periods),
  modelRef: (r.model_ref as ModelRef) ?? null,
  fingerprint: (r.fingerprint as string) ?? null,
  notes: (r.notes as string) ?? null,
  createdBy: (r.created_by as UserId) ?? null,
  createdAt: iso(r.created_at as string)!,
  sealedAt: iso((r.sealed_at as string) ?? null),
});

const toOverride = (r: Row): ScenarioOverride => ({
  id: r.id as string,
  orgId: r.org_id as OrgId,
  scenarioId: r.scenario_id as string,
  revisionId: r.revision_id as string,
  overrideType: r.override_type as OverrideType,
  targetNodeId: r.target_node_id as string,
  metricKey: r.metric_key as string,
  subjectEntityId: (r.subject_entity_id as EntityId) ?? null,
  operation: r.operation as ScenarioOverride['operation'],
  value: r.value as string,
  unit: r.unit_type as QuantityUnit,
  currency: (r.currency as string) ?? null,
  period: periodOf(r.period_start as string, r.period_end as string, r.period_grain as string),
  provenanceKind: r.provenance_kind as OverrideProvenanceKind,
  sourceSystem: r.source_system as string,
  rationale: r.rationale as string,
  confidence: num(r.confidence as number | string | null),
  createdBy: (r.created_by as UserId) ?? null,
  createdAt: iso(r.created_at as string)!,
});

const toRun = (r: Row): ScenarioRun => ({
  id: r.id as string,
  orgId: r.org_id as OrgId,
  stateKind: r.state_kind as StateKind,
  scenarioId: (r.scenario_id as string) ?? null,
  revisionId: (r.revision_id as string) ?? null,
  kind: r.kind as ScenarioRunKind,
  replayOfRunId: (r.replay_of_run_id as string) ?? null,
  status: r.status as ScenarioRunStatus,
  completeness: (r.completeness as Completeness) ?? null,
  fork: {
    effectiveAsOf: iso(r.effective_as_of as string)!,
    recordedThrough: iso(r.recorded_through as string)!,
    policy: r.observation_policy as ScenarioRun['fork']['policy'],
  },
  periods: periodsOf(r.periods),
  fingerprint: r.fingerprint as string,
  modelRef: r.model_ref as ModelRef,
  periodRuns: (Array.isArray(r.period_runs) ? r.period_runs : []).map(
    (p: { period: Period; calculationRunId: string }) => ({
      period: periodsOf([p.period])[0],
      calculationRunId: p.calculationRunId,
    }),
  ),
  startedAt: iso(r.started_at as string)!,
  completedAt: iso((r.completed_at as string) ?? null),
  createdBy: (r.created_by as UserId) ?? null,
  notes: (r.notes as string) ?? null,
});

const toResult = (r: Row): ScenarioConstraintResult => ({
  constraintKey: r.constraint_key as string,
  constraintVersion: r.constraint_version as string,
  name: r.name as string,
  kind: r.kind as ConstraintKind,
  period: periodOf(r.period_start as string, r.period_end as string, r.period_grain as string)!,
  status: r.status as ConstraintStatus,
  threshold: (r.threshold as string) ?? null,
  actual: (r.actual as string) ?? null,
  breachAmount: (r.breach_amount as string) ?? null,
  unit: (r.unit_type as QuantityUnit) ?? null,
  severity: r.severity as ConstraintSeverity,
  explanation: r.explanation as string,
});

export function createPostgresScenarioStore(opts: PostgresScenarioStoreOptions): ScenarioStore {
  const { client } = opts;
  void opts.clock;

  const wrote = (what: string, message: string) =>
    fail(ScenarioErrors.WRITE_FAILED, `Could not ${what}: ${message}`);
  const read = (what: string, message: string) =>
    fail(ScenarioErrors.READ_FAILED, `Could not read ${what}: ${message}`);

  async function one<T>(
    table: string,
    cols: string,
    scope: Scope,
    id: string,
    map: (r: Row) => T,
  ): Promise<Result<T | null>> {
    const { data, error } = await client.from(table).select(cols).eq('org_id', scope.orgId).eq('id', id).maybeSingle();
    if (error) return read(table, error.message);
    return ok(data ? map(data as unknown as Row) : null);
  }

  const store: ScenarioStore = {
    async createScenario(scope, input) {
      const existing = await store.getScenarioByKey(scope, input.key);
      if (!existing.ok) return existing;
      if (existing.value) {
        return fail(ScenarioErrors.DUPLICATE_KEY, `A scenario with key "${input.key}" already exists.`);
      }
      const { data, error } = await client
        .from('helm_scenarios')
        .insert({
          org_id: scope.orgId,
          key: input.key,
          name: input.name,
          description: input.description,
          parent_scenario_id: input.parentScenarioId,
          scenario_entity_id: input.scenarioEntityId,
          status: 'DRAFT',
          metadata: input.metadata,
          created_by: input.createdBy,
        })
        .select(SCENARIO_COLS)
        .single();
      if (error) return wrote('create the scenario', error.message);
      return ok(toScenario(data as unknown as Row));
    },

    getScenario: (scope, id) => one('helm_scenarios', SCENARIO_COLS, scope, id, toScenario),

    async getScenarioByKey(scope, key) {
      const { data, error } = await client
        .from('helm_scenarios')
        .select(SCENARIO_COLS)
        .eq('org_id', scope.orgId)
        .eq('key', key)
        .maybeSingle();
      if (error) return read('scenario', error.message);
      return ok(data ? toScenario(data as unknown as Row) : null);
    },

    async listScenarios(scope) {
      const { data, error } = await client
        .from('helm_scenarios')
        .select(SCENARIO_COLS)
        .eq('org_id', scope.orgId)
        .not('key', 'is', null)
        .order('created_at', { ascending: true })
        .order('key', { ascending: true });
      if (error) return read('scenarios', error.message);
      return ok((data ?? []).map((r) => toScenario(r as unknown as Row)));
    },

    async setScenarioStatus(scope, id, status, reason = null) {
      const current = await store.getScenario(scope, id);
      if (!current.ok) return current;
      if (!current.value) return fail(ScenarioErrors.NOT_FOUND, `Scenario ${id} not found.`);
      const from = current.value.status;
      if (from !== status && !scenarioTransitions[from].includes(status)) {
        return fail(ScenarioErrors.INVALID_TRANSITION, `A ${from} scenario cannot become ${status}.`, {
          from,
          to: status,
        });
      }
      const { data, error } = await client
        .from('helm_scenarios')
        .update({ status, status_reason: reason })
        .eq('org_id', scope.orgId)
        .eq('id', id)
        .select(SCENARIO_COLS)
        .single();
      if (error) return wrote('change the scenario status', error.message);
      return ok(toScenario(data as unknown as Row));
    },

    async createRevision(scope, input) {
      if (input.periods.length === 0) {
        return fail(ScenarioErrors.INVALID_INPUT, 'A revision must model at least one period.');
      }
      const existing = await store.listRevisions(scope, input.scenarioId);
      if (!existing.ok) return existing;
      if (existing.value.some((r) => r.state === 'DRAFT')) {
        return fail(ScenarioErrors.DRAFT_EXISTS, 'This scenario already has a draft revision.');
      }
      const { data, error } = await client
        .from('helm_scenario_revisions')
        .insert({
          org_id: scope.orgId,
          scenario_id: input.scenarioId,
          revision_number: existing.value.length + 1,
          state: 'DRAFT',
          reason: input.reason,
          based_on_revision_id: input.basedOnRevisionId,
          parent_revision_id: input.parentRevisionId,
          effective_as_of: input.fork.effectiveAsOf,
          recorded_through: input.fork.recordedThrough,
          observation_policy: input.fork.policy,
          periods: input.periods.map(periodJson),
          notes: input.notes,
          created_by: input.createdBy,
        })
        .select(REVISION_COLS)
        .single();
      if (error) return wrote('create the revision', error.message);
      return ok(toRevision(data as unknown as Row));
    },

    getRevision: (scope, id) => one('helm_scenario_revisions', REVISION_COLS, scope, id, toRevision),

    async listRevisions(scope, scenarioId) {
      const { data, error } = await client
        .from('helm_scenario_revisions')
        .select(REVISION_COLS)
        .eq('org_id', scope.orgId)
        .eq('scenario_id', scenarioId)
        .order('revision_number', { ascending: true });
      if (error) return read('revisions', error.message);
      return ok((data ?? []).map((r) => toRevision(r as unknown as Row)));
    },

    async sealRevision(scope, id, seal) {
      const current = await store.getRevision(scope, id);
      if (!current.ok) return current;
      if (!current.value) return fail(ScenarioErrors.NOT_FOUND, `Revision ${id} not found.`);
      if (current.value.state === 'SEALED') {
        return fail(ScenarioErrors.REVISION_SEALED, `Revision ${id} is already sealed.`);
      }
      const { data, error } = await client
        .from('helm_scenario_revisions')
        .update({
          state: 'SEALED',
          model_ref: seal.modelRef,
          fingerprint: seal.fingerprint,
          sealed_at: opts.clock.now().toISOString(),
        })
        .eq('org_id', scope.orgId)
        .eq('id', id)
        .eq('state', 'DRAFT')
        .select(REVISION_COLS)
        .single();
      if (error) return wrote('seal the revision', error.message);
      return ok(toRevision(data as unknown as Row));
    },

    async addOverride(scope, input) {
      const revision = await store.getRevision(scope, input.revisionId);
      if (!revision.ok) return revision;
      if (!revision.value) return fail(ScenarioErrors.NOT_FOUND, `Revision ${input.revisionId} not found.`);
      if (revision.value.state !== 'DRAFT') {
        return fail(
          ScenarioErrors.REVISION_SEALED,
          'A sealed revision is immutable; create a new revision to change its assumptions.',
        );
      }
      const { data, error } = await client
        .from('helm_scenario_overrides')
        .insert({
          org_id: scope.orgId,
          scenario_id: input.scenarioId,
          revision_id: input.revisionId,
          override_type: input.overrideType,
          target_node_id: input.targetNodeId,
          metric_key: input.metricKey,
          subject_entity_id: input.subjectEntityId,
          operation: input.operation,
          value: input.value,
          unit_type: input.unit,
          currency: input.currency,
          period_start: input.period?.start ?? null,
          period_end: input.period?.end ?? null,
          period_grain: input.period?.grain ?? null,
          provenance_kind: input.provenanceKind,
          source_system: input.sourceSystem,
          rationale: input.rationale,
          confidence: input.confidence,
          created_by: input.createdBy,
        })
        .select(OVERRIDE_COLS)
        .single();
      if (error) return wrote('add the override', error.message);
      return ok(toOverride(data as unknown as Row));
    },

    async removeOverride(scope, id) {
      const current = await one('helm_scenario_overrides', OVERRIDE_COLS, scope, id, toOverride);
      if (!current.ok) return current;
      if (!current.value) return fail(ScenarioErrors.NOT_FOUND, `Override ${id} not found.`);
      const revision = await store.getRevision(scope, current.value.revisionId);
      if (!revision.ok) return revision;
      if (revision.value?.state !== 'DRAFT') {
        return fail(ScenarioErrors.REVISION_SEALED, 'Overrides of a sealed revision cannot be removed.');
      }
      const { error } = await client.from('helm_scenario_overrides').delete().eq('org_id', scope.orgId).eq('id', id);
      if (error) return wrote('remove the override', error.message);
      return ok(undefined);
    },

    async listOverrides(scope, revisionId) {
      const { data, error } = await client
        .from('helm_scenario_overrides')
        .select(OVERRIDE_COLS)
        .eq('org_id', scope.orgId)
        .eq('revision_id', revisionId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true });
      if (error) return read('overrides', error.message);
      return ok((data ?? []).map((r) => toOverride(r as unknown as Row)));
    },

    async createRun(scope, input) {
      if (input.stateKind === 'SCENARIO') {
        const revision = input.revisionId ? await store.getRevision(scope, input.revisionId) : null;
        if (revision && !revision.ok) return revision;
        const r = revision?.value ?? null;
        if (!r || r.scenarioId !== input.scenarioId) {
          return fail(ScenarioErrors.NOT_FOUND, 'A scenario run needs a revision of its scenario.');
        }
        if (r.state !== 'SEALED') {
          return fail(ScenarioErrors.NOT_EXECUTABLE, 'Only a sealed revision can be simulated.');
        }
        if (
          r.fork.effectiveAsOf !== iso(input.fork.effectiveAsOf) ||
          r.fork.recordedThrough !== iso(input.fork.recordedThrough) ||
          r.fork.policy !== input.fork.policy
        ) {
          return fail(ScenarioErrors.INVALID_INPUT, "A scenario run must use its revision's fork.");
        }
      } else if (input.scenarioId || input.revisionId) {
        return fail(ScenarioErrors.INVALID_INPUT, 'A baseline run carries no scenario.');
      }
      const { data, error } = await client
        .from('helm_scenario_runs')
        .insert({
          org_id: scope.orgId,
          state_kind: input.stateKind,
          scenario_id: input.scenarioId,
          revision_id: input.revisionId,
          kind: input.kind,
          replay_of_run_id: input.replayOfRunId,
          status: 'RUNNING',
          effective_as_of: input.fork.effectiveAsOf,
          recorded_through: input.fork.recordedThrough,
          observation_policy: input.fork.policy,
          periods: input.periods.map(periodJson),
          fingerprint: input.fingerprint,
          model_ref: input.modelRef,
          created_by: input.createdBy,
          notes: input.notes,
        })
        .select(RUN_COLS)
        .single();
      if (error) return wrote('start the simulation', error.message);
      return ok(toRun(data as unknown as Row));
    },

    async attachPeriodRun(scope, runId, periodRun) {
      const current = await store.getRun(scope, runId);
      if (!current.ok) return current;
      if (!current.value) return fail(ScenarioErrors.NOT_FOUND, `Run ${runId} not found.`);
      if (current.value.status !== 'RUNNING') {
        return fail(ScenarioErrors.IMMUTABLE, 'A completed simulation cannot gain periods.');
      }
      const next = [
        ...current.value.periodRuns.map((p) => ({ period: periodJson(p.period), calculationRunId: p.calculationRunId })),
        { period: periodJson(periodRun.period), calculationRunId: periodRun.calculationRunId },
      ];
      const { data, error } = await client
        .from('helm_scenario_runs')
        .update({ period_runs: next })
        .eq('org_id', scope.orgId)
        .eq('id', runId)
        .eq('status', 'RUNNING')
        .select(RUN_COLS)
        .single();
      if (error) return wrote('record the period run', error.message);
      return ok(toRun(data as unknown as Row));
    },

    async completeRun(scope, runId, outcome) {
      const current = await store.getRun(scope, runId);
      if (!current.ok) return current;
      if (!current.value) return fail(ScenarioErrors.NOT_FOUND, `Run ${runId} not found.`);
      if (current.value.status !== 'RUNNING') {
        return fail(ScenarioErrors.IMMUTABLE, 'A simulation completes once.');
      }
      const { data, error } = await client
        .from('helm_scenario_runs')
        .update({
          status: outcome.status,
          completeness: outcome.completeness,
          completed_at: opts.clock.now().toISOString(),
        })
        .eq('org_id', scope.orgId)
        .eq('id', runId)
        .eq('status', 'RUNNING')
        .select(RUN_COLS)
        .single();
      if (error) return wrote('complete the simulation', error.message);
      return ok(toRun(data as unknown as Row));
    },

    getRun: (scope, id) => one('helm_scenario_runs', RUN_COLS, scope, id, toRun),

    async listRuns(scope, filter = {}) {
      let q = client.from('helm_scenario_runs').select(RUN_COLS).eq('org_id', scope.orgId);
      if (filter.scenarioId !== undefined) q = q.eq('scenario_id', filter.scenarioId);
      if (filter.revisionId !== undefined) q = q.eq('revision_id', filter.revisionId);
      if (filter.stateKind !== undefined) q = q.eq('state_kind', filter.stateKind);
      const { data, error } = await q.order('started_at', { ascending: true }).order('id', { ascending: true });
      if (error) return read('simulations', error.message);
      return ok((data ?? []).map((r) => toRun(r as unknown as Row)));
    },

    async recordConstraintResults(scope, runId, results) {
      const run = await store.getRun(scope, runId);
      if (!run.ok) return run;
      if (!run.value) return fail(ScenarioErrors.NOT_FOUND, `Run ${runId} not found.`);
      if (run.value.status === 'RUNNING') {
        return fail(ScenarioErrors.IMMUTABLE, 'A simulation is judged after it completes.');
      }
      const existing = await store.listConstraintResults(scope, runId);
      if (!existing.ok) return existing;
      if (existing.value.length > 0) {
        return fail(ScenarioErrors.IMMUTABLE, 'Constraint results are recorded once per simulation.');
      }
      if (results.length === 0) return ok(undefined);
      const { error } = await client.from('helm_scenario_constraint_results').insert(
        results.map((r) => ({
          org_id: scope.orgId,
          scenario_run_id: runId,
          constraint_key: r.constraintKey,
          constraint_version: r.constraintVersion,
          name: r.name,
          kind: r.kind,
          period_start: r.period.start,
          period_end: r.period.end,
          period_grain: r.period.grain,
          status: r.status,
          threshold: r.threshold,
          actual: r.actual,
          breach_amount: r.breachAmount,
          unit_type: r.unit,
          severity: r.severity,
          explanation: r.explanation,
        })),
      );
      if (error) return wrote('record constraint results', error.message);
      return ok(undefined);
    },

    async listConstraintResults(scope, runId) {
      const { data, error } = await client
        .from('helm_scenario_constraint_results')
        .select(RESULT_COLS)
        .eq('org_id', scope.orgId)
        .eq('scenario_run_id', runId)
        .order('period_start', { ascending: true })
        .order('constraint_key', { ascending: true });
      if (error) return read('constraint results', error.message);
      return ok((data ?? []).map((r) => toResult(r as unknown as Row)));
    },
  };
  return store;
}
