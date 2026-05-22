import React, { useState, useCallback } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { colors, darkColors } from '@tricigo/theme';
import { useThemeStore } from '@/stores/theme.store';
import { useLogout } from '@/hooks/useLogout';

/**
 * BUG-299b — "¿Cuenta equivocada? Cerrar sesión" footer link for the
 * client app's `complete-profile.tsx`.
 *
 * The client RootNavigator (`apps/client/app/_layout.tsx:162-181`) routes
 * any authenticated user without `full_name` to `complete-profile`. The
 * screen had no logout button, so a user who signed in via OAuth with
 * the wrong account (or otherwise wants to switch) could only complete
 * the form (and tie that name to the wrong account) or kill-app +
 * reinstall.
 *
 * Mirrors `apps/driver/src/components/onboarding/SwitchAccountFooter.tsx`
 * from PR #150 (BUG-299). Visual differences:
 *   - The client app has dynamic light/dark mode (`useThemeStore`) rather
 *     than the driver's fixed midnightEmber palette.
 *   - Lives under `components/auth/` (not `components/onboarding/`)
 *     because the client doesn't have a multi-step onboarding — it's a
 *     single profile-completion screen inside the auth group.
 *
 * Wrapped in `Alert.alert` confirmation: the screen might have a typed
 * name and a selected avatar that shouldn't be wiped by an accidental
 * tap on a tertiary-color link.
 *
 * No `router.replace` here — `useLogout` clears `isAuthenticated` and
 * the RootNavigator effect picks up the change and routes to
 * `/(auth)/login` automatically.
 */
export function SwitchAccountFooter() {
  const { t } = useTranslation('common');
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const isDark = resolvedScheme === 'dark';
  const linkColor = isDark ? darkColors.text.secondary : colors.neutral[500];
  const logout = useLogout();
  const [busy, setBusy] = useState(false);

  const onPress = useCallback(() => {
    Alert.alert(
      t('auth.switch_account_confirm_title', {
        defaultValue: '¿Cambiar de cuenta?',
      }),
      t('auth.switch_account_confirm_body', {
        defaultValue: 'Vas a cerrar sesión y volver al inicio.',
      }),
      [
        {
          text: t('cancel', { defaultValue: 'Cancelar' }),
          style: 'cancel',
        },
        {
          text: t('auth.switch_account', { defaultValue: 'Cerrar sesión' }),
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await logout();
            } finally {
              // Reset busy ONLY if logout failed AND we're still mounted.
              // On success the RootNavigator unmounts this component when
              // it redirects to /(auth)/login.
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
        accessibilityLabel={t('auth.switch_account_prompt', {
          defaultValue: '¿Cuenta equivocada? Cerrar sesión',
        })}
      >
        <Text
          variant="caption"
          style={{
            color: linkColor,
            textAlign: 'center',
            textDecorationLine: 'underline',
            opacity: busy ? 0.5 : 1,
          }}
        >
          {t('auth.switch_account_prompt', {
            defaultValue: '¿Cuenta equivocada? Cerrar sesión',
          })}
        </Text>
      </Pressable>
    </View>
  );
}
