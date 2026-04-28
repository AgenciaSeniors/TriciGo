-- BUG-266: ride_location_events was missing from supabase_realtime
-- publication, so the rider's useDriverPosition subscription always
-- got CHANNEL_ERROR (the table is not visible to the realtime engine).
-- That forced everything to fall back to 1-second polling — which works
-- but adds 0-1s of latency vs an instant push.
--
-- Adding the table to the publication makes the driver's GPS samples
-- broadcast to the rider in <100ms, eliminating the perceived lag and
-- making the rider's experience feel like the driver's own map.
ALTER PUBLICATION supabase_realtime ADD TABLE public.ride_location_events;
