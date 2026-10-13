import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

/* Honest and dry: a dashed paper well that says what is empty, then the mechanism that would fill it. */
export function EmptyState({ title, detail, action, className }: { title: string; detail?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-ink-200 bg-sheet px-6 py-10 text-center', className)}>
      <p className="text-ui font-medium text-ink-700">{title}</p>
      {detail && <div className="max-w-[448px] text-dense text-ink-500">{detail}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
