-- Seed for the 00608 rehearsal. Values are fakes of the same shape as prod's.
INSERT INTO public.users (id, role) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'customer'),   -- ALICE
  ('a0000000-0000-4000-8000-000000000003', 'admin');      -- CAROL

INSERT INTO public.platform_config (key, value) VALUES
  ('openweather_api_key', to_jsonb(repeat('k', 32))),
  ('eltoque_api_token', to_jsonb(repeat('t', 295))),
  ('netopia_live_signature', to_jsonb(repeat('s', 24))),
  ('weather_surge_multiplier', to_jsonb('1.4'::text)),
  ('commission_rate', to_jsonb(0.15));

-- ALICE cancelled once in the last 24 h
INSERT INTO public.cancellation_penalties (user_id) VALUES ('a0000000-0000-4000-8000-000000000001');
