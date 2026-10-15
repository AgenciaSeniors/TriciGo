-- Rows the 00663 tests read. Runs as the owner (RLS does not apply).
SET ROLE postgres;
-- The two system accounts (the platform and the deleted users), a signed-in user with nothing
-- of their own (Sam), and a driver stuck in sign-up (Pablo, never seen online).
INSERT INTO public.users (id, full_name) VALUES
  ('00000000-0000-0000-0000-000000000001', 'TriciGo'),
  ('00000000-0000-0000-0000-000000000099', 'Usuario eliminado'),
  ('c0000000-0000-4000-8000-000000000009', 'Sam Sinnada'),
  ('c0000000-0000-4000-8000-000000000005', 'Pablo Pendiente');
INSERT INTO public.driver_profiles (id, user_id, status, last_heartbeat_at)
  VALUES ('d0000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000005', 'pending_verification', NULL);
INSERT INTO public.rides (id, customer_id, driver_id, status, pickup_address, dropoff_address,
  share_token, pickup_lat, pickup_lng, canceled_at, canceled_by, cancellation_reason, created_at)
VALUES
  ('f0000000-0000-4000-8000-000000000010', 'c0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000002', 'canceled', 'Calle 23 e/ L y M', 'Prado 100',
   'tok-secret', 23.13, -82.38, now() - interval '1 day', 'c0000000-0000-4000-8000-000000000001',
   'changed_plans', now() - interval '1 day'),
  ('f0000000-0000-4000-8000-000000000011', 'c0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000002', 'completed', 'Obispo 5', 'Línea 9',
   NULL, NULL, NULL, NULL, NULL, NULL, now() - interval '2 days'),
  ('f0000000-0000-4000-8000-000000000012', 'c0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000002', 'canceled', 'G y 25', 'Prado 1',
   NULL, NULL, NULL, now(), 'c0000000-0000-4000-8000-000000000002', 'no_show', now()),
  ('f0000000-0000-4000-8000-000000000013', 'c0000000-0000-4000-8000-000000000001',
   NULL, 'canceled', 'Malecón 1', 'Paseo 2',
   NULL, NULL, NULL, now(), NULL, 'searching_abandoned', now()),
  -- canceled by Ana (admin): staff
  ('f0000000-0000-4000-8000-000000000014', 'c0000000-0000-4000-8000-000000000001',
   NULL, 'canceled', 'Neptuno 3', 'Zanja 4',
   NULL, NULL, NULL, now(), 'a0000000-0000-4000-8000-000000000001', 'admin_cleanup', now()),
  -- canceled by Sam, a customer who is not this ride's: unknown
  ('f0000000-0000-4000-8000-000000000015', 'c0000000-0000-4000-8000-000000000001',
   NULL, 'canceled', 'Monte 5', 'Reina 6',
   NULL, NULL, NULL, now(), 'c0000000-0000-4000-8000-000000000009', NULL, now());
UPDATE public.rides SET final_fare_cup = 1500, completed_at = now() - interval '2 days',
                        wait_time_minutes = 4, wait_time_charge_cup = 120, wallet_ratio = 0.5
  WHERE id = 'f0000000-0000-4000-8000-000000000011';
UPDATE public.driver_profiles
  SET identity_number = '90010112345', address = 'Calle Secreta 1', municipality = 'Plaza',
      province = 'La Habana', has_criminal_record = false, current_location = 'POINT(-82.38 23.13)',
      last_heartbeat_at = now()
  WHERE id = 'd0000000-0000-4000-8000-000000000002';
INSERT INTO public.vehicles (driver_id, type, make, model, year, color, plate_number)
  VALUES ('d0000000-0000-4000-8000-000000000002', 'triciclo', 'Tricimoto', 'T1', 2022, 'rojo', 'P123456');
INSERT INTO public.driver_documents (driver_id, document_type, storage_path, file_name, is_verified)
  VALUES ('d0000000-0000-4000-8000-000000000002', 'national_id', 'driver-docs/d2/id.jpg', 'id.jpg', true);
INSERT INTO public.driver_score_events (driver_id, event_type, delta)
  VALUES ('d0000000-0000-4000-8000-000000000002', 'ride_completed', 1);
INSERT INTO public.driver_outreach_log (driver_profile_id, admin_id, channel, note)
  VALUES ('d0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'whatsapp', 'seed');
INSERT INTO public.reviews (id, ride_id, reviewer_id, reviewee_id, rating, comment)
  VALUES ('b0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000011',
          'c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 2, 'Llegó tarde');
-- Diego's review of Carla: not public (00645), so only its two people, admins and marketing read it.
INSERT INTO public.reviews (id, ride_id, reviewer_id, reviewee_id, rating, comment)
  VALUES ('b0000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000011',
          'c0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001', 3, 'No estaba en la esquina');
INSERT INTO public.review_tags (review_id, tag_key) VALUES ('b0000000-0000-4000-8000-000000000001', 'late'),
                                                          ('b0000000-0000-4000-8000-000000000002', 'late_rider');
INSERT INTO public.support_tickets (id, user_id, subject, description)
  VALUES ('b1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'Cobro', 'Me cobraron dos veces'),
         ('b1000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000003', 'Mi viaje', 'Ticket propio de Mara');
INSERT INTO public.ticket_messages (ticket_id, sender_id, message)
  VALUES ('b1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'Hola');
INSERT INTO public.lost_items (id, ride_id, reporter_id, driver_id, description, category, status,
  driver_response, driver_found, return_fee_cup, return_location, return_notes, admin_notes)
  VALUES ('b4000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000011',
          'c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'Mochila azul',
          'bag', 'driver_responded', 'La tengo', true, 200, 'Calle 23 y L', 'Entregar de 5 a 6', 'nota interna');
INSERT INTO public.ride_transitions (ride_id, from_status, to_status, actor_id)
  VALUES ('f0000000-0000-4000-8000-000000000010', 'searching', 'canceled', 'c0000000-0000-4000-8000-000000000001');
INSERT INTO public.ride_pricing_snapshots (ride_id, snapshot_type, total)
  VALUES ('f0000000-0000-4000-8000-000000000011', 'estimate', 1500);
INSERT INTO public.ride_disputes (id, ride_id, opened_by, reason, description, evidence_urls, refund_amount_trc, admin_notes)
  VALUES ('b2000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000011',
          'c0000000-0000-4000-8000-000000000001', 'overcharge', 'Me cobró de más',
          ARRAY['https://example.test/evidence.jpg'], 50, 'nota de admin');
INSERT INTO public.incident_reports (id, ride_id, reported_by, against_user_id, type, description, evidence_urls)
  VALUES ('b3000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000011',
          'c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'rude_behavior',
          'Fue grosero', ARRAY['https://example.test/incident.jpg']);
INSERT INTO public.poi_import_queue (name, status) VALUES ('Paladar X', 'pending'), ('Paladar X', 'failed'), ('Hotel Y', 'done');
INSERT INTO public.push_registration_status (user_id, app, outcome)
  VALUES ('c0000000-0000-4000-8000-000000000001', 'client', 'denied'),
         ('c0000000-0000-4000-8000-000000000002', 'driver', 'registered');
INSERT INTO public.user_devices (user_id, push_token, platform)
  VALUES ('c0000000-0000-4000-8000-000000000002', 'ExponentPushToken[x]', 'android');
INSERT INTO public.app_opens (user_id, app, device_id, app_version, platform)
  VALUES ('c0000000-0000-4000-8000-000000000001', 'client', 'dev-1', '1.7.3', 'android');
INSERT INTO public.payment_intents (user_id, status, amount_usd, error_message, provider_error_code)
  VALUES ('c0000000-0000-4000-8000-000000000001', 'failed', 20, 'Invalid card number', NULL),
         ('c0000000-0000-4000-8000-000000000001', 'failed', 10, 'Invalid card number', NULL),
         ('c0000000-0000-4000-8000-000000000001', 'failed', 10, 'Error: netopia', 'E99'),
         ('c0000000-0000-4000-8000-000000000001', 'paid', 10, NULL, NULL);
INSERT INTO public.validation_events (driver_id, event_type, properties)
  VALUES ('d0000000-0000-4000-8000-000000000002', 'driver_ride_rejected', '{"profit_level":"low"}');
INSERT INTO public.cuba_pois (id, name, name_normalized, tricigo_category, location, is_admin, is_active, updated_at)
  VALUES (1, 'Coppelia', 'coppelia', 'food', 'POINT(-82.3830 23.1400)', true, true, now());
INSERT INTO public.cuba_pois_submissions (name, tricigo_category, location, status)
  VALUES ('Paladar Nuevo', 'restaurant', 'POINT(-82.40 23.13)', 'pending');
RESET ROLE;
