import { cn } from '../../lib/cn.ts';

/* HELM v2 mark — "Bearing". A bearing ring with a compass needle set to 012.5°
   (the brand heading). North half brass, south half ink. Wordmark is drawn,
   not typed: 2-unit strokes, bracket-less slab serifs, 30-unit cap height.
   Geometry is final; mirrors public/brand/*.svg. Never retype HELM in a font. */

const NAVY = '#0d1a2e';
const PAPER = '#f3f1eb';
const BRASS = '#c9a45c';

type Tone = 'light' | 'dark' | 'black' | 'white';
const TONES: Record<Tone, { ink: string; accent: string; bg: string }> = {
  light: { ink: NAVY, accent: BRASS, bg: PAPER },   // on paper / white
  dark: { ink: PAPER, accent: BRASS, bg: NAVY },    // on navy (sidebar, auth)
  black: { ink: '#000', accent: '#000', bg: '#fff' },
  white: { ink: '#fff', accent: '#fff', bg: '#000' },
};

const WORD_D = 'M1 0V30M25 0V30M1 15H25M-3 1H5M-3 29H5M21 1H29M21 29H29M61 1H42V29H61M42 15H58M38 1H42M38 29H42M60 0V5M60 25V30M57 12.5V17.5M77 0V29H94M73 1H81M73 29H77M93 24V30M110 30V0.2L125 22.2L140 0.2V30M106 29H114M136 29H144M106 1H110M140 1H144';

interface SymbolProps { size?: number; tone?: Tone; compact?: boolean; className?: string; title?: string }

/** The bearing. Below 28px it switches to the compact cut (heavier ring, no ticks). */
export function HelmSymbol({ size = 32, tone = 'light', compact, className, title = 'HELM' }: SymbolProps) {
  const { ink, accent, bg } = TONES[tone];
  const small = compact ?? size < 28;
  const tip = small ? 11 : 13;
  const hw = small ? 6 : 4.6;
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} role="img" aria-label={title} className={cn('block shrink-0', className)}>
      <circle cx="32" cy="32" r={small ? 25 : 26} fill="none" stroke={ink} strokeWidth={small ? 4.5 : 2.6} />
      {!small && [0, 90, 180, 270].map((a) => (
        <line key={a} x1="32" y1="6" x2="32" y2="11" stroke={ink} strokeWidth="2.6" transform={'rotate(' + a + ' 32 32)'} />
      ))}
      {!small && [45, 135, 225, 315].map((a) => (
        <line key={a} x1="32" y1="6.5" x2="32" y2="9" stroke={ink} strokeWidth="1.4" transform={'rotate(' + a + ' 32 32)'} />
      ))}
      <g transform="rotate(12.5 32 32)">
        <polygon points={'32,' + tip + ' ' + (32 + hw) + ',32 ' + (32 - hw) + ',32'} fill={accent} />
        <polygon points={(32 - hw) + ',32 ' + (32 + hw) + ',32 32,' + (64 - tip)} fill={ink} />
        <circle cx="32" cy="32" r={small ? 2.4 : 2} fill={bg} />
      </g>
    </svg>
  );
}

interface WordmarkProps { height?: number; tone?: Tone; className?: string; title?: string }

/** Drawn HELM wordmark. height = rendered cap-box height in px (min 12). */
export function HelmWordmark({ height = 20, tone = 'light', className, title = 'HELM' }: WordmarkProps) {
  const { ink } = TONES[tone];
  return (
    <svg viewBox="-6 -2 153 34" height={height} width={(height * 153) / 34} role="img" aria-label={title} className={cn('block shrink-0', className)}>
      <path d={WORD_D} fill="none" stroke={ink} strokeWidth="2" strokeMiterlimit="2" />
    </svg>
  );
}

interface LockupProps { height?: number; tone?: Tone; className?: string }

/** Symbol + wordmark. height = overall height; symbol is the full height, gap = 0.39 × height. */
export function HelmLockup({ height = 26, tone = 'dark', className }: LockupProps) {
  return (
    <span className={cn('inline-flex items-center', className)} style={{ gap: Math.round(height * 0.39) }} aria-label="HELM" role="img">
      <HelmSymbol size={height} tone={tone} compact={height < 28} title="" />
      <HelmWordmark height={height * 0.74} tone={tone} title="" />
    </span>
  );
}

/** App icon / favicon tile. */
export function HelmAppIcon({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} role="img" aria-label="HELM" className={cn('block shrink-0', className)}>
      <rect width="64" height="64" rx="14" fill={NAVY} />
      <g transform="translate(9 9) scale(0.72)">
        <circle cx="32" cy="32" r="25" fill="none" stroke={PAPER} strokeWidth="4.5" />
        <g transform="rotate(12.5 32 32)">
          <polygon points="32,11 38,32 26,32" fill={BRASS} />
          <polygon points="26,32 38,32 32,53" fill={PAPER} />
          <circle cx="32" cy="32" r="2.4" fill={NAVY} />
        </g>
      </g>
    </svg>
  );
}
