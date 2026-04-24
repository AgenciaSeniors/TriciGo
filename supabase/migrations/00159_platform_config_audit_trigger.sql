-- ============================================================
-- BUG-096: platform_config edits from admin UI (commission_rate,
-- exchange_rate_fallback_cup, etc.) were NOT logged to admin_actions,
-- so there was no way to answer "who changed commission_rate to 0.20".
-- Only the generic audit_log trigger (which fires on all tables and
-- lumps everything together) captured the mutation.
--
-- This trigger records every INSERT/UPDATE/DELETE on platform_config
-- to admin_actions with old_values + new_values so operators can see
-- the full diff from /audit.
-- ============================================================

CREATE OR REPLACE FUNCTION public.tg_platform_config_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_admin UUID := COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000001'::uuid);
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
    VALUES (v_admin, 'insert_platform_config', 'platform_config', NEW.key,
            NULL,
            jsonb_build_object('value', NEW.value));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.value IS DISTINCT FROM NEW.value THEN
      INSERT INTO admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
      VALUES (v_admin, 'update_platform_config', 'platform_config', NEW.key,
              jsonb_build_object('value', OLD.value),
              jsonb_build_object('value', NEW.value));
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
    VALUES (v_admin, 'delete_platform_config', 'platform_config', OLD.key,
            jsonb_build_object('value', OLD.value),
            NULL);
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS platform_config_audit ON public.platform_config;
CREATE TRIGGER platform_config_audit
AFTER INSERT OR UPDATE OR DELETE ON public.platform_config
FOR EACH ROW
EXECUTE FUNCTION public.tg_platform_config_audit();

COMMENT ON TRIGGER platform_config_audit ON public.platform_config IS
  'BUG-096: records every platform_config mutation to admin_actions so /audit shows the diff (who, when, old→new).';
