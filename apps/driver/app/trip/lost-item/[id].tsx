import React, { useEffect, useState } from 'react';
import { View, TextInput, ActivityIndicator, Alert } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { lostItemService } from '@tricigo/api';
import { useDriverStore } from '@/stores/driver.store';
import { useAuthStore } from '@/stores/auth.store';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@tricigo/theme';
import { formatCUP } from '@tricigo/utils';
import type { LostItem } from '@tricigo/types';

const CATEGORY_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  phone: 'phone-portrait-outline',
  wallet: 'wallet-outline',
  bag: 'bag-handle-outline',
  clothing: 'shirt-outline',
  electronics: 'laptop-outline',
  documents: 'document-text-outline',
  keys: 'key-outline',
  other: 'help-circle-outline',
};

export default function DriverLostItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation('driver');
  const user = useAuthStore((s) => s.user);

  const [item, setItem] = useState<LostItem | null>(null);
  const [loading, setLoading] = useState(true);

  // Response form
  const [response, setResponse] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Return arrangement form
  const [returnFee, setReturnFee] = useState('');
  const [returnLocation, setReturnLocation] = useState('');
  const [returnNotes, setReturnNotes] = useState('');

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function load() {
      try {
        const data = await lostItemService.getLostItemByRide(id);
        if (!cancelled) setItem(data);
      } catch (err) {
        console.error('Error loading lost item:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [id]);

  const handleRespond = async (found: boolean) => {
    if (!item || !user?.id) return;
    setSubmitting(true);
    try {
      const updated = await lostItemService.driverRespond(
        item.id,
        user.id,
        found,
        response.trim() || undefined,
      );
      setItem(updated);
    } catch (err: any) {
      Alert.alert(t('common.error'), err?.message ?? 'Error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleArrangeReturn = async () => {
    if (!item) return;
    setSubmitting(true);
    try {
      const updated = await lostItemService.arrangeReturn(item.id, {
        return_fee_cup: returnFee ? parseInt(returnFee, 10) : undefined,
        return_location: returnLocation.trim() || undefined,
        return_notes: returnNotes.trim() || undefined,
      });
      setItem(updated);
    } catch (err: any) {
      Alert.alert(t('common.error'), err?.message ?? 'Error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleMarkReturned = async () => {
    if (!item || !user?.id) return;
    setSubmitting(true);
    try {
      const updated = await lostItemService.markReturned(item.id, user.id);
      setItem(updated);
    } catch (err: any) {
      Alert.alert(t('common.error'), err?.message ?? 'Error');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Screen bg="lightPrimary" statusBarStyle="dark-content" padded>
        <View className="flex-1 items-center justify-center py-20">
          <ActivityIndicator size="large" color={colors.brand.orange} />
        </View>
      </Screen>
    );
  }

  if (!item) {
    return (
      <Screen bg="lightPrimary" statusBarStyle="dark-content" padded>
        <View className="pt-4">
          <ScreenHeader title="" onBack={() => router.back()} />
          <Text variant="body" color="primary" className="opacity-50">
            {t('lost_found.no_items')}
          </Text>
        </View>
      </Screen>
    );
  }

  const hasResponded = item.driver_found !== null;
  const isFound = item.driver_found === true;
  const canArrangeReturn = isFound && item.status === 'found';
  const canMarkReturned = item.status === 'return_arranged';
  const isResolved = item.status === 'returned' || item.status === 'closed';

  return (
    <Screen scroll bg="lightPrimary" statusBarStyle="dark-content" padded>
      <View className="pt-4 pb-8">
        <ScreenHeader
          title={t('lost_found.title')}
          onBack={() => router.back()}
        />

        {/* Item info */}
        <Card theme="light" variant="filled" padding="md" className="bg-white mb-4">
          <View className="flex-row items-center mb-3">
            <View className="w-10 h-10 rounded-full bg-amber-100 items-center justify-center mr-3">
              <Ionicons
                name={CATEGORY_ICONS[item.category] ?? 'help-circle-outline'}
                size={20}
                color={colors.warning.DEFAULT}
              />
            </View>
            <View className="flex-1">
              <Text variant="label" color="primary">{t(`lost_found.item_category`)}</Text>
              <Text variant="bodySmall" color="primary" className="opacity-70">
                {t(`lost_found.status_${item.status}`)}
              </Text>
            </View>
          </View>

          <Text variant="caption" color="primary" className="opacity-50 mb-1">
            {t('lost_found.item_description')}
          </Text>
          <Text variant="body" color="primary">{item.description}</Text>
        </Card>

        {/* Driver response section (not yet responded) */}
        {!hasResponded && (
          <Card theme="light" variant="filled" padding="md" className="bg-white mb-4">
            <Text variant="label" color="primary" className="mb-3">
              {t('lost_found.respond')}
            </Text>

            <TextInput
              className="border border-[#E2E8F0] rounded-xl px-4 py-3 text-base min-h-[80px] mb-4 text-neutral-900 bg-white"
              placeholder={t('lost_found.response_placeholder')}
              placeholderTextColor="#666"
              value={response}
              onChangeText={setResponse}
              multiline
              textAlignVertical="top"
            />

            <View className="flex-row gap-3">
              <View className="flex-1">
                <Button
                  title={t('lost_found.found_item')}
                  variant="primary"
                  size="md"
                  fullWidth
                  onPress={() => handleRespond(true)}
                  disabled={submitting}
                />
              </View>
              <View className="flex-1">
                <Button
                  title={t('lost_found.not_found_item')}
                  variant="outline"
                  size="md"
                  fullWidth
                  onPress={() => handleRespond(false)}
                  disabled={submitting}
                />
              </View>
            </View>
          </Card>
        )}

        {/* Arrange return (item found, not yet arranged) */}
        {canArrangeReturn && (
          <Card theme="light" variant="filled" padding="md" className="bg-white mb-4">
            <Text variant="label" color="primary" className="mb-3">
              {t('lost_found.arrange_return')}
            </Text>

            <Text variant="caption" color="primary" className="opacity-50 mb-1">
              {t('lost_found.return_fee_label')}
            </Text>
            <TextInput
              className="border border-[#E2E8F0] rounded-xl px-4 py-3 text-base mb-3 text-neutral-900 bg-white"
              placeholder="0"
              placeholderTextColor="#666"
              value={returnFee}
              onChangeText={setReturnFee}
              keyboardType="numeric"
            />

            <Text variant="caption" color="primary" className="opacity-50 mb-1">
              {t('lost_found.return_location_label')}
            </Text>
            <TextInput
              className="border border-[#E2E8F0] rounded-xl px-4 py-3 text-base mb-3 text-neutral-900 bg-white"
              placeholder={t('lost_found.return_location_label')}
              placeholderTextColor="#666"
              value={returnLocation}
              onChangeText={setReturnLocation}
            />

            <Text variant="caption" color="primary" className="opacity-50 mb-1">
              {t('lost_found.return_notes_label')}
            </Text>
            <TextInput
              className="border border-[#E2E8F0] rounded-xl px-4 py-3 text-base min-h-[60px] mb-4 text-neutral-900 bg-white"
              placeholder={t('lost_found.return_notes_label')}
              placeholderTextColor="#666"
              value={returnNotes}
              onChangeText={setReturnNotes}
              multiline
              textAlignVertical="top"
            />

            <Button
              title={t('lost_found.arrange_return')}
              variant="primary"
              size="lg"
              fullWidth
              onPress={handleArrangeReturn}
              disabled={submitting}
            />
          </Card>
        )}

        {/* Mark returned button */}
        {canMarkReturned && (
          <Card theme="light" variant="filled" padding="md" className="bg-white mb-4">
            {item.return_location && (
              <View className="mb-3">
                <Text variant="caption" color="primary" className="opacity-50">
                  {t('lost_found.return_location_label')}
                </Text>
                <Text variant="body" color="primary">{item.return_location}</Text>
              </View>
            )}
            {item.return_fee_cup != null && item.return_fee_cup > 0 && (
              <View className="mb-3">
                <Text variant="caption" color="primary" className="opacity-50">
                  {t('lost_found.return_fee_label')}
                </Text>
                <Text variant="body" color="accent">{formatCUP(item.return_fee_cup)}</Text>
              </View>
            )}
            <Button
              title={t('lost_found.mark_returned')}
              variant="primary"
              size="lg"
              fullWidth
              onPress={handleMarkReturned}
              disabled={submitting}
            />
          </Card>
        )}

        {/* Resolved status */}
        {isResolved && (
          <Card theme="light" variant="filled" padding="md" className="bg-green-50 border border-green-200 mb-4">
            <Text variant="body" color="primary" className="font-semibold">
              ✓ {t(`lost_found.status_${item.status}`)}
            </Text>
          </Card>
        )}
      </View>
    </Screen>
  );
}
