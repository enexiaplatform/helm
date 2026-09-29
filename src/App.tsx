import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useHelmStore } from './services/helmStore.ts';
import { ConsoleLayout } from './components/shell/ConsoleLayout.tsx';
import { AuthPage } from './pages/AuthPage.tsx';
import { OnboardingPage } from './pages/OnboardingPage.tsx';
import { AttentionPage } from './pages/AttentionPage.tsx';
import { DecisionsPage } from './pages/DecisionsPage.tsx';
import { DecisionDetailPage } from './pages/DecisionDetailPage.tsx';
import { ScenariosPage } from './pages/ScenariosPage.tsx';
import { EconomicsPage } from './pages/EconomicsPage.tsx';
import { OperationsPage } from './pages/OperationsPage.tsx';
import { MemoryPage } from './pages/MemoryPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { OntologyPage } from './pages/OntologyPage.tsx';
import { ValueGraphPage } from './pages/ValueGraphPage.tsx';
import { CalculationsPage } from './pages/CalculationsPage.tsx';
import { GovernancePage } from './pages/GovernancePage.tsx';

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
      <div className="flex min-h-screen items-center justify-center text-ui text-ink-500">
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
        <Route element={<ConsoleLayout />}>
          <Route index element={<AttentionPage />} />
          <Route path="decisions" element={<DecisionsPage />} />
          <Route path="decisions/:id" element={<DecisionDetailPage />} />
          <Route path="scenarios" element={<ScenariosPage />} />
          {/* The pre-kernel CVP what-if detail page is retired (Phase 4). */}
          <Route path="scenarios/:id" element={<Navigate to="/scenarios" replace />} />
          <Route path="economics" element={<EconomicsPage />} />
          <Route path="operations" element={<OperationsPage />} />
          <Route path="memory" element={<MemoryPage />} />
          <Route path="ontology" element={<OntologyPage />} />
          <Route path="value-graph" element={<ValueGraphPage />} />
          <Route path="calculations" element={<CalculationsPage />} />
          <Route path="governance" element={<GovernancePage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      ) : (
        <Route path="*" element={<Navigate to={needsOnboarding ? '/onboarding' : '/auth'} replace />} />
      )}
    </Routes>
  );
}
