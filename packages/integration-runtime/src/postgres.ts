/**
 * PostgresIntegrationStore — the IntegrationStore over Supabase.
 *
 * The I/O boundary of @helm/integration-runtime, held to the same conformance
 * suite as the in-memory store. The database enforces the integrity rules
 * (helm_integration_* guards and CHECKs): write-once, record time stamped by the
 * database, a blocked run does not move the checkpoint, DRY_RUN is the only
 * mode, a dry run derives from an action intent of its own commitment, and an
 * idempotency key is unique per organization.
 *
 * Reads are RLS-shaped: a writeback request is returned only to a reader who can
 * see the decision it derives from.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fail, ok, type Result, type Scope, type SourceSystem, type UserId } from '@helm/shared';
import type { IntegrationStore } from './port.ts';
import { IntegrationErrors, type SyncRecord, type WritebackRequest } from './types.ts';

export type PostgresIntegrationStoreOptions = { client: SupabaseClient };

type Row = Record<string, unknown>;
const iso = (v: unknown): string => new Date(v as string).toISOString();

const toSync = (r: Row): SyncRecord => ({
  id: String(r.id),
  orgId: String(r.org_id),
  system: r.system as SourceSystem,
  connector: String(r.connector),
  cursorBefore: (r.cursor_before as string | null) ?? null,
  cursorAfter: (r.cursor_after as string | null) ?? null,
  outcome: r.outcome as SyncRecord['outcome'],
  counts: r.counts as SyncRecord['counts'],
  drift: (r.drift as SyncRecord['drift']) ?? [],
  quarantined: (r.quarantined as SyncRecord['quarantined']) ?? [],
  ingestionEventId: (r.ingestion_event_id as string | null) ?? null,
  startedBy: (r.started_by as UserId | null) ?? null,
  recordedAt: iso(r.recorded_at),
});

const toWriteback = (r: Row): WritebackRequest => ({
  id: String(r.id),
  orgId: String(r.org_id),
  commitmentId: String(r.commitment_id),
  decisionId: String(r.decision_id),
  actionIntentId: String(r.action_intent_id),
  targetSystem: r.target_system as SourceSystem,
  operation: String(r.operation),
  payload: r.payload as WritebackRequest['payload'],
  payloadHash: String(r.payload_hash),
  idempotencyKey: String(r.idempotency_key),
  mode: r.mode as WritebackRequest['mode'],
  outcome: r.outcome as WritebackRequest['outcome'],
  refusalReason: (r.refusal_reason as string | null) ?? null,
  receipt: (r.receipt as WritebackRequest['receipt']) ?? {},
  governanceState: String(r.governance_state),
  requestedBy: (r.requested_by as UserId | null) ?? null,
  recordedAt: iso(r.recorded_at),
});

type Q = PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;

const codeOf = (message: string, code?: string): string =>
  code === '23505' ? IntegrationErrors.DUPLICATE : /action intent/i.test(message) ? IntegrationErrors.NO_INTENT : IntegrationErrors.INVALID;

async function one<T>(q: Q, map: (r: Row) => T, what: string): Promise<Result<T>> {
  const { data, error } = await q;
  if (error) return fail(codeOf(error.message, error.code), `${what}: ${error.message}`);
  if (!data) return fail(IntegrationErrors.NOT_FOUND, `${what}: nothing was returned (not visible, or refused by policy).`);
  return ok(map(data as Row));
}
async function many<T>(q: Q, map: (r: Row) => T, what: string): Promise<Result<readonly T[]>> {
  const { data, error } = await q;
  if (error) return fail(IntegrationErrors.INVALID, `${what}: ${error.message}`);
  return ok(((data as Row[]) ?? []).map(map));
}

export function createPostgresIntegrationStore(opts: PostgresIntegrationStoreOptions): IntegrationStore {
  const db = opts.client;
  const org = (s: Scope) => s.orgId as string;
  return {
    appendSync: (scope, s) =>
      one(
        db
          .from('helm_integration_syncs')
          .insert({
            org_id: org(scope),
            system: s.system,
            connector: s.connector,
            cursor_before: s.cursorBefore,
            cursor_after: s.cursorAfter,
            outcome: s.outcome,
            counts: s.counts,
            drift: s.drift,
            quarantined: s.quarantined,
            ingestion_event_id: s.ingestionEventId,
            started_by: s.startedBy ?? scope.actorId,
          })
          .select('*')
          .single(),
        toSync,
        'Recording the sync',
      ),
    listSyncs: (scope, filter) => {
      let q = db.from('helm_integration_syncs').select('*').eq('org_id', org(scope)).order('recorded_at', { ascending: true });
      if (filter?.system) q = q.eq('system', filter.system);
      if (filter?.connector) q = q.eq('connector', filter.connector);
      return many(q, toSync, 'Listing syncs');
    },
    async checkpointOf(scope, system, connector) {
      const r = await many(
        db.from('helm_integration_syncs').select('*').eq('org_id', org(scope)).eq('system', system).eq('connector', connector).in('outcome', ['SUCCEEDED', 'PARTIAL']).order('recorded_at', { ascending: false }).limit(50),
        toSync,
        'Reading the checkpoint',
      );
      if (!r.ok) return r;
      const last = r.value[0];
      const lastOk = r.value.find((x) => x.outcome === 'SUCCEEDED');
      return ok({ system, connector, cursor: last ? last.cursorAfter : null, lastSucceededAt: lastOk ? lastOk.recordedAt : null });
    },

    insertWriteback: (scope, w) =>
      one(
        db
          .from('helm_writeback_requests')
          .insert({
            org_id: org(scope),
            commitment_id: w.commitmentId,
            decision_id: w.decisionId,
            action_intent_id: w.actionIntentId,
            target_system: w.targetSystem,
            operation: w.operation,
            payload: w.payload,
            payload_hash: w.payloadHash,
            idempotency_key: w.idempotencyKey,
            mode: w.mode,
            outcome: w.outcome,
            refusal_reason: w.refusalReason,
            receipt: w.receipt,
            governance_state: w.governanceState,
            requested_by: w.requestedBy ?? scope.actorId,
          })
          .select('*')
          .single(),
        toWriteback,
        'Recording the dry-run writeback',
      ),
    async findWriteback(scope, key) {
      const { data, error } = await db.from('helm_writeback_requests').select('*').eq('org_id', org(scope)).eq('idempotency_key', key).maybeSingle();
      if (error) return fail(IntegrationErrors.INVALID, `Finding the writeback: ${error.message}`);
      return ok(data ? toWriteback(data as Row) : null);
    },
    listWritebacks: (scope, filter) => {
      let q = db.from('helm_writeback_requests').select('*').eq('org_id', org(scope)).order('recorded_at', { ascending: true });
      if (filter?.commitmentId) q = q.eq('commitment_id', filter.commitmentId);
      return many(q, toWriteback, 'Listing writebacks');
    },
  };
}
