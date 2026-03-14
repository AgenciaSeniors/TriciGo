import { Stack } from 'expo-router';

export default function DisputeRespondLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="[disputeId]" />
    </Stack>
  );
}
