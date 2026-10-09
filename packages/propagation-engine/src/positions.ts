/**
 * Derived value positions — where the model's results can live.
 *
 * The engine writes a derived observation onto a value node that already
 * carries the output metric; it never invents a node. A world that arrives from
 * a source system (Memoire, ADR-0034) brings its source facts — an opportunity's
 * value and probability — and nothing else, so a full model run over it finds
 * nowhere to put an expected revenue and computes nothing at all.
 *
 * `ensureDerivedPositions` closes that gap from the registry alone. For every
 * active calculation whose required inputs all sit on the SAME subject, each
 * subject that carries every one of those inputs gets the output position, at
 * the run's horizon, linked DRIVES from the inputs it is computed from. It
 * creates structure only: no observation, no value, no default. Whatever the
 * position will hold is still computed by the engine, with its trace.
 *
 * Calculations that need a related or scoped input (a product's price, an
 * enterprise assumption) are left alone: whether such a position exists is a
 * modelling decision about the related entity, not something a subject's own
 * facts can settle. Idempotent — positions and links that exist are reused.
 */

import { fail, ok, type EntityId, type Result, type Scope } from '@helm/shared';
import type { GraphStore } from '@helm/graph-store';
import type { OntologyRegistry } from '@helm/ontology';
import type { TimeHorizon, ValueGraph, ValueNode } from '@helm/value-graph';
import type { CalculationDefinition } from './types.ts';
import type { CalculationRegistry } from './registry.ts';

export type DerivedPositionDeps = {
  readonly registry: CalculationRegistry;
  readonly valueGraph: ValueGraph;
  readonly graphStore: GraphStore;
  readonly ontology: OntologyRegistry;
};

export type DerivedPosition = {
  readonly nodeId: string;
  readonly metricKey: string;
  readonly subjectEntityId: EntityId;
  readonly calculation: string;
  readonly label: string;
};

export type DerivedPositionReport = {
  /** Positions this call created. */
  readonly created: readonly DerivedPosition[];
  /** Positions that already existed for a subject that qualifies. */
  readonly existing: number;
  /** Calculations left alone because an input is not on the same subject. */
  readonly notSameSubject: readonly string[];
};

const LIMIT = 5000;

/** A calculation whose every required input is read from the output's own subject. */
const sameSubjectOnly = (c: CalculationDefinition): boolean =>
  c.inputs.filter((i) => i.required).length > 0 && c.inputs.filter((i) => i.required).every((i) => i.binding.kind === 'SAME_SUBJECT');

const ref = (c: CalculationDefinition): string => `${c.key}@${c.version}`;

export async function ensureDerivedPositions(
  deps: DerivedPositionDeps,
  scope: Scope,
  opts: { horizon?: TimeHorizon } = {},
): Promise<Result<DerivedPositionReport>> {
  const horizon: TimeHorizon = opts.horizon ?? 'quarter';
  const created: DerivedPosition[] = [];
  let existing = 0;
  const calcs = deps.registry.active();
  const notSameSubject = calcs.filter((c) => !sameSubjectOnly(c)).map(ref);
  const categories = new Map<string, { category: string | null; name: string }>();

  const subjectOf = async (id: EntityId): Promise<Result<{ category: string | null; name: string }>> => {
    const known = categories.get(String(id));
    if (known) return ok(known);
    const e = await deps.graphStore.getEntity(scope, id);
    if (!e.ok) return e;
    const v = { category: e.value ? deps.ontology.categoryOf(e.value.entityTypeKey) : null, name: e.value?.name ?? String(id) };
    categories.set(String(id), v);
    return ok(v);
  };

  // A position created in one pass can be an input of another calculation: repeat until nothing new appears.
  for (let pass = 0; pass < 8; pass += 1) {
    let added = 0;
    for (const calc of calcs.filter(sameSubjectOnly)) {
      const required = calc.inputs.filter((i) => i.required);
      // Subjects carrying each required input, at the horizon the input is read at.
      let qualifying: Map<string, ValueNode[]> | null = null;
      for (const input of required) {
        const found = await deps.valueGraph.findValueNodes(scope, { metricKeys: [input.metricKey], limit: LIMIT });
        if (!found.ok) return found;
        const want = input.horizon ?? horizon;
        const bySubject = new Map<string, ValueNode>();
        for (const n of found.value) if (n.subjectEntityId && (!n.timeHorizon || n.timeHorizon === want)) bySubject.set(String(n.subjectEntityId), n);
        const next = new Map<string, ValueNode[]>();
        for (const [subject, node] of bySubject) {
          if (qualifying === null) next.set(subject, [node]);
          else if (qualifying.has(subject)) next.set(subject, [...qualifying.get(subject)!, node]);
        }
        qualifying = next;
        if (qualifying.size === 0) break;
      }
      if (!qualifying || qualifying.size === 0) continue;

      const outputs = await deps.valueGraph.findValueNodes(scope, { metricKeys: [calc.outputMetricKey], limit: LIMIT });
      if (!outputs.ok) return outputs;
      const has = new Set(outputs.value.filter((n) => n.subjectEntityId && (!n.timeHorizon || n.timeHorizon === horizon)).map((n) => String(n.subjectEntityId)));

      for (const [subject, inputs] of qualifying) {
        if (has.has(subject)) {
          if (pass === 0) existing += 1;
          continue;
        }
        const s = await subjectOf(subject as EntityId);
        if (!s.ok) return s;
        if (calc.scopeCompatibility !== null && s.value.category !== null && !calc.scopeCompatibility.includes(s.value.category)) continue;
        const label = `${calc.name} — ${s.value.name}`;
        const node = await deps.valueGraph.upsertValueNode(scope, {
          metricKey: calc.outputMetricKey,
          subjectEntityId: subject as EntityId,
          timeHorizon: horizon,
          label,
          metadata: { derivedPosition: ref(calc) },
          createdBy: scope.actorId,
        });
        if (!node.ok) return node;
        for (const input of inputs) {
          const link = await deps.valueGraph.createValueLink(scope, {
            linkType: 'DRIVES',
            sourceNodeId: input.id,
            targetNodeId: node.value.id,
            confidence: 1,
            sourceSystem: 'helm',
            metadata: { calculation: ref(calc) },
            createdBy: scope.actorId,
          });
          if (!link.ok) return fail(link.error.code, `The position ${label} was created, but its link from ${input.label} was not: ${link.error.message}`);
        }
        created.push({ nodeId: node.value.id, metricKey: calc.outputMetricKey, subjectEntityId: subject as EntityId, calculation: ref(calc), label });
        has.add(subject);
        added += 1;
      }
    }
    if (added === 0) break;
  }
  return ok({ created, existing, notSameSubject });
}
