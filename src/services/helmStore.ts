import { create } from 'zustand';
import { supabaseClient } from '../lib/supabaseClient.ts';
import type {
  CostObject,
  EconomicsRow,
  InventoryItem,
  OrgMember,
  OrgRole,
  OrgUnit,
  Organization,
  Process,
  ProcessActivity,
  Signal,
  SignalStatus,
} from '../domain/types.ts';
import { detectSignals } from '../domain/engines/signals.ts';
import {
  demoCostObjects,
  demoEconomics,
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
        const [units, costObjects, economics, inventory, processes, activities, signals, memberRows] =
          await Promise.all([
            q('org_units'),
            q('helm_cost_objects'),
            q('helm_economics'),
            q('helm_inventory_items'),
            q('helm_processes'),
            q('helm_process_activities'),
            q('helm_signals'),
            sb
              .from('organization_memberships')
              .select('user_id, role, user_profiles:user_profiles!inner(id, email, display_name)')
              .eq('org_id', orgId),
          ]);
        const first = [units, costObjects, economics, inventory, processes, activities, signals].find((r) => r.error);
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

    // --------------------------------------------------------------- memoire

    loadMemoireOpportunities: async () => {
      if (isDemo()) return;
      const opportunities = await listMemoireOpportunities();
      set({ memoireOpportunities: opportunities });
    },
  };
});
