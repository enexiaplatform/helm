import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn.ts';

type Variant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger';
interface Props extends ButtonHTMLAttributes<HTMLButtonElement> { variant?: Variant; size?: 'md' | 'sm' }

/* One primary per view. Primary = the single act the view exists for ("Open the decision", "Commit"): navy ink.
   Accent = sea teal, for an instrument's own act. Danger = brick outline. Hover is colour only; no press scale. */
const V: Record<Variant, string> = {
  primary: 'border-transparent bg-ink-950 text-ink-50 hover:bg-ink-800',
  accent: 'border-transparent bg-accent-600 text-white hover:bg-accent-700',
  secondary: 'border-ink-200 bg-white text-ink-800 hover:bg-ink-100',
  ghost: 'border-transparent bg-transparent text-ink-600 hover:bg-ink-100 hover:text-ink-900',
  danger: 'border-red-200 bg-white text-red-700 hover:bg-red-50',
};

export function Button({ variant = 'secondary', size = 'md', className, type = 'button', ...rest }: Props) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center gap-[6px] rounded-md border font-sans font-medium transition-colors ease-helm disabled:pointer-events-none disabled:opacity-50',
        size === 'md' ? 'px-3 py-[6px] text-ui' : 'px-[10px] py-1 text-dense',
        V[variant],
        className,
      )}
      {...rest}
    />
  );
}
