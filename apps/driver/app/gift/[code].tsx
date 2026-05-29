import { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

/**
 * Deep-link landing for `tricigo-driver://gift/<code>` (the gift QR
 * payload). Resolves to the gift screen with the recipient code
 * pre-filled, which auto-resolves the recipient. A gift code identifies
 * the RECIPIENT — it is not "redeemed" like a referral.
 */
export default function GiftDeepLink() {
  const { code } = useLocalSearchParams<{ code?: string }>();

  useEffect(() => {
    const timer = setTimeout(() => {
      router.replace(code ? `/wallet/gift?code=${encodeURIComponent(code)}` : '/wallet/gift');
    }, 50);
    return () => clearTimeout(timer);
  }, [code]);

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0a0a0a' }}>
      <ActivityIndicator size="large" color="#FF4D00" />
    </View>
  );
}
