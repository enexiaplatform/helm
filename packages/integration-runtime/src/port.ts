/**
 * The integration ports (ADR-0030): what a source system must offer to be
 * connected, what a target system must offer to be written to (dry-run only in
 * v1), and where HELM keeps its own record of having done either.
 *
 * Nothing here names a vendor. Memoire is the first rich implementation; a
 * Salesforce, SAP, WMS or HRIS adapter implements the same interface and the
 * kernel does not change.
 */

import type { Result, Scope, SourceSystem } from '@helm/shared';
import type { SchemaContract, SourceRecord, SyncCheckpoint, SyncRecord, Translation, WritebackRequest } from './types.ts';

export type PullResult = {
  readonly records: readonly SourceRecord[];
  /** Where the next pull resumes; null when the source has nothing newer. Opaque to HELM. */
  readonly nextCursor: string | null;
};

/**
 * A way of reading one source system. `translate` is PURE: no network, no
 * database — an adapter is fully testable from recorded fixtures, and a source
 * schema change cannot ripple inward past it.
 */
export interface SourceAdapter {
  readonly system: SourceSystem;
  /** 'memoire-connector@0.1.0' — recorded in provenance so a fact names the build that translated it. */
  readonly connector: string;
  /** What the adapter promises each object type looks like. Drift is detected against this. */
  readonly contracts: readonly SchemaContract[];
  /** READ-ONLY. An adapter that can also write is a WritebackAdapter, and a separate object. */
  pull(scope: Scope, cursor: string | null, limit?: number): Promise<Result<PullResult>>;
  translate(record: SourceRecord): Result<Translation>;
}

export type WritebackDescription = {
  /** What a live call would address, in the target's own words. */
  readonly endpoint: string;
  readonly method: string;
  readonly body: Readonly<Record<string, unknown>>;
};

/**
 * The target side. v1 offers no method that sends: `describe` says what a live
 * write WOULD be, and the gateway records that. A live adapter is a later,
 * separately authorized decision; the interface has nowhere to put it yet.
 */
export interface WritebackAdapter {
  readonly system: SourceSystem;
  readonly supportedOperations: readonly string[];
  describe(operation: string, payload: Readonly<Record<string, unknown>>): Result<WritebackDescription>;
}

export type NewSync = Omit<SyncRecord, 'id' | 'orgId' | 'recordedAt'>;
export type NewWriteback = Omit<WritebackRequest, 'id' | 'orgId' | 'recordedAt'>;

/** HELM's own record of syncs and dry-run writebacks. Append-only; the store stamps record time. */
export interface IntegrationStore {
  appendSync(scope: Scope, input: NewSync): Promise<Result<SyncRecord>>;
  listSyncs(scope: Scope, filter?: { system?: SourceSystem; connector?: string }): Promise<Result<readonly SyncRecord[]>>;
  /** The resume point: the latest run that was not blocked or failed. */
  checkpointOf(scope: Scope, system: SourceSystem, connector: string): Promise<Result<SyncCheckpoint>>;

  /** Write-once, and unique on the idempotency key: a second insert of the same key is refused with integration.duplicate. */
  insertWriteback(scope: Scope, input: NewWriteback): Promise<Result<WritebackRequest>>;
  findWriteback(scope: Scope, idempotencyKey: string): Promise<Result<WritebackRequest | null>>;
  listWritebacks(scope: Scope, filter?: { commitmentId?: string }): Promise<Result<readonly WritebackRequest[]>>;
}
