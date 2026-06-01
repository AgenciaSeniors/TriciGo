-- ============================================================
-- 00366 — Converge "new device login" detection on mechanism B
--
-- Mechanism B (Edge Function `register-login-device` + table
-- `user_known_devices`, fed by the apps with a STABLE per-install
-- `device_id`) is now the single canonical new-device path. This retires
-- mechanism A: the orphan trigger on `auth.sessions`
-- (`trg_send_security_new_device_email` → `public.send_security_new_device_email`)
-- that keyed off the unstable `user_agent` heuristic.
--
-- We do NOT "reconvert" A to read user_known_devices: the trigger fires when
-- the session row is inserted (at login), BEFORE the client registers its
-- device_id, so it would always see "unknown" and email on every login. B
-- decides correctly because it runs AFTER login (device_id already known).
--
-- The trigger's CREATE was never in git (prod-only orphan) — DROP TRIGGER IF
-- EXISTS handles it. The function was brought into git by 00365; dropped here.
--
-- ⚠️ APPLY TO PROD ONLY AFTER mechanism B is verified live in a release build,
-- so there is no window with NO new-device alert at all.
-- ============================================================

DROP TRIGGER IF EXISTS trg_send_security_new_device_email ON auth.sessions;
DROP FUNCTION IF EXISTS public.send_security_new_device_email();

-- Let users remove their OWN devices from the "Tus dispositivos" screen.
-- 00355 created only ukd_select_own (SELECT) + ukd_admin_all; the DELETE
-- policy was intentionally omitted then. Add it now, scoped to the row owner.
-- (Writes/inserts stay service-role-only via register-login-device.)
CREATE POLICY "ukd_delete_own" ON public.user_known_devices
  FOR DELETE USING (user_id = auth.uid());
