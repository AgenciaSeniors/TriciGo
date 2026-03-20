import React, { useState, useEffect, useCallback } from 'react';
import { View, Pressable, Switch, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { trustedContactService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import { AddContactSheet } from '@/components/AddContactSheet';
import type { TrustedContact } from '@tricigo/types';

const MAX_CONTACTS = 5;

export default function TrustedContactsScreen() {
  const { t } = useTranslation('common');
  const user = useAuthStore((s) => s.user);
  const [contacts, setContacts] = useState<TrustedContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [addSheetVisible, setAddSheetVisible] = useState(false);

  const loadContacts = useCallback(async () => {
    if (!user) return;
    try {
      const data = await trustedContactService.getContacts(user.id);
      setContacts(data);
    } catch {
      // silent fail
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadContacts();
  }, [loadContacts]);

  const handleToggleAutoShare = async (contact: TrustedContact) => {
    try {
      const updated = await trustedContactService.updateContact(contact.id, {
        auto_share: !contact.auto_share,
      });
      setContacts((prev) =>
        prev.map((c) => (c.id === contact.id ? updated : c)),
      );
    } catch {
      Alert.alert(t('error'), t('errors.generic'));
    }
  };

  const handleDelete = (contact: TrustedContact) => {
    Alert.alert(
      t('trusted_contacts.delete_contact'),
      t('trusted_contacts.delete_confirm', { name: contact.name }),
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: t('delete'),
          style: 'destructive',
          onPress: async () => {
            try {
              await trustedContactService.deleteContact(contact.id);
              setContacts((prev) => prev.filter((c) => c.id !== contact.id));
            } catch {
              Alert.alert(t('error'), t('errors.generic'));
            }
          },
        },
      ],
    );
  };

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4">
        <ScreenHeader title={t('trusted_contacts.title')} onBack={() => router.back()} />

        <Text variant="bodySmall" color="secondary" className="mb-4">
          {t('trusted_contacts.desc')}
        </Text>

        {/* Contact List */}
        {contacts.map((contact) => (
          <Card key={contact.id} variant="outlined" padding="md" className="mb-3">
            <View className="flex-row items-start">
              <View className="w-10 h-10 rounded-full bg-primary-100 items-center justify-center mr-3 mt-1">
                <Ionicons name="person-outline" size={20} color={colors.primary[500]} />
              </View>
              <View className="flex-1">
                <View className="flex-row items-center">
                  <Text variant="body" className="font-semibold flex-1">
                    {contact.name}
                  </Text>
                  {contact.is_emergency && (
                    <View className="bg-error px-2 py-0.5 rounded-full ml-2">
                      <Text variant="caption" color="inverse" className="text-xs">
                        {t('trusted_contacts.emergency_badge')}
                      </Text>
                    </View>
                  )}
                </View>
                <Text variant="caption" color="secondary">{contact.phone}</Text>
                {contact.relationship ? (
                  <Text variant="caption" color="secondary">{contact.relationship}</Text>
                ) : null}

                {/* Auto-share toggle */}
                <View className="flex-row items-center justify-between mt-2 pt-2 border-t border-neutral-100">
                  <Text variant="caption" color="secondary">
                    {t('trusted_contacts.auto_share')}
                  </Text>
                  <Switch
                    value={contact.auto_share}
                    onValueChange={() => handleToggleAutoShare(contact)}
                    trackColor={{ true: colors.primary[500], false: colors.neutral[300] }}
                  />
                </View>
              </View>

              {/* Delete button */}
              <Pressable
                className="ml-2 p-2"
                onPress={() => handleDelete(contact)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('delete')}
              >
                <Ionicons name="trash-outline" size={18} color={colors.neutral[400]} />
              </Pressable>
            </View>
          </Card>
        ))}

        {/* Empty state */}
        {!loading && contacts.length === 0 && (
          <Card variant="outlined" padding="lg" className="mb-3">
            <View className="items-center py-4">
              <Ionicons name="people-outline" size={40} color={colors.neutral[300]} />
              <Text variant="body" color="secondary" className="mt-3 text-center">
                {t('trusted_contacts.no_contacts')}
              </Text>
              <Text variant="caption" color="secondary" className="text-center mt-1">
                {t('trusted_contacts.no_contacts_desc')}
              </Text>
            </View>
          </Card>
        )}

        {/* Add button */}
        {contacts.length < MAX_CONTACTS && (
          <Button
            title={t('trusted_contacts.add_contact')}
            variant="outline"
            size="lg"
            fullWidth
            onPress={() => setAddSheetVisible(true)}
            icon="add-outline"
          />
        )}

        {contacts.length >= MAX_CONTACTS && (
          <Text variant="caption" color="secondary" className="text-center mt-2">
            {t('trusted_contacts.max_reached')}
          </Text>
        )}
      </View>

      {user && (
        <AddContactSheet
          visible={addSheetVisible}
          onClose={() => setAddSheetVisible(false)}
          userId={user.id}
          onAdded={loadContacts}
        />
      )}
    </Screen>
  );
}
