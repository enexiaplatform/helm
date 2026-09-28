import type { CSSProperties } from 'react';

/* The HELM marks. Wordmark: one 40-unit cap height, 6-unit strokes; the H
   crossbar rises 12.5° (4 u over 18 u) — the heading, and the only irregular
   stroke. Symbol: the H and its heading in a 48-unit tile. Never flatten the
   crossbar, recolour, stretch or retype it. Fills go through style so the
   CSS variables resolve. */
const PAPER = 'var(--paper)';
const NAVY = 'var(--accent-950)';
const BRASS = 'var(--brass-400)';

export function HelmWordmark({
  height = 17,
  ink = NAVY,
  bar,
  style,
}: {
  height?: number;
  ink?: string;
  bar?: string;
  style?: CSSProperties;
}) {
  const s = { fill: ink };
  return (
    <svg
      viewBox="0 0 132 40"
      width={(height * 132) / 40}
      height={height}
      role="img"
      aria-label="HELM"
      style={{ display: 'block', flexShrink: 0, ...style }}
    >
      <rect x="0" y="0" width="6" height="40" style={s} />
      <rect x="24" y="0" width="6" height="40" style={s} />
      <polygon points="6,19 24,15 24,21 6,25" style={{ fill: bar ?? ink }} />
      <rect x="37" y="0" width="6" height="40" style={s} />
      <rect x="43" y="0" width="18" height="6" style={s} />
      <rect x="43" y="17" width="15" height="6" style={s} />
      <rect x="43" y="34" width="18" height="6" style={s} />
      <rect x="68" y="0" width="6" height="40" style={s} />
      <rect x="74" y="34" width="16" height="6" style={s} />
      <polygon
        points="94,40 94,0 101.5,0 113,25 124.5,0 132,0 132,40 126,40 126,12 116.2,33 109.8,33 100,12 100,40"
        style={s}
      />
    </svg>
  );
}

/** Reversed wordmark on navy: paper letters, brass heading, tagline beneath. */
export function HelmLogo({ size = 'app', tagline }: { size?: 'app' | 'auth'; tagline?: string }) {
  const auth = size === 'auth';
  const h = auth ? 30 : 17;
  const tag = tagline ?? (auth ? 'The Enterprise Management Infrastructure' : 'System of decision');
  return (
    <div>
      <HelmWordmark height={h} ink={PAPER} bar={BRASS} />
      <p
        className={auth ? 'text-xs' : 'text-2xs'}
        style={{ marginTop: Math.round(h * 0.6), color: 'var(--text-on-chrome-muted)' }}
      >
        {tag}
      </p>
    </div>
  );
}
