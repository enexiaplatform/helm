/**
 * PostgresTwinStore — the TwinStore over Supabase.
 *
 * The I/O boundary of @helm/twin-runtime, held to the same conformance suite
 * as the in-memory store. The kernel check (checkSnapshot) runs first, so a
 * caller gets a typed error; the header and its manifest are then written in
 * ONE transaction by `helm_save_twin_snapshot` (SECURITY INVOKER — under the
 * caller's own RLS), and the database refuses the rest: a CURRENT chain that
 * moves backwards, a manifest whose length or sensitivity label disagrees with
 * its header, an item with no kernel reference, any update or delete.
 *
 * Reads are RLS-shaped: a snapshot is returned only where the caller may see
 * it, and each item only where the caller is cleared for its class — so a
 * manifest read back can be SHORTER than `itemCount`. That is the
 * sensitivity projection done by the database, never an error; the header's
 * `itemCount` and `sensitivityClasses` still say what exists.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fail, ok, type OrgId, type UserId } from '@helm/shared';
import { checkSnapshot } from './inMemoryStore.ts';
import type { SensitivityClearance } from './sensitivity.ts';
import { TwinErrors, sensitivityClasses, type TwinItem, type TwinSnapshot } from './types.ts';
import { scopeKeyOf, type TwinStore } from './port.ts';

export type PostgresTwinStoreOptions = { client: SupabaseClient };

type Row = Record<string, unknown>;

const SNAPSHOT_COLS =
  'id, org_id, kind, label, effective_as_of, recorded_through, scope, scope_key, periods, scenario_run_id, commitment_id, model, ' +
  'source_references, completeness, completeness_reasons, sensitivity_classes, granted_unit_ids, item_count, fingerprint, ' +
  'previous_snapshot_id, built_by, created_at';
const ITEM_COLS = 'item_key, kind, categories, label, subject_entity_id, layer, status, state, refs, sensitivity, reason, ordinal';
const CLEARANCE_COLS = 'id, org_id, user_id, sensitivity, valid_from, valid_to, reason, granted_by, recorded_at';

const iso = (v: unknown): string => new Date(v as string).toISOString();

const toSnapshot = (r: Row): TwinSnapshot => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  spec: {
    kind: r.kind as TwinSnapshot['spec']['kind'],
    label: String(r.label),
    lens: { effectiveAsOf: iso(r.effective_as_of), recordedThrough: iso(r.recorded_through) },
    scope: r.scope as TwinSnapshot['spec']['scope'],
    periods: (r.periods as string[]) ?? [],
    scenarioRunId: (r.scenario_run_id as string | null) ?? null,
    commitmentId: (r.commitment_id as string | null) ?? null,
  },
  model: r.model as TwinSnapshot['model'],
  sourceReferences: (r.source_references as TwinSnapshot['sourceReferences']) ?? [],
  completeness: r.completeness as TwinSnapshot['completeness'],
  completenessReasons: (r.completeness_reasons as TwinSnapshot['completenessReasons']) ?? [],
  sensitivityClasses: (r.sensitivity_classes as TwinSnapshot['sensitivityClasses']) ?? [],
  grantedUnitIds: ((r.granted_unit_ids as string[]) ?? []).slice().sort(),
  itemCount: Number(r.item_count),
  fingerprint: String(r.fingerprint),
  previousSnapshotId: (r.previous_snapshot_id as string | null) ?? null,
  builtBy: (r.built_by as UserId | null) ?? null,
  createdAt: iso(r.created_at),
});

const toItem = (r: Row): TwinItem => ({
  key: String(r.item_key),
  kind: r.kind as TwinItem['kind'],
  categories: (r.categories as TwinItem['categories']) ?? [],
  label: String(r.label),
  subjectEntityId: (r.subject_entity_id as string | null) ?? null,
  layer: (r.layer as TwinItem['layer']) ?? null,
  status: r.status as TwinItem['status'],
  state: (r.state as TwinItem['state']) ?? {},
  refs: (r.refs as TwinItem['refs']) ?? [],
  sensitivity: r.sensitivity as TwinItem['sensitivity'],
  reason: (r.reason as string | null) ?? null,
});

const toClearance = (r: Row): SensitivityClearance => ({
  id: String(r.id),
  orgId: String(r.org_id),
  userId: String(r.user_id),
  sensitivity: r.sensitivity as SensitivityClearance['sensitivity'],
  validFrom: iso(r.valid_from),
  validTo: r.valid_to ? iso(r.valid_to) : null,
  reason: String(r.reason),
  grantedBy: (r.granted_by as string | null) ?? null,
  recordedAt: iso(r.recorded_at),
});

export function createPostgresTwinStore(opts: PostgresTwinStoreOptions): TwinStore {
  const { client } = opts;
  return {
    async saveSnapshot(scope, header, items) {
      const checked = checkSnapshot(header, items);
      if (!checked.ok) return checked;
      const { data, error } = await client.rpc('helm_save_twin_snapshot', {
        p_header: {
          org_id: scope.orgId,
          kind: header.spec.kind,
          label: header.spec.label,
          effective_as_of: header.spec.lens.effectiveAsOf,
          recorded_through: header.spec.lens.recordedThrough,
          scope: header.spec.scope,
          scope_key: scopeKeyOf(header.spec.scope),
          periods: header.spec.periods,
          scenario_run_id: header.spec.scenarioRunId ?? '',
          commitment_id: header.spec.commitmentId ?? '',
          model: header.model,
          source_references: header.sourceReferences,
          completeness: header.completeness,
          completeness_reasons: header.completenessReasons,
          sensitivity_classes: header.sensitivityClasses,
          granted_unit_ids: header.grantedUnitIds,
          item_count: header.itemCount,
          fingerprint: header.fingerprint,
          previous_snapshot_id: header.previousSnapshotId ?? '',
          created_at: header.createdAt,
        },
        p_items: items,
      });
      if (error) return fail(TwinErrors.WRITE_FAILED, `The snapshot was not stored: ${error.message}`);
      const saved = await this.getSnapshot(scope, String(data));
      if (!saved.ok) return saved;
      if (!saved.value) return fail(TwinErrors.WRITE_FAILED, 'The snapshot was stored but cannot be read back by its builder.');
      return ok(saved.value);
    },

    async getSnapshot(scope, id) {
      const { data, error } = await client.from('helm_twin_snapshots').select(SNAPSHOT_COLS).eq('org_id', scope.orgId).eq('id', id).maybeSingle();
      if (error) return fail(TwinErrors.READ_FAILED, error.message);
      return ok(data ? toSnapshot(data as unknown as Row) : null);
    },

    async getItems(scope, snapshotId) {
      const snapshot = await this.getSnapshot(scope, snapshotId);
      if (!snapshot.ok) return snapshot;
      if (!snapshot.value) return fail(TwinErrors.NOT_FOUND, `Snapshot ${snapshotId} not found.`);
      const { data, error } = await client
        .from('helm_twin_snapshot_items')
        .select(ITEM_COLS)
        .eq('org_id', scope.orgId)
        .eq('snapshot_id', snapshotId)
        .order('ordinal')
        .limit(20000);
      if (error) return fail(TwinErrors.READ_FAILED, error.message);
      return ok(((data as unknown as Row[] | null) ?? []).map(toItem));
    },

    async listSnapshots(scope, filter) {
      let q = client.from('helm_twin_snapshots').select(SNAPSHOT_COLS).eq('org_id', scope.orgId);
      if (filter?.kind) q = q.eq('kind', filter.kind);
      if (filter?.scopeKey) q = q.eq('scope_key', filter.scopeKey);
      const { data, error } = await q.order('created_at').order('id').limit(2000);
      if (error) return fail(TwinErrors.READ_FAILED, error.message);
      return ok(((data as unknown as Row[] | null) ?? []).map(toSnapshot));
    },

    async grantClearance(scope, input) {
      if (!(sensitivityClasses as readonly string[]).includes(input.sensitivity) || input.sensitivity === 'GENERAL_MANAGEMENT') {
        return fail(TwinErrors.INVALID_INPUT, 'A clearance names one of the restricted sensitivity classes.');
      }
      if (input.validTo !== null && Date.parse(input.validTo) <= Date.parse(input.validFrom)) {
        return fail(TwinErrors.INVALID_INPUT, 'A clearance ends after it starts.');
      }
      if (input.reason.trim().length < 4) return fail(TwinErrors.INVALID_INPUT, 'A clearance states why it is granted.');
      const { data, error } = await client
        .from('helm_sensitivity_clearances')
        .insert({
          org_id: scope.orgId,
          user_id: input.userId,
          sensitivity: input.sensitivity,
          valid_from: input.validFrom,
          valid_to: input.validTo,
          reason: input.reason,
          granted_by: scope.actorId,
        })
        .select(CLEARANCE_COLS)
        .single();
      if (error) return fail(TwinErrors.WRITE_FAILED, error.message);
      return ok(toClearance(data as Row));
    },

    async listClearances(scope, userId) {
      let q = client.from('helm_sensitivity_clearances').select(CLEARANCE_COLS).eq('org_id', scope.orgId);
      if (userId) q = q.eq('user_id', userId);
      const { data, error } = await q.order('valid_from').order('id');
      if (error) return fail(TwinErrors.READ_FAILED, error.message);
      return ok(((data as unknown as Row[] | null) ?? []).map(toClearance));
    },
  };
}
