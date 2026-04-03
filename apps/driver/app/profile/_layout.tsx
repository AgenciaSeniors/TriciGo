import { Stack } from 'expo-router';

export default function ProfileLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="edit" />
      <Stack.Screen name="vehicle" />
      <Stack.Screen name="documents" />
      <Stack.Screen name="safety" />
      <Stack.Screen name="pricing" />
      <Stack.Screen name="settings" />
      <Stack.Screen name="help" />
      <Stack.Screen name="ticket-detail" />
      <Stack.Screen name="referral" />
      <Stack.Screen name="cargo-settings" />
      <Stack.Screen name="edit-vehicle" />
    </Stack>
  );
}
