import React, { useEffect, useCallback, useState } from 'react';
import { View, Pressable, Linking } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { authService, driverService } from '@tricigo/api';
import { useDriverStore } from '@/stores/driver.store';
import { useAuthStore } from '@/stores/auth.store';

// Central support contact. Update here if ops phone/whatsapp changes.
const SUPPORT_WHATSAPP = '+5356621636'; // WhatsApp ops line

export default function PendingScreen() {
  const { t } = useTranslation('driver');
  const user = useAuthStore((s) => s.user);
  const resetAuth = useAuthStore((s) => s.reset);
  const setProfile = useDriverStore((s) => s.setProfile);
  const resetDriver = useDriverStore((s) => s.reset);
  const [driverStatus, setDriverStatus] = useState<string>('under_review');
  const [rejectionReason, setRejectionReason] = useState<string | null>(null);
  const [suspensionReason, setSuspensionReason] = useState<string | null>(null);

  // UX: give drivers who are stuck waiting / rejected / suspended a
  // quick way out. Previous screens dead-ended them.
  const openSupport = useCallback(() => {
    const msg = encodeURIComponent(t('onboarding.support_prefill', { defaultValue: 'Hola, necesito ayuda con mi cuenta de conductor.' }));
    Linking.openURL(`https://wa.me/${SUPPORT_WHATSAPP.replace(/[^0-9]/g, '')}?text=${msg}`)
      .catch(() => Linking.openURL(`tel:${SUPPORT_WHATSAPP}`).catch(() => {}));
  }, [t]);

  const doLogout = useCallback(async () => {
    try { await authService.signOut(); } catch { /* best-effort */ }
    resetAuth();
    resetDriver();
  }, [resetAuth, resetDriver]);

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
          {/* UX: actionable CTAs — previously drivers were told to
               "contact support" but had no button to do so, and no way
               to resubmit. Both paths now live here. */}
          <View className="w-full mt-8 gap-3">
            <Button
              title={t('onboarding.resubmit_docs', { defaultValue: 'Volver a subir documentos' })}
              size="lg"
              fullWidth
              onPress={() => router.replace('/onboarding/documents')}
            />
            <Button
              title={t('onboarding.contact_support', { defaultValue: 'Contactar soporte' })}
              variant="outline"
              size="lg"
              fullWidth
              forceDark
              onPress={openSupport}
            />
          </View>
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
          <View className="w-full mt-8">
            <Button
              title={t('onboarding.contact_support', { defaultValue: 'Contactar soporte' })}
              size="lg"
              fullWidth
              onPress={openSupport}
            />
          </View>
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
        {/* UX: concrete time window makes the wait feel bounded.
             Drivers otherwise refresh every 5 minutes and give up. */}
        <View className="mt-5 bg-orange-500/10 border border-orange-500/30 rounded-xl px-4 py-2">
          <Text variant="caption" style={{ color: '#FFB380' }}>
            {t('onboarding.pending_sla', { defaultValue: 'Tiempo promedio: 24 horas hábiles' })}
          </Text>
        </View>
        <Text variant="caption" color="inverse" className="mt-4 opacity-30">
          {t('onboarding.checking_status', { defaultValue: 'Verificando estado automaticamente...' })}
        </Text>

        {/* UX: give the driver something to do while they wait. Without
             these two actions, the screen was a dead end — they couldn't
             contact support, couldn't log out to try a different email,
             nothing. */}
        <View className="w-full mt-10 gap-3">
          <Button
            title={t('onboarding.contact_support', { defaultValue: 'Contactar soporte' })}
            variant="outline"
            size="lg"
            fullWidth
            forceDark
            onPress={openSupport}
          />
          <Pressable onPress={doLogout} hitSlop={10} className="py-2">
            <Text variant="caption" style={{ color: '#9CA3AF', textAlign: 'center' }}>
              {t('onboarding.switch_account', { defaultValue: 'Cambiar de cuenta' })}
            </Text>
          </Pressable>
        </View>
      </View>
    </Screen>
  );
}
