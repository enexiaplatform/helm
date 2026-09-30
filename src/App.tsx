import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useHelmStore } from './services/helmStore.ts';
import { ConsoleLayout } from './components/shell/ConsoleLayout.tsx';
import { AuthPage } from './pages/AuthPage.tsx';
import { OnboardingPage } from './pages/OnboardingPage.tsx';
import { CockpitPage } from './pages/CockpitPage.tsx';
import { DecisionsPage } from './pages/DecisionsPage.tsx';
import { DecisionDetailPage } from './pages/DecisionDetailPage.tsx';
import { ScenariosPage } from './pages/ScenariosPage.tsx';
import { MemoryPage } from './pages/MemoryPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { OntologyPage } from './pages/OntologyPage.tsx';
import { ValueGraphPage } from './pages/ValueGraphPage.tsx';
import { CalculationsPage } from './pages/CalculationsPage.tsx';
import { GovernancePage } from './pages/GovernancePage.tsx';
import { TwinPage } from './pages/TwinPage.tsx';
import { CausalPage } from './pages/CausalPage.tsx';
import { GenomePage } from './pages/GenomePage.tsx';
import { CounterfactualsPage } from './pages/CounterfactualsPage.tsx';
import { ReviewsPage } from './pages/ReviewsPage.tsx';
import { SourcesPage } from './pages/SourcesPage.tsx';

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
          <Route index element={<CockpitPage />} />
          <Route path="attention" element={<Navigate to="/" replace />} />
          <Route path="reviews" element={<ReviewsPage />} />
          <Route path="decisions" element={<DecisionsPage />} />
          <Route path="decisions/:id" element={<DecisionDetailPage />} />
          <Route path="scenarios" element={<ScenariosPage />} />
          {/* The pre-kernel CVP what-if detail page is retired (Phase 4). */}
          <Route path="scenarios/:id" element={<Navigate to="/scenarios" replace />} />
          {/* The pre-kernel Economics and Operations pages are retired: their figures are the value graph's and the twin's now. */}
          <Route path="economics" element={<Navigate to="/value-graph" replace />} />
          <Route path="operations" element={<Navigate to="/twin" replace />} />
          <Route path="memory" element={<MemoryPage />} />
          <Route path="ontology" element={<OntologyPage />} />
          <Route path="value-graph" element={<ValueGraphPage />} />
          <Route path="calculations" element={<CalculationsPage />} />
          <Route path="governance" element={<GovernancePage />} />
          <Route path="twin" element={<TwinPage />} />
          <Route path="causal" element={<CausalPage />} />
          <Route path="genome" element={<GenomePage />} />
          <Route path="counterfactuals" element={<CounterfactualsPage />} />
          <Route path="sources" element={<SourcesPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      ) : (
        <Route path="*" element={<Navigate to={needsOnboarding ? '/onboarding' : '/auth'} replace />} />
      )}
    </Routes>
  );
}
