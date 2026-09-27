// ============================================================
// TriciGo Driver — a card with its own background color
// <Card> cannot be tinted through className: NativeWind applies
// conflicting classes by specificity and stylesheet order, not in
// the order they are written, and Card's own bg-white / bg-neutral-*
// comes after most tints (src/__tests__/cardTints.test.ts checks
// every <Card>). This View has Card's shape and accessibility but no
// background, so the colors in className are the ones that render.
// ============================================================

import React from 'react';
import { View, type ViewProps } from 'react-native';

const paddingClasses = { md: 'p-4', lg: 'p-6' } as const;

interface TintedCardProps extends ViewProps {
  /** Background, border, shadow and margins, applied as written. */
  className: string;
  padding?: keyof typeof paddingClasses;
}

export function TintedCard({ className, padding = 'md', children, ...props }: TintedCardProps) {
  return (
    <View
      accessible
      accessibilityRole="summary"
      className={`rounded-2xl ${paddingClasses[padding]} ${className}`}
      {...props}
    >
      {children}
    </View>
  );
}
