import { useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import type { ForkPoint } from '@helm/scenario-runtime';
import { useHelmStore } from '../../services/helmStore.ts';
import { cloudScope, demoScope } from '../../services/ontologyGraph.ts';
import { displayClock, resolveScenarioWorkspace } from '../../services/scenarioRuntime.ts';
import { AppShell } from './AppShell.tsx';

/** Kernel instruments run full width; everything else is the 1240px management register. */
const INSTRUMENTS = new Set(['scenarios', 'value-graph', 'ontology', 'calculations', 'governance', 'twin', 'causal', 'genome']);

const keyOf = (pathname: string): string => pathname.split('/')[1] || 'attention';
const hrefOf = (key: string): string => (key === 'attention' ? '/' : `/${key}`);

/**
 * The routed shell: reads the store and the router and hands plain values to
 * AppShell. The two clocks are the scenario workspace's own fork — the
 * boundary every future is computed from — so the strip never states a time
 * the kernel did not use.
 */
export function ConsoleLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const mode = useHelmStore((s) => s.mode);
  const organizations = useHelmStore((s) => s.organizations);
  const activeOrgId = useHelmStore((s) => s.activeOrgId);
  const userId = useHelmStore((s) => s.userId);
  const userEmail = useHelmStore((s) => s.userEmail);
  const myRole = useHelmStore((s) => s.myRole);
  const error = useHelmStore((s) => s.error);
  const setActiveOrg = useHelmStore((s) => s.setActiveOrg);
  const signOut = useHelmStore((s) => s.signOut);
  const exitDemo = useHelmStore((s) => s.exitDemo);
  const openSignals = useHelmStore((s) => s.signals.filter((x) => x.status === 'open').length);
  const [fork, setFork] = useState<ForkPoint | null>(null);

  const scope = useMemo(
    () => (mode === 'demo' ? demoScope() : activeOrgId ? cloudScope(activeOrgId, userId ?? '', myRole()) : null),
    [mode, activeOrgId, userId, myRole],
  );

  useEffect(() => {
    if (!scope || !mode) return;
    let cancelled = false;
    resolveScenarioWorkspace(mode, scope)
      .then((ws) => {
        if (!cancelled) setFork(ws?.defaultFork ?? null);
      })
      .catch(() => {
        if (!cancelled) setFork(null);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, scope]);

  const active = keyOf(pathname);
  const activeOrg = organizations.find((o) => o.id === activeOrgId);

  return (
    <AppShell
      active={active}
      onNavigate={(key) => navigate(hrefOf(key))}
      hrefFor={hrefOf}
      openSignals={openSignals}
      orgName={activeOrg?.name ?? '—'}
      orgs={organizations}
      activeOrgId={activeOrgId}
      onOrgChange={(id) => void setActiveOrg(id)}
      userLabel={userEmail ?? myRole()}
      demo={mode === 'demo'}
      effectiveAsOf={fork ? displayClock(fork.effectiveAsOf) : undefined}
      recordedThrough={fork ? displayClock(fork.recordedThrough) : undefined}
      error={error}
      onSettings={() => navigate('/settings')}
      onSignOut={() => {
        if (mode === 'demo') {
          exitDemo();
          navigate('/auth');
        } else {
          void signOut().then(() => navigate('/auth'));
        }
      }}
      wide={INSTRUMENTS.has(active)}
    >
      <Outlet />
    </AppShell>
  );
}
