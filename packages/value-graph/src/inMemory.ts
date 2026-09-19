/**
 * InMemoryValueGraph — the reference implementation of the ValueGraph port.
 *
 * Defines the semantics the Postgres adapter must match, and lets everything
 * above be tested without a database.
 *
 * Org scoping is enforced here as well as in RLS: a store that ignored
 * `scope.orgId` would pass its own tests while leaking between tenants.
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
  type IdGen,
  type ProvenanceInput,
  type ProvenanceRecord,
  type Result,
  type Scope,
} from '@helm/shared';
import type { GraphStore } from '@helm/graph-store';
import type { OntologyRegistry } from '@helm/ontology';
import { ValueErrorCodes, type ValueMetricRegistry } from './registry.ts';
import type {
  ValueDirection,
  ValueGraph,
  ValueChain,
  ValueChainNode,
  ValueNeighbor,
  ContentionPoint,
  ValueNodeQuery,
  ValueLinkQuery,
  ObservationQuery,
  LatestObservationQuery,
  MetricQuery,
  ValueTraversalSpec,
} from './port.ts';
import {
  type ValueLink,
  type ValueLinkInput,
  type ValueMetricDefinition,
  type ValueNode,
  type ValueNodeInput,
  type ValueObservation,
  type ValueObservationInput,
} from './types.ts';

const MAX_ALLOWED_DEPTH = 12;
const DEFAULT_MAX_NODES = 1000;

export type InMemoryValueGraphOptions = {
  metrics: ValueMetricRegistry;
  ontology: OntologyRegistry;
  /** Used to verify a subject entity exists and belongs to the caller's org. */
  graphStore: GraphStore;
  clock: Clock;
  idGen: IdGen;
};

type Store = {
  metrics: Map<string, ValueMetricDefinition>;
  nodes: Map<string, ValueNode>;
  links: Map<string, ValueLink>;
  observations: ValueObservation[];
  provenance: ProvenanceRecord[];
};

/** Identity of a value node: one metric, about one subject, at one horizon. */
function nodeKey(orgId: string, input: ValueNodeInput): string {
  return [
    orgId,
    input.metricKey,
    input.subjectEntityId ?? '',
    input.scopeKind ?? '',
    input.scopeRef ?? '',
    input.timeHorizon ?? '',
  ].join('|');
}

export function createInMemoryValueGraph(opts: InMemoryValueGraphOptions): ValueGraph {
  const { metrics: registry, ontology, graphStore, clock, idGen } = opts;

  const db: Store = {
    metrics: new Map(registry.allMetrics().map((m) => [m.key, m])),
    nodes: new Map(),
    links: new Map(),
    observations: [],
    provenance: [],
  };

  const nowIso = () => clock.now().toISOString();
  const inOrg = <T extends { orgId: string }>(scope: Scope, row: T) => row.orgId === scope.orgId;
  const orgNodes = (scope: Scope) => [...db.nodes.values()].filter((n) => inOrg(scope, n));
  const orgLinks = (scope: Scope) => [...db.links.values()].filter((l) => inOrg(scope, l));

  const metricFor = (key: string) => db.metrics.get(key) ?? registry.metric(key);

  const linkValidAt = (l: ValueLink, asOf?: Date | string) =>
    isValidAt({ validFrom: l.validFrom, validTo: l.validTo }, asOf ?? clock.now());

  /** The subject entity's type category, for scope compatibility checks. */
  async function subjectCategory(
    scope: Scope,
    entityId: EntityId | null | undefined,
  ): Promise<Result<string | null>> {
    if (!entityId) return ok(null);
    const r = await graphStore.getEntity(scope, entityId);
    if (!r.ok) return r;
    if (!r.value) {
      return fail(
        ValueErrorCodes.CROSS_ORG,
        `Subject entity ${entityId} not found in this organization.`,
        { entityId },
      );
    }
    return ok(ontology.categoryOf(r.value.entityTypeKey));
  }

  function observationsFor(
    scope: Scope,
    nodeId: string,
    scenarioEntityId: EntityId | null | undefined,
  ): ValueObservation[] {
    return db.observations.filter((o) => {
      if (o.orgId !== scope.orgId || o.nodeId !== nodeId) return false;
      if (scenarioEntityId === undefined) return true;
      return scenarioEntityId === null
        ? o.scenarioEntityId === null
        : o.scenarioEntityId === scenarioEntityId;
    });
  }

  type Step = { link: ValueLink; other: string; dir: 'upstream' | 'downstream' };

  function stepsFrom(
    scope: Scope,
    nodeId: string,
    direction: ValueDirection,
    spec: { linkTypes?: readonly string[]; asOf?: Date | string; minConfidence?: Confidence },
  ): Step[] {
    const out: Step[] = [];
    for (const link of orgLinks(scope)) {
      if (!linkValidAt(link, spec.asOf)) continue;
      if (spec.linkTypes?.length && !spec.linkTypes.includes(link.linkType)) continue;
      if (spec.minConfidence !== undefined && (link.confidence ?? 1) < spec.minConfidence) {
        continue;
      }
      // A link points from cause-side to effect-side, so following it forwards
      // is "downstream" and backwards is "upstream".
      if (link.sourceNodeId === nodeId && direction !== 'upstream') {
        out.push({ link, other: link.targetNodeId, dir: 'downstream' });
      }
      if (link.targetNodeId === nodeId && direction !== 'downstream') {
        out.push({ link, other: link.sourceNodeId, dir: 'upstream' });
      }
    }
    return out;
  }

  function matchesNodeFilters(n: ValueNode, spec: ValueTraversalSpec): boolean {
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
      if (db.metrics.has(input.key)) {
        return fail(
          ValueErrorCodes.DUPLICATE_METRIC,
          `A metric with key "${input.key}" already exists.`,
        );
      }
      const def: ValueMetricDefinition = {
        ...input,
        id: `vm_${input.key.toLowerCase()}@${scope.orgId}`,
        orgId: scope.orgId,
        version: 1,
        isSystem: false,
      };
      db.metrics.set(def.key, def);
      return ok(def);
    },

    async getMetricDefinition(_scope, key) {
      return ok(db.metrics.get(key) ?? null);
    },

    async findMetricDefinitions(scope, query: MetricQuery = {}) {
      let rows = [...db.metrics.values()].filter(
        (m) => m.orgId === null || m.orgId === scope.orgId,
      );
      if (query.dimensions?.length) {
        rows = rows.filter((m) => query.dimensions!.includes(m.dimension));
      }
      if (query.keys?.length) rows = rows.filter((m) => query.keys!.includes(m.key));
      if (query.search) {
        const s = query.search.toLowerCase();
        rows = rows.filter(
          (m) => m.name.toLowerCase().includes(s) || m.key.toLowerCase().includes(s),
        );
      }
      if (!query.includeInactive) rows = rows.filter((m) => m.status === 'active');
      rows.sort((a, b) => a.key.localeCompare(b.key));
      return ok(rows);
    },

    // ------------------------------------------------------- value nodes
    async createValueNode(scope, input: ValueNodeInput) {
      const cat = await subjectCategory(scope, input.subjectEntityId);
      if (!cat.ok) return cat;

      const validation = registry.validateNode(input, cat.value);
      if (!validation.ok) return validation;

      const key = nodeKey(scope.orgId, input);
      const existing = orgNodes(scope).find((n) => nodeKey(n.orgId, {
        metricKey: n.metricKey,
        subjectEntityId: n.subjectEntityId,
        scopeKind: n.scopeKind,
        scopeRef: n.scopeRef,
        timeHorizon: n.timeHorizon,
      }) === key);
      if (existing) {
        return fail(
          ValueErrorCodes.DUPLICATE_NODE,
          `A value node for "${input.metricKey}" on this subject and horizon already exists. ` +
            'Use upsertValueNode for idempotent construction.',
          { metricKey: input.metricKey },
        );
      }

      const metric = metricFor(input.metricKey)!;
      const now = nowIso();
      const node: ValueNode = {
        id: idGen.next(),
        orgId: scope.orgId,
        metricId: metric.id,
        metricKey: metric.key,
        subjectEntityId: input.subjectEntityId ?? null,
        scopeKind: input.scopeKind ?? null,
        scopeRef: input.scopeRef ?? null,
        timeHorizon: input.timeHorizon ?? null,
        label: input.label ?? metric.name,
        metadata: { ...(input.metadata ?? {}) },
        createdBy: input.createdBy ?? null,
        createdAt: asRecordTime(now),
        updatedAt: asRecordTime(now),
      };
      db.nodes.set(node.id, node);
      return ok(node);
    },

    async upsertValueNode(scope, input) {
      const key = nodeKey(scope.orgId, input);
      const existing = orgNodes(scope).find(
        (n) =>
          nodeKey(n.orgId, {
            metricKey: n.metricKey,
            subjectEntityId: n.subjectEntityId,
            scopeKind: n.scopeKind,
            scopeRef: n.scopeRef,
            timeHorizon: n.timeHorizon,
          }) === key,
      );
      if (existing) return ok(existing);
      return graph.createValueNode(scope, input);
    },

    async getValueNode(scope, id) {
      const n = db.nodes.get(id);
      return ok(n && inOrg(scope, n) ? n : null);
    },

    async findValueNodes(scope, query: ValueNodeQuery = {}) {
      let rows = orgNodes(scope);
      if (query.metricKeys?.length) {
        rows = rows.filter((n) => query.metricKeys!.includes(n.metricKey));
      }
      if (query.dimensions?.length) {
        rows = rows.filter((n) => {
          const m = metricFor(n.metricKey);
          return m ? query.dimensions!.includes(m.dimension) : false;
        });
      }
      if (query.subjectEntityIds?.length) {
        rows = rows.filter(
          (n) => n.subjectEntityId && query.subjectEntityIds!.includes(n.subjectEntityId),
        );
      }
      if (query.scopeKind) rows = rows.filter((n) => n.scopeKind === query.scopeKind);
      if (query.timeHorizon) rows = rows.filter((n) => n.timeHorizon === query.timeHorizon);
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
      const rows = orgNodes(scope).filter((n) => n.subjectEntityId === entityId);
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
      const src = db.nodes.get(input.sourceNodeId);
      const tgt = db.nodes.get(input.targetNodeId);
      if (!src || !inOrg(scope, src)) {
        return fail(
          ValueErrorCodes.NODE_NOT_FOUND,
          `Source value node ${input.sourceNodeId} not found in this organization.`,
        );
      }
      if (!tgt || !inOrg(scope, tgt)) {
        return fail(
          ValueErrorCodes.NODE_NOT_FOUND,
          `Target value node ${input.targetNodeId} not found in this organization.`,
        );
      }

      const now = nowIso();
      const link: ValueLink = {
        id: idGen.next(),
        orgId: scope.orgId,
        linkType: input.linkType,
        sourceNodeId: input.sourceNodeId,
        targetNodeId: input.targetNodeId,
        weight: input.weight ?? null,
        confidence: input.confidence ?? null,
        lagDays: input.lagDays ?? null,
        validFrom: input.validFrom ?? asValidTime(now),
        validTo: input.validTo ?? null,
        observedAt: input.observedAt ?? null,
        ingestedAt: asRecordTime(now),
        updatedAt: asRecordTime(now),
        sourceSystem: input.sourceSystem,
        metadata: { ...(input.metadata ?? {}) },
        createdBy: input.createdBy ?? null,
      };
      db.links.set(link.id, link);
      return ok(link);
    },

    async removeValueLink(scope, id, at) {
      const link = db.links.get(id);
      if (!link || !inOrg(scope, link)) {
        return fail(ValueErrorCodes.LINK_NOT_FOUND, `Value link ${id} not found in this organization.`);
      }
      const when = toIso(at ?? clock.now());
      const next: ValueLink = { ...link, validTo: asValidTime(when), updatedAt: asRecordTime(when) };
      db.links.set(id, next);
      return ok(next);
    },

    async findValueLinks(scope, query: ValueLinkQuery = {}) {
      let rows = orgLinks(scope);
      if (query.linkTypes?.length) rows = rows.filter((l) => query.linkTypes!.includes(l.linkType));
      if (query.sourceNodeId) rows = rows.filter((l) => l.sourceNodeId === query.sourceNodeId);
      if (query.targetNodeId) rows = rows.filter((l) => l.targetNodeId === query.targetNodeId);
      if (query.eitherEndpoint) {
        rows = rows.filter(
          (l) => l.sourceNodeId === query.eitherEndpoint || l.targetNodeId === query.eitherEndpoint,
        );
      }
      if (query.minConfidence !== undefined) {
        rows = rows.filter((l) => (l.confidence ?? 1) >= query.minConfidence!);
      }
      rows = rows.filter((l) => linkValidAt(l, query.asOf));
      rows.sort((a, b) => a.linkType.localeCompare(b.linkType));
      return ok(rows.slice(0, query.limit ?? 500));
    },

    // ------------------------------------------------------ observations
    async recordObservation(scope, input: ValueObservationInput) {
      const node = db.nodes.get(input.nodeId);
      if (!node || !inOrg(scope, node)) {
        return fail(
          ValueErrorCodes.NODE_NOT_FOUND,
          `Value node ${input.nodeId} not found in this organization.`,
        );
      }
      const metric = metricFor(node.metricKey)!;
      const validation = registry.validateObservation(input, node.metricKey);
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

      const obs: ValueObservation = {
        id: idGen.next(),
        orgId: scope.orgId,
        nodeId: input.nodeId,
        observationType: input.observationType,
        numericValue: input.numericValue ?? null,
        textValue: input.textValue ?? null,
        unitType: input.unitType ?? metric.unitType,
        currency: input.currency ?? metric.defaultCurrency ?? null,
        effectiveAt: input.effectiveAt ?? null,
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
        observedAt: input.observedAt ?? null,
        recordedAt: asRecordTime(nowIso()),
        scenarioEntityId: input.scenarioEntityId ?? null,
        assumptionEntityId: input.assumptionEntityId ?? null,
        confidence:
          input.confidence === null || input.confidence === undefined
            ? null
            : clampConfidence(input.confidence),
        sourceSystem: input.sourceSystem,
        provenanceId: input.provenanceId ?? null,
        calculationRunId: null,
        metadata: { ...(input.metadata ?? {}) },
        createdBy: input.createdBy ?? null,
      };
      db.observations.push(obs);
      return ok(obs);
    },

    async getObservations(scope, query: ObservationQuery) {
      let rows = observationsFor(scope, query.nodeId, query.scenarioEntityId);
      if (query.types?.length) {
        rows = rows.filter((o) => query.types!.includes(o.observationType));
      }
      const anchor = (o: ValueObservation) => o.effectiveAt ?? o.periodStart ?? o.recordedAt;
      if (query.from) {
        const t = new Date(query.from).getTime();
        rows = rows.filter((o) => new Date(anchor(o)).getTime() >= t);
      }
      if (query.to) {
        const t = new Date(query.to).getTime();
        rows = rows.filter((o) => new Date(anchor(o)).getTime() <= t);
      }
      rows = [...rows].sort((a, b) => String(anchor(b)).localeCompare(String(anchor(a))));
      return ok(rows.slice(0, query.limit ?? 200));
    },

    async getLatestObservation(scope, query: LatestObservationQuery) {
      const rows = observationsFor(scope, query.nodeId, query.scenarioEntityId).filter(
        (o) => o.observationType === query.type,
      );
      const anchor = (o: ValueObservation) => o.effectiveAt ?? o.periodStart ?? o.recordedAt;
      const eligible = query.asOf
        ? rows.filter((o) => new Date(anchor(o)).getTime() <= new Date(query.asOf!).getTime())
        : rows;
      if (eligible.length === 0) return ok(null);
      const latest = [...eligible].sort((a, b) =>
        String(anchor(b)).localeCompare(String(anchor(a))),
      )[0];
      return ok(latest);
    },

    // --------------------------------------------------------- traversal
    async getValueNeighborhood(scope, nodeId, direction, asOf) {
      const self = db.nodes.get(nodeId);
      if (!self || !inOrg(scope, self)) {
        return fail(ValueErrorCodes.NODE_NOT_FOUND, `Value node ${nodeId} not found in this organization.`);
      }
      const out: ValueNeighbor[] = [];
      for (const step of stepsFrom(scope, nodeId, direction, { asOf })) {
        const other = db.nodes.get(step.other);
        if (!other || !inOrg(scope, other)) continue;
        const metric = metricFor(other.metricKey);
        if (!metric) continue;
        out.push({ node: other, metric, via: step.link, direction: step.dir });
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
      const visited = new Map<string, ValueChainNode>();
      const usedLinks = new Map<string, ValueLink>();
      let truncated = false;

      const attach = (node: ValueNode, depth: number, path: string[], confs: number[]) => {
        const metric = metricFor(node.metricKey);
        if (!metric) return;
        visited.set(node.id, {
          node,
          metric,
          depth,
          path: [...path],
          pathConfidence: chainConfidence(confs),
          // Observations are ATTACHED, never combined. Phase 2 shows the
          // numbers along the chain; it does not compute through it.
          observations: observationsFor(scope, node.id, spec.scenarioEntityId),
        });
      };

      type QueueItem = { id: string; depth: number; path: string[]; confs: number[] };
      const queue: QueueItem[] = [];

      for (const startId of spec.start) {
        const n = db.nodes.get(startId);
        if (!n || !inOrg(scope, n)) continue;
        attach(n, 0, [], []);
        queue.push({ id: startId, depth: 0, path: [], confs: [] });
      }

      while (queue.length > 0) {
        const item = queue.shift()!;
        if (item.depth >= spec.maxDepth) continue;
        for (const step of stepsFrom(scope, item.id, spec.direction, {
          linkTypes: spec.linkTypes,
          asOf: spec.asOf,
          minConfidence: spec.minConfidence,
        })) {
          const other = db.nodes.get(step.other);
          if (!other || !inOrg(scope, other)) continue;
          if (!matchesNodeFilters(other, spec)) continue;
          usedLinks.set(step.link.id, step.link);
          if (visited.has(other.id)) continue;
          if (visited.size >= maxNodes) {
            truncated = true;
            break;
          }
          const path = [...item.path, step.link.id];
          const confs = [...item.confs, step.link.confidence ?? 1];
          attach(other, item.depth + 1, path, confs);
          queue.push({ id: other.id, depth: item.depth + 1, path, confs });
        }
        if (truncated) break;
      }

      const nodes = [...visited.values()].sort((a, b) =>
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
      const out: ContentionPoint[] = [];

      for (const node of orgNodes(scope)) {
        const metric = metricFor(node.metricKey);
        if (!metric) continue;
        // A resource is contended when several nodes draw on or limit it.
        const claimants: ValueNeighbor[] = [];
        for (const link of orgLinks(scope)) {
          if (link.targetNodeId !== node.id) continue;
          if (!linkValidAt(link, opts.asOf)) continue;
          if (link.linkType !== 'CONSUMES' && link.linkType !== 'ALLOCATES_TO') continue;
          const src = db.nodes.get(link.sourceNodeId);
          if (!src || !inOrg(scope, src)) continue;
          const srcMetric = metricFor(src.metricKey);
          if (!srcMetric) continue;
          claimants.push({ node: src, metric: srcMetric, via: link, direction: 'upstream' });
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
      const record: ProvenanceRecord = {
        ...input,
        id: asProvenanceId(idGen.next()),
        orgId: scope.orgId,
        confidence:
          input.confidence === null || input.confidence === undefined
            ? null
            : clampConfidence(input.confidence),
        recordedAt: input.recordedAt ?? asRecordTime(nowIso()),
      };
      db.provenance.push(record);
      return ok(record);
    },

    async getObservationProvenance(scope, observationId) {
      const rows = db.provenance.filter(
        (p) =>
          p.orgId === scope.orgId &&
          p.subjectKind === 'value_observation' &&
          p.subjectId === observationId,
      );
      return ok(rows);
    },
  };

  return graph;
}
