/**
 * The app's access to the Phase 6 Authority Runtime.
 *
 * Wires ports together and holds no domain logic: every verdict, requirement
 * and explanation comes from @helm/authority-runtime. Demo mode seeds the
 * DEMO GOVERNANCE POLICY once per session, in memory, over the canonical
 * decision the decision service already built:
 *
 *   the Rohto commitment      REQUIRES_APPROVAL → the Country GM approves → APPROVED
 *   the Q1 call-off           AUTHORIZED — inside the Commercial Director's line
 *   the alternative analyzer  REQUIRES_APPROVAL, pending — Country GM, then Finance
 *
 * Evaluations and approval acts go through the TRUSTED authority service
 * (ADR-0024) and nothing else: in the cloud, the `helm-authority` edge
 * function — the only writer the database accepts, with the caller's identity
 * from their verified token — and in the demo, the same service in-process,
 * its verdicts labelled as such. The app sends identifiers, never facts.
 */

import {
  MERIDIAN_DEMO_PEOPLE,
  MERIDIAN_DEMO_UNITS,
  MERIDIAN_DEMO_USERS,
  buildCallOffScenario,
  buildProofDecision,
  canSeeDecision,
  createAuthorityRuntime,
  createTrustedAuthorityService,
  readableAmount,
  scopeAs,
  type AuthorityRuntime,
  type OrgUnit,
  type TrustedResponse,
} from '@helm/authority-runtime';
import { calculations } from './ontologyGraph.ts';
import { createPostgresAuthorityStore } from '@helm/authority-runtime/postgres';
import { systemClock, type Scope, type UserId } from '@helm/shared';
import { supabaseClient } from '../lib/supabaseClient.ts';
import { resolveDecisionContext, type DecisionWorkspaceContext } from './decisionRuntime.ts';
import type { ApprovalRequestView, GovernanceView } from '../components/decision/GovernancePanel.tsx';

export type DemoIdentity = { readonly userId: UserId; readonly label: string; readonly seat: string };

/** What the trusted authority service answered, in the app's terms. */
export type TrustedOutcome = { readonly ok: true; readonly body: Readonly<Record<string, unknown>> } | { readonly ok: false; readonly message: string };

export type ApprovalDecisionKind = 'APPROVE' | 'REJECT' | 'RETURN_FOR_RECONSIDERATION';

export type GovernanceContext = {
  /** Reads only. Every verdict and act goes through `evaluate` / `act` below. */
  runtime: AuthorityRuntime;
  /** Ask the trusted service to evaluate a commitment. The app sends its id, nothing else. */
  evaluate: (callerUserId: UserId, commitmentId: string) => Promise<TrustedOutcome>;
  /** Ask the trusted service to record an approval act by the (verified) caller. */
  act: (callerUserId: UserId, requiredApprovalId: string, decision: ApprovalDecisionKind, comments: string) => Promise<TrustedOutcome>;
  decisions: DecisionWorkspaceContext;
  scope: Scope;
  mode: 'demo' | 'cloud';
  /** Demo only: the fictional people who hold seats, so an approval can be recorded as one of them. */
  demoIdentities: readonly DemoIdentity[];
  /** The organization's units, for reading visibility grants. */
  units: readonly OrgUnit[];
};

let demoGovernance: Promise<GovernanceContext> | null = null;

const OP: Readonly<Record<ApprovalDecisionKind, 'approve' | 'reject' | 'return'>> = {
  APPROVE: 'approve',
  REJECT: 'reject',
  RETURN_FOR_RECONSIDERATION: 'return',
};

/** Demo only: which demo units each fictional seat-holder belongs to. */
const DEMO_MEMBERSHIP: Readonly<Record<string, readonly string[]>> = {
  [MERIDIAN_DEMO_USERS.countryGM]: ['unit-vn'],
  [MERIDIAN_DEMO_USERS.commercialDirector]: ['unit-vn-commercial'],
  [MERIDIAN_DEMO_USERS.financeDirector]: ['unit-vn-finance'],
  [MERIDIAN_DEMO_USERS.regionalMD]: ['unit-sea'],
  [MERIDIAN_DEMO_USERS.pharmaAnalyst]: ['unit-vn-pharma'],
  [MERIDIAN_DEMO_USERS.industrialHead]: ['unit-vn-industrial'],
};

const SEATS: Readonly<Record<keyof typeof MERIDIAN_DEMO_USERS, string>> = {
  countryGM: 'Country GM Vietnam',
  commercialDirector: 'Commercial Director Vietnam',
  financeDirector: 'Finance Director Vietnam',
  regionalMD: 'Regional MD Southeast Asia',
  pharmaAnalyst: 'Pharma Commercial Analyst Vietnam',
  industrialHead: 'Industrial BU Head Vietnam',
};

const must = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }, what: string): T => {
  if (!r.ok) throw new Error(`${what}: ${r.error.message}`);
  return r.value;
};

function getDemoGovernance(scope: Scope): Promise<GovernanceContext> {
  if (demoGovernance) return demoGovernance;
  demoGovernance = (async () => {
    const decisions = await resolveDecisionContext('demo', scope);
    if (!decisions) throw new Error('the demo decision workspace is unavailable');
    // The structure (roles, occupancies, DOA-2026-04) was recorded by the
    // decision service before it committed anything; reuse that runtime.
    const runtime = decisions.demoAuthority;
    const store = decisions.demoAuthorityStore;
    if (!runtime || !store) throw new Error('the demo authority runtime was not seeded');
    const graphs = decisions.scenarios.graphs;
    // The trusted service, in-process: the same code the helm-authority edge
    // function runs, over the demo's stores. Its verdicts say where they ran.
    const trusted = createTrustedAuthorityService({
      runtime: createAuthorityRuntime({
        store,
        decisions: decisions.store,
        scenarios: decisions.scenarios.runtime,
        graph: graphs.graphStore,
        clock: systemClock,
        evaluator: { kind: 'TRUSTED_SERVICE', host: 'in-process (demo)' },
      }),
      store,
      decisions: decisions.store,
      scenarios: decisions.scenarios.runtime,
      engine: graphs.engine,
      registry: calculations,
      valueGraph: graphs.valueGraph,
      membershipOf: async (userId) => ({ ok: true, value: { orgRole: userId === scope.actorId ? 'admin' : 'member', memberUnitIds: [] } }),
      callerCanSeeDecision: async (s, decisionId) => {
        const d = await decisions.store.getDecision(s, decisionId);
        const grants = await runtime.listVisibility(s, decisionId);
        if (!d.ok || !d.value || !grants.ok) return { ok: true, value: false };
        return {
          ok: true,
          value: canSeeDecision(
            { userId: String(s.actorId), orgRole: s.role, memberUnitIds: DEMO_MEMBERSHIP[String(s.actorId)] ?? [] },
            { createdBy: d.value.createdBy, grantedUnitIds: grants.value.map((g) => g.orgUnitId) },
            MERIDIAN_DEMO_UNITS,
          ).visible || String(s.actorId) === String(scope.actorId),
        };
      },
    });
    const outcome = (r: TrustedResponse): TrustedOutcome =>
      r.status === 200 ? { ok: true, body: r.body } : { ok: false, message: String((r.body.error as { message?: string } | undefined)?.message ?? `refused (${r.status})`) };
    const evaluate = async (caller: UserId, commitmentId: string) => outcome(await trusted.handle({ userId: caller }, { op: 'evaluate', orgId: scope.orgId, commitmentId }));
    const act = async (caller: UserId, requiredApprovalId: string, decision: ApprovalDecisionKind, comments: string) =>
      outcome(await trusted.handle({ userId: caller }, { op: OP[decision], orgId: scope.orgId, requiredApprovalId, comments }));

    const cd = scopeAs(scope, MERIDIAN_DEMO_USERS.commercialDirector);
    const unit = (id: string) => MERIDIAN_DEMO_UNITS.find((u) => u.id === id)!;
    const share = async (decisionId: string, unitIds: string[]) => {
      for (const id of unitIds) {
        must(await runtime.grantVisibility(cd, decisionId, { orgUnitId: id, orgUnitLabel: unit(id).label, reason: 'Demo: the units this decision concerns' }), 'share');
      }
    };

    // 1. The canonical Rohto commitment: classified, shared, evaluated, approved.
    if (decisions.canonicalDecisionId) {
      const id = decisions.canonicalDecisionId;
      must(await runtime.declareGovernanceProfile(cd, id, { decisionTypeKey: 'INVENTORY_ALLOCATION', note: 'Allocation of SKU-X stock to the Rohto order.' }), 'classify');
      await share(id, ['unit-vn-pharma', 'unit-vn-finance']);
      const commitments = must(await decisions.store.listCommitments(scope, id), 'commitments');
      const commitment = commitments[commitments.length - 1];
      if (commitment) {
        const evaluated = await evaluate(MERIDIAN_DEMO_USERS.countryGM, commitment.id);
        if (!evaluated.ok) throw new Error(`evaluate the Rohto commitment: ${evaluated.message}`);
        const required = evaluated.body.required as { id: string; roleLabel: string }[];
        const gm = required.find((r) => r.roleLabel === SEATS.countryGM);
        if (gm) {
          const approved = await act(
            MERIDIAN_DEMO_USERS.countryGM,
            gm.id,
            'APPROVE',
            'Approved within Country GM authority. The distributor-buffer risk is accepted for the quarter.',
          );
          if (!approved.ok) throw new Error(`Country GM approval: ${approved.message}`);
        }
      }
    }

    // 2. A smaller commitment inside the Commercial Director's own line.
    const callOff = must(
      await buildCallOffScenario(decisions.scenarios.runtime, scope, decisions.scenarios.graphs.nodeHandles ?? {}, decisions.scenarios.defaultFork),
      'call-off scenario',
    );
    const small = must(
      await buildProofDecision(decisions.runtime, cd, {
        title: 'Rohto 2027-Q1 framework call-off',
        managementQuestion: 'How should Meridian serve the Rohto framework call-off in 2027-Q1?',
        scenarioId: callOff.scenarioId,
        alternativeLabel: 'Call off from standard replenishment',
        committedByLabel: 'Commercial Director Vietnam',
      }),
      'call-off decision',
    );
    must(await runtime.declareGovernanceProfile(cd, small.decision.id, { decisionTypeKey: 'INVENTORY_ALLOCATION' }), 'classify call-off');
    await share(small.decision.id, ['unit-vn-pharma']);
    if (small.commitment) {
      const r = await evaluate(MERIDIAN_DEMO_USERS.commercialDirector, small.commitment.id);
      if (!r.ok) throw new Error(`evaluate the call-off: ${r.message}`);
    }

    // 3. One left pending: beyond both the Commercial Director and the Finance line.
    const alt = decisions.scenarios.scenarioIdsByKey['alternative-product'];
    if (alt) {
      const pending = must(
        await buildProofDecision(decisions.runtime, cd, {
          title: 'Offer the alternative analyzer to Rohto',
          managementQuestion: 'Should Meridian serve the Rohto order with the in-stock alternative analyzer?',
          scenarioId: alt,
          alternativeLabel: 'Offer the alternative analyzer',
          committedByLabel: 'Commercial Director Vietnam',
        }),
        'alternative decision',
      );
      must(await runtime.declareGovernanceProfile(cd, pending.decision.id, { decisionTypeKey: 'INVENTORY_ALLOCATION' }), 'classify alternative');
      await share(pending.decision.id, ['unit-vn-pharma', 'unit-vn-finance']);
      if (pending.commitment) {
        const r = await evaluate(MERIDIAN_DEMO_USERS.commercialDirector, pending.commitment.id);
        if (!r.ok) throw new Error(`evaluate the alternative: ${r.message}`);
      }
    }

    return {
      runtime,
      evaluate,
      act,
      decisions,
      scope,
      mode: 'demo' as const,
      demoIdentities: (Object.keys(MERIDIAN_DEMO_USERS) as (keyof typeof MERIDIAN_DEMO_USERS)[]).map((k) => ({
        userId: MERIDIAN_DEMO_USERS[k],
        label: MERIDIAN_DEMO_PEOPLE[k],
        seat: SEATS[k],
      })),
      units: MERIDIAN_DEMO_UNITS,
    };
  })();
  return demoGovernance;
}

async function getCloudGovernance(scope: Scope): Promise<GovernanceContext | null> {
  const decisions = await resolveDecisionContext('cloud', scope);
  if (!decisions || !supabaseClient) return null;
  const runtime = createAuthorityRuntime({
    store: createPostgresAuthorityStore({ client: supabaseClient, clock: systemClock }),
    decisions: decisions.store,
    scenarios: decisions.scenarios.runtime,
    graph: decisions.scenarios.graphs.graphStore,
    clock: systemClock,
  });
  const { data } = await supabaseClient.from('org_units').select('id, parent_id, name, unit_type').eq('org_id', scope.orgId);
  const units = ((data as { id: string; parent_id: string | null; name: string; unit_type: string }[] | null) ?? []).map((u) => ({
    id: u.id,
    parentId: u.parent_id,
    label: u.name,
    unitType: u.unit_type,
  }));
  // The helm-authority edge function is the only writer of authority records the
  // database accepts. The caller's identity travels as their session token.
  const call = async (body: Record<string, unknown>): Promise<TrustedOutcome> => {
    if (!supabaseClient) return { ok: false, message: 'Not connected.' };
    const { data, error } = await supabaseClient.functions.invoke('helm-authority', { body: { ...body, orgId: scope.orgId } });
    if (error) return { ok: false, message: error.message };
    const answer = data as { ok?: boolean; error?: { message?: string } } | null;
    return answer?.ok ? { ok: true, body: answer as Record<string, unknown> } : { ok: false, message: answer?.error?.message ?? 'The authority service refused the request.' };
  };
  return {
    runtime,
    evaluate: (_caller, commitmentId) => call({ op: 'evaluate', commitmentId }),
    act: (_caller, requiredApprovalId, decision, comments) => call({ op: OP[decision], requiredApprovalId, comments }),
    decisions,
    scope,
    mode: 'cloud',
    demoIdentities: [],
    units,
  };
}

export async function resolveGovernanceContext(mode: 'demo' | 'cloud', scope: Scope): Promise<GovernanceContext | null> {
  return mode === 'demo' ? getDemoGovernance(scope) : getCloudGovernance(scope);
}

/**
 * The scope an act is recorded under. In the cloud it is always the signed-in
 * user; in the demo, one of the fictional seat-holders, chosen on screen and
 * labelled as such.
 */
export function actingScope(ctx: GovernanceContext, demoUserId: UserId | null): Scope {
  return ctx.mode === 'demo' && demoUserId ? scopeAs(ctx.scope, demoUserId) : ctx.scope;
}

/** "REQUIRES_APPROVAL" → "Requires approval". For reading only. */
export const sentence = (v: string): string => {
  const s = v.replaceAll('_', ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// ------------------------------------------------------------ read models
// Formatting only: every value below is read off records the runtime made.

const dayTime = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

export async function loadGovernanceView(ctx: GovernanceContext, commitmentId: string): Promise<GovernanceView | null> {
  const state = await ctx.runtime.getGovernanceState(ctx.scope, commitmentId);
  if (!state.ok) throw new Error(state.error.message);
  const s = state.value;
  const e = s.evaluation;
  if (!e) return null;
  const occupancies = await ctx.runtime.listOccupancies(ctx.scope);
  const person = (userId: string | null) =>
    (occupancies.ok ? occupancies.value.find((o) => o.userId === userId)?.personLabel : undefined) ?? 'the person who committed';
  const deciding = e.rules.find((r) => r.deciding);
  const waiting = s.requirements.filter((r) => !r.satisfied).map((r) => r.requirement.roleLabel);
  const approvers = s.requirements.flatMap((r) => r.acts).map((a) => `${a.approverLabel} (${a.approverRoleLabel})`);
  const headline: Record<string, string> = {
    AUTHORIZED: `Within ${e.actorLabel}'s own authority${e.basisDelegationId ? ', through a delegation' : ''}: no approval is needed.`,
    PENDING_APPROVAL: `Beyond ${e.actorLabel}'s authority. Waiting on ${waiting.join(' and ')}.`,
    ESCALATED: `Beyond every authority it first reaches. Escalated to ${waiting.join(' and ')}.`,
    APPROVED: `Beyond ${e.actorLabel}'s authority, and approved by ${approvers.join(' and ')}.`,
    REJECTED: `Rejected by ${approvers.join(' and ')}. The commitment stands as history; answering it means reconsidering.`,
    RETURNED: `Returned for reconsideration by ${approvers.join(' and ')}.`,
    NOT_AUTHORIZED: `NOT AUTHORIZED: ${e.actorLabel} holds no authority that reaches this commitment.`,
    INDETERMINATE: 'UNKNOWN: HELM cannot establish whether this was within authority, and will not guess.',
  };
  return {
    state: s.state,
    policyResult: s.policyResult,
    progress: s.approvalProgress,
    headline: headline[s.state] ?? s.statement,
    alarm: ['NOT_AUTHORIZED', 'INDETERMINATE', 'REJECTED'].includes(s.state),
    statement: s.statement,
    basis: e.policies.map((p) => `${p.reference} v${p.version}${p.demo ? ' · demo' : ''}`).join(', ') || 'none in force',
    actor: `${e.actorLabel} · ${e.actorRoles.map((r) => r.roleLabel).join(', ') || 'no role'}`,
    fingerprint: e.fingerprint,
    evaluatedAt: dayTime(e.evaluatedAt),
    evaluator:
      e.evaluator.kind === 'TRUSTED_SERVICE'
        ? `trusted service · ${e.evaluator.host}${e.evaluator.consequenceCheck.status === 'TRACE_VERIFIED' ? ` · ${e.evaluator.consequenceCheck.checkedSteps} steps re-derived` : ''}`
        : 'client runtime · not a trusted verdict',
    consequences: e.consequences
      .filter((c) => c.value !== null)
      .map((c) => ({ label: c.label, value: readableAmount(c.value!, c.unit, c.currency) })),
    why: [...(deciding ? [`Deciding rule: "${deciding.ruleKey}" — ${deciding.specificity}.`] : []), ...e.explanation],
    requirements: s.requirements.map((r) => {
      const act = r.acts[0];
      return {
        id: r.requirement.id,
        role: r.requirement.roleLabel,
        kind: r.requirement.kind,
        sequence: r.requirement.sequence,
        status: act ? act.decision : 'PENDING',
        occupants: e.requiredAuthorities.find((x) => x.roleId === r.requirement.roleId)?.currentOccupants.map((o) => o.label).join(', ') ?? '',
        independentOf: r.requirement.independentOfUserId ? person(r.requirement.independentOfUserId) : null,
        reason: r.requirement.reason,
        act: act
          ? {
              by: act.approverLabel,
              at: dayTime(act.actedAt),
              basis: act.basis.kind === 'DELEGATION' ? 'by delegation' : `as ${act.approverRoleLabel}`,
              comments: act.comments,
              note: r.note,
            }
          : undefined,
      };
    }),
    gaps: e.gaps.map((g) => ({ message: g.message, blocking: g.blocking })),
  };
}

export async function loadApprovalRequest(ctx: GovernanceContext, requiredApprovalId: string): Promise<ApprovalRequestView> {
  const r = await ctx.runtime.approvalRequest(ctx.scope, requiredApprovalId);
  if (!r.ok) throw new Error(r.error.message);
  const q = r.value;
  return {
    question: q.managementQuestion,
    chosen: q.chosenAlternative.label,
    committedBy: `${q.committedByLabel} · ${dayTime(q.committedAt)}`,
    consequences: q.keyConsequences.map((c) => ({ label: c.label, value: readableAmount(c.value!, c.unit, c.currency) })),
    tradeOffs: [...q.acceptedTradeOffs],
    uncertainty: [...q.uncertainty],
    reason: [...q.authorityReason],
  };
}

/** The latest commitment of a decision, for the governance panel. */
export async function latestCommitmentId(ctx: GovernanceContext, decisionId: string): Promise<string | null> {
  const list = await ctx.decisions.store.listCommitments(ctx.scope, decisionId);
  if (!list.ok) throw new Error(list.error.message);
  return list.value[list.value.length - 1]?.id ?? null;
}
