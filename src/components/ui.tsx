/**
 * TEMPORARY bridge for the pages not yet rebuilt on v2 (Scenarios, Value Graph,
 * Ontology, Calculations, Economics, Operations, Settings). It keeps their v1
 * props but renders in the v2 grammar; Modal, Field and EmptyState are the v2
 * components themselves. New code imports from ./ui/* instead. Delete this
 * file once those pages are rebuilt (docs/product/visual-system.md).
 */
import type { ComponentType, ReactNode } from 'react';

export { Modal } from './ui/Modal.tsx';
export { Field } from './ui/Field.tsx';
export { EmptyState } from './ui/EmptyState.tsx';

/** v1 header props → v2 kicker, serif title and lede, with actions on the right. */
export function PageHeader({
  title,
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
  const kicker = eyebrow ?? (register === 'instrument' ? 'Kernel instrument' : 'Management');
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-ink-200 pb-5">
      <div className="min-w-0 flex-[1_1_480px]">
        {kicker && <p className="helm-label">{kicker}</p>}
        <h1 className="mt-[10px] text-instrument">{title}</h1>
        {description && <p className="mt-3 max-w-[720px] text-read text-ink-600">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** v1 panel: white, radius 12, hairline, serif title. A string action is an italic caveat. */
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
    <section className={`min-w-0 rounded-xl border border-ink-200 bg-white ${className}`}>
      {(title || action) && (
        <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-ink-200 px-5 py-[14px]">
          <h2 className="flex min-w-0 items-center gap-2 text-panel">{title}</h2>
          {action && (
            <div className={`shrink-0 text-right ${typeof action === 'string' ? 'helm-caveat' : 'text-meta text-ink-500'}`}>
              {action}
            </div>
          )}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

const TONE = { neutral: 'text-ink-950', good: 'text-emerald-700', bad: 'text-red-700', warn: 'text-amber-700' };

/** Label over a serif figure (the MetricList figure), with its basis beneath. */
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
      <p className="helm-label">{label}</p>
      <p className={`tabular mt-1 font-serif text-figure-sm font-medium ${TONE[tone]}`}>{value}</p>
      {sub && <p className="helm-meta">{sub}</p>}
    </div>
  );
}
