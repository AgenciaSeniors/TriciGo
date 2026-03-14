import { useState, useEffect, useCallback } from 'react';
import {
  recentAddressService,
  type RecentAddress,
} from '@/services/recentAddresses';

/**
 * React hook wrapping the recent-addresses AsyncStorage service.
 * Loads on mount, exposes helpers that keep React state in sync.
 */
export function useRecentAddresses() {
  const [recentAddresses, setRecentAddresses] = useState<RecentAddress[]>([]);

  useEffect(() => {
    recentAddressService.getAll().then(setRecentAddresses).catch(() => {});
  }, []);

  const addRecentAddress = useCallback(
    async (address: string, latitude: number, longitude: number) => {
      const updated = await recentAddressService.add(address, latitude, longitude);
      setRecentAddresses(updated);
    },
    [],
  );

  const clearRecent = useCallback(async () => {
    await recentAddressService.clear();
    setRecentAddresses([]);
  }, []);

  return { recentAddresses, addRecentAddress, clearRecent } as const;
}
