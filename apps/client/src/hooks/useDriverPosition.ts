import { useEffect, useState } from 'react';
import { getSupabaseClient } from '@tricigo/api';

interface DriverPosition {
  latitude: number;
  longitude: number;
  heading: number | null;
}

export function useDriverPosition(rideId: string | null): DriverPosition | null {
  const [position, setPosition] = useState<DriverPosition | null>(null);

  useEffect(() => {
    if (!rideId) return;

    const supabase = getSupabaseClient();
    const channel = supabase
      .channel(`driver-pos:${rideId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'ride_location_events',
          filter: `ride_id=eq.${rideId}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          // Parse location from POINT string if needed
          if (typeof row.location === 'string') {
            const match = (row.location as string).match(/POINT\(([^ ]+) ([^ ]+)\)/);
            if (match && match[1] && match[2]) {
              setPosition({
                latitude: parseFloat(match[2]!),
                longitude: parseFloat(match[1]!),
                heading: (row.heading as number) ?? null,
              });
            }
          }
        },
      )
      .subscribe();

    return () => {
      channel.unsubscribe();
    };
  }, [rideId]);

  return position;
}
