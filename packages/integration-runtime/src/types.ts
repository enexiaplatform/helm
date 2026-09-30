/**
 * The integration vocabulary (ADR-0030).
 *
 *   SOURCE SYSTEM OWNS THE FACT.
 *   HELM references, canonicalizes, models and interprets it.
 *
 * A source fact enters as a SourceRecord, is translated — purely — into
 * ontology terms, and is recorded as a source-typed observation (ACTUAL,
 * FORECAST, TARGET) that names its system. A model estimate about the same
 * quantity is a different observation type in the same node: Source Truth and
 * Model Truth sit side by side and neither overwrites the other.
 */

import type { SourceSystem, UserId } from '@helm/shared';
import type { UnitType } from '@helm/value-graph';

export const IntegrationErrors = {
  INVALID: 'integration.invalid_input',
  NOT_FOUND: 'integration.not_found',
  DRIFT_BREAKING: 'integration.schema_drift_breaking',
  IDENTITY_CONFLICT: 'integration.identity_conflict',
  NAME_IS_NOT_IDENTITY: 'integration.name_is_not_identity',
  SOURCE_CANNOT_ASSERT_MODEL: 'integration.source_cannot_assert_model',
  TRANSLATION: 'integration.translation_failed',
  LIVE_WRITEBACK_DISABLED: 'integration.live_writeback_disabled',
  NOT_AUTHORIZED_TO_WRITE_BACK: 'integration.writeback_not_authorized',
  NO_INTENT: 'integration.no_execution_intent',
  WRONG_TARGET: 'integration.wrong_target',
  DUPLICATE: 'integration.duplicate',
} as const;

// ------------------------------------------------------------------ source

/** What a source system said, as it said it. `fields` are the source's own names — they never leave the adapter. */
export type SourceRecord = {
  readonly system: SourceSystem;
  /** The source's own object type: 'opportunity', 'account'. */
  readonly objectType: string;
  /** The source's own durable id. Never a name. */
  readonly externalId: string;
  /** When the source last changed the record (source business time). */
  readonly updatedAt: string;
  /** Hash of the record content: two identical reads hash identically. */
  readonly contentHash: string;
  readonly fields: Readonly<Record<string, unknown>>;
};

export type EntityRef = { readonly entityTypeKey: string; readonly canonicalKey: string };

export type EntityMutation = EntityRef & {
  readonly name: string;
  readonly sourceEntityType: string;
  readonly sourceEntityId: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly observedAt: string;
};

export type RelationshipMutation = {
  readonly relationshipTypeKey: string;
  readonly source: EntityRef;
  readonly target: EntityRef;
  readonly sourceObjectType: string;
  readonly sourceObjectId: string;
};

export type AliasMutation = {
  readonly entity: EntityRef;
  readonly aliasKind: 'source_id' | 'code' | 'tax_id' | 'email' | 'domain';
  readonly aliasValue: string;
};

/** Observation types a SOURCE may assert. A source never asserts an estimate, a derivation, a scenario or a management assumption. */
export const sourceObservationTypes = ['ACTUAL', 'FORECAST', 'TARGET'] as const;
export type SourceObservationType = (typeof sourceObservationTypes)[number];

export type SourceFact = {
  readonly subject: EntityRef;
  readonly metricKey: string;
  readonly observationType: SourceObservationType;
  readonly value: number;
  readonly unit: UnitType;
  readonly currency: string | null;
  readonly effectiveAt: string | null;
  readonly periodStart?: string | null;
  readonly periodEnd?: string | null;
  readonly observedAt: string;
  /** The source's own field, kept as attribution: 'pipeline_probability'. */
  readonly sourceField: string;
  readonly confidence: number | null;
  readonly label: string;
};

export type Translation = {
  readonly entities: readonly EntityMutation[];
  readonly relationships: readonly RelationshipMutation[];
  readonly aliases: readonly AliasMutation[];
  readonly facts: readonly SourceFact[];
};

// ------------------------------------------------------------------- drift

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'json';
export type FieldSpec = { readonly name: string; readonly type: FieldType; readonly required: boolean };

/** What an adapter promises the source looks like. A changed source is detected against it, never assumed. */
export type SchemaContract = {
  readonly system: SourceSystem;
  readonly objectType: string;
  readonly version: string;
  readonly fields: readonly FieldSpec[];
};

export type DriftFinding = {
  readonly kind: 'MISSING_REQUIRED_FIELD' | 'TYPE_CHANGED' | 'UNKNOWN_FIELD' | 'MISSING_OPTIONAL_FIELD';
  readonly field: string;
  readonly detail: string;
  /** How many of the sampled records showed it. */
  readonly records: number;
};

export type DriftReport = {
  readonly objectType: string;
  readonly contractVersion: string;
  readonly sampled: number;
  /** A breaking finding stops ingestion of that object type: HELM never guesses at a changed source. */
  readonly breaking: readonly DriftFinding[];
  readonly additive: readonly DriftFinding[];
  readonly status: 'NONE' | 'ADDITIVE' | 'BREAKING';
};

// -------------------------------------------------------------------- sync

export const syncOutcomes = ['SUCCEEDED', 'PARTIAL', 'BLOCKED_BY_DRIFT', 'FAILED'] as const;
export type SyncOutcome = (typeof syncOutcomes)[number];

export type SyncCounts = {
  readonly records: number;
  readonly entitiesCreated: number;
  readonly entitiesUpdated: number;
  readonly entitiesUnchanged: number;
  readonly relationshipsCreated: number;
  readonly aliasesRegistered: number;
  readonly observationsRecorded: number;
  readonly observationsUnchanged: number;
  readonly quarantined: number;
};

export type SyncRecord = {
  readonly id: string;
  readonly orgId: string;
  readonly system: SourceSystem;
  readonly connector: string;
  readonly cursorBefore: string | null;
  /** Where the next run resumes. Unchanged on failure or on a drift block. */
  readonly cursorAfter: string | null;
  readonly outcome: SyncOutcome;
  readonly counts: SyncCounts;
  readonly drift: readonly DriftReport[];
  readonly quarantined: readonly { readonly externalId: string; readonly reason: string }[];
  /** The graph-store ingestion event the run's provenance points at. */
  readonly ingestionEventId: string | null;
  readonly startedBy: UserId | null;
  readonly recordedAt: string;
};

export type SyncCheckpoint = {
  readonly system: SourceSystem;
  readonly connector: string;
  readonly cursor: string | null;
  readonly lastSucceededAt: string | null;
};

// --------------------------------------------------------------- writeback

/** HELM → operational system. v1 has ONE mode: DRY_RUN. */
export const writebackModes = ['DRY_RUN'] as const;
export type WritebackMode = (typeof writebackModes)[number];

export const writebackOutcomes = ['WOULD_WRITE', 'REFUSED'] as const;
export type WritebackOutcome = (typeof writebackOutcomes)[number];

export type WritebackRequest = {
  readonly id: string;
  readonly orgId: string;
  readonly commitmentId: string;
  readonly decisionId: string;
  /** The execution intent the request derives from. There is no request without one. */
  readonly actionIntentId: string;
  readonly targetSystem: SourceSystem;
  readonly operation: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payloadHash: string;
  /** Stable for (intent, target, payload): dispatching twice is one request. */
  readonly idempotencyKey: string;
  readonly mode: WritebackMode;
  readonly outcome: WritebackOutcome;
  readonly refusalReason: string | null;
  /** What a live write would have sent, and to what. Nothing was sent. */
  readonly receipt: Readonly<Record<string, unknown>>;
  readonly governanceState: string;
  readonly requestedBy: UserId | null;
  readonly recordedAt: string;
};
