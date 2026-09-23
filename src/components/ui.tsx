import type { ReactNode } from 'react';
import type { SignalSeverity } from '../domain/types.ts';

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
  return (
    <section className={`rounded-lg border border-ink-200 bg-white shadow-panel ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-ink-100 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

const severityStyles: Record<SignalSeverity, { dot: string; badge: string; label: string }> = {
  critical: { dot: 'bg-red-500', badge: 'bg-red-50 text-red-700 border-red-200', label: 'Critical' },
  warning: { dot: 'bg-amber-500', badge: 'bg-amber-50 text-amber-800 border-amber-200', label: 'Warning' },
  watch: { dot: 'bg-accent-500', badge: 'bg-accent-50 text-accent-800 border-accent-200', label: 'Watch' },
  info: { dot: 'bg-ink-400', badge: 'bg-ink-50 text-ink-600 border-ink-200', label: 'Info' },
};

export function SeverityBadge({ severity }: { severity: SignalSeverity }) {
  const s = severityStyles[severity];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-semibold ${s.badge}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

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
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-ink-200 bg-ink-50/50 px-6 py-10 text-center">
      <p className="text-sm font-medium text-ink-700">{title}</p>
      {detail && <p className="max-w-md text-xs text-ink-500">{detail}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

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
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/40 p-4 pt-[8vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} rounded-lg bg-white shadow-overlay`}>
        <header className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button className="btn-ghost px-2 py-1" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="p-4">{children}</div>
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
      {hint && <span className="mt-1 block text-2xs text-ink-400">{hint}</span>}
    </label>
  );
}

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
  const toneClass =
    tone === 'good' ? 'text-emerald-700' : tone === 'bad' ? 'text-red-700' : tone === 'warn' ? 'text-amber-700' : 'text-ink-950';
  return (
    <div className="min-w-0">
      <p className="truncate text-2xs font-semibold uppercase tracking-wide text-ink-500">{label}</p>
      <p className={`mt-0.5 truncate text-lg font-semibold tabular-nums ${toneClass}`}>{value}</p>
      {sub && <p className="truncate text-2xs text-ink-500">{sub}</p>}
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
          className={`relative -mb-px flex items-center gap-1.5 rounded-t-md px-3 py-2 text-sm font-medium transition-colors ${
            active === t.id
              ? 'border border-ink-200 border-b-white bg-white text-ink-950'
              : 'text-ink-500 hover:text-ink-800'
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
