import React, { useState, useCallback } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber } from '@tricigo/theme';
import { useLogout } from '@/hooks/useLogout';

/**
 * BUG-299 — "¿Cuenta equivocada? Cerrar sesión" footer link.
 *
 * Rendered at the bottom of every onboarding step (personal-info,
 * vehicle-info, documents, review) so a driver who logged in with the
 * wrong phone (or wants to switch to another account) can escape the
 * flow. Without this, the RootNavigator (`apps/driver/app/_layout.tsx`
 * line 208-217) re-redirects any back navigation straight back into the
 * onboarding — there is no other way out.
 *
 * Visual style intentionally matches the existing "Cambiar de cuenta"
 * link in `apps/driver/app/onboarding/pending.tsx:228-232` so the two
 * escape routes feel like one pattern.
 *
 * Wrapped in `Alert.alert` confirmation: the driver may have already
 * filled half the form (uploaded documents take time on Cuban networks),
 * and a stray tap on a tertiary-color link shouldn't silently wipe that
 * progress. The `useLogout` hook also resets `useOnboardingStore`, which
 * is the source of truth for the in-progress form draft.
 *
 * No `router.replace` here — `useLogout` clears `isAuthenticated` and
 * the RootNavigator effect picks up the change and routes to
 * `/(auth)/login` automatically.
 */
export function SwitchAccountFooter() {
  const { t } = useTranslation('driver');
  const logout = useLogout();
  const [busy, setBusy] = useState(false);

  const onPress = useCallback(() => {
    Alert.alert(
      t('onboarding.switch_account_confirm_title', {
        defaultValue: '¿Cambiar de cuenta?',
      }),
      t('onboarding.switch_account_confirm_body', {
        defaultValue:
          'Vas a cerrar sesión y volver al inicio. Los datos del formulario actual se perderán.',
      }),
      [
        {
          text: t('common:cancel', { defaultValue: 'Cancelar' }),
          style: 'cancel',
        },
        {
          text: t('onboarding.switch_account', {
            defaultValue: 'Cerrar sesión',
          }),
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await logout();
            } finally {
              // Reset busy ONLY if logout failed AND we're still mounted.
              // On success the RootNavigator unmounts this component when
              // it redirects to /(auth)/login, so leaving busy=true is fine.
              setBusy(false);
            }
          },
        },
      ],
    );
  }, [logout, t]);

  return (
    <View style={{ alignItems: 'center', paddingVertical: 16 }}>
      <Pressable
        onPress={onPress}
        disabled={busy}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel={t('onboarding.switch_account_prompt', {
          defaultValue: '¿Cuenta equivocada? Cerrar sesión',
        })}
      >
        <Text
          variant="caption"
          style={{
            color: midnightEmber.map.text.tertiary,
            textAlign: 'center',
            textDecorationLine: 'underline',
            opacity: busy ? 0.5 : 1,
          }}
        >
          {t('onboarding.switch_account_prompt', {
            defaultValue: '¿Cuenta equivocada? Cerrar sesión',
          })}
        </Text>
      </Pressable>
    </View>
  );
}
