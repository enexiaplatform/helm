/**
 * InMemoryTwinStore — the TwinStore for demo mode and tests.
 *
 * Held to the same conformance suite as the Postgres store. It enforces what
 * the database enforces: write-once snapshots, a fingerprint that must match
 * the manifest it arrives with, a CURRENT chain that only moves forward, and
 * clearances that name a real class and an end after their start.
 */

import { fail, ok, type Clock, type IdGen, type Result, type Scope } from '@helm/shared';
import { snapshotFingerprint } from './fingerprint.ts';
import { containerSensitivity } from './sensitivity.ts';
import type { SensitivityClearance } from './sensitivity.ts';
import { TwinErrors, sensitivityClasses, type TwinItem, type TwinSnapshot } from './types.ts';
import { scopeKeyOf, type NewSnapshot, type TwinStore } from './port.ts';

export type InMemoryTwinStoreOptions = { clock: Clock; idGen: IdGen };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/** Shared by both adapters, so they refuse the same snapshots with the same words. */
export function checkSnapshot(header: NewSnapshot, items: readonly TwinItem[]): Result<true> {
  const expected = snapshotFingerprint(header.spec, header.model, items);
  if (header.fingerprint !== expected) {
    return fail(TwinErrors.FINGERPRINT_MISMATCH, 'The snapshot fingerprint does not match its manifest; it was not stored.', { expected, received: header.fingerprint });
  }
  if (header.itemCount !== items.length) return fail(TwinErrors.INVALID_INPUT, 'The item count does not match the manifest.');
  const keys = new Set(items.map((i) => i.key));
  if (keys.size !== items.length) return fail(TwinErrors.INVALID_INPUT, 'A manifest holds each item key once.');
  for (const i of items) {
    if (i.refs.length === 0) return fail(TwinErrors.INVALID_INPUT, `Item ${i.key} names no kernel object; a twin item is never free-standing.`);
  }
  const labelled = containerSensitivity(items);
  if (labelled.join(',') !== [...header.sensitivityClasses].join(',')) {
    return fail(TwinErrors.INVALID_INPUT, 'The snapshot sensitivity label is derived from its items and does not match them.');
  }
  if (Date.parse(header.spec.lens.recordedThrough) > Date.parse(header.createdAt)) {
    return fail(TwinErrors.INVALID_INPUT, 'A snapshot cannot know what was recorded after it was built.');
  }
  return ok(true);
}

export function createInMemoryTwinStore(opts: InMemoryTwinStoreOptions): TwinStore {
  const { clock, idGen } = opts;
  const snapshots = new Map<string, TwinSnapshot>();
  const manifests = new Map<string, readonly TwinItem[]>();
  const clearances = new Map<string, SensitivityClearance>();
  const mine = <T extends { orgId: string }>(scope: Scope, v: T | undefined): T | null => (v && v.orgId === scope.orgId ? v : null);

  return {
    async saveSnapshot(scope, header, items) {
      const checked = checkSnapshot(header, items);
      if (!checked.ok) return checked;
      if (header.previousSnapshotId !== null) {
        const prev = mine(scope, snapshots.get(header.previousSnapshotId));
        if (!prev) return fail(TwinErrors.NOT_FOUND, 'The previous snapshot is not in this organization.');
        if (prev.spec.kind !== 'CURRENT' || header.spec.kind !== 'CURRENT' || scopeKeyOf(prev.spec.scope) !== scopeKeyOf(header.spec.scope)) {
          return fail(TwinErrors.INVALID_INPUT, 'Only a CURRENT snapshot follows a CURRENT snapshot of the same scope.');
        }
        if (Date.parse(prev.spec.lens.recordedThrough) > Date.parse(header.spec.lens.recordedThrough)) {
          return fail(TwinErrors.INVALID_INPUT, 'Current state only moves forward in knowledge.');
        }
      }
      const snapshot = deepFreeze({ ...header, id: idGen.next(), orgId: scope.orgId } as TwinSnapshot);
      snapshots.set(snapshot.id, snapshot);
      manifests.set(snapshot.id, deepFreeze(items.map((i) => ({ ...i }))));
      return ok(snapshot);
    },
    async getSnapshot(scope, id) {
      return ok(mine(scope, snapshots.get(id)));
    },
    async getItems(scope, snapshotId) {
      if (!mine(scope, snapshots.get(snapshotId))) return fail(TwinErrors.NOT_FOUND, `Snapshot ${snapshotId} not found.`);
      return ok(manifests.get(snapshotId) ?? []);
    },
    async listSnapshots(scope, filter) {
      return ok(
        [...snapshots.values()]
          .filter((s) => s.orgId === scope.orgId)
          .filter((s) => !filter?.kind || s.spec.kind === filter.kind)
          .filter((s) => !filter?.scopeKey || scopeKeyOf(s.spec.scope) === filter.scopeKey)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
      );
    },
    async grantClearance(scope, input) {
      if (!(sensitivityClasses as readonly string[]).includes(input.sensitivity) || input.sensitivity === 'GENERAL_MANAGEMENT') {
        return fail(TwinErrors.INVALID_INPUT, 'A clearance names one of the restricted sensitivity classes.');
      }
      if (input.validTo !== null && Date.parse(input.validTo) <= Date.parse(input.validFrom)) {
        return fail(TwinErrors.INVALID_INPUT, 'A clearance ends after it starts.');
      }
      if (input.reason.trim().length < 4) return fail(TwinErrors.INVALID_INPUT, 'A clearance states why it is granted.');
      const c = deepFreeze({ ...input, id: idGen.next(), orgId: scope.orgId, recordedAt: input.recordedAt || clock.now().toISOString() });
      clearances.set(c.id, c);
      return ok(c);
    },
    async listClearances(scope, userId) {
      return ok(
        [...clearances.values()]
          .filter((c) => c.orgId === scope.orgId && (!userId || c.userId === userId))
          .sort((a, b) => a.validFrom.localeCompare(b.validFrom) || a.id.localeCompare(b.id)),
      );
    },
  };
}
