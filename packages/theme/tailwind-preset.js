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
        // Trinational accent (Brasil / Paraguay / Argentina)
        flag: {
          br: '#009C3B',
          py: '#D52B1E',
          ar: '#75AADB',
        },
        // Semantic surface tokens (driven by CSS vars — see globals.css)
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          elevated: 'rgb(var(--surface-elevated) / <alpha-value>)',
          sunken: 'rgb(var(--surface-sunken) / <alpha-value>)',
          inverse: 'rgb(var(--surface-inverse) / <alpha-value>)',
        },
        ink: {
          DEFAULT: 'rgb(var(--ink) / <alpha-value>)',
          muted: 'rgb(var(--ink-muted) / <alpha-value>)',
          subtle: 'rgb(var(--ink-subtle) / <alpha-value>)',
          inverse: 'rgb(var(--ink-inverse) / <alpha-value>)',
        },
        line: {
          DEFAULT: 'rgb(var(--line) / <alpha-value>)',
          strong: 'rgb(var(--line-strong) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['"Instrument Sans"', 'Montserrat', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Bricolage Grotesque"', '"Instrument Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        editorial: ['"Instrument Serif"', 'ui-serif', 'Georgia', 'serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.02em' }],
      },
      borderRadius: {
        sm: '4px',
        md: '8px',
        lg: '12px',
        xl: '16px',
        '2xl': '24px',
        '3xl': '32px',
      },
      boxShadow: {
        'elev-1': '0 1px 2px 0 rgb(0 0 0 / 0.04), 0 1px 1px 0 rgb(0 0 0 / 0.02)',
        'elev-2': '0 2px 8px -2px rgb(0 0 0 / 0.06), 0 1px 3px -1px rgb(0 0 0 / 0.04)',
        'elev-3': '0 10px 30px -10px rgb(0 0 0 / 0.10), 0 4px 12px -4px rgb(0 0 0 / 0.06)',
        'glow-primary': '0 0 0 1px rgb(255 77 0 / 0.15), 0 8px 24px -8px rgb(255 77 0 / 0.35)',
        'ring-focus': '0 0 0 2px rgb(var(--surface) / 1), 0 0 0 4px rgb(255 77 0 / 0.5)',
      },
      backgroundImage: {
        'grid-faint':
          'linear-gradient(to right, rgb(var(--line) / 0.6) 1px, transparent 1px), linear-gradient(to bottom, rgb(var(--line) / 0.6) 1px, transparent 1px)',
        'radial-primary':
          'radial-gradient(ellipse at top, rgb(255 77 0 / 0.12), transparent 60%)',
        'aurora':
          'conic-gradient(from 180deg at 50% 50%, rgb(255 77 0 / 0.18), rgb(0 156 59 / 0.12), rgb(117 170 219 / 0.12), rgb(213 43 30 / 0.10), rgb(255 77 0 / 0.18))',
      },
      backgroundSize: {
        grid: '32px 32px',
      },
      transitionTimingFunction: {
        'spring': 'cubic-bezier(0.22, 1, 0.36, 1)',
        'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'shimmer': {
          '0%': { backgroundPosition: '-1000px 0' },
          '100%': { backgroundPosition: '1000px 0' },
        },
        'pulse-ring': {
          '0%': { transform: 'scale(0.9)', opacity: '0.7' },
          '100%': { transform: 'scale(2.2)', opacity: '0' },
        },
      },
      animation: {
        'fade-in': 'fade-in 220ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'shimmer': 'shimmer 1.8s linear infinite',
        'pulse-ring': 'pulse-ring 1.8s cubic-bezier(0.22, 1, 0.36, 1) infinite',
      },
    },
  },
};
