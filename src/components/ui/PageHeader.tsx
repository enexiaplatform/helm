import type { ReactNode } from 'react';

interface Props {
  /** "Management · Cockpit · Monday 28 September" — register · page · context */
  kicker: string;
  /** Management pages: a sentence that answers the page's question. */
  title: ReactNode;
  lede?: ReactNode;
  /** display = page title (28); title = the question in a decision's header (26); instrument = a kernel object (28) */
  size?: 'display' | 'title' | 'instrument';
  children?: ReactNode;
}

/* No card, no box. Eyebrow → serif title (Source Serif 4 semibold) → a 14px line beneath (max 720px). */
export function PageHeader({ kicker, title, lede, size = 'display', children }: Props) {
  const t = size === 'display' ? 'text-display max-w-headline' : size === 'title' ? 'text-title font-medium max-w-[900px]' : 'text-instrument';
  return (
    <header>
      <p className="helm-label">{kicker}</p>
      <h1 className={'mt-1 text-ink-950 ' + t}>{title}</h1>
      {lede && <p className="mt-1 max-w-[720px] text-base text-ink-600">{lede}</p>}
      {children}
    </header>
  );
}
