// ============================================================
// TriciGo — SubmitPoiSheet
//
// Shared UI for crowdsourced POI submissions (PR 3 of POI parity).
// Drivers and clients tap a floating "+" button → this sheet opens with
// the current map center (or GPS) as the marker location. User types a
// name, picks a category from the 9 visual groups, taps "Enviar". The
// submission goes to cuba_pois_submissions; admin approves later via the
// admin panel.
//
// MVP scope (this iteration):
//   - Name + category picker (no photo upload, no address autocomplete)
//   - Coords passed in as props (consumer reads from map state)
//   - Rate-limit / "outside Cuba" / "near existing" error handling
//
// Deferred:
//   - Photo upload (needs storage bucket setup)
//   - Address auto-detect (reverse geocode)
//   - Duplicate "is it the same as X" sheet
// ============================================================

import React, { useState } from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet } from './BottomSheet';
import { Button } from './Button';
import { Input } from './Input';
import { useSubmitPoi } from './useSubmitPoi';
import { POI_VISUAL_GROUPS } from '@tricigo/utils';

interface SupabaseLike {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>;
}

export interface SubmitPoiSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Coords of the location being submitted — usually map center or GPS. */
  lat: number;
  lng: number;
  /** Pre-filled address if reverse-geocoded by parent. Optional. */
  address?: string | null;
  /** Supabase client — passed by consumer to keep this component agnostic. */
  supabase: SupabaseLike;
  /** Called on successful submission (parent shows toast / clears state). */
  onSubmitted?: (result: { submissionId: string; nearbyExistingCount: number }) => void;
  /** Optional override of localized strings (defaults to Spanish). */
  i18n?: {
    title?: string;
    nameLabel?: string;
    namePlaceholder?: string;
    categoryLabel?: string;
    submitButton?: string;
    cancelButton?: string;
    locationLabel?: string;
    nearbyExistingHint?: (count: number) => string;
    error_unauthenticated?: string;
    error_invalid_name?: string;
    error_invalid_category?: string;
    error_outside_cuba?: string;
    error_rate_limit_hour?: string;
    error_rate_limit_day?: string;
    error_unknown?: string;
    success?: string;
  };
}

// Map of POI_VISUAL_GROUPS keys to a representative tricigo_category value.
// The 9 visual groups are coarse — when the user picks "food" we default to
// 'restaurant'. They could refine if needed in a follow-up PR with a
// subcategory step. For MVP this is fine.
const GROUP_TO_DEFAULT_CATEGORY: Record<string, string> = {
  food: 'restaurant',
  lodging: 'hotel',
  shopping: 'shop',
  health: 'hospital',
  finance: 'bank',
  civic: 'gov',
  culture: 'museum',
  transport: 'transport',
  other: 'other',
};

const DEFAULT_I18N: Required<Omit<SubmitPoiSheetProps['i18n'] & object, 'nearbyExistingHint'>> & {
  nearbyExistingHint: (count: number) => string;
} = {
  title: 'Sugerir lugar',
  nameLabel: 'Nombre del lugar',
  namePlaceholder: 'Ej: Paladar La Guarida',
  categoryLabel: 'Categoría',
  submitButton: 'Enviar',
  cancelButton: 'Cancelar',
  locationLabel: 'Ubicación',
  nearbyExistingHint: (count: number) =>
    count > 0
      ? `⚠ Hay ${count} lugar${count > 1 ? 'es' : ''} cercano${count > 1 ? 's' : ''} ya registrado${count > 1 ? 's' : ''}. ¿Es uno de ellos?`
      : '',
  error_unauthenticated: 'Necesitás iniciar sesión.',
  error_invalid_name: 'El nombre es requerido.',
  error_invalid_category: 'Elegí una categoría.',
  error_outside_cuba: 'Solo aceptamos lugares en Cuba.',
  error_rate_limit_hour: 'Esperá un rato — ya enviaste varios. Volvé en una hora.',
  error_rate_limit_day: 'Llegaste al máximo diario. Volvé mañana.',
  error_unknown: 'Algo salió mal. Probá de nuevo.',
  success: '¡Gracias! Tu sugerencia está siendo revisada.',
};

export function SubmitPoiSheet({
  visible,
  onClose,
  lat,
  lng,
  address,
  supabase,
  onSubmitted,
  i18n,
}: SubmitPoiSheetProps) {
  const [name, setName] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { submit, isSubmitting } = useSubmitPoi(supabase);
  const labels = { ...DEFAULT_I18N, ...i18n };

  const handleSubmit = async () => {
    setErrorMsg(null);
    if (!name.trim()) {
      setErrorMsg(labels.error_invalid_name);
      return;
    }
    if (!selectedGroup) {
      setErrorMsg(labels.error_invalid_category);
      return;
    }
    const tricigoCategory = GROUP_TO_DEFAULT_CATEGORY[selectedGroup] ?? 'other';

    const result = await submit({
      name: name.trim(),
      tricigoCategory,
      lat,
      lng,
      address,
    });

    if (result.ok) {
      onSubmitted?.({
        submissionId: result.submissionId ?? '',
        nearbyExistingCount: result.nearbyExistingCount ?? 0,
      });
      // Reset and close
      setName('');
      setSelectedGroup(null);
      onClose();
      return;
    }

    // Surface the error in a user-friendly way
    switch (result.error) {
      case 'unauthenticated':
        setErrorMsg(labels.error_unauthenticated);
        break;
      case 'invalid_name':
        setErrorMsg(labels.error_invalid_name);
        break;
      case 'invalid_category':
        setErrorMsg(labels.error_invalid_category);
        break;
      case 'outside_cuba':
        setErrorMsg(labels.error_outside_cuba);
        break;
      case 'rate_limit_hour':
        setErrorMsg(labels.error_rate_limit_hour);
        break;
      case 'rate_limit_day':
        setErrorMsg(labels.error_rate_limit_day);
        break;
      default:
        setErrorMsg(labels.error_unknown);
    }
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Text className="text-xl font-bold mb-4 text-neutral-900 dark:text-white">
          {labels.title}
        </Text>

        {/* Location indicator (read-only) */}
        <View className="flex-row items-center mb-4 p-3 bg-neutral-100 dark:bg-neutral-800 rounded-xl">
          <Ionicons name="location" size={18} color="#FF4D00" />
          <Text className="ml-2 text-xs text-neutral-700 dark:text-neutral-300 flex-1" numberOfLines={2}>
            {address ?? `${lat.toFixed(5)}, ${lng.toFixed(5)}`}
          </Text>
        </View>

        <Input
          label={labels.nameLabel}
          placeholder={labels.namePlaceholder}
          value={name}
          onChangeText={setName}
          maxLength={200}
          autoCapitalize="words"
        />

        <Text className="text-sm font-semibold mb-2 text-neutral-700 dark:text-neutral-300">
          {labels.categoryLabel}
        </Text>
        <View className="flex-row flex-wrap mb-4 -mx-1">
          {POI_VISUAL_GROUPS.map((group) => {
            const isSelected = selectedGroup === group.key;
            return (
              <Pressable
                key={group.key}
                onPress={() => setSelectedGroup(group.key)}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
                className={`flex-row items-center px-3 py-2 m-1 rounded-full border-2 ${
                  isSelected ? 'border-primary-500' : 'border-neutral-200 dark:border-neutral-700'
                }`}
                style={{
                  backgroundColor: isSelected ? group.color : 'transparent',
                }}
              >
                <Ionicons
                  name={group.icon as keyof typeof Ionicons.glyphMap}
                  size={16}
                  color={isSelected ? '#fff' : group.color}
                />
                <Text
                  className={`ml-1.5 text-sm font-medium ${
                    isSelected ? 'text-white' : 'text-neutral-700 dark:text-neutral-300'
                  }`}
                >
                  {group.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {errorMsg && (
          <Text className="text-sm text-red-600 dark:text-red-400 mb-3">
            {errorMsg}
          </Text>
        )}

        <View className="flex-row mt-2">
          <View className="flex-1 mr-2">
            <Button
              title={labels.cancelButton}
              variant="outline"
              onPress={onClose}
              disabled={isSubmitting}
              fullWidth
            />
          </View>
          <View className="flex-1 ml-2">
            <Button
              title={labels.submitButton}
              variant="primary"
              onPress={handleSubmit}
              loading={isSubmitting}
              disabled={isSubmitting || !name.trim() || !selectedGroup}
              fullWidth
            />
          </View>
        </View>
      </ScrollView>
    </BottomSheet>
  );
}
