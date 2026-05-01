// ============================================================
// TriciGo — Typography System
// Primary: Inter | Fallback: Montserrat
// ============================================================

export const fontFamily = {
  sans: 'Inter',
  sansFallback: 'Montserrat',
  mono: 'JetBrainsMono_400Regular',
  /** Bricolage Grotesque — display headings, geometric with character. */
  display: 'BricolageGrotesque_700Bold',
  displayMedium: 'BricolageGrotesque_500Medium',
  displaySemibold: 'BricolageGrotesque_600SemiBold',
  /** Instrument Serif — emotional accent phrases (italic). */
  accent: 'InstrumentSerif_400Regular',
  accentItalic: 'InstrumentSerif_400Regular_Italic',
} as const;

export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  extrabold: '800',
} as const;

export const fontSize = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 30,
  '4xl': 36,
  '5xl': 48,
} as const;

export const lineHeight = {
  tight: 1.2,
  normal: 1.5,
  relaxed: 1.75,
} as const;

export const textVariants = {
  display: {
    fontSize: fontSize['5xl'],
    fontWeight: fontWeight.extrabold,
    lineHeight: 1.1,
  },
  h1: {
    fontSize: fontSize['3xl'],
    fontWeight: fontWeight.bold,
    lineHeight: lineHeight.tight,
  },
  h2: {
    fontSize: fontSize['2xl'],
    fontWeight: fontWeight.bold,
    lineHeight: lineHeight.tight,
  },
  h3: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.tight,
  },
  h4: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.tight,
  },
  body: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.normal,
  },
  bodySmall: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.normal,
  },
  caption: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.normal,
  },
  button: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
    lineHeight: lineHeight.tight,
  },
  buttonSmall: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.tight,
  },
  label: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.tight,
  },
  /** Large stat numbers (earnings totals, hero metrics) */
  stat: {
    fontSize: fontSize['3xl'],
    fontWeight: fontWeight.extrabold,
    lineHeight: lineHeight.tight,
  },
  /** Medium metric values (dashboard cards) */
  metric: {
    fontSize: fontSize['2xl'],
    fontWeight: fontWeight.bold,
    lineHeight: lineHeight.tight,
  },
  /** Small badge/pill text */
  badge: {
    fontSize: 11 as const,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.tight,
  },

  // ============================================================
  // Cuban Modern variants — see docs/DESIGN_CLIENT_HOME.md §3
  // Used by the redesigned passenger home / wallet / rides / profile.
  // ============================================================

  /** Display XL — hero numbers, balance amounts. Bricolage 42pt, tight tracking. */
  displayXl: {
    fontFamily: fontFamily.display,
    fontSize: 42,
    fontWeight: fontWeight.bold,
    lineHeight: 1.05,
    letterSpacing: -0.5,
  },
  /** Display L — section headings (e.g., "Tu saldo"). Bricolage 28pt. */
  displayLg: {
    fontFamily: fontFamily.displaySemibold,
    fontSize: 28,
    fontWeight: fontWeight.semibold,
    lineHeight: 1.15,
    letterSpacing: -0.25,
  },
  /** Display M — sub-headings. Bricolage 20pt. */
  displayMd: {
    fontFamily: fontFamily.displaySemibold,
    fontSize: 20,
    fontWeight: fontWeight.semibold,
    lineHeight: 1.2,
    letterSpacing: -0.15,
  },
  /** Accent — Instrument Serif italic for emotional anchor ("¿A dónde vamos?"). */
  accentItalic: {
    fontFamily: fontFamily.accentItalic,
    fontSize: 28,
    fontWeight: fontWeight.regular,
    lineHeight: 1.2,
    fontStyle: 'italic' as const,
  },
  /** Caption mono — uppercase metadata labels (SALDO DISPONIBLE, RECIENTES). */
  captionMono: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    fontWeight: fontWeight.medium,
    lineHeight: 1.3,
    letterSpacing: 1.5,
    textTransform: 'uppercase' as const,
  },
  /** Number mono — prices, ETAs, distances. JetBrains Mono 16pt. */
  numberMono: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.base,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.tight,
  },
} as const;
