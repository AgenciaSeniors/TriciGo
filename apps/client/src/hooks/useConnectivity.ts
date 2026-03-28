import { useState, useEffect } from 'react';
import NetInfo from '@react-native-community/netinfo';

/**
 * Centralized connectivity hook.
 * Returns whether the device currently has internet connectivity.
 */
export function useConnectivity() {
  const [isConnected, setIsConnected] = useState(true);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setIsConnected(state.isConnected ?? true);
    });
    return () => unsubscribe();
  }, []);

  return { isConnected };
}
