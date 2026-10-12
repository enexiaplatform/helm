/**
 * The ingestion pipeline: source records → ontology → value graph, idempotent.
 *
 *   pull → check for schema drift → translate (pure) → upsert entities →
 *   register identity → relate → record SOURCE-typed observations → checkpoint.
 *
 * Idempotent by construction: an entity upsert returns 'unchanged' for
 * identical content and writes no version; an observation identical in value,
 * unit and currency to the latest of its type is not recorded again; an alias
 * asserted twice is one alias. Running the same sync twice changes nothing.
 *
 * Source Truth ≠ Model Truth: the pipeline records only ACTUAL, FORECAST and
 * TARGET, each naming its system. It has no path to write an ESTIMATE, a
 * DERIVED value, a scenario value or a management assumption — a Model
 * estimate of the same quantity is another observation type in the same node
 * and is never overwritten by, or written over, the source's.
 */

import type { GraphStore } from '@helm/graph-store';
import type { ValueGraph } from '@helm/value-graph';
import { asEntityId, asValidTime, fail, fnv1a64, type Clock, type Result, type Scope, type SourceSystem } from '@helm/shared';
import { detectDrift } from './drift.ts';
import { createIdentityMapper, type IdentityMapper } from './identity.ts';
import type { IntegrationStore, SourceAdapter } from './port.ts';
import {
  IntegrationErrors,
  sourceObservationTypes,
  type DriftReport,
  type EntityRef,
  type SourceFact,
  type SourceRecord,
  type SyncCounts,
  type SyncOutcome,
  type SyncRecord,
  type Translation,
} from './types.ts';

export type IngestionPipelineDeps = {
  readonly graph: GraphStore;
  readonly valueGraph: ValueGraph;
  readonly store: IntegrationStore;
  readonly clock: Clock;
  readonly identity?: IdentityMapper;
  /**
   * How many records of a page are ingested side by side. Each record is several reads and writes, and in the cloud each
   * is a round trip: one after another, a first read of a hundred opportunities took minutes (audit 2026-10-12).
   */
  readonly concurrency?: number;
};

const DEFAULT_CONCURRENCY = 8;

/** Run `fn` over the items with at most `limit` in flight. */
async function eachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
}

export type RunOptions = { readonly limit?: number };

export interface IngestionPipeline {
  /** One sync of one adapter from its checkpoint. Records the run whatever happened. */
  run(scope: Scope, adapter: SourceAdapter, options?: RunOptions): Promise<Result<SyncRecord>>;
}

const emptyCounts = (): { -readonly [K in keyof SyncCounts]: SyncCounts[K] } => ({
  records: 0,
  entitiesCreated: 0,
  entitiesUpdated: 0,
  entitiesUnchanged: 0,
  relationshipsCreated: 0,
  aliasesRegistered: 0,
  observationsRecorded: 0,
  observationsUnchanged: 0,
  quarantined: 0,
});

const keyOf = (r: EntityRef) => `${r.entityTypeKey}|${r.canonicalKey}`;

export function createIngestionPipeline(deps: IngestionPipelineDeps): IngestionPipeline {
  const { graph, valueGraph, store } = deps;
  const identity = deps.identity ?? createIdentityMapper(graph);

  return {
    async run(scope, adapter, options) {
      const cp = await store.checkpointOf(scope, adapter.system, adapter.connector);
      if (!cp.ok) return cp;
      const cursorBefore = cp.value.cursor;
      const startedBy = scope.actorId;
      const counts = emptyCounts();
      const quarantined: { externalId: string; reason: string }[] = [];
      const drift: DriftReport[] = [];

      const record = (outcome: SyncOutcome, cursorAfter: string | null, ingestionEventId: string | null) =>
        store.appendSync(scope, { system: adapter.system, connector: adapter.connector, cursorBefore, cursorAfter, outcome, counts: { ...counts }, drift, quarantined, ingestionEventId, startedBy });

      const pulled = await adapter.pull(scope, cursorBefore, options?.limit);
      if (!pulled.ok) {
        const failed = await record('FAILED', cursorBefore, null);
        return failed.ok ? fail(pulled.error.code, `The pull failed and the checkpoint did not move: ${pulled.error.message}`) : failed;
      }
      counts.records = pulled.value.records.length;

      // ---- drift first: a changed source is never guessed at.
      const byType = new Map<string, SourceRecord[]>();
      for (const r of pulled.value.records) byType.set(r.objectType, [...(byType.get(r.objectType) ?? []), r]);
      const blockedTypes = new Set<string>();
      for (const [objectType, recs] of byType) {
        const contract = adapter.contracts.find((c) => c.objectType === objectType);
        if (!contract) {
          blockedTypes.add(objectType);
          drift.push({ objectType, contractVersion: 'none', sampled: recs.length, breaking: [{ kind: 'UNKNOWN_FIELD', field: '*', detail: `The adapter has no contract for object type "${objectType}".`, records: recs.length }], additive: [], status: 'BREAKING' });
          continue;
        }
        const report = detectDrift(contract, recs);
        drift.push(report);
        if (report.status === 'BREAKING') blockedTypes.add(objectType);
      }
      const usable = pulled.value.records.filter((r) => !blockedTypes.has(r.objectType));
      if (usable.length === 0 && blockedTypes.size > 0) {
        const blocked = await record('BLOCKED_BY_DRIFT', cursorBefore, null);
        return blocked;
      }

      const evt = await graph.startIngestionEvent(scope, adapter.system, adapter.connector, cursorBefore);
      if (!evt.ok) return evt;
      const ingestionEventId = evt.value.id as string;

      const entityByKey = new Map<string, { id: string }>();
      const entityOf = async (ref: EntityRef): Promise<string | null> => {
        const hit = entityByKey.get(keyOf(ref));
        if (hit) return hit.id;
        const r = await graph.getEntityByCanonicalKey(scope, ref.entityTypeKey, ref.canonicalKey);
        if (!r.ok || !r.value) return null;
        entityByKey.set(keyOf(ref), { id: r.value.id });
        return r.value.id;
      };

      // ---- translate every record first (pure); what cannot be translated is quarantined and goes no further.
      type Work = { readonly index: number; readonly rec: SourceRecord; readonly t: Translation };
      const work: Work[] = [];
      const quarantine = (index: number, externalId: string, reason: string) => {
        quarantinedAt.push({ index, entry: { externalId, reason } });
        counts.quarantined += 1;
      };
      const quarantinedAt: { index: number; entry: { externalId: string; reason: string } }[] = [];
      usable.forEach((rec, index) => {
        const t = adapter.translate(rec);
        if (!t.ok) return quarantine(index, rec.externalId, t.error.message);
        const problems = validateTranslation(t.value.facts);
        if (problems) return quarantine(index, rec.externalId, problems);
        work.push({ index, rec, t: t.value });
      });

      // ---- what more than one record of this page names is SHARED (a customer named by each of its opportunities, the
      // segment its account belongs to). Its writes happen once per mention, in record order, before anything runs side
      // by side — exactly as a sequential run would make them. Everything else belongs to one record alone, so records
      // can be ingested concurrently without two of them racing on the same entity, alias, relationship or value node.
      const mentions = new Map<string, number>();
      for (const w of work) {
        const named = new Set([
          ...w.t.entities.map(keyOf),
          ...w.t.aliases.map((x) => keyOf(x.entity)),
          ...w.t.relationships.flatMap((r) => [keyOf(r.source), keyOf(r.target)]),
          ...w.t.facts.map((x) => keyOf(x.subject)),
        ]);
        for (const k of named) mentions.set(k, (mentions.get(k) ?? 0) + 1);
      }
      const shared = (r: EntityRef) => (mentions.get(keyOf(r)) ?? 0) > 1;
      const failed = new Set<number>();

      const upsertEntities = async (w: Work, which: (m: EntityRef) => boolean) => {
        for (const m of w.t.entities) {
          if (!which(m)) continue;
          // What the source said about this entity may not have changed even though another record mentions it later
          // (a customer named by each of its opportunities): unchanged content is not a new version.
          const held = await graph.getEntityByCanonicalKey(scope, m.entityTypeKey, m.canonicalKey);
          if (held.ok && held.value && sameContent(held.value, m, adapter.system)) {
            entityByKey.set(keyOf(m), { id: held.value.id });
            counts.entitiesUnchanged += 1;
            continue;
          }
          const up = await graph.upsertEntity(scope, {
            entityTypeKey: m.entityTypeKey,
            canonicalKey: m.canonicalKey,
            name: m.name,
            sourceSystem: adapter.system,
            sourceEntityType: m.sourceEntityType,
            sourceEntityId: m.sourceEntityId,
            observedAt: asValidTime(m.observedAt),
            attributes: { ...m.attributes },
            createdBy: startedBy,
          });
          if (!up.ok) throw new Error(up.error.message);
          entityByKey.set(keyOf(m), { id: up.value.entity.id });
          if (up.value.outcome === 'created') counts.entitiesCreated += 1;
          else if (up.value.outcome === 'updated') counts.entitiesUpdated += 1;
          else counts.entitiesUnchanged += 1;
          if (up.value.outcome !== 'unchanged') {
            const p = await graph.recordProvenance(scope, {
              subjectKind: 'entity',
              subjectId: up.value.entity.id,
              sourceField: null,
              method: 'ingested',
              system: adapter.system,
              connector: adapter.connector,
              sourceObjectType: m.sourceEntityType,
              sourceObjectId: m.sourceEntityId,
              ingestionEventId: evt.value.id,
              transformation: `translate@${adapter.contracts.find((c) => c.objectType === w.rec.objectType)?.version ?? 'unversioned'}`,
              inputs: null,
              actorId: startedBy,
              confidence: null,
              notes: null,
              payload: { contentHash: w.rec.contentHash, updatedAt: w.rec.updatedAt },
              observedAt: asValidTime(m.observedAt),
            });
            if (!p.ok) throw new Error(p.error.message);
          }
        }
      };
      const registerAliases = async (w: Work, which: (m: EntityRef) => boolean) => {
        for (const al of w.t.aliases) {
          if (!which(al.entity)) continue;
          const id = await entityOf(al.entity);
          if (!id) throw new Error(`alias names ${al.entity.canonicalKey}, which was not ingested`);
          const reg = await identity.register(scope, asEntityId(id), adapter.system, al.aliasKind, al.aliasValue, { connector: adapter.connector, ingestionEventId });
          if (!reg.ok) throw new Error(reg.error.message);
          if (reg.value.created) counts.aliasesRegistered += 1;
        }
      };
      const relate = async (w: Work, which: (r: Translation['relationships'][number]) => boolean) => {
        for (const rel of w.t.relationships) {
          if (!which(rel)) continue;
          const src = await entityOf(rel.source);
          const tg = await entityOf(rel.target);
          if (!src || !tg) throw new Error(`relationship ${rel.relationshipTypeKey} names an entity that was not ingested`);
          const have = await graph.findRelationships(scope, { relationshipTypeKeys: [rel.relationshipTypeKey], sourceEntityId: asEntityId(src), targetEntityId: asEntityId(tg) });
          if (!have.ok) throw new Error(have.error.message);
          if (have.value.length === 0) {
            const made = await graph.createRelationship(scope, {
              relationshipTypeKey: rel.relationshipTypeKey,
              sourceEntityId: asEntityId(src),
              targetEntityId: asEntityId(tg),
              sourceSystem: adapter.system,
              sourceObjectType: rel.sourceObjectType,
              sourceObjectId: rel.sourceObjectId,
              observedAt: asValidTime(w.rec.updatedAt),
              createdBy: startedBy,
            });
            if (!made.ok) throw new Error(made.error.message);
            counts.relationshipsCreated += 1;
          }
        }
      };
      const bothShared = (r: Translation['relationships'][number]) => shared(r.source) && shared(r.target);

      // 1. The shared part, sequentially, in record order.
      for (const w of work) {
        try {
          await upsertEntities(w, shared);
          await registerAliases(w, shared);
          await relate(w, bothShared);
        } catch (e) {
          failed.add(w.index);
          quarantine(w.index, w.rec.externalId, (e as Error).message);
        }
      }

      // 2. What belongs to one record alone — its own entities, identities, relationships and source facts.
      const own = async (w: Work) => {
        try {
          await upsertEntities(w, (m) => !shared(m));
          await registerAliases(w, (m) => !shared(m));
          await relate(w, (r) => !bothShared(r));
          // facts — source-typed observations only
          for (const fact of w.t.facts) {
            const outcome = await recordFact(scope, adapter, w.rec, fact, ingestionEventId, await entityOf(fact.subject));
            if (outcome === 'recorded') counts.observationsRecorded += 1;
            else counts.observationsUnchanged += 1;
          }
        } catch (e) {
          quarantine(w.index, w.rec.externalId, (e as Error).message);
        }
      };
      const rest = work.filter((w) => !failed.has(w.index));
      // A record whose facts land on a shared subject (the same opportunity twice in one page) shares a value node with
      // another record: those run one after another, after the rest.
      const alone = rest.filter((w) => w.t.facts.every((x) => !shared(x.subject)));
      const together = rest.filter((w) => !alone.includes(w));
      await eachLimited(alone, deps.concurrency ?? DEFAULT_CONCURRENCY, own);
      for (const w of together) await own(w);
      // Completion order is not record order: the quarantine reads in record order, whatever finished first.
      quarantined.push(...quarantinedAt.sort((x, y) => x.index - y.index).map((q) => q.entry));

      const anyBlocked = blockedTypes.size > 0;
      const anyQuarantined = quarantined.length > 0;
      const outcome: SyncOutcome = anyBlocked || anyQuarantined ? 'PARTIAL' : 'SUCCEEDED';
      // The checkpoint never moves past a record HELM could not take: the next run sees it again.
      const cursorAfter = anyBlocked || anyQuarantined ? cursorBefore : (pulled.value.nextCursor ?? cursorBefore);
      await graph.finishIngestionEvent(scope, evt.value.id, outcome === 'SUCCEEDED' ? 'succeeded' : 'partial', counts.records - counts.quarantined, quarantined.map((q) => `${q.externalId}: ${q.reason}`).join('; ') || null);
      return record(outcome, cursorAfter, ingestionEventId);
    },
  };

  async function recordFact(scope: Scope, adapter: SourceAdapter, rec: SourceRecord, f: SourceFact, ingestionEventId: string, subjectId: string | null): Promise<'recorded' | 'unchanged'> {
    if (!subjectId) throw new Error(`fact ${f.metricKey} names ${f.subject.canonicalKey}, which was not ingested`);
    const node = await valueGraph.upsertValueNode(scope, { metricKey: f.metricKey, subjectEntityId: asEntityId(subjectId), timeHorizon: 'current', label: f.label, createdBy: scope.actorId });
    if (!node.ok) throw new Error(node.error.message);
    const latest = await valueGraph.getLatestObservation(scope, { nodeId: node.value.id, type: f.observationType, scenarioEntityId: null });
    if (latest.ok && latest.value && latest.value.numericValue === f.value && latest.value.unitType === f.unit && (latest.value.currency ?? null) === (f.currency ?? null)) return 'unchanged';
    const obs = await valueGraph.recordObservation(scope, {
      nodeId: node.value.id,
      observationType: f.observationType,
      numericValue: f.value,
      unitType: f.unit,
      currency: f.currency,
      effectiveAt: f.effectiveAt === null ? null : asValidTime(f.effectiveAt),
      periodStart: f.periodStart ? asValidTime(f.periodStart) : null,
      periodEnd: f.periodEnd ? asValidTime(f.periodEnd) : null,
      observedAt: asValidTime(f.observedAt),
      confidence: f.confidence,
      sourceSystem: adapter.system as SourceSystem,
      metadata: { sourceField: f.sourceField, sourceObjectType: rec.objectType, sourceObjectId: rec.externalId, contentHash: rec.contentHash, ingestionEventId, connector: adapter.connector, fingerprint: fnv1a64(`${adapter.system}|${rec.externalId}|${f.metricKey}|${f.value}`) },
      createdBy: scope.actorId,
    });
    if (!obs.ok) throw new Error(obs.error.message);
    const p = await graph.recordProvenance(scope, {
      subjectKind: 'value_observation',
      subjectId: obs.value.id,
      sourceField: f.sourceField,
      method: 'ingested',
      system: adapter.system,
      connector: adapter.connector,
      sourceObjectType: rec.objectType,
      sourceObjectId: rec.externalId,
      ingestionEventId: ingestionEventId as never,
      transformation: `translate@${adapter.contracts.find((c) => c.objectType === rec.objectType)?.version ?? 'unversioned'}`,
      inputs: null,
      actorId: scope.actorId,
      confidence: f.confidence,
      notes: null,
      payload: { contentHash: rec.contentHash, updatedAt: rec.updatedAt },
      observedAt: asValidTime(f.observedAt),
    });
    if (!p.ok) throw new Error(p.error.message);
    return 'recorded';
  }
}

const stable = (o: unknown): string => JSON.stringify(o, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v));
const sameContent = (e: { name: string; sourceSystem: string; sourceEntityId: string | null; attributes: Readonly<Record<string, unknown>> }, m: { name: string; sourceEntityId: string; attributes: Readonly<Record<string, unknown>> }, system: string): boolean =>
  e.name === m.name && e.sourceSystem === system && e.sourceEntityId === m.sourceEntityId && stable(e.attributes) === stable(m.attributes);

/** A source cannot assert model truth: only ACTUAL, FORECAST and TARGET pass. */
function validateTranslation(facts: readonly SourceFact[]): string | null {
  for (const f of facts) {
    if (!(sourceObservationTypes as readonly string[]).includes(f.observationType)) {
      return `${IntegrationErrors.SOURCE_CANNOT_ASSERT_MODEL}: a source may record ACTUAL, FORECAST or TARGET, not ${f.observationType}.`;
    }
    if (!Number.isFinite(f.value)) return `fact ${f.metricKey} is not a finite number`;
  }
  return null;
}
