-- Seed for the 00668 rehearsal. Runs as pgtest (superuser: no RLS) after stubs.sql,
-- prod-objects.sql and 00667, so the operator role already exists.
-- One account per role, a ride of each kind the tests need, and one row in every table the
-- operator gets a SELECT policy on, owned by nobody the tests sign in as.
INSERT INTO public.users (id, role, full_name, email, phone, is_active, email_verified_at) VALUES
  ('a2000000-0000-4000-8000-000000000001', 'super_admin', 'Sam Super',       'sam@example.com',   '+5350000001', true,  now()),
  ('a2000000-0000-4000-8000-000000000002', 'admin',       'Ana Admin',       'ana@example.com',   '+5350000002', true,  now()),
  ('a2000000-0000-4000-8000-000000000003', 'marketing',   'Mia Marketing',   'mia@example.com',   '+5350000003', true,  now()),
  ('a2000000-0000-4000-8000-000000000004', 'operator',    'Olga Operadora',  'olga@example.com',  '+5350000004', true,  now()),
  ('a2000000-0000-4000-8000-000000000005', 'operator',    'Otto Inactivo',   'otto@example.com',  '+5350000005', false, now()),
  ('a2000000-0000-4000-8000-000000000006', 'customer',    'Carl Cliente',    'carl@example.com',  '+5350000006', true,  now()),
  ('a2000000-0000-4000-8000-000000000007', 'driver',      'Diego Conductor', 'diego@example.com', '+5350000007', true,  now());

INSERT INTO public.driver_profiles (id, user_id, status, is_online, current_location, current_heading) VALUES
  ('d2000000-0000-4000-8000-000000000007', 'a2000000-0000-4000-8000-000000000007', 'approved', true, 'POINT(-82.38 23.13)', 90);

INSERT INTO public.vehicles (id, driver_id, type, plate_number, is_active) VALUES
  ('e2000000-0000-4000-8000-000000000007', 'd2000000-0000-4000-8000-000000000007', 'triciclo', 'T-0007', true);

-- R1: Carl's ride with Diego. R2: Olga's own search (she rides as a passenger).
INSERT INTO public.rides (id, customer_id, driver_id, status, service_type, ride_mode, pickup_address, dropoff_address) VALUES
  ('f2000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000006', 'd2000000-0000-4000-8000-000000000007',
   'accepted', 'triciclo_basico', 'cargo', 'Calle 23 e/ L y M', 'Malecón y Prado'),
  ('f2000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000004', NULL,
   'searching', 'triciclo_basico', 'passenger', 'Calle G e/ 21 y 23', 'Parque Central');

INSERT INTO public.delivery_details (ride_id, recipient_name, recipient_phone, delivery_otp) VALUES
  ('f2000000-0000-4000-8000-000000000001', 'Rosa', '+5351111111', '4821');

INSERT INTO public.corporate_accounts (id, created_by, status) VALUES
  ('c2000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000007', 'approved');

-- One ownerless row in each remaining table of the operator's reads.
DO $seed$
DECLARE
  v_tbl text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY[
    'ride_transitions', 'ride_pricing_snapshots', 'ride_messages', 'driver_documents',
    'driver_score_events', 'driver_contracts', 'selfie_checks', 'wallet_accounts',
    'ledger_transactions', 'ledger_entries', 'wallet_transfers', 'wallet_recharge_requests',
    'wallet_receipts', 'cancellation_penalties', 'reviews', 'ticket_messages', 'support_tickets',
    'ride_disputes', 'incident_reports', 'lost_items', 'fraud_alerts', 'cancellation_reviews',
    'corporate_employees', 'corporate_rides', 'driver_fleets', 'fleet_members', 'promotions',
    'referrals', 'stuck_ride_alerts']
  LOOP
    EXECUTE format('INSERT INTO public.%I DEFAULT VALUES', v_tbl);
  END LOOP;
END
$seed$;

INSERT INTO storage.objects (bucket_id, name) VALUES
  ('driver-documents', 'driver-docs/d2000000-0000-4000-8000-000000000007/license/1.jpg'),
  ('driver-contracts', 'a2000000-0000-4000-8000-000000000007/contract-es.pdf'),
  ('receipts',         'a2000000-0000-4000-8000-000000000006/receipt.pdf'),
  ('avatars',          'a2000000-0000-4000-8000-000000000006/me.png');
