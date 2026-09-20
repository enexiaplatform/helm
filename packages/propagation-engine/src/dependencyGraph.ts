/**
 * The calculation dependency graph — execution order and cycle rejection.
 *
 * This is the EXECUTABLE dependency graph, distinct from the value graph's
 * semantic one (§29–30). It is derived entirely from what calculations declare
 * as inputs and outputs, so it cannot drift from the code that runs.
 *
 * Pure: metric-level topology with no database access.
 */

import { fail, ok, type Result } from '@helm/shared';
import { CalculationErrors, calculationRef, type CalculationDefinition } from './types.ts';
import type { CalculationRegistry } from './registry.ts';

export type MetricDependencyGraph = {
  /** metric → metrics it directly depends on. */
  dependsOn: ReadonlyMap<string, readonly string[]>;
  /** metric → metrics that directly depend on it. */
  dependents: ReadonlyMap<string, readonly string[]>;
  /** Deterministic topological order of computed metrics. */
  order: readonly string[];
  /** Metrics with no calculation — the model's source facts. */
  roots: readonly string[];
};

/**
 * Builds the metric-level dependency graph and rejects cycles.
 *
 * Cycles are rejected outright, not solved iteratively (§8). A model that says
 * revenue depends on capacity which depends on revenue is not a hard problem to
 * solve — it is a statement that has no single answer, and HELM should say so
 * rather than silently converging on one.
 */
export function buildDependencyGraph(
  registry: CalculationRegistry,
): Result<MetricDependencyGraph> {
  const calculations = registry.active();

  const dependsOn = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  const computed = new Set<string>();
  const producedBy = new Map<string, CalculationDefinition>();

  for (const calc of calculations) {
    computed.add(calc.outputMetricKey);
    producedBy.set(calc.outputMetricKey, calc);
    const inputs = calc.inputs.map((i) => i.metricKey);
    const existing = dependsOn.get(calc.outputMetricKey) ?? [];
    // Sorted + deduped so the graph is identical on every build.
    dependsOn.set(
      calc.outputMetricKey,
      [...new Set([...existing, ...inputs])].sort(),
    );
    for (const input of inputs) {
      const list = dependents.get(input) ?? [];
      if (!list.includes(calc.outputMetricKey)) list.push(calc.outputMetricKey);
      dependents.set(input, list.sort());
    }
  }

  const cycle = findCycle(computed, dependsOn);
  if (cycle) {
    const chain = [...cycle, cycle[0]]
      .map((m) => {
        const c = producedBy.get(m);
        return c ? `${m} (${calculationRef(c)})` : m;
      })
      .join(' → ');
    return fail(
      CalculationErrors.CYCLE_DETECTED,
      `Circular calculation dependency: ${chain}. ` +
        'HELM rejects circular models rather than solving them iteratively — a value ' +
        'that depends on itself has no single answer, and guessing one would be worse ' +
        'than refusing.',
      { cycle },
    );
  }

  const order = topologicalOrder(computed, dependsOn);
  const roots = [...new Set([...dependsOn.values()].flat())]
    .filter((m) => !computed.has(m))
    .sort();

  return ok({ dependsOn, dependents, order, roots });
}

/**
 * Depth-first cycle detection. Returns the cycle members in order, or null.
 * Iterates in sorted order so the reported cycle is the same on every run.
 */
function findCycle(
  nodes: ReadonlySet<string>,
  dependsOn: ReadonlyMap<string, readonly string[]>,
): string[] | null {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    colour.set(node, GREY);
    stack.push(node);
    for (const dep of [...(dependsOn.get(node) ?? [])].sort()) {
      if (!nodes.has(dep)) continue; // a source fact, not a computed metric
      const c = colour.get(dep) ?? WHITE;
      if (c === GREY) {
        // Found a back edge: the cycle is the stack from `dep` onwards.
        return stack.slice(stack.indexOf(dep));
      }
      if (c === WHITE) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    colour.set(node, BLACK);
    return null;
  };

  for (const node of [...nodes].sort()) {
    if ((colour.get(node) ?? WHITE) === WHITE) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return null;
}

/** Kahn's algorithm with sorted tie-breaking, so ordering is deterministic. */
function topologicalOrder(
  nodes: ReadonlySet<string>,
  dependsOn: ReadonlyMap<string, readonly string[]>,
): string[] {
  const remaining = new Map<string, Set<string>>();
  for (const n of nodes) {
    remaining.set(n, new Set((dependsOn.get(n) ?? []).filter((d) => nodes.has(d))));
  }

  const out: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([n]) => n)
      .sort();
    if (ready.length === 0) break; // unreachable: cycles rejected earlier
    for (const n of ready) {
      out.push(n);
      remaining.delete(n);
    }
    for (const deps of remaining.values()) {
      for (const n of ready) deps.delete(n);
    }
  }
  return out;
}

/**
 * Metrics affected by a change to `changedMetric`, in execution order.
 *
 * This is what makes propagation incremental (§24): a change to opportunity
 * probability recalculates the revenue chain and leaves unrelated branches —
 * supplier risk, capacity utilization — untouched.
 */
export function downstreamOf(
  graph: MetricDependencyGraph,
  changedMetrics: readonly string[],
): readonly string[] {
  const affected = new Set<string>();
  const queue = [...changedMetrics];
  while (queue.length > 0) {
    const m = queue.shift()!;
    for (const dependent of graph.dependents.get(m) ?? []) {
      if (affected.has(dependent)) continue;
      affected.add(dependent);
      queue.push(dependent);
    }
  }
  // Preserve topological order so execution is valid.
  return graph.order.filter((m) => affected.has(m));
}

/** Renders the graph for the explorer and for verification output. */
export function describeGraph(graph: MetricDependencyGraph): string {
  const lines: string[] = [];
  for (const metric of graph.order) {
    const deps = graph.dependsOn.get(metric) ?? [];
    lines.push(`${metric} ← ${deps.length > 0 ? deps.join(', ') : '(no inputs)'}`);
  }
  return lines.join('\n');
}
