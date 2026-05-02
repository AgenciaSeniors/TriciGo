/**
 * WeatherChip — compact location-aware weather widget for the home header.
 *
 * Renders as: [icon] 28° · Habana
 *
 * Hides itself when no temperature data is available (no "--°" placeholder).
 * City name truncates at ~14 chars to fit in the header next to other actions.
 */
import React from 'react';
import { View, Text as RNText } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { cubanLight, cubanDark } from '@tricigo/theme';

export interface WeatherChipProps {
  tempC: number;
  conditionCode: number;
  city: string | null;
  mode?: 'light' | 'dark';
}

function getIconName(code: number): keyof typeof Ionicons.glyphMap {
  if (code >= 200 && code <= 232) return 'thunderstorm';
  if (code >= 300 && code <= 321) return 'rainy-outline';
  if (code >= 500 && code <= 531) return 'rainy';
  if (code >= 600 && code <= 622) return 'snow';
  if (code >= 701 && code <= 781) return 'cloudy-outline';
  if (code === 800) return 'sunny';
  if (code === 801) return 'partly-sunny';
  if (code >= 802 && code <= 804) return 'cloudy';
  return 'sunny';
}

export function WeatherChip({ tempC, conditionCode, city, mode = 'light' }: WeatherChipProps) {
  const tokens = mode === 'dark' ? cubanDark : cubanLight;
  const iconName = getIconName(conditionCode);

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        backgroundColor: tokens.bg.elev1,
        borderWidth: 1,
        borderColor: tokens.line,
      }}
      accessibilityLabel={`${Math.round(tempC)} grados${city ? `, ${city}` : ''}`}
    >
      <Ionicons name={iconName} size={14} color={tokens.accent.warm} />
      <RNText
        style={{
          fontFamily: 'JetBrainsMono_500Medium',
          fontSize: 12,
          color: tokens.ink.primary,
          lineHeight: 14,
        }}
      >
        {Math.round(tempC)}°
      </RNText>
      {city && (
        <>
          <RNText
            style={{
              fontFamily: 'JetBrainsMono_500Medium',
              fontSize: 12,
              color: tokens.ink.subtle,
              lineHeight: 14,
            }}
          >
            ·
          </RNText>
          <RNText
            style={{
              fontFamily: 'Inter_500Medium',
              fontSize: 12,
              color: tokens.ink.secondary,
              maxWidth: 90,
              lineHeight: 14,
            }}
            numberOfLines={1}
          >
            {city}
          </RNText>
        </>
      )}
    </View>
  );
}
