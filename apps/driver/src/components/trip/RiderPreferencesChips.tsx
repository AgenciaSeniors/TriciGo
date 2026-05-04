/**
 * RiderPreferencesChips — Midnight Ember edition (PR-B).
 *
 * Collapsible row of chips representing the rider's preferences. Hidden
 * by default; tap a "Ver preferencias" link to expand.
 *
 * v2 tokenization:
 *   - 9 chips that previously used 5+ ad-hoc colors (orange / blue /
 *     green / purple / amber) collapse into ONE uniform chip style.
 *     Only the icon shape varies; the chip itself is always
 *     `map.bg.surface` + `line.default` border + `text.secondary`
 *     content. The icon color follows the same secondary token so the
 *     chip rail reads as a calm enumeration, not a parade of badges.
 *   - Container border + radius: `radius.tap` (chip), `line.default`.
 *   - Toggle link consumes `accent[500]` for affordance.
 */
import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber } from '@tricigo/theme';

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

interface ChipDef {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
}

function PrefChip({ icon, label }: ChipDef) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: midnightEmber.radius.pill,
        backgroundColor: midnightEmber.map.bg.surface,
        borderWidth: 1,
        borderColor: midnightEmber.map.line.default,
      }}
    >
      <Ionicons name={icon} size={12} color={midnightEmber.map.text.secondary} />
      <Text
        variant="caption"
        style={{ color: midnightEmber.map.text.secondary }}
      >
        {label}
      </Text>
    </View>
  );
}

export function RiderPreferencesChips({ preferences }: RiderPreferencesChipsProps) {
  const { t } = useTranslation('driver');
  const [expanded, setExpanded] = useState(false);

  if (!preferences) return null;
  const hasAny = Object.values(preferences).some(Boolean);
  if (!hasAny) return null;

  const chips: ChipDef[] = [];
  if (preferences.quiet_mode) {
    chips.push({ icon: 'volume-mute', label: t('ride.pref_quiet', { defaultValue: 'Silencio' }) });
  }
  if (preferences.temperature === 'cool') {
    chips.push({ icon: 'snow', label: t('ride.pref_cool', { defaultValue: 'AC fresco' }) });
  }
  if (preferences.temperature === 'warm') {
    chips.push({ icon: 'sunny', label: t('ride.pref_warm', { defaultValue: 'Cálido' }) });
  }
  if (preferences.conversation_ok) {
    chips.push({ icon: 'chatbubbles', label: t('ride.pref_conversation', { defaultValue: 'Conversación' }) });
  }
  if (preferences.luggage_trunk) {
    chips.push({ icon: 'briefcase', label: t('ride.pref_trunk', { defaultValue: 'Maletero' }) });
  }
  if (preferences.accessibility_needs?.includes('wheelchair')) {
    chips.push({ icon: 'accessibility', label: t('ride.pref_wheelchair', { defaultValue: 'Silla de ruedas' }) });
  }
  if (preferences.accessibility_needs?.includes('hearing_impaired')) {
    chips.push({ icon: 'ear', label: t('ride.pref_hearing', { defaultValue: 'Dificultad auditiva' }) });
  }
  if (preferences.accessibility_needs?.includes('visual_impaired')) {
    chips.push({ icon: 'eye-off', label: t('ride.pref_visual', { defaultValue: 'Dificultad visual' }) });
  }
  if (preferences.accessibility_needs?.includes('service_animal')) {
    chips.push({ icon: 'paw', label: t('ride.pref_service_animal', { defaultValue: 'Animal de servicio' }) });
  }
  if (preferences.accessibility_needs?.includes('extra_space')) {
    chips.push({ icon: 'resize', label: t('ride.pref_extra_space', { defaultValue: 'Espacio extra' }) });
  }

  return (
    <View style={{ marginBottom: 12 }}>
      <Pressable
        onPress={() => setExpanded(!expanded)}
        style={{ minHeight: 48, justifyContent: 'center' }}
        accessibilityRole="button"
        accessibilityLabel={expanded ? t('trip.hide_preferences') : t('trip.view_preferences')}
      >
        <Text
          variant="bodySmall"
          style={{
            textAlign: 'center',
            marginVertical: 4,
            color: midnightEmber.accent[500],
          }}
        >
          {expanded ? t('trip.hide_preferences') : t('trip.view_preferences')}
        </Text>
      </Pressable>
      {expanded && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 4 }}>
          <View style={{ alignSelf: 'center', marginRight: 2 }}>
            <Ionicons
              name="options-outline"
              size={14}
              color={midnightEmber.map.text.tertiary}
            />
          </View>
          {chips.map((c) => (
            <PrefChip key={c.label} icon={c.icon} label={c.label} />
          ))}
        </View>
      )}
    </View>
  );
}
