/**
 * DEMO MANAGEMENT EPISODES — the Rohto episode and four illustrative ones
 * (Phase 9).
 *
 * Everything here is DEMO data, labelled as such in every record. The Rohto
 * episode wraps the real story the Phase 5–8 demos already live: the decision,
 * its commitment, the twin snapshots and the causal beliefs are the kernel's
 * own records, referenced. The four other decisions are illustrative: they are
 * decided and reviewed through the same decision runtime as any other, but the
 * facts they encode — what was chosen, what it turned out to cost — are
 * invented for the demonstration, and their expected figures come from the
 * demo scenarios they are bound to.
 *
 *   E1  Rohto Q4 allocation (ISSUE, Vietnam Pharma · Rohto)
 *         reallocate; a finance challenge left open at commitment; margin
 *         landed 0.6878 pts below the committed figure; a tender assumption
 *         disproved. The twin, the causal graph and governance all hold records
 *         of it.
 *   E2  Rohto Q1 call-off (PLANNED_REVIEW, Vietnam Pharma · Rohto)
 *         served from standard replenishment; margin met the commitment.
 *   E3  Thailand Pharma tender allocation (ISSUE, Thailand Pharma)
 *         margin landed below the commitment — in another country.
 *   E4  Vietnam Pharma second-account allocation (ISSUE, Vietnam Pharma)
 *         expedite; a finance challenge left open; margin landed below.
 *   E5  Vietnam Pharma allocation with freight priced in (SIGNAL, Vietnam Pharma)
 *         the challenge was resolved before commitment; margin met the commitment.
 *
 * Patterns (each a checkable hypothesis, none a law):
 *   P1  "Margin lands below the committed margin on Vietnam Pharma allocations
 *       triggered by an issue or a signal" — E1 and E4 support, E5 contradicts,
 *       E2 and E3 are outside it → CONTESTED.
 *   P2  "A finance challenge is left open at commitment on issue-triggered
 *       Vietnam Pharma allocations" — E1 and E4 → RECURRING.
 *   P3  "A material assumption is disproved on issue-triggered Rohto decisions"
 *       — E1 alone → EMERGING, labelled weak.
 *
 * The lessons are authored by management and inert.
 */

import { ok, type Result, type Scope, type UserId } from '@helm/shared';
import type { DecisionCommitment, DecisionRuntime, DecisionStore } from '@helm/decision-runtime';
import type { AuthorityRuntime } from '@helm/authority-runtime';
import type { EpisodeView, LessonView, ManagementGenome, PatternView } from './port.ts';
import type { GenomeScope } from './types.ts';

export const DEMO_GENOME_LABEL = 'DEMO MANAGEMENT EPISODES';

export const MERIDIAN_GENOME_TIMES = {
  callOff: '2027-02-16T02:00:00.000Z',
  thailand: '2027-02-20T02:00:00.000Z',
  secondAccount: '2027-02-24T02:00:00.000Z',
  freightPriced: '2027-03-02T02:00:00.000Z',
  reviews: '2027-03-28T02:00:00.000Z',
  episodes: '2027-04-02T02:00:00.000Z',
  patterns: '2027-04-06T02:00:00.000Z',
  lessons: '2027-04-08T02:00:00.000Z',
  /** Between the two links of P1 that make it recur, and before the contradiction was linked. */
  beforeContradictionLinked: '2027-04-06T05:00:00.000Z',
} as const;

type Anchor = { entityId: string; label: string };

export type MeridianGenomeDeps = {
  readonly genome: ManagementGenome;
  readonly admin: Scope;
  readonly as: (userId: UserId) => Scope;
  readonly users: { readonly countryGM: UserId; readonly commercialDirector: UserId; readonly financeDirector: UserId };
  readonly decisions: DecisionRuntime;
  readonly decisionStore: DecisionStore;
  readonly authority: AuthorityRuntime;
  readonly scenarioIds: Readonly<Record<string, string>>;
  readonly entities: { readonly buPharma: Anchor; readonly rohto: Anchor; readonly buThPharma: Anchor; readonly vn: Anchor };
  readonly twin: { readonly decisionId: string; readonly commitmentId: string; readonly S0: string; readonly CF1: string; readonly S2: string };
  /** Causal claims of the Phase 8 story that bear on the Rohto episode, by id. */
  readonly causalClaimIds: readonly string[];
  /**
   * The units the demonstration decisions concern. Where given, each decision is shared with them —
   * as the governance demonstration does — so who may read the genome follows the decision-visibility
   * rule rather than a demo shortcut. Omitted, decisions stay with their creators.
   */
  readonly shareWith?: readonly { readonly unitId: string; readonly label: string }[];
  readonly advanceTo: (iso: string) => void;
};

export type MeridianGenomeStory = {
  readonly episodes: Readonly<Record<'E1' | 'E2' | 'E3' | 'E4' | 'E5', EpisodeView>>;
  readonly patterns: Readonly<Record<'P1' | 'P2' | 'P3', PatternView>>;
  readonly lessons: Readonly<Record<'L1' | 'L2', LessonView>>;
};

const unwrap = <T>(r: Result<T>, what: string): T => {
  if (!r.ok) throw new Error(`genome story — ${what}: ${r.error.code} ${r.error.message}`);
  return r.value;
};

export async function runMeridianGenomeStory(d: MeridianGenomeDeps): Promise<Result<MeridianGenomeStory>> {
  try {
    return ok(await story(d));
  } catch (e) {
    return { ok: false, error: { code: 'genome.demo_story', message: (e as Error).message } };
  }
}

const FIN = { kind: 'ROLE' as const, label: 'Finance Director Vietnam', userId: null };
const COM = { kind: 'ROLE' as const, label: 'Commercial Director Vietnam', userId: null };
const SCM = { kind: 'ROLE' as const, label: 'Supply Chain Director Vietnam', userId: null };

type DemoSpec = {
  title: string;
  question: string;
  trigger: 'ISSUE' | 'SIGNAL' | 'PLANNED_REVIEW';
  scenarioKey: string;
  scopeText: string;
  reversibility: 'REVERSIBLE' | 'PARTIALLY_REVERSIBLE';
  /** A finance challenge raised on the chosen alternative; `resolved` closes it before commitment. */
  challenge: { concern: string; resolved: boolean } | null;
  assumptions: { statement: string; owner: typeof COM | null; criticality: 'CRITICAL' | 'MATERIAL' | 'MINOR' }[];
};

async function decide(d: MeridianGenomeDeps, spec: DemoSpec): Promise<{ decisionId: string; commitment: DecisionCommitment; assumptionIds: string[] }> {
  const scope = d.admin;
  const created = unwrap(
    await d.decisions.createDecision(scope, {
      title: `${spec.title} (demo)`,
      managementQuestion: spec.question,
      context: `${DEMO_GENOME_LABEL}: illustrative decision; its facts are invented for the demonstration.`,
      scope: spec.scopeText,
      triggerType: spec.trigger,
      owner: { kind: 'ROLE', label: 'Country GM Vietnam', userId: null },
      reversibility: spec.reversibility,
    }),
    `create ${spec.title}`,
  );
  const revisionId = created.revision.id;
  const chosen = unwrap(
    await d.decisions.addAlternative(scope, revisionId, { label: spec.title, description: 'The computed future this commitment rests on.', scenarioId: d.scenarioIds[spec.scenarioKey] }),
    'alternative',
  );
  unwrap(
    await d.decisions.addAlternative(scope, revisionId, { label: 'Hold and revisit next quarter', description: 'Do nothing now.', unmodelledReason: 'Not simulated: holding is the status quo.' }),
    'other alternative',
  );
  const criterion = unwrap(
    await d.decisions.addCriterion(scope, revisionId, {
      key: 'customer-service',
      name: 'Customer service',
      style: 'HARD_CONSTRAINT',
      required: true,
      metricKey: 'DemandCoverage',
      threshold: 90,
      unit: 'percentage',
      direction: 'HIGHER_IS_BETTER',
      author: { kind: 'ROLE', label: 'Country GM Vietnam', userId: null },
      rationale: `${DEMO_GENOME_LABEL}: the 90% coverage floor on key accounts.`,
      demoPolicy: true,
    }),
    'criterion',
  );
  const assumptionIds: string[] = [];
  for (const a of spec.assumptions) {
    const added = unwrap(
      await d.decisions.addAssumption(scope, revisionId, { statement: a.statement, owner: a.owner, source: DEMO_GENOME_LABEL, rationale: 'Stated for the demonstration.', confidence: 0.7, criticality: a.criticality }),
      'assumption',
    );
    assumptionIds.push(added.id);
  }
  if (spec.challenge) {
    const ch = unwrap(await d.decisions.challenge(scope, revisionId, { targetKind: 'ALTERNATIVE', targetId: chosen.id, author: FIN, concern: spec.challenge.concern }), 'challenge');
    if (spec.challenge.resolved) {
      unwrap(await d.decisions.resolveChallenge(scope, ch.id, { status: 'RESOLVED', resolution: 'Finance confirmed the freight premium is priced into the commitment.' }), 'resolve');
    }
  }
  for (const state of ['MODELLING', 'READY_FOR_DECISION'] as const) unwrap(await d.decisions.setState(scope, created.decision.id, state), `state ${state}`);
  const committed = unwrap(
    await d.decisions.commit(scope, revisionId, {
      chosenAlternativeId: chosen.id,
      authorship: 'MANAGEMENT_AUTHORED_DEMO',
      committedByLabel: 'Country GM Vietnam',
      summary: `${spec.title}.`,
      rationale: [{ kind: 'CRITERION', ref: criterion.id, label: 'Customer service', statement: 'The computed future keeps coverage above the 90% floor management stated.' }],
      acceptedTradeOffs: [],
      expectedOutcomes: [
        { label: 'Gross margin %', kind: 'MODELLED', metricKey: 'GrossMarginPct', subjectHint: 'Rohto' },
        { label: 'Customer service', kind: 'MODELLED', metricKey: 'DemandCoverage' },
      ],
      acknowledgeOpenChallenges: true,
    }),
    `commit ${spec.title}`,
  );
  unwrap(await d.authority.declareGovernanceProfile(scope, created.decision.id, { decisionTypeKey: 'INVENTORY_ALLOCATION', note: DEMO_GENOME_LABEL }), 'classify');
  return { decisionId: created.decision.id, commitment: committed.commitment, assumptionIds };
}

/** Records an outcome review whose gross margin is the committed one plus `delta` points (demo figures). */
async function review(d: MeridianGenomeDeps, commitment: DecisionCommitment, delta: number, assumptionResults: { assumptionId: string; outcome: 'CONFIRMED' | 'DISPROVED'; note: string }[], note: string) {
  const expected = commitment.expectedOutcomes.find((o) => o.metricKey === 'GrossMarginPct')?.expectedValue ?? null;
  if (expected === null) throw new Error('genome story — the commitment expects no gross margin');
  const actual = (Number(expected) + delta).toFixed(4);
  unwrap(
    await d.decisions.recordOutcomeReview(d.admin, commitment.id, {
      reviewedByLabel: 'Finance Director Vietnam',
      actuals: [{ label: 'Gross margin %', metricKey: 'GrossMarginPct', actual }],
      assumptionResults,
      notes: `${DEMO_GENOME_LABEL}: ${note}`,
    }),
    'review',
  );
}

async function story(d: MeridianGenomeDeps): Promise<MeridianGenomeStory> {
  const { genome } = d;
  const T = MERIDIAN_GENOME_TIMES;
  const commercial = d.as(d.users.commercialDirector);
  const finance = d.as(d.users.financeDirector);
  const gm = d.as(d.users.countryGM);
  const anchor = (a: Anchor) => ({ entityId: a.entityId, label: a.label, dimension: '' });
  const pharma: GenomeScope = { kind: 'ANCHORED', anchors: [anchor(d.entities.buPharma)] };
  const rohtoInPharma: GenomeScope = { kind: 'ANCHORED', anchors: [anchor(d.entities.buPharma), anchor(d.entities.rohto)] };
  const thailand: GenomeScope = { kind: 'ANCHORED', anchors: [anchor(d.entities.buThPharma)] };

  // Decision visibility is a rule, not a courtesy: a decision is shared with the units it concerns.
  const share = async (decisionId: string) => {
    for (const u of d.shareWith ?? []) {
      unwrap(await d.authority.grantVisibility(commercial, decisionId, { orgUnitId: u.unitId, orgUnitLabel: u.label, reason: 'Demo: the units this decision concerns' }), 'share decision');
    }
  };
  await share(d.twin.decisionId);

  // ------------------------------------------------------------ the decisions (chronological)
  d.advanceTo(T.callOff);
  const e2 = await decide(d, {
    title: 'Rohto Q1 call-off from standard replenishment',
    question: 'How should we serve the Rohto framework call-off in 2027-Q1?',
    trigger: 'PLANNED_REVIEW',
    scenarioKey: 'call-off',
    scopeText: 'Vietnam · Rohto',
    reversibility: 'REVERSIBLE',
    challenge: null,
    assumptions: [{ statement: 'A standard replenishment of four units lands before the quarter.', owner: SCM, criticality: 'CRITICAL' }],
  });
  await share(e2.decisionId);
  d.advanceTo(T.thailand);
  const e3 = await decide(d, {
    title: 'Thailand Pharma tender allocation',
    question: 'How should we allocate stock to the Thailand Pharma tender?',
    trigger: 'ISSUE',
    scenarioKey: 'reallocate',
    scopeText: 'Thailand · Pharma BU',
    reversibility: 'PARTIALLY_REVERSIBLE',
    challenge: { concern: 'The forwarder quote covers freight only; re-labelling for the tender packs is not in it.', resolved: false },
    assumptions: [{ statement: 'The distributor will release the consignment units.', owner: COM, criticality: 'CRITICAL' }],
  });
  await share(e3.decisionId);
  d.advanceTo(T.secondAccount);
  const e4 = await decide(d, {
    title: 'Vietnam Pharma second-account allocation, expedited',
    question: 'How should we fulfil a second key account order from constrained stock?',
    trigger: 'ISSUE',
    scenarioKey: 'expedite',
    scopeText: 'Vietnam · Pharma BU',
    reversibility: 'PARTIALLY_REVERSIBLE',
    challenge: { concern: 'The air-freight premium quoted excludes customs handling, so the cost of expediting may be understated.', resolved: false },
    assumptions: [{ statement: 'Supplier A can deliver in seven days once expedited.', owner: SCM, criticality: 'CRITICAL' }],
  });
  await share(e4.decisionId);
  d.advanceTo(T.freightPriced);
  const e5 = await decide(d, {
    title: 'Vietnam Pharma allocation with the freight priced in',
    question: 'How should we serve an urgent Vietnam Pharma order, with the freight premium priced into the commitment?',
    trigger: 'SIGNAL',
    scenarioKey: 'reallocate',
    scopeText: 'Vietnam · Pharma BU',
    reversibility: 'PARTIALLY_REVERSIBLE',
    challenge: { concern: 'The transfer cost may be understated.', resolved: true },
    assumptions: [{ statement: 'The distributor will release the consignment units.', owner: COM, criticality: 'CRITICAL' }],
  });

  await share(e5.decisionId);

  // ------------------------------------------------------------ what happened (illustrative figures)
  d.advanceTo(T.reviews);
  await review(d, e2.commitment, 0, [{ assumptionId: e2.assumptionIds[0], outcome: 'CONFIRMED', note: 'The replenishment landed on time.' }], 'the call-off met the committed margin.');
  await review(d, e3.commitment, -1.1, [{ assumptionId: e3.assumptionIds[0], outcome: 'CONFIRMED', note: 'Released in full.' }], 'margin landed below the commitment; re-labelling was not in the quote.');
  await review(d, e4.commitment, -0.9, [{ assumptionId: e4.assumptionIds[0], outcome: 'CONFIRMED', note: 'Delivered in six days.' }], 'margin landed below the commitment; customs handling was not in the quote.');
  await review(d, e5.commitment, 0, [{ assumptionId: e5.assumptionIds[0], outcome: 'CONFIRMED', note: 'Released in full.' }], 'with the freight priced in, margin met the commitment.');

  // ------------------------------------------------------------ the episodes
  d.advanceTo(T.episodes);
  const reviewsOf = async (decisionId: string) => unwrap(await d.decisionStore.listOutcomeReviews(d.admin, decisionId), 'reviews');
  const e1Open = unwrap(
    await genome.openEpisode(gm, { decisionId: d.twin.decisionId, title: 'Rohto Q4 allocation (demo)', scope: rohtoInPharma, situationSnapshotId: d.twin.S0, authoredByLabel: 'Country GM Vietnam (demo)' }),
    'open E1',
  );
  const bind = async (episodeId: string, role: Parameters<ManagementGenome['bindRef']>[2], ref: Parameters<ManagementGenome['bindRef']>[3], note?: string) =>
    unwrap(await genome.bindRef(gm, episodeId, role, ref, note), `bind ${role}`);
  await bind(e1Open.episode.id, 'COMMITTED_FUTURE', { kind: 'TWIN_SNAPSHOT', id: d.twin.CF1, pin: null, label: 'CF1 — the committed future' });
  await bind(e1Open.episode.id, 'OUTCOME_SNAPSHOT', { kind: 'TWIN_SNAPSHOT', id: d.twin.S2, pin: null, label: 'S2 — after the Q4 outcome' });
  for (const r of await reviewsOf(d.twin.decisionId)) await bind(e1Open.episode.id, 'OUTCOME_REVIEW', { kind: 'OUTCOME_REVIEW', id: r.id, pin: null, label: 'Q4 outcome review' });
  const evaluations = unwrap(await d.authority.listEvaluations(d.admin, { commitmentId: d.twin.commitmentId }), 'evaluations');
  for (const ev of evaluations) await bind(e1Open.episode.id, 'GOVERNANCE_EVALUATION', { kind: 'EVALUATION', id: ev.id, pin: null, label: 'Authority evaluation' });
  for (const claimId of d.causalClaimIds) await bind(e1Open.episode.id, 'CAUSAL_CONTEXT', { kind: 'CAUSAL_CLAIM', id: claimId, pin: null, label: null });

  const open = async (title: string, decisionId: string, commitment: DecisionCommitment, scope: GenomeScope) => {
    const ep = unwrap(await genome.openEpisode(gm, { decisionId, title: `${title} (demo)`, scope, authoredByLabel: 'Country GM Vietnam (demo)' }), `open ${title}`);
    for (const r of await reviewsOf(decisionId)) if (r.commitmentId === commitment.id) await bind(ep.episode.id, 'OUTCOME_REVIEW', { kind: 'OUTCOME_REVIEW', id: r.id, pin: null, label: 'Outcome review' });
    return ep;
  };
  const e2Open = await open('Rohto Q1 call-off', e2.decisionId, e2.commitment, rohtoInPharma);
  const e3Open = await open('Thailand Pharma tender allocation', e3.decisionId, e3.commitment, thailand);
  const e4Open = await open('Vietnam Pharma second-account allocation', e4.decisionId, e4.commitment, pharma);
  const e5Open = await open('Vietnam Pharma allocation, freight priced in', e5.decisionId, e5.commitment, pharma);

  // ------------------------------------------------------------ the patterns
  d.advanceTo(T.patterns);
  const p1 = unwrap(
    await genome.proposePattern(commercial, {
      title: 'Margin lands below the committed margin on Vietnam Pharma allocations',
      scope: pharma,
      conditions: { decisionType: ['INVENTORY_ALLOCATION'], triggerType: ['ISSUE', 'SIGNAL'], expectedMetric: ['GrossMarginPct'] },
      characteristic: { kind: 'OUTCOME_VS_EXPECTATION', metricKey: 'GrossMarginPct', direction: 'ACTUAL_BELOW_EXPECTED' },
      statement: 'Inventory allocations in Vietnam Pharma that were triggered by an issue or a signal have tended to land below the gross margin management committed to.',
      limitations:
        'Three recorded episodes match; none is a sample. The episodes differ in what was chosen (reallocation, expedite) and in whether the freight premium was priced in. ' +
        'The pattern says nothing about why margin fell, about other units, or about what will happen next.',
      authoredByLabel: 'Commercial Director Vietnam (demo)',
    }),
    'P1',
  );
  const p2 = unwrap(
    await genome.proposePattern(finance, {
      title: 'A finance cost challenge is left open at commitment on issue-triggered Vietnam Pharma allocations',
      scope: pharma,
      conditions: { decisionType: ['INVENTORY_ALLOCATION'], triggerType: ['ISSUE'] },
      characteristic: { kind: 'PROCESS_FEATURE', feature: 'CHALLENGE_OPEN_AT_COMMITMENT' },
      statement: 'When an allocation in Vietnam Pharma is triggered by an issue, a finance challenge about cost has been acknowledged and left open rather than resolved before commitment.',
      limitations: 'This describes how the decisions were prepared, not whether preparing them this way was wrong: an open challenge can be a sound acceptance of risk. Two episodes.',
      authoredByLabel: 'Finance Director Vietnam (demo)',
    }),
    'P2',
  );
  const p3 = unwrap(
    await genome.proposePattern(commercial, {
      title: 'A material assumption is disproved on issue-triggered Rohto decisions',
      scope: rohtoInPharma,
      conditions: { triggerType: ['ISSUE'] },
      characteristic: { kind: 'ASSUMPTION_OUTCOME', criticality: 'MATERIAL', outcome: 'DISPROVED' },
      statement: 'On Rohto decisions triggered by an issue, an assumption of material criticality has been disproved by the outcome.',
      limitations: 'One episode. One case is a hint, not a pattern.',
      authoredByLabel: 'Commercial Director Vietnam (demo)',
    }),
    'P3',
  );
  const link = async (as: Scope, patternId: string, episodeId: string, stance: Parameters<ManagementGenome['linkEpisode']>[3], why: string) =>
    unwrap(await genome.linkEpisode(as, patternId, episodeId, stance, why), `link ${stance}`);
  await link(commercial, p1.pattern.id, e1Open.episode.id, 'SUPPORTING_EPISODE', 'Margin came in 0.6878 pts below the committed figure.');
  await link(commercial, p1.pattern.id, e4Open.episode.id, 'SUPPORTING_EPISODE', 'Margin landed below the commitment; customs handling was not in the quote.');
  await link(commercial, p1.pattern.id, e2Open.episode.id, 'CONTEXTUAL_EPISODE', 'A planned call-off from standard replenishment: not the kind of situation the pattern is about.');
  await link(commercial, p1.pattern.id, e3Open.episode.id, 'CONTEXTUAL_EPISODE', 'Another country: the pattern makes no claim there.');
  d.advanceTo(T.beforeContradictionLinked);
  const p1Linked = await link(finance, p1.pattern.id, e5Open.episode.id, 'CONTRADICTORY_EPISODE', 'With the freight premium priced into the commitment, margin met it.');
  void p1Linked;
  await link(finance, p2.pattern.id, e1Open.episode.id, 'SUPPORTING_EPISODE', "Finance's cost challenge was open when the commitment was made.");
  await link(finance, p2.pattern.id, e4Open.episode.id, 'SUPPORTING_EPISODE', 'The customs-handling challenge was open at commitment.');
  await link(commercial, p3.pattern.id, e1Open.episode.id, 'SUPPORTING_EPISODE', 'The provincial tender was postponed to Q1.');

  // ------------------------------------------------------------ the lessons
  d.advanceTo(T.lessons);
  const episodeRef = (id: string, label: string) => ({ kind: 'MANAGEMENT_EPISODE' as const, id, pin: null, label });
  const l1 = unwrap(
    await genome.recordLesson(commercial, {
      claim: 'When a Vietnam Pharma allocation is expedited, ask Finance to confirm the freight and handling premium is in the commitment before it is made.',
      scope: pharma,
      evidence: [{ kind: 'MANAGEMENT_PATTERN', id: p1.pattern.id, pin: null, label: null }, episodeRef(e1Open.episode.id, 'Rohto Q4'), episodeRef(e5Open.episode.id, 'freight priced in')],
      authoredByLabel: 'Commercial Director Vietnam (demo)',
    }),
    'L1',
  );
  unwrap(await genome.reviewLesson(finance, l1.lesson.id, 'ENDORSED', 'Consistent with the two episodes where the premium was and was not in the commitment.', 'Finance Director Vietnam (demo)'), 'endorse L1');
  const l2 = unwrap(
    await genome.recordLesson(finance, {
      claim: 'Name an owner for every critical assumption before commitment.',
      scope: rohtoInPharma,
      evidence: [episodeRef(e1Open.episode.id, 'Rohto Q4')],
      authoredByLabel: 'Finance Director Vietnam (demo)',
    }),
    'L2',
  );

  const now = async () => ({
    E1: unwrap(await genome.getEpisode(d.admin, e1Open.episode.id), 'E1'),
    E2: unwrap(await genome.getEpisode(d.admin, e2Open.episode.id), 'E2'),
    E3: unwrap(await genome.getEpisode(d.admin, e3Open.episode.id), 'E3'),
    E4: unwrap(await genome.getEpisode(d.admin, e4Open.episode.id), 'E4'),
    E5: unwrap(await genome.getEpisode(d.admin, e5Open.episode.id), 'E5'),
  });
  const episodes = await now();
  const patterns = {
    P1: unwrap(await genome.getPattern(d.admin, p1.pattern.id), 'P1'),
    P2: unwrap(await genome.getPattern(d.admin, p2.pattern.id), 'P2'),
    P3: unwrap(await genome.getPattern(d.admin, p3.pattern.id), 'P3'),
  };
  const lessons = (await genome.listLessons(d.admin)) as Result<readonly LessonView[]>;
  const all = unwrap(lessons, 'lessons');
  return { episodes, patterns, lessons: { L1: all.find((x) => x.lesson.id === l1.lesson.id)!, L2: all.find((x) => x.lesson.id === l2.lesson.id)! } };
}
