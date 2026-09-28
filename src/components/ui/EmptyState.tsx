import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

/* The fact in serif, then the mechanism that would fill it — an ink-50 well,
   like Memory's "Not looked at again yet." */
export function EmptyState({ title, detail, action, className }: { title: string; detail?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('grid justify-items-start gap-[6px] rounded-xl border border-ink-200 bg-ink-50 px-5 py-[18px]', className)}>
      <p className="font-serif text-section-sm font-medium">{title}</p>
      {detail && <p className="max-w-reading text-base text-ink-700">{detail}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
