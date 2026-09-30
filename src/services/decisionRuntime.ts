/**
 * The app's access to the Phase 5 Decision Runtime.
 *
 * Same shape as ontologyGraph.ts and scenarioRuntime.ts: this module wires
 * ports together and holds no domain logic. Demo mode runs entirely in memory
 * and seeds the canonical Rohto decision once per session — including its
 * management-authored commitment, which is seeded management input and not
 * something HELM produced. Cloud mode uses the Postgres decision store with
 * RLS doing the isolation.
 *
 * The display helpers at the bottom format EXACT decimal strings for reading
 * only. They never round a stored value and never compute one.
 */

import { createDecisionRuntime, type DecisionRuntime, type DecisionStore } from '@helm/decision-runtime';
import { createPostgresDecisionStore } from '@helm/decision-runtime/postgres';
import type { AuthorityRuntime, AuthorityStore } from '@helm/authority-runtime';
import { systemClock, type Scope } from '@helm/shared';
import type { ScenarioRuntime } from '@helm/scenario-runtime';
import { supabaseClient } from '../lib/supabaseClient.ts';
import { resolveScenarioWorkspace, type ScenarioWorkspace } from './scenarioRuntime.ts';

export type DecisionWorkspaceContext = {
  runtime: DecisionRuntime;
  /** The store behind the runtime — the authority runtime reads commitments and appends to the timeline through it. */
  store: DecisionStore;
  scenarios: ScenarioWorkspace;
  scope: Scope;
  mode: 'demo' | 'cloud';
  /** The decision the demo opens on, if the canonical one was seeded. */
  canonicalDecisionId: string | null;
  /**
   * Demo only: the authority runtime, with its structure (roles, occupancies,
   * DOA-2026-04) recorded BEFORE anything is committed — authority is never
   * granted retroactively, so a commitment made first would be INDETERMINATE.
   */
  demoAuthority: AuthorityRuntime | null;
  /** Demo only: the store behind it, which the in-process trusted service writes through. */
  demoAuthorityStore: AuthorityStore | null;
};

let demoContext: Promise<DecisionWorkspaceContext> | null = null;

function buildRuntime(scenarios: ScenarioRuntime, store: DecisionStore): DecisionRuntime {
  return createDecisionRuntime({ store, scenarios, clock: systemClock });
}

/** Demo: the decision workspace of the ONE demonstration world — the twin's decisions, governance and story, not a parallel copy. */
function getDemoContext(scope: Scope): Promise<DecisionWorkspaceContext> {
  if (demoContext) return demoContext;
  demoContext = (async () => {
    const scenarios = await resolveScenarioWorkspace('demo', scope);
    if (!scenarios) throw new Error('the demo scenario workspace is unavailable');
    const { resolveTwinContext } = await import('./twinRuntime.ts');
    const twin = await resolveTwinContext('demo', scope);
    if (!twin?.story) throw new Error('the demonstration world is unavailable');
    const k = twin.kernel;
    return {
      runtime: k.decisions,
      store: k.decisionStore,
      scenarios,
      scope,
      mode: 'demo' as const,
      canonicalDecisionId: twin.story.decisionId,
      demoAuthority: k.authority,
      demoAuthorityStore: k.authorityStore,
    };
  })();
  return demoContext;
}

/** Cloud: the organization's own decisions, persisted under RLS. */
async function getCloudContext(scope: Scope): Promise<DecisionWorkspaceContext | null> {
  const scenarios = await resolveScenarioWorkspace('cloud', scope);
  if (!scenarios || !supabaseClient) return null;
  const store = createPostgresDecisionStore({ client: supabaseClient, clock: systemClock });
  return {
    runtime: buildRuntime(scenarios.runtime, store),
    store,
    scenarios,
    scope,
    mode: 'cloud',
    canonicalDecisionId: null,
    demoAuthority: null,
    demoAuthorityStore: null,
  };
}

export async function resolveDecisionContext(
  mode: 'demo' | 'cloud',
  scope: Scope,
): Promise<DecisionWorkspaceContext | null> {
  return mode === 'demo' ? getDemoContext(scope) : getCloudContext(scope);
}

// ---------------------------------------------------------- display helpers

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const plain = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });

/** For reading only: the exact value is always one hover away. */
export function displayValue(value: string | null, unit: string | null, currency: string | null): string {
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

export const displayConfidence = (c: number | null): string => (c === null ? '—' : c.toFixed(2));

export const displayInstant = (iso: string | null): string =>
  iso === null
    ? '—'
    : new Date(iso).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC',
      }) + ' UTC';

export const displayDate = (d: string | null): string =>
  d === null ? '—' : new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Sentence case for an enum, for reading: MEETS_TARGET → "meets target". */
export const readable = (v: string | null | undefined): string =>
  v === null || v === undefined ? '—' : v.replaceAll('_', ' ').toLowerCase();
