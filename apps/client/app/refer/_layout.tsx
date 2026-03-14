import { Stack } from 'expo-router';

export default function ReferLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="[code]" />
    </Stack>
  );
}
