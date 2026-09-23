/**
 * The app's access to the Phase 4 Scenario Runtime.
 *
 * Same shape as ontologyGraph.ts: this module wires ports together and holds
 * no domain logic. Demo mode runs entirely in memory — the canonical scenarios
 * are built and simulated once per session, and nothing reaches the shared
 * database. Cloud mode uses the Postgres scenario store with RLS doing the
 * isolation.
 *
 * The display helpers at the bottom format EXACT decimal strings for reading
 * only. They never round a stored value and never compute one.
 */

import {
  buildMeridianScenarios,
  createInMemoryScenarioStore,
  createScenarioRuntime,
  meridianConstraintsV1,
  meridianStateFrame,
  Q1_2027,
  Q4_2026,
  type ForkPoint,
  type FutureState,
  type FutureStateValue,
  type ScenarioRuntime,
  type ScenarioStore,
} from '@helm/scenario-runtime';
import { createPostgresScenarioStore } from '@helm/scenario-runtime/postgres';
import {
  periodContaining,
  periodKey,
  systemClock,
  uuidIdGen,
  type Period,
  type QuantityUnit,
  type Scope,
} from '@helm/shared';
import { supabaseClient } from '../lib/supabaseClient.ts';
import { calculations, getCloudGraphs, getDemoGraphs, type HelmGraphs } from './ontologyGraph.ts';

export type ScenarioWorkspace = {
  runtime: ScenarioRuntime;
  graphs: HelmGraphs;
  scope: Scope;
  mode: 'demo' | 'cloud';
  /** The boundary new scenarios fork from unless the user says otherwise. */
  defaultFork: ForkPoint;
  /** Periods a new scenario may simulate. */
  periodChoices: readonly Period[];
  /** The baseline simulation opened with the explorer, if one exists. */
  baselineRunId: string | null;
};

/**
 * The business instant the canonical Meridian data describes. The demo forks
 * here so its numbers are the ones the docs and tests state.
 */
const CANONICAL_EFFECTIVE = '2026-09-19T12:00:00.000Z';

let demoWorkspace: Promise<ScenarioWorkspace> | null = null;

function buildRuntime(graphs: HelmGraphs, store: ScenarioStore): ScenarioRuntime {
  return createScenarioRuntime({
    engine: graphs.engine,
    registry: calculations,
    valueGraph: graphs.valueGraph,
    graphStore: graphs.graphStore,
    store,
    clock: systemClock,
    constraints: meridianConstraintsV1,
    stateFrame: meridianStateFrame,
  });
}

/** Demo: canonical scenarios built and simulated once, in memory. */
function getDemoWorkspace(scope: Scope): Promise<ScenarioWorkspace> {
  if (demoWorkspace) return demoWorkspace;
  demoWorkspace = (async () => {
    const graphs = await getDemoGraphs();
    const runtime = buildRuntime(graphs, createInMemoryScenarioStore({ clock: systemClock, idGen: uuidIdGen }));
    const fork: ForkPoint = {
      effectiveAsOf: CANONICAL_EFFECTIVE,
      recordedThrough: systemClock.now().toISOString(),
      policy: 'SOURCE_TRUTH',
    };
    const built = await buildMeridianScenarios(runtime, scope, graphs.nodeHandles ?? {}, { fork });
    if (!built.ok) throw new Error(`canonical scenarios failed: ${built.error.message}`);
    const baseline = await runtime.executeBaseline(scope, { fork, periods: [Q4_2026], notes: 'demo baseline' });
    if (!baseline.ok) throw new Error(`baseline failed: ${baseline.error.message}`);
    for (const { scenario } of Object.values(built.value)) {
      const run = await runtime.execute(scope, scenario.id);
      if (!run.ok) throw new Error(`scenario ${scenario.key} failed: ${run.error.message}`);
    }
    return {
      runtime,
      graphs,
      scope,
      mode: 'demo' as const,
      defaultFork: fork,
      periodChoices: [Q4_2026, Q1_2027],
      baselineRunId: baseline.value.run.id,
    };
  })();
  return demoWorkspace;
}

/** Cloud: the organization's own scenarios, persisted under RLS. */
function getCloudWorkspace(scope: Scope): ScenarioWorkspace | null {
  const graphs = getCloudGraphs();
  if (!graphs || !supabaseClient) return null;
  const store = createPostgresScenarioStore({ client: supabaseClient, clock: systemClock });
  const now = systemClock.now();
  const current = periodContaining(now, 'QUARTER');
  const next = periodContaining(current.end, 'QUARTER');
  return {
    runtime: buildRuntime(graphs, store),
    graphs,
    scope,
    mode: 'cloud',
    defaultFork: { effectiveAsOf: now.toISOString(), recordedThrough: now.toISOString(), policy: 'SOURCE_TRUTH' },
    periodChoices: [current, next],
    baselineRunId: null,
  };
}

export async function resolveScenarioWorkspace(
  mode: 'demo' | 'cloud',
  scope: Scope,
): Promise<ScenarioWorkspace | null> {
  return mode === 'demo' ? getDemoWorkspace(scope) : getCloudWorkspace(scope);
}

// ------------------------------------------------------- the branch summary

/**
 * The few value positions the branch view shows per state. Chosen by metric,
 * and — where a metric sits on several subjects — by the subject a reader
 * means (the Rohto deal rather than the tender). Nothing here judges them.
 */
export const BRANCH_METRICS: readonly { label: string; metricKey: string; subjectHint?: string }[] = [
  { label: 'Revenue', metricKey: 'ExpectedRevenue', subjectHint: 'Rohto' },
  { label: 'Margin', metricKey: 'GrossMarginPct', subjectHint: 'Rohto' },
  { label: 'Cash', metricKey: 'CashImpact', subjectHint: 'Rohto' },
  { label: 'Service', metricKey: 'DemandCoverage' },
  { label: 'Risk', metricKey: 'RevenueAtRisk', subjectHint: 'Rohto' },
];

export function pickValue(
  state: FutureState,
  metricKey: string,
  period: Period,
  subjectHint?: string,
): FutureStateValue | undefined {
  const inPeriod = state.values.filter(
    (v) => v.metricKey === metricKey && periodKey(v.period) === periodKey(period),
  );
  return (subjectHint ? inPeriod.find((v) => v.nodeLabel.includes(subjectHint)) : undefined) ?? inPeriod[0];
}

// ---------------------------------------------------------- display helpers

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const plain = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });

/** For reading only: the exact value is always one hover away. */
export function displayValue(value: string | null, unit: QuantityUnit | null, currency: string | null): string {
  if (value === null) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  switch (unit) {
    case 'currency':
      return `${compact.format(n)} ${currency ?? ''}`.trim();
    case 'percentage':
      return `${plain.format(n)}%`;
    case 'days':
      return `${plain.format(n)} d`;
    case 'units':
      return `${plain.format(n)} u`;
    default:
      return plain.format(n);
  }
}

/** A signed delta; a percentage moves in points. */
export function displayDelta(delta: string | null, unit: QuantityUnit | null, currency: string | null): string {
  if (delta === null) return '—';
  const n = Number(delta);
  const sign = n > 0 ? '+' : n < 0 ? '−' : '±';
  const magnitude = Math.abs(n).toString();
  if (unit === 'percentage') return `${sign}${plain.format(Number(magnitude))} pts`;
  return `${sign}${displayValue(magnitude, unit, currency)}`;
}

export const displayConfidence = (c: number | null): string => (c === null ? '—' : c.toFixed(2));

export const displayInstant = (iso: string): string =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) + ' UTC';
