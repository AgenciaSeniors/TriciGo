import { Stack } from 'expo-router';

export default function ProfileLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="edit" />
      <Stack.Screen name="saved-locations" />
      <Stack.Screen name="emergency-contact" />
      <Stack.Screen name="trusted-contacts" />
      <Stack.Screen name="safety" />
      <Stack.Screen name="ride-preferences" />
      <Stack.Screen name="recurring-rides" />
      <Stack.Screen name="settings" />
      <Stack.Screen name="help" />
      <Stack.Screen name="ticket-detail" />
      <Stack.Screen name="referral" />
      <Stack.Screen name="about" />
    </Stack>
  );
}
