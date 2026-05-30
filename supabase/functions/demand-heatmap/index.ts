import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const GRID_PRECISION = 3; // ~100m grid cells
const CACHE_TTL_S = 300; // 5 minutes

Deno.serve(async (req: Request) => {
  // CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, x-client-info, apikey, content-type',
      },
    });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Get rides from last 2 hours with status 'searching'
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    const { data: rides, error } = await supabase
      .from('rides')
      .select('pickup_location')
      .eq('status', 'searching')
      .gte('created_at', twoHoursAgo);

    if (error) throw error;

    // Also include recently completed rides to show demand patterns
    const { data: recentRides } = await supabase
      .from('rides')
      .select('pickup_location')
      .in('status', ['accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress'])
      .gte('created_at', twoHoursAgo);

    const allRides = [...(rides ?? []), ...(recentRides ?? [])];

    // Parse PostGIS POINT and group by grid cell
    const grid = new Map<string, number>();

    for (const ride of allRides) {
      const loc = ride.pickup_location;
      if (!loc) continue;

      // Parse POINT(lng lat) format
      const match = String(loc).match(/POINT\(([\-\d.]+)\s+([\-\d.]+)\)/);
      if (!match) continue;

      const lng = parseFloat(match[1]);
      const lat = parseFloat(match[2]);

      // Round to grid
      const gridLat = lat.toFixed(GRID_PRECISION);
      const gridLng = lng.toFixed(GRID_PRECISION);
      const key = `${gridLat},${gridLng}`;

      grid.set(key, (grid.get(key) ?? 0) + 1);
    }

    // Convert to heatmap points with intensity (0-1)
    const maxCount = Math.max(...Array.from(grid.values()), 1);

    const heatmapPoints = Array.from(grid.entries()).map(([key, count]) => {
      const [lat, lng] = key.split(',').map(Number);
      return {
        latitude: lat,
        longitude: lng,
        intensity: Math.min(count / maxCount, 1),
      };
    });

    return new Response(JSON.stringify(heatmapPoints), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${CACHE_TTL_S}`,
        'Access-Control-Allow-Origin': '*',
        'Connection': 'keep-alive',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
});
