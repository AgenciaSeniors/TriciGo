-- Seed for the 00656 rehearsal. D = 2026-10-07 (Havana, UTC-4 that day), D-1 = 2026-10-06,
-- D-7 = 2026-09-30. Every expected number in run.sh comes from these rows; the comments say which
-- rows count where.
SET ROLE postgres;
CREATE FUNCTION pg_temp.h(text) RETURNS timestamptz LANGUAGE sql AS $$ SELECT ($1::timestamp AT TIME ZONE 'America/Havana') $$;
CREATE FUNCTION pg_temp.pt(lng float8, lat float8) RETURNS extensions.geography LANGUAGE sql AS
  $$ SELECT extensions.ST_SetSRID(extensions.ST_MakePoint(lng, lat), 4326)::extensions.geography $$;

-- People. Staff: A1 admin (Google identity, mixed-case address), S1 super_admin (verified),
-- M1 marketing (Google identity), M2 marketing (no proof: never a recipient), A3 admin (blocked),
-- the platform account (never a recipient). Customers C1-C5, test customer T1, drivers DU1-DU3,
-- test driver DU4.
INSERT INTO public.users (id, email, full_name, role, is_active, is_test, created_at, signup_code, email_verified_at) VALUES
  ('00000000-0000-0000-0000-000000000001', 'platform@tricigo.system', 'TriciGo Platform', 'super_admin', true, false, '2026-01-01', NULL, '2026-01-01'),
  ('a1000000-0000-4000-8000-000000000001', 'ana@example.com',  'Ana Admin',     'admin',       true,  false, '2026-01-01', NULL, NULL),
  ('a1000000-0000-4000-8000-000000000002', 'sam@example.com',  'Sam Super',     'super_admin', true,  false, '2026-01-01', NULL, '2026-01-01'),
  ('a1000000-0000-4000-8000-000000000003', 'mia@example.com',  'Mia Marketing', 'marketing',   true,  false, '2026-01-01', NULL, NULL),
  ('a1000000-0000-4000-8000-000000000004', 'max@example.com',  'Max Marketing', 'marketing',   true,  false, '2026-01-01', NULL, NULL),
  ('a1000000-0000-4000-8000-000000000006', 'off@example.com',  'Off Admin',     'admin',       false, false, '2026-01-01', NULL, '2026-01-01'),
  ('c1000000-0000-4000-8000-000000000001', 'c1@example.com',   'Cliente Uno',   'customer',    true,  false, '2026-01-01', NULL, '2026-01-01'),
  ('c1000000-0000-4000-8000-000000000002', 'c2@example.com',   'Cliente Dos',   'customer',    true,  false, '2026-01-01', NULL, NULL),
  ('c1000000-0000-4000-8000-000000000003', 'c3@example.com',   'Cliente Tres',  'customer',    true,  false, pg_temp.h('2026-10-06 09:00'), NULL, NULL),
  ('c1000000-0000-4000-8000-000000000004', 'c4@example.com',   'Cliente Cuatro','customer',    true,  false, pg_temp.h('2026-10-07 10:00'), 'BACO1', NULL),
  ('c1000000-0000-4000-8000-000000000005', 'c5@example.com',   'Cliente Cinco', 'customer',    true,  false, pg_temp.h('2026-10-07 11:00'), 'RADIO', NULL),
  ('c1000000-0000-4000-8000-0000000000ff', 't1@example.com',   'Cuenta Prueba', 'customer',    true,  true,  pg_temp.h('2026-10-07 12:00'), 'BACO1', NULL),
  ('d1000000-0000-4000-8000-000000000001', 'du1@example.com',  'Chofer Uno',    'driver',      true,  false, '2026-01-01', NULL, NULL),
  ('d1000000-0000-4000-8000-000000000002', 'du2@example.com',  'Chofer Dos',    'driver',      true,  false, '2026-01-01', NULL, NULL),
  ('d1000000-0000-4000-8000-000000000003', 'du3@example.com',  'Chofer Tres',   'driver',      true,  false, pg_temp.h('2026-10-07 09:30'), NULL, NULL),
  ('d1000000-0000-4000-8000-0000000000ff', 'du4@example.com',  'Chofer Prueba', 'driver',      true,  true,  '2026-01-01', NULL, NULL);
INSERT INTO auth.identities (user_id, provider, identity_data) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'google', '{"email": "Ana@Example.com ", "email_verified": true}'),
  ('a1000000-0000-4000-8000-000000000003', 'google', '{"email": "mia@example.com", "email_verified": true}');

-- DP1 approved long ago; DP2 approved on D; DP3 registered on D, under review. DP4 (test driver
-- DU4) registered and approved on D: in neither count.
INSERT INTO public.driver_profiles (id, user_id, status, approved_at, created_at) VALUES
  ('e1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'approved', '2026-01-02', '2026-01-01'),
  ('e1000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000002', 'approved', pg_temp.h('2026-10-07 09:00'), '2026-09-01'),
  ('e1000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000003', 'under_review', NULL, pg_temp.h('2026-10-07 09:30')),
  ('e1000000-0000-4000-8000-0000000000ff', 'd1000000-0000-4000-8000-0000000000ff', 'approved', pg_temp.h('2026-10-07 09:15'), pg_temp.h('2026-10-07 08:45'));

INSERT INTO public.service_type_configs (slug, name_es) VALUES
  ('triciclo_basico', 'Triciclo'), ('auto_standard', 'Auto'), ('moto_standard', 'Moto'), ('auto_confort', 'Confort');

-- Two municipalities (level 6) with separate boxes. Plaza: (-82.39, 23.13); Centro Habana: (-82.37, 23.15).
INSERT INTO public.cuba_admin_areas (admin_level, name_es, geom) VALUES
  (6, 'Plaza', extensions.ST_Multi(extensions.ST_MakeEnvelope(-82.40, 23.12, -82.38, 23.14, 4326))),
  (6, 'Centro Habana', extensions.ST_Multi(extensions.ST_MakeEnvelope(-82.38, 23.14, -82.36, 23.16, 4326)));

-- Rides. D cohort (created on D by a real customer): R1 R2 R3 R4 R5 R6 R9 R13. R7 is a test customer's.
-- R8 was requested on D-1 and completed on D. R10 is D-1's, R11 is D-7's, R0 is C1's first ride.
-- R5's pickup is in the sea north of Havana and R9's far to the south-east: both outside every polygon.
-- R12 is the platform account's (never counts). R13 is real customer C5's, driven by test driver DP4:
-- it counts everywhere except drivers_with_ride. R14 is C2's earlier ride, finished on 2026-09-25 and
-- disputed since: C2's ride on D is not a first ride.
INSERT INTO public.rides (id, customer_id, driver_id, status, canceled_by, service_type, pickup_location, final_fare_cup, created_at, completed_at) VALUES
  ('f0000000-0000-4000-8000-000000000000', 'c1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'completed', NULL, 'triciclo_basico', pg_temp.pt(-82.39, 23.13), 100, pg_temp.h('2026-09-20 10:00'), pg_temp.h('2026-09-20 10:30')),
  ('f0000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'completed', NULL, 'triciclo_basico', pg_temp.pt(-82.39, 23.13), 1000, pg_temp.h('2026-10-07 08:10'), pg_temp.h('2026-10-07 08:40')),
  ('f0000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000001', 'completed', NULL, 'auto_standard',   pg_temp.pt(-82.37, 23.15), 2000, pg_temp.h('2026-10-07 13:00'), pg_temp.h('2026-10-07 13:30')),
  ('f0000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000002', 'canceled', 'c1000000-0000-4000-8000-000000000003', 'auto_standard', pg_temp.pt(-82.39, 23.13), NULL, pg_temp.h('2026-10-07 19:00'), NULL),
  ('f0000000-0000-4000-8000-000000000004', 'c1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002', 'canceled', 'd1000000-0000-4000-8000-000000000002', 'triciclo_basico', pg_temp.pt(-82.39, 23.13), NULL, pg_temp.h('2026-10-07 20:00'), NULL),
  ('f0000000-0000-4000-8000-000000000005', 'c1000000-0000-4000-8000-000000000002', NULL, 'canceled', 'c1000000-0000-4000-8000-000000000002', 'moto_standard', pg_temp.pt(-82.40, 23.25), NULL, pg_temp.h('2026-10-07 02:00'), NULL),
  ('f0000000-0000-4000-8000-000000000006', 'c1000000-0000-4000-8000-000000000003', NULL, 'canceled', NULL, 'moto_standard', pg_temp.pt(-82.37, 23.15), NULL, pg_temp.h('2026-10-07 23:59'), NULL),
  ('f0000000-0000-4000-8000-000000000007', 'c1000000-0000-4000-8000-0000000000ff', 'e1000000-0000-4000-8000-000000000001', 'completed', NULL, 'auto_standard', pg_temp.pt(-82.39, 23.13), 9999, pg_temp.h('2026-10-07 10:00'), pg_temp.h('2026-10-07 10:30')),
  ('f0000000-0000-4000-8000-000000000008', 'c1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'completed', NULL, 'triciclo_basico', pg_temp.pt(-82.39, 23.13), 500, pg_temp.h('2026-10-06 23:59'), pg_temp.h('2026-10-07 00:20')),
  ('f0000000-0000-4000-8000-000000000009', 'c1000000-0000-4000-8000-000000000004', NULL, 'searching', NULL, 'auto_confort', pg_temp.pt(-82.0, 22.0), NULL, pg_temp.h('2026-10-07 00:00'), NULL),
  ('f0000000-0000-4000-8000-000000000010', 'c1000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000001', 'completed', NULL, 'auto_standard', pg_temp.pt(-82.37, 23.15), 800, pg_temp.h('2026-10-06 12:00'), pg_temp.h('2026-10-06 12:30')),
  ('f0000000-0000-4000-8000-000000000011', 'c1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'completed', NULL, 'triciclo_basico', pg_temp.pt(-82.39, 23.13), 1200, pg_temp.h('2026-09-30 10:00'), pg_temp.h('2026-09-30 10:40')),
  ('f0000000-0000-4000-8000-000000000012', '00000000-0000-0000-0000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'completed', NULL, 'auto_standard', pg_temp.pt(-82.39, 23.13), 7777, pg_temp.h('2026-10-07 15:00'), pg_temp.h('2026-10-07 15:30')),
  ('f0000000-0000-4000-8000-000000000013', 'c1000000-0000-4000-8000-000000000005', 'e1000000-0000-4000-8000-0000000000ff', 'completed', NULL, 'auto_confort', pg_temp.pt(-82.37, 23.15), 3000, pg_temp.h('2026-10-07 16:00'), pg_temp.h('2026-10-07 16:40')),
  ('f0000000-0000-4000-8000-000000000014', 'c1000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000001', 'disputed', NULL, 'triciclo_basico', pg_temp.pt(-82.39, 23.13), 600, pg_temp.h('2026-09-25 10:00'), pg_temp.h('2026-09-25 10:30'));

-- R5 (no driver) got an offer that expired; R6 (no driver) got none.
INSERT INTO public.ride_offers (ride_id, status) VALUES ('f0000000-0000-4000-8000-000000000005', 'expired');

-- Final snapshots carry the commission; R1's estimate snapshot must be ignored.
INSERT INTO public.ride_pricing_snapshots (ride_id, snapshot_type, commission_amount) VALUES
  ('f0000000-0000-4000-8000-000000000001', 'final', 150),
  ('f0000000-0000-4000-8000-000000000001', 'estimate', 999),
  ('f0000000-0000-4000-8000-000000000002', 'final', 300),
  ('f0000000-0000-4000-8000-000000000007', 'final', 999),
  ('f0000000-0000-4000-8000-000000000008', 'final', 75),
  ('f0000000-0000-4000-8000-000000000010', 'final', 120),
  ('f0000000-0000-4000-8000-000000000011', 'final', 180),
  ('f0000000-0000-4000-8000-000000000012', 'final', 777),
  ('f0000000-0000-4000-8000-000000000013', 'final', 450);

-- Recharges: 5000 on D counts; the failed one and the test account's do not; 3000 is D-1's.
INSERT INTO public.payment_intents (user_id, amount_cup, status, paid_at) VALUES
  ('c1000000-0000-4000-8000-000000000001', 5000, 'completed', pg_temp.h('2026-10-07 10:00')),
  ('c1000000-0000-4000-8000-000000000002', 4000, 'failed',    pg_temp.h('2026-10-07 11:00')),
  ('c1000000-0000-4000-8000-0000000000ff', 7000, 'completed', pg_temp.h('2026-10-07 12:00')),
  ('c1000000-0000-4000-8000-000000000001', 3000, 'completed', pg_temp.h('2026-10-06 15:00'));

-- Heartbeats on D: DP1 online at 8 h (twice) and 13 h, DP2 at 19 h, DP1 offline at 10 h. Test driver
-- DP4 online at 16 h, an hour nobody else covers: it must not count.
INSERT INTO public.driver_heartbeat_log (driver_profile_id, beat_at, is_online) VALUES
  ('e1000000-0000-4000-8000-000000000001', pg_temp.h('2026-10-07 08:00'), true),
  ('e1000000-0000-4000-8000-000000000001', pg_temp.h('2026-10-07 08:30'), true),
  ('e1000000-0000-4000-8000-000000000001', pg_temp.h('2026-10-07 13:00'), true),
  ('e1000000-0000-4000-8000-000000000002', pg_temp.h('2026-10-07 19:00'), true),
  ('e1000000-0000-4000-8000-000000000001', pg_temp.h('2026-10-07 10:00'), false),
  ('e1000000-0000-4000-8000-0000000000ff', pg_temp.h('2026-10-07 16:10'), true);

-- Pending now: one open SOS, one incident under investigation, one resolved; two open disputes
-- (one past its deadline) and one resolved.
INSERT INTO public.incident_reports (type, status) VALUES ('sos', 'open'), ('driver_behavior', 'investigating'), ('vehicle_issue', 'resolved');
INSERT INTO public.ride_disputes (resolved_at, sla_resolution_deadline) VALUES
  (NULL, now() - interval '1 day'), (NULL, now() + interval '1 day'), (now() - interval '2 days', now() - interval '3 days');

-- Marketing. Referrals on D: C1 -> C4 counts; C1 -> T1 (test referee) and T1 -> C5 (test referrer)
-- do not. Promotion uses on D: three real ones; T1's SUPERFLA use does not count.
INSERT INTO public.acquisition_codes (code, label) VALUES ('BACO1', 'Baco Instagram'), ('RADIO', 'Radio Taino');
INSERT INTO public.referrals (referrer_id, referee_id, created_at) VALUES
  ('c1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000004', pg_temp.h('2026-10-07 14:00')),
  ('c1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-0000000000ff', pg_temp.h('2026-10-07 15:00')),
  ('c1000000-0000-4000-8000-0000000000ff', 'c1000000-0000-4000-8000-000000000005', pg_temp.h('2026-10-07 15:30'));
INSERT INTO public.campaigns (id, name, status, sent_at, push_sent, email_sent) VALUES
  ('ca000000-0000-4000-8000-000000000001', 'Promo sabado', 'sent',   pg_temp.h('2026-10-07 09:00'), 10, 4),
  ('ca000000-0000-4000-8000-000000000003', 'Prueba',       'failed', pg_temp.h('2026-10-07 15:00'), 0, 0),
  ('ca000000-0000-4000-8000-000000000002', 'Aviso',        'sent',   pg_temp.h('2026-10-06 09:00'), 5, 0);
INSERT INTO public.promotions (id, code) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'BIENVENIDA'), ('b0000000-0000-4000-8000-000000000002', 'SUPERFLA');
INSERT INTO public.promotion_uses (promotion_id, user_id, created_at) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000004', pg_temp.h('2026-10-07 10:00')),
  ('b0000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000005', pg_temp.h('2026-10-07 11:00')),
  ('b0000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', pg_temp.h('2026-10-07 12:00')),
  ('b0000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-0000000000ff', pg_temp.h('2026-10-07 13:00'));
RESET ROLE;
