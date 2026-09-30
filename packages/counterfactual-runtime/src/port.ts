/**
 * The CounterfactualStore port and the CounterfactualRuntime interface
 * (ADR-0029).
 *
 * The store keeps records only — cases, worlds and reviews — every one of them
 * append-only. A case's status, a world's causal support and the comparison
 * itself are never stored: they are derived at a lens from the records known
 * at that lens, so "what did we conclude about this alternative in March?" is
 * a query, not a copy. The store stamps record time itself.
 *
 * No Postgres concept appears here.
 */

import type { Result, Scope } from '@helm/shared';
import type { OrgUnit } from '@helm/authority-runtime';
import type { SensitivityClass, TwinViewer } from '@helm/twin-runtime';
import type {
  CausalSupport,
  ComparedMetric,
  ComparisonCell,
  CounterfactualCase,
  CounterfactualIntervention,
  CounterfactualLens,
  CounterfactualReview,
  CounterfactualScope,
  CounterfactualWorld,
  HindsightInputSpec,
} from './types.ts';

export type NewCase = Omit<CounterfactualCase, 'id' | 'orgId' | 'recordedAt'>;
export type NewWorld = Omit<CounterfactualWorld, 'id' | 'orgId' | 'recordedAt'>;
export type NewReview = Omit<CounterfactualReview, 'id' | 'orgId' | 'recordedAt'>;

export interface CounterfactualStore {
  /** Write-once. One case per (commitment, intervention) is not enforced: two people may ask the same question. */
  insertCase(scope: Scope, input: NewCase): Promise<Result<CounterfactualCase>>;
  getCase(scope: Scope, id: string): Promise<Result<CounterfactualCase | null>>;
  listCases(scope: Scope, filter?: { decisionId?: string }): Promise<Result<readonly CounterfactualCase[]>>;

  /** Append-only: a later estimate is a new world. */
  insertWorld(scope: Scope, input: NewWorld): Promise<Result<CounterfactualWorld>>;
  listWorlds(scope: Scope, caseId?: string): Promise<Result<readonly CounterfactualWorld[]>>;

  /** Append-only; limitations are required. */
  insertReview(scope: Scope, input: NewReview): Promise<Result<CounterfactualReview>>;
  listReviews(scope: Scope, caseId?: string): Promise<Result<readonly CounterfactualReview[]>>;
}

// ---------------------------------------------------------------- runtime inputs

export type OpenCaseInput = {
  decisionId: string;
  /** Defaults to the decision's latest commitment. */
  commitmentId?: string | null;
  title: string;
  question: string;
  intervention: CounterfactualIntervention;
  /** A twin snapshot known at or before the decision boundary. Required: a counterfactual is anchored to the past. */
  anchorSnapshotId: string | null;
  scope: CounterfactualScope;
  /**
   * Classes the case's readers must ALSO be cleared for, beyond those of the metrics it compares — declared when
   * the intervention or a hindsight input moves a value of another class. A case never exposes a class its readers
   * lack: an estimate that would is refused.
   */
  carriesClasses?: readonly SensitivityClass[];
  visibility?: 'ORG_WIDE' | 'RESTRICTED';
  grantedUnitIds?: readonly string[];
  authoredByLabel: string;
};

export type EstimateInput =
  | { lens: 'AS_KNOWN_THEN'; byLabel: string }
  | { lens: 'WITH_HINDSIGHT'; byLabel: string; hindsight: readonly HindsightInputSpec[] };

export type RecordReviewInput = { statement: string; limitations: string; reviewedByLabel: string };

// ---------------------------------------------------------------- runtime outputs

/** A world with the causal support the Causal Graph gave it AT the world's own knowledge boundary. */
export type WorldView = {
  readonly world: CounterfactualWorld;
  readonly causal: CausalSupport;
};

export type CaseView = {
  readonly case: CounterfactualCase;
  readonly lens: CounterfactualLens;
  /** OPEN: no world known at the lens. ESTIMATED: a world, no review. REVIEWED: a person has recorded a reading. Not a judgement. */
  readonly status: 'OPEN' | 'ESTIMATED' | 'REVIEWED';
  readonly decisionTitle: string;
  readonly chosenLabel: string | null;
  readonly interventionLabel: string;
  /** The latest world of each lens known at the lens. Never blended. */
  readonly worlds: { readonly asKnownThen: WorldView | null; readonly withHindsight: WorldView | null };
  /** Every world known at the lens, in the order recorded — earlier estimates stay readable. */
  readonly history: readonly CounterfactualWorld[];
  readonly reviews: readonly CounterfactualReview[];
  readonly statement: string;
};

export type ComparedRow = {
  readonly metric: ComparedMetric;
  readonly expected: ComparisonCell;
  readonly actual: ComparisonCell;
  readonly alternativeThen: ComparisonCell;
  readonly alternativeWithHindsight: ComparisonCell;
  /** Ex ante with ex ante: the alternative as known then, minus what the commitment expected. Null unless both were read. */
  readonly alternativeThenMinusExpected: string | null;
  /** Ex post with ex post: the alternative with hindsight, minus what happened. Null unless both were read. */
  readonly alternativeWithHindsightMinusActual: string | null;
};

/**
 * The actual world beside the alternative worlds, LAYERED. There is no single
 * difference, no regret figure and no verdict; only two named differences, each
 * between layers of the same kind.
 */
export type CounterfactualComparison = {
  readonly case: CounterfactualCase;
  readonly lens: CounterfactualLens;
  readonly chosen: { readonly alternativeId: string | null; readonly label: string | null };
  readonly intervention: { readonly kind: CounterfactualIntervention['kind']; readonly label: string };
  readonly rows: readonly ComparedRow[];
  readonly worlds: { readonly asKnownThen: WorldView | null; readonly withHindsight: WorldView | null };
  /** True when the model that computed the two worlds differs; null unless both exist. */
  readonly modelChangedSinceThen: boolean | null;
  readonly fingerprint: string;
  readonly statement: string;
  readonly important: string;
};

export type ProjectedCounterfactuals = {
  readonly cases: readonly CaseView[];
  readonly withheld: number;
  readonly statement: string;
};

export type CounterfactualVisibilityFacts = {
  /** Can this viewer see decision `id`? The runtime never guesses — the host says. */
  decisionVisible: (decisionId: string) => boolean;
};

export interface CounterfactualRuntime {
  /** Asks the question. Anchored to the decision boundary; the intervention must differ from what was chosen. */
  openCase(scope: Scope, input: OpenCaseInput): Promise<Result<CaseView>>;
  /** Computes one world for one retrospective lens. Append-only. */
  estimate(scope: Scope, caseId: string, input: EstimateInput): Promise<Result<WorldView>>;
  /** Records a person's reading of the comparison as it stands, pinned to its fingerprint. */
  recordReview(scope: Scope, caseId: string, input: RecordReviewInput): Promise<Result<CaseView>>;

  getCase(scope: Scope, id: string, lens?: CounterfactualLens): Promise<Result<CaseView>>;
  listCases(scope: Scope, filter?: { decisionId?: string }, lens?: CounterfactualLens): Promise<Result<readonly CaseView[]>>;
  /** The four layers side by side, derived at a lens. */
  compare(scope: Scope, caseId: string, lens?: CounterfactualLens): Promise<Result<CounterfactualComparison>>;

  /** Cases as they stood at a lens, reconstructed from append-only records. */
  viewAt(scope: Scope, lens?: CounterfactualLens): Promise<Result<{ lens: CounterfactualLens; cases: readonly CaseView[] }>>;
  projectForViewer(scope: Scope, viewer: TwinViewer, units: readonly OrgUnit[], facts: CounterfactualVisibilityFacts, lens?: CounterfactualLens): Promise<Result<ProjectedCounterfactuals>>;
}
