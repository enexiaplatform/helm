import { useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import type { ForkPoint } from '@helm/scenario-runtime';
import { useHelmStore } from '../../services/helmStore.ts';
import { liveSyncLine, refreshFromMemoire, startMemoireLiveSync, useMemoireLive } from '../../services/memoireLiveSync.ts';
import { cloudScope, demoScope } from '../../services/ontologyGraph.ts';
import { displayClock, resolveScenarioWorkspace } from '../../services/scenarioRuntime.ts';
import { attentionCount } from '../../services/twinRuntime.ts';
import { prepareDemoWorld } from '../../services/demoWorld.ts';
import { AppShell } from './AppShell.tsx';

/** Kernel instruments run full width; everything else is the 1240px management register. */
const INSTRUMENTS = new Set(['scenarios', 'value-graph', 'ontology', 'calculations', 'governance', 'twin', 'causal', 'counterfactuals', 'genome', 'sources']);

/** The Pipeline is a working table: full width, without the instruments' clocks. */
const WIDE = new Set([...INSTRUMENTS, 'pipeline']);

const keyOf = (pathname: string): string => pathname.split('/')[1] || 'cockpit';
const hrefOf = (key: string): string => (key === 'cockpit' ? '/' : `/${key}`);

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
  const [openSignals, setOpenSignals] = useState(0);
  const [fork, setFork] = useState<ForkPoint | null>(null);
  // The demo is built whole before any page reads it, so every page sees the same organization (src/services/demoWorld.ts).
  const [demoReady, setDemoReady] = useState<'pending' | 'ready' | string>('pending');

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

  useEffect(() => {
    if (mode !== 'demo' || !scope) return;
    let cancelled = false;
    prepareDemoWorld(scope)
      .then(() => {
        if (!cancelled) setDemoReady('ready');
      })
      .catch((e: unknown) => {
        if (!cancelled) setDemoReady(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [mode, scope]);

  // Memoire → HELM on Refresh (ADR-0034, manual since 2026-10-13): opening a page shows what HELM holds at once; the
  // reader presses Refresh to read Memoire's changes and everything HELM holds again. The demo has no source.
  const live = useMemoireLive();
  useEffect(() => {
    if (mode !== 'cloud' || !scope || !userId) return;
    const { stop } = startMemoireLiveSync(scope);
    return stop;
  }, [mode, scope, userId]);

  // The rail's count is the attention conditions HELM's own rules hold in the latest current state — not a stored signal.
  useEffect(() => {
    if (!scope || !mode || (mode === 'demo' && demoReady !== 'ready')) return;
    let cancelled = false;
    attentionCount(mode, scope)
      .then((n) => {
        if (!cancelled) setOpenSignals(n);
      })
      .catch(() => {
        if (!cancelled) setOpenSignals(0);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, scope, live.version, live.readEpoch, demoReady]);

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
      orgMeta={myRole()}
      crumbDetail={pathname.split('/')[2] ? (active === 'decisions' ? 'Decision' : 'Record') : null}
      demo={mode === 'demo'}
      sourceLine={mode === 'cloud' ? liveSyncLine(live, displayClock) : null}
      onRefresh={mode === 'cloud' ? () => void refreshFromMemoire() : undefined}
      refreshing={live.refreshing || live.phase === 'reading' || live.phase === 'composing'}
      effectiveAsOf={fork && INSTRUMENTS.has(active) ? displayClock(fork.effectiveAsOf) : undefined}
      recordedThrough={fork && INSTRUMENTS.has(active) ? displayClock(fork.recordedThrough) : undefined}
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
      wide={WIDE.has(active)}
    >
      {mode !== 'demo' || demoReady === 'ready' ? (
        // A finished Refresh reads the page again from scratch.
        <Outlet key={live.readEpoch} />
      ) : demoReady === 'pending' ? (
        <p className="text-ui text-ink-500">Preparing the demo organization…</p>
      ) : (
        <p role="alert" className="text-ui text-red-700">The demo organization could not be prepared: {demoReady}</p>
      )}
    </AppShell>
  );
}
