# Marketing Role Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the marketing team their own `marketing` role in the admin panel: metrics, promotions as drafts that an admin approves, campaigns, announcements and blog, and nothing else.

**Architecture:** A new `user_role` value (00640) and one permissions migration (00641). The migration adds `is_marketing()`, additive `*_marketing` RLS policies, a draft-and-approve trigger on `promotions`, and in-place patches (md5-guarded, from the live bodies) of the metrics RPCs plus three live functions that list roles. Two Edge Functions learn the role (`send-push` only for content categories). The admin panel gets one shared allow-list (`@tricigo/utils/adminPanelAccess`) used by the middleware, the sidebar and the bottom bar, and a role context that hides admin-only UI.

**Tech Stack:** PostgreSQL 16 (Supabase), plpgsql, Deno Edge Functions tested with vitest, Next.js 15 admin panel, TypeScript, Tailwind.

**Spec:** `docs/superpowers/specs/2026-10-08-marketing-role-design.md` (read the section "Changes found while planning").

---

## Ground rules for whoever executes this

- **Branch:** `claude/hopeful-shannon-g3theu`, draft PR AgenciaSeniors/TriciGo#1115. Never push elsewhere.
- **Commits:** small, English, conventional (`feat:`, `fix:`, `test:`, `docs:`). Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01EbnC6H75XT6LqrciPs9Gzi
  ```
  No model name anywhere else (code, comments, PR text).
- **Production:** Tasks 1–18 never write to prod. Reading prod through the Supabase MCP (`execute_sql` with SELECT only) is fine. Tasks 19–22 change prod and each needs the founder's explicit OK in this conversation first, asked with AskUserQuestion. Merging the PR needs its own OK.
- **Migration numbers:** on 2026-10-08 master ends at 00638, AgenciaSeniors/TriciGo#1117 holds 00639 and the only other open PR with a migration uses 00569, so 00640 and 00641 are free. Re-check both right before pushing (Task 18, step 1). If either is taken, renumber the files and every `00640`/`00641` mention; the md5 values in this plan do not contain the number, so they stay valid.
- **Local Postgres:** the rehearsal cluster of earlier sessions (user `pgtest`, port 5433, datadir `~pgtest/pg627`). If it is not running:
  ```bash
  rm -f ~pgtest/pg627/postmaster.pid 2>/dev/null
  su pgtest -c '/usr/lib/postgresql/16/bin/pg_ctl -D ~/pg627 -o "-p 5433 -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp" -l ~/pg627.log -w start'
  ```
  If the datadir does not exist, create the cluster: `useradd -m pgtest` (if missing), then `su pgtest -c '/usr/lib/postgresql/16/bin/initdb -D ~/pg627 -U pgtest -A trust -E UTF8 --no-locale'` and start it as above.
- **UI tasks (13–16):** follow the panel's existing tokens and patterns (`text-ink`, `bg-surface-*`, `-700` text on `-500/10` tints, `-800` for amber, `dark:` variants). Run the `frontend-design` skill before Task 13.

## File map

| File | Status | Responsibility |
|---|---|---|
| `supabase/migrations/00640_marketing_role_enum.sql` | new | Adds `'marketing'` to `user_role`. Nothing else. |
| `supabase/migrations/00641_marketing_role_permissions.sql` | new | `is_marketing()`, approval columns + trigger on `promotions`, 13 `*_marketing` policies, metrics RPC gate patches, role-list patches, self-checks. |
| `supabase/tests/00641/live-bodies.sql` | new | `pg_get_functiondef` of the 17 live functions the rehearsal needs, dumped from prod. |
| `supabase/tests/00641/scaffold.sql` | new | Prod's tables (reduced), policies, triggers and seed data for the rehearsal. |
| `supabase/tests/00641/run.sh` | new | RED/GREEN rehearsal with negative proofs. |
| `packages/types/src/enums.ts` | modify | `UserRole` gains `'marketing'`. |
| `packages/utils/src/adminPanelAccess.ts` | new | Panel roles, marketing allow-list, home page, least-privilege fallback. |
| `packages/utils/src/__tests__/adminPanelAccess.test.ts` | new | Tests of the allow-list. |
| `packages/utils/package.json` | modify | Subpath export `./adminPanelAccess`. |
| `packages/api/src/services/promotion.service.ts` | modify | Approval fields on `Promotion`, `countPendingApproval()`. |
| `packages/api/src/services/__tests__/promotion.test.ts` | new | Tests of `countPendingApproval()`. |
| `supabase/functions/_shared/panel-roles.ts` | new | Which panel role may send which push or bulk e-mail. |
| `supabase/functions/_shared/panel-roles.test.ts` | new | Tests of the above. |
| `supabase/functions/send-push/index.ts` | modify | Marketing allowed for `campaign`/`announcement`/`promo`/`blog` only. |
| `supabase/functions/send-push/index.test.ts` | new | Handler test of the role and category gate. |
| `supabase/functions/send-bulk-email/index.ts` | modify | Marketing allowed. |
| `supabase/functions/send-bulk-email/index.test.ts` | modify | Handler tests for marketing and customer JWTs. |
| `packages/api/vitest.config.ts` | modify | Runs `send-push/*.test.ts`. |
| `apps/admin/src/middleware.ts` | modify | Admits marketing, redirects it off disallowed pages. |
| `apps/admin/src/lib/panelRole.tsx` | new | `PanelRoleProvider` / `usePanelRole()`. |
| `apps/admin/src/components/layout/AdminShell.tsx` | modify | Provides the role, waits for it, hides the support banner for marketing. |
| `apps/admin/src/components/layout/Sidebar.tsx` | modify | Filters the menu, pending-promotions dot for admins. |
| `apps/admin/src/components/layout/BottomNav.tsx` | modify | Marketing's own four tabs. |
| `apps/admin/src/components/layout/Header.tsx` | modify | Role label, no SOS bell or "Mi perfil" for marketing. |
| `apps/admin/src/app/promotions/page.tsx` | modify | Draft/approval UI. |
| `apps/admin/src/app/referrals/page.tsx` | modify | Read-only for marketing. |
| `apps/admin/src/app/users/page.tsx`, `apps/admin/src/app/users/[id]/page.tsx` | modify | Marketing role badge. |
| `packages/i18n/src/locales/{es,en,pt}/admin.json` | modify | New copy. |
| `CLAUDE.md` | modify | Section on the marketing role. |

---

### Task 1: Dump the live function bodies for the rehearsal

**Files:**
- Create: `supabase/tests/00641/live-bodies.sql`

- [ ] **Step 1: Read the 17 bodies from prod (read-only)**

Run with the Supabase MCP `execute_sql` (project `lqaufszburqvlslpcuac`):

```sql
SELECT string_agg(pg_get_functiondef(p.oid) || ';', E'\n\n' ORDER BY p.proname COLLATE "C") AS sql
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('admin_launch_pulse', 'admin_signup_code_stats', 'apply_user_rating', 'current_user_role',
    'enforce_ride_transition', 'ensure_driver_role_and_tricicoin_on_approval', 'get_active_push_user_ids',
    'get_admin_dashboard_metrics', 'get_admin_wallet_stats', 'get_rides_by_day', 'get_rides_by_payment_method',
    'get_rides_by_service_type', 'get_top_drivers', 'is_admin', 'is_super_admin', 'promote_user_role',
    'tg_acquisition_codes_guard');
```

- [ ] **Step 2: Write the result to the file without hand-copying**

Copy the JSON array the tool returns (the `[{"sql": "..."}]` text between the untrusted-data markers) into the scratchpad as `live-bodies.json`, then:

```bash
SCRATCH=/tmp/claude-0/-home-user-TriciGo/d6301488-459d-5640-a247-d08312636658/scratchpad
python3 - "$SCRATCH/live-bodies.json" supabase/tests/00641/live-bodies.sql <<'EOF'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
body = json.load(open(src, encoding='utf-8'))[0]['sql']
assert '\r' not in body
header = ("-- Live bodies dumped from prod on 2026-10-08 with pg_get_functiondef (read-only MCP query).\n"
          "-- The 00641 rehearsal loads them as they run in prod; run.sh (L1) checks each md5.\n\n")
open(dst, 'w', encoding='utf-8', newline='\n').write(header + body + '\n')
print(body.count('CREATE OR REPLACE FUNCTION'), 'functions')
EOF
```

Expected: `17 functions`.

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/00641/live-bodies.sql
git commit -m "test(00641): dump the live function bodies the rehearsal needs"
```

---

### Task 2: Rehearsal scaffold

**Files:**
- Create: `supabase/tests/00641/scaffold.sql`

- [ ] **Step 1: Write the scaffold**

```sql
-- Scaffold for the 00641 rehearsal (marketing role in the admin panel).
-- Prod's tables as of 2026-10-08, reduced to the columns the code under test reads, prod's
-- policies on them, and the LIVE bodies of the functions 00641 patches or calls
-- (live-bodies.sql, dumped from prod; run.sh checks every body against prod's md5).
-- No Supabase stack: auth.uid() reads request.jwt.claim.sub like PostgREST.
-- Every object belongs to a NON-superuser role named postgres, as in prod, so RLS applies to
-- anon, authenticated and service_role and not to the owner.
-- Simplified on purpose: no foreign keys to auth.users, no RLS on ride_transitions.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role TO postgres;

CREATE SCHEMA auth AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO postgres;

SET ROLE postgres;

-- Until 2026-10-30 Supabase grants every new function and table of public to the API roles.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$f$;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');
CREATE TYPE public.driver_status AS ENUM ('pending_verification', 'under_review', 'approved', 'rejected', 'suspended');
CREATE TYPE public.promotion_type AS ENUM ('percentage_discount', 'fixed_discount', 'bonus_credit');
CREATE TYPE public.wallet_account_type AS ENUM ('customer_cash', 'driver_cash', 'driver_hold', 'platform_revenue',
  'platform_promotions', 'corporate_cash', 'driver_quota', 'tricicoin', 'platform_fx_reserve');

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  full_name text NOT NULL DEFAULT '',
  phone text,
  email text,
  role public.user_role NOT NULL DEFAULT 'customer',
  is_active boolean NOT NULL DEFAULT true,
  is_test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.customer_profiles (
  user_id uuid PRIMARY KEY REFERENCES public.users(id),
  rating_avg numeric NOT NULL DEFAULT 5.00
);
CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  status public.driver_status NOT NULL DEFAULT 'pending_verification',
  rating_avg numeric
);
CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.users(id),
  driver_id uuid REFERENCES public.driver_profiles(id),
  status public.ride_status NOT NULL DEFAULT 'searching',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.valid_transitions (
  from_status public.ride_status NOT NULL,
  to_status public.ride_status NOT NULL,
  allowed_roles public.user_role[] NOT NULL
);
CREATE TABLE public.ride_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid,
  from_status public.ride_status,
  to_status public.ride_status,
  actor_id uuid,
  actor_role public.user_role,
  reason text,
  metadata jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.wallet_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id),
  account_type public.wallet_account_type NOT NULL,
  balance numeric NOT NULL DEFAULT 0,
  UNIQUE (user_id, account_type)
);
CREATE TABLE public.referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid REFERENCES public.users(id),
  referee_id uuid REFERENCES public.users(id),
  status text NOT NULL DEFAULT 'pending',
  bonus_amount integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  rewarded_at timestamptz
);
CREATE TABLE public.referral_codes (code text PRIMARY KEY, user_id uuid);
CREATE TABLE public.admin_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid,
  action text,
  target_type text,
  target_id text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  type public.promotion_type NOT NULL,
  discount_percent numeric,
  discount_fixed_cup integer,
  max_uses integer,
  current_uses integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  title_es text,
  body_es text,
  image_url text,
  notify_on_publish boolean NOT NULL DEFAULT true,
  notified_at timestamptz,
  first_ride_only boolean NOT NULL DEFAULT false,
  is_public boolean NOT NULL DEFAULT true
);
CREATE TABLE public.campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  segment_type text NOT NULL,
  segment_city_id uuid,
  message_title text NOT NULL,
  message_body text NOT NULL,
  promo_code_id uuid REFERENCES public.promotions(id) ON DELETE SET NULL,
  channel text NOT NULL DEFAULT 'push',
  status text NOT NULL DEFAULT 'draft',
  scheduled_at timestamptz,
  sent_at timestamptz,
  sent_count integer DEFAULT 0,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  audience_role text NOT NULL DEFAULT 'customer'
);
CREATE TABLE public.home_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_es text NOT NULL,
  body_es text,
  image_url text,
  cta_label_es text,
  cta_url text,
  is_active boolean NOT NULL DEFAULT false,
  starts_at timestamptz,
  ends_at timestamptz,
  city_id uuid,
  priority integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  notify_on_publish boolean NOT NULL DEFAULT true,
  notified_at timestamptz
);
CREATE TABLE public.blog_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  title_es text NOT NULL,
  title_en text NOT NULL,
  excerpt_es text NOT NULL DEFAULT '',
  excerpt_en text NOT NULL DEFAULT '',
  body_es text NOT NULL DEFAULT '',
  body_en text NOT NULL DEFAULT '',
  cover_image_url text,
  is_published boolean DEFAULT false,
  published_at timestamptz,
  author_id uuid REFERENCES public.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  notify_on_publish boolean NOT NULL DEFAULT true,
  notified_at timestamptz
);
CREATE TABLE public.acquisition_codes (
  code text PRIMARY KEY,
  label text NOT NULL,
  channel text NOT NULL,
  audience text NOT NULL DEFAULT 'ambos',
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL
);
CREATE TABLE public.cms_content (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  title_es text NOT NULL,
  title_en text NOT NULL,
  body_es text NOT NULL,
  body_en text NOT NULL,
  updated_at timestamptz DEFAULT now(),
  updated_by uuid REFERENCES public.users(id)
);

-- The live functions. current_user_role and is_super_admin are LANGUAGE sql, so users must exist first.
\ir live-bodies.sql

-- 00517: anon may not call current_user_role() (is_admin() returns early for it).
REVOKE EXECUTE ON FUNCTION public.current_user_role() FROM PUBLIC, anon;

-- apply_user_rating calls it; the real one averages reviews and cancellation events.
CREATE FUNCTION public.recompute_user_rating(p_user_id uuid) RETURNS numeric
LANGUAGE sql AS $f$ SELECT 4.25::numeric $f$;

-- Prod's RLS and policies on these tables (2026-10-08).
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.home_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acquisition_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_content ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_admin_select ON public.users FOR SELECT USING (is_admin());
CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = (SELECT auth.uid())) OR is_admin());
CREATE POLICY users_update_own ON public.users FOR UPDATE USING (id = (SELECT auth.uid()));
CREATE POLICY dp_admin_select ON public.driver_profiles FOR SELECT USING (is_admin());
CREATE POLICY dp_select_own ON public.driver_profiles FOR SELECT TO authenticated
  USING ((user_id = (SELECT auth.uid())) OR is_admin());
CREATE POLICY r_admin_select ON public.rides FOR SELECT USING (is_admin());
CREATE POLICY r_select_customer ON public.rides FOR SELECT USING ((customer_id = (SELECT auth.uid())) OR is_admin());
CREATE POLICY r_insert ON public.rides FOR INSERT WITH CHECK (customer_id = (SELECT auth.uid()));
CREATE POLICY r_update ON public.rides FOR UPDATE USING ((customer_id = (SELECT auth.uid()))
  OR (driver_id IN (SELECT driver_profiles.id FROM public.driver_profiles WHERE driver_profiles.user_id = (SELECT auth.uid())))
  OR is_admin());
CREATE POLICY wa_select ON public.wallet_accounts FOR SELECT USING ((user_id = (SELECT auth.uid())) OR is_admin());
CREATE POLICY ref_select ON public.referrals FOR SELECT
  USING ((referrer_id = (SELECT auth.uid())) OR (referee_id = (SELECT auth.uid())) OR is_admin());
CREATE POLICY referral_codes_admin_all ON public.referral_codes FOR ALL USING (is_admin());
CREATE POLICY referral_codes_select_own ON public.referral_codes FOR SELECT
  USING ((user_id = (SELECT auth.uid())) OR is_admin());
CREATE POLICY promo_admin ON public.promotions FOR ALL USING (is_admin());
CREATE POLICY "Admin full access on campaigns" ON public.campaigns FOR ALL
  USING (EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = ANY (ARRAY['admin'::public.user_role, 'super_admin'::public.user_role])))
  WITH CHECK (EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = ANY (ARRAY['admin'::public.user_role, 'super_admin'::public.user_role])));
CREATE POLICY ha_admin_all ON public.home_announcements FOR ALL USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY ha_public_read ON public.home_announcements FOR SELECT
  USING (is_active AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now()));
CREATE POLICY blog_posts_admin_all ON public.blog_posts FOR ALL
  USING (EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = ANY (ARRAY['admin'::public.user_role, 'super_admin'::public.user_role])));
CREATE POLICY blog_posts_public_read ON public.blog_posts FOR SELECT USING (is_published = true);
CREATE POLICY acquisition_codes_admin_all ON public.acquisition_codes FOR ALL TO authenticated
  USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
CREATE POLICY "Admins can manage cms_content" ON public.cms_content FOR ALL
  USING (EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = ANY (ARRAY['admin'::public.user_role, 'super_admin'::public.user_role])));
CREATE POLICY "Anyone can read cms_content" ON public.cms_content FOR SELECT USING (true);

-- Prod's triggers (pg_get_triggerdef, 2026-10-08).
CREATE TRIGGER trg_enforce_ride_transition BEFORE UPDATE OF status ON public.rides
  FOR EACH ROW WHEN (old.status IS DISTINCT FROM new.status) EXECUTE FUNCTION public.enforce_ride_transition();
CREATE TRIGGER dp_ensure_driver_role_and_tricicoin AFTER INSERT OR UPDATE OF status ON public.driver_profiles
  FOR EACH ROW EXECUTE FUNCTION public.ensure_driver_role_and_tricicoin_on_approval();
CREATE TRIGGER trg_acquisition_codes_guard BEFORE INSERT OR UPDATE OF code ON public.acquisition_codes
  FOR EACH ROW EXECUTE FUNCTION public.tg_acquisition_codes_guard();

-- Prod's valid_transitions (2026-10-08).
INSERT INTO public.valid_transitions (from_status, to_status, allowed_roles) VALUES
  ('disputed', 'completed', '{admin,super_admin}'),
  ('searching', 'accepted', '{driver,admin,super_admin}'),
  ('accepted', 'driver_en_route', '{driver,admin,super_admin}'),
  ('driver_en_route', 'arrived_at_pickup', '{driver,admin,super_admin}'),
  ('arrived_at_pickup', 'in_progress', '{driver,admin,super_admin}'),
  ('in_progress', 'completed', '{driver,admin,super_admin}'),
  ('in_progress', 'disputed', '{customer,driver,admin,super_admin}'),
  ('searching', 'canceled', '{customer,admin,super_admin}'),
  ('accepted', 'canceled', '{customer,driver,admin,super_admin}'),
  ('arrived_at_pickup', 'canceled', '{customer,driver,admin,super_admin}'),
  ('in_progress', 'arrived_at_destination', '{driver,admin,super_admin}'),
  ('arrived_at_destination', 'completed', '{driver,admin,super_admin}'),
  ('arrived_at_destination', 'disputed', '{customer,driver,admin,super_admin}'),
  ('driver_en_route', 'canceled', '{customer,driver,admin,super_admin}'),
  ('completed', 'disputed', '{customer,driver,admin,super_admin}'),
  ('arrived_at_destination', 'canceled', '{admin,super_admin}'),
  ('in_progress', 'canceled', '{admin,driver,customer,super_admin}'),
  ('accepted', 'searching', '{admin,super_admin}'),
  ('driver_en_route', 'searching', '{admin,super_admin}');

-- Seed: Ana (admin), Sara (super_admin), Carla (customer), Diego (approved driver) and Mara,
-- who run.sh turns into marketing once 00640 has added the value.
INSERT INTO public.users (id, full_name, role) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'Ana Admin', 'admin'),
  ('a0000000-0000-4000-8000-000000000002', 'Sara Super', 'super_admin'),
  ('c0000000-0000-4000-8000-000000000001', 'Carla Cliente', 'customer'),
  ('c0000000-0000-4000-8000-000000000002', 'Diego Driver', 'driver'),
  ('c0000000-0000-4000-8000-000000000003', 'Mara Marketing', 'customer');
INSERT INTO public.customer_profiles (user_id) VALUES
  ('c0000000-0000-4000-8000-000000000001'), ('c0000000-0000-4000-8000-000000000003');
INSERT INTO public.driver_profiles (id, user_id, status) VALUES
  ('d0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002', 'approved');
INSERT INTO public.wallet_accounts (user_id, account_type, balance) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'customer_cash', 500);
INSERT INTO public.rides (id, customer_id) VALUES
  ('f0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001');
INSERT INTO public.referrals (referrer_id, referee_id) VALUES
  ('c0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001');
INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, reason) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'seed', 'user', 'c0000000-0000-4000-8000-000000000001', 'seed row');
INSERT INTO public.promotions (id, code, type, discount_percent, is_active, current_uses) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'LIVE10', 'percentage_discount', 10, true, 0),
  ('e0000000-0000-4000-8000-000000000002', 'USED5', 'percentage_discount', 5, false, 3);
INSERT INTO public.cms_content (slug, title_es, title_en, body_es, body_en)
  VALUES ('terms', 'Términos', 'Terms', 'Texto', 'Text');
INSERT INTO public.blog_posts (slug, title_es, title_en, is_published) VALUES ('hola', 'Hola', 'Hello', true);
```

- [ ] **Step 2: Check it loads**

```bash
B=/usr/lib/postgresql/16/bin; C="-h 127.0.0.1 -p 5433 -U pgtest"
$B/dropdb $C --if-exists pr641try; $B/createdb $C pr641try
$B/psql $C -d pr641try -q -v ON_ERROR_STOP=1 -f supabase/tests/00641/scaffold.sql && echo LOADED
$B/dropdb $C pr641try
```

Expected: `LOADED`. If a function in `live-bodies.sql` fails to create, its error names the missing type or table: add it to the scaffold with prod's definition (read it with a SELECT on `information_schema.columns`) and run again.

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/00641/scaffold.sql
git commit -m "test(00641): rehearsal scaffold with prod's tables, policies and triggers"
```

---

### Task 3: Migration 00640 (the enum value)

**Files:**
- Create: `supabase/migrations/00640_marketing_role_enum.sql`

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================
-- 00640 — marketing role: the enum value
--
-- Spec: docs/superpowers/specs/2026-10-08-marketing-role-design.md
-- A value added by ALTER TYPE ... ADD VALUE cannot be used in the transaction that adds it
-- (same split as 00370/00371), so everything that uses 'marketing' lives in 00641.
-- On its own this changes nothing: no account has the role until a super_admin grants it with
-- promote_user_role.
-- ============================================================
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'marketing';
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/00640_marketing_role_enum.sql
git commit -m "feat(db): add the marketing value to user_role"
```

---

### Task 4: Rehearsal suite (RED)

**Files:**
- Create: `supabase/tests/00641/run.sh`

- [ ] **Step 1: Write the runner**

```bash
#!/usr/bin/env bash
# Rehearsal runner for migrations 00640 + 00641 (marketing role in the admin panel).
# Builds prod as of 2026-10-08 from scaffold.sql (tables, policies, triggers) and live-bodies.sql
# (the live functions 00641 patches or calls; L1 checks each against prod's md5), applies 00640
# twice (the enum value, harmless on its own) and turns Mara into a marketing account.
#   supabase/tests/00641/run.sh none
#       -> prod + 00640 + tests (RED: marketing reads nothing, cannot ride, loses its role as a driver)
#   supabase/tests/00641/run.sh supabase/migrations/00641_marketing_role_permissions.sql
#       -> the same + 00641 applied twice, each time in one transaction (GREEN) + negative proofs
# Cluster: user pgtest, port 5433. Other clusters: PGBIN=<dir with psql> PGPORT=<port>.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr641
GUARD=pr641guard
ENUM="$ROOT/supabase/migrations/00640_marketing_role_enum.sql"
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = '';"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

ANA=a0000000-0000-4000-8000-000000000001     # admin
SARA=a0000000-0000-4000-8000-000000000002    # super_admin
CARLA=c0000000-0000-4000-8000-000000000001   # customer
DIEGO=c0000000-0000-4000-8000-000000000002   # approved driver
MARA=c0000000-0000-4000-8000-000000000003    # marketing
CARLA_DP=d0000000-0000-4000-8000-000000000001
DIEGO_DP=d0000000-0000-4000-8000-000000000002
MARA_DP=d0000000-0000-4000-8000-000000000003
RIDE_C=f0000000-0000-4000-8000-000000000001  # Carla's searching ride
RIDE_M=f0000000-0000-4000-8000-000000000003
P_LIVE=e0000000-0000-4000-8000-000000000001  # LIVE10: active, unused
P_USED=e0000000-0000-4000-8000-000000000002  # USED5: inactive, used 3 times

# as ID: the rest of the transaction runs as an API user with that JWT subject
as_user(){ echo "SET LOCAL request.jwt.claim.sub = '$1'; SET LOCAL ROLE authenticated;"; }

LIVE_NAMES="'admin_launch_pulse','admin_signup_code_stats','apply_user_rating','current_user_role',
  'enforce_ride_transition','ensure_driver_role_and_tricicoin_on_approval','get_active_push_user_ids',
  'get_admin_dashboard_metrics','get_admin_wallet_stats','get_rides_by_day','get_rides_by_payment_method',
  'get_rides_by_service_type','get_top_drivers','is_admin','is_super_admin','promote_user_role',
  'tg_acquisition_codes_guard'"
LIVE_MD5="admin_launch_pulse=21c359c7427f75016c38b6b758ad23a7,admin_signup_code_stats=079bc5a6c046e6896c62200f71fc7740,apply_user_rating=8d0b0de3bf82f6d15d8da36462cbbe9c,current_user_role=cb4a7c12d4e21fe2997135833f141e25,enforce_ride_transition=35bde4fd60a4a4fa0fc86a237ec4a414,ensure_driver_role_and_tricicoin_on_approval=ed41bc2fe192ceb6dbafd163507934f3,get_active_push_user_ids=e3d6f508efe28decb7141f3251410f50,get_admin_dashboard_metrics=0c99d4e89b08ad2da5989642e09ba5bf,get_admin_wallet_stats=86c6ef03c7c39d56e9f84cc8795dfbfd,get_rides_by_day=68dcc98aaa0919c942eafc22e6cfe06a,get_rides_by_payment_method=351484791e08451565cc6fbae34fef2e,get_rides_by_service_type=c94b1028a03b16d34d25f4a2a56d4bd6,get_top_drivers=cb273bf7da9f5c3d58b495ba08d6714b,is_admin=22cb75e91980d512498034cd33e1eda2,is_super_admin=5655a4615e92e8b1e323d06c7566b058,promote_user_role=6d7f90376c85173c104a86003e684e1e,tg_acquisition_codes_guard=383b43d28d0e0598a9233fafd1eba296"
PATCHED_NAMES="'admin_launch_pulse','admin_signup_code_stats','apply_user_rating','enforce_ride_transition',
  'ensure_driver_role_and_tricicoin_on_approval','get_active_push_user_ids','get_admin_dashboard_metrics',
  'get_admin_wallet_stats','get_rides_by_day','get_rides_by_payment_method','get_rides_by_service_type','get_top_drivers'"
# Computed in prod on 2026-10-08 as md5(replace(prosrc, <target>, <replacement>)): the bodies 00641 must leave.
PATCHED_MD5="admin_launch_pulse=bb5d37a5bca57a64d3e3409ada2dd6b6,admin_signup_code_stats=16a8ed1ebe03aa82f2f75676783a9099,apply_user_rating=96be8c154990651738312ef44861242f,enforce_ride_transition=f806997fab31c18e7b369e69f5321c30,ensure_driver_role_and_tricicoin_on_approval=1940d4379a446c8afdf0d47434945c07,get_active_push_user_ids=875f787da6a1c0fcce8708404efd72d8,get_admin_dashboard_metrics=32cec76d3f079f6938b09f8bb7e919b2,get_admin_wallet_stats=0f937c94cda1d26e7dd2da7d574949dd,get_rides_by_day=fd5363b072a17da61325a23cfd1486af,get_rides_by_payment_method=2ecacefdfef6c96da84d3b2f20a0b138,get_rides_by_service_type=ffd6c633752a21bba4945625fc9aaaaf,get_top_drivers=03e7be0213769612782ed3bcb0183f3a"
GATE='Admin only\|forbidden\|Forbidden'
METRICS="admin_launch_pulse(4) admin_signup_code_stats() get_admin_dashboard_metrics() get_admin_wallet_stats()
  get_rides_by_day(7) get_rides_by_service_type(7) get_rides_by_payment_method(7) get_top_drivers(5)
  get_active_push_user_ids(30)"

load(){ local db=$1 i
  $BIN/dropdb $CONN --if-exists "$db" >/dev/null 2>&1
  $BIN/createdb $CONN "$db" || { echo "createdb $db failed"; exit 1; }
  $BIN/psql $CONN -d "$db" -q -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >"$TMP/scaffold.out" 2>&1 \
    || { echo "scaffold failed:"; cat "$TMP/scaffold.out"; exit 1; }
  for i in 1 2; do
    $BIN/psql $CONN -d "$db" -q -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$ENUM" >"$TMP/enum.out" 2>&1 \
      || { echo "00640 failed on apply $i:"; cat "$TMP/enum.out"; exit 1; }
  done
  $BIN/psql $CONN -d "$db" -q -v ON_ERROR_STOP=1 -c "UPDATE public.users SET role = 'marketing' WHERE id = '$MARA'" \
    >"$TMP/mara.out" 2>&1 || { echo "could not make Mara marketing:"; cat "$TMP/mara.out"; exit 1; }
}
migrate(){ local db=$1 i
  [ "$MIG" = none ] && return 0
  for i in 1 2; do
    # one transaction per apply, as apply_migration runs it
    $BIN/psql $CONN -d "$db" -q -1 -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >"$TMP/mig.out" 2>&1 \
      || { echo "migration failed on apply $i:"; cat "$TMP/mig.out"; exit 1; }
  done
}

load $DB
# L1: the live bodies are prod's (md5 of prosrc read from prod on 2026-10-08)
val L1 "SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname COLLATE \"C\")
  FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ($LIVE_NAMES)" "$LIVE_MD5"
# E1: 00640 added the value at the end, twice without error, and Mara is marketing
val E1 "SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) FROM pg_enum
  WHERE enumtypid = 'public.user_role'::regtype; SELECT role FROM public.users WHERE id = '$MARA'" \
  "customer,driver,admin,super_admin,marketing;marketing"
migrate $DB

# --- G: the file did what it says -------------------------------------------------------
val G1 "SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname COLLATE \"C\")
  FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ($PATCHED_NAMES)" "$PATCHED_MD5"
val G2 "SELECT p.prosecdef, has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('authenticated', p.oid, 'EXECUTE')
  FROM pg_proc p WHERE p.oid = 'public.is_marketing()'::regprocedure" "f|t|t"
val G3 "SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE '%\\_marketing'" "13"

# --- M: is_marketing() ------------------------------------------------------------------
val M1 "BEGIN; $(as_user $MARA) SELECT public.is_marketing(), public.is_admin(); ROLLBACK;" "t|f"
val M2 "BEGIN; $(as_user $ANA) SELECT public.is_marketing(); $(as_user $CARLA) SELECT public.is_marketing(); ROLLBACK;" "f;f"
# anon may not call current_user_role(): is_marketing() must return before it, without an error
val M3 "BEGIN; SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE anon; SELECT public.is_marketing(); ROLLBACK;" "f"

# --- R: what marketing reads, and what it still cannot touch ----------------------------
val R1 "BEGIN; $(as_user $MARA) SELECT (SELECT count(*) FROM public.rides), (SELECT count(*) FROM public.users),
  (SELECT count(*) FROM public.driver_profiles), (SELECT count(*) FROM public.referrals); ROLLBACK;" "1|5|1|1"
val R2 "BEGIN; $(as_user $CARLA) SELECT (SELECT count(*) FROM public.rides), (SELECT count(*) FROM public.users),
  (SELECT count(*) FROM public.driver_profiles), (SELECT count(*) FROM public.referrals); ROLLBACK;" "1|1|0|1"
val R3 "BEGIN; $(as_user $MARA) SELECT (SELECT count(*) FROM public.wallet_accounts), (SELECT count(*) FROM public.admin_actions); ROLLBACK;" "0|0"
val R4 "BEGIN; $(as_user $MARA) WITH u AS (UPDATE public.rides SET status = 'canceled' WHERE id = '$RIDE_C' RETURNING 1)
  SELECT count(*) FROM u; ROLLBACK;" "0"
val R5 "BEGIN; $(as_user $MARA) WITH u AS (UPDATE public.cms_content SET title_es = 'x' RETURNING 1) SELECT count(*) FROM u; ROLLBACK;" "0"
err R5b "BEGIN; $(as_user $MARA) INSERT INTO public.cms_content (slug, title_es, title_en, body_es, body_en)
  VALUES ('x', 'x', 'x', 'x', 'x'); ROLLBACK;" "new row violates row-level security policy"
# R6: approving a driver or rewarding a referral is still admin work (0 rows, no policy lets it through)
val R6 "BEGIN; $(as_user $MARA)
  WITH d AS (UPDATE public.driver_profiles SET status = 'suspended' WHERE id = '$DIEGO_DP' RETURNING 1),
       r AS (UPDATE public.referrals SET status = 'rewarded', bonus_amount = 500 RETURNING 1)
  SELECT (SELECT count(*) FROM d), (SELECT count(*) FROM r); ROLLBACK;" "0|0"

# --- P: promotions, draft and approval --------------------------------------------------
# P1: whatever marketing sends, a new promotion is an inactive draft of its own, unused, unapproved
val P1 "BEGIN; $(as_user $MARA)
  INSERT INTO public.promotions (code, type, discount_percent, is_active, created_by, approved_by, approved_at, current_uses)
  VALUES ('MKT1', 'percentage_discount', 10, true, '$ANA', '$ANA', now(), 7);
  RESET ROLE;
  SELECT is_active, pending_approval, created_by = '$MARA', approved_by IS NULL, approved_at IS NULL, current_uses
  FROM public.promotions WHERE code = 'MKT1'; ROLLBACK;" "f|t|t|t|t|0"
# P2: an edited draft goes back to the admins
val P2 "BEGIN; $(as_user $MARA) UPDATE public.promotions SET title_es = 'Nuevo' WHERE id = '$P_USED'; RESET ROLE;
  SELECT title_es, pending_approval, is_active FROM public.promotions WHERE id = '$P_USED'; ROLLBACK;" "Nuevo|t|f"
err P3 "BEGIN; $(as_user $MARA) UPDATE public.promotions SET is_active = true WHERE id = '$P_USED'; ROLLBACK;" \
  "promo_activation_requires_admin"
err P4 "BEGIN; $(as_user $MARA) UPDATE public.promotions SET discount_percent = 50 WHERE id = '$P_LIVE'; ROLLBACK;" \
  "promo_active_locked"
# P5: marketing may pause a live promotion; pausing is not a new draft
val P5 "BEGIN; $(as_user $MARA) UPDATE public.promotions SET is_active = false WHERE id = '$P_LIVE'; RESET ROLE;
  SELECT is_active, pending_approval FROM public.promotions WHERE id = '$P_LIVE'; ROLLBACK;" "f|f"
# P6: and stamp the push "Notificar ahora" just sent
val P6 "BEGIN; $(as_user $MARA) UPDATE public.promotions SET notified_at = now() WHERE id = '$P_LIVE'; RESET ROLE;
  SELECT is_active, notified_at IS NOT NULL FROM public.promotions WHERE id = '$P_LIVE'; ROLLBACK;" "t|t"
# P7: marketing cannot write the approval columns
val P7 "BEGIN; $(as_user $MARA) UPDATE public.promotions SET pending_approval = false, approved_by = '$ANA', approved_at = now()
  WHERE id = '$P_USED'; RESET ROLE;
  SELECT pending_approval, approved_by IS NULL, approved_at IS NULL FROM public.promotions WHERE id = '$P_USED'; ROLLBACK;" "t|t|t"
val P8 "BEGIN; $(as_user $MARA) INSERT INTO public.promotions (code, type, discount_percent) VALUES ('MKT2', 'percentage_discount', 5);
  DELETE FROM public.promotions WHERE code = 'MKT2'; RESET ROLE;
  SELECT count(*) FROM public.promotions WHERE code = 'MKT2'; ROLLBACK;" "0"
err P9 "BEGIN; $(as_user $MARA) DELETE FROM public.promotions WHERE id = '$P_LIVE'; ROLLBACK;" "promo_delete_blocked"
err P10 "BEGIN; $(as_user $MARA) DELETE FROM public.promotions WHERE id = '$P_USED'; ROLLBACK;" "promo_delete_blocked"
# P11: an admin turning a draft on is the approval
val P11 "BEGIN; $(as_user $MARA) INSERT INTO public.promotions (code, type, discount_percent) VALUES ('MKT3', 'percentage_discount', 5);
  $(as_user $ANA) UPDATE public.promotions SET is_active = true WHERE code = 'MKT3'; RESET ROLE;
  SELECT is_active, pending_approval, approved_by = '$ANA', approved_at IS NOT NULL FROM public.promotions WHERE code = 'MKT3';
  ROLLBACK;" "t|f|t|t"
# P12: an admin's own promotions are never pending; creating one active stamps the approval
val P12 "BEGIN; $(as_user $ANA) INSERT INTO public.promotions (code, type, discount_percent, is_active)
  VALUES ('ADM1', 'percentage_discount', 5, false), ('ADM2', 'percentage_discount', 5, true); RESET ROLE;
  SELECT code, is_active, pending_approval, approved_by IS NOT NULL FROM public.promotions
  WHERE code IN ('ADM1', 'ADM2') ORDER BY code; ROLLBACK;" "ADM1|f|f|f;ADM2|t|f|t"
# P13: service role and SQL without a JWT: unchanged
val P13 "BEGIN; SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE service_role;
  UPDATE public.promotions SET is_active = true WHERE id = '$P_USED'; RESET ROLE;
  SELECT is_active, approved_by IS NULL FROM public.promotions WHERE id = '$P_USED'; ROLLBACK;" "t|t"
val P14 "BEGIN; $(as_user $CARLA) SELECT count(*) FROM public.promotions; ROLLBACK;" "0"
err P14b "BEGIN; $(as_user $CARLA) INSERT INTO public.promotions (code, type, discount_percent)
  VALUES ('CLI1', 'percentage_discount', 5); ROLLBACK;" "new row violates row-level security policy"
val P15 "BEGIN; $(as_user $ANA) UPDATE public.promotions SET discount_percent = 50 WHERE id = '$P_LIVE'; RESET ROLE;
  SELECT discount_percent FROM public.promotions WHERE id = '$P_LIVE'; ROLLBACK;" "50"
val P16 "BEGIN; $(as_user $ANA) DELETE FROM public.promotions WHERE id = '$P_USED'; RESET ROLE;
  SELECT count(*) FROM public.promotions WHERE id = '$P_USED'; ROLLBACK;" "0"

# --- C, A, B, Q: campaigns, announcements, blog, signup codes ----------------------------
val C1 "BEGIN; $(as_user $MARA) INSERT INTO public.campaigns (name, segment_type, message_title, message_body, created_by)
  VALUES ('Lanzamiento', 'all', 'Hola', 'Cuerpo', '$MARA'); SELECT count(*) FROM public.campaigns; ROLLBACK;" "1"
err C2 "BEGIN; $(as_user $MARA) INSERT INTO public.campaigns (name, segment_type, message_title, message_body, created_by)
  VALUES ('Ajena', 'all', 'Hola', 'Cuerpo', '$ANA'); ROLLBACK;" "new row violates row-level security policy"
err C3 "BEGIN; $(as_user $CARLA) INSERT INTO public.campaigns (name, segment_type, message_title, message_body, created_by)
  VALUES ('Cliente', 'all', 'Hola', 'Cuerpo', '$CARLA'); ROLLBACK;" "new row violates row-level security policy"
val A1 "BEGIN; $(as_user $MARA) INSERT INTO public.home_announcements (title_es) VALUES ('Novedad');
  UPDATE public.home_announcements SET is_active = true WHERE title_es = 'Novedad';
  SELECT count(*) FILTER (WHERE is_active) FROM public.home_announcements; ROLLBACK;" "1"
val B1 "BEGIN; $(as_user $MARA) INSERT INTO public.blog_posts (slug, title_es, title_en) VALUES ('borrador', 'Borrador', 'Draft');
  SELECT count(*) FROM public.blog_posts;
  SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE anon; SELECT count(*) FROM public.blog_posts; ROLLBACK;" "2;1"
val Q1 "BEGIN; $(as_user $MARA) INSERT INTO public.acquisition_codes (code, label, channel) VALUES ('mkt-ig', 'Instagram', 'influencer');
  RESET ROLE; SELECT code, created_by = '$MARA' FROM public.acquisition_codes; ROLLBACK;" "MKT-IG|t"

# --- F: the metrics RPCs' gate -----------------------------------------------------------
# The gate is the first statement of each. Past it, the reduced scaffold may lack a table: any error
# then is fine, as long as it is not the gate's.
for f in $METRICS; do
  r=$(run $DB "BEGIN; $(as_user $CARLA) SELECT public.$f; ROLLBACK;")
  if echo "$r" | grep -q "$GATE"; then ok "F1 customer refused: $f"; else ko "F1 customer refused: $f" "got [$r]"; fi
  r=$(run $DB "BEGIN; $(as_user $MARA) SELECT public.$f; ROLLBACK;")
  if echo "$r" | grep -q "$GATE"; then ko "F2 marketing passes the gate: $f" "got [$r]"; else ok "F2 marketing passes the gate: $f"; fi
  r=$(run $DB "BEGIN; $(as_user $ANA) SELECT public.$f; ROLLBACK;")
  if echo "$r" | grep -q "$GATE"; then ko "F3 admin passes the gate: $f" "got [$r]"; else ok "F3 admin passes the gate: $f"; fi
done

# --- T, D, U: the live functions that list roles ----------------------------------------
# T1: marketing rides as a passenger and cancels its own search (RED: "for role marketing")
val T1 "BEGIN; $(as_user $MARA) INSERT INTO public.rides (id, customer_id) VALUES ('$RIDE_M', '$MARA');
  UPDATE public.rides SET status = 'canceled' WHERE id = '$RIDE_M'; RESET ROLE;
  SELECT r.status, t.actor_role FROM public.rides r JOIN public.ride_transitions t ON t.ride_id = r.id
  WHERE r.id = '$RIDE_M'; ROLLBACK;" "canceled|customer"
# T2: marketing with an approved driver profile accepts the ride assigned to it, as a driver
val T2 "BEGIN; INSERT INTO public.driver_profiles (id, user_id, status) VALUES ('$MARA_DP', '$MARA', 'approved');
  UPDATE public.rides SET driver_id = '$MARA_DP' WHERE id = '$RIDE_C';
  $(as_user $MARA) UPDATE public.rides SET status = 'accepted' WHERE id = '$RIDE_C'; RESET ROLE;
  SELECT r.status, t.actor_role FROM public.rides r JOIN public.ride_transitions t ON t.ride_id = r.id
  WHERE r.id = '$RIDE_C'; ROLLBACK;" "accepted|driver"
err T3 "BEGIN; UPDATE public.rides SET driver_id = '$DIEGO_DP' WHERE id = '$RIDE_C';
  $(as_user $CARLA) UPDATE public.rides SET status = 'accepted' WHERE id = '$RIDE_C'; ROLLBACK;" \
  "Invalid ride transition from searching to accepted for role customer"
# D1: approved as a driver, marketing keeps its role and gets a tricicoin wallet (RED: role becomes driver)
val D1 "BEGIN; INSERT INTO public.driver_profiles (id, user_id) VALUES ('$MARA_DP', '$MARA');
  UPDATE public.driver_profiles SET status = 'approved' WHERE id = '$MARA_DP';
  SELECT (SELECT role FROM public.users WHERE id = '$MARA'),
         (SELECT count(*) FROM public.wallet_accounts WHERE user_id = '$MARA' AND account_type = 'tricicoin'); ROLLBACK;" \
  "marketing|1"
val D2 "BEGIN; INSERT INTO public.driver_profiles (id, user_id) VALUES ('$CARLA_DP', '$CARLA');
  UPDATE public.driver_profiles SET status = 'approved' WHERE id = '$CARLA_DP';
  SELECT (SELECT role FROM public.users WHERE id = '$CARLA'),
         (SELECT count(*) FROM public.wallet_accounts WHERE user_id = '$CARLA' AND account_type = 'tricicoin'); ROLLBACK;" \
  "driver|1"
# U1: a marketing passenger gets its rating (RED: 5.00, untouched)
val U1 "BEGIN; SELECT public.apply_user_rating('$MARA'); SELECT rating_avg FROM public.customer_profiles WHERE user_id = '$MARA';
  ROLLBACK;" "4.25"

# --- PR: granting the role --------------------------------------------------------------
val PR1 "BEGIN; $(as_user $SARA) SELECT public.promote_user_role('$CARLA', 'marketing', 'Equipo de marketing (prueba)') ->> 'new_role';
  RESET ROLE; SELECT role FROM public.users WHERE id = '$CARLA';
  SELECT count(*) FROM public.admin_actions WHERE action = 'promote_user_role'; ROLLBACK;" "marketing;marketing;1"
err PR2 "BEGIN; $(as_user $ANA) SELECT public.promote_user_role('$CARLA', 'marketing', 'Equipo de marketing (prueba)'); ROLLBACK;" \
  "only super_admin can promote user roles"

# --- N: the guards refuse what they do not know (separate database, GREEN only) ----------
apply_once(){ $BIN/psql $CONN -d "$1" -q -1 -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" 2>&1 | tr -d '\r'; }
if [ "$MIG" != none ]; then
  # N1: a metrics RPC whose live body drifted: the file stops instead of patching it blindly
  load $GUARD
  run $GUARD "$AS_OWNER DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.get_rides_by_day(integer)'::regprocedure),
    'IF NOT is_admin() THEN', 'IF NOT is_admin() THEN -- drift'); END \$d\$;" >/dev/null
  r=$(apply_once $GUARD)
  if echo "$r" | grep -q "get_rides_by_day(integer) has a body this file does not know"; then ok N1; else ko N1 "got [$r]"; fi
  # N2: and nothing of the file stayed behind
  val N2 "SELECT (SELECT count(*) FROM pg_proc WHERE proname = 'is_marketing'),
    (SELECT count(*) FROM information_schema.columns WHERE table_name = 'promotions' AND column_name = 'pending_approval'),
    (SELECT count(*) FROM pg_policies WHERE policyname LIKE '%\\_marketing')" "0|0|0" $GUARD
  # N3: same for a role-list function
  load $GUARD
  run $GUARD "$AS_OWNER DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.enforce_ride_transition()'::regprocedure),
    'RETURN NEW;', 'RETURN NEW; -- drift'); END \$d\$;" >/dev/null
  r=$(apply_once $GUARD)
  if echo "$r" | grep -q "enforce_ride_transition() has a body this file does not know"; then ok N3; else ko N3 "got [$r]"; fi
  # N4: a policy that already has one of the names but does not use is_marketing(): the final check refuses it
  load $GUARD
  run $GUARD "$AS_OWNER CREATE POLICY rides_select_marketing ON public.rides FOR SELECT TO authenticated USING (false);" >/dev/null
  r=$(apply_once $GUARD)
  if echo "$r" | grep -q "policy rides_select_marketing on rides does not use is_marketing()"; then ok N4; else ko N4 "got [$r]"; fi
  $BIN/dropdb $CONN --if-exists $GUARD >/dev/null 2>&1
fi

echo "----"
echo "PASS $PASS  FAIL $FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run it without 00641 and confirm RED**

```bash
chmod +x supabase/tests/00641/run.sh
supabase/tests/00641/run.sh none 2>&1 | tail -60
```

Expected: L1 and E1 PASS (if L1 fails, a body in `live-bodies.sql` is not prod's: redo Task 1). FAIL on G1, G2, G3, M1, M2, M3, R1, P1–P13, C1, A1, B1, Q1, every F2, T1, D1, U1. PASS on R2–R6, P14, P14b, P15, P16, C2, C3, every F1 and F3, T2, T3, D2, PR1, PR2. The N section is skipped. Save the output: it goes into the PR body.

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/00641/run.sh
git commit -m "test(00641): rehearsal for the marketing role, red without the migration"
```

---

### Task 5: Migration 00641 (GREEN)

**Files:**
- Create: `supabase/migrations/00641_marketing_role_permissions.sql`

- [ ] **Step 1: Write the migration**

````sql
-- ============================================================
-- 00641 — marketing role: what a marketing account may read and write
--
-- Spec: docs/superpowers/specs/2026-10-08-marketing-role-design.md
-- Needs 00640 (the enum value) committed first: a value added by ALTER TYPE cannot be used in
-- the transaction that adds it.
--
--   1. is_marketing(): the twin of is_admin() (00592), anon-safe.
--   2. Promotions: approval columns and a draft-and-approve trigger. Marketing creates and edits
--      drafts; only an admin or super_admin turns a promotion on, and that stamps the approval.
--   3. Policies, all named *_marketing so a rollback can drop exactly these. Nothing that exists
--      today is loosened for any other role.
--   4. The metrics RPCs the marketing pages call let marketing through their admin gate.
--   5. Three live functions that list roles learn about marketing: it rides as a passenger, keeps
--      its role when approved as a driver, and gets its passenger rating.
--   6. Checks of everything above. A failed check aborts the whole file.
--
-- Every function patch starts from the live body, runs only on the body this file was written
-- against (md5 below), is skipped on the body it leaves, and refuses any other body.
-- No statement here drops or removes anything.
--
-- Rehearsal: supabase/tests/00641/run.sh (RED without this file, GREEN with it, applied twice)
-- ============================================================

-- Creating a policy locks its table. Waiting behind a long transaction would queue the app's
-- reads behind us; failing fast and retrying is better.
SET lock_timeout = '5s';

-- 1. is_marketing() -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_marketing()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- No JWT subject: anon, service role, cron. None of them is marketing, and anon may not
  -- call current_user_role() (00517). Same early return as is_admin() (00592).
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() = 'marketing';
END;
$$;
REVOKE ALL ON FUNCTION public.is_marketing() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_marketing() TO anon, authenticated, service_role;

-- 2. Promotions: draft and approval ---------------------------------------------------------
ALTER TABLE public.promotions
  ADD COLUMN IF NOT EXISTS pending_approval boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

COMMENT ON COLUMN public.promotions.pending_approval IS
  'true while a promotion created or edited by marketing waits for an admin to turn it on (00641).';

CREATE OR REPLACE FUNCTION public.tg_promotions_marketing_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF public.is_admin() THEN
    -- An admin or super_admin turning a promotion on: that is the approval.
    IF TG_OP <> 'DELETE' AND NEW.is_active AND (TG_OP = 'INSERT' OR NOT OLD.is_active) THEN
      NEW.pending_approval := false;
      NEW.approved_by := auth.uid();
      NEW.approved_at := now();
    END IF;
  ELSIF public.is_marketing() THEN
    IF TG_OP = 'INSERT' THEN
      -- A draft, whatever the request says. Only an admin turns it on.
      NEW.is_active := false;
      NEW.pending_approval := true;
      NEW.created_by := auth.uid();
      NEW.approved_by := NULL;
      NEW.approved_at := NULL;
      NEW.current_uses := 0;
      NEW.notified_at := NULL;
    ELSIF TG_OP = 'UPDATE' AND OLD.is_active THEN
      -- A live promotion: marketing may pause it, or stamp the push "Notificar ahora" just sent.
      IF (to_jsonb(NEW) - 'is_active' - 'notified_at') IS DISTINCT FROM (to_jsonb(OLD) - 'is_active' - 'notified_at') THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'Pausa la promoción para editarla.',
          DETAIL = 'promo_active_locked';
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      IF NEW.is_active THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'Solo un administrador puede activar una promoción.',
          DETAIL = 'promo_activation_requires_admin';
      END IF;
      -- An edited draft goes back to the admins. Marketing never writes the approval or the counters.
      NEW.pending_approval := true;
      NEW.approved_by := OLD.approved_by;
      NEW.approved_at := OLD.approved_at;
      NEW.created_by := OLD.created_by;
      NEW.current_uses := OLD.current_uses;
    ELSIF OLD.is_active OR OLD.current_uses > 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Solo se puede borrar una promoción pausada que nadie usó.',
        DETAIL = 'promo_delete_blocked';
    END IF;
  END IF;
  -- Service role, cron and SQL without a JWT: unchanged.
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_promotions_marketing_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_promotions_marketing_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.promotions
  FOR EACH ROW EXECUTE FUNCTION public.tg_promotions_marketing_guard();

-- 3. Policies -------------------------------------------------------------------------------
-- Additive only: each one lets marketing do what its pages need. A policy that already exists
-- with the same name is kept, and step 6 checks that it uses is_marketing().
DO $policies$
DECLARE
  c_m constant text := '(SELECT public.is_marketing())';
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- Reading, for the metrics pages, the campaign segments and the referral list.
      ('rides',              'rides_select_marketing',           'SELECT', c_m,  NULL::text),
      ('users',              'users_select_marketing',           'SELECT', c_m,  NULL),
      ('driver_profiles',    'driver_profiles_select_marketing', 'SELECT', c_m,  NULL),
      ('referrals',          'referrals_select_marketing',       'SELECT', c_m,  NULL),
      -- Promotions: the trigger above decides what a write may change.
      ('promotions',         'promotions_select_marketing',      'SELECT', c_m,  NULL),
      ('promotions',         'promotions_insert_marketing',      'INSERT', NULL, c_m),
      ('promotions',         'promotions_update_marketing',      'UPDATE', c_m,  c_m),
      ('promotions',         'promotions_delete_marketing',      'DELETE', c_m,  NULL),
      -- Campaigns: the page reads them and inserts its own.
      ('campaigns',          'campaigns_select_marketing',       'SELECT', c_m,  NULL),
      ('campaigns',          'campaigns_insert_marketing',       'INSERT', NULL, c_m || ' AND created_by = (SELECT auth.uid())'),
      -- Content and signup codes: full control, like the admins.
      ('home_announcements', 'home_announcements_all_marketing', 'ALL',    c_m,  c_m),
      ('blog_posts',         'blog_posts_all_marketing',         'ALL',    c_m,  c_m),
      ('acquisition_codes',  'acquisition_codes_all_marketing',  'ALL',    c_m,  c_m)
    ) AS v(tbl, name, cmd, using_expr, check_expr)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies
                   WHERE schemaname = 'public' AND tablename = r.tbl AND policyname = r.name) THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR %s TO authenticated%s%s',
        r.name, r.tbl, r.cmd,
        CASE WHEN r.using_expr IS NULL THEN '' ELSE ' USING (' || r.using_expr || ')' END,
        CASE WHEN r.check_expr IS NULL THEN '' ELSE ' WITH CHECK (' || r.check_expr || ')' END);
    END IF;
  END LOOP;
END
$policies$;

-- 4. Metrics RPCs ---------------------------------------------------------------------------
-- The admin gate of each one becomes "admin or marketing". Two spellings exist in prod; the
-- whole condition is replaced, never just is_admin() (that would leave "public.(...)").
-- get_platform_earnings stays admin-only: only /earnings calls it.
DO $patch$
DECLARE
  c_gate constant text := 'IF NOT (public.is_admin() OR public.is_marketing()) THEN';
  r record;
  v_src text;
  v_md5 text;
  v_target text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.admin_launch_pulse(integer)',          '21c359c7427f75016c38b6b758ad23a7', 'bb5d37a5bca57a64d3e3409ada2dd6b6'),
      ('public.admin_signup_code_stats()',            '079bc5a6c046e6896c62200f71fc7740', '16a8ed1ebe03aa82f2f75676783a9099'),
      ('public.get_admin_dashboard_metrics()',        '0c99d4e89b08ad2da5989642e09ba5bf', '32cec76d3f079f6938b09f8bb7e919b2'),
      ('public.get_admin_wallet_stats()',             '86c6ef03c7c39d56e9f84cc8795dfbfd', '0f937c94cda1d26e7dd2da7d574949dd'),
      ('public.get_rides_by_day(integer)',            '68dcc98aaa0919c942eafc22e6cfe06a', 'fd5363b072a17da61325a23cfd1486af'),
      ('public.get_rides_by_service_type(integer)',   'c94b1028a03b16d34d25f4a2a56d4bd6', 'ffd6c633752a21bba4945625fc9aaaaf'),
      ('public.get_rides_by_payment_method(integer)', '351484791e08451565cc6fbae34fef2e', '2ecacefdfef6c96da84d3b2f20a0b138'),
      ('public.get_top_drivers(integer)',             'cb273bf7da9f5c3d58b495ba08d6714b', '03e7be0213769612782ed3bcb0183f3a'),
      ('public.get_active_push_user_ids(integer)',    'e3d6f508efe28decb7141f3251410f50', '875f787da6a1c0fcce8708404efd72d8')
    ) AS v(fn, old_md5, new_md5)
  LOOP
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = r.fn::regprocedure;
    v_md5 := md5(v_src);
    CONTINUE WHEN v_md5 = r.new_md5;
    IF v_md5 <> r.old_md5 THEN
      RAISE EXCEPTION '00641: % has a body this file does not know (md5 %); patch it from the live body', r.fn, v_md5;
    END IF;
    v_target := CASE WHEN position('IF NOT public.is_admin() THEN' IN v_src) > 0
                     THEN 'IF NOT public.is_admin() THEN' ELSE 'IF NOT is_admin() THEN' END;
    IF (length(v_src) - length(replace(v_src, v_target, ''))) / length(v_target) <> 1 THEN
      RAISE EXCEPTION '00641: the admin gate is not in % exactly once', r.fn;
    END IF;
    EXECUTE replace(pg_get_functiondef(r.fn::regprocedure), v_target, c_gate);
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = r.fn::regprocedure;
    IF v_md5 <> r.new_md5 THEN
      RAISE EXCEPTION '00641: % patched to an unexpected body (md5 %)', r.fn, v_md5;
    END IF;
  END LOOP;
END
$patch$;

-- 5. Live functions that list roles ---------------------------------------------------------
DO $patch$
DECLARE
  r record;
  v_src text;
  v_md5 text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- valid_transitions lists customer, driver, admin and super_admin. Marketing rides as a
      -- passenger: without this it could not even cancel its own search.
      ('public.enforce_ride_transition()',
       '35bde4fd60a4a4fa0fc86a237ec4a414', 'f806997fab31c18e7b369e69f5321c30',
       $t$  SELECT role INTO v_user_role FROM users WHERE id = auth.uid();
$t$,
       $t$  SELECT role INTO v_user_role FROM users WHERE id = auth.uid();

  -- Marketing rides as a passenger: its rights over a ride are a customer's
  -- (or a driver's, below, when it owns the approved driver profile).
  IF v_user_role = 'marketing' THEN
    v_user_role := 'customer';
  END IF;
$t$),
      -- Approving a driver profile turned every other role into 'driver'. Marketing keeps its
      -- role, as admins do.
      ('public.ensure_driver_role_and_tricicoin_on_approval()',
       'ed41bc2fe192ceb6dbafd163507934f3', '1940d4379a446c8afdf0d47434945c07',
       $t$role NOT IN ('driver', 'admin', 'super_admin')$t$,
       $t$role NOT IN ('driver', 'admin', 'super_admin', 'marketing')$t$),
      -- A marketing passenger gets its rating, like customers and admins.
      ('public.apply_user_rating(uuid)',
       '8d0b0de3bf82f6d15d8da36462cbbe9c', '96be8c154990651738312ef44861242f',
       $t$v_role IN ('customer', 'super_admin', 'admin')$t$,
       $t$v_role IN ('customer', 'super_admin', 'admin', 'marketing')$t$)
    ) AS v(fn, old_md5, new_md5, target, repl)
  LOOP
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = r.fn::regprocedure;
    v_md5 := md5(v_src);
    CONTINUE WHEN v_md5 = r.new_md5;
    IF v_md5 <> r.old_md5 THEN
      RAISE EXCEPTION '00641: % has a body this file does not know (md5 %); patch it from the live body', r.fn, v_md5;
    END IF;
    IF (length(v_src) - length(replace(v_src, r.target, ''))) / length(r.target) <> 1 THEN
      RAISE EXCEPTION '00641: the role list is not in % exactly once', r.fn;
    END IF;
    EXECUTE replace(pg_get_functiondef(r.fn::regprocedure), r.target, r.repl);
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = r.fn::regprocedure;
    IF v_md5 <> r.new_md5 THEN
      RAISE EXCEPTION '00641: % patched to an unexpected body (md5 %)', r.fn, v_md5;
    END IF;
  END LOOP;
END
$patch$;

-- 6. What this file promises ----------------------------------------------------------------
DO $check$
DECLARE
  v_tbl text;
  v_name text;
  v_def text;
BEGIN
  -- is_marketing(): invoker, callable by the API roles (policies call it), false without a JWT.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.is_marketing()'::regprocedure) THEN
    RAISE EXCEPTION '00641: is_marketing() must not be SECURITY DEFINER';
  END IF;
  IF NOT has_function_privilege('anon', 'public.is_marketing()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.is_marketing()', 'EXECUTE') THEN
    RAISE EXCEPTION '00641: anon and authenticated must be able to call is_marketing()';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  SET LOCAL ROLE anon;
  IF public.is_marketing() THEN
    RAISE EXCEPTION '00641: is_marketing() is true without a JWT';
  END IF;
  RESET ROLE;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.promotions'::regclass
                   AND tgname = 'trg_promotions_marketing_guard' AND tgenabled = 'O') THEN
    RAISE EXCEPTION '00641: trg_promotions_marketing_guard is missing or disabled';
  END IF;

  FOR v_tbl, v_name IN
    SELECT * FROM (VALUES
      ('rides', 'rides_select_marketing'), ('users', 'users_select_marketing'),
      ('driver_profiles', 'driver_profiles_select_marketing'), ('referrals', 'referrals_select_marketing'),
      ('promotions', 'promotions_select_marketing'), ('promotions', 'promotions_insert_marketing'),
      ('promotions', 'promotions_update_marketing'), ('promotions', 'promotions_delete_marketing'),
      ('campaigns', 'campaigns_select_marketing'), ('campaigns', 'campaigns_insert_marketing'),
      ('home_announcements', 'home_announcements_all_marketing'), ('blog_posts', 'blog_posts_all_marketing'),
      ('acquisition_codes', 'acquisition_codes_all_marketing')
    ) AS v(t, n)
  LOOP
    SELECT coalesce(qual, '') || ' ' || coalesce(with_check, '') INTO v_def
    FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl AND policyname = v_name;
    IF v_def IS NULL THEN
      RAISE EXCEPTION '00641: policy % on % is missing', v_name, v_tbl;
    END IF;
    IF position('is_marketing()' IN v_def) = 0 THEN
      RAISE EXCEPTION '00641: policy % on % does not use is_marketing()', v_name, v_tbl;
    END IF;
  END LOOP;

  FOR v_name, v_def IN
    SELECT * FROM (VALUES
      ('public.admin_launch_pulse(integer)', 'bb5d37a5bca57a64d3e3409ada2dd6b6'),
      ('public.admin_signup_code_stats()', '16a8ed1ebe03aa82f2f75676783a9099'),
      ('public.get_admin_dashboard_metrics()', '32cec76d3f079f6938b09f8bb7e919b2'),
      ('public.get_admin_wallet_stats()', '0f937c94cda1d26e7dd2da7d574949dd'),
      ('public.get_rides_by_day(integer)', 'fd5363b072a17da61325a23cfd1486af'),
      ('public.get_rides_by_service_type(integer)', 'ffd6c633752a21bba4945625fc9aaaaf'),
      ('public.get_rides_by_payment_method(integer)', '2ecacefdfef6c96da84d3b2f20a0b138'),
      ('public.get_top_drivers(integer)', '03e7be0213769612782ed3bcb0183f3a'),
      ('public.get_active_push_user_ids(integer)', '875f787da6a1c0fcce8708404efd72d8'),
      ('public.enforce_ride_transition()', 'f806997fab31c18e7b369e69f5321c30'),
      ('public.ensure_driver_role_and_tricicoin_on_approval()', '1940d4379a446c8afdf0d47434945c07'),
      ('public.apply_user_rating(uuid)', '96be8c154990651738312ef44861242f')
    ) AS v(fn, md5)
  LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_name::regprocedure) <> v_def THEN
      RAISE EXCEPTION '00641: % does not have the patched body', v_name;
    END IF;
  END LOOP;
END
$check$;

RESET lock_timeout;
````

- [ ] **Step 2: Run the rehearsal with it and confirm GREEN**

```bash
supabase/tests/00641/run.sh supabase/migrations/00641_marketing_role_permissions.sql 2>&1 | tail -80
```

Expected: every test PASS, including N1–N4, and the last line `PASS <n>  FAIL 0`. Save the output for the PR body.

If G1 fails for one function, compare its body with the target by reading `pg_get_functiondef` in `pr641`: usually a whitespace difference in the dollar-quoted target or replacement. Do not change the expected md5 values: they were computed on prod's live bodies.

- [ ] **Step 3: Record the md5 of the two new functions (needed to verify prod in Task 20)**

```bash
/usr/lib/postgresql/16/bin/psql -h 127.0.0.1 -p 5433 -U pgtest -d pr641 -qAt -c "
SELECT proname || '=' || md5(prosrc) FROM pg_proc
WHERE proname IN ('is_marketing', 'tg_promotions_marketing_guard') ORDER BY proname"
```

Write both lines into the PR body draft (scratchpad), under "Expected in prod".

- [ ] **Step 4: Check the migration has no destructive statement and no CR**

```bash
grep -nE "\b(DROP|TRUNCATE)\b|DELETE FROM" supabase/migrations/00641_marketing_role_permissions.sql; echo "exit $?"
tr -cd '\r' < supabase/migrations/00641_marketing_role_permissions.sql | wc -c
pnpm check:migration-grants
```

Expected: no grep match (`exit 1`), `0` carriage returns, and the grants check passes (00641 creates no table).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00641_marketing_role_permissions.sql
git commit -m "feat(db): marketing role permissions, promotion approval and role-list fixes"
```

---

### Task 6: `UserRole` and the promotion service

**Files:**
- Modify: `packages/types/src/enums.ts:6`
- Modify: `packages/api/src/services/promotion.service.ts`
- Create: `packages/api/src/services/__tests__/promotion.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/api/src/services/__tests__/promotion.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFrom = vi.fn();
const mockSupabase = { from: mockFrom };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

import { promotionService } from '../promotion.service';

function mockCountChain(result: { count: number | null; error: unknown }) {
  const eq = vi.fn().mockResolvedValue(result);
  const select = vi.fn(() => ({ eq }));
  mockFrom.mockReturnValueOnce({ select });
  return { select, eq };
}

describe('promotionService.countPendingApproval', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('counts the promotions waiting for an admin', async () => {
    const { select, eq } = mockCountChain({ count: 3, error: null });

    await expect(promotionService.countPendingApproval()).resolves.toBe(3);

    expect(mockFrom).toHaveBeenCalledWith('promotions');
    expect(select).toHaveBeenCalledWith('id', { count: 'exact', head: true });
    expect(eq).toHaveBeenCalledWith('pending_approval', true);
  });

  it('is 0 when the column does not exist yet (00641 not applied)', async () => {
    mockCountChain({ count: null, error: { message: 'column promotions.pending_approval does not exist' } });
    await expect(promotionService.countPendingApproval()).resolves.toBe(0);
  });

  it('is 0 when the query throws', async () => {
    mockFrom.mockImplementationOnce(() => {
      throw new Error('network');
    });
    await expect(promotionService.countPendingApproval()).resolves.toBe(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
pnpm --filter @tricigo/api exec vitest run src/services/__tests__/promotion.test.ts
```

Expected: FAIL, `promotionService.countPendingApproval is not a function`.

- [ ] **Step 3: Implement**

In `packages/types/src/enums.ts` replace line 6 with:

```ts
export type UserRole = 'customer' | 'driver' | 'admin' | 'super_admin' | 'marketing';
```

In `packages/api/src/services/promotion.service.ts`, add to `interface Promotion`, after `is_public: boolean;`:

```ts
  /** 00641: true while a promotion marketing created or edited waits for an admin to turn it on. */
  pending_approval?: boolean;
  /** 00641: the admin who turned it on, and when. */
  approved_by?: string | null;
  approved_at?: string | null;
```

Replace the `CreatePromotionInput` type with:

```ts
export type CreatePromotionInput = Omit<
  Promotion,
  'id' | 'current_uses' | 'created_at' | 'created_by' | 'pending_approval' | 'approved_by' | 'approved_at'
>;
```

Add this method to `promotionService`, after `remove`:

```ts
  /**
   * How many promotions marketing left waiting for an admin (00641). 0 when the column does
   * not exist yet or the query fails: it only drives a menu dot and a notice.
   */
  async countPendingApproval(): Promise<number> {
    try {
      const supabase = getSupabaseClient();
      const { count, error } = await supabase
        .from('promotions')
        .select('id', { count: 'exact', head: true })
        .eq('pending_approval', true);
      if (error) return 0;
      return count ?? 0;
    } catch {
      return 0;
    }
  },
```

- [ ] **Step 4: Run the test and the type check**

```bash
pnpm --filter @tricigo/api exec vitest run src/services/__tests__/promotion.test.ts
pnpm check-types
```

Expected: 3 tests PASS; `check-types` passes in every package.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/enums.ts packages/api/src/services/promotion.service.ts packages/api/src/services/__tests__/promotion.test.ts
git commit -m "feat(api): marketing in UserRole and a count of promotions awaiting approval"
```

---

### Task 7: The panel allow-list (`@tricigo/utils/adminPanelAccess`)

**Files:**
- Create: `packages/utils/src/adminPanelAccess.ts`
- Create: `packages/utils/src/__tests__/adminPanelAccess.test.ts`
- Modify: `packages/utils/package.json` (`exports`)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  MARKETING_HOME,
  MARKETING_ROUTES,
  canOpenPanelPath,
  isPanelRole,
  menuRole,
  panelHome,
} from '../adminPanelAccess';

describe('isPanelRole', () => {
  it('accepts the three panel roles', () => {
    for (const role of ['admin', 'super_admin', 'marketing']) expect(isPanelRole(role)).toBe(true);
  });

  it('rejects every other value', () => {
    for (const role of ['customer', 'driver', '', 'Admin', null, undefined, 42]) expect(isPanelRole(role)).toBe(false);
  });
});

describe('canOpenPanelPath', () => {
  it('lets admins and super admins open everything', () => {
    for (const path of ['/', '/wallet', '/settings/pricing', '/promotions']) {
      expect(canOpenPanelPath('admin', path)).toBe(true);
      expect(canOpenPanelPath('super_admin', path)).toBe(true);
    }
  });

  it('lets marketing open its pages and their sub-pages', () => {
    for (const route of MARKETING_ROUTES) {
      expect(canOpenPanelPath('marketing', route)).toBe(true);
      expect(canOpenPanelPath('marketing', `${route}/abc`)).toBe(true);
    }
  });

  it('keeps marketing out of everything else', () => {
    for (const path of ['/', '/wallet', '/wallet/gifts', '/users', '/users/1', '/drivers', '/rides', '/settings',
      '/notifications', '/content', '/competitors', '/earnings', '/support']) {
      expect(canOpenPanelPath('marketing', path)).toBe(false);
    }
  });

  it('does not take a longer name for a sub-page', () => {
    expect(canOpenPanelPath('marketing', '/promotionsx')).toBe(false);
    expect(canOpenPanelPath('marketing', '/blog-admin')).toBe(false);
  });
});

describe('panelHome and menuRole', () => {
  it('sends marketing to the launch pulse and admins to the dashboard', () => {
    expect(panelHome('marketing')).toBe(MARKETING_HOME);
    expect(canOpenPanelPath('marketing', MARKETING_HOME)).toBe(true);
    expect(panelHome('admin')).toBe('/');
    expect(panelHome('super_admin')).toBe('/');
  });

  it('uses the least privileged menus when the role is unknown', () => {
    expect(menuRole(null)).toBe('marketing');
    expect(menuRole(undefined)).toBe('marketing');
    expect(menuRole('admin')).toBe('admin');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
pnpm --filter @tricigo/utils exec vitest run src/__tests__/adminPanelAccess.test.ts
```

Expected: FAIL, cannot resolve `../adminPanelAccess`.

- [ ] **Step 3: Implement**

`packages/utils/src/adminPanelAccess.ts`:

```ts
/**
 * Who may open which admin panel page (00641, marketing role).
 *
 * One module for the middleware, the sidebar and the bottom bar, so a menu never offers a page
 * the middleware refuses. It only shapes the panel: every permission is also enforced on the
 * server (RLS, RPC gates, Edge Functions).
 *
 * Imported as `@tricigo/utils/adminPanelAccess` so the middleware does not load the utils barrel.
 * Spec: docs/superpowers/specs/2026-10-08-marketing-role-design.md
 */
export type PanelRole = 'admin' | 'super_admin' | 'marketing';

const PANEL_ROLES: readonly string[] = ['admin', 'super_admin', 'marketing'];

/** The pages marketing may open. Each one also covers its sub-pages. */
export const MARKETING_ROUTES: readonly string[] = [
  '/launch-pulse',
  '/funnel',
  '/code-performance',
  '/segments',
  '/reports',
  '/referrals',
  '/promotions',
  '/campaigns',
  '/announcements',
  '/blog',
];

/** Where marketing lands, and where the middleware sends it from any other page. */
export const MARKETING_HOME = '/launch-pulse';

export function isPanelRole(role: unknown): role is PanelRole {
  return typeof role === 'string' && PANEL_ROLES.includes(role);
}

/** The role the menus use. When the role could not be read: the least privileged one. */
export function menuRole(role: PanelRole | null | undefined): PanelRole {
  return role ?? 'marketing';
}

export function panelHome(role: PanelRole): string {
  return role === 'marketing' ? MARKETING_HOME : '/';
}

export function canOpenPanelPath(role: PanelRole, pathname: string): boolean {
  if (role !== 'marketing') return true;
  return MARKETING_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}
```

In `packages/utils/package.json`, add to `exports` after `"./addressSearch": "./src/addressSearch.ts",`:

```json
    "./adminPanelAccess": "./src/adminPanelAccess.ts",
```

- [ ] **Step 4: Run the test**

```bash
pnpm --filter @tricigo/utils exec vitest run src/__tests__/adminPanelAccess.test.ts
```

Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/utils/src/adminPanelAccess.ts packages/utils/src/__tests__/adminPanelAccess.test.ts packages/utils/package.json
git commit -m "feat(utils): admin panel allow-list for the marketing role"
```

---

### Task 8: `panel-roles` for the Edge Functions

**Files:**
- Create: `supabase/functions/_shared/panel-roles.ts`
- Create: `supabase/functions/_shared/panel-roles.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { MARKETING_PUSH_CATEGORIES, canSendPush, isAdminRole, isPanelStaffRole } from './panel-roles';

describe('panel roles', () => {
  it('knows the admin roles', () => {
    expect(isAdminRole('admin')).toBe(true);
    expect(isAdminRole('super_admin')).toBe(true);
    for (const role of ['marketing', 'customer', 'driver', null, undefined]) expect(isAdminRole(role)).toBe(false);
  });

  it('counts marketing as panel staff, nobody else outside the admins', () => {
    for (const role of ['admin', 'super_admin', 'marketing']) expect(isPanelStaffRole(role)).toBe(true);
    for (const role of ['customer', 'driver', '', null, undefined]) expect(isPanelStaffRole(role)).toBe(false);
  });

  it('lets an admin send any push, categorized or not', () => {
    expect(canSendPush('admin', 'ride_offer')).toBe(true);
    expect(canSendPush('super_admin', undefined)).toBe(true);
  });

  it("lets marketing send only its pages' content categories", () => {
    expect([...MARKETING_PUSH_CATEGORIES].sort()).toEqual(['announcement', 'blog', 'campaign', 'promo']);
    for (const category of MARKETING_PUSH_CATEGORIES) expect(canSendPush('marketing', category)).toBe(true);
    for (const category of ['ride_offer', 'system', 'sos', 'payment', 'news', undefined, null]) {
      expect(canSendPush('marketing', category)).toBe(false);
    }
  });

  it('never lets anyone else send', () => {
    expect(canSendPush('customer', 'campaign')).toBe(false);
    expect(canSendPush(null, 'campaign')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
pnpm --filter @tricigo/api exec vitest run ../../supabase/functions/_shared/panel-roles.test.ts
```

Expected: FAIL, cannot resolve `./panel-roles`.

- [ ] **Step 3: Implement**

`supabase/functions/_shared/panel-roles.ts`:

```ts
// ============================================================
// Panel roles for Edge Functions (00641, marketing role).
//
// Admins and super_admins may call the panel's broadcast functions for anything. Marketing may
// send the pushes its pages send (campaigns, home announcements, promotions, blog) and bulk
// campaign e-mail, nothing else: no ride, system, safety or one-user pushes.
//
// Spec: docs/superpowers/specs/2026-10-08-marketing-role-design.md
// Pure module: no remote imports, so packages/api's vitest runs it unmodified.
// ============================================================

/** The push categories marketing's pages send. */
export const MARKETING_PUSH_CATEGORIES: ReadonlySet<string> = new Set(['campaign', 'announcement', 'promo', 'blog']);

export function isAdminRole(role: unknown): boolean {
  return role === 'admin' || role === 'super_admin';
}

/** Roles that may call the panel's broadcast functions at all. */
export function isPanelStaffRole(role: unknown): boolean {
  return isAdminRole(role) || role === 'marketing';
}

/** Admins send any category. Marketing sends only its content categories, never an uncategorized push. */
export function canSendPush(role: unknown, category: string | null | undefined): boolean {
  if (isAdminRole(role)) return true;
  return role === 'marketing' && typeof category === 'string' && MARKETING_PUSH_CATEGORIES.has(category);
}
```

- [ ] **Step 4: Run the test**

```bash
pnpm --filter @tricigo/api exec vitest run ../../supabase/functions/_shared/panel-roles.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/panel-roles.ts supabase/functions/_shared/panel-roles.test.ts
git commit -m "feat(ef): shared rules for which panel role may broadcast what"
```

---

### Task 9: `send-push` accepts marketing for content categories

**Files:**
- Modify: `supabase/functions/send-push/index.ts`
- Create: `supabase/functions/send-push/index.test.ts`
- Modify: `packages/api/vitest.config.ts`

- [ ] **Step 1: Write the failing handler test**

`supabase/functions/send-push/index.test.ts`:

```ts
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the real send-push handler to check who may send which push (00641, marketing role).
// supabase-js (esm.sh) is replaced with a fake client: a session table for auth.getUser, a role
// per user, and empty answers for everything else (no device tokens, so nothing reaches Expo).
// The rate limiter is replaced too: it is DB-backed and imports supabase-js itself.

const db = vi.hoisted(() => ({
  sessions: {} as Record<string, string>,
  roles: {} as Record<string, string>,
  inserts: [] as Array<{ table: string; rows: unknown }>,
}));

vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => {
  function query(table: string) {
    let id: string | null = null;
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.in = () => q;
    q.not = () => q;
    q.eq = (col: string, val: string) => {
      if (col === 'id') id = val;
      return q;
    };
    q.single = () =>
      Promise.resolve(
        table === 'users' && id && db.roles[id]
          ? { data: { role: db.roles[id] }, error: null }
          : { data: null, error: { message: 'no rows' } },
      );
    q.insert = (rows: unknown) => {
      db.inserts.push({ table, rows });
      return Promise.resolve({ data: null, error: null });
    };
    q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(ok, ko);
    return q;
  }
  return {
    createClient: () => ({
      auth: {
        getUser: (token: string) =>
          Promise.resolve(
            db.sessions[token]
              ? { data: { user: { id: db.sessions[token] } }, error: null }
              : { data: { user: null }, error: { message: 'invalid JWT' } },
          ),
      },
      from: (table: string) => query(table),
    }),
  };
});

vi.mock('../_shared/rate-limiter.ts', () => ({
  rateLimit: vi.fn(async () => ({ allowed: true, remaining: 29, retryAfterMs: 0 })),
  rateLimitResponse: vi.fn(() => new Response('{}', { status: 429 })),
}));

// Fake key material: same shape as a real secret key, not a credential.
const SERVICE_KEY = 'sb_secret_TESTtestTESTtestTESTtest01';
const env: Record<string, string> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SERVICE_KEY }),
};

let handler: (req: Request) => Promise<Response>;

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (k: string) => env[k] },
    serve: (h: (req: Request) => Promise<Response>) => {
      handler = h;
    },
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"data":[]}', { status: 200 })));
  await import('./index.ts');
});

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const MARKETING = '00000000-0000-4000-8000-0000000000b1';
const CUSTOMER = '00000000-0000-4000-8000-0000000000c1';
const TARGET = '00000000-0000-4000-8000-0000000000d1';

beforeEach(() => {
  db.inserts.length = 0;
  db.sessions = { 'jwt-admin': ADMIN, 'jwt-marketing': MARKETING, 'jwt-customer': CUSTOMER };
  db.roles = { [ADMIN]: 'admin', [MARKETING]: 'marketing', [CUSTOMER]: 'customer' };
});

const push = (token: string, category?: string) =>
  handler(
    new Request('https://example.supabase.co/functions/v1/send-push', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_ids: [TARGET], title: 'Hola', body: 'Cuerpo', ...(category ? { category } : {}) }),
    }),
  );

describe('send-push: who may send which push', () => {
  it.each(['campaign', 'announcement', 'promo', 'blog'])('marketing may send a %s push', async (category) => {
    const res = await push('jwt-marketing', category);
    expect(res.status).toBe(200);
    expect(db.inserts.map((i) => i.table)).toEqual(['notifications']);
  });

  it.each(['ride_offer', 'system', 'sos', 'payment'])('marketing may not send a %s push', async (category) => {
    const res = await push('jwt-marketing', category);
    expect(res.status).toBe(403);
    expect(db.inserts).toEqual([]);
  });

  it("marketing may not send an uncategorized push (the panel's one-user push)", async () => {
    const res = await push('jwt-marketing');
    expect(res.status).toBe(403);
    expect(db.inserts).toEqual([]);
  });

  it('an admin still sends any category', async () => {
    expect((await push('jwt-admin', 'system')).status).toBe(200);
    expect((await push('jwt-admin')).status).toBe(200);
  });

  it('a customer is still refused', async () => {
    expect((await push('jwt-customer', 'campaign')).status).toBe(403);
    expect(db.inserts).toEqual([]);
  });
});
```

In `packages/api/vitest.config.ts`, add after the `send-bulk-email` line:

```ts
      // send-push's handler: role and category gate (00641). supabase-js and the rate limiter
      // replaced with vi.mock, Deno stubbed.
      '../../supabase/functions/send-push/*.test.ts',
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
pnpm --filter @tricigo/api exec vitest run ../../supabase/functions/send-push/index.test.ts
```

Expected: the four "marketing may send" cases FAIL with 403; the rest PASS.

- [ ] **Step 3: Implement**

In `supabase/functions/send-push/index.ts`:

Add the import after the `service-key.ts` import:

```ts
import { canSendPush, isPanelStaffRole } from '../_shared/panel-roles.ts';
```

Replace the header comment's last line (`// (notifications table). Now requires service_role OR admin role.`) with:

```ts
// (notifications table). Now requires service_role OR admin role.
// 00641: marketing may call it too, only for the content categories its pages send
// (campaign, announcement, promo, blog). See _shared/panel-roles.ts.
```

Replace the comment `// ── Auth gate: service_role OR authenticated admin ──` with `// ── Auth gate: service_role, an admin, or marketing (content categories only, below) ──`, and add right after `const isInternalCall = isServiceKeyToken(apiKey);`:

```ts
    // null for internal calls (service key); otherwise the caller's users.role.
    let callerRole: string | null = null;
```

Replace the role check block:

```ts
      // Only admins can craft pushes for arbitrary user_ids.
      // Regular users have no legitimate path to call send-push.
      const { data: roleRow } = await supabaseAuth
        .from('users')
        .select('role')
        .eq('id', user.id)
        .single();
      if (!roleRow || !['admin', 'super_admin'].includes(roleRow.role as string)) {
```

with:

```ts
      // Only panel staff can craft pushes for arbitrary user_ids: admins for any category,
      // marketing for its content categories (checked once the body is read).
      // Regular users have no legitimate path to call send-push.
      const { data: roleRow } = await supabaseAuth
        .from('users')
        .select('role')
        .eq('id', user.id)
        .single();
      callerRole = (roleRow?.role as string | undefined) ?? null;
      if (!isPanelStaffRole(callerRole)) {
```

After the `invalid_category` 400 block (the one that ends with `{ status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },\n      );\n    }` right after `if (category && !VALID_CATEGORIES.has(category)) {`), add:

```ts
    // 00641: marketing sends only the content pushes its pages send. Never a ride, system or
    // safety push, and never an uncategorized one (the panel's one-user push is support's).
    if (callerRole !== null && !canSendPush(callerRole, category)) {
      return new Response(
        JSON.stringify({ error: 'Forbidden: this push category needs an admin' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
```

- [ ] **Step 4: Run the test and a type check of the module**

```bash
pnpm --filter @tricigo/api exec vitest run ../../supabase/functions/send-push/index.test.ts
```

Expected: 11 tests PASS. `pnpm check:ef-types` cannot run in the sandbox (the proxy blocks esm.sh); CI runs it.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/send-push/index.ts supabase/functions/send-push/index.test.ts packages/api/vitest.config.ts
git commit -m "feat(ef): send-push lets marketing send campaign, announcement, promo and blog pushes"
```

---

### Task 10: `send-bulk-email` accepts marketing

**Files:**
- Modify: `supabase/functions/send-bulk-email/index.ts`
- Modify: `supabase/functions/send-bulk-email/index.test.ts`

- [ ] **Step 1: Extend the test**

In `supabase/functions/send-bulk-email/index.test.ts`:

1. Add to the `db` object in `vi.hoisted`:
   ```ts
     sessions: {} as Record<string, string>,
     roles: {} as Record<string, string>,
   ```
2. In `query()`, add `let idEq: string | null = null;` next to `let optIn`, replace `q.eq` with:
   ```ts
    q.eq = (col: string, val: unknown) => {
      if (col === 'marketing_opt_in') optIn = val as boolean;
      if (col === 'id') idEq = val as string;
      return q;
    };
    q.single = () => Promise.resolve(
      table === 'users' && idEq && db.roles[idEq]
        ? { data: { role: db.roles[idEq] }, error: null }
        : { data: null, error: { message: 'no rows' } },
    );
   ```
3. In the object `createClient` returns, add:
   ```ts
      auth: {
        getUser: (token: string) => Promise.resolve(
          db.sessions[token]
            ? { data: { user: { id: db.sessions[token] } }, error: null }
            : { data: { user: null }, error: { message: 'invalid JWT' } },
        ),
      },
   ```
4. In `beforeEach`, add:
   ```ts
  db.sessions = { 'jwt-marketing': 'u-marketing', 'jwt-customer': 'u-customer' };
  db.roles = { 'u-marketing': 'marketing', 'u-customer': 'customer' };
   ```
5. Append at the end of the file:
   ```ts
const campaignAs = (token: string) => handler(new Request('https://example.supabase.co/functions/v1/send-bulk-email', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ user_ids: [VICTIM, PROVEN, NO_OPT], subject: 'Promo', body_html: '<p>Hola</p>' }),
}));

describe('send-bulk-email: who may send a campaign (00641)', () => {
  it('marketing may, and it still reaches only consenting, proven addresses', async () => {
    const res = await campaignAs('jwt-marketing');
    expect(res.status).toBe(200);
    expect(sent.map((s) => s.to)).toEqual(['Proven@x.test']);
  });

  it('a customer may not', async () => {
    expect((await campaignAs('jwt-customer')).status).toBe(403);
    expect(sent).toEqual([]);
  });
});
   ```

- [ ] **Step 2: Run it and confirm the marketing case fails**

```bash
pnpm --filter @tricigo/api exec vitest run ../../supabase/functions/send-bulk-email/index.test.ts
```

Expected: "marketing may" FAIL with 403; the other three PASS.

- [ ] **Step 3: Implement**

In `supabase/functions/send-bulk-email/index.ts`, add after the `mailable-emails.ts` import:

```ts
import { isPanelStaffRole } from '../_shared/panel-roles.ts';
```

Change the header line `// Now requires admin role (or service_role for cron/automation).` to:

```ts
// Now requires admin role (or service_role for cron/automation).
// 00641: marketing may send campaigns too. It still reaches only users who opted in, at a
// proven address.
```

Change `// ── Auth gate: service_role OR authenticated admin ──` to `// ── Auth gate: service_role, an admin, or marketing ──` and replace

```ts
      if (!roleRow || !['admin', 'super_admin'].includes(roleRow.role as string)) {
```

with

```ts
      if (!isPanelStaffRole(roleRow?.role)) {
```

- [ ] **Step 4: Run the test**

```bash
pnpm --filter @tricigo/api exec vitest run ../../supabase/functions/send-bulk-email/index.test.ts
```

Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/send-bulk-email/index.ts supabase/functions/send-bulk-email/index.test.ts
git commit -m "feat(ef): send-bulk-email lets marketing send campaigns"
```

---

### Task 11: Admin middleware

**Files:**
- Modify: `apps/admin/src/middleware.ts`

- [ ] **Step 1: Implement**

Add the import after the `createMiddlewareClient` import:

```ts
import { canOpenPanelPath, isPanelRole, panelHome } from '@tricigo/utils/adminPanelAccess';
```

Replace the doc comment lines

```ts
 * Redirects to /login if:
 *  - No valid Supabase session
 *  - User does not have admin or super_admin role
 */
```

with

```ts
 * Redirects to /login if:
 *  - No valid Supabase session
 *  - User does not have a panel role (admin, super_admin or marketing)
 *
 * Sends a marketing account that opens a page outside its allow-list to its home
 * (@tricigo/utils/adminPanelAccess, the same list the menus use, 00641).
 */
```

Replace

```ts
  if (!userData || !['admin', 'super_admin'].includes(userData.role)) {
    const loginUrl = publicUrl(request, '/login');
    loginUrl.searchParams.set('error', 'unauthorized');
    return NextResponse.redirect(loginUrl);
  }

  return response;
```

with

```ts
  const role: unknown = userData?.role;
  if (!isPanelRole(role)) {
    const loginUrl = publicUrl(request, '/login');
    loginUrl.searchParams.set('error', 'unauthorized');
    return NextResponse.redirect(loginUrl);
  }

  if (!canOpenPanelPath(role, request.nextUrl.pathname)) {
    const redirect = NextResponse.redirect(publicUrl(request, panelHome(role)));
    // Keep any session cookie Supabase refreshed while answering getUser().
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }

  return response;
```

- [ ] **Step 2: Type check**

```bash
pnpm --filter @tricigo/admin check-types
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/middleware.ts
git commit -m "feat(admin): middleware admits marketing and keeps it on its pages"
```

---

### Task 12: Admin copy (es/en/pt)

**Files:**
- Modify: `packages/i18n/src/locales/es/admin.json`, `en/admin.json`, `pt/admin.json`

- [ ] **Step 1: Add the keys with a script (the files round-trip exactly through `json.dumps(indent=2)`)**

```bash
python3 - <<'EOF'
import json
KEYS = {
  'promotions': {
    'status_pending': ('Pendiente de aprobación', 'Awaiting approval', 'Aguardando aprovação'),
    'action_approve': ('Aprobar y activar', 'Approve and activate', 'Aprovar e ativar'),
    'action_pause': ('Pausar', 'Pause', 'Pausar'),
    'pending_strip': ('Promociones esperando aprobación: {{count}}', 'Promotions awaiting approval: {{count}}',
                      'Promoções aguardando aprovação: {{count}}'),
    'pending_dot': ('Hay promociones esperando aprobación', 'Some promotions are awaiting approval',
                    'Há promoções aguardando aprovação'),
    'marketing_review_note': ('Se guarda apagada. Un administrador la revisa y la activa.',
                              'It is saved switched off. An administrator reviews and activates it.',
                              'É salva desativada. Um administrador revisa e ativa.'),
    'toast_sent_for_approval': ('Guardada. Un administrador la revisa y la activa.',
                                'Saved. An administrator reviews and activates it.',
                                'Salva. Um administrador revisa e ativa.'),
    'marketing_edit_active': ('Pausa la promoción para editarla.', 'Pause the promotion to edit it.',
                              'Pause a promoção para editá-la.'),
    'already_paused': ('Esta promoción ya está pausada.', 'This promotion is already paused.',
                       'Esta promoção já está pausada.'),
    'marketing_notify_inactive': ('Solo se puede avisar de una promoción activa.',
                                  'You can only announce an active promotion.',
                                  'Só é possível anunciar uma promoção ativa.'),
  },
  'header': {
    'role_admin': ('Administrador', 'Administrator', 'Administrador'),
    'role_marketing': ('Marketing', 'Marketing', 'Marketing'),
  },
  'users': {
    'role_marketing': ('Marketing', 'Marketing', 'Marketing'),
  },
}
for i, loc in enumerate(['es', 'en', 'pt']):
    path = f'packages/i18n/src/locales/{loc}/admin.json'
    data = json.load(open(path, encoding='utf-8'))
    for ns, keys in KEYS.items():
        for key, values in keys.items():
            assert key not in data[ns], f'{loc}: {ns}.{key} exists already'
            data[ns][key] = values[i]
    open(path, 'w', encoding='utf-8', newline='\n').write(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
print('ok')
EOF
git diff --stat packages/i18n
pnpm check:i18n
```

Expected: `ok`, three files with 13 insertions each and no deletions, and the parity check passes.

- [ ] **Step 2: Commit**

```bash
git add packages/i18n/src/locales
git commit -m "feat(i18n): admin copy for the marketing role and promotion approval"
```

---

### Task 13: Role context and admin shell

**Files:**
- Create: `apps/admin/src/lib/panelRole.tsx`
- Modify: `apps/admin/src/components/layout/AdminShell.tsx`

- [ ] **Step 1: Write the role context**

`apps/admin/src/lib/panelRole.tsx`:

```tsx
'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { isPanelRole, type PanelRole } from '@tricigo/utils/adminPanelAccess';
import { createBrowserClient } from './supabase-server';

interface PanelRoleState {
  /** admin, super_admin or marketing; null when it could not be read. */
  role: PanelRole | null;
  loading: boolean;
}

const PanelRoleContext = createContext<PanelRoleState>({ role: null, loading: true });

/**
 * Reads the signed-in user's role once for the whole panel (00641, marketing role).
 * The middleware already refused anyone without a panel role; this only shapes the UI.
 * The server enforces every permission on its own (RLS, RPC gates, Edge Functions).
 */
export function PanelRoleProvider({
  userId,
  initialRole,
  children,
}: {
  userId: string;
  /** Dev design previews run without a session: they render as an admin. */
  initialRole?: PanelRole;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<PanelRoleState>(
    initialRole ? { role: initialRole, loading: false } : { role: null, loading: true },
  );

  useEffect(() => {
    if (initialRole) return;
    if (!userId) {
      setState({ role: null, loading: false });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { data } = await createBrowserClient().from('users').select('role').eq('id', userId).single();
        const role: unknown = data?.role;
        if (!cancelled) setState({ role: isPanelRole(role) ? role : null, loading: false });
      } catch {
        if (!cancelled) setState({ role: null, loading: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, initialRole]);

  return <PanelRoleContext.Provider value={state}>{children}</PanelRoleContext.Provider>;
}

export function usePanelRole(): PanelRoleState {
  return useContext(PanelRoleContext);
}
```

- [ ] **Step 2: Rewrite `AdminShell`**

Replace the whole file `apps/admin/src/components/layout/AdminShell.tsx` with:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { initI18n } from '@tricigo/i18n';
import { menuRole } from '@tricigo/utils/adminPanelAccess';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { BottomNav } from './BottomNav';
import { SidebarProvider } from './SidebarContext';
import { ThemeProvider } from './ThemeProvider';
import { AdminToastProvider } from '@/components/ui/AdminToast';
import { useAdminUser } from '@/lib/useAdminUser';
import { PanelRoleProvider, usePanelRole } from '@/lib/panelRole';
import { SupportWaitingBanner } from '@/components/support/SupportWaitingBanner';

let i18nInitialized = false;

function ShellSpinner() {
  return (
    <div className="flex h-screen items-center justify-center bg-surface-sunken">
      <div className="relative h-10 w-10">
        <div className="absolute inset-0 animate-spin rounded-full border-4 border-primary-500/20 border-t-primary-500" />
      </div>
    </div>
  );
}

/** The panel once the role is known. Marketing does not get support's waiting-rides banner. */
function ShellLayout({ children }: { children: React.ReactNode }) {
  const { role, loading } = usePanelRole();
  if (loading) return <ShellSpinner />;
  const isMarketing = menuRole(role) === 'marketing';

  return (
    <div className="flex h-dvh bg-surface-sunken text-ink">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header />
        {!isMarketing && <SupportWaitingBanner />}
        <main id="main-content" className="relative flex-1 overflow-y-auto pb-20 md:pb-6">
          <div className="mx-auto w-full max-w-[1600px] px-4 py-5 md:px-6 md:py-7">{children}</div>
        </main>
      </div>
      <BottomNav />
    </div>
  );
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isAuthPage =
    pathname === '/login' ||
    pathname === '/forgot-password' ||
    pathname === '/reset-password';
  const [ready, setReady] = useState(i18nInitialized);
  const { user, loading: authLoading } = useAdminUser();

  useEffect(() => {
    if (!i18nInitialized) {
      initI18n();
      i18nInitialized = true;
      setReady(true);
    }
  }, []);

  // Allow design-preview routes (dev only) to render without a session.
  // Mirrors the guard in middleware.ts.
  const bypassAuth =
    typeof window !== 'undefined' &&
    process.env.NODE_ENV === 'development' &&
    new URLSearchParams(window.location.search).has('__preview');

  useEffect(() => {
    if (bypassAuth) return;
    if (!authLoading && !user && !isAuthPage) {
      router.replace('/login');
    }
  }, [authLoading, user, isAuthPage, router, bypassAuth]);

  if (!ready) return null;

  if (isAuthPage) {
    return (
      <ThemeProvider>
        <AdminToastProvider>{children}</AdminToastProvider>
      </ThemeProvider>
    );
  }

  if (!bypassAuth && (authLoading || !user)) {
    return <ShellSpinner />;
  }

  return (
    <ThemeProvider>
      <AdminToastProvider>
        <PanelRoleProvider userId={user?.id ?? ''} initialRole={bypassAuth ? 'admin' : undefined}>
          <SidebarProvider>
            <ShellLayout>{children}</ShellLayout>
          </SidebarProvider>
        </PanelRoleProvider>
      </AdminToastProvider>
    </ThemeProvider>
  );
}
```

- [ ] **Step 3: Type check**

```bash
pnpm --filter @tricigo/admin check-types
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/lib/panelRole.tsx apps/admin/src/components/layout/AdminShell.tsx
git commit -m "feat(admin): panel role context; marketing does not get the waiting-rides banner"
```

---

### Task 14: Sidebar, bottom bar and header

**Files:**
- Modify: `apps/admin/src/components/layout/Sidebar.tsx`
- Modify: `apps/admin/src/components/layout/BottomNav.tsx`
- Modify: `apps/admin/src/components/layout/Header.tsx`

- [ ] **Step 1: Sidebar**

Add imports (keep the existing ones):

```tsx
import { useEffect, useMemo, useState } from 'react';
import { promotionService } from '@tricigo/api';
import { canOpenPanelPath, menuRole, panelHome } from '@tricigo/utils/adminPanelAccess';
import { usePanelRole } from '@/lib/panelRole';
```

At the top of `Sidebar()`, after `const { isOpen, close, isCollapsed, toggleCollapsed } = useSidebar();`, add:

```tsx
  const { role } = usePanelRole();
  const panelRole = menuRole(role);
  const groups = useMemo(
    () =>
      NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter((item) => canOpenPanelPath(panelRole, item.href)),
      })).filter((group) => group.items.length > 0),
    [panelRole],
  );

  // Promotions marketing left waiting: a dot on the menu item, for the people who approve them.
  const [pendingPromotions, setPendingPromotions] = useState(0);
  useEffect(() => {
    if (panelRole === 'marketing') return;
    let cancelled = false;
    promotionService.countPendingApproval().then((n) => {
      if (!cancelled) setPendingPromotions(n);
    });
    return () => {
      cancelled = true;
    };
  }, [panelRole, pathname]);
```

Change the brand link `<Link href="/" className="flex min-w-0 items-center gap-2.5" aria-label="TriciGo Admin">` to `<Link href={panelHome(panelRole)} className="flex min-w-0 items-center gap-2.5" aria-label="TriciGo Admin">`.

Change `{NAV_GROUPS.map((group) => (` to `{groups.map((group) => (`.

Inside the item `<Link>`, right after the label span (`<span className={`truncate ${isCollapsed ? 'md:hidden' : ''}`}>{label}</span>`), add:

```tsx
                          {item.href === '/promotions' && pendingPromotions > 0 && (
                            <>
                              <span
                                aria-hidden="true"
                                className={`h-2 w-2 shrink-0 rounded-full bg-amber-500 ${isCollapsed ? 'md:absolute md:right-2 md:top-2' : 'ml-auto'}`}
                              />
                              <span className="sr-only">
                                {t('promotions.pending_dot', { defaultValue: 'Hay promociones esperando aprobación' })}
                              </span>
                            </>
                          )}
```

- [ ] **Step 2: BottomNav**

Replace the lucide import line with:

```tsx
import { Headphones, LayoutDashboard, Map, MapPin, Megaphone, MoreHorizontal, Newspaper, Rocket, Ticket } from 'lucide-react';
```

Add imports:

```tsx
import { menuRole } from '@tricigo/utils/adminPanelAccess';
import { usePanelRole } from '@/lib/panelRole';
```

After the `ITEMS` constant add:

```tsx
/** Marketing's tabs: its home and the three pages it works in most. */
const MARKETING_ITEMS: Item[] = [
  { href: '/launch-pulse', labelKey: 'sidebar.launch_pulse', defaultLabel: 'Pulso', icon: Rocket, matchPrefix: true },
  { href: '/promotions', labelKey: 'sidebar.promotions', defaultLabel: 'Promociones', icon: Ticket, matchPrefix: true },
  { href: '/campaigns', labelKey: 'sidebar.campaigns', defaultLabel: 'Campañas', icon: Megaphone, matchPrefix: true },
  { href: '/blog', labelKey: 'sidebar.blog', defaultLabel: 'Bitácora', icon: Newspaper, matchPrefix: true },
];
```

In `BottomNav()`, after `const { t } = useTranslation('admin');` add:

```tsx
  const { role } = usePanelRole();
  const items = menuRole(role) === 'marketing' ? MARKETING_ITEMS : ITEMS;
```

and change `{ITEMS.map((item) => {` to `{items.map((item) => {`.

- [ ] **Step 3: Header**

Add imports:

```tsx
import { menuRole } from '@tricigo/utils/adminPanelAccess';
import { usePanelRole } from '@/lib/panelRole';
```

In `Header()`, after `const { t } = useTranslation('admin');` add:

```tsx
  const { role } = usePanelRole();
  const isMarketing = menuRole(role) === 'marketing';
```

Replace `<NotificationBell />` with `{!isMarketing && <NotificationBell />}`.

Replace the hardcoded role label

```tsx
                    Administrador
```

with

```tsx
                    {isMarketing
                      ? t('header.role_marketing', { defaultValue: 'Marketing' })
                      : t('header.role_admin', { defaultValue: 'Administrador' })}
```

Wrap the "Mi perfil" button (the `<button onClick={() => router.push('/settings')} …>…</button>`) in `{!isMarketing && ( … )}`.

- [ ] **Step 4: Type check and lint**

```bash
pnpm --filter @tricigo/admin check-types
pnpm --filter @tricigo/admin lint
```

Expected: no errors, no new warnings.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/components/layout
git commit -m "feat(admin): menus, tabs and header follow the panel role"
```

---

### Task 15: Promotions page

**Files:**
- Modify: `apps/admin/src/app/promotions/page.tsx`

- [ ] **Step 1: Imports and state**

Change `import { Ticket, Plus, X } from 'lucide-react';` to `import { Clock, Ticket, Plus, X } from 'lucide-react';` and add:

```tsx
import { menuRole } from '@tricigo/utils/adminPanelAccess';
import { usePanelRole } from '@/lib/panelRole';
```

In `PromotionsAdminPage()`, after `const [notifying, setNotifying] = useState(false);` add:

```tsx
  // 00641: marketing writes drafts; an admin activates them (the server enforces it too).
  const { role } = usePanelRole();
  const isMarketing = menuRole(role) === 'marketing';
  const [pendingCount, setPendingCount] = useState(0);
```

- [ ] **Step 2: Load the pending count for admins**

In `loadItems`, after `setItems(data);` add:

```tsx
      if (!isMarketing) setPendingCount(await promotionService.countPendingApproval());
```

and change its dependency list `}, [page, t]);` to `}, [page, t, isMarketing]);`.

- [ ] **Step 3: Saving, editing and pausing**

In `handleSave`, in the `base` object, change `is_active: form.is_active,` to:

```tsx
        // Marketing's promotions are always saved off; the server forces it too (00641).
        is_active: isMarketing ? false : form.is_active,
```

and replace the two success toasts:

```tsx
        showToast('success', t('promotions.toast_updated', { defaultValue: 'Promoción actualizada' }));
```

with

```tsx
        showToast('success', isMarketing
          ? t('promotions.toast_sent_for_approval', { defaultValue: 'Guardada. Un administrador la revisa y la activa.' })
          : t('promotions.toast_updated', { defaultValue: 'Promoción actualizada' }));
```

and

```tsx
        showToast('success', t('promotions.toast_created', { defaultValue: 'Promoción creada' }));
```

with

```tsx
        showToast('success', isMarketing
          ? t('promotions.toast_sent_for_approval', { defaultValue: 'Guardada. Un administrador la revisa y la activa.' })
          : t('promotions.toast_created', { defaultValue: 'Promoción creada' }));
```

At the start of `handleEdit`, before `setForm({`, add:

```tsx
    if (isMarketing && p.is_active) {
      showToast('error', t('promotions.marketing_edit_active', { defaultValue: 'Pausa la promoción para editarla.' }));
      return;
    }
```

After `handleToggleActive`, add:

```tsx
  // Marketing's only switch: it can turn a live promotion off, never on (00641).
  const handlePause = async (p: Promotion) => {
    if (!p.is_active) {
      showToast('error', t('promotions.already_paused', { defaultValue: 'Esta promoción ya está pausada.' }));
      return;
    }
    try {
      await promotionService.setActive(p.id, false);
      showToast('success', t('promotions.toast_deactivated', { defaultValue: 'Promoción desactivada' }));
      await loadItems();
    } catch (err) {
      showToast('error', getErrorMessage(err));
    }
  };
```

- [ ] **Step 4: Status column**

Replace the `is_active` column's `cell` and `width`:

```tsx
        cell: (p) =>
          p.is_active ? (
            <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
              {t('promotions.status_active', { defaultValue: 'Activa' })}
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-ink-muted">
              {t('promotions.status_inactive', { defaultValue: 'Inactiva' })}
            </span>
          ),
        width: '110px',
```

with

```tsx
        cell: (p) =>
          p.is_active ? (
            <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
              {t('promotions.status_active', { defaultValue: 'Activa' })}
            </span>
          ) : p.pending_approval ? (
            <span className="flex flex-col items-start gap-1">
              <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-400">
                {t('promotions.status_pending', { defaultValue: 'Pendiente de aprobación' })}
              </span>
              {!isMarketing && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleToggleActive(p);
                  }}
                  className="rounded-full bg-ink px-2.5 py-0.5 text-[10.5px] font-medium text-surface transition-opacity hover:opacity-90"
                >
                  {t('promotions.action_approve', { defaultValue: 'Aprobar y activar' })}
                </button>
              )}
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-ink-muted">
              {t('promotions.status_inactive', { defaultValue: 'Inactiva' })}
            </span>
          ),
        width: '170px',
```

and change the `columns` dependency list `[t, typeLabel, discountLabel],` to `[t, typeLabel, discountLabel, isMarketing, handleToggleActive],`.

- [ ] **Step 5: The approval notice for admins**

Right after the page header block (the `<div className="flex flex-wrap items-end justify-between gap-3">…</div>` that holds the title and "Nueva promoción"), add:

```tsx
      {!isMarketing && pendingCount > 0 && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-[13px] font-medium text-amber-800 dark:text-amber-400"
        >
          <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
          {t('promotions.pending_strip', { defaultValue: 'Promociones esperando aprobación: {{count}}', count: pendingCount })}
        </div>
      )}
```

- [ ] **Step 6: The "Activa" field**

Replace the whole "Activa" `<Field>` (the one with `checked={form.is_active}`) with:

```tsx
            {isMarketing ? (
              <Field label={t('promotions.field_active', { defaultValue: 'Activa' })}>
                <p className="text-[13px] text-ink-muted">
                  {t('promotions.marketing_review_note', { defaultValue: 'Se guarda apagada. Un administrador la revisa y la activa.' })}
                </p>
              </Field>
            ) : (
              <Field label={t('promotions.field_active', { defaultValue: 'Activa' })}>
                <label className="inline-flex items-center gap-2 text-[13px] text-ink">
                  <input
                    type="checkbox"
                    checked={form.is_active}
                    onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                    className="h-4 w-4 rounded border-line"
                  />
                  {t('promotions.active_help', { defaultValue: 'El código se puede canjear' })}
                </label>
              </Field>
            )}
```

- [ ] **Step 7: Row actions**

Replace the `rowActions={[ … ]}` prop of the `DataTable` with:

```tsx
        rowActions={
          isMarketing
            ? [
                { label: t('promotions.action_edit', { defaultValue: 'Editar' }), onClick: (p) => handleEdit(p) },
                { label: t('promotions.action_pause', { defaultValue: 'Pausar' }), onClick: (p) => void handlePause(p) },
                {
                  label: t('promotions.action_notify', { defaultValue: 'Notificar ahora' }),
                  onClick: (p) =>
                    p.is_active
                      ? setNotifyTarget(p)
                      : showToast('error', t('promotions.marketing_notify_inactive', {
                          defaultValue: 'Solo se puede avisar de una promoción activa.',
                        })),
                },
                {
                  label: t('promotions.action_delete', { defaultValue: 'Eliminar' }),
                  tone: 'danger',
                  onClick: (p) => setDeleteModalId(p.id),
                },
              ]
            : [
                { label: t('promotions.action_edit', { defaultValue: 'Editar' }), onClick: (p) => handleEdit(p) },
                {
                  label: t('promotions.action_toggle', { defaultValue: 'Activar/Desactivar' }),
                  onClick: (p) => void handleToggleActive(p),
                },
                {
                  label: t('promotions.action_notify', { defaultValue: 'Notificar ahora' }),
                  onClick: (p) => setNotifyTarget(p),
                },
                {
                  label: t('promotions.action_delete', { defaultValue: 'Eliminar' }),
                  tone: 'danger',
                  onClick: (p) => setDeleteModalId(p.id),
                },
              ]
        }
```

- [ ] **Step 8: Type check and lint**

```bash
pnpm --filter @tricigo/admin check-types
pnpm --filter @tricigo/admin lint
```

Expected: no errors, no new warnings.

- [ ] **Step 9: Commit**

```bash
git add apps/admin/src/app/promotions/page.tsx
git commit -m "feat(admin): promotion drafts for marketing and approval for admins"
```

---

### Task 16: Referrals read-only, marketing role badges

**Files:**
- Modify: `apps/admin/src/app/referrals/page.tsx`
- Modify: `apps/admin/src/app/users/page.tsx`
- Modify: `apps/admin/src/app/users/[id]/page.tsx`

- [ ] **Step 1: Referrals**

Add imports:

```tsx
import { menuRole } from '@tricigo/utils/adminPanelAccess';
import { usePanelRole } from '@/lib/panelRole';
```

At the top of `ReferralsPage()`, add:

```tsx
  // 00641: marketing reads referrals; rewarding or invalidating one moves money, so it stays with admins.
  const { role } = usePanelRole();
  const isMarketing = menuRole(role) === 'marketing';
```

Change `rowActions={[` to `rowActions={isMarketing ? undefined : [` and the matching closing `]}` of that prop to `]}` unchanged (the ternary's false branch is the existing array).

- [ ] **Step 2: Users list badge**

In `apps/admin/src/app/users/page.tsx`, add to `ROLE_CLASS`:

```ts
  marketing: 'bg-violet-500/10 text-violet-700 dark:text-violet-400',
```

and in `roleLabel`'s fallbacks change `customer: 'Pasajero', driver: 'Conductor', admin: 'Admin', super_admin: 'Super admin',` to `customer: 'Pasajero', driver: 'Conductor', admin: 'Admin', super_admin: 'Super admin', marketing: 'Marketing',`.

- [ ] **Step 3: User detail badge**

In `apps/admin/src/app/users/[id]/page.tsx`, add to `roleBadgeClasses`:

```ts
  marketing: 'bg-violet-50 text-violet-700',
```

- [ ] **Step 4: Type check and lint**

```bash
pnpm --filter @tricigo/admin check-types
pnpm --filter @tricigo/admin lint
```

Expected: no errors, no new warnings.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/app/referrals/page.tsx apps/admin/src/app/users
git commit -m "feat(admin): referrals read-only for marketing, marketing role badge"
```

---

### Task 17: Full verification

- [ ] **Step 1: Repo checks**

```bash
[ -d node_modules ] || pnpm install --frozen-lockfile
git checkout HEAD -- pnpm-lock.yaml 2>/dev/null
pnpm check-types && pnpm lint && pnpm test && pnpm check:i18n && pnpm test:migration-grants && pnpm check:migration-grants
```

Expected: everything passes. Record the test totals for the PR body.

- [ ] **Step 2: The admin build includes the middleware**

```bash
cd apps/admin && NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=build-check pnpm build 2>&1 | tee /tmp/claude-0/-home-user-TriciGo/d6301488-459d-5640-a247-d08312636658/scratchpad/admin-build.log | grep -E "Middleware|error" ; cd ../..
```

Expected: a line `ƒ Middleware` and no `error`. A build that drops the middleware would leave every page open to any signed-in account.

- [ ] **Step 3: Both rehearsal runs, from scratch**

```bash
supabase/tests/00641/run.sh none 2>&1 | tail -3
supabase/tests/00641/run.sh supabase/migrations/00641_marketing_role_permissions.sql 2>&1 | tail -3
```

Expected: the first ends `FAIL <n>` with n > 0 (RED, as in Task 4); the second ends `FAIL 0`.

- [ ] **Step 4: Review the whole diff adversarially**

```bash
git diff --stat origin/master...HEAD
git diff origin/master...HEAD -- supabase/migrations apps/admin/src/middleware.ts supabase/functions
```

Check: no secrets, no model names, no `\r`, no `DROP`/`DELETE FROM` in the migrations, every new user-visible string in es/en/pt, the middleware still sends a customer to `/login?error=unauthorized`.

---

### Task 18: Document, update the PR, push

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Re-check the migration numbers**

```bash
git fetch origin master
git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -5
```

Then list the migration files of every open PR (GitHub MCP `list_pull_requests` state open, then `pull_request_read` `get_files` for each). If 00640 or 00641 is taken, rename with `git mv`, update every mention, rerun Task 17 step 3, and commit.

- [ ] **Step 2: Add the section to CLAUDE.md**

Insert before `### Recordatorio para Claude`:

```markdown
### Rol marketing en el panel (00640/00641, 2026-10-08)

Diseño: `docs/superpowers/specs/2026-10-08-marketing-role-design.md`. Plan: `docs/superpowers/plans/2026-10-08-marketing-role.md`.

- **Qué puede hacer:** métricas (Pulso del lanzamiento, Embudo, Rendimiento, Segmentos, Reportes), Referidos solo lectura, Promociones como borrador, Campañas (push y correo), Anuncios y Bitácora. Ve datos personales, como un admin. No toca dinero, conductores, soporte, ajustes ni las páginas legales.
- **Cómo se crea una cuenta:** la persona entra una vez con Google en tricigo.com o en la app, y un super_admin corre `promote_user_role(<id>, 'marketing', <motivo de 10+ caracteres>)`. Queda en `admin_actions`. No hay botón en el panel.
- **Promociones:** `tg_promotions_marketing_guard` hace que todo lo que marketing crea o edita quede apagado y `pending_approval = true`. Solo un admin o super_admin la activa, y eso estampa `approved_by`/`approved_at`. Con una activa, marketing solo puede pausarla o estampar `notified_at`. Errores: DETAIL `promo_active_locked`, `promo_activation_requires_admin`, `promo_delete_blocked`, con mensaje en español.
- **Una página nueva del panel no la ve marketing** salvo que se agregue a `MARKETING_ROUTES` en `packages/utils/src/adminPanelAccess.ts` (lo usan el middleware y los menús) y se le den permisos en el servidor: políticas `*_marketing` con `(SELECT public.is_marketing())`, y en una RPC de admin el control `IF NOT (public.is_admin() OR public.is_marketing()) THEN`.
- **Push:** `send-push` acepta marketing solo con categoría `campaign`, `announcement`, `promo` o `blog` (`supabase/functions/_shared/panel-roles.ts`). El push a un usuario (página Notificaciones) sigue siendo solo de admins.
- **Funciones que listan roles:** si se agrega otro rol, revisar `valid_transitions` y `enforce_ride_transition` (00641 trata a marketing como pasajero), `ensure_driver_role_and_tricicoin_on_approval` y `apply_user_rating`.
- **Ensayo:** `supabase/tests/00641/run.sh` (RED sin la 00641, GREEN con ella, con pruebas negativas).
- **Estado:** pendiente de aplicar (se completa en el Task 20 del plan).
```

- [ ] **Step 3: Commit and push**

```bash
git add CLAUDE.md
git commit -m "docs: marketing role in CLAUDE.md"
git push -u origin claude/hopeful-shannon-g3theu
```

Retry the push up to 4 times with 2s, 4s, 8s, 16s waits only on network errors.

- [ ] **Step 4: Update PR #1115**

With the GitHub MCP `update_pull_request` (keep it a draft), write a body with: summary; the two migrations and what each does; "Migración no aplicada a prod todavía"; the RED and GREEN rehearsal tails; test totals; the admin build line; "Expected in prod" (the 12 patched md5 values from run.sh `PATCHED_MD5` plus the two from Task 5 step 3); rollout steps (Tasks 19–22). End the body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01EbnC6H75XT6LqrciPs9Gzi
```

- [ ] **Step 5: Wait for CI**

PR events arrive on their own. If CI fails, fix the cause, rerun Task 17, push again.

---

### Task 19: Merge (needs the founder's OK for this PR)

- [ ] **Step 1:** With CI green, ask with AskUserQuestion: "¿Autorizo el squash-merge de #1115?". Only on an explicit yes, mark the PR ready and merge it with the GitHub MCP (`merge_method: squash`, the head SHA in full).
- [ ] **Step 2:** Confirm the admin deploy finished (`Deploy Admin` workflow green) and that the new chunk is live: download the login page's JS chunks from admin.tricigo.com and grep for `launch-pulse` together with `marketing`.

---

### Task 20: Apply the migrations (needs the founder's OK, asked separately)

- [ ] **Step 1: Ask** with AskUserQuestion, one option per action: "Aplicar 00640 (agrega el valor 'marketing'; no cambia nada más)", then later "Ensayar 00641 en prod dentro de una transacción revertida", then "Aplicar 00641".

- [ ] **Step 2: Apply 00640** with MCP `apply_migration` (name `00640_marketing_role_enum`, the file's content). Verify:

```sql
SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = 'public.user_role'::regtype;
```

Expected: `customer,driver,admin,super_admin,marketing`.

- [ ] **Step 3: Rehearse 00641 in prod, rolled back**

Build the rehearsal SQL from the file (no hand-copy):

```bash
SCRATCH=/tmp/claude-0/-home-user-TriciGo/d6301488-459d-5640-a247-d08312636658/scratchpad
python3 - "$SCRATCH/rehearsal-00641.sql" <<'EOF'
import sys, pathlib
mig = pathlib.Path('supabase/migrations/00641_marketing_role_permissions.sql').read_text(encoding='utf-8')
assert '$mig$' not in mig and '\r' not in mig
sql = r"""DO $rehearsal$
DECLARE
  v_uid uuid;
  v_out text := '';
  v_id uuid;
  v_n bigint;
  v_txt text;
  v_fn text;
BEGIN
  EXECUTE $mig$__MIGRATION__$mig$;

  -- Borrow a test passenger and make it marketing, inside this transaction only.
  SELECT id INTO v_uid FROM public.users WHERE is_test AND role = 'customer' AND is_active ORDER BY created_at LIMIT 1;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'no active test passenger to borrow'; END IF;
  UPDATE public.users SET role = 'marketing' WHERE id = v_uid;

  PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  v_out := 'is_marketing=' || public.is_marketing()::text;
  SELECT count(*) INTO v_n FROM public.rides; v_out := v_out || ' rides=' || v_n;
  SELECT count(*) INTO v_n FROM public.users; v_out := v_out || ' users=' || v_n;
  SELECT count(*) INTO v_n FROM public.wallet_accounts WHERE user_id <> v_uid; v_out := v_out || ' others_wallets=' || v_n;

  INSERT INTO public.promotions (code, type, discount_percent, is_active)
  VALUES ('ENSAYO-MKT-' || substr(md5(random()::text), 1, 6), 'percentage_discount', 5, true)
  RETURNING id INTO v_id;
  SELECT format(' draft=%s/%s', is_active, pending_approval) INTO v_txt FROM public.promotions WHERE id = v_id;
  v_out := v_out || v_txt;
  BEGIN
    UPDATE public.promotions SET is_active = true WHERE id = v_id;
    v_out := v_out || ' activate=ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_txt = PG_EXCEPTION_DETAIL;
    v_out := v_out || ' activate=' || v_txt;
  END;

  FOREACH v_fn IN ARRAY ARRAY['admin_launch_pulse(4)', 'admin_signup_code_stats()', 'get_admin_dashboard_metrics()',
    'get_admin_wallet_stats()', 'get_rides_by_day(7)', 'get_rides_by_service_type(7)',
    'get_rides_by_payment_method(7)', 'get_top_drivers(5)', 'get_active_push_user_ids(30)'] LOOP
    BEGIN
      EXECUTE 'SELECT public.' || v_fn;
      v_out := v_out || ' ' || v_fn || '=ok';
    EXCEPTION WHEN OTHERS THEN
      v_out := v_out || ' ' || v_fn || '=' || SQLERRM;
    END;
  END LOOP;

  RESET ROLE;
  RAISE EXCEPTION 'REHEARSAL (rolled back): %', v_out;
END
$rehearsal$;
""".replace('__MIGRATION__', mig)
pathlib.Path(sys.argv[1]).write_text(sql, encoding='utf-8')
print(len(sql), 'chars')
EOF
```

Run the file's content with MCP `execute_sql`. Expected: an error `REHEARSAL (rolled back): is_marketing=true rides=<n> users=<n> others_wallets=0 draft=false/true activate=promo_activation_requires_admin` followed by `=ok` for all nine RPCs. Then confirm nothing stayed:

```sql
SELECT (SELECT count(*) FROM pg_proc WHERE proname = 'is_marketing') AS fn,
       (SELECT count(*) FROM public.users WHERE role = 'marketing') AS marketing_users,
       (SELECT count(*) FROM public.promotions WHERE code LIKE 'ENSAYO-MKT-%') AS drafts;
```

Expected: `0|0|0`.

- [ ] **Step 4: Apply 00641** with MCP `apply_migration` (name `00641_marketing_role_permissions`). If it times out, do not retry blindly: verify by object (next step) first.

- [ ] **Step 5: Verify by object**

```sql
SELECT
  (SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname COLLATE "C") FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname IN ('admin_launch_pulse', 'admin_signup_code_stats',
     'apply_user_rating', 'enforce_ride_transition', 'ensure_driver_role_and_tricicoin_on_approval',
     'get_active_push_user_ids', 'get_admin_dashboard_metrics', 'get_admin_wallet_stats', 'get_rides_by_day',
     'get_rides_by_payment_method', 'get_rides_by_service_type', 'get_top_drivers')) AS patched,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE '%\_marketing') AS policies,
  (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_promotions_marketing_guard') AS trigger,
  (SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc
   WHERE proname IN ('is_marketing', 'tg_promotions_marketing_guard')) AS new_functions;
```

Expected: `patched` equals run.sh `PATCHED_MD5`, `policies` 13, `trigger` 1, `new_functions` equals the two lines recorded in Task 5 step 3.

- [ ] **Step 6: Update CLAUDE.md "Estado"** with the apply date and the verification, commit on a fresh branch from master if #1115 is already merged (follow the repo's merged-PR rule), and open a small docs PR.

---

### Task 21: Deploy the Edge Functions (needs the founder's OK)

- [ ] **Step 1:** Read the deployed `verify_jwt` of both functions (`list_edge_functions`): send-push `false`, send-bulk-email `true` (as in `supabase/config.toml`). Keep them.
- [ ] **Step 2:** Deploy with MCP `deploy_edge_function`:
  - `send-push`: `index.ts`, `../_shared/rate-limiter.ts`, `../_shared/service-key.ts`, `../_shared/panel-roles.ts`, `verify_jwt: false`.
  - `send-bulk-email`: `index.ts`, `../_shared/service-key.ts`, `../_shared/mailable-emails.ts`, `../_shared/email-guard.ts`, `../_shared/panel-roles.ts`, `verify_jwt: true`.
- [ ] **Step 3:** For each, `get_edge_function` and diff the returned files against the repo (`tr -d '\r'` on both sides). Expected: identical.
- [ ] **Step 4:** Smoke: `curl -s -X POST https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push -H 'Content-Type: application/json' -d '{}'` must answer 401 (no auth), as before.

---

### Task 22: Create the marketing accounts (one by one, each confirmed with the founder)

- [ ] **Step 1:** Ask the founder for each person's e-mail and confirm that person already signed in once (`SELECT id, full_name, email, role FROM public.users WHERE lower(email) = lower('<e-mail>')`).
- [ ] **Step 2:** Ask which super_admin account acts (`SELECT id, full_name FROM public.users WHERE role = 'super_admin'`), then, after an explicit OK for that person:

```sql
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '<super_admin_id>', true);
  PERFORM public.promote_user_role('<user_id>', 'marketing', '<motivo, por ejemplo: Equipo de marketing, alta pedida por el fundador>');
END
$$;
```

- [ ] **Step 3:** Verify: `SELECT role FROM public.users WHERE id = '<user_id>'` is `marketing`, and the newest `admin_actions` row has `action = 'promote_user_role'`.
- [ ] **Step 4:** Ask the person to sign in at admin.tricigo.com and confirm: they land on Pulso del lanzamiento, the menu shows only their pages, `/wallet` sends them back, a new promotion shows "Pendiente de aprobación", and an admin sees the notice and the dot.

---

## Self-review notes

- **Spec coverage:** role and accounts (Tasks 3, 6, 22); panel shell, allow-list, header, banner (Tasks 7, 11, 13, 14); server permissions and metrics RPCs (Task 5 §1, §3, §4); Edge Functions (Tasks 8–10, 21); promotion approval, trigger and UI (Task 5 §2, Tasks 6, 15); referrals read-only and role badges (Task 16); role sweep and the three live-function fixes (Task 5 §5, tests T1–T3, D1–D2, U1); testing (Tasks 4, 5, 17); rollout (Tasks 19–22); documentation (Task 18).
- **Not in this plan, by decision:** competitors, SMS campaigns, partner places, quests, Notificaciones, legal pages, referral rewards, and the three ungated RPCs (`detect_collusion_reviews`, `get_peak_hours`, `get_driver_utilization`), which get their own fix.
