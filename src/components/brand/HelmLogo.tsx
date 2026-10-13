import { cn } from '../../lib/cn.ts';

/* HELM mark — a six-spoke helm wheel. Paper spokes and teal knobs on a navy tile,
   or a tileless navy wheel for paper grounds. The wordmark is HELM in Source Serif 4
   semibold caps, tracked 0.16em. Geometry is final; mirrors public/brand/*.svg. */

const NAVY = '#0e1624';
const PAPER = '#f7f5f0';
const SHEET = '#fbfaf7';
const KNOB_ON_NAVY = '#3a9a8f';   // accent-400
const KNOB_ON_PAPER = '#136a61';  // accent-600

const SPOKES = [[16, 6], [24.66, 11], [24.66, 21], [16, 26], [7.34, 21], [7.34, 11]] as const;
const KNOBS = [[16, 4.4], [26.05, 10.2], [26.05, 21.8], [16, 27.6], [5.95, 21.8], [5.95, 10.2]] as const;

/** tile = paper wheel on a navy tile (the default); light = navy wheel for paper grounds; bare = currentColor. */
type MarkTone = 'tile' | 'light' | 'bare';
const MARK: Record<MarkTone, { tile: string | null; stroke: string; knob: string; hub: string }> = {
  tile: { tile: NAVY, stroke: PAPER, knob: KNOB_ON_NAVY, hub: NAVY },
  light: { tile: null, stroke: NAVY, knob: KNOB_ON_PAPER, hub: SHEET },
  bare: { tile: null, stroke: 'currentColor', knob: 'currentColor', hub: 'none' },
};

interface SymbolProps { size?: number; tone?: MarkTone; className?: string; title?: string }

/** The wheel. */
export function HelmSymbol({ size = 32, tone = 'tile', className, title = 'HELM' }: SymbolProps) {
  const t = MARK[tone];
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} role="img" aria-label={title || undefined} aria-hidden={title ? undefined : true} className={cn('block shrink-0', className)}>
      {t.tile && <rect width="32" height="32" rx="6" fill={t.tile} />}
      <g stroke={t.stroke} strokeWidth="2" strokeLinecap="round">
        {SPOKES.map(([x, y]) => <line key={`${x}-${y}`} x1="16" y1="16" x2={x} y2={y} />)}
      </g>
      <circle cx="16" cy="16" r="7" fill="none" stroke={t.stroke} strokeWidth="2.25" />
      <g fill={t.knob}>{KNOBS.map(([x, y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.7" />)}</g>
      <circle cx="16" cy="16" r="3" fill={t.hub} stroke={t.stroke} strokeWidth="2" />
    </svg>
  );
}

/** Where the lockup sits: on paper / white, or on the navy night surface. */
type Ground = 'light' | 'dark';

/** HELM in serif semibold caps, tracked 0.16em. size = font size in px. */
export function HelmWordmark({ size = 15, tone = 'light', className }: { size?: number; tone?: Ground; className?: string }) {
  return (
    <span className={cn('font-serif font-semibold leading-none', tone === 'dark' ? 'text-ink-50' : 'text-ink-950', className)} style={{ fontSize: size, letterSpacing: '0.16em' }}>
      HELM
    </span>
  );
}

interface LockupProps { height?: number; tone?: Ground; subtitle?: string | null; className?: string }

/** Tiled mark + wordmark, with an optional subline. height = the mark's size; the wordmark is half of it. */
export function HelmLockup({ height = 30, tone = 'light', subtitle = 'System of decision', className }: LockupProps) {
  const word = Math.round(height * 0.5);
  return (
    <span className={cn('inline-flex items-center', className)} style={{ gap: Math.round(height * 0.34) }} aria-label="HELM" role="img">
      <HelmSymbol size={height} tone="tile" title="" />
      <span className="flex flex-col" style={{ lineHeight: 1.15 }}>
        <HelmWordmark size={word} tone={tone} />
        {subtitle && (
          <span className={cn('mt-[3px] font-sans', tone === 'dark' ? 'text-ink-400' : 'text-ink-500')} style={{ fontSize: Math.max(11, Math.round(word * 0.72)) }}>
            {subtitle}
          </span>
        )}
      </span>
    </span>
  );
}

/** App icon / favicon tile. */
export function HelmAppIcon({ size = 32, className }: { size?: number; className?: string }) {
  return <HelmSymbol size={size} tone="tile" className={className} />;
}
