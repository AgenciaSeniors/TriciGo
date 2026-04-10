import React, { useState, useEffect } from 'react';
import { View, Pressable, TextInput, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { driverService } from '@tricigo/api';
import { formatCUP, validateDriverRate } from '@tricigo/utils';
import { useDriverStore } from '@/stores/driver.store';

export default function DriverPricingScreen() {
  const { t } = useTranslation('driver');
  const driverProfile = useDriverStore((s) => s.profile);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [currentRate, setCurrentRate] = useState<number | null>(null);
  const [defaultRate, setDefaultRate] = useState(100);
  const [maxMultiplier, setMaxMultiplier] = useState(2.0);
  const [exchangeRate, setExchangeRate] = useState(1);
  const [inputValue, setInputValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!driverProfile?.id) return;

    driverService.getCustomRateConfig(driverProfile.id)
      .then((config) => {
        setCurrentRate(config.currentRate);
        setDefaultRate(config.defaultRate);
        setMaxMultiplier(config.maxMultiplier);
        setExchangeRate(config.exchangeRate ?? 1);
        setInputValue(
          config.currentRate != null
            ? String(config.currentRate)
            : String(config.defaultRate),
        );
      })
      .catch(() => setError(t('pricing.error_loading')))
      .finally(() => setLoading(false));
  }, [driverProfile?.id, t]);

  const maxRate = Math.round(defaultRate * maxMultiplier);
  const activeRate = currentRate ?? defaultRate;
  const isCustom = currentRate !== null;

  async function handleSave() {
    if (!driverProfile?.id) return;
    setError(null);
    setSaved(false);

    const numValue = parseInt(inputValue, 10);
    if (isNaN(numValue) || numValue <= 0) {
      setError(t('pricing.error_invalid'));
      return;
    }

    const validation = validateDriverRate(numValue, defaultRate, maxMultiplier);
    if (!validation.valid) {
      setError(
        validation.error === 'below_minimum'
          ? t('pricing.error_below_min', { min: formatCUP(defaultRate) })
          : t('pricing.error_above_max', { max: formatCUP(maxRate) }),
      );
      return;
    }

    setSaving(true);
    try {
      await driverService.updateCustomRate(driverProfile.id, numValue);
      setCurrentRate(numValue);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(t('pricing.error_saving'));
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (!driverProfile?.id) return;
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      await driverService.updateCustomRate(driverProfile.id, null);
      setCurrentRate(null);
      setInputValue(String(defaultRate));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      setError(t('pricing.error_saving'));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Screen scroll bg="lightPrimary" statusBarStyle="dark-content" padded>
        <View className="flex-1 items-center justify-center pt-20">
          <ActivityIndicator size="large" color={colors.brand.orange} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll bg="lightPrimary" statusBarStyle="dark-content" padded>
      <View className="pt-4">
        {/* Header */}
        <View className="flex-row items-center mb-6">
          <Pressable onPress={() => router.back()} className="mr-3">
            <Ionicons name="arrow-back" size={24} color="#0F172A" />
          </Pressable>
          <Text variant="h3" color="primary">{t('pricing.title')}</Text>
        </View>

        {/* Explanation */}
        <Card theme="light" variant="filled" padding="md" className="mb-4 bg-white">
          <Text variant="body" color="primary" className="opacity-70 mb-2">
            {t('pricing.explanation')}
          </Text>
          <View className="flex-row justify-between mb-1">
            <Text variant="bodySmall" color="primary" className="opacity-50">
              {t('pricing.default_rate')}
            </Text>
            <Text variant="bodySmall" color="accent">
              {formatCUP(defaultRate)}/km
            </Text>
          </View>
          <View className="flex-row justify-between mb-1">
            <Text variant="bodySmall" color="primary" className="opacity-50">
              {t('pricing.max_rate')}
            </Text>
            <Text variant="bodySmall" color="accent">
              {formatCUP(maxRate)}/km ({maxMultiplier}x)
            </Text>
          </View>
          <View className="flex-row justify-between">
            <Text variant="bodySmall" color="primary" className="opacity-50">
              1 USD = {exchangeRate} CUP
            </Text>
          </View>
        </Card>

        {/* Current rate display */}
        <Card theme="light" variant="filled" padding="md" className="mb-4 bg-white">
          <Text variant="bodySmall" color="primary" className="opacity-50 mb-1">
            {t('pricing.current_rate')}
          </Text>
          <View className="flex-row items-baseline gap-2">
            <Text variant="h2" color="accent">
              {formatCUP(activeRate)}
            </Text>
            <Text variant="bodySmall" color="primary" className="opacity-40">
              /km (~{(activeRate / exchangeRate).toFixed(2)} TRC/km)
            </Text>
          </View>
          {isCustom && (
            <View className="mt-2 bg-primary-900/30 px-3 py-1 rounded-full self-start">
              <Text variant="caption" color="accent">
                {t('pricing.custom_label')}
              </Text>
            </View>
          )}
        </Card>

        {/* Rate input */}
        <Card theme="light" variant="filled" padding="md" className="mb-4 bg-white">
          <Text variant="bodySmall" color="primary" className="opacity-50 mb-2">
            {t('pricing.set_rate')}
          </Text>
          <View className="flex-row items-center gap-3">
            <TextInput
              value={inputValue}
              onChangeText={setInputValue}
              keyboardType="number-pad"
              placeholder={String(defaultRate)}
              placeholderTextColor="#94A3B8"
              style={{
                flex: 1,
                backgroundColor: '#F8FAFC',
                color: '#0F172A',
                borderRadius: 12,
                paddingHorizontal: 16,
                paddingVertical: 14,
                fontSize: 18,
                fontWeight: '700',
                borderWidth: 1,
                borderColor: error ? '#ef4444' : '#E2E8F0',
              }}
            />
            <Text variant="body" color="primary" className="opacity-50">
              CUP/km
            </Text>
          </View>

          {error && (
            <Text variant="caption" className="text-red-400 mt-2">
              {error}
            </Text>
          )}

          {saved && (
            <View className="flex-row items-center gap-1 mt-2">
              <Ionicons name="checkmark-circle" size={16} color="#22c55e" />
              <Text variant="caption" className="text-green-400">
                {t('pricing.saved')}
              </Text>
            </View>
          )}
        </Card>

        {/* Action buttons */}
        <Button
          title={saving ? t('pricing.saving') : t('pricing.save')}
          size="lg"
          fullWidth
          onPress={handleSave}
          disabled={saving}
          className="mb-3"
        />

        {isCustom && (
          <Button
            title={t('pricing.reset_default')}
            variant="outline"
            size="lg"
            fullWidth
            onPress={handleReset}
            disabled={saving}
          />
        )}
      </View>
    </Screen>
  );
}
