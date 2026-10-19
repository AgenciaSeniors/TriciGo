# Marketing autonomy and signup driver bonus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Marketing runs promotions with no admin approval and edits the four referral amounts, and a signup code can pay a wallet balance to drivers who register with it.

**Architecture:** One migration, 00666. It rewrites the promotions guard (`tg_promotions_marketing_guard`), adds `set_referral_amounts(jsonb)`, adds `acquisition_codes.driver_bonus_cup` and a lock table `signup_driver_bonuses` paid by an AFTER UPDATE trigger on `rides`, and extends `admin_signup_code_stats()`. It is rehearsed on local Postgres 16 against live prod bodies. The admin panel and `packages/api` services change to match.

**Tech Stack:** PostgreSQL 16 (plpgsql), Supabase RLS, Next.js admin panel (`apps/admin`), TypeScript services (`packages/api`, vitest), i18n JSON (`packages/i18n`).

**Spec:** `docs/superpowers/specs/2026-10-19-marketing-autonomy-driver-signup-bonus-design.md`. Read it first.

**Ground rules for every task:**
- Branch `claude/pensive-archimedes-41vkeh`. Commit after each task. Commit messages in English, conventional format, ending with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QhinwD8BYzm5x6GoTZvtki
  ```
- **Never touch prod** (no Supabase MCP, no network calls to Supabase). Everything runs locally.
- Code, comments and commit messages in English. User-facing Spanish text uses tuteo (never voseo: no "podés", "tenés", "elegí", "confirmá"…); `packages/utils/src/__tests__/copyTuteo.test.ts` enforces it.
- Local Postgres 16 is already running: `127.0.0.1:5433`, user `pgtest`, binaries in `/usr/lib/postgresql/16/bin`. If it is down: `rm -f /home/pgtest/data/postmaster.pid; su pgtest -c '/usr/lib/postgresql/16/bin/pg_ctl -D /home/pgtest/data -o "-p 5433 -c unix_socket_directories=/tmp" -l /home/pgtest/pg.log -w start'`.

---

## File structure

| File | Responsibility |
|---|---|
| `supabase/tests/00666/live-bodies.sql` | **Already committed.** 25 live function bodies read from prod on 2026-10-19 (md5 in each header comment). |
| `supabase/tests/00666/scaffold.sql` | Create: tables, enums, policies, triggers and seed users the rehearsal needs, loading `live-bodies.sql`. |
| `supabase/tests/00666/run.sh` | Create: the rehearsal runner (RED without the migration, GREEN with it). |
| `supabase/migrations/00666_marketing_autonomy_driver_signup_bonus.sql` | Create: copy of the finished migration at `/tmp/claude-0/-home-user-TriciGo/9fbd24a4-2a83-5a40-9dc8-0cea270fab54/scratchpad/p666/00666_marketing_autonomy_driver_signup_bonus.sql`. |
| `packages/api/src/services/referral.service.ts` | Modify: `REFERRAL_AMOUNT_KEYS`, `getReferralAmounts()`, `setReferralAmounts()`. |
| `packages/api/src/services/acquisition-code.service.ts` | Modify: `driver_bonus_cup` in types and `create`, new `setDriverBonus()`, three new stats fields. |
| `packages/api/src/services/__tests__/referral-amounts.test.ts` | Create: tests for the two referral-amount methods. |
| `packages/api/src/services/__tests__/acquisition-code.test.ts` | Modify: tests for `create` with a bonus, `setDriverBonus`, stats fields. |
| `apps/admin/src/app/promotions/page.tsx` | Modify: marketing gets the admin UI. |
| `apps/admin/src/app/referrals/page.tsx` | Modify: "Montos" card. |
| `apps/admin/src/components/referrals/ReferralAmountsCard.tsx` | Create: the card (form + save). |
| `apps/admin/src/app/code-performance/page.tsx` | Modify: driver bonus field in the form, per-row editor, paid column, CSV, `form_help` text. |
| `packages/i18n/src/locales/{es,en,pt}/admin.json` | Modify: new and changed keys (parity enforced by `pnpm check:i18n`). |
| `CLAUDE.md` | Modify: a section for 00666. |

---

### Task 1: Rehearsal scaffold and runner (RED)

**Files:**
- Create: `supabase/tests/00666/scaffold.sql`
- Create: `supabase/tests/00666/run.sh` (executable, LF line endings)
- Read for patterns: `supabase/tests/00665/run.sh`, `supabase/tests/00665/scaffold.sql`, `supabase/tests/00642/run.sh` (promotion guard tests P1–P10), `supabase/tests/00666/live-bodies.sql`.

- [ ] **Step 1: Write `scaffold.sql`.** Model it on `supabase/tests/00665/scaffold.sql` (same header style, a NON-superuser owner role `tricigo_owner` that owns everything, `auth` schema with `auth.users(id, phone, phone_confirmed_at)` and the API roles `anon`, `authenticated`, `service_role`; like prod, `ALTER DEFAULT PRIVILEGES` at the end so new functions in `public` are executable by the API roles). It must contain:

  Enums (exact labels):
  ```sql
  CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin', 'marketing');
  CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');
  CREATE TYPE public.promotion_type AS ENUM ('percentage_discount', 'fixed_discount', 'bonus_credit');
  CREATE TYPE public.wallet_account_type AS ENUM ('customer_cash', 'driver_cash', 'driver_hold', 'platform_revenue', 'platform_promotions', 'corporate_cash', 'driver_quota', 'tricicoin', 'platform_fx_reserve');
  CREATE TYPE public.ledger_entry_type AS ENUM ('recharge', 'ride_payment', 'ride_hold', 'ride_hold_release', 'commission', 'transfer_in', 'transfer_out', 'promo_credit', 'redemption', 'adjustment', 'insurance_premium', 'refund', 'quota_deduction', 'quota_recharge', 'fx_revaluation');
  CREATE TYPE public.ledger_transaction_status AS ENUM ('pending', 'posted', 'archived', 'reversed');
  ```
  Tables (prod columns, as read on 2026-10-19; keep only the columns listed):
  - `public.users (id uuid PK REFERENCES auth.users(id) ON DELETE CASCADE, role user_role NOT NULL DEFAULT 'customer', full_name text, phone text, is_active boolean NOT NULL DEFAULT true, signup_code text REFERENCES public.acquisition_codes(code) ON UPDATE CASCADE, signup_code_at timestamptz)` — create `acquisition_codes` first.
  - `public.platform_config (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`.
  - `public.admin_actions (id uuid PK DEFAULT gen_random_uuid(), admin_id uuid NOT NULL REFERENCES users(id), action text NOT NULL, target_type text NOT NULL, target_id text NOT NULL, old_values jsonb, new_values jsonb, reason text, created_at timestamptz NOT NULL DEFAULT now())`.
  - `public.promotions` with exactly the prod columns: `id uuid PK DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE, type promotion_type NOT NULL, discount_percent numeric, discount_fixed_cup integer, max_uses integer, current_uses integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true, valid_from timestamptz NOT NULL DEFAULT now(), valid_until timestamptz, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), title_es text, body_es text, image_url text, notify_on_publish boolean NOT NULL DEFAULT true, notified_at timestamptz, first_ride_only boolean NOT NULL DEFAULT false, is_public boolean NOT NULL DEFAULT true, pending_approval boolean NOT NULL DEFAULT false, approved_by uuid REFERENCES users(id) ON DELETE SET NULL, approved_at timestamptz, revision integer NOT NULL DEFAULT 0`.
  - `public.acquisition_codes (code text PK CHECK (code ~ '^[A-Z0-9-]{3,24}$'), label text NOT NULL, channel text NOT NULL, audience text NOT NULL DEFAULT 'ambos', is_active boolean NOT NULL DEFAULT true, notes text, created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, promotion_id uuid)`; add `REFERENCES public.promotions(id) ON DELETE SET NULL` on `promotion_id` after `promotions` exists.
  - `public.referral_codes (code text PRIMARY KEY, user_id uuid)` (read by `tg_acquisition_codes_guard`).
  - `public.driver_profiles (id uuid PK, user_id uuid NOT NULL REFERENCES users(id), status text NOT NULL DEFAULT 'approved')`.
  - `public.rides (id uuid PK DEFAULT gen_random_uuid(), customer_id uuid REFERENCES users(id), driver_id uuid REFERENCES driver_profiles(id), status ride_status NOT NULL DEFAULT 'searching', promo_code_id uuid REFERENCES promotions(id) ON DELETE SET NULL)`.
  - `public.promotion_uses (id uuid PK DEFAULT gen_random_uuid(), promotion_id uuid NOT NULL REFERENCES promotions(id) ON DELETE CASCADE, user_id uuid NOT NULL, ride_id uuid)`.
  - `public.campaigns (id uuid PK DEFAULT gen_random_uuid(), name text NOT NULL DEFAULT 'c', promo_code_id uuid REFERENCES promotions(id) ON DELETE SET NULL)`.
  - `public.wallet_accounts (id uuid PK DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id) ON DELETE SET NULL, account_type wallet_account_type NOT NULL, balance integer NOT NULL DEFAULT 0, held_balance integer NOT NULL DEFAULT 0, currency text NOT NULL DEFAULT 'TRC', anchor_usd_cents numeric, UNIQUE (user_id, account_type), CONSTRAINT wallet_accounts_customer_balance_non_negative CHECK (account_type <> 'customer_cash' OR balance >= 0))`.
  - `public.ledger_transactions (id uuid PK DEFAULT gen_random_uuid(), idempotency_key text NOT NULL UNIQUE, type ledger_entry_type NOT NULL, status ledger_transaction_status NOT NULL DEFAULT 'pending', reference_type text, reference_id uuid, description text NOT NULL DEFAULT '', metadata jsonb, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now())`.
  - `public.ledger_entries (id uuid PK DEFAULT gen_random_uuid(), transaction_id uuid NOT NULL REFERENCES ledger_transactions(id), account_id uuid NOT NULL REFERENCES wallet_accounts(id), amount integer NOT NULL, balance_after integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`.
  - 00658 lock tables, copied from `supabase/tests/00665/scaffold.sql` (`reward_identity_salt`, `reward_claims` with its unique `(identity_hash, claim)`), and the salt seed row.
  - `public.cron_http_calls (request_id bigint PRIMARY KEY, jobname text NOT NULL, url text NOT NULL, called_at timestamptz NOT NULL DEFAULT now())`.
  - `net` schema with `net.http_request_queue (id bigserial PRIMARY KEY, url text, headers jsonb, body jsonb)` and a stub `net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds integer) RETURNS bigint` that inserts into the queue and returns the id (so pushes are observable).
  - Stubs: `public.get_service_role_key()` returns `'test-service-key'` (SECURITY DEFINER, no grants to clients) — it **replaces** the live body, so drop that one from what `live-bodies.sql` creates or create the stub after loading it; `public.get_current_exchange_rate()` returns `510`; `public.record_audit()` is not needed (no audit triggers on wallets in the scaffold).

  Then `\ir live-bodies.sql` (with `SET check_function_bodies = off` around it, as 00665 does). After loading, re-create `get_service_role_key()` as the stub.

  Policies, as in prod:
  ```sql
  ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;
  CREATE POLICY promo_admin ON public.promotions USING (is_admin());
  CREATE POLICY promotions_select_marketing ON public.promotions FOR SELECT TO authenticated USING ((SELECT is_marketing()));
  CREATE POLICY promotions_insert_marketing ON public.promotions FOR INSERT TO authenticated WITH CHECK ((SELECT is_marketing()));
  CREATE POLICY promotions_update_marketing ON public.promotions FOR UPDATE TO authenticated USING ((SELECT is_marketing())) WITH CHECK ((SELECT is_marketing()));
  CREATE POLICY promotions_delete_marketing ON public.promotions FOR DELETE TO authenticated USING ((SELECT is_marketing()));
  ALTER TABLE public.platform_config ENABLE ROW LEVEL SECURITY;
  CREATE POLICY pc_select ON public.platform_config FOR SELECT USING ((NOT platform_config_is_secret(key)) OR platform_config_can_read_secrets());
  CREATE POLICY pc_super_admin_insert ON public.platform_config FOR INSERT WITH CHECK (is_super_admin());
  CREATE POLICY pc_super_admin_update ON public.platform_config FOR UPDATE USING (is_super_admin()) WITH CHECK (is_super_admin());
  CREATE POLICY pc_super_admin_delete ON public.platform_config FOR DELETE USING (is_super_admin());
  ALTER TABLE public.acquisition_codes ENABLE ROW LEVEL SECURITY;
  CREATE POLICY acquisition_codes_admin_all ON public.acquisition_codes FOR ALL TO authenticated USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
  CREATE POLICY acquisition_codes_all_marketing ON public.acquisition_codes FOR ALL TO authenticated USING ((SELECT is_marketing())) WITH CHECK ((SELECT is_marketing()));
  ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
  CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = (SELECT auth.uid())) OR is_admin());
  ```
  Table grants: `GRANT SELECT, INSERT, UPDATE, DELETE ON public.promotions, public.platform_config, public.acquisition_codes TO authenticated; GRANT SELECT ON public.users TO authenticated; GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;`.

  Triggers, as in prod:
  ```sql
  CREATE TRIGGER trg_promotions_marketing_guard BEFORE INSERT OR DELETE OR UPDATE ON public.promotions FOR EACH ROW EXECUTE FUNCTION tg_promotions_marketing_guard();
  CREATE TRIGGER platform_config_audit AFTER INSERT OR DELETE OR UPDATE ON public.platform_config FOR EACH ROW EXECUTE FUNCTION tg_platform_config_audit();
  CREATE TRIGGER trg_acquisition_codes_guard BEFORE INSERT OR UPDATE OF code ON public.acquisition_codes FOR EACH ROW EXECUTE FUNCTION tg_acquisition_codes_guard();
  ```

  Seeds (fixed ids; phones in E.164 without `+`, confirmed unless stated):
  - `…0001` platform user (role `admin`, no phone) — the `platform_promotions` owner.
  - `ADMIN` (role `admin`), `SUPER` (role `super_admin`), `MARK` (role `marketing`), `RIDER` (role `customer`, phone 5355500006).
  - `DRV1` driver, signup code `VIGO`, phone 5355500011, profile `DP1` approved.
  - `DRV2` driver, signup code `VIGO`, phone never confirmed (`phone_confirmed_at` NULL), profile `DP2`.
  - `DRV3` driver, signup code `ZERO` (bonus 0), phone 5355500013, profile `DP3`.
  - `DRV4` driver, no signup code, phone 5355500014, profile `DP4`.
  - `DRV5` driver, signup code `VIGO`, phone 5355500011 **on a new account** inserted in a test (see C6), profile `DP5`.
  - Codes: `VIGO` (channel `influencer`, driver_bonus set by the tests), `ZERO`.
  - `platform_config` rows: `referral_bonus_cup` 500, `referral_bonus_driver_cup` 1000, `referral_welcome_bonus_cup` 0, `referral_welcome_bonus_driver_cup` 0 (JSON numbers), and a secret-looking row `x_api_key` = `"s"`.
  - Promotions: `P_LIVE` active, used (one `promotion_uses` row); `P_PAUSED` paused, unused; `P_REF` paused, referenced by one ride.

- [ ] **Step 2: Write `run.sh`.** Same skeleton as `supabase/tests/00665/run.sh`: `run`, `val`, `err`, `tx`, `client` helpers; `fresh DB` creates a database from the scaffold; `S0` checks every live md5 (the md5 is in each `-- name md5=… acl=…` header line of `live-bodies.sql`; compare `md5(replace(prosrc, chr(13), ''))`, except `get_service_role_key` which the scaffold replaces). Usage: `run.sh none` (RED) and `run.sh supabase/migrations/00666_marketing_autonomy_driver_signup_bonus.sql` (GREEN: apply as `tricigo_owner` twice, then the tests, then a CRLF copy into a fresh DB, then negative proofs). Use a helper `bonus_ride ID DRIVER_PROFILE CUSTOMER` that inserts a ride `accepted` with that driver and customer and then `UPDATE … SET status = 'completed'` (the trigger is AFTER UPDATE OF status).

  Tests (each `val`/`err` with the exact expected output; run every test in a rolled-back transaction with `tx` unless it needs to see a previous one):

  **A — promotions guard**
  - A1 marketing inserts `{code: 'MK1', type: percentage_discount, discount_percent: 10, is_active: true, current_uses: 7, approved_by: ADMIN}` → row has `is_active=t, pending_approval=f, current_uses=0, created_by=MARK, approved_by=MARK, approved_at not null`.
  - A2 marketing inserts with `is_active=false` → `is_active=f, pending_approval=f, approved_by null`.
  - A3 marketing updates `P_LIVE` title (live) → succeeds, `revision` +1, `pending_approval=f`, `approved_by` unchanged.
  - A4 marketing sets `is_active=true` on `P_PAUSED` → active, `approved_by=MARK`.
  - A5 marketing tries `current_uses=99`, `created_by=RIDER`, `approved_by=RIDER` in one update → all three keep their old values.
  - A6 marketing pauses `P_LIVE` → `is_active=f`.
  - A7 marketing deletes `P_LIVE` (paused first in the same tx) → error `promo_delete_blocked` (used). Deletes `P_REF` → `promo_delete_blocked`. Deletes `P_PAUSED` → 1 row gone.
  - A8 admin inserts active → `approved_by=ADMIN` (unchanged behaviour); admin deletes `P_REF` → allowed (unchanged).
  - A9 a rider (`RIDER`) cannot see or insert promotions (RLS): insert error `row-level security`.
  - A10 a ride path: as `tricigo_owner` with MARK's JWT set (`SET LOCAL request.jwt.claim.sub`, no `SET ROLE`, as inside the SECURITY DEFINER promo validator), `UPDATE promotions SET current_uses = current_uses + 1 WHERE id = P_LIVE` → the counter goes up (current_user is not a client role, so the marketing rules do not apply).

  **B — referral amounts**
  - B1 marketing `set_referral_amounts('{"referral_bonus_cup": 700, "referral_welcome_bonus_driver_cup": 300}')` → `success`, `amounts` has the four keys with 700/1000/0/300; `platform_config` values are JSON numbers 700 and 300.
  - B2 two `admin_actions` rows `update_platform_config`, `admin_id = MARK`, targets the two keys.
  - B3 same call again → `success`, zero new `admin_actions` rows.
  - B4 admin (not super) can call it → `success`.
  - B5 RIDER → `{"error": "forbidden"}`; anon → permission denied (no EXECUTE).
  - B6 `{"referral_bonus_cup": -1}` → `invalid_amount`; `1.5` → `invalid_amount`; `"500"` → `invalid_amount`; `{"x_api_key": 1}` → `unknown_key`; `{}` → `nothing_to_save`; a mixed object with one bad key writes nothing (values unchanged).
  - B7 marketing reads the four keys with a plain `SELECT key, value FROM platform_config WHERE key LIKE 'referral_%'` as `authenticated` → 4 rows (pc_select).

  **C — signup driver bonus** (set `UPDATE acquisition_codes SET driver_bonus_cup = 1000 WHERE code = 'VIGO'` as admin first)
  - C1 `bonus_ride R1 DP1 RIDER` → `DRV1` tricicoin balance 1000, `platform_promotions` balance −1000, one `ledger_transactions` row `signup_driver_bonus:<DRV1>` type `promo_credit` status `posted` reference `signup_driver_bonus`/R1 description `Bono de bienvenida - código VIGO`, two `ledger_entries` (−1000, +1000), one `signup_driver_bonuses` row (DRV1, VIGO, 1000, R1), one `reward_claims` row with claim `signup_driver_bonus`, one `net.http_request_queue` row whose body has `title` `Recibiste un bono de bienvenida` and `category` `system`, and one `cron_http_calls` row with jobname `signup-driver-bonus`.
  - C2 after C1, `bonus_ride R2 DP1 RIDER` → still 1000, still one ledger transaction.
  - C3 a ride the driver requested for themselves first (`bonus_ride R3 DP1 DRV1`) pays nothing, and then a ride for RIDER pays 1000 (it is the first for another person).
  - C4 `DRV3` (code `ZERO`, amount 0) → nothing.
  - C5 `DRV2` (no confirmed phone) → nothing, no claim row, no table row.
  - C6 in the same transaction after C1's payment: insert `DRV5` (a new account with DRV1's phone 5355500011, code VIGO, profile DP5) and complete its first ride for RIDER → nothing paid (the phone already has the claim).
  - C7 `DRV4` (no code) → nothing.
  - C8 the payment block failing does not block the ride: make `ledger_entries` refuse inserts in the transaction (`ALTER TABLE ledger_entries ADD CONSTRAINT t_fail CHECK (false) NOT VALID` inside `tx`) and complete a VIGO driver's first ride → the ride is `completed`, no `signup_driver_bonuses` row, no `reward_claims` row (rolled back with the block).
  - C9 a second change of status to `completed` (e.g. `disputed` → `completed`) does not pay again.
  - C10 stats as marketing: `SELECT code, driver_bonus_cup, drivers_bonus_paid, driver_bonus_paid_cup FROM admin_signup_code_stats() WHERE code = 'VIGO'` → `VIGO|1000|1|1000` after C1; RIDER → error 42501.
  - C11 marketing sets `driver_bonus_cup = 2500` on VIGO through RLS → allowed; `-5` → check violation.

  **G — grants and shape** (GREEN only)
  - G1 `signup_driver_bonuses`: RLS on, no policies, `anon`/`authenticated` no SELECT, `service_role` INSERT.
  - G2 `set_referral_amounts`: anon no EXECUTE, authenticated EXECUTE; `trg_signup_driver_bonus`: authenticated no EXECUTE.
  - G3 the guard is SECURITY INVOKER and the trigger on promotions is enabled.
  - G4 the four new md5s: `tg_promotions_marketing_guard=146c9ffc9df39e5f4bbf36b59a17dcb8`, `trg_signup_driver_bonus=b8cb2c4cebc62b45ee5cae55d4ce1bff`, `set_referral_amounts=cd6a37dea2a53f4674549af28e3c2e9a`, `admin_signup_code_stats=c743b9103a7d1eb5b794831072b26b09`.

  **N — negative proofs** (GREEN only; each in a fresh DB named `${DB}n`)
  - N1 replace `tg_promotions_marketing_guard` with a body that differs by one comment, then apply → error `is not the body read from prod`.
  - N2 replace `admin_signup_code_stats` with a different body (same result type), then apply → error `admin_signup_code_stats() is not the body read from prod`.
  - N3 apply the migration with `trg_signup_driver_bonus` edited in the file copy (one changed comment inside the body) → error `trg_signup_driver_bonus has an unexpected body`.
  - N4 the CRLF copy applies and leaves no carriage return (G4 still holds).

- [ ] **Step 3: Run RED.**
  Run: `bash supabase/tests/00666/run.sh none`
  Expected: S0 passes (live md5s), A1–A5 fail (guard still forces drafts / refuses), B1–B7 fail except B7 (no function), C1–C11 fail (no column/trigger). Write the counts in the commit message.

- [ ] **Step 4: Commit.**
  ```bash
  git add supabase/tests/00666/scaffold.sql supabase/tests/00666/run.sh
  git commit -m "test(db): rehearsal for 00666 marketing autonomy and signup driver bonus (RED)"
  ```

---

### Task 2: Migration 00666 (GREEN)

**Files:**
- Create: `supabase/migrations/00666_marketing_autonomy_driver_signup_bonus.sql`

- [ ] **Step 1: Copy the migration.**
  ```bash
  cp /tmp/claude-0/-home-user-TriciGo/9fbd24a4-2a83-5a40-9dc8-0cea270fab54/scratchpad/p666/00666_marketing_autonomy_driver_signup_bonus.sql supabase/migrations/
  ```
  Read it whole before running anything. Do not change function bodies without recomputing their md5 (the text between the `$function$` markers) and updating both the migration's `$verify$` block and G4.

- [ ] **Step 2: Run GREEN.**
  Run: `bash supabase/tests/00666/run.sh supabase/migrations/00666_marketing_autonomy_driver_signup_bonus.sql`
  Expected: every test passes, applied twice, CRLF copy, N1–N4.

- [ ] **Step 3: If a test fails**, decide whether the test or the migration is wrong against the spec. A migration fix that changes a body needs new md5s in `$verify$`, in the `$guard$` alternative for the guard (`@@NEW_GUARD_MD5@@` position), and in G4.

- [ ] **Step 4: Run the CI checks that read migrations.**
  Run: `pnpm check:migration-grants && pnpm test:migration-grants && npx vitest run packages/utils/src/__tests__/copyTuteo.test.ts`
  Expected: pass (the new table has GRANT to service_role; the Spanish texts in the migration use tuteo).

- [ ] **Step 5: Commit.**
  ```bash
  git add supabase/migrations/00666_marketing_autonomy_driver_signup_bonus.sql
  git commit -m "feat(db): 00666 marketing runs promotions and referral amounts; signup code driver bonus"
  ```

---

### Task 3: Services (`packages/api`)

**Files:**
- Modify: `packages/api/src/services/referral.service.ts`
- Modify: `packages/api/src/services/acquisition-code.service.ts`
- Create: `packages/api/src/services/__tests__/referral-amounts.test.ts`
- Modify: `packages/api/src/services/__tests__/acquisition-code.test.ts`

- [ ] **Step 1: Write the failing tests** in `referral-amounts.test.ts` (mock style of `__tests__/acquisition-code.test.ts`: `vi.mock('../../client', () => ({ getSupabaseClient: () => mockSupabase }))` with `mockRpc` and `mockFrom`):
  ```ts
  import { describe, it, expect, vi, beforeEach } from 'vitest';

  const mockRpc = vi.fn();
  const mockFrom = vi.fn();
  const mockSupabase = { rpc: mockRpc, from: mockFrom };
  vi.mock('../../client', () => ({ getSupabaseClient: () => mockSupabase }));

  import { referralService, REFERRAL_AMOUNT_KEYS } from '../referral.service';

  function selectChain(rows: { key: string; value: unknown }[] | null, error: unknown = null) {
    const chain = { select: vi.fn(), in: vi.fn() };
    chain.select.mockReturnValue(chain);
    chain.in.mockResolvedValue({ data: rows, error });
    return chain;
  }

  describe('referralService.getReferralAmounts', () => {
    beforeEach(() => { mockRpc.mockReset(); mockFrom.mockReset(); });

    it('reads the four keys and defaults a missing one to 0', async () => {
      const chain = selectChain([
        { key: 'referral_bonus_cup', value: 500 },
        { key: 'referral_bonus_driver_cup', value: 1000 },
        { key: 'referral_welcome_bonus_cup', value: '0' },
      ]);
      mockFrom.mockReturnValue(chain);
      const amounts = await referralService.getReferralAmounts();
      expect(mockFrom).toHaveBeenCalledWith('platform_config');
      expect(chain.in).toHaveBeenCalledWith('key', [...REFERRAL_AMOUNT_KEYS]);
      expect(amounts).toEqual({
        referral_bonus_cup: 500,
        referral_bonus_driver_cup: 1000,
        referral_welcome_bonus_cup: 0,
        referral_welcome_bonus_driver_cup: 0,
      });
    });

    it('throws the query error', async () => {
      mockFrom.mockReturnValue(selectChain(null, { message: 'boom' }));
      await expect(referralService.getReferralAmounts()).rejects.toEqual({ message: 'boom' });
    });
  });

  describe('referralService.setReferralAmounts', () => {
    beforeEach(() => { mockRpc.mockReset(); mockFrom.mockReset(); });

    it('sends only the given keys and returns the saved amounts', async () => {
      mockRpc.mockResolvedValue({
        data: { success: true, amounts: { referral_bonus_cup: 700, referral_bonus_driver_cup: 1000, referral_welcome_bonus_cup: 0, referral_welcome_bonus_driver_cup: 300 } },
        error: null,
      });
      const saved = await referralService.setReferralAmounts({ referral_bonus_cup: 700, referral_welcome_bonus_driver_cup: 300 });
      expect(mockRpc).toHaveBeenCalledWith('set_referral_amounts', { p_amounts: { referral_bonus_cup: 700, referral_welcome_bonus_driver_cup: 300 } });
      expect(saved.referral_welcome_bonus_driver_cup).toBe(300);
    });

    it.each([
      ['forbidden', 'No tienes permiso para cambiar los montos de referidos.'],
      ['invalid_amount', 'Los montos tienen que ser números enteros, 0 o más.'],
      ['unknown_key', 'Uno de los montos no existe. Recarga la página.'],
      ['nothing_to_save', 'No hay cambios para guardar.'],
    ])('maps %s to a Spanish message', async (code, message) => {
      mockRpc.mockResolvedValue({ data: { error: code }, error: null });
      await expect(referralService.setReferralAmounts({ referral_bonus_cup: 1 })).rejects.toThrow(message);
    });

    it('says the feature is not available yet when the RPC is missing', async () => {
      mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'not found' } });
      await expect(referralService.setReferralAmounts({ referral_bonus_cup: 1 })).rejects.toThrow('Esta función todavía no está disponible.');
    });
  });
  ```
  In `acquisition-code.test.ts` add (reusing its existing `mockInsertChain` / `mockUpdateChain` helpers and `getStats` describe):
  - `create` with `driverBonusCup: 1500` sends `driver_bonus_cup: 1500`; with `0` or undefined it does **not** send the key.
  - `setDriverBonus('VIGO', 2000)` calls `.update({ driver_bonus_cup: 2000 }).eq('code', 'VIGO').select('code')`; 0 rows → throws `No se pudo cambiar el saldo para choferes del código. Recarga la página e intenta de nuevo.`; `-1` or `1.5` → throws `El saldo para choferes tiene que ser un número entero, 0 o más.` without calling Supabase.
  - `getStats` coerces `driver_bonus_cup`, `drivers_bonus_paid`, `driver_bonus_paid_cup` with `Number(... ?? 0)`.

- [ ] **Step 2: Run them, expect FAIL.**
  Run: `cd packages/api && npx vitest run src/services/__tests__/referral-amounts.test.ts src/services/__tests__/acquisition-code.test.ts`
  Expected: FAIL (`getReferralAmounts is not a function`, etc.).

- [ ] **Step 3: Implement in `referral.service.ts`** (add after the imports and inside `referralService`):
  ```ts
  /** 00666: the four referral amounts in platform_config, in CUP. */
  export const REFERRAL_AMOUNT_KEYS = [
    'referral_bonus_cup',
    'referral_bonus_driver_cup',
    'referral_welcome_bonus_cup',
    'referral_welcome_bonus_driver_cup',
  ] as const;
  export type ReferralAmountKey = (typeof REFERRAL_AMOUNT_KEYS)[number];
  export type ReferralAmounts = Record<ReferralAmountKey, number>;

  const REFERRAL_AMOUNT_ERRORS: Record<string, string> = {
    forbidden: 'No tienes permiso para cambiar los montos de referidos.',
    invalid_amount: 'Los montos tienen que ser números enteros, 0 o más.',
    unknown_key: 'Uno de los montos no existe. Recarga la página.',
    nothing_to_save: 'No hay cambios para guardar.',
  };

  function toAmounts(rows: { key: string; value: unknown }[]): ReferralAmounts {
    const out = Object.fromEntries(REFERRAL_AMOUNT_KEYS.map((k) => [k, 0])) as ReferralAmounts;
    for (const row of rows) {
      if ((REFERRAL_AMOUNT_KEYS as readonly string[]).includes(row.key)) {
        const n = Number(row.value);
        out[row.key as ReferralAmountKey] = Number.isFinite(n) ? n : 0;
      }
    }
    return out;
  }
  ```
  and the two methods inside `referralService`:
  ```ts
  /** 00666: the referral amounts (any signed-in user can read these non-secret keys). */
  async getReferralAmounts(): Promise<ReferralAmounts> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('platform_config')
      .select('key, value')
      .in('key', [...REFERRAL_AMOUNT_KEYS]);
    if (error) throw error;
    return toAmounts((data ?? []) as { key: string; value: unknown }[]);
  },

  /** 00666: admins and marketing save the changed amounts (integers >= 0). */
  async setReferralAmounts(changes: Partial<ReferralAmounts>): Promise<ReferralAmounts> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('set_referral_amounts', { p_amounts: changes });
    if (error) {
      if (isMissingFunctionError(error)) throw new Error('Esta función todavía no está disponible.');
      throw error;
    }
    const result = (data ?? {}) as { success?: boolean; error?: string; amounts?: Record<string, unknown> };
    if (result.error || !result.success) {
      throw new Error(REFERRAL_AMOUNT_ERRORS[result.error ?? ''] ?? 'No se pudieron guardar los montos.');
    }
    return toAmounts(Object.entries(result.amounts ?? {}).map(([key, value]) => ({ key, value })));
  },
  ```
  Export `REFERRAL_AMOUNT_KEYS` and the two types from `packages/api/src/index.ts` next to the existing referral exports.

- [ ] **Step 4: Implement in `acquisition-code.service.ts`:**
  - `AcquisitionCode`: add `/** 00666: CUP a driver registered with the code gets on the first ride; 0 = off. */ driver_bonus_cup: number;`
  - `AcquisitionCodeStats`: add `driver_bonus_cup: number; drivers_bonus_paid: number; driver_bonus_paid_cup: number;` with a 00666 comment.
  - `NewAcquisitionCode`: add `driverBonusCup?: number;`.
  - `getStats`: add `driver_bonus_cup: Number(row.driver_bonus_cup ?? 0), drivers_bonus_paid: Number(row.drivers_bonus_paid ?? 0), driver_bonus_paid_cup: Number(row.driver_bonus_paid_cup ?? 0),`.
  - `create`: validate `input.driverBonusCup` with the helper below and add `...(input.driverBonusCup ? { driver_bonus_cup: input.driverBonusCup } : {}),` next to `promotion_id` (same "only when set" reason: before 00666 the column does not exist).
  - New helper and method:
  ```ts
  const DRIVER_BONUS_INVALID = 'El saldo para choferes tiene que ser un número entero, 0 o más.';

  function checkDriverBonus(amount: number | undefined): void {
    if (amount === undefined) return;
    if (!Number.isInteger(amount) || amount < 0) throw new Error(DRIVER_BONUS_INVALID);
  }
  ```
  ```ts
  /**
   * Sets the CUP a driver registered with the code gets on the first ride
   * (00666); 0 turns it off. An UPDATE that RLS filters out answers OK with
   * 0 rows, so it throws when no row came back.
   */
  async setDriverBonus(code: string, amount: number): Promise<void> {
    checkDriverBonus(amount);
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('acquisition_codes')
      .update({ driver_bonus_cup: amount })
      .eq('code', code)
      .select('code');
    if (error) throw error;
    if (!data || data.length === 0) {
      throw new Error('No se pudo cambiar el saldo para choferes del código. Recarga la página e intenta de nuevo.');
    }
  },
  ```
  Update the file header comment: codes can now also pay new drivers a balance (00666).

- [ ] **Step 5: Run the tests, expect PASS**, then the whole package and types.
  Run: `cd packages/api && npx vitest run` then (repo root) `pnpm check-types`
  Expected: all pass.

- [ ] **Step 6: Commit.**
  ```bash
  git add packages/api/src
  git commit -m "feat(api): referral amounts and signup code driver bonus in the services"
  ```

---

### Task 4: Promotions page — marketing gets the admin UI

**Files:**
- Modify: `apps/admin/src/app/promotions/page.tsx`
- Modify: `packages/i18n/src/locales/{es,en,pt}/admin.json` (only if a key you add has a JSON entry; keys only used as `defaultValue` need no JSON)

Current branches (line numbers from master `217066e2`):
- L97-100 `isMarketing`; L126 `if (!isMarketing) setPendingCount(...)`.
- L249-251 `const payload = isMarketing ? base : { ...base, is_active: form.is_active };`
- L257-259 / L273-275 marketing toast `promotions.toast_sent_for_approval`.
- L260-270 `maybeNotifyOnPublish` after an edit skipped for marketing.
- L302-305 `handleEdit` refuses a live promotion for marketing (`promotions.marketing_edit_active`).
- L395-422 `handleToggleActive` (admins), L424-438 `handlePause` (marketing).
- L492-509 status column: "Aprobar y activar" only `!isMarketing`.
- L581-589 pending banner `!isMarketing && pendingCount > 0`.
- L705-723 is_active field: marketing sees `promotions.marketing_review_note`.
- L816-852 rowActions: marketing gets Pausar instead of Activar/Desactivar, and "Notificar ahora" only for live ones.

- [ ] **Step 1: Make every path the admin path.** Keep `isMarketing` only where it still means something (the pending banner and count stay admin-only, since nobody creates pending drafts any more but old rows could exist). Concretely:
  - `handleSave`: `const payload = { ...base, is_active: form.is_active };` for everyone; toasts `toast_updated` / `toast_created` for everyone; `maybeNotifyOnPublish` after an edit for everyone.
  - `handleEdit`: delete the marketing refusal block.
  - Status column: show "Aprobar y activar" for everyone (`!isMarketing &&` goes).
  - is_active field: everyone gets the checkbox; delete the `marketing_review_note` branch.
  - rowActions: one list for everyone (Editar, Activar/Desactivar via `handleToggleActive`, Notificar ahora, Eliminar). Delete `handlePause` if it is no longer used (and `promotionService.pause` stays in the service; it is still tested).
  - Update the 00642 comment at L97 to say 00666 lets marketing run promotions; the server still refuses deleting a used one (`promo_delete_blocked`, shown through `getErrorMessage`).
- [ ] **Step 2: Remove now-unused i18n keys only if no file uses them** (`git grep -n "marketing_review_note\|toast_sent_for_approval\|marketing_edit_active\|marketing_notify_inactive\|already_paused"`). If a key is unused everywhere, delete it from es, en and pt together.
- [ ] **Step 3: Check.**
  Run: `pnpm --filter admin lint && pnpm check-types && pnpm check:i18n && npx vitest run packages/utils/src/__tests__/copyTuteo.test.ts`
  Expected: pass, no new lint warnings.
- [ ] **Step 4: Commit.** `git commit -am "feat(admin): marketing activates and edits promotions without approval"`

---

### Task 5: Referidos page — "Montos" card

**Files:**
- Create: `apps/admin/src/components/referrals/ReferralAmountsCard.tsx`
- Modify: `apps/admin/src/app/referrals/page.tsx` (render the card between the header L189-200 and the KPI grid L202)
- Modify: `packages/i18n/src/locales/{es,en,pt}/admin.json` (`referrals.amounts_*` keys, all three locales)

- [ ] **Step 1: Write the component** (client component; Tailwind tokens as in the page; `showToast` from `@/components/ui/AdminToast`; `getErrorMessage` from `@tricigo/utils`):
  ```tsx
  'use client';

  import { useEffect, useState } from 'react';
  import { useTranslation } from 'react-i18next';
  import { referralService, REFERRAL_AMOUNT_KEYS, type ReferralAmountKey, type ReferralAmounts } from '@tricigo/api';
  import { getErrorMessage } from '@tricigo/utils';
  import { showToast } from '@/components/ui/AdminToast';

  const LABELS: Record<ReferralAmountKey, { label: string; help: string }> = {
    referral_bonus_cup: { label: 'Por traer un pasajero', help: 'Lo recibe quien invitó, cuando el pasajero invitado completa su primer viaje.' },
    referral_bonus_driver_cup: { label: 'Por traer un chofer', help: 'Lo recibe quien invitó, cuando el chofer invitado completa su primer viaje. 0 usa el monto por pasajero.' },
    referral_welcome_bonus_cup: { label: 'Bienvenida para el pasajero invitado', help: 'Lo recibe el invitado en su primer viaje. 0 = apagado.' },
    referral_welcome_bonus_driver_cup: { label: 'Bienvenida para el chofer invitado', help: 'Lo recibe el chofer invitado en su primer viaje. 0 usa la bienvenida del pasajero.' },
  };

  export function ReferralAmountsCard() {
    const { t } = useTranslation('admin');
    const [saved, setSaved] = useState<ReferralAmounts | null>(null);
    const [draft, setDraft] = useState<Record<ReferralAmountKey, string> | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
      referralService.getReferralAmounts()
        .then((a) => { setSaved(a); setDraft(toDraft(a)); })
        .catch((e) => showToast('error', getErrorMessage(e)));
    }, []);

    const changes = (): Partial<ReferralAmounts> | 'invalid' => {
      if (!saved || !draft) return {};
      const out: Partial<ReferralAmounts> = {};
      for (const k of REFERRAL_AMOUNT_KEYS) {
        const raw = draft[k].trim();
        if (!/^\d+$/.test(raw)) return 'invalid';
        const n = Number(raw);
        if (n !== saved[k]) out[k] = n;
      }
      return out;
    };

    const handleSave = async () => {
      const c = changes();
      if (c === 'invalid') {
        showToast('error', t('referrals.amounts_invalid', { defaultValue: 'Los montos tienen que ser números enteros, 0 o más.' }));
        return;
      }
      if (Object.keys(c).length === 0) {
        showToast('info', t('referrals.amounts_nothing', { defaultValue: 'No hay cambios para guardar.' }));
        return;
      }
      setSaving(true);
      try {
        const next = await referralService.setReferralAmounts(c);
        setSaved(next);
        setDraft(toDraft(next));
        showToast('success', t('referrals.amounts_saved', { defaultValue: 'Montos guardados. Se aplican a los próximos referidos que se paguen.' }));
      } catch (e) {
        showToast('error', getErrorMessage(e));
      } finally {
        setSaving(false);
      }
    };

    return (
      <section className="rounded-2xl border border-line bg-surface p-5">
        <h2 className="text-base font-semibold text-ink">{t('referrals.amounts_title', { defaultValue: 'Montos de referidos (CUP)' })}</h2>
        <p className="mt-1 text-sm text-ink-muted">{t('referrals.amounts_help', { defaultValue: 'Se pagan en la billetera cuando el invitado completa su primer viaje. Una sola vez por teléfono.' })}</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {REFERRAL_AMOUNT_KEYS.map((k) => (
            <label key={k} className="block">
              <span className="text-sm font-medium text-ink">{t(`referrals.amount_${k}`, { defaultValue: LABELS[k].label })}</span>
              <input
                type="number" min={0} step={1} inputMode="numeric"
                className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-ink"
                value={draft?.[k] ?? ''} disabled={!draft || saving}
                onChange={(e) => setDraft((d) => (d ? { ...d, [k]: e.target.value } : d))}
              />
              <span className="mt-1 block text-xs text-ink-subtle">{t(`referrals.amount_${k}_help`, { defaultValue: LABELS[k].help })}</span>
            </label>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={handleSave} disabled={!draft || saving}
            className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {saving ? t('referrals.amounts_saving', { defaultValue: 'Guardando…' }) : t('referrals.amounts_save', { defaultValue: 'Guardar montos' })}
          </button>
        </div>
      </section>
    );
  }

  function toDraft(a: ReferralAmounts): Record<ReferralAmountKey, string> {
    return Object.fromEntries(REFERRAL_AMOUNT_KEYS.map((k) => [k, String(a[k])])) as Record<ReferralAmountKey, string>;
  }
  ```
  Before writing, open `apps/admin/src/app/referrals/page.tsx` and an existing card component in `apps/admin/src/components` and reuse the exact Tailwind class names the panel uses for a card, a text input and a primary button (the classes above are a starting point; match the panel). Check `showToast`'s accepted types (`'success' | 'error' | 'info'`?) and use only those.
- [ ] **Step 2: Render it** in `referrals/page.tsx` for admins and marketing (both). Keep the `rowActions` marketing branch as is (rewarding by hand stays admin-only).
- [ ] **Step 3: Strings.** Every `defaultValue` above is the Spanish text. Add JSON entries only if the codebase convention for this page needs them (copy real titles to es/en/pt per CLAUDE.md § "Convención i18n"); keep parity.
- [ ] **Step 4: Check.** `pnpm --filter admin lint && pnpm check-types && pnpm check:i18n && npx vitest run packages/utils/src/__tests__/copyTuteo.test.ts`
- [ ] **Step 5: Commit.** `git add apps/admin packages/i18n && git commit -m "feat(admin): edit referral amounts from the Referidos page"`

---

### Task 6: Códigos de origen — driver bonus

**Files:**
- Modify: `apps/admin/src/app/code-performance/page.tsx`
- Modify: `packages/i18n/src/locales/{es,en,pt}/admin.json` (`code_performance.form_help` text and new keys)

Current structure (master `217066e2`): `AcquisitionForm` L49-56, `EMPTY_FORM` L58-65, `handleCreate` L460-497, `handleExportCodes` L499-541, `acquisitionColumns` L701-906 (promotion select + "Guardar"/"Cancelar" at L805-857 with `promoDrafts`/`setPromoDraft` L250-259 and `handleSetPromotion` L397-449), form section L992-1137 (grid of 4 columns at L1006).

- [ ] **Step 1: Form.** Add `driverBonusCup: string` to `AcquisitionForm` (default `'0'` in `EMPTY_FORM`) and an input "Saldo para choferes (CUP)" (`type="number" min=0 step=1`) with help "Lo recibe un chofer que se registre con este código, al completar su primer viaje. 0 = apagado." In `handleCreate`, validate `/^\d+$/` (else show "El saldo para choferes tiene que ser un número entero, 0 o más.") and pass `driverBonusCup: Number(form.driverBonusCup)` to `acquisitionCodeService.create`.
- [ ] **Step 2: Row editor.** Mirror the promotion pattern: `bonusDrafts: Record<string, string>` state, a numeric input showing the draft or `row.driver_bonus_cup`, and "Guardar"/"Cancelar" buttons shown only when the draft differs; `handleSetDriverBonus(row)` validates like the form, calls `acquisitionCodeService.setDriverBonus(row.code, n)`, shows a success toast "Saldo para choferes guardado.", clears the draft and reloads with `loadCodes()`. Add the new deps to the `useMemo` deps array.
- [ ] **Step 3: Paid column.** A column "Bonos a choferes" rendering `row.drivers_bonus_paid` and, when > 0, `· ${formatCUP(row.driver_bonus_paid_cup)}` (import `formatCUP` from `@tricigo/utils` if the file does not already).
- [ ] **Step 4: CSV.** In `handleExportCodes` add columns `driver_bonus_cup` ("Saldo para choferes (CUP)"), `drivers_bonus_paid` ("Choferes con bono"), `driver_bonus_paid_cup` ("Bonos pagados (CUP)").
- [ ] **Step 5: `form_help`.** In es/en/pt `code_performance.form_help` and the page's `defaultValue`, remove "Activar una promoción lo decide un administrador." and add one sentence: "Si pones un saldo para choferes, se paga en su billetera cuando completan su primer viaje." (en/pt: same meaning in English/Portuguese).
- [ ] **Step 6: Check.** `pnpm --filter admin lint && pnpm check-types && pnpm check:i18n && npx vitest run packages/utils/src/__tests__/copyTuteo.test.ts`
- [ ] **Step 7: Commit.** `git add apps/admin packages/i18n && git commit -m "feat(admin): signup codes can pay new drivers a wallet balance"`

---

### Task 7: Docs

**Files:**
- Modify: `CLAUDE.md` — add a section `### Marketing maneja promociones y montos de referidos; saldo para choferes por código de origen (00666)` after the 00665 section ("Un código de origen puede traer una promoción"). In Spanish with tuteo, CLAUDE.md style (short bullets, decisions and traps): what changed in the guard (and that `promo_delete_blocked` remains), `set_referral_amounts` (keys, integers ≥ 0, no cap by owner decision, audit via `tg_platform_config_audit`), the driver bonus rule (first ride for another person, once per confirmed phone, claim `signup_driver_bonus`, platform_promotions → tricicoin, push `signup-driver-bonus`), `signup_driver_bonuses` as a lock table without FKs, the stats columns, the rehearsal path and counts, and "Estado: sin aplicar en prod". Also fix the marketing bullet in § "Rol `marketing` en el panel admin" that says promotions need approval (point it to the new section).
- [ ] **Step 1: Write the section.** Keep it under ~30 lines.
- [ ] **Step 2: Check** `npx vitest run packages/utils/src/__tests__/copyTuteo.test.ts` (it does not read CLAUDE.md, but keep tuteo anyway).
- [ ] **Step 3: Commit.** `git commit -am "docs: 00666 marketing autonomy and signup driver bonus"`

---

## Self-review notes

- Spec A → Task 2 (guard) + Task 4 (panel) + tests A1–A10. Spec B → Task 2 (`set_referral_amounts`) + Task 3 + Task 5 + B1–B7. Spec C → Task 2 (column, table, trigger, stats) + Task 3 + Task 6 + C1–C11.
- Names used across tasks: `set_referral_amounts`, `REFERRAL_AMOUNT_KEYS`, `getReferralAmounts`, `setReferralAmounts`, `setDriverBonus`, `driver_bonus_cup`, `drivers_bonus_paid`, `driver_bonus_paid_cup`, `signup_driver_bonuses`, `trg_signup_driver_bonus`, claim `signup_driver_bonus`, job label `signup-driver-bonus`.
- Prod steps (rolled-back probe, apply, merge) are not in this plan: they need the owner's explicit OK and are done by the controller session.
