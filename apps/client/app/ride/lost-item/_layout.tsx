import { Stack } from 'expo-router';

export default function LostItemLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="[rideId]" />
    </Stack>
  );
}
