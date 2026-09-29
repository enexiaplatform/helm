/**
 * DEMO CAUSAL HYPOTHESES — the Rohto causal investigation (Phase 8).
 *
 * Everything here is DEMO data, labelled as such in every record. None of it
 * came from a company's books: the invoices, ledgers, analyses and judgements
 * are illustrative, and they enter HELM exactly as real evidence would.
 *
 * It continues the Phase 7 twin story. On 12 Jan 2027 Finance closed Q4:
 * Rohto gross margin 31.7 % against 32.3878 % committed (−0.6878 pts). The
 * twin already explains the ARITHMETIC — fulfilment cost came in at
 * 185 220 000 VND against the 165 000 000 VND the committed run planned
 * (SCM's 140 000 000 estimate plus the 25 000 000 transfer allowance), and
 * nothing else in the model moved. Phase 8 asks the different question:
 * WHY did fulfilment cost rise?
 *
 *   13 Jan 2027  Finance asks it. The Supply Director proposes H1 (expedited
 *                transfer by air) on judgement alone → HYPOTHESIS.
 *   14 Jan       Finance proposes H2 (supplier surcharge) and H3 (customs
 *                handling), and states C2 — fulfilment cost DECREASES margin.
 *   15 Jan       The Commercial Director states C3 — faster delivery
 *                protects Rohto's service outcome — behind a decision
 *                assumption. Judgement only → HYPOTHESIS.
 *   20 Jan       SCM files the air-freight invoice and a repeated-pattern
 *                analysis → H1 SUPPORTED. H2's invoice search finds nothing
 *                → UNRESOLVED. H3's ledger line is met by a judgement that
 *                the fee was already estimated → UNRESOLVED.
 *   22 Jan       Procurement proposes H4 (the January supplier price
 *                revision). It took effect AFTER the Q4 cost was recorded →
 *                TEMPORAL_CONFLICT → WEAKENED.
 *   25 Jan       Industrial: a discount raised volume → SUPPORTED …
 *    5 Feb       … until Finance's comparison with accounts that got no
 *                discount contradicts it → CONTESTED; Finance's competing
 *                claim (market demand) is stored beside it, not merged.
 *   10 Feb       A service feedback loop is stated (a cycle, kept).
 *   12 Feb       Inventory allocation changed and satisfaction improved in
 *                the same quarter: recorded as a CORRELATION, and a
 *                question with no candidate. No causal claim is created.
 */

import { ok, type Result, type Scope, type UserId } from '@helm/shared';
import type { DecisionAssumption } from '@helm/decision-runtime';
import type { CausalGraph, ClaimView, RecordEvidenceInput } from './port.ts';
import type { CausalEvidence, CausalQuestion, CorrelationFinding, ScopeAnchor } from './types.ts';

export const DEMO_CAUSAL_LABEL = 'DEMO CAUSAL HYPOTHESES';

export const MERIDIAN_CAUSAL_TIMES = {
  asked: '2027-01-13T02:00:00.000Z',
  financeHypotheses: '2027-01-14T02:00:00.000Z',
  serviceBelief: '2027-01-15T02:00:00.000Z',
  scmEvidence: '2027-01-20T02:00:00.000Z',
  priceRevision: '2027-01-22T02:00:00.000Z',
  discountSupported: '2027-01-25T02:00:00.000Z',
  discountContradicted: '2027-02-05T02:00:00.000Z',
  loop: '2027-02-10T02:00:00.000Z',
  coincidence: '2027-02-12T02:00:00.000Z',
  /** Business time of the Q4 fulfilment-cost actual in the twin story. */
  q4CostRecorded: '2027-01-10T00:00:00.000Z',
  /** T1 of the historical-knowledge proof: after H1 was proposed, before SCM's evidence. */
  beforeScmEvidence: '2027-01-19T00:00:00.000Z',
  /** Between the discount's support and its contradiction. */
  beforeContradiction: '2027-02-01T00:00:00.000Z',
} as const;

type Anchor = { entityId: string; label: string };

export type MeridianCausalDeps = {
  readonly causal: CausalGraph;
  readonly admin: Scope;
  readonly as: (userId: UserId) => Scope;
  readonly users: { readonly countryGM: UserId; readonly commercialDirector: UserId; readonly financeDirector: UserId; readonly industrialHead: UserId };
  readonly entities: { readonly vn: Anchor; readonly buPharma: Anchor; readonly rohto: Anchor; readonly buIndustrial: Anchor; readonly buThPharma: Anchor };
  readonly nodeIds: { readonly freightOpex: string; readonly grossMarginPctOpp: string };
  readonly twin: { readonly decisionId: string; readonly cf1SnapshotId: string; readonly s2SnapshotId: string; readonly fulfilmentItemKey: string };
  readonly assumptions: readonly DecisionAssumption[];
  readonly advanceTo: (iso: string) => void;
};

export type MeridianCausalStory = {
  readonly claims: Readonly<Record<'H1' | 'H2' | 'H3' | 'H4' | 'C2' | 'C3' | 'M1' | 'MED' | 'D1' | 'D2' | 'L1' | 'L2' | 'L3' | 'L4', ClaimView>>;
  readonly evidence: Readonly<Record<string, CausalEvidence>>;
  readonly questions: { readonly fulfilment: CausalQuestion; readonly satisfaction: CausalQuestion };
  readonly correlation: CorrelationFinding;
  readonly serviceAssumption: DecisionAssumption | null;
};

const unwrapOr = <T>(r: Result<T>, what: string): T => {
  if (!r.ok) throw new Error(`causal story — ${what}: ${r.error.code} ${r.error.message}`);
  return r.value;
};

export async function runMeridianCausalStory(d: MeridianCausalDeps): Promise<Result<MeridianCausalStory>> {
  try {
    return ok(await story(d));
  } catch (e) {
    return { ok: false, error: { code: 'causal.demo_story', message: (e as Error).message } };
  }
}

async function story(d: MeridianCausalDeps): Promise<MeridianCausalStory> {
  const { causal } = d;
  const T = MERIDIAN_CAUSAL_TIMES;
  const finance = d.as(d.users.financeDirector);
  const commercial = d.as(d.users.commercialDirector);
  const industrial = d.as(d.users.industrialHead);
  const supply = d.admin; // the demo Supply Director acts through the demo admin identity, labelled
  const anchor = (a: Anchor): ScopeAnchor => ({ entityId: a.entityId, label: a.label, dimension: '' });
  const pharma = { kind: 'ANCHORED' as const, anchors: [anchor(d.entities.buPharma)] };
  const rohtoInPharma = { kind: 'ANCHORED' as const, anchors: [anchor(d.entities.buPharma), anchor(d.entities.rohto)] };
  const industrialScope = { kind: 'ANCHORED' as const, anchors: [anchor(d.entities.buIndustrial)] };
  const vietnam = { kind: 'ANCHORED' as const, anchors: [anchor(d.entities.vn)] };
  const demo = (ref: string) => `${DEMO_CAUSAL_LABEL} · ${ref}`;
  const evidence: Record<string, CausalEvidence> = {};
  const record = async (s: Scope, key: string, input: RecordEvidenceInput) => {
    evidence[key] = unwrapOr(await causal.recordEvidence(s, input), `evidence ${key}`);
    return evidence[key];
  };

  // ------------------------------------------------------------ variables
  d.advanceTo(T.asked);
  const variable = async (key: string, label: string, kind: 'METRIC' | 'ACTION' | 'CONDITION' | 'EVENT' | 'OUTCOME', extra: { metricKey?: string; nodeId?: string; description?: string } = {}) =>
    unwrapOr(
      await causal.defineVariable(d.admin, {
        key,
        label,
        kind,
        metricKey: extra.metricKey ?? null,
        description: extra.description ?? '',
        refs: extra.nodeId ? [{ kind: 'VALUE_NODE', id: extra.nodeId, pin: null, label }] : [],
      }),
      `variable ${key}`,
    );
  await variable('FULFILMENT_COST', 'Fulfilment cost', 'METRIC', { metricKey: 'Opex', nodeId: d.nodeIds.freightOpex, description: 'Incremental cost of fulfilling the Rohto order (the model\'s fulfilment_cost input).' });
  await variable('GROSS_MARGIN_PCT', 'Gross margin %', 'METRIC', { metricKey: 'GrossMarginPct', nodeId: d.nodeIds.grossMarginPctOpp });
  await variable('EXPEDITED_TRANSFER', 'Expedited transfer of stock', 'ACTION', { description: 'Moving stock between warehouses faster than the standard road transfer.' });
  await variable('AIR_FREIGHT_USAGE', 'Air-freight usage', 'EVENT');
  await variable('SUPPLIER_SURCHARGE', 'Supplier surcharge', 'EVENT');
  await variable('CUSTOMS_HANDLING', 'Customs and handling charges', 'EVENT');
  await variable('SUPPLIER_PRICE_REVISION', 'January 2027 supplier price revision', 'EVENT');
  await variable('DELIVERY_SPEED', 'Delivery speed', 'CONDITION', { description: 'How quickly an order reaches the customer.' });
  await variable('SERVICE_LEVEL', 'Service level', 'METRIC', { metricKey: 'ServiceLevel' });
  await variable('PRICE_DISCOUNT', 'Price discount', 'ACTION');
  await variable('SALES_VOLUME', 'Sales volume', 'OUTCOME');
  await variable('MARKET_DEMAND', 'Market demand', 'CONDITION');
  await variable('SERVICE_FAILURE', 'Service failure', 'EVENT');
  await variable('CUSTOMER_CHURN', 'Customer churn', 'OUTCOME');
  await variable('REVENUE_PRESSURE', 'Revenue pressure', 'CONDITION');
  await variable('COST_CUTTING', 'Cost cutting', 'ACTION');
  await variable('INVENTORY_ALLOCATION_CHANGE', 'Change in inventory allocation', 'ACTION');
  await variable('CUSTOMER_SATISFACTION', 'Customer satisfaction', 'OUTCOME');

  // ------------------------------------------------------------ 13 Jan: the question, and H1 on judgement
  const fulfilment = unwrapOr(
    await causal.askQuestion(finance, {
      statement:
        'Why did Q4 fulfilment cost for the Rohto order come in 20 220 000 VND above the committed plan ' +
        '(45 220 000 VND above SCM\'s original 140 000 000 VND estimate)?',
      target: {
        variableKey: 'FULFILMENT_COST',
        metricKey: 'Opex',
        nodeId: d.nodeIds.freightOpex,
        fromSnapshotId: d.twin.cf1SnapshotId,
        toSnapshotId: d.twin.s2SnapshotId,
        itemKey: d.twin.fulfilmentItemKey,
        observedChange: '+20220000',
        unit: 'VND',
      },
      scope: rohtoInPharma,
      period: { from: '2026-10-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' },
    }),
    'question',
  );
  const H1 = unwrapOr(
    await causal.createClaim(supply, {
      causeKey: 'EXPEDITED_TRANSFER',
      effectKey: 'FULFILMENT_COST',
      relationshipType: 'INCREASES',
      scope: rohtoInPharma,
      conditions: [{ statement: 'WHEN the transfer is flown rather than trucked', refs: [] }],
      authoredByLabel: 'Supply Director Vietnam (demo)',
      statement: 'Expediting the stock transfer by air increased the Rohto order\'s fulfilment cost.',
      mechanism: [
        { variableKey: 'EXPEDITED_TRANSFER', description: 'the transfer to meet the committed date was expedited' },
        { variableKey: 'AIR_FREIGHT_USAGE', description: 'it went by air instead of by road' },
        { variableKey: 'FULFILMENT_COST', description: 'the air-freight surcharge is booked as fulfilment cost' },
      ],
      rationale: 'The committed plan priced a road transfer; the date could only be met by flying the units.',
      externalValidity: 'Supported, if at all, for Vietnam Pharma transfers on this lane; external validity unknown.',
      links: [
        { kind: 'TWIN_SNAPSHOT', id: d.twin.cf1SnapshotId, pin: null, label: 'CF1 — the committed future' },
        { kind: 'TWIN_SNAPSHOT', id: d.twin.s2SnapshotId, pin: null, label: 'S2 — after the Q4 outcome' },
        { kind: 'VALUE_NODE', id: d.nodeIds.freightOpex, pin: null, label: 'Fulfilment cost' },
        { kind: 'ENTITY', id: d.entities.rohto.entityId, pin: null, label: d.entities.rohto.label },
      ],
    }),
    'H1',
  );
  await record(supply, 'E1', {
    type: 'MANAGEMENT_EXPERTISE',
    statement: 'Supply Director: an expedited transfer on the Hanoi–HCMC lane normally goes by air, at roughly three times the road cost.',
    assessedStrength: 'LOW',
    strengthRationale: 'Experienced judgement, not a measurement of this order.',
    provenance: { sourceSystem: 'manual', sourceReference: demo('judgement recorded 13 Jan 2027'), method: 'JUDGEMENT', assertedByLabel: 'Supply Director Vietnam (demo)', assertedRole: 'Supply Director' },
  });
  unwrapOr(await causal.supportClaim(supply, H1.claim.id, evidence.E1.id, 'The lane and the practice match this order.'), 'H1+E1');
  unwrapOr(await causal.proposeCandidate(supply, fulfilment.id, H1.claim.id, 'The committed plan priced a road transfer.'), 'Q1 ← H1');

  // ------------------------------------------------------------ 14 Jan: Finance's hypotheses and C2
  d.advanceTo(T.financeHypotheses);
  const H2 = unwrapOr(
    await causal.createClaim(finance, {
      causeKey: 'SUPPLIER_SURCHARGE',
      effectKey: 'FULFILMENT_COST',
      relationshipType: 'INCREASES',
      scope: rohtoInPharma,
      authoredByLabel: 'Finance Director Vietnam (demo)',
      statement: 'A supplier surcharge on the rush replenishment increased the Rohto order\'s fulfilment cost.',
      rationale: 'Supplier A has charged rush surcharges before.',
      links: [{ kind: 'TWIN_SNAPSHOT', id: d.twin.s2SnapshotId, pin: null, label: 'S2 — after the Q4 outcome' }],
    }),
    'H2',
  );
  const H3 = unwrapOr(
    await causal.createClaim(finance, {
      causeKey: 'CUSTOMS_HANDLING',
      effectKey: 'FULFILMENT_COST',
      relationshipType: 'INCREASES',
      scope: rohtoInPharma,
      authoredByLabel: 'Finance Director Vietnam (demo)',
      statement: 'Customs and handling charges on the re-labelled lot increased the Rohto order\'s fulfilment cost.',
      rationale: 'The re-labelled lot was re-inspected, and inspection carries handling fees.',
      links: [{ kind: 'TWIN_SNAPSHOT', id: d.twin.s2SnapshotId, pin: null, label: 'S2 — after the Q4 outcome' }],
    }),
    'H3',
  );
  unwrapOr(await causal.proposeCandidate(finance, fulfilment.id, H2.claim.id, 'Rush replenishment was ordered in October.'), 'Q1 ← H2');
  unwrapOr(await causal.proposeCandidate(finance, fulfilment.id, H3.claim.id, 'The lot was re-labelled and re-inspected.'), 'Q1 ← H3');
  await record(finance, 'E4', {
    type: 'MANAGEMENT_EXPERTISE',
    statement: 'Procurement: Supplier A applied a rush surcharge on two orders in 2025.',
    assessedStrength: 'LOW',
    strengthRationale: 'Recollection of earlier orders, not a record of this one.',
    provenance: { sourceSystem: 'manual', sourceReference: demo('procurement judgement, 14 Jan 2027'), method: 'JUDGEMENT', assertedByLabel: 'Procurement Lead Vietnam (demo)', assertedRole: 'Procurement Lead' },
  });
  unwrapOr(await causal.supportClaim(finance, H2.claim.id, evidence.E4.id, 'A surcharge would be consistent with the supplier\'s history.'), 'H2+E4');

  const C2 = unwrapOr(
    await causal.createClaim(finance, {
      causeKey: 'FULFILMENT_COST',
      effectKey: 'GROSS_MARGIN_PCT',
      relationshipType: 'DECREASES',
      scope: pharma,
      authoredByLabel: 'Finance Director Vietnam (demo)',
      statement: 'Higher fulfilment cost lowers realised tender gross margin in Vietnam Pharma.',
      rationale: 'Fulfilment cost is booked in cost of sales for tenders, and tenders are fixed-price.',
      externalValidity: 'Stated for Vietnam Pharma tenders, which are fixed-price; not for price-adjustable contracts.',
    }),
    'C2',
  );
  await record(finance, 'E8', {
    type: 'PROCESS_MECHANISM',
    statement: 'Finance accounting policy: incremental fulfilment cost of a fixed-price tender is booked in cost of sales, not recovered through price.',
    assessedStrength: 'MEDIUM',
    strengthRationale: 'Documents how the cost reaches margin; says nothing about how much.',
    provenance: { sourceSystem: 'finance', sourceReference: demo('accounting policy FIN-POL-07'), method: 'DOCUMENT', assertedByLabel: 'Finance Director Vietnam (demo)', assertedRole: 'Finance Director' },
    sensitivity: 'FINANCIAL_SENSITIVE',
  });
  await record(finance, 'E9', {
    type: 'LONGITUDINAL_OBSERVATION',
    statement: 'Eight quarters of Vietnam Pharma tenders: in every quarter per-order fulfilment cost rose, realised tender margin fell.',
    assessedStrength: 'MEDIUM',
    strengthRationale: 'Same population over time; other cost drivers were not controlled.',
    provenance: { sourceSystem: 'finance', sourceReference: demo('tender margin review 2025–2026'), method: 'ANALYSIS', assertedByLabel: 'Finance Director Vietnam (demo)', assertedRole: 'Finance Director' },
    sensitivity: 'FINANCIAL_SENSITIVE',
  });
  unwrapOr(await causal.supportClaim(finance, C2.claim.id, evidence.E8.id, 'The mechanism by which the cost reaches margin.'), 'C2+E8');
  unwrapOr(await causal.supportClaim(finance, C2.claim.id, evidence.E9.id, 'The relationship held over eight quarters.'), 'C2+E9');

  // ------------------------------------------------------------ 15 Jan: C3 behind a decision assumption
  d.advanceTo(T.serviceBelief);
  const serviceAssumption = d.assumptions.find((a) => /on-time delivery/.test(a.statement)) ?? null;
  const C3 = unwrapOr(
    await causal.createClaim(commercial, {
      causeKey: 'DELIVERY_SPEED',
      effectKey: 'SERVICE_LEVEL',
      relationshipType: 'INCREASES',
      scope: rohtoInPharma,
      authoredByLabel: 'Commercial Director Vietnam (demo)',
      statement: 'Faster delivery improves Rohto\'s service outcome.',
      rationale: 'Rohto ties the framework agreement to on-time delivery.',
      links: [
        { kind: 'DECISION', id: d.twin.decisionId, pin: null, label: 'The Rohto allocation decision' },
        ...(serviceAssumption ? [{ kind: 'ASSUMPTION' as const, id: serviceAssumption.id, pin: serviceAssumption.decisionId, label: serviceAssumption.statement }] : []),
      ],
    }),
    'C3',
  );
  await record(commercial, 'E10', {
    type: 'MANAGEMENT_EXPERTISE',
    statement: 'Commercial Director: Rohto\'s buyer said at the quarterly review that late deliveries weigh on the framework renewal.',
    assessedStrength: 'LOW',
    strengthRationale: 'A reported remark, not a measured service outcome.',
    provenance: { sourceSystem: 'manual', sourceReference: demo('QBR notes, Q3 2026'), method: 'JUDGEMENT', assertedByLabel: 'Commercial Director Vietnam (demo)', assertedRole: 'Commercial Director' },
  });
  unwrapOr(await causal.supportClaim(commercial, C3.claim.id, evidence.E10.id, 'The customer said so.'), 'C3+E10');

  // ------------------------------------------------------------ 20 Jan: SCM's evidence
  d.advanceTo(T.scmEvidence);
  await record(supply, 'E2', {
    type: 'PROCESS_MECHANISM',
    statement: 'SCM freight invoice: the eight transferred units were flown Hanoi → HCMC on 8 Oct 2026; the invoice carries an air-freight charge.',
    assessedStrength: 'MEDIUM',
    strengthRationale: 'A source document showing the mechanism in this very order; it does not say how much of the overrun it explains.',
    provenance: { sourceSystem: 'scm', sourceReference: demo('freight invoice INV-DEMO-AF-1008'), method: 'DOCUMENT', assertedByLabel: 'SCM Logistics (demo)', assertedRole: 'Logistics' },
    causeObservedAt: '2026-10-08T00:00:00.000Z',
    effectObservedAt: '2026-10-12T00:00:00.000Z',
    refs: [{ kind: 'SOURCE_DOCUMENT', id: 'INV-DEMO-AF-1008', pin: null, label: 'freight invoice (demo)' }],
    sensitivity: 'FINANCIAL_SENSITIVE',
  });
  await record(supply, 'E3', {
    type: 'REPEATED_PATTERN',
    statement: 'SCM analysis: all six expedited Vietnam Pharma transfers in 2025 cost more to fulfil than road transfers on the same lanes.',
    assessedStrength: 'MEDIUM',
    strengthRationale: 'Consistent, but observational: urgent orders may differ in other ways.',
    provenance: { sourceSystem: 'scm', sourceReference: demo('expedite cost review 2025'), method: 'ANALYSIS', assertedByLabel: 'SCM Logistics (demo)', assertedRole: 'Logistics' },
  });
  unwrapOr(await causal.supportClaim(supply, H1.claim.id, evidence.E2.id, 'The transfer was in fact flown.'), 'H1+E2');
  unwrapOr(await causal.supportClaim(supply, H1.claim.id, evidence.E3.id, 'Expedited transfers have cost more every time.'), 'H1+E3');

  const M1 = unwrapOr(
    await causal.createClaim(supply, {
      causeKey: 'EXPEDITED_TRANSFER',
      effectKey: 'AIR_FREIGHT_USAGE',
      relationshipType: 'INCREASES',
      scope: pharma,
      authoredByLabel: 'Supply Director Vietnam (demo)',
      statement: 'Expediting a transfer in Vietnam Pharma leads to it being flown.',
      rationale: 'Road cannot meet an expedited date on the long lanes.',
    }),
    'M1',
  );
  unwrapOr(await causal.supportClaim(supply, M1.claim.id, evidence.E2.id, 'This expedited transfer was flown.'), 'M1+E2');
  const MED = unwrapOr(
    await causal.createClaim(supply, {
      causeKey: 'AIR_FREIGHT_USAGE',
      effectKey: 'FULFILMENT_COST',
      relationshipType: 'MEDIATES',
      targetClaimId: H1.claim.id,
      scope: rohtoInPharma,
      authoredByLabel: 'Supply Director Vietnam (demo)',
      statement: 'Air-freight usage is the path by which expediting raised fulfilment cost.',
      rationale: 'The extra cost is the air-freight charge; nothing else about expediting is billed.',
    }),
    'MED',
  );
  unwrapOr(await causal.supportClaim(supply, MED.claim.id, evidence.E2.id, 'The invoice line is an air-freight charge.'), 'MED+E2');

  await record(finance, 'E5', {
    type: 'PROCESS_MECHANISM',
    statement: 'Procurement searched every Q4 invoice from Supplier A for the Rohto lot: no surcharge line was found.',
    assessedStrength: 'LOW',
    strengthRationale: 'An absence in the records searched; a surcharge could have been billed elsewhere.',
    provenance: { sourceSystem: 'erp', sourceReference: demo('invoice search, 20 Jan 2027'), method: 'DOCUMENT', assertedByLabel: 'Procurement Lead Vietnam (demo)', assertedRole: 'Procurement Lead' },
  });
  unwrapOr(await causal.challengeClaim(finance, H2.claim.id, evidence.E5.id, 'No invoice shows the surcharge.'), 'H2−E5');
  await record(finance, 'E6', {
    type: 'PROCESS_MECHANISM',
    statement: 'Finance ledger: a customs-handling adjustment was booked against the Rohto shipment on 18 Nov 2026.',
    assessedStrength: 'MEDIUM',
    strengthRationale: 'A ledger line on this shipment; it does not say whether the fee was already in the estimate.',
    provenance: { sourceSystem: 'finance', sourceReference: demo('ledger adjustment JE-DEMO-1118'), method: 'DOCUMENT', assertedByLabel: 'Finance Director Vietnam (demo)', assertedRole: 'Finance Director' },
    causeObservedAt: '2026-11-18T00:00:00.000Z',
    effectObservedAt: T.q4CostRecorded,
    sensitivity: 'FINANCIAL_SENSITIVE',
  });
  await record(supply, 'E7', {
    type: 'MANAGEMENT_EXPERTISE',
    statement: 'Logistics lead: customs handling is a fixed per-shipment fee and was already inside SCM\'s 140 000 000 VND estimate.',
    assessedStrength: 'LOW',
    strengthRationale: 'Judgement about how the estimate was built.',
    provenance: { sourceSystem: 'manual', sourceReference: demo('logistics judgement, 20 Jan 2027'), method: 'JUDGEMENT', assertedByLabel: 'Logistics Lead Vietnam (demo)', assertedRole: 'Logistics Lead' },
  });
  unwrapOr(await causal.supportClaim(finance, H3.claim.id, evidence.E6.id, 'A customs-handling charge was booked on this shipment.'), 'H3+E6');
  unwrapOr(await causal.challengeClaim(supply, H3.claim.id, evidence.E7.id, 'The fee may already have been estimated.'), 'H3−E7');

  // ------------------------------------------------------------ 22 Jan: H4, impossible in time
  d.advanceTo(T.priceRevision);
  const H4 = unwrapOr(
    await causal.createClaim(finance, {
      causeKey: 'SUPPLIER_PRICE_REVISION',
      effectKey: 'FULFILMENT_COST',
      relationshipType: 'INCREASES',
      scope: rohtoInPharma,
      applicablePeriod: { from: '2026-10-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' },
      authoredByLabel: 'Procurement Lead Vietnam (demo)',
      statement: 'Supplier A\'s price revision raised the Rohto order\'s Q4 fulfilment cost.',
      rationale: 'The supplier announced higher logistics rates.',
    }),
    'H4',
  );
  await record(finance, 'E14', {
    type: 'PROCESS_MECHANISM',
    statement: 'Supplier A\'s price-revision notice: new logistics rates effective 20 Jan 2027.',
    assessedStrength: 'MEDIUM',
    strengthRationale: 'A dated source document.',
    provenance: { sourceSystem: 'erp', sourceReference: demo('supplier notice SUP-A-2027-01'), method: 'DOCUMENT', assertedByLabel: 'Procurement Lead Vietnam (demo)', assertedRole: 'Procurement Lead' },
    causeObservedAt: '2027-01-20T00:00:00.000Z',
    effectObservedAt: T.q4CostRecorded,
  });
  unwrapOr(await causal.supportClaim(finance, H4.claim.id, evidence.E14.id, 'The supplier raised its rates.'), 'H4+E14');
  unwrapOr(await causal.proposeCandidate(finance, fulfilment.id, H4.claim.id, 'The supplier raised its rates.'), 'Q1 ← H4');

  // ------------------------------------------------------------ 25 Jan → 5 Feb: support, then contradiction
  d.advanceTo(T.discountSupported);
  const D1 = unwrapOr(
    await causal.createClaim(industrial, {
      causeKey: 'PRICE_DISCOUNT',
      effectKey: 'SALES_VOLUME',
      relationshipType: 'INCREASES',
      scope: industrialScope,
      conditions: [{ statement: 'WHEN the segment is price-sensitive', refs: [] }],
      authoredByLabel: 'Industrial BU Head Vietnam (demo)',
      statement: 'The Q3 price discount raised Industrial BU sales volume.',
      confounders: [{ variableKey: 'MARKET_DEMAND', note: 'Demand recovered in the same quarter and drives both discounting decisions and volume.' }],
      rationale: 'Volume rose the quarter the discount ran.',
    }),
    'D1',
  );
  await record(industrial, 'E11', {
    type: 'INTERVENTION',
    statement: 'Industrial BU ran a 5 % discount in Q3 2026; volume rose 12 % on Q2.',
    assessedStrength: 'MEDIUM',
    strengthRationale: 'A deliberate change, but nothing else was held constant.',
    provenance: { sourceSystem: 'erp', sourceReference: demo('Industrial promo review Q3 2026'), method: 'ANALYSIS', assertedByLabel: 'Industrial BU Head Vietnam (demo)', assertedRole: 'BU Head' },
    causeObservedAt: '2026-07-01T00:00:00.000Z',
    effectObservedAt: '2026-09-30T00:00:00.000Z',
  });
  await record(industrial, 'E12', {
    type: 'REPEATED_PATTERN',
    statement: 'The three earlier Industrial promotions were each followed by a volume rise.',
    assessedStrength: 'MEDIUM',
    strengthRationale: 'Repeated, observational.',
    provenance: { sourceSystem: 'erp', sourceReference: demo('promotion history 2024–2026'), method: 'ANALYSIS', assertedByLabel: 'Industrial BU Head Vietnam (demo)', assertedRole: 'BU Head' },
  });
  unwrapOr(await causal.supportClaim(industrial, D1.claim.id, evidence.E11.id, 'Volume rose while the discount ran.'), 'D1+E11');
  unwrapOr(await causal.supportClaim(industrial, D1.claim.id, evidence.E12.id, 'It has happened before.'), 'D1+E12');

  d.advanceTo(T.discountContradicted);
  const D2 = unwrapOr(
    await causal.createClaim(finance, {
      causeKey: 'MARKET_DEMAND',
      effectKey: 'SALES_VOLUME',
      relationshipType: 'INCREASES',
      scope: industrialScope,
      authoredByLabel: 'Finance Director Vietnam (demo)',
      statement: 'Recovering market demand, not the discount, raised Industrial BU volume in Q3.',
      rationale: 'Accounts that were not offered the discount grew as fast.',
    }),
    'D2',
  );
  await record(finance, 'E13', {
    type: 'NATURAL_EXPERIMENT',
    statement: 'Industrial accounts that were not offered the Q3 discount grew volume 11 % in the same quarter.',
    assessedStrength: 'MEDIUM',
    strengthRationale: 'A comparable untreated group, but the groups were not assigned at random.',
    provenance: { sourceSystem: 'finance', sourceReference: demo('treated vs untreated accounts, Q3 2026'), method: 'ANALYSIS', assertedByLabel: 'Finance Director Vietnam (demo)', assertedRole: 'Finance Director' },
    causeObservedAt: '2026-07-01T00:00:00.000Z',
    effectObservedAt: '2026-09-30T00:00:00.000Z',
  });
  unwrapOr(await causal.linkEvidence(finance, D1.claim.id, evidence.E13.id, 'CONTRADICTS', 'Untreated accounts grew as fast; the discount does not explain the rise.'), 'D1×E13');
  unwrapOr(await causal.supportClaim(finance, D2.claim.id, evidence.E13.id, 'Growth without the discount points to demand.'), 'D2+E13');

  // ------------------------------------------------------------ 10 Feb: a feedback loop
  d.advanceTo(T.loop);
  const loop = async (cause: string, effect: string, statement: string) =>
    unwrapOr(
      await causal.createClaim(d.admin, {
        causeKey: cause,
        effectKey: effect,
        relationshipType: 'INCREASES',
        scope: vietnam,
        authoredByLabel: 'Country GM Vietnam (demo)',
        statement,
        rationale: 'A loop the leadership team described in the Q4 review.',
      }),
      `loop ${cause}`,
    );
  const L1 = await loop('SERVICE_FAILURE', 'CUSTOMER_CHURN', 'Service failures increase customer churn.');
  const L2 = await loop('CUSTOMER_CHURN', 'REVENUE_PRESSURE', 'Churn increases revenue pressure.');
  const L3 = await loop('REVENUE_PRESSURE', 'COST_CUTTING', 'Revenue pressure increases cost cutting.');
  const L4 = await loop('COST_CUTTING', 'SERVICE_FAILURE', 'Cost cutting increases service failures.');

  // ------------------------------------------------------------ 12 Feb: a coincidence, kept as one
  d.advanceTo(T.coincidence);
  const correlation = unwrapOr(
    await causal.recordCorrelation(finance, {
      xKey: 'INVENTORY_ALLOCATION_CHANGE',
      yKey: 'CUSTOMER_SATISFACTION',
      direction: 'POSITIVE',
      method: 'co-movement in one quarter',
      population: 'Vietnam Pharma key accounts',
      period: '2026-Q4',
      effectEstimate: 'allocation changed; satisfaction survey +6 points',
      uncertainty: 'one quarter, one survey wave',
      limitations: 'Two things changed in the same quarter. Nothing about influence is known.',
      scope: pharma,
    }),
    'correlation',
  );
  const satisfaction = unwrapOr(
    await causal.askQuestion(commercial, {
      statement: 'Why did Vietnam Pharma key-account satisfaction improve in Q4?',
      target: { variableKey: 'CUSTOMER_SATISFACTION' },
      scope: pharma,
      period: { from: '2026-10-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' },
    }),
    'satisfaction question',
  );

  const refresh = async (v: ClaimView) => unwrapOr(await causal.getClaim(d.admin, v.claim.id), 'refresh');
  return {
    claims: {
      H1: await refresh(H1),
      H2: await refresh(H2),
      H3: await refresh(H3),
      H4: await refresh(H4),
      C2: await refresh(C2),
      C3: await refresh(C3),
      M1: await refresh(M1),
      MED: await refresh(MED),
      D1: await refresh(D1),
      D2: await refresh(D2),
      L1,
      L2,
      L3,
      L4,
    },
    evidence,
    questions: { fulfilment, satisfaction },
    correlation,
    serviceAssumption,
  };
}
