/**
 * The ManagementGenome runtime (ADR-0028).
 *
 * Every read takes a lens. What comes back is reconstructed from the records
 * KNOWN at its knowledge boundary: an episode opened later does not exist
 * earlier, a pattern link made later does not count earlier, a lesson review
 * counts only from the moment it was recorded. Nothing is copied from the
 * kernel — an episode is references plus a view composed on demand — and
 * nothing is ever written below: the genome reads the decision, authority,
 * scenario, twin and causal layers and changes none of them.
 *
 * What this runtime never does:
 *   - link an episode to a pattern on its own initiative;
 *   - record support the episode's own records contradict;
 *   - score a decision, combine process and outcome, or rate a person;
 *   - treat a snapshot recorded after the decision as the situation;
 *   - change a policy, calculation, causal claim or authority rule because a
 *     pattern or lesson exists.
 */

import { fail, ok, type Clock, type Result, type Scope } from '@helm/shared';
import type { Decision, DecisionAlternative, DecisionAssumption, DecisionChallenge, DecisionCommitment, DecisionCriterion, DecisionEvidence, DecisionOutcomeReview } from '@helm/decision-runtime';
import { canSeeDecision, type OrgUnit } from '@helm/authority-runtime';
import { applicabilityOf as causalApplicability, claimsReferencing, type ClaimView } from '@helm/causal-runtime';
import { isCleared, type StructureView, type TwinViewer } from '@helm/twin-runtime';
import {
  GENOME_PATTERN_POLICY,
  conditionsHold,
  decidePattern,
  observeCharacteristic,
  stanceAgrees,
  type LinkedEpisode,
  type ObservableFacts,
} from './policy.ts';
import { agreements, boundaryOf, checkFeatures, classesOf, deriveSituation, structureAt, type GenomeSources } from './situation.ts';
import type {
  EpisodeClassification,
  EpisodeCausal,
  EpisodeOutcome,
  EpisodeProcess,
  EpisodeView,
  GenomeStore,
  GenomeVisibilityFacts,
  LessonView,
  ManagementGenome,
  OpenEpisodeInput,
  PatternView,
  ProcessFact,
  ProjectedGenome,
  ProposePatternInput,
  RecordLessonInput,
  SimilarEpisode,
} from './port.ts';
import {
  GenomeErrors,
  conditionFeatures,
  episodeRefRoles,
  outcomeDirections,
  processFeatures,
  assumptionCriticalities,
  assumptionOutcomeKinds,
  patternStances,
  type EpisodeRef,
  type EpisodeRefRole,
  type FeatureName,
  type GenomeLens,
  type GenomeRef,
  type GenomeScope,
  type Lesson,
  type LessonReview,
  type LessonStatus,
  type ManagementEpisode,
  type ManagementPattern,
  type PatternCharacteristic,
  type PatternConditions,
  type PatternEvidence,
  type PatternRevision,
} from './types.ts';

export type ManagementGenomeOptions = { store: GenomeStore; sources: GenomeSources; clock: Clock };

type Records = {
  episodes: readonly ManagementEpisode[];
  refs: readonly EpisodeRef[];
  patterns: readonly ManagementPattern[];
  revisions: readonly PatternRevision[];
  evidence: readonly PatternEvidence[];
  lessons: readonly Lesson[];
  reviews: readonly LessonReview[];
};

const ms = (t: string) => Date.parse(t);
const known = <T extends { recordedAt: string }>(xs: readonly T[], T: number): T[] => xs.filter((x) => ms(x.recordedAt) <= T);
const invalid = (msg: string) => fail(GenomeErrors.INVALID, msg);
const CAVEAT =
  'A recurrence of recorded episodes: what happened in the situations this organization recorded and linked — not a law, and not what will happen. ' +
  'The genome remembers the enterprise\'s decisions; it does not judge them or the people who made them.';

type Facts = {
  decision: Decision;
  commitment: DecisionCommitment | null;
  alternatives: readonly DecisionAlternative[];
  criteria: readonly DecisionCriterion[];
  assumptions: readonly DecisionAssumption[];
  challenges: readonly DecisionChallenge[];
  evidence: readonly DecisionEvidence[];
  reviews: readonly DecisionOutcomeReview[];
};

export function createManagementGenome(opts: ManagementGenomeOptions): ManagementGenome {
  const { store, sources, clock } = opts;

  const currentLens = (): GenomeLens => {
    const n = clock.now().toISOString();
    return { effectiveAsOf: n, recordedThrough: n };
  };
  const checkLens = (lens: GenomeLens | undefined): Result<GenomeLens> => {
    const l = lens ?? currentLens();
    if (Number.isNaN(ms(l.effectiveAsOf)) || Number.isNaN(ms(l.recordedThrough))) return invalid('A lens states effectiveAsOf and recordedThrough as instants.');
    if (ms(l.recordedThrough) > clock.now().getTime()) return fail(GenomeErrors.KNOWLEDGE_IN_FUTURE, 'The genome cannot know what has not been recorded yet: recordedThrough is in the future.');
    return ok(l);
  };

  async function load(scope: Scope): Promise<Result<Records>> {
    const [episodes, refs, patterns, revisions, evidence, lessons, reviews] = await Promise.all([
      store.listEpisodes(scope),
      store.listEpisodeRefs(scope),
      store.listPatterns(scope),
      store.listPatternRevisions(scope),
      store.listPatternEvidence(scope),
      store.listLessons(scope),
      store.listLessonReviews(scope),
    ]);
    for (const x of [episodes, refs, patterns, revisions, evidence, lessons, reviews]) if (!x.ok) return x;
    return ok({
      episodes: episodes.ok ? episodes.value : [],
      refs: refs.ok ? refs.value : [],
      patterns: patterns.ok ? patterns.value : [],
      revisions: revisions.ok ? revisions.value : [],
      evidence: evidence.ok ? evidence.value : [],
      lessons: lessons.ok ? lessons.value : [],
      reviews: reviews.ok ? reviews.value : [],
    });
  }

  /** Per-call cache of the structure at an episode's boundary (a past boundary is stable). */
  const structureCache = () => {
    const m = new Map<string, StructureView>();
    return async (scope: Scope, lens: GenomeLens): Promise<Result<StructureView>> => {
      const key = `${lens.effectiveAsOf}|${lens.recordedThrough}`;
      const hit = m.get(key);
      if (hit) return ok(hit);
      const v = await structureAt(sources, scope, lens);
      if (v.ok) m.set(key, v.value);
      return v;
    };
  };

  async function readFacts(scope: Scope, episode: ManagementEpisode, lens: GenomeLens): Promise<Result<Facts>> {
    const decision = await sources.decisions.getDecision(scope, episode.decisionId);
    if (!decision.ok) return decision;
    if (!decision.value) return fail(GenomeErrors.NOT_FOUND, 'The decision this episode wraps is not visible.');
    const commitment = episode.commitmentId ? await sources.decisions.getCommitment(scope, episode.commitmentId) : ok(null);
    if (!commitment.ok) return commitment;
    const reviews = await sources.decisions.listOutcomeReviews(scope, episode.decisionId);
    if (!reviews.ok) return reviews;
    const T = ms(lens.recordedThrough);
    const known_ = reviews.value.filter((r) => (commitment.value ? r.commitmentId === commitment.value.id : true) && ms(r.reviewedAt) <= T);
    if (!commitment.value) {
      return ok({ decision: decision.value, commitment: null, alternatives: [], criteria: [], assumptions: [], challenges: [], evidence: [], reviews: known_ });
    }
    const rev = commitment.value.revisionId;
    const [alternatives, criteria, assumptions, challenges, evidence] = await Promise.all([
      sources.decisions.listAlternatives(scope, rev),
      sources.decisions.listCriteria(scope, rev),
      sources.decisions.listAssumptions(scope, rev),
      sources.decisions.listChallenges(scope, rev),
      sources.decisions.listEvidence(scope, rev),
    ]);
    for (const x of [alternatives, criteria, assumptions, challenges, evidence]) if (!x.ok) return x;
    return ok({
      decision: decision.value,
      commitment: commitment.value,
      alternatives: alternatives.ok ? alternatives.value : [],
      criteria: criteria.ok ? criteria.value : [],
      assumptions: assumptions.ok ? assumptions.value : [],
      challenges: challenges.ok ? challenges.value : [],
      evidence: evidence.ok ? evidence.value : [],
      reviews: known_,
    });
  }

  const observable = (f: Facts): ObservableFacts => ({
    committedAt: f.commitment?.committedAt ?? f.decision.createdAt,
    assumptions: f.assumptions,
    challenges: f.challenges,
    alternatives: f.alternatives,
    reviews: f.reviews,
  });

  function processOf(f: Facts): EpisodeProcess {
    const chosen = f.commitment ? f.alternatives.find((a) => a.id === f.commitment!.chosenAlternativeId) ?? null : null;
    const rejected = f.alternatives.filter((a) => a.id !== chosen?.id && a.status !== 'WITHDRAWN').map((a) => a.label);
    const committedAt = f.commitment?.committedAt ?? f.decision.createdAt;
    const challenges = f.challenges.map((c) => ({
      id: c.id,
      statement: c.concern,
      status: c.status,
      openAtCommitment: c.resolvedAt === null || c.resolvedAt > committedAt,
    }));
    const modelled = f.alternatives.filter((a) => a.status === 'MODELLED').length;
    const unmodelled = f.alternatives.filter((a) => a.status === 'UNMODELLED').length;
    const facts: ProcessFact[] = [
      { label: 'Question', value: f.decision.managementQuestion, ref: { kind: 'DECISION', id: f.decision.id, pin: null, label: f.decision.title } },
      { label: 'Alternatives considered', value: `${f.alternatives.length} (${modelled} with a simulated future, ${unmodelled} without)`, ref: null },
      { label: 'Criteria stated', value: String(f.criteria.length), ref: null },
      { label: 'Critical assumptions without an owner', value: String(f.assumptions.filter((a) => a.criticality === 'CRITICAL' && a.owner === null).length), ref: null },
      { label: 'Challenges open at commitment', value: String(challenges.filter((c) => c.openAtCommitment).length), ref: null },
      { label: 'Evidence items on the table', value: String(f.evidence.length), ref: null },
    ];
    return {
      chosen: chosen?.label ?? null,
      rejected,
      alternatives: { total: f.alternatives.length, modelled, unmodelled },
      criteria: f.criteria.length,
      assumptions: f.assumptions.map((a) => ({ id: a.id, statement: a.statement, criticality: a.criticality, owner: a.owner?.label ?? null, confidence: a.confidence ?? null })),
      challenges,
      evidenceCount: f.evidence.length,
      facts,
    };
  }

  async function outcomeOf(scope: Scope, f: Facts, lens: GenomeLens): Promise<Result<EpisodeOutcome>> {
    const statements = new Map(f.assumptions.map((a) => [a.id, a.statement]));
    let governance: EpisodeOutcome['governance'] = null;
    // Governance state is a projection of acts as they stand; a historical lens does not reconstruct it here (the twin snapshot does).
    if (f.commitment && ms(lens.recordedThrough) >= clock.now().getTime() - 1000) {
      const g = await sources.authority.getGovernanceState(scope, f.commitment.id);
      if (g.ok) governance = { state: g.value.state, policyResult: g.value.policyResult ?? null };
    }
    return ok({
      reviews: f.reviews.map((r) => ({
        id: r.id,
        reviewedAt: r.reviewedAt,
        variances: r.variances.map((v) => ({ label: v.label, metricKey: v.metricKey, expected: v.expected, actual: v.actual, variance: v.variance })),
        assumptionResults: r.assumptionResults.map((a) => ({ assumptionId: a.assumptionId, statement: statements.get(a.assumptionId) ?? a.statement, outcome: a.outcome, note: a.note })),
        notes: r.notes,
      })),
      expected: (f.commitment?.expectedOutcomes ?? []).map((o) => ({ label: o.label, metricKey: o.metricKey ?? null })),
      governance,
    });
  }

  async function causalOf(scope: Scope, episode: ManagementEpisode, refs: readonly EpisodeRef[], lens: GenomeLens): Promise<Result<EpisodeCausal>> {
    const bound = new Set(refs.filter((r) => r.role === 'CAUSAL_CONTEXT').map((r) => r.ref.id));
    const all = await sources.causal.listClaims(scope, { lens });
    if (!all.ok) return all;
    const about = await claimsReferencing(sources.causal, scope, { kind: 'DECISION', id: episode.decisionId }, lens);
    if (!about.ok) return about;
    const relevant = new Map<string, ClaimView>();
    for (const v of all.value) if (bound.has(v.claim.id)) relevant.set(v.claim.id, v);
    for (const v of about.value) relevant.set(v.claim.id, v);
    const atDecision: ClaimView[] = [];
    const since: ClaimView[] = [];
    for (const v of [...relevant.values()].sort((a, b) => a.claim.recordedAt.localeCompare(b.claim.recordedAt))) {
      if (ms(v.claim.recordedAt) <= ms(episode.boundary.recordedThrough)) {
        // Read it as management could read it THEN.
        const then = await sources.causal.getClaim(scope, v.claim.id, episode.boundary);
        atDecision.push(then.ok ? then.value : v);
      } else {
        since.push(v);
      }
    }
    return ok({ atDecision, since });
  }

  async function episodeView(scope: Scope, episode: ManagementEpisode, rec: Records, lens: GenomeLens): Promise<Result<EpisodeView>> {
    const T = ms(lens.recordedThrough);
    if (ms(episode.recordedAt) > T) {
      return fail(GenomeErrors.NOT_KNOWN_AT_LENS, `This episode was first recorded on ${episode.recordedAt}, after the knowledge boundary ${lens.recordedThrough}.`);
    }
    const facts = await readFacts(scope, episode, lens);
    if (!facts.ok) return facts;
    const outcome = await outcomeOf(scope, facts.value, lens);
    if (!outcome.ok) return outcome;
    const refs = known(rec.refs, T).filter((r) => r.episodeId === episode.id);
    const causal = await causalOf(scope, episode, refs, lens);
    if (!causal.ok) return causal;
    const patternLinks = known(rec.evidence, T)
      .filter((e) => e.episodeId === episode.id)
      .flatMap((e) => {
        const p = rec.patterns.find((x) => x.id === e.patternId);
        return p ? [{ patternId: p.id, title: p.title, stance: e.stance }] : [];
      });
    const status = facts.value.reviews.length > 0 ? 'COMPLETED' : 'OPEN';
    return ok({
      episode,
      lens,
      status,
      decisionTitle: facts.value.decision.title,
      managementQuestion: facts.value.decision.managementQuestion,
      process: processOf(facts.value),
      outcome: outcome.value,
      causal: causal.value,
      refs,
      patterns: patternLinks,
      statement:
        `${episode.title}: ${status}. How management decided and what happened are shown apart; ` +
        'neither judges the other (Decision Process Quality ≠ Outcome Quality).',
    });
  }

  async function scopeCheck(scope: Scope, s: GenomeScope): Promise<Result<GenomeScope>> {
    if (s.kind === 'ENTERPRISE_WIDE') {
      if (!s.justification || s.justification.trim().length < 12) return invalid('An enterprise-wide scope must say why it holds everywhere.');
      return ok(s);
    }
    if (!Array.isArray(s.anchors) || s.anchors.length === 0) return invalid('A scope names where it holds: anchor it on entities. Nothing is global by default.');
    const anchors = [];
    for (const a of s.anchors) {
      const e = await sources.graph.getEntity(scope, a.entityId as never);
      if (!e.ok) return e;
      if (!e.value) return invalid(`The scope names ${a.label}, which is not an entity of this organization.`);
      anchors.push({ entityId: e.value.id, label: a.label || e.value.name, dimension: a.dimension });
    }
    return ok({ kind: 'ANCHORED', anchors });
  }

  // ------------------------------------------------------------------ patterns

  async function classify(scope: Scope, pattern: ManagementPattern, episode: ManagementEpisode, lens: GenomeLens, structure: (scope: Scope, l: GenomeLens) => Promise<Result<StructureView>>): Promise<Result<EpisodeClassification>> {
    const reasons: string[] = [];
    const view = await structure(scope, episode.boundary);
    if (!view.ok) return view;
    const applic = causalApplicability(view.value, pattern.scope, episode.situation.anchorIds);
    if (applic.verdict !== 'APPLIES') {
      return ok({ classification: 'OUT_OF_SCOPE', reasons: [`Scope: ${applic.reason}`] });
    }
    const cond = conditionsHold(pattern.conditions, episode.situation);
    if (!cond.holds) return ok({ classification: 'OUT_OF_SCOPE', reasons: cond.failed.map((f) => `Condition: ${f}`) });
    if (!episode.commitmentId) return ok({ classification: 'NOT_OBSERVABLE', reasons: ['The episode has no commitment, so there is no committed expectation to observe against.'] });
    const facts = await readFacts(scope, episode, lens);
    if (!facts.ok) return facts;
    const seen = observeCharacteristic(pattern.characteristic, observable(facts.value));
    reasons.push(seen.detail);
    return ok({ classification: seen.result === 'EXHIBITS' ? 'SUPPORTS' : seen.result === 'DOES_NOT_EXHIBIT' ? 'CONTRADICTS' : 'NOT_OBSERVABLE', reasons });
  }

  async function patternView(scope: Scope, p: ManagementPattern, rec: Records, lens: GenomeLens, views: Map<string, EpisodeView>, structure: (scope: Scope, l: GenomeLens) => Promise<Result<StructureView>>): Promise<Result<PatternView>> {
    const T = ms(lens.recordedThrough);
    if (ms(p.recordedAt) > T) return fail(GenomeErrors.NOT_KNOWN_AT_LENS, `This pattern was first recorded on ${p.recordedAt}, after the knowledge boundary ${lens.recordedThrough}.`);
    const revs = known(rec.revisions, T).filter((r) => r.patternId === p.id).sort((a, b) => a.revision - b.revision);
    const latest = revs[revs.length - 1];
    if (!latest) return fail(GenomeErrors.NOT_FOUND, 'The pattern is incomplete in this organization.');
    const links = known(rec.evidence, T)
      .filter((e) => e.patternId === p.id)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
    const episodeOf = async (id: string): Promise<Result<EpisodeView>> => {
      const hit = views.get(id);
      if (hit) return ok(hit);
      const ep = rec.episodes.find((e) => e.id === id);
      if (!ep) return fail(GenomeErrors.NOT_FOUND, 'The linked episode is missing.');
      const v = await episodeView(scope, ep, rec, lens);
      if (v.ok) views.set(id, v.value);
      return v;
    };
    const supporting: PatternView['supporting'][number][] = [];
    const contradictory: PatternView['contradictory'][number][] = [];
    const contextual: PatternView['contextual'][number][] = [];
    for (const l of links) {
      const ev = await episodeOf(l.episodeId);
      if (!ev.ok) return ev;
      const entry = { evidence: l, episode: ev.value };
      (l.stance === 'SUPPORTING_EPISODE' ? supporting : l.stance === 'CONTRADICTORY_EPISODE' ? contradictory : contextual).push(entry);
    }
    // Coverage: recorded episodes that match the scope and conditions, linked or not.
    const matching: string[] = [];
    for (const e of known(rec.episodes, T)) {
      const view = await structure(scope, e.boundary);
      if (!view.ok) return view;
      if (causalApplicability(view.value, p.scope, e.situation.anchorIds).verdict !== 'APPLIES') continue;
      if (!conditionsHold(p.conditions, e.situation).holds) continue;
      matching.push(e.id);
    }
    const linkedIds = new Set(links.map((l) => l.episodeId));
    const coverage = { matching: matching.length, linked: matching.filter((id) => linkedIds.has(id)).length, unlinkedMatching: matching.filter((id) => !linkedIds.has(id)) };
    const asLinked = (x: { evidence: PatternEvidence; episode: EpisodeView }): LinkedEpisode => ({
      episodeId: x.episode.episode.id,
      decisionId: x.episode.episode.decisionId,
      contextKey: [...x.episode.episode.situation.anchorIds].sort().join('+'),
    });
    const decided = decidePattern({
      supporting: supporting.map(asLinked),
      contradictory: contradictory.map(asLinked),
      contextual: contextual.length,
      retired: { retired: latest.retired, reason: latest.retirementReason },
      coverage,
    });
    return ok({
      pattern: p,
      revision: latest,
      lens,
      policy: GENOME_PATTERN_POLICY,
      status: decided.status,
      weak: decided.weak,
      reasons: decided.reasons,
      supporting,
      contradictory,
      contextual,
      coverage,
      caveat: CAVEAT,
    });
  }

  function lessonView(l: Lesson, rec: Records, lens: GenomeLens): LessonView {
    const T = ms(lens.recordedThrough);
    const reviews = known(rec.reviews, T)
      .filter((r) => r.lessonId === l.id)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
    const status: LessonStatus = reviews.length === 0 ? 'PROPOSED' : reviews[reviews.length - 1].status;
    const label = (r: GenomeRef): string =>
      r.kind === 'MANAGEMENT_EPISODE' ? rec.episodes.find((e) => e.id === r.id)?.title ?? r.id : r.kind === 'MANAGEMENT_PATTERN' ? rec.patterns.find((p) => p.id === r.id)?.title ?? r.id : r.label ?? r.id;
    return { lesson: l, status, reviews, evidence: l.evidence.map((r) => ({ ref: r, label: label(r) })) };
  }

  const validCharacteristic = (c: PatternCharacteristic): string | null => {
    if (c.kind === 'OUTCOME_VS_EXPECTATION') return c.metricKey?.trim() && (outcomeDirections as readonly string[]).includes(c.direction) ? null : 'An outcome characteristic names a metric and a direction (below, above or equal to expected).';
    if (c.kind === 'ASSUMPTION_OUTCOME') return (assumptionCriticalities as readonly string[]).includes(c.criticality) && (assumptionOutcomeKinds as readonly string[]).includes(c.outcome) ? null : 'An assumption characteristic names a criticality and an outcome.';
    if (c.kind === 'PROCESS_FEATURE') return (processFeatures as readonly string[]).includes(c.feature) ? null : `Unknown process feature. Features: ${processFeatures.join(', ')}.`;
    return 'Unknown characteristic kind.';
  };
  const validConditions = (c: PatternConditions): string | null => {
    for (const [k, v] of Object.entries(c)) {
      if (!(conditionFeatures as readonly string[]).includes(k)) return `"${k}" is not a feature a pattern may condition on. Features: ${conditionFeatures.join(', ')}. Where it holds is the scope.`;
      if (!Array.isArray(v) || v.length === 0) return `The condition "${k}" lists at least one value.`;
    }
    return null;
  };

  // ------------------------------------------------------------------ the runtime

  const self: ManagementGenome = {
    async situationOf(scope, decisionId, o = {}) {
      const s = await deriveSituation(sources, scope, decisionId, { scope: o.scope ?? { kind: 'ANCHORED', anchors: [] }, situationSnapshotId: o.situationSnapshotId ?? null });
      return s.ok ? ok(s.value.features) : s;
    },

    async openEpisode(scope, input: OpenEpisodeInput) {
      if (!input.title?.trim() || !input.authoredByLabel?.trim()) return invalid('An episode has a title and names who recorded it.');
      const sc = await scopeCheck(scope, input.scope);
      if (!sc.ok) return sc;
      const rec = await load(scope);
      if (!rec.ok) return rec;
      const derived = await deriveSituation(sources, scope, input.decisionId, { scope: sc.value, situationSnapshotId: input.situationSnapshotId ?? null });
      if (!derived.ok) return derived;
      const commitmentId = derived.value.commitment?.id ?? null;
      if (rec.value.episodes.some((e) => e.decisionId === input.decisionId && e.commitmentId === commitmentId)) {
        return fail(GenomeErrors.DUPLICATE, 'An episode already wraps this decision and commitment; a management experience has one container.');
      }
      const created = await store.insertEpisode(scope, {
        decisionId: input.decisionId,
        commitmentId,
        title: input.title.trim(),
        scope: sc.value,
        situation: derived.value.features,
        boundary: derived.value.boundary,
        sensitivityClasses: classesOf(derived.value.features.values.expectedMetric),
        visibility: input.visibility ?? 'ORG_WIDE',
        grantedUnitIds: [...(input.grantedUnitIds ?? [])].sort(),
        authoredBy: scope.actorId,
        authoredByLabel: input.authoredByLabel,
      });
      if (!created.ok) return created;
      if (input.situationSnapshotId) {
        const bound = await store.insertEpisodeRef(scope, {
          episodeId: created.value.id,
          role: 'SITUATION_SNAPSHOT',
          ref: { kind: 'TWIN_SNAPSHOT', id: input.situationSnapshotId, pin: null, label: 'The situation as known at the decision boundary' },
          note: null,
          boundBy: scope.actorId,
        });
        if (!bound.ok) return bound;
      }
      return self.getEpisode(scope, created.value.id);
    },

    async bindRef(scope, episodeId, role, ref, note) {
      if (!(episodeRefRoles as readonly string[]).includes(role)) return invalid(`Unknown role "${role}". Roles: ${episodeRefRoles.join(', ')}.`);
      const ep = await store.getEpisode(scope, episodeId);
      if (!ep.ok) return ep;
      if (!ep.value) return fail(GenomeErrors.NOT_FOUND, 'No such episode in this organization.');
      const e = ep.value;
      const expectKind: Record<EpisodeRefRole, string> = {
        SITUATION_SNAPSHOT: 'TWIN_SNAPSHOT',
        COMMITTED_FUTURE: 'TWIN_SNAPSHOT',
        OUTCOME_SNAPSHOT: 'TWIN_SNAPSHOT',
        CAUSAL_CONTEXT: 'CAUSAL_CLAIM',
        GOVERNANCE_EVALUATION: 'EVALUATION',
        OUTCOME_REVIEW: 'OUTCOME_REVIEW',
      };
      if (ref.kind !== expectKind[role]) return invalid(`A ${role} reference points at a ${expectKind[role]}, not a ${ref.kind}.`);
      const T0 = ms(e.boundary.recordedThrough);
      if (role === 'SITUATION_SNAPSHOT' || role === 'COMMITTED_FUTURE' || role === 'OUTCOME_SNAPSHOT') {
        const snap = await sources.twin.getSnapshot(scope, ref.id);
        if (!snap.ok) return snap;
        const lensT = ms(snap.value.snapshot.spec.lens.recordedThrough);
        if (role === 'SITUATION_SNAPSHOT' && lensT > T0) return fail(GenomeErrors.HINDSIGHT_AS_SITUATION, 'That snapshot was known only after the decision boundary: it is hindsight, not the situation management faced.');
        if (role === 'OUTCOME_SNAPSHOT' && lensT <= T0) return invalid('An outcome snapshot is known after the decision boundary; this one was known before it.');
        if (role === 'COMMITTED_FUTURE' && (snap.value.snapshot.spec.kind !== 'COMMITTED_FUTURE' || snap.value.snapshot.spec.commitmentId !== e.commitmentId)) {
          return invalid("A committed future is the COMMITTED_FUTURE snapshot of this episode's own commitment.");
        }
      }
      if (role === 'CAUSAL_CONTEXT') {
        const c = await sources.causal.getClaim(scope, ref.id);
        if (!c.ok) return c;
      }
      if (role === 'OUTCOME_REVIEW') {
        const reviews = await sources.decisions.listOutcomeReviews(scope, e.decisionId);
        if (!reviews.ok) return reviews;
        if (!reviews.value.some((r) => r.id === ref.id)) return invalid("That outcome review does not belong to this episode's decision.");
      }
      const bound = await store.insertEpisodeRef(scope, { episodeId, role, ref, note: note ?? null, boundBy: scope.actorId });
      if (!bound.ok) return bound;
      return self.getEpisode(scope, episodeId);
    },

    async getEpisode(scope, id, lens) {
      const l = checkLens(lens);
      if (!l.ok) return l;
      const rec = await load(scope);
      if (!rec.ok) return rec;
      const ep = rec.value.episodes.find((e) => e.id === id);
      if (!ep) return fail(GenomeErrors.NOT_FOUND, 'No such episode in this organization.');
      return episodeView(scope, ep, rec.value, l.value);
    },

    async listEpisodes(scope, lens) {
      const l = checkLens(lens);
      if (!l.ok) return l;
      const rec = await load(scope);
      if (!rec.ok) return rec;
      const out: EpisodeView[] = [];
      for (const e of known(rec.value.episodes, ms(l.value.recordedThrough)).sort((a, b) => a.boundary.recordedThrough.localeCompare(b.boundary.recordedThrough))) {
        const v = await episodeView(scope, e, rec.value, l.value);
        if (!v.ok) return v;
        out.push(v.value);
      }
      return ok(out);
    },

    async findSimilar(scope, input) {
      const l = checkLens(input.lens);
      if (!l.ok) return l;
      const req = checkFeatures(input.require);
      if (!req.ok) return req;
      const rec = await load(scope);
      if (!rec.ok) return rec;
      let target;
      let selfId: string | null = null;
      if (input.episodeId) {
        const ep = rec.value.episodes.find((e) => e.id === input.episodeId);
        if (!ep) return fail(GenomeErrors.NOT_FOUND, 'No such episode in this organization.');
        target = ep.situation;
        selfId = ep.id;
      } else if (input.decisionId) {
        const s = await deriveSituation(sources, scope, input.decisionId, { scope: { kind: 'ANCHORED', anchors: [] } });
        if (!s.ok) return s;
        target = s.value.features;
      } else {
        return invalid('Say which situation: an episode, or a decision (committed or not).');
      }
      const found: SimilarEpisode[] = [];
      for (const e of known(rec.value.episodes, ms(l.value.recordedThrough)).sort((a, b) => a.boundary.recordedThrough.localeCompare(b.boundary.recordedThrough))) {
        if (e.id === selfId) continue;
        const ag = agreements(target, e.situation, req.value);
        if (!ag.every((a) => a.agrees)) continue;
        const v = await episodeView(scope, e, rec.value, l.value);
        if (!v.ok) return v;
        found.push({ view: v.value, agreements: ag });
      }
      const unstated = req.value.filter((f) => target.notStated.includes(f));
      const unstatedNote = unstated.length === 0 ? '' : ` This situation does not state ${unstated.join(', ')}, so no episode can agree on ${unstated.length === 1 ? 'it' : 'them'} — an empty result here means "cannot tell", not "nothing like it".`;
      return ok({
        target,
        required: req.value as readonly FeatureName[],
        unstatedInTarget: unstated as readonly FeatureName[],
        episodes: found,
        statement:
          (found.length === 0
            ? 'No recorded episode agrees on every required feature. That is not evidence the situation is new — only that the genome holds no such episode.'
            : `${found.length} recorded episode(s) agree on ${req.value.join(', ')}. They are listed in the order they were decided, not by resemblance; how they differ is for people to read.`) + unstatedNote,
      });
    },

    async proposePattern(scope, input: ProposePatternInput) {
      if (!input.title?.trim() || !input.statement?.trim() || !input.authoredByLabel?.trim()) return invalid('A pattern is titled, stated, and names its author.');
      if (!input.limitations?.trim()) return invalid('A pattern states its limitations: what it does not show. That is not optional.');
      const cErr = validCharacteristic(input.characteristic);
      if (cErr) return invalid(cErr);
      const kErr = validConditions(input.conditions ?? {});
      if (kErr) return invalid(kErr);
      const sc = await scopeCheck(scope, input.scope);
      if (!sc.ok) return sc;
      const created = await store.insertPattern(
        scope,
        {
          title: input.title.trim(),
          scope: sc.value,
          conditions: input.conditions ?? {},
          characteristic: input.characteristic,
          visibility: input.visibility ?? 'ORG_WIDE',
          grantedUnitIds: [...(input.grantedUnitIds ?? [])].sort(),
          authoredBy: scope.actorId,
          authoredByLabel: input.authoredByLabel,
        },
        { statement: input.statement.trim(), limitations: input.limitations.trim(), retired: false, retirementReason: null, recordedBy: scope.actorId },
      );
      if (!created.ok) return created;
      return self.getPattern(scope, created.value.pattern.id);
    },

    async revisePattern(scope, patternId, input) {
      const cur = await self.getPattern(scope, patternId);
      if (!cur.ok) return cur;
      const r = await store.insertPatternRevision(scope, patternId, {
        statement: input.statement ?? cur.value.revision.statement,
        limitations: input.limitations ?? cur.value.revision.limitations,
        retired: false,
        retirementReason: null,
        recordedBy: scope.actorId,
      });
      if (!r.ok) return r;
      return self.getPattern(scope, patternId);
    },

    async retirePattern(scope, patternId, reason) {
      if (!reason?.trim()) return invalid('Retiring a pattern says why.');
      const cur = await self.getPattern(scope, patternId);
      if (!cur.ok) return cur;
      if (scope.role !== 'admin' && cur.value.pattern.authoredBy !== scope.actorId) {
        return fail(GenomeErrors.FORBIDDEN, "Only the pattern's author or an organization admin retires a pattern.");
      }
      const r = await store.insertPatternRevision(scope, patternId, { ...{ statement: cur.value.revision.statement, limitations: cur.value.revision.limitations }, retired: true, retirementReason: reason.trim(), recordedBy: scope.actorId });
      if (!r.ok) return r;
      return self.getPattern(scope, patternId);
    },

    async classifyEpisode(scope, patternId, episodeId, lens) {
      const l = checkLens(lens);
      if (!l.ok) return l;
      const rec = await load(scope);
      if (!rec.ok) return rec;
      const p = rec.value.patterns.find((x) => x.id === patternId);
      const e = rec.value.episodes.find((x) => x.id === episodeId);
      if (!p || !e) return fail(GenomeErrors.NOT_FOUND, 'No such pattern or episode in this organization.');
      const T = ms(l.value.recordedThrough);
      if (ms(p.recordedAt) > T || ms(e.recordedAt) > T) {
        return fail(GenomeErrors.NOT_KNOWN_AT_LENS, `The ${ms(p.recordedAt) > T ? 'pattern' : 'episode'} was first recorded after the knowledge boundary ${l.value.recordedThrough}.`);
      }
      return classify(scope, p, e, l.value, structureCache());
    },

    async linkEpisode(scope, patternId, episodeId, stance, rationale) {
      if (!(patternStances as readonly string[]).includes(stance)) return invalid(`Unknown stance "${stance}".`);
      if (!rationale?.trim()) return invalid('Linking an episode says why it bears on the pattern.');
      const rec = await load(scope);
      if (!rec.ok) return rec;
      const p = rec.value.patterns.find((x) => x.id === patternId);
      const e = rec.value.episodes.find((x) => x.id === episodeId);
      if (!p || !e) return fail(GenomeErrors.NOT_FOUND, 'No such pattern or episode in this organization.');
      const revs = rec.value.revisions.filter((r) => r.patternId === patternId).sort((a, b) => a.revision - b.revision);
      if (revs[revs.length - 1]?.retired) return fail(GenomeErrors.IMMUTABLE, 'The pattern is retired; it takes no further episode.');
      const now = currentLens();
      const c = await classify(scope, p, e, now, structureCache());
      if (!c.ok) return c;
      const agree = stanceAgrees(stance, c.value.classification);
      if (!agree.ok) return fail(GenomeErrors.INCONSISTENT_STANCE, `${agree.message} (${c.value.reasons.join('; ')})`);
      const linked = await store.insertPatternEvidence(scope, { patternId, episodeId, stance, rationale: rationale.trim(), observed: c.value.classification, linkedBy: scope.actorId });
      if (!linked.ok) return linked;
      return self.getPattern(scope, patternId);
    },

    async getPattern(scope, id, lens) {
      const l = checkLens(lens);
      if (!l.ok) return l;
      const rec = await load(scope);
      if (!rec.ok) return rec;
      const p = rec.value.patterns.find((x) => x.id === id);
      if (!p) return fail(GenomeErrors.NOT_FOUND, 'No such pattern in this organization.');
      return patternView(scope, p, rec.value, l.value, new Map(), structureCache());
    },

    async listPatterns(scope, lens) {
      const l = checkLens(lens);
      if (!l.ok) return l;
      const rec = await load(scope);
      if (!rec.ok) return rec;
      const views = new Map<string, EpisodeView>();
      const structure = structureCache();
      const out: PatternView[] = [];
      for (const p of known(rec.value.patterns, ms(l.value.recordedThrough)).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))) {
        const v = await patternView(scope, p, rec.value, l.value, views, structure);
        if (!v.ok) return v;
        out.push(v.value);
      }
      return ok(out);
    },

    async recordLesson(scope, input: RecordLessonInput) {
      if (!input.claim?.trim() || !input.authoredByLabel?.trim()) return invalid('A lesson states its claim and names its author.');
      if (!input.evidence || input.evidence.length === 0) return invalid('A lesson rests on at least one episode or pattern.');
      const sc = await scopeCheck(scope, input.scope);
      if (!sc.ok) return sc;
      const rec = await load(scope);
      if (!rec.ok) return rec;
      for (const r of input.evidence) {
        const exists = r.kind === 'MANAGEMENT_EPISODE' ? rec.value.episodes.some((e) => e.id === r.id) : r.kind === 'MANAGEMENT_PATTERN' ? rec.value.patterns.some((p) => p.id === r.id) : null;
        if (exists === null) return invalid('A lesson rests on episodes or patterns of this genome — not on free text, not on a calculation.');
        if (!exists) return invalid(`The ${r.kind === 'MANAGEMENT_EPISODE' ? 'episode' : 'pattern'} ${r.id} is not in this organization.`);
      }
      const created = await store.insertLesson(scope, {
        claim: input.claim.trim(),
        scope: sc.value,
        evidence: input.evidence,
        visibility: input.visibility ?? 'ORG_WIDE',
        grantedUnitIds: [...(input.grantedUnitIds ?? [])].sort(),
        authoredBy: scope.actorId,
        authoredByLabel: input.authoredByLabel,
      });
      if (!created.ok) return created;
      const fresh = await load(scope);
      if (!fresh.ok) return fresh;
      return ok(lessonView(created.value, fresh.value, currentLens()));
    },

    async reviewLesson(scope, lessonId, status, note, reviewedByLabel) {
      const rec = await load(scope);
      if (!rec.ok) return rec;
      const lesson = rec.value.lessons.find((x) => x.id === lessonId);
      if (!lesson) return fail(GenomeErrors.NOT_FOUND, 'No such lesson in this organization.');
      if (!reviewedByLabel?.trim()) return invalid('A review names who made it.');
      const r = await store.insertLessonReview(scope, { lessonId, status, note, reviewedBy: scope.actorId, reviewedByLabel });
      if (!r.ok) return r;
      const fresh = await load(scope);
      if (!fresh.ok) return fresh;
      return ok(lessonView(lesson, fresh.value, currentLens()));
    },

    async listLessons(scope, lens) {
      const l = checkLens(lens);
      if (!l.ok) return l;
      const rec = await load(scope);
      if (!rec.ok) return rec;
      return ok(known(rec.value.lessons, ms(l.value.recordedThrough)).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)).map((x) => lessonView(x, rec.value, l.value)));
    },

    async viewAt(scope, lens) {
      const l = checkLens(lens);
      if (!l.ok) return l;
      const [episodes, patterns, lessons] = await Promise.all([self.listEpisodes(scope, l.value), self.listPatterns(scope, l.value), self.listLessons(scope, l.value)]);
      if (!episodes.ok) return episodes;
      if (!patterns.ok) return patterns;
      if (!lessons.ok) return lessons;
      return ok({ lens: l.value, episodes: episodes.value, patterns: patterns.value, lessons: lessons.value });
    },

    async projectForViewer(scope, viewer: TwinViewer, units: readonly OrgUnit[], facts: GenomeVisibilityFacts, lens) {
      const l = checkLens(lens);
      if (!l.ok) return l;
      const at = l.value.recordedThrough;
      const g = await self.viewAt(scope, l.value);
      if (!g.ok) return g;
      const isAdmin = viewer.orgRole === 'admin';
      const unitOk = (x: { visibility: 'ORG_WIDE' | 'RESTRICTED'; authoredBy: string | null; grantedUnitIds: readonly string[] }) =>
        isAdmin ||
        x.visibility === 'ORG_WIDE' ||
        canSeeDecision({ userId: viewer.userId, orgRole: viewer.orgRole, memberUnitIds: viewer.memberUnitIds }, { createdBy: x.authoredBy, grantedUnitIds: x.grantedUnitIds }, units).visible;
      const episodeOk = (v: EpisodeView) =>
        unitOk(v.episode) && v.episode.sensitivityClasses.every((c) => isCleared(viewer, c, at)) && (isAdmin || facts.decisionVisible(v.episode.decisionId));
      const episodes = g.value.episodes.filter(episodeOk);
      const visibleEpisode = new Set(episodes.map((v) => v.episode.id));
      // A pattern or lesson is read whole or not at all: every episode it rests on must be readable.
      const patterns = g.value.patterns.filter((p) => unitOk(p.pattern) && [...p.supporting, ...p.contradictory, ...p.contextual].every((x) => visibleEpisode.has(x.episode.episode.id)));
      const visiblePattern = new Set(patterns.map((p) => p.pattern.id));
      const lessons = g.value.lessons.filter(
        (x) =>
          unitOk(x.lesson) &&
          x.lesson.evidence.every((r) => (r.kind === 'MANAGEMENT_EPISODE' ? visibleEpisode.has(r.id) : r.kind === 'MANAGEMENT_PATTERN' ? visiblePattern.has(r.id) : false)),
      );
      const withheld = { episodes: g.value.episodes.length - episodes.length, patterns: g.value.patterns.length - patterns.length, lessons: g.value.lessons.length - lessons.length };
      const total = withheld.episodes + withheld.patterns + withheld.lessons;
      return ok({
        episodes,
        patterns,
        lessons,
        withheld,
        statement:
          total === 0
            ? 'Every episode, pattern and lesson known at this lens is visible to you.'
            : `${withheld.episodes} episode(s), ${withheld.patterns} pattern(s) and ${withheld.lessons} lesson(s) withheld: they are restricted to other units, carry a sensitivity class you are not cleared for, ` +
              'or rest on a decision you cannot see. A pattern or lesson that rests on a withheld episode is withheld whole.',
      } satisfies ProjectedGenome);
    },
  };

  return self;
}

export { boundaryOf };
