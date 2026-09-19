import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useHelmStore } from './services/helmStore.ts';
import { AppShell } from './components/AppShell.tsx';
import { AuthPage } from './pages/AuthPage.tsx';
import { OnboardingPage } from './pages/OnboardingPage.tsx';
import { AttentionPage } from './pages/AttentionPage.tsx';
import { DecisionsPage } from './pages/DecisionsPage.tsx';
import { DecisionDetailPage } from './pages/DecisionDetailPage.tsx';
import { ScenariosPage } from './pages/ScenariosPage.tsx';
import { ScenarioDetailPage } from './pages/ScenarioDetailPage.tsx';
import { EconomicsPage } from './pages/EconomicsPage.tsx';
import { OperationsPage } from './pages/OperationsPage.tsx';
import { MemoryPage } from './pages/MemoryPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';

export default function App() {
  const authReady = useHelmStore((s) => s.authReady);
  const mode = useHelmStore((s) => s.mode);
  const organizations = useHelmStore((s) => s.organizations);
  const initAuth = useHelmStore((s) => s.initAuth);

  useEffect(() => {
    void initAuth();
  }, [initAuth]);

  if (!authReady) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-ink-500">
        Loading HELM…
      </div>
    );
  }

  // Signed out and not in demo → auth. Signed in without an org → onboarding.
  const inApp = mode === 'demo' || (mode === 'cloud' && organizations.length > 0);
  const needsOnboarding = mode === 'cloud' && organizations.length === 0;

  return (
    <Routes>
      <Route path="/auth" element={inApp ? <Navigate to="/" replace /> : <AuthPage />} />
      <Route
        path="/onboarding"
        element={needsOnboarding ? <OnboardingPage /> : <Navigate to={inApp ? '/' : '/auth'} replace />}
      />
      {inApp ? (
        <Route element={<AppShell />}>
          <Route index element={<AttentionPage />} />
          <Route path="decisions" element={<DecisionsPage />} />
          <Route path="decisions/:id" element={<DecisionDetailPage />} />
          <Route path="scenarios" element={<ScenariosPage />} />
          <Route path="scenarios/:id" element={<ScenarioDetailPage />} />
          <Route path="economics" element={<EconomicsPage />} />
          <Route path="operations" element={<OperationsPage />} />
          <Route path="memory" element={<MemoryPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      ) : (
        <Route path="*" element={<Navigate to={needsOnboarding ? '/onboarding' : '/auth'} replace />} />
      )}
    </Routes>
  );
}
