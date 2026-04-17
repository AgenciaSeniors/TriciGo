import React, { useState, useEffect, useCallback } from 'react';
import { View, Pressable, Switch, Alert, ScrollView, RefreshControl } from 'react-native';
import Toast from 'react-native-toast-message';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { SkeletonListItem } from '@tricigo/ui/Skeleton';
import { ErrorState } from '@tricigo/ui/ErrorState';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { StaggeredList } from '@tricigo/ui/AnimatedCard';
import { trustedContactService } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import type { TrustedContact } from '@tricigo/types';

const MAX_CONTACTS = 5;

export default function TrustedContactsScreen() {
  const { t } = useTranslation('common');
  const user = useAuthStore((s) => s.user);
  const [contacts, setContacts] = useState<TrustedContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadContacts = useCallback(async () => {
    if (!user) return;
    try {
      const data = await trustedContactService.getContacts(user.id);
      setContacts(data);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadContacts();
  }, [loadContacts]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadContacts();
    setRefreshing(false);
  }, [loadContacts]);

  const handleToggleAutoShare = async (contact: TrustedContact) => {
    try {
      const updated = await trustedContactService.updateContact(contact.id, {
        auto_share: !contact.auto_share,
      });
      setContacts((prev) => prev.map((c) => (c.id === contact.id ? updated : c)));
    } catch {
      Toast.show({ type: 'error', text1: t('errors.contacts_load_failed') });
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
              Toast.show({ type: 'error', text1: t('errors.contacts_load_failed') });
            }
          },
        },
      ],
    );
  };

  if (error) return <ErrorState title="Error" description={error} onRetry={() => { setError(null); loadContacts(); }} />;

  return (
    <Screen bg="lightPrimary" statusBarStyle="dark-content" padded>
      <ScrollView
        contentContainerStyle={{ flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.brand.orange} />}
      >
        <View className="pt-4 pb-8">
          <View className="flex-row items-center mb-4">
            <Pressable
              onPress={() => router.back()}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('common.back', { defaultValue: 'Back' })}
              className="mr-3 w-11 h-11 rounded-xl items-center justify-center"
              style={{ backgroundColor: '#F1F5F9' }}
            >
              <Ionicons name="arrow-back" size={20} color="#0F172A" />
            </Pressable>
            <Text variant="h3" color="primary">{t('trusted_contacts.title')}</Text>
          </View>

          <Text variant="bodySmall" color="secondary" className="mb-4">
            {t('trusted_contacts.desc')}
          </Text>

          {loading && contacts.length === 0 && (
            <View className="gap-3 mb-4">
              <SkeletonListItem />
              <SkeletonListItem />
            </View>
          )}

          {contacts.length > 0 && (
            <StaggeredList staggerDelay={80}>
              {contacts.map((contact) => (
                <View
                  key={contact.id}
                  className="rounded-2xl p-4 mb-3"
                  style={{ backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E8F0' }}
                >
                  <View className="flex-row items-start">
                    <View className="w-10 h-10 rounded-full items-center justify-center mr-3 mt-1" style={{ backgroundColor: `${colors.brand.orange}20` }}>
                      <Ionicons name="person-outline" size={20} color={colors.brand.orange} />
                    </View>
                    <View className="flex-1">
                      <View className="flex-row items-center">
                        <Text variant="body" color="primary" className="font-semibold flex-1">
                          {contact.name}
                        </Text>
                        {contact.is_emergency && (
                          <View className="bg-error px-2 py-0.5 rounded-full ml-2">
                            <Text variant="caption" color="primary" className="text-xs">
                              {t('trusted_contacts.emergency_badge')}
                            </Text>
                          </View>
                        )}
                      </View>
                      <Text variant="caption" color="secondary">{contact.phone}</Text>
                      {contact.relationship && (
                        <Text variant="caption" color="secondary">{contact.relationship}</Text>
                      )}

                      <View className="flex-row items-center justify-between mt-2 pt-2 border-t" style={{ borderTopColor: '#E2E8F0' }}>
                        <Text variant="caption" color="secondary">
                          {t('trusted_contacts.auto_share')}
                        </Text>
                        <Switch
                          value={contact.auto_share}
                          onValueChange={() => handleToggleAutoShare(contact)}
                          trackColor={{ false: '#E2E8F0', true: colors.brand.orange }}
                        />
                      </View>
                    </View>

                    <Pressable className="ml-2 p-2" onPress={() => handleDelete(contact)} hitSlop={8}>
                      <Ionicons name="trash-outline" size={18} color={colors.neutral[500]} />
                    </Pressable>
                  </View>
                </View>
              ))}
            </StaggeredList>
          )}

          {!loading && contacts.length === 0 && (
            <EmptyState
              icon="people-outline"
              title={t('trusted_contacts.no_contacts')}
              description={t('trusted_contacts.no_contacts_desc')}
            />
          )}

          {contacts.length < MAX_CONTACTS && (
            <Button
              title={t('trusted_contacts.add_contact')}
              variant="outline"
              size="lg"
              fullWidth
              onPress={() => {
                // TODO: Open add contact sheet
                Toast.show({ type: 'info', text1: t('common.coming_soon', { defaultValue: 'Próximamente' }) });
              }}
            />
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}
