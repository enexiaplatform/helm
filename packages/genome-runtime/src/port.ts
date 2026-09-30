/**
 * The GenomeStore port and the ManagementGenome runtime interface (ADR-0028).
 *
 * The store keeps records only — episodes, their bound references, patterns,
 * pattern revisions, pattern links, lessons and lesson reviews — every one of
 * them append-only. Status is never stored: a pattern's status and a lesson's
 * review status are derived at a lens from the records known at that lens, so
 * "what did we know about this pattern in March?" is a query, not a copy. The
 * store stamps record time itself; a caller cannot back-date memory.
 *
 * No Postgres concept appears here.
 */

import type { Result, Scope } from '@helm/shared';
import type { OrgUnit } from '@helm/authority-runtime';
import type { CausalClaim, ClaimView } from '@helm/causal-runtime';
import type { TwinViewer } from '@helm/twin-runtime';
import type {
  Classification,
  EpisodeRef,
  EpisodeRefRole,
  FeatureName,
  GenomeLens,
  GenomeRef,
  GenomeScope,
  Lesson,
  LessonReview,
  LessonStatus,
  ManagementEpisode,
  ManagementPattern,
  PatternCharacteristic,
  PatternConditions,
  PatternEvidence,
  PatternRevision,
  PatternStance,
  PatternStatus,
  SituationFeatures,
} from './types.ts';
import type { PatternCoverage } from './policy.ts';

export type NewEpisode = Omit<ManagementEpisode, 'id' | 'orgId' | 'recordedAt'>;
export type NewEpisodeRef = Omit<EpisodeRef, 'id' | 'orgId' | 'recordedAt'>;
export type NewPattern = Omit<ManagementPattern, 'id' | 'orgId' | 'recordedAt'>;
export type NewPatternRevision = Omit<PatternRevision, 'id' | 'orgId' | 'patternId' | 'revision' | 'recordedAt'>;
export type NewPatternEvidence = Omit<PatternEvidence, 'id' | 'orgId' | 'recordedAt'>;
export type NewLesson = Omit<Lesson, 'id' | 'orgId' | 'recordedAt'>;
export type NewLessonReview = Omit<LessonReview, 'id' | 'orgId' | 'recordedAt'>;

export interface GenomeStore {
  insertEpisode(scope: Scope, input: NewEpisode): Promise<Result<ManagementEpisode>>;
  getEpisode(scope: Scope, id: string): Promise<Result<ManagementEpisode | null>>;
  listEpisodes(scope: Scope): Promise<Result<readonly ManagementEpisode[]>>;
  /** Write-once per (episode, role, referenced id). */
  insertEpisodeRef(scope: Scope, input: NewEpisodeRef): Promise<Result<EpisodeRef>>;
  listEpisodeRefs(scope: Scope, episodeId?: string): Promise<Result<readonly EpisodeRef[]>>;

  /** The pattern's identity and its revision 1, together or not at all. */
  insertPattern(scope: Scope, pattern: NewPattern, first: NewPatternRevision): Promise<Result<{ pattern: ManagementPattern; revision: PatternRevision }>>;
  /** Appends revision n+1. A retired pattern takes no further revision. */
  insertPatternRevision(scope: Scope, patternId: string, input: NewPatternRevision): Promise<Result<PatternRevision>>;
  getPattern(scope: Scope, id: string): Promise<Result<ManagementPattern | null>>;
  listPatterns(scope: Scope): Promise<Result<readonly ManagementPattern[]>>;
  listPatternRevisions(scope: Scope, patternId?: string): Promise<Result<readonly PatternRevision[]>>;
  /** One link per (pattern, episode). */
  insertPatternEvidence(scope: Scope, input: NewPatternEvidence): Promise<Result<PatternEvidence>>;
  listPatternEvidence(scope: Scope, patternId?: string): Promise<Result<readonly PatternEvidence[]>>;

  insertLesson(scope: Scope, input: NewLesson): Promise<Result<Lesson>>;
  listLessons(scope: Scope): Promise<Result<readonly Lesson[]>>;
  /** Append-only; an ENDORSEMENT by the lesson's own author is refused. */
  insertLessonReview(scope: Scope, input: NewLessonReview): Promise<Result<LessonReview>>;
  listLessonReviews(scope: Scope, lessonId?: string): Promise<Result<readonly LessonReview[]>>;
}

// ---------------------------------------------------------------- runtime inputs

export type OpenEpisodeInput = {
  decisionId: string;
  title: string;
  /** Where the episode happened: anchored on entities, never inferred. */
  scope: GenomeScope;
  /** A twin snapshot of the situation. Must have been known at the decision boundary — a later one is hindsight. */
  situationSnapshotId?: string | null;
  visibility?: 'ORG_WIDE' | 'RESTRICTED';
  grantedUnitIds?: readonly string[];
  authoredByLabel: string;
};

export type ProposePatternInput = {
  title: string;
  scope: GenomeScope;
  conditions?: PatternConditions;
  characteristic: PatternCharacteristic;
  statement: string;
  /** Required: what the pattern does NOT show. */
  limitations: string;
  visibility?: 'ORG_WIDE' | 'RESTRICTED';
  grantedUnitIds?: readonly string[];
  authoredByLabel: string;
};

export type RecordLessonInput = {
  claim: string;
  scope: GenomeScope;
  evidence: readonly GenomeRef[];
  visibility?: 'ORG_WIDE' | 'RESTRICTED';
  grantedUnitIds?: readonly string[];
  authoredByLabel: string;
};

// ---------------------------------------------------------------- runtime outputs

export type ProcessFact = { readonly label: string; readonly value: string; readonly ref: GenomeRef | null };

/** How management decided: what it had on the table. NEVER a quality judgement. */
export type EpisodeProcess = {
  readonly chosen: string | null;
  readonly rejected: readonly string[];
  readonly alternatives: { readonly total: number; readonly modelled: number; readonly unmodelled: number };
  readonly criteria: number;
  readonly assumptions: readonly { readonly id: string; readonly statement: string; readonly criticality: string; readonly owner: string | null; readonly confidence: number | null }[];
  readonly challenges: readonly { readonly id: string; readonly statement: string; readonly openAtCommitment: boolean; readonly status: string }[];
  readonly evidenceCount: number;
  readonly facts: readonly ProcessFact[];
};

/** What happened: expected against actual, as the reviews recorded it. NEVER a verdict on the decision. */
export type EpisodeOutcome = {
  readonly reviews: readonly {
    readonly id: string;
    readonly reviewedAt: string;
    readonly variances: readonly { readonly label: string; readonly metricKey: string | null; readonly expected: string | null; readonly actual: string | null; readonly variance: string | null }[];
    readonly assumptionResults: readonly { readonly assumptionId: string; readonly statement: string; readonly outcome: string; readonly note: string | null }[];
    readonly notes: string;
  }[];
  readonly expected: readonly { readonly label: string; readonly metricKey: string | null }[];
  readonly governance: { readonly state: string | null; readonly policyResult: string | null } | null;
};

export type EpisodeCausal = {
  /** Claims known at the decision boundary. Hindsight is not among them. */
  readonly atDecision: readonly ClaimView[];
  /** Claims recorded since — shown apart, never folded into what management believed then. */
  readonly since: readonly ClaimView[];
};

export type EpisodeView = {
  readonly episode: ManagementEpisode;
  readonly lens: GenomeLens;
  /** OPEN until an outcome review is known at the lens. Not a judgement. */
  readonly status: 'OPEN' | 'COMPLETED';
  readonly decisionTitle: string;
  readonly managementQuestion: string;
  readonly process: EpisodeProcess;
  readonly outcome: EpisodeOutcome;
  readonly causal: EpisodeCausal;
  readonly refs: readonly EpisodeRef[];
  readonly patterns: readonly { readonly patternId: string; readonly title: string; readonly stance: PatternStance }[];
  readonly statement: string;
};

export type FeatureAgreement = { readonly feature: FeatureName; readonly agrees: boolean; readonly target: readonly string[]; readonly other: readonly string[] };

export type SimilarEpisode = {
  readonly view: EpisodeView;
  readonly agreements: readonly FeatureAgreement[];
};

export type SimilarSituations = {
  readonly target: SituationFeatures;
  readonly required: readonly FeatureName[];
  /** Required features the target situation does not state: nothing can agree on them, and an empty result then says nothing about novelty. */
  readonly unstatedInTarget: readonly FeatureName[];
  /** Chronological, not ranked: an episode is in the list because it agrees on everything required. */
  readonly episodes: readonly SimilarEpisode[];
  readonly statement: string;
};

export type EpisodeClassification = {
  readonly classification: Classification;
  readonly reasons: readonly string[];
};

export type PatternView = {
  readonly pattern: ManagementPattern;
  readonly revision: PatternRevision;
  readonly lens: GenomeLens;
  readonly policy: string;
  readonly status: PatternStatus;
  /** True for one case or none. */
  readonly weak: boolean;
  readonly reasons: readonly string[];
  readonly supporting: readonly { readonly evidence: PatternEvidence; readonly episode: EpisodeView }[];
  readonly contradictory: readonly { readonly evidence: PatternEvidence; readonly episode: EpisodeView }[];
  readonly contextual: readonly { readonly evidence: PatternEvidence; readonly episode: EpisodeView }[];
  readonly coverage: PatternCoverage;
  /** Always present: what a recurrence of recorded episodes is not. */
  readonly caveat: string;
};

export type LessonView = {
  readonly lesson: Lesson;
  readonly status: LessonStatus;
  readonly reviews: readonly LessonReview[];
  readonly evidence: readonly { readonly ref: GenomeRef; readonly label: string }[];
};

export type ProjectedGenome = {
  readonly episodes: readonly EpisodeView[];
  readonly patterns: readonly PatternView[];
  readonly lessons: readonly LessonView[];
  readonly withheld: { readonly episodes: number; readonly patterns: number; readonly lessons: number };
  readonly statement: string;
};

export type GenomeVisibilityFacts = {
  /** Can this viewer see decision `id`? The runtime never guesses — the host says. */
  decisionVisible: (decisionId: string) => boolean;
};

export type { CausalClaim };

export interface ManagementGenome {
  /** Derives the features of a situation (of a decision, committed or not) without recording anything. */
  situationOf(scope: Scope, decisionId: string, opts?: { scope?: GenomeScope; situationSnapshotId?: string | null }): Promise<Result<SituationFeatures>>;

  openEpisode(scope: Scope, input: OpenEpisodeInput): Promise<Result<EpisodeView>>;
  bindRef(scope: Scope, episodeId: string, role: EpisodeRefRole, ref: GenomeRef, note?: string): Promise<Result<EpisodeView>>;
  getEpisode(scope: Scope, id: string, lens?: GenomeLens): Promise<Result<EpisodeView>>;
  listEpisodes(scope: Scope, lens?: GenomeLens): Promise<Result<readonly EpisodeView[]>>;
  /** "Have we seen a situation like this before?" — episodes agreeing on every required feature. */
  findSimilar(scope: Scope, input: { episodeId?: string; decisionId?: string; require: readonly FeatureName[]; lens?: GenomeLens }): Promise<Result<SimilarSituations>>;

  proposePattern(scope: Scope, input: ProposePatternInput): Promise<Result<PatternView>>;
  revisePattern(scope: Scope, patternId: string, input: { statement?: string; limitations?: string }): Promise<Result<PatternView>>;
  retirePattern(scope: Scope, patternId: string, reason: string): Promise<Result<PatternView>>;
  /** What HELM's own records say about an episode against a pattern. */
  classifyEpisode(scope: Scope, patternId: string, episodeId: string, lens?: GenomeLens): Promise<Result<EpisodeClassification>>;
  /** A person's link; refused unless it agrees with the classification. */
  linkEpisode(scope: Scope, patternId: string, episodeId: string, stance: PatternStance, rationale: string): Promise<Result<PatternView>>;
  getPattern(scope: Scope, id: string, lens?: GenomeLens): Promise<Result<PatternView>>;
  listPatterns(scope: Scope, lens?: GenomeLens): Promise<Result<readonly PatternView[]>>;

  recordLesson(scope: Scope, input: RecordLessonInput): Promise<Result<LessonView>>;
  reviewLesson(scope: Scope, lessonId: string, status: Exclude<LessonStatus, 'PROPOSED'>, note: string, reviewedByLabel: string): Promise<Result<LessonView>>;
  listLessons(scope: Scope, lens?: GenomeLens): Promise<Result<readonly LessonView[]>>;

  /** The genome AS IT STOOD at a lens, reconstructed from append-only records. */
  viewAt(scope: Scope, lens?: GenomeLens): Promise<Result<{ lens: GenomeLens; episodes: readonly EpisodeView[]; patterns: readonly PatternView[]; lessons: readonly LessonView[] }>>;
  projectForViewer(scope: Scope, viewer: TwinViewer, units: readonly OrgUnit[], facts: GenomeVisibilityFacts, lens?: GenomeLens): Promise<Result<ProjectedGenome>>;
}
