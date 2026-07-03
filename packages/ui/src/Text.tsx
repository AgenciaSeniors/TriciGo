import React from 'react';
import { Text as RNText, StyleSheet, type TextProps as RNTextProps } from 'react-native';

export interface TextProps extends RNTextProps {
  variant?:
    | 'h1' | 'h2' | 'h3' | 'h4'
    | 'body' | 'bodySmall'
    | 'caption' | 'label'
    | 'stat' | 'metric' | 'badge'
    // Cuban Modern variants — see packages/theme/src/typography.ts §3
    | 'displayXl' | 'displayLg' | 'displayMd'
    | 'accentItalic'
    | 'captionMono' | 'numberMono';
  color?: 'primary' | 'secondary' | 'tertiary' | 'inverse' | 'accent' | 'error' | 'muted';
}

const variantClasses = {
  h1: 'text-4xl font-extrabold',
  h2: 'text-3xl font-bold',
  h3: 'text-2xl font-bold',
  h4: 'text-xl font-semibold',
  body: 'text-base font-normal',
  bodySmall: 'text-sm font-normal',
  caption: 'text-xs font-medium',
  label: 'text-sm font-medium',
  stat: 'text-3xl font-extrabold',
  metric: 'text-2xl font-bold',
  badge: 'text-[11px] font-semibold',
  // Cuban Modern variants. font-display = Bricolage Grotesque,
  // font-editorial = Instrument Serif (italic via fontStyle),
  // font-mono = JetBrains Mono. Tracking matches the typography spec.
  displayXl: 'font-display text-[42px] font-bold leading-[1.05] tracking-tight',
  displayLg: 'font-display text-[28px] font-semibold leading-tight tracking-tight',
  displayMd: 'font-display text-[20px] font-semibold leading-tight',
  accentItalic: 'font-editorial italic text-[28px] font-normal leading-tight',
  captionMono: 'font-mono text-[11px] font-medium uppercase tracking-[1.5px] leading-[1.3]',
  numberMono: 'font-mono text-base font-medium leading-tight',
} as const;

// Line height (px) emitted by each variant's Tailwind classes above.
// `badge` uses an arbitrary text-[11px] size with no leading utility, so
// NativeWind sets no lineHeight for it — nothing can clip, no entry needed.
const variantLineHeight: Partial<Record<NonNullable<TextProps['variant']>, number>> = {
  h1: 40,
  h2: 36,
  h3: 32,
  h4: 28,
  body: 24,
  bodySmall: 20,
  caption: 16,
  label: 20,
  stat: 36,
  metric: 32,
  displayXl: 44,
  displayLg: 35,
  displayMd: 25,
  accentItalic: 35,
  captionMono: 14,
  numberMono: 20,
};

const colorClasses = {
  primary: 'text-neutral-950 dark:text-neutral-50',
  secondary: 'text-neutral-600 dark:text-neutral-400',
  tertiary: 'text-neutral-400 dark:text-[#8a8a8a]',
  inverse: 'text-white',
  accent: 'text-primary-500',
  error: 'text-error',
  muted: 'text-neutral-500 dark:text-neutral-400',
} as const;

export function Text({
  variant = 'body',
  color = 'primary',
  className,
  style,
  children,
  ...props
}: TextProps & { className?: string }) {
  // iOS clips glyphs taller than the line box (Android lets them overflow),
  // so an inline fontSize that outgrows the variant's Tailwind line-height —
  // e.g. style={{ fontSize: 28 }} over the default body's 24px box — renders
  // with the top of every glyph cut off on iPhone. Widen the box whenever an
  // inline fontSize (without an explicit lineHeight) wouldn't fit.
  const flat = StyleSheet.flatten(style);
  const variantLH = variantLineHeight[variant];
  let resolvedStyle = style;
  if (
    flat?.fontSize != null &&
    flat.lineHeight == null &&
    variantLH != null &&
    flat.fontSize * 1.2 > variantLH
  ) {
    resolvedStyle = [style, { lineHeight: Math.ceil(flat.fontSize * 1.25) }];
  }

  return (
    <RNText
      className={`
        ${variantClasses[variant]}
        ${colorClasses[color]}
        ${className ?? ''}
      `}
      style={resolvedStyle}
      {...props}
    >
      {children}
    </RNText>
  );
}
