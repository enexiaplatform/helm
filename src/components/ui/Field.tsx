import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

/** The input look (.field-input), for selects, textareas and bare inputs: 4px, hairline, teal border and ring on focus. */
export const controlClass =
  'w-full rounded-md border border-ink-200 bg-white px-[10px] py-[6px] text-ui text-ink-950 placeholder:text-ink-400 focus-visible:border-accent-500 focus-visible:shadow-field disabled:bg-ink-100 disabled:text-ink-500';

/** The compact control for toolbars and inline filters. */
export const controlSmClass =
  'max-w-full rounded-md border border-ink-200 bg-white px-2 py-1 text-dense text-ink-950 placeholder:text-ink-400 focus-visible:border-accent-500 focus-visible:shadow-field';

/* Uppercase 11px field label over any control, with an optional hint beneath. */
export function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1 block helm-label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-meta text-ink-500">{hint}</span>}
    </label>
  );
}
