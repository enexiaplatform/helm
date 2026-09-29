import type { ReactNode, MouseEvent } from 'react';
import { HelmLockup } from '../brand/HelmLogo.tsx';
import { cn } from '../../lib/cn.ts';

export interface NavItem { key: string; label: string; group?: 'Management' | 'Kernel' }
export const HELM_NAV: NavItem[] = [
  { key: 'attention', label: 'Attention', group: 'Management' },
  { key: 'decisions', label: 'Decisions' },
  { key: 'scenarios', label: 'Scenarios' },
  { key: 'economics', label: 'Economics' },
  { key: 'operations', label: 'Operations' },
  { key: 'memory', label: 'Memory' },
  { key: 'ontology', label: 'Ontology', group: 'Kernel' },
  { key: 'value-graph', label: 'Value Graph' },
  { key: 'calculations', label: 'Calculations' },
  { key: 'governance', label: 'Governance' },
];

interface Props {
  active: string;
  onNavigate: (key: string) => void;
  /** Real addresses, so a nav item can be opened in a new tab. */
  hrefFor?: (key: string) => string;
  items?: NavItem[];
  openSignals?: number;
  orgName: string;
  /** More than one organization → the org box becomes a picker. */
  orgs?: { id: string; name: string }[];
  activeOrgId?: string | null;
  onOrgChange?: (id: string) => void;
  userLabel: string;           // role, e.g. "Country GM Vietnam"
  demo?: boolean;
  /** the two clocks — always visible in the top strip */
  effectiveAsOf?: string;      // "19 Sep 12:00"
  recordedThrough?: string;    // "21 Sep 09:00"
  /** a failure the whole console should see, set in brick under the strip */
  error?: string | null;
  onSignOut?: () => void;
  onSettings?: () => void;
  /** instrument pages (Scenarios, Value Graph, Ontology, Calculations, Governance) run full width */
  wide?: boolean;
  children: ReactNode;
}

/* v2 shell. Navy sidebar 224px, text-only nav (no icons) with a 6px dot:
   brass = current page, 18% paper = idle. Brass count pill on Attention only.
   Main area has a thin mono strip (demo notice + the two clocks) instead of a banner. */
export function AppShell({ active, onNavigate, hrefFor = (k) => '#' + k, items = HELM_NAV, openSignals = 0, orgName, orgs = [], activeOrgId, onOrgChange, userLabel, demo, effectiveAsOf, recordedThrough, error, onSignOut, onSettings, wide, children }: Props) {
  const go = (k: string) => (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onNavigate(k);
  };
  return (
    <div className="flex min-h-screen bg-paper">
      <aside className="sticky top-0 z-40 flex h-screen w-sidebar shrink-0 flex-col self-start overflow-y-auto bg-navy text-paper">
        <div className="px-[22px] pb-[22px] pt-[26px]"><HelmLockup height={26} tone="dark" /></div>
        <div className="mx-[14px] mb-2 grid gap-px rounded-lg border border-chrome-line px-3 py-[9px]">
          <span className="font-sans text-tag font-medium uppercase text-chrome-muted">Organization</span>
          {orgs.length > 1 && onOrgChange ? (
            <select
              value={activeOrgId ?? ''}
              onChange={(e) => onOrgChange(e.target.value)}
              aria-label="Active organization"
              className="-mx-1 truncate rounded-md bg-transparent px-1 text-dense font-medium text-paper"
            >
              {orgs.map((o) => <option key={o.id} value={o.id} className="text-ink-950">{o.name}</option>)}
            </select>
          ) : (
            <span className="truncate text-dense font-medium">{orgName}</span>
          )}
        </div>
        <nav className="grid flex-1 content-start gap-[2px] px-[10px] pb-4 pt-[6px]">
          {items.map((it) => {
            const on = it.key === active;
            return (
              <div key={it.key}>
                {it.group && <p className="mx-3 mb-[6px] mt-[18px] font-sans text-tag font-medium uppercase text-chrome-muted">{it.group}</p>}
                <a
                  href={hrefFor(it.key)}
                  onClick={go(it.key)}
                  aria-current={on ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-[10px] rounded-lg px-3 py-2 text-ui font-medium no-underline transition-colors ease-helm hover:bg-chrome-hover hover:text-paper hover:no-underline',
                    on ? 'bg-chrome-active text-paper' : 'text-chrome-fg',
                  )}
                >
                  <span className={cn('h-[6px] w-[6px] rounded-full', on ? 'bg-brass-400' : 'bg-paper/20')} />
                  <span className="flex-1">{it.label}</span>
                  {it.key === 'attention' && openSignals > 0 && (
                    <span className="rounded-full bg-brass-400 px-[7px] font-mono text-[11px] font-bold leading-[18px] text-navy">{openSignals}</span>
                  )}
                </a>
              </div>
            );
          })}
        </nav>
        <div className="grid gap-[2px] border-t border-chrome-line px-[22px] pb-[18px] pt-[14px]">
          <span className="truncate text-dense font-medium">{userLabel}</span>
          <span className="flex gap-2 text-meta text-chrome-muted">
            <button type="button" onClick={onSettings} className={cn('hover:text-paper', active === 'settings' && 'text-paper')}>Settings</button>·
            <button type="button" onClick={onSignOut} className="hover:text-paper">{demo ? 'Exit demo' : 'Sign out'}</button>
          </span>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        {(demo || effectiveAsOf) && (
          <div className="flex flex-wrap justify-between gap-x-6 gap-y-2 border-b border-ink-200 px-page-x py-3 font-mono text-meta text-ink-500">
            <span>{demo ? 'Demo organization · local sample data, nothing syncs' : orgName}</span>
            {effectiveAsOf && <span>Effective {effectiveAsOf} · recorded through {recordedThrough}</span>}
          </div>
        )}
        {error && (
          <p role="alert" className="border-b border-red-200 bg-red-50 px-page-x py-3 text-dense text-red-700">{error}</p>
        )}
        <div className={wide ? 'px-page-x pb-[72px] pt-8' : 'mx-auto max-w-management px-page-x pb-[72px] pt-page-y'}>{children}</div>
      </main>
    </div>
  );
}
