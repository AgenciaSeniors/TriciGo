import { Stack } from 'expo-router';

export default function DriverProfileLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="[userId]" />
    </Stack>
  );
}
