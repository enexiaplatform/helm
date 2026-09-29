/**
 * The canonical Meridian decision, as data (ADR-0021 §9).
 *
 * One real management question over the Phase 4 Rohto scenarios: how to fulfil
 * a 4.2B VND order when there are four own units and the order needs twelve.
 *
 * Everything below is either a reference into the scenario runtime — which
 * computed the futures — or a statement a named person made. Nothing here is
 * HELM's opinion:
 *
 *   * the criteria are authored, and the one threshold that exists is marked
 *     DEMO MANAGEMENT POLICY rather than presented as a HELM rule;
 *   * one alternative is honestly UNMODELLED, because HELM cannot yet compute
 *     what replacing a distributor would do;
 *   * one critical assumption is deliberately left unowned, so the readiness
 *     report has something true to complain about;
 *   * one challenge is accepted as a risk and one stays OPEN at commitment;
 *   * the commitment is MANAGEMENT_AUTHORED_DEMO — seeded management input,
 *     not a recommendation the system produced.
 */

import { ok, type Result, type Scope } from '@helm/shared';
import type {
  AcceptedTradeOff,
  Decision,
  DecisionAlternative,
  DecisionAssumption,
  DecisionChallenge,
  DecisionCommitment,
  DecisionCriterion,
  DecisionEvidence,
  RationaleItem,
  ReviewTrigger,
} from './types.ts';
import type { CommitInput, DecisionRuntime } from './port.ts';

export const MERIDIAN_MANAGEMENT_QUESTION =
  'How should Meridian fulfil the Rohto order while balancing service, margin, cash and future inventory optionality?';

const GM = { kind: 'ROLE' as const, label: 'Country GM Vietnam', userId: null };
const SCM = { kind: 'ROLE' as const, label: 'Supply Chain Director Vietnam', userId: null };
const FIN = { kind: 'ROLE' as const, label: 'Finance Director Vietnam', userId: null };
const COM = { kind: 'ROLE' as const, label: 'Commercial Director Vietnam', userId: null };

export type MeridianDecisionResult = {
  decision: Decision;
  revisionId: string;
  alternatives: Record<string, DecisionAlternative>;
  criteria: Record<string, DecisionCriterion>;
  assumptions: Record<string, DecisionAssumption>;
  challenges: Record<string, DecisionChallenge>;
  evidence: readonly DecisionEvidence[];
  commitment: DecisionCommitment | null;
};

/**
 * Builds the decision over already-simulated scenarios.
 *
 * `scenarioIds` maps the Phase 4 scenario keys — expedite, reallocate,
 * alternative-product, delay-delivery — to their ids in this organization.
 */
export async function buildMeridianDecision(
  runtime: DecisionRuntime,
  scope: Scope,
  scenarioIds: Readonly<Record<string, string>>,
  options: {
    commit?: boolean;
    fork?: Partial<Decision['fork']>;
    /**
     * Who signs the commitment, as a label. The identity is always the
     * scope's actor; Phase 6 governance reads that, never this text.
     */
    committedByLabel?: string;
  } = {},
): Promise<Result<MeridianDecisionResult>> {
  const created = await runtime.createDecision(scope, {
    title: 'Rohto Q4 order fulfilment',
    managementQuestion: MERIDIAN_MANAGEMENT_QUESTION,
    context:
      'Rohto Vietnam has a 4.2B VND Q4 tender at 70% probability. Serving it needs twelve units of SKU-X; ' +
      'four are in the HCMC warehouse and eight sit as consignment stock at Distributor D. A provincial ' +
      'tender in the same quarter draws on the same stock.',
    problem: 'Own inventory does not cover the order, and every way of closing the gap costs something elsewhere.',
    scope: 'Vietnam · SKU-X · 2026-Q4',
    triggerType: 'ISSUE',
    triggerRefs: [
      { kind: 'OPPORTUNITY', ref: 'rohto-q4-tender', label: 'Rohto Q4 tender' },
      { kind: 'METRIC', ref: 'InventoryGap', label: 'Inventory gap 8.385714 units' },
    ],
    owner: GM,
    fork: options.fork,
    horizon: {
      decisionDeadline: '2026-09-30',
      effectiveFrom: '2026-10-01',
      expectedOutcomeHorizon: '2026-12-31',
      reviewDate: '2026-10-23',
    },
    objectives: [
      'Serve the Rohto commitment',
      'Protect gross margin in the quarter',
      'Keep the option to serve the provincial tender',
    ],
    reversibility: 'PARTIALLY_REVERSIBLE',
    reversalWindowDays: 14,
    metadata: { canonical: 'meridian-rohto-q4' },
  });
  if (!created.ok) return created;
  const { decision } = created.value;
  const revisionId = created.value.revision.id;

  await runtime.setState(scope, decision.id, 'INVESTIGATING');

  // ---------------------------------------------------------- alternatives
  const alternatives: Record<string, DecisionAlternative> = {};
  const specs: { key: string; label: string; description: string; scenarioKey?: string; unmodelled?: string }[] = [
    {
      key: 'expedite',
      label: 'A — Expedite supply',
      description: 'Air-freight eight units from Supplier A so the order ships from own stock in Q4.',
      scenarioKey: 'expedite',
    },
    {
      key: 'reallocate',
      label: 'B — Reallocate distributor stock',
      description: "Transfer Distributor D's eight consignment units into the HCMC warehouse.",
      scenarioKey: 'reallocate',
    },
    {
      key: 'alternative-product',
      label: 'C — Offer the alternative analyzer',
      description: 'Propose the alternative analyzer, twelve units of which are already on hand.',
      scenarioKey: 'alternative-product',
    },
    {
      key: 'delay',
      label: 'D — Delay delivery to 2027-Q1',
      description: 'Agree a later delivery date with Rohto and fulfil from the next replenishment.',
      scenarioKey: 'delay-delivery',
    },
    {
      key: 'replace-distributor',
      label: 'E — Replace the distributor',
      description:
        'Move the consignment arrangement to another distributor with deeper stock in the north.',
      unmodelled:
        'HELM has no model of a second distributor: no positions, no lead times and no cost basis exist for one, ' +
        'so its future state cannot be computed. The option is on the table and its consequences are not.',
    },
  ];
  for (const spec of specs) {
    const added = await runtime.addAlternative(scope, revisionId, {
      label: spec.label,
      description: spec.description,
      scenarioId: spec.scenarioKey ? scenarioIds[spec.scenarioKey] : null,
      unmodelledReason: spec.unmodelled ?? null,
    });
    if (!added.ok) return added;
    alternatives[spec.key] = added.value;
  }

  await runtime.setState(scope, decision.id, 'MODELLING');

  // --------------------------------------------------------------- criteria
  const criteria: Record<string, DecisionCriterion> = {};
  const criterionSpecs: Parameters<DecisionRuntime['addCriterion']>[2][] = [
    {
      key: 'customer-service',
      name: 'Customer service',
      description: "Share of the quarter's requirement that own stock covers.",
      style: 'HARD_CONSTRAINT',
      required: true,
      metricKey: 'DemandCoverage',
      threshold: 90,
      unit: 'percentage',
      direction: 'HIGHER_IS_BETTER',
      author: GM,
      rationale:
        'DEMO MANAGEMENT POLICY: Vietnam commercial policy sets 90% coverage as the floor on framework accounts. ' +
        'This is a stated management line for the demonstration, not a HELM rule.',
      demoPolicy: true,
      sort: 1,
    },
    {
      key: 'gross-margin',
      name: 'Gross margin %',
      description: 'Margin on the Rohto order as a percentage of expected revenue.',
      style: 'TARGET',
      required: true,
      metricKey: 'GrossMarginPct',
      subjectHint: 'Rohto',
      threshold: 35,
      unit: 'percentage',
      direction: 'HIGHER_IS_BETTER',
      author: FIN,
      rationale: 'The 38% objective allows a 3-point concession on a single framework order; below that the deal is dilutive.',
      demoPolicy: true,
      sort: 2,
    },
    {
      key: 'cash-impact',
      name: 'Cash impact',
      description: 'Net cash effect of serving the order over the horizon.',
      style: 'PREFERENCE',
      metricKey: 'CashImpact',
      subjectHint: 'Rohto',
      unit: 'currency',
      direction: 'HIGHER_IS_BETTER',
      author: FIN,
      rationale: 'Cash is the binding constraint this quarter; less of it tied up is preferred, with no fixed line.',
      sort: 3,
    },
    {
      key: 'feasibility',
      name: 'Feasibility — own stock covers the requirement',
      description: 'Units of the quarter requirement that own stock does not cover.',
      style: 'TARGET',
      required: true,
      metricKey: 'InventoryGap',
      threshold: 0,
      unit: 'units',
      direction: 'LOWER_IS_BETTER',
      author: SCM,
      rationale: 'The quarter should close with no uncovered requirement across both opportunities.',
      sort: 4,
    },
    {
      key: 'inventory-optionality',
      name: 'Inventory optionality',
      description: 'What the option leaves available for the next urgent order in the quarter.',
      style: 'QUALITATIVE',
      required: true,
      direction: 'HIGHER_IS_BETTER',
      author: SCM,
      rationale: 'The provincial tender and any unplanned order draw on the same stock. This is judgement, not a metric HELM holds.',
      sort: 5,
    },
    {
      key: 'strategic-account',
      name: 'Strategic account relationship',
      description: 'Effect on the Rohto framework relationship.',
      style: 'QUALITATIVE',
      direction: 'HIGHER_IS_BETTER',
      author: COM,
      rationale: 'Rohto is the anchor account for the Vietnam framework; the relationship outlives this order.',
      sort: 6,
    },
  ];
  for (const spec of criterionSpecs) {
    const added = await runtime.addCriterion(scope, revisionId, spec);
    if (!added.ok) return added;
    criteria[spec.key] = added.value;
  }

  // ------------------------------------------------ qualitative assessments
  const assessments: {
    criterion: string;
    alternative: string;
    rating: 'STRONG_SUPPORT' | 'SUPPORT' | 'NEUTRAL' | 'CONCERN' | 'STRONG_CONCERN';
    rationale: string;
    author: typeof GM;
  }[] = [
    {
      criterion: 'inventory-optionality',
      alternative: 'expedite',
      rating: 'SUPPORT',
      rationale: "Distributor D's buffer is untouched, so the next urgent order still has stock behind it.",
      author: SCM,
    },
    {
      criterion: 'inventory-optionality',
      alternative: 'reallocate',
      rating: 'CONCERN',
      rationale: "Distributor D's buffer goes to zero. A second urgent order in the quarter would have nothing behind it.",
      author: SCM,
    },
    {
      criterion: 'inventory-optionality',
      alternative: 'alternative-product',
      rating: 'NEUTRAL',
      rationale: 'SKU-X stock is untouched, but twelve units of the alternative are consumed instead.',
      author: SCM,
    },
    {
      criterion: 'inventory-optionality',
      alternative: 'delay',
      rating: 'STRONG_SUPPORT',
      rationale: 'Nothing ships in the quarter, so all own stock stays available for the provincial tender.',
      author: SCM,
    },
    {
      criterion: 'strategic-account',
      alternative: 'expedite',
      rating: 'STRONG_SUPPORT',
      rationale: 'The committed date is met in full from own stock.',
      author: COM,
    },
    {
      criterion: 'strategic-account',
      alternative: 'reallocate',
      rating: 'STRONG_SUPPORT',
      rationale: 'The committed date is met; Rohto sees no difference from expediting.',
      author: COM,
    },
    {
      criterion: 'strategic-account',
      alternative: 'alternative-product',
      rating: 'CONCERN',
      rationale: 'Rohto specified this analyzer. Substituting it re-opens a technical evaluation we already won.',
      author: COM,
    },
    {
      criterion: 'strategic-account',
      alternative: 'delay',
      rating: 'STRONG_CONCERN',
      rationale: 'Missing the committed date on the anchor account puts the framework renewal at risk.',
      author: COM,
    },
  ];
  for (const a of assessments) {
    const done = await runtime.recordAssessment(scope, {
      criterionId: criteria[a.criterion].id,
      alternativeId: alternatives[a.alternative].id,
      rating: a.rating,
      rationale: a.rationale,
      author: a.author,
    });
    if (!done.ok) return done;
  }

  // ------------------------------------------------------------ assumptions
  const assumptions: Record<string, DecisionAssumption> = {};
  const assumptionSpecs: {
    key: string;
    statement: string;
    owner: typeof GM | null;
    source: string;
    rationale: string;
    confidence: number | null;
    criticality: 'CRITICAL' | 'MATERIAL' | 'MINOR';
    alternatives?: string[];
  }[] = [
    {
      key: 'lead-time',
      statement: 'Supplier A can deliver eight units in seven days once the order is expedited.',
      owner: SCM,
      source: 'Supplier A account manager, verbal',
      rationale: 'Air freight from the Osaka hub has run 5–7 days on the last four expedited shipments.',
      confidence: 0.7,
      criticality: 'CRITICAL',
      alternatives: ['expedite'],
    },
    {
      key: 'distributor-release',
      statement: 'Distributor D will release its eight consignment units for the quarter.',
      owner: COM,
      source: 'Distributor D commercial manager, 17 Sep call',
      rationale: 'The consignment agreement allows recall with 5 working days notice; D has agreed in principle.',
      confidence: 0.75,
      criticality: 'CRITICAL',
      alternatives: ['reallocate'],
    },
    {
      key: 'substitution',
      statement: 'Rohto would accept the alternative analyzer at the discounted price.',
      owner: COM,
      source: 'Commercial judgement',
      rationale: 'The alternative meets the published tender specification, but Rohto named the original unit.',
      confidence: 0.6,
      criticality: 'MATERIAL',
      alternatives: ['alternative-product'],
    },
    {
      key: 'tender-material',
      statement: 'The provincial tender remains material this quarter.',
      owner: COM,
      source: 'Tender shortlist published 15 Sep',
      rationale: 'Meridian is on the shortlist; award is expected before the quarter closes.',
      confidence: 0.5,
      criticality: 'MATERIAL',
    },
    {
      // Deliberately unowned: the readiness report should say so.
      key: 'framework-condition',
      statement: 'Rohto treats on-time delivery of this order as a condition of the annual framework agreement.',
      owner: null,
      source: 'Understood in the account team; not written down anywhere',
      rationale: 'It has shaped every option on this list, and nobody has put their name to it.',
      confidence: null,
      criticality: 'CRITICAL',
    },
  ];
  for (const spec of assumptionSpecs) {
    const added = await runtime.addAssumption(scope, revisionId, {
      statement: spec.statement,
      owner: spec.owner ? { kind: spec.owner.kind, label: spec.owner.label, userId: null } : null,
      source: spec.source,
      rationale: spec.rationale,
      confidence: spec.confidence,
      criticality: spec.criticality,
      alternativeIds: (spec.alternatives ?? []).map((k) => alternatives[k].id),
    });
    if (!added.ok) return added;
    assumptions[spec.key] = added.value;
  }

  // -------------------------------------------------------------- evidence
  const evidence: DecisionEvidence[] = [];
  const evidenceSpecs: Parameters<DecisionRuntime['addEvidence']>[2][] = [
    {
      kind: 'POLICY',
      title: 'Vietnam commercial policy — 90% coverage floor on framework accounts',
      detail: 'Seeded for the demonstration as a stated management policy, not a HELM rule.',
      relation: 'SUPPORT',
      targetKind: 'CRITERION',
      targetId: criteria['customer-service'].id,
      sourceSystem: 'helm',
      confidence: 1,
      author: GM,
    },
    {
      kind: 'SUPPLIER_COMMITMENT',
      title: 'Forwarder quote Q-2291 — 80M VND air-freight premium, valid 14 days',
      detail: 'Covers eight units Osaka → HCMC. Customs surcharge is quoted separately.',
      relation: 'SUPPORT',
      targetKind: 'ALTERNATIVE',
      targetId: alternatives['expedite'].id,
      sourceSystem: 'scm',
      sourceRef: 'Q-2291',
      effectiveAt: '2026-09-18T00:00:00.000Z',
      confidence: 0.85,
      author: SCM,
    },
    {
      kind: 'CUSTOMER_COMMUNICATION',
      title: 'Rohto procurement, 18 Sep: the delivery date is firm',
      detail: 'Procurement confirmed that the committed date is a condition of the tender award.',
      relation: 'CHALLENGE',
      targetKind: 'ALTERNATIVE',
      targetId: alternatives['delay'].id,
      sourceSystem: 'memoire',
      effectiveAt: '2026-09-18T00:00:00.000Z',
      confidence: 0.9,
      author: COM,
    },
    {
      kind: 'MARKET_SIGNAL',
      title: 'Provincial tender shortlist published 15 Sep',
      detail: 'Meridian is shortlisted; the award draws on the same SKU-X stock.',
      relation: 'CONTEXTUALIZE',
      targetKind: 'CRITERION',
      targetId: criteria['inventory-optionality'].id,
      sourceSystem: 'market',
      effectiveAt: '2026-09-15T00:00:00.000Z',
      confidence: 0.8,
      author: COM,
    },
  ];
  for (const spec of evidenceSpecs) {
    const added = await runtime.addEvidence(scope, revisionId, spec);
    if (!added.ok) return added;
    evidence.push(added.value);
  }

  // ------------------------------------------------------------- challenges
  const challenges: Record<string, DecisionChallenge> = {};
  const leadTimeChallenge = await runtime.challenge(scope, revisionId, {
    targetKind: 'ASSUMPTION',
    targetId: assumptions['lead-time'].id,
    author: SCM,
    concern:
      'The seven-day expedited lead time is not contractually confirmed with Supplier A. If it slips, expediting ' +
      'delivers nothing the committed date can use.',
  });
  if (!leadTimeChallenge.ok) return leadTimeChallenge;
  const resolved = await runtime.resolveChallenge(scope, leadTimeChallenge.value.id, {
    status: 'ACCEPTED_RISK',
    resolution:
      'Management accepts the risk: no written commitment will be obtained before the decision deadline, and the ' +
      'alternative options do not depend on it.',
  });
  if (!resolved.ok) return resolved;
  challenges['lead-time'] = resolved.value;

  const freightChallenge = await runtime.challenge(scope, revisionId, {
    targetKind: 'ALTERNATIVE',
    targetId: alternatives['reallocate'].id,
    author: FIN,
    concern:
      'The 25M transfer cost is the logistics quote only. Re-labelling the consignment units into hospital tender ' +
      'packs is not in it, so the cash impact may be understated.',
  });
  if (!freightChallenge.ok) return freightChallenge;
  challenges['transfer-cost'] = freightChallenge.value;

  const ready = await runtime.setState(scope, decision.id, 'READY_FOR_DECISION');
  if (!ready.ok) return ready;

  if (options.commit === false) {
    return ok({
      decision: ready.value,
      revisionId,
      alternatives,
      criteria,
      assumptions,
      challenges,
      evidence,
      commitment: null,
    });
  }

  // ------------------------------------------------------------ commitment
  const rationale: RationaleItem[] = [
    {
      kind: 'CRITERION',
      ref: criteria['customer-service'].id,
      label: 'Customer service',
      statement:
        'Reallocation reaches the same modelled coverage as expediting (96.8858%), above the 90% policy line.',
    },
    {
      kind: 'SCENARIO_DELTA',
      ref: criteria['gross-margin'].id,
      label: 'Gross margin %',
      statement: '32.3878% against 30.517% for expediting — 1.8708 points more margin for the same service.',
    },
    {
      kind: 'SCENARIO_DELTA',
      ref: criteria['cash-impact'].id,
      label: 'Cash impact',
      statement: '−1 735 500 000 VND against −1 790 500 000 for expediting: 55 000 000 less cash tied up.',
    },
    {
      kind: 'JUDGEMENT',
      ref: alternatives['delay'].id,
      label: 'Why not D — Delay',
      statement:
        'Delay moves the revenue out of the quarter entirely and misses a date Rohto has confirmed is a condition of the award.',
    },
    {
      kind: 'JUDGEMENT',
      ref: alternatives['alternative-product'].id,
      label: 'Why not C — Alternative analyzer',
      statement: 'Margin falls to 22.9048% and the substitution re-opens a technical evaluation already won.',
    },
    {
      kind: 'ASSUMPTION',
      ref: assumptions['distributor-release'].id,
      label: 'What this rests on',
      statement:
        'Distributor D releasing its eight consignment units (Commercial Director Vietnam, confidence 0.75).',
    },
  ];

  const acceptedTradeOffs: AcceptedTradeOff[] = [
    {
      label: 'Distributor buffer',
      statement:
        "Distributor D's buffer drops to zero. A second urgent order in the quarter would have no consignment stock behind it.",
      criterionId: criteria['inventory-optionality'].id,
      metricKey: 'AvailableInventory',
      givenUp: 'eight consignment units of headroom at Distributor D',
      inFavourOf: '1.8708 points of gross margin and 55M VND of cash, at the same modelled service level',
    },
    {
      label: 'Transfer cost is not fully quoted',
      statement:
        "Finance's challenge stays open: the 25M transfer cost excludes re-labelling, so the cash impact may be understated.",
      criterionId: criteria['cash-impact'].id,
      metricKey: 'CashImpact',
      givenUp: 'certainty about the transfer cost',
      inFavourOf: 'deciding before the 30 September deadline',
    },
  ];

  const reviewTriggers: ReviewTrigger[] = [
    {
      key: 'margin-floor',
      description: 'Gross margin on the Rohto order falls below 30%.',
      kind: 'METRIC_THRESHOLD',
      metricKey: 'GrossMarginPct',
      comparator: 'BELOW',
      threshold: '30',
      byDate: null,
    },
    {
      key: 'distributor-release-slips',
      description: 'Distributor D has not released the units within five working days.',
      kind: 'EVENT',
      metricKey: null,
      comparator: null,
      threshold: null,
      byDate: null,
    },
    {
      key: 'thirty-day-review',
      description: 'Review thirty days after the commitment regardless of what happens.',
      kind: 'DATE',
      metricKey: null,
      comparator: null,
      threshold: null,
      byDate: '2026-10-23',
    },
  ];

  const commitInput: CommitInput = {
    chosenAlternativeId: alternatives['reallocate'].id,
    authorship: 'MANAGEMENT_AUTHORED_DEMO',
    committedByLabel: options.committedByLabel ?? 'Country GM Vietnam',
    summary:
      'Reallocate Distributor D’s consignment stock to serve the Rohto order in Q4, accepting that the distributor buffer goes to zero.',
    rationale,
    acceptedTradeOffs,
    expectedOutcomes: [
      { label: 'Gross margin %', kind: 'MODELLED', metricKey: 'GrossMarginPct', subjectHint: 'Rohto' },
      { label: 'Customer service', kind: 'MODELLED', metricKey: 'DemandCoverage' },
      { label: 'Cash impact', kind: 'MODELLED', metricKey: 'CashImpact', subjectHint: 'Rohto' },
      {
        label: 'Framework relationship',
        kind: 'QUALITATIVE',
        statement: 'Rohto sees the committed date met in full; the framework renewal conversation is unaffected.',
      },
    ],
    reviewTriggers,
    actionIntents: [
      {
        title: 'Recall and transfer eight consignment units from Distributor D to HCMC',
        detail: 'Five working days notice under the consignment agreement.',
        ownerLabel: 'Supply Chain Director Vietnam',
        dueDate: '2026-10-02',
        targetSystem: 'scm',
      },
      {
        title: 'Confirm the delivery date with Rohto procurement',
        detail: 'HELM records the intent; the customer conversation happens in Memoire.',
        ownerLabel: 'Commercial Director Vietnam',
        dueDate: '2026-09-26',
        targetSystem: 'memoire',
      },
      {
        title: 'Update the quarter inventory exposure and cash forecast',
        detail: 'Reflect the transfer cost and the reduced consignment position.',
        ownerLabel: 'Finance Director Vietnam',
        dueDate: '2026-10-05',
        targetSystem: 'finance',
      },
    ],
    acknowledgeOpenChallenges: true,
  };

  const committed = await runtime.commit(scope, revisionId, commitInput);
  if (!committed.ok) return committed;

  const after = await runtime.getDecision(scope, decision.id);
  if (!after.ok) return after;

  return ok({
    decision: after.value ?? ready.value,
    revisionId,
    alternatives,
    criteria,
    assumptions,
    challenges,
    evidence,
    commitment: committed.value.commitment,
  });
}
