import { create } from 'zustand';
import { supabaseClient } from '../lib/supabaseClient.ts';
import type {
  ApprovalRule,
  CostObject,
  Decision,
  DecisionAction,
  DecisionAlternative,
  DecisionAssumption,
  DecisionEvent,
  DecisionStatus,
  DecisionType,
  EconomicsRow,
  ExpectedMetric,
  FinancialLine,
  InventoryItem,
  OrgMember,
  OrgRole,
  OrgUnit,
  Organization,
  OutcomeScore,
  Process,
  ProcessActivity,
  Signal,
  SignalStatus,
} from '../domain/types.ts';
import { orgRoleRank } from '../domain/types.ts';
import { canTransition, requiresApproval } from '../domain/decisionStates.ts';
import { detectSignals } from '../domain/engines/signals.ts';
import {
  demoActions,
  demoAlternatives,
  demoApprovalRules,
  demoAssumptions,
  demoCostObjects,
  demoDecisions,
  demoEconomics,
  demoEvents,
  demoInventory,
  demoMembers,
  demoMemoireOpportunities,
  demoOrganization,
  demoProcessActivities,
  demoProcesses,
  demoUnits,
  DEMO_USER_ID,
} from '../data/demoOrg.ts';
import * as map from './mappers.ts';
import {
  listMemoireOpportunities,
  writebackDecisionToMemoire,
  type MemoireOpportunity,
} from './memoireBridge.ts';

/**
 * The single application store. Demo mode mutates local state only (demo data
 * never syncs — the ecosystem rule); cloud mode writes to Supabase first and
 * mirrors into state. Decision state changes go exclusively through
 * `transitionDecision`, which enforces the state machine and appends an audit
 * event for every move.
 */

type Mode = 'demo' | 'cloud';

const uid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

type HelmState = {
  authReady: boolean;
  userId: string | null;
  userEmail: string | null;
  mode: Mode | null;
  organizations: Organization[];
  activeOrgId: string | null;
  loadingData: boolean;
  error: string | null;

  units: OrgUnit[];
  members: OrgMember[];
  costObjects: CostObject[];
  economics: EconomicsRow[];
  inventory: InventoryItem[];
  processes: Process[];
  processActivities: ProcessActivity[];
  signals: Signal[];
  decisions: Decision[];
  alternatives: DecisionAlternative[];
  assumptions: DecisionAssumption[];
  events: DecisionEvent[];
  actions: DecisionAction[];
  approvalRules: ApprovalRule[];
  memoireOpportunities: MemoireOpportunity[];

  // ---- auth & context ----
  initAuth: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<string | null>;
  signUp: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  enterDemo: () => void;
  exitDemo: () => void;
  loadOrganizations: () => Promise<void>;
  createOrganization: (name: string, currency: string, fyStart: number) => Promise<string | null>;
  setActiveOrg: (orgId: string) => Promise<void>;
  addMemberByEmail: (email: string, role: OrgRole) => Promise<string | null>;

  // ---- derived ----
  activeOrg: () => Organization | null;
  myRole: () => OrgRole;
  currency: () => string;

  // ---- signals ----
  refreshSignals: () => Promise<void>;
  setSignalStatus: (signalId: string, status: SignalStatus) => Promise<void>;

  // ---- decisions ----
  createDecision: (input: {
    decisionType: DecisionType;
    title: string;
    context?: string;
    problem?: string;
    objective?: string;
    amountAtStake?: number | null;
    signalId?: string | null;
    orgUnitId?: string | null;
    memoireAccountId?: string | null;
    memoireOpportunityId?: string | null;
    contextSnapshot?: Record<string, unknown> | null;
  }) => Promise<string | null>;
  updateDecision: (
    id: string,
    fields: Partial<
      Pick<
        Decision,
        | 'title'
        | 'context'
        | 'problem'
        | 'objective'
        | 'dueDate'
        | 'reviewAfter'
        | 'amountAtStake'
        | 'recommendation'
        | 'expectedOutcome'
        | 'expectedMetrics'
        | 'orgUnitId'
      >
    >,
  ) => Promise<void>;
  transitionDecision: (
    id: string,
    to: DecisionStatus,
    extras?: {
      decidedAlternativeId?: string | null;
      decisionRationale?: string;
      rejectedReason?: string;
      actualOutcome?: string;
      outcomeScore?: OutcomeScore;
      lesson?: string;
      expectedMetrics?: ExpectedMetric[];
    },
  ) => Promise<string | null>;

  addAlternative: (decisionId: string, name: string) => Promise<void>;
  updateAlternative: (
    id: string,
    fields: Partial<
      Pick<
        DecisionAlternative,
        'name' | 'description' | 'financialLines' | 'qualitative' | 'strategic' | 'risks' | 'isRecommended'
      >
    >,
  ) => Promise<void>;
  removeAlternative: (id: string) => Promise<void>;

  addAssumption: (decisionId: string, statement: string) => Promise<void>;
  updateAssumption: (
    id: string,
    fields: Partial<Pick<DecisionAssumption, 'statement' | 'basis' | 'sensitivity' | 'validated'>>,
  ) => Promise<void>;
  removeAssumption: (id: string) => Promise<void>;

  addAction: (decisionId: string, title: string, ownerLabel: string, dueDate: string | null) => Promise<void>;
  setActionStatus: (id: string, status: DecisionAction['status']) => Promise<void>;

  // ---- approval rules ----
  saveApprovalRule: (rule: Omit<ApprovalRule, 'orgId' | 'id'> & { id?: string }) => Promise<void>;
  removeApprovalRule: (id: string) => Promise<void>;

  // ---- memoire ----
  loadMemoireOpportunities: () => Promise<void>;
};

const emptyData = {
  units: [] as OrgUnit[],
  members: [] as OrgMember[],
  costObjects: [] as CostObject[],
  economics: [] as EconomicsRow[],
  inventory: [] as InventoryItem[],
  processes: [] as Process[],
  processActivities: [] as ProcessActivity[],
  signals: [] as Signal[],
  decisions: [] as Decision[],
  alternatives: [] as DecisionAlternative[],
  assumptions: [] as DecisionAssumption[],
  events: [] as DecisionEvent[],
  actions: [] as DecisionAction[],
  approvalRules: [] as ApprovalRule[],
  memoireOpportunities: [] as MemoireOpportunity[],
};

export const useHelmStore = create<HelmState>((set, get) => {
  const isDemo = () => get().mode === 'demo';

  /** Write path helper: run the cloud mutation only in cloud mode; always run
   * the local mirror. Cloud failures surface in `error` and skip the mirror. */
  const write = async (cloud: () => Promise<void>, local: () => void): Promise<string | null> => {
    if (!isDemo()) {
      try {
        await cloud();
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Write failed';
        set({ error: message });
        return message;
      }
    }
    local();
    return null;
  };

  const appendEvent = async (decisionId: string, eventType: string, payload: Record<string, unknown>) => {
    const { activeOrgId, userId } = get();
    if (!activeOrgId) return;
    const event: DecisionEvent = {
      id: uid(),
      orgId: activeOrgId,
      decisionId,
      eventType,
      actorId: userId ?? DEMO_USER_ID,
      payload,
      createdAt: nowIso(),
    };
    await write(
      async () => {
        if (!supabaseClient) throw new Error('Cloud not configured');
        const { error } = await supabaseClient.from('helm_decision_events').insert({
          id: event.id,
          org_id: event.orgId,
          decision_id: decisionId,
          event_type: eventType,
          actor_id: event.actorId,
          payload,
        });
        if (error) throw new Error(error.message);
      },
      () => set((st) => ({ events: [...st.events, event] })),
    );
  };

  return {
    authReady: false,
    userId: null,
    userEmail: null,
    mode: null,
    organizations: [],
    activeOrgId: null,
    loadingData: false,
    error: null,
    ...emptyData,

    // ------------------------------------------------------------------ auth

    initAuth: async () => {
      // Demo survives a reload within the browser session — but never syncs.
      if (sessionStorage.getItem('helm.demo') === '1') {
        get().enterDemo();
        set({ authReady: true });
        return;
      }
      if (!supabaseClient) {
        set({ authReady: true });
        return;
      }
      const { data } = await supabaseClient.auth.getSession();
      const session = data.session;
      set({
        authReady: true,
        userId: session?.user?.id ?? null,
        userEmail: session?.user?.email ?? null,
      });
      supabaseClient.auth.onAuthStateChange((_evt, s) => {
        set({ userId: s?.user?.id ?? null, userEmail: s?.user?.email ?? null });
        if (!s) set({ mode: null, organizations: [], activeOrgId: null, ...emptyData });
      });
      if (session) {
        set({ mode: 'cloud' });
        await get().loadOrganizations();
      }
    },

    signIn: async (email, password) => {
      if (!supabaseClient) return 'Cloud is not configured';
      const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) return error.message;
      set({ mode: 'cloud' });
      await get().loadOrganizations();
      return null;
    },

    signUp: async (email, password) => {
      if (!supabaseClient) return 'Cloud is not configured';
      const { error } = await supabaseClient.auth.signUp({ email, password });
      if (error) return error.message;
      set({ mode: 'cloud' });
      await get().loadOrganizations();
      return null;
    },

    signOut: async () => {
      await supabaseClient?.auth.signOut();
      set({ mode: null, organizations: [], activeOrgId: null, userId: null, userEmail: null, ...emptyData });
    },

    enterDemo: () => {
      sessionStorage.setItem('helm.demo', '1');
      set({
        mode: 'demo',
        userId: DEMO_USER_ID,
        userEmail: 'you@meridian.example',
        organizations: [demoOrganization],
        activeOrgId: demoOrganization.id,
        units: demoUnits,
        members: demoMembers,
        costObjects: demoCostObjects,
        economics: demoEconomics,
        inventory: demoInventory,
        processes: demoProcesses,
        processActivities: demoProcessActivities,
        signals: [],
        decisions: demoDecisions,
        alternatives: demoAlternatives,
        assumptions: demoAssumptions,
        events: demoEvents,
        actions: demoActions,
        approvalRules: demoApprovalRules,
        memoireOpportunities: demoMemoireOpportunities.map((o) => ({
          id: o.id,
          accountId: null,
          accountName: o.accountName,
          title: o.title,
          value: o.value,
          currency: o.currency,
          stage: o.stage,
        })),
        error: null,
      });
      void get().refreshSignals();
    },

    exitDemo: () => {
      sessionStorage.removeItem('helm.demo');
      set({ mode: null, organizations: [], activeOrgId: null, userId: null, userEmail: null, ...emptyData });
    },

    // ------------------------------------------------------------------ orgs

    loadOrganizations: async () => {
      if (!supabaseClient) return;
      const { data: memberships } = await supabaseClient
        .from('organization_memberships')
        .select('org_id, role, organizations(id, name, base_currency, fiscal_year_start_month)');
      const orgs: Organization[] = (memberships ?? [])
        .map((m) => {
          const o = m.organizations as unknown as {
            id: string;
            name: string;
            base_currency: string;
            fiscal_year_start_month: number;
          } | null;
          if (!o) return null;
          return {
            id: o.id,
            name: o.name,
            baseCurrency: o.base_currency,
            fiscalYearStartMonth: o.fiscal_year_start_month,
            role: m.role as OrgRole,
          };
        })
        .filter((o): o is Organization => o !== null);
      set({ organizations: orgs });
      const { activeOrgId } = get();
      if (orgs.length > 0 && (!activeOrgId || !orgs.some((o) => o.id === activeOrgId))) {
        await get().setActiveOrg(orgs[0].id);
      }
    },

    createOrganization: async (name, currency, fyStart) => {
      if (!supabaseClient) return 'Cloud is not configured';
      const { data, error } = await supabaseClient.rpc('create_organization', {
        p_name: name,
        p_currency: currency,
        p_fy_start: fyStart,
      });
      if (error) return error.message;
      await get().loadOrganizations();
      if (typeof data === 'string') await get().setActiveOrg(data);
      return null;
    },

    setActiveOrg: async (orgId) => {
      set({ activeOrgId: orgId, loadingData: true, error: null, ...emptyData });
      if (isDemo() || !supabaseClient) {
        set({ loadingData: false });
        return;
      }
      const sb = supabaseClient;
      const q = (table: string) => sb.from(table).select('*').eq('org_id', orgId);
      try {
        const [units, costObjects, economics, inventory, processes, activities, signals, decisions, alternatives, assumptions, events, actions, rules, memberRows] =
          await Promise.all([
            q('org_units'),
            q('helm_cost_objects'),
            q('helm_economics'),
            q('helm_inventory_items'),
            q('helm_processes'),
            q('helm_process_activities'),
            q('helm_signals'),
            q('helm_decisions'),
            q('helm_decision_alternatives'),
            q('helm_decision_assumptions'),
            q('helm_decision_events'),
            q('helm_actions'),
            q('helm_approval_rules'),
            sb
              .from('organization_memberships')
              .select('user_id, role, user_profiles:user_profiles!inner(id, email, display_name)')
              .eq('org_id', orgId),
          ]);
        const first = [units, costObjects, economics, inventory, processes, activities, signals, decisions, alternatives, assumptions, events, actions, rules].find((r) => r.error);
        if (first?.error) throw new Error(first.error.message);

        const members: OrgMember[] = (memberRows.data ?? []).map((m) => {
          const p = m.user_profiles as unknown as { id: string; email: string; display_name: string | null } | null;
          return {
            userId: m.user_id as string,
            email: p?.email ?? '',
            displayName: p?.display_name || p?.email || 'Member',
            role: m.role as OrgRole,
          };
        });

        set({
          units: (units.data ?? []).map(map.mapOrgUnit),
          costObjects: (costObjects.data ?? []).map(map.mapCostObject),
          economics: (economics.data ?? []).map(map.mapEconomics),
          inventory: (inventory.data ?? []).map(map.mapInventoryItem),
          processes: (processes.data ?? []).map(map.mapProcess),
          processActivities: (activities.data ?? []).map(map.mapProcessActivity),
          signals: (signals.data ?? []).map(map.mapSignal),
          decisions: (decisions.data ?? []).map(map.mapDecision),
          alternatives: (alternatives.data ?? []).map(map.mapAlternative),
          assumptions: (assumptions.data ?? []).map(map.mapAssumption),
          events: (events.data ?? []).map(map.mapEvent),
          actions: (actions.data ?? []).map(map.mapAction),
          approvalRules: (rules.data ?? []).map(map.mapApprovalRule),
          members,
          loadingData: false,
        });
        await get().refreshSignals();
        void get().loadMemoireOpportunities();
      } catch (e) {
        set({ loadingData: false, error: e instanceof Error ? e.message : 'Failed to load organization data' });
      }
    },

    addMemberByEmail: async (email, role) => {
      const { activeOrgId } = get();
      if (isDemo()) return 'Demo mode: members are read-only';
      if (!supabaseClient || !activeOrgId) return 'Cloud is not configured';
      const { error } = await supabaseClient.rpc('add_org_member', {
        p_org: activeOrgId,
        p_email: email,
        p_role: role,
      });
      if (error) return error.message;
      await get().setActiveOrg(activeOrgId);
      return null;
    },

    // --------------------------------------------------------------- derived

    activeOrg: () => {
      const { organizations, activeOrgId } = get();
      return organizations.find((o) => o.id === activeOrgId) ?? null;
    },
    myRole: () => get().activeOrg()?.role ?? 'viewer',
    currency: () => get().activeOrg()?.baseCurrency ?? 'USD',

    // --------------------------------------------------------------- signals

    refreshSignals: async () => {
      const st = get();
      const org = st.activeOrg();
      if (!org) return;
      const candidates = detectSignals({
        currency: org.baseCurrency,
        costObjects: st.costObjects,
        economics: st.economics,
        inventory: st.inventory,
        processes: st.processes,
        processActivities: st.processActivities,
        decisions: st.decisions,
      });
      const existingByKey = new Map(st.signals.map((sg) => [sg.dedupeKey, sg]));
      const merged: Signal[] = candidates.map((c) => {
        const existing = existingByKey.get(c.dedupeKey);
        return {
          ...c,
          id: existing?.id ?? uid(),
          orgId: org.id,
          status: existing?.status ?? 'open',
          decisionId: existing?.decisionId ?? null,
          detectedAt: existing?.detectedAt ?? nowIso(),
        };
      });
      // Converted signals whose condition cleared stay visible via their
      // decision; open ones that cleared simply drop out of the inbox.
      set({ signals: merged });

      if (!isDemo() && supabaseClient) {
        const rows = merged.map((sg) => ({
          id: sg.id,
          org_id: sg.orgId,
          rule_code: sg.ruleCode,
          dedupe_key: sg.dedupeKey,
          severity: sg.severity,
          title: sg.title,
          reason: sg.reason,
          threshold_label: sg.thresholdLabel,
          measured_label: sg.measuredLabel,
          evidence: sg.evidence,
          entity_kind: sg.entityKind,
          entity_id: sg.entityId,
          status: sg.status,
          decision_id: sg.decisionId,
          detected_at: sg.detectedAt,
        }));
        if (rows.length > 0) {
          await supabaseClient.from('helm_signals').upsert(rows, { onConflict: 'org_id,dedupe_key' });
        }
      }
    },

    setSignalStatus: async (signalId, status) => {
      const sg = get().signals.find((x) => x.id === signalId);
      if (!sg) return;
      await write(
        async () => {
          if (!supabaseClient) throw new Error('Cloud not configured');
          const { error } = await supabaseClient
            .from('helm_signals')
            .update({ status, resolved_at: status === 'dismissed' ? nowIso() : null })
            .eq('id', signalId);
          if (error) throw new Error(error.message);
        },
        () =>
          set((st) => ({
            signals: st.signals.map((x) => (x.id === signalId ? { ...x, status } : x)),
          })),
      );
    },

    // ------------------------------------------------------------- decisions

    createDecision: async (input) => {
      const st = get();
      const org = st.activeOrg();
      if (!org) return null;
      const id = uid();
      const decision: Decision = {
        id,
        orgId: org.id,
        orgUnitId: input.orgUnitId ?? null,
        decisionType: input.decisionType,
        title: input.title,
        context: input.context ?? '',
        problem: input.problem ?? '',
        objective: input.objective ?? '',
        status: 'draft',
        ownerId: st.userId,
        dueDate: null,
        reviewAfter: null,
        currency: org.baseCurrency,
        amountAtStake: input.amountAtStake ?? null,
        recommendation: '',
        decidedAlternativeId: null,
        decisionRationale: '',
        expectedOutcome: '',
        expectedMetrics: [],
        actualOutcome: '',
        outcomeScore: null,
        lesson: '',
        signalId: input.signalId ?? null,
        memoireAccountId: input.memoireAccountId ?? null,
        memoireOpportunityId: input.memoireOpportunityId ?? null,
        contextSnapshot: input.contextSnapshot ?? null,
        approvedBy: null,
        approvedAt: null,
        rejectedReason: '',
        closedAt: null,
        createdBy: st.userId ?? DEMO_USER_ID,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      const err = await write(
        async () => {
          if (!supabaseClient) throw new Error('Cloud not configured');
          const { error } = await supabaseClient.from('helm_decisions').insert({
            id,
            org_id: org.id,
            org_unit_id: decision.orgUnitId,
            decision_type: decision.decisionType,
            title: decision.title,
            context: decision.context,
            problem: decision.problem,
            objective: decision.objective,
            status: 'draft',
            owner_id: decision.ownerId,
            currency: decision.currency,
            amount_at_stake: decision.amountAtStake,
            signal_id: decision.signalId,
            memoire_account_id: decision.memoireAccountId,
            memoire_opportunity_id: decision.memoireOpportunityId,
            context_snapshot: decision.contextSnapshot,
          });
          if (error) throw new Error(error.message);
        },
        () => set((s2) => ({ decisions: [...s2.decisions, decision] })),
      );
      if (err) return null;
      await appendEvent(id, 'created', {
        template: input.decisionType,
        fromSignal: input.signalId ?? undefined,
        fromMemoireOpportunity: input.memoireOpportunityId ?? undefined,
      });
      if (input.signalId) {
        const sg = st.signals.find((x) => x.id === input.signalId);
        if (sg) {
          await write(
            async () => {
              if (!supabaseClient) throw new Error('Cloud not configured');
              const { error } = await supabaseClient
                .from('helm_signals')
                .update({ status: 'converted', decision_id: id })
                .eq('id', sg.id);
              if (error) throw new Error(error.message);
            },
            () =>
              set((s2) => ({
                signals: s2.signals.map((x) =>
                  x.id === sg.id ? { ...x, status: 'converted', decisionId: id } : x,
                ),
              })),
          );
        }
      }
      return id;
    },

    updateDecision: async (id, fields) => {
      await write(
        async () => {
          if (!supabaseClient) throw new Error('Cloud not configured');
          const { error } = await supabaseClient
            .from('helm_decisions')
            .update({
              title: fields.title,
              context: fields.context,
              problem: fields.problem,
              objective: fields.objective,
              due_date: fields.dueDate,
              review_after: fields.reviewAfter,
              amount_at_stake: fields.amountAtStake,
              recommendation: fields.recommendation,
              expected_outcome: fields.expectedOutcome,
              expected_metrics: fields.expectedMetrics,
              org_unit_id: fields.orgUnitId,
            })
            .eq('id', id);
          if (error) throw new Error(error.message);
        },
        () =>
          set((st) => ({
            decisions: st.decisions.map((d) =>
              d.id === id ? { ...d, ...fields, updatedAt: nowIso() } : d,
            ),
          })),
      );
    },

    transitionDecision: async (id, to, extras = {}) => {
      const st = get();
      const decision = st.decisions.find((d) => d.id === id);
      if (!decision) return 'Decision not found';
      if (!canTransition(decision.status, to)) {
        return `Illegal transition: ${decision.status} → ${to}`;
      }
      // Approval gate: skipping pending_approval is only legal when no active
      // rule demands it.
      if (decision.status === 'analyzing' && to === 'approved') {
        if (requiresApproval(decision.amountAtStake, decision.decisionType, st.approvalRules)) {
          return 'This decision requires approval — submit it for approval instead.';
        }
      }
      // Approving requires the rule's role.
      if (to === 'approved' || to === 'rejected') {
        const matching = st.approvalRules.filter(
          (r) =>
            r.active &&
            (r.decisionType === null || r.decisionType === decision.decisionType) &&
            Math.abs(decision.amountAtStake ?? 0) >= r.thresholdAmount,
        );
        const needed: OrgRole = matching.some((r) => r.requiredRole === 'admin') ? 'admin' : 'manager';
        if (decision.status === 'pending_approval' && orgRoleRank[st.myRole()] < orgRoleRank[needed]) {
          return `Approval requires the ${needed} role.`;
        }
      }

      const patch: Partial<Decision> = { status: to };
      if (to === 'approved') {
        patch.approvedBy = st.userId;
        patch.approvedAt = nowIso();
        patch.decidedAlternativeId = extras.decidedAlternativeId ?? decision.decidedAlternativeId;
        patch.decisionRationale = extras.decisionRationale ?? decision.decisionRationale;
        if (extras.expectedMetrics) patch.expectedMetrics = extras.expectedMetrics;
      }
      if (to === 'rejected') patch.rejectedReason = extras.rejectedReason ?? '';
      if (to === 'closed') {
        patch.closedAt = nowIso();
        patch.actualOutcome = extras.actualOutcome ?? decision.actualOutcome;
        patch.outcomeScore = extras.outcomeScore ?? decision.outcomeScore;
        patch.lesson = extras.lesson ?? decision.lesson;
      }

      const err = await write(
        async () => {
          if (!supabaseClient) throw new Error('Cloud not configured');
          const { error } = await supabaseClient
            .from('helm_decisions')
            .update({
              status: to,
              approved_by: patch.approvedBy,
              approved_at: patch.approvedAt,
              decided_alternative_id: patch.decidedAlternativeId,
              decision_rationale: patch.decisionRationale,
              expected_metrics: patch.expectedMetrics,
              rejected_reason: patch.rejectedReason,
              closed_at: patch.closedAt,
              actual_outcome: patch.actualOutcome,
              outcome_score: patch.outcomeScore,
              lesson: patch.lesson,
            })
            .eq('id', id);
          if (error) throw new Error(error.message);
        },
        () =>
          set((s2) => ({
            decisions: s2.decisions.map((d) =>
              d.id === id ? { ...d, ...patch, updatedAt: nowIso() } : d,
            ),
          })),
      );
      if (err) return err;

      await appendEvent(id, to === 'approved' ? 'approved' : to === 'rejected' ? 'rejected' : 'status_changed', {
        from: decision.status,
        to,
        ...(extras.decisionRationale ? { rationale: extras.decisionRationale } : {}),
        ...(extras.rejectedReason ? { reason: extras.rejectedReason } : {}),
        ...(extras.lesson ? { lesson: extras.lesson } : {}),
      });

      // Execution write-back into Memoire: same database, same user, explicit
      // provenance. Only in cloud mode and only when the decision references a
      // Memoire record.
      if (to === 'executing' && !isDemo() && (decision.memoireOpportunityId || decision.memoireAccountId)) {
        try {
          const chosen = get().alternatives.find((a) => a.id === (patch.decidedAlternativeId ?? decision.decidedAlternativeId));
          const acts = get().actions.filter((a) => a.decisionId === id);
          const result = await writebackDecisionToMemoire({ ...decision, ...patch } as Decision, chosen?.name ?? null, acts);
          if (result) await appendEvent(id, 'memoire_writeback', { eventId: result.eventId });
        } catch (e) {
          set({ error: e instanceof Error ? e.message : 'Memoire write-back failed' });
        }
      }
      return null;
    },

    // ---------------------------------------------------------- alternatives

    addAlternative: async (decisionId, name) => {
      const { activeOrgId, alternatives } = get();
      if (!activeOrgId) return;
      const alt: DecisionAlternative = {
        id: uid(),
        orgId: activeOrgId,
        decisionId,
        name,
        description: '',
        financialLines: [],
        qualitative: '',
        strategic: '',
        risks: '',
        isRecommended: false,
        sort: alternatives.filter((a) => a.decisionId === decisionId).length,
      };
      await write(
        async () => {
          if (!supabaseClient) throw new Error('Cloud not configured');
          const { error } = await supabaseClient.from('helm_decision_alternatives').insert({
            id: alt.id,
            org_id: alt.orgId,
            decision_id: decisionId,
            name,
            sort: alt.sort,
          });
          if (error) throw new Error(error.message);
        },
        () => set((st) => ({ alternatives: [...st.alternatives, alt] })),
      );
    },

    updateAlternative: async (id, fields) => {
      await write(
        async () => {
          if (!supabaseClient) throw new Error('Cloud not configured');
          const { error } = await supabaseClient
            .from('helm_decision_alternatives')
            .update({
              name: fields.name,
              description: fields.description,
              financial_lines: fields.financialLines as FinancialLine[] | undefined,
              qualitative: fields.qualitative,
              strategic: fields.strategic,
              risks: fields.risks,
              is_recommended: fields.isRecommended,
            })
            .eq('id', id);
          if (error) throw new Error(error.message);
        },
        () =>
          set((st) => ({
            alternatives: st.alternatives.map((a) => (a.id === id ? { ...a, ...fields } : a)),
          })),
      );
    },

    removeAlternative: async (id) => {
      await write(
        async () => {
          if (!supabaseClient) throw new Error('Cloud not configured');
          const { error } = await supabaseClient.from('helm_decision_alternatives').delete().eq('id', id);
          if (error) throw new Error(error.message);
        },
        () => set((st) => ({ alternatives: st.alternatives.filter((a) => a.id !== id) })),
      );
    },

    // ----------------------------------------------------------- assumptions

    addAssumption: async (decisionId, statement) => {
      const { activeOrgId } = get();
      if (!activeOrgId) return;
      const a: DecisionAssumption = {
        id: uid(),
        orgId: activeOrgId,
        decisionId,
        statement,
        basis: '',
        sensitivity: 'medium',
        validated: 'pending',
      };
      await write(
        async () => {
          if (!supabaseClient) throw new Error('Cloud not configured');
          const { error } = await supabaseClient.from('helm_decision_assumptions').insert({
            id: a.id,
            org_id: a.orgId,
            decision_id: decisionId,
            statement,
          });
          if (error) throw new Error(error.message);
        },
        () => set((st) => ({ assumptions: [...st.assumptions, a] })),
      );
    },

    updateAssumption: async (id, fields) => {
      await write(
        async () => {
          if (!supabaseClient) throw new Error('Cloud not configured');
          const { error } = await supabaseClient
            .from('helm_decision_assumptions')
            .update({
              statement: fields.statement,
              basis: fields.basis,
              sensitivity: fields.sensitivity,
              validated: fields.validated,
            })
            .eq('id', id);
          if (error) throw new Error(error.message);
        },
        () =>
          set((st) => ({
            assumptions: st.assumptions.map((a) => (a.id === id ? { ...a, ...fields } : a)),
          })),
      );
    },

    removeAssumption: async (id) => {
      await write(
        async () => {
          if (!supabaseClient) throw new Error('Cloud not configured');
          const { error } = await supabaseClient.from('helm_decision_assumptions').delete().eq('id', id);
          if (error) throw new Error(error.message);
        },
        () => set((st) => ({ assumptions: st.assumptions.filter((a) => a.id !== id) })),
      );
    },

    // --------------------------------------------------------------- actions

    addAction: async (decisionId, title, ownerLabel, dueDate) => {
      const { activeOrgId } = get();
      if (!activeOrgId) return;
      const a: DecisionAction = {
        id: uid(),
        orgId: activeOrgId,
        decisionId,
        title,
        ownerLabel,
        ownerId: null,
        dueDate,
        status: 'open',
        writeback: null,
      };
      await write(
        async () => {
          if (!supabaseClient) throw new Error('Cloud not configured');
          const { error } = await supabaseClient.from('helm_actions').insert({
            id: a.id,
            org_id: a.orgId,
            decision_id: decisionId,
            title,
            owner_label: ownerLabel,
            due_date: dueDate,
          });
          if (error) throw new Error(error.message);
        },
        () => set((st) => ({ actions: [...st.actions, a] })),
      );
    },

    setActionStatus: async (id, status) => {
      await write(
        async () => {
          if (!supabaseClient) throw new Error('Cloud not configured');
          const { error } = await supabaseClient.from('helm_actions').update({ status }).eq('id', id);
          if (error) throw new Error(error.message);
        },
        () =>
          set((st) => ({
            actions: st.actions.map((a) => (a.id === id ? { ...a, status } : a)),
          })),
      );
    },

    // -------------------------------------------------------- approval rules

    saveApprovalRule: async (rule) => {
      const { activeOrgId } = get();
      if (!activeOrgId) return;
      const id = rule.id ?? uid();
      const full: ApprovalRule = { ...rule, id, orgId: activeOrgId };
      await write(
        async () => {
          if (!supabaseClient) throw new Error('Cloud not configured');
          const { error } = await supabaseClient.from('helm_approval_rules').upsert({
            id,
            org_id: activeOrgId,
            decision_type: full.decisionType,
            threshold_amount: full.thresholdAmount,
            required_role: full.requiredRole,
            active: full.active,
          });
          if (error) throw new Error(error.message);
        },
        () =>
          set((st) => ({
            approvalRules: st.approvalRules.some((r) => r.id === id)
              ? st.approvalRules.map((r) => (r.id === id ? full : r))
              : [...st.approvalRules, full],
          })),
      );
    },

    removeApprovalRule: async (id) => {
      await write(
        async () => {
          if (!supabaseClient) throw new Error('Cloud not configured');
          const { error } = await supabaseClient.from('helm_approval_rules').delete().eq('id', id);
          if (error) throw new Error(error.message);
        },
        () => set((st) => ({ approvalRules: st.approvalRules.filter((r) => r.id !== id) })),
      );
    },

    // --------------------------------------------------------------- memoire

    loadMemoireOpportunities: async () => {
      if (isDemo()) return;
      const opportunities = await listMemoireOpportunities();
      set({ memoireOpportunities: opportunities });
    },
  };
});
