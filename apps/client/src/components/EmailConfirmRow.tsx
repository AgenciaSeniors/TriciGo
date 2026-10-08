import React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from '@tricigo/i18n';
import { colors, cubanDark, cubanLight } from '@tricigo/theme';

interface EmailConfirmRowProps {
  /** The unconfirmed address (get_my_email_status). */
  email: string;
  /** A link was sent in this session, or the server holds a still-valid one. */
  linkSent: boolean;
  resending: boolean;
  onResend: () => void;
  isDark: boolean;
}

/**
 * Profile row under the phone number while the account's e-mail is not confirmed:
 * the address, its state ("Sin confirmar" / "Enlace enviado", text plus a mark,
 * never color alone) and a "Reenviar enlace" action. Not dismissible.
 *
 * Colors measured for small text (WCAG AA 4.5:1) on every hero surface:
 * state #92400E 6.1–7.1:1 light, #FFB547 9.2–11:1 dark; action #BF3800
 * 4.8–5.6:1 light, #FF6D38 5.7–6.9:1 dark. Brand orange #FF4D00 would be
 * 3.3:1 on white.
 */
export function EmailConfirmRow({ email, linkSent, resending, onResend, isDark }: EmailConfirmRowProps) {
  const { t } = useTranslation('common');
  const palette = isDark ? cubanDark : cubanLight;
  const stateColor = isDark ? palette.accent.warm : colors.warning.dark;
  const actionColor = isDark ? colors.primary[400] : colors.primary[700];

  return (
    <View style={{ marginTop: 6 }}>
      <Text style={{ color: palette.ink.secondary, fontSize: 13 }} numberOfLines={1} ellipsizeMode="middle">
        {email}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginTop: 2 }}>
        <View
          style={{ flexDirection: 'row', alignItems: 'center', marginRight: 10 }}
          accessible
          accessibilityRole="text"
        >
          {linkSent ? (
            <Ionicons name="checkmark-circle" size={13} color={stateColor} style={{ marginRight: 4 }} />
          ) : (
            <View
              style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: stateColor, marginRight: 5 }}
            />
          )}
          <Text style={{ color: stateColor, fontSize: 12, fontWeight: '600' }}>
            {linkSent
              ? t('email_notice.sent_short', { defaultValue: 'Enlace enviado' })
              : t('email_notice.unconfirmed', { defaultValue: 'Sin confirmar' })}
          </Text>
        </View>
        <Pressable
          onPress={onResend}
          disabled={resending}
          hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
          accessibilityRole="button"
          accessibilityLabel={t('email_notice.resend_a11y', {
            email,
            defaultValue: 'Reenviar el enlace de confirmación a {{email}}',
          })}
          accessibilityState={{ disabled: resending, busy: resending }}
          style={{ paddingVertical: 4 }}
        >
          {/* Layout in plain style objects, pressed state through children-as-function
              (CLAUDE.md: a Pressable style function can drop its layout block). */}
          {({ pressed }) => (
            <View
              style={{ flexDirection: 'row', alignItems: 'center', opacity: resending ? 0.5 : pressed ? 0.6 : 1 }}
            >
              {resending && (
                <ActivityIndicator
                  size="small"
                  color={actionColor}
                  style={{ marginRight: 4, transform: [{ scale: 0.7 }] }}
                />
              )}
              <Text style={{ color: actionColor, fontSize: 12, fontWeight: '700' }}>
                {t('email_notice.resend', { defaultValue: 'Reenviar enlace' })}
              </Text>
            </View>
          )}
        </Pressable>
      </View>
    </View>
  );
}
