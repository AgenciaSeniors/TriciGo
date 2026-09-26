# Freeze a reviewed fleet invitation: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** once the admin has reviewed a fleet invitation, the fleet owner can no longer change what was reviewed (number, person, licence, fleet) or the admin's rejection reason. The change is silently discarded, like `status` today.

**Architecture:** one migration (00600) replaces `tg_fleet_members_protect()` with the live body plus one block in the owner's UPDATE branch. It refuses to replace a body it does not know, and it asserts itself with a rolled-back self-test that acts as a real non-admin account. A local Postgres rehearsal with the live prod bodies proves RED → GREEN. Spec: `docs/superpowers/specs/2026-09-25-fleet-freeze-reviewed-invitations-design.md`.

**Tech Stack:** PostgreSQL 16 / plpgsql (Supabase), bash + psql rehearsal, TypeScript JSDoc in `@tricigo/api`.

---

## File structure

| File | Responsibility |
|---|---|
| `supabase/tests/00600/scaffold.sql` (create) | Live prod shapes, RLS policies, grants and the function bodies an owner's write and the link paths run (byte for byte) |
| `supabase/tests/00600/run.sh` (create) | RED/GREEN runner: seed, owner-after-review cases, must-keep-working cases, contract, fidelity, a database built from git, negative proofs |
| `supabase/migrations/00600_freeze_reviewed_fleet_invitations.sql` (create) | Drift guard, the new `tg_fleet_members_protect()`, comment, self-test |
| `packages/api/src/services/fleet.service.ts` (modify: JSDoc of `uploadMemberLicense`) | Say that the path only changes while the invitation is in review |
| `CLAUDE.md` (modify: before "Fleet membership 3-way gate (corporate)") | The freeze rule, so a future owner-side edit screen doesn't get surprised |

Local cluster (Windows): portable Postgres 16 in the scratchpad, started with
`pg_ctl -D <scratchpad>/pgdata -o "-p 5441 -c listen_addresses=127.0.0.1" -l <scratchpad>/pg.log -w start`.
Runner env on Windows: `PGBIN=<scratchpad>/pgsql/bin PGPORT=5441 PYTHON=python`.

---

### Task 1: Rehearsal scaffold and runner (RED)

**Files:** create `supabase/tests/00600/scaffold.sql` (Appendix A), `supabase/tests/00600/run.sh` (Appendix B, mode 755).

- [ ] **Step 1:** write the scaffold. Every function body is copied from the live `pg_get_functiondef` (2026-09-25) and checked by md5 in the runner's `S` cases.
- [ ] **Step 2:** write the runner.
- [ ] **Step 3: run RED**

Run: `PGBIN=… PGPORT=5441 PYTHON=python bash supabase/tests/00600/run.sh none`
Expected: every `S … is the prod body` PASSES (the scaffold is faithful). The owner-after-review cases FAIL for the right reason: A1, A3–A6 and A9–A10 show the owner's values; A2 links the new number; A7–A8 show the owner's rejection text. PASS as controls: B1–B9 and D1–D4.

- [ ] **Step 4: commit**

```bash
git add supabase/tests/00600/scaffold.sql supabase/tests/00600/run.sh
git commit -m "test(fleet): rehearsal for freezing reviewed fleet invitations (RED)"
```

### Task 2: Migration 00600 (GREEN)

**Files:** create `supabase/migrations/00600_freeze_reviewed_fleet_invitations.sql` (Appendix C).

- [ ] **Step 1: re-check the number is free.** Look at master, every open PR and the other worktrees; 00598 and 00599 are taken by parallel sessions.

```bash
git fetch origin
git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -3
for pr in $(gh pr list --state open --json number --jq '.[].number'); do gh pr view $pr --json files --jq '.files[].path' | grep supabase/migrations; done
```

- [ ] **Step 2:** write the migration. The function body is the live one plus the `-- 00600:` block at the end of the UPDATE branch. The drift guard accepts three md5s: the live body, 00435's text in git, and the new body (a re-run).
- [ ] **Step 3: run GREEN**

Run: `PGBIN=… PGPORT=5441 PYTHON=python bash supabase/tests/00600/run.sh supabase/migrations/00600_freeze_reviewed_fleet_invitations.sql`
Expected: `summary: N passed, 0 failed`, including M1–M2, D5 (fidelity), G1 (a database built from git) and N1–N6.

- [ ] **Step 4:** check line endings: `git ls-files --eol` shows `w/lf` for the new files after `git add`.
- [ ] **Step 5: commit**

```bash
git add supabase/migrations/00600_freeze_reviewed_fleet_invitations.sql
git commit -m "fix(db): the fleet owner can no longer rewrite a reviewed invitation (00600)"
```

### Task 3: Service JSDoc

**Files:** modify `packages/api/src/services/fleet.service.ts` (JSDoc of `uploadMemberLicense`).

- [ ] **Step 1:** add to the JSDoc that the database keeps `license_doc_path` as reviewed once the invitation left review (00600), so the update only takes effect while it is `pending_review`.
- [ ] **Step 2: verify.** Run `pnpm check-types` (all packages pass) and `pnpm --filter @tricigo/api test -- fleet` (the fleet tests pass).
- [ ] **Step 3: commit**

```bash
git add packages/api/src/services/fleet.service.ts
git commit -m "docs(fleet): a reviewed invitation keeps its licence path"
```

### Task 4: CLAUDE.md

- [ ] **Step 1:** add a short section before "Fleet membership 3-way gate (corporate)": what the owner can and cannot change, why (every link path trusts `driver_phone` on an approved row), how to change a reviewed member (delete and invite again), and that the owner's write succeeds silently.
- [ ] **Step 2: commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): a reviewed fleet invitation is frozen for its owner"
```

### Task 5: Review, push, PR

- [ ] **Step 1:** get a code review from a subagent (superpowers:requesting-code-review) over `origin/master...HEAD`. Address the findings with superpowers:receiving-code-review, and re-run the rehearsal after any SQL change.
- [ ] **Step 2:** re-run the migration-number check from Task 2 Step 1 right before pushing.
- [ ] **Step 3:** `git push -u origin claude/fleet-freeze-reviewed-invitations`, then `gh pr create --base master --body-file <scratchpad>/pr-body.md`. The body covers the problem, the decisions, the fix, the rehearsal numbers, "not applied to production (MCP guard)" and the test plan.
- [ ] **Step 4:** file the two out-of-scope chips (the window during review, the licence file in Storage) and tell the 00598 session the PR number.
- [ ] **Step 5:** do not merge and do not apply the migration without explicit authorization for this PR.

---

## Appendix A — `supabase/tests/00600/scaffold.sql`

````sql
-- Scaffold for the 00600 rehearsal: the LIVE production shapes of users,
-- corporate_accounts, driver_fleets and fleet_members, their RLS policies and
-- grants, and every function a fleet owner's write and the fleet-linking paths
-- run, transcribed on 2026-09-25 from pg_get_functiondef, pg_policies,
-- pg_trigger, pg_indexes and information_schema. Each function body is byte for
-- byte the one running in prod: run.sh checks md5(prosrc) and length against
-- the values read there, and each function keeps its prod ACL. auth.users and
-- public.users keep only the columns these paths read. RLS is on, so the tests
-- run each call as `authenticated` with a JWT subject, the way PostgREST does.
-- fleet_members, driver_fleets and corporate_accounts had 0 rows in prod.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
GRANT anon, authenticated, service_role TO pgtest;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;

-- LIVE (md5 cdef18c6…, 176)
CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');

-- GoTrue's table, trimmed. GoTrue stores phones as E.164 digits without '+'.
-- No grant to anon/authenticated, as in prod.
CREATE TABLE auth.users (
  id                 uuid PRIMARY KEY,
  phone              text DEFAULT NULL,
  phone_confirmed_at timestamptz
);
CREATE UNIQUE INDEX users_phone_key ON auth.users USING btree (phone);

-- LIVE public.users, trimmed to what these paths read. No unique index on phone: prod has none.
CREATE TABLE public.users (
  id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  phone      text,
  role       public.user_role NOT NULL DEFAULT 'customer',
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_phone_not_blank CHECK (((phone IS NULL) OR (btrim(phone) <> ''::text)))
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.users TO anon, authenticated, service_role;

-- LIVE (md5 cb4a7c12…, 103). ACL {postgres, authenticated, service_role}.
CREATE OR REPLACE FUNCTION public.current_user_role()
 RETURNS user_role
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT COALESCE(
    (SELECT role FROM users WHERE id = auth.uid()),
    'customer'::user_role
  );
$function$;
REVOKE EXECUTE ON FUNCTION public.current_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated, service_role;

-- LIVE (00592, md5 22cb75e9…, 285). ACL {PUBLIC, postgres, anon, authenticated, service_role}.
CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  -- No JWT subject: anon, service role, cron, triggers without a user. None of
  -- them is an admin, and anon may not even call current_user_role().
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() IN ('admin', 'super_admin');
END;
$function$;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated, service_role;

-- LIVE users policies
CREATE POLICY users_admin_select ON public.users FOR SELECT USING (is_admin());
CREATE POLICY users_insert_own ON public.users FOR INSERT WITH CHECK (id = ( SELECT auth.uid() AS uid));
CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = ( SELECT auth.uid() AS uid)) OR is_admin());
CREATE POLICY users_update_own ON public.users FOR UPDATE USING (id = ( SELECT auth.uid() AS uid));

-- LIVE (00487, md5 9f5227a3…, 451). ACL {PUBLIC, postgres, service_role}.
CREATE OR REPLACE FUNCTION public._normalize_cuban_phone(p_phone text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_digits text;
BEGIN
  IF p_phone IS NULL THEN
    RETURN NULL;
  END IF;
  v_digits := regexp_replace(p_phone, '\D', '', 'g');
  -- Bare local mobile: 8 digits starting with 5 (legacy) or 6 (new 63/64)
  IF v_digits ~ '^[56]\d{7}$' THEN
    RETURN '+53' || v_digits;
  -- With country code, no +: 53 followed by the 8-digit subscriber number
  ELSIF v_digits ~ '^53\d{8}$' THEN
    RETURN '+' || v_digits;
  END IF;
  RETURN p_phone;
END;
$function$;
GRANT EXECUTE ON FUNCTION public._normalize_cuban_phone(text) TO service_role;

-- LIVE corporate_accounts: every column and constraint.
CREATE TABLE public.corporate_accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  contact_phone text NOT NULL,
  contact_email text,
  tax_id text,
  status text NOT NULL DEFAULT 'pending'::text,
  created_by uuid NOT NULL,
  monthly_budget_trc integer NOT NULL DEFAULT 0,
  per_ride_cap_trc integer NOT NULL DEFAULT 0,
  allowed_service_types text[] DEFAULT '{}'::text[],
  allowed_hours_start time without time zone,
  allowed_hours_end time without time zone,
  current_month_spent integer NOT NULL DEFAULT 0,
  approved_at timestamp with time zone,
  suspended_at timestamp with time zone,
  suspended_reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  commission_percent numeric(5,2) DEFAULT NULL::numeric,
  is_fleet_owner boolean NOT NULL DEFAULT false,
  CONSTRAINT corporate_accounts_pkey PRIMARY KEY (id),
  CONSTRAINT corporate_accounts_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT corporate_accounts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'suspended'::text, 'rejected'::text])))
);
ALTER TABLE public.corporate_accounts ADD CONSTRAINT corporate_accounts_commission_range
  CHECK (((commission_percent IS NULL) OR ((commission_percent >= (0)::numeric) AND (commission_percent <= (100)::numeric)))) NOT VALID;
ALTER TABLE public.corporate_accounts ENABLE ROW LEVEL SECURITY;

-- LIVE (00434, md5 16d3e412…, 455). ACL {PUBLIC, postgres, service_role}.
CREATE OR REPLACE FUNCTION public.tg_corporate_accounts_protect_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF current_setting('app.trusted_corporate_update', true) = '1' THEN RETURN NEW; END IF;

  NEW.status              := 'pending';
  NEW.is_fleet_owner      := false;
  NEW.commission_percent  := NULL;
  NEW.current_month_spent := 0;
  NEW.approved_at         := NULL;
  NEW.suspended_at        := NULL;
  NEW.suspended_reason    := NULL;
  RETURN NEW;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.tg_corporate_accounts_protect_insert() TO service_role;
CREATE TRIGGER trg_corporate_accounts_protect_insert BEFORE INSERT ON public.corporate_accounts
  FOR EACH ROW EXECUTE FUNCTION tg_corporate_accounts_protect_insert();

-- LIVE corporate_accounts policies. corporate_accounts_corp_admin_update and
-- corporate_accounts_employee_read need corporate_employees and no test runs
-- as a corporate employee, so they are left out.
CREATE POLICY corporate_accounts_admin_read ON public.corporate_accounts FOR SELECT TO authenticated
  USING (EXISTS ( SELECT 1 FROM users WHERE ((users.id = auth.uid()) AND (users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role])))));
CREATE POLICY corporate_accounts_admin_update ON public.corporate_accounts FOR UPDATE TO authenticated
  USING (EXISTS ( SELECT 1 FROM users WHERE ((users.id = auth.uid()) AND (users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role])))));
CREATE POLICY corporate_accounts_creator_read ON public.corporate_accounts FOR SELECT TO authenticated
  USING (created_by = auth.uid());
CREATE POLICY corporate_accounts_insert ON public.corporate_accounts FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

-- LIVE driver_fleets: one fleet per corporate account.
CREATE TABLE public.driver_fleets (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  corporate_account_id uuid NOT NULL,
  name text NOT NULL,
  vehicle_count_estimate integer,
  vehicle_types text[] DEFAULT '{}'::text[],
  operating_zones text[] DEFAULT '{}'::text[],
  estimated_rides_per_day_per_vehicle integer,
  operating_hours_start time without time zone,
  operating_hours_end time without time zone,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT driver_fleets_pkey PRIMARY KEY (id),
  CONSTRAINT driver_fleets_corporate_account_id_key UNIQUE (corporate_account_id),
  CONSTRAINT driver_fleets_corporate_account_id_fkey FOREIGN KEY (corporate_account_id) REFERENCES corporate_accounts(id) ON DELETE CASCADE
);
ALTER TABLE public.driver_fleets ENABLE ROW LEVEL SECURITY;
CREATE POLICY driver_fleets_admin_delete ON public.driver_fleets FOR DELETE USING (is_admin());
CREATE POLICY driver_fleets_owner_insert ON public.driver_fleets FOR INSERT
  WITH CHECK (corporate_account_id IN ( SELECT corporate_accounts.id FROM corporate_accounts WHERE (corporate_accounts.created_by = auth.uid())));
CREATE POLICY driver_fleets_owner_select ON public.driver_fleets FOR SELECT
  USING (is_admin() OR (corporate_account_id IN ( SELECT corporate_accounts.id FROM corporate_accounts WHERE (corporate_accounts.created_by = auth.uid()))));
CREATE POLICY driver_fleets_owner_update ON public.driver_fleets FOR UPDATE
  USING (is_admin() OR (corporate_account_id IN ( SELECT corporate_accounts.id FROM corporate_accounts WHERE (corporate_accounts.created_by = auth.uid()))));

-- LIVE fleet_members: unique only on (fleet_id, driver_phone) as typed. The
-- owner's UPDATE policy has no WITH CHECK, and authenticated can UPDATE every column.
CREATE TABLE public.fleet_members (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  fleet_id uuid NOT NULL,
  driver_id uuid,
  driver_name text NOT NULL,
  driver_phone text NOT NULL,
  driver_email text,
  driver_license_number text,
  driver_id_number text,
  status text NOT NULL DEFAULT 'pending_review'::text,
  license_doc_path text,
  added_at timestamp with time zone NOT NULL DEFAULT now(),
  reviewed_at timestamp with time zone,
  reviewed_by uuid,
  rejected_reason text,
  signed_up_at timestamp with time zone,
  CONSTRAINT fleet_members_pkey PRIMARY KEY (id),
  CONSTRAINT fleet_members_fleet_id_driver_phone_key UNIQUE (fleet_id, driver_phone),
  CONSTRAINT fleet_members_fleet_id_fkey FOREIGN KEY (fleet_id) REFERENCES driver_fleets(id) ON DELETE CASCADE,
  CONSTRAINT fleet_members_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fleet_members_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES users(id),
  CONSTRAINT fleet_members_status_check CHECK ((status = ANY (ARRAY['pending_review'::text, 'approved'::text, 'rejected'::text, 'pending_signup'::text, 'active'::text, 'inactive'::text])))
);
CREATE INDEX fleet_members_phone_idx ON public.fleet_members USING btree (driver_phone);
CREATE INDEX fleet_members_driver_id_idx ON public.fleet_members USING btree (driver_id);
CREATE INDEX fleet_members_status_idx ON public.fleet_members USING btree (status);
ALTER TABLE public.fleet_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY fleet_members_owner_delete ON public.fleet_members FOR DELETE
  USING (is_admin() OR (fleet_id IN ( SELECT df.id FROM (driver_fleets df JOIN corporate_accounts ca ON ((ca.id = df.corporate_account_id))) WHERE (ca.created_by = auth.uid()))));
CREATE POLICY fleet_members_owner_insert ON public.fleet_members FOR INSERT
  WITH CHECK (fleet_id IN ( SELECT df.id FROM (driver_fleets df JOIN corporate_accounts ca ON ((ca.id = df.corporate_account_id))) WHERE (ca.created_by = auth.uid())));
CREATE POLICY fleet_members_owner_or_admin_update ON public.fleet_members FOR UPDATE
  USING (is_admin() OR (fleet_id IN ( SELECT df.id FROM (driver_fleets df JOIN corporate_accounts ca ON ((ca.id = df.corporate_account_id))) WHERE (ca.created_by = auth.uid()))));
CREATE POLICY fleet_members_owner_or_self_select ON public.fleet_members FOR SELECT
  USING (is_admin() OR (driver_id = auth.uid()) OR (fleet_id IN ( SELECT df.id FROM (driver_fleets df JOIN corporate_accounts ca ON ((ca.id = df.corporate_account_id))) WHERE (ca.created_by = auth.uid()))));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.corporate_accounts, public.driver_fleets, public.fleet_members TO anon, authenticated, service_role;

-- LIVE (md5 8b0d07af…, 674; 00435's text in git carries the same logic with
-- comments). ACL {PUBLIC, postgres, service_role}.
CREATE OR REPLACE FUNCTION public.tg_fleet_members_protect()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF current_setting('app.trusted_fleet_update', true) = '1' THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.status          := 'pending_review';
    NEW.driver_id       := NULL;
    NEW.signed_up_at    := NULL;
    NEW.reviewed_at     := NULL;
    NEW.reviewed_by     := NULL;
    NEW.rejected_reason := NULL;
    RETURN NEW;
  ELSE
    NEW.status       := OLD.status;
    NEW.driver_id    := OLD.driver_id;
    NEW.signed_up_at := OLD.signed_up_at;
    NEW.reviewed_at  := OLD.reviewed_at;
    NEW.reviewed_by  := OLD.reviewed_by;
    RETURN NEW;
  END IF;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.tg_fleet_members_protect() TO service_role;
CREATE TRIGGER trg_fleet_members_protect BEFORE INSERT OR UPDATE ON public.fleet_members
  FOR EACH ROW EXECUTE FUNCTION tg_fleet_members_protect();

-- LIVE (00595, md5 c4b25ab7…, 434). ACL {postgres, service_role}.
CREATE OR REPLACE FUNCTION public.auto_link_fleet_member_on_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.phone IS NULL OR NEW.phone = '' THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('app.trusted_fleet_update', '1', true);

  UPDATE fleet_members
  SET driver_id = NEW.id,
      status = 'active',
      signed_up_at = now()
  WHERE public._normalize_cuban_phone(driver_phone) = public._normalize_cuban_phone(NEW.phone)
    AND status IN ('approved', 'pending_signup')
    AND driver_id IS NULL;

  RETURN NEW;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.auto_link_fleet_member_on_signup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_link_fleet_member_on_signup() TO service_role;
CREATE TRIGGER auto_link_fleet_member_on_signup AFTER INSERT ON public.users
  FOR EACH ROW EXECUTE FUNCTION auto_link_fleet_member_on_signup();

-- LIVE (00461, md5 87327e7e…, 565). ACL {postgres, service_role, authenticated}.
CREATE OR REPLACE FUNCTION public.relink_fleet_member_for_existing_driver(p_driver_id uuid, p_phone text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count integer;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: only admins can relink fleet members';
  END IF;

  PERFORM set_config('app.trusted_fleet_update', '1', true);

  UPDATE fleet_members
  SET driver_id = p_driver_id,
      status = 'active',
      signed_up_at = COALESCE(signed_up_at, now())
  WHERE public._normalize_cuban_phone(driver_phone) = public._normalize_cuban_phone(p_phone)
    AND status IN ('approved', 'pending_signup')
    AND driver_id IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.relink_fleet_member_for_existing_driver(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.relink_fleet_member_for_existing_driver(uuid, text) TO authenticated, service_role;
````

## Appendix B — `supabase/tests/00600/run.sh`

````bash
#!/usr/bin/env bash
# Rehearsal runner for migration 00600 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00600/run.sh none
#       -> scaffold + tests (RED: the fleet owner rewrites an invitation the admin already reviewed)
#   supabase/tests/00600/run.sh supabase/migrations/00600_freeze_reviewed_fleet_invitations.sql
#       -> scaffold + migration x2 (idempotency) + tests + fidelity + a database built from git + negative proofs (GREEN)
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Elsewhere, PGBIN, PGPORT and PYTHON override the defaults, e.g. on Windows:
#   PGBIN=<portable pgsql>/bin PGPORT=5441 PYTHON=python bash supabase/tests/00600/run.sh none
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PY="${PYTHON:-python3}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
DB=pr600
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
ERRF="$(mktemp)"; trap 'rm -f "$ERRF"' EXIT
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# val NAME SQL EXPECTED -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
val(){ local r; r=$($P -c "$2" </dev/null 2>&1 | tr -d '\r' | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }

ADMIN=a0000000-0000-4000-8000-000000000001    # admin, the one reviewing
OWNER=a0000000-0000-4000-8000-000000000002    # fleet owner (a driver)
DRV=a0000000-0000-4000-8000-000000000003      # a driver already linked to the fleet
NEWU=b0000000-0000-4000-8000-000000000001     # someone who signs up during a test
NEWU2=b0000000-0000-4000-8000-000000000002    # someone else who signs up during a test
CA=c0000000-0000-4000-8000-00000000000a; CB=c0000000-0000-4000-8000-00000000000b
FA=f0000000-0000-4000-8000-00000000000a; FB=f0000000-0000-4000-8000-00000000000b
# auth.users keeps phones the way GoTrue does (E.164 digits, no '+'); public.users has them normalized.
PEOPLE="INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES
  ('$ADMIN', '5355550001', now()), ('$OWNER', '5355550002', now()), ('$DRV', '5355551234', now());
INSERT INTO public.users (id, phone, role) VALUES
  ('$ADMIN', '+5355550001', 'admin'), ('$OWNER', '+5355550002', 'driver'), ('$DRV', '+5355551234', 'driver');"
# RESET -> no invitations, no one signed up during a test, the owner's two fleets
RESET="TRUNCATE public.fleet_members, public.driver_fleets, public.corporate_accounts;
DELETE FROM auth.users WHERE id IN ('$NEWU', '$NEWU2');
INSERT INTO public.corporate_accounts (id, name, contact_phone, created_by) VALUES
  ('$CA', 'Flota A', '+5355550002', '$OWNER'), ('$CB', 'Flota B', '+5355550002', '$OWNER');
INSERT INTO public.driver_fleets (id, corporate_account_id, name) VALUES ('$FA', '$CA', 'Flota A'), ('$FB', '$CB', 'Flota B');"
# as PERSON -> what follows runs the way PostgREST runs that person's call: role authenticated + JWT subject
as(){ printf "SET ROLE authenticated; SET request.jwt.claim.sub = '%s';" "$1"; }
# NOJWT -> back to a caller with no JWT (service role, migrations, GoTrue's triggers)
NOJWT="RESET ROLE; RESET request.jwt.claim.sub;"
# invite FLEET PHONE STATUS -> a fixture invitation, written with no JWT so it keeps STATUS
invite(){ printf "INSERT INTO public.fleet_members (fleet_id, driver_name, driver_phone, driver_email, driver_license_number, driver_id_number, license_doc_path, status) VALUES ('%s', 'Juan', '%s', 'juan@x.cu', 'L1', 'I1', 'd1.jpg', '%s');" "$1" "$2" "$3"; }
# linked FLEET STATUS -> a fixture invitation already linked to DRV
linked(){ printf "INSERT INTO public.fleet_members (fleet_id, driver_id, driver_name, driver_phone, driver_email, driver_license_number, driver_id_number, license_doc_path, status, signed_up_at) VALUES ('%s', '$DRV', 'Juan', '+5355551234', 'juan@x.cu', 'L1', 'I1', 'd1.jpg', '%s', now());" "$1" "$2"; }
# approve FLEET PHONE / reject FLEET PHONE REASON -> what fleetService.approveMember() / rejectMember() write, as the admin through RLS
approve(){ printf "%s UPDATE public.fleet_members SET status = 'approved', reviewed_at = now(), reviewed_by = '$ADMIN' WHERE fleet_id = '%s' AND driver_phone = '%s'; %s" "$(as "$ADMIN")" "$1" "$2" "$NOJWT"; }
reject(){ printf "%s UPDATE public.fleet_members SET status = 'rejected', reviewed_at = now(), reviewed_by = '$ADMIN', rejected_reason = '%s' WHERE fleet_id = '%s' AND driver_phone = '%s'; %s" "$(as "$ADMIN")" "$3" "$1" "$2" "$NOJWT"; }
# REWRITE -> the owner, through RLS, rewrites every reviewed field of their fleet A invitations and moves them to fleet B
REWRITE="$(as "$OWNER") UPDATE public.fleet_members SET driver_phone = '+5355559999', driver_name = 'Otro', driver_email = 'otro@x.cu',
  driver_license_number = 'L9', driver_id_number = 'I9', license_doc_path = 'd9.jpg', fleet_id = '$FB' WHERE fleet_id = '$FA'; $NOJWT"
# signup ID PHONE -> a new account with that confirmed number (what GoTrue + handle_new_user write, no JWT)
signup(){ printf "INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES ('%s', '%s', now()); INSERT INTO public.users (id, phone) VALUES ('%s', '%s');" "$1" "${2#+}" "$1" "$2"; }
WHO="LEFT JOIN (VALUES ('$DRV'::uuid, 'DRV'), ('$NEWU'::uuid, 'NEWU'), ('$NEWU2'::uuid, 'NEWU2')) p(id, who) ON p.id = fm.driver_id"
# ROW -> fleet|status|who|phone|name|email|licence|id|doc|reason for every invitation ('-' = not linked / NULL)
ROW="SELECT string_agg(CASE fm.fleet_id WHEN '$FA' THEN 'A' WHEN '$FB' THEN 'B' END || '|' || fm.status || '|' || coalesce(p.who, '-')
  || '|' || fm.driver_phone || '|' || fm.driver_name || '|' || coalesce(fm.driver_email, '-') || '|' || coalesce(fm.driver_license_number, '-')
  || '|' || coalesce(fm.driver_id_number, '-') || '|' || coalesce(fm.license_doc_path, '-') || '|' || coalesce(fm.rejected_reason, '-'),
  ',' ORDER BY fm.added_at, fm.driver_phone) FROM public.fleet_members fm $WHO;"
# LINKS -> status:who for every invitation
LINKS="SELECT string_agg(fm.status || ':' || coalesce(p.who, '-'), ',' ORDER BY fm.added_at, fm.driver_phone) FROM public.fleet_members fm $WHO;"
# FINGERPRINT -> every row the self-test must leave alone
FINGERPRINT="SELECT md5(coalesce((SELECT string_agg(fm::text, ',' ORDER BY fm.id) FROM public.fleet_members fm), '')
  || coalesce((SELECT string_agg(df::text, ',' ORDER BY df.id) FROM public.driver_fleets df), '')
  || coalesce((SELECT string_agg(ca::text, ',' ORDER BY ca.id) FROM public.corporate_accounts ca), '')
  || coalesce((SELECT string_agg(u::text, ',' ORDER BY u.id) FROM public.users u), '')
  || coalesce((SELECT string_agg(au::text, ',' ORDER BY au.id) FROM auth.users au), ''))"
# Bodies read from prod on 2026-09-25: signature|md5(prosrc)|length. The scaffold must carry them.
LIVE="public.tg_fleet_members_protect()|8b0d07aff7ab33142bfcec29304c01ed|674
public.auto_link_fleet_member_on_signup()|c4b25ab786f201ced8661633ff113e57|434
public.relink_fleet_member_for_existing_driver(uuid,text)|87327e7eb782781d445804ae8b4a5a21|565
public.is_admin()|22cb75e91980d512498034cd33e1eda2|285
public.current_user_role()|cb4a7c12d4e21fe2997135833f141e25|103
public._normalize_cuban_phone(text)|9f5227a3c108fa42f6aacdf01fb0ad86|451
public.tg_corporate_accounts_protect_insert()|16d3e41267fd99172c562f62e4e968fd|455
auth.uid()|cdef18c69c4f4cbbced2eaf81e628b49|176"
# bodies PREFIX [SKIP] -> every LIVE body but SKIP is still the prod one
bodies(){ while IFS='|' read -r sig md5 len; do
  [ "$sig" = "${2:-}" ] && continue
  val "$1 $sig is the prod body" "SELECT md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE oid = '$sig'::regprocedure" "$md5/$len"
done <<< "$LIVE"; }
# fresh NAME -> a database with the scaffold and the people, nothing else
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1 \
  && $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 \
  && $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "$PEOPLE" >/dev/null 2>&1; }

echo "== reset database =="
fresh $DB || { echo "scaffold or seed failed"; exit 1; }
bodies S
ACL_BEFORE=$($P -c "SELECT proacl::text FROM pg_proc WHERE oid = 'public.tg_fleet_members_protect()'::regprocedure" | tr -d '\r')

if [ "$MIG" != "none" ]; then
  # State before the migration: invitations the self-test must leave exactly as they are.
  $P -c "$RESET $(invite $FA '+5355551111' 'approved') $(invite $FA '+5355552222' 'pending_review') $(linked $FB 'active')" >/dev/null || exit 1
  BEFORE=$($P -c "$FINGERPRINT" | tr -d '\r')
  # 1st pass in one transaction, the way `supabase db push` runs a file; 2nd in autocommit mode.
  echo "== apply migration (1st, one transaction, search_path = '') =="
  if ! CLAIM=$($P -1 -c "SET search_path = ''" -f "$MIG" -c "SELECT '[' || coalesce(current_setting('request.jwt.claim.sub', true), '') || ']'" 2>"$ERRF"); then
    echo "migration failed:"; grep -m3 ERROR "$ERRF"; exit 1
  fi
  echo "== apply migration (2nd, idempotency, autocommit, search_path = '') =="
  $P -c "SET search_path = ''" -f "$MIG" >/dev/null 2>"$ERRF" || { echo "migration NOT idempotent:"; grep -m3 ERROR "$ERRF"; exit 1; }
  val "M1 the self-test leaves every row exactly as it was" "$FINGERPRINT" "$BEFORE"
  if [ "$(printf '%s' "$CLAIM" | tr -d '\r')" = "[]" ]; then ok "M2 the self-test's JWT claim does not outlive the migration"
  else ko "M2 the self-test's JWT claim does not outlive the migration" "got [$CLAIM]"; fi
fi

echo "== tests =="
# A. the reported case: once the admin reviewed the invitation, the owner's changes are discarded
val "A1 approved: the owner's rewrite of every reviewed field, fleet included, is discarded" \
  "$RESET $(invite $FA '+5355551111' 'approved') $REWRITE $ROW" \
  "A|approved|-|+5355551111|Juan|juan@x.cu|L1|I1|d1.jpg|-"
val "A2 after the attempt, the new number's signup links nothing and the reviewed number's signup links it" \
  "$RESET $(invite $FA '+5355551111' 'approved') $REWRITE $(signup $NEWU '+5355559999') $LINKS $(signup $NEWU2 '+5355551111') $LINKS" \
  "approved:-;active:NEWU2"
val "A3 pending_signup: the rewrite is discarded" \
  "$RESET $(invite $FA '+5355551111' 'pending_signup') $REWRITE $ROW" \
  "A|pending_signup|-|+5355551111|Juan|juan@x.cu|L1|I1|d1.jpg|-"
val "A4 rejected: the rewrite is discarded, so a later approval covers what the admin rejected" \
  "$RESET $(invite $FA '+5355551111' 'pending_review') $(reject $FA '+5355551111' 'Licencia vencida') $REWRITE $ROW" \
  "A|rejected|-|+5355551111|Juan|juan@x.cu|L1|I1|d1.jpg|Licencia vencida"
val "A5 active: the rewrite is discarded and the driver stays linked" \
  "$RESET $(linked $FA 'active') $REWRITE $ROW" \
  "A|active|DRV|+5355551234|Juan|juan@x.cu|L1|I1|d1.jpg|-"
val "A6 inactive: the rewrite is discarded" \
  "$RESET $(linked $FA 'inactive') $REWRITE $ROW" \
  "A|inactive|DRV|+5355551234|Juan|juan@x.cu|L1|I1|d1.jpg|-"
val "A7 the rejection reason is the admin's: the owner cannot rewrite it" \
  "$RESET $(invite $FA '+5355551111' 'pending_review') $(reject $FA '+5355551111' 'Licencia vencida')
   $(as $OWNER) UPDATE public.fleet_members SET rejected_reason = 'Aprobado por el supervisor'; $NOJWT
   SELECT rejected_reason FROM public.fleet_members;" "Licencia vencida"
val "A8 nor plant one on an invitation in review" \
  "$RESET $(invite $FA '+5355551111' 'pending_review')
   $(as $OWNER) UPDATE public.fleet_members SET rejected_reason = 'Aprobado por el supervisor'; $NOJWT
   SELECT coalesce(rejected_reason, '-') FROM public.fleet_members;" "-"
val "A9 status sent along with the number (to reopen the review): both discarded" \
  "$RESET $(invite $FA '+5355551111' 'pending_review') $(approve $FA '+5355551111')
   $(as $OWNER) UPDATE public.fleet_members SET status = 'pending_review', driver_phone = '+5355559999'; $NOJWT
   SELECT status || '|' || driver_phone FROM public.fleet_members;" "approved|+5355551111"
val "A10 an upsert that updates on conflict (PostgREST merge-duplicates) is discarded too" \
  "$RESET $(invite $FA '+5355551111' 'pending_review') $(approve $FA '+5355551111')
   $(as $OWNER) INSERT INTO public.fleet_members (fleet_id, driver_name, driver_phone, driver_license_number)
     VALUES ('$FA', 'Otro', '+5355551111', 'L9')
     ON CONFLICT (fleet_id, driver_phone) DO UPDATE SET driver_name = EXCLUDED.driver_name, driver_license_number = EXCLUDED.driver_license_number; $NOJWT
   SELECT status || '|' || driver_name || '|' || driver_license_number FROM public.fleet_members;" "approved|Juan|L1"

# B. what must keep working
val "B1 in review: the owner's edits go through, fleet included (the admin has not reviewed it yet)" \
  "$RESET $(invite $FA '+5355551111' 'pending_review') $REWRITE $ROW" \
  "B|pending_review|-|+5355559999|Otro|otro@x.cu|L9|I9|d9.jpg|-"
val "B2 the admin corrects a reviewed invitation" \
  "$RESET $(invite $FA '+5355551111' 'approved')
   $(as $ADMIN) UPDATE public.fleet_members SET driver_phone = '+5355559999', driver_name = 'Otro'; $NOJWT
   SELECT status || '|' || driver_phone || '|' || driver_name FROM public.fleet_members;" "approved|+5355559999|Otro"
val "B3 a write with no JWT (service role, a migration) goes through" \
  "$RESET $(invite $FA '+5355551111' 'approved') UPDATE public.fleet_members SET driver_phone = '+5355559999';
   SELECT driver_phone FROM public.fleet_members;" "+5355559999"
val "B4 the signup of the reviewed number links it (00595, trusted flag)" \
  "$RESET $(invite $FA '+5355551111' 'pending_review') $(approve $FA '+5355551111') $(signup $NEWU '+5355551111') $LINKS" "active:NEWU"
val "B5 the admin relink RPC links it" \
  "$RESET $(invite $FA '+5355551234' 'pending_review') $(approve $FA '+5355551234')
   $(as $ADMIN) SELECT public.relink_fleet_member_for_existing_driver('$DRV', '+5355551234'); $NOJWT $LINKS" "1;active:DRV"
val "B6 the owner deletes a reviewed invitation and invites again: the new one goes to review, unlinked" \
  "$RESET $(invite $FA '+5355551111' 'approved')
   $(as $OWNER) DELETE FROM public.fleet_members WHERE fleet_id = '$FA';
   INSERT INTO public.fleet_members (fleet_id, driver_name, driver_phone, status) VALUES ('$FA', 'Otro', '+5355559999', 'approved'); $NOJWT $ROW" \
  "A|pending_review|-|+5355559999|Otro|-|-|-|-|-"
val "B7 the owner's insert is forced to review, unlinked, with no reason or reviewer" \
  "$RESET $(as $OWNER) INSERT INTO public.fleet_members (fleet_id, driver_id, driver_name, driver_phone, status, rejected_reason, reviewed_by)
     VALUES ('$FA', '$DRV', 'Juan', '+5355551234', 'active', 'Aprobado', '$ADMIN'); $NOJWT
   SELECT status || '|' || coalesce(driver_id::text, '-') || '|' || coalesce(rejected_reason, '-') || '|' || coalesce(reviewed_by::text, '-') FROM public.fleet_members;" \
  "pending_review|-|-|-"
val "B8 the admin approves and rejects the way FleetReview does" \
  "$RESET $(invite $FA '+5355551111' 'pending_review') $(invite $FA '+5355552222' 'pending_review')
   $(approve $FA '+5355551111') $(reject $FA '+5355552222' 'Licencia vencida')
   SELECT string_agg(status || '|' || coalesce(rejected_reason, '-') || '|' || (reviewed_by = '$ADMIN'), ',' ORDER BY driver_phone) FROM public.fleet_members;" \
  "approved|-|true,rejected|Licencia vencida|true"
val "B9 an owner update that changes nothing raises nothing" \
  "$RESET $(invite $FA '+5355551111' 'approved')
   $(as $OWNER) UPDATE public.fleet_members SET driver_phone = driver_phone, driver_name = driver_name; $NOJWT $ROW" \
  "A|approved|-|+5355551111|Juan|juan@x.cu|L1|I1|d1.jpg|-"

# D. contract: same trigger, same function shape and privileges, no other body touched
val "D1 the trigger is the same: BEFORE INSERT OR UPDATE, every column, per row" \
  "SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.fleet_members'::regclass AND tgname = 'trg_fleet_members_protect'" \
  "CREATE TRIGGER trg_fleet_members_protect BEFORE INSERT OR UPDATE ON public.fleet_members FOR EACH ROW EXECUTE FUNCTION tg_fleet_members_protect()"
val "D2 same signature, SECURITY DEFINER, same pinned search_path" \
  "SELECT pg_get_function_identity_arguments(oid) || '|' || pg_get_function_result(oid) || '|' || prosecdef || '|' || array_to_string(proconfig, ',')
   FROM pg_proc WHERE oid = 'public.tg_fleet_members_protect()'::regprocedure" "|trigger|true|search_path=public, pg_catalog"
val "D3 the ACL is the same" "SELECT proacl::text FROM pg_proc WHERE oid = 'public.tg_fleet_members_protect()'::regprocedure" "$ACL_BEFORE"
bodies "D4 unchanged:" "public.tg_fleet_members_protect()"

if [ "$MIG" != "none" ]; then
  # D5. fidelity: the new body is the live one plus the 00600 block, and nothing else
  FIDQ="$("$PY" - "$MIG" <<'PYEOF'
import sys
src = open(sys.argv[1], encoding='utf-8', newline='').read()
fn = src.index('CREATE OR REPLACE FUNCTION public.tg_fleet_members_protect()')
start = src.index('    -- 00600:', fn)
end = src.index('    END IF;\n', start) + len('    END IF;\n')
blk = src[start:end]
assert '$blk$' not in blk
q = ("SELECT ((length(prosrc) - length(replace(prosrc, $blk${0}$blk$, ''))) / length($blk${0}$blk$))::text"
     " || '|' || md5(replace(prosrc, $blk${0}$blk$, '')) || '/' || length(replace(prosrc, $blk${0}$blk$, ''))"
     " FROM pg_proc WHERE oid = 'public.tg_fleet_members_protect()'::regprocedure").format(blk)
sys.stdout.buffer.write(q.encode('utf-8'))  # bytes: a text-mode stdout on Windows would turn \n into \r\n
PYEOF
)"
  if [ -n "$FIDQ" ]; then
    val "D5 without its 00600 block (present once), the new body is byte for byte the live one" "$FIDQ" "1|8b0d07aff7ab33142bfcec29304c01ed/674"
  else
    ko "D5 without its 00600 block (present once), the new body is byte for byte the live one" "could not find the block in the migration"
  fi

  # G. a database built from the migrations in git has 00435's text (with comments), not the live one
  GIT="$(mktemp --suffix=.sql)"
  "$PY" - "$ROOT/supabase/migrations/00435_round7_fleet_sched_hardening.sql" "$GIT" <<'PYEOF'
import sys
src = open(sys.argv[1], encoding='utf-8', newline='').read()
start = src.index('CREATE OR REPLACE FUNCTION public.tg_fleet_members_protect()')
end = src.index('$function$;', start) + len('$function$;')
open(sys.argv[2], 'w', encoding='utf-8', newline='').write(src[start:end] + '\n')
PYEOF
  fresh ${DB}g
  G="$BIN/psql $CONN -d ${DB}g -qAt -v ON_ERROR_STOP=1"
  $G -f "$GIT" >/dev/null 2>&1
  if [ "$($G -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tg_fleet_members_protect()'::regprocedure" | tr -d '\r')" != "9d34552cc0598d60952239a2680129fd" ]; then
    ko "G1 a database built from git accepts the migration and freezes the reviewed invitation" "could not load 00435's text"
  elif ! $G -1 -c "SET search_path = ''" -f "$MIG" >/dev/null 2>"$ERRF"; then
    ko "G1 a database built from git accepts the migration and freezes the reviewed invitation" "$(tr -d '\r' < "$ERRF" | grep -m1 ERROR)"
  else
    P_MAIN="$P"; P="$G"
    val "G1 a database built from git accepts the migration and freezes the reviewed invitation" \
      "$RESET $(invite $FA '+5355551111' 'approved') $REWRITE $ROW" "A|approved|-|+5355551111|Juan|juan@x.cu|L1|I1|d1.jpg|-"
    P="$P_MAIN"
  fi
  rm -f "$GIT"

  # N. negative proofs: a copy of the migration with one defect must be aborted by its own assertions
  # mutate OLD NEW -> path of a copy of the migration with OLD (present exactly once) replaced by NEW
  mutate(){ local out; out="$(mktemp --suffix=.sql)"
    OLD="$1" NEW="$2" "$PY" - "$MIG" "$out" <<'PYEOF' || { rm -f "$out"; return 1; }
import os, sys
src = open(sys.argv[1], encoding='utf-8', newline='').read()
old, new = os.environ['OLD'], os.environ['NEW']
assert src.count(old) == 1, f"expected the anchor once, found {src.count(old)}"
out = src.replace(old, new)
assert out != src
open(sys.argv[2], 'w', encoding='utf-8', newline='').write(out)
PYEOF
    echo "$out"; }
  # expect_abort NAME ERROR FILE [PREP_SQL] -> FILE, applied to a fresh scaffold (after PREP_SQL), must fail with ERROR
  expect_abort(){ local out
    fresh ${DB}n
    local N="$BIN/psql $CONN -d ${DB}n -qAt -v ON_ERROR_STOP=1"
    if [ -n "${4:-}" ] && ! $N -c "$4" >/dev/null 2>"$ERRF"; then ko "$1" "setup failed: $(tr -d '\r' < "$ERRF" | grep -m1 ERROR)"; return; fi
    if out=$($N -1 -c "SET search_path = ''" -f "$3" 2>&1); then
      ko "$1" "the migration applied with the defect in place"
    elif echo "$out" | grep -q "$2"; then
      ok "$1"
    else
      ko "$1" "wrong error: $(echo "$out" | tr -d '\r' | grep -m1 ERROR)"
    fi; }
  # negative NAME OLD NEW ERROR -> the copy with OLD replaced by NEW must be aborted with ERROR
  negative(){ local buggy
    if ! buggy="$(mutate "$2" "$3")"; then ko "$1" "the anchor was not found; proof skipped"; return; fi
    expect_abort "$1" "$4" "$buggy"
    rm -f "$buggy"; }
  negative "N1 the number is no longer frozen: the self-test aborts the migration" \
    "      NEW.driver_phone          := OLD.driver_phone;
" "" "the owner changed an invitation the admin had reviewed"
  negative "N2 the fleet is no longer frozen: the self-test aborts the migration" \
    "      NEW.fleet_id              := OLD.fleet_id;
" "" "the owner changed an invitation the admin had reviewed"
  negative "N3 an invitation in review is frozen too: the self-test aborts the migration" \
    "    IF OLD.status <> 'pending_review' THEN" "    IF true THEN" \
    "the owner could not edit an invitation still in review"
  negative "N4 the rejection reason is left writable: the self-test aborts the migration" \
    "    NEW.rejected_reason := OLD.rejected_reason;
" "" "the owner rewrote the admin"
  expect_abort "N5 someone changed the function after 2026-09-25: the migration refuses to replace it" \
    "is not the body this migration was written against" "$MIG" \
    "DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.tg_fleet_members_protect()'::regprocedure),
       E'    RETURN NEW;\n  END IF;\nEND;', E'    NEW.added_at := OLD.added_at;\n    RETURN NEW;\n  END IF;\nEND;'); END \$d\$;"
  expect_abort "N6 the trigger lost its INSERT event: the migration refuses" \
    "is not attached to fleet_members as BEFORE INSERT OR UPDATE" "$MIG" \
    "DROP TRIGGER trg_fleet_members_protect ON public.fleet_members;
     CREATE TRIGGER trg_fleet_members_protect BEFORE UPDATE ON public.fleet_members FOR EACH ROW EXECUTE FUNCTION tg_fleet_members_protect();"
fi

echo "== summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
````

## Appendix C — `supabase/migrations/00600_freeze_reviewed_fleet_invitations.sql`

````sql
-- ============================================================
-- 00600: a reviewed fleet invitation stays as the admin reviewed it
--
-- A fleet owner can rewrite an invitation (fleet_members) after the admin has
-- reviewed it. The owner's UPDATE policy, fleet_members_owner_or_admin_update,
-- has no WITH CHECK; `authenticated` can UPDATE every column; and
-- tg_fleet_members_protect() only reverts status, driver_id, signed_up_at,
-- reviewed_at and reviewed_by for the owner. The number, the name, the
-- licence, the ID, the licence document, the fleet and the admin's rejection
-- reason all stay writable. Every path that links an invitation to an account
-- (auto_link_fleet_member_on_signup, the admin relink RPC, and the 00598
-- triggers and backfill) reads an approved, unlinked row as "the admin
-- approved this person at this number". So an owner can point an approved
-- invitation at someone else's number. When that person signs up, or has the
-- number confirmed later (00598), they are linked to the fleet under a name
-- and licence the admin never saw, and nobody reviewed them. Moving the row
-- to another fleet of the same owner carries the approval with it.
-- Reproduced locally with the live bodies and RLS on. fleet_members,
-- driver_fleets and corporate_accounts had 0 rows in prod on 2026-09-25, so
-- nobody was hit.
--
-- Owner decisions (2026-09-25):
--   * Freeze, silently, the way the trigger already treats status: the
--     owner's write succeeds and the reviewed values stay. To change a
--     reviewed member, the owner deletes the row and invites again, and the
--     new row goes to review.
--   * Once the invitation has left 'pending_review', the owner can no longer
--     change what the admin reviewed (driver_phone, driver_name, driver_email,
--     driver_license_number, driver_id_number, license_doc_path) or the fleet
--     it was reviewed for (fleet_id). rejected_reason is the admin's text, so
--     the owner cannot change it in any status (the INSERT branch already
--     clears it).
--
-- Fix: tg_fleet_members_protect() is transcribed from the live body (md5
-- 8b0d07af..., 674 chars, no comments; the 00435 file in git has the same
-- logic with comments) and gains one block at the end of the owner's UPDATE
-- branch. Only the owner's path changes. Admins, callers with no JWT (the
-- service role, migrations, GoTrue) and the trusted writers (the signup link,
-- the relink RPC, the 00598 triggers) return before that block, and none of
-- them writes these columns. The trigger itself (name, timing, events) and
-- the function's ACL are untouched, so the trigger still fires before
-- 00598's approval trigger.
--
-- The migration refuses to replace a body it was not written against: if
-- someone changed the function after 2026-09-25, replacing it would silently
-- drop that change. It also asserts its own result instead of trusting
-- CREATE, since plpgsql only checks a body when it runs: a rolled-back
-- self-test acts as a real non-admin account.
--
-- Not covered here, flagged separately: an owner edit while the invitation
-- is still in review, between the admin opening it and approving it; and the
-- licence file itself, which the storage-upload function lets the owner
-- overwrite under the same path.
-- Rehearsal: supabase/tests/00600/run.sh.
-- ============================================================

-- 1. Only replace a body this migration knows ---------------------------------
DO $$
DECLARE
  v_fn  regprocedure := to_regprocedure('public.tg_fleet_members_protect()');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION '00600: public.tg_fleet_members_protect() does not exist (00435 creates it)';
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_fn;
  -- The live body on 2026-09-25, 00435's text in git (a database built from
  -- the migrations), or the body below (this migration already ran).
  IF v_md5 NOT IN ('8b0d07aff7ab33142bfcec29304c01ed',
                   '9d34552cc0598d60952239a2680129fd',
                   '5379b97b1e22509ba322e960e31cca26') THEN
    RAISE EXCEPTION '00600: tg_fleet_members_protect() is not the body this migration was written against (md5 %). Transcribe it again from pg_get_functiondef and keep what changed.', v_md5;
  END IF;
END $$;

-- 2. The owner's UPDATE keeps what the admin reviewed ------------------------------
CREATE OR REPLACE FUNCTION public.tg_fleet_members_protect()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF current_setting('app.trusted_fleet_update', true) = '1' THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.status          := 'pending_review';
    NEW.driver_id       := NULL;
    NEW.signed_up_at    := NULL;
    NEW.reviewed_at     := NULL;
    NEW.reviewed_by     := NULL;
    NEW.rejected_reason := NULL;
    RETURN NEW;
  ELSE
    NEW.status       := OLD.status;
    NEW.driver_id    := OLD.driver_id;
    NEW.signed_up_at := OLD.signed_up_at;
    NEW.reviewed_at  := OLD.reviewed_at;
    NEW.reviewed_by  := OLD.reviewed_by;
    -- 00600: the rejection reason is the admin's text. Once the admin has
    -- reviewed the invitation, what they reviewed and the fleet it is for
    -- stay as reviewed; to change them, the owner deletes it and invites again.
    NEW.rejected_reason := OLD.rejected_reason;
    IF OLD.status <> 'pending_review' THEN
      NEW.fleet_id              := OLD.fleet_id;
      NEW.driver_name           := OLD.driver_name;
      NEW.driver_phone          := OLD.driver_phone;
      NEW.driver_email          := OLD.driver_email;
      NEW.driver_license_number := OLD.driver_license_number;
      NEW.driver_id_number      := OLD.driver_id_number;
      NEW.license_doc_path      := OLD.license_doc_path;
    END IF;
    RETURN NEW;
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.tg_fleet_members_protect() IS
  'BEFORE INSERT OR UPDATE on fleet_members. For the fleet owner (a JWT that is not an admin, without app.trusted_fleet_update), an insert always starts in pending_review, unlinked and unreviewed. An update never changes status, driver_id, signed_up_at, reviewed_at, reviewed_by or rejected_reason, and once the invitation has left pending_review it does not change the reviewed fields (driver_phone, driver_name, driver_email, driver_license_number, driver_id_number, license_doc_path) or fleet_id either (00600). The owner''s write succeeds with those values kept; to change a reviewed member, delete it and invite again.';

-- 3. Assert the result ---------------------------------------------------------------
-- Acting as a real non-admin account (its id in the JWT claim, the way
-- PostgREST sets it), the block rewrites an approved invitation (all seven
-- reviewed fields), rewrites an admin's rejection reason and edits an
-- invitation still in review. The first two must be kept, the third must go
-- through. Everything the block does is rolled back, the claim included. A
-- database with no non-admin account has nobody to act as, so the behaviour
-- check is skipped there. The trigger check always runs.
DO $$
DECLARE
  v_owner          uuid;
  v_claim          text := current_setting('request.jwt.claim.sub', true);
  v_corp_a         uuid := gen_random_uuid();
  v_corp_b         uuid := gen_random_uuid();
  v_fleet_a        uuid := gen_random_uuid();
  v_fleet_b        uuid := gen_random_uuid();
  v_reviewed       uuid := gen_random_uuid();
  v_rejected       uuid := gen_random_uuid();
  v_pending        uuid := gen_random_uuid();
  v_after_reviewed text;
  v_after_rejected text;
  v_after_pending  text;
  v_expected       text := concat_ws('|', 'fleet a', 'Reviewed', '+5355500601', 'reviewed@00600.test', 'L-1', 'I-1', 'doc-1');
BEGIN
  SELECT u.id INTO v_owner
  FROM public.users u
  WHERE u.role NOT IN ('admin', 'super_admin')
  ORDER BY u.created_at, u.id
  LIMIT 1;

  IF v_owner IS NULL THEN
    RAISE NOTICE '00600: no non-admin account yet, behaviour self-test skipped';
  ELSE
    BEGIN
      -- Fixtures, written with no JWT, so the trigger lets them through as they are.
      PERFORM set_config('request.jwt.claim.sub', '', true);
      PERFORM set_config('request.jwt.claims', '', true);
      PERFORM set_config('app.trusted_fleet_update', '', true);
      INSERT INTO public.corporate_accounts (id, name, contact_phone, created_by) VALUES
        (v_corp_a, '00600 self-test A', '+5355500600', v_owner),
        (v_corp_b, '00600 self-test B', '+5355500600', v_owner);
      INSERT INTO public.driver_fleets (id, corporate_account_id, name) VALUES
        (v_fleet_a, v_corp_a, '00600 self-test A'),
        (v_fleet_b, v_corp_b, '00600 self-test B');
      INSERT INTO public.fleet_members (id, fleet_id, driver_name, driver_phone, driver_email,
                                        driver_license_number, driver_id_number, license_doc_path,
                                        status, rejected_reason) VALUES
        (v_reviewed, v_fleet_a, 'Reviewed', '+5355500601', 'reviewed@00600.test', 'L-1', 'I-1', 'doc-1', 'approved', NULL),
        (v_rejected, v_fleet_a, 'Rejected', '+5355500602', NULL, NULL, NULL, NULL, 'rejected', 'admin reason'),
        (v_pending,  v_fleet_a, 'Pending',  '+5355500603', NULL, NULL, NULL, NULL, 'pending_review', NULL);

      -- The owner's writes, with the owner's id in the claim.
      PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
      UPDATE public.fleet_members
         SET fleet_id = v_fleet_b, driver_name = 'Other', driver_phone = '+5355500699',
             driver_email = 'other@00600.test', driver_license_number = 'L-9',
             driver_id_number = 'I-9', license_doc_path = 'doc-9'
       WHERE id = v_reviewed;
      UPDATE public.fleet_members SET rejected_reason = 'owner text' WHERE id = v_rejected;
      UPDATE public.fleet_members SET driver_phone = '+5355500698' WHERE id = v_pending;
      PERFORM set_config('request.jwt.claim.sub', '', true);

      SELECT concat_ws('|', CASE fleet_id WHEN v_fleet_a THEN 'fleet a' WHEN v_fleet_b THEN 'fleet b' END,
                       driver_name, driver_phone, driver_email, driver_license_number, driver_id_number, license_doc_path)
        INTO v_after_reviewed FROM public.fleet_members WHERE id = v_reviewed;
      SELECT rejected_reason INTO v_after_rejected FROM public.fleet_members WHERE id = v_rejected;
      SELECT driver_phone INTO v_after_pending FROM public.fleet_members WHERE id = v_pending;

      RAISE EXCEPTION '00600 self-test rollback';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> '00600 self-test rollback' THEN
        RAISE;
      END IF;
    END;

    IF v_after_reviewed IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION '00600: the owner changed an invitation the admin had reviewed: % (expected %)', coalesce(v_after_reviewed, 'missing'), v_expected;
    END IF;
    IF v_after_rejected IS DISTINCT FROM 'admin reason' THEN
      RAISE EXCEPTION '00600: the owner rewrote the admin''s rejection reason: %', coalesce(v_after_rejected, 'NULL');
    END IF;
    IF v_after_pending IS DISTINCT FROM '+5355500698' THEN
      RAISE EXCEPTION '00600: the owner could not edit an invitation still in review: %', coalesce(v_after_pending, 'missing');
    END IF;
    IF coalesce(current_setting('request.jwt.claim.sub', true), '') <> coalesce(v_claim, '') THEN
      RAISE EXCEPTION '00600: the self-test left the JWT claim set';
    END IF;
    RAISE NOTICE '00600: verified, the owner cannot change a reviewed invitation and can still edit one in review';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.fleet_members'::regclass
      AND t.tgname = 'trg_fleet_members_protect'
      AND t.tgfoid = 'public.tg_fleet_members_protect()'::regprocedure
      AND t.tgtype = 23                        -- FOR EACH ROW | BEFORE | INSERT | UPDATE
      AND t.tgenabled = 'O'
      AND cardinality(t.tgattr::int2[]) = 0    -- every column, not UPDATE OF
  ) THEN
    RAISE EXCEPTION '00600: trg_fleet_members_protect is not attached to fleet_members as BEFORE INSERT OR UPDATE FOR EACH ROW';
  END IF;
END $$;
````
