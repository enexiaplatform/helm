import type { ReactNode } from 'react';

interface Props {
  /** "Management · Attention · Monday 28 September" — register · page · context */
  kicker: string;
  /** Management pages: a sentence that answers the page's question. */
  title: ReactNode;
  lede?: ReactNode;
  size?: 'display' | 'title' | 'instrument';
  children?: ReactNode;
}

/* No card, no box. Kicker (11px label) → serif headline → lede (max 640px). */
export function PageHeader({ kicker, title, lede, size = 'display', children }: Props) {
  // On a phone the 44px management voice fills the first screen before anything it speaks about; it steps down to the instrument size there.
  const t = size === 'display' ? 'text-instrument sm:text-display max-w-headline' : size === 'title' ? 'text-instrument sm:text-title max-w-[900px]' : 'text-instrument';
  return (
    <header>
      <p className="helm-label">{kicker}</p>
      <h1 className={'mt-[10px] ' + t}>{title}</h1>
      {lede && <p className="mt-3 max-w-[640px] text-lede text-ink-600">{lede}</p>}
      {children}
    </header>
  );
}
