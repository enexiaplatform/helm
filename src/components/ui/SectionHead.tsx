import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

interface Props {
  title: ReactNode;
  /** mono meta after the title: "critical · 2" */
  meta?: ReactNode;
  /** the caption a section states about itself, right-aligned: "nothing is ranked, weighted or totalled" */
  caveat?: ReactNode;
  dot?: 'critical' | 'warning' | 'watch';
  size?: 'section' | 'section-sm';
  className?: string;
}

const DOT = { critical: 'bg-red-500', warning: 'bg-amber-500', watch: 'bg-accent-500' };

/* A serif title — a question or a plain-language claim, not a noun — over an ink-300 hairline,
   with its caveat as a right-hand caption. Rows beneath are separated by ink-100/200 hairlines. */
export function SectionHead({ title, meta, caveat, dot, size = 'section', className }: Props) {
  return (
    <div className={cn('flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-ink-300 pb-2', className)}>
      {dot && <span className={cn('h-[6px] w-[6px] self-center rounded-full', DOT[dot])} />}
      <h2 className={cn('text-ink-950', size === 'section' ? 'text-section' : 'text-section-sm')}>{title}</h2>
      {meta && <span className="helm-meta">{meta}</span>}
      {caveat && <span className="helm-caveat ml-auto">{caveat}</span>}
    </div>
  );
}
