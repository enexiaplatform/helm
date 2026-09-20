/**
 * Provenance vocabulary — see ADR-0013.
 *
 * HELM must be able to answer "where did this fact come from?" uniformly,
 * whether the fact was ingested from a source system, derived by a calculation,
 * or typed in by a manager as an explicit assumption.
 */

import type { IngestionEventId, OrgId, ProvenanceId, UserId } from './ids.ts';
import type { Confidence, RecordTime, ValidTime } from './temporal.ts';

/** Systems HELM can learn facts from. `helm` = HELM's own tables. */
export const sourceSystems = [
  'memoire',
  'erp',
  'finance',
  'scm',
  'wms',
  'hris',
  'market',
  'helm',
  'manual',
] as const;
export type SourceSystem = (typeof sourceSystems)[number];

/**
 * How a fact was acquired. The extension point that lets Phase 3's calculation
 * audit reuse this table rather than needing its own.
 */
export const provenanceMethods = [
  'ingested', // pulled from a source system by a connector
  'seeded', // shipped ontology or demo fixture
  'derived', // produced by a rule from other facts
  'calculated', // produced by a registered calculation (Phase 3)
  'human_assumption', // a manager asserted it
  'inferred', // concluded, e.g. an identity resolution merge
] as const;
export type ProvenanceMethod = (typeof provenanceMethods)[number];

export const provenanceSubjects = [
  'entity',
  'relationship',
  'entity_version',
  // Phase 2: the value graph reuses this mechanism rather than inventing a
  // second source model (ADR-0013, ADR-0015).
  'value_node',
  'value_link',
  'value_observation',
  // Phase 3: a derived value's provenance names the RUN that produced it. The
  // run id is the only subject known before the observation exists, and
  // helm_provenance is append-only, so a placeholder subject could never be
  // corrected. The observation points back through its own provenance_id.
  'calculation_run',
  'calculation_step',
] as const;
export type ProvenanceSubject = (typeof provenanceSubjects)[number];

export type ProvenanceRecord = {
  id: ProvenanceId;
  orgId: OrgId;
  subjectKind: ProvenanceSubject;
  subjectId: string;
  /** Field-level attribution when the fact concerns one attribute. */
  sourceField: string | null;
  method: ProvenanceMethod;
  system: SourceSystem;
  /** Which connector build produced this, e.g. 'memoire-connector@0.1.0'. */
  connector: string | null;
  sourceObjectType: string | null;
  sourceObjectId: string | null;
  ingestionEventId: IngestionEventId | null;
  /** What was applied to get from source to fact. */
  transformation: string | null;
  /** For derived/calculated: the contributing references. */
  inputs: Record<string, unknown> | null;
  /** For human_assumption: who asserted it. */
  actorId: UserId | null;
  confidence: Confidence | null;
  notes: string | null;
  /** The source fragment that justifies the fact — never a full record copy. */
  payload: Record<string, unknown> | null;
  observedAt: ValidTime | null;
  recordedAt: RecordTime;
};

/** The subset a writer supplies; ids and record time are assigned by the store. */
export type ProvenanceInput = Omit<ProvenanceRecord, 'id' | 'orgId' | 'recordedAt'> & {
  recordedAt?: RecordTime;
};

/**
 * The denormalised provenance carried inline on entities and relationships.
 * ADR-0013 keeps this as a fast path; `helm_provenance` is authoritative for
 * anything richer, and `verify:ontology` asserts the two agree.
 */
export type InlineProvenance = {
  sourceSystem: SourceSystem;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
  observedAt: ValidTime | null;
};

export type IngestionEventStatus = 'running' | 'succeeded' | 'failed' | 'partial';

export type IngestionEvent = {
  id: IngestionEventId;
  orgId: OrgId;
  system: SourceSystem;
  connector: string;
  cursor: string | null;
  startedAt: RecordTime;
  finishedAt: RecordTime | null;
  status: IngestionEventStatus;
  recordCount: number;
  notes: string | null;
};
