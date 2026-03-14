import { Stack } from 'expo-router';

export default function DisputeLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="[rideId]" />
    </Stack>
  );
}
