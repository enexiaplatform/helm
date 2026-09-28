import type { ComponentType, ReactNode } from 'react';
import { X } from 'lucide-react';
import type { SignalSeverity } from '../domain/types.ts';

/**
 * Kicker + serif title + intro + actions, closed by a hairline rule. Two
 * registers: management pages (Attention, Decisions, Memory…) set a 34px
 * title; kernel instruments (Scenarios, Value Graph, Ontology, Calculations)
 * a 28px one. The kicker says which register the reader is in.
 */
export function PageHeader({
  title,
  icon: Icon,
  eyebrow,
  description,
  actions,
  register = 'management',
}: {
  title: ReactNode;
  icon?: ComponentType<{ size?: number }>;
  eyebrow?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  register?: 'management' | 'instrument';
}) {
  const instrument = register === 'instrument';
  const kicker = eyebrow ?? (instrument ? 'Kernel instrument' : 'Management');
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-ink-200 pb-5">
      <div className="min-w-0 flex-[1_1_480px]">
        {kicker && (
          <p className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase leading-4 tracking-wide text-ink-500">
            {Icon && <Icon size={14} />}
            {kicker}
          </p>
        )}
        <h1
          className="tracking-display text-ink-950"
          style={{ font: instrument ? 'var(--type-instrument-title)' : 'var(--type-page-title)', textWrap: 'balance' }}
        >
          {title}
        </h1>
        {description && (
          <p
            className={`mt-2 text-ink-600 ${instrument ? 'text-sm' : 'text-[15px] leading-6'}`}
            style={{ maxWidth: 'var(--measure-prose)', textWrap: 'pretty' }}
          >
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** White on chart paper, warm hairline, serif title. A string action is a caveat, set in italic serif. */
export function PanelCard({
  title,
  action,
  children,
  className = '',
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const caveat = typeof action === 'string';
  return (
    <section className={`min-w-0 rounded-lg border border-ink-200 bg-white shadow-panel ${className}`}>
      {(title || action) && (
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-ink-100 px-5 pb-3 pt-3.5">
          <h2 className="flex min-w-0 items-center gap-2 font-serif text-[19px] font-medium leading-[26px] tracking-display text-ink-900">
            {title}
          </h2>
          {action && (
            <div
              className={`shrink-0 text-right text-ink-500 ${caveat ? 'font-serif text-[15px] italic leading-[22px]' : 'text-2xs'}`}
            >
              {action}
            </div>
          )}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

const severityLabel: Record<SignalSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  watch: 'Watch',
  info: 'Info',
};

export function SeverityBadge({ severity }: { severity: SignalSeverity }) {
  const v = (part: string) => `var(--signal-${severity}-${part})`;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-[7px] whitespace-nowrap rounded-full border px-2.5 py-0.5 text-2xs font-semibold"
      style={{ borderColor: v('border'), background: v('bg'), color: v('fg') }}
    >
      <span className="h-[7px] w-[7px] rounded-full" style={{ background: v('dot') }} />
      {severityLabel[severity]}
    </span>
  );
}

/** The fact in serif, then the mechanism that would fill it. */
export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-ink-300 px-6 py-12 text-center">
      <p className="font-serif text-xl font-medium tracking-display text-ink-900">{title}</p>
      {detail && (
        <p className="max-w-[480px] text-xs text-ink-600" style={{ textWrap: 'pretty' }}>
          {detail}
        </p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** Top-aligned dialog on a navy scrim. */
export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4"
      style={{ background: 'var(--surface-scrim)', paddingTop: 'var(--modal-top)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full overflow-hidden rounded-xl bg-white shadow-overlay"
        style={{ maxWidth: wide ? 'var(--modal-width-wide)' : 'var(--modal-width)' }}
      >
        <header className="flex items-center justify-between gap-3 border-b border-ink-100 py-3.5 pl-6 pr-4">
          <h2 className="font-serif text-[22px] font-medium leading-7 tracking-display text-ink-950">{title}</h2>
          <button className="btn-ghost p-1.5" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="px-6 pb-6 pt-5">{children}</div>
      </div>
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
  className = '',
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-2xs text-ink-500">{hint}</span>}
    </label>
  );
}

/** Label / serif figure / basis. The figure never truncates: it steps down on narrow strips and wraps if it must. */
export function Stat({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'neutral' | 'good' | 'bad' | 'warn';
}) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase leading-4 tracking-wide text-ink-500" style={{ textWrap: 'balance' }}>
        {label}
      </p>
      <p
        className="mt-1.5 font-serif font-medium tracking-display"
        style={{
          fontSize: 'clamp(24px, 2.4vw, 30px)',
          lineHeight: 1.2,
          fontVariantNumeric: 'lining-nums tabular-nums',
          color: `var(--tone-${tone})`,
        }}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-2xs text-ink-500">{sub}</p>}
    </div>
  );
}

export function TabBar<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string; badge?: number }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <nav className="flex gap-1 border-b border-ink-200" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onChange(t.id)}
          className={`helm-tab relative -mb-px flex items-center gap-1.5 rounded-t-md border px-3 py-2 text-sm font-medium ${
            active === t.id ? 'border-ink-200 border-b-white bg-white' : 'border-transparent'
          }`}
        >
          {t.label}
          {t.badge !== undefined && t.badge > 0 && (
            <span className="rounded-full bg-ink-100 px-1.5 text-2xs font-semibold text-ink-600">{t.badge}</span>
          )}
        </button>
      ))}
    </nav>
  );
}
