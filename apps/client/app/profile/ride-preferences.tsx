import React, { useState, useEffect, useCallback } from 'react';
import { View, Pressable, Switch, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { customerService } from '@tricigo/api';
import type { RidePreferences } from '@tricigo/types';
import { useAuthStore } from '@/stores/auth.store';
import { useRideStore } from '@/stores/ride.store';

type TemperaturePref = 'cool' | 'warm' | 'no_preference';

const TEMP_OPTIONS: { value: TemperaturePref; labelKey: string; icon: string }[] = [
  { value: 'cool', labelKey: 'preferences.temp_cool', icon: 'snow-outline' },
  { value: 'warm', labelKey: 'preferences.temp_warm', icon: 'sunny-outline' },
  { value: 'no_preference', labelKey: 'preferences.temp_no_preference', icon: 'remove-outline' },
];

export default function RidePreferencesScreen() {
  const { t } = useTranslation('common');
  const userId = useAuthStore((s) => s.user?.id);
  const setRidePreferences = useRideStore((s) => s.setRidePreferences);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<RidePreferences>({});

  useEffect(() => {
    if (!userId) return;
    customerService.ensureProfile(userId).then((profile) => {
      setProfileId(profile.id);
      setPrefs(profile.ride_preferences ?? {});
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [userId]);

  const savePrefs = useCallback(async (updated: RidePreferences) => {
    setPrefs(updated);
    setRidePreferences(updated);
    if (!profileId) return;
    setSaving(true);
    try {
      await customerService.updateProfile(profileId, { ride_preferences: updated });
    } catch {
      // best-effort save
    } finally {
      setSaving(false);
    }
  }, [profileId, setRidePreferences]);

  const toggleQuietMode = useCallback(() => {
    savePrefs({ ...prefs, quiet_mode: !prefs.quiet_mode });
  }, [prefs, savePrefs]);

  const toggleConversation = useCallback(() => {
    savePrefs({ ...prefs, conversation_ok: !prefs.conversation_ok });
  }, [prefs, savePrefs]);

  const toggleLuggage = useCallback(() => {
    savePrefs({ ...prefs, luggage_trunk: !prefs.luggage_trunk });
  }, [prefs, savePrefs]);

  const setTemperature = useCallback((temp: TemperaturePref) => {
    savePrefs({ ...prefs, temperature: temp });
  }, [prefs, savePrefs]);

  if (loading) {
    return (
      <Screen>
        <ScreenHeader title={t('preferences.title')} onBack={() => router.back()} />
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={colors.primary[500]} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenHeader
        title={t('preferences.title')}
        onBack={() => router.back()}
        rightElement={saving ? <ActivityIndicator size="small" color={colors.primary[500]} /> : undefined}
      />

      <View className="flex-1 px-4 pt-4 gap-4">
        {/* Quiet Mode */}
        <Card>
          <View className="flex-row items-center justify-between py-1">
            <View className="flex-row items-center gap-3 flex-1">
              <Ionicons name="volume-mute-outline" size={22} color={colors.neutral[600]} />
              <View className="flex-1">
                <Text className="text-base font-medium text-neutral-900">
                  {t('preferences.quiet_mode')}
                </Text>
                <Text className="text-sm text-neutral-500 mt-0.5">
                  {t('preferences.quiet_mode_desc')}
                </Text>
              </View>
            </View>
            <Switch
              value={!!prefs.quiet_mode}
              onValueChange={toggleQuietMode}
              trackColor={{ false: colors.neutral[200], true: colors.primary[500] }}
            />
          </View>
        </Card>

        {/* Temperature */}
        <Card>
          <View className="gap-3">
            <View className="flex-row items-center gap-3">
              <Ionicons name="thermometer-outline" size={22} color={colors.neutral[600]} />
              <Text className="text-base font-medium text-neutral-900">
                {t('preferences.temperature')}
              </Text>
            </View>
            <View className="flex-row gap-2">
              {TEMP_OPTIONS.map((opt) => {
                const selected = (prefs.temperature ?? 'no_preference') === opt.value;
                return (
                  <Pressable
                    key={opt.value}
                    onPress={() => setTemperature(opt.value)}
                    className={`flex-1 flex-row items-center justify-center gap-1.5 py-2.5 rounded-xl border ${
                      selected
                        ? 'bg-primary-50 border-primary-500'
                        : 'bg-white border-neutral-200'
                    }`}
                  >
                    <Ionicons
                      name={opt.icon as any}
                      size={16}
                      color={selected ? colors.primary[500] : colors.neutral[400]}
                    />
                    <Text
                      className={`text-sm font-medium ${
                        selected ? 'text-primary-600' : 'text-neutral-600'
                      }`}
                    >
                      {t(opt.labelKey)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </Card>

        {/* Conversation OK */}
        <Card>
          <View className="flex-row items-center justify-between py-1">
            <View className="flex-row items-center gap-3 flex-1">
              <Ionicons name="chatbubbles-outline" size={22} color={colors.neutral[600]} />
              <View className="flex-1">
                <Text className="text-base font-medium text-neutral-900">
                  {t('preferences.conversation_ok')}
                </Text>
                <Text className="text-sm text-neutral-500 mt-0.5">
                  {t('preferences.conversation_ok_desc')}
                </Text>
              </View>
            </View>
            <Switch
              value={!!prefs.conversation_ok}
              onValueChange={toggleConversation}
              trackColor={{ false: colors.neutral[200], true: colors.primary[500] }}
            />
          </View>
        </Card>

        {/* Luggage / Trunk */}
        <Card>
          <View className="flex-row items-center justify-between py-1">
            <View className="flex-row items-center gap-3 flex-1">
              <Ionicons name="briefcase-outline" size={22} color={colors.neutral[600]} />
              <View className="flex-1">
                <Text className="text-base font-medium text-neutral-900">
                  {t('preferences.luggage_trunk')}
                </Text>
                <Text className="text-sm text-neutral-500 mt-0.5">
                  {t('preferences.luggage_trunk_desc')}
                </Text>
              </View>
            </View>
            <Switch
              value={!!prefs.luggage_trunk}
              onValueChange={toggleLuggage}
              trackColor={{ false: colors.neutral[200], true: colors.primary[500] }}
            />
          </View>
        </Card>
      </View>
    </Screen>
  );
}
