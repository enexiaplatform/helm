/**
 * `Result` at kernel boundaries.
 *
 * Domain-rule failures are values, not exceptions: "this relationship type may
 * not connect these domains" is an expected outcome the caller must handle, not
 * a crash. Only programmer errors throw.
 */

export type HelmError = {
  /** Stable, greppable, namespaced: 'ontology.unknown_type'. */
  code: string;
  /** Manager-readable. Ends up in a UI, so it explains rather than blames. */
  message: string;
  details?: Record<string, unknown>;
};

export type Result<T, E = HelmError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E = HelmError>(error: E): Result<never, E> => ({ ok: false, error });

export const fail = (
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Result<never, HelmError> => err({ code, message, details });

export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;

export function map<T, U, E>(r: Result<T, E>, fn: (v: T) => U): Result<U, E> {
  return r.ok ? ok(fn(r.value)) : r;
}

export function flatMap<T, U, E>(
  r: Result<T, E>,
  fn: (v: T) => Result<U, E>,
): Result<U, E> {
  return r.ok ? fn(r.value) : r;
}

/** Unwraps or throws — for tests and for genuinely unreachable failures only. */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  throw new Error(`unwrap() on an error Result: ${JSON.stringify(r.error)}`);
}

export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

/**
 * Collects many Results into one. Fails on the first error — validation callers
 * that want every problem at once should gather errors themselves.
 */
export function all<T, E>(results: Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const r of results) {
    if (!r.ok) return r;
    values.push(r.value);
  }
  return ok(values);
}

/** Error codes the kernel emits. Kept together so they stay consistent. */
export const ErrorCodes = {
  ONTOLOGY_UNKNOWN_ENTITY_TYPE: 'ontology.unknown_entity_type',
  ONTOLOGY_UNKNOWN_RELATIONSHIP_TYPE: 'ontology.unknown_relationship_type',
  ONTOLOGY_INVALID_ATTRIBUTES: 'ontology.invalid_attributes',
  ONTOLOGY_DOMAIN_CONSTRAINT: 'ontology.domain_constraint_violated',
  ONTOLOGY_INACTIVE_TYPE: 'ontology.inactive_type',
  ONTOLOGY_DUPLICATE_TYPE: 'ontology.duplicate_type',
  ONTOLOGY_CYCLIC_INHERITANCE: 'ontology.cyclic_inheritance',
  ONTOLOGY_INVALID_CANONICAL_KEY: 'ontology.invalid_canonical_key',

  GRAPH_ENTITY_NOT_FOUND: 'graph.entity_not_found',
  GRAPH_RELATIONSHIP_NOT_FOUND: 'graph.relationship_not_found',
  GRAPH_DEPTH_REQUIRED: 'graph.depth_required',
  GRAPH_DEPTH_EXCEEDED: 'graph.depth_exceeded',
  GRAPH_CROSS_ORG: 'graph.cross_org_reference',
  GRAPH_SELF_REFERENCE: 'graph.self_reference',
  GRAPH_WRITE_FAILED: 'graph.write_failed',
  GRAPH_READ_FAILED: 'graph.read_failed',

  SCOPE_FORBIDDEN: 'scope.forbidden',
} as const;
