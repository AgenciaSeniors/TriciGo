/**
 * CapitolioDivider — subtle Cuban identity marker.
 *
 * SVG silhouette of El Capitolio de La Habana (dome + columns + wings)
 * flanked by two minimal palm trees. Used as a decorative divider
 * between sections on the redesigned client home — not folkloric,
 * not touristy, just a quiet nod to the local architecture.
 *
 * Reference: docs/DESIGN_CLIENT_HOME.md §4, §10
 */
import React from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { cubanLight, cubanDark } from '@tricigo/theme';

// react-native-svg works on native; on web we fall back to inline SVG.
let Svg: React.ComponentType<any> | null = null;
let Rect: React.ComponentType<any> | null = null;
let Polygon: React.ComponentType<any> | null = null;
let Ellipse: React.ComponentType<any> | null = null;
let Path: React.ComponentType<any> | null = null;
let Line: React.ComponentType<any> | null = null;
let Circle: React.ComponentType<any> | null = null;
let G: React.ComponentType<any> | null = null;

try {
  const svgLib = require('react-native-svg');
  Svg = svgLib.default;
  Rect = svgLib.Rect;
  Polygon = svgLib.Polygon;
  Ellipse = svgLib.Ellipse;
  Path = svgLib.Path;
  Line = svgLib.Line;
  Circle = svgLib.Circle;
  G = svgLib.G;
} catch {
  // Fall back silently on web
}

export interface CapitolioDividerProps {
  mode?: 'light' | 'dark';
  height?: number;
}

export function CapitolioDivider({ mode = 'light', height = 72 }: CapitolioDividerProps) {
  const tokens = mode === 'dark' ? cubanDark : cubanLight;
  const dusk = tokens.accent.dusk;
  const orange = tokens.accent.orange;
  const warm = tokens.accent.warm;
  const opacity = mode === 'dark' ? 0.55 : 0.45;

  if (!Svg || !G || !Polygon || !Rect || !Ellipse || !Path || !Line || !Circle) {
    // Web fallback using inline SVG via dangerouslySetInnerHTML-style approach
    return <View style={[styles.wrap, { height, opacity }]} />;
  }

  return (
    <View style={[styles.wrap, { height }]}>
      <Svg width="100%" height="100%" viewBox="0 0 390 72" preserveAspectRatio="xMidYMid meet">
        {/* Palmera izquierda */}
        <G transform="translate(18, 28) scale(0.8)" opacity={opacity}>
          <Line x1="8" y1="40" x2="8" y2="18" stroke={dusk} strokeWidth={1.2} strokeLinecap="round" />
          <Path d="M 8 18 Q 0 12, -4 6 M 8 18 Q 2 8, 2 0 M 8 18 Q 14 8, 20 4 M 8 18 Q 18 14, 24 12" stroke={dusk} strokeWidth={1} fill="none" strokeLinecap="round" />
        </G>
        {/* Palmera derecha */}
        <G transform="translate(362, 30) scale(0.8)" opacity={opacity}>
          <Line x1="8" y1="38" x2="8" y2="16" stroke={dusk} strokeWidth={1.2} strokeLinecap="round" />
          <Path d="M 8 16 Q 0 10, -4 4 M 8 16 Q 2 6, 2 -2 M 8 16 Q 14 6, 20 2 M 8 16 Q 18 12, 24 10" stroke={dusk} strokeWidth={1} fill="none" strokeLinecap="round" />
        </G>

        {/* Capitolio */}
        <G transform="translate(195, 0)" opacity={opacity + 0.15}>
          {/* Escalera base */}
          <Polygon points="-95,68 95,68 82,64 -82,64" fill={dusk} />
          <Polygon points="-82,64 82,64 74,60 -74,60" fill={dusk} />

          {/* Alas laterales */}
          <Rect x="-74" y="42" width="48" height="18" fill={dusk} />
          <Rect x="26" y="42" width="48" height="18" fill={dusk} />

          {/* Ventanas */}
          <G fill={warm} opacity={0.35}>
            <Rect x="-68" y="48" width="3" height="6" />
            <Rect x="-60" y="48" width="3" height="6" />
            <Rect x="-52" y="48" width="3" height="6" />
            <Rect x="-44" y="48" width="3" height="6" />
            <Rect x="-36" y="48" width="3" height="6" />
            <Rect x="32" y="48" width="3" height="6" />
            <Rect x="40" y="48" width="3" height="6" />
            <Rect x="48" y="48" width="3" height="6" />
            <Rect x="56" y="48" width="3" height="6" />
            <Rect x="64" y="48" width="3" height="6" />
          </G>

          {/* Cuerpo central */}
          <Rect x="-26" y="38" width="52" height="22" fill={dusk} />

          {/* Columnas */}
          <G fill={dusk}>
            <Rect x="-22" y="38" width="3" height="22" />
            <Rect x="-14" y="38" width="3" height="22" />
            <Rect x="-6" y="38" width="3" height="22" />
            <Rect x="2" y="38" width="3" height="22" />
            <Rect x="10" y="38" width="3" height="22" />
            <Rect x="18" y="38" width="3" height="22" />
          </G>

          {/* Frontón triangular */}
          <Polygon points="-28,38 28,38 0,28" fill={dusk} />

          {/* Cúpula base + nervios */}
          <Ellipse cx="0" cy="22" rx="22" ry="10" fill={dusk} />
          <Path d="M -22 22 Q -22 2, 0 2 Q 22 2, 22 22" fill={dusk} />
          <G stroke={orange} strokeWidth={0.4} opacity={0.5} fill="none">
            <Path d="M -18 22 Q -16 8, -8 4" />
            <Path d="M -10 22 Q -9 4, 0 2" />
            <Path d="M 0 22 L 0 2" />
            <Path d="M 10 22 Q 9 4, 0 2" />
            <Path d="M 18 22 Q 16 8, 8 4" />
          </G>

          {/* Cupulín */}
          <Rect x="-4" y="-4" width="8" height="6" fill={dusk} />
          <Rect x="-5" y="-6" width="10" height="2" fill={dusk} />
          {/* Aguja + luz naranja */}
          <Line x1="0" y1="-6" x2="0" y2="-14" stroke={dusk} strokeWidth={1.5} strokeLinecap="round" />
          <Circle cx="0" cy="-14" r={1.5} fill={orange} />
        </G>
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: '100%',
    marginVertical: 8,
    ...Platform.select({
      web: { marginHorizontal: -20 } as object,
      default: {},
    }),
  },
});
