# Link fleet invitations to existing drivers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an invitation in `fleet_members` gets linked to a person who already has an account, at approval time or when that person verifies the phone later, using only OTP-confirmed numbers.

**Architecture:** one migration (00598) adds a helper that maps a number to the one active account that confirmed it in `auth.users`, a BEFORE trigger on `fleet_members` that links when a write makes the invitation linkable, an AFTER UPDATE OF phone trigger on `public.users`, and a one-time backfill. The migration asserts itself (rolled-back self-test + ACL check). A local Postgres rehearsal with the live prod bodies proves RED → GREEN. Spec: `docs/superpowers/specs/2026-09-25-fleet-link-existing-drivers-design.md`.

**Tech Stack:** PostgreSQL 16 / plpgsql (Supabase), bash + psql rehearsal, TypeScript doc comments in `@tricigo/api`.

---

## File structure

| File | Responsibility |
|---|---|
| `supabase/tests/00598/scaffold.sql` (create) | Live prod shapes, RLS policies, grants and function bodies the linking paths run (byte for byte) |
| `supabase/tests/00598/run.sh` (create) | RED/GREEN runner: seed, behaviour tests (approval, owner, phone verified later, signup), contract, negative proofs |
| `supabase/migrations/00598_link_fleet_invitations_to_existing_accounts.sql` (create) | Helper, two triggers, backfill, self-test |
| `packages/api/src/services/fleet.service.ts` (modify: JSDoc of `approveMember`, `relinkExistingDriver`) | Say what the database now does |
| `CLAUDE.md` (modify: after "Fleet membership 3-way gate") | Linking model, `users.phone` is not proof, trigger order |

Local cluster (Windows): portable Postgres 16 in the scratchpad, started with
`pg_ctl -D <scratchpad>/pgdata -o "-p 5437 -c listen_addresses=127.0.0.1" -l <scratchpad>/pg.log -w start`.
Runner env on Windows: `PGBIN=<scratchpad>/pgsql/bin PGPORT=5437 PYTHON=python`.

---

### Task 1: Rehearsal scaffold and tests (RED)

**Files:**
- Create: `supabase/tests/00598/scaffold.sql`
- Create: `supabase/tests/00598/run.sh`

- [ ] **Step 1: Write `supabase/tests/00598/scaffold.sql`** — full content in Appendix A.
- [ ] **Step 2: Write `supabase/tests/00598/run.sh`** (mode 755) — full content in Appendix B.
- [ ] **Step 3: Run RED**

Run: `PGBIN=… PGPORT=5437 PYTHON=python bash supabase/tests/00598/run.sh none`
Expected: every `S … is the prod body` check PASSES (the scaffold is faithful). FAIL, for the right reason:
- A1–A7 and A13 (the invitation stays `approved:-`, the reported bug);
- C1, C2 and C5 (no link after the phone is verified);
- D1–D5 (the new functions and triggers do not exist).
PASS as controls: A8–A12, B1–B3, C3, C4, C6, X1, D6.
If B1/B2 fail with `approved:-`, the fixtures share the test's transaction: the signup trigger leaves
`app.trusted_fleet_update = '1'` until commit, so the owner's writes skip the protect trigger. `tcase`
commits the reset on its own for that reason.

- [ ] **Step 4: Commit**

```bash
git add supabase/tests/00598/scaffold.sql supabase/tests/00598/run.sh
git commit -m "test(fleet): rehearsal for linking invitations to existing accounts (RED)"
```

### Task 2: Migration 00598 (GREEN)

**Files:**
- Create: `supabase/migrations/00598_link_fleet_invitations_to_existing_accounts.sql` — full content in Appendix C.

- [ ] **Step 1: Re-check the number is free** (master + every open PR + remote branches):

```bash
git fetch origin
git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -3
for pr in $(gh pr list --state open --json number --jq '.[].number'); do gh pr view $pr --json files --jq '.files[].path' | grep supabase/migrations; done
```
Expected: nothing uses `00598`.

- [ ] **Step 2: Write the migration** (Appendix C).
- [ ] **Step 3: Run GREEN**

Run: `PGBIN=… PGPORT=5437 PYTHON=python bash supabase/tests/00598/run.sh supabase/migrations/00598_link_fleet_invitations_to_existing_accounts.sql`
Expected: `summary: N passed, 0 failed`, including M1, M2, N1–N3 and the D7 bodies check.

- [ ] **Step 4: Check line endings** — `git ls-files --eol` must show `w/lf` for the three new SQL/sh files after `git add`.
- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00598_link_fleet_invitations_to_existing_accounts.sql
git commit -m "fix(db): link fleet invitations to accounts that already exist (00598)"
```

### Task 3: Service doc comments

**Files:**
- Modify: `packages/api/src/services/fleet.service.ts:208` and `:273-277`

- [ ] **Step 1: Replace the `approveMember` JSDoc**

```ts
  /**
   * Admin: approve a single fleet member after reviewing their docs. If an
   * active account has already confirmed this phone by OTP, the database
   * links it in this same update and the row comes back 'active' (00598).
   */
```

- [ ] **Step 2: Replace the `relinkExistingDriver` JSDoc**

```ts
  /**
   * Manual fallback: link the approved invitations for `phone` to the given
   * account. The database already links on its own at signup, at approval and
   * when an account verifies its phone later (00595, 00598), always to the
   * account whose number is OTP-confirmed; this is for an account whose number
   * was never confirmed by OTP.
   */
```

- [ ] **Step 3: Verify**

Run: `pnpm check-types` → all packages pass. Run: `pnpm --filter @tricigo/api test -- fleet` → fleet tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/services/fleet.service.ts
git commit -m "docs(fleet): approval and phone verification now link existing accounts"
```

### Task 4: CLAUDE.md

- [ ] **Step 1: Insert after the "Fleet membership 3-way gate (corporate)" section** (before "Smoke test E2E paths…"):

```markdown
### Flotas: cómo queda vinculada una invitación (00595 + 00598, verificado 2026-09-25)

Una fila de `fleet_members` pasa a `status='active'` con `driver_id` por tres caminos automáticos, todos por teléfono normalizado, y uno manual:
1. **Alta:** `auto_link_fleet_member_on_signup` (AFTER INSERT ON `users`). La cuenta nueva trae el número de GoTrue (`handle_new_user`), ya verificado.
2. **Aprobación:** `trg_fleet_members_set_driver_on_approval` (BEFORE INSERT OR UPDATE OF status). Cuando la invitación **pasa a** `approved`/`pending_signup`, la vincula a la cuenta activa que confirmó ese número por OTP. Una fila que ya estaba aprobada no se vuelve a mirar: el dueño todavía puede cambiar `driver_phone` después de la revisión, y ese cambio no debe vincular a nadie.
3. **Teléfono verificado después:** `auto_link_fleet_member_on_phone_verified` (AFTER UPDATE OF phone ON `users`). Solo vincula si `auth.users` confirma ese número para esa misma cuenta, que es lo que hace `link-phone` antes de copiarlo a `users`.
4. **Manual:** `relink_fleet_member_for_existing_driver` (solo admin), para una cuenta cuyo número nunca pasó por OTP.

**`public.users.phone` no prueba que el número sea de esa persona.** Su dueño lo puede escribir por PostgREST sin OTP: tiene grant de columna, `users_update_own` lo permite y `tg_users_protect_admin_fields` no lo cubre. Además no es único. La fuente confiable es `auth.users.phone` con `phone_confirmed_at`: tiene índice único `users_phone_key` y va en E.164 **sin `+`** (`53XXXXXXXX`). Para "la cuenta de este número" usar `_user_id_by_verified_phone(text)`, que no es ejecutable por clientes porque sirve de oráculo número→cuenta.

**Orden de triggers:** los del mismo evento y momento disparan en orden de nombre (strcmp). `trg_fleet_members_set_driver_on_approval` corre después de `trg_fleet_members_protect` a propósito (`s` > `p`), así ve la fila con los cambios del dueño ya revertidos. Renombrar cualquiera de los dos cambia ese orden.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): how fleet invitations get linked; users.phone is not proof"
```

### Task 5: Review, push, PR

- [ ] **Step 1:** code review by a subagent (superpowers:requesting-code-review) over `origin/master...HEAD`; address findings with superpowers:receiving-code-review; re-run the rehearsal after any SQL change.
- [ ] **Step 2:** re-run the migration-number check from Task 2 Step 1 right before pushing.
- [ ] **Step 3:** `git push -u origin claude/fleet-link-existing-drivers`; `gh pr create --base master --body-file <scratchpad>/pr-body.md`. Body: problem, decisions, fix, rehearsal numbers, "not applied to production (MCP guard)", test plan.
- [ ] **Step 4:** do not merge and do not apply the migration without explicit per-PR authorization.

### Task 6: Revision after code review (owner decisions 4–6 in the spec)

The review reproduced that the first "verified later" trigger, on `public.users`, could be re-fired
without an OTP by setting `users.phone` away and back. The appendices below are the revised files.

- [x] **Step 1:** tests first. Scaffold gains `handle_new_user` and its trigger on `auth.users`, so signups go
  through an INSERT into `auth.users` as in prod. New cases: C5 (the away-and-back toggle), C6/X2 (GoTrue's own
  phone signup: unconfirmed, then confirmed), C7 (re-confirmation), C8/X3 (a linking error never fails a
  confirmation or a signup), C9, A15 (re-approval of a row that lost its account), A16 (NULL status), B2/C3
  asserting that the write itself went through.
- [x] **Step 2:** RED: 21 of 62 fail, each for its reason; the controls pass.
- [x] **Step 3:** migration: confirmation trigger `on_auth_user_phone_confirmed` on `auth.users` (created last),
  the signup trigger gated on the confirmed number, both error-contained; NULL-status guard; `lock_timeout`;
  `CREATE OR REPLACE TRIGGER`; self-test covers approval, signup and confirmation; self-test account filter
  `^53[56]`.
- [x] **Step 4:** GREEN: 68/68, applied twice; N1–N4 abort.
- [x] **Step 5:** `supabase/tests/00598/mutants.py` (Appendix D): 11 guards, each caught by its own test.

---

## Appendix A — `supabase/tests/00598/scaffold.sql`

````sql
-- Scaffold for the 00598 rehearsal: the LIVE production shapes of users,
-- corporate_accounts, driver_fleets and fleet_members, their RLS policies and
-- grants, and every function the fleet-linking paths run, transcribed on
-- 2026-09-25 from pg_get_functiondef, pg_policies, pg_trigger, pg_indexes and
-- information_schema. Each function body is byte for byte the one running in
-- prod: run.sh checks md5(prosrc) and length against the values read there.
-- auth.users keeps only the columns _user_id_by_verified_phone reads, with
-- GoTrue's unique index on phone; public.users keeps the columns these paths
-- and tg_users_protect_admin_fields touch. RLS is on, so the tests run each
-- call as `authenticated` with a JWT subject, the way PostgREST does.
-- fleet_members, driver_fleets and corporate_accounts had 0 rows in prod.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
GRANT anon, authenticated, service_role TO pgtest;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');

-- GoTrue's table, trimmed to what handle_new_user and the linking paths read.
-- GoTrue stores phones as E.164 digits without '+' (all 544 in prod are
-- 53XXXXXXXX). No grant to anon/authenticated, as in prod.
CREATE TABLE auth.users (
  id                 uuid PRIMARY KEY,
  email              character varying,
  phone              text DEFAULT NULL,
  phone_confirmed_at timestamptz,
  raw_user_meta_data jsonb
);
CREATE UNIQUE INDEX users_phone_key ON auth.users USING btree (phone);

-- LIVE public.users, trimmed. No unique index on phone: prod has none.
CREATE TABLE public.users (
  id                   uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  phone                text,
  full_name            text NOT NULL DEFAULT ''::text,
  email                text,
  role                 public.user_role NOT NULL DEFAULT 'customer',
  is_active            boolean NOT NULL DEFAULT true,
  level                text NOT NULL DEFAULT 'bronce',
  total_rides          integer NOT NULL DEFAULT 0,
  total_spent          numeric NOT NULL DEFAULT 0,
  cancellation_count   integer NOT NULL DEFAULT 0,
  last_cancellation_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_phone_not_blank CHECK (((phone IS NULL) OR (btrim(phone) <> ''::text)))
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
-- As in prod: authenticated may UPDATE every column of its own row, phone included.
GRANT SELECT, INSERT, UPDATE ON public.users TO anon, authenticated, service_role;

-- LIVE driver_profiles, trimmed: tg_users_protect_admin_fields reads it.
CREATE TABLE public.driver_profiles (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  status  text NOT NULL DEFAULT 'pending_verification'
);

-- LIVE (md5 cb4a7c12…, 103)
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

-- LIVE (00592, md5 22cb75e9…, 285)
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

-- LIVE (md5 5655a461…, 105)
CREATE OR REPLACE FUNCTION public.is_super_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM users
    WHERE id = auth.uid()
      AND role = 'super_admin'
  );
$function$;
REVOKE EXECUTE ON FUNCTION public.is_super_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated, service_role;

-- LIVE (00487, md5 9f5227a3…, 451)
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

-- LIVE (00461, md5 c0491b42…, 147)
CREATE OR REPLACE FUNCTION public.tg_users_normalize_phone()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.phone IS NOT NULL AND NEW.phone <> '' THEN
    NEW.phone := public._normalize_cuban_phone(NEW.phone);
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER tg_users_normalize_phone BEFORE INSERT OR UPDATE OF phone ON public.users
  FOR EACH ROW EXECUTE FUNCTION tg_users_normalize_phone();

-- LIVE (md5 2907fccb…, 1701): reverts role/is_active/level/counters for a
-- non-admin, but NOT phone.
CREATE OR REPLACE FUNCTION public.tg_users_protect_admin_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_super_admin() THEN
    RETURN NEW;
  END IF;

  IF current_setting('app.trusted_tier_update', true) = '1' THEN
    NEW.role                 := OLD.role;
    NEW.is_active            := OLD.is_active;
    NEW.total_spent          := OLD.total_spent;
    NEW.cancellation_count   := OLD.cancellation_count;
    NEW.last_cancellation_at := OLD.last_cancellation_at;
    NEW.id                   := OLD.id;
    NEW.created_at           := OLD.created_at;
    RETURN NEW;
  END IF;

  IF current_setting('app.trusted_cancel_update', true) = '1' THEN
    NEW.role        := OLD.role;
    NEW.is_active   := OLD.is_active;
    NEW.level       := OLD.level;
    NEW.total_rides := OLD.total_rides;
    NEW.total_spent := OLD.total_spent;
    NEW.id          := OLD.id;
    NEW.created_at  := OLD.created_at;
    RETURN NEW;
  END IF;

  IF is_admin() THEN
    IF NOT (OLD.role = 'customer' AND NEW.role = 'driver'
            AND EXISTS (SELECT 1 FROM driver_profiles dp
                        WHERE dp.user_id = NEW.id AND dp.status = 'approved')) THEN
      NEW.role := OLD.role;
    END IF;
    NEW.level := OLD.level;
    NEW.id          := OLD.id;
    NEW.created_at  := OLD.created_at;
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.role               := OLD.role;
  NEW.is_active          := OLD.is_active;
  NEW.level              := OLD.level;
  NEW.total_rides        := OLD.total_rides;
  NEW.total_spent        := OLD.total_spent;
  NEW.cancellation_count := OLD.cancellation_count;
  NEW.last_cancellation_at := OLD.last_cancellation_at;
  NEW.id                 := OLD.id;
  NEW.created_at         := OLD.created_at;

  RETURN NEW;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.tg_users_protect_admin_fields() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_users_protect_admin_fields() TO service_role;
CREATE TRIGGER trg_users_protect_admin_fields BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION tg_users_protect_admin_fields();

-- LIVE (md5 c42fa89f…, 299): GoTrue's INSERT into auth.users creates the
-- public.users row, copying the auth phone whether or not it is confirmed.
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  INSERT INTO public.users (id, phone, full_name, email, role)
  VALUES (
    NEW.id,
    NULLIF(NEW.phone, ''),
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    CASE WHEN NEW.email ~* '^phone_\d+@tricigo\.app$' THEN NULL ELSE NEW.email END,
    'customer'
  );
  RETURN NEW;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- LIVE users policies
CREATE POLICY users_admin_select ON public.users FOR SELECT USING (is_admin());
CREATE POLICY users_insert_own ON public.users FOR INSERT WITH CHECK (id = ( SELECT auth.uid() AS uid));
CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = ( SELECT auth.uid() AS uid)) OR is_admin());
CREATE POLICY users_update_own ON public.users FOR UPDATE USING (id = ( SELECT auth.uid() AS uid));

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

-- LIVE (00434, md5 16d3e412…, 455)
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
CREATE TRIGGER trg_corporate_accounts_protect_insert BEFORE INSERT ON public.corporate_accounts
  FOR EACH ROW EXECUTE FUNCTION tg_corporate_accounts_protect_insert();

-- LIVE corporate_accounts policies (corporate_accounts_corp_admin_update needs
-- corporate_employees and no test updates corporate_accounts, so it is left out).
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

-- LIVE fleet_members: unique only on (fleet_id, driver_phone) as typed.
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

-- LIVE (00435, md5 8b0d07af…, 674)
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
CREATE TRIGGER trg_fleet_members_protect BEFORE INSERT OR UPDATE ON public.fleet_members
  FOR EACH ROW EXECUTE FUNCTION tg_fleet_members_protect();

-- LIVE (00595, md5 c4b25ab7…, 434). ACL {postgres=X, service_role=X}.
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

-- LIVE (00461, md5 87327e7e…, 565). ACL {postgres=X, service_role=X, authenticated=X}.
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

## Appendix B — `supabase/tests/00598/run.sh`

````bash
#!/usr/bin/env bash
# Rehearsal runner for migration 00598 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00598/run.sh none
#       -> scaffold + tests (RED: an approved invitation is never linked to an existing account,
#          and a signup links whatever number GoTrue gave the account, confirmed or not)
#   supabase/tests/00598/run.sh supabase/migrations/00598_link_fleet_invitations_to_existing_accounts.sql
#       -> scaffold + migration x2 (idempotency) + tests + negative proofs of the self-test (GREEN)
#   supabase/tests/00598/mutants.py <migration>  -> the suite once per guard removed (see that file)
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Elsewhere, PGBIN, PGPORT and PYTHON override the defaults, e.g. on Windows:
#   PGBIN=<portable pgsql>/bin PGPORT=5437 PYTHON=python bash supabase/tests/00598/run.sh none
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PY="${PYTHON:-python3}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
DB=pr598
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# val NAME SQL EXPECTED -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
val(){ local r; r=$($P -c "$2" </dev/null 2>&1 | tr -d '\r' | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# tcase NAME SQL EXPECTED -> val on fresh fixtures. The reset commits on its own: the signup trigger leaves
# app.trusted_fleet_update = '1' for the rest of its transaction, and in prod that transaction is GoTrue's,
# never the one of a later request. Sharing it here would let the owner's writes skip the protect trigger.
tcase(){ if $P -c "$RESET" </dev/null >/dev/null 2>&1; then val "$1" "$2" "$3"; else ko "$1" "reset failed"; fi; }

# People. auth.users holds phones the way GoTrue does (E.164 digits, no '+'); handle_new_user copies
# them into public.users, where tg_users_normalize_phone adds the '+'.
ADMIN=a0000000-0000-4000-8000-000000000001    # admin, the one approving
OWNER=a0000000-0000-4000-8000-000000000002    # fleet owner (a driver)
DRV=a0000000-0000-4000-8000-000000000003      # driver with a confirmed number: the reported case
PAX=a0000000-0000-4000-8000-000000000004      # passenger only, confirmed number
SEED=a0000000-0000-4000-8000-000000000005     # admin whose number is only in users.phone (prod: 2 seeded admins)
DUP=a0000000-0000-4000-8000-000000000006      # driver who confirmed the number SEED also holds (prod's one shared number)
LONE=a0000000-0000-4000-8000-000000000007     # passenger whose number is only in users.phone
INACT=a0000000-0000-4000-8000-000000000008    # deactivated account, confirmed number
UNCONF=a0000000-0000-4000-8000-000000000009   # number in auth.users, OTP never confirmed
LATER=a0000000-0000-4000-8000-00000000000a    # Google/Apple account, no phone yet
TWIN1=a0000000-0000-4000-8000-00000000000b    # TWIN1 and TWIN2 confirmed the same number spelled two ways
TWIN2=a0000000-0000-4000-8000-00000000000c    #   (with and without '+'): which one is it? Nobody is guessed.
NEWU=b0000000-0000-4000-8000-000000000001     # someone who signs up during a test
CA=c0000000-0000-4000-8000-00000000000a; CB=c0000000-0000-4000-8000-00000000000b
FA=f0000000-0000-4000-8000-00000000000a; FB=f0000000-0000-4000-8000-00000000000b
PEOPLE="INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES
  ('$ADMIN', '5355550001', now()), ('$OWNER', '5355550002', now()), ('$DRV', '5355551234', now()),
  ('$PAX', '5355552222', now()), ('$SEED', NULL, NULL), ('$DUP', '5355553333', now()),
  ('$LONE', NULL, NULL), ('$INACT', '5355554444', now()), ('$UNCONF', '5355557777', NULL), ('$LATER', NULL, NULL),
  ('$TWIN1', '5355550909', now()), ('$TWIN2', '+5355550909', now());
UPDATE public.users u SET role = p.role::public.user_role, is_active = p.active, phone = coalesce(p.phone, u.phone)
FROM (VALUES ('$ADMIN'::uuid, 'admin', true, NULL::text), ('$OWNER'::uuid, 'driver', true, NULL), ('$DRV'::uuid, 'driver', true, NULL),
  ('$PAX'::uuid, 'customer', true, NULL), ('$SEED'::uuid, 'admin', true, '+5355553333'), ('$DUP'::uuid, 'driver', true, NULL),
  ('$LONE'::uuid, 'customer', true, '+5355556666'), ('$INACT'::uuid, 'driver', false, NULL), ('$UNCONF'::uuid, 'customer', true, NULL),
  ('$LATER'::uuid, 'customer', true, NULL), ('$TWIN1'::uuid, 'driver', true, NULL), ('$TWIN2'::uuid, 'driver', true, NULL)) p(id, role, active, phone)
WHERE u.id = p.id;"
RESET="TRUNCATE public.fleet_members, public.driver_fleets, public.corporate_accounts;
DELETE FROM auth.users;
$PEOPLE
INSERT INTO public.corporate_accounts (id, name, contact_phone, created_by) VALUES
  ('$CA', 'Flota A', '+5355550002', '$OWNER'), ('$CB', 'Flota B', '+5355550002', '$OWNER');
INSERT INTO public.driver_fleets (id, corporate_account_id, name) VALUES ('$FA', '$CA', 'Flota A'), ('$FB', '$CB', 'Flota B');"
# as PERSON -> what follows runs the way PostgREST runs that person's call: role authenticated + JWT subject
as(){ printf "SET ROLE authenticated; SET request.jwt.claim.sub = '%s';" "$1"; }
# NOJWT -> back to a caller with no JWT (service role, migrations, GoTrue's connection)
NOJWT="RESET ROLE; RESET request.jwt.claim.sub;"
# invite FLEET PHONE STATUS -> an invitation written with no JWT (a fixture; the owner's own writes are in B)
invite(){ printf "INSERT INTO public.fleet_members (fleet_id, driver_name, driver_phone, status) VALUES ('%s', 'Juan', '%s', '%s');" "$1" "$2" "$3"; }
# approve FLEET PHONE -> what fleetService.approveMember() writes, as the admin through RLS
approve(){ printf "%s UPDATE public.fleet_members SET status = 'approved', reviewed_at = now(), reviewed_by = '%s' WHERE fleet_id = '%s' AND driver_phone = '%s'; %s" "$(as "$ADMIN")" "$ADMIN" "$1" "$2" "$NOJWT"; }
# repoint FLEET FROM TO -> fixture: change the number of an invitation without touching its status
repoint(){ printf "UPDATE public.fleet_members SET driver_phone = '%s' WHERE fleet_id = '%s' AND driver_phone = '%s';" "$3" "$1" "$2"; }
# signup PHONE -> GoTrue creates an account whose number is already confirmed (verify-otp's createUser);
# handle_new_user creates its public.users row
signup(){ printf "INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES ('$NEWU', '%s', now());" "$1"; }
# signup_unconfirmed PHONE -> GoTrue's own phone signup: the account exists before its number is confirmed
signup_unconfirmed(){ printf "INSERT INTO auth.users (id, phone) VALUES ('$NEWU', '%s');" "$1"; }
# confirm PERSON PHONE -> what link-phone (or verify-otp's heal, or GoTrue's own OTP) writes in auth.users
confirm(){ printf "UPDATE auth.users SET phone = '%s', phone_confirmed_at = now() WHERE id = '%s';" "$2" "$1"; }
# BREAK_LINKS -> inside BEGIN … ROLLBACK: every link attempt now fails with a check violation
BREAK_LINKS="ALTER TABLE public.fleet_members ADD CONSTRAINT t598_no_link CHECK (status <> 'active') NOT VALID; SET LOCAL client_min_messages = error;"
# STATE -> every invitation as status:who, by fleet and phone ('-' = not linked)
STATE="SELECT string_agg(fm.status || ':' || coalesce(p.who, '-'), ',' ORDER BY fm.fleet_id, fm.driver_phone)
FROM public.fleet_members fm LEFT JOIN (VALUES ('$ADMIN'::uuid, 'ADMIN'), ('$OWNER'::uuid, 'OWNER'), ('$DRV'::uuid, 'DRV'),
  ('$PAX'::uuid, 'PAX'), ('$SEED'::uuid, 'SEED'), ('$DUP'::uuid, 'DUP'), ('$LONE'::uuid, 'LONE'), ('$INACT'::uuid, 'INACT'),
  ('$UNCONF'::uuid, 'UNCONF'), ('$LATER'::uuid, 'LATER'), ('$TWIN1'::uuid, 'TWIN1'), ('$TWIN2'::uuid, 'TWIN2'),
  ('$NEWU'::uuid, 'NEWU')) p(id, who) ON p.id = fm.driver_id;"
# Bodies read from prod on 2026-09-25: signature|md5(prosrc)|length. The scaffold must carry all of them;
# the migration redefines only auto_link_fleet_member_on_signup and must leave the rest untouched.
LIVE_SIGNUP="auto_link_fleet_member_on_signup()|c4b25ab786f201ced8661633ff113e57|434"
UNTOUCHED="tg_fleet_members_protect()|8b0d07aff7ab33142bfcec29304c01ed|674
relink_fleet_member_for_existing_driver(uuid,text)|87327e7eb782781d445804ae8b4a5a21|565
_normalize_cuban_phone(text)|9f5227a3c108fa42f6aacdf01fb0ad86|451
is_admin()|22cb75e91980d512498034cd33e1eda2|285
current_user_role()|cb4a7c12d4e21fe2997135833f141e25|103
is_super_admin()|5655a4615e92e8b1e323d06c7566b058|105
tg_users_normalize_phone()|c0491b42cf36767c3911fb8a3fda9f04|147
tg_users_protect_admin_fields()|2907fccbd0f2ec2201b7c0ec61d434a3|1701
tg_corporate_accounts_protect_insert()|16d3e41267fd99172c562f62e4e968fd|455
handle_new_user()|c42fa89f6155a50a1cc4198255dd9d77|299"
bodies(){ while IFS='|' read -r sig md5 len; do
  val "$1 $sig is the prod body" "SELECT md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE oid = 'public.$sig'::regprocedure" "$md5/$len"
done <<< "$2"; }
# ROWS -> fingerprint of everything the self-test must leave alone (all but the backfilled invitation)
ROWS="SELECT md5(coalesce((SELECT string_agg(id::text || coalesce(driver_id::text, '-') || status || driver_phone || coalesce(signed_up_at::text, '-'), ',' ORDER BY id)
                           FROM public.fleet_members WHERE driver_phone <> '+5355551234'), '')
          || coalesce((SELECT string_agg(id::text, ',' ORDER BY id) FROM public.driver_fleets), '')
          || coalesce((SELECT string_agg(id::text, ',' ORDER BY id) FROM public.corporate_accounts), '')
          || coalesce((SELECT string_agg(id::text || coalesce(phone, '-') || is_active, ',' ORDER BY id) FROM public.users), '')
          || coalesce((SELECT string_agg(id::text || coalesce(phone, '-') || coalesce(phone_confirmed_at::text, '-'), ',' ORDER BY id) FROM auth.users), ''))"

echo "== reset database =="
$BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" >/dev/null 2>&1 || exit 1
$P -f "$DIR/scaffold.sql" >/dev/null 2>&1 || { echo "scaffold failed"; exit 1; }
$P -c "$PEOPLE" >/dev/null || { echo "seed failed"; exit 1; }
bodies S "$LIVE_SIGNUP
$UNTOUCHED"

if [ "$MIG" != "none" ]; then
  # State before the migration: one invitation approved for DRV's confirmed number (the backfill's case),
  # one for a number only in users.phone and one whose OTP was never confirmed (both must stay as they are).
  $P -c "$RESET" >/dev/null || exit 1
  $P -c "$(invite $FA '+5355551234' 'approved') $(invite $FA '+5355556666' 'approved') $(invite $FB '+5355557777' 'pending_signup')" >/dev/null || exit 1
  BEFORE=$($P -c "$ROWS" | tr -d '\r')
  # 1st pass in one transaction, the way `supabase db push` runs a file; 2nd in autocommit mode.
  echo "== apply migration (1st, one transaction, search_path = '') =="; $P -1 -c "SET search_path = ''" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, search_path = '') =="; $P -c "SET search_path = ''" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  val "M1 the self-test leaves every other row exactly as it was" "$ROWS" "$BEFORE"
  val "M2 the backfill linked the invitation approved before the migration, and only that one" "$STATE" "active:DRV,approved:-,pending_signup:-"
fi

echo "== tests =="
# A. the reported case: the admin approves, through RLS, like FleetReview does
tcase "A1 existing driver with a confirmed number: the approval itself links them" \
  "$(invite $FA '+5355551234' 'pending_review') $(approve $FA '+5355551234') $STATE
   SELECT signed_up_at IS NOT NULL FROM public.fleet_members;" "active:DRV;t"
tcase "A2 the owner typed the number as 8 digits: still linked" \
  "$(invite $FA '55551234' 'pending_review') $(approve $FA '55551234') $STATE" "active:DRV"
tcase "A3 invited by two fleets: each approval links its own invitation" \
  "$(invite $FA '+5355551234' 'pending_review') $(invite $FB '5355551234' 'pending_review')
   $(approve $FA '+5355551234') $(approve $FB '5355551234') $STATE" "active:DRV,active:DRV"
tcase "A4 a passenger-only account is linked too, as a signup would be" \
  "$(invite $FA '+5355552222' 'pending_review') $(approve $FA '+5355552222') $STATE" "active:PAX"
tcase "A5 an invitation inserted already approved (service role) is linked on insert" \
  "$(invite $FA '+5355551234' 'approved') $STATE" "active:DRV"
tcase "A6 rejected, then approved: linked when it becomes approved" \
  "$(invite $FA '+5355551234' 'rejected') $(approve $FA '+5355551234') $STATE" "active:DRV"
tcase "A7 the number two accounts share (prod: a seeded admin and a driver): linked to the one who confirmed it" \
  "$(invite $FA '+5355553333' 'pending_review') $(approve $FA '+5355553333') $STATE" "active:DUP"
tcase "A8 nothing is linked before the approval" \
  "$(invite $FA '+5355551234' 'pending_review') $STATE" "pending_review:-"
tcase "A9 a number that is only in users.phone, never confirmed by OTP: not linked" \
  "$(invite $FA '+5355556666' 'pending_review') $(approve $FA '+5355556666') $STATE" "approved:-"
tcase "A10 a deactivated account: not linked" \
  "$(invite $FA '+5355554444' 'pending_review') $(approve $FA '+5355554444') $STATE" "approved:-"
tcase "A11 a number in auth.users whose OTP was never confirmed: not linked" \
  "$(invite $FA '+5355557777' 'pending_review') $(approve $FA '+5355557777') $STATE" "approved:-"
tcase "A12 nobody has the number yet: stays approved, and the signup links it later (00595)" \
  "$(invite $FA '+5355559999' 'pending_review') $(approve $FA '+5355559999') $STATE $(signup 5355559999) $STATE" "approved:-;active:NEWU"
tcase "A13 an invitation inserted as pending_signup (service role) is linked on insert" \
  "$(invite $FA '+5355551234' 'pending_signup') $STATE" "active:DRV"
tcase "A14 two accounts confirmed the same number spelled two ways: nobody is linked" \
  "$(invite $FA '+5355550909' 'pending_review') $(approve $FA '+5355550909') $STATE" "approved:-"
tcase "A15 an active invitation that lost its account (driver_id NULL), approved again: linked" \
  "INSERT INTO public.fleet_members (fleet_id, driver_name, driver_phone, status) VALUES ('$FA', 'Juan', '+5355551234', 'active');
   $(approve $FA '+5355551234') $STATE" "active:DRV"
tcase "A16 a write that nulls the status is rejected, not turned into a link (the gate must not fail open)" \
  "$(invite $FA '+5355551234' 'pending_review') CREATE TEMP TABLE t598_out (x text);
   DO \$\$ BEGIN UPDATE public.fleet_members SET status = NULL; INSERT INTO t598_out VALUES ('accepted');
   EXCEPTION WHEN not_null_violation THEN INSERT INTO t598_out VALUES ('rejected'); END \$\$;
   SELECT x FROM t598_out;" "rejected"

# B. the fleet owner cannot use it
tcase "B1 the owner inserts an invitation as approved: forced to pending_review, not linked" \
  "$(as $OWNER) INSERT INTO public.fleet_members (fleet_id, driver_name, driver_phone, status)
          VALUES ('$FA', 'Carlos', '+5355551234', 'approved'); $NOJWT $STATE" "pending_review:-"
tcase "B2 the owner approves their own invitation: reverted, not linked (the write itself went through)" \
  "$(invite $FA '+5355551234' 'pending_review')
   $(as $OWNER) UPDATE public.fleet_members SET status = 'approved', driver_name = 'Carlos' WHERE fleet_id = '$FA'; $NOJWT
   SELECT driver_name FROM public.fleet_members; $STATE" "Carlos;pending_review:-"
tcase "B3 the owner re-points an approved invitation at a driver's confirmed number, sending status along: not linked" \
  "$(invite $FA '+5355554321' 'pending_review') $(approve $FA '+5355554321')
   $(as $OWNER) UPDATE public.fleet_members SET driver_phone = '+5355551234', status = 'approved' WHERE fleet_id = '$FA'; $NOJWT
   SELECT status || ':' || coalesce(driver_id::text, '-') || '|' || driver_phone FROM public.fleet_members;" "approved:-|+5355551234"

# C. the account confirms its phone after the approval (Google/Apple sign-in, then link-phone)
tcase "C1 link-phone confirms the number in auth.users: that write links, before the app copies the number" \
  "$(invite $FA '+5355558888' 'pending_review') $(approve $FA '+5355558888') $(confirm $LATER 5355558888) $STATE" "active:LATER"
tcase "C2 the app then copies the number to users.phone under its own JWT: still linked, nothing breaks" \
  "$(invite $FA '+5355558888' 'pending_review') $(approve $FA '+5355558888') $(confirm $LATER 5355558888)
   $(as $LATER) UPDATE public.users SET phone = '5355558888' WHERE id = '$LATER'; $NOJWT
   SELECT phone FROM public.users WHERE id = '$LATER'; $STATE" "+5355558888;active:LATER"
tcase "C3 a number written into users.phone without an OTP links nothing (the write itself went through)" \
  "$(invite $FA '+5355558888' 'pending_review') $(approve $FA '+5355558888')
   $(as $LATER) UPDATE public.users SET phone = '+5355558888' WHERE id = '$LATER'; $NOJWT
   SELECT phone FROM public.users WHERE id = '$LATER'; $STATE" "+5355558888;approved:-"
tcase "C4 writing someone else's confirmed number into your own users.phone does not take their invitation" \
  "$(invite $FA '+5355554321' 'pending_review') $(approve $FA '+5355554321') $(repoint $FA '+5355554321' '+5355551234')
   $(as $LATER) UPDATE public.users SET phone = '+5355551234' WHERE id = '$LATER'; $NOJWT
   SELECT phone FROM public.users WHERE id = '$LATER'; $STATE" "+5355551234;approved:-"
tcase "C5 the owner re-points an approved invitation at DRV's number, DRV sets users.phone away and back: not linked" \
  "$(invite $FA '+5355554321' 'pending_review') $(approve $FA '+5355554321')
   $(as $OWNER) UPDATE public.fleet_members SET driver_phone = '+5355551234' WHERE fleet_id = '$FA'; $NOJWT
   $(as $DRV) UPDATE public.users SET phone = '+5355550000' WHERE id = '$DRV'; UPDATE public.users SET phone = '+5355551234' WHERE id = '$DRV'; $NOJWT
   SELECT driver_phone FROM public.fleet_members; $STATE" "+5355551234;approved:-"
tcase "C6 GoTrue's own phone signup: the account exists before its number is confirmed, and the confirmation links it" \
  "$(invite $FA '+5355557766' 'approved') $(signup_unconfirmed 5355557766) $STATE
   UPDATE auth.users SET phone_confirmed_at = now() WHERE id = '$NEWU'; $STATE" "approved:-;active:NEWU"
tcase "C7 confirming an already confirmed number again links nothing: only a newly confirmed number counts" \
  "$(invite $FA '+5355554321' 'pending_review') $(approve $FA '+5355554321') $(repoint $FA '+5355554321' '+5355551234')
   UPDATE auth.users SET phone_confirmed_at = now() WHERE id = '$DRV'; $STATE" "approved:-"
tcase "C8 a failure while linking never fails the confirmation (it runs inside GoTrue's transaction)" \
  "BEGIN; $(invite $FA '+5355558888' 'pending_review') $(approve $FA '+5355558888') $BREAK_LINKS $(confirm $LATER 5355558888)
   SELECT phone_confirmed_at IS NOT NULL FROM auth.users WHERE id = '$LATER'; $STATE ROLLBACK;" "t;approved:-"
tcase "C9 a deactivated account that confirms a new number is not linked" \
  "$(invite $FA '+5355554545' 'pending_review') $(approve $FA '+5355554545') $(confirm $INACT 5355554545) $STATE" "approved:-"

# X. signup
tcase "X1 invited by two fleets, then signs up with a confirmed number: both linked (00595)" \
  "$(invite $FA '+5355559999' 'approved') $(invite $FB '55559999' 'approved') $(signup 5355559999) $STATE" "active:NEWU,active:NEWU"
tcase "X2 an account created with a number it never confirms (GoTrue's own phone signup) links nothing" \
  "$(invite $FA '+5355559999' 'approved') $(signup_unconfirmed 5355559999)
   SELECT phone FROM public.users WHERE id = '$NEWU'; $STATE" "+5355559999;approved:-"
tcase "X3 a failure while linking never fails the signup (it runs inside GoTrue's transaction)" \
  "BEGIN; $(invite $FA '+5355559999' 'approved') $BREAK_LINKS $(signup 5355559999)
   SELECT count(*) FROM public.users WHERE id = '$NEWU'; $STATE ROLLBACK;" "1;approved:-"

# D. contract
for f in "_user_id_by_verified_phone(text)" "tg_fleet_members_set_driver_on_approval()" \
         "auto_link_fleet_member_on_phone_confirmed()" "auto_link_fleet_member_on_signup()"; do
  val "D1 $f: execute anon no, authenticated no, service_role yes" \
    "SELECT has_function_privilege('anon', 'public.$f', 'EXECUTE') || '|' || has_function_privilege('authenticated', 'public.$f', 'EXECUTE')
            || '|' || has_function_privilege('service_role', 'public.$f', 'EXECUTE')" "false|false|true"
done
val "D2 the linking functions are SECURITY DEFINER with a pinned search_path" \
  "SELECT string_agg(proname || ':' || prosecdef || ':' || array_to_string(proconfig, ','), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname IN ('_user_id_by_verified_phone', 'tg_fleet_members_set_driver_on_approval',
     'auto_link_fleet_member_on_phone_confirmed', 'auto_link_fleet_member_on_signup')" \
  "_user_id_by_verified_phone:true:search_path=public, pg_temp,auto_link_fleet_member_on_phone_confirmed:true:search_path=public, pg_temp,auto_link_fleet_member_on_signup:true:search_path=public, pg_temp,tg_fleet_members_set_driver_on_approval:true:search_path=public, pg_temp"
val "D3 on fleet_members the link trigger fires after the protect trigger (name order)" \
  "SELECT string_agg(tgname, ',' ORDER BY tgname COLLATE \"C\") FROM pg_trigger WHERE tgrelid = 'public.fleet_members'::regclass AND NOT tgisinternal" \
  "trg_fleet_members_protect,trg_fleet_members_set_driver_on_approval"
val "D4 the approval trigger: BEFORE INSERT OR UPDATE OF status, per row" \
  "SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.fleet_members'::regclass AND tgname = 'trg_fleet_members_set_driver_on_approval'" \
  "CREATE TRIGGER trg_fleet_members_set_driver_on_approval BEFORE INSERT OR UPDATE OF status ON public.fleet_members FOR EACH ROW EXECUTE FUNCTION tg_fleet_members_set_driver_on_approval()"
val "D5 the confirmation trigger on auth.users: AFTER UPDATE OF phone, phone_confirmed_at, only for a newly confirmed number" \
  "SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'auth.users'::regclass AND tgname = 'on_auth_user_phone_confirmed'" \
  "CREATE TRIGGER on_auth_user_phone_confirmed AFTER UPDATE OF phone, phone_confirmed_at ON auth.users FOR EACH ROW WHEN (((new.phone IS NOT NULL) AND (new.phone <> ''::text) AND (new.phone_confirmed_at IS NOT NULL) AND ((old.phone_confirmed_at IS NULL) OR (new.phone IS DISTINCT FROM old.phone)))) EXECUTE FUNCTION auto_link_fleet_member_on_phone_confirmed()"
val "D6 the signup trigger is still there, AFTER INSERT per row" \
  "SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.users'::regclass AND tgname = 'auto_link_fleet_member_on_signup'" \
  "CREATE TRIGGER auto_link_fleet_member_on_signup AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION auto_link_fleet_member_on_signup()"
val "D7 nothing on public.users links on a phone change: its only triggers are the signup one and the two BEFORE ones" \
  "SELECT string_agg(tgname, ',' ORDER BY tgname COLLATE \"C\") FROM pg_trigger WHERE tgrelid = 'public.users'::regclass AND NOT tgisinternal" \
  "auto_link_fleet_member_on_signup,tg_users_normalize_phone,trg_users_protect_admin_fields"
bodies "D8 unchanged:" "$UNTOUCHED"

# N. negative proofs: a copy of the migration with one defect must be aborted by its own assertions
# mutate OLD NEW -> path of a copy of the migration with OLD (present exactly once) replaced by NEW
mutate(){ local out; out="$(mktemp)"
  OLD="$1" NEW="$2" "$PY" - "$MIG" "$out" <<'PYEOF' || { rm -f "$out"; return 1; }
import os, sys
src = open(sys.argv[1], newline='').read()
old, new = os.environ['OLD'], os.environ['NEW']
assert src.count(old) == 1, f"expected the anchor once, found {src.count(old)}"
out = src.replace(old, new)
assert out != src
open(sys.argv[2], 'w', newline='').write(out)
PYEOF
  echo "$out"; }
# negative NAME OLD NEW ERROR -> the defective copy, applied to a fresh scaffold, must fail with ERROR
negative(){ local buggy out
  if ! buggy="$(mutate "$2" "$3")"; then ko "$1" "the anchor was not found; proof skipped"; return; fi
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}n" -c "CREATE DATABASE ${DB}n" >/dev/null 2>&1
  local N="$BIN/psql $CONN -d ${DB}n -qAt -v ON_ERROR_STOP=1"
  $N -f "$DIR/scaffold.sql" >/dev/null 2>&1 && $N -c "$PEOPLE" >/dev/null 2>&1
  if out=$($N -1 -c "SET search_path = ''" -f "$buggy" 2>&1); then
    ko "$1" "the migration applied with the defect in place"
  elif echo "$out" | grep -q "$4"; then
    ok "$1"
  else
    ko "$1" "wrong error: $(echo "$out" | tr -d '\r' | grep -m1 ERROR)"
  fi
  rm -f "$buggy"; }
if [ "$MIG" != "none" ]; then
  negative "N1 the approval stops linking: the self-test aborts the migration" \
    "  v_driver := public._user_id_by_verified_phone(NEW.driver_phone);" "  v_driver := NULL;" \
    "approving an invitation for a verified account left it"
  negative "N2 a signup with a confirmed number stops linking: the self-test aborts the migration" \
    "    WHERE public._normalize_cuban_phone(driver_phone) = public._normalize_cuban_phone(NEW.phone)" \
    "    WHERE public._normalize_cuban_phone(driver_name) = public._normalize_cuban_phone(NEW.phone)" \
    "signing up with a verified number left the invitation"
  negative "N3 a confirmed phone stops linking: the self-test aborts the migration" \
    "public._normalize_cuban_phone(fm.driver_phone)" "public._normalize_cuban_phone(fm.driver_name)" \
    "confirming the number left the approved invitation"
  negative "N4 the helper stays executable by clients: the ACL check aborts the migration" \
    "REVOKE EXECUTE ON FUNCTION public._user_id_by_verified_phone(text) FROM PUBLIC, anon, authenticated;" "" \
    "is executable by anon or authenticated"
fi

echo "== summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
````

## Appendix C — `supabase/migrations/00598_link_fleet_invitations_to_existing_accounts.sql`

````sql
-- ============================================================
-- 00598: link fleet invitations to people who already have an account
--
-- A fleet invitation (fleet_members) was linked to a driver only when that
-- person SIGNED UP: auto_link_fleet_member_on_signup() runs AFTER INSERT ON
-- public.users. When the admin approves an invitation for someone who already
-- has an account, nothing looks for that account. The row stays 'approved'
-- with driver_id NULL for good, the fleet's corporate rides never reach that
-- driver (find_best_drivers and accept_ride_v2 require status 'active' and a
-- driver_id), and the driver app shows the "create your own fleet" form. The
-- admin path meant for this, relink_fleet_member_for_existing_driver(), has no
-- caller (fleetService.relinkExistingDriver is unused). An account that
-- confirms its phone after the approval (Google/Apple sign-in, then
-- link-phone) is stuck the same way. Reproduced locally with the live bodies
-- and RLS on. fleet_members, driver_fleets and corporate_accounts had 0 rows
-- in prod on 2026-09-25, so nobody was hit.
--
-- Rule (owner decisions, 2026-09-25): an invitation is linked to the one
-- ACTIVE account whose number is confirmed by OTP in auth.users
-- (phone_confirmed_at), at each moment that can make that true: approval,
-- signup and confirmation. public.users.phone is not proof. Its owner can
-- write any number there through PostgREST without an OTP (column UPDATE
-- grant, users_update_own, and tg_users_protect_admin_fields does not cover
-- it), and it is not unique. auth.users.phone is unique (users_phone_key),
-- GoTrue keeps it as E.164 digits without '+', and users cannot write it.
-- phone_autoconfirm is false in prod (/auth/v1/settings, 2026-09-25), and
-- verify-otp and link-phone confirm a number with the admin API only after
-- checking the D7 code. On 2026-09-25, 544 of the 546 phones in public.users
-- equal (normalized) their confirmed auth phone; the other 2 belong to seeded
-- admins with no auth phone. The one number two accounts share (an admin,
-- unconfirmed, and a driver, confirmed) resolves to the driver. No driver
-- profile is required, same as signup: a passenger-only account is linked
-- and is already in the fleet when it registers as a driver.
--
-- Fix:
--   1. _user_id_by_verified_phone(text) returns that account's id, or NULL
--      (never a guess between two). It reads auth.users, so it is SECURITY
--      DEFINER; it maps a number to an account, so clients cannot execute it.
--   2. Approval: trg_fleet_members_set_driver_on_approval, BEFORE INSERT OR
--      UPDATE OF status ON fleet_members, links the row on NEW when the write
--      makes it linkable (inserted as, or moved into, approved or
--      pending_signup, with no driver_id). A row that already was linkable is
--      not looked at again, so a later edit of an approved invitation (the
--      owner can still change driver_phone after the review) links nobody
--      here. It fires after trg_fleet_members_protect (same event and timing
--      fire in name order) and so sees the row after an owner's change of
--      status was reverted. That is defence in depth: the protect trigger
--      reverts every field this one sets, whichever runs first.
--   3. Signup: auto_link_fleet_member_on_signup now links only when the new
--      account's number is confirmed. handle_new_user copies auth.users.phone
--      whether or not it is, and GoTrue's own phone signup (the provider is
--      on) inserts the account before its OTP. verify-otp creates accounts
--      already confirmed, so the real flow is unchanged.
--   4. Confirmation: on_auth_user_phone_confirmed, AFTER UPDATE OF phone,
--      phone_confirmed_at ON auth.users, links an account's approved
--      invitations when a number becomes confirmed for it (link-phone,
--      verify-otp's heal, GoTrue's own OTP). Confirming an already confirmed
--      number again does not count. Users cannot write auth.users, so unlike
--      a trigger on public.users this one cannot be fired by setting a number
--      without an OTP.
--   5. The signup and confirmation functions run inside GoTrue's transaction.
--      A failure to link is logged as a WARNING and never fails the signup or
--      the confirmation.
--   6. A one-time backfill for invitations already approved whose number a
--      verified account holds (0 rows in prod).
-- The relink RPC and the protect trigger are untouched.
-- The migration asserts its result instead of trusting CREATE (a plpgsql
-- body is only checked when it runs): a rolled-back self-test against a real
-- verified account (approval, signup and confirmation each link it), and the
-- ACL of the four functions. The trigger on auth.users is created last, so
-- the lock it takes on that table is held for the shortest time.
-- Rehearsal: supabase/tests/00598/run.sh and supabase/tests/00598/mutants.py.
-- ============================================================

SET lock_timeout = '5s';

-- 1. The account that confirmed a number ---------------------------------------
CREATE OR REPLACE FUNCTION public._user_id_by_verified_phone(p_phone text)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_norm text := public._normalize_cuban_phone(p_phone);
  v_id   uuid;
BEGIN
  IF v_norm IS NULL OR v_norm !~ '^\+[0-9]{8,15}$' THEN
    RETURN NULL;
  END IF;

  -- GoTrue stores E.164 without '+'; both spellings use users_phone_key.
  -- Anything but exactly one match returns NULL: never guess.
  SELECT CASE WHEN count(*) = 1 THEN (array_agg(u.id))[1] END
    INTO v_id
  FROM auth.users au
  JOIN public.users u ON u.id = au.id
  WHERE au.phone IN (v_norm, substr(v_norm, 2))
    AND au.phone_confirmed_at IS NOT NULL
    AND u.is_active;

  RETURN v_id;
END;
$function$;

COMMENT ON FUNCTION public._user_id_by_verified_phone(text) IS
  'The one active account whose number is confirmed by OTP in auth.users (phone_confirmed_at), or NULL. public.users.phone is not proof: its owner can write it without an OTP. Maps a number to an account, so clients cannot execute it.';

REVOKE EXECUTE ON FUNCTION public._user_id_by_verified_phone(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._user_id_by_verified_phone(text) TO service_role;

-- 2. Link when the invitation is approved --------------------------------------
CREATE OR REPLACE FUNCTION public.tg_fleet_members_set_driver_on_approval()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_driver uuid;
BEGIN
  IF NEW.driver_id IS NOT NULL OR NEW.status IS NULL
     OR NEW.status NOT IN ('approved', 'pending_signup') THEN
    RETURN NEW;
  END IF;
  -- Only when this write makes the invitation linkable. A row that already
  -- was is left alone: a later edit of an approved invitation links nobody.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('approved', 'pending_signup') THEN
      RETURN NEW;
    END IF;
  END IF;

  v_driver := public._user_id_by_verified_phone(NEW.driver_phone);
  IF v_driver IS NOT NULL THEN
    NEW.driver_id    := v_driver;
    NEW.status       := 'active';
    NEW.signed_up_at := COALESCE(NEW.signed_up_at, now());
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.tg_fleet_members_set_driver_on_approval() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_fleet_members_set_driver_on_approval() TO service_role;

-- Fires after trg_fleet_members_protect: 'set_…' sorts after 'protect'.
CREATE OR REPLACE TRIGGER trg_fleet_members_set_driver_on_approval
  BEFORE INSERT OR UPDATE OF status ON public.fleet_members
  FOR EACH ROW EXECUTE FUNCTION public.tg_fleet_members_set_driver_on_approval();

-- 3. Link at signup, only a confirmed number ------------------------------------
-- Same trigger on public.users (AFTER INSERT) and same ACL as 00595; the body
-- adds the confirmed-number check and never lets a failure reach the signup.
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

  -- Runs inside GoTrue's signup transaction: failing to link must never fail
  -- the signup.
  BEGIN
    -- Only a number this account confirmed by OTP. GoTrue's own phone signup
    -- inserts the account before its OTP; on_auth_user_phone_confirmed links
    -- it once the number is confirmed.
    IF public._user_id_by_verified_phone(NEW.phone) IS DISTINCT FROM NEW.id THEN
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
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'auto_link_fleet_member_on_signup(%): % %', NEW.id, SQLSTATE, SQLERRM;
  END;

  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.auto_link_fleet_member_on_signup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_link_fleet_member_on_signup() TO service_role;

-- 4. Link when an account confirms a number later ------------------------------
CREATE OR REPLACE FUNCTION public.auto_link_fleet_member_on_phone_confirmed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Runs inside GoTrue's transaction (link-phone, verify-otp, GoTrue's own
  -- OTP): failing to link must never fail the confirmation. GoTrue's
  -- connection carries no JWT, so tg_fleet_members_protect lets this through.
  BEGIN
    IF public._user_id_by_verified_phone(NEW.phone) IS DISTINCT FROM NEW.id THEN
      RETURN NEW;
    END IF;

    UPDATE public.fleet_members fm
    SET driver_id = NEW.id,
        status = 'active',
        signed_up_at = COALESCE(fm.signed_up_at, now())
    WHERE public._normalize_cuban_phone(fm.driver_phone) = public._normalize_cuban_phone(NEW.phone)
      AND fm.status IN ('approved', 'pending_signup')
      AND fm.driver_id IS NULL;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'auto_link_fleet_member_on_phone_confirmed(%): % %', NEW.id, SQLSTATE, SQLERRM;
  END;

  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.auto_link_fleet_member_on_phone_confirmed() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_link_fleet_member_on_phone_confirmed() TO service_role;

-- 5. Invitations approved before this migration (0 rows in prod) ----------------
-- A migration runs with no JWT, so tg_fleet_members_protect lets it through.
UPDATE public.fleet_members fm
SET driver_id = m.user_id,
    status = 'active',
    signed_up_at = COALESCE(fm.signed_up_at, now())
FROM (
  SELECT id, public._user_id_by_verified_phone(driver_phone) AS user_id
  FROM public.fleet_members
  WHERE status IN ('approved', 'pending_signup')
    AND driver_id IS NULL
) m
WHERE fm.id = m.id
  AND m.user_id IS NOT NULL;

-- 6. Assert the result ------------------------------------------------------------
-- Against a real account with a confirmed number: an invitation approved for it
-- is linked by the approval; two approved invitations the approval could not
-- link (they carried no phone yet) are linked by a signup and by a
-- confirmation of that number. The signup and confirmation functions are
-- fired from scratch tables, so no account row is written, and everything the
-- block does is rolled back. A database with no verified account has nobody
-- to link, so the behaviour check is skipped there. The ACL check always runs.
DO $$
DECLARE
  v_user        uuid;
  v_phone       text;   -- the confirmed number as GoTrue keeps it: 53 + 8 digits
  v_corp        uuid := gen_random_uuid();
  v_fleet       uuid := gen_random_uuid();
  v_approval    uuid := gen_random_uuid();
  v_signup      uuid := gen_random_uuid();
  v_confirm     uuid := gen_random_uuid();
  v_on_approval text;
  v_on_signup   text;
  v_on_confirm  text;
BEGIN
  SELECT u.id, au.phone INTO v_user, v_phone
  FROM auth.users au
  JOIN public.users u ON u.id = au.id
  WHERE au.phone ~ '^53[56][0-9]{7}$'
    AND au.phone_confirmed_at IS NOT NULL
    AND u.is_active
  ORDER BY u.created_at, u.id
  LIMIT 1;

  IF v_user IS NULL THEN
    RAISE NOTICE '00598: no account with a confirmed phone yet, behaviour self-test skipped';
  ELSE
    BEGIN
      INSERT INTO public.corporate_accounts (id, name, contact_phone, created_by)
      VALUES (v_corp, '00598 self-test', '+' || v_phone, v_user);
      INSERT INTO public.driver_fleets (id, corporate_account_id, name)
      VALUES (v_fleet, v_corp, '00598 self-test');

      -- Approval of an invitation carrying the number as 8 local digits.
      INSERT INTO public.fleet_members (id, fleet_id, driver_name, driver_phone, status)
      VALUES (v_approval, v_fleet, '00598 self-test', substr(v_phone, 3), 'pending_review');
      UPDATE public.fleet_members SET status = 'approved' WHERE id = v_approval;
      SELECT status || ':' || coalesce((driver_id = v_user)::text, 'unlinked') INTO v_on_approval
      FROM public.fleet_members WHERE id = v_approval;

      -- Two approved invitations with no phone yet, so the approval links neither.
      INSERT INTO public.fleet_members (id, fleet_id, driver_name, driver_phone, status)
      VALUES (v_signup, v_fleet, '00598 self-test', '00598 self-test signup', 'approved'),
             (v_confirm, v_fleet, '00598 self-test', '00598 self-test confirmation', 'approved');

      -- Signup: point the first one at the number, then fire the signup function.
      UPDATE public.fleet_members SET driver_phone = v_phone WHERE id = v_signup;
      CREATE TEMP TABLE t00598_signup (id uuid, phone text);
      CREATE TRIGGER t00598_signup AFTER INSERT ON pg_temp.t00598_signup
        FOR EACH ROW EXECUTE FUNCTION public.auto_link_fleet_member_on_signup();
      INSERT INTO pg_temp.t00598_signup (id, phone) VALUES (v_user, '+' || v_phone);
      SELECT status || ':' || coalesce((driver_id = v_user)::text, 'unlinked') INTO v_on_signup
      FROM public.fleet_members WHERE id = v_signup;

      -- Confirmation: point the second one at the number, then fire the
      -- confirmation function as an update of the account's phone.
      UPDATE public.fleet_members SET driver_phone = '+' || v_phone WHERE id = v_confirm;
      CREATE TEMP TABLE t00598_auth (id uuid, phone text);
      CREATE TRIGGER t00598_auth AFTER UPDATE ON pg_temp.t00598_auth
        FOR EACH ROW EXECUTE FUNCTION public.auto_link_fleet_member_on_phone_confirmed();
      INSERT INTO pg_temp.t00598_auth (id, phone) VALUES (v_user, NULL);
      UPDATE pg_temp.t00598_auth SET phone = v_phone;
      SELECT status || ':' || coalesce((driver_id = v_user)::text, 'unlinked') INTO v_on_confirm
      FROM public.fleet_members WHERE id = v_confirm;

      RAISE EXCEPTION '00598 self-test rollback';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> '00598 self-test rollback' THEN
        RAISE;
      END IF;
    END;

    IF v_on_approval IS DISTINCT FROM 'active:true' THEN
      RAISE EXCEPTION '00598: approving an invitation for a verified account left it %', coalesce(v_on_approval, 'missing');
    END IF;
    IF v_on_signup IS DISTINCT FROM 'active:true' THEN
      RAISE EXCEPTION '00598: signing up with a verified number left the invitation %', coalesce(v_on_signup, 'missing');
    END IF;
    IF v_on_confirm IS DISTINCT FROM 'active:true' THEN
      RAISE EXCEPTION '00598: confirming the number left the approved invitation %', coalesce(v_on_confirm, 'missing');
    END IF;
    RAISE NOTICE '00598: verified, approval, signup and confirmation each link the confirmed account';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY['public._user_id_by_verified_phone(text)',
                      'public.tg_fleet_members_set_driver_on_approval()',
                      'public.auto_link_fleet_member_on_signup()',
                      'public.auto_link_fleet_member_on_phone_confirmed()']) AS f(sig),
         unnest(ARRAY['anon', 'authenticated']) AS r(role_name)
    WHERE has_function_privilege(r.role_name, f.sig::regprocedure, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION '00598: a fleet-linking function is executable by anon or authenticated';
  END IF;
END $$;

-- 7. The confirmation trigger, last: CREATE TRIGGER blocks writes to auth.users
-- until this migration commits, so the window stays as short as possible.
CREATE OR REPLACE TRIGGER on_auth_user_phone_confirmed
  AFTER UPDATE OF phone, phone_confirmed_at ON auth.users
  FOR EACH ROW
  WHEN (NEW.phone IS NOT NULL AND NEW.phone <> '' AND NEW.phone_confirmed_at IS NOT NULL
        AND (OLD.phone_confirmed_at IS NULL OR NEW.phone IS DISTINCT FROM OLD.phone))
  EXECUTE FUNCTION public.auto_link_fleet_member_on_phone_confirmed();
````

## Appendix D — `supabase/tests/00598/mutants.py`

````python
#!/usr/bin/env python3
"""Mutation check for migration 00598: remove one guard at a time; the test that owns it must fail.

  supabase/tests/00598/mutants.py supabase/migrations/00598_link_fleet_invitations_to_existing_accounts.sql

Runs run.sh once per mutant with the same environment (PGBIN, PGPORT, PYTHON), about a minute each.
Every mutant here still applies: its migration self-test does not cover that guard. The guards the
self-test does cover are proven by run.sh's own negative proofs (N1-N4).
"""
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
RUN = os.path.join(HERE, "run.sh").replace("\\", "/")

# (guard, text in the migration (exactly once), replacement, tests that must fail)
MUTANTS = [
    ("the approval re-evaluates rows that were already approved",
     "  IF TG_OP = 'UPDATE' THEN\n    IF OLD.status IN ('approved', 'pending_signup') THEN\n"
     "      RETURN NEW;\n    END IF;\n  END IF;\n",
     "", ["B3"]),
    ("an unconfirmed number counts as verified",
     "    AND au.phone_confirmed_at IS NOT NULL\n    AND u.is_active;\n", "    AND u.is_active;\n",
     ["A11", "X2", "C6"]),
    ("a deactivated account counts as verified",
     "    AND u.is_active;\n", ";\n", ["A10", "C9"]),
    ("the helper guesses between two accounts",
     "CASE WHEN count(*) = 1 THEN", "CASE WHEN count(*) >= 1 THEN", ["A14"]),
    ("a NULL status slips through the approval gate",
     "  IF NEW.driver_id IS NOT NULL OR NEW.status IS NULL\n     OR NEW.status NOT IN",
     "  IF NEW.driver_id IS NOT NULL\n     OR NEW.status NOT IN", ["A16"]),
    ("the approval trigger ignores INSERTs",
     "  BEFORE INSERT OR UPDATE OF status ON public.fleet_members",
     "  BEFORE UPDATE OF status ON public.fleet_members", ["A5", "A13"]),
    ("the signup links a number the account never confirmed",
     "    IF public._user_id_by_verified_phone(NEW.phone) IS DISTINCT FROM NEW.id THEN\n"
     "      RETURN NEW;\n    END IF;\n\n    PERFORM set_config",
     "    PERFORM set_config", ["X2", "C6"]),
    ("a failure to link fails the signup",
     "  EXCEPTION WHEN OTHERS THEN\n"
     "    RAISE WARNING 'auto_link_fleet_member_on_signup(%): % %', NEW.id, SQLSTATE, SQLERRM;\n",
     "", ["X3"]),
    ("confirming an already confirmed number fires again",
     "        AND (OLD.phone_confirmed_at IS NULL OR NEW.phone IS DISTINCT FROM OLD.phone))",
     "        AND (OLD.phone_confirmed_at IS DISTINCT FROM NEW.phone_confirmed_at OR NEW.phone IS DISTINCT FROM OLD.phone))",
     ["C7"]),
    ("a failure to link fails the confirmation",
     "  EXCEPTION WHEN OTHERS THEN\n"
     "    RAISE WARNING 'auto_link_fleet_member_on_phone_confirmed(%): % %', NEW.id, SQLSTATE, SQLERRM;\n",
     "", ["C8"]),
    ("the confirmation links whichever account holds the number",
     "    IF public._user_id_by_verified_phone(NEW.phone) IS DISTINCT FROM NEW.id THEN\n"
     "      RETURN NEW;\n    END IF;\n\n    UPDATE public.fleet_members fm",
     "    UPDATE public.fleet_members fm", ["C9"]),
]


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    src = open(sys.argv[1], encoding="utf-8", newline="").read()
    all_caught = True
    for guard, old, new, expected in MUTANTS:
        found = src.count(old)
        if found != 1:
            print(f"BROKEN    {guard}: the anchor appears {found} times", flush=True)
            all_caught = False
            continue
        fd, path = tempfile.mkstemp(suffix=".sql")
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(src.replace(old, new))
        try:
            out = subprocess.run(["bash", RUN, path], capture_output=True, text=True).stdout
        finally:
            os.remove(path)
        failing = sorted(set(re.findall(r"^FAIL  (\S+)", out, re.M)))
        applied = "migration failed" not in out
        caught = applied and all(test in failing for test in expected)
        all_caught &= caught
        verdict = "CAUGHT" if caught else ("ABORTED" if not applied else "MISSED")
        print(f"{verdict:8}  {guard}: expected {expected}, failing {failing}", flush=True)
    print("ALL MUTANTS CAUGHT" if all_caught else "SOME MUTANT SURVIVED")
    return 0 if all_caught else 1


if __name__ == "__main__":
    sys.exit(main())
````
