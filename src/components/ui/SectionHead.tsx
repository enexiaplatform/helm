import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

interface Props {
  title: ReactNode;
  /** mono meta after the title: "critical · 2" */
  meta?: ReactNode;
  /** italic serif caveat, right-aligned: "nothing is ranked, weighted or totalled" */
  caveat?: ReactNode;
  dot?: 'critical' | 'warning' | 'watch';
  size?: 'section' | 'section-sm';
  className?: string;
}

const DOT = { critical: 'bg-red-600', warning: 'bg-amber-500', watch: 'bg-accent-500' };

/* The primary structuring device of v2: a serif head over a 2px ink rule.
   Replaces nested cards. Rows beneath use 1px ink-200 hairlines. */
export function SectionHead({ title, meta, caveat, dot, size = 'section', className }: Props) {
  return (
    <div className={cn('flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b-2 border-ink-950 pb-[10px]', className)}>
      {dot && <span className={cn('h-2 w-2 self-center rounded-full', DOT[dot])} />}
      <h2 className={size === 'section' ? 'text-section' : 'text-section-sm'}>{title}</h2>
      {meta && <span className="helm-meta">{meta}</span>}
      {caveat && <span className="helm-caveat ml-auto">{caveat}</span>}
    </div>
  );
}
