/**
 * The twin snapshot fingerprint.
 *
 * One identity for "this management state, of this scope, under this lens,
 * read through this model". It is built from the spec (kind, lens, scope,
 * periods, the run or commitment it is about), the model identity (engine
 * version, calculation registry, attention rules, composer version) and every
 * item of the manifest — its key, kind, layer, status, materialized state and
 * the kernel references that pin what was read. Nothing else: not the snapshot
 * id, not who built it, not when it was stored.
 *
 * So equivalent state under the same context fingerprints identically, and a
 * replay of the composition under the same lens either reproduces it byte for
 * byte or proves that something it rested on was rewritten.
 */

import { fnv1a64 } from '@helm/shared';
import type { ModelIdentity, SnapshotSpec, TwinItem } from './types.ts';

/** JSON with object keys sorted at every level, so equal content prints equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return 'null';
}

export function itemFingerprintLine(item: TwinItem): string {
  return canonicalJson({
    key: item.key,
    kind: item.kind,
    categories: [...item.categories].sort(),
    label: item.label,
    subject: item.subjectEntityId,
    layer: item.layer,
    status: item.status,
    state: item.state,
    refs: item.refs.map((r) => `${r.kind}:${r.id}:${r.pin ?? ''}`).sort(),
    sensitivity: item.sensitivity,
    reason: item.reason,
  });
}

export function snapshotFingerprint(spec: SnapshotSpec, model: ModelIdentity, items: readonly TwinItem[]): string {
  const lines = [
    'helm-twin-snapshot/v1',
    canonicalJson({
      kind: spec.kind,
      lens: { effectiveAsOf: new Date(spec.lens.effectiveAsOf).toISOString(), recordedThrough: new Date(spec.lens.recordedThrough).toISOString() },
      scope: spec.scope,
      periods: [...spec.periods].sort(),
      scenarioRunId: spec.scenarioRunId,
      commitmentId: spec.commitmentId,
    }),
    canonicalJson({ ...model, calculations: [...model.calculations].sort() }),
    ...[...items].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map(itemFingerprintLine),
  ];
  const text = lines.join('\n');
  return `tws_${fnv1a64(text)}_${text.length}`;
}
