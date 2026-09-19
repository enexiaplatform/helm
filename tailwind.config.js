/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        // Executive palette: ink for chrome, one restrained accent, semantic
        // status colors used sparingly for signal severity only.
        ink: {
          50: '#f6f7f9',
          100: '#eceef2',
          200: '#d5d9e2',
          300: '#b1b8c9',
          400: '#8791ab',
          500: '#687390',
          600: '#535c77',
          700: '#444b61',
          800: '#3b4152',
          900: '#343947',
          950: '#16181f',
        },
        accent: {
          50: '#eef6ff',
          100: '#d9eaff',
          200: '#bcdbff',
          300: '#8ec4ff',
          400: '#59a3ff',
          500: '#3380fc',
          600: '#1d60f1',
          700: '#154bde',
          800: '#183eb4',
          900: '#19398d',
        },
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      boxShadow: {
        panel: '0 1px 2px 0 rgb(22 24 31 / 0.05), 0 1px 3px 0 rgb(22 24 31 / 0.06)',
        overlay: '0 10px 38px -10px rgb(22 24 31 / 0.35), 0 10px 20px -15px rgb(22 24 31 / 0.2)',
      },
    },
  },
  plugins: [],
};
