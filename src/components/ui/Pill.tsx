import { Children, type ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

/* State chip: 2px corners, 11px medium, words carry the meaning and the tint is the second channel.
   Each tone is fixed to one meaning — never re-map. Kernel enums are rendered readable
   (READY_FOR_DECISION → "Ready for decision"). The four truth layers also carry their shape:
   actual ■ ink · modelled ◆ teal · stated ○ slate (forecast, target, policy) · scenario ⬚ violet. */
export type PillTone =
  | 'actual' | 'forecast' | 'target' | 'scenario' | 'estimate' | 'derived' | 'assumption'
  | 'committed' | 'reviewed' | 'open' | 'accepted' | 'blocked' | 'computed' | 'overridden' | 'neutral'
  /* Phase 8 — causal knowledge. Five kinds of relationship, never drawn alike:
     a model dependency is 'computed'; these four are claims and findings. */
  | 'hypothesis' | 'supported' | 'contested' | 'refuted' | 'correlation'
  /* Phase 9 — the management genome. A pattern that recurred in recorded
     episodes, and a lesson someone other than its author has endorsed. */
  | 'recurring' | 'endorsed'
  /* Phase 10–12 — what an AI statement IS. An inference is drawn dashed: it is the model's reading, not a kernel fact. */
  | 'counterfactual' | 'inference' | 'unknown';

const T: Record<PillTone, string> = {
  actual: 'bg-ink-100 text-ink-800',
  forecast: 'bg-slate-50 text-slate-800',
  target: 'bg-slate-50 text-slate-800',
  scenario: 'bg-violet-100 text-violet-800',
  estimate: 'bg-ink-100 text-ink-600',
  derived: 'bg-accent-50 text-accent-800',
  assumption: 'bg-amber-50 text-amber-800',
  committed: 'bg-emerald-100 text-emerald-800',
  reviewed: 'bg-ink-100 text-ink-500',
  open: 'bg-red-50 text-red-700',
  accepted: 'bg-amber-50 text-amber-800',
  blocked: 'bg-red-100 text-red-700',
  computed: 'bg-accent-50 text-accent-800',
  overridden: 'bg-amber-100 text-amber-900',
  neutral: 'bg-ink-100 text-ink-600',
  hypothesis: 'bg-orange-100 text-orange-900',
  supported: 'bg-emerald-50 text-emerald-800',
  contested: 'bg-amber-100 text-amber-900',
  refuted: 'bg-red-100 text-red-800',
  correlation: 'bg-sky-50 text-sky-800',
  recurring: 'bg-lime-50 text-lime-800',
  endorsed: 'bg-emerald-100 text-emerald-900',
  counterfactual: 'bg-violet-50 text-violet-700',
  inference: 'border border-dashed border-ink-300 bg-white text-ink-600',
  unknown: 'bg-red-50 text-red-700',
};

/** The truth layer a tone belongs to, if it is one. */
const LAYER: Partial<Record<PillTone, TruthLayer>> = {
  actual: 'actual', forecast: 'stated', target: 'stated', scenario: 'scenario', derived: 'modelled', computed: 'modelled',
};

export type TruthLayer = 'actual' | 'modelled' | 'stated' | 'scenario';
const SHAPE: Record<TruthLayer, string> = {
  actual: 'bg-truth-actual',
  modelled: 'bg-truth-modelled rotate-45 scale-[0.86]',
  stated: 'rounded-full border-[1.5px] border-truth-stated',
  scenario: 'border-[1.5px] border-dashed border-truth-scenario',
};

/** Which kind of truth a value is. Shape plus colour, never colour alone. */
export function TruthShape({ layer, className }: { layer: TruthLayer; className?: string }) {
  return <span aria-hidden className={cn('inline-block h-[7px] w-[7px] shrink-0', SHAPE[layer], className)} />;
}

const ENUM = /^[A-Z][A-Z0-9_ ]*[A-Z0-9]$/;
/** READY_FOR_DECISION → "Ready for decision"; anything that is not an upper-case enum is left as written. */
function readable(children: ReactNode): ReactNode {
  return Children.map(children, (c, i) => {
    if (typeof c !== 'string' || !ENUM.test(c.trim()) || c.trim().length < 3) return c;
    const s = c.replace(/_/g, ' ').toLowerCase();
    return i === 0 ? s.replace(/^(\s*)(\S)/, (_m, sp: string, ch: string) => sp + ch.toUpperCase()) : s;
  });
}

export function Pill({ tone = 'neutral', children, className }: { tone?: PillTone; children: ReactNode; className?: string }) {
  const layer = LAYER[tone];
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-[5px] whitespace-nowrap rounded-sm px-[6px] py-[2px] font-sans text-meta font-medium', T[tone], className)}>
      {layer && <TruthShape layer={layer} />}
      {readable(children)}
    </span>
  );
}
