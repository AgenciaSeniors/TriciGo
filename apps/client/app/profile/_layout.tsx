import { Stack } from 'expo-router';

export default function ProfileLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="edit" />
      <Stack.Screen name="saved-locations" />
      <Stack.Screen name="emergency-contact" />
    </Stack>
  );
}
