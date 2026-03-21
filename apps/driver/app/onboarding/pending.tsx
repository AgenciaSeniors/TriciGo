import React, { useEffect, useCallback, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { driverService } from '@tricigo/api';
import { useDriverStore } from '@/stores/driver.store';
import { useAuthStore } from '@/stores/auth.store';

export default function PendingScreen() {
  const { t } = useTranslation('driver');
  const user = useAuthStore((s) => s.user);
  const setProfile = useDriverStore((s) => s.setProfile);
  const [driverStatus, setDriverStatus] = useState<string>('under_review');
  const [rejectionReason, setRejectionReason] = useState<string | null>(null);
  const [suspensionReason, setSuspensionReason] = useState<string | null>(null);

  const checkStatus = useCallback(async () => {
    if (!user?.id) return;
    try {
      const profile = await driverService.getProfile(user.id);
      if (!profile) return;

      setDriverStatus(profile.status);

      if (profile.status === 'approved') {
        setProfile(profile);
        router.replace('/(tabs)');
        return;
      }

      if (profile.status === 'rejected') {
        // Fetch rejection reason from admin_actions
        try {
          const { getSupabaseClient } = await import('@tricigo/api');
          const supabase = getSupabaseClient();
          const { data: actions } = await supabase
            .from('admin_actions')
            .select('reason')
            .eq('target_id', profile.id)
            .eq('action', 'reject_driver')
            .order('created_at', { ascending: false })
            .limit(1);
          setRejectionReason(actions?.[0]?.reason ?? null);
        } catch {
          setRejectionReason(null);
        }
      }

      if (profile.status === 'suspended') {
        setSuspensionReason((profile as any).suspended_reason ?? null);
      }
    } catch {
      // Ignore — will retry
    }
  }, [user?.id, setProfile]);

  // Poll every 15 seconds
  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 15000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  // ── Rejected screen ──
  if (driverStatus === 'rejected') {
    return (
      <Screen bg="dark" statusBarStyle="light-content">
        <View className="flex-1 justify-center items-center px-8">
          <View className="w-20 h-20 rounded-full bg-red-500/20 items-center justify-center mb-4">
            <Ionicons name="close-circle" size={60} color="#ef4444" />
          </View>
          <Text variant="h3" color="inverse" className="mt-2 text-center">
            {t('onboarding.rejected_title', { defaultValue: 'Solicitud rechazada' })}
          </Text>
          <Text variant="body" color="inverse" className="mt-3 text-center opacity-60">
            {t('onboarding.rejected_description', { defaultValue: 'Tu solicitud de conductor no fue aprobada. Revisa tus documentos y contacta soporte si tienes preguntas.' })}
          </Text>
          {rejectionReason && (
            <View className="mt-4 bg-red-500/10 rounded-xl px-4 py-3">
              <Text variant="bodySmall" className="text-red-400 text-center">
                {rejectionReason}
              </Text>
            </View>
          )}
        </View>
      </Screen>
    );
  }

  // ── Suspended screen ──
  if (driverStatus === 'suspended') {
    return (
      <Screen bg="dark" statusBarStyle="light-content">
        <View className="flex-1 justify-center items-center px-8">
          <View className="w-20 h-20 rounded-full bg-amber-500/20 items-center justify-center mb-4">
            <Ionicons name="warning" size={60} color="#f59e0b" />
          </View>
          <Text variant="h3" color="inverse" className="mt-2 text-center">
            {t('onboarding.suspended_title', { defaultValue: 'Cuenta suspendida' })}
          </Text>
          <Text variant="body" color="inverse" className="mt-3 text-center opacity-60">
            {t('onboarding.suspended_description', { defaultValue: 'Tu cuenta de conductor ha sido suspendida temporalmente.' })}
          </Text>
          {suspensionReason && (
            <View className="mt-4 bg-amber-500/10 rounded-xl px-4 py-3">
              <Text variant="bodySmall" className="text-amber-400 text-center">
                {suspensionReason}
              </Text>
            </View>
          )}
        </View>
      </Screen>
    );
  }

  // ── Under review screen (default) ──
  return (
    <Screen bg="dark" statusBarStyle="light-content">
      <View className="flex-1 justify-center items-center px-8">
        <Ionicons name="time-outline" size={80} color={colors.brand.orange} />
        <Text variant="h3" color="inverse" className="mt-6 text-center">
          {t('onboarding.pending_review')}
        </Text>
        <Text variant="body" color="inverse" className="mt-3 text-center opacity-60">
          {t('onboarding.pending_review_description')}
        </Text>
        <Text variant="caption" color="inverse" className="mt-6 opacity-30">
          {t('onboarding.checking_status', { defaultValue: 'Verificando estado automaticamente...' })}
        </Text>
      </View>
    </Screen>
  );
}
