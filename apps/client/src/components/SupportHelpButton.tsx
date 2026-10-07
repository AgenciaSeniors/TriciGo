import React, { useState } from 'react';
import { Linking, View } from 'react-native';
import Toast from 'react-native-toast-message';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { rideAssistService } from '@tricigo/api';
import { rideShortCode, searchHelpAvailable, SUPPORT_WHATSAPP_PHONE, waMeLink } from '@tricigo/utils';

interface SupportHelpButtonProps {
  rideId: string;
  /** Seconds the searching screen has been up (SearchingView's counter). */
  elapsedSeconds: number;
}

/**
 * "¿No aparece conductor? Pide ayuda" (00628), from 45 s of searching. Alerts support once
 * (request_ride_help) and opens WhatsApp with the ride code; the search keeps running.
 * The alert is awaited for at most 4 s so it leaves before WhatsApp takes the screen (the app
 * can be suspended then); WhatsApp opens either way, also when 00628 is not applied.
 */
export function SupportHelpButton({ rideId, elapsedSeconds }: SupportHelpButtonProps) {
  const { t } = useTranslation('rider');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  if (!searchHelpAvailable(elapsedSeconds)) return null;
  const code = rideShortCode(rideId);

  const onPress = async () => {
    setSending(true);
    await Promise.race([
      rideAssistService.requestHelp(rideId),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4_000)),
    ]);
    setSending(false);
    setSent(true);
    const url = waMeLink(SUPPORT_WHATSAPP_PHONE, t('home.support_help_whatsapp_text', { code }));
    try {
      if (!url) throw new Error('no WhatsApp link');
      await Linking.openURL(url);
    } catch {
      Toast.show({ type: 'info', text1: t('home.support_help_no_whatsapp', { code }), visibilityTime: 8000 });
    }
  };

  return (
    <View className="w-full px-8 mb-4">
      <Button
        title={sent ? t('home.support_help_again') : t('home.support_help_cta')}
        variant="primary"
        size="md"
        fullWidth
        onPress={() => void onPress()}
        loading={sending}
      />
      {!sent && (
        <Text variant="caption" color="tertiary" className="mt-2 text-center">
          {t('home.support_help_hint')}
        </Text>
      )}
    </View>
  );
}
