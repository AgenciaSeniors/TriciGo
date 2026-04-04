// ============================================================
// TriciGo — Shared Tailwind CSS Preset
// Used by apps/client, apps/driver, and apps/admin
// ============================================================

/** @type {import('tailwindcss').Config} */
module.exports = {
  theme: {
    extend: {
      colors: {
        brand: {
          black: '#111111',
          orange: '#FF4D00',
          white: '#FFFFFF',
        },
        primary: {
          50: '#FFF3ED',
          100: '#FFE4D4',
          200: '#FFC5A8',
          300: '#FF9E71',
          400: '#FF6D38',
          500: '#FF4D00',
          600: '#E64400',
          700: '#BF3800',
          800: '#992D00',
          900: '#7A2400',
          950: '#421100',
        },
        neutral: {
          50: '#F9F9F9',
          100: '#F0F0F0',
          200: '#E4E4E4',
          300: '#D1D1D1',
          400: '#A3A3A3',
          500: '#737373',
          600: '#525252',
          700: '#404040',
          800: '#262626',
          900: '#171717',
          950: '#111111',
        },
        success: {
          light: '#D1FAE5',
          DEFAULT: '#10B981',
          dark: '#065F46',
        },
        warning: {
          light: '#FEF3C7',
          DEFAULT: '#F59E0B',
          dark: '#92400E',
        },
        error: {
          light: '#FEE2E2',
          DEFAULT: '#EF4444',
          dark: '#991B1B',
        },
        info: {
          light: '#DBEAFE',
          DEFAULT: '#3B82F6',
          dark: '#1E40AF',
        },
      },
      fontFamily: {
        sans: ['var(--font-montserrat)', 'Montserrat', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        sm: '4px',
        md: '8px',
        lg: '12px',
        xl: '16px',
        '2xl': '24px',
      },
    },
  },
};
