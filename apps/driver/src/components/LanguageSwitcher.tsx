import React, { useState, useCallback } from 'react';
import { Pressable, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTranslation } from '@tricigo/i18n';
import { Text } from '@tricigo/ui/Text';

const LANGUAGES = [
  { code: 'es', label: 'ES' },
  { code: 'en', label: 'EN' },
  { code: 'pt', label: 'PT' },
] as const;

interface LanguageSwitcherProps {
  /** 'pill' = glassmorphism for floating header, 'compact' = onboarding header */
  variant?: 'pill' | 'compact';
}

export function LanguageSwitcher({ variant = 'compact' }: LanguageSwitcherProps) {
  const { i18n, t } = useTranslation('driver');
  const [showPicker, setShowPicker] = useState(false);
  const currentLang = i18n.language || 'es';

  const handleChange = useCallback(
    (code: string) => {
      i18n.changeLanguage(code);
      AsyncStorage.setItem('tricigo_language', code);
      setShowPicker(false);
    },
    [i18n],
  );

  const isPill = variant === 'pill';

  return (
    <View style={s.wrapper}>
      <Pressable
        onPress={() => setShowPicker(!showPicker)}
        style={[s.trigger, isPill ? s.triggerPill : s.triggerCompact]}
      >
        <Ionicons name="globe-outline" size={isPill ? 15 : 14} color="#FF4D00" />
        <Text
          variant="caption"
          style={{ color: '#FF4D00', fontWeight: '700', fontSize: isPill ? 12 : 11 }}
        >
          {currentLang.toUpperCase()}
        </Text>
        <Ionicons name="chevron-down" size={10} color="rgba(255,255,255,0.4)" />
      </Pressable>

      {showPicker && (
        <View style={[s.dropdown, isPill ? s.dropdownPill : s.dropdownCompact]}>
          {LANGUAGES.map((lang) => {
            const isActive = currentLang === lang.code;
            return (
              <Pressable
                key={lang.code}
                onPress={() => handleChange(lang.code)}
                style={[s.option, isActive && s.optionActive]}
              >
                {isActive && (
                  <Ionicons name="checkmark" size={14} color="#FF4D00" />
                )}
                <Text
                  variant="bodySmall"
                  style={{
                    color: isActive ? '#FF4D00' : '#FFFFFF',
                    fontWeight: isActive ? '700' : '400',
                    marginLeft: isActive ? 0 : 22,
                  }}
                >
                  {t(`onboarding.lang_${lang.code}`, { defaultValue: lang.label })}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrapper: {
    position: 'relative',
    zIndex: 200,
  },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  triggerPill: {
    backgroundColor: 'rgba(20,20,20,0.7)',
    borderRadius: 20,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  triggerCompact: {
    backgroundColor: '#1a1a2e',
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  dropdown: {
    position: 'absolute',
    top: 38,
    right: 0,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
    zIndex: 200,
    minWidth: 130,
  },
  dropdownPill: {
    backgroundColor: 'rgba(20,20,20,0.95)',
    borderColor: 'rgba(255,255,255,0.1)',
  },
  dropdownCompact: {
    backgroundColor: '#1a1a2e',
    borderColor: '#252540',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 11,
    gap: 8,
    backgroundColor: 'transparent',
  },
  optionActive: {
    backgroundColor: 'rgba(255,77,0,0.12)',
  },
});
