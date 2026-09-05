import React, { useEffect, useState } from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { ADDRESS_NOTES_MAX, trimNotes, triggerHaptic } from '@tricigo/utils';

interface AddressDetailsSheetProps {
  visible: boolean;
  target: 'pickup' | 'dropoff';
  /** The address the note belongs to — shown so the rider knows which end they are describing. */
  address: string;
  value?: string | null;
  onSave: (notes: string | null) => void;
  onClose: () => void;
}

/** Words riders reach for; tapping one appends it so the note is mostly taps. */
const QUICK_WORDS = ['Apto', 'Edificio', 'Timbre', 'Portón', 'Frente a', 'Al lado de'] as const;

/**
 * One free-text field per endpoint: number, apartment, landmark, how to get
 * in — everything the Cuban address structure carries and the geocoder's
 * string does not. Stored on the ride (00578) and shown to the driver while
 * heading to that endpoint; never in the offer push.
 */
export function AddressDetailsSheet({ visible, target, address, value, onSave, onClose }: AddressDetailsSheetProps) {
  const { t } = useTranslation('rider');
  const [text, setText] = useState(value ?? '');
  useEffect(() => {
    if (visible) setText(value ?? '');
  }, [visible, value]);

  const appendWord = (word: string) => {
    void triggerHaptic('light');
    setText((prev) => {
      const base = prev.trimEnd();
      const next = base ? `${base} ${word} ` : `${word} `;
      return next.length > ADDRESS_NOTES_MAX ? prev : next;
    });
  };

  const handleSave = () => {
    void triggerHaptic('light');
    onSave(trimNotes(text));
    onClose();
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text variant="h4" className="mb-1">
        {target === 'pickup'
          ? t('ride.details_title_pickup', { defaultValue: 'Detalles de la recogida' })
          : t('ride.details_title_dropoff', { defaultValue: 'Detalles del destino' })}
      </Text>
      <View className="flex-row items-center mb-3">
        <Ionicons name="location-outline" size={14} color={colors.neutral[500]} />
        <Text variant="caption" color="secondary" numberOfLines={2} className="ml-1 flex-1">
          {address}
        </Text>
      </View>
      <Input
        multiline
        numberOfLines={3}
        maxLength={ADDRESS_NOTES_MAX}
        value={text}
        onChangeText={setText}
        placeholder={t('ride.details_placeholder', { defaultValue: 'Ej: #302 apto 4, edificio azul, tocar el timbre' })}
        hint={t('ride.details_hint', { defaultValue: 'El conductor lo verá al ir hacia este punto' })}
        style={{ minHeight: 84, textAlignVertical: 'top' }}
        autoFocus
      />
      <Text variant="caption" color="tertiary" className="text-right mt-1">
        {text.length}/{ADDRESS_NOTES_MAX}
      </Text>
      <View className="flex-row flex-wrap gap-2 mt-2">
        {QUICK_WORDS.map((word) => (
          <Pressable
            key={word}
            onPress={() => appendWord(word)}
            accessibilityRole="button"
            className="px-3 py-1.5 rounded-full bg-neutral-100 dark:bg-neutral-800"
          >
            <Text variant="caption" color="primary">{word}</Text>
          </Pressable>
        ))}
      </View>
      <View className="flex-row gap-3 mt-4">
        <View className="flex-1">
          <Button title={t('common:cancel', { defaultValue: 'Cancelar' })} variant="outline" size="lg" fullWidth onPress={onClose} />
        </View>
        <View className="flex-1">
          <Button title={t('common:save', { defaultValue: 'Guardar' })} variant="primary" size="lg" fullWidth onPress={handleSave} />
        </View>
      </View>
    </BottomSheet>
  );
}
