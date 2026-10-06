-- Extra seed for the 00613 rehearsal, on top of supabase/tests/00612/scaffold.sql with 00612
-- applied (the state of prod on 2026-10-06). Inserted as the owner, with no JWT, so the guard
-- keeps the values as written.
SET ROLE tricigo_owner;
-- Fede and Gabi: two more customers to invite.
INSERT INTO auth.users (id) VALUES
  ('0f000000-0000-4000-8000-000000000006'), ('09000000-0000-4000-8000-000000000007');
INSERT INTO public.users (id, role, full_name) VALUES
  ('0f000000-0000-4000-8000-000000000006', 'customer', 'Fede'),
  ('09000000-0000-4000-8000-000000000007', 'customer', 'Gabi');
-- R3: Ana's ride split the way the apps did before 00613 (50 %, then 33.33 %).
-- R4: Ana's ride whose split with Beto is already paid.
INSERT INTO public.rides (id, customer_id, driver_id, status, payment_method, is_split) VALUES
  ('f3000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000004', 'accepted', 'tricicoin', true),
  ('f4000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000004', 'accepted', 'tricicoin', true);
INSERT INTO public.ride_splits (ride_id, user_id, share_pct, invited_by, created_at) VALUES
  ('f3000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000002', 50, 'a0000000-0000-4000-8000-000000000001', now() - interval '2 minutes'),
  ('f3000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000005', 33.33, 'a0000000-0000-4000-8000-000000000001', now() - interval '1 minute');
INSERT INTO public.ride_splits (ride_id, user_id, share_pct, invited_by, accepted_at, payment_status, paid_at, amount_trc) VALUES
  ('f4000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000002', 50, 'a0000000-0000-4000-8000-000000000001', now(), 'paid', now(), 2500);
RESET ROLE;
