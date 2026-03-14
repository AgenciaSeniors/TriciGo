import { Stack } from 'expo-router';

export default function RideLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="[id]" />
      <Stack.Screen name="share/[token]" />
      <Stack.Screen name="dispute/[rideId]" />
      <Stack.Screen name="lost-item/[rideId]" />
    </Stack>
  );
}
