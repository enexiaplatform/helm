/**
 * The canonical Meridian governance — DEMO GOVERNANCE POLICY, as data.
 *
 * Nothing here is a HELM default. It is a seeded delegation-of-authority
 * document for a fictional company, clearly labelled, used to prove the
 * authority graph against the Phase 5 Rohto decision:
 *
 *   Commercial Director Vietnam   commits inventory allocation in Vietnam
 *                                 Pharma while cash impact ≥ −1.0B VND;
 *                                 above that it goes to the Country GM
 *   Country GM Vietnam            commits and approves across Vietnam while
 *                                 cash impact ≥ −3.0B VND AND demand coverage
 *                                 ≥ 90% — two lines, each explained apart
 *   Regional MD Southeast Asia    commits and approves across the region
 *   Finance Director Vietnam      must also approve anything below −2.0B VND
 *                                 (a matrix requirement, not a reporting line)
 *   Pharma commercial analyst     may PREPARE and RECOMMEND, not commit
 *   Industrial BU Head Vietnam    commits within the Industrial BU only
 *
 * People and their identities are demo seed data too. The authority logic
 * never names a person or a role: it reads rules and occupancies.
 */

import { asUserId, ok, quarterPeriod, type Result, type Scope, type UserId } from '@helm/shared';
import { canonicalKey } from '@helm/ontology';
import type { GraphStore } from '@helm/graph-store';
import type { ForkPoint, ScenarioRuntime } from '@helm/scenario-runtime';
import type { CommitInput, Decision, DecisionCommitment, DecisionRuntime } from '@helm/decision-runtime';
import type { AuthorityRuntime } from './port.ts';
import type { AuthorityPolicy, AuthorityRule, EntityRef, RoleOccupancy, ScopeConstraint } from './types.ts';

export const DEMO_GOVERNANCE_LABEL = 'DEMO GOVERNANCE POLICY';

/** Demo identities. In the cloud these are auth.users ids; here they are fixed so proofs are repeatable. */
export const MERIDIAN_DEMO_USERS = {
  countryGM: asUserId('d6000000-0000-4000-8000-000000000001'),
  commercialDirector: asUserId('d6000000-0000-4000-8000-000000000002'),
  financeDirector: asUserId('d6000000-0000-4000-8000-000000000003'),
  regionalMD: asUserId('d6000000-0000-4000-8000-000000000004'),
  pharmaAnalyst: asUserId('d6000000-0000-4000-8000-000000000005'),
  industrialHead: asUserId('d6000000-0000-4000-8000-000000000006'),
} as const;

export const MERIDIAN_DEMO_PEOPLE: Readonly<Record<keyof typeof MERIDIAN_DEMO_USERS, string>> = {
  countryGM: 'Nguyen Thi Mai',
  commercialDirector: 'Tran Van Binh',
  financeDirector: 'Le Thi Hoa',
  regionalMD: 'Daniel Tan',
  pharmaAnalyst: 'Pham Minh Chau',
  industrialHead: 'Vo Quang Huy',
};

/** Demo organization units, for decision VISIBILITY (not authority). */
export const MERIDIAN_DEMO_UNITS = [
  { id: 'unit-meridian', parentId: null, label: 'Meridian Life Sciences', unitType: 'company' },
  { id: 'unit-sea', parentId: 'unit-meridian', label: 'Southeast Asia', unitType: 'region' },
  { id: 'unit-vn', parentId: 'unit-sea', label: 'Vietnam', unitType: 'country' },
  { id: 'unit-vn-pharma', parentId: 'unit-vn', label: 'Vietnam Pharma BU', unitType: 'business_unit' },
  { id: 'unit-vn-industrial', parentId: 'unit-vn', label: 'Vietnam Industrial BU', unitType: 'business_unit' },
  { id: 'unit-vn-finance', parentId: 'unit-vn', label: 'Vietnam Finance', unitType: 'department' },
  { id: 'unit-vn-commercial', parentId: 'unit-vn', label: 'Vietnam Commercial', unitType: 'department' },
] as const;

export type MeridianGovernanceGraph = {
  readonly entities: Readonly<Record<string, EntityRef>>;
};

const ENTITY_SPECS: readonly { handle: string; type: string; ref: string; name: string; existing?: boolean; namespace?: string; attributes?: Record<string, unknown> }[] = [
  // Already in the Phase 1 canonical graph.
  { handle: 'group', type: 'Enterprise', ref: 'meridian', name: 'Meridian Life Sciences', existing: true },
  { handle: 'sea', type: 'Region', ref: 'sea', name: 'Southeast Asia', existing: true },
  { handle: 'vn', type: 'Country', ref: 'vn', name: 'Vietnam', existing: true },
  { handle: 'buPharma', type: 'BusinessUnit', ref: 'bu-pharma', name: 'Pharma BU', existing: true },
  { handle: 'rohto', type: 'Customer', ref: 'a3f2c1d4', name: 'Rohto Vietnam', existing: true, namespace: 'memoire' },
  { handle: 'roleGM', type: 'Role', ref: 'country-gm-vn', name: 'Country GM Vietnam', existing: true },
  { handle: 'roleCommDir', type: 'Role', ref: 'commercial-director-vn', name: 'Commercial Director Vietnam', existing: true },
  { handle: 'personGM', type: 'Person', ref: 'p-nguyen', name: 'Nguyen Thi Mai', existing: true },
  // Added for Phase 6.
  { handle: 'th', type: 'Country', ref: 'th', name: 'Thailand', attributes: { iso2: 'TH', currency: 'THB' } },
  { handle: 'buThPharma', type: 'BusinessUnit', ref: 'bu-th-pharma', name: 'Thailand Pharma BU', attributes: { unitCode: 'TH-PHARMA' } },
  { handle: 'buIndustrial', type: 'BusinessUnit', ref: 'bu-industrial', name: 'Industrial BU', attributes: { unitCode: 'VN-IND' } },
  { handle: 'roleFD', type: 'Role', ref: 'finance-director-vn', name: 'Finance Director Vietnam', attributes: { title: 'Finance Director', level: 'L4' } },
  { handle: 'roleRMD', type: 'Role', ref: 'regional-md-sea', name: 'Regional MD Southeast Asia', attributes: { title: 'Regional Managing Director', level: 'L6' } },
  { handle: 'roleAnalyst', type: 'Role', ref: 'pharma-analyst-vn', name: 'Pharma Commercial Analyst Vietnam', attributes: { title: 'Commercial Analyst', level: 'L2' } },
  { handle: 'roleIndustrialHead', type: 'Role', ref: 'industrial-head-vn', name: 'Industrial BU Head Vietnam', attributes: { title: 'BU Head', level: 'L4' } },
  { handle: 'personCommDir', type: 'Person', ref: 'p-tran', name: 'Tran Van Binh' },
  { handle: 'personFD', type: 'Person', ref: 'p-le', name: 'Le Thi Hoa' },
  { handle: 'personRMD', type: 'Person', ref: 'p-tan', name: 'Daniel Tan' },
  { handle: 'personAnalyst', type: 'Person', ref: 'p-pham', name: 'Pham Minh Chau' },
  { handle: 'personIndustrialHead', type: 'Person', ref: 'p-vo', name: 'Vo Quang Huy' },
];

const RELATIONSHIP_SPECS: readonly { type: string; from: string; to: string }[] = [
  { type: 'BELONGS_TO', from: 'th', to: 'sea' },
  { type: 'BELONGS_TO', from: 'buThPharma', to: 'th' },
  { type: 'BELONGS_TO', from: 'buIndustrial', to: 'vn' },
  { type: 'HOLDS_ROLE', from: 'personCommDir', to: 'roleCommDir' },
  { type: 'HOLDS_ROLE', from: 'personFD', to: 'roleFD' },
  { type: 'HOLDS_ROLE', from: 'personRMD', to: 'roleRMD' },
  { type: 'HOLDS_ROLE', from: 'personAnalyst', to: 'roleAnalyst' },
  { type: 'HOLDS_ROLE', from: 'personIndustrialHead', to: 'roleIndustrialHead' },
  { type: 'REPORTS_TO', from: 'roleGM', to: 'roleRMD' },
  { type: 'REPORTS_TO', from: 'roleFD', to: 'roleGM' },
  { type: 'REPORTS_TO', from: 'roleAnalyst', to: 'roleCommDir' },
  { type: 'REPORTS_TO', from: 'roleIndustrialHead', to: 'roleGM' },
  { type: 'RESPONSIBLE_FOR', from: 'roleRMD', to: 'sea' },
  { type: 'RESPONSIBLE_FOR', from: 'roleIndustrialHead', to: 'buIndustrial' },
];

/** Adds the governance entities to the enterprise graph. Idempotent. */
export async function buildMeridianGovernanceGraph(graph: GraphStore, scope: Scope): Promise<Result<MeridianGovernanceGraph>> {
  const entities: Record<string, EntityRef> = {};
  for (const spec of ENTITY_SPECS) {
    const key = canonicalKey(spec.namespace ?? 'helm', spec.type.toLowerCase(), spec.ref);
    if (spec.existing) {
      const found = await graph.getEntityByCanonicalKey(scope, spec.type, key);
      if (!found.ok) return found;
      if (!found.value) throw new Error(`governance graph: ${key} is missing — build the Phase 1 canonical graph first`);
      entities[spec.handle] = { entityId: found.value.id, label: found.value.name };
      continue;
    }
    const r = await graph.upsertEntity(scope, {
      entityTypeKey: spec.type,
      canonicalKey: key,
      name: spec.name,
      sourceSystem: 'helm',
      attributes: spec.attributes ?? {},
    });
    if (!r.ok) return r;
    entities[spec.handle] = { entityId: r.value.entity.id, label: r.value.entity.name };
  }
  for (const spec of RELATIONSHIP_SPECS) {
    const from = entities[spec.from].entityId;
    const to = entities[spec.to].entityId;
    const existing = await graph.findRelationships(scope, {
      relationshipTypeKeys: [spec.type],
      sourceEntityId: from as never,
      targetEntityId: to as never,
    });
    if (!existing.ok) return existing;
    if (existing.value.length > 0) continue;
    const r = await graph.createRelationship(scope, {
      relationshipTypeKey: spec.type,
      sourceEntityId: from as never,
      targetEntityId: to as never,
      sourceSystem: 'helm',
      metadata: { seed: 'meridian-governance' },
    });
    if (!r.ok) return r;
  }
  return ok({ entities });
}

const vnd = (label: string, metricKey: string, comparator: 'GTE' | 'LT', threshold: string) => ({
  metricKey,
  label,
  comparator,
  threshold,
  unit: 'currency' as const,
  currency: 'VND',
});

/**
 * DOA-2026-04, version 1. In force from 1 January 2026. `commercialDirectorCashLine`
 * exists so version 2 can move exactly one line and nothing else.
 */
function meridianDoaRules(e: MeridianGovernanceGraph['entities'], commercialDirectorCashLine: string) {
  const at = (dimension: ScopeConstraint['dimension'], ...handles: string[]): ScopeConstraint => ({
    dimension,
    entities: handles.map((h) => e[h]),
  });
  const role = (h: string) => ({ kind: 'ROLE' as const, roleId: e[h].entityId, label: e[h].label });
  const INVENTORY = ['INVENTORY_ALLOCATION'];
  return [
    {
      key: 'commercial-director-inventory-allocation',
      holder: role('roleCommDir'),
      effect: 'GRANT' as const,
      decisionTypes: INVENTORY,
      acts: ['PREPARE', 'RECOMMEND', 'COMMIT', 'EXECUTE'] as const,
      scope: [at('COUNTRY', 'vn'), at('BUSINESS_UNIT', 'buPharma')],
      conditions: [vnd('Cash impact', 'CashImpact', 'GTE', commercialDirectorCashLine)],
      escalationRoleId: e.roleGM.entityId,
      escalationRoleLabel: e.roleGM.label,
      approvalIndependence: 'INDEPENDENT_OF_COMMITTER' as const,
      rationale: `${DEMO_GOVERNANCE_LABEL}: the Commercial Director allocates Pharma stock in Vietnam up to a cash exposure line; beyond it the Country GM decides.`,
    },
    {
      key: 'country-gm-inventory-allocation',
      holder: role('roleGM'),
      effect: 'GRANT' as const,
      decisionTypes: INVENTORY,
      acts: ['PREPARE', 'RECOMMEND', 'COMMIT', 'APPROVE', 'EXECUTE'] as const,
      scope: [at('COUNTRY', 'vn')],
      conditions: [
        vnd('Cash impact', 'CashImpact', 'GTE', '-3000000000'),
        { metricKey: 'DemandCoverage', label: 'Demand coverage', comparator: 'GTE' as const, threshold: '90', unit: 'percentage' as const, currency: null },
      ],
      escalationRoleId: e.roleRMD.entityId,
      escalationRoleLabel: e.roleRMD.label,
      approvalIndependence: 'INDEPENDENT_OF_COMMITTER' as const,
      rationale: `${DEMO_GOVERNANCE_LABEL}: the Country GM commits and approves allocation across Vietnam, provided the cash exposure stays inside 3.0B VND and service does not fall below the 90% coverage floor.`,
    },
    {
      key: 'regional-md-inventory-allocation',
      holder: role('roleRMD'),
      effect: 'GRANT' as const,
      decisionTypes: INVENTORY,
      acts: ['COMMIT', 'APPROVE'] as const,
      scope: [at('REGION', 'sea')],
      conditions: [vnd('Cash impact', 'CashImpact', 'GTE', '-10000000000')],
      escalationRoleId: null,
      escalationRoleLabel: null,
      approvalIndependence: 'INDEPENDENT_OF_COMMITTER' as const,
      rationale: `${DEMO_GOVERNANCE_LABEL}: the Regional MD holds allocation authority across Southeast Asia up to 10B VND. Above that, the policy names nobody — and HELM does not invent one.`,
    },
    {
      key: 'finance-director-cash-exposure',
      holder: role('roleFD'),
      effect: 'REQUIRE_APPROVAL' as const,
      decisionTypes: INVENTORY,
      acts: ['COMMIT'] as const,
      scope: [at('COUNTRY', 'vn')],
      conditions: [vnd('Cash impact', 'CashImpact', 'LT', '-2000000000')],
      escalationRoleId: null,
      escalationRoleLabel: null,
      approvalIndependence: 'INDEPENDENT_OF_COMMITTER' as const,
      approvalSequence: 2,
      rationale: `${DEMO_GOVERNANCE_LABEL}: any allocation in Vietnam tying up more than 2.0B VND of cash also needs the Finance Director, whoever commits it.`,
    },
    {
      key: 'pharma-analyst-preparation',
      holder: role('roleAnalyst'),
      effect: 'GRANT' as const,
      decisionTypes: INVENTORY,
      acts: ['PREPARE', 'RECOMMEND'] as const,
      scope: [at('COUNTRY', 'vn'), at('BUSINESS_UNIT', 'buPharma')],
      conditions: [],
      escalationRoleId: null,
      escalationRoleLabel: null,
      approvalIndependence: 'NONE' as const,
      rationale: `${DEMO_GOVERNANCE_LABEL}: the analyst prepares and recommends Pharma allocations; committing them is not theirs.`,
    },
    {
      key: 'industrial-head-inventory-allocation',
      holder: role('roleIndustrialHead'),
      effect: 'GRANT' as const,
      decisionTypes: INVENTORY,
      acts: ['PREPARE', 'RECOMMEND', 'COMMIT'] as const,
      scope: [at('COUNTRY', 'vn'), at('BUSINESS_UNIT', 'buIndustrial')],
      conditions: [vnd('Cash impact', 'CashImpact', 'GTE', '-1000000000')],
      escalationRoleId: e.roleGM.entityId,
      escalationRoleLabel: e.roleGM.label,
      approvalIndependence: 'INDEPENDENT_OF_COMMITTER' as const,
      rationale: `${DEMO_GOVERNANCE_LABEL}: the Industrial BU Head allocates Industrial stock up to 1.0B VND.`,
    },
  ];
}

export async function recordMeridianDoaV1(
  runtime: AuthorityRuntime,
  scope: Scope,
  graph: MeridianGovernanceGraph,
): Promise<Result<{ policy: AuthorityPolicy; rules: readonly AuthorityRule[] }>> {
  return runtime.recordPolicy(scope, {
    key: 'meridian-vn-doa',
    version: 1,
    title: `Meridian Vietnam delegation of authority — ${DEMO_GOVERNANCE_LABEL}`,
    reference: 'DOA-2026-04',
    source: 'DOA_DOCUMENT',
    demo: true,
    rationale:
      `${DEMO_GOVERNANCE_LABEL}. Seeded for the demonstration from a fictional board-approved delegation of ` +
      'authority. It is not a HELM default and not a recommendation of limits.',
    validFrom: '2026-01-01T00:00:00.000Z',
    rules: meridianDoaRules(graph.entities, '-1000000000'),
  });
}

/**
 * DOA-2026-10, version 2: from 1 October 2026 the Commercial Director's cash
 * line moves from −1.0B to −2.0B VND. Nothing else changes, and version 1 is
 * not touched: a commitment made in September is still judged by it.
 */
export async function recordMeridianDoaV2(
  runtime: AuthorityRuntime,
  scope: Scope,
  graph: MeridianGovernanceGraph,
  supersedes: AuthorityPolicy,
): Promise<Result<{ policy: AuthorityPolicy; rules: readonly AuthorityRule[] }>> {
  return runtime.recordPolicy(scope, {
    key: 'meridian-vn-doa',
    version: 2,
    title: `Meridian Vietnam delegation of authority, revised — ${DEMO_GOVERNANCE_LABEL}`,
    reference: 'DOA-2026-10',
    source: 'DOA_DOCUMENT',
    demo: true,
    rationale: `${DEMO_GOVERNANCE_LABEL}. The Commercial Director's allocation line is raised to 2.0B VND from 1 October 2026.`,
    validFrom: '2026-10-01T00:00:00.000Z',
    supersedesPolicyId: supersedes.id,
    rules: meridianDoaRules(graph.entities, '-2000000000'),
  });
}

export async function recordMeridianOccupancies(
  runtime: AuthorityRuntime,
  scope: Scope,
  graph: MeridianGovernanceGraph,
): Promise<Result<Record<keyof typeof MERIDIAN_DEMO_USERS, RoleOccupancy>>> {
  const e = graph.entities;
  const seats: [keyof typeof MERIDIAN_DEMO_USERS, string, string, string][] = [
    ['countryGM', 'roleGM', 'personGM', '2024-03-01T00:00:00.000Z'],
    ['commercialDirector', 'roleCommDir', 'personCommDir', '2025-01-01T00:00:00.000Z'],
    ['financeDirector', 'roleFD', 'personFD', '2023-07-01T00:00:00.000Z'],
    ['regionalMD', 'roleRMD', 'personRMD', '2022-01-01T00:00:00.000Z'],
    ['pharmaAnalyst', 'roleAnalyst', 'personAnalyst', '2025-06-01T00:00:00.000Z'],
    ['industrialHead', 'roleIndustrialHead', 'personIndustrialHead', '2024-09-01T00:00:00.000Z'],
  ];
  const out = {} as Record<keyof typeof MERIDIAN_DEMO_USERS, RoleOccupancy>;
  for (const [who, role, person, from] of seats) {
    const r = await runtime.recordOccupancy(scope, {
      roleId: e[role].entityId,
      userId: MERIDIAN_DEMO_USERS[who],
      personEntityId: e[person].entityId,
      personLabel: MERIDIAN_DEMO_PEOPLE[who],
      kind: 'SUBSTANTIVE',
      validFrom: from,
      basis: `${DEMO_GOVERNANCE_LABEL}: appointment letter (demo)`,
    });
    if (!r.ok) return r;
    out[who] = r.value;
  }
  return ok(out);
}

export const scopeAs = (scope: Scope, userId: UserId): Scope => ({ ...scope, actorId: userId });

// ------------------------------------------------- the small proof decisions

export const Q1_2027_CALL_OFF = quarterPeriod(2027, 1);

/**
 * A smaller commitment: the Rohto framework call-off in 2027-Q1, served from
 * standard replenishment. Its consequences are COMPUTED like any other — the
 * scenario states three overrides and the engine does the rest.
 */
export async function buildCallOffScenario(
  scenarios: ScenarioRuntime,
  scope: Scope,
  nodeIds: Readonly<Record<string, string>>,
  fork: Partial<ForkPoint>,
): Promise<Result<{ scenarioId: string }>> {
  const created = await scenarios.createScenario(scope, {
    key: 'rohto-q1-call-off',
    name: 'Q1 — Rohto call-off from standard replenishment',
    description: 'Serve the 2027-Q1 framework call-off from the standard 21-day replenishment, shipped by sea.',
    parentScenarioId: null,
    fork,
    periods: [Q1_2027_CALL_OFF],
    metadata: { governanceProof: true },
  });
  if (!created.ok) return created;
  const overrides = [
    { node: 'availOwn', operation: 'ADD' as const, value: '4', unit: 'units' as const, currency: null, rationale: 'A standard replenishment of 4 units lands before 2027-Q1.' },
    { node: 'freightOpex', operation: 'SET' as const, value: '0', unit: 'currency' as const, currency: 'VND', rationale: 'Sea freight at standard cost, already inside unit cost.' },
    { node: 'oppValueNext', operation: 'SET' as const, value: '0', unit: 'currency' as const, currency: 'VND', rationale: 'The provincial tender delivers in 2026-Q4 and draws nothing in 2027-Q1.' },
  ];
  for (const o of overrides) {
    const added = await scenarios.addOverride(scope, created.value.revision.id, {
      overrideType: 'VALUE_OVERRIDE',
      targetNodeId: nodeIds[o.node],
      operation: o.operation,
      value: o.value,
      unit: o.unit,
      currency: o.currency,
      period: Q1_2027_CALL_OFF,
      provenanceKind: 'MANAGEMENT_ASSUMPTION',
      rationale: o.rationale,
      confidence: 0.8,
    });
    if (!added.ok) return added;
  }
  const executed = await scenarios.execute(scope, created.value.scenario.id);
  if (!executed.ok) return executed;
  return ok({ scenarioId: created.value.scenario.id });
}

/**
 * A compact decision over one computed future, for the governance proofs:
 * one modelled alternative, one honestly unmodelled, one demo criterion, and a
 * management-authored commitment whose expected outcomes are read from the
 * chosen future state. The authority evaluation reads them from there too.
 */
export async function buildProofDecision(
  decisions: DecisionRuntime,
  scope: Scope,
  spec: {
    title: string;
    managementQuestion: string;
    scenarioId: string;
    alternativeLabel: string;
    committedByLabel: string;
    fork?: Partial<Decision['fork']>;
    commit?: boolean;
  },
): Promise<Result<{ decision: Decision; revisionId: string; alternativeId: string; commitment: DecisionCommitment | null }>> {
  const created = await decisions.createDecision(scope, {
    title: spec.title,
    managementQuestion: spec.managementQuestion,
    context: `${DEMO_GOVERNANCE_LABEL} proof decision.`,
    scope: 'Vietnam · SKU-X',
    triggerType: 'PLANNED_REVIEW',
    owner: { kind: 'ROLE', label: spec.committedByLabel, userId: null },
    fork: spec.fork,
    reversibility: 'REVERSIBLE',
  });
  if (!created.ok) return created;
  const revisionId = created.value.revision.id;
  const modelled = await decisions.addAlternative(scope, revisionId, {
    label: spec.alternativeLabel,
    description: 'The computed future this commitment rests on.',
    scenarioId: spec.scenarioId,
  });
  if (!modelled.ok) return modelled;
  const other = await decisions.addAlternative(scope, revisionId, {
    label: 'Hold and revisit next quarter',
    description: 'Do nothing now.',
    unmodelledReason: 'Not simulated: holding is the status quo and no scenario was built for it.',
  });
  if (!other.ok) return other;
  const criterion = await decisions.addCriterion(scope, revisionId, {
    key: 'customer-service',
    name: 'Customer service',
    style: 'HARD_CONSTRAINT',
    required: true,
    metricKey: 'DemandCoverage',
    threshold: 90,
    unit: 'percentage',
    direction: 'HIGHER_IS_BETTER',
    author: { kind: 'ROLE', label: 'Country GM Vietnam', userId: null },
    rationale: `${DEMO_GOVERNANCE_LABEL}: the 90% coverage floor on framework accounts.`,
    demoPolicy: true,
  });
  if (!criterion.ok) return criterion;
  for (const state of ['MODELLING', 'READY_FOR_DECISION'] as const) {
    const moved = await decisions.setState(scope, created.value.decision.id, state);
    if (!moved.ok) return moved;
  }
  if (spec.commit === false) {
    return ok({ decision: created.value.decision, revisionId, alternativeId: modelled.value.id, commitment: null });
  }
  const input: CommitInput = {
    chosenAlternativeId: modelled.value.id,
    authorship: 'MANAGEMENT_AUTHORED_DEMO',
    committedByLabel: spec.committedByLabel,
    summary: `${spec.alternativeLabel}.`,
    rationale: [
      {
        kind: 'CRITERION',
        ref: criterion.value.id,
        label: 'Customer service',
        statement: 'The computed future keeps coverage above the 90% floor management stated.',
      },
    ],
    acceptedTradeOffs: [],
    expectedOutcomes: [
      { label: 'Cash impact', kind: 'MODELLED', metricKey: 'CashImpact', subjectHint: 'Rohto' },
      { label: 'Gross margin %', kind: 'MODELLED', metricKey: 'GrossMarginPct', subjectHint: 'Rohto' },
      { label: 'Customer service', kind: 'MODELLED', metricKey: 'DemandCoverage' },
    ],
  };
  const committed = await decisions.commit(scope, revisionId, input);
  if (!committed.ok) return committed;
  return ok({ decision: created.value.decision, revisionId, alternativeId: modelled.value.id, commitment: committed.value.commitment });
}
