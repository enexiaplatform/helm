/**
 * Situation features (ADR-0028 §2): what kind of situation a decision was, as
 * the kernel's own records state it at the decision boundary.
 *
 * Explicit and checkable. No embeddings, no scores, and no person: nothing
 * here is about who decided. Similarity is "agrees on every feature you
 * required", and each feature's agreement is shown.
 */

import { fail, ok, type Result, type Scope } from '@helm/shared';
import type { GraphStore } from '@helm/graph-store';
import type { Decision, DecisionCommitment, DecisionStore } from '@helm/decision-runtime';
import type { ScenarioRuntime } from '@helm/scenario-runtime';
import type { AuthorityRuntime } from '@helm/authority-runtime';
import { applicabilityOf, type CausalGraph } from '@helm/causal-runtime';
import { classificationOf, readStructure, sensitivityOfMetric, type SensitivityClass, type StructureView, type TwinRuntime } from '@helm/twin-runtime';
import type { FeatureAgreement } from './port.ts';
import { GenomeErrors, featureNames, type FeatureName, type GenomeLens, type GenomeScope, type SituationFeatures } from './types.ts';

export type GenomeSources = {
  readonly graph: GraphStore;
  /** Read-only: the genome never writes a decision. */
  readonly decisions: DecisionStore;
  readonly scenarios: ScenarioRuntime;
  readonly authority: AuthorityRuntime;
  readonly twin: TwinRuntime;
  readonly causal: CausalGraph;
};

const ms = (t: string) => Date.parse(t);
const uniq = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

export const ENTERPRISE_LABEL = { kind: 'ENTERPRISE', label: 'Enterprise' } as const;

/** The decision boundary: the knowledge boundary management decided under. */
export function boundaryOf(decision: Decision, commitment: DecisionCommitment | null): GenomeLens {
  const T = commitment ? commitment.committedAt : decision.fork.recordedThrough;
  const E = ms(decision.fork.effectiveAsOf) < ms(T) ? decision.fork.effectiveAsOf : T;
  return { effectiveAsOf: E, recordedThrough: T };
}

export async function structureAt(sources: GenomeSources, scope: Scope, lens: GenomeLens): Promise<Result<StructureView>> {
  return readStructure(sources.graph, scope, lens, ENTERPRISE_LABEL);
}

/** The class of every value metric a commitment expects to move — an episode carries them all. */
export function classesOf(metricKeys: readonly string[]): SensitivityClass[] {
  const out = new Set<SensitivityClass>(['GENERAL_MANAGEMENT']);
  for (const m of metricKeys) out.add(sensitivityOfMetric(m));
  return [...out].sort();
}

export type DerivedSituation = {
  readonly features: SituationFeatures;
  readonly decision: Decision;
  readonly commitment: DecisionCommitment | null;
  readonly boundary: GenomeLens;
  readonly scope: GenomeScope;
};

/**
 * Derives the situation of a decision at its boundary. `situationSnapshotId`
 * (a twin snapshot) is how constraint kinds are known; it must itself have
 * been known at the boundary — a snapshot recorded after the decision is
 * hindsight, not the situation management faced.
 */
export async function deriveSituation(
  sources: GenomeSources,
  scope: Scope,
  decisionId: string,
  opts: { scope: GenomeScope; commitmentId?: string | null; situationSnapshotId?: string | null },
): Promise<Result<DerivedSituation>> {
  const decision = await sources.decisions.getDecision(scope, decisionId);
  if (!decision.ok) return decision;
  if (!decision.value) return fail(GenomeErrors.NOT_FOUND, 'No such decision in this organization.');
  const commitments = await sources.decisions.listCommitments(scope, decisionId);
  if (!commitments.ok) return commitments;
  const ordered = [...commitments.value].sort((a, b) => a.committedAt.localeCompare(b.committedAt));
  const commitment = opts.commitmentId ? ordered.find((c) => c.id === opts.commitmentId) ?? null : ordered[ordered.length - 1] ?? null;
  if (opts.commitmentId && !commitment) return fail(GenomeErrors.NOT_FOUND, 'That commitment does not belong to this decision.');
  const boundary = boundaryOf(decision.value, commitment);

  const view = await structureAt(sources, scope, boundary);
  if (!view.ok) return view;

  // ----- scope: anchored on entities that existed at the boundary
  const anchorIds: string[] = [];
  const placement = new Map<string, Set<string>>();
  if (opts.scope.kind === 'ANCHORED') {
    for (const a of opts.scope.anchors) {
      const e = view.value.entities.get(a.entityId);
      if (!e) return fail(GenomeErrors.INVALID, `${a.label} did not exist at the decision boundary (${boundary.recordedThrough}).`);
      anchorIds.push(e.id);
      for (const [dim, ids] of Object.entries(view.value.placement.get(e.id) ?? {})) {
        const set = placement.get(dim) ?? new Set<string>();
        for (const id of ids) set.add(id);
        placement.set(dim, set);
      }
    }
  }
  const placementOut = Object.fromEntries([...placement].map(([d, s]) => [d, [...s].sort()]));

  const values: Record<FeatureName, string[]> = {
    decisionType: [],
    triggerType: [decision.value.triggerType],
    reversibility: decision.value.reversibility === 'UNASSESSED' ? [] : [decision.value.reversibility],
    businessUnit: placementOut.BUSINESS_UNIT ?? [],
    country: placementOut.COUNTRY ?? [],
    constraintKind: [],
    expectedMetric: [],
    overrideMetric: [],
    customerClass: [],
  };
  const notStated = new Set<FeatureName>();
  if (decision.value.reversibility === 'UNASSESSED') notStated.add('reversibility');
  if (values.businessUnit.length === 0) notStated.add('businessUnit');
  if (values.country.length === 0) notStated.add('country');

  // ----- decision type: a classification the governance profile states
  const profile = await sources.authority.currentProfile(scope, decisionId);
  if (!profile.ok) return profile;
  if (profile.value?.decisionTypeKey) values.decisionType = [profile.value.decisionTypeKey];
  else notStated.add('decisionType');

  // ----- constraint kinds the situation faced: breached constraints of the situation snapshot
  if (opts.situationSnapshotId) {
    const snap = await sources.twin.getSnapshot(scope, opts.situationSnapshotId);
    if (!snap.ok) return snap;
    if (ms(snap.value.snapshot.spec.lens.recordedThrough) > ms(boundary.recordedThrough)) {
      return fail(
        GenomeErrors.HINDSIGHT_AS_SITUATION,
        `The snapshot was known only through ${snap.value.snapshot.spec.lens.recordedThrough}, after the decision boundary ${boundary.recordedThrough}: it is hindsight, not the situation management faced.`,
      );
    }
    values.constraintKind = uniq(
      snap.value.items.filter((i) => i.kind === 'CONSTRAINT' && i.state.status === 'BREACHED').map((i) => String(i.state.kind)),
    );
  } else {
    notStated.add('constraintKind');
  }

  // ----- what the commitment expects to move, and what its chosen future overrides
  if (commitment) {
    values.expectedMetric = uniq(commitment.expectedOutcomes.map((o) => o.metricKey).filter((k): k is string => !!k));
    const alts = await sources.decisions.listAlternatives(scope, commitment.revisionId);
    if (!alts.ok) return alts;
    const chosen = alts.value.find((a) => a.id === commitment.chosenAlternativeId);
    if (chosen?.scenarioRevisionId) {
      const overrides = await sources.scenarios.listOverrides(scope, chosen.scenarioRevisionId);
      if (!overrides.ok) return overrides;
      values.overrideMetric = uniq(overrides.value.map((o) => o.metricKey));
    }
  } else {
    notStated.add('expectedMetric');
    notStated.add('overrideMetric');
  }

  // ----- the account classification of customers the decision was about
  const classes: string[] = [];
  for (const id of anchorIds) {
    const e = view.value.entities.get(id);
    if (e?.entityTypeKey !== 'Customer') continue;
    const c = classificationOf(view.value, id);
    if (c) classes.push(c.classification);
  }
  values.customerClass = uniq(classes);

  return ok({
    features: { values, notStated: [...notStated].sort() as FeatureName[], placement: placementOut, anchorIds },
    decision: decision.value,
    commitment,
    boundary,
    scope: opts.scope,
  });
}

// ---------------------------------------------------------------- similarity

/**
 * Two situations agree on a feature when both STATE it and share a value. A
 * feature neither could state, or that is empty on either side, is not
 * agreement — absence of information is not similarity.
 */
export function agreements(target: SituationFeatures, other: SituationFeatures, require: readonly FeatureName[]): FeatureAgreement[] {
  return require.map((feature) => {
    const a = target.values[feature];
    const b = other.values[feature];
    const stated = !target.notStated.includes(feature) && !other.notStated.includes(feature);
    const agrees = stated && a.some((v) => b.includes(v));
    return { feature, agrees, target: a, other: b };
  });
}

export function checkFeatures(require: readonly string[]): Result<readonly FeatureName[]> {
  if (require.length === 0) return fail(GenomeErrors.INVALID, 'Similarity needs at least one feature that must agree; "similar to everything" is not a question.');
  for (const f of require) if (!(featureNames as readonly string[]).includes(f)) return fail(GenomeErrors.INVALID, `Unknown feature "${f}". Features: ${featureNames.join(', ')}.`);
  return ok(require as readonly FeatureName[]);
}

export { applicabilityOf };
