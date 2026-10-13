import { useState, type ReactNode, type MouseEvent } from 'react';
import {
  Bell, BookOpenCheck, Calculator, ChevronsUpDown, ClipboardCheck, Database, Dna, GitBranch, GitCompareArrows, Layers,
  LogOut, Network, Scale, Settings, ShieldCheck, Waypoints, Workflow, type LucideIcon,
} from 'lucide-react';
import { HelmLockup } from '../brand/HelmLogo.tsx';
import { cn } from '../../lib/cn.ts';

export type NavGroup = 'Management' | 'Model' | 'Learning' | 'Setup';
/** hint = the stage of the operating loop the page serves (Sense → Diagnose → Simulate → Decide → Control → Learn). */
export interface NavItem { key: string; label: string; icon: LucideIcon; group?: NavGroup; hint?: string }
/**
 * Grouped by what a manager comes for (audit 2026-10-12: fourteen flat entries, five of them pages that only explain
 * why they are empty). Setup folds away until opened or until one of its pages is the current one; Learning stays open,
 * because the Cockpit links into it (audit 2026-10-13).
 */
export const HELM_NAV: NavItem[] = [
  { key: 'cockpit', label: 'Cockpit', icon: Bell, group: 'Management', hint: 'sense' },
  { key: 'reviews', label: 'Reviews', icon: ClipboardCheck, hint: 'control' },
  { key: 'decisions', label: 'Decisions', icon: Scale, hint: 'decide' },
  { key: 'memory', label: 'Decision memory', icon: BookOpenCheck, hint: 'learn' },
  { key: 'scenarios', label: 'Scenarios', icon: GitBranch, group: 'Model', hint: 'simulate' },
  { key: 'twin', label: 'Twin', icon: Layers },
  { key: 'value-graph', label: 'Value Graph', icon: Workflow },
  { key: 'calculations', label: 'Calculations', icon: Calculator },
  { key: 'causal', label: 'Causal', icon: Waypoints, group: 'Learning', hint: 'diagnose' },
  { key: 'counterfactuals', label: 'Counterfactuals', icon: GitCompareArrows },
  { key: 'genome', label: 'Genome', icon: Dna },
  { key: 'sources', label: 'Sources', icon: Database, group: 'Setup' },
  { key: 'governance', label: 'Governance', icon: ShieldCheck },
  { key: 'ontology', label: 'Ontology', icon: Network },
];
const FOLDED: readonly NavGroup[] = ['Setup'];

/** The group an item belongs to: its own, or the last one declared above it. */
function groupOf(items: readonly NavItem[], idx: number): NavGroup | null {
  for (let i = idx; i >= 0; i -= 1) if (items[i]!.group) return items[i]!.group!;
  return null;
}

interface Props {
  active: string;
  onNavigate: (key: string) => void;
  /** Real addresses, so a nav item can be opened in a new tab. */
  hrefFor?: (key: string) => string;
  items?: NavItem[];
  /** Attention conditions in the latest current state — the one count the rail shows. */
  openSignals?: number;
  orgName: string;
  /** More than one organization → the org box becomes a picker. */
  orgs?: { id: string; name: string }[];
  activeOrgId?: string | null;
  onOrgChange?: (id: string) => void;
  userLabel: string;           // e-mail, or role, e.g. "Country GM Vietnam"
  /** the reader's role, set in mono under the organization */
  orgMeta?: string;
  /** the record open below the section, e.g. a decision: the breadcrumb's last step */
  crumbDetail?: string | null;
  demo?: boolean;
  /** how current HELM's reading of a live source is — said in the bar, in brick when it failed */
  sourceLine?: { text: string; failed: boolean } | null;
  /** the two clocks — shown in the bar on instrument pages */
  effectiveAsOf?: string;      // "19 Sep 12:00"
  recordedThrough?: string;    // "21 Sep 09:00"
  /** a failure the whole console should see, set in brick under the bar */
  error?: string | null;
  onSignOut?: () => void;
  onSettings?: () => void;
  /** instrument pages (Scenarios, Twin, Causal, Counterfactuals, Genome, Governance, Sources, Ontology, Value Graph, Calculations) run full width */
  wide?: boolean;
  children: ReactNode;
}

const ITEM =
  'flex w-full items-center gap-[10px] rounded-md border px-[10px] py-[6px] text-left text-ui font-medium no-underline transition-colors ease-helm hover:no-underline';
const IDLE = 'border-transparent text-ink-600 hover:bg-white/60 hover:text-ink-950';
const CURRENT = 'border-ink-200 bg-white text-ink-950';

/* The paper rail: 232px on ink-100 with a hairline edge. Lockup, the organization, nav grouped by what a manager comes
   for with the loop stage in mono, and the reader at the foot. The current page is a white fill with a hairline and a
   teal icon. To the right, a sticky 48px breadcrumb bar on paper (92%, 6px blur) carries the demo pill and the clocks. */
export function AppShell({ active, onNavigate, hrefFor = (k) => '#' + k, items = HELM_NAV, openSignals = 0, orgName, orgs = [], activeOrgId, onOrgChange, userLabel, orgMeta, crumbDetail, demo, sourceLine, effectiveAsOf, recordedThrough, error, onSignOut, onSettings, wide, children }: Props) {
  // Below 768px the rail is a menu behind a bar: the content keeps the whole width instead of being squeezed beside it.
  const [menuOpen, setMenuOpen] = useState(false);
  const [unfolded, setUnfolded] = useState<ReadonlySet<NavGroup>>(new Set());
  const go = (k: string) => (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    setMenuOpen(false);
    onNavigate(k);
  };
  const current = active === 'settings' ? 'Settings' : items.find((i) => i.key === active)?.label ?? active;
  return (
    <div className="flex min-h-screen flex-col bg-paper md:flex-row">
      <div className="flex items-center justify-between border-b border-ink-200 bg-ink-100 px-4 py-3 md:hidden">
        <HelmLockup height={26} subtitle={null} />
        <button
          type="button"
          aria-expanded={menuOpen}
          aria-controls="helm-nav"
          onClick={() => setMenuOpen((o) => !o)}
          className="rounded-md border border-ink-200 bg-white px-3 py-1 text-dense font-medium text-ink-800 transition-colors ease-helm hover:bg-ink-50"
        >
          {menuOpen ? 'Close' : 'Menu'}
        </button>
      </div>
      <aside
        id="helm-nav"
        className={cn(
          'z-40 w-full shrink-0 flex-col overflow-y-auto border-r border-ink-200 bg-ink-100 text-ink-700 md:sticky md:top-0 md:flex md:h-screen md:w-sidebar md:self-start',
          menuOpen ? 'flex' : 'hidden',
        )}
      >
        <div className="hidden px-4 pb-[14px] pt-[18px] md:block"><HelmLockup height={30} /></div>
        <div className="relative mx-3 mb-2 mt-3 rounded-md border border-ink-200 bg-sheet py-[7px] pl-[10px] pr-7 md:mt-0">
          <p className="truncate text-dense font-semibold text-ink-950">{orgName}</p>
          {orgMeta && <p className="truncate font-mono text-[10px] leading-[14px] text-ink-500">{orgMeta}</p>}
          {orgs.length > 1 && onOrgChange && (
            <>
              <ChevronsUpDown size={14} aria-hidden className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-400" />
              <select
                value={activeOrgId ?? ''}
                onChange={(e) => onOrgChange(e.target.value)}
                aria-label="Active organization"
                className="absolute inset-0 w-full cursor-pointer opacity-0"
              >
                {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </>
          )}
        </div>
        <nav className="grid flex-1 content-start gap-px px-2 pb-4 pt-1">
          {items.map((it, idx) => {
            const on = it.key === active;
            const group = groupOf(items, idx);
            const foldable = group !== null && FOLDED.includes(group);
            const folded = foldable && !unfolded.has(group) && !items.some((x, j) => groupOf(items, j) === group && x.key === active);
            const Icon = it.icon;
            return (
              <div key={it.key}>
                {it.group &&
                  (FOLDED.includes(it.group) ? (
                    <button
                      type="button"
                      onClick={() => setUnfolded((u) => { const n = new Set(u); if (n.has(it.group!)) n.delete(it.group!); else n.add(it.group!); return n; })}
                      aria-expanded={!folded}
                      className="mb-1 mt-4 flex w-full items-center justify-between px-[10px] font-sans text-tag font-semibold uppercase text-ink-500 hover:text-ink-950"
                    >
                      <span>{it.group}</span>
                      <span aria-hidden>{folded ? '+' : '−'}</span>
                    </button>
                  ) : (
                    <p className={cn('mb-1 px-[10px] font-sans text-tag font-semibold uppercase text-ink-500', idx === 0 ? 'mt-1' : 'mt-4')}>{it.group}</p>
                  ))}
                {!folded && (
                  <a href={hrefFor(it.key)} onClick={go(it.key)} aria-current={on ? 'page' : undefined} className={cn(ITEM, on ? CURRENT : IDLE)}>
                    <Icon size={16} aria-hidden className={on ? 'text-accent-600' : 'text-ink-400'} />
                    <span className="flex-1">{it.label}</span>
                    {it.key === 'cockpit' && openSignals > 0 && (
                      <span className="rounded-full bg-accent-600 px-[6px] py-px text-meta font-semibold text-white">{openSignals}</span>
                    )}
                    {it.hint && <span className="font-mono text-[10px] leading-[14px] tracking-[0.04em] text-ink-400">{it.hint}</span>}
                  </a>
                )}
              </div>
            );
          })}
        </nav>
        <div className="grid gap-px border-t border-ink-200 p-2">
          <button type="button" onClick={() => { setMenuOpen(false); onSettings?.(); }} aria-current={active === 'settings' ? 'page' : undefined} className={cn(ITEM, active === 'settings' ? CURRENT : IDLE)}>
            <Settings size={16} aria-hidden className={active === 'settings' ? 'text-accent-600' : 'text-ink-400'} />
            Settings
          </button>
          <button type="button" onClick={onSignOut} className={cn(ITEM, IDLE)}>
            <LogOut size={16} aria-hidden className="text-ink-400" />
            {demo ? 'Exit demo' : 'Sign out'}
          </button>
          <p className="truncate px-[10px] pb-[2px] pt-1 text-meta text-ink-500">{userLabel}</p>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <div className="sticky top-0 z-30 flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-ink-200 bg-paper/[0.92] px-4 py-2 text-[13px] leading-5 backdrop-blur-[6px] md:px-page-x">
          <span className="min-w-0 truncate">
            <span className="text-ink-500">{orgName}</span>
            <span className="mx-2 text-ink-300">/</span>
            {crumbDetail ? (
              <>
                <a href={hrefFor(active)} onClick={go(active)} className="text-ink-500 hover:text-accent-700">{current}</a>
                <span className="mx-2 text-ink-300">/</span>
                <span className="font-medium text-ink-900">{crumbDetail}</span>
              </>
            ) : (
              <span className="font-medium text-ink-900">{current}</span>
            )}
          </span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {sourceLine && (
              <span role="status" className={cn('font-mono text-meta', sourceLine.failed ? 'text-red-700' : 'text-ink-500')}>{sourceLine.text}</span>
            )}
            {/* The boundary a new future forks at. Two equal instants read as one: "now", not a riddle. */}
            {/* Only on instrument pages: a management page states its own "as known on", and two clocks there read as two "nows". */}
            {effectiveAsOf && (
              <span className="font-mono text-meta text-ink-500">
                {effectiveAsOf === recordedThrough ? `New futures fork at ${effectiveAsOf}` : `New futures fork at ${effectiveAsOf} · recorded through ${recordedThrough}`}
              </span>
            )}
            {demo && (
              <span title="Everything here is local sample data; nothing syncs to the cloud." className="whitespace-nowrap rounded-full border border-amber-200 bg-amber-50 px-2 py-px text-meta font-semibold text-amber-800">
                Demo organization · nothing syncs
              </span>
            )}
          </span>
        </div>
        {error && (
          <p role="alert" className="border-b border-red-200 bg-red-50 px-4 py-[6px] text-dense text-red-700 md:px-page-x">{error}</p>
        )}
        <div className={wide ? 'px-4 pb-8 pt-page-y md:px-page-x' : 'mx-auto max-w-management px-4 pb-8 pt-page-y md:px-page-x'}>{children}</div>
      </main>
    </div>
  );
}
