import React, { useState, useEffect, useCallback } from 'react';
import { View, Pressable } from 'react-native';
import Toast from 'react-native-toast-message';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { customerService, trustedContactService } from '@tricigo/api';
import { isValidCubanPhone, getErrorMessage } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { ErrorState } from '@tricigo/ui/ErrorState';
import { SkeletonCard } from '@tricigo/ui/Skeleton';
import type { CustomerProfile, TrustedContact } from '@tricigo/types';

export default function EmergencyContactScreen() {
  const { t } = useTranslation('common');
  const user = useAuthStore((s) => s.user);
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [existingContact, setExistingContact] = useState<TrustedContact | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [relationship, setRelationship] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(() => {
    if (!user) return;
    setLoading(true);

    // Load from customer_profiles (backward compat)
    customerService.ensureProfile(user.id).then((cp) => {
      setProfile(cp);
      if (cp.emergency_contact) {
        setName(cp.emergency_contact.name);
        setPhone(cp.emergency_contact.phone);
        setRelationship(cp.emergency_contact.relationship);
      }
    }).catch((err) => setError(getErrorMessage(err))).finally(() => setLoading(false));

    // Also check trusted_contacts for existing emergency contact
    trustedContactService.getContacts(user.id).then((contacts) => {
      const emergency = contacts.find((c) => c.is_emergency);
      if (emergency) {
        setExistingContact(emergency);
        // Prefer trusted_contacts data if available
        setName(emergency.name);
        setPhone(emergency.phone);
        setRelationship(emergency.relationship);
      }
    }).catch(() => {});
  }, [user]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSave = async () => {
    if (!profile || !user) return;
    if (!name.trim() || name.trim().length < 2) {
      Toast.show({ type: 'error', text1: t('emergency.name_required', { defaultValue: 'Ingresa el nombre del contacto' }) });
      return;
    }
    if (!isValidCubanPhone(phone.trim())) {
      Toast.show({ type: 'error', text1: t('emergency.invalid_phone', { defaultValue: 'Ingresa un número de teléfono cubano válido' }) });
      return;
    }
    setSaving(true);
    try {
      // 1. Update customer_profiles JSONB (backward compat)
      await customerService.updateProfile(profile.id, {
        emergency_contact: {
          name: name.trim(),
          phone: phone.trim(),
          relationship: relationship.trim(),
        },
      });

      // 2. Upsert in trusted_contacts with is_emergency=true
      if (existingContact) {
        await trustedContactService.updateContact(existingContact.id, {
          name: name.trim(),
          phone: phone.trim(),
          relationship: relationship.trim(),
          is_emergency: true,
        });
      } else {
        await trustedContactService.addContact({
          user_id: user.id,
          name: name.trim(),
          phone: phone.trim(),
          relationship: relationship.trim(),
          auto_share: true,
          is_emergency: true,
        }).catch(() => {
          // May fail if duplicate phone — that's ok, trusted_contacts already has this phone
        });
      }

      router.back();
    } catch {
      Toast.show({ type: 'error', text1: t('errors.emergency_contact_failed') });
    } finally {
      setSaving(false);
    }
  };

  if (error) return <ErrorState title="Error" description={error} onRetry={() => { setError(null); loadData(); }} />;

  if (loading) {
    return (
      <Screen scroll bg="white" padded>
        <View className="pt-4">
          <ScreenHeader title={t('profile.emergency_contact_title')} onBack={() => router.back()} />
          <SkeletonCard lines={4} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4">
        <ScreenHeader title={t('profile.emergency_contact_title')} onBack={() => router.back()} />

        <Input
          label={t('profile.emergency_name')}
          value={name}
          onChangeText={setName}
          placeholder="Juan Pérez"
        />
        <Input
          label={t('profile.emergency_phone')}
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          placeholder="+53 5XXXXXXX"
        />
        <Input
          label={t('profile.emergency_relationship')}
          value={relationship}
          onChangeText={setRelationship}
          placeholder="Familiar, Amigo..."
        />

        <Button
          title={t('save')}
          onPress={handleSave}
          loading={saving}
          fullWidth
          size="lg"
          disabled={!name.trim() || !phone.trim()}
        />
      </View>
    </Screen>
  );
}
