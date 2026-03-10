import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Text } from '@tricigo/ui';
import { getOnlineStatus, getPendingCount } from '@tricigo/api';

/**
 * Displays a warning banner when the app is offline (dark theme variant).
 * Shows pending mutation count if any are queued.
 */
export function OfflineBanner() {
  const [isOnline, setIsOnline] = useState(true);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setIsOnline(getOnlineStatus());
      setPending(getPendingCount());
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  if (isOnline && pending === 0) return null;

  return (
    <View className="bg-yellow-600 px-4 py-2">
      <Text variant="caption" className="text-center font-semibold text-neutral-900">
        {!isOnline
          ? `Sin conexión${pending > 0 ? ` · ${pending} cambio${pending > 1 ? 's' : ''} pendiente${pending > 1 ? 's' : ''}` : ''}`
          : `Sincronizando ${pending} cambio${pending > 1 ? 's' : ''}...`}
      </Text>
    </View>
  );
}
