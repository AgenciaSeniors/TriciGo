import { Stack } from 'expo-router';
import { colors } from '@tricigo/theme';

export default function WalletLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#0d0d1a' },
        animation: 'slide_from_right',
      }}
    />
  );
}
