-- Scaffold for the 00653 rehearsal: the five tables with prod's columns, RLS
-- policies and grants (read from prod on 2026-10-11), auth.uid(), is_admin()
-- (00592) and current_user_role(), and minimal rides / driver_profiles / users
-- with RLS like prod's (customer or assigned driver).
-- The AFTER triggers that call Edge Functions in prod are stand-ins that write
-- what they would send into public.outbox: the chat push, the lost-item push and
-- the SOS text (with the share token of the ride, which is what leaked).
-- report_review is a SECURITY DEFINER stand-in that inserts like prod's.
-- A NON-superuser role (prod: postgres) owns everything; run.sh applies the
-- migration as that role.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tricigo_owner') THEN CREATE ROLE tricigo_owner NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, tricigo_owner TO pgtest;
GRANT anon, authenticated, service_role TO tricigo_owner;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO tricigo_owner;
ALTER SCHEMA auth OWNER TO tricigo_owner;

SET ROLE tricigo_owner;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');
CREATE TYPE public.incident_type AS ENUM ('sos', 'safety_concern', 'payment_dispute', 'vehicle_issue',
  'driver_behavior', 'passenger_behavior', 'review_abuse');
CREATE TYPE public.incident_severity AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE public.incident_status AS ENUM ('open', 'investigating', 'resolved', 'dismissed');

CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$
;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role public.user_role NOT NULL DEFAULT 'customer',
  full_name text
);
GRANT SELECT ON public.users TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.current_user_role()
 RETURNS public.user_role
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT COALESCE(
    (SELECT role FROM users WHERE id = auth.uid()),
    'customer'::user_role
  );
$function$;
REVOKE ALL ON FUNCTION public.current_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  -- No JWT subject: anon, service role, cron, triggers without a user. None of
  -- them is an admin, and anon may not even call current_user_role().
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() IN ('admin', 'super_admin');
END;
$function$;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated, service_role;

CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id)
);
ALTER TABLE public.driver_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY dp_select_own ON public.driver_profiles FOR SELECT USING (user_id = auth.uid() OR is_admin());
GRANT SELECT ON public.driver_profiles TO anon, authenticated, service_role;

CREATE TABLE public.rides (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.users(id),
  driver_id uuid REFERENCES public.driver_profiles(id),
  status public.ride_status NOT NULL,
  share_token text
);
ALTER TABLE public.rides ENABLE ROW LEVEL SECURITY;
CREATE POLICY r_select ON public.rides FOR SELECT USING (
  customer_id = auth.uid()
  OR driver_id IN (SELECT dp.id FROM public.driver_profiles dp WHERE dp.user_id = auth.uid())
  OR is_admin());
GRANT SELECT ON public.rides TO anon, authenticated, service_role;

-- What the Edge Function calls would have sent.
CREATE TABLE public.outbox (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  target uuid,
  detail text
);
GRANT SELECT ON public.outbox TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- ride_messages (prod: rm_insert, rm_select)
CREATE TABLE public.ride_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid REFERENCES public.rides(id),
  sender_id uuid REFERENCES public.users(id),
  body text,
  created_at timestamptz DEFAULT now(),
  read_at timestamptz
);
ALTER TABLE public.ride_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY rm_insert ON public.ride_messages FOR INSERT WITH CHECK (
  (sender_id = auth.uid()) AND ((ride_id IN (SELECT rides.id FROM rides WHERE (rides.customer_id = auth.uid())))
   OR (ride_id IN (SELECT r.id FROM (rides r JOIN driver_profiles dp ON ((r.driver_id = dp.id))) WHERE (dp.user_id = auth.uid())))));
CREATE POLICY rm_select ON public.ride_messages FOR SELECT USING (
  is_admin() OR (ride_id IN (SELECT rides.id FROM rides WHERE (rides.customer_id = (SELECT auth.uid()))))
  OR (ride_id IN (SELECT r.id FROM (rides r JOIN driver_profiles dp ON ((r.driver_id = dp.id)))
      WHERE ((dp.user_id = (SELECT auth.uid())) AND (r.status = ANY (ARRAY['accepted'::ride_status,
        'driver_en_route'::ride_status, 'arrived_at_pickup'::ride_status, 'in_progress'::ride_status,
        'arrived_at_destination'::ride_status, 'disputed'::ride_status]))))));
GRANT ALL ON public.ride_messages TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.notify_new_chat_message()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog' AS $$
DECLARE v_ride record; v_to uuid;
BEGIN
  SELECT r.customer_id, dp.user_id AS driver_user INTO v_ride
    FROM rides r LEFT JOIN driver_profiles dp ON dp.id = r.driver_id WHERE r.id = NEW.ride_id;
  v_to := CASE WHEN NEW.sender_id = v_ride.customer_id THEN v_ride.driver_user ELSE v_ride.customer_id END;
  INSERT INTO outbox (kind, target, detail) VALUES ('chat_push', v_to, left(NEW.body, 100));
  RETURN NEW;
END $$;
CREATE TRIGGER trg_push_new_message AFTER INSERT ON public.ride_messages
  FOR EACH ROW EXECUTE FUNCTION public.notify_new_chat_message();

-- lost_items (prod: li_admin_update, lost_items_insert, lost_items_update, lost_items_select)
CREATE TABLE public.lost_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid REFERENCES public.rides(id),
  reporter_id uuid REFERENCES public.users(id),
  driver_id uuid REFERENCES public.users(id),
  description text,
  category text DEFAULT 'other',
  photo_urls text[] DEFAULT '{}',
  status text DEFAULT 'reported',
  driver_response text,
  driver_found boolean,
  return_fee_cup integer,
  return_location text,
  return_notes text,
  admin_notes text,
  resolved_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  resolved_at timestamptz
);
ALTER TABLE public.lost_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY li_admin_select ON public.lost_items FOR SELECT USING (is_admin());
CREATE POLICY li_admin_update ON public.lost_items FOR UPDATE TO authenticated USING (is_admin());
CREATE POLICY lost_items_insert ON public.lost_items FOR INSERT WITH CHECK (reporter_id = auth.uid());
CREATE POLICY lost_items_select ON public.lost_items FOR SELECT
  USING ((reporter_id = auth.uid()) OR (driver_id = auth.uid()) OR is_admin());
CREATE POLICY lost_items_update ON public.lost_items FOR UPDATE
  USING ((reporter_id = auth.uid()) OR (driver_id = auth.uid()) OR is_admin());
GRANT ALL ON public.lost_items TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.notify_lost_item_change()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO outbox (kind, target, detail) VALUES ('lost_item_push', NEW.driver_id, NEW.description);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_lost_item_notifications AFTER INSERT OR UPDATE ON public.lost_items
  FOR EACH ROW EXECUTE FUNCTION public.notify_lost_item_change();
CREATE TRIGGER trg_lost_items_updated_at BEFORE UPDATE ON public.lost_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- support_tickets / ticket_messages (prod policies)
CREATE TABLE public.support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id),
  ride_id uuid REFERENCES public.rides(id),
  category text,
  subject text,
  description text,
  status text DEFAULT 'open',
  priority text DEFAULT 'normal',
  assigned_to uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz,
  resolved_at timestamptz
);
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins update tickets" ON public.support_tickets FOR UPDATE USING (EXISTS (SELECT 1 FROM users
  WHERE ((users.id = auth.uid()) AND (users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role])))));
CREATE POLICY "Users create own tickets" ON public.support_tickets FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users read own tickets" ON public.support_tickets FOR SELECT USING ((user_id = auth.uid()) OR (EXISTS
  (SELECT 1 FROM users WHERE ((users.id = auth.uid()) AND (users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role]))))));
GRANT ALL ON public.support_tickets TO anon, authenticated, service_role;

CREATE TABLE public.ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid REFERENCES public.support_tickets(id),
  sender_id uuid REFERENCES public.users(id),
  message text,
  is_admin boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.ticket_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Ticket participants insert messages" ON public.ticket_messages FOR INSERT WITH CHECK (
  (sender_id = auth.uid()) AND (EXISTS (SELECT 1 FROM support_tickets WHERE ((support_tickets.id = ticket_messages.ticket_id)
   AND ((support_tickets.user_id = auth.uid()) OR (EXISTS (SELECT 1 FROM users WHERE ((users.id = auth.uid())
   AND (users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role]))))))))));
CREATE POLICY "Ticket participants read messages" ON public.ticket_messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM support_tickets WHERE ((support_tickets.id = ticket_messages.ticket_id)
   AND ((support_tickets.user_id = auth.uid()) OR (EXISTS (SELECT 1 FROM users WHERE ((users.id = auth.uid())
   AND (users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role])))))))));
GRANT ALL ON public.ticket_messages TO anon, authenticated, service_role;

-- incident_reports (prod: ir_admin, ir_insert, ir_select)
CREATE TABLE public.incident_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid REFERENCES public.rides(id),
  reported_by uuid REFERENCES public.users(id),
  against_user_id uuid REFERENCES public.users(id),
  type public.incident_type,
  severity public.incident_severity DEFAULT 'medium',
  description text,
  evidence_urls text[] DEFAULT '{}',
  status public.incident_status DEFAULT 'open',
  resolved_by uuid,
  resolved_at timestamptz,
  resolution_notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  review_id uuid
);
ALTER TABLE public.incident_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY ir_admin ON public.incident_reports USING (is_admin());
CREATE POLICY ir_insert ON public.incident_reports FOR INSERT WITH CHECK (reported_by = (SELECT auth.uid()));
CREATE POLICY ir_select ON public.incident_reports FOR SELECT USING (
  (reported_by = (SELECT auth.uid())) OR (against_user_id = (SELECT auth.uid())) OR is_admin());
GRANT ALL ON public.incident_reports TO anon, authenticated, service_role;

-- The SOS text carries the share link of NEW.ride_id (prod: notify_trusted_contacts_on_sos).
CREATE OR REPLACE FUNCTION public.notify_trusted_contacts_on_sos()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog' AS $$
DECLARE v_token text;
BEGIN
  IF NEW.type <> 'sos' THEN RETURN NEW; END IF;
  IF NEW.ride_id IS NOT NULL THEN SELECT share_token INTO v_token FROM rides WHERE id = NEW.ride_id; END IF;
  INSERT INTO outbox (kind, target, detail) VALUES ('sos_sms', NEW.reported_by, coalesce(v_token, '-'));
  RETURN NEW;
END $$;
CREATE TRIGGER incident_reports_notify_sos AFTER INSERT ON public.incident_reports
  FOR EACH ROW EXECUTE FUNCTION public.notify_trusted_contacts_on_sos();

-- report_review: a SECURITY DEFINER caller that writes review_id (prod's body, minus the review lookup).
CREATE OR REPLACE FUNCTION public.report_review_standin(p_ride uuid, p_against uuid, p_review uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog' AS $$
BEGIN
  INSERT INTO public.incident_reports (ride_id, reported_by, against_user_id, review_id, type, severity, description, status)
  VALUES (p_ride, auth.uid(), p_against, p_review, 'review_abuse', 'low', 'Reseña reportada como abusiva', 'open');
END $$;
GRANT EXECUTE ON FUNCTION public.report_review_standin(uuid, uuid, uuid) TO authenticated;

RESET ROLE;
