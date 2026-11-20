-- Example migration of the rehearsal template. CI runs the template with it on every PR to prove
-- the server, the client and the template work. Not a real migration: it lives outside
-- supabase/migrations/.
CREATE TABLE IF NOT EXISTS public.rehearsal_example (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
ALTER TABLE public.rehearsal_example ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.rehearsal_example TO service_role;
