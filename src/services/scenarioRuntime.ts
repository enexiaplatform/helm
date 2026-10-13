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
  decimal,
  periodContaining,
  periodKey,
  sumAll,
  systemClock,
  toString as decimalString,
  type Period,
  type QuantityUnit,
  type Scope,
} from '@helm/shared';
import { supabaseClient } from '../lib/supabaseClient.ts';
import { calculations, getCloudGraphs, getDemoGraphs, valueMetrics, type HelmGraphs } from './ontologyGraph.ts';

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
  /** Canonical scenario ids by key, so a decision can bind its alternatives. */
  scenarioIdsByKey: Readonly<Record<string, string>>;
};

let demoWorkspace: Promise<ScenarioWorkspace> | null = null;

/**
 * The Meridian constraints and state frame name the demonstration world's own subjects (opp-8821, SKU-X at the HCMC
 * warehouse). They are the demo's, never a real organization's: a cloud workspace checked them against Memoire data
 * and reported "opp-8821 is not in this organization's model" under "Can it be done?" (audit 2026-10-09).
 */
function buildRuntime(graphs: HelmGraphs, store: ScenarioStore, world: 'demo' | 'cloud'): ScenarioRuntime {
  return createScenarioRuntime({
    engine: graphs.engine,
    registry: calculations,
    valueGraph: graphs.valueGraph,
    graphStore: graphs.graphStore,
    store,
    clock: systemClock,
    constraints: world === 'demo' ? meridianConstraintsV1 : [],
    stateFrame: world === 'demo' ? meridianStateFrame : [],
  });
}

/** Demo: the scenario workspace of the ONE demonstration world (the twin's), with its canonical futures already simulated. */
function getDemoWorkspace(scope: Scope): Promise<ScenarioWorkspace> {
  if (demoWorkspace) return demoWorkspace;
  demoWorkspace = (async () => {
    const graphs = await getDemoGraphs();
    const { resolveTwinContext } = await import('./twinRuntime.ts');
    const twin = await resolveTwinContext('demo', scope);
    const k = twin?.kernel;
    if (!k?.demoWorld || !k.scenarioIds) throw new Error('the demonstration world is unavailable');
    const baselines = await k.scenarios.listRuns(scope);
    const latestBaseline = baselines.ok ? baselines.value.filter((r) => r.stateKind === 'BASELINE').at(-1) : undefined;
    return {
      runtime: k.scenarios,
      graphs,
      scope,
      mode: 'demo' as const,
      defaultFork: k.demoWorld.fork,
      periodChoices: [Q4_2026, Q1_2027],
      baselineRunId: latestBaseline?.id ?? null,
      scenarioIdsByKey: k.scenarioIds,
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
    runtime: buildRuntime(graphs, store, 'cloud'),
    graphs,
    scope,
    mode: 'cloud',
    defaultFork: { effectiveAsOf: now.toISOString(), recordedThrough: now.toISOString(), policy: 'SOURCE_TRUTH' },
    periodChoices: [current, next],
    baselineRunId: null,
    scenarioIdsByKey: {},
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

/**
 * The cloud branch summary. A real organization has many opportunities, not one Rohto deal, so "Revenue" is the
 * roll-up the metric itself declares — summed only where its aggregation is SUM and every position is in one currency;
 * anything else is said, not computed. Nothing is ranked: the same rows, in the same order, for every future.
 */
export const CLOUD_BRANCH_METRICS: readonly { label: string; metricKey: string; scopeNote?: string }[] = [
  { label: 'Expected revenue', metricKey: 'ExpectedRevenue' },
  // A future state holds only the positions the model computes from: an opportunity with a value and no probability is
  // in the pipeline (Cockpit, Reviews) but in no future. The row says so, so two pages never show two "pipelines" unexplained.
  {
    label: 'Modelled pipeline',
    metricKey: 'OpportunityValue',
    scopeNote: 'only opportunities that carry both a value and a probability are modelled — the whole pipeline, with those that carry no probability, is on the Cockpit and in Reviews',
  },
  { label: 'Gross margin', metricKey: 'GrossMargin' },
  { label: 'Cash', metricKey: 'CashImpact' },
  { label: 'Revenue at risk', metricKey: 'RevenueAtRisk' },
];

export type RollUp = {
  readonly value: string | null;
  readonly unit: QuantityUnit | null;
  readonly currency: string | null;
  /** Positions with a value, out of all positions of the metric in the period. */
  readonly counted: number;
  readonly positions: number;
  /** Why there is no total, or what it leaves out. */
  readonly note: string | null;
};

export function rollUp(state: FutureState, metricKey: string, period: Period): RollUp {
  const metric = valueMetrics.metric(metricKey);
  const all = state.values.filter((v) => v.metricKey === metricKey && periodKey(v.period) === periodKey(period));
  const none = (note: string): RollUp => ({ value: null, unit: null, currency: null, counted: 0, positions: all.length, note });
  if (all.length === 0) return none(`No position carries ${metric?.name ?? metricKey} in this state: the model computes it only for subjects that carry all of its inputs.`);
  if (!metric || metric.aggregation !== 'SUM') return none(`${metric?.name ?? metricKey} is ${metric ? metric.aggregation.toLowerCase().replaceAll('_', ' ') : 'undeclared'}; it is never summed across positions.`);
  const known = all.filter((v) => v.value !== null);
  const currencies = new Set(known.map((v) => v.currency));
  if (currencies.size > 1) return none(`The positions carry ${[...currencies].join(', ')}; HELM does not convert currencies.`);
  if (known.length === 0) return none(`None of the ${all.length} positions has a value in this state.`);
  return {
    value: decimalString(sumAll(known.map((v) => decimal(v.value!)))),
    unit: known[0]!.unit,
    currency: known[0]!.currency,
    counted: known.length,
    positions: all.length,
    note: known.length < all.length ? `${all.length - known.length} of ${all.length} positions have no value and are not in the total.` : null,
  };
}

/** A twin state's roll-up of one metric in one layer and period: what a review or the cockpit can say about the whole. */
export type StateRollUp = RollUp & { readonly metricKey: string; readonly metricName: string; readonly layer: string; readonly period: string | null };

/**
 * The same rule as `rollUp`, over the VALUE items of a twin state (as the reader may see them): a total only where the
 * metric declares SUM and every position carries one currency, one line per period, never across periods.
 */
export function rollUpItems(items: readonly { kind: string; layer: string | null; status: string; state: Record<string, unknown> }[], metricKey: string, layer: string): StateRollUp[] {
  const metric = valueMetrics.metric(metricKey);
  const name = metric?.name ?? metricKey;
  const mine = items.filter((i) => i.kind === 'VALUE' && i.layer === layer && i.state['metricKey'] === metricKey);
  const byPeriod = new Map<string | null, typeof mine>();
  for (const i of mine) {
    const p = (i.state['period'] as string | null | undefined) ?? null;
    byPeriod.set(p, [...(byPeriod.get(p) ?? []), i]);
  }
  return [...byPeriod.entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([period, all]) => {
      const base = { metricKey, metricName: name, layer, period };
      const none = (note: string): StateRollUp => ({ ...base, value: null, unit: null, currency: null, counted: 0, positions: all.length, note });
      if (!metric || metric.aggregation !== 'SUM') return none(`${name} is ${metric ? metric.aggregation.toLowerCase().replaceAll('_', ' ') : 'undeclared'}; it is never summed across positions.`);
      const known = all.filter((i) => i.status === 'KNOWN' && typeof i.state['value'] === 'string');
      const currencies = new Set(known.map((i) => (i.state['currency'] as string | null) ?? null));
      if (currencies.size > 1) return none(`The positions carry ${[...currencies].join(', ')}; HELM does not convert currencies.`);
      if (known.length === 0) return none(`None of the ${all.length} positions has a value in this state.`);
      return {
        ...base,
        value: decimalString(sumAll(known.map((i) => decimal(i.state['value'] as string)))),
        unit: (known[0]!.state['unit'] as QuantityUnit | null) ?? null,
        currency: (known[0]!.state['currency'] as string | null) ?? null,
        counted: known.length,
        positions: all.length,
        note: known.length < all.length ? `${all.length - known.length} of ${all.length} positions have no value and are not in the total.` : null,
      };
    });
}

// ---------------------------------------------------------- display helpers

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
// Two decimals for reading (audit 2026-10-13: "35.4731%", "10.909091 units"); the exact value stays one hover away.
const plain = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const minus = (x: string): string => x.replace(/^-/, '−');

/** For reading only: the exact value is always one hover away. */
export function displayValue(value: string | null, unit: QuantityUnit | null, currency: string | null): string {
  if (value === null) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  switch (unit) {
    case 'currency':
      return minus(`${compact.format(n)} ${currency ?? ''}`.trim());
    case 'percentage':
      return `${minus(plain.format(n))}%`;
    case 'days':
      return `${minus(plain.format(n))} d`;
    case 'units':
      return `${minus(plain.format(n))} u`;
    default:
      return minus(Math.abs(n) >= 1_000_000 ? compact.format(n) : plain.format(n));
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

/** The short form the console's clock strip uses: "19 Sep 2026, 12:00 UTC" — with its year, which the demo's story spans. */
export const displayClock = (iso: string): string =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) + ' UTC';
