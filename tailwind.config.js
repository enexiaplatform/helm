import { readFileSync } from 'node:fs';

// The palette lives in one place: src/styles/tokens/colors.css ("chart room").
// Tailwind utilities read the same values, so `text-ink-500` in a page and
// `var(--ink-500)` in a component recipe can never drift apart. Hex values
// (not var()) keep opacity modifiers like `bg-ink-950/40` working.
const colorsCss = readFileSync(new URL('./src/styles/tokens/colors.css', import.meta.url), 'utf8');
const palette = {};
for (const [, family, step, hex] of colorsCss.matchAll(/--([a-z]+)-(\d+):\s*(#[0-9a-f]{6})/gi)) {
  (palette[family] ??= {})[step] = hex;
}
const single = (name) => colorsCss.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))[1];

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Be Vietnam Pro runs the interface, Newsreader is the management
        // voice, IBM Plex Mono carries every value (tokens/typography.css).
        sans: ['Be Vietnam Pro', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        serif: ['Newsreader', 'Iowan Old Style', 'Palatino Linotype', 'Georgia', 'serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        ...palette,
        paper: single('paper'),
      },
      fontSize: {
        // No 11px reading text: meta is 12/18, panel body 13/20, base 14/22.
        '2xs': ['0.75rem', { lineHeight: '1.125rem' }],
        xs: ['0.8125rem', { lineHeight: '1.25rem' }],
        sm: ['0.875rem', { lineHeight: '1.375rem' }],
      },
      letterSpacing: {
        wide: '0.08em', // uppercase labels
        display: '-0.012em', // serif display sizes
      },
      borderRadius: {
        DEFAULT: '6px', // small wells, chips' square cousins
        md: '8px', // buttons, inputs, nav items, wells
        lg: '12px', // panels, empty states
        xl: '16px', // modals, the auth card
      },
      boxShadow: {
        panel: '0 1px 2px 0 rgb(18 22 29 / 0.04), 0 4px 12px -6px rgb(18 22 29 / 0.08)',
        overlay: '0 24px 64px -16px rgb(13 26 46 / 0.32), 0 8px 24px -12px rgb(13 26 46 / 0.2)',
      },
      transitionDuration: { DEFAULT: '160ms' },
      transitionTimingFunction: { DEFAULT: 'cubic-bezier(0.2, 0, 0, 1)' },
    },
  },
  plugins: [],
};
