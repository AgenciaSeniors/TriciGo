-- Checks of the rehearsal. Each check that does not hold inserts a row into public._t_fail (created
-- by run.sh); run.sh prints them as FAIL lines and exits 1. At least one check must fail without the
-- migration: `run.sh none` has to fail, or the rehearsal does not test the migration.
-- These three checks belong to the example migration of the template; replace them.
DO $t$
BEGIN
  IF to_regclass('public.rehearsal_example') IS NULL THEN
    INSERT INTO public._t_fail VALUES ('T1 the migration creates public.rehearsal_example', NULL);
  ELSE
    IF NOT has_table_privilege('service_role', 'public.rehearsal_example', 'SELECT') THEN
      INSERT INTO public._t_fail VALUES ('T2 service_role can read public.rehearsal_example', NULL);
    END IF;
    IF has_table_privilege('anon', 'public.rehearsal_example', 'SELECT') THEN
      INSERT INTO public._t_fail VALUES ('T3 anon cannot read public.rehearsal_example', NULL);
    END IF;
  END IF;
END
$t$;
