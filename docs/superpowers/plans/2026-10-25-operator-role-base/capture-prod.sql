-- Builds the 00668 rehearsal scaffold from prod's catalogue. Read-only: it only SELECTs.
-- Run it through the Supabase MCP (execute_sql) BEFORE 00667 is applied in prod; the result is one
-- text column, "scaffold", to save as supabase/tests/00668/prod-objects.sql.
-- What it emits, in order:
--   1. every enum of public (user_role without 'operator', so the scaffold is prod before 00667);
--   2. the tables the migration and its tests touch, with their columns (PostGIS and other
--      extension types become text), simple defaults, RLS flag and the API roles' grants;
--   3. the functions the migration patches and every public function they or the policies call,
--      two calls deep, byte for byte (pg_get_functiondef), with their EXECUTE grants;
--      the stubbed ones (stubs.sql) are left out;
--   4. the panel views and driver_churn_risk, with their options and grants;
--   5. the policies of those tables (and of storage.objects for the three buckets) whose functions
--      and tables are all in the scaffold;
--   6. the ride transition trigger and the valid_transitions rows.
SET LOCAL search_path = pg_catalog;
WITH RECURSIVE
stub(name) AS (VALUES ('cron_http_post'), ('get_service_role_key'), ('log_rpc_attempt'), ('check_rate_limit')),
pub_fn AS (
  SELECT p.oid, p.proname, p.prosrc FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
    AND p.proname NOT IN (SELECT name FROM stub)
    -- PostGIS, pg_trgm, unaccent and pg_net live in public: their functions come from the
    -- extensions (stubs.sql), never from here.
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
),
pub_tbl AS (
  SELECT c.oid, c.relname FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
),
seed_tbl AS (
  SELECT t.oid FROM pub_tbl t WHERE t.relname = ANY (ARRAY[
    'rides', 'ride_transitions', 'ride_pricing_snapshots', 'ride_messages', 'users', 'driver_profiles',
    'driver_documents', 'driver_score_events', 'driver_contracts', 'selfie_checks', 'wallet_accounts',
    'ledger_transactions', 'ledger_entries', 'wallet_transfers', 'wallet_recharge_requests',
    'wallet_receipts', 'cancellation_penalties', 'reviews', 'ticket_messages', 'support_tickets',
    'ride_disputes', 'incident_reports', 'lost_items', 'fraud_alerts', 'cancellation_reviews',
    'corporate_accounts', 'corporate_employees', 'corporate_rides', 'driver_fleets', 'fleet_members',
    'promotions', 'referrals', 'stuck_ride_alerts', 'vehicles', 'delivery_details', 'team_invitations',
    'valid_transitions', 'admin_actions', 'customer_profiles', 'platform_config', 'cities'])
),
seed_fn AS (
  SELECT f.oid FROM pub_fn f WHERE f.proname = ANY (ARRAY[
    'is_admin', 'is_marketing', 'is_super_admin', 'current_user_role',
    'get_admin_dashboard_metrics', 'get_admin_wallet_stats', 'get_rides_by_day',
    'get_rides_by_service_type', 'get_rides_by_payment_method', 'get_top_drivers', 'get_peak_hours',
    'get_driver_utilization', 'get_product_failures', 'admin_launch_pulse',
    'admin_incomplete_driver_signups', 'admin_support_waiting_rides', 'admin_ride_assist_context',
    'admin_ride_assist_candidates', 'admin_active_ride_context', 'admin_get_online_fleet',
    'get_corporate_balance', 'get_corporate_employees', '_panel_driver_churn_risk',
    'enforce_ride_transition', 'ensure_driver_role_and_tricicoin_on_approval', 'apply_user_rating',
    '_support_alert', 'team_digest_recipients', '_team_role_rank', '_team_lock_target', 'list_team',
    'create_team_invitation', 'set_team_member_role', 'remove_team_member',
    'admin_adjust_wallet', 'admin_send_gift', 'admin_reverse_gift', 'freeze_wallet', 'unfreeze_wallet',
    'approve_wallet_recharge', 'process_dispute_refund', 'admin_reward_referral',
    'admin_invalidate_referral', 'set_referral_amounts', 'get_platform_earnings', 'promote_user_role',
    'admin_set_user_level', 'admin_set_user_active'])
  UNION
  -- Functions the policies of the seed tables call.
  SELECT f.oid FROM pg_policies p
  JOIN pg_class c ON c.relname = p.tablename AND c.relnamespace = 'public'::regnamespace
  CROSS JOIN LATERAL regexp_matches(coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''), '([a-z_][a-z0-9_]*)\(', 'g') m
  JOIN pub_fn f ON f.proname = m[1]
  WHERE p.schemaname = 'public' AND c.oid IN (SELECT oid FROM seed_tbl)
),
fn_closure(oid, depth) AS (
  SELECT oid, 0 FROM seed_fn
  UNION
  SELECT f2.oid, c.depth + 1
  FROM fn_closure c
  JOIN pub_fn f1 ON f1.oid = c.oid
  CROSS JOIN LATERAL (SELECT DISTINCT m[1] AS nm FROM regexp_matches(f1.prosrc, '([a-z_][a-z0-9_]*)\s*\(', 'g') m) r
  JOIN pub_fn f2 ON f2.proname = r.nm
  WHERE c.depth < 2
),
fn_set AS (SELECT DISTINCT oid FROM fn_closure),
view_set AS (
  SELECT c.oid, c.relname FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'v'
    AND (c.relname LIKE 'panel\_%' OR c.relname = 'driver_churn_risk')
),
tbl_set AS (
  SELECT oid FROM seed_tbl
  UNION
  SELECT t.oid FROM fn_set s JOIN pub_fn f ON f.oid = s.oid
  CROSS JOIN LATERAL regexp_matches(f.prosrc, '(?:FROM|JOIN|INTO|UPDATE)\s+(?:public\.)?([a-z_][a-z0-9_]*)', 'gi') m
  JOIN pub_tbl t ON t.relname = lower(m[1])
  UNION
  SELECT t.oid FROM view_set v
  CROSS JOIN LATERAL regexp_matches(pg_get_viewdef(v.oid), '(?:FROM|JOIN)\s+(?:public\.)?([a-z_][a-z0-9_]*)', 'gi') m
  JOIN pub_tbl t ON t.relname = lower(m[1])
),
fn_names AS (SELECT f.proname FROM fn_set s JOIN pub_fn f ON f.oid = s.oid
             UNION SELECT name FROM stub UNION VALUES ('uid'), ('foldername')),
tbl_names AS (SELECT c.relname FROM tbl_set s JOIN pg_class c ON c.oid = s.oid
              UNION SELECT relname FROM view_set UNION VALUES ('objects'), ('users')),
enums AS (
  SELECT string_agg(format('CREATE TYPE public.%I AS ENUM (%s);', t.typname,
           (SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder)
            FROM pg_enum e WHERE e.enumtypid = t.oid
              AND NOT (t.typname = 'user_role' AND e.enumlabel = 'operator'))), E'\n' ORDER BY t.typname) AS txt
  FROM pg_type t WHERE t.typnamespace = 'public'::regnamespace AND t.typtype = 'e'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
),
cols AS (
  SELECT a.attrelid, a.attnum, format('  %I %s%s', a.attname,
    CASE
      WHEN ty.typname IN ('geography', 'geometry') OR ety.typname IN ('geography', 'geometry') THEN 'text'
      WHEN ty.typtype = 'e' OR ty.typnamespace = 'pg_catalog'::regnamespace
           OR ety.typtype = 'e' OR ety.typnamespace = 'pg_catalog'::regnamespace
        THEN format_type(a.atttypid, a.atttypmod)
      ELSE 'text'
    END,
    CASE
      WHEN a.attgenerated <> '' OR d.adbin IS NULL THEN ''
      WHEN pg_get_expr(d.adbin, d.adrelid) ~ 'uuid_generate_v4\(\)' THEN ' DEFAULT gen_random_uuid()'
      WHEN pg_get_expr(d.adbin, d.adrelid) ~ '(nextval|extensions\.|auth\.|public\.)' THEN ''
      ELSE ' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid)
    END) AS line
  FROM pg_attribute a
  JOIN pg_type ty ON ty.oid = a.atttypid
  LEFT JOIN pg_type ety ON ety.oid = ty.typelem AND ty.typcategory = 'A'
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid IN (SELECT oid FROM tbl_set) AND a.attnum > 0 AND NOT a.attisdropped
),
tables AS (
  SELECT string_agg(
    format(E'CREATE TABLE public.%I (\n%s\n);', c.relname,
      (SELECT string_agg(line, E',\n' ORDER BY attnum) FROM cols WHERE attrelid = c.oid))
    || CASE WHEN c.relrowsecurity THEN format(E'\nALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', c.relname) ELSE '' END
    || format(E'\nREVOKE ALL ON public.%I FROM anon, authenticated, service_role;', c.relname)
    || coalesce((SELECT E'\n' || string_agg(format('GRANT %s ON public.%I TO %I;', g.privilege_type, c.relname, g.grantee), E'\n' ORDER BY g.grantee, g.privilege_type)
                 FROM information_schema.role_table_grants g
                 WHERE g.table_schema = 'public' AND g.table_name = c.relname
                   AND g.grantee IN ('anon', 'authenticated', 'service_role')), ''),
    E'\n\n' ORDER BY c.relname) AS txt
  FROM tbl_set s JOIN pg_class c ON c.oid = s.oid
),
functions AS (
  SELECT string_agg(
    pg_get_functiondef(p.oid) || ';'
    || format(E'\nREVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role;', p.oid::regprocedure)
    || coalesce((SELECT E'\n' || string_agg(format('GRANT EXECUTE ON FUNCTION %s TO %s;', p.oid::regprocedure,
                   CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END), E'\n')
                 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 WHERE a.privilege_type = 'EXECUTE'
                   AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon', 'authenticated', 'service_role'))), ''),
    E'\n\n' ORDER BY p.proname, p.oid) AS txt
  FROM fn_set s JOIN pg_proc p ON p.oid = s.oid
),
views AS (
  SELECT string_agg(
    format(E'CREATE VIEW public.%I%s AS\n%s', v.relname,
      CASE WHEN c.reloptions IS NULL THEN '' ELSE ' WITH (' || array_to_string(c.reloptions, ', ') || ')' END,
      pg_get_viewdef(v.oid))
    || format(E'\nREVOKE ALL ON public.%I FROM anon, authenticated, service_role;', v.relname)
    || coalesce((SELECT E'\n' || string_agg(format('GRANT %s ON public.%I TO %I;', g.privilege_type, v.relname, g.grantee), E'\n')
                 FROM information_schema.role_table_grants g
                 WHERE g.table_schema = 'public' AND g.table_name = v.relname
                   AND g.grantee IN ('anon', 'authenticated', 'service_role')), ''),
    -- driver_churn_risk first: _panel_driver_churn_risk() reads it and panel_driver_churn_risk reads that.
    E'\n\n' ORDER BY (v.relname <> 'driver_churn_risk'), v.relname) AS txt
  FROM view_set v JOIN pg_class c ON c.oid = v.oid
),
pols AS (
  SELECT p.schemaname, p.tablename, p.policyname,
    format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s%s%s;', p.policyname, p.schemaname, p.tablename,
      p.permissive, p.cmd, array_to_string(p.roles, ', '),
      CASE WHEN p.qual IS NULL THEN '' ELSE ' USING (' || p.qual || ')' END,
      CASE WHEN p.with_check IS NULL THEN '' ELSE ' WITH CHECK (' || p.with_check || ')' END) AS stmt,
    coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') AS expr
  FROM pg_policies p
  WHERE (p.schemaname = 'public' AND p.tablename IN (SELECT relname FROM tbl_names))
     OR (p.schemaname = 'storage' AND p.tablename = 'objects'
         AND (p.qual ~ '(driver-documents|driver-contracts|receipts)'
              OR p.with_check ~ '(driver-documents|driver-contracts|receipts)'))
),
pols_ok AS (
  SELECT pl.* FROM pols pl
  WHERE NOT EXISTS (SELECT 1 FROM regexp_matches(pl.expr, '([a-z_][a-z0-9_]*)\(', 'g') m
                    WHERE m[1] NOT IN (SELECT proname FROM fn_names)
                      AND m[1] NOT IN ('coalesce', 'lower', 'upper', 'btrim', 'array', 'any', 'exists', 'nullif',
                                       'now', 'current_setting', 'jsonb_extract_path_text', 'jwt', 'text', 'split_part'))
    AND NOT EXISTS (SELECT 1 FROM regexp_matches(pl.expr, '(?:FROM|JOIN)\s+(?:public\.)?([a-z_][a-z0-9_]*)', 'gi') m
                    WHERE lower(m[1]) NOT IN (SELECT relname FROM tbl_names))
),
policies AS (
  SELECT string_agg(stmt, E'\n' ORDER BY schemaname, tablename, policyname) AS txt FROM pols_ok
),
skipped AS (
  SELECT string_agg('-- skipped (needs objects outside the scaffold): ' || schemaname || '.' || tablename || '.' || policyname, E'\n'
                    ORDER BY schemaname, tablename, policyname) AS txt
  FROM pols WHERE (schemaname, tablename, policyname) NOT IN (SELECT schemaname, tablename, policyname FROM pols_ok)
),
triggers AS (
  SELECT string_agg(pg_get_triggerdef(t.oid) || ';', E'\n') AS txt FROM pg_trigger t
  WHERE t.tgrelid = 'public.rides'::regclass AND t.tgfoid = 'public.enforce_ride_transition()'::regprocedure
),
transitions AS (
  SELECT 'INSERT INTO public.valid_transitions (from_status, to_status, allowed_roles) VALUES' || E'\n'
         || string_agg(format('  (%L, %L, %L)', from_status, to_status,
              -- The scaffold has no operator value yet; prod rows do not mention it either.
              allowed_roles::text), E',\n' ORDER BY from_status, to_status) || ';' AS txt
  FROM public.valid_transitions
)
SELECT E'-- Generated by supabase/tests/00668/capture-prod.sql on ' || now()::date || E'. Do not edit by hand.\n'
  || E'SET check_function_bodies = off;\n\n'
  || '-- 1. Enums' || E'\n' || (SELECT txt FROM enums) || E'\n\n'
  || '-- 2. Tables' || E'\n' || (SELECT txt FROM tables) || E'\n\n'
  || '-- 3. Functions' || E'\n' || (SELECT txt FROM functions) || E'\n\n'
  || '-- 4. Views' || E'\n' || (SELECT txt FROM views) || E'\n\n'
  || '-- 5. Policies' || E'\n' || (SELECT txt FROM policies) || E'\n' || coalesce((SELECT txt FROM skipped), '') || E'\n\n'
  || '-- 6. Ride transitions' || E'\n' || (SELECT txt FROM triggers) || E'\n' || (SELECT txt FROM transitions) || E'\n'
  AS scaffold;
