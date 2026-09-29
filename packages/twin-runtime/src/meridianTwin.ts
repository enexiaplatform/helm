/**
 * The canonical twin story — the Rohto decision, lived through time.
 *
 * DEMO DATA. Every later fact below (the reclassification, the change of
 * Commercial Director, the Q4 actuals) is illustrative, labelled as such, and
 * enters HELM exactly as a real fact would: through the kernel that owns it, at
 * its own record time. The twin is then only ever asked what it knew when.
 *
 *   23 Sep 09:00  S0   the decision is ready, not committed; stock is short
 *   23 Sep        S1a  committed by the Commercial Director; the Country GM's
 *                      approval is pending (trusted authority service)
 *   24 Sep        S1   approved; the committed future exists; nothing physical
 *                      has changed yet
 *                 CF1  the committed future itself, read from the frozen run
 *   28 Sep             DOA v2 recorded (in force 1 Oct)
 *    2 Oct             the stock transfer is done
 *    1 Nov             Rohto reclassified Key Account → Strategic Account
 *   15 Nov             the Commercial Director changes
 *   12 Jan 2027   S2   Q4 actuals are in: fulfilment cost ran over, margin came
 *                      in at 31.7%, the tender assumption was disproved
 */

import { asUserId, fail, ok, type Result, type Scope, type UserId } from '@helm/shared';
import { canonicalKey } from '@helm/ontology';
import type { GraphStore } from '@helm/graph-store';
import type { ValueGraph } from '@helm/value-graph';
import { Q4_2026, type ScenarioRuntime } from '@helm/scenario-runtime';
import { buildMeridianDecision, type DecisionRuntime } from '@helm/decision-runtime';
import {
  MERIDIAN_DEMO_USERS,
  recordMeridianDoaV2,
  type AuthorityPolicy,
  type AuthorityRuntime,
  type MeridianGovernanceGraph,
  type RoleOccupancy,
  type TrustedAuthorityService,
} from '@helm/authority-runtime';
import type { TwinRuntime } from './port.ts';
import type { ComposedSnapshot, TwinScope } from './types.ts';

export const DEMO_TWIN_LABEL = 'DEMO TWIN DATA';

/** The Commercial Director's successor from 15 Nov 2026 (demo). */
export const MERIDIAN_TWIN_SUCCESSOR = {
  userId: asUserId('d6000000-0000-4000-8000-000000000007'),
  personLabel: 'Hoang Thu Trang',
} as const;

export const TWIN_PERIODS = ['2026-Q4'] as const;

export const MERIDIAN_TWIN_TIMES = {
  classified: '2026-09-21T02:00:00.000Z',
  s0: '2026-09-23T02:00:00.000Z',
  approved: '2026-09-24T03:00:00.000Z',
  /** An hour after the approval: the boundary the committed future is read under. */
  approvedKnown: '2026-09-24T04:00:00.000Z',
  doaV2: '2026-09-28T02:00:00.000Z',
  transfer: '2026-10-02T09:00:00.000Z',
  /** SCM restates the Q4 field-service utilisation it had filed (a correction about a period already known). */
  restated: '2026-10-05T02:00:00.000Z',
  reclassified: '2026-11-01T02:00:00.000Z',
  succession: '2026-11-15T02:00:00.000Z',
  actuals: '2027-01-12T03:00:00.000Z',
  /** The Q4 close re-run: after the actuals were recorded, so it can know them. */
  q4Close: '2027-01-12T04:00:00.000Z',
  /** "As management knew the enterprise on 23 Sep, 14:00 ICT." */
  historicalLens: { effectiveAsOf: '2026-09-23T07:00:00.000Z', recordedThrough: '2026-09-23T07:00:00.000Z' },
  committedHorizon: '2026-12-31T00:00:00.000Z',
} as const;

/** The actual fulfilment cost that brings Q4 gross margin to exactly 31.70%: 2.94B × 68.3% − 1.8228B. */
export const Q4_ACTUAL_FULFILMENT_COST = '185220000';
export const Q4_ACTUAL_GM_PCT = '31.7';

export type MeridianTwinDeps = {
  readonly admin: Scope;
  readonly as: (userId: UserId) => Scope;
  readonly graph: GraphStore;
  readonly valueGraph: ValueGraph;
  readonly scenarios: ScenarioRuntime;
  readonly decisions: DecisionRuntime;
  readonly authority: AuthorityRuntime;
  readonly trusted: TrustedAuthorityService;
  readonly twin: TwinRuntime;
  readonly governance: MeridianGovernanceGraph;
  readonly doaV1: AuthorityPolicy;
  readonly occupancies: Readonly<Record<string, RoleOccupancy>>;
  readonly scenarioIds: Readonly<Record<string, string>>;
  readonly nodeIds: Readonly<Record<string, string>>;
  /** Moves the host clock forward. The story never moves it back. */
  readonly advanceTo: (iso: string) => void;
  /** Org units the snapshots are shared with (demo: unit ids of MERIDIAN_DEMO_UNITS). */
  readonly units: { readonly vietnam: string; readonly pharma: string; readonly industrial: string };
};

export type MeridianTwinStory = {
  readonly decisionId: string;
  readonly commitmentId: string;
  readonly scopes: { readonly vietnam: TwinScope; readonly pharma: TwinScope; readonly industrial: TwinScope };
  readonly S0: ComposedSnapshot;
  readonly S1a: ComposedSnapshot;
  readonly S1: ComposedSnapshot;
  readonly CF1: ComposedSnapshot;
  readonly S2: ComposedSnapshot;
  readonly H23: ComposedSnapshot;
  /** The same business instant as H23, under the knowledge boundary of the Q4 close. */
  readonly H23now: ComposedSnapshot;
  readonly pharmaS2: ComposedSnapshot;
  readonly industrialS2: ComposedSnapshot;
  readonly segments: { readonly keyAccount: string; readonly strategicAccount: string };
};

const must = <T>(r: Result<T>, what: string): Result<T> =>
  r.ok ? r : fail(r.error.code, `${what}: ${r.error.message}`, r.error.details);

export async function runMeridianTwinStory(d: MeridianTwinDeps): Promise<Result<MeridianTwinStory>> {
  const e = d.governance.entities;
  const gm = d.as(MERIDIAN_DEMO_USERS.countryGM);
  const cd = d.as(MERIDIAN_DEMO_USERS.commercialDirector);
  const fd = d.as(MERIDIAN_DEMO_USERS.financeDirector);
  const periods = [...TWIN_PERIODS];
  const vn = await d.graph.getEntity(d.admin, e.vn.entityId as never);
  if (!vn.ok || !vn.value) return fail('twin.not_found', 'The Vietnam entity is missing from the graph.');
  const pharma = await d.graph.getEntity(d.admin, e.buPharma.entityId as never);
  const industrial = await d.graph.getEntity(d.admin, e.buIndustrial.entityId as never);
  if (!pharma.ok || !pharma.value || !industrial.ok || !industrial.value) return fail('twin.not_found', 'A business unit is missing from the graph.');
  const scopes = {
    vietnam: { kind: 'ENTITY', entityId: vn.value.id, entityTypeKey: 'Country', label: 'Vietnam' } as const,
    pharma: { kind: 'ENTITY', entityId: pharma.value.id, entityTypeKey: 'BusinessUnit', label: 'Pharma BU' } as const,
    industrial: { kind: 'ENTITY', entityId: industrial.value.id, entityTypeKey: 'BusinessUnit', label: 'Industrial BU' } as const,
  };
  const current = (label: string, scope: TwinScope = scopes.vietnam, granted = [d.units.vietnam]) =>
    d.twin.buildSnapshot(gm, { kind: 'CURRENT', label, scope, periods, grantedUnitIds: granted });

  // --------------------------------------------------- account classification
  d.advanceTo(MERIDIAN_TWIN_TIMES.classified);
  const segment = async (ref: string, name: string, code: string) =>
    d.graph.createEntity(d.admin, {
      entityTypeKey: 'Segment',
      canonicalKey: canonicalKey('helm', 'segment', ref),
      name,
      sourceSystem: 'manual',
      validFrom: '2025-01-01T00:00:00.000Z' as never,
      attributes: { segmentCode: code },
    });
  const keyAccount = must(await segment('key-account', 'Key Account', 'KEY_ACCOUNT'), 'key account segment');
  if (!keyAccount.ok) return keyAccount;
  const strategicAccount = must(await segment('strategic-account', 'Strategic Account', 'STRATEGIC_ACCOUNT'), 'strategic account segment');
  if (!strategicAccount.ok) return strategicAccount;
  const keyLink = must(
    await d.graph.createRelationship(d.admin, {
      relationshipTypeKey: 'BELONGS_TO',
      sourceEntityId: e.rohto.entityId as never,
      targetEntityId: keyAccount.value.entity.id,
      sourceSystem: 'manual',
      validFrom: '2025-01-01T00:00:00.000Z' as never,
      metadata: { demo: DEMO_TWIN_LABEL, basis: 'Account plan 2025: Key Account (demo). Memoire remains the commercial system of record.' },
    }),
    'classification',
  );
  if (!keyLink.ok) return keyLink;

  // ------------------------------------------------------ S0, S1a, S1, CF1
  d.advanceTo(MERIDIAN_TWIN_TIMES.s0);
  // The model's reading of the baseline on the morning of 23 Sep, for Q4.
  const morning = must(
    await d.scenarios.executeBaseline(d.admin, {
      fork: { effectiveAsOf: MERIDIAN_TWIN_TIMES.s0, recordedThrough: MERIDIAN_TWIN_TIMES.s0, policy: 'SOURCE_TRUTH' },
      periods: [Q4_2026],
      notes: 'Baseline on 23 Sep: the enterprise as recorded, before any decision',
    }),
    'S0 baseline',
  );
  if (!morning.ok) return morning;
  let S0: ComposedSnapshot | null = null;
  const built = must(
    await buildMeridianDecision(d.decisions, cd, d.scenarioIds, {
      committedByLabel: 'Commercial Director Vietnam',
      beforeCommit: async () => {
        const s = await current('S0 — before the decision');
        if (s.ok) S0 = s.value;
        return s;
      },
    }),
    'canonical decision',
  );
  if (!built.ok) return built;
  if (!S0 || !built.value.commitment) return fail('twin.invalid_input', 'The canonical decision did not commit.');
  const commitment = built.value.commitment;
  const profiled = must(await d.authority.declareGovernanceProfile(cd, built.value.decision.id, { decisionTypeKey: 'INVENTORY_ALLOCATION', note: 'Rohto Q4 allocation' }), 'classify');
  if (!profiled.ok) return profiled;
  const orgId = d.admin.orgId;
  const evaluated = await d.trusted.handle({ userId: MERIDIAN_DEMO_USERS.countryGM }, { op: 'evaluate', orgId, commitmentId: commitment.id });
  if (evaluated.status !== 200) return fail('twin.invalid_input', `The trusted authority service refused: ${JSON.stringify(evaluated.body)}`);
  const S1a = must(await current('S1a — committed, approval pending'), 'S1a');
  if (!S1a.ok) return S1a;

  d.advanceTo(MERIDIAN_TWIN_TIMES.approved);
  const required = (evaluated.body.required as { id: string }[])[0];
  const approved = await d.trusted.handle({ userId: MERIDIAN_DEMO_USERS.countryGM }, { op: 'approve', orgId, requiredApprovalId: required.id, comments: 'Approved. Confirm the transfer date with Distributor D.' });
  if (approved.status !== 200) return fail('twin.invalid_input', `The approval was refused: ${JSON.stringify(approved.body)}`);
  const S1 = must(await current('S1 — committed and approved'), 'S1');
  if (!S1.ok) return S1;
  d.advanceTo(MERIDIAN_TWIN_TIMES.approvedKnown);
  const CF1 = must(
    await d.twin.getCommittedFuture(gm, commitment.id, {
      label: 'CF1 — the committed future',
      scope: scopes.vietnam,
      lens: { effectiveAsOf: MERIDIAN_TWIN_TIMES.committedHorizon, recordedThrough: MERIDIAN_TWIN_TIMES.approvedKnown },
      grantedUnitIds: [d.units.vietnam],
    }),
    'CF1',
  );
  if (!CF1.ok) return CF1;

  // ------------------------------------------------ what happened afterwards
  d.advanceTo(MERIDIAN_TWIN_TIMES.doaV2);
  const v2 = must(await recordMeridianDoaV2(d.authority, d.admin, d.governance, d.doaV1), 'DOA v2');
  if (!v2.ok) return v2;

  d.advanceTo(MERIDIAN_TWIN_TIMES.transfer);
  const intents = await d.decisions.getWorkspace(cd, built.value.decision.id);
  if (!intents.ok) return intents;
  for (const intent of intents.value.actionIntents) {
    const to = intent.targetSystem === 'finance' ? 'IN_PROGRESS' : 'DONE';
    const moved = must(await d.decisions.setActionIntentStatus(cd, commitment.id, intent.id, to, 'demo progress'), 'intent status');
    if (!moved.ok) return moved;
  }

  d.advanceTo(MERIDIAN_TWIN_TIMES.restated);
  const restated = await d.valueGraph.recordObservation(d.admin, {
    nodeId: d.nodeIds.capUtil,
    observationType: 'ACTUAL',
    numericValue: 81,
    unitType: 'percentage',
    periodStart: Q4_2026.start as never,
    periodEnd: Q4_2026.end as never,
    observedAt: '2026-10-05T02:00:00.000Z' as never,
    sourceSystem: 'scm',
    confidence: 1,
    metadata: { demo: DEMO_TWIN_LABEL, note: 'corrected Q4 field-service utilisation plan: 81%, not 78%' },
  });
  if (!restated.ok) return restated;

  d.advanceTo(MERIDIAN_TWIN_TIMES.reclassified);
  const closed = must(await d.graph.removeRelationship(d.admin, keyLink.value.id, new Date('2026-11-01T00:00:00.000Z')), 'close classification');
  if (!closed.ok) return closed;
  const strategicLink = must(
    await d.graph.createRelationship(d.admin, {
      relationshipTypeKey: 'BELONGS_TO',
      sourceEntityId: e.rohto.entityId as never,
      targetEntityId: strategicAccount.value.entity.id,
      sourceSystem: 'manual',
      validFrom: '2026-11-01T00:00:00.000Z' as never,
      metadata: { demo: DEMO_TWIN_LABEL, basis: 'Account review Nov 2026: Strategic Account (demo).' },
    }),
    'reclassification',
  );
  if (!strategicLink.ok) return strategicLink;

  d.advanceTo(MERIDIAN_TWIN_TIMES.succession);
  const cdSeat = d.occupancies.commercialDirector;
  const ended = must(await d.authority.endOccupancy(d.admin, cdSeat.id, '2026-11-15T00:00:00.000Z'), 'end occupancy');
  if (!ended.ok) return ended;
  const successor = must(
    await d.authority.recordOccupancy(d.admin, {
      roleId: cdSeat.roleId,
      userId: MERIDIAN_TWIN_SUCCESSOR.userId,
      personEntityId: null,
      personLabel: MERIDIAN_TWIN_SUCCESSOR.personLabel,
      kind: 'SUBSTANTIVE',
      validFrom: '2026-11-15T00:00:00.000Z',
      basis: `${DEMO_TWIN_LABEL}: appointment letter (demo)`,
    }),
    'successor',
  );
  if (!successor.ok) return successor;

  d.advanceTo(MERIDIAN_TWIN_TIMES.actuals);
  const observe = (node: string, input: Parameters<ValueGraph['recordObservation']>[1]) => d.valueGraph.recordObservation(d.admin, { ...input, nodeId: d.nodeIds[node] });
  const Q4 = { periodStart: Q4_2026.start as never, periodEnd: Q4_2026.end as never };
  for (const [what, r] of [
    ['own stock', await observe('availOwn', { nodeId: '', observationType: 'ACTUAL', numericValue: 12, unitType: 'units', effectiveAt: '2026-10-03T00:00:00.000Z' as never, observedAt: '2026-10-03T00:00:00.000Z' as never, sourceSystem: 'scm', confidence: 1, metadata: { demo: DEMO_TWIN_LABEL, note: 'eight units transferred from Distributor D on 2 Oct' } })],
    ['distributor stock', await observe('availDist', { nodeId: '', observationType: 'ACTUAL', numericValue: 0, unitType: 'units', effectiveAt: '2026-10-03T00:00:00.000Z' as never, observedAt: '2026-10-03T00:00:00.000Z' as never, sourceSystem: 'scm', confidence: 1, metadata: { demo: DEMO_TWIN_LABEL } })],
    ['fulfilment cost', await observe('freightOpex', { nodeId: '', observationType: 'ACTUAL', numericValue: Number(Q4_ACTUAL_FULFILMENT_COST), unitType: 'currency', currency: 'VND', ...Q4, observedAt: '2027-01-10T00:00:00.000Z' as never, sourceSystem: 'finance', confidence: 1, metadata: { demo: DEMO_TWIN_LABEL, exactValue: Q4_ACTUAL_FULFILMENT_COST, note: 'transfer, re-labelling and a second inspection' } })],
    ['gross margin', await observe('grossMarginPctOpp', { nodeId: '', observationType: 'ACTUAL', numericValue: 31.7, unitType: 'percentage', ...Q4, observedAt: '2027-01-10T00:00:00.000Z' as never, sourceSystem: 'finance', confidence: 1, metadata: { demo: DEMO_TWIN_LABEL, exactValue: Q4_ACTUAL_GM_PCT } })],
  ] as const) {
    if (!r.ok) return fail(r.error.code, `${what}: ${r.error.message}`);
  }
  d.advanceTo(MERIDIAN_TWIN_TIMES.q4Close);
  const rerun = must(
    await d.scenarios.executeBaseline(d.admin, {
      fork: { effectiveAsOf: MERIDIAN_TWIN_TIMES.committedHorizon, recordedThrough: MERIDIAN_TWIN_TIMES.q4Close, policy: 'SOURCE_TRUTH' },
      periods: [Q4_2026],
      notes: 'Q4 close: the baseline model over the actuals as recorded',
    }),
    'Q4 baseline',
  );
  if (!rerun.ok) return rerun;
  const review = must(
    await d.decisions.recordOutcomeReview(fd, commitment.id, {
      reviewedByLabel: 'Finance Director Vietnam',
      actuals: [{ label: 'Gross margin %', metricKey: 'GrossMarginPct', actual: Q4_ACTUAL_GM_PCT }],
      assumptionResults: [
        { assumptionId: built.value.assumptions['distributor-release'].id, outcome: 'CONFIRMED', note: 'Distributor D released all eight units on 2 October.' },
        { assumptionId: built.value.assumptions['tender-material'].id, outcome: 'DISPROVED', note: 'The provincial tender was postponed to Q1.' },
      ],
      notes: 'Margin came in below the modelled figure because the re-labelling cost Finance flagged was real.',
    }),
    'outcome review',
  );
  if (!review.ok) return review;
  for (const intent of intents.value.actionIntents.filter((i) => i.targetSystem === 'finance')) {
    const moved = must(await d.decisions.setActionIntentStatus(fd, commitment.id, intent.id, 'DONE', 'Q4 close'), 'intent done');
    if (!moved.ok) return moved;
  }

  const S2 = must(await current('S2 — after the Q4 outcome'), 'S2');
  if (!S2.ok) return S2;
  const pharmaS2 = must(await current('S2 — Pharma BU', scopes.pharma, [d.units.pharma]), 'Pharma S2');
  if (!pharmaS2.ok) return pharmaS2;
  const industrialS2 = must(await current('S2 — Industrial BU', scopes.industrial, [d.units.industrial]), 'Industrial S2');
  if (!industrialS2.ok) return industrialS2;
  const H23 = must(
    await d.twin.buildSnapshot(gm, { kind: 'HISTORICAL', label: 'As management knew the enterprise on 23 Sep, 14:00', scope: scopes.vietnam, lens: MERIDIAN_TWIN_TIMES.historicalLens, periods, grantedUnitIds: [d.units.vietnam] }),
    'H23',
  );
  if (!H23.ok) return H23;

  const H23now = must(
    await d.twin.buildSnapshot(gm, {
      kind: 'HISTORICAL',
      label: '23 Sep, 14:00 — as HELM knows it now',
      scope: scopes.vietnam,
      lens: { effectiveAsOf: MERIDIAN_TWIN_TIMES.historicalLens.effectiveAsOf, recordedThrough: MERIDIAN_TWIN_TIMES.q4Close },
      periods,
      grantedUnitIds: [d.units.vietnam],
    }),
    'H23 as known now',
  );
  if (!H23now.ok) return H23now;

  return ok({
    decisionId: built.value.decision.id,
    H23now: H23now.value,
    commitmentId: commitment.id,
    scopes,
    S0,
    S1a: S1a.value,
    S1: S1.value,
    CF1: CF1.value,
    S2: S2.value,
    H23: H23.value,
    pharmaS2: pharmaS2.value,
    industrialS2: industrialS2.value,
    segments: { keyAccount: keyAccount.value.entity.id, strategicAccount: strategicAccount.value.entity.id },
  });
}
