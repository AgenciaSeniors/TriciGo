import { useEffect, useState, useRef } from 'react';

interface HeatmapPoint {
  latitude: number;
  longitude: number;
  intensity: number;
}

const SUPABASE_URL = 'https://lqaufszburqvlslpcuac.supabase.co';

/**
 * Hook that fetches demand heatmap data from Supabase edge function.
 * Refreshes every 5 minutes.
 */
export function useDemandHeatmap(enabled: boolean): HeatmapPoint[] {
  const [points, setPoints] = useState<HeatmapPoint[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // TODO: Enable when demand-heatmap edge function is deployed
    if (!enabled) {
      setPoints([]);
      return;
    }
    return;

    const fetchHeatmap = async () => {
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/demand-heatmap`);
        if (!res.ok) return;
        const data = (await res.json()) as HeatmapPoint[];
        setPoints(data);
      } catch {
        // Silently fail - heatmap is a nice-to-have
      }
    };

    fetchHeatmap();
    intervalRef.current = setInterval(fetchHeatmap, 5 * 60 * 1000); // 5 minutes

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [enabled]);

  return points;
}
