import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

export type NoticeTone = 'error' | 'warning' | 'after' | 'neutral';

const T: Record<NoticeTone, { box: string; label: string; body: string }> = {
  error: { box: 'border-red-200 bg-red-50', label: 'text-red-700', body: 'text-red-700' },
  warning: { box: 'border-amber-200 bg-amber-50', label: 'text-amber-800', body: 'text-amber-800' },
  after: { box: 'border-accent-200 bg-accent-50', label: 'text-accent-900', body: 'text-accent-900' },
  neutral: { box: 'border-ink-200 bg-ink-50', label: 'text-ink-600', body: 'text-ink-600' },
};

/* An inset note the reader must not miss: an error, a scoped warning (the ochre "Contended resource" notice),
   evidence that arrived after a commitment. 4px, hairline, 10px padding, an optional semibold title over the body. */
export function Notice({ tone = 'neutral', label, onDismiss, className, children }: { tone?: NoticeTone; label?: string; onDismiss?: () => void; className?: string; children: ReactNode }) {
  const t = T[tone];
  return (
    <div role={tone === 'error' ? 'alert' : undefined} className={cn('grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 rounded-md border p-[10px]', t.box, className)}>
      <div className="grid gap-1">
        {label && <span className={cn('text-dense font-semibold', t.label)}>{label}</span>}
        <div className={cn('text-dense', t.body)}>{children}</div>
      </div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className={cn('self-start text-dense', t.body)}>✕</button>
      )}
    </div>
  );
}
