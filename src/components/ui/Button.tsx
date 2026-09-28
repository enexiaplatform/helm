import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn.ts';

type Variant = 'primary' | 'secondary' | 'ghost';
interface Props extends ButtonHTMLAttributes<HTMLButtonElement> { variant?: Variant; size?: 'md' | 'sm' }

/* One primary per view. Primary = the single act the view exists for
   ("Frame a decision →" on a critical signal, "Commit" in a decision). */
const V: Record<Variant, string> = {
  primary: 'bg-accent-800 text-white font-semibold hover:bg-accent-900',
  secondary: 'bg-white text-ink-950 font-medium border border-ink-300 hover:bg-ink-50 hover:border-ink-400',
  ghost: 'bg-transparent text-ink-600 font-medium hover:bg-ink-100 hover:text-ink-950',
};

export function Button({ variant = 'secondary', size = 'md', className, type = 'button', ...rest }: Props) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center gap-2 rounded-lg font-sans transition-colors ease-helm disabled:pointer-events-none disabled:opacity-45',
        size === 'md' ? 'px-4 py-[9px] text-dense' : 'px-3 py-[6px] text-meta',
        V[variant],
        className,
      )}
      {...rest}
    />
  );
}
