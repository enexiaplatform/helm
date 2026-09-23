/**
 * Read helpers for the Scenario Explorer. Wiring and selection only — every
 * number shown comes from the runtime (future states, comparisons,
 * explanations); nothing here computes a value or a delta.
 */

import type {
  FutureState,
  Scenario,
  ScenarioComparison,
  ScenarioRevision,
  ScenarioRun,
  ValidationReport,
} from '@helm/scenario-runtime';
import type { Period, Result } from '@helm/shared';
import type { UnitType } from '@helm/value-graph';
import { valueMetrics } from './ontologyGraph.ts';
import type { ScenarioWorkspace } from './scenarioRuntime.ts';

export type ScenarioSnapshot = {
  scenario: Scenario;
  revisions: readonly ScenarioRevision[];
  latestRevision: ScenarioRevision | null;
  latestRun: ScenarioRun | null;
  report: ValidationReport | null;
};

export type ExplorerData = {
  scenarios: readonly ScenarioSnapshot[];
  baselineRun: ScenarioRun | null;
  states: Readonly<Record<string, FutureState>>;
  /** Baseline against every scenario's latest simulation. */
  overview: ScenarioComparison | null;
  /** Value node id to its label, so an override names a position not a metric. */
  nodeLabels: Readonly<Record<string, string>>;
};

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

const completed = (r: ScenarioRun) => r.status !== 'RUNNING';

export async function loadExplorer(ws: ScenarioWorkspace): Promise<ExplorerData> {
  const { runtime, scope } = ws;
  const scenarios = unwrap(await runtime.listScenarios(scope));
  const runs = unwrap(await runtime.listRuns(scope));

  const snapshots: ScenarioSnapshot[] = [];
  for (const scenario of scenarios) {
    const revisions = unwrap(await runtime.listRevisions(scope, scenario.id));
    const latestRevision = revisions.length > 0 ? revisions[revisions.length - 1] : null;
    const mine = runs.filter((r) => r.scenarioId === scenario.id && completed(r));
    const latestRun = mine.length > 0 ? mine[mine.length - 1] : null;
    const report = latestRevision ? unwrap(await runtime.validate(scope, latestRevision.id)) : null;
    snapshots.push({ scenario, revisions, latestRevision, latestRun, report });
  }

  const baselines = runs.filter((r) => r.stateKind === 'BASELINE' && completed(r));
  const baselineRun =
    baselines.find((r) => r.id === ws.baselineRunId) ?? (baselines.length > 0 ? baselines[baselines.length - 1] : null);

  const states: Record<string, FutureState> = {};
  const wanted = [baselineRun, ...snapshots.map((s) => s.latestRun)].filter((r): r is ScenarioRun => r !== null);
  for (const run of wanted) states[run.id] = unwrap(await runtime.getFutureState(scope, run.id));

  const alternatives = snapshots.map((s) => s.latestRun?.id).filter((id): id is string => Boolean(id));
  const overview =
    baselineRun && alternatives.length > 0
      ? unwrap(await runtime.compare(scope, { baselineRunId: baselineRun.id, alternativeRunIds: alternatives }))
      : null;

  const nodeLabels: Record<string, string> = {};
  for (const n of unwrap(await ws.graphs.valueGraph.findValueNodes(scope, { limit: 500 }))) {
    nodeLabels[n.id] = n.label;
  }

  return { scenarios: snapshots, baselineRun, states, overview, nodeLabels };
}

export type OverridableNode = {
  id: string;
  label: string;
  metricKey: string;
  metricName: string;
  unitType: UnitType;
  defaultCurrency: string | null;
};

/**
 * Value nodes a scenario may override: every node the model does NOT compute.
 * Outcomes are derived; offering them here would invite a refusal.
 */
export async function listOverridableNodes(ws: ScenarioWorkspace, periods: readonly Period[]): Promise<OverridableNode[]> {
  const { graphs, scope, defaultFork } = ws;
  const computed = new Set<string>();
  for (const period of periods) {
    const plan = unwrap(
      await graphs.engine.planPropagation(scope, {
        effectiveAsOf: new Date(defaultFork.effectiveAsOf),
        period,
      }),
    );
    for (const n of plan.nodes) computed.add(n.outputNodeId);
  }
  const nodes = unwrap(await graphs.valueGraph.findValueNodes(scope, { limit: 500 }));
  return nodes
    .filter((n) => !computed.has(n.id))
    .map((n) => {
      const metric = valueMetrics.metric(n.metricKey);
      return {
        id: n.id,
        label: n.label,
        metricKey: n.metricKey,
        metricName: metric?.name ?? n.metricKey,
        unitType: metric?.unitType ?? 'units',
        defaultCurrency: metric?.defaultCurrency ?? (metric?.unitType === 'currency' ? 'VND' : null),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Children listed under their parent, roots first — the branch tree's order. */
export function branchOrder(snapshots: readonly ScenarioSnapshot[]): { snapshot: ScenarioSnapshot; depth: number }[] {
  const out: { snapshot: ScenarioSnapshot; depth: number }[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const s of snapshots.filter((x) => x.scenario.parentScenarioId === parentId)) {
      out.push({ snapshot: s, depth });
      visit(s.scenario.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}
