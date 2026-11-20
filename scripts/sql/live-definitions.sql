-- Prints the live definition of the objects a migration touches, to paste into a rehearsal
-- scaffold. Read-only. Run it through the Supabase MCP (execute_sql) after replacing the names in
-- the first CTE (schema-qualified: public.rides, public.complete_ride_and_pay).
WITH names(name) AS (VALUES ('public.rides'), ('public.complete_ride_and_pay')),
fns AS (
  SELECT 'function' AS kind, n.name || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS object,
         md5(p.prosrc) || '/' || length(p.prosrc) AS md5,
         pg_get_functiondef(p.oid) AS definition
  FROM pg_proc p JOIN names n ON n.name = p.pronamespace::regnamespace::text || '.' || p.proname
),
rels AS (
  SELECT CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'table' END AS kind,
         n.name AS object, NULL::text AS md5,
         CASE WHEN c.relkind IN ('v', 'm')
              THEN format('CREATE OR REPLACE VIEW %s AS %s', n.name, pg_get_viewdef(c.oid, true))
              ELSE format('CREATE TABLE %s (%s);', n.name, (
                SELECT string_agg(format('%I %s%s%s', a.attname, format_type(a.atttypid, a.atttypmod),
                         CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END,
                         coalesce(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '')), ', ' ORDER BY a.attnum)
                FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped))
         END || E'\n-- grants: ' || coalesce(c.relacl::text, 'default') || E'\n-- rls: ' || c.relrowsecurity
  FROM pg_class c JOIN names n ON n.name = c.relnamespace::regnamespace::text || '.' || c.relname
  WHERE c.relkind IN ('r', 'p', 'v', 'm')
),
pols AS (
  SELECT 'policy' AS kind, format('%s on %s.%s', p.policyname, p.schemaname, p.tablename) AS object, NULL::text,
         format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s%s%s;', p.policyname, p.schemaname, p.tablename,
                p.permissive, p.cmd, array_to_string(p.roles, ', '),
                coalesce(' USING (' || p.qual || ')', ''), coalesce(' WITH CHECK (' || p.with_check || ')', ''))
  FROM pg_policies p JOIN names n ON n.name = p.schemaname || '.' || p.tablename
)
SELECT * FROM fns UNION ALL SELECT * FROM rels UNION ALL SELECT * FROM pols ORDER BY 1, 2;
