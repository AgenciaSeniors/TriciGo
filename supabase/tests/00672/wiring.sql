-- The triggers of the tables 00672 writes, as in prod (pg_get_triggerdef, 2026-11-02), limited to
-- the ones whose functions live-bodies.sql loads. The fleet invitation linking trigger (00598) and
-- the audit and e-mail triggers are left out: the prod rehearsal runs with all of them.
CREATE TRIGGER trg_corporate_accounts_protect_admin_fields BEFORE UPDATE ON public.corporate_accounts FOR EACH ROW EXECUTE FUNCTION public.tg_corporate_accounts_protect_admin_fields();
CREATE TRIGGER trg_driver_documents_protect_review BEFORE INSERT OR UPDATE ON public.driver_documents FOR EACH ROW EXECUTE FUNCTION public.tg_driver_documents_protect_review();
CREATE TRIGGER trg_driver_documents_validate_mime BEFORE INSERT OR UPDATE OF mime_type ON public.driver_documents FOR EACH ROW EXECUTE FUNCTION public.tg_driver_documents_validate_mime();
CREATE TRIGGER trg_driver_outreach_log_stamp BEFORE INSERT ON public.driver_outreach_log FOR EACH ROW EXECUTE FUNCTION public.tg_driver_outreach_log_stamp();
CREATE TRIGGER dp_ensure_driver_role_and_tricicoin AFTER INSERT OR UPDATE OF status ON public.driver_profiles FOR EACH ROW EXECUTE FUNCTION public.ensure_driver_role_and_tricicoin_on_approval();
CREATE TRIGGER trg_driver_profiles_protect_admin_fields BEFORE UPDATE ON public.driver_profiles FOR EACH ROW EXECUTE FUNCTION public.tg_driver_profiles_protect_admin_fields();
CREATE TRIGGER trg_fleet_members_protect BEFORE INSERT OR UPDATE ON public.fleet_members FOR EACH ROW EXECUTE FUNCTION public.tg_fleet_members_protect();
CREATE TRIGGER trg_users_protect_admin_fields BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.tg_users_protect_admin_fields();
