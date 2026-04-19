/**
 * DemoBanner — barra top persistente cuando la app corre en modo demo.
 *
 * Sólo se renderiza si `DEMO_MODE=true`. Queda fija al top (debajo del
 * status bar / notch), no bloquea taps del contenido, y tiene un look
 * on-brand Cuban Modern (naranja cálido, JetBrainsMono letter-spaced).
 *
 * Propósito: al creador nunca se le olvida que está en un APK no-prod
 * y los datos que se generan NO son reales.
 */
import React from 'react';
import { View, Text as RNText, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DEMO_MODE, DEMO_CITY, DEMO_CITY_LABEL } from '@/config/demo';

export function DemoBanner() {
  const insets = useSafeAreaInsets();
  if (!DEMO_MODE) return null;

  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        paddingTop: insets.top + 4,
        paddingBottom: 6,
        paddingHorizontal: 16,
        backgroundColor: '#FF4D00',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        // Ensure visible on top of the map, modals, etc.
        elevation: Platform.OS === 'android' ? 20 : undefined,
      }}
      accessibilityRole="alert"
    >
      <RNText
        style={{
          fontFamily: 'JetBrainsMono_600SemiBold',
          fontSize: 10,
          letterSpacing: 2,
          color: '#FFFFFF',
        }}
      >
        {`MODO DEMO · ${DEMO_CITY_LABEL[DEMO_CITY].toUpperCase()} · NO PRODUCCIÓN`}
      </RNText>
    </View>
  );
}
