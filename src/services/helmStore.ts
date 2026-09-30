import { create } from 'zustand';
import { supabaseClient } from '../lib/supabaseClient.ts';
import type { OrgMember, OrgRole, OrgUnit, Organization } from '../domain/types.ts';
import { demoMembers, demoOrganization, demoUnits, DEMO_USER_ID } from '../data/demoOrg.ts';
import * as map from './mappers.ts';

/**
 * The application store: WHO is signed in and which organization they are in. Nothing about the enterprise
 * lives here — decisions, twin state, causal claims, the genome, counterfactual worlds, reviews, sources and
 * the AI layer are all read from the kernels (src/services/*Runtime.ts), as the person reading. Demo mode
 * holds a local organization shell that never syncs (the ecosystem rule).
 */

type Mode = 'demo' | 'cloud';

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

};

const emptyData = {
  units: [] as OrgUnit[],
  members: [] as OrgMember[],
};

export const useHelmStore = create<HelmState>((set, get) => {
  const isDemo = () => get().mode === 'demo';

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
        error: null,
      });
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
      try {
        const [units, memberRows] = await Promise.all([
          sb.from('org_units').select('*').eq('org_id', orgId),
          sb
            .from('organization_memberships')
            .select('user_id, role, user_profiles:user_profiles!inner(id, email, display_name)')
            .eq('org_id', orgId),
        ]);
        if (units.error) throw new Error(units.error.message);

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
          members,
          loadingData: false,
        });
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
  };
});
