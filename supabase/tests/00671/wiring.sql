-- The rides triggers 00671 patches, as in prod (pg_get_triggerdef), and prod's EXECUTE grants on
-- the functions it patches (has_function_privilege, 2026-11-02).
CREATE TRIGGER trg_enforce_ride_transition BEFORE UPDATE OF status ON public.rides FOR EACH ROW WHEN ((old.status IS DISTINCT FROM new.status)) EXECUTE FUNCTION public.enforce_ride_transition();
CREATE TRIGGER trg_enforce_ride_update_columns BEFORE UPDATE ON public.rides FOR EACH ROW EXECUTE FUNCTION public.enforce_ride_update_columns();
CREATE TRIGGER trg_rides_validate_actuals BEFORE UPDATE ON public.rides FOR EACH ROW EXECUTE FUNCTION public.tg_rides_validate_actuals();

REVOKE ALL ON FUNCTION public.enforce_ride_transition(), public.enforce_ride_update_columns(),
  public.tg_rides_validate_actuals() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_ride_and_pay(uuid,uuid,integer,integer),
  public.admin_offer_ride_to_driver(uuid,uuid), public.admin_assign_ride_to_driver(uuid,uuid,text),
  public.admin_change_ride_service(uuid,text,integer,text,text),
  public.admin_release_active_ride(uuid,text,uuid,text), public.admin_advance_active_ride(uuid,text,uuid,text),
  public.admin_complete_active_ride(uuid,text,uuid,integer,text), public.admin_cancel_ride(uuid,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_ride_and_pay(uuid,uuid,integer,integer),
  public.admin_offer_ride_to_driver(uuid,uuid), public.admin_assign_ride_to_driver(uuid,uuid,text),
  public.admin_change_ride_service(uuid,text,integer,text,text),
  public.admin_release_active_ride(uuid,text,uuid,text), public.admin_advance_active_ride(uuid,text,uuid,text),
  public.admin_complete_active_ride(uuid,text,uuid,integer,text), public.admin_cancel_ride(uuid,text)
  TO authenticated, service_role;
