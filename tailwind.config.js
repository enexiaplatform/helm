/** HELM — "Chart room" (design system of 2026-10-13). Warm paper, navy ink, sea-teal instruments.
 *  Ramp names are kept (ink/accent/red/amber/emerald/violet/slate) so every component remaps cleanly.
 *  Every hex here is final — do not add colours outside this file. */
const ink = { 50:'#f7f5f0',100:'#eeebe3',200:'#dfdace',300:'#c4beb0',400:'#9a958a',500:'#6f6c66',600:'#55534f',700:'#3e3f42',800:'#2a2f38',900:'#1b2230',950:'#0e1624' };
// Sea teal, like navigation instruments: focus, the active place, modelled values, the mark's knobs.
const accent = { 50:'#eaf5f3',100:'#cfe8e4',200:'#a4d3cc',300:'#6db6ac',400:'#3a9a8f',500:'#1e8075',600:'#136a61',700:'#0f574f',800:'#0d4540',900:'#0b3632',950:'#082925' };
// Muted status: brick (critical), ochre (warning), forest (good). Violet is reserved for scenarios.
const red = { 50:'#fbefec',100:'#f6dcd5',200:'#edbfb3',300:'#e29d8b',400:'#d77a64',500:'#c2553b',600:'#a8412a',700:'#8e3522',800:'#742b1c',900:'#5a2216' };
const amber = { 50:'#fbf4e6',100:'#f5e6c4',200:'#ebd199',300:'#e1bb6f',400:'#d6a445',500:'#c08a23',600:'#a06f17',700:'#835914',800:'#6b4812',900:'#4f350e' };
const emerald = { 50:'#edf5ef',100:'#d5e9db',200:'#afd3ba',300:'#86bc97',400:'#5aa173',500:'#3f8a5c',600:'#2f7a4b',700:'#26653e',800:'#1f5233',900:'#173d26' };
const violet = { 50:'#f3f0f9',100:'#e8e2f4',200:'#cfc4e8',300:'#b2a1da',400:'#9580cc',500:'#7a62c0',600:'#6a4fb0',700:'#584198',800:'#46357f',900:'#352862' };
// Slate = what the business says: forecast, target, policy (the "stated" truth layer).
const slate = { 50:'#eef2f8',100:'#dbe3ef',200:'#c3cfe2',300:'#9fb2cf',400:'#7590b8',500:'#5676a3',600:'#3f5f8f',700:'#354f78',800:'#2b4366',900:'#22344f' };
const sky = { 50:'#edf3f6',100:'#d8e6ec',200:'#b3cdd8',700:'#2d5f75',800:'#244c5e' };
const lime = { 50:'#f2f4e6',100:'#e4e9c9',200:'#d6dcae',800:'#4b561c' };
const orange = { 50:'#fbf1ea',100:'#f6e1d3',200:'#ecc4a8',800:'#7f3d1a',900:'#6e3416' };

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    colors: {
      transparent: 'transparent', current: 'currentColor', white: '#ffffff', black: '#000000',
      paper: ink[50],               // the workspace
      sheet: '#fbfaf7',             // inner blocks on a white sheet, table headers
      navy: ink[950],               // the one night surface: Auth
      ink, accent, red, amber, emerald, violet, slate, sky, lime, orange,
      // truth layers — HELM never lets these blur into one number
      truth: { actual: ink[950], modelled: accent[600], stated: slate[600], scenario: violet[600] },
      // aliases so stock classes land on HELM hues
      gray: ink, zinc: ink, neutral: ink, stone: ink,
      teal: accent, cyan: accent, indigo: slate, blue: slate,
      green: emerald, yellow: amber, rose: red, purple: violet,
    },
    fontFamily: {
      sans: ['"Be Vietnam Pro"', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
      serif: ['"Source Serif 4"', 'Georgia', '"Times New Roman"', 'serif'],
      mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
    },
    fontSize: {
      // the record's voice (serif)
      display: ['28px', { lineHeight: '36px', letterSpacing: '-0.01em' }],    // page title / computed headline
      title: ['26px', { lineHeight: '34px', letterSpacing: '-0.01em' }],      // the question in the decision header
      instrument: ['28px', { lineHeight: '36px', letterSpacing: '-0.01em' }], // kernel page titles
      signal: ['20px', { lineHeight: '28px' }],                               // a condition that cannot wait
      section: ['17px', { lineHeight: '24px' }],                              // questions in lists, section heads
      'section-sm': ['15px', { lineHeight: '22px' }],
      panel: ['14px', { lineHeight: '22px' }],                                // panel titles (sans semibold)
      figure: ['22px', { lineHeight: '30px' }],
      'figure-sm': ['18px', { lineHeight: '28px' }],                          // stat value
      // interface (sans) + provenance (mono)
      lede: ['15px', { lineHeight: '24px' }],
      read: ['14px', { lineHeight: '22px' }],
      base: ['14px', { lineHeight: '22px' }],
      ui: ['14px', { lineHeight: '22px' }],
      dense: ['12px', { lineHeight: '18px' }],
      meta: ['11px', { lineHeight: '16px' }],
      label: ['11px', { lineHeight: '16px', letterSpacing: '0.06em' }],       // eyebrow, always uppercase
      tag: ['10.5px', { lineHeight: '14px', letterSpacing: '0.08em' }],       // ledger caps, provenance
    },
    // This is a record, not a bubble: 2px tags and bars, 4px controls, 6px sheets.
    borderRadius: { none: '0', sm: '2px', DEFAULT: '2px', md: '4px', lg: '4px', xl: '6px', '2xl': '6px', full: '9999px' },
    extend: {
      boxShadow: {
        panel: '0 1px 0 rgb(14 22 36 / 0.04)',
        overlay: '0 0 0 1px rgb(14 22 36 / 0.06), 0 24px 48px -12px rgb(14 22 36 / 0.28)',
        focus: '0 0 0 2px #f7f5f0, 0 0 0 4px #1e8075',
        field: '0 0 0 3px rgb(30 128 117 / 0.15)',
        decision: 'inset 0 2px 0 #136a61',  // the 2px teal rule on a ledger's decision column
      },
      maxWidth: { management: '1152px', reading: '680px', headline: '820px' },
      width: { sidebar: '232px' },
      spacing: { 'page-x': '24px', 'page-y': '24px' },
      transitionTimingFunction: { helm: 'cubic-bezier(0.4, 0, 0.2, 1)' },
      transitionDuration: { DEFAULT: '150ms' },
    },
  },
  plugins: [],
};
