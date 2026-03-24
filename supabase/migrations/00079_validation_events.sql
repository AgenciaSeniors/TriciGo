-- Production validation events for driver behavior tracking
CREATE TABLE IF NOT EXISTS public.validation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid REFERENCES auth.users(id),
  event_type text NOT NULL,
  ride_id uuid REFERENCES public.rides(id),
  properties jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_validation_events_driver ON public.validation_events(driver_id, created_at DESC);
CREATE INDEX idx_validation_events_type ON public.validation_events(event_type, created_at DESC);

ALTER TABLE public.validation_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "drivers_insert_own" ON public.validation_events
  FOR INSERT WITH CHECK (auth.uid() = driver_id);

CREATE POLICY "admins_read_all" ON public.validation_events
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );
