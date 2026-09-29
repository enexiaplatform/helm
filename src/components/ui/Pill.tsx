import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

/* Mono enum pill. Words carry the meaning; the tint is the second channel.
   Each tone is fixed to one meaning — never re-map. */
export type PillTone =
  | 'actual' | 'forecast' | 'target' | 'scenario' | 'estimate' | 'derived' | 'assumption'
  | 'committed' | 'reviewed' | 'open' | 'accepted' | 'blocked' | 'computed' | 'overridden' | 'neutral'
  /* Phase 8 — causal knowledge. Five kinds of relationship, never drawn alike:
     a model dependency is 'computed'; these four are claims and findings. */
  | 'hypothesis' | 'supported' | 'contested' | 'refuted' | 'correlation';

const T: Record<PillTone, string> = {
  actual: 'bg-emerald-50 text-emerald-700',
  forecast: 'bg-accent-50 text-accent-800',
  target: 'bg-indigo-50 text-indigo-800',
  scenario: 'bg-amber-50 text-amber-800',
  estimate: 'bg-ink-100 text-ink-700',
  derived: 'bg-violet-50 text-violet-800',
  assumption: 'bg-orange-100 text-orange-900',
  committed: 'bg-emerald-200 text-navy',
  reviewed: 'bg-ink-100 text-ink-600',
  open: 'bg-red-50 text-red-700',
  accepted: 'bg-amber-50 text-amber-700',
  blocked: 'bg-red-50 text-red-700',
  computed: 'bg-violet-50 text-violet-800',
  overridden: 'bg-amber-50 text-amber-900',
  neutral: 'bg-ink-100 text-ink-600',
  hypothesis: 'bg-orange-100 text-orange-900',
  supported: 'bg-teal-50 text-teal-800',
  contested: 'bg-amber-100 text-amber-900',
  refuted: 'bg-red-100 text-red-800',
  correlation: 'bg-sky-50 text-sky-800',
};

export function Pill({ tone = 'neutral', children, className }: { tone?: PillTone; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center whitespace-nowrap rounded-full px-2 py-px font-mono text-tag font-semibold uppercase', T[tone], className)}>
      {children}
    </span>
  );
}
