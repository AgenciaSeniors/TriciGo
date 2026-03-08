import React from 'react';
import { View } from 'react-native';
import { Link } from 'expo-router';
import { Text } from '@tricigo/ui/Text';

export default function NotFoundScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-neutral-950">
      <Text variant="h3" color="inverse">404</Text>
      <Text variant="body" color="inverse" className="mt-2 mb-4 opacity-50">
        Página no encontrada
      </Text>
      <Link href="/(tabs)">
        <Text variant="body" color="accent">
          Volver al inicio
        </Text>
      </Link>
    </View>
  );
}
