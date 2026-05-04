/**
 * RiderPreferencesChips — extracted from DriverTripView for PR-A.
 *
 * Collapsible row of chips representing the rider's preferences for the
 * trip (`quiet_mode`, `temperature`, `conversation_ok`, `luggage_trunk`,
 * `accessibility_needs[]`). Hidden by default; tap a "Ver preferencias"
 * link to expand.
 *
 * Visual + tokens preserved verbatim — chips use ad-hoc per-pref colors
 * which collapse to a uniform style in PR-B.
 *
 * State (`expanded`) is local and stays inside the component.
 */
import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';

export interface RiderPreferences {
  quiet_mode?: boolean;
  conversation_ok?: boolean;
  temperature?: 'cool' | 'warm' | 'no_preference';
  luggage_trunk?: boolean;
  accessibility_needs?: string[];
}

interface RiderPreferencesChipsProps {
  preferences: RiderPreferences | null | undefined;
}

export function RiderPreferencesChips({ preferences }: RiderPreferencesChipsProps) {
  const { t } = useTranslation('driver');
  const [expanded, setExpanded] = useState(false);

  // Same gating logic as the inline version: only render if at least one
  // preference is truthy. Using Object.values + Boolean covers strings
  // and arrays uniformly.
  if (!preferences) return null;
  const hasAny = Object.values(preferences).some(Boolean);
  if (!hasAny) return null;

  return (
    <View className="mb-3">
      <Pressable
        onPress={() => setExpanded(!expanded)}
        style={{ minHeight: 48, justifyContent: 'center' }}
        accessibilityRole="button"
        accessibilityLabel={expanded ? t('trip.hide_preferences') : t('trip.view_preferences')}
      >
        <Text variant="bodySmall" color="accent" style={{ textAlign: 'center', marginVertical: 4 }}>
          {expanded ? t('trip.hide_preferences') : t('trip.view_preferences')}
        </Text>
      </Pressable>
      {expanded && (
        <View className="flex-row flex-wrap gap-1.5 px-1">
          <Ionicons name="options-outline" size={14} color="#9CA3AF" />
          {preferences.quiet_mode && (
            <View className="flex-row items-center bg-[#1a1a2e] px-2.5 py-1 rounded-full gap-1">
              <Ionicons name="volume-mute" size={12} color="#FFA726" />
              <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_quiet', { defaultValue: 'Silencio' })}</Text>
            </View>
          )}
          {preferences.temperature === 'cool' && (
            <View className="flex-row items-center bg-[#1a1a2e] px-2.5 py-1 rounded-full gap-1">
              <Ionicons name="snow" size={12} color="#42A5F5" />
              <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_cool', { defaultValue: 'AC fresco' })}</Text>
            </View>
          )}
          {preferences.temperature === 'warm' && (
            <View className="flex-row items-center bg-[#1a1a2e] px-2.5 py-1 rounded-full gap-1">
              <Ionicons name="sunny" size={12} color="#FFA726" />
              <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_warm', { defaultValue: 'Cálido' })}</Text>
            </View>
          )}
          {preferences.conversation_ok && (
            <View className="flex-row items-center bg-[#1a1a2e] px-2.5 py-1 rounded-full gap-1">
              <Ionicons name="chatbubbles" size={12} color="#66BB6A" />
              <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_conversation', { defaultValue: 'Conversación' })}</Text>
            </View>
          )}
          {preferences.luggage_trunk && (
            <View className="flex-row items-center bg-[#1a1a2e] px-2.5 py-1 rounded-full gap-1">
              <Ionicons name="briefcase" size={12} color="#AB47BC" />
              <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_trunk', { defaultValue: 'Maletero' })}</Text>
            </View>
          )}
          {preferences.accessibility_needs?.includes('wheelchair') && (
            <View className="flex-row items-center bg-blue-900 px-2.5 py-1 rounded-full gap-1">
              <Ionicons name="accessibility" size={12} color="#64B5F6" />
              <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_wheelchair', { defaultValue: 'Silla de ruedas' })}</Text>
            </View>
          )}
          {preferences.accessibility_needs?.includes('hearing_impaired') && (
            <View className="flex-row items-center bg-blue-900 px-2.5 py-1 rounded-full gap-1">
              <Ionicons name="ear" size={12} color="#64B5F6" />
              <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_hearing', { defaultValue: 'Dificultad auditiva' })}</Text>
            </View>
          )}
          {preferences.accessibility_needs?.includes('visual_impaired') && (
            <View className="flex-row items-center bg-blue-900 px-2.5 py-1 rounded-full gap-1">
              <Ionicons name="eye-off" size={12} color="#64B5F6" />
              <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_visual', { defaultValue: 'Dificultad visual' })}</Text>
            </View>
          )}
          {preferences.accessibility_needs?.includes('service_animal') && (
            <View className="flex-row items-center bg-blue-900 px-2.5 py-1 rounded-full gap-1">
              <Ionicons name="paw" size={12} color="#64B5F6" />
              <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_service_animal', { defaultValue: 'Animal de servicio' })}</Text>
            </View>
          )}
          {preferences.accessibility_needs?.includes('extra_space') && (
            <View className="flex-row items-center bg-blue-900 px-2.5 py-1 rounded-full gap-1">
              <Ionicons name="resize" size={12} color="#64B5F6" />
              <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_extra_space', { defaultValue: 'Espacio extra' })}</Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
}
