import { Fragment } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  Calculator,
  Bell,
  CircleAlert,
  GitBranch,
  Info,
  Scale,
  LineChart,
  Factory,
  BookOpenCheck,
  Settings,
  LogOut,
  Network,
  Workflow,
} from 'lucide-react';
import { useHelmStore } from '../services/helmStore.ts';
import { HelmLogo } from './HelmLogo.tsx';

const navItems = [
  { to: '/', label: 'Attention', icon: Bell, end: true, group: 'Management' },
  { to: '/decisions', label: 'Decisions', icon: Scale },
  { to: '/scenarios', label: 'Scenarios', icon: GitBranch },
  { to: '/economics', label: 'Economics', icon: LineChart },
  { to: '/operations', label: 'Operations', icon: Factory },
  { to: '/memory', label: 'Memory', icon: BookOpenCheck },
  // Kernel instruments, not management surfaces.
  { to: '/ontology', label: 'Ontology', icon: Network, group: 'Kernel' },
  { to: '/value-graph', label: 'Value Graph', icon: Workflow },
  { to: '/calculations', label: 'Calculations', icon: Calculator },
];

export function AppShell() {
  const navigate = useNavigate();
  const mode = useHelmStore((s) => s.mode);
  const organizations = useHelmStore((s) => s.organizations);
  const activeOrgId = useHelmStore((s) => s.activeOrgId);
  const userEmail = useHelmStore((s) => s.userEmail);
  const error = useHelmStore((s) => s.error);
  const setActiveOrg = useHelmStore((s) => s.setActiveOrg);
  const signOut = useHelmStore((s) => s.signOut);
  const exitDemo = useHelmStore((s) => s.exitDemo);
  const openSignals = useHelmStore((s) => s.signals.filter((x) => x.status === 'open').length);

  const activeOrg = organizations.find((o) => o.id === activeOrgId);

  return (
    <div className="flex min-h-screen">
      <aside
        className="fixed inset-y-0 left-0 z-40 flex flex-col overflow-y-auto"
        style={{ width: 'var(--sidebar-width)', background: 'var(--surface-chrome)', color: 'var(--text-on-chrome)' }}
      >
        <div style={{ padding: '26px 22px 22px' }}>
          <HelmLogo />
        </div>

        {organizations.length > 0 && (
          <div className="px-3.5 pb-2.5">
            <p className="helm-chrome-label mb-1.5 ml-1.5">Organization</p>
            <select
              className="helm-chrome-select"
              value={activeOrgId ?? ''}
              onChange={(e) => void setActiveOrg(e.target.value)}
              aria-label="Active organization"
            >
              {organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <nav className="grid flex-1 content-start gap-0.5 px-2.5 pb-4">
          {navItems.map(({ to, label, icon: Icon, end, group }) => (
            <Fragment key={to}>
              {group && <p className="helm-chrome-label mx-3 mb-1.5 mt-[18px]">{group}</p>}
              <NavLink to={to} end={end} className="helm-nav-item">
                <Icon size={18} />
                <span className="flex-1">{label}</span>
                {label === 'Attention' && openSignals > 0 && (
                  <span
                    className="rounded-full px-2 text-[11px] font-bold leading-[18px]"
                    style={{ background: 'var(--count-bg)', color: 'var(--count-fg)' }}
                  >
                    {openSignals}
                  </span>
                )}
              </NavLink>
            </Fragment>
          ))}
        </nav>

        <div className="grid gap-0.5 px-2.5 pb-4 pt-2.5" style={{ borderTop: '1px solid var(--border-chrome)' }}>
          <NavLink to="/settings" className="helm-nav-item">
            <Settings size={18} />
            Settings
          </NavLink>
          <button
            className="helm-nav-item"
            onClick={() => {
              if (mode === 'demo') {
                exitDemo();
                navigate('/auth');
              } else {
                void signOut().then(() => navigate('/auth'));
              }
            }}
          >
            <LogOut size={18} />
            {mode === 'demo' ? 'Exit demo' : 'Sign out'}
          </button>
          {userEmail && (
            <p className="truncate px-3 pt-1.5 text-2xs" style={{ color: 'var(--text-on-chrome-muted)' }}>
              {userEmail}
            </p>
          )}
        </div>
      </aside>

      <div className="flex min-h-screen min-w-0 flex-1 flex-col" style={{ marginLeft: 'var(--sidebar-width)' }}>
        {mode === 'demo' && (
          <div
            className="flex items-center gap-2 border-b text-xs"
            style={{
              borderColor: 'var(--banner-demo-border)',
              background: 'var(--banner-demo-bg)',
              color: 'var(--banner-demo-fg)',
              padding: '8px var(--page-pad-x)',
            }}
          >
            <Info size={15} className="shrink-0" />
            <span>
              Demo organization — <strong className="font-semibold">{activeOrg?.name}</strong>. Everything here is
              local sample data; nothing syncs to the cloud.
            </span>
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="flex items-center gap-2 border-b text-xs"
            style={{
              borderColor: 'var(--banner-error-border)',
              background: 'var(--banner-error-bg)',
              color: 'var(--banner-error-fg)',
              padding: '8px var(--page-pad-x)',
            }}
          >
            <CircleAlert size={15} className="shrink-0" />
            <span>{error}</span>
          </div>
        )}
        <main className="min-w-0 flex-1" style={{ padding: 'var(--page-pad-y) var(--page-pad-x) 64px' }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
