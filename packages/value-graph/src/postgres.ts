/**
 * PostgresValueGraph — the production ValueGraph adapter.
 *
 * Held to the same conformance suite as the in-memory adapter, which is the
 * reference semantics (ADR-0015). Tenant isolation is enforced twice: every
 * query filters on `scope.orgId`, and RLS filters again server-side.
 *
 * Traversal is bounded level-by-level BFS with one batched query per level,
 * matching the Phase 1 GraphStore adapter's approach and reasoning.
 */

import {
  asProvenanceId,
  asRecordTime,
  asValidTime,
  chainConfidence,
  clampConfidence,
  fail,
  isValidAt,
  ok,
  toIso,
  type Clock,
  type Confidence,
  type EntityId,
  type OrgId,
  type ProvenanceInput,
  type ProvenanceRecord,
  type Scope,
  type SourceSystem,
  type UserId,
} from '@helm/shared';
import type { GraphStore } from '@helm/graph-store';
import type { OntologyRegistry } from '@helm/ontology';
import { ValueErrorCodes, byRecency, type ValueMetricRegistry } from './registry.ts';
import type {
  ContentionPoint,
  LatestObservationQuery,
  MetricQuery,
  ObservationQuery,
  ValueChain,
  ValueChainNode,
  ValueDirection,
  ValueGraph,
  ValueLinkQuery,
  ValueNeighbor,
  ValueNodeQuery,
  ValueTraversalSpec,
} from './port.ts';
import type {
  ObservationType,
  UnitType,
  ValueLink,
  ValueLinkInput,
  ValueLinkType,
  ValueMetricDefinition,
  ValueNode,
  ValueNodeInput,
  ValueObservation,
  ValueObservationInput,
} from './types.ts';

const MAX_ALLOWED_DEPTH = 12;
const DEFAULT_MAX_NODES = 1000;

export type SupabaseLike = {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  from(table: string): any;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  rpc(fn: string, args?: Record<string, unknown>): any;
};

export type PostgresValueGraphOptions = {
  client: SupabaseLike;
  metrics: ValueMetricRegistry;
  ontology: OntologyRegistry;
  graphStore: GraphStore;
  clock: Clock;
};

type NodeRow = {
  id: string;
  org_id: string;
  metric_id: string;
  subject_entity_id: string | null;
  scope_kind: ValueNode['scopeKind'];
  scope_ref: string | null;
  time_horizon: ValueNode['timeHorizon'];
  label: string;
  metadata: Record<string, unknown>;
  created_by: UserId | null;
  created_at: string;
  updated_at: string;
};

type LinkRow = {
  id: string;
  org_id: string;
  link_type: ValueLinkType;
  source_node_id: string;
  target_node_id: string;
  weight: number | string | null;
  confidence: number | string | null;
  lag_days: number | null;
  valid_from: string;
  valid_to: string | null;
  observed_at: string | null;
  ingested_at: string;
  updated_at: string;
  source_system: SourceSystem;
  metadata: Record<string, unknown>;
  created_by: UserId | null;
};

type ObsRow = {
  id: string;
  org_id: string;
  node_id: string;
  observation_type: ObservationType;
  numeric_value: number | string | null;
  text_value: string | null;
  unit_type: UnitType;
  currency: string | null;
  effective_at: string | null;
  period_start: string | null;
  period_end: string | null;
  observed_at: string | null;
  recorded_at: string;
  scenario_entity_id: string | null;
  assumption_entity_id: string | null;
  confidence: number | string | null;
  source_system: SourceSystem;
  provenance_id: string | null;
  calculation_run_id: string | null;
  metadata: Record<string, unknown>;
  created_by: UserId | null;
};

type ProvRow = {
  id: string;
  org_id: string;
  subject_kind: ProvenanceRecord['subjectKind'];
  subject_id: string;
  source_field: string | null;
  method: ProvenanceRecord['method'];
  system: SourceSystem;
  connector: string | null;
  source_object_type: string | null;
  source_object_id: string | null;
  ingestion_event_id: string | null;
  transformation: string | null;
  inputs: Record<string, unknown> | null;
  actor_id: UserId | null;
  confidence: number | string | null;
  notes: string | null;
  payload: Record<string, unknown> | null;
  observed_at: string | null;
  recorded_at: string;
};

const num = (v: number | string | null | undefined): number | null =>
  v === null || v === undefined ? null : typeof v === 'number' ? v : Number(v);

const NODE_COLS =
  'id, org_id, metric_id, subject_entity_id, scope_kind, scope_ref, time_horizon, ' +
  'label, metadata, created_by, created_at, updated_at';
const LINK_COLS =
  'id, org_id, link_type, source_node_id, target_node_id, weight, confidence, lag_days, ' +
  'valid_from, valid_to, observed_at, ingested_at, updated_at, source_system, metadata, created_by';
const OBS_COLS =
  'id, org_id, node_id, observation_type, numeric_value, text_value, unit_type, currency, ' +
  'effective_at, period_start, period_end, observed_at, recorded_at, scenario_entity_id, ' +
  'assumption_entity_id, confidence, source_system, provenance_id, calculation_run_id, ' +
  'metadata, created_by';

export function createPostgresValueGraph(opts: PostgresValueGraphOptions): ValueGraph {
  const { client, metrics: registry, ontology, graphStore, clock } = opts;

  const metricKeyById = new Map<string, string>();
  const metricIdByKey = new Map<string, string>();
  for (const m of registry.allMetrics()) {
    metricKeyById.set(m.id, m.key);
    metricIdByKey.set(m.key, m.id);
  }
  const metricFor = (key: string) => registry.metric(key);

  const toNode = (r: NodeRow): ValueNode => ({
    id: r.id,
    orgId: r.org_id as OrgId,
    metricId: r.metric_id,
    metricKey: metricKeyById.get(r.metric_id) ?? r.metric_id,
    subjectEntityId: (r.subject_entity_id ?? null) as EntityId | null,
    scopeKind: r.scope_kind,
    scopeRef: r.scope_ref,
    timeHorizon: r.time_horizon,
    label: r.label,
    metadata: r.metadata ?? {},
    createdBy: r.created_by,
    createdAt: asRecordTime(r.created_at),
    updatedAt: asRecordTime(r.updated_at),
  });

  const toLink = (r: LinkRow): ValueLink => ({
    id: r.id,
    orgId: r.org_id as OrgId,
    linkType: r.link_type,
    sourceNodeId: r.source_node_id,
    targetNodeId: r.target_node_id,
    weight: num(r.weight),
    confidence: num(r.confidence),
    lagDays: r.lag_days,
    validFrom: asValidTime(r.valid_from),
    validTo: r.valid_to === null ? null : asValidTime(r.valid_to),
    observedAt: r.observed_at === null ? null : asValidTime(r.observed_at),
    ingestedAt: asRecordTime(r.ingested_at),
    updatedAt: asRecordTime(r.updated_at),
    sourceSystem: r.source_system,
    metadata: r.metadata ?? {},
    createdBy: r.created_by,
  });

  const toObs = (r: ObsRow): ValueObservation => ({
    id: r.id,
    orgId: r.org_id as OrgId,
    nodeId: r.node_id,
    observationType: r.observation_type,
    numericValue: num(r.numeric_value),
    textValue: r.text_value,
    unitType: r.unit_type,
    currency: r.currency,
    effectiveAt: r.effective_at === null ? null : asValidTime(r.effective_at),
    periodStart: r.period_start === null ? null : asValidTime(r.period_start),
    periodEnd: r.period_end === null ? null : asValidTime(r.period_end),
    observedAt: r.observed_at === null ? null : asValidTime(r.observed_at),
    recordedAt: asRecordTime(r.recorded_at),
    scenarioEntityId: (r.scenario_entity_id ?? null) as EntityId | null,
    assumptionEntityId: (r.assumption_entity_id ?? null) as EntityId | null,
    confidence: num(r.confidence),
    sourceSystem: r.source_system,
    provenanceId: r.provenance_id === null ? null : asProvenanceId(r.provenance_id),
    calculationRunId: r.calculation_run_id,
    metadata: r.metadata ?? {},
    createdBy: r.created_by,
  });

  const toProv = (r: ProvRow): ProvenanceRecord => ({
    id: asProvenanceId(r.id),
    orgId: r.org_id as OrgId,
    subjectKind: r.subject_kind,
    subjectId: r.subject_id,
    sourceField: r.source_field,
    method: r.method,
    system: r.system,
    connector: r.connector,
    sourceObjectType: r.source_object_type,
    sourceObjectId: r.source_object_id,
    ingestionEventId: r.ingestion_event_id as ProvenanceRecord['ingestionEventId'],
    transformation: r.transformation,
    inputs: r.inputs,
    actorId: r.actor_id,
    confidence: num(r.confidence),
    notes: r.notes,
    payload: r.payload,
    observedAt: r.observed_at === null ? null : asValidTime(r.observed_at),
    recordedAt: asRecordTime(r.recorded_at),
  });

  const linkValidAt = (r: LinkRow, asOf?: Date | string) =>
    isValidAt(
      {
        validFrom: asValidTime(r.valid_from),
        validTo: r.valid_to === null ? null : asValidTime(r.valid_to),
      },
      asOf ?? clock.now(),
    );

  async function fetchNodes(scope: Scope, ids: readonly string[]): Promise<Map<string, ValueNode>> {
    const map = new Map<string, ValueNode>();
    if (ids.length === 0) return map;
    const { data, error } = await client
      .from('helm_value_nodes')
      .select(NODE_COLS)
      .eq('org_id', scope.orgId)
      .in('id', [...ids]);
    if (error) throw new Error(`helm_value_nodes read failed: ${error.message}`);
    for (const row of (data ?? []) as NodeRow[]) map.set(row.id, toNode(row));
    return map;
  }

  async function fetchLinksFor(
    scope: Scope,
    ids: readonly string[],
    linkTypes: readonly ValueLinkType[] | undefined,
    asOf: Date | string | undefined,
    minConfidence: Confidence | undefined,
  ): Promise<LinkRow[]> {
    if (ids.length === 0) return [];
    const list = `(${ids.join(',')})`;
    let q = client.from('helm_value_links').select(LINK_COLS).eq('org_id', scope.orgId);
    q = q.or(`source_node_id.in.${list},target_node_id.in.${list}`);
    if (linkTypes?.length) q = q.in('link_type', [...linkTypes]);
    const { data, error } = await q;
    if (error) throw new Error(`helm_value_links read failed: ${error.message}`);
    return ((data ?? []) as LinkRow[]).filter(
      (r) =>
        linkValidAt(r, asOf) &&
        (minConfidence === undefined || (num(r.confidence) ?? 1) >= minConfidence),
    );
  }

  function stepsFrom(links: readonly LinkRow[], nodeId: string, direction: ValueDirection) {
    const out: { link: LinkRow; other: string; dir: 'upstream' | 'downstream' }[] = [];
    for (const link of links) {
      if (link.source_node_id === nodeId && direction !== 'upstream') {
        out.push({ link, other: link.target_node_id, dir: 'downstream' });
      }
      if (link.target_node_id === nodeId && direction !== 'downstream') {
        out.push({ link, other: link.source_node_id, dir: 'upstream' });
      }
    }
    return out;
  }

  async function observationsFor(
    scope: Scope,
    nodeIds: readonly string[],
    scenarioEntityId: EntityId | null | undefined,
  ): Promise<Map<string, ValueObservation[]>> {
    const map = new Map<string, ValueObservation[]>();
    if (nodeIds.length === 0) return map;
    let q = client
      .from('helm_value_observations')
      .select(OBS_COLS)
      .eq('org_id', scope.orgId)
      .in('node_id', [...nodeIds]);
    if (scenarioEntityId === null) q = q.is('scenario_entity_id', null);
    else if (scenarioEntityId !== undefined) q = q.eq('scenario_entity_id', scenarioEntityId);
    const { data, error } = await q;
    if (error) throw new Error(`helm_value_observations read failed: ${error.message}`);
    for (const row of (data ?? []) as ObsRow[]) {
      const list = map.get(row.node_id) ?? [];
      list.push(toObs(row));
      map.set(row.node_id, list);
    }
    return map;
  }

  function matchesFilters(n: ValueNode, spec: ValueTraversalSpec): boolean {
    if (spec.metricKeys?.length && !spec.metricKeys.includes(n.metricKey)) return false;
    if (spec.dimensions?.length) {
      const m = metricFor(n.metricKey);
      if (!m || !spec.dimensions.includes(m.dimension)) return false;
    }
    return true;
  }

  const graph: ValueGraph = {
    // ------------------------------------------------ metric definitions
    async createMetricDefinition(scope, input) {
      const id = `vm_${input.key.toLowerCase()}@${scope.orgId}`;
      const { data, error } = await client
        .from('helm_value_metrics')
        .insert({
          id,
          org_id: scope.orgId,
          key: input.key,
          name: input.name,
          description: input.description,
          dimension: input.dimension,
          unit_type: input.unitType,
          default_currency: input.defaultCurrency,
          data_type: input.dataType,
          aggregation: input.aggregation,
          directionality: input.directionality,
          time_behavior: input.timeBehavior,
          scope_categories: input.scopeCategories,
          status: input.status,
          is_system: false,
          metadata: input.metadata ?? {},
        })
        .select('*')
        .single();
      if (error) {
        return fail(ValueErrorCodes.WRITE_FAILED, `Metric write failed: ${error.message}`);
      }
      const r = data as Record<string, unknown>;
      return ok({ ...input, id: r.id as string, orgId: scope.orgId, version: 1, isSystem: false });
    },

    async getMetricDefinition(scope, key) {
      const { data, error } = await client
        .from('helm_value_metrics')
        .select('*')
        .eq('key', key)
        .or(`org_id.is.null,org_id.eq.${scope.orgId}`)
        .limit(1)
        .maybeSingle();
      if (error) {
        return fail(ValueErrorCodes.READ_FAILED, `Metric read failed: ${error.message}`);
      }
      if (!data) return ok(null);
      return ok(rowToMetric(data as Record<string, unknown>));
    },

    async findMetricDefinitions(scope, query: MetricQuery = {}) {
      let q = client
        .from('helm_value_metrics')
        .select('*')
        .or(`org_id.is.null,org_id.eq.${scope.orgId}`);
      if (query.dimensions?.length) q = q.in('dimension', [...query.dimensions]);
      if (query.keys?.length) q = q.in('key', [...query.keys]);
      if (!query.includeInactive) q = q.eq('status', 'active');
      const { data, error } = await q.order('key', { ascending: true });
      if (error) {
        return fail(ValueErrorCodes.READ_FAILED, `Metric query failed: ${error.message}`);
      }
      let rows = ((data ?? []) as Record<string, unknown>[]).map(rowToMetric);
      if (query.search) {
        const s = query.search.toLowerCase();
        rows = rows.filter(
          (m) => m.name.toLowerCase().includes(s) || m.key.toLowerCase().includes(s),
        );
      }
      return ok(rows);
    },

    // ------------------------------------------------------- value nodes
    async createValueNode(scope, input: ValueNodeInput) {
      // The subject entity must exist in the caller's organization.
      let category: string | null = null;
      if (input.subjectEntityId) {
        const e = await graphStore.getEntity(scope, input.subjectEntityId);
        if (!e.ok) return e;
        if (!e.value) {
          return fail(
            ValueErrorCodes.CROSS_ORG,
            `Subject entity ${input.subjectEntityId} not found in this organization.`,
          );
        }
        category = ontology.categoryOf(e.value.entityTypeKey);
      }

      const validation = registry.validateNode(input, category);
      if (!validation.ok) return validation;

      const metricId = metricIdByKey.get(input.metricKey);
      if (!metricId) {
        return fail(
          ValueErrorCodes.UNKNOWN_METRIC,
          `Unknown value metric "${input.metricKey}".`,
        );
      }
      const metric = metricFor(input.metricKey)!;

      const { data, error } = await client
        .from('helm_value_nodes')
        .insert({
          org_id: scope.orgId,
          metric_id: metricId,
          subject_entity_id: input.subjectEntityId ?? null,
          scope_kind: input.scopeKind ?? null,
          scope_ref: input.scopeRef ?? null,
          time_horizon: input.timeHorizon ?? null,
          label: input.label ?? metric.name,
          metadata: input.metadata ?? {},
          created_by: scope.actorId,
        })
        .select(NODE_COLS)
        .single();
      if (error) {
        const duplicate = /duplicate key|unique/i.test(error.message);
        return fail(
          duplicate ? ValueErrorCodes.DUPLICATE_NODE : ValueErrorCodes.WRITE_FAILED,
          duplicate
            ? `A value node for "${input.metricKey}" on this subject and horizon already exists. ` +
              'Use upsertValueNode for idempotent construction.'
            : `Value node write failed: ${error.message}`,
        );
      }
      return ok(toNode(data as NodeRow));
    },

    async upsertValueNode(scope, input) {
      const metricId = metricIdByKey.get(input.metricKey);
      if (!metricId) {
        return fail(ValueErrorCodes.UNKNOWN_METRIC, `Unknown value metric "${input.metricKey}".`);
      }
      let q = client
        .from('helm_value_nodes')
        .select(NODE_COLS)
        .eq('org_id', scope.orgId)
        .eq('metric_id', metricId);
      q = input.subjectEntityId
        ? q.eq('subject_entity_id', input.subjectEntityId)
        : q.is('subject_entity_id', null);
      q = input.timeHorizon ? q.eq('time_horizon', input.timeHorizon) : q.is('time_horizon', null);
      q = input.scopeKind ? q.eq('scope_kind', input.scopeKind) : q.is('scope_kind', null);
      q = input.scopeRef ? q.eq('scope_ref', input.scopeRef) : q.is('scope_ref', null);

      const { data, error } = await q.limit(1).maybeSingle();
      if (error) {
        return fail(ValueErrorCodes.READ_FAILED, `Value node read failed: ${error.message}`);
      }
      if (data) return ok(toNode(data as NodeRow));
      return graph.createValueNode(scope, input);
    },

    async getValueNode(scope, id) {
      const { data, error } = await client
        .from('helm_value_nodes')
        .select(NODE_COLS)
        .eq('org_id', scope.orgId)
        .eq('id', id)
        .maybeSingle();
      if (error) {
        return fail(ValueErrorCodes.READ_FAILED, `Value node read failed: ${error.message}`);
      }
      return ok(data ? toNode(data as NodeRow) : null);
    },

    async findValueNodes(scope, query: ValueNodeQuery = {}) {
      let q = client.from('helm_value_nodes').select(NODE_COLS).eq('org_id', scope.orgId);
      if (query.metricKeys?.length) {
        const ids = query.metricKeys
          .map((k) => metricIdByKey.get(k))
          .filter((v): v is string => Boolean(v));
        if (ids.length === 0) return ok([]);
        q = q.in('metric_id', ids);
      }
      if (query.dimensions?.length) {
        const ids = registry
          .allMetrics()
          .filter((m) => query.dimensions!.includes(m.dimension))
          .map((m) => m.id);
        if (ids.length === 0) return ok([]);
        q = q.in('metric_id', ids);
      }
      if (query.subjectEntityIds?.length) {
        q = q.in('subject_entity_id', [...query.subjectEntityIds]);
      }
      if (query.scopeKind) q = q.eq('scope_kind', query.scopeKind);
      if (query.timeHorizon) q = q.eq('time_horizon', query.timeHorizon);

      const { data, error } = await q.limit(2000);
      if (error) {
        return fail(ValueErrorCodes.READ_FAILED, `Value node query failed: ${error.message}`);
      }
      let rows = ((data ?? []) as NodeRow[]).map(toNode);
      if (query.search) {
        const s = query.search.toLowerCase();
        rows = rows.filter(
          (n) => n.label.toLowerCase().includes(s) || n.metricKey.toLowerCase().includes(s),
        );
      }
      rows.sort((a, b) => a.label.localeCompare(b.label) || a.metricKey.localeCompare(b.metricKey));
      const offset = query.offset ?? 0;
      return ok(rows.slice(offset, offset + (query.limit ?? 500)));
    },

    async findNodesForEntity(scope, entityId) {
      const { data, error } = await client
        .from('helm_value_nodes')
        .select(NODE_COLS)
        .eq('org_id', scope.orgId)
        .eq('subject_entity_id', entityId);
      if (error) {
        return fail(ValueErrorCodes.READ_FAILED, `Value node query failed: ${error.message}`);
      }
      const rows = ((data ?? []) as NodeRow[]).map(toNode);
      rows.sort((a, b) => a.metricKey.localeCompare(b.metricKey));
      return ok(rows);
    },

    // ------------------------------------------------------- value links
    async createValueLink(scope, input: ValueLinkInput) {
      if (input.sourceNodeId === input.targetNodeId) {
        return fail(
          ValueErrorCodes.LINK_SELF_REFERENCE,
          'A value link cannot connect a node to itself.',
        );
      }
      const nodes = await fetchNodes(scope, [input.sourceNodeId, input.targetNodeId]);
      if (!nodes.has(input.sourceNodeId)) {
        return fail(
          ValueErrorCodes.NODE_NOT_FOUND,
          `Source value node ${input.sourceNodeId} not found in this organization.`,
        );
      }
      if (!nodes.has(input.targetNodeId)) {
        return fail(
          ValueErrorCodes.NODE_NOT_FOUND,
          `Target value node ${input.targetNodeId} not found in this organization.`,
        );
      }

      const { data, error } = await client
        .from('helm_value_links')
        .insert({
          org_id: scope.orgId,
          link_type: input.linkType,
          source_node_id: input.sourceNodeId,
          target_node_id: input.targetNodeId,
          weight: input.weight ?? null,
          confidence: input.confidence ?? null,
          lag_days: input.lagDays ?? null,
          valid_from: input.validFrom ?? toIso(clock.now()),
          valid_to: input.validTo ?? null,
          observed_at: input.observedAt ?? null,
          source_system: input.sourceSystem,
          metadata: input.metadata ?? {},
          created_by: scope.actorId,
        })
        .select(LINK_COLS)
        .single();
      if (error) {
        return fail(ValueErrorCodes.WRITE_FAILED, `Value link write failed: ${error.message}`);
      }
      return ok(toLink(data as LinkRow));
    },

    async removeValueLink(scope, id, at) {
      const when = toIso(at ?? clock.now());
      const { data, error } = await client
        .from('helm_value_links')
        .update({ valid_to: when })
        .eq('org_id', scope.orgId)
        .eq('id', id)
        .select(LINK_COLS)
        .maybeSingle();
      if (error) {
        return fail(ValueErrorCodes.WRITE_FAILED, `Value link close failed: ${error.message}`);
      }
      if (!data) {
        return fail(ValueErrorCodes.LINK_NOT_FOUND, `Value link ${id} not found in this organization.`);
      }
      return ok(toLink(data as LinkRow));
    },

    async findValueLinks(scope, query: ValueLinkQuery = {}) {
      let q = client.from('helm_value_links').select(LINK_COLS).eq('org_id', scope.orgId);
      if (query.linkTypes?.length) q = q.in('link_type', [...query.linkTypes]);
      if (query.sourceNodeId) q = q.eq('source_node_id', query.sourceNodeId);
      if (query.targetNodeId) q = q.eq('target_node_id', query.targetNodeId);
      if (query.eitherEndpoint) {
        q = q.or(
          `source_node_id.eq.${query.eitherEndpoint},target_node_id.eq.${query.eitherEndpoint}`,
        );
      }
      const { data, error } = await q.limit(2000);
      if (error) {
        return fail(ValueErrorCodes.READ_FAILED, `Value link query failed: ${error.message}`);
      }
      let rows = ((data ?? []) as LinkRow[]).filter((r) => linkValidAt(r, query.asOf));
      if (query.minConfidence !== undefined) {
        rows = rows.filter((r) => (num(r.confidence) ?? 1) >= query.minConfidence!);
      }
      const mapped = rows.map(toLink);
      mapped.sort((a, b) => a.linkType.localeCompare(b.linkType));
      return ok(mapped.slice(0, query.limit ?? 500));
    },

    // ------------------------------------------------------ observations
    async recordObservation(scope, input: ValueObservationInput) {
      const node = await graph.getValueNode(scope, input.nodeId);
      if (!node.ok) return node;
      if (!node.value) {
        return fail(
          ValueErrorCodes.NODE_NOT_FOUND,
          `Value node ${input.nodeId} not found in this organization.`,
        );
      }
      const metric = metricFor(node.value.metricKey)!;
      const validation = registry.validateObservation(input, node.value.metricKey);
      if (!validation.ok) return validation;

      if (input.scenarioEntityId) {
        const s = await graphStore.getEntity(scope, input.scenarioEntityId);
        if (!s.ok) return s;
        if (!s.value) {
          return fail(
            ValueErrorCodes.CROSS_ORG,
            `Scenario entity ${input.scenarioEntityId} not found in this organization.`,
          );
        }
      }

      const { data, error } = await client
        .from('helm_value_observations')
        .insert({
          org_id: scope.orgId,
          node_id: input.nodeId,
          observation_type: input.observationType,
          numeric_value: input.numericValue ?? null,
          text_value: input.textValue ?? null,
          unit_type: input.unitType ?? metric.unitType,
          currency: input.currency ?? metric.defaultCurrency ?? null,
          effective_at: input.effectiveAt ?? null,
          period_start: input.periodStart ?? null,
          period_end: input.periodEnd ?? null,
          observed_at: input.observedAt ?? null,
          scenario_entity_id: input.scenarioEntityId ?? null,
          assumption_entity_id: input.assumptionEntityId ?? null,
          confidence:
            input.confidence === null || input.confidence === undefined
              ? null
              : clampConfidence(input.confidence),
          source_system: input.sourceSystem,
          provenance_id: input.provenanceId ?? null,
          metadata: input.metadata ?? {},
          created_by: scope.actorId,
        })
        .select(OBS_COLS)
        .single();
      if (error) {
        return fail(ValueErrorCodes.WRITE_FAILED, `Observation write failed: ${error.message}`);
      }
      return ok(toObs(data as ObsRow));
    },

    async getObservations(scope, query: ObservationQuery) {
      let q = client
        .from('helm_value_observations')
        .select(OBS_COLS)
        .eq('org_id', scope.orgId)
        .eq('node_id', query.nodeId);
      if (query.types?.length) q = q.in('observation_type', [...query.types]);
      if (query.scenarioEntityId === null) q = q.is('scenario_entity_id', null);
      else if (query.scenarioEntityId !== undefined) {
        q = q.eq('scenario_entity_id', query.scenarioEntityId);
      }
      const { data, error } = await q.limit(500);
      if (error) {
        return fail(ValueErrorCodes.READ_FAILED, `Observation query failed: ${error.message}`);
      }
      let rows = ((data ?? []) as ObsRow[]).map(toObs);
      const anchor = (o: ValueObservation) => o.effectiveAt ?? o.periodStart ?? o.recordedAt;
      if (query.from) {
        const t = new Date(query.from).getTime();
        rows = rows.filter((o) => new Date(anchor(o)).getTime() >= t);
      }
      if (query.to) {
        const t = new Date(query.to).getTime();
        rows = rows.filter((o) => new Date(anchor(o)).getTime() <= t);
      }
      // Newest first: by valid time, then by RECORD time. The second key is not
      // cosmetic — two claims can be valid at the same instant, and the one
      // recorded later is the current belief. Without it "latest" would depend
      // on storage order, which is exactly the kind of thing a derived value
      // must never depend on.
      rows.sort(byRecency);
      return ok(rows.slice(0, query.limit ?? 200));
    },

    async getLatestObservation(scope, query: LatestObservationQuery) {
      const all = await graph.getObservations(scope, {
        nodeId: query.nodeId,
        types: [query.type],
        scenarioEntityId: query.scenarioEntityId,
        to: query.asOf,
        limit: 200,
      });
      if (!all.ok) return all;
      return ok(all.value.length > 0 ? all.value[0] : null);
    },

    // --------------------------------------------------------- traversal
    async getValueNeighborhood(scope, nodeId, direction, asOf) {
      const self = await graph.getValueNode(scope, nodeId);
      if (!self.ok) return self;
      if (!self.value) {
        return fail(ValueErrorCodes.NODE_NOT_FOUND, `Value node ${nodeId} not found in this organization.`);
      }
      const links = await fetchLinksFor(scope, [nodeId], undefined, asOf, undefined);
      const steps = stepsFrom(links, nodeId, direction);
      const others = await fetchNodes(scope, steps.map((s) => s.other));

      const out: ValueNeighbor[] = [];
      for (const s of steps) {
        const other = others.get(s.other);
        if (!other) continue;
        const metric = metricFor(other.metricKey);
        if (!metric) continue;
        out.push({ node: other, metric, via: toLink(s.link), direction: s.dir });
      }
      return ok(out);
    },

    async getValueChain(scope, spec: ValueTraversalSpec) {
      if (spec.maxDepth === undefined || spec.maxDepth === null) {
        return fail(ValueErrorCodes.DEPTH_REQUIRED, 'getValueChain() requires maxDepth.');
      }
      if (spec.maxDepth < 0 || spec.maxDepth > MAX_ALLOWED_DEPTH) {
        return fail(
          ValueErrorCodes.DEPTH_EXCEEDED,
          `maxDepth must be between 0 and ${MAX_ALLOWED_DEPTH}, got ${spec.maxDepth}.`,
          { maxDepth: spec.maxDepth, limit: MAX_ALLOWED_DEPTH },
        );
      }

      const maxNodes = spec.maxNodes ?? DEFAULT_MAX_NODES;
      const visited = new Map<string, { node: ValueNode; depth: number; path: string[]; confs: number[] }>();
      const usedLinks = new Map<string, ValueLink>();
      let truncated = false;

      const starts = await fetchNodes(scope, [...spec.start]);
      let frontier: { id: string; path: string[]; confs: number[] }[] = [];
      for (const id of spec.start) {
        const n = starts.get(id);
        if (!n) continue;
        visited.set(id, { node: n, depth: 0, path: [], confs: [] });
        frontier.push({ id, path: [], confs: [] });
      }

      for (let depth = 0; depth < spec.maxDepth && frontier.length > 0; depth += 1) {
        const links = await fetchLinksFor(
          scope,
          frontier.map((f) => f.id),
          spec.linkTypes,
          spec.asOf,
          spec.minConfidence,
        );
        if (links.length === 0) break;

        const candidates: { other: string; link: LinkRow; path: string[]; confs: number[] }[] = [];
        for (const f of frontier) {
          for (const s of stepsFrom(links, f.id, spec.direction)) {
            candidates.push({
              other: s.other,
              link: s.link,
              path: [...f.path, s.link.id],
              confs: [...f.confs, num(s.link.confidence) ?? 1],
            });
          }
        }

        const nextNodes = await fetchNodes(scope, candidates.map((c) => c.other));
        const nextFrontier: typeof frontier = [];
        for (const c of candidates) {
          const n = nextNodes.get(c.other);
          if (!n) continue;
          if (!matchesFilters(n, spec)) continue;
          usedLinks.set(c.link.id, toLink(c.link));
          if (visited.has(c.other)) continue;
          if (visited.size >= maxNodes) {
            truncated = true;
            break;
          }
          visited.set(c.other, { node: n, depth: depth + 1, path: c.path, confs: c.confs });
          nextFrontier.push({ id: c.other, path: c.path, confs: c.confs });
        }
        if (truncated) break;
        frontier = nextFrontier;
      }

      const obs = await observationsFor(scope, [...visited.keys()], spec.scenarioEntityId);

      const nodes: ValueChainNode[] = [];
      for (const v of visited.values()) {
        const metric = metricFor(v.node.metricKey);
        if (!metric) continue;
        nodes.push({
          node: v.node,
          metric,
          depth: v.depth,
          path: v.path,
          pathConfidence: chainConfidence(v.confs),
          // Attached, never combined: Phase 2 represents value, Phase 3 moves it.
          observations: obs.get(v.node.id) ?? [],
        });
      }
      nodes.sort((a, b) =>
        a.depth === b.depth ? a.node.label.localeCompare(b.node.label) : a.depth - b.depth,
      );

      const chain: ValueChain = {
        nodes,
        links: [...usedLinks.values()].sort((a, b) => a.id.localeCompare(b.id)),
        truncated,
      };
      return ok(chain);
    },

    async findUpstreamValueNodes(scope, nodeId, maxDepth) {
      return graph.getValueChain(scope, { start: [nodeId], maxDepth, direction: 'upstream' });
    },

    async findDownstreamValueNodes(scope, nodeId, maxDepth) {
      return graph.getValueChain(scope, { start: [nodeId], maxDepth, direction: 'downstream' });
    },

    async findContention(scope, opts = {}) {
      const minClaimants = opts.minClaimants ?? 2;
      const { data, error } = await client
        .from('helm_value_links')
        .select(LINK_COLS)
        .eq('org_id', scope.orgId)
        .in('link_type', ['CONSUMES', 'ALLOCATES_TO']);
      if (error) {
        return fail(ValueErrorCodes.READ_FAILED, `Contention query failed: ${error.message}`);
      }
      const links = ((data ?? []) as LinkRow[]).filter((r) => linkValidAt(r, opts.asOf));

      const byTarget = new Map<string, LinkRow[]>();
      for (const l of links) {
        const list = byTarget.get(l.target_node_id) ?? [];
        list.push(l);
        byTarget.set(l.target_node_id, list);
      }

      const contended = [...byTarget.entries()].filter(([, ls]) => ls.length >= minClaimants);
      if (contended.length === 0) return ok([]);

      const allIds = new Set<string>();
      for (const [target, ls] of contended) {
        allIds.add(target);
        for (const l of ls) allIds.add(l.source_node_id);
      }
      const nodes = await fetchNodes(scope, [...allIds]);

      const out: ContentionPoint[] = [];
      for (const [target, ls] of contended) {
        const node = nodes.get(target);
        if (!node) continue;
        const metric = metricFor(node.metricKey);
        if (!metric) continue;

        const claimants: ValueNeighbor[] = [];
        for (const l of ls) {
          const src = nodes.get(l.source_node_id);
          if (!src) continue;
          const srcMetric = metricFor(src.metricKey);
          if (!srcMetric) continue;
          claimants.push({ node: src, metric: srcMetric, via: toLink(l), direction: 'upstream' });
        }
        if (claimants.length < minClaimants) continue;

        const weights = claimants.map((c) => c.via.weight).filter((w): w is number => w !== null);
        out.push({
          node,
          metric,
          claimants,
          totalClaimedWeight:
            weights.length === claimants.length ? weights.reduce((a, b) => a + b, 0) : null,
        });
      }
      out.sort((a, b) => b.claimants.length - a.claimants.length);
      return ok(out);
    },

    // -------------------------------------------------------- provenance
    async recordProvenance(scope, input: ProvenanceInput) {
      const { data, error } = await client
        .from('helm_provenance')
        .insert({
          org_id: scope.orgId,
          subject_kind: input.subjectKind,
          subject_id: input.subjectId,
          source_field: input.sourceField,
          method: input.method,
          system: input.system,
          connector: input.connector,
          source_object_type: input.sourceObjectType,
          source_object_id: input.sourceObjectId,
          ingestion_event_id: input.ingestionEventId,
          transformation: input.transformation,
          inputs: input.inputs,
          actor_id: input.actorId,
          confidence: input.confidence,
          notes: input.notes,
          payload: input.payload,
          observed_at: input.observedAt,
        })
        .select('*')
        .single();
      if (error) {
        return fail(ValueErrorCodes.WRITE_FAILED, `Provenance write failed: ${error.message}`);
      }
      return ok(toProv(data as ProvRow));
    },

    /**
     * Provenance for one observation, from either direction.
     *
     * A stated fact's provenance names the observation as its subject. A DERIVED
     * value's names the calculation run instead, because the run id is the only
     * subject knowable before the observation exists and this table is
     * append-only. Falling back to the observation's own `provenance_id` means
     * "where did this number come from?" has one answer for every observation
     * type, rather than silently returning nothing for the derived ones.
     */
    async getObservationProvenance(scope, observationId) {
      const { data, error } = await client
        .from('helm_provenance')
        .select('*')
        .eq('org_id', scope.orgId)
        .eq('subject_kind', 'value_observation')
        .eq('subject_id', observationId)
        .order('recorded_at', { ascending: false });
      if (error) {
        return fail(ValueErrorCodes.READ_FAILED, `Provenance read failed: ${error.message}`);
      }
      const rows = ((data ?? []) as ProvRow[]).map(toProv);
      if (rows.length > 0) return ok(rows);

      const obs = await client
        .from('helm_value_observations')
        .select('provenance_id')
        .eq('org_id', scope.orgId)
        .eq('id', observationId)
        .maybeSingle();
      if (obs.error) {
        return fail(ValueErrorCodes.READ_FAILED, `Provenance read failed: ${obs.error.message}`);
      }
      const provenanceId = (obs.data as { provenance_id: string | null } | null)?.provenance_id;
      if (!provenanceId) return ok([]);

      const byId = await client
        .from('helm_provenance')
        .select('*')
        .eq('org_id', scope.orgId)
        .eq('id', provenanceId);
      if (byId.error) {
        return fail(ValueErrorCodes.READ_FAILED, `Provenance read failed: ${byId.error.message}`);
      }
      return ok(((byId.data ?? []) as ProvRow[]).map(toProv));
    },
  };

  return graph;
}

function rowToMetric(r: Record<string, unknown>): ValueMetricDefinition {
  return {
    id: r.id as string,
    orgId: (r.org_id ?? null) as ValueMetricDefinition['orgId'],
    key: r.key as string,
    name: r.name as string,
    description: r.description as string,
    dimension: r.dimension as ValueMetricDefinition['dimension'],
    unitType: r.unit_type as UnitType,
    defaultCurrency: (r.default_currency ?? null) as string | null,
    dataType: r.data_type as ValueMetricDefinition['dataType'],
    aggregation: r.aggregation as ValueMetricDefinition['aggregation'],
    directionality: r.directionality as ValueMetricDefinition['directionality'],
    timeBehavior: r.time_behavior as ValueMetricDefinition['timeBehavior'],
    scopeCategories: (r.scope_categories ?? null) as readonly string[] | null,
    version: r.version as number,
    status: r.status as ValueMetricDefinition['status'],
    isSystem: r.is_system as boolean,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
  };
}
