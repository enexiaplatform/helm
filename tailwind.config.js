/** HELM v2 — "Chart room". Drop-in replacement for the repo's tailwind.config.js.
 *  The colour families keep Tailwind names (emerald, amber, red…) but carry HELM values,
 *  so existing classes re-skin immediately. Off-palette families are aliased onto HELM ones.
 *  Every hex here is final — do not add colours outside this file. */
const ink = { 50:'#f8f6f1',100:'#efece5',200:'#e2ded4',300:'#c9c4b8',400:'#8e8f8c',500:'#646a73',600:'#4f5560',700:'#3a404a',800:'#2a303a',900:'#1d222b',950:'#12161d' };
const accent = { 50:'#eef2f9',100:'#dce5f3',200:'#bacbe6',300:'#8da8d4',400:'#5f82be',500:'#3b63a8',600:'#284c8f',700:'#1f3e78',800:'#19325f',900:'#14284b',950:'#0d1a2e' };
const emerald = { 50:'#edf6f1',100:'#d8ede2',200:'#b5dac6',500:'#3c9a70',600:'#2a7f5a',700:'#1f6a4a',800:'#195539',900:'#13442e' };
const amber = { 50:'#fbf4e4',100:'#f6e7c3',200:'#edd49a',500:'#c8922a',600:'#a8761a',700:'#875d12',800:'#6f4c10',900:'#5a3e0e' };
const red = { 50:'#fbeeec',100:'#f7dcd8',200:'#eebdb6',500:'#cc4a3d',600:'#b23a2e',700:'#962e24',800:'#7c261e',900:'#661f19' };
const violet = { 50:'#f4f0f8',100:'#e8e0f1',200:'#d3c4e5',700:'#5e3f8e',800:'#4e3476',900:'#3f2a60' };
const sky = { 50:'#edf5f7',100:'#d9ebef',200:'#b6d7e0',700:'#22627a',800:'#1b5064' };
const indigo = { 50:'#eff0f9',100:'#e0e2f3',200:'#c5c9e8',800:'#373d86',900:'#2d316c' };

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    colors: {
      transparent: 'transparent', current: 'currentColor', white: '#ffffff', black: '#000000',
      paper: '#f3f1eb',             // Chart Paper — the page
      navy: '#0d1a2e',              // Night Navy — sidebar, auth, commitment banner
      brass: { 300:'#dcc38e', 400:'#c9a45c', 500:'#b08a3e', 600:'#9c7a32' }, // mark, active nav dot, Attention count ONLY
      ink, accent, prussian: accent,
      emerald, amber, red, violet, sky, indigo,
      teal: { 50:'#ecf6f4', 200:'#b3dcd4', 800:'#1a5c55' },
      lime: { 50:'#f3f5e6', 200:'#d7deaf', 800:'#4e5a1a' },
      orange: { 100:'#f8e4d6', 900:'#7a3512' },
      // aliases so stock classes land on HELM hues
      slate: ink, gray: ink, zinc: ink, neutral: ink, stone: ink,
      blue: accent, green: emerald, yellow: amber, rose: red, purple: violet, cyan: sky,
      chrome: { fg: '#b6c3d9', muted: '#8da8d4', line: 'rgb(243 241 235 / 0.10)', hover: 'rgb(243 241 235 / 0.07)', active: 'rgb(243 241 235 / 0.09)' },
    },
    fontFamily: {
      sans: ['"Be Vietnam Pro"', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
      serif: ['Newsreader', '"Iowan Old Style"', '"Palatino Linotype"', 'Georgia', 'serif'],
      mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
    },
    fontSize: {
      // management voice (serif)
      display: ['44px', { lineHeight: '50px', letterSpacing: '-0.015em' }],   // Attention headline
      title: ['36px', { lineHeight: '44px', letterSpacing: '-0.015em' }],     // decision question
      instrument: ['28px', { lineHeight: '36px', letterSpacing: '-0.012em' }],// kernel page titles
      signal: ['24px', { lineHeight: '31px', letterSpacing: '-0.01em' }],     // critical signal title
      section: ['22px', { lineHeight: '28px' }],                              // section head over 2px rule
      'section-sm': ['20px', { lineHeight: '26px' }],
      panel: ['17px', { lineHeight: '24px' }],                                // side panel titles
      figure: ['26px', { lineHeight: '32px' }],
      'figure-sm': ['24px', { lineHeight: '30px' }],
      // interface (sans) + values (mono)
      lede: ['16px', { lineHeight: '26px' }],
      read: ['15px', { lineHeight: '24px' }],
      base: ['14px', { lineHeight: '22px' }],
      ui: ['14px', { lineHeight: '20px' }],
      dense: ['13px', { lineHeight: '20px' }],
      meta: ['12px', { lineHeight: '18px' }],
      label: ['11px', { lineHeight: '16px', letterSpacing: '0.08em' }],       // always uppercase
      tag: ['10px', { lineHeight: '16px', letterSpacing: '0.06em' }],         // mono enum pills
    },
    extend: {
      borderRadius: { md: '6px', lg: '8px', xl: '12px', '2xl': '16px' },
      boxShadow: {
        panel: '0 1px 2px rgb(13 26 46 / 0.05), 0 4px 12px rgb(13 26 46 / 0.04)',
        overlay: '0 2px 6px rgb(13 26 46 / 0.08), 0 24px 48px rgb(13 26 46 / 0.18)',
        focus: '0 0 0 3px rgb(59 99 168 / 0.35)',
      },
      maxWidth: { management: '1240px', reading: '680px', headline: '820px' },
      width: { sidebar: '224px' },
      spacing: { 'page-x': '40px', 'page-y': '36px' },
      transitionTimingFunction: { helm: 'cubic-bezier(0.2, 0, 0, 1)' },
      transitionDuration: { DEFAULT: '160ms' },
    },
  },
  plugins: [],
};
