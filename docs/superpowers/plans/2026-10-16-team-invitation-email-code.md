# Accepting a team invitation with an e-mail code — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an invited person accept an admin panel invitation with a 6-digit code sent to the invited address, creating their account (or setting a password on the existing one), next to the existing Google option.

**Architecture:** One migration (00664) adds two lock tables and three SECURITY DEFINER functions that only `service_role` executes: issue a code, check it, accept the invitation for an account. A new Edge Function `team-invitation-code` (`verify_jwt = false`) wraps them with per-IP limits, sends the code through `send-email`, and creates or updates the GoTrue account. The invitation page gets a form that calls the function through `teamService` and then signs in with the chosen password. `verify-otp` stops overwriting a password the person chose (marked in `users.password_set_at`), so a team member with a phone keeps it after a phone login.

**Tech Stack:** Postgres 16 (plpgsql, pgcrypto in schema `extensions`), Supabase Edge Functions (Deno, supabase-js 2.108.2 from esm.sh), vitest, Next.js 15 admin app with `@supabase/ssr`, i18next.

**Spec:** `docs/superpowers/specs/2026-10-16-team-invitation-email-code-design.md`. Branch: `claude/team-invitation-email-code`.

---

## Before starting

- The worktree has an **uncommitted** edit to `CLAUDE.md` (three release notes from the 1.8.0 release, owner-approved content, not yet committed by the owner's choice). Do not mix it into these commits: every `git add` below names its files. Task 8 edits a different section of `CLAUDE.md`; before Task 8, ask the owner whether to commit the release notes first as their own commit (recommended) or to leave them out of this branch.
- Migration number: **00664** was free on 2026-10-16 (master up to 00661; open PRs hold 00662 and 00663). Re-check right before writing the file and again before applying (CLAUDE.md § "Pre-flight para elegir número de migración"):
  ```bash
  git fetch origin master
  git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -5
  for pr in $(gh pr list --state open --json number --jq '.[].number'); do gh pr view $pr --json files --jq '.files[].path' | grep supabase/migrations; done
  ```
  If 00664 is taken, use the next free number everywhere this plan says 00664 (file names, the `00664:` prefix of the self-check messages, the test directory).
- Local Postgres for the SQL rehearsal: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (sandbox) or "En Windows, sin sandbox" (portable EDB binaries). The runner takes `PGBIN`, `PGPORT` and `PYTHON` from the environment. It needs the `pgcrypto` extension (shipped with both).

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/00664_team_invitation_email_code.sql` (create) | Tables, helpers, the three functions, permissions, self-checks |
| `supabase/tests/00664/scaffold.sql`, `seed.sql`, `run.sh` (create) | Rehearsal on top of `supabase/tests/00661` |
| `supabase/functions/_shared/email-templates/team_invitation_code.ts` + `.test.ts` (create) | The code e-mail |
| `supabase/functions/_shared/email-templates/team_invitation.ts` + `.test.ts` (modify) | The invitation e-mail mentions the code |
| `supabase/functions/_shared/email-templates/index.ts` (modify) | Registers `team_invitation_code` |
| `supabase/functions/team-invitation-code/index.ts` + `index.test.ts` (create) | The Edge Function |
| `supabase/config.toml` (modify) | `verify_jwt = false` for the new function |
| `packages/api/vitest.config.ts` (modify) | Runs the new function's tests |
| `packages/utils/src/teamInvitation.ts` + `__tests__/teamInvitation.test.ts` (modify) | Parses the function's answers, Spanish messages |
| `packages/api/src/services/team.service.ts`, `src/index.ts`, `src/services/__tests__/team.test.ts` (modify) | `requestInvitationCode`, `acceptInvitationWithCode` |
| `apps/admin/src/app/invitacion/[token]/InvitationCodeForm.tsx` (create), `page.tsx` (modify) | The form |
| `packages/i18n/src/locales/{es,en,pt}/admin.json` (modify) | Page text |
| `docs/superpowers/specs/2026-10-16-team-invitation-email-code-design.md` (modify) | Clarifications found while planning (Task 1) and in review (before Task 4a) |
| `supabase/functions/verify-otp/index.ts` + `index.test.ts` (modify, Task 4b) | Phone logins keep a chosen password |
| `apps/admin/src/app/reset-password/page.tsx` (modify, Task 4b) | Marks the password after a reset |
| `CLAUDE.md` (modify, Task 8) | Documents the feature |

---

### Task 1: Spec clarifications

Two details the spec left contradictory, settled here so later tasks agree with it.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-16-team-invitation-email-code-design.md`

- [ ] **Step 1: Let `send` pass on the name the inviter typed**

The spec says the form is "prefilled from the invitation when it has one" and also that `send` passes on "only `account_exists`". `get_team_invitation` does not return the name, so the prefill needs `send` to pass it. Replace:

```
The Edge Function passes on only `account_exists`, so the form knows whether to ask for the name; it never returns the code or the address. Whoever holds the link learns whether the invited address has a TriciGo account, and nothing more.
```

with:

```
The Edge Function passes on `account_exists` (so the form knows whether to ask for the name) and `invitee_name`, the name the super_admin typed in the invitation (to prefill the field); it never returns the code or the address. Whoever holds the link learns whether the invited address has a TriciGo account and the name the inviter typed, and nothing more.
```

and in `team_invitation_code_issue(p_token text)` change "returns to the Edge Function the code, the full address and whether an account already has that address" to "returns to the Edge Function the code, the full address, the invitation's name and whether an account already has that address".

- [ ] **Step 2: Never fail on a missing name after the code is used**

In the Edge Function section, replace "the name (required for a new account, at most 80 characters, ignored for an existing one);" with:

```
the name (at most 80 characters; the form requires it for a new account, and the server uses the invitation's name when it is empty, because the code is already used at that point; ignored for an existing account);
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-10-16-team-invitation-email-code-design.md
git commit -m "docs(spec): settle the invitee name in the e-mail code design

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: SQL rehearsal (RED)

> **Superseded after Task 4a (2026-10-16).** The code below is what was first committed. The review fixes changed it (grants, account cases, the two marks, new tests). The committed files under `supabase/migrations/00664_*` and `supabase/tests/00664/` are the source of truth; do not copy from this section.

**Files:**
- Create: `supabase/tests/00664/scaffold.sql`
- Create: `supabase/tests/00664/seed.sql`
- Create: `supabase/tests/00664/run.sh`

The rehearsal builds on `supabase/tests/00661`: its scaffold and seed, then 00661 itself (as prod has it), then this task's extras.

- [ ] **Step 1: Write `supabase/tests/00664/scaffold.sql`**

```sql
-- Extra scaffold for the 00664 rehearsal, run after supabase/tests/00661/scaffold.sql.
-- What 00664 reads that the 00661 scaffold leaves out: the sign-in address and the ban of
-- auth.users, GoTrue's sessions and refresh tokens, pgcrypto in schema extensions, and
-- rate_limits with the LIVE body of check_rate_limit (prod 2026-10-16, md5 5a2e6163.../527).
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;

SET ROLE postgres;
ALTER TABLE auth.users
  ADD COLUMN email text,
  ADD COLUMN encrypted_password text,
  ADD COLUMN banned_until timestamptz,
  ADD COLUMN raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE auth.sessions (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL
);
CREATE TABLE auth.refresh_tokens (
  id         bigserial PRIMARY KEY,
  user_id    character varying(255),
  session_id uuid REFERENCES auth.sessions (id) ON DELETE CASCADE
);

CREATE TABLE public.rate_limits (
  key          text NOT NULL,
  window_start timestamptz NOT NULL DEFAULT now(),
  count        integer NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rate_limits FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.check_rate_limit(p_key text, p_max_requests integer, p_window_seconds integer)
 RETURNS TABLE(allowed boolean, current_count integer, reset_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_count INTEGER;
BEGIN
  v_window_start := to_timestamp(
    floor(EXTRACT(EPOCH FROM NOW()) / p_window_seconds) * p_window_seconds
  );

  INSERT INTO rate_limits (key, window_start, count)
  VALUES (p_key, v_window_start, 1)
  ON CONFLICT (key, window_start)
  DO UPDATE SET count = rate_limits.count + 1
  RETURNING rate_limits.count INTO v_count;

  RETURN QUERY SELECT
    v_count <= p_max_requests,
    v_count,
    v_window_start + (p_window_seconds * INTERVAL '1 second');
END;
$function$
;
REVOKE ALL ON FUNCTION public.check_rate_limit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) TO service_role;
RESET ROLE;
```

- [ ] **Step 2: Write `supabase/tests/00664/seed.sql`**

```sql
-- Seed for the 00664 rehearsal, run after supabase/tests/00661/seed.sql. The sign-in address of
-- every seeded account (auth.users.email) and the people the account cases need:
--   SAM ANA MIA CARL DIEGO DORA: proven (a verified Google identity with the same address).
--     CARL also has a confirmed phone, which a proven account keeps.
--   PETE password only (identity 'email'), no phone                  -> password_only
--   PHIL password only plus a confirmed phone and a phone identity   -> needs_google
--   EVE  a Google identity with the address that is not verified     -> needs_google
--   BOB  public.users.is_active false                                -> blocked
--   BEN  banned in GoTrue (banned_until in the future)               -> blocked
--   nina@bacoagency.com has no account                               -> new (tests create NINA)
SET ROLE postgres;
UPDATE auth.users au SET email = v.email, created_at = '2026-01-01'
FROM (VALUES
  ('a1000000-0000-4000-8000-000000000001'::uuid, 'sam@example.com'),
  ('a1000000-0000-4000-8000-000000000002'::uuid, 'ana@example.com'),
  ('a1000000-0000-4000-8000-000000000003'::uuid, 'mia@example.com'),
  ('a1000000-0000-4000-8000-000000000004'::uuid, 'carl@gmail.com'),
  ('a1000000-0000-4000-8000-000000000005'::uuid, 'diego@gmail.com'),
  ('a1000000-0000-4000-8000-000000000006'::uuid, 'pete@example.com'),
  ('a1000000-0000-4000-8000-000000000007'::uuid, 'bob@gmail.com'),
  ('a1000000-0000-4000-8000-000000000008'::uuid, 'eve@gmail.com'),
  ('a1000000-0000-4000-8000-000000000009'::uuid, 'dora@gmail.com'),
  ('a1000000-0000-4000-8000-00000000000a'::uuid, 'old@example.com'),
  ('00000000-0000-0000-0000-000000000001'::uuid, 'platform@tricigo.system')) v (id, email)
WHERE au.id = v.id;
UPDATE auth.users SET phone = '5355550104', phone_confirmed_at = '2026-02-01'
WHERE id = 'a1000000-0000-4000-8000-000000000004';

INSERT INTO public.users (id, email, full_name, role) VALUES
  ('a1000000-0000-4000-8000-00000000000b', 'phil@example.com', 'Phil Phone',  'customer'),
  ('a1000000-0000-4000-8000-00000000000c', 'ben@gmail.com',    'Ben Banned',  'customer');
INSERT INTO auth.users (id, email, phone, phone_confirmed_at, banned_until, created_at) VALUES
  ('a1000000-0000-4000-8000-00000000000b', 'phil@example.com', '5355550111', '2026-02-01', NULL, '2026-01-01'),
  ('a1000000-0000-4000-8000-00000000000c', 'ben@gmail.com', NULL, NULL, now() + interval '100 years', '2026-01-01');
INSERT INTO auth.identities (user_id, provider, identity_data) VALUES
  ('a1000000-0000-4000-8000-00000000000b', 'email',  '{"email": "phil@example.com", "email_verified": true}'),
  ('a1000000-0000-4000-8000-00000000000b', 'phone',  '{"phone": "5355550111"}'),
  ('a1000000-0000-4000-8000-00000000000c', 'google', '{"email": "ben@gmail.com", "email_verified": true}');
RESET ROLE;
```

- [ ] **Step 3: Write `supabase/tests/00664/run.sh`**

```bash
#!/usr/bin/env bash
# Rehearsal runner for migration 00664 (accepting a team invitation with an e-mail code; local Postgres 16).
#   supabase/tests/00664/run.sh none
#       -> 00661 scaffold + seed + migration, the 00664 extras, tests without 00664 (RED)
#   supabase/tests/00664/run.sh supabase/migrations/00664_team_invitation_email_code.sql
#       -> the same + 00664 x2 (idempotency) + tests + negative proofs of the self-checks (GREEN)
# Builds on supabase/tests/00661 (scaffold, seed) and applies 00661 itself first, as prod has it.
# Every migration is applied as postgres, the scaffold's non-superuser owner (as in prod).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod".
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00664/run.sh ...
set -u
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
BASE="$ROOT/supabase/tests/00661"
M661="$ROOT/supabase/migrations/00661_team_invitations.sql"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB="${RUN_DB:-pr664}"
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# val NAME SQL EXPECTED -> the printed rows, joined with ';', must equal EXPECTED (\r dropped for Windows)
val(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\r' | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$BASE/scaffold.sql" >/dev/null 2>&1 && \
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 && \
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$BASE/seed.sql" >/dev/null 2>&1 && \
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/seed.sql" >/dev/null 2>&1 && \
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$M661" >/dev/null 2>&1; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

SAM=a1000000-0000-4000-8000-000000000001
ANA=a1000000-0000-4000-8000-000000000002
MIA=a1000000-0000-4000-8000-000000000003
CARL=a1000000-0000-4000-8000-000000000004
PETE=a1000000-0000-4000-8000-000000000006
BOB=a1000000-0000-4000-8000-000000000007
EVE=a1000000-0000-4000-8000-000000000008
PHIL=a1000000-0000-4000-8000-00000000000b
BEN=a1000000-0000-4000-8000-00000000000c
NINA=a1000000-0000-4000-8000-00000000000d

# svc SQL -> SQL as the Edge Function (role service_role) in a transaction that is rolled back.
# su / sr switch to the test superuser and back to service_role inside an svc block.
svc(){ printf "BEGIN; SET LOCAL client_min_messages = error; SET LOCAL ROLE service_role; %s ROLLBACK;" "$1"; }
su(){ printf "RESET ROLE;"; }
sr(){ printf "SET LOCAL ROLE service_role;"; }
# inv EMAIL ROLE C -> a pending invitation (token: 64 times the hex character C), invited by SAM
inv(){ printf "INSERT INTO public.team_invitations (email, role, token, invited_by, expires_at) VALUES ('%s', '%s', repeat('%s', 64), '$SAM', now() + interval '1 day');" "$1" "$2" "$3"; }
# issue C -> prints the result of team_invitation_code_issue and keeps the code in test.code
issue(){ printf "SELECT r->>'result' FROM (SELECT public.team_invitation_code_issue(repeat('%s', 64)) r) x WHERE set_config('test.code', coalesce(r->>'code', ''), true) IS NOT NULL;" "$1"; }
# chk C CODE_SQL -> 'result|attempts_left' of team_invitation_code_check
chk(){ printf "SELECT (r->>'result') || '|' || coalesce(r->>'attempts_left', '') FROM (SELECT public.team_invitation_code_check(repeat('%s', 64), %s) r) x;" "$1" "$2"; }
# okc C USER -> 'result|case|user_id is USER' of a check with the right code
okc(){ printf "SELECT (r->>'result') || '|' || coalesce(r->>'case', '') || '|' || coalesce(((r->>'user_id') = '%s')::text, '') FROM (SELECT public.team_invitation_code_check(repeat('%s', 64), current_setting('test.code')) r) x;" "$2" "$1"; }
# acc C USER -> 'result|role' of accept_team_invitation_by_code
acc(){ printf "SELECT (r->>'result') || '|' || coalesce(r->>'role', '') FROM (SELECT public.accept_team_invitation_by_code(repeat('%s', 64), '%s') r) x;" "$1" "$2"; }
out(){ printf "SELECT t.outcome('%s');" "$1"; }
RIGHT="current_setting('test.code')"
WRONG="CASE WHEN current_setting('test.code') = '000000' THEN '111111' ELSE '000000' END"
FNS="'_team_code_hash', '_team_code_account', 'team_invitation_code_issue', 'team_invitation_code_check', 'accept_team_invitation_by_code'"
BODIES="SELECT string_agg(proname || ':' || md5(prosrc), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ($FNS)"

echo "== reset database =="
fresh $DB || { echo "scaffold, seed or 00661 failed"; exit 1; }
val "S0 the scaffold carries the live check_rate_limit body" \
  "SELECT md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE oid = 'public.check_rate_limit(text, integer, integer)'::regprocedure" \
  "5a2e61635bf60849be2e5ca41cbd9889/527"
val "S1 00661 is applied, as in prod" "SELECT to_regprocedure('public.accept_team_invitation(text)') IS NOT NULL" "t"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as postgres, search_path = '') =="; $P -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as postgres, search_path = '') =="; $P -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

echo "== objects =="
val "O1 both tables have RLS and only service_role can read them" \
  "SELECT string_agg(c.relname || ':' || c.relrowsecurity || ':' || has_table_privilege('anon', c.oid, 'SELECT') || has_table_privilege('authenticated', c.oid, 'SELECT') || has_table_privilege('service_role', c.oid, 'SELECT'), ',' ORDER BY c.relname COLLATE \"C\") FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('team_invitation_codes', 'team_invitation_code_salt')" \
  "team_invitation_code_salt:true:falsefalsetrue,team_invitation_codes:true:falsefalsetrue"
val "O2 no client executes the new functions; the service role does; all SECURITY DEFINER" \
  "SELECT string_agg(p.proname || ':' || has_function_privilege('anon', p.oid, 'EXECUTE') || has_function_privilege('authenticated', p.oid, 'EXECUTE') || has_function_privilege('service_role', p.oid, 'EXECUTE') || ':' || p.prosecdef, ',' ORDER BY p.proname COLLATE \"C\") FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ($FNS)" \
  "_team_code_account:falsefalsetrue:true,_team_code_hash:falsefalsetrue:true,accept_team_invitation_by_code:falsefalsetrue:true,team_invitation_code_check:falsefalsetrue:true,team_invitation_code_issue:falsefalsetrue:true"
val "O3 one salt, 32 random bytes in hex" \
  "SELECT count(*) || ':' || bool_and(salt ~ '^[0-9a-f]{64}\$') FROM public.team_invitation_code_salt" "1:true"
val "O4 anon cannot ask for a code; a signed-in user cannot accept with one" \
  "BEGIN; SET LOCAL ROLE anon; $(out "SELECT public.team_invitation_code_issue(repeat(''a'', 64))::text") RESET ROLE; SET LOCAL request.jwt.claim.sub = '$PETE'; SET LOCAL ROLE authenticated; $(out "SELECT public.accept_team_invitation_by_code(repeat(''a'', 64), ''$PETE'')::text") ROLLBACK;" \
  "raised 42501: permission denied for function team_invitation_code_issue;raised 42501: permission denied for function accept_team_invitation_by_code"

echo "== issuing a code =="
val "I1 a pending invitation gets a 6-digit code for its address; only the hash is stored, for 10 minutes" \
  "$(svc "$(inv nina@bacoagency.com marketing a) SELECT (r->>'result') || '|' || (r->>'code' ~ '^[0-9]{6}\$') || '|' || (r->>'email') || '|' || (r->>'account_exists') || '|' || (r->>'expires_in_s') || '|' || (r->>'full_name') FROM (SELECT public.team_invitation_code_issue(repeat('a', 64)) r) x; SELECT (code_hash ~ '^[0-9a-f]{64}\$') || '|' || attempts || '|' || (expires_at = now() + interval '10 minutes') FROM public.team_invitation_codes;")" \
  "issued|true|nina@bacoagency.com|false|600|;true|0|true"
val "I2 the stored hash is the salted HMAC of the code, not a plain hash" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(issue a) SELECT (c.code_hash = public._team_code_hash(c.invitation_id, current_setting('test.code'))) || '|' || (c.code_hash <> encode(sha256(convert_to(current_setting('test.code'), 'UTF8')), 'hex')) FROM public.team_invitation_codes c;")" \
  "issued;true|true"
val "I3 the answer says whether the address already has an account" \
  "$(svc "$(inv pete@example.com admin b) SELECT public.team_invitation_code_issue(repeat('b', 64))->>'account_exists';")" "true"
val "I4 a second code within 60 s is refused, with the seconds left" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(issue a) SELECT (r->>'result') || '|' || ((r->>'retry_after_s')::int BETWEEN 59 AND 60) FROM (SELECT public.team_invitation_code_issue(repeat('a', 64)) r) x;")" \
  "issued;cooldown|true"
val "I5 after 60 s a new code replaces the old one and resets the attempts" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(issue a) $(su) UPDATE public.team_invitation_codes SET sent_at = now() - interval '61 seconds', attempts = 3; $(sr) $(issue a) SELECT attempts || '|' || (sent_at = now()) FROM public.team_invitation_codes;")" \
  "issued;issued;0|true"
val "I6 the sixth code in an hour is refused" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(su) INSERT INTO public.rate_limits (key, window_start, count) SELECT 'team-code-hour:' || id, to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600), 5 FROM public.team_invitations; $(sr) SELECT (r->>'result') || '|' || ((r->>'retry_after_s')::int BETWEEN 1 AND 3600) FROM (SELECT public.team_invitation_code_issue(repeat('a', 64)) r) x; SELECT count(*) FROM public.team_invitation_codes;")" \
  "too_many_hour|true;0"
val "I7 the eleventh code in a day is refused" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(su) INSERT INTO public.rate_limits (key, window_start, count) SELECT 'team-code-day:' || id, to_timestamp(floor(extract(epoch FROM now()) / 86400) * 86400), 10 FROM public.team_invitations; $(sr) SELECT (r->>'result') || '|' || ((r->>'retry_after_s')::int BETWEEN 1 AND 86400) FROM (SELECT public.team_invitation_code_issue(repeat('a', 64)) r) x; SELECT count(*) FROM public.team_invitation_codes;")" \
  "too_many_day|true;0"
val "I8 expired, canceled, used, internal, unknown and malformed invitations get no code" \
  "$(svc "$(su) INSERT INTO public.team_invitations (email, role, token, invited_by, expires_at, status) VALUES ('x1@example.com', 'admin', repeat('1', 64), '$SAM', now() - interval '1 minute', 'pending'), ('x2@example.com', 'admin', repeat('2', 64), '$SAM', now() + interval '1 day', 'canceled'), ('x3@example.com', 'admin', repeat('3', 64), '$SAM', now() + interval '1 day', 'accepted'), ('ops@tricigo.app', 'admin', repeat('4', 64), '$SAM', now() + interval '1 day', 'pending'); $(sr) SELECT string_agg(public.team_invitation_code_issue(v.t)->>'result', ',' ORDER BY v.n) FROM (VALUES (1, repeat('1', 64)), (2, repeat('2', 64)), (3, repeat('3', 64)), (4, repeat('4', 64)), (5, repeat('9', 64)), (6, 'nope')) v (n, t); SELECT count(*) FROM public.team_invitation_codes;")" \
  "expired,canceled,used,internal_address,not_found,not_found;0"

echo "== checking a code =="
val "C1 a wrong code costs an attempt and says how many are left" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(issue a) $(chk a "$WRONG") SELECT attempts FROM public.team_invitation_codes;")" \
  "issued;wrong_code|4;1"
val "C2 after five wrong codes even the right one is refused" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(issue a) $(chk a "$WRONG") $(chk a "$WRONG") $(chk a "$WRONG") $(chk a "$WRONG") $(chk a "$WRONG") $(chk a "$RIGHT")")" \
  "issued;wrong_code|4;wrong_code|3;wrong_code|2;wrong_code|1;locked|;locked|"
val "C3 a malformed or missing code also costs an attempt" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(issue a) $(chk a "'12 34'") $(chk a "NULL")")" \
  "issued;wrong_code|4;wrong_code|3"
val "C4 a code older than 10 minutes is refused" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(issue a) $(su) UPDATE public.team_invitation_codes SET expires_at = now() - interval '1 second'; $(sr) $(chk a "$RIGHT")")" \
  "issued;code_expired|"
val "C5 the right code answers the address, role and case once, and is gone after" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(issue a) SELECT (r->>'result') || '|' || (r->>'email') || '|' || (r->>'role') || '|' || (r->>'case') || '|' || coalesce(r->>'user_id', '-') FROM (SELECT public.team_invitation_code_check(repeat('a', 64), current_setting('test.code')) r) x; SELECT count(*) FROM public.team_invitation_codes; $(chk a "$RIGHT")")" \
  "issued;ok|nina@bacoagency.com|marketing|new|-;0;no_code|"
val "C6 checking before asking for a code says so" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(chk a "'123456'")")" "no_code|"
val "C7 the account cases: proven (with a phone), password only, phone, unverified Google, blocked, banned" \
  "$(svc "$(inv carl@gmail.com marketing c) $(issue c) $(okc c $CARL) $(inv pete@example.com marketing b) $(issue b) $(okc b $PETE) $(inv phil@example.com marketing d) $(issue d) $(okc d $PHIL) SELECT count(*) FROM public.team_invitation_codes c JOIN public.team_invitations i ON i.id = c.invitation_id WHERE i.email = 'phil@example.com'; $(inv eve@gmail.com marketing e) $(issue e) $(okc e $EVE) $(inv bob@gmail.com marketing 1) $(issue 1) $(okc 1 $BOB) $(inv ben@gmail.com marketing 2) $(issue 2) $(okc 2 $BEN)")" \
  "issued;ok|proven|true;issued;ok|password_only|true;issued;needs_google||;1;issued;needs_google||;issued;blocked||;issued;blocked||"

echo "== accepting with a code =="
val "A1 a new account gets the role; the invitation is accepted and audited as e-mail code" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(issue a) $(okc a '') $(su) INSERT INTO public.users (id, email, full_name) VALUES ('$NINA', 'nina@bacoagency.com', 'Nina Baco'); INSERT INTO auth.users (id, email) VALUES ('$NINA', 'nina@bacoagency.com'); INSERT INTO auth.identities (user_id, provider, identity_data) VALUES ('$NINA', 'email', '{\"email\": \"nina@bacoagency.com\", \"email_verified\": true}'); $(sr) $(acc a $NINA) SELECT role FROM public.users WHERE id = '$NINA'; SELECT status || '|' || (accepted_user_id = '$NINA') FROM public.team_invitations; SELECT action || '|' || (new_values->>'method') || '|' || (new_values->>'account') || '|' || (new_values->>'sessions_closed') FROM public.admin_actions;")" \
  "issued;ok|new|;accepted|marketing;marketing;accepted|true;team_invite_accepted|email_code|password_only|0"
val "A2 an existing account loses every session and refresh token" \
  "$(svc "$(su) INSERT INTO auth.sessions (id, user_id) VALUES ('5e550000-0000-4000-8000-000000000001', '$PETE'), ('5e550000-0000-4000-8000-000000000002', '$PETE'); INSERT INTO auth.refresh_tokens (user_id, session_id) VALUES ('$PETE', '5e550000-0000-4000-8000-000000000001'), ('$PETE', NULL); $(sr) $(inv pete@example.com admin b) $(issue b) $(okc b $PETE) $(acc b $PETE) $(su) SELECT (SELECT count(*) FROM auth.sessions) || '|' || (SELECT count(*) FROM auth.refresh_tokens); SELECT u.role || '|' || (a.new_values->>'sessions_closed') FROM public.users u, public.admin_actions a WHERE u.id = '$PETE';")" \
  "issued;ok|password_only|true;accepted|admin;0|0;admin|2"
val "A3 a proven account keeps its confirmed phone" \
  "$(svc "$(inv carl@gmail.com marketing c) $(issue c) $(okc c $CARL) $(acc c $CARL) $(su) SELECT phone || '|' || (phone_confirmed_at IS NOT NULL) FROM auth.users WHERE id = '$CARL';")" \
  "issued;ok|proven|true;accepted|marketing;5355550104|true"
val "A4 another account's id is refused and nothing changes" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(acc a $PETE) SELECT status FROM public.team_invitations; SELECT role FROM public.users WHERE id = '$PETE';")" \
  "wrong_account|;pending;customer"
val "A5 the phone case is refused at accept too, also when the phone was confirmed after the check" \
  "$(svc "$(inv phil@example.com marketing d) $(acc d $PHIL) $(inv pete@example.com marketing b) $(issue b) $(okc b $PETE) $(su) UPDATE auth.users SET phone = '5355550106', phone_confirmed_at = now() WHERE id = '$PETE'; $(sr) $(acc b $PETE) SELECT role FROM public.users WHERE id = '$PETE';")" \
  "needs_google|;issued;ok|password_only|true;needs_google|;customer"
val "A6 blocked and banned accounts are refused" \
  "$(svc "$(inv bob@gmail.com marketing 1) $(acc 1 $BOB) $(inv ben@gmail.com marketing 2) $(acc 2 $BEN)")" \
  "blocked|;blocked|"
val "A7 accepting never lowers a role" \
  "$(svc "$(inv ana@example.com marketing f) $(acc f $ANA) SELECT role FROM public.users WHERE id = '$ANA'; SELECT (old_values->>'role') || '|' || (new_values->>'role') FROM public.admin_actions;")" \
  "accepted|admin;admin;admin|admin"
val "A8 accepting twice answers accepted; another account finds it used" \
  "$(svc "$(inv carl@gmail.com marketing c) $(acc c $CARL) $(acc c $CARL) $(acc c $PETE)")" \
  "accepted|marketing;accepted|marketing;used|"
val "A9 expired and canceled invitations cannot be accepted" \
  "$(svc "$(su) INSERT INTO public.team_invitations (email, role, token, invited_by, expires_at, status) VALUES ('pete@example.com', 'admin', repeat('1', 64), '$SAM', now() - interval '1 minute', 'pending'), ('x2@example.com', 'admin', repeat('2', 64), '$SAM', now() + interval '1 day', 'canceled'); $(sr) $(acc 1 $PETE) $(acc 2 $PETE)")" \
  "expired|;canceled|"
val "A10 the Google path of 00661 still accepts" \
  "BEGIN; SET LOCAL client_min_messages = error; SET LOCAL ROLE service_role; $(inv carl@gmail.com marketing c) RESET ROLE; SET LOCAL request.jwt.claim.sub = '$CARL'; SET LOCAL ROLE authenticated; SELECT public.accept_team_invitation(repeat('c', 64))->>'result'; ROLLBACK;" \
  "accepted"

echo "== an accept with a code racing a removal waits for it instead of deadlocking =="
# Same races as 00661 R1/R2, with accept_team_invitation_by_code. MIA is marketing with a proven
# Google address and has an invitation to admin.
race_setup="SET ROLE postgres; INSERT INTO public.team_invitations (email, role, token, invited_by, expires_at) VALUES ('mia@example.com', 'admin', repeat('f', 64), '$SAM', now() + interval '1 day');"
R="$BIN/psql $CONN -d ${DB}r -qAt"
TR=$(mktemp -d)
fresh ${DB}r
[ "$MIG" != "none" ] && $BIN/psql $CONN -d ${DB}r -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null 2>&1
$R -c "$race_setup CREATE OR REPLACE FUNCTION public._team_role_rank(p_role text) RETURNS integer LANGUAGE plpgsql SET search_path = pg_catalog AS \$f\$ BEGIN IF current_setting('test.slow_rank', true) = '1' THEN PERFORM set_config('test.slow_rank', '', true); PERFORM pg_sleep(2); END IF; RETURN CASE p_role WHEN 'super_admin' THEN 3 WHEN 'admin' THEN 2 WHEN 'marketing' THEN 1 ELSE 0 END; END \$f\$;" >/dev/null 2>&1
( $R -c "BEGIN; SET LOCAL ROLE service_role; SET LOCAL test.slow_rank = '1'; SELECT public.accept_team_invitation_by_code(repeat('f', 64), '$MIA')->>'result'; COMMIT;" 2>&1 | tr -d '\r' | grep -m1 -o 'deadlock detected\|^[a-z_]*$' > "$TR/accept" ) &
sleep 0.5
rm_out=$($R -c "BEGIN; SET LOCAL request.jwt.claim.sub = '$SAM'; SET LOCAL ROLE authenticated; SELECT public.remove_team_member('$MIA', 'Ya no trabaja aqui'); COMMIT;" 2>&1 | tr -d '\r' | grep -m1 -o 'deadlock detected\|^[a-z_]*$')
wait
final=$($R -c "SELECT u.role || ':' || i.status FROM public.users u, public.team_invitations i WHERE u.id = '$MIA'" 2>&1 | tr -d '\r')
got="$(cat "$TR/accept")|$rm_out|$final"
[ "$got" = "accepted|customer|customer:accepted" ] && ok "R1 the accept finishes first, the removal then takes the role away; no deadlock" || ko "R1 the accept finishes first, the removal then takes the role away; no deadlock" "expected [accepted|customer|customer:accepted], got [$got]"

fresh ${DB}r
[ "$MIG" != "none" ] && $BIN/psql $CONN -d ${DB}r -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null 2>&1
$R -c "$race_setup CREATE OR REPLACE FUNCTION public._team_previous_role(p_user uuid) RETURNS public.user_role LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS \$f\$ BEGIN IF current_setting('test.slow_prev', true) = '1' THEN PERFORM set_config('test.slow_prev', '', true); PERFORM pg_sleep(2); END IF; RETURN CASE WHEN EXISTS (SELECT 1 FROM public.driver_profiles dp WHERE dp.user_id = p_user AND dp.status IN ('approved', 'suspended')) THEN 'driver'::public.user_role ELSE 'customer'::public.user_role END; END \$f\$;" >/dev/null 2>&1
( $R -c "BEGIN; SET LOCAL request.jwt.claim.sub = '$SAM'; SET LOCAL ROLE authenticated; SET LOCAL test.slow_prev = '1'; SELECT public.remove_team_member('$MIA', 'Ya no trabaja aqui'); COMMIT;" 2>&1 | tr -d '\r' | grep -m1 -o 'deadlock detected\|^[a-z_]*$' > "$TR/remove" ) &
sleep 0.5
acc_out=$($R -c "BEGIN; SET LOCAL ROLE service_role; SELECT public.accept_team_invitation_by_code(repeat('f', 64), '$MIA')->>'result'; COMMIT;" 2>&1 | tr -d '\r' | grep -m1 -o 'deadlock detected\|^[a-z_]*$')
wait
final=$($R -c "SELECT u.role || ':' || i.status FROM public.users u, public.team_invitations i WHERE u.id = '$MIA'" 2>&1 | tr -d '\r')
got="$(cat "$TR/remove")|$acc_out|$final"
[ "$got" = "customer|canceled|customer:canceled" ] && ok "R2 the removal finishes first, the accept then finds its invitation canceled; no deadlock" || ko "R2 the removal finishes first, the accept then finds its invitation canceled; no deadlock" "expected [customer|canceled|customer:canceled], got [$got]"
rm -rf "$TR"
$BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}r" >/dev/null 2>&1

if [ "$MIG" != "none" ]; then
  echo "== negative proofs: the migration's own checks catch a broken result =="
  T=$(mktemp -d)
  sabotage(){ "$PY" - "$MIG" "$T/$1.sql" "$2" "$3" <<'PYEOF'
import sys
src, dst, old, new = sys.argv[1:5]
s = open(src, encoding='utf-8').read().replace('\r\n', '\n')
assert s.count(old) == 1, f'{old!r} appears {s.count(old)} times'
s2 = s.replace(old, new); assert s2 != s
open(dst, 'w', encoding='utf-8', newline='\n').write(s2)
PYEOF
  }
  # G0: the same file with CRLF line endings (pasted from Windows) produces the same bodies.
  "$PY" - "$MIG" "$T/crlf.sql" <<'PYEOF'
import sys
s = open(sys.argv[1], encoding='utf-8').read().replace('\r\n', '\n')
open(sys.argv[2], 'w', encoding='utf-8', newline='\r\n').write(s)
PYEOF
  want=$($P -c "$BODIES" 2>&1 | tr -d '\r')
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/crlf.sql"); b=$($BIN/psql $CONN -d ${DB}g -qAt -c "$BODIES" 2>&1 | tr -d '\r')
  [ "$r" = applied ] && [ "$b" = "$want" ] && ok "G0 with CRLF line endings the migration produces the same bodies" || ko "G0 with CRLF line endings the migration produces the same bodies" "$r / $b"

  sabotage g1 "  public.accept_team_invitation_by_code(text, uuid)
FROM PUBLIC, anon, authenticated;" "  public.accept_team_invitation_by_code(text, uuid)
FROM PUBLIC;"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g1.sql")
  echo "$r" | grep -q "can execute public\." && ok "G1 a function a client can execute aborts the migration" || ko "G1 a function a client can execute aborts the migration" "$r"

  sabotage g2 "ALTER TABLE public.team_invitation_codes ENABLE ROW LEVEL SECURITY;" "-- sabotaged"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g2.sql")
  echo "$r" | grep -q "team_invitation_codes has row level security disabled" && ok "G2 a table without RLS aborts the migration" || ko "G2 a table without RLS aborts the migration" "$r"

  sabotage g3 "INSERT INTO public.team_invitation_code_salt (id, salt)
VALUES (1, encode(extensions.gen_random_bytes(32), 'hex'))
ON CONFLICT (id) DO NOTHING;" "-- sabotaged"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g3.sql")
  echo "$r" | grep -q "the code salt is missing" && ok "G3 a missing salt aborts the migration" || ko "G3 a missing salt aborts the migration" "$r"

  rm -rf "$T"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 4: Make it executable and run it without the migration (RED)**

```bash
chmod +x supabase/tests/00664/run.sh
bash supabase/tests/00664/run.sh none
```

Expected: `S0`, `S1` and `A10` PASS (they guard the scaffold and 00661), every `O*`, `I*`, `C*`, `A1`–`A9`, `R1`, `R2` FAIL (the objects do not exist); the last line reads `== 3 passed, 30 failed ==` and the exit code is 1. If `S0` fails, the scaffold's `check_rate_limit` body is not byte-for-byte the live one: fix the scaffold, not the expected value.

- [ ] **Step 5: Commit**

```bash
git add supabase/tests/00664/scaffold.sql supabase/tests/00664/seed.sql supabase/tests/00664/run.sh
git commit -m "test(db): rehearsal for accepting a team invitation with an e-mail code

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Migration 00664 (GREEN)

> **Superseded after Task 4a (2026-10-16).** The code below is what was first committed. The review fixes changed it (grants, account cases, the two marks, new tests). The committed files under `supabase/migrations/00664_*` and `supabase/tests/00664/` are the source of truth; do not copy from this section.

**Files:**
- Create: `supabase/migrations/00664_team_invitation_email_code.sql`

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================
-- Migration 00664: accept a team invitation with an e-mail code
--
-- Spec: docs/superpowers/specs/2026-10-16-team-invitation-email-code-design.md
--
-- 00661 accepts an invitation only through a Google or Apple identity with the
-- invited address. This adds a second way: a 6-digit code sent to that address.
-- With it the Edge Function team-invitation-code creates the account (or sets a
-- password on the existing one) and accepts the invitation:
--
--   1. public.team_invitation_codes and public.team_invitation_code_salt, lock tables
--      (RLS on, no policies, GRANT to service_role only).
--   2. Helpers: _team_code_hash (HMAC of the code with the salt) and
--      _team_code_account (which account has the address, and whether a code may
--      give it the role).
--   3. For the Edge Function only (service_role): team_invitation_code_issue,
--      team_invitation_code_check, accept_team_invitation_by_code.
--   4. Permissions, 5. carriage returns out of the bodies, 6. self-checks.
--
-- Account cases (_team_code_account): new (no account has the address as its
-- sign-in address), proven (a verified Google or Apple identity with that address;
-- a confirmed phone on it is the same owner's), password_only (only e-mail and
-- password), needs_google (no such proof, and a confirmed phone or another
-- identity: whoever holds it could reach the panel) and blocked (users.is_active
-- false or banned in GoTrue). Accepting never lowers a panel role and closes every
-- session of the account. Limits: 6 digits, 10 minutes, single use, 5 attempts;
-- 60 s between codes, 5 an hour and 10 a day per invitation (rate_limits).
-- Outcomes are answers ({result: ...}), never exceptions: the Edge Function maps them.
-- Rehearsal: supabase/tests/00664/run.sh
-- ============================================================

-- 0. What this migration needs -------------------------------------------------------
DO $guard$
BEGIN
  IF to_regclass('public.team_invitations') IS NULL
     OR to_regprocedure('public._team_write_role(uuid, public.user_role)') IS NULL
     OR to_regprocedure('public._team_role_rank(text)') IS NULL THEN
    RAISE EXCEPTION '00664: needs 00661 (team_invitations, _team_write_role, _team_role_rank)';
  END IF;
  IF to_regprocedure('extensions.gen_random_bytes(integer)') IS NULL
     OR to_regprocedure('extensions.hmac(text, text, text)') IS NULL THEN
    RAISE EXCEPTION '00664: needs pgcrypto in schema extensions';
  END IF;
  IF to_regprocedure('public.check_rate_limit(text, integer, integer)') IS NULL THEN
    RAISE EXCEPTION '00664: needs public.check_rate_limit';
  END IF;
END
$guard$;

-- 1. Tables ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_invitation_codes (
  invitation_id uuid PRIMARY KEY REFERENCES public.team_invitations (id) ON DELETE CASCADE,
  code_hash     text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at    timestamptz NOT NULL,
  attempts      smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  sent_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.team_invitation_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_invitation_codes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.team_invitation_codes TO service_role;

CREATE TABLE IF NOT EXISTS public.team_invitation_code_salt (
  id   smallint PRIMARY KEY CHECK (id = 1),
  salt text NOT NULL CHECK (salt ~ '^[0-9a-f]{64}$')
);
ALTER TABLE public.team_invitation_code_salt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_invitation_code_salt FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.team_invitation_code_salt TO service_role;
INSERT INTO public.team_invitation_code_salt (id, salt)
VALUES (1, encode(extensions.gen_random_bytes(32), 'hex'))
ON CONFLICT (id) DO NOTHING;

-- 2. Helpers ---------------------------------------------------------------------------
-- The stored form of a code: HMAC-SHA256 of '<invitation id>:<code>' keyed with the salt,
-- so a copy of team_invitation_codes does not let anyone try the million codes offline.
CREATE OR REPLACE FUNCTION public._team_code_hash(p_invitation uuid, p_code text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT encode(extensions.hmac(p_invitation::text || ':' || p_code, s.salt, 'sha256'), 'hex')
  FROM public.team_invitation_code_salt s
  WHERE s.id = 1
$$;

-- The account whose sign-in address (auth.users.email) is p_email, and its case:
-- {case: new} or {case: proven|password_only|needs_google|blocked, user_id}.
-- public.users.email does not count: its owner writes it without proof.
CREATE OR REPLACE FUNCTION public._team_code_account(p_email text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_id     uuid;
  v_phone  boolean;
  v_banned boolean;
  v_active boolean;
BEGIN
  SELECT au.id, au.phone_confirmed_at IS NOT NULL, coalesce(au.banned_until > now(), false)
    INTO v_id, v_phone, v_banned
  FROM auth.users au
  WHERE au.email IS NOT NULL AND lower(btrim(au.email)) = v_email
  ORDER BY au.created_at, au.id
  LIMIT 1;
  IF v_id IS NULL THEN
    RETURN jsonb_build_object('case', 'new');
  END IF;

  SELECT coalesce(u.is_active, true) INTO v_active FROM public.users u WHERE u.id = v_id;
  IF v_banned OR NOT coalesce(v_active, true) THEN
    RETURN jsonb_build_object('case', 'blocked', 'user_id', v_id);
  END IF;

  IF EXISTS (
    SELECT 1 FROM auth.identities i
    WHERE i.user_id = v_id
      AND i.provider IN ('google', 'apple')
      AND lower(btrim(coalesce(i.identity_data->>'email', ''))) = v_email
      AND lower(coalesce(i.identity_data->>'email_verified', '')) = 'true'
  ) THEN
    RETURN jsonb_build_object('case', 'proven', 'user_id', v_id);
  END IF;

  IF v_phone OR EXISTS (
    SELECT 1 FROM auth.identities i WHERE i.user_id = v_id AND i.provider <> 'email'
  ) THEN
    RETURN jsonb_build_object('case', 'needs_google', 'user_id', v_id);
  END IF;
  RETURN jsonb_build_object('case', 'password_only', 'user_id', v_id);
END;
$$;

-- 3. For the Edge Function -----------------------------------------------------------
-- A new code for a pending invitation. Answers {result: issued, code, email, full_name,
-- account_exists, expires_in_s} or {result: not_found|canceled|used|expired|
-- internal_address|cooldown|too_many_hour|too_many_day[, retry_after_s]}.
CREATE OR REPLACE FUNCTION public.team_invitation_code_issue(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_inv   public.team_invitations;
  v_prev  public.team_invitation_codes;
  v_limit record;
  v_bytes bytea;
  v_n     bigint;
  v_code  text;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  SELECT * INTO v_inv FROM public.team_invitations WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF v_inv.status = 'canceled' THEN
    RETURN jsonb_build_object('result', 'canceled');
  END IF;
  IF v_inv.status = 'accepted' THEN
    RETURN jsonb_build_object('result', 'used');
  END IF;
  IF v_inv.expires_at <= now() THEN
    RETURN jsonb_build_object('result', 'expired');
  END IF;
  IF v_inv.email ~ '@tricigo\.(app|system)$' THEN
    RETURN jsonb_build_object('result', 'internal_address');
  END IF;

  SELECT * INTO v_prev FROM public.team_invitation_codes WHERE invitation_id = v_inv.id;
  IF FOUND AND v_prev.sent_at > now() - interval '60 seconds' THEN
    RETURN jsonb_build_object('result', 'cooldown',
      'retry_after_s', greatest(1, ceil(extract(epoch FROM (v_prev.sent_at + interval '60 seconds' - now()))))::integer);
  END IF;
  SELECT * INTO v_limit FROM public.check_rate_limit('team-code-hour:' || v_inv.id::text, 5, 3600);
  IF NOT v_limit.allowed THEN
    RETURN jsonb_build_object('result', 'too_many_hour',
      'retry_after_s', greatest(1, ceil(extract(epoch FROM (v_limit.reset_at - now()))))::integer);
  END IF;
  SELECT * INTO v_limit FROM public.check_rate_limit('team-code-day:' || v_inv.id::text, 10, 86400);
  IF NOT v_limit.allowed THEN
    RETURN jsonb_build_object('result', 'too_many_day',
      'retry_after_s', greatest(1, ceil(extract(epoch FROM (v_limit.reset_at - now()))))::integer);
  END IF;

  -- 4 random bytes; values from 4,294,000,000 up are dropped so all million codes are equally likely.
  LOOP
    v_bytes := extensions.gen_random_bytes(4);
    v_n := (get_byte(v_bytes, 0)::bigint << 24) + (get_byte(v_bytes, 1)::bigint << 16)
         + (get_byte(v_bytes, 2)::bigint << 8) + get_byte(v_bytes, 3)::bigint;
    EXIT WHEN v_n < 4294000000;
  END LOOP;
  v_code := lpad((v_n % 1000000)::text, 6, '0');

  INSERT INTO public.team_invitation_codes (invitation_id, code_hash, expires_at, attempts, sent_at)
  VALUES (v_inv.id, public._team_code_hash(v_inv.id, v_code), now() + interval '10 minutes', 0, now())
  ON CONFLICT (invitation_id) DO UPDATE
    SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, sent_at = EXCLUDED.sent_at;

  RETURN jsonb_build_object(
    'result', 'issued',
    'code', v_code,
    'email', v_inv.email,
    'full_name', coalesce(v_inv.full_name, ''),
    'account_exists', (public._team_code_account(v_inv.email)->>'case') <> 'new',
    'expires_in_s', 600);
END;
$$;

-- Checks a code. Right: deletes it (single use) and answers {result: ok, email, role,
-- full_name, case, user_id}. Otherwise {result: not_found|canceled|used|expired|
-- internal_address|no_code|locked|code_expired|wrong_code[, attempts_left]|
-- needs_google|blocked}. A wrong or malformed code costs one of the 5 attempts.
CREATE OR REPLACE FUNCTION public.team_invitation_code_check(p_token text, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_inv      public.team_invitations;
  v_row      public.team_invitation_codes;
  v_account  jsonb;
  v_attempts integer;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  SELECT * INTO v_inv FROM public.team_invitations WHERE token = p_token;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF v_inv.status = 'canceled' THEN
    RETURN jsonb_build_object('result', 'canceled');
  END IF;
  IF v_inv.status = 'accepted' THEN
    RETURN jsonb_build_object('result', 'used');
  END IF;
  IF v_inv.expires_at <= now() THEN
    RETURN jsonb_build_object('result', 'expired');
  END IF;
  IF v_inv.email ~ '@tricigo\.(app|system)$' THEN
    RETURN jsonb_build_object('result', 'internal_address');
  END IF;

  SELECT * INTO v_row FROM public.team_invitation_codes WHERE invitation_id = v_inv.id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'no_code');
  END IF;
  IF v_row.attempts >= 5 THEN
    RETURN jsonb_build_object('result', 'locked');
  END IF;
  IF v_row.expires_at <= now() THEN
    RETURN jsonb_build_object('result', 'code_expired');
  END IF;

  IF coalesce(p_code, '') ~ '^[0-9]{6}$' AND public._team_code_hash(v_inv.id, p_code) = v_row.code_hash THEN
    v_account := public._team_code_account(v_inv.email);
    IF v_account->>'case' IN ('blocked', 'needs_google') THEN
      RETURN jsonb_build_object('result', v_account->>'case');
    END IF;
    DELETE FROM public.team_invitation_codes WHERE invitation_id = v_inv.id;
    RETURN jsonb_build_object(
      'result', 'ok',
      'email', v_inv.email,
      'role', v_inv.role,
      'full_name', coalesce(v_inv.full_name, ''),
      'case', v_account->>'case',
      'user_id', v_account->'user_id');
  END IF;

  UPDATE public.team_invitation_codes SET attempts = attempts + 1
   WHERE invitation_id = v_inv.id
  RETURNING attempts INTO v_attempts;
  IF v_attempts >= 5 THEN
    RETURN jsonb_build_object('result', 'locked');
  END IF;
  RETURN jsonb_build_object('result', 'wrong_code', 'attempts_left', 5 - v_attempts);
END;
$$;

-- Accepts the invitation for p_user once the Edge Function created the account or set its
-- password. Checks everything again. Answers {result: accepted, role} or {result:
-- not_found|no_account|canceled|used|expired|wrong_account|blocked|needs_google}.
CREATE OR REPLACE FUNCTION public.accept_team_invitation_by_code(p_token text, p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_role     public.user_role;
  v_active   boolean;
  v_inv      public.team_invitations;
  v_email    text;
  v_account  jsonb;
  v_new      public.user_role;
  v_sessions integer;
BEGIN
  IF p_user IS NULL OR p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  -- The person's row first, then the invitation: the order of every 00661 function, so an
  -- accept racing a removal waits instead of deadlocking.
  SELECT u.role, coalesce(u.is_active, true) INTO v_role, v_active
  FROM public.users u WHERE u.id = p_user
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'no_account');
  END IF;
  SELECT * INTO v_inv FROM public.team_invitations WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF v_inv.status = 'canceled' THEN
    RETURN jsonb_build_object('result', 'canceled');
  END IF;
  IF v_inv.status = 'accepted' THEN
    IF v_inv.accepted_user_id = p_user THEN
      RETURN jsonb_build_object('result', 'accepted', 'role', v_role);
    END IF;
    RETURN jsonb_build_object('result', 'used');
  END IF;
  IF v_inv.expires_at <= now() THEN
    RETURN jsonb_build_object('result', 'expired');
  END IF;

  SELECT lower(btrim(coalesce(au.email, ''))) INTO v_email FROM auth.users au WHERE au.id = p_user;
  v_account := public._team_code_account(v_inv.email);
  IF v_email IS DISTINCT FROM v_inv.email OR (v_account->>'user_id') IS DISTINCT FROM p_user::text THEN
    RETURN jsonb_build_object('result', 'wrong_account');
  END IF;
  IF NOT v_active OR v_account->>'case' = 'blocked' THEN
    RETURN jsonb_build_object('result', 'blocked');
  END IF;
  IF v_account->>'case' NOT IN ('proven', 'password_only') THEN
    RETURN jsonb_build_object('result', 'needs_google');
  END IF;

  WITH s AS (DELETE FROM auth.sessions WHERE user_id = p_user RETURNING 1)
  SELECT count(*) INTO v_sessions FROM s;
  -- Refresh tokens with a session went with it (ON DELETE CASCADE); these are the rest.
  DELETE FROM auth.refresh_tokens WHERE user_id = p_user::text;

  v_new := CASE WHEN public._team_role_rank(v_role::text) >= public._team_role_rank(v_inv.role::text)
                THEN v_role ELSE v_inv.role END;
  IF v_new IS DISTINCT FROM v_role THEN
    PERFORM public._team_write_role(p_user, v_new);
  END IF;
  UPDATE public.team_invitations
     SET status = 'accepted', accepted_at = now(), accepted_user_id = p_user
   WHERE id = v_inv.id;
  DELETE FROM public.team_invitation_codes WHERE invitation_id = v_inv.id;
  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
  VALUES (v_inv.invited_by, 'team_invite_accepted', 'user', p_user::text,
          jsonb_build_object('role', v_role),
          jsonb_build_object('role', v_new, 'invitation_id', v_inv.id, 'method', 'email_code',
                             'account', v_account->>'case', 'sessions_closed', v_sessions));
  RETURN jsonb_build_object('result', 'accepted', 'role', v_new);
END;
$$;

-- 4. Permissions -----------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public._team_code_hash(uuid, text),
  public._team_code_account(text),
  public.team_invitation_code_issue(text),
  public.team_invitation_code_check(text, text),
  public.accept_team_invitation_by_code(text, uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.team_invitation_code_issue(text),
  public.team_invitation_code_check(text, text),
  public.accept_team_invitation_by_code(text, uuid)
TO service_role;

-- 5. A copy pasted with CRLF line endings leaves carriage returns in the bodies --------
DO $crlf$
DECLARE
  v_fn  regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public._team_code_hash(uuid, text)', 'public._team_code_account(text)',
    'public.team_invitation_code_issue(text)', 'public.team_invitation_code_check(text, text)',
    'public.accept_team_invitation_by_code(text, uuid)']::regprocedure[]
  LOOP
    v_def := pg_get_functiondef(v_fn);
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END
$crlf$;

-- 6. Self-checks -------------------------------------------------------------------------
DO $check$
DECLARE
  v_tbl  regclass;
  v_fn   regprocedure;
  v_role text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['public.team_invitation_codes', 'public.team_invitation_code_salt']::regclass[] LOOP
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = v_tbl) THEN
      RAISE EXCEPTION '00664: % has row level security disabled', v_tbl;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_table_privilege(v_role, v_tbl, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') THEN
        RAISE EXCEPTION '00664: % has privileges on %', v_role, v_tbl;
      END IF;
    END LOOP;
    IF NOT has_table_privilege('service_role', v_tbl, 'SELECT') THEN
      RAISE EXCEPTION '00664: service_role cannot read %', v_tbl;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.team_invitation_code_salt WHERE id = 1 AND salt ~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION '00664: the code salt is missing';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'public._team_code_hash(uuid, text)', 'public._team_code_account(text)',
    'public.team_invitation_code_issue(text)', 'public.team_invitation_code_check(text, text)',
    'public.accept_team_invitation_by_code(text, uuid)']::regprocedure[]
  LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION '00664: % can execute %', v_role, v_fn;
      END IF;
    END LOOP;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_fn) THEN
      RAISE EXCEPTION '00664: % must be SECURITY DEFINER', v_fn;
    END IF;
    IF position(chr(13) IN (SELECT p.prosrc FROM pg_proc p WHERE p.oid = v_fn)) > 0 THEN
      RAISE EXCEPTION '00664: % kept a carriage return', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY[
    'public.team_invitation_code_issue(text)', 'public.team_invitation_code_check(text, text)',
    'public.accept_team_invitation_by_code(text, uuid)']::regprocedure[]
  LOOP
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00664: service_role cannot execute %', v_fn;
    END IF;
  END LOOP;
END
$check$;
```

- [ ] **Step 2: Run the rehearsal with the migration (GREEN)**

```bash
bash supabase/tests/00664/run.sh supabase/migrations/00664_team_invitation_email_code.sql
```

Expected: every test PASS, last line `== 37 passed, 0 failed ==` (33 tests plus G0–G3), exit code 0. If a test fails, fix the migration, not the expected value, unless the expected value is provably wrong; then say so in the commit message.

- [ ] **Step 3: Run the repo's migration checks**

```bash
pnpm test:migration-grants && pnpm check:migration-grants
pnpm --filter @tricigo/utils exec vitest run copyTuteo copyAccents
```

Expected: all pass (the tables carry GRANTs including `service_role`; the migration has no Spanish copy).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00664_team_invitation_email_code.sql
git commit -m "feat(db): accept a team invitation with an e-mail code (00664)

Two lock tables (team_invitation_codes, team_invitation_code_salt) and
three functions only service_role executes: team_invitation_code_issue,
team_invitation_code_check and accept_team_invitation_by_code. A code
is 6 digits, lives 10 minutes, is stored as an HMAC and allows 5
attempts; an invitation gets a code every 60 s, at most 5 an hour and
10 a day. The code gives the role to a new account, to one whose address
Google or Apple verified, or to one with only e-mail and password; it
refuses an unproven account with a phone, and blocked accounts.
Accepting closes every session of the account and never lowers a role.

Rehearsal: supabase/tests/00664/run.sh (RED 30 failures, GREEN 37/37).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: E-mail templates

**Files:**
- Create: `supabase/functions/_shared/email-templates/team_invitation_code.ts`
- Create: `supabase/functions/_shared/email-templates/team_invitation_code.test.ts`
- Modify: `supabase/functions/_shared/email-templates/index.ts`
- Modify: `supabase/functions/_shared/email-templates/team_invitation.ts:75-78`
- Modify: `supabase/functions/_shared/email-templates/team_invitation.test.ts`

- [ ] **Step 1: Write the failing template test**

`supabase/functions/_shared/email-templates/team_invitation_code.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { teamInvitationCodeHtml, teamInvitationCodeSubject } from './team_invitation_code.ts';
import { isTemplateKey, renderTemplate } from './index.ts';

// wrapHtml turns every non-ASCII character into a numeric entity; decode them to read the text.
const decode = (html: string) => html.replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));

const DATA = { code: '048213', email: 'info@bacoagency.com' };

describe('team_invitation_code template', () => {
  it('has a fixed subject', () => {
    expect(teamInvitationCodeSubject).toBe('Tu código para el panel de TriciGo');
  });

  it('shows the code, the address and the expiry', () => {
    const html = decode(teamInvitationCodeHtml(DATA));
    expect(html).toContain('048213');
    expect(html).toContain('info@bacoagency.com');
    expect(html).toContain('Vence en 10 minutos.');
    expect(html).toContain('Si no pediste este código, ignora este correo.');
  });

  it('shows nothing that is not a 6-digit code', () => {
    const html = teamInvitationCodeHtml({ ...DATA, code: '<b>12</b>' });
    expect(html).not.toContain('<b>12');
    expect(html).not.toContain('&lt;b&gt;12');
  });

  it('escapes the address', () => {
    const html = teamInvitationCodeHtml({ ...DATA, email: '<script>x</script>@evil.example' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('is registered in the template index', () => {
    expect(isTemplateKey('team_invitation_code')).toBe(true);
    const rendered = renderTemplate('team_invitation_code', DATA);
    expect(rendered.subject).toBe('Tu código para el panel de TriciGo');
    expect(decode(rendered.html)).toContain('048213');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @tricigo/api exec vitest run email-templates/team_invitation_code`
Expected: FAIL, `Failed to resolve import "./team_invitation_code.ts"`.

- [ ] **Step 3: Write the template**

`supabase/functions/_shared/email-templates/team_invitation_code.ts`:

```ts
// ============================================================
// TriciGo — Team invitation code e-mail (00664)
//
// Sent by the Edge Function team-invitation-code to the invited address: the
// 6-digit code that lets the person accept their admin panel invitation, by
// creating their account or setting a password on the one with that address.
// data: { code, email }. The code is the only thing this e-mail proves.
// Spec: docs/superpowers/specs/2026-10-16-team-invitation-email-code-design.md
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, escapeHtml } from './_layout.ts';

export interface TeamInvitationCodeData {
  code: string;
  email: string;
}

export const teamInvitationCodeSubject = 'Tu código para el panel de TriciGo';

const CODE_RE = /^[0-9]{6}$/;

export function teamInvitationCodeHtml(data: TeamInvitationCodeData): string {
  const code = CODE_RE.test(data.code) ? data.code : '';

  const body = `
    <p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      Hola:
    </p>
    <p style="margin: 0 0 16px;">
      Usa este código para aceptar tu invitación al panel de TriciGo con <strong>${escapeHtml(data.email)}</strong>:
    </p>
    <p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 32px; font-weight: 700; letter-spacing: 8px; color: ${COLORS.ink};">
      ${code}
    </p>
    <p style="margin: 0 0 16px;">
      Vence en 10 minutos.
    </p>
    <p style="margin: 0;">
      Si no pediste este código, ignora este correo. Nadie de TriciGo te lo va a pedir.
    </p>
  `;

  return wrapHtml({
    preheader: code ? `Tu código: ${code}. Vence en 10 minutos.` : 'Tu código para el panel de TriciGo.',
    hero: {
      title: 'Tu código para el panel',
      subtitle: 'Panel de administración de TriciGo',
    },
    body,
    footerNote: '¿Dudas? Escríbenos a soporte@tricigo.com',
  });
}
```

- [ ] **Step 4: Register it in `supabase/functions/_shared/email-templates/index.ts`**

After the `team_invitation` import block add:

```ts
import {
  teamInvitationCodeHtml,
  teamInvitationCodeSubject,
  type TeamInvitationCodeData,
} from './team_invitation_code.ts';
```

In `TemplateKey`, change `| 'team_invitation';` to:

```ts
  | 'team_invitation'
  | 'team_invitation_code';
```

In the `switch`, after the `case 'team_invitation': { ... }` block add:

```ts
    case 'team_invitation_code': {
      const d = data as TeamInvitationCodeData;
      return {
        subject: subjectOverride ?? teamInvitationCodeSubject,
        html: teamInvitationCodeHtml(d),
      };
    }
```

In `isTemplateKey`, change `key === 'team_invitation'` to:

```ts
    key === 'team_invitation' ||
    key === 'team_invitation_code'
```

- [ ] **Step 5: Change the invitation e-mail and its test**

In `supabase/functions/_shared/email-templates/team_invitation.ts`, replace:

```ts
      Toca el botón y entra con la cuenta de Google de <strong>${escapeHtml(data.email)}</strong>.
      Con otra cuenta la invitación no funciona.
```

with:

```ts
      Toca el botón y entra con la cuenta de Google de <strong>${escapeHtml(data.email)}</strong>,
      o crea tu cuenta con un código que te mandamos a esta dirección.
```

In `team_invitation.test.ts`, inside `it('carries the link, the invited address, the role and the expiry in Havana time', ...)`, add after the `ignora este correo` expectation:

```ts
    expect(html).toContain('o crea tu cuenta con un código que te mandamos a esta dirección.');
    expect(html).not.toContain('Con otra cuenta la invitación no funciona.');
```

- [ ] **Step 6: Run the template tests**

Run: `pnpm --filter @tricigo/api exec vitest run email-templates/team_invitation`
Expected: PASS (both files). Then `pnpm --filter @tricigo/api exec vitest run copy-tuteo` → PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/email-templates/team_invitation_code.ts supabase/functions/_shared/email-templates/team_invitation_code.test.ts supabase/functions/_shared/email-templates/index.ts supabase/functions/_shared/email-templates/team_invitation.ts supabase/functions/_shared/email-templates/team_invitation.test.ts
git commit -m "feat(email): team invitation code template

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4a: Review fixes to 00664

A code review of Tasks 2–3 (2026-10-16) found these; each was checked against the code before being accepted. The migration is still unapplied, so the fixes go into the same file.

**Files:**
- Modify: `supabase/migrations/00664_team_invitation_email_code.sql`
- Modify: `supabase/tests/00664/run.sh` (and `seed.sql` only if a new person is clearer than an inline one)

- [ ] **Step 1: Add the failing rehearsal tests**

Add to `supabase/tests/00664/run.sh`, each in the section it belongs to (O = objects, I = issuing, C = checking, A = accepting, G = negative proofs; the last ones today are O4, I8, C7, A10, G3) (use the existing helpers `svc`, `su`, `sr`, `inv`, `issue`, `chk`, `okc`, `acc`):

| Test | What it proves | Expected |
|---|---|---|
| O5 | `service_role` has exactly what the migration grants: on `team_invitation_codes` SELECT, INSERT, UPDATE, DELETE and not TRUNCATE, REFERENCES or TRIGGER; on `team_invitation_code_salt` SELECT and nothing else. The scaffold gives every new table ALL through default privileges, as prod does until 2026-10-30, so this fails until the REVOKE includes `service_role`. | `codes:SELECT,INSERT,UPDATE,DELETE;salt:SELECT` (list the privileges service_role holds, in that order) |
| O6 | `public.users.password_set_at` exists (timestamptz, nullable) | `timestamp with time zone:YES` (`information_schema.columns` data_type and is_nullable) |
| I9 | The fifth code in an hour is still issued: `rate_limits` count 4 for `team-code-hour:<id>` → `issued` (I6 shows the sixth is refused) | `issued` |
| I10 | The tenth code in a day is still issued: count 9 for `team-code-day:<id>` → `issued` | `issued` |
| I11 | A `cooldown` answer adds nothing to either counter: issue, issue again within 60 s, then the two `rate_limits` counts are still 1 and 1 | `issued;cooldown;1|1` |
| C8 | An account whose phone is set but not confirmed is `needs_google`: insert inline an account with `auth.users.email` = the invited address, `phone = '5355500077'`, `phone_confirmed_at` NULL and only an `email` identity; a right code answers `needs_google` and the code row is still there | `needs_google;1` |
| C9 | An address that no `auth.users.email` has but an identity carries is `needs_google`: insert an `auth.users` row with another address (e.g. `phone_5355500088@tricigo.app`) plus a `google` identity with `{"email": "<invited>", "email_verified": true}`; issue answers `account_exists = true`, a right code answers `needs_google` and keeps the code row | `issued|true;needs_google;1` |
| A11 | `accept_team_invitation_by_code` refuses an internal address: a pending invitation to `ops@tricigo.app` and any user → `internal_address` | `internal_address|` |
| A12 | Accept for a user with no `public.users` row → `no_account` | `no_account|` |
| A13 | After a code acceptance the person's `password_set_at` is set and `email_verified_at` is set when `users.email` is the invited address (use NINA, the new-account path) | `t|t` |
| A14 | `email_verified_at` is not touched when `users.email` is another address (e.g. PETE with `users.email` changed to another address inside the test), while `password_set_at` is set | `t|t` for "password_set_at set, email_verified_at still NULL" |
| A15 | An `email_verified_at` already set is kept, not moved to `now()` | `t` (the value equals the one set before the accept) |
| G4 | Negative proof: a copy of the migration whose two table REVOKEs leave out `service_role` aborts on the new self-check (below) with `service_role has TRUNCATE on` | grep the message |

Pick the exact SQL by copying the closest existing test and changing what differs; keep the `expected` strings exact.

- [ ] **Step 2: Run the rehearsal and see the new tests fail**

Run (Windows; cluster from CLAUDE.md § "En Windows, sin sandbox"):
`PGBIN=<scratchpad>/pg/pgsql/bin PGPORT=<port> PYTHON=python bash supabase/tests/00664/run.sh supabase/migrations/00664_team_invitation_email_code.sql`
Expected: the old tests pass, every new test above fails (G4 fails because the self-check does not exist yet).

- [ ] **Step 3: Fix the migration**

1. Section 1, both tables: revoke from `service_role` too, before the grant (memory `reference_table_grants_revoke_first`):
   ```sql
   REVOKE ALL ON public.team_invitation_codes FROM PUBLIC, anon, authenticated, service_role;
   GRANT SELECT, INSERT, UPDATE, DELETE ON public.team_invitation_codes TO service_role;
   ```
   ```sql
   REVOKE ALL ON public.team_invitation_code_salt FROM PUBLIC, anon, authenticated, service_role;
   GRANT SELECT ON public.team_invitation_code_salt TO service_role;
   ```
2. Section 1, after the salt insert: bring `users.password_set_at` into git without locking prod, where it already exists:
   ```sql
   -- users.password_set_at marks a password the person chose; verify-otp reads it so a phone
   -- login does not overwrite that password. Prod has had it since before git tracked it
   -- (set-password-after-otp writes it): adding it only when missing takes no lock there.
   DO $col$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = 'public.users'::regclass AND attname = 'password_set_at' AND NOT attisdropped) THEN
       ALTER TABLE public.users ADD COLUMN password_set_at timestamptz;
     END IF;
   END
   $col$;
   ```
3. `_team_code_account`: a phone counts even unconfirmed, and an address only an identity carries is `needs_google`. Replace the body from `DECLARE` to `END;` with:
   ```sql
   DECLARE
     v_email    text := lower(btrim(coalesce(p_email, '')));
     v_id       uuid;
     v_phone    boolean;
     v_banned   boolean;
     v_active   boolean;
     v_identity boolean := false;
   BEGIN
     SELECT au.id,
            au.phone_confirmed_at IS NOT NULL OR nullif(btrim(coalesce(au.phone, '')), '') IS NOT NULL,
            coalesce(au.banned_until > now(), false)
       INTO v_id, v_phone, v_banned
     FROM auth.users au
     WHERE au.email IS NOT NULL AND lower(btrim(au.email)) = v_email
     ORDER BY au.created_at, au.id
     LIMIT 1;
     IF v_id IS NULL THEN
       -- No account signs in with the address, but an identity may carry it: signing in with
       -- Google would land on that account, so a second account with the address must not be made.
       SELECT i.user_id INTO v_id
       FROM auth.identities i
       WHERE lower(btrim(coalesce(i.identity_data->>'email', ''))) = v_email
       ORDER BY i.user_id
       LIMIT 1;
       IF v_id IS NULL THEN
         RETURN jsonb_build_object('case', 'new');
       END IF;
       v_identity := true;
       SELECT coalesce(au.banned_until > now(), false) INTO v_banned FROM auth.users au WHERE au.id = v_id;
     END IF;

     SELECT coalesce(u.is_active, true) INTO v_active FROM public.users u WHERE u.id = v_id;
     IF coalesce(v_banned, false) OR NOT coalesce(v_active, true) THEN
       RETURN jsonb_build_object('case', 'blocked', 'user_id', v_id);
     END IF;
     IF v_identity THEN
       RETURN jsonb_build_object('case', 'needs_google', 'user_id', v_id);
     END IF;

     IF EXISTS (
       SELECT 1 FROM auth.identities i
       WHERE i.user_id = v_id
         AND i.provider IN ('google', 'apple')
         AND lower(btrim(coalesce(i.identity_data->>'email', ''))) = v_email
         AND lower(coalesce(i.identity_data->>'email_verified', '')) = 'true'
     ) THEN
       RETURN jsonb_build_object('case', 'proven', 'user_id', v_id);
     END IF;

     IF coalesce(v_phone, false) OR EXISTS (
       SELECT 1 FROM auth.identities i WHERE i.user_id = v_id AND i.provider <> 'email'
     ) THEN
       RETURN jsonb_build_object('case', 'needs_google', 'user_id', v_id);
     END IF;
     RETURN jsonb_build_object('case', 'password_only', 'user_id', v_id);
   END;
   ```
   (`SELECT … INTO` with no row sets every target to NULL, hence the `coalesce`s.)
4. `accept_team_invitation_by_code`, right after the `expires_at` check:
   ```sql
     IF v_inv.email ~ '@tricigo\.(app|system)$' THEN
       RETURN jsonb_build_object('result', 'internal_address');
     END IF;
   ```
   and right after the `_team_write_role` block (before marking the invitation accepted):
   ```sql
     -- What the code proved: the mailbox (password reset and e-mail login read email_verified_at,
     -- 00611) and a password the person chose (verify-otp must not overwrite it on a phone login).
     UPDATE public.users
        SET password_set_at = now(),
            email_verified_at = CASE WHEN email_verified_at IS NULL
                                      AND lower(btrim(coalesce(email, ''))) = v_inv.email
                                     THEN now() ELSE email_verified_at END
      WHERE id = p_user;
   ```
   Add `internal_address` to the list of answers in the comment above the function.
5. Section 6 (self-checks), inside the table loop:
   ```sql
       IF has_table_privilege('service_role', v_tbl, 'TRUNCATE') THEN
         RAISE EXCEPTION '00664: service_role has TRUNCATE on %', v_tbl;
       END IF;
   ```
   and after the loop:
   ```sql
     IF NOT EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = 'public.users'::regclass AND attname = 'password_set_at' AND NOT attisdropped) THEN
       RAISE EXCEPTION '00664: public.users.password_set_at is missing';
     END IF;
   ```
6. Header comment: the account cases now say "a phone (confirmed or not)" and "an address only an identity carries is needs_google"; add one line: "Accepting sets users.password_set_at and, when users.email is the invited address, users.email_verified_at."

- [ ] **Step 4: Run the rehearsal, GREEN and RED**

Run it with the migration (as in Step 2) and with `none`.
Expected: with the migration, everything passes (report the count); with `none`, every functional test fails as before. Then update the `$BODIES` md5 list if a test pins it, and say the new md5 of each body in the commit message (Task 9 compares them with prod).

- [ ] **Step 5: Run the repo's migration checks**

Run: `pnpm test:migration-grants && pnpm check:migration-grants`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/00664_team_invitation_email_code.sql supabase/tests/00664/run.sh
git commit -m "fix(db): tighten who a team invitation code can reach (00664 review)

<what changed, the test count, the md5 of each body>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
(Add `supabase/tests/00664/seed.sql` to `git add` only if it changed.)

---

### Task 4b: Phone logins keep a chosen password

`verify-otp` (Strategy A) signs in with a password derived from the account id and, when that fails, writes the derived password over the account's. A team member with a confirmed phone (a `proven` account) would lose the password chosen with the code the first time they open the driver or passenger app. With `users.password_set_at` set, or unreadable, the function now mints the session with the magic link only (Strategy B), which writes no password and closes no session. The panel's password reset marks the password too.

**Files:**
- Modify: `supabase/functions/verify-otp/index.ts` (the block "Strategy A — stable-password grant")
- Modify: `supabase/functions/verify-otp/index.test.ts`
- Modify: `apps/admin/src/app/reset-password/page.tsx` (`handleSubmit`)

- [ ] **Step 1: Write the failing handler tests**

Extend the fake in `supabase/functions/verify-otp/index.test.ts` so a right code reaches the session, without changing what the existing tests see:

- `db.lookupId: string | null` (reset to `null` in `beforeEach`). In `rpc`, `lookup_auth_user_by_contact` answers `{ data: db.lookupId, error: null }` when it is set; with `null` it keeps the current error, so the existing budget tests still end in 503.
- `auth.admin.getUserById` answers an account with `email: 'carl@gmail.com'`, the test phone in GoTrue's format (digits without `+`, check what `phoneConflictsWithAccount` expects), `phone_confirmed_at` set and `banned_until: null`.
- `from(table)`: for `'users'` return a chain whose `select`/`eq` return itself and `maybeSingle` resolves `db.mark` (`{ data: { password_set_at: '2026-10-16T00:00:00Z' } | { password_set_at: null } | null, error }`); every other table keeps the current chain.
- `auth.signInWithPassword`, `auth.admin.updateUserById`, `auth.admin.generateLink` (answers `{ data: { properties: { hashed_token: 'h' } }, error: null }`) and `auth.verifyOtp` as `vi.fn`s; both sign-in paths answer a session whose `user.id` is `db.lookupId`.

Then:

```ts
describe('verify-otp keeps a password the person chose', () => {
  beforeEach(() => {
    buckets();
    db.verify = { data: { ok: true }, error: null };
    db.lookupId = USER_ID;
  });

  it('with password_set_at, the session comes from the magic link and no password is tried or written', async () => {
    db.mark = { data: { password_set_at: '2026-10-16T00:00:00Z' }, error: null };
    const res = await verify();
    expect(res.status).toBe(200);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(auth.updateUserById).not.toHaveBeenCalledWith(USER_ID, expect.objectContaining({ password: expect.anything() }));
    expect(auth.generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'carl@gmail.com' });
  });

  it('when the mark cannot be read, it also uses the magic link', async () => {
    db.mark = { data: null, error: { message: 'column does not exist' } };
    const res = await verify();
    expect(res.status).toBe(200);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(auth.generateLink).toHaveBeenCalled();
  });

  it('without the mark, it signs in with the derived password as before and writes nothing', async () => {
    db.mark = { data: { password_set_at: null }, error: null };
    const res = await verify();
    expect(res.status).toBe(200);
    expect(auth.signInWithPassword).toHaveBeenCalledTimes(1);
    expect(auth.updateUserById).not.toHaveBeenCalled();
    expect(auth.generateLink).not.toHaveBeenCalled();
  });
});
```
(`USER_ID` and `auth` are the names you give the fake's id and its `vi.fn`s.)

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --filter @tricigo/api exec vitest run verify-otp`
Expected: the first two new tests fail (Strategy A runs), the third and the 8 existing pass.

- [ ] **Step 3: Read the mark in `verify-otp`**

In `supabase/functions/verify-otp/index.ts`, delete the four `NOTE (latent conflict)` lines of the Strategy A comment, add this right before the Strategy A comment:

```ts
    // A password the person chose (a team invitation code, the panel's password reset,
    // set-password-after-otp) is marked in users.password_set_at. Strategy A writes the
    // derived password whenever its sign-in fails, so with the mark, or when it cannot be
    // read, the session comes from the magic link only: no password written, no session closed.
    let keepPassword = true;
    try {
      const { data: mark, error: markErr } = await supabase
        .from('users')
        .select('password_set_at')
        .eq('id', userId)
        .maybeSingle();
      if (markErr) console.warn('password_set_at read failed, using the magic link:', markErr.message);
      else keepPassword = Boolean((mark as { password_set_at?: string | null } | null)?.password_set_at);
    } catch (e) {
      console.warn('password_set_at read threw, using the magic link:', e instanceof Error ? e.message : String(e));
    }
```

and run the whole Strategy A `try { … } catch { … }` only `if (!keepPassword)`. Strategy B is unchanged (it already runs when there is no session).

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @tricigo/api exec vitest run verify-otp`
Expected: all pass (8 existing + 3 new).

- [ ] **Step 5: Mark the password in the panel's reset page**

In `apps/admin/src/app/reset-password/page.tsx`, `handleSubmit`: keep the `data` of `updateUser` and, after the `updateError` check and before the global sign-out:

```ts
      const { data: updated, error: updateError } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (updateError) {
        setError(updateError.message);
        return;
      }

      // Phone logins (verify-otp) keep a password the person chose only when it is marked.
      if (updated.user) {
        const { error: markError } = await supabase
          .from('users')
          .update({ password_set_at: new Date().toISOString() })
          .eq('id', updated.user.id);
        if (markError) console.warn('[reset-password] password_set_at not saved:', markError.message);
      }
```

A signed-in user may update that column on their own row (`users_update_own`; `tg_users_protect_admin_fields` does not cover it; checked in prod on 2026-10-16).

- [ ] **Step 6: Type-check**

Run: `pnpm check-types` and the Edge Function type check from Task 5 Step 7 for `verify-otp`.
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/verify-otp/index.ts supabase/functions/verify-otp/index.test.ts apps/admin/src/app/reset-password/page.tsx
git commit -m "fix(auth): phone logins keep a password the person chose

verify-otp wrote its derived password whenever its sign-in failed, so a
password chosen with a team invitation code (or the panel's reset) was
lost on the next phone login. With users.password_set_at set, or
unreadable, it now mints the session with the magic link only.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Edge Function `team-invitation-code`

**Files:**
- Create: `supabase/functions/team-invitation-code/index.ts`
- Create: `supabase/functions/team-invitation-code/index.test.ts`
- Modify: `supabase/config.toml` (next to `[functions.team-digest-unsubscribe]`)
- Modify: `packages/api/vitest.config.ts` (the `include` list)

- [ ] **Step 1: Add the tests to the vitest include list**

In `packages/api/vitest.config.ts`, after `'../../supabase/functions/admin-delete-pending-account/*.test.ts',` add:

```ts
      // team-invitation-code (00664): supabase-js and the rate limiter replaced with vi.mock, Deno stubbed.
      '../../supabase/functions/team-invitation-code/*.test.ts',
```

- [ ] **Step 2: Write the failing handler test**

`supabase/functions/team-invitation-code/index.test.ts`:

```ts
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the real team-invitation-code handler. Replaced: supabase-js (imported from esm.sh,
// which vitest cannot load) with a client whose rpc and auth.admin calls the tests script;
// the rate limiter (DB-backed); and fetch, so the call to send-email is observed.
const limiter = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  rateLimitResponse: vi.fn(
    (retryAfterMs: number) =>
      new Response(JSON.stringify({ error: 'Too many requests. Try again later.' }), {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) },
      }),
  ),
}));
vi.mock('../_shared/rate-limiter.ts', () => limiter);

const sb = vi.hoisted(() => ({
  rpc: vi.fn(),
  createUser: vi.fn(),
  updateUserById: vi.fn(),
  // from(table).update(values).eq(column, value): the chosen-password mark.
  markUpdate: vi.fn(),
}));
vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => ({
  createClient: () => ({
    rpc: sb.rpc,
    from: (table: string) => ({
      update: (values: unknown) => ({ eq: (column: string, value: unknown) => sb.markUpdate(table, values, column, value) }),
    }),
    auth: { admin: { createUser: sb.createUser, updateUserById: sb.updateUserById } },
  }),
}));

// Fake key material: same shape as a real secret key, not a credential.
const SERVICE_KEY = 'sb_secret_TESTtestTESTtestTESTtest01';
const TOKEN = 'a'.repeat(64);
const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const NEW_ID = '00000000-0000-4000-8000-0000000000bb';
const ORIGIN = 'https://admin.tricigo.com';

const env: Record<string, string> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SERVICE_KEY }),
  ALLOWED_ORIGINS: `${ORIGIN},https://tricigo.com`,
};

const mail = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{"success":true}', { status: 200 }));

let handler: (req: Request) => Promise<Response>;

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (name: string) => env[name] },
    serve: (h: typeof handler) => {
      handler = h;
    },
  });
  vi.stubGlobal('fetch', mail);
  await import('./index.ts');
});

beforeEach(() => {
  limiter.rateLimit.mockReset();
  limiter.rateLimit.mockResolvedValue({ allowed: true, remaining: 1, retryAfterMs: 0 });
  limiter.rateLimitResponse.mockClear();
  sb.rpc.mockReset();
  sb.createUser.mockReset();
  sb.updateUserById.mockReset();
  sb.markUpdate.mockReset();
  sb.markUpdate.mockResolvedValue({ error: null });
  mail.mockReset();
  mail.mockImplementation(async () => new Response('{"success":true}', { status: 200 }));
});

/** Each RPC answers what the test gives it. */
function rpcAnswers(answers: Record<string, unknown>) {
  sb.rpc.mockImplementation(async (fn: string) => ({ data: answers[fn] ?? null, error: null }));
}

function post(body: unknown) {
  return handler(
    new Request('https://example.supabase.co/functions/v1/team-invitation-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'x-forwarded-for': '152.206.10.20' },
      body: JSON.stringify(body),
    }),
  );
}

const ISSUED = {
  result: 'issued', code: '048213', email: 'info@bacoagency.com', full_name: 'Baco', account_exists: false, expires_in_s: 600,
};
const CHECK_NEW = { result: 'ok', email: 'info@bacoagency.com', role: 'marketing', full_name: 'Baco', case: 'new', user_id: null };

describe('team-invitation-code', () => {
  it('answers CORS for the panel origin', async () => {
    const res = await handler(new Request('https://example.supabase.co/functions/v1/team-invitation-code', {
      method: 'OPTIONS', headers: { Origin: ORIGIN },
    }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  it('answers not_found for a malformed token without touching the database', async () => {
    const res = await post({ action: 'send', token: 'nope' });
    expect(await res.json()).toEqual({ result: 'not_found' });
    expect(sb.rpc).not.toHaveBeenCalled();
  });

  describe('send', () => {
    it('is limited per client IP before anything else', async () => {
      limiter.rateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 60_000 });
      const res = await post({ action: 'send', token: TOKEN });
      expect(res.status).toBe(429);
      expect(limiter.rateLimit).toHaveBeenCalledWith('team-code-send-ip:152.206.10.20', 10, 3_600_000);
      expect(sb.rpc).not.toHaveBeenCalled();
    });

    it('passes on a refusal from the database and mails nothing', async () => {
      rpcAnswers({ team_invitation_code_issue: { result: 'cooldown', retry_after_s: 42 } });
      const res = await post({ action: 'send', token: TOKEN });
      expect(await res.json()).toEqual({ result: 'cooldown', retry_after_s: 42 });
      expect(mail).not.toHaveBeenCalled();
    });

    it('mails the code through send-email and answers without the code or the address', async () => {
      rpcAnswers({ team_invitation_code_issue: ISSUED });
      const res = await post({ action: 'send', token: TOKEN });
      const body = await res.json();
      expect(body).toEqual({ result: 'sent', account_exists: false, expires_in_s: 600, invitee_name: 'Baco' });
      expect(JSON.stringify(body)).not.toContain('048213');
      expect(JSON.stringify(body)).not.toContain('bacoagency');
      expect(sb.rpc).toHaveBeenCalledWith('team_invitation_code_issue', { p_token: TOKEN });
      const [url, init] = mail.mock.calls[0];
      expect(url).toBe('https://example.supabase.co/functions/v1/send-email');
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${SERVICE_KEY}`);
      expect(JSON.parse(String(init?.body))).toEqual({
        template: 'team_invitation_code',
        recipient_email: 'info@bacoagency.com',
        data: { code: '048213', email: 'info@bacoagency.com' },
      });
    });

    it('answers send_failed when send-email refuses', async () => {
      rpcAnswers({ team_invitation_code_issue: ISSUED });
      mail.mockImplementation(async () => new Response('{"error":"x"}', { status: 500 }));
      expect(await (await post({ action: 'send', token: TOKEN })).json()).toEqual({ result: 'send_failed' });
    });

    it('answers 500 when the database fails', async () => {
      sb.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
      expect((await post({ action: 'send', token: TOKEN })).status).toBe(500);
    });
  });

  describe('verify', () => {
    const verify = (extra: Record<string, unknown> = {}) =>
      post({ action: 'verify', token: TOKEN, code: '048213', password: 'secreta123', full_name: 'Nina Baco', ...extra });

    it('is limited per client IP', async () => {
      limiter.rateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 60_000 });
      expect((await verify()).status).toBe(429);
      expect(limiter.rateLimit).toHaveBeenCalledWith('team-code-verify-ip:152.206.10.20', 30, 3_600_000);
    });

    it('refuses a bad password before spending the code', async () => {
      expect(await (await verify({ password: 'corta12' })).json()).toEqual({ result: 'bad_password' });
      expect(await (await verify({ password: 'x'.repeat(73) })).json()).toEqual({ result: 'bad_password' });
      expect(sb.rpc).not.toHaveBeenCalled();
    });

    it('refuses a name over 80 characters before spending the code', async () => {
      expect(await (await verify({ full_name: 'x'.repeat(81) })).json()).toEqual({ result: 'bad_name' });
      expect(sb.rpc).not.toHaveBeenCalled();
    });

    it('passes on a wrong code with the attempts left, and touches no account', async () => {
      rpcAnswers({ team_invitation_code_check: { result: 'wrong_code', attempts_left: 3 } });
      const body = await (await verify()).json();
      expect(body).toEqual({ result: 'wrong_code', attempts_left: 3 });
      expect(sb.createUser).not.toHaveBeenCalled();
      expect(sb.updateUserById).not.toHaveBeenCalled();
    });

    it('creates a new account with a confirmed address and accepts the invitation for it', async () => {
      rpcAnswers({
        team_invitation_code_check: CHECK_NEW,
        accept_team_invitation_by_code: { result: 'accepted', role: 'marketing' },
      });
      sb.createUser.mockResolvedValue({ data: { user: { id: NEW_ID } }, error: null });
      expect(await (await verify()).json()).toEqual({ result: 'accepted', email: 'info@bacoagency.com', role: 'marketing' });
      expect(sb.createUser).toHaveBeenCalledWith({
        email: 'info@bacoagency.com',
        password: 'secreta123',
        email_confirm: true,
        user_metadata: { full_name: 'Nina Baco' },
      });
      expect(sb.rpc).toHaveBeenCalledWith('accept_team_invitation_by_code', { p_token: TOKEN, p_user: NEW_ID });
    });

    it("uses the invitation's name when the form sends none", async () => {
      rpcAnswers({
        team_invitation_code_check: CHECK_NEW,
        accept_team_invitation_by_code: { result: 'accepted', role: 'marketing' },
      });
      sb.createUser.mockResolvedValue({ data: { user: { id: NEW_ID } }, error: null });
      await verify({ full_name: '   ' });
      expect(sb.createUser.mock.calls[0][0].user_metadata).toEqual({ full_name: 'Baco' });
    });

    it('sets the password on an existing account instead of creating one', async () => {
      rpcAnswers({
        team_invitation_code_check: { ...CHECK_NEW, case: 'proven', user_id: USER_ID },
        accept_team_invitation_by_code: { result: 'accepted', role: 'admin' },
      });
      sb.updateUserById.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
      expect(await (await verify()).json()).toEqual({ result: 'accepted', email: 'info@bacoagency.com', role: 'admin' });
      expect(sb.updateUserById).toHaveBeenCalledWith(USER_ID, { password: 'secreta123', email_confirm: true });
      expect(sb.createUser).not.toHaveBeenCalled();
      // The mark goes first, so a failure after the password write cannot leave it unmarked.
      expect(sb.markUpdate).toHaveBeenCalledWith('users', { password_set_at: expect.any(String) }, 'id', USER_ID);
      expect(sb.markUpdate.mock.invocationCallOrder[0]).toBeLessThan(sb.updateUserById.mock.invocationCallOrder[0]);
    });

    it('does not touch the password of an existing account when the mark cannot be written', async () => {
      rpcAnswers({ team_invitation_code_check: { ...CHECK_NEW, case: 'proven', user_id: USER_ID } });
      sb.markUpdate.mockResolvedValue({ error: { message: 'db down' } });
      expect(await (await verify()).json()).toEqual({ result: 'try_again' });
      expect(sb.updateUserById).not.toHaveBeenCalled();
      expect(sb.rpc).not.toHaveBeenCalledWith('accept_team_invitation_by_code', expect.anything());
    });

    it('answers weak_password when GoTrue refuses the password, and accepts nothing', async () => {
      rpcAnswers({ team_invitation_code_check: CHECK_NEW });
      sb.createUser.mockResolvedValue({ data: { user: null }, error: { code: 'weak_password', message: 'weak' } });
      expect(await (await verify()).json()).toEqual({ result: 'weak_password' });
      expect(sb.rpc).not.toHaveBeenCalledWith('accept_team_invitation_by_code', expect.anything());
    });

    it('answers try_again when GoTrue fails for another reason', async () => {
      rpcAnswers({ team_invitation_code_check: CHECK_NEW });
      sb.createUser.mockResolvedValue({ data: { user: null }, error: { code: 'email_exists', message: 'taken' } });
      expect(await (await verify()).json()).toEqual({ result: 'try_again' });
    });

    it('passes on a refusal from the accept step', async () => {
      rpcAnswers({
        team_invitation_code_check: { ...CHECK_NEW, case: 'password_only', user_id: USER_ID },
        accept_team_invitation_by_code: { result: 'canceled' },
      });
      sb.updateUserById.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
      expect(await (await verify()).json()).toEqual({ result: 'canceled' });
    });
  });

  it('refuses an unknown action', async () => {
    expect((await post({ action: 'other', token: TOKEN })).status).toBe(400);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm --filter @tricigo/api exec vitest run team-invitation-code`
Expected: FAIL, `Failed to resolve import "./index.ts"` (or `handler is not a function`).

- [ ] **Step 4: Write the Edge Function**

`supabase/functions/team-invitation-code/index.ts`:

```ts
// ============================================================
// TriciGo — team-invitation-code (00664)
//
// The second way to accept an admin panel invitation: a 6-digit code sent to
// the invited address. With it the person creates their account, or sets a
// password on the one that has that address, and gets the role.
//   { action: 'send', token }                               -> mails a code
//   { action: 'verify', token, code, password, full_name? } -> account + role
// verify_jwt = false: the caller has no session yet. The SQL functions
// (team_invitation_code_issue / _check, accept_team_invitation_by_code) decide
// everything about the invitation and the account; this function adds the
// per-IP limits, the e-mail through send-email and the GoTrue calls.
// Outcomes answer 200 { result, ... }, so the panel reads them from data.
// The code and the full address never go back to the caller, except the
// address after a right code (the page signs in with it).
// Spec: docs/superpowers/specs/2026-10-16-team-invitation-email-code-design.md
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';
import { getServiceKey } from '../_shared/service-key.ts';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').filter(Boolean);
const TOKEN_RE = /^[0-9a-f]{64}$/;
const HOUR_MS = 60 * 60 * 1000;

type Admin = ReturnType<typeof createClient>;

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

// The gateway sets x-forwarded-for; a forged value does not get past it (CLAUDE.md, 2026-10-06).
function clientIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

interface Issued {
  result?: string;
  code?: string;
  email?: string;
  full_name?: string;
  account_exists?: boolean;
  expires_in_s?: number;
  retry_after_s?: number;
}

interface Checked {
  result?: string;
  email?: string;
  role?: string;
  full_name?: string;
  case?: string;
  user_id?: string | null;
  attempts_left?: number;
}

async function send(req: Request, admin: Admin, url: string, key: string, token: string): Promise<Response> {
  const limit = await rateLimit(`team-code-send-ip:${clientIp(req)}`, 10, HOUR_MS);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterMs, corsHeaders(req));

  const { data, error } = await admin.rpc('team_invitation_code_issue', { p_token: token });
  if (error) throw new Error(`issue: ${error.message}`);
  const issued = (data ?? {}) as Issued;
  if (issued.result !== 'issued' || !issued.code || !issued.email) {
    return json(req, { result: issued.result ?? 'not_found', retry_after_s: issued.retry_after_s });
  }

  const mailed = await fetch(`${url}/functions/v1/send-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, apikey: key },
    body: JSON.stringify({
      template: 'team_invitation_code',
      recipient_email: issued.email,
      data: { code: issued.code, email: issued.email },
    }),
  }).catch(() => null);
  if (!mailed || !mailed.ok) {
    console.error('[team-invitation-code] send-email failed:', mailed?.status ?? 'network');
    return json(req, { result: 'send_failed' });
  }
  return json(req, {
    result: 'sent',
    account_exists: issued.account_exists === true,
    expires_in_s: issued.expires_in_s ?? 600,
    invitee_name: issued.full_name ?? '',
  });
}

function gotrueFailure(req: Request, err: { code?: string; message?: string } | null, step: string): Response {
  const code = err?.code ?? '';
  console.error(`[team-invitation-code] ${step} failed:`, code || err?.message || 'no user');
  return json(req, { result: code === 'weak_password' ? 'weak_password' : 'try_again' });
}

async function verify(req: Request, admin: Admin, token: string, body: Record<string, unknown>): Promise<Response> {
  const limit = await rateLimit(`team-code-verify-ip:${clientIp(req)}`, 30, HOUR_MS);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterMs, corsHeaders(req));

  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const fullName = typeof body.full_name === 'string' ? body.full_name.replace(/\s+/g, ' ').trim() : '';
  // Checked before the code: a refused password or name must not spend it.
  if (password.length < 8 || password.length > 72) return json(req, { result: 'bad_password' });
  if (fullName.length > 80) return json(req, { result: 'bad_name' });

  const { data, error } = await admin.rpc('team_invitation_code_check', { p_token: token, p_code: code });
  if (error) throw new Error(`check: ${error.message}`);
  const checked = (data ?? {}) as Checked;
  if (checked.result !== 'ok' || !checked.email) {
    return json(req, { result: checked.result ?? 'not_found', attempts_left: checked.attempts_left });
  }

  let userId: string;
  if (checked.case === 'new') {
    // The code is already used here: never fail on a missing name, fall back to the invitation's.
    const name = fullName || (checked.full_name ?? '').trim();
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: checked.email,
      password,
      email_confirm: true,
      user_metadata: { full_name: name },
    });
    if (createErr || !created?.user) return gotrueFailure(req, createErr, 'create');
    userId = created.user.id;
  } else if ((checked.case === 'proven' || checked.case === 'password_only') && checked.user_id) {
    // Mark the password as chosen BEFORE writing it: verify-otp (phone login) overwrites an
    // unmarked password, and a proven account usually has a phone. A mark without the new
    // password is harmless (phone logins just use the magic link). accept_ also sets it.
    const { error: markErr } = await admin
      .from('users')
      .update({ password_set_at: new Date().toISOString() })
      .eq('id', checked.user_id);
    if (markErr) {
      console.error('[team-invitation-code] password mark failed:', markErr.message);
      return json(req, { result: 'try_again' });
    }
    // email_confirm: since 2026-10-07 a GoTrue sign-up leaves the address unconfirmed, and an
    // unconfirmed address cannot sign in with a password.
    const { error: updateErr } = await admin.auth.admin.updateUserById(checked.user_id, { password, email_confirm: true });
    if (updateErr) return gotrueFailure(req, updateErr, 'update');
    userId = checked.user_id;
  } else {
    return json(req, { result: 'needs_google' });
  }

  const { data: acc, error: accErr } = await admin.rpc('accept_team_invitation_by_code', { p_token: token, p_user: userId });
  if (accErr) throw new Error(`accept: ${accErr.message}`);
  const accepted = (acc ?? {}) as { result?: string; role?: string };
  if (accepted.result !== 'accepted') return json(req, { result: accepted.result ?? 'try_again' });
  return json(req, { result: 'accepted', email: checked.email, role: accepted.role });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(req, { error: 'bad_request' }, 400);
  }
  if (body.action !== 'send' && body.action !== 'verify') return json(req, { error: 'bad_request' }, 400);
  const token = typeof body.token === 'string' ? body.token : '';
  if (!TOKEN_RE.test(token)) return json(req, { result: 'not_found' });

  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const key = getServiceKey();
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    return body.action === 'send' ? await send(req, admin, url, key, token) : await verify(req, admin, token, body);
  } catch (err) {
    console.error('[team-invitation-code] failed:', err instanceof Error ? err.message : String(err));
    return json(req, { error: 'internal' }, 500);
  }
});
```

- [ ] **Step 5: Run the handler tests**

Run: `pnpm --filter @tricigo/api exec vitest run team-invitation-code`
Expected: PASS (35 tests after the review fixes; the test file in this section is the first version). Note the order in the handler: the action check comes before the token check, so `refuses an unknown action` gets 400 even with a valid token.

- [ ] **Step 6: Register `verify_jwt = false`**

In `supabase/config.toml`, after the two lines of `[functions.team-digest-unsubscribe]` add:

```toml

[functions.team-invitation-code]
verify_jwt = false
```

- [ ] **Step 7: Type-check the function as CI does**

Run: `pnpm check:ef-types`
Expected: no new TS2304/2305/2307/2552 for `team-invitation-code`. From the sandbox `esm.sh` is blocked: then check with the throwaway tsconfig described in CLAUDE.md § "`pg_cron` + `net.http_post` es CIEGO…" ("Un `index.ts` entero también se puede chequear sin Deno") and say which way was used in the commit.

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/team-invitation-code/index.ts supabase/functions/team-invitation-code/index.test.ts supabase/config.toml packages/api/vitest.config.ts
git commit -m "feat(team): Edge Function to accept an invitation with an e-mail code

team-invitation-code (verify_jwt = false) mails a code with
team_invitation_code_issue and send-email, and on verify checks it,
creates the GoTrue account with a confirmed address or sets the
password on the existing one, and accepts with
accept_team_invitation_by_code. 10 sends and 30 verifies an hour per
client IP. The code and the address never go back to the caller, except
the address after a right code.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Answers and messages in `@tricigo/utils`, service methods in `@tricigo/api`

**Files:**
- Modify: `packages/utils/src/teamInvitation.ts` (append)
- Modify: `packages/utils/src/__tests__/teamInvitation.test.ts` (append)
- Modify: `packages/api/src/services/team.service.ts`
- Modify: `packages/api/src/index.ts:108-117`
- Modify: `packages/api/src/services/__tests__/team.test.ts`

- [ ] **Step 1: Write the failing utils tests**

Append to `packages/utils/src/__tests__/teamInvitation.test.ts`. Merge the import line below into the file's existing import from `'../teamInvitation'` instead of adding a second one:

```ts
import { invitationCodeMessage, parseInvitationCodeAnswer } from '../teamInvitation';

describe('parseInvitationCodeAnswer', () => {
  it('reads the result, the seconds and the attempts', () => {
    expect(parseInvitationCodeAnswer({ result: 'cooldown', retry_after_s: 42 })).toEqual({
      result: 'cooldown',
      retryAfterS: 42,
      attemptsLeft: null,
    });
    expect(parseInvitationCodeAnswer({ result: 'wrong_code', attempts_left: 3 })).toEqual({
      result: 'wrong_code',
      retryAfterS: null,
      attemptsLeft: 3,
    });
  });

  it('turns anything unexpected into error', () => {
    expect(parseInvitationCodeAnswer(null).result).toBe('error');
    expect(parseInvitationCodeAnswer({ result: 'pwned' }).result).toBe('error');
    expect(parseInvitationCodeAnswer({ result: 'cooldown', retry_after_s: -1 }).retryAfterS).toBeNull();
  });
});

describe('invitationCodeMessage', () => {
  const msg = (result: string, extra: Record<string, unknown> = {}) =>
    invitationCodeMessage(parseInvitationCodeAnswer({ result, ...extra }));

  it('says how long to wait', () => {
    expect(msg('cooldown', { retry_after_s: 42 })).toBe('Espera 42 segundos para pedir otro código.');
    expect(msg('cooldown', { retry_after_s: 1 })).toBe('Espera un momento para pedir otro código.');
    expect(msg('too_many_hour', { retry_after_s: 61 })).toBe(
      'Pediste muchos códigos en la última hora. Vuelve a intentarlo en 2 minutos.',
    );
    expect(msg('too_many_hour', { retry_after_s: 30 })).toBe(
      'Pediste muchos códigos en la última hora. Vuelve a intentarlo en 1 minuto.',
    );
    expect(msg('too_many_day')).toBe('Ya pediste 10 códigos hoy. Vuelve a intentarlo mañana.');
  });

  it('counts the attempts left', () => {
    expect(msg('wrong_code', { attempts_left: 3 })).toBe('El código no es correcto. Te quedan 3 intentos.');
    expect(msg('wrong_code', { attempts_left: 1 })).toBe('El código no es correcto. Te queda 1 intento.');
  });

  it('explains the refusals', () => {
    expect(msg('needs_google')).toBe(
      'Esta cuenta también entra con un teléfono. Para aceptar, entra con Google con este correo.',
    );
    expect(msg('blocked')).toBe('Tu cuenta está bloqueada.');
    expect(msg('locked')).toBe('Probaste demasiadas veces con este código. Pide uno nuevo.');
    expect(msg('expired')).toBe('La invitación venció. Pídele a quien te invitó que te mande una nueva.');
    expect(msg('try_again')).toBe('Algo cambió mientras preparábamos tu cuenta. Pide un código nuevo y vuelve a intentarlo.');
    expect(msg('weak_password')).toBe('Esa contraseña es muy fácil de adivinar. Elige otra y pide un código nuevo.');
    expect(msg('error')).toBe('Algo salió mal. Intenta de nuevo.');
  });
});
```

Run: `pnpm --filter @tricigo/utils exec vitest run teamInvitation`
Expected: FAIL, `invitationCodeMessage is not a function` / not exported.

- [ ] **Step 2: Implement in `packages/utils/src/teamInvitation.ts`**

Append:

```ts
/** What the Edge Function team-invitation-code answers (00664). */
export const INVITATION_CODE_RESULTS = [
  'sent',
  'accepted',
  'cooldown',
  'too_many_hour',
  'too_many_day',
  'send_failed',
  'wrong_code',
  'locked',
  'code_expired',
  'no_code',
  'bad_password',
  'bad_name',
  'weak_password',
  'needs_google',
  'blocked',
  'internal_address',
  'expired',
  'canceled',
  'used',
  'not_found',
  'wrong_account',
  'no_account',
  'try_again',
  'rate_limited',
  'error',
] as const;

export type InvitationCodeResult = (typeof INVITATION_CODE_RESULTS)[number];

export interface InvitationCodeAnswer {
  result: InvitationCodeResult;
  retryAfterS: number | null;
  attemptsLeft: number | null;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Reads what team-invitation-code answered. Anything unexpected is 'error'. */
export function parseInvitationCodeAnswer(raw: unknown): InvitationCodeAnswer {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const result = (INVITATION_CODE_RESULTS as readonly string[]).includes(obj.result as string)
    ? (obj.result as InvitationCodeResult)
    : 'error';
  return { result, retryAfterS: nonNegativeInt(obj.retry_after_s), attemptsLeft: nonNegativeInt(obj.attempts_left) };
}

/** The text the invitation page shows for an answer that is not a success. */
export function invitationCodeMessage(answer: InvitationCodeAnswer): string {
  const seconds = answer.retryAfterS;
  switch (answer.result) {
    case 'cooldown':
      return seconds && seconds > 1
        ? `Espera ${seconds} segundos para pedir otro código.`
        : 'Espera un momento para pedir otro código.';
    case 'too_many_hour': {
      const minutes = seconds ? Math.max(1, Math.ceil(seconds / 60)) : null;
      return minutes
        ? `Pediste muchos códigos en la última hora. Vuelve a intentarlo en ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}.`
        : 'Pediste muchos códigos en la última hora. Vuelve a intentarlo más tarde.';
    }
    case 'too_many_day':
      return 'Ya pediste 10 códigos hoy. Vuelve a intentarlo mañana.';
    case 'send_failed':
      return 'No pudimos mandar el correo. Intenta de nuevo en un rato.';
    case 'wrong_code': {
      const left = answer.attemptsLeft;
      if (left === 1) return 'El código no es correcto. Te queda 1 intento.';
      return left ? `El código no es correcto. Te quedan ${left} intentos.` : 'El código no es correcto.';
    }
    case 'locked':
      return 'Probaste demasiadas veces con este código. Pide uno nuevo.';
    case 'code_expired':
      return 'El código venció. Pide uno nuevo.';
    case 'no_code':
      return 'Primero pide un código.';
    case 'bad_password':
      return 'La contraseña tiene que tener entre 8 y 72 caracteres.';
    case 'bad_name':
      return 'El nombre puede tener hasta 80 caracteres.';
    case 'weak_password':
      // The code is already spent when GoTrue refuses the password.
      return 'Esa contraseña es muy fácil de adivinar. Elige otra y pide un código nuevo.';
    case 'needs_google':
      return 'Esta cuenta también entra con un teléfono. Para aceptar, entra con Google con este correo.';
    case 'blocked':
      return 'Tu cuenta está bloqueada.';
    case 'internal_address':
      return 'Esta invitación no se puede aceptar con un código. Entra con Google.';
    case 'expired':
      return 'La invitación venció. Pídele a quien te invitó que te mande una nueva.';
    case 'canceled':
      return 'La invitación fue cancelada. Si crees que es un error, pídele a quien te invitó una nueva.';
    case 'used':
      return 'Esta invitación ya se usó. Entra desde la página de inicio de sesión.';
    case 'not_found':
      return 'No encontramos esa invitación. Revisa el enlace o pide uno nuevo.';
    case 'rate_limited':
      return 'Hubo demasiados intentos desde esta conexión. Espera un rato y vuelve a intentarlo.';
    case 'wrong_account':
    case 'no_account':
    case 'try_again':
      return 'Algo cambió mientras preparábamos tu cuenta. Pide un código nuevo y vuelve a intentarlo.';
    default:
      return 'Algo salió mal. Intenta de nuevo.';
  }
}
```

Run: `pnpm --filter @tricigo/utils exec vitest run teamInvitation copyTuteo copyAccents`
Expected: PASS.

- [ ] **Step 3: Write the failing service tests**

In `packages/api/src/services/__tests__/team.test.ts`, change the mock at the top to:

```ts
const mockRpc = vi.fn();
const mockInvoke = vi.fn();

vi.mock('../../client', () => ({
  getSupabaseClient: () => ({ rpc: mockRpc, functions: { invoke: mockInvoke } }),
}));
```

and append:

```ts
describe('teamService invitation codes', () => {
  const TOKEN = 'a'.repeat(64);

  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it('requestInvitationCode asks the function to send a code', async () => {
    mockInvoke.mockResolvedValueOnce({
      data: { result: 'sent', account_exists: true, expires_in_s: 600, invitee_name: 'Nina' },
      error: null,
    });
    await expect(teamService.requestInvitationCode(TOKEN)).resolves.toEqual({
      accountExists: true,
      expiresInS: 600,
      inviteeName: 'Nina',
    });
    expect(mockInvoke).toHaveBeenCalledWith('team-invitation-code', { body: { action: 'send', token: TOKEN } });
  });

  it('throws a refusal with its Spanish message and the seconds to wait', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { result: 'cooldown', retry_after_s: 42 }, error: null });
    const err = await teamService.requestInvitationCode(TOKEN).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      message: 'Espera 42 segundos para pedir otro código.',
      code: 'invitation_cooldown',
      statusCode: 400,
      details: { result: 'cooldown', retryAfterS: 42 },
    });
  });

  it('reads a 429 as too many attempts from this connection', async () => {
    mockInvoke.mockResolvedValueOnce({ data: null, error: { context: new Response('{}', { status: 429 }) } });
    await expect(teamService.requestInvitationCode(TOKEN)).rejects.toMatchObject({ code: 'invitation_rate_limited' });
  });

  it('acceptInvitationWithCode sends code, password and name, and answers the address and role', async () => {
    mockInvoke.mockResolvedValueOnce({
      data: { result: 'accepted', email: 'info@bacoagency.com', role: 'marketing' },
      error: null,
    });
    await expect(
      teamService.acceptInvitationWithCode({ token: TOKEN, code: ' 048213 ', password: 'secreta123', fullName: ' Nina ' }),
    ).resolves.toEqual({ email: 'info@bacoagency.com', role: 'marketing' });
    expect(mockInvoke).toHaveBeenCalledWith('team-invitation-code', {
      body: { action: 'verify', token: TOKEN, code: '048213', password: 'secreta123', full_name: 'Nina' },
    });
  });

  it('leaves a blank name out', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { result: 'accepted', email: 'a@b.co', role: 'admin' }, error: null });
    await teamService.acceptInvitationWithCode({ token: TOKEN, code: '048213', password: 'secreta123', fullName: '  ' });
    expect(mockInvoke.mock.calls[0][1].body).not.toHaveProperty('full_name');
  });

  it('says how many attempts are left on a wrong code', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { result: 'wrong_code', attempts_left: 2 }, error: null });
    await expect(
      teamService.acceptInvitationWithCode({ token: TOKEN, code: '000000', password: 'secreta123' }),
    ).rejects.toMatchObject({ message: 'El código no es correcto. Te quedan 2 intentos.', code: 'invitation_wrong_code' });
  });

  it('treats an accepted answer without address or panel role as a failure', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { result: 'accepted', role: 'customer' }, error: null });
    await expect(
      teamService.acceptInvitationWithCode({ token: TOKEN, code: '048213', password: 'secreta123' }),
    ).rejects.toMatchObject({ code: 'invitation_try_again' });
  });
});
```

Run: `pnpm --filter @tricigo/api exec vitest run services/__tests__/team.test`
Expected: FAIL, `teamService.requestInvitationCode is not a function`.

- [ ] **Step 4: Implement in `packages/api/src/services/team.service.ts`**

Change the first import to:

```ts
import {
  invitationCodeMessage,
  parseAcceptOutcome,
  parseInvitationCodeAnswer,
  type AcceptInvitationOutcome,
  type InvitationCodeAnswer,
} from '@tricigo/utils/teamInvitation';
import { isPanelRole, type PanelRole } from '@tricigo/utils/adminPanelAccess';
```

After the `PublicInvitation` interface add:

```ts
export interface InvitationCodeSent {
  /** The invited address already has a TriciGo account: the form does not ask for the name. */
  accountExists: boolean;
  expiresInS: number;
  /** The name the super_admin typed in the invitation, to prefill the form ('' when none). */
  inviteeName: string;
}

export interface InvitationCodeAccepted {
  /** The full invited address: the page signs in with it and the chosen password. */
  email: string;
  role: PanelRole;
}
```

After the `call` function add:

```ts
/** An answer of team-invitation-code that is not a success, as a 400 AppError with its Spanish text. */
function invitationCodeError(answer: InvitationCodeAnswer): AppError {
  return new AppError(invitationCodeMessage(answer), `invitation_${answer.result}`, 400, {
    result: answer.result,
    retryAfterS: answer.retryAfterS,
  });
}

async function invokeInvitationCode(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await getSupabaseClient().functions.invoke('team-invitation-code', { body });
  if (error) {
    const status = (error as { context?: Response }).context?.status;
    throw invitationCodeError({ result: status === 429 ? 'rate_limited' : 'error', retryAfterS: null, attemptsLeft: null });
  }
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}
```

Inside `teamService`, after `accept(...)`, add:

```ts
  /** Mails a code to the invited address (00664). Works without a session. */
  async requestInvitationCode(token: string): Promise<InvitationCodeSent> {
    const raw = await invokeInvitationCode({ action: 'send', token });
    const answer = parseInvitationCodeAnswer(raw);
    if (answer.result !== 'sent') throw invitationCodeError(answer);
    return {
      accountExists: raw.account_exists === true,
      expiresInS: typeof raw.expires_in_s === 'number' ? raw.expires_in_s : 600,
      inviteeName: typeof raw.invitee_name === 'string' ? raw.invitee_name : '',
    };
  },

  /** Checks the code, creates the account or sets its password, and accepts the invitation. */
  async acceptInvitationWithCode(input: {
    token: string;
    code: string;
    password: string;
    fullName?: string | null;
  }): Promise<InvitationCodeAccepted> {
    const body: Record<string, unknown> = {
      action: 'verify',
      token: input.token,
      code: input.code.trim(),
      password: input.password,
    };
    const name = input.fullName?.trim();
    if (name) body.full_name = name;
    const raw = await invokeInvitationCode(body);
    const answer = parseInvitationCodeAnswer(raw);
    if (answer.result !== 'accepted') throw invitationCodeError(answer);
    if (typeof raw.email !== 'string' || !raw.email || !isPanelRole(raw.role)) {
      throw invitationCodeError({ ...answer, result: 'try_again' });
    }
    return { email: raw.email, role: raw.role };
  },
```

In `packages/api/src/index.ts`, add the two types to the `team.service` export block:

```ts
  type PublicInvitationStatus,
  type InvitationCodeSent,
  type InvitationCodeAccepted,
} from './services/team.service';
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @tricigo/api exec vitest run services/__tests__/team.test`
Expected: PASS (old and new tests).

- [ ] **Step 6: Commit**

```bash
git add packages/utils/src/teamInvitation.ts packages/utils/src/__tests__/teamInvitation.test.ts packages/api/src/services/team.service.ts packages/api/src/index.ts packages/api/src/services/__tests__/team.test.ts
git commit -m "feat(team): request an invitation code and accept with it

parseInvitationCodeAnswer and invitationCodeMessage in
@tricigo/utils/teamInvitation turn each answer of team-invitation-code
into Spanish text; teamService.requestInvitationCode and
acceptInvitationWithCode call the function and throw those as 400
AppErrors (invitation_<result>).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The form on the invitation page

**Files:**
- Create: `apps/admin/src/app/invitacion/[token]/InvitationCodeForm.tsx`
- Modify: `apps/admin/src/app/invitacion/[token]/page.tsx`
- Modify: `packages/i18n/src/locales/es/admin.json`, `en/admin.json`, `pt/admin.json` (the `invitation` block, line ~2660)

The admin app has no component test setup (CLAUDE.md: "el admin no tiene vitest"); this task is verified with `pnpm check-types`, the copy guards and the real run in Task 9.

- [ ] **Step 1: Write the form**

`apps/admin/src/app/invitacion/[token]/InvitationCodeForm.tsx`:

```tsx
'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { teamService } from '@tricigo/api';
import { panelHome } from '@tricigo/utils/adminPanelAccess';
import { createBrowserClient } from '@/lib/supabase-server';

/** Seconds before "Enviar otro código" comes back: the server's own cooldown (00664). */
const RESEND_AFTER_S = 60;

const INPUT =
  'w-full px-4 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-primary-500 text-sm';
const PRIMARY =
  'w-full py-2.5 bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-medium rounded-lg text-sm transition-colors';
const LABEL = 'block text-sm font-medium text-neutral-300 mb-1';

interface InvitationCodeFormProps {
  token: string;
  emailMasked: string;
}

/**
 * The second way to accept an invitation (00664): a code sent to the invited address and a
 * password. On success it signs in with that password and goes to the person's panel home.
 */
export function InvitationCodeForm({ token, emailMasked }: InvitationCodeFormProps) {
  const { t } = useTranslation('admin');
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [accountExists, setAccountExists] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [wait, setWait] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (wait <= 0) return;
    const id = window.setTimeout(() => setWait((s) => s - 1), 1000);
    return () => window.clearTimeout(id);
  }, [wait]);

  const failure = (err: unknown) =>
    err instanceof Error && err.message
      ? err.message
      : t('invitation.code_error', { defaultValue: 'Algo salió mal. Intenta de nuevo.' });

  const sendCode = async () => {
    setSending(true);
    setError('');
    try {
      const res = await teamService.requestInvitationCode(token);
      setAccountExists(res.accountExists);
      if (res.inviteeName) setName((current) => current || res.inviteeName);
      setSent(true);
      setWait(RESEND_AFTER_S);
    } catch (err) {
      setError(failure(err));
      const retry = (err as { details?: { retryAfterS?: number | null } }).details?.retryAfterS;
      if (typeof retry === 'number' && retry > 0 && retry <= RESEND_AFTER_S) setWait(retry);
    } finally {
      setSending(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!/^\d{6}$/.test(code.replace(/\s+/g, ''))) {
      setError(t('invitation.code_missing', { defaultValue: 'Escribe el código de 6 dígitos.' }));
      return;
    }
    if (!accountExists && !name.trim()) {
      setError(t('invitation.code_name_missing', { defaultValue: 'Escribe tu nombre.' }));
      return;
    }
    if (password.length < 8) {
      setError(t('invitation.code_too_short', { defaultValue: 'La contraseña tiene que tener al menos 8 caracteres.' }));
      return;
    }
    // GoTrue (bcrypt) counts bytes, and the server refuses more than 72 before spending the code.
    if (new TextEncoder().encode(password).length > 72) {
      setError(t('invitation.code_too_long', { defaultValue: 'La contraseña es demasiado larga.' }));
      return;
    }
    if (password !== repeat) {
      setError(t('invitation.code_mismatch', { defaultValue: 'Las contraseñas no coinciden.' }));
      return;
    }
    setSubmitting(true);
    try {
      const { email, role } = await teamService.acceptInvitationWithCode({
        token,
        code,
        password,
        fullName: accountExists ? null : name,
      });
      const { error: signInError } = await createBrowserClient().auth.signInWithPassword({ email, password });
      if (signInError) {
        setNotice(
          t('invitation.code_signin_fallback', {
            defaultValue:
              'Tu cuenta quedó lista, pero no pudimos iniciar sesión. Entra en la página de inicio de sesión con tu correo y tu contraseña.',
          }),
        );
        return;
      }
      window.location.assign(panelHome(role));
    } catch (err) {
      setError(failure(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-lg border border-neutral-700 py-2.5 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-800"
      >
        {t('invitation.code_option', { defaultValue: 'Crear cuenta con un código' })}
      </button>
    );
  }

  return (
    <div className="space-y-3 border-t border-neutral-800 pt-4">
      {!sent ? (
        <>
          <p>
            {t('invitation.code_intro', {
              defaultValue: 'Te mandamos un código de 6 dígitos a {{email}}.',
              email: emailMasked,
            })}
          </p>
          <button type="button" onClick={() => void sendCode()} disabled={sending} className={PRIMARY}>
            {sending
              ? t('invitation.code_sending', { defaultValue: 'Enviando…' })
              : t('invitation.code_send', { defaultValue: 'Enviar código' })}
          </button>
        </>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="space-y-3">
          <p>
            {t('invitation.code_sent', {
              defaultValue: 'Te mandamos el código a {{email}}. Vence en 10 minutos.',
              email: emailMasked,
            })}
          </p>
          {accountExists && (
            <p className="text-neutral-400">
              {t('invitation.code_existing', {
                defaultValue: 'Ya hay una cuenta con este correo: elige una contraseña nueva para entrar.',
              })}
            </p>
          )}
          <div>
            <label htmlFor="invite-code" className={LABEL}>
              {t('invitation.code_label', { defaultValue: 'Código' })}
            </label>
            <input
              id="invite-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              className={INPUT}
            />
          </div>
          {!accountExists && (
            <div>
              <label htmlFor="invite-name" className={LABEL}>
                {t('invitation.code_name_label', { defaultValue: 'Tu nombre' })}
              </label>
              <input
                id="invite-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                maxLength={80}
                className={INPUT}
              />
            </div>
          )}
          <div>
            <label htmlFor="invite-password" className={LABEL}>
              {t('invitation.code_password_label', { defaultValue: 'Contraseña' })}
            </label>
            <input
              id="invite-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              maxLength={72}
              className={INPUT}
            />
            <p className="mt-1 text-xs text-neutral-500">
              {t('invitation.code_password_hint', { defaultValue: 'Al menos 8 caracteres.' })}
            </p>
          </div>
          <div>
            <label htmlFor="invite-repeat" className={LABEL}>
              {t('invitation.code_repeat_label', { defaultValue: 'Repite la contraseña' })}
            </label>
            <input
              id="invite-repeat"
              type="password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              autoComplete="new-password"
              maxLength={72}
              className={INPUT}
            />
          </div>
          <button type="submit" disabled={submitting} className={PRIMARY}>
            {submitting
              ? t('invitation.code_submitting', { defaultValue: 'Entrando…' })
              : t('invitation.code_submit', { defaultValue: 'Crear cuenta y entrar' })}
          </button>
          <button
            type="button"
            onClick={() => void sendCode()}
            disabled={sending || wait > 0}
            className="w-full text-sm text-neutral-400 hover:text-white disabled:opacity-50"
          >
            {wait > 0
              ? t('invitation.code_resend_in', { defaultValue: 'Enviar otro código ({{s}} s)', s: wait })
              : t('invitation.code_resend', { defaultValue: 'Enviar otro código' })}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-neutral-300">
          {notice}{' '}
          <a href="/login" className="text-primary-400 hover:text-primary-300">
            {t('invitation.code_go_login', { defaultValue: 'Ir a iniciar sesión' })}
          </a>
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Put it on the page**

In `apps/admin/src/app/invitacion/[token]/page.tsx`:

- Add `import { InvitationCodeForm } from './InvitationCodeForm';` after the `GoogleIcon` import.
- In the header comment, change "and signs in with Google." to "and signs in with Google, or accepts with a code sent to the invited address (00664)."
- Change the `use_google` default to: `'Entra con la cuenta de Google de {{email}}, o crea tu cuenta con un código que te mandamos a esa dirección.'`
- After the closing `</button>` of the Google button (inside the `pending` fragment) add:

```tsx
              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-neutral-700" />
                <span className="text-xs uppercase text-neutral-500">{t('login.or_divider')}</span>
                <div className="h-px flex-1 bg-neutral-700" />
              </div>
              <InvitationCodeForm token={token} emailMasked={invitation.email_masked ?? ''} />
```

(`login.or_divider` already exists; the login page uses it.)

- [ ] **Step 3: Add the text to the three locales**

In each `packages/i18n/src/locales/<lang>/admin.json`, inside `"invitation"`: replace the `use_google` value, and after the `"sign_in": ...` line add the `code_*` keys. Spanish:

```json
    "use_google": "Entra con la cuenta de Google de {{email}}, o crea tu cuenta con un código que te mandamos a esa dirección.",
```
```json
    "code_option": "Crear cuenta con un código",
    "code_intro": "Te mandamos un código de 6 dígitos a {{email}}.",
    "code_send": "Enviar código",
    "code_sending": "Enviando…",
    "code_sent": "Te mandamos el código a {{email}}. Vence en 10 minutos.",
    "code_existing": "Ya hay una cuenta con este correo: elige una contraseña nueva para entrar.",
    "code_label": "Código",
    "code_name_label": "Tu nombre",
    "code_password_label": "Contraseña",
    "code_password_hint": "Al menos 8 caracteres.",
    "code_repeat_label": "Repite la contraseña",
    "code_submit": "Crear cuenta y entrar",
    "code_submitting": "Entrando…",
    "code_resend": "Enviar otro código",
    "code_resend_in": "Enviar otro código ({{s}} s)",
    "code_missing": "Escribe el código de 6 dígitos.",
    "code_name_missing": "Escribe tu nombre.",
    "code_too_short": "La contraseña tiene que tener al menos 8 caracteres.",
    "code_too_long": "La contraseña es demasiado larga.",
    "code_mismatch": "Las contraseñas no coinciden.",
    "code_signin_fallback": "Tu cuenta quedó lista, pero no pudimos iniciar sesión. Entra en la página de inicio de sesión con tu correo y tu contraseña.",
    "code_go_login": "Ir a iniciar sesión",
    "code_error": "Algo salió mal. Intenta de nuevo.",
```

English:

```json
    "use_google": "Sign in with the Google account of {{email}}, or create your account with a code we send to that address.",
```
```json
    "code_option": "Create an account with a code",
    "code_intro": "We will send a 6-digit code to {{email}}.",
    "code_send": "Send code",
    "code_sending": "Sending…",
    "code_sent": "We sent the code to {{email}}. It expires in 10 minutes.",
    "code_existing": "There is already an account with this e-mail: choose a new password to sign in.",
    "code_label": "Code",
    "code_name_label": "Your name",
    "code_password_label": "Password",
    "code_password_hint": "At least 8 characters.",
    "code_repeat_label": "Repeat the password",
    "code_submit": "Create account and sign in",
    "code_submitting": "Signing in…",
    "code_resend": "Send another code",
    "code_resend_in": "Send another code ({{s}} s)",
    "code_missing": "Enter the 6-digit code.",
    "code_name_missing": "Enter your name.",
    "code_too_short": "The password must have at least 8 characters.",
    "code_too_long": "The password is too long.",
    "code_mismatch": "The passwords do not match.",
    "code_signin_fallback": "Your account is ready, but we could not sign you in. Sign in on the login page with your e-mail and password.",
    "code_go_login": "Go to sign in",
    "code_error": "Something went wrong. Try again.",
```

Portuguese:

```json
    "use_google": "Entre com a conta do Google de {{email}}, ou crie sua conta com um código que enviamos para esse endereço.",
```
```json
    "code_option": "Criar conta com um código",
    "code_intro": "Vamos enviar um código de 6 dígitos para {{email}}.",
    "code_send": "Enviar código",
    "code_sending": "Enviando…",
    "code_sent": "Enviamos o código para {{email}}. Ele vence em 10 minutos.",
    "code_existing": "Já existe uma conta com este e-mail: escolha uma nova senha para entrar.",
    "code_label": "Código",
    "code_name_label": "Seu nome",
    "code_password_label": "Senha",
    "code_password_hint": "Pelo menos 8 caracteres.",
    "code_repeat_label": "Repita a senha",
    "code_submit": "Criar conta e entrar",
    "code_submitting": "Entrando…",
    "code_resend": "Enviar outro código",
    "code_resend_in": "Enviar outro código ({{s}} s)",
    "code_missing": "Digite o código de 6 dígitos.",
    "code_name_missing": "Digite seu nome.",
    "code_too_short": "A senha precisa ter pelo menos 8 caracteres.",
    "code_too_long": "A senha é longa demais.",
    "code_mismatch": "As senhas não coincidem.",
    "code_signin_fallback": "Sua conta está pronta, mas não conseguimos iniciar a sessão. Entre pela página de login com seu e-mail e sua senha.",
    "code_go_login": "Ir para o login",
    "code_error": "Algo deu errado. Tente de novo.",
```

Check the three files still parse: `node -e "for (const l of ['es','en','pt']) JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/'+l+'/admin.json','utf8'))"` → no output.

- [ ] **Step 4: Type-check and run the copy guards**

```bash
pnpm check-types
pnpm --filter @tricigo/utils exec vitest run copyTuteo copyAccents
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add "apps/admin/src/app/invitacion/[token]/InvitationCodeForm.tsx" "apps/admin/src/app/invitacion/[token]/page.tsx" packages/i18n/src/locales/es/admin.json packages/i18n/src/locales/en/admin.json packages/i18n/src/locales/pt/admin.json
git commit -m "feat(admin): accept an invitation with a code on the invitation page

Under 'Entrar con Google', 'Crear cuenta con un código' mails a code to
the invited address and asks for it, the name (new accounts) and a
password; on success it signs in with that password and goes to the
panel home of the role.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Documentation and full verification

**Files:**
- Modify: `CLAUDE.md` (section `### Equipo del panel: invitaciones (00661)`)

Ask the owner first what to do with the uncommitted release notes in `CLAUDE.md` (see "Before starting"). Do not stage them with this task.

- [ ] **Step 1: Document the feature**

At the end of the bullet list of `### Equipo del panel: invitaciones (00661)` in `CLAUDE.md`, add:

```markdown
- **Código por correo (00664).** Además de Google, la invitación se acepta con un código de 6 dígitos que la Edge Function `team-invitation-code` (`verify_jwt = false`) manda a la dirección invitada desde `noreply@tricigo.com` (plantilla `team_invitation_code`). Con el código, la persona elige una contraseña: se crea la cuenta con el correo confirmado, o se le pone esa contraseña a la que ya tiene la dirección como `auth.users.email`; se cierran todas sus sesiones y recibe el rol. Después entra con correo y contraseña. Spec: `docs/superpowers/specs/2026-10-16-team-invitation-email-code-design.md`. Ensayo: `supabase/tests/00664/run.sh`.
- **Qué cuenta puede recibir el rol con código** (`_team_code_account`): `new`, `proven` (Google o Apple verificaron esa misma dirección; su teléfono es del mismo dueño) y `password_only` (solo correo y contraseña). Se rechazan `needs_google` (sin esa prueba y con un teléfono, confirmado o no, u otra identidad: quien tenga ese teléfono podría entrar al panel por la app; también cuando ninguna cuenta entra con la dirección pero una identidad de alguna la tiene) y `blocked`. El correo del perfil (`users.email`) no cuenta. Aceptar marca `users.password_set_at` y, si `users.email` es la dirección invitada, `users.email_verified_at`.
- **Límites:** 6 dígitos, 10 minutos, un solo uso y 5 intentos; 60 s entre códigos, 5 por hora y 10 por día por invitación (`rate_limits`, claves `team-code-hour:<id>` y `team-code-day:<id>`); por IP, 10 envíos y 30 verificaciones por hora. El código se guarda como HMAC con la sal de `team_invitation_code_salt`; esa tabla y `team_invitation_codes` son tablas-candado.
- **Una contraseña elegida sobrevive al login por teléfono.** Con `users.password_set_at` puesto (o si no se puede leer), `verify-otp` no prueba ni escribe su contraseña derivada: entra por enlace mágico. La marcan la aceptación con código, `set-password-after-otp` y `/reset-password` del panel. Sin la marca, todo sigue como antes.
- **Si algo falla a mitad de camino** queda, como mucho, una cuenta sin rol: la persona pide otro código y el segundo intento la completa (cae en `password_only`).
- **Diagnóstico de un código que no llega o no sirve:**
  ```sql
  SELECT i.email, i.status, c.attempts, c.sent_at, c.expires_at
  FROM team_invitations i LEFT JOIN team_invitation_codes c ON c.invitation_id = i.id
  ORDER BY i.created_at DESC LIMIT 10;
  ```
  más los logs de `team-invitation-code` (`[team-invitation-code] ... failed`). Una aceptación con código deja `admin_actions.new_values.method = 'email_code'`.
```

In `### Login en una app deslogueaba la otra` of `CLAUDE.md`, replace the sentence that starts with "Conflicto latente documentado en el código" by:

```markdown
Una contraseña elegida ya no se pisa: desde 00664, con `users.password_set_at` puesto `verify-otp` entra por enlace mágico (Strategy B) y no escribe la contraseña derivada.
```

- [ ] **Step 2: Run everything**

```bash
bash supabase/tests/00664/run.sh supabase/migrations/00664_team_invitation_email_code.sql
bash supabase/tests/00661/run.sh supabase/migrations/00661_team_invitations.sql
pnpm --filter @tricigo/api exec vitest run verify-otp team-invitation-code
pnpm exec turbo run test --force
pnpm check-types
pnpm test:migration-grants && pnpm check:migration-grants
```

Expected: 00664 all passed (the count Task 4a reported); 00661 still all green (nothing of it changed); every package test passes (`--force` so turbo's cache does not replay an old green, memory `reference_turbo_test_cache_replay`); types pass; grants pass.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): accepting a team invitation with an e-mail code

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

If the release notes were left uncommitted in `CLAUDE.md`, stage only this task's hunk: write the section with the Edit tool on a clean `CLAUDE.md` (the owner decides how to set the other edit aside; never a bare `git stash`, see the worktree rules).

---

### Task 9: Rollout (each step only with the owner's explicit OK)

Nothing here is automatic. Ask before each step (CLAUDE.md § "MCP migration guard", "Merges a master requieren autorización explícita por PR").

- [ ] **Step 1: Push the branch and open the PR**

Push, open the PR with `gh pr create --body-file` (body: summary, the rehearsal numbers, "Migration not applied yet; the page hides nothing until merged, and nothing calls the functions until the Edge Function is deployed"). Bind it with the ccd_pr tools and read CI.

- [ ] **Step 2: Re-check the migration number, then apply it**

Run the pre-flight from "Before starting" again. With the owner's OK, rehearse in prod inside a block that rolls back (CLAUDE.md, the `DO $probe$ BEGIN EXECUTE $mig$<file>$mig$; ... RAISE EXCEPTION ...` pattern), then apply with `mcp__apply_migration` (name `00664_team_invitation_email_code`). Verify by object afterwards:

```sql
SELECT p.proname, md5(p.prosrc), has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_x
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('_team_code_hash', '_team_code_account', 'team_invitation_code_issue', 'team_invitation_code_check', 'accept_team_invitation_by_code');
SELECT count(*) FROM public.team_invitation_code_salt;  -- 1
```

The md5 of each body must equal the local rehearsal's (`$BODIES` in `run.sh`).

- [ ] **Step 3: Check the magic-link login with the demo account, then deploy `verify-otp`**

The magic link has been only a fallback; before accounts depend on it, try it in prod. With the owner's OK, in this order:
1. Deploy `verify-otp` (with `_shared/`, as below). Nobody has the mark yet, so nothing changes.
2. Set the mark on the store demo passenger account: `UPDATE public.users SET password_set_at = now() WHERE id = (SELECT id FROM auth.users WHERE phone = '5355550100');`
3. The owner signs in on a phone with `+5355550100` and the demo code (never written anywhere by Claude).
4. Check the `verify-otp` logs: `Session minted for user <id>` and no `updateUserById(password)` line; the app opens.
5. Clear the mark: `UPDATE public.users SET password_set_at = NULL WHERE id = (SELECT id FROM auth.users WHERE phone = '5355550100');`

If step 3 fails, roll `verify-otp` back to the previous version and stop: the code path must not reach accounts with a phone until the magic link works.

- [ ] **Step 4: Deploy the other functions**

With the owner's OK: deploy `team-invitation-code` and redeploy `send-email` (new template and the changed invitation line), following memory `reference_supabase_mcp_tooling` (deploy from a `git archive` LF export with `npx supabase functions deploy <name> --project-ref lqaufszburqvlslpcuac`; then drift-check with `functions download`). Confirm `team-invitation-code` shows `verify_jwt: false`.

- [ ] **Step 5: Merge**

With "Sí, autorizo el squash-merge de #<N>" from the owner (memory `feedback_merge_approval_classifier`). The merge deploys the admin panel (`deploy-admin.yml`).

- [ ] **Step 6: Real run in prod**

With the owner's OK and an address the owner controls:
1. In *Equipo*, invite that address as *Marketing*.
2. Open the link, *Crear cuenta con un código*, *Enviar código*; the e-mail arrives from `noreply@tricigo.com` with a 6-digit code.
3. Enter the code, a name and a password; the panel opens on *Pulso del lanzamiento*.
4. Check `admin_actions` (`method = 'email_code'`), the role, `password_set_at` and `email_verified_at` on the account, and that `team_invitation_codes` has no row left.
5. Sign out and sign in again with e-mail and password at admin.tricigo.com.
6. In *Equipo*, remove that access.

Then update the marketing message for Baco: drop the "create a Google account" step.

---

## Self-review

- **Review fixes (Task 4a/4b):** service_role REVOKE before GRANT, unconfirmed phone and identity-only address are `needs_google`, internal address refused at accept, the two marks set at accept, `password_set_at` brought into git, `verify-otp` keeps a chosen password, `email_confirm: true` on existing accounts (Task 5), and the tests for each.
- **Spec coverage:** page flow (Task 7), account cases (Task 3 `_team_code_account`, tested C7/A1–A6), code storage as HMAC with salt (Task 3, I2), issue/check/accept (Task 3), limits (I4–I7, C1–C4, Task 5 IP limits), errors (Task 6 messages), e-mail templates (Task 4), `teamService` (Task 6), tests (Tasks 2–7), rollout (Task 9), docs (Task 8). The spec's contradictions about the name are settled in Task 1.
- **Placeholders:** none; every code step has its code and every run step its command and expected output. The migration number is a stated value (00664) with an explicit re-check.
- **Consistency:** answers `issued|ok|accepted` and the refusal names match across SQL (Task 3), the Edge Function (Task 5), `INVITATION_CODE_RESULTS` (Task 6) and the tests. The Edge Function sends `invitee_name`, `teamService` reads `invitee_name` into `inviteeName`, the form uses `res.inviteeName`. `requestInvitationCode`/`acceptInvitationWithCode` names match between service, tests and form.
