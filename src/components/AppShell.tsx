import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  Bell,
  GitBranch,
  Scale,
  LineChart,
  Factory,
  BookOpenCheck,
  Settings,
  LogOut,
  Ship,
  Network,
  Workflow,
} from 'lucide-react';
import { useHelmStore } from '../services/helmStore.ts';

const navItems = [
  { to: '/', label: 'Attention', icon: Bell, end: true },
  { to: '/decisions', label: 'Decisions', icon: Scale },
  { to: '/scenarios', label: 'Scenarios', icon: GitBranch },
  { to: '/economics', label: 'Economics', icon: LineChart },
  { to: '/operations', label: 'Operations', icon: Factory },
  { to: '/memory', label: 'Memory', icon: BookOpenCheck },
  // Phase 1 kernel instrument, not a management surface.
  { to: '/ontology', label: 'Ontology', icon: Network },
  { to: '/value-graph', label: 'Value Graph', icon: Workflow },
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
      <aside className="fixed inset-y-0 left-0 z-40 flex w-56 flex-col border-r border-ink-200 bg-ink-950 text-ink-200">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-ink-800">
            <Ship size={17} className="text-accent-400" />
          </span>
          <div className="leading-tight">
            <p className="text-sm font-bold tracking-wide text-white">HELM</p>
            <p className="text-2xs text-ink-400">System of decision</p>
          </div>
        </div>

        {organizations.length > 0 && (
          <div className="px-3 pb-2">
            <select
              className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-xs text-ink-100 focus:border-accent-500 focus:outline-none"
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

        <nav className="flex-1 space-y-0.5 px-2 py-2">
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive ? 'bg-ink-800 text-white' : 'text-ink-300 hover:bg-ink-900 hover:text-white'
                }`
              }
            >
              <Icon size={16} />
              <span className="flex-1">{label}</span>
              {label === 'Attention' && openSignals > 0 && (
                <span className="rounded-full bg-accent-600 px-1.5 py-0.5 text-2xs font-semibold text-white">
                  {openSignals}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="space-y-0.5 border-t border-ink-800 px-2 py-2">
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                isActive ? 'bg-ink-800 text-white' : 'text-ink-300 hover:bg-ink-900 hover:text-white'
              }`
            }
          >
            <Settings size={16} />
            Settings
          </NavLink>
          <button
            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-ink-300 transition-colors hover:bg-ink-900 hover:text-white"
            onClick={() => {
              if (mode === 'demo') {
                exitDemo();
                navigate('/auth');
              } else {
                void signOut().then(() => navigate('/auth'));
              }
            }}
          >
            <LogOut size={16} />
            {mode === 'demo' ? 'Exit demo' : 'Sign out'}
          </button>
          <p className="truncate px-3 pt-1 text-2xs text-ink-500">{userEmail}</p>
        </div>
      </aside>

      <div className="ml-56 flex min-h-screen flex-1 flex-col">
        {mode === 'demo' && (
          <div className="border-b border-amber-200 bg-amber-50 px-6 py-1.5 text-xs text-amber-800">
            Demo organization — <strong>{activeOrg?.name}</strong>. Everything here is local sample data; nothing
            syncs to the cloud.
          </div>
        )}
        {error && (
          <div className="border-b border-red-200 bg-red-50 px-6 py-1.5 text-xs text-red-700">{error}</div>
        )}
        <main className="flex-1 px-6 py-5">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
