-- Seed for the 00606 rehearsal: the shape of prod's admin_actions on 2026-10-06,
-- scaled down. Runs as the scaffold owner with no JWT subject, so the platform_config
-- INSERTs below are audited by the platform account, as in prod.
INSERT INTO public.users (id, role) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'customer'),   -- ALICE
  ('a0000000-0000-4000-8000-000000000003', 'admin');      -- CAROL

INSERT INTO public.platform_config (key, value) VALUES
  ('netopia_proxy_health_at', to_jsonb('2026-10-06T02:00:00Z'::text)),
  ('db_health_detail', to_jsonb('849.6 MB · conn 28/60'::text)),
  ('weather_last_check', to_jsonb('{"condition":"clear"}'::text)),
  ('weather_surge_multiplier', to_jsonb('1'::text)),
  ('commission_rate', to_jsonb(0.15)),
  ('eltoque_api_token', to_jsonb('tok-old'::text));

-- History. created_at is spread over the last 90 days, never "now".
-- (a) 3000 watchdog heartbeats by the platform account: what 00606 deletes
INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, created_at)
SELECT '00000000-0000-0000-0000-000000000001', 'update_platform_config', 'platform_config',
       (ARRAY['netopia_proxy_health_at', 'db_health_detail', 'weather_last_check'])[1 + g % 3],
       jsonb_build_object('value', g), jsonb_build_object('value', g + 1),
       now() - make_interval(mins => g * 43)
FROM generate_series(1, 3000) g;

-- (b) 400 automated changes to a real setting by the platform account: kept
INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, created_at)
SELECT '00000000-0000-0000-0000-000000000001', 'update_platform_config', 'platform_config', 'weather_surge_multiplier',
       jsonb_build_object('value', '1'), jsonb_build_object('value', '1.2'), now() - make_interval(mins => g * 300 + 7)
FROM generate_series(1, 400) g;

-- (c) automated INSERT and DELETE of telemetry keys: kept (only UPDATEs are heartbeats)
INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, created_at) VALUES
  ('00000000-0000-0000-0000-000000000001', 'insert_platform_config', 'platform_config', 'sms_health_at', NULL, '{"value": "x"}', now() - interval '60 days'),
  ('00000000-0000-0000-0000-000000000001', 'delete_platform_config', 'platform_config', 'old_probe_detail', '{"value": "y"}', NULL, now() - interval '30 days');

-- (d) a person editing a telemetry key: kept
INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, created_at)
SELECT 'a0000000-0000-4000-8000-000000000003', 'update_platform_config', 'platform_config', 'netopia_proxy_health_at',
       '{"value": "a"}', '{"value": "b"}', now() - make_interval(days => g)
FROM generate_series(1, 5) g;

-- (e) 5000 ordinary admin actions by a person: kept
INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, reason, created_at)
SELECT 'a0000000-0000-4000-8000-000000000003', 'approve_driver', 'driver', gen_random_uuid()::text, 'docs ok',
       now() - make_interval(mins => g * 25 + 3)
FROM generate_series(1, 5000) g;

ANALYZE public.admin_actions;
