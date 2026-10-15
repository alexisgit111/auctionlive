/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: { DEFAULT: '#001D4A', 950: '#000F28', 900: '#001537', 800: '#001D4A', 700: '#0A2C63', 600: '#163C7A' },
        brand: { DEFAULT: '#00A1E9', 600: '#008BCB', 400: '#33B4ED', 100: '#E0F4FD', 50: '#F0FAFE' },
        // Light, white-based UI
        surface: { DEFAULT: '#F4F6F9', 2: '#FFFFFF', 3: '#EEF2F7' },
        ink: { DEFAULT: '#1E2B40', muted: '#5B6B82', faint: '#8A96A8' },
        line: '#DCE3EC',
        subtle: { DEFAULT: '#F3F6FA', 2: '#E7ECF3' },
        ok: '#16A34A',
        warn: '#D97706',
        bad: '#DC2626',
      },
      fontFamily: {
        sans: ['"Source Sans 3"', '"Source Sans Pro"', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
