import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

/** The TextField control look, for selects, textareas and bare inputs. */
export const controlClass =
  'w-full rounded-lg border border-ink-300 bg-white px-3 py-[10px] text-ui text-ink-950 placeholder:text-ink-400 focus-visible:border-accent-500 disabled:bg-ink-100 disabled:text-ink-500';

/** The compact control for toolbars and inline filters. */
export const controlSmClass =
  'max-w-full rounded-lg border border-ink-300 bg-white px-[10px] py-[6px] text-dense text-ink-950 placeholder:text-ink-400 focus-visible:border-accent-500';

/* Label 12/500 ink-600 over any control, with an optional hint beneath. */
export function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <label className={cn('grid gap-[6px]', className)}>
      <span className="text-meta font-medium text-ink-600">{label}</span>
      {children}
      {hint && <span className="text-meta text-ink-500">{hint}</span>}
    </label>
  );
}
