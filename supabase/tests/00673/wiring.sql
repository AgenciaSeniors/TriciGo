-- The triggers of the tables 00673 writes, as in prod (pg_get_triggerdef, 2026-11-02), limited to
-- the ones whose functions live-bodies.sql loads. The lost-item notices, the SOS alerts, the audit
-- and the ride side effects are left out: the prod rehearsal runs with all of them.
CREATE TRIGGER trg_driver_profiles_inactive_stays_offline BEFORE UPDATE OF is_online ON public.driver_profiles FOR EACH ROW EXECUTE FUNCTION public.tg_driver_profiles_inactive_stays_offline();
CREATE TRIGGER trg_driver_profiles_protect_admin_fields BEFORE UPDATE ON public.driver_profiles FOR EACH ROW EXECUTE FUNCTION public.tg_driver_profiles_protect_admin_fields();
CREATE TRIGGER trg_driver_profiles_shift_intent BEFORE UPDATE ON public.driver_profiles FOR EACH ROW EXECUTE FUNCTION public.tg_driver_profiles_shift_intent();
CREATE TRIGGER trg_incident_reports_client_guard BEFORE INSERT ON public.incident_reports FOR EACH ROW EXECUTE FUNCTION public.tg_incident_reports_client_guard();
CREATE TRIGGER trg_lost_items_client_guard BEFORE INSERT OR UPDATE ON public.lost_items FOR EACH ROW EXECUTE FUNCTION public.tg_lost_items_client_guard();
CREATE TRIGGER trg_lost_items_updated_at BEFORE UPDATE ON public.lost_items FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_reviews_client_guard BEFORE INSERT ON public.reviews FOR EACH ROW EXECUTE FUNCTION public.tg_reviews_client_guard();
CREATE TRIGGER trg_update_rating_avg AFTER INSERT OR UPDATE ON public.reviews FOR EACH ROW EXECUTE FUNCTION public.update_rating_avg();
CREATE TRIGGER set_ride_disputes_updated_at BEFORE UPDATE ON public.ride_disputes FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_ride_disputes_protect_columns BEFORE UPDATE ON public.ride_disputes FOR EACH ROW EXECUTE FUNCTION public.tg_ride_disputes_protect_columns();
CREATE TRIGGER rides_client_write_guard BEFORE UPDATE ON public.rides FOR EACH ROW EXECUTE FUNCTION public.tg_rides_client_write_guard();
CREATE TRIGGER trg_enforce_ride_transition BEFORE UPDATE OF status ON public.rides FOR EACH ROW WHEN ((old.status IS DISTINCT FROM new.status)) EXECUTE FUNCTION public.enforce_ride_transition();
CREATE TRIGGER trg_enforce_ride_update_columns BEFORE UPDATE ON public.rides FOR EACH ROW EXECUTE FUNCTION public.enforce_ride_update_columns();
CREATE TRIGGER trg_support_tickets_client_guard BEFORE INSERT ON public.support_tickets FOR EACH ROW EXECUTE FUNCTION public.tg_support_tickets_client_guard();
CREATE TRIGGER trg_support_tickets_client_update_guard BEFORE UPDATE ON public.support_tickets FOR EACH ROW EXECUTE FUNCTION public.tg_support_tickets_client_update_guard();
CREATE TRIGGER trg_ticket_messages_client_guard BEFORE INSERT ON public.ticket_messages FOR EACH ROW EXECUTE FUNCTION public.tg_ticket_messages_client_guard();
CREATE TRIGGER trg_users_protect_admin_fields BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.tg_users_protect_admin_fields();
-- The transitions 00673 meets (disputed -> completed is admin-only).
INSERT INTO public.valid_transitions (from_status, to_status, allowed_roles) VALUES
  ('completed', 'disputed', '{customer,driver,admin,super_admin}'),
  ('disputed', 'completed', '{admin,super_admin}');
