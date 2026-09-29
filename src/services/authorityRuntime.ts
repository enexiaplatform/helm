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
 * Cloud mode uses the Postgres stores with RLS doing the isolation; the
 * approver of an act is always the signed-in user, and the database checks
 * their seat again.
 */

import {
  MERIDIAN_DEMO_PEOPLE,
  MERIDIAN_DEMO_UNITS,
  MERIDIAN_DEMO_USERS,
  buildCallOffScenario,
  buildProofDecision,
  createAuthorityRuntime,
  readableAmount,
  scopeAs,
  type AuthorityRuntime,
  type OrgUnit,
} from '@helm/authority-runtime';
import { createPostgresAuthorityStore } from '@helm/authority-runtime/postgres';
import { systemClock, type Scope, type UserId } from '@helm/shared';
import { supabaseClient } from '../lib/supabaseClient.ts';
import { resolveDecisionContext, type DecisionWorkspaceContext } from './decisionRuntime.ts';
import type { ApprovalRequestView, GovernanceView } from '../components/decision/GovernancePanel.tsx';

export type DemoIdentity = { readonly userId: UserId; readonly label: string; readonly seat: string };

export type GovernanceContext = {
  runtime: AuthorityRuntime;
  decisions: DecisionWorkspaceContext;
  scope: Scope;
  mode: 'demo' | 'cloud';
  /** Demo only: the fictional people who hold seats, so an approval can be recorded as one of them. */
  demoIdentities: readonly DemoIdentity[];
  /** The organization's units, for reading visibility grants. */
  units: readonly OrgUnit[];
};

let demoGovernance: Promise<GovernanceContext> | null = null;

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
    if (!runtime) throw new Error('the demo authority runtime was not seeded');

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
        const { required } = must(await runtime.evaluate(scope, commitment.id), 'evaluate the Rohto commitment');
        const gm = required.find((r) => r.roleLabel === SEATS.countryGM);
        if (gm) {
          must(
            await runtime.recordApproval(scopeAs(scope, MERIDIAN_DEMO_USERS.countryGM), gm.id, {
              comments: 'Approved within Country GM authority. The distributor-buffer risk is accepted for the quarter.',
            }),
            'Country GM approval',
          );
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
    if (small.commitment) must(await runtime.evaluate(scope, small.commitment.id), 'evaluate the call-off');

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
      if (pending.commitment) must(await runtime.evaluate(scope, pending.commitment.id), 'evaluate the alternative');
    }

    return {
      runtime,
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
  return { runtime, decisions, scope, mode: 'cloud', demoIdentities: [], units };
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
