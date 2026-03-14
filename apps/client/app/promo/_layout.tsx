import { Stack } from 'expo-router';

export default function PromoLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="[code]" />
    </Stack>
  );
}
