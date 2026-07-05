/**
 * AddContactSheet (driver) — parity port of the rider's
 * `apps/client/src/components/AddContactSheet.tsx`.
 *
 * Same backing service (`trustedContactService.addContact`) and same
 * validation (`isValidCubanPhone`, MAX_CONTACTS=5 cap, duplicate-phone
 * detection via Postgres 23505). Themed with Midnight Ember tokens to
 * match the driver's screen palette.
 *
 * Closes the parity gap where the driver's trusted-contacts screen
 * had the "Agregar" CTA wired to a "Próximamente" toast.
 */
import React, { useState } from 'react';
import { View, Switch, Alert } from 'react-native';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber } from '@tricigo/theme';
import { trustedContactService } from '@tricigo/api';
import { isValidCubanPhone, normalizeCubanPhone, triggerHaptic } from '@tricigo/utils';
import Toast from 'react-native-toast-message';

interface AddContactSheetProps {
  visible: boolean;
  onClose: () => void;
  userId: string;
  onAdded: () => void;
}

export function AddContactSheet({ visible, onClose, userId, onAdded }: AddContactSheetProps) {
  const { t } = useTranslation('common');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [relationship, setRelationship] = useState('');
  const [autoShare, setAutoShare] = useState(true);
  const [isEmergency, setIsEmergency] = useState(false);
  const [saving, setSaving] = useState(false);

  const resetForm = () => {
    setName('');
    setPhone('');
    setRelationship('');
    setAutoShare(true);
    setIsEmergency(false);
  };

  const handleSave = async () => {
    if (!name.trim() || !phone.trim()) return;
    if (!isValidCubanPhone(phone)) {
      Alert.alert(t('error'), t('errors.invalid_phone'));
      return;
    }
    setSaving(true);
    try {
      await trustedContactService.addContact({
        user_id: userId,
        name: name.trim(),
        // E.164 (+53...) — D7 can't deliver raw local 8-digit numbers.
        phone: normalizeCubanPhone(phone.trim()),
        relationship: relationship.trim(),
        auto_share: autoShare,
        is_emergency: isEmergency,
      });
      resetForm();
      Toast.show({
        type: 'success',
        text1: t('trusted_contacts.contact_added', { defaultValue: 'Contacto agregado' }),
      });
      triggerHaptic('success');
      onAdded();
      onClose();
    } catch (err: unknown) {
      const errObj = err as Record<string, unknown> | null;
      if (errObj?.code === 'MAX_CONTACTS') {
        Alert.alert(
          t('trusted_contacts.max_contacts'),
          t('trusted_contacts.max_reached'),
        );
      } else if (errObj?.code === '23505') {
        Alert.alert(t('error'), t('trusted_contacts.duplicate_phone'));
      } else {
        Alert.alert(t('error'), t('errors.contacts_load_failed'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text variant="h4" className="mb-4">
        {t('trusted_contacts.add_contact')}
      </Text>

      <Input
        label={t('trusted_contacts.name')}
        value={name}
        onChangeText={setName}
        placeholder="Juan Pérez"
      />
      <Input
        label={t('trusted_contacts.phone')}
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        placeholder="+53 5XXXXXXX o 6XXXXXXX"
      />
      <Input
        label={t('trusted_contacts.relationship')}
        value={relationship}
        onChangeText={setRelationship}
        placeholder="Familiar, Amigo..."
      />

      <View className="flex-row items-center justify-between py-3">
        <View className="flex-1 mr-3">
          <Text variant="body">{t('trusted_contacts.auto_share')}</Text>
          <Text variant="caption" color="secondary">
            {t('trusted_contacts.auto_share_desc_driver')}
          </Text>
        </View>
        <Switch
          value={autoShare}
          onValueChange={setAutoShare}
          trackColor={{
            true: midnightEmber.accent[500],
            false: midnightEmber.screen.line.default,
          }}
        />
      </View>

      <View className="flex-row items-center justify-between py-3 mb-4">
        <View className="flex-1 mr-3">
          <Text variant="body">{t('trusted_contacts.is_emergency')}</Text>
          <Text variant="caption" color="secondary">
            {t('trusted_contacts.emergency_desc')}
          </Text>
        </View>
        <Switch
          value={isEmergency}
          onValueChange={setIsEmergency}
          trackColor={{
            true: midnightEmber.accent[500],
            false: midnightEmber.screen.line.default,
          }}
        />
      </View>

      <Button
        title={t('save')}
        onPress={handleSave}
        loading={saving}
        fullWidth
        size="lg"
        disabled={!name.trim() || !phone.trim()}
      />
    </BottomSheet>
  );
}
