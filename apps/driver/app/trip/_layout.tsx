import { Stack } from 'expo-router';

export default function TripLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="[id]" />
      <Stack.Screen name="dispute-respond/[disputeId]" />
      <Stack.Screen name="lost-item/[id]" />
    </Stack>
  );
}
