# Support-Assisted Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the app cannot find a driver, TriciGo support gets alerted (admin banner with sound, push, e-mail), can send the ride to a chosen driver or assign it directly, and can switch it to another vehicle type at a recomputed price with the rider's consent; the rider gets a "Pedir ayuda" button and a proposal card.

**Architecture:** One migration (`00628`) adds two lock tables, the rider and admin RPCs, a one-minute alert cron, a shared estimate-snapshot writer, and a one-line patch to the discount trigger. A new `rideAssistService` in `packages/api` wraps the RPCs. The admin gets a banner in its shell and a `/rides/[id]/assist` page. The rider client (1.7.4) and web get the help button and the proposal card. The driver app (1.7.4) learns to pick up a ride support assigned while the app is open.

**Tech Stack:** PostgreSQL 16 + PostGIS (Supabase), plpgsql, Next.js 14 admin and web, Expo / React Native client and driver apps, TypeScript, vitest, i18next.

**Spec:** `docs/superpowers/specs/2026-10-07-support-assisted-matching-design.md`

---

## Before you start

Read the spec first. Facts the tasks rely on, all measured in prod on 2026-10-07:

- **Dispatch.** A driver only sees a ride through a `ride_offers` row (`r_select_driver` RLS and `accept_ride_v2`, which needs a pending, unexpired offer). `dispatch_ride` inserts offers from `find_best_drivers`. An offer INSERT fires `trg_notify_driver_new_offer` (push "Viaje disponible cerca"). An UPDATE `expired → pending` fires `trg_notify_driver_reoffer` (same push). `ride_offers` has `UNIQUE (ride_id, driver_profile_id)`.
- **The vehicle types a service accepts** come from a CASE in `find_best_drivers`: `triciclo%` → triciclo, `moto%` → moto, `auto%` → auto or confort, `mensajeria` → any, anything else → triciclo.
- **Money.** `complete_ride_and_pay` charges the `total` of the ride's `estimate` row in `ride_pricing_snapshots` (strict parity), minus `rides.discount_amount_cup`, plus waiting charges. The `estimate` row is written by `tg_rides_create_estimate_snapshot` (AFTER INSERT on rides). `tg_rides_validate_promo_discount` (BEFORE INSERT OR UPDATE OF `promo_code_id, discount_amount_cup, shared_ride, shared_ride_seats_occupied, dropoff_location, corporate_account_id`) recomputes every discount from the `estimate` total, clears `shared_ride` off `triciclo_basico`, and skips the recompute for a `super_admin` caller.
- **Who may change what on `rides`.** `enforce_ride_update_columns` lets admins and calls without a JWT through; a rider may change the fares and `service_type` but not `surge_multiplier`, `driver_custom_rate_cup`, `wallet_ratio`, `insurance_premium_cup` or `wait_time_charge_cup`. `valid_transitions` allows `searching → accepted` for driver, admin and super_admin. `tg_rides_validate_insurance` recomputes the insurance premium on every UPDATE. `rides_sync_coords` keeps `pickup_lat/lng` and `dropoff_lat/lng`.
- **Pushes.** `send-push` takes `user_id` or `user_ids`, `title`, `body`, `category`, `data`. It overwrites `data.type` with the category, so the event goes in `data.event`. Category `system` is always delivered; `ride` can be switched off by the user. Only 1 of the 5 active admins has a push token today.
- **E-mail.** `send-email` with `{recipient_email, subject, template: <raw HTML>, data: {}}` (the 00538 pattern). Recipients come from a comma-separated `platform_config` value.
- **Cron to Edge Function** always through `public.cron_http_post(label, url, headers, body)` (CLAUDE.md § "pg_cron + net.http_post es CIEGO").
- **Clients.** Realtime is off (BUG-277). The rider app re-reads its ride every 3 s (`useRideInit` in `apps/client/src/hooks/useRide.ts`); the web track page every 3 s. The driver app re-reads its active trip on mount, on return to the foreground, and every 5 s only while it already has a trip.
- **Prices.** `rideService.getLocalFareEstimate` fetches the route again, reads the time band from the device clock and, if a pricing experiment is active, the signed-in user's variant. 0 experiments are active, 0 rides had stops and 0 were corporate in the last 90 days; 3 were deliveries.
- **The admin has no Mapbox token** (`deploy-admin.yml` never passes `NEXT_PUBLIC_MAPBOX_TOKEN`), so a fare quoted there routes through the public OSRM server; the rider app uses Mapbox. The rider consents to the exact price shown, which is what is charged.
- **Dispatch does not skip test accounts** (`users.is_test` is not read by `dispatch_ride`, `find_best_drivers` or the reactivation push). A test ride in prod reaches real drivers.
- **`admin.json` already has a `support` section** (the support tickets page, 55 keys). This feature's admin copy lives in a new `ride_assist` section; `pnpm check:i18n` rejects duplicate keys.
- **Migration number.** `00628`. On 2026-10-07 master ended at `00626`; the open PRs with migrations were #965 (`00569`) and #1095 (`00627`, admin money policies, opened by a parallel session the same morning). #1094 reserves `00628` with a placeholder file until Task 3 fills it. Re-check right before writing the file (Task 3, step 1).

Rules from CLAUDE.md that apply throughout: commits in English with the conventional format (the `git commit` commands below show only the subject; end every message with the attribution trailer your session instructions give); no credentials in code; every new `public` table gets explicit GRANTs including `service_role`; never apply a migration or merge without explicit per-PR authorization; never say "listo" without evidence.

## File map

**Database**
- Create `supabase/migrations/00628_support_assisted_matching.sql` — everything server-side.
- Create `supabase/tests/00628/scaffold.sql` — prod's tables and live function bodies for the local rehearsal.
- Create `supabase/tests/00628/run.sh` — the rehearsal suite (RED without the migration, GREEN with it).

**Shared packages**
- Modify `packages/utils/src/searchWait.ts` — `searchHelpAvailable`, `rideShortCode`, `SUPPORT_WHATSAPP_PHONE`.
- Modify `packages/utils/src/fareCalculator.ts` — `pricingClock`.
- Modify `packages/utils/src/index.ts` — exports.
- Modify `packages/utils/src/__tests__/searchWait.test.ts`, `packages/utils/src/__tests__/fareCalculator.test.ts`.
- Modify `packages/api/src/services/ride.service.ts` — `getLocalFareEstimate` options.
- Create `packages/api/src/services/ride-assist.service.ts` — `rideAssistService`, `isProposalGone` and their types.
- Modify `packages/api/src/index.ts`, `packages/api/package.json` — exports.
- Create `packages/api/src/services/__tests__/ride-assist.test.ts`.
- Modify `packages/api/src/services/__tests__/ride.test.ts` — estimate options.
- Modify `packages/api/src/services/admin.service.ts` and `packages/api/src/services/__tests__/admin.test.ts` — ride search by code.

**Admin** (`apps/admin/src`)
- Create `lib/chime.ts` — the alert sound.
- Create `components/support/supportFormat.ts` — `waitLabel`, `agoLabel`, `telLink`.
- Create `hooks/useSupportWaitingRides.ts` — the banner's poll.
- Create `components/support/SupportWaitingBanner.tsx` — the banner.
- Modify `components/layout/AdminShell.tsx` — mount the banner.
- Create `components/support/assistErrors.ts` — error code → message.
- Create `components/support/AssistCandidates.tsx`, `components/support/AssistServiceChange.tsx`.
- Create `app/rides/[id]/assist/page.tsx` — the assist page.
- Modify `app/rides/[id]/page.tsx` — "Asistir" button.
- Modify `components/layout/Header.tsx` — breadcrumb label.
- Modify `app/settings/platform-config/page.tsx` — five `KNOWN_KEYS`.
- Modify `packages/i18n/src/locales/{es,en,pt}/admin.json` — a new `ride_assist` section (`support` already exists: it is the tickets page).

**Rider**
- Create `apps/client/src/hooks/useServiceProposal.ts`.
- Create `apps/client/src/components/SupportHelpButton.tsx`, `apps/client/src/components/ServiceProposalCard.tsx`.
- Modify `apps/client/app/(tabs)/index.tsx` — wire both into `SearchingView`.
- Modify `apps/client/src/hooks/useRide.ts` — notice type changes in the 3 s poll.
- Create `apps/web/src/app/track/[id]/SupportHelpCard.tsx`; modify `apps/web/src/app/track/[id]/page.tsx`.
- Modify `packages/i18n/src/locales/{es,en,pt}/rider.json` and `web.json`.

**Driver**
- Create `apps/driver/src/utils/rideAssignedPush.ts` (+ test) — recognizes the `ride_assigned` push and passes it on.
- Modify `apps/driver/src/hooks/useDriverRide.ts` — `requestActiveTripReconcile`, poll.
- Modify `apps/driver/src/hooks/useNotifications.ts` — `ride_assigned` push.
- Modify `packages/i18n/src/locales/{es,en,pt}/driver.json`.

## Phase 1 — Database (migration 00628)

### Task 1: Rehearsal cluster and scaffold

The rehearsal reproduces prod's tables and the live bodies of the functions around `rides` and `ride_offers` in a local Postgres 16 with PostGIS, so the migration can be tested RED → GREEN without touching prod.

**Files:**
- Create: `supabase/tests/00628/scaffold.sql`
- Create: `supabase/tests/00628/live-bodies.sql` (generated from prod in step 4)

- [ ] **Step 1: Install PostGIS and start the cluster**

```bash
test -f /usr/share/postgresql/16/extension/postgis.control || apt-get install -y postgresql-16-postgis-3
id pgtest >/dev/null 2>&1 || useradd -m pgtest
/usr/lib/postgresql/16/bin/pg_isready -h 127.0.0.1 -p 5433 \
  || su pgtest -c '/usr/lib/postgresql/16/bin/initdb -D ~/pg627 -U pgtest -A trust -E UTF8 --no-locale >/dev/null \
       && /usr/lib/postgresql/16/bin/pg_ctl -D ~/pg627 -o "-p 5433 -c listen_addresses=127.0.0.1" -l ~/pg627.log -w start'
/usr/lib/postgresql/16/bin/psql -h 127.0.0.1 -p 5433 -U pgtest -d postgres -Atc "SELECT current_user, version() LIKE 'PostgreSQL 16%'"
```

Expected last line: `pgtest|t`. If `pg_isready` reported a server already listening on 5433, confirm it is this session's (`su pgtest -c 'cat ~/pg627/postmaster.pid' | head -1` matches the PID from `ss -lptn 'sport = :5433'`); a cluster of another session must not be reused, because `run.sh` drops and recreates its databases.

- [ ] **Step 2: Write `supabase/tests/00628/scaffold.sql`**

```sql
-- Scaffold for the 00628 rehearsal (support-assisted matching).
-- Prod's tables as of 2026-10-07, reduced to the columns the code under test reads, and the
-- LIVE bodies of the functions around rides and ride_offers (live-bodies.sql, dumped from prod;
-- run.sh checks every body against prod's md5).
-- No Supabase stack: auth.uid() reads request.jwt.claim.sub like PostgREST, net.http_post records
-- its calls in net.calls instead of sending them, and cron is a stub with pg_cron's job table.
-- Every object belongs to a NON-superuser role named postgres, as in prod: dispatch_ride lets
-- through callers whose current_user is 'postgres', and the migration is applied as that role.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role TO postgres;

CREATE EXTENSION IF NOT EXISTS postgis;  -- in public, as in prod

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE SCHEMA net AUTHORIZATION postgres;
CREATE SCHEMA extensions AUTHORIZATION postgres;
CREATE SCHEMA cron AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO postgres;

SET ROLE postgres;

-- Until 2026-10-30 Supabase grants every new function and table of public to the API roles.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

-- pg_cron stub: the job table and schedule(), which upserts by name like pg_cron does.
CREATE TABLE cron.job (
  jobid bigserial PRIMARY KEY,
  schedule text NOT NULL,
  command text NOT NULL,
  username text NOT NULL DEFAULT current_user,
  active boolean NOT NULL DEFAULT true,
  jobname text UNIQUE
);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
LANGUAGE sql AS $f$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING jobid
$f$;

-- pg_net stub: same signature, records the call instead of sending it.
CREATE TABLE net.calls (
  id bigserial PRIMARY KEY,
  url text NOT NULL,
  headers jsonb,
  body jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
                              headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000)
RETURNS bigint LANGUAGE sql AS $f$
  INSERT INTO net.calls (url, headers, body) VALUES ($1, $4, $2) RETURNING id
$f$;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');
CREATE TYPE public.user_level AS ENUM ('bronce', 'plata', 'oro', 'platino', 'diamante');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');
CREATE TYPE public.payment_method AS ENUM ('tricicoin', 'cash', 'mixed', 'stripe', 'tropipay', 'corporate');
CREATE TYPE public.vehicle_type AS ENUM ('triciclo', 'moto', 'auto', 'confort');
CREATE TYPE public.driver_status AS ENUM ('pending_verification', 'under_review', 'approved', 'rejected', 'suspended');
CREATE TYPE public.pricing_snapshot_type AS ENUM ('estimate', 'final');
CREATE TYPE public.promotion_type AS ENUM ('percentage_discount', 'fixed_discount', 'bonus_credit');
CREATE TYPE public.wallet_account_type AS ENUM ('customer_cash', 'driver_cash', 'driver_hold', 'platform_revenue',
  'platform_promotions', 'corporate_cash', 'driver_quota', 'tricicoin', 'platform_fx_reserve');
CREATE TYPE public.driver_gps_status AS ENUM ('healthy', 'unavailable', 'rider_consented');

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  phone text,
  email text,
  full_name text NOT NULL DEFAULT '',
  role public.user_role NOT NULL DEFAULT 'customer',
  is_active boolean NOT NULL DEFAULT true,
  level public.user_level NOT NULL DEFAULT 'bronce',
  is_test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.cities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), is_active boolean NOT NULL DEFAULT true);

-- driver_profiles: every prod column (find_best_drivers and the offer triggers read many of them).
CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  status public.driver_status NOT NULL DEFAULT 'pending_verification',
  is_online boolean NOT NULL DEFAULT false,
  current_location geography,
  current_heading numeric,
  rating_avg numeric NOT NULL DEFAULT 5.00,
  total_rides integer NOT NULL DEFAULT 0,
  total_rides_completed integer NOT NULL DEFAULT 0,
  zone_id uuid,
  approved_at timestamptz,
  suspended_at timestamptz,
  suspended_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_financially_eligible boolean DEFAULT true,
  negative_balance_since timestamptz,
  match_score numeric DEFAULT 50.0,
  acceptance_rate numeric DEFAULT 100.0,
  total_rides_offered integer DEFAULT 0,
  custom_per_km_rate_cup integer,
  city_id uuid,
  is_on_break boolean NOT NULL DEFAULT false,
  last_heartbeat_at timestamptz DEFAULT now(),
  identity_number text,
  address text,
  province text,
  municipality text,
  has_criminal_record boolean DEFAULT false,
  criminal_record_details text,
  auto_accept_enabled boolean DEFAULT false,
  grace_trips_remaining integer DEFAULT 0,
  quota_blocked boolean DEFAULT false,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  terms_accepted_at timestamptz,
  auto_offline_at timestamptz
);

CREATE TABLE public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.driver_profiles(id),
  type public.vehicle_type NOT NULL,
  make text NOT NULL,
  model text NOT NULL,
  year integer NOT NULL,
  color text NOT NULL,
  plate_number text NOT NULL,
  capacity integer NOT NULL DEFAULT 2,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  max_cargo_length_cm integer,
  max_cargo_width_cm integer,
  max_cargo_height_cm integer,
  accepted_cargo_categories text[] DEFAULT '{}'::text[],
  accepts_cargo boolean DEFAULT false,
  max_cargo_weight_kg numeric
);

-- rides: every prod column, with prod's defaults and NOT NULLs.
CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  driver_id uuid,
  service_type text NOT NULL,
  status public.ride_status NOT NULL DEFAULT 'searching',
  payment_method public.payment_method NOT NULL DEFAULT 'cash',
  pickup_location geography NOT NULL,
  pickup_address text NOT NULL,
  dropoff_location geography NOT NULL,
  dropoff_address text NOT NULL,
  estimated_fare_cup integer NOT NULL DEFAULT 0,
  estimated_distance_m integer NOT NULL DEFAULT 0,
  estimated_duration_s integer NOT NULL DEFAULT 0,
  final_fare_cup integer,
  actual_distance_m integer,
  actual_duration_s integer,
  scheduled_at timestamptz,
  is_scheduled boolean NOT NULL DEFAULT false,
  accepted_at timestamptz,
  driver_arrived_at timestamptz,
  pickup_at timestamptz,
  completed_at timestamptz,
  canceled_at timestamptz,
  canceled_by uuid,
  cancellation_reason text,
  share_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  promo_code_id uuid,
  discount_amount_cup integer NOT NULL DEFAULT 0,
  surge_multiplier numeric NOT NULL DEFAULT 1.0,
  tip_amount integer NOT NULL DEFAULT 0,
  driver_custom_rate_cup integer,
  exchange_rate_usd_cup numeric,
  estimated_fare_trc integer,
  final_fare_trc integer,
  next_ride_id uuid,
  is_chained boolean DEFAULT false,
  scheduled_notified boolean DEFAULT false,
  city_id uuid,
  insurance_selected boolean NOT NULL DEFAULT false,
  insurance_premium_cup integer NOT NULL DEFAULT 0,
  rider_preferences jsonb,
  corporate_account_id uuid,
  pickup_lat double precision,
  pickup_lng double precision,
  dropoff_lat double precision,
  dropoff_lng double precision,
  ride_mode text NOT NULL DEFAULT 'passenger',
  estimated_duration_hours numeric,
  payment_status text NOT NULL DEFAULT 'not_applicable',
  payment_intent_id uuid,
  cancellation_fee_cup numeric NOT NULL DEFAULT 0,
  cancellation_fee_trc numeric NOT NULL DEFAULT 0,
  passenger_count integer NOT NULL DEFAULT 1,
  wait_time_seconds integer DEFAULT 0,
  wait_charge_cup numeric DEFAULT 0,
  is_split boolean DEFAULT false,
  arrived_at_destination_at timestamptz,
  wallet_ratio numeric DEFAULT 0,
  wallet_amount_cup integer DEFAULT 0,
  cash_amount_cup integer DEFAULT 0,
  dispatch_round integer NOT NULL DEFAULT 0,
  last_dispatched_at timestamptz,
  share_token_expires_at timestamptz,
  wait_time_minutes integer NOT NULL DEFAULT 0,
  wait_time_charge_cup integer NOT NULL DEFAULT 0,
  proximity_pickup_notified_at timestamptz,
  proximity_dropoff_notified_at timestamptz,
  quota_deduction_amount integer DEFAULT 0,
  excess_distance_uncharged_m integer NOT NULL DEFAULT 0,
  excess_distance_reason text,
  excess_distance_admin_reviewed boolean NOT NULL DEFAULT false,
  gps_override_requested_at timestamptz,
  gps_override_confirmed_at timestamptz,
  no_gps_validation boolean NOT NULL DEFAULT false,
  gps_check_distance_m integer,
  driver_gps_status public.driver_gps_status NOT NULL DEFAULT 'healthy',
  driver_gps_unavailable_at timestamptz,
  rider_gps_consent_at timestamptz,
  delivery_recipient_notified_at timestamptz,
  searching_seen_at timestamptz NOT NULL DEFAULT now(),
  shared_ride boolean NOT NULL DEFAULT false,
  shared_ride_seats_occupied integer,
  shared_ride_discount_cup integer NOT NULL DEFAULT 0,
  cancellation_reason_code text,
  completed_far_from_pin boolean NOT NULL DEFAULT false,
  actual_dropoff_location geography,
  reported_distance_m integer,
  partner_place_id uuid,
  partner_discount_cup integer NOT NULL DEFAULT 0,
  pickup_notes text,
  dropoff_notes text
);
CREATE UNIQUE INDEX rides_one_active_per_driver ON public.rides (driver_id)
  WHERE status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination');

CREATE TABLE public.ride_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL REFERENCES public.rides(id) ON DELETE CASCADE,
  driver_profile_id uuid NOT NULL REFERENCES public.driver_profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'expired', 'superseded')),
  composite_score numeric,
  distance_m double precision,
  offered_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  UNIQUE (ride_id, driver_profile_id)
);

CREATE TABLE public.ride_pricing_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL REFERENCES public.rides(id),
  snapshot_type public.pricing_snapshot_type NOT NULL,
  base_fare integer NOT NULL,
  per_km_rate integer NOT NULL,
  per_minute_rate integer NOT NULL,
  distance_m integer NOT NULL,
  duration_s integer NOT NULL,
  surge_multiplier numeric NOT NULL DEFAULT 1.00,
  subtotal integer NOT NULL,
  commission_rate numeric NOT NULL DEFAULT 0.150,
  commission_amount integer NOT NULL DEFAULT 0,
  total integer NOT NULL,
  pricing_rule_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  exchange_rate_usd_cup numeric,
  total_trc integer,
  min_fare integer,
  corporate_commission_rate numeric,
  default_commission_rate_snapshot numeric,
  pre_waypoints_total integer,
  CONSTRAINT rps_surge_multiplier_min1 CHECK (surge_multiplier IS NULL OR surge_multiplier >= 1)
);

CREATE TABLE public.ride_waypoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL REFERENCES public.rides(id),
  sort_order integer NOT NULL,
  location geography NOT NULL,
  address text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.service_type_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name_es text NOT NULL,
  name_en text NOT NULL,
  base_fare_cup integer NOT NULL,
  per_km_rate_cup integer NOT NULL,
  per_minute_rate_cup integer NOT NULL,
  min_fare_cup integer NOT NULL,
  max_passengers integer NOT NULL DEFAULT 2,
  icon_name text NOT NULL DEFAULT 'car',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.pricing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_type text NOT NULL,
  base_fare_cup integer NOT NULL,
  per_km_rate_cup integer NOT NULL,
  per_minute_rate_cup integer NOT NULL,
  min_fare_cup integer NOT NULL,
  time_window_start time,
  time_window_end time,
  day_of_week integer[],
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE public.platform_config (key text PRIMARY KEY, value jsonb, updated_at timestamptz DEFAULT now());

CREATE TABLE public.admin_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  old_values jsonb,
  new_values jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.admin_promo_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  admin_user_id uuid NOT NULL,
  ride_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  promo_code_id uuid,
  discount_amount_cup_supplied integer NOT NULL,
  estimated_fare_cup integer,
  notes text
);

CREATE TABLE public.cron_http_calls (
  request_id bigint PRIMARY KEY,
  jobname text NOT NULL,
  url text NOT NULL,
  called_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.rpc_attempt_log (
  id bigserial PRIMARY KEY,
  rpc_name text NOT NULL,
  caller_uid uuid,
  target_id uuid,
  outcome text NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.wallet_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  account_type public.wallet_account_type NOT NULL,
  balance integer NOT NULL DEFAULT 0,
  held_balance integer NOT NULL DEFAULT 0
);

CREATE TABLE public.corporate_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_by uuid NOT NULL,
  commission_percent numeric,
  is_fleet_owner boolean NOT NULL DEFAULT false
);
CREATE TABLE public.driver_fleets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corporate_account_id uuid NOT NULL,
  name text NOT NULL
);
CREATE TABLE public.fleet_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_id uuid NOT NULL,
  driver_id uuid,
  driver_name text NOT NULL,
  driver_phone text NOT NULL,
  status text NOT NULL DEFAULT 'pending_review'
);

CREATE TABLE public.promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  type public.promotion_type NOT NULL,
  discount_percent numeric,
  discount_fixed_cup integer,
  max_uses integer,
  current_uses integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  first_ride_only boolean NOT NULL DEFAULT false
);
CREATE TABLE public.promotion_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id uuid NOT NULL,
  user_id uuid NOT NULL,
  ride_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.partner_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  location geography NOT NULL,
  radius_m integer NOT NULL DEFAULT 80,
  is_active boolean NOT NULL DEFAULT true,
  valid_until timestamptz,
  discount_percent numeric NOT NULL DEFAULT 10
);

CREATE TABLE public.customer_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  rating_avg numeric NOT NULL DEFAULT 5.00
);

CREATE TABLE public.user_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_id uuid NOT NULL,
  blocked_id uuid NOT NULL
);

CREATE TABLE public.delivery_details (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL,
  package_category text,
  estimated_weight_kg numeric,
  package_length_cm integer,
  package_width_cm integer,
  package_height_cm integer
);

CREATE TABLE public.valid_transitions (
  from_status public.ride_status NOT NULL,
  to_status public.ride_status NOT NULL,
  allowed_roles public.user_role[] NOT NULL
);

CREATE TABLE public.ride_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL,
  from_status public.ride_status,
  to_status public.ride_status NOT NULL,
  actor_id uuid,
  actor_role public.user_role,
  reason text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.trip_insurance_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_type text NOT NULL,
  premium_pct numeric NOT NULL DEFAULT 0.0500,
  min_premium_cup integer NOT NULL DEFAULT 50,
  is_active boolean NOT NULL DEFAULT true
);

-- Stub: prod reads the key from the vault.
CREATE FUNCTION public.get_service_role_key() RETURNS text LANGUAGE sql AS $f$ SELECT 'test-service-key'::text $f$;

-- LIVE bodies, dumped from prod (Task 1, step 4). auth.uid, current_user_role and
-- is_super_admin come first: SQL functions are checked when created.
\ir live-bodies.sql

CREATE TRIGGER rides_create_estimate_snapshot AFTER INSERT ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.tg_rides_create_estimate_snapshot();
CREATE TRIGGER rides_sync_coords_trg BEFORE INSERT OR UPDATE ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.rides_sync_coords();
CREATE TRIGGER rides_validate_promo_discount BEFORE INSERT OR UPDATE OF promo_code_id, discount_amount_cup,
  shared_ride, shared_ride_seats_occupied, dropoff_location, corporate_account_id ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.tg_rides_validate_promo_discount();
CREATE TRIGGER trg_enforce_ride_transition BEFORE UPDATE OF status ON public.rides
  FOR EACH ROW WHEN (old.status IS DISTINCT FROM new.status) EXECUTE FUNCTION public.enforce_ride_transition();
CREATE TRIGGER trg_enforce_ride_update_columns BEFORE UPDATE ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.enforce_ride_update_columns();
CREATE TRIGGER trg_rides_validate_insurance BEFORE INSERT OR UPDATE ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.tg_rides_validate_insurance();
CREATE TRIGGER ride_offers_increment_offered AFTER INSERT ON public.ride_offers
  FOR EACH ROW EXECUTE FUNCTION public.tg_ride_offer_increment_offered();
CREATE TRIGGER ride_offers_refresh_acceptance AFTER UPDATE OF status ON public.ride_offers
  FOR EACH ROW EXECUTE FUNCTION public.tg_ride_offer_refresh_acceptance();
CREATE TRIGGER trg_notify_driver_new_offer AFTER INSERT ON public.ride_offers
  FOR EACH ROW EXECUTE FUNCTION public.notify_driver_new_offer();
CREATE TRIGGER trg_notify_driver_reoffer AFTER UPDATE OF status ON public.ride_offers
  FOR EACH ROW WHEN (old.status = 'expired' AND new.status = 'pending') EXECUTE FUNCTION public.notify_driver_new_offer();

-- Seeds -------------------------------------------------------------------------------------
INSERT INTO public.platform_config (key, value) VALUES
  ('commission_rate', '0.15'), ('offer_ttl_seconds', '60'), ('reoffer_cooldown_s', '120'),
  ('dispatch_stage1_seconds', '45'), ('dispatch_stage1_radius_m', '8000'), ('dispatch_max_radius_m', '50000'),
  ('dispatch_offer_limit', '0'), ('dispatch_heartbeat_window_s', '0'), ('low_rating_rider_threshold', '3.0'),
  ('shared_ride_discount_per_seat_pct', '7'),
  ('business_notification_email', '"ops@tricigo.test, jefa@tricigo.test"');

INSERT INTO public.valid_transitions VALUES
  ('searching', 'accepted', '{driver,admin,super_admin}'),
  ('searching', 'canceled', '{customer,admin,super_admin}');

INSERT INTO public.service_type_configs
  (slug, name_es, name_en, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup, max_passengers, is_active) VALUES
  ('triciclo_basico', 'Triciclo', 'Tricycle', 500, 150, 10, 1337, 4, true),
  ('moto_standard', 'Moto', 'Moto', 300, 90, 6, 620, 1, true),
  ('auto_standard', 'Auto', 'Car', 700, 200, 12, 1551, 4, true),
  ('auto_confort', 'Confort', 'Comfort', 900, 260, 15, 2011, 4, true),
  ('mensajeria', 'Mensajería', 'Delivery', 800, 200, 10, 2038, 0, true),
  ('triciclo_premium', 'Triciclo premium', 'Premium tricycle', 900, 250, 15, 4786, 8, false);
INSERT INTO public.pricing_rules (service_type, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup)
  SELECT slug, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup FROM public.service_type_configs;

INSERT INTO public.users (id, full_name, phone, role, is_test) VALUES
  ('a0000000-0000-4000-8000-0000000000ad', 'Ana Admin', '+5350000001', 'admin', false),
  ('a0000000-0000-4000-8000-0000000000ee', 'Sergio Super', '+5350000002', 'super_admin', false),
  ('c0000000-0000-4000-8000-000000000001', 'Rita Rider', '+5350000101', 'customer', false),
  ('c0000000-0000-4000-8000-000000000002', 'Oscar Otro', '+5350000102', 'customer', false),
  ('c0000000-0000-4000-8000-000000000003', 'Tina Test', '+5350000103', 'customer', true),
  ('e1000000-0000-4000-8000-000000000001', 'Daniel Uno', '+5350000201', 'driver', false),
  ('e2000000-0000-4000-8000-000000000002', 'Daniel Dos', '+5350000202', 'driver', false),
  ('e3000000-0000-4000-8000-000000000003', 'Daniel Tres', '+5350000203', 'driver', false),
  ('e4000000-0000-4000-8000-000000000004', 'Daniel Cuatro', '+5350000204', 'driver', false),
  ('e5000000-0000-4000-8000-000000000005', 'Daniel Cinco', '+5350000205', 'driver', false),
  ('e6000000-0000-4000-8000-000000000006', 'Daniel Seis', '+5350000206', 'driver', false),
  ('e7000000-0000-4000-8000-000000000007', 'Daniel Siete', '+5350000207', 'driver', false),
  ('e8000000-0000-4000-8000-000000000008', 'Daniel Ocho', '+5350000208', 'driver', false);
INSERT INTO public.customer_profiles (user_id, rating_avg) VALUES
  ('c0000000-0000-4000-8000-000000000001', 4.8),
  ('c0000000-0000-4000-8000-000000000002', 4.8),
  ('c0000000-0000-4000-8000-000000000003', 4.8);

-- Pickup of every test ride: (-82.3830, 23.1330). Distances along the same latitude.
INSERT INTO public.driver_profiles (id, user_id, status, is_online, current_location, last_heartbeat_at) VALUES
  -- D1 triciclo, online, ~307 m
  ('d1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'approved', true,
   ST_SetSRID(ST_MakePoint(-82.3800, 23.1330), 4326)::geography, now()),
  -- D2 moto, online, ~512 m
  ('d2000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000002', 'approved', true,
   ST_SetSRID(ST_MakePoint(-82.3780, 23.1330), 4326)::geography, now()),
  -- D3 triciclo, offline since 2 days, ~1 km
  ('d3000000-0000-4000-8000-000000000003', 'e3000000-0000-4000-8000-000000000003', 'approved', false,
   ST_SetSRID(ST_MakePoint(-82.3732, 23.1330), 4326)::geography, now() - interval '2 days'),
  -- D4 triciclo, online, busy with RB, ~800 m
  ('d4000000-0000-4000-8000-000000000004', 'e4000000-0000-4000-8000-000000000004', 'approved', true,
   ST_SetSRID(ST_MakePoint(-82.3752, 23.1330), 4326)::geography, now()),
  -- D5 auto, online, ~563 m
  ('d5000000-0000-4000-8000-000000000005', 'e5000000-0000-4000-8000-000000000005', 'approved', true,
   ST_SetSRID(ST_MakePoint(-82.3775, 23.1330), 4326)::geography, now()),
  -- D6 triciclo, online, no balance, ~389 m
  ('d6000000-0000-4000-8000-000000000006', 'e6000000-0000-4000-8000-000000000006', 'approved', true,
   ST_SetSRID(ST_MakePoint(-82.3792, 23.1330), 4326)::geography, now()),
  -- D7 triciclo, still in verification
  ('d7000000-0000-4000-8000-000000000007', 'e7000000-0000-4000-8000-000000000007', 'pending_verification', false,
   ST_SetSRID(ST_MakePoint(-82.3810, 23.1330), 4326)::geography, now()),
  -- D8 triciclo, online but its last heartbeat is 10 minutes old, ~451 m
  ('d8000000-0000-4000-8000-000000000008', 'e8000000-0000-4000-8000-000000000008', 'approved', true,
   ST_SetSRID(ST_MakePoint(-82.3786, 23.1330), 4326)::geography, now() - interval '10 minutes');
INSERT INTO public.vehicles (driver_id, type, make, model, year, color, plate_number) VALUES
  ('d1000000-0000-4000-8000-000000000001', 'triciclo', 'Bicitaxi', 'Clásico', 2020, 'Rojo', 'T-0001'),
  ('d2000000-0000-4000-8000-000000000002', 'moto', 'Suzuki', 'GN125', 2018, 'Negra', 'M-0002'),
  ('d3000000-0000-4000-8000-000000000003', 'triciclo', 'Bicitaxi', 'Clásico', 2019, 'Azul', 'T-0003'),
  ('d4000000-0000-4000-8000-000000000004', 'triciclo', 'Bicitaxi', 'Clásico', 2021, 'Verde', 'T-0004'),
  ('d5000000-0000-4000-8000-000000000005', 'auto', 'Lada', '2107', 1988, 'Blanco', 'A-0005'),
  ('d6000000-0000-4000-8000-000000000006', 'triciclo', 'Bicitaxi', 'Clásico', 2022, 'Amarillo', 'T-0006'),
  ('d7000000-0000-4000-8000-000000000007', 'triciclo', 'Bicitaxi', 'Clásico', 2023, 'Gris', 'T-0007'),
  ('d8000000-0000-4000-8000-000000000008', 'triciclo', 'Bicitaxi', 'Clásico', 2020, 'Blanco', 'T-0008');
INSERT INTO public.wallet_accounts (user_id, account_type, balance)
  SELECT user_id, 'tricicoin', CASE WHEN id = 'd6000000-0000-4000-8000-000000000006' THEN 0 ELSE 50000 END
  FROM public.driver_profiles;

-- RB: Oscar's ride, accepted by D4 (keeps D4 busy).
INSERT INTO public.rides (id, customer_id, driver_id, service_type, status, pickup_location, pickup_address,
  dropoff_location, dropoff_address, estimated_fare_cup, estimated_fare_trc, estimated_distance_m,
  estimated_duration_s, accepted_at) VALUES
  ('fb000000-0000-4000-8000-0000000000bb', 'c0000000-0000-4000-8000-000000000002',
   'd4000000-0000-4000-8000-000000000004', 'triciclo_basico', 'accepted',
   ST_SetSRID(ST_MakePoint(-82.3700, 23.1300), 4326)::geography, 'Línea y G',
   ST_SetSRID(ST_MakePoint(-82.3650, 23.1320), 4326)::geography, 'Paseo y 23', 1500, 1500, 1200, 300, now());

INSERT INTO public.promotions (id, code, type, discount_percent, valid_from) VALUES
  ('9a000000-0000-4000-8000-000000000025', 'BACO25', 'percentage_discount', 25, now() - interval '1 day');

INSERT INTO public.corporate_accounts (id, name, status, created_by) VALUES
  ('c0c00000-0000-4000-8000-000000000001', 'Empresa Uno', 'approved', 'c0000000-0000-4000-8000-000000000002');

RESET ROLE;
```

- [ ] **Step 3: Note what the live bodies must be**

These are the md5 of `prosrc` in prod on 2026-10-07. `run.sh` (Task 2) checks them, so a body that changed in prod since then, or a paste error, fails the suite.

| Function | md5 |
|---|---|
| `auth.uid` | `cdef18c69c4f4cbbced2eaf81e628b49` |
| `accept_ride_v2` | `b51311095327fa66df27849ec9a4660f` |
| `cron_http_post` | `15d9ded451c60f92a0fd0a3c4e1ee0ab` |
| `current_user_role` | `cb4a7c12d4e21fe2997135833f141e25` |
| `dispatch_ride` | `a16ae76866950dedd21d33595f345d63` |
| `driver_can_afford_commission` | `cc0dde026b1e9262afbda4bde8f79723` |
| `enforce_ride_transition` | `35bde4fd60a4a4fa0fc86a237ec4a414` |
| `enforce_ride_update_columns` | `c181b9e3e630e306a329de56398033f5` |
| `find_best_drivers` | `53a6b5d68be18d5369445986a83e2fa9` |
| `get_platform_config_numeric` | `13d2587037eca74854cf2394ba42a90c` |
| `get_platform_config_text` | `407a7b835c527164a4aa8b3aa8525ba5` |
| `is_admin` | `22cb75e91980d512498034cd33e1eda2` |
| `is_super_admin` | `5655a4615e92e8b1e323d06c7566b058` |
| `log_rpc_attempt` | `0a902c34a1148dac5686403a7c941bc0` |
| `notify_driver_new_offer` | `6226f91fe0acacd99b298718a3c35937` |
| `rides_sync_coords` | `66b9877c7ff14aed2dd133d0d04b64b7` |
| `tg_ride_offer_increment_offered` | `34482879e7d798ba9c96c5c8ae67a993` |
| `tg_ride_offer_refresh_acceptance` | `f9c2c0652ab23eb08f1b2b571a2d8ee6` |
| `tg_rides_create_estimate_snapshot` | `b801283b9dcb6de3e4822992347d962e` |
| `tg_rides_validate_insurance` | `4d5516aca57a3b81076fdad9fdb6f9f6` |
| `tg_rides_validate_promo_discount` | `d4494bd8ab75ce590e1c42743583aec5` |

- [ ] **Step 4: Dump the live bodies into `supabase/tests/00628/live-bodies.sql`**

Run this with `mcp__Supabase__execute_sql` (project `lqaufszburqvlslpcuac`). It returns one row per function: its md5 and its full `CREATE OR REPLACE` statement as base64 on a single line (base64 survives copying where an SQL body full of quotes and backslashes does not).

```sql
SELECT n.nspname || '.' || p.proname AS fn,
       md5(p.prosrc) AS md5,
       replace(encode(convert_to(pg_get_functiondef(p.oid) || E';\n\n', 'UTF8'), 'base64'), E'\n', '') AS def_b64
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE (n.nspname = 'auth' AND p.proname = 'uid')
   OR (n.nspname = 'public' AND p.proname IN (
        'accept_ride_v2', 'cron_http_post', 'current_user_role', 'dispatch_ride', 'driver_can_afford_commission',
        'enforce_ride_transition', 'enforce_ride_update_columns', 'find_best_drivers',
        'get_platform_config_numeric', 'get_platform_config_text', 'is_admin', 'is_super_admin',
        'log_rpc_attempt', 'notify_driver_new_offer', 'rides_sync_coords', 'tg_ride_offer_increment_offered',
        'tg_ride_offer_refresh_acceptance', 'tg_rides_create_estimate_snapshot', 'tg_rides_validate_insurance',
        'tg_rides_validate_promo_discount'))
ORDER BY CASE n.nspname || '.' || p.proname
           WHEN 'auth.uid' THEN 0 WHEN 'public.current_user_role' THEN 1 WHEN 'public.is_super_admin' THEN 2 ELSE 3 END,
         p.proname;
```

If a row's `md5` differs from the table in step 3, stop: prod changed after this plan was written, and the migration's guards (Task 4) would refuse to run against it. Re-read that function in prod and update the plan before going on.

Write each `def_b64` value to its own file in a scratch directory outside the repo (your session's scratchpad if it has one, otherwise a `mktemp -d`), one line and nothing else, named `00-auth.uid.b64`, `01-…` in the order returned. Then decode them into the scaffold's include:

```bash
SP=<that scratch directory>
ls "$SP"/*.b64 | wc -l            # expect 21 files, named 00-auth.uid.b64, 01-..., in the query's order
: > supabase/tests/00628/live-bodies.sql
for f in $(ls "$SP"/*.b64 | sort); do base64 -d "$f" >> supabase/tests/00628/live-bodies.sql || echo "BAD $f"; done
grep -c '^CREATE OR REPLACE FUNCTION' supabase/tests/00628/live-bodies.sql
```

Expected: no `BAD` line and a count of `21`. The md5 check in Task 2 proves each body is byte-identical to prod.

- [ ] **Step 5: Load the scaffold once by hand**

```bash
BIN=/usr/lib/postgresql/16/bin; CONN="-h 127.0.0.1 -p 5433 -U pgtest"
$BIN/dropdb $CONN --if-exists s627 && $BIN/createdb $CONN s627
$BIN/psql $CONN -d s627 -q -v ON_ERROR_STOP=1 -f supabase/tests/00628/scaffold.sql && echo LOADED
$BIN/psql $CONN -d s627 -Atc "SELECT count(*) FROM public.driver_profiles; SELECT count(*) FROM public.ride_pricing_snapshots"
$BIN/dropdb $CONN s627
```

Expected: `LOADED`, then `8` and `1` (RB's estimate row, written by the live trigger).

- [ ] **Step 6: Commit**

```bash
git add supabase/tests/00628/scaffold.sql supabase/tests/00628/live-bodies.sql
git commit -m "test(db): scaffold for the 00628 support-assisted matching rehearsal"
```

### Task 2: Rehearsal suite (RED)

Write every test before the migration. Each test is one transaction that is rolled back, so tests cannot leak into each other. The race test (P12) needs committed data and uses its own database.

**Files:**
- Create: `supabase/tests/00628/run.sh`

- [ ] **Step 1: Write `supabase/tests/00628/run.sh`**

```bash
#!/usr/bin/env bash
# Rehearsal runner for migration 00628 (support-assisted matching).
# Local Postgres 16 + PostGIS, no Supabase stack.
#   supabase/tests/00628/run.sh none
#       -> prod as of 2026-10-07 (scaffold + live bodies) + tests
#          (RED: none of the support functions exist)
#   supabase/tests/00628/run.sh supabase/migrations/00628_support_assisted_matching.sql
#       -> the same + the migration applied twice (idempotency) + tests (GREEN)
# The migration is applied as postgres, the scaffold's non-superuser owner, with an empty
# search_path, so every name in it must be schema-qualified.
# Cluster: Task 1 of docs/superpowers/plans/2026-10-07-support-assisted-matching.md
# (user pgtest, port 5433, PostGIS). Other clusters: PGBIN=<dir with psql> PGPORT=<port>.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8
DB=pr627
RACE=pr627race
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = '';"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# psql on DBNAME; errors show their SQLSTATE; empty lines dropped; rows joined with ';'
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
# val NAME SQL EXPECTED [DBNAME] -> the printed rows, joined with ';', must equal EXPECTED
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# err NAME SQL PATTERN [DBNAME] -> the statements must fail with an error matching PATTERN
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

ADMIN=a0000000-0000-4000-8000-0000000000ad     # admin
SUPER=a0000000-0000-4000-8000-0000000000ee     # super_admin
RIDER=c0000000-0000-4000-8000-000000000001     # Rita, the rider of every test ride
OTHER=c0000000-0000-4000-8000-000000000002     # Oscar, another rider (owns RB)
TESTER=c0000000-0000-4000-8000-000000000003    # Tina, users.is_test
U1=e1000000-0000-4000-8000-000000000001        # D1's user
U5=e5000000-0000-4000-8000-000000000005        # D5's user
D1=d1000000-0000-4000-8000-000000000001        # triciclo, online, ~307 m
D2=d2000000-0000-4000-8000-000000000002        # moto, online
D3=d3000000-0000-4000-8000-000000000003        # triciclo, offline since 2 days
D4=d4000000-0000-4000-8000-000000000004        # triciclo, online, busy with RB
D5=d5000000-0000-4000-8000-000000000005        # auto, online
D6=d6000000-0000-4000-8000-000000000006        # triciclo, online, no balance
D7=d7000000-0000-4000-8000-000000000007        # triciclo, pending_verification
D8=d8000000-0000-4000-8000-000000000008        # triciclo, online, heartbeat 10 min old
R1=f1000000-0000-4000-8000-000000000001
R2=f2000000-0000-4000-8000-000000000002
R3=f3000000-0000-4000-8000-000000000003
R4=f4000000-0000-4000-8000-000000000004
R5=f5000000-0000-4000-8000-000000000005
RB=fb000000-0000-4000-8000-0000000000bb        # Oscar's ride, accepted by D4
PROMO=9a000000-0000-4000-8000-000000000025     # BACO25, 25 %
CORP=c0c00000-0000-4000-8000-000000000001
FLEET=f1ee0000-0000-4000-8000-000000000001
P1=b1000000-0000-4000-8000-000000000001        # a proposal on R1
SNAP_OLD=5a000000-0000-4000-8000-0000000000a1  # estimate row written by the LIVE trigger
SNAP_NEW=5a000000-0000-4000-8000-0000000000a2  # estimate row written after the migration

# ride ID [SERVICE] [FARE] [AGE]: Rita's searching ride, Vedado -> Capitolio, created AGE ago
ride(){ echo "INSERT INTO public.rides (id, customer_id, service_type, status, payment_method,
  pickup_location, pickup_address, dropoff_location, dropoff_address,
  estimated_fare_cup, estimated_fare_trc, estimated_distance_m, estimated_duration_s, exchange_rate_usd_cup, created_at)
  VALUES ('$1', '$RIDER', '${2:-triciclo_basico}', 'searching', 'cash',
  ST_SetSRID(ST_MakePoint(-82.3830, 23.1330), 4326)::geography, 'Calle 23 e/ L y M, Vedado',
  ST_SetSRID(ST_MakePoint(-82.3590, 23.1350), 4326)::geography, 'Capitolio, Centro Habana',
  ${3:-2000}, ${3:-2000}, 2800, 600, 500, now() - interval '${4:-2 minutes}');"; }
# offer DRIVER STATUS EXPIRES: an existing ride_offers row on R1
offer(){ echo "INSERT INTO public.ride_offers (ride_id, driver_profile_id, status, expires_at)
  VALUES ('$R1', '$1', '${2:-pending}', now() + interval '${3:-1 minute}');"; }
# prop [STATUS] [EXPIRES]: P1 on R1, triciclo_basico 2000 -> auto_standard 3000
prop(){ echo "INSERT INTO public.ride_service_proposals (id, ride_id, from_service_type, to_service_type,
  from_fare_cup, to_fare_cup, proposed_by, status, expires_at)
  VALUES ('$P1', '$R1', 'triciclo_basico', 'auto_standard', 2000, 3000, '$ADMIN', '${1:-pending}',
  now() + interval '${2:-3 minutes}');"; }
# The scaffold's heartbeats are as old as the load; fresh ones for every online driver but D8.
BEAT="UPDATE public.driver_profiles SET last_heartbeat_at = now() WHERE is_online AND id <> '$D8';"
# Forget the offer pushes a setup's own INSERTs queued.
QUIET="DELETE FROM net.calls;"
# tx SETUP UID CALL CHECK: one transaction, rolled back. SETUP runs without a JWT (as service
# code would), CALL as authenticated with JWT subject UID (as PostgREST would), CHECK without a JWT.
tx(){ printf "BEGIN; %s SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s RESET ROLE; SET LOCAL request.jwt.claim.sub = ''; %s; ROLLBACK;" "$1" "$2" "$3" "$4"; }
# as UID: switch the JWT subject inside an open transaction, as authenticated
as(){ printf "RESET ROLE; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated;" "$1"; }
# calls LABEL: how many HTTP calls the label queued through cron_http_post
calls(){ echo "(SELECT count(*) FROM public.cron_http_calls WHERE jobname = '$1')"; }
# pcheck: P1's status and R1's service type
PCHECK="SELECT p.status || '|' || r.service_type FROM public.ride_service_proposals p JOIN public.rides r ON r.id = p.ride_id WHERE p.id = '$P1'"
# rstate: R1's service type and fare
RSTATE="SELECT service_type || '|' || estimated_fare_cup FROM public.rides WHERE id = '$R1'"

load(){ local db=$1
  $BIN/dropdb $CONN --if-exists "$db" >/dev/null 2>&1
  $BIN/createdb $CONN "$db" || { echo "createdb $db failed"; exit 1; }
  $BIN/psql $CONN -d "$db" -q -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >"$TMP/scaffold.out" 2>&1 \
    || { echo "scaffold failed:"; cat "$TMP/scaffold.out"; exit 1; }
}
migrate(){ local db=$1 i
  [ "$MIG" = none ] && return 0
  for i in 1 2; do
    $BIN/psql $CONN -d "$db" -q -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >"$TMP/mig.out" 2>&1 \
      || { echo "migration failed on apply $i:"; cat "$TMP/mig.out"; exit 1; }
  done
}

load $DB

# L1: the scaffold carries prod's live bodies (md5 of prosrc read from prod on 2026-10-07)
val L1 "SELECT string_agg(p.proname || '=' || md5(p.prosrc), ',' ORDER BY p.proname COLLATE \"C\")
  FROM pg_proc p WHERE p.pronamespace IN ('public'::regnamespace, 'auth'::regnamespace) AND p.proname IN (
  'uid', 'accept_ride_v2', 'cron_http_post', 'current_user_role', 'dispatch_ride', 'driver_can_afford_commission',
  'enforce_ride_transition', 'enforce_ride_update_columns', 'find_best_drivers', 'get_platform_config_numeric',
  'get_platform_config_text', 'is_admin', 'is_super_admin', 'log_rpc_attempt', 'notify_driver_new_offer',
  'rides_sync_coords', 'tg_ride_offer_increment_offered', 'tg_ride_offer_refresh_acceptance',
  'tg_rides_create_estimate_snapshot', 'tg_rides_validate_insurance', 'tg_rides_validate_promo_discount')" \
  "accept_ride_v2=b51311095327fa66df27849ec9a4660f,cron_http_post=15d9ded451c60f92a0fd0a3c4e1ee0ab,current_user_role=cb4a7c12d4e21fe2997135833f141e25,dispatch_ride=a16ae76866950dedd21d33595f345d63,driver_can_afford_commission=cc0dde026b1e9262afbda4bde8f79723,enforce_ride_transition=35bde4fd60a4a4fa0fc86a237ec4a414,enforce_ride_update_columns=c181b9e3e630e306a329de56398033f5,find_best_drivers=53a6b5d68be18d5369445986a83e2fa9,get_platform_config_numeric=13d2587037eca74854cf2394ba42a90c,get_platform_config_text=407a7b835c527164a4aa8b3aa8525ba5,is_admin=22cb75e91980d512498034cd33e1eda2,is_super_admin=5655a4615e92e8b1e323d06c7566b058,log_rpc_attempt=0a902c34a1148dac5686403a7c941bc0,notify_driver_new_offer=6226f91fe0acacd99b298718a3c35937,rides_sync_coords=66b9877c7ff14aed2dd133d0d04b64b7,tg_ride_offer_increment_offered=34482879e7d798ba9c96c5c8ae67a993,tg_ride_offer_refresh_acceptance=f9c2c0652ab23eb08f1b2b571a2d8ee6,tg_rides_create_estimate_snapshot=b801283b9dcb6de3e4822992347d962e,tg_rides_validate_insurance=4d5516aca57a3b81076fdad9fdb6f9f6,tg_rides_validate_promo_discount=d4494bd8ab75ce590e1c42743583aec5,uid=cdef18c69c4f4cbbced2eaf81e628b49"

# An estimate row written by the LIVE trigger, for S11. Canceled at once so no alert sees it.
run $DB "$(ride $SNAP_OLD) UPDATE public.rides SET status = 'canceled' WHERE id = '$SNAP_OLD';" >/dev/null
migrate $DB

# --- H: the rider asks for help ----------------------------------------------------------
val H1 "$(tx "$(ride $R1)" $RIDER "SELECT public.request_ride_help('$R1')->>'code';" \
  "SELECT (SELECT help_requested_at IS NOT NULL FROM public.ride_assist WHERE ride_id = '$R1'),
          $(calls support-help-alert), $(calls support-help-email),
          (SELECT c.body->>'category' || ':' || jsonb_array_length(c.body->'user_ids') || ':' || (c.body->'data'->>'event')
             FROM net.calls c JOIN public.cron_http_calls h ON h.request_id = c.id WHERE h.jobname = 'support-help-alert')")" \
  "F1000000;t|1|2|system:2:support_help"
val H2 "$(tx "$(ride $R1)" $RIDER "SELECT public.request_ride_help('$R1')->>'success'; SELECT public.request_ride_help('$R1')->>'success';" \
  "SELECT $(calls support-help-alert)")" "true;true;1"
val H3 "$(tx "$(ride $R1)" $OTHER "SELECT public.request_ride_help('$R1')->>'error';" "SELECT count(*) FROM public.ride_assist")" \
  "ride_not_found;0"
val H4 "$(tx "" $OTHER "SELECT public.request_ride_help('$RB')->>'error';" "SELECT count(*) FROM public.ride_assist")" \
  "ride_not_searching;0"
err H5 "BEGIN; $(ride $R1) SET LOCAL ROLE anon; SELECT public.request_ride_help('$R1'); ROLLBACK;" \
  "permission denied for function request_ride_help"
val H6 "$(tx "$(ride $R1) UPDATE public.platform_config SET value = '\"\"' WHERE key = 'support_alert_email';" $RIDER \
  "SELECT public.request_ride_help('$R1')->>'success';" "SELECT $(calls support-help-alert), $(calls support-help-email)")" \
  "true;1|0"
val H7 "$(tx "$(ride $R1) UPDATE public.rides SET pickup_address = '<script>x</script>' WHERE id = '$R1';" $RIDER \
  "SELECT public.request_ride_help('$R1')->>'success';" \
  "SELECT bool_and(position('&lt;script&gt;' IN c.body->>'template') > 0 AND position('<script>' IN c.body->>'template') = 0
                   AND c.body->>'template' LIKE '%/rides/$R1/assist%')
     FROM net.calls c WHERE c.url LIKE '%/send-email'")" "true;t"
val H8 "$(tx "$(ride $R1) UPDATE public.rides SET customer_id = '$TESTER' WHERE id = '$R1';" $TESTER \
  "SELECT public.request_ride_help('$R1')->>'success';" "SELECT $(calls support-help-alert)")" "true;1"

# --- C: the one-minute alert cron ---------------------------------------------------------
val C1 "BEGIN; $(ride $R1) SELECT public.notify_support_waiting_rides();
  SELECT (SELECT wait_alert_sent_at IS NOT NULL FROM public.ride_assist WHERE ride_id = '$R1'),
         $(calls support-wait-alert), $(calls support-wait-email); ROLLBACK;" "1;t|1|2"
val C2 "BEGIN; $(ride $R1) SELECT public.notify_support_waiting_rides(); SELECT public.notify_support_waiting_rides(); ROLLBACK;" "1;0"
val C3 "BEGIN; $(ride $R1) $(ride $R2 triciclo_basico 2000 '30 seconds') $(ride $R3 triciclo_basico 2000 '10 minutes') $(ride $R4 triciclo_basico 2000 '7 hours')
  UPDATE public.rides SET customer_id = '$TESTER' WHERE id = '$R1';
  UPDATE public.rides SET is_scheduled = true, scheduled_at = now() + interval '1 hour' WHERE id = '$R3';
  SELECT public.notify_support_waiting_rides(); ROLLBACK;" "0"
val C4 "BEGIN; $(ride $R1) UPDATE public.platform_config SET value = 'false' WHERE key = 'support_alert_enabled';
  SELECT public.notify_support_waiting_rides(); ROLLBACK;" "0"
val C5 "SELECT schedule || ' / ' || command FROM cron.job WHERE jobname = 'notify-support-waiting-rides'" \
  "* * * * * / SELECT public.notify_support_waiting_rides()"

# --- W: the banner's list -----------------------------------------------------------------
WCOLS="ride_id, code, waiting_since, wait_s, help_requested_at, service_type, estimated_fare_cup, pickup_address, dropoff_address, pending_offers, is_test, ord"
err W1 "$(tx "" $RIDER "SELECT count(*) FROM public.admin_support_waiting_rides();" "SELECT 1")" "forbidden"
val W2 "$(tx "$(ride $R1) $(ride $R2 triciclo_basico 2000 '5 minutes') $(ride $R3 triciclo_basico 2000 '30 seconds') $(ride $R4 triciclo_basico 2000 '3 minutes') $(ride $R5 triciclo_basico 2000 '20 seconds')
  UPDATE public.rides SET customer_id = '$TESTER' WHERE id = '$R4';
  INSERT INTO public.ride_assist (ride_id, help_requested_at) VALUES ('$R3', now());" $ADMIN \
  "SELECT string_agg(w.code || ':' || w.is_test, ',' ORDER BY w.ord) FROM public.admin_support_waiting_rides() WITH ORDINALITY AS w($WCOLS);" \
  "SELECT 1")" "F3000000:false,F2000000:false,F4000000:true,F1000000:false;1"

# --- K: the assist page's context and candidates ------------------------------------------
KCOLS="driver_profile_id, full_name, phone, vehicle_type, vehicle_label, is_online, last_heartbeat_at, distance_m, busy_ride_id, can_afford, offer_status, offer_expires_at, ord"
val K1 "$(tx "$(ride $R1) INSERT INTO public.ride_assist (ride_id, help_requested_at) VALUES ('$R1', now());" $ADMIN \
  "SELECT c->'ride'->>'code', round((c->'ride'->>'pickup_lat')::numeric, 3), c->'ride'->>'customer_phone',
          c->>'help_requested_at' IS NOT NULL, jsonb_array_length(c->'offers'), jsonb_typeof(c->'proposal')
     FROM (SELECT public.admin_ride_assist_context('$R1') AS c) x;" "SELECT 1")" \
  "F1000000|23.133|+5350000101|t|0|null;1"
val K2 "$(tx "$(ride $R1) $BEAT" $ADMIN \
  "SELECT string_agg(left(x.driver_profile_id::text, 2) || ':' || x.is_online || ':' || x.can_afford || ':' || (x.busy_ride_id IS NOT NULL), ',' ORDER BY x.ord)
     FROM public.admin_ride_assist_candidates('$R1') WITH ORDINALITY AS x($KCOLS);" "SELECT 1")" \
  "d1:true:true:false,d6:true:false:false,d8:true:true:false,d4:true:true:true,d3:false:true:false;1"
val K3 "$(tx "$(ride $R1)" $ADMIN \
  "SELECT string_agg(left(x.driver_profile_id::text, 2), ',' ORDER BY x.ord)
     FROM public.admin_ride_assist_candidates('$R1', 'auto_standard') WITH ORDINALITY AS x($KCOLS);" "SELECT 1")" "d5;1"
val K4 "$(tx "$(ride $R1) INSERT INTO public.user_blocks (blocker_id, blocked_id) VALUES ('$RIDER', '$U1');" $ADMIN \
  "SELECT left(x.driver_profile_id::text, 2) FROM public.admin_ride_assist_candidates('$R1') WITH ORDINALITY AS x($KCOLS) ORDER BY x.ord LIMIT 1;" \
  "SELECT 1")" "d6;1"
err K5 "$(tx "$(ride $R1)" $RIDER "SELECT public.admin_ride_assist_candidates('$R1');" "SELECT 1")" "forbidden"

# --- O: support sends an offer --------------------------------------------------------------
OSTATE="SELECT o.status || '|' || (SELECT count(*) FROM net.calls c WHERE c.body->>'user_id' = '$U1') || '|' || extract(epoch FROM o.expires_at - now())::int
  FROM public.ride_offers o WHERE o.ride_id = '$R1' AND o.driver_profile_id = '$D1'"
val O1 "$(tx "$(ride $R1)" $RIDER "SELECT public.admin_offer_ride_to_driver('$R1', '$D1')->>'error';" "SELECT count(*) FROM public.ride_offers")" \
  "forbidden;0"
val O2 "$(tx "$(ride $R1)" $ADMIN "SELECT public.admin_offer_ride_to_driver('$R1', '$D1')->>'mode';" \
  "SELECT o.status, extract(epoch FROM o.expires_at - now())::int, o.distance_m BETWEEN 250 AND 350,
          (SELECT c.body->>'category' FROM net.calls c WHERE c.body->>'user_id' = '$U1'),
          (SELECT count(*) FROM public.admin_actions WHERE action = 'support_offer_ride')
     FROM public.ride_offers o WHERE o.ride_id = '$R1' AND o.driver_profile_id = '$D1'")" \
  "created;pending|120|t|ride_offer|1"
val O3 "$(tx "$(ride $R1) $(offer $D1 expired '-5 minutes') $QUIET" $ADMIN "SELECT public.admin_offer_ride_to_driver('$R1', '$D1')->>'mode';" "$OSTATE")" \
  "rearmed;pending|1|120"
val O4 "$(tx "$(ride $R1) $(offer $D1 rejected '-1 minute') $QUIET" $ADMIN "SELECT public.admin_offer_ride_to_driver('$R1', '$D1')->>'mode';" "$OSTATE")" \
  "rearmed;pending|1|120"
val O5 "$(tx "$(ride $R1) $(offer $D1 pending '20 seconds') $QUIET" $ADMIN "SELECT public.admin_offer_ride_to_driver('$R1', '$D1')->>'mode';" "$OSTATE")" \
  "extended;pending|0|120"
val O6 "$(tx "$(ride $R1)" $ADMIN "SELECT public.admin_offer_ride_to_driver('$R1', '$D2')->>'error';" "SELECT count(*) FROM public.ride_offers WHERE ride_id = '$R1'")" \
  "wrong_vehicle_type;0"
val O7 "$(tx "$(ride $R1)" $ADMIN "SELECT public.admin_offer_ride_to_driver('$R1', '$D7')->>'error';" "SELECT count(*) FROM public.ride_offers WHERE ride_id = '$R1'")" \
  "driver_not_approved;0"
val O8 "$(tx "" $ADMIN "SELECT public.admin_offer_ride_to_driver('$RB', '$D1')->>'error';" "SELECT 1")" "ride_not_searching;1"
val O9 "$(tx "$(ride $R1) INSERT INTO public.user_blocks (blocker_id, blocked_id) VALUES ('$U1', '$RIDER');" $ADMIN \
  "SELECT public.admin_offer_ride_to_driver('$R1', '$D1')->>'error';" "SELECT count(*) FROM public.ride_offers WHERE ride_id = '$R1'")" \
  "blocked;0"
val O10 "BEGIN; $(ride $R1) $BEAT $(as $ADMIN) SELECT public.admin_offer_ride_to_driver('$R1', '$D1')->>'mode';
  $(as $U1) SELECT public.accept_ride_v2('$R1', '$D1')->>'success';
  RESET ROLE; SELECT status || ':' || left(driver_id::text, 2) FROM public.rides WHERE id = '$R1'; ROLLBACK;" \
  "created;true;accepted:d1"

# --- A: support assigns directly -----------------------------------------------------------
ASTATE="SELECT status FROM public.rides WHERE id = '$R1'"
assign(){ echo "SELECT public.admin_assign_ride_to_driver('$R1', '$1', '${2:-Lo coordiné por WhatsApp}')->>'${3:-error}';"; }
val A1 "$(tx "$(ride $R1) $BEAT" $ADMIN "$(assign $D1 '   ')" "$ASTATE")" "reason_required;searching"
val A2 "$(tx "$(ride $R1) $BEAT $(offer $D1) $(offer $D6)" $ADMIN "$(assign $D1 'Lo coordiné por WhatsApp' success)" \
  "SELECT r.status || ':' || left(r.driver_id::text, 2),
          (SELECT string_agg(left(o.driver_profile_id::text, 2) || '=' || o.status, ',' ORDER BY o.driver_profile_id) FROM public.ride_offers o WHERE o.ride_id = '$R1'),
          (SELECT (c.body->'data'->>'event') || '@' || (c.body->>'user_id' = '$U1') || '@' || (c.body->>'category')
             FROM net.calls c JOIN public.cron_http_calls h ON h.request_id = c.id WHERE h.jobname = 'support-assign-push'),
          (SELECT reason FROM public.admin_actions WHERE action = 'support_assign_ride'),
          (SELECT actor_role FROM public.ride_transitions WHERE ride_id = '$R1' AND to_status = 'accepted')
     FROM public.rides r WHERE r.id = '$R1'")" \
  "true;accepted:d1|d1=accepted,d6=superseded|ride_assigned@true@system|Lo coordiné por WhatsApp|admin"
val A3 "$(tx "$(ride $R1) $BEAT" $ADMIN "$(assign $D3)" "$ASTATE")" "not_online;searching"
val A4 "$(tx "$(ride $R1) $BEAT" $ADMIN "$(assign $D8)" "$ASTATE")" "stale_heartbeat;searching"
val A5 "$(tx "$(ride $R1) $BEAT" $ADMIN "$(assign $D4)" "$ASTATE")" "busy;searching"
val A6 "$(tx "$(ride $R1) $BEAT" $ADMIN "$(assign $D6)" "$ASTATE")" "insufficient_balance;searching"
val A7 "$(tx "$(ride $R1) $BEAT" $ADMIN "$(assign $D2)" "$ASTATE")" "wrong_vehicle_type;searching"
val A8 "$(tx "$(ride $R1) $BEAT UPDATE public.rides SET status = 'canceled' WHERE id = '$R1';" $ADMIN "$(assign $D1)" "$ASTATE")" \
  "ride_not_searching;canceled"
val A9 "$(tx "$(ride $R1) $BEAT" $RIDER "$(assign $D1)" "$ASTATE")" "forbidden;searching"
val A10 "$(tx "$(ride $R1) $BEAT UPDATE public.corporate_accounts SET is_fleet_owner = true WHERE id = '$CORP';
  INSERT INTO public.driver_fleets (id, corporate_account_id, name) VALUES ('$FLEET', '$CORP', 'Flota Uno');
  INSERT INTO public.fleet_members (fleet_id, driver_id, driver_name, driver_phone, status) VALUES ('$FLEET', '$U5', 'Daniel Cinco', '+5350000205', 'active');
  UPDATE public.rides SET corporate_account_id = '$CORP' WHERE id = '$R1';" $ADMIN "$(assign $D1)" "$ASTATE")" "not_in_fleet;searching"

# --- S: support switches the vehicle type with WhatsApp consent -----------------------------
apply(){ echo "SELECT public.admin_change_ride_service('$R1', '$1', $2, 'apply', ${3:-'Aceptó por WhatsApp'})->>'${4:-error}';"; }
val S1 "$(tx "$(ride $R1) $BEAT UPDATE public.rides SET shared_ride = true, shared_ride_seats_occupied = 1 WHERE id = '$R1'; $(offer $D1)" $ADMIN \
  "$(apply auto_standard 3000 "'Aceptó por WhatsApp'" mode)" \
  "SELECT r.service_type, r.estimated_fare_cup, r.estimated_fare_trc, r.shared_ride, r.shared_ride_discount_cup, r.discount_amount_cup,
          (SELECT count(*) || ':' || max(s.total) || ':' || max(s.base_fare) FROM public.ride_pricing_snapshots s WHERE s.ride_id = '$R1' AND s.snapshot_type = 'estimate'),
          (SELECT string_agg(left(o.driver_profile_id::text, 2) || '=' || o.status, ',' ORDER BY o.driver_profile_id) FROM public.ride_offers o WHERE o.ride_id = '$R1'),
          r.dispatch_round, (SELECT count(*) FROM public.admin_actions WHERE action = 'support_change_service')
     FROM public.rides r WHERE r.id = '$R1'")" \
  "apply;auto_standard|3000|3000|f|0|0|1:3000:700|d1=superseded,d5=pending|1|1"
DSTATE="SELECT discount_amount_cup || '|' || (promo_code_id IS NOT NULL) FROM public.rides WHERE id = '$R1'"
val S2 "$(tx "$(ride $R1) UPDATE public.rides SET promo_code_id = '$PROMO' WHERE id = '$R1';" $ADMIN \
  "$(apply auto_standard 3000 "'Aceptó por WhatsApp'" mode)" "$DSTATE")" "apply;750|true"
val S3 "$(tx "$(ride $R1) UPDATE public.rides SET promo_code_id = '$PROMO' WHERE id = '$R1';" $SUPER \
  "$(apply auto_standard 3000 "'Aceptó por WhatsApp'" mode)" "$DSTATE")" "apply;750|true"
# The super_admin escape hatch of the discount trigger still works outside a service change.
val S3b "$(tx "$(ride $R1) UPDATE public.rides SET promo_code_id = '$PROMO' WHERE id = '$R1';" $SUPER \
  "UPDATE public.rides SET discount_amount_cup = 123 WHERE id = '$R1';" "$DSTATE")" "123|true"
val S4 "$(tx "$(ride $R1)" $ADMIN "$(apply auto_standard 1000)" "$RSTATE")" "fare_below_minimum;triciclo_basico|2000"
val S5 "$(tx "$(ride $R1) UPDATE public.rides SET corporate_account_id = '$CORP' WHERE id = '$R1';" $ADMIN "$(apply auto_standard 3000)" "$RSTATE")" \
  "corporate_not_supported;triciclo_basico|2000"
val S6 "$(tx "$(ride $R1) UPDATE public.rides SET ride_mode = 'cargo' WHERE id = '$R1';" $ADMIN "$(apply auto_standard 3000)" "$RSTATE")" \
  "cargo_not_supported;triciclo_basico|2000"
val S7 "$(tx "$(ride $R1)" $ADMIN "$(apply triciclo_basico 2500)" "$RSTATE")" "same_service_type;triciclo_basico|2000"
val S8 "$(tx "$(ride $R1) UPDATE public.rides SET passenger_count = 2 WHERE id = '$R1';" $ADMIN "$(apply moto_standard 1000)" "$RSTATE")" \
  "too_many_passengers;triciclo_basico|2000"
val S9 "$(tx "$(ride $R1)" $ADMIN "$(apply auto_standard 10001)" "$RSTATE")" "fare_out_of_range;triciclo_basico|2000"
val S10 "$(tx "$(ride $R1)" $ADMIN "$(apply auto_standard 3000 NULL)" "$RSTATE")" "reason_required;triciclo_basico|2000"
val S11 "BEGIN; $(ride $SNAP_NEW)
  SELECT (SELECT count(*) FROM (SELECT DISTINCT base_fare, per_km_rate, per_minute_rate, distance_m, duration_s,
            surge_multiplier, subtotal, commission_rate, commission_amount, total, pricing_rule_id,
            exchange_rate_usd_cup, total_trc, min_fare, corporate_commission_rate, default_commission_rate_snapshot
          FROM public.ride_pricing_snapshots WHERE ride_id IN ('$SNAP_OLD', '$SNAP_NEW') AND snapshot_type = 'estimate') d),
         (SELECT count(*) FROM public.ride_pricing_snapshots WHERE ride_id IN ('$SNAP_OLD', '$SNAP_NEW'));
  ROLLBACK;" "1|2"
val S12 "$(tx "$(ride $R1)" $ADMIN "$(apply auto_standard 3000 "'ok'" mode)" \
  "SELECT '[' || coalesce(current_setting('app.force_discount_recompute', true), '') || ']'")" "apply;[]"
val S13 "$(tx "$(ride $R1)" $ADMIN "$(apply mensajeria 3000) $(apply triciclo_premium 5000)" "$RSTATE")" \
  "service_type_unavailable;service_type_unavailable;triciclo_basico|2000"
val S14 "$(tx "$(ride $R1) INSERT INTO public.ride_waypoints (ride_id, sort_order, location, address)
  VALUES ('$R1', 1, ST_SetSRID(ST_MakePoint(-82.3700, 23.1350), 4326)::geography, 'Parada');" $ADMIN "$(apply auto_standard 3000)" "$RSTATE")" \
  "waypoints_not_supported;triciclo_basico|2000"

# --- P: proposals the rider answers in the app ----------------------------------------------
propose(){ echo "SELECT public.admin_change_ride_service('$R1', '$1', $2, 'propose', NULL)->>'mode';"; }
respond(){ echo "SELECT public.respond_ride_service_proposal('$P1', $1)->>'${2:-error}';"; }
val P1 "$(tx "$(ride $R1)" $ADMIN "$(propose auto_standard 3000)" \
  "SELECT p.status, extract(epoch FROM p.expires_at - now())::int, p.from_service_type || '>' || p.to_service_type,
          p.from_fare_cup || '>' || p.to_fare_cup, r.service_type, r.estimated_fare_cup,
          (SELECT count(*) FROM public.admin_actions WHERE action = 'support_propose_service')
     FROM public.ride_service_proposals p JOIN public.rides r ON r.id = p.ride_id WHERE p.ride_id = '$R1'")" \
  "propose;pending|180|triciclo_basico>auto_standard|2000>3000|triciclo_basico|2000|1"
val P2 "$(tx "$(ride $R1)" $ADMIN "$(propose auto_standard 3000) $(propose auto_confort 4000)" \
  "SELECT string_agg(to_service_type || '=' || status, ',' ORDER BY to_service_type) FROM public.ride_service_proposals WHERE ride_id = '$R1'")" \
  "propose;propose;auto_confort=pending,auto_standard=superseded"
val P3 "BEGIN; $(ride $R1) $(as $ADMIN) $(propose auto_standard 3000)
  $(as $RIDER) SELECT public.get_my_ride_service_proposal('$R1')->>'to_service_type';
  $(as $OTHER) SELECT public.get_my_ride_service_proposal('$R1') IS NULL; ROLLBACK;" "propose;auto_standard;t"
val P4 "BEGIN; $(ride $R1) $BEAT $(as $ADMIN) $(propose auto_standard 3000)
  $(as $RIDER) SELECT public.respond_ride_service_proposal((public.get_my_ride_service_proposal('$R1')->>'id')::uuid, true)->>'accepted';
  RESET ROLE; SELECT r.service_type || '|' || r.estimated_fare_cup || '|' || p.status
    FROM public.rides r JOIN public.ride_service_proposals p ON p.ride_id = r.id WHERE r.id = '$R1'; ROLLBACK;" \
  "propose;true;auto_standard|3000|accepted"
val P5 "$(tx "$(ride $R1) $(prop)" $RIDER "$(respond false accepted)" "$PCHECK")" "false;rejected|triciclo_basico"
val P6 "$(tx "$(ride $R1) $(prop pending '-1 second')" $RIDER "$(respond true)" "$PCHECK")" "proposal_expired;pending|triciclo_basico"
val P7 "$(tx "$(ride $R1) $(prop superseded)" $RIDER "$(respond true)" "$PCHECK")" "proposal_not_pending;superseded|triciclo_basico"
val P8 "$(tx "$(ride $R1) $(prop)" $OTHER "$(respond true)" "$PCHECK")" "proposal_not_found;pending|triciclo_basico"
val P9 "$(tx "$(ride $R1) $(prop) $BEAT UPDATE public.rides SET status = 'accepted', driver_id = '$D1', accepted_at = now() WHERE id = '$R1';" $RIDER \
  "$(respond true)" "$PCHECK")" "ride_not_searching;pending|triciclo_basico"
val P10 "BEGIN; $(ride $R1) $(prop) $(as $ADMIN) $(apply auto_confort 4000 "'Aceptó por WhatsApp'" mode)
  $(as $RIDER) $(respond true) RESET ROLE; $PCHECK; ROLLBACK;" "apply;proposal_not_pending;superseded|auto_confort"
val P11 "$(tx "$(ride $R1) $(prop) UPDATE public.service_type_configs SET min_fare_cup = 5000 WHERE slug = 'auto_standard';" $RIDER \
  "$(respond true)" "$PCHECK")" "fare_below_minimum;pending|triciclo_basico"

# --- G: who may call what -----------------------------------------------------------------
err G1 "$(tx "$(ride $R1)" $ADMIN "SELECT public._apply_ride_service_change('$R1', 'auto_standard', 3000);" "SELECT 1")" \
  "permission denied for function _apply_ride_service_change"
err G2 "$(tx "" $RIDER "SELECT count(*) FROM public.ride_assist;" "SELECT 1")" "permission denied for table ride_assist"
err G3 "$(tx "" $RIDER "SELECT count(*) FROM public.ride_service_proposals;" "SELECT 1")" "permission denied for table ride_service_proposals"
err G4 "BEGIN; $(ride $R1) SET LOCAL ROLE anon; SELECT public.admin_offer_ride_to_driver('$R1', '$D1'); ROLLBACK;" \
  "permission denied for function admin_offer_ride_to_driver"
err G5 "$(tx "" $ADMIN "SELECT public.notify_support_waiting_rides();" "SELECT 1")" \
  "permission denied for function notify_support_waiting_rides"

# --- P12: a rider's answer racing support's apply (committed data, separate database) --------
load $RACE
migrate $RACE
run $RACE "$(ride $R1) $(prop)" >/dev/null
( run $RACE "BEGIN; $(as $ADMIN) $(apply auto_confort 4000 "'carrera'" mode) SELECT pg_sleep(2); COMMIT;" > "$TMP/race_admin" ) &
sleep 1
RIDER_OUT=$(run $RACE "SET request.jwt.claim.sub = '$RIDER'; SET ROLE authenticated; $(respond true)")
wait
ADMIN_OUT=$(cat "$TMP/race_admin")
FINAL=$(run $RACE "$PCHECK")
if [ "$ADMIN_OUT" = "apply" ] && [ "$RIDER_OUT" = "proposal_not_pending" ] && [ "$FINAL" = "superseded|auto_confort" ]; then
  ok P12
else
  ko P12 "admin [$ADMIN_OUT] rider [$RIDER_OUT] final [$FINAL]"
fi

echo "----"
echo "PASS $PASS  FAIL $FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run it without the migration and confirm it is RED**

```bash
chmod +x supabase/tests/00628/run.sh
supabase/tests/00628/run.sh none | tail -25
```

Expected: `L1`, `S3b` and `S11` PASS (they describe prod as it is); every other test FAILs, most with `function public.… does not exist`. The last line reads `PASS 3  FAIL 70` (one test per `val`/`err` line plus P12). If `L1` fails, the live bodies were not pasted byte for byte: redo Task 1, step 4.

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/00628/run.sh
git commit -m "test(db): RED rehearsal suite for 00628 support-assisted matching"
```

### Task 3: Migration — support tables, settings, helpers

**Files:**
- Create: `supabase/migrations/00628_support_assisted_matching.sql` (it already holds a comment-only placeholder that reserves the number; replace its whole content)

- [ ] **Step 1: Confirm the migration number is still free**

```bash
git fetch origin master
git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -3
```

Then list the migration files of every open PR with `mcp__github__list_pull_requests` (state open) and, for each, `git fetch origin <head-branch> && git diff --name-only origin/master...FETCH_HEAD -- supabase/migrations`. Expected: master ends at `00626` (or `00627`, if #1095 merged), and no open PR other than #1094 holds `00628`. If either changed, use the next free number everywhere `00628` appears in this plan (file names, `run.sh`, the migration's comments).

- [ ] **Step 2: Write sections 1 to 3 of the migration**

```sql
-- ============================================================
-- 00628 — support-assisted matching
--
-- When the app cannot find a driver, TriciGo support helps the rider get one, inside the app.
--   * request_ride_help: the rider's "Pedir ayuda" button. Marks the ride and alerts support.
--   * notify_support_waiting_rides (cron, every minute): alerts support once per ride that has
--     waited longer than support_alert_after_s (60 s).
--     An alert is a push to every active admin and super_admin (category system, always
--     delivered) and an e-mail to support_alert_email, both through cron_http_post.
--   * admin_support_waiting_rides, admin_ride_assist_context, admin_ride_assist_candidates:
--     the admin banner and the assist page.
--   * admin_offer_ride_to_driver: an offer the driver accepts in the app as usual.
--   * admin_assign_ride_to_driver: assigns at once, with accept_ride_v2's checks plus the
--     vehicle type, and a reason.
--   * admin_change_ride_service: another vehicle type at a recomputed price, proposed to the
--     rider (get_my_ride_service_proposal, respond_ride_service_proposal) or applied with the
--     rider's WhatsApp consent and a reason.
--
-- A type change rewrites the ride's estimate snapshot, which complete_ride_and_pay charges,
-- through _write_ride_estimate_snapshot, now shared with tg_rides_create_estimate_snapshot,
-- and re-runs the discount trigger. tg_rides_validate_promo_discount gets a one-line patch so
-- that its super_admin bypass does not skip that recompute when this code asks for it.
--
-- Design: docs/superpowers/specs/2026-10-07-support-assisted-matching-design.md
-- Rehearsal: supabase/tests/00628/run.sh (RED without this file, GREEN with it, applied twice)
-- ============================================================

-- The foreign keys below lock rides (SHARE ROW EXCLUSIVE) until commit. Give up after 10 s rather
-- than queue every ride write behind a long transaction. Outside a transaction block (the local
-- rehearsal's psql) SET LOCAL only prints a warning.
SET LOCAL lock_timeout = '10s';

-- 1. Support tables. Both are lock tables (RLS, no policies): only the SECURITY DEFINER
--    functions below read and write them.

CREATE TABLE IF NOT EXISTS public.ride_assist (
  ride_id            uuid PRIMARY KEY REFERENCES public.rides(id) ON DELETE CASCADE,
  help_requested_at  timestamptz,
  help_alert_sent_at timestamptz,
  wait_alert_sent_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ride_assist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ride_assist FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ride_assist TO service_role;

CREATE TABLE IF NOT EXISTS public.ride_service_proposals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id           uuid NOT NULL REFERENCES public.rides(id) ON DELETE CASCADE,
  from_service_type text NOT NULL,
  to_service_type   text NOT NULL,
  from_fare_cup     integer NOT NULL,
  to_fare_cup       integer NOT NULL CHECK (to_fare_cup > 0),
  proposed_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  -- A pending row whose expires_at has passed is expired: nothing sweeps it.
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded')),
  expires_at        timestamptz NOT NULL,
  responded_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ride_service_proposals_one_pending
  ON public.ride_service_proposals (ride_id) WHERE status = 'pending';
ALTER TABLE public.ride_service_proposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ride_service_proposals FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ride_service_proposals TO service_role;

-- 2. Settings (admin: Settings → Platform config).
INSERT INTO public.platform_config (key, value) VALUES
  ('support_alert_enabled', 'true'::jsonb),
  ('support_alert_after_s', '60'::jsonb),
  ('support_offer_ttl_s', '120'::jsonb),
  ('support_proposal_ttl_s', '180'::jsonb)
ON CONFLICT (key) DO NOTHING;
-- Who gets the alert e-mail: starts as the business list. Empty turns the e-mail off.
INSERT INTO public.platform_config (key, value)
SELECT 'support_alert_email', value FROM public.platform_config WHERE key = 'business_notification_email'
ON CONFLICT (key) DO NOTHING;

-- 3. Helpers. None is callable by a client role.

-- The ride code support and the rider talk about: the first 8 characters of the id.
CREATE OR REPLACE FUNCTION public._ride_short_code(p_ride_id uuid)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_catalog
AS $$ SELECT upper(left(p_ride_id::text, 8)) $$;

-- The vehicle types that can serve a service type: the CASE in find_best_drivers, which the
-- dispatcher uses. Keep the two in step. NULL means any vehicle.
CREATE OR REPLACE FUNCTION public._vehicle_types_for_service(p_service_type text)
RETURNS public.vehicle_type[]
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_catalog
AS $$
  SELECT CASE
    WHEN p_service_type LIKE 'triciclo%' THEN ARRAY['triciclo'::public.vehicle_type]
    WHEN p_service_type LIKE 'moto%'     THEN ARRAY['moto'::public.vehicle_type]
    WHEN p_service_type LIKE 'auto%'     THEN ARRAY['auto'::public.vehicle_type, 'confort'::public.vehicle_type]
    WHEN p_service_type = 'mensajeria'   THEN NULL
    ELSE ARRAY['triciclo'::public.vehicle_type]
  END
$$;

-- An active vehicle of the driver can serve the ride: the vehicle filter of find_best_drivers
-- (type, and accepts_cargo for deliveries). Package size and weight are left to support.
CREATE OR REPLACE FUNCTION public._driver_can_serve_ride(p_driver_id uuid, p_service_type text, p_is_delivery boolean)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.vehicles v
    WHERE v.driver_id = p_driver_id
      AND v.is_active
      AND (public._vehicle_types_for_service(p_service_type) IS NULL
           OR v.type = ANY (public._vehicle_types_for_service(p_service_type)))
      AND (NOT p_is_delivery OR v.accepts_cargo IS TRUE)
  )
$$;

-- Either user blocked the other. dispatch_ride never offers a ride across such a pair.
CREATE OR REPLACE FUNCTION public._users_blocked(p_a uuid, p_b uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_blocks ub
    WHERE (ub.blocker_id = p_a AND ub.blocked_id = p_b)
       OR (ub.blocker_id = p_b AND ub.blocked_id = p_a)
  )
$$;

-- For values a user typed (addresses, names) that go into an HTML e-mail.
CREATE OR REPLACE FUNCTION public._html_escape(p_text text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_catalog
AS $$
  SELECT replace(replace(replace(replace(replace(coalesce(p_text, ''),
    '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;')
$$;

REVOKE ALL ON FUNCTION public._ride_short_code(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._vehicle_types_for_service(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._driver_can_serve_ride(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._users_blocked(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._html_escape(text) FROM PUBLIC, anon, authenticated;
```

- [ ] **Step 3: Run the suite**

```bash
supabase/tests/00628/run.sh supabase/migrations/00628_support_assisted_matching.sql | grep -E '^(PASS|FAIL)  (L1|G2|G3|S3b|S11)|^PASS [0-9]'
```

Expected: the migration applies twice without error, and `L1`, `G2`, `G3`, `S3b`, `S11` PASS. Everything that calls a support function still fails.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00628_support_assisted_matching.sql
git commit -m "feat(db): support tables, settings and helpers for assisted matching (00628)"
```

### Task 4: Migration — shared estimate snapshot and the discount patch

**Files:**
- Modify: `supabase/migrations/00628_support_assisted_matching.sql` (append)

- [ ] **Step 1: Append sections 4 and 5**

```sql
-- 4. The estimate snapshot: one writer for the ride INSERT trigger and the type change.

-- The two live bodies rewritten below must be the ones this migration was written for.
DO $guard$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.tg_rides_create_estimate_snapshot()'::regprocedure;
  IF position('_write_ride_estimate_snapshot' IN v_src) = 0
     AND md5(v_src) <> 'b801283b9dcb6de3e4822992347d962e' THEN
    RAISE EXCEPTION '00628: tg_rides_create_estimate_snapshot is not the body this migration was written for (md5 %)', md5(v_src);
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.tg_rides_validate_promo_discount()'::regprocedure;
  IF position('app.force_discount_recompute' IN v_src) = 0
     AND md5(v_src) <> 'd4494bd8ab75ce590e1c42743583aec5' THEN
    RAISE EXCEPTION '00628: tg_rides_validate_promo_discount is not the body this migration was written for (md5 %)', md5(v_src);
  END IF;
END
$guard$;

-- Writes the ride's estimate row, the price contract complete_ride_and_pay charges.
-- The logic is tg_rides_create_estimate_snapshot's body as of 00628 (md5 b801283b…) with NEW
-- renamed p_ride. p_replace = false only writes a ride that has no estimate row yet (the INSERT
-- trigger). p_replace = true rewrites the existing row in place (a type change).
CREATE OR REPLACE FUNCTION public._write_ride_estimate_snapshot(p_ride public.rides, p_replace boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_svc                  RECORD;
  v_commission_rate      NUMERIC;
  v_corp_commission_rate NUMERIC;
  v_eff_per_km           INTEGER;
  v_commission_amount    INTEGER;
  v_rule_id              uuid;
  v_now_t                time;
  v_now_dow              int;
  v_exists               boolean;
BEGIN
  IF p_ride.estimated_fare_cup IS NULL OR p_ride.estimated_fare_cup <= 0 THEN
    RETURN;
  END IF;

  v_exists := EXISTS (
    SELECT 1 FROM public.ride_pricing_snapshots
    WHERE ride_id = p_ride.id AND snapshot_type = 'estimate'
  );
  IF v_exists AND NOT p_replace THEN
    RETURN;
  END IF;

  SELECT * INTO v_svc
  FROM public.service_type_configs
  WHERE slug = p_ride.service_type AND is_active = true
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  BEGIN
    v_now_t   := (now() AT TIME ZONE 'America/Havana')::time;
    v_now_dow := EXTRACT(dow FROM now() AT TIME ZONE 'America/Havana')::int;
    SELECT pr.id INTO v_rule_id
    FROM public.pricing_rules pr
    WHERE pr.service_type = p_ride.service_type
      AND pr.is_active = true
      AND (pr.time_window_start IS NULL OR pr.time_window_end IS NULL OR
           CASE WHEN pr.time_window_start <= pr.time_window_end
                THEN v_now_t >= pr.time_window_start AND v_now_t < pr.time_window_end
                ELSE v_now_t >= pr.time_window_start OR v_now_t < pr.time_window_end END)
      AND (pr.day_of_week IS NULL OR array_length(pr.day_of_week, 1) IS NULL
           OR v_now_dow = ANY(pr.day_of_week))
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_rule_id := NULL;
  END;

  v_eff_per_km := COALESCE(p_ride.driver_custom_rate_cup, v_svc.per_km_rate_cup);

  SELECT (value #>> '{}')::NUMERIC INTO v_commission_rate
  FROM public.platform_config WHERE key = 'commission_rate';
  -- Guard: 0 / NULL / out-of-range (>=1) is invalid -> fall back to 15%.
  IF v_commission_rate IS NULL OR v_commission_rate <= 0 OR v_commission_rate >= 1 THEN
    v_commission_rate := 0.15;
  END IF;

  IF p_ride.corporate_account_id IS NOT NULL THEN
    SELECT commission_percent / 100.0 INTO v_corp_commission_rate
    FROM public.corporate_accounts WHERE id = p_ride.corporate_account_id;
  END IF;

  IF v_corp_commission_rate IS NOT NULL AND v_corp_commission_rate < v_commission_rate THEN
    v_commission_amount := ROUND(p_ride.estimated_fare_cup * v_corp_commission_rate)::int;
  ELSE
    v_commission_amount := ROUND(p_ride.estimated_fare_cup * v_commission_rate)::int;
  END IF;

  IF v_exists THEN
    UPDATE public.ride_pricing_snapshots SET (
      base_fare, per_km_rate, per_minute_rate,
      distance_m, duration_s, surge_multiplier, subtotal,
      commission_rate, commission_amount, total, pricing_rule_id,
      exchange_rate_usd_cup, total_trc,
      min_fare, corporate_commission_rate, default_commission_rate_snapshot
    ) = (
      v_svc.base_fare_cup, v_eff_per_km, v_svc.per_minute_rate_cup,
      p_ride.estimated_distance_m, p_ride.estimated_duration_s, p_ride.surge_multiplier,
      p_ride.estimated_fare_cup,
      COALESCE(v_corp_commission_rate, v_commission_rate),
      v_commission_amount,
      p_ride.estimated_fare_cup,
      v_rule_id,
      p_ride.exchange_rate_usd_cup, p_ride.estimated_fare_trc,
      v_svc.min_fare_cup, v_corp_commission_rate, v_commission_rate
    )
    WHERE ride_id = p_ride.id AND snapshot_type = 'estimate';
  ELSE
    INSERT INTO public.ride_pricing_snapshots (
      ride_id, snapshot_type, base_fare, per_km_rate, per_minute_rate,
      distance_m, duration_s, surge_multiplier, subtotal,
      commission_rate, commission_amount, total, pricing_rule_id,
      exchange_rate_usd_cup, total_trc,
      min_fare, corporate_commission_rate, default_commission_rate_snapshot
    ) VALUES (
      p_ride.id, 'estimate',
      v_svc.base_fare_cup, v_eff_per_km, v_svc.per_minute_rate_cup,
      p_ride.estimated_distance_m, p_ride.estimated_duration_s, p_ride.surge_multiplier,
      p_ride.estimated_fare_cup,
      COALESCE(v_corp_commission_rate, v_commission_rate),
      v_commission_amount,
      p_ride.estimated_fare_cup,
      v_rule_id,
      p_ride.exchange_rate_usd_cup, p_ride.estimated_fare_trc,
      v_svc.min_fare_cup, v_corp_commission_rate, v_commission_rate
    );
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._write_ride_estimate_snapshot(public.rides, boolean) FROM PUBLIC, anon, authenticated;

-- Same trigger function, same attributes; CREATE OR REPLACE keeps its grants.
CREATE OR REPLACE FUNCTION public.tg_rides_create_estimate_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
BEGIN
  -- 00628: the body moved to _write_ride_estimate_snapshot, shared with the type change.
  PERFORM public._write_ride_estimate_snapshot(NEW, false);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tg_rides_create_estimate_snapshot failed for ride %: % %',
    NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

-- 5. tg_rides_validate_promo_discount: its super_admin bypass keeps whatever discount the
--    UPDATE carries, a deliberate escape hatch for support. A type change needs the recompute
--    whoever applies it, so the bypass steps aside while the transaction has
--    app.force_discount_recompute = '1', which only _apply_ride_service_change sets.
--    Patched in place from the live body (CLAUDE.md § "Patch in-place"): nothing else changes.
DO $patch$
DECLARE
  v_src    text;
  v_target constant text := 'IF is_super_admin() THEN';
  v_new    constant text := 'IF is_super_admin() AND COALESCE(current_setting(''app.force_discount_recompute'', true), '''') <> ''1'' THEN';
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.tg_rides_validate_promo_discount()'::regprocedure;
  IF position('app.force_discount_recompute' IN v_src) > 0 THEN
    RETURN;  -- already patched
  END IF;
  IF (length(v_src) - length(replace(v_src, v_target, ''))) / length(v_target) <> 1 THEN
    RAISE EXCEPTION '00628: the super_admin bypass is not exactly once in tg_rides_validate_promo_discount';
  END IF;
  EXECUTE replace(pg_get_functiondef('public.tg_rides_validate_promo_discount()'::regprocedure), v_target, v_new);
END
$patch$;
```

- [ ] **Step 2: Run the suite**

```bash
supabase/tests/00628/run.sh supabase/migrations/00628_support_assisted_matching.sql | grep -E '^(PASS|FAIL)  (L1|G2|G3|S3b|S11)'
```

Expected: the five still PASS. `S11` now compares a row written by the new trigger with one written by the live one, so it proves the refactor writes the same snapshot. `S3b` proves the super_admin escape hatch still works outside a type change.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00628_support_assisted_matching.sql
git commit -m "feat(db): share the estimate snapshot writer and let a type change recompute discounts (00628)"
```

### Task 5: Migration — changing the vehicle type, and the rider's proposals

**Files:**
- Modify: `supabase/migrations/00628_support_assisted_matching.sql` (append)

- [ ] **Step 1: Append section 6**

```sql
-- 6. Changing the vehicle type of a searching ride.

-- Why the ride cannot switch to p_service_type at p_fare_cup, or NULL when it can.
CREATE OR REPLACE FUNCTION public._ride_service_change_error(p_ride public.rides, p_service_type text, p_fare_cup integer)
RETURNS text
LANGUAGE plpgsql STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_svc public.service_type_configs%ROWTYPE;
BEGIN
  IF p_ride.status <> 'searching' THEN
    RETURN 'ride_not_searching';
  END IF;
  IF COALESCE(p_ride.ride_mode, 'passenger') <> 'passenger' THEN
    RETURN 'cargo_not_supported';
  END IF;
  IF p_ride.corporate_account_id IS NOT NULL THEN
    RETURN 'corporate_not_supported';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ride_waypoints w WHERE w.ride_id = p_ride.id) THEN
    RETURN 'waypoints_not_supported';
  END IF;
  IF p_service_type IS NULL OR p_service_type = p_ride.service_type THEN
    RETURN 'same_service_type';
  END IF;
  SELECT * INTO v_svc FROM public.service_type_configs WHERE slug = p_service_type AND is_active;
  IF NOT FOUND OR p_service_type = 'mensajeria' THEN
    RETURN 'service_type_unavailable';
  END IF;
  IF v_svc.max_passengers > 0 AND COALESCE(p_ride.passenger_count, 1) > v_svc.max_passengers THEN
    RETURN 'too_many_passengers';
  END IF;
  IF p_fare_cup IS NULL OR p_fare_cup < v_svc.min_fare_cup THEN
    RETURN 'fare_below_minimum';
  END IF;
  -- A typo guard: no vehicle type costs five times another for the same trip.
  IF p_fare_cup > 5 * GREATEST(COALESCE(p_ride.estimated_fare_cup, 0), v_svc.min_fare_cup) THEN
    RETURN 'fare_out_of_range';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public._ride_service_change_error(public.rides, text, integer) FROM PUBLIC, anon, authenticated;

-- Switches a searching ride to another type at a new fare. The callers check who is calling;
-- this re-checks the ride under its row lock.
CREATE OR REPLACE FUNCTION public._apply_ride_service_change(p_ride_id uuid, p_service_type text, p_fare_cup integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_ride public.rides%ROWTYPE;
  v_err  text;
BEGIN
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ride_not_found';
  END IF;
  v_err := public._ride_service_change_error(v_ride, p_service_type, p_fare_cup);
  IF v_err IS NOT NULL THEN
    RAISE EXCEPTION '%', v_err;
  END IF;

  -- 1. The estimate row first: complete_ride_and_pay charges its total, and the discount
  --    trigger below reads it as the fare base.
  v_ride.service_type       := p_service_type;
  v_ride.estimated_fare_cup := p_fare_cup;
  v_ride.estimated_fare_trc := p_fare_cup;  -- 1 TRC = 1 CUP: cupToTrc is the identity
  PERFORM public._write_ride_estimate_snapshot(v_ride, true);
  IF NOT EXISTS (
    SELECT 1 FROM public.ride_pricing_snapshots
    WHERE ride_id = p_ride_id AND snapshot_type = 'estimate' AND total = p_fare_cup
  ) THEN
    RAISE EXCEPTION 'snapshot_failed';
  END IF;

  -- 2. The ride. Setting discount_amount_cup fires tg_rides_validate_promo_discount, which
  --    recomputes the promo, partner and shared-ride discounts on the new fare and clears
  --    shared_ride off triciclo; the flag makes it do so for a super_admin too.
  --    tg_rides_validate_insurance recomputes the premium on its own. surge_multiplier stays as
  --    it was: a rider may not change it, and the snapshot only records it.
  PERFORM set_config('app.force_discount_recompute', '1', true);
  UPDATE public.rides
     SET service_type        = p_service_type,
         estimated_fare_cup  = p_fare_cup,
         estimated_fare_trc  = p_fare_cup,
         discount_amount_cup = discount_amount_cup
   WHERE id = p_ride_id;
  PERFORM set_config('app.force_discount_recompute', '', true);

  -- 3. Offers made for the old type are void; drivers of the new type get offers.
  UPDATE public.ride_offers SET status = 'superseded', responded_at = now()
   WHERE ride_id = p_ride_id AND status = 'pending';
  UPDATE public.ride_service_proposals SET status = 'superseded', responded_at = now()
   WHERE ride_id = p_ride_id AND status = 'pending';
  PERFORM public.dispatch_ride(p_ride_id);
END;
$$;
REVOKE ALL ON FUNCTION public._apply_ride_service_change(uuid, text, integer) FROM PUBLIC, anon, authenticated;

-- Support: propose another type to the rider, or apply it with the rider's WhatsApp consent.
CREATE OR REPLACE FUNCTION public.admin_change_ride_service(
  p_ride_id uuid, p_service_type text, p_fare_cup integer, p_mode text, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_admin  uuid := auth.uid();
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_ride   public.rides%ROWTYPE;
  v_err    text;
  v_ttl    integer;
  v_prop   public.ride_service_proposals%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('propose', 'apply') THEN
    RETURN jsonb_build_object('error', 'invalid_mode');
  END IF;
  IF p_mode = 'apply' AND v_reason IS NULL THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;

  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  v_err := public._ride_service_change_error(v_ride, p_service_type, p_fare_cup);
  IF v_err IS NOT NULL THEN
    RETURN jsonb_build_object('error', v_err, 'status', v_ride.status);
  END IF;

  IF p_mode = 'propose' THEN
    v_ttl := GREATEST(60, public.get_platform_config_numeric('support_proposal_ttl_s', 180)::int);
    UPDATE public.ride_service_proposals SET status = 'superseded', responded_at = now()
     WHERE ride_id = p_ride_id AND status = 'pending';
    INSERT INTO public.ride_service_proposals
      (ride_id, from_service_type, to_service_type, from_fare_cup, to_fare_cup, proposed_by, expires_at)
    VALUES
      (p_ride_id, v_ride.service_type, p_service_type, COALESCE(v_ride.estimated_fare_cup, 0), p_fare_cup,
       v_admin, now() + make_interval(secs => v_ttl))
    RETURNING * INTO v_prop;
    INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
    VALUES (v_admin, 'support_propose_service', 'ride', p_ride_id::text,
            jsonb_build_object('service_type', v_ride.service_type, 'estimated_fare_cup', v_ride.estimated_fare_cup),
            jsonb_build_object('service_type', p_service_type, 'estimated_fare_cup', p_fare_cup, 'proposal_id', v_prop.id),
            v_reason);
    RETURN jsonb_build_object('success', true, 'mode', 'propose',
                              'proposal_id', v_prop.id, 'expires_at', v_prop.expires_at);
  END IF;

  PERFORM public._apply_ride_service_change(p_ride_id, p_service_type, p_fare_cup);
  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  SELECT v_admin, 'support_change_service', 'ride', p_ride_id::text,
         jsonb_build_object('service_type', v_ride.service_type, 'estimated_fare_cup', v_ride.estimated_fare_cup,
                            'discount_amount_cup', v_ride.discount_amount_cup),
         jsonb_build_object('service_type', r.service_type, 'estimated_fare_cup', r.estimated_fare_cup,
                            'discount_amount_cup', r.discount_amount_cup),
         v_reason
  FROM public.rides r WHERE r.id = p_ride_id;
  RETURN jsonb_build_object('success', true, 'mode', 'apply');
END;
$$;
REVOKE ALL ON FUNCTION public.admin_change_ride_service(uuid, text, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_change_ride_service(uuid, text, integer, text, text) TO authenticated, service_role;

-- The rider's pending, unexpired proposal for their own searching ride, or NULL.
CREATE OR REPLACE FUNCTION public.get_my_ride_service_proposal(p_ride_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object(
    'id', p.id, 'ride_id', p.ride_id,
    'from_service_type', p.from_service_type, 'to_service_type', p.to_service_type,
    'from_fare_cup', p.from_fare_cup, 'to_fare_cup', p.to_fare_cup,
    'expires_at', p.expires_at)
  FROM public.ride_service_proposals p
  JOIN public.rides r ON r.id = p.ride_id
  WHERE p.ride_id = p_ride_id
    AND r.customer_id = auth.uid()
    AND r.status = 'searching'
    AND p.status = 'pending'
    AND p.expires_at > now()
  ORDER BY p.created_at DESC
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.get_my_ride_service_proposal(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_ride_service_proposal(uuid) TO authenticated, service_role;

-- The rider accepts or rejects a proposal.
CREATE OR REPLACE FUNCTION public.respond_ride_service_proposal(p_proposal_id uuid, p_accept boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_ride_id uuid;
  v_ride    public.rides%ROWTYPE;
  v_prop    public.ride_service_proposals%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  SELECT ride_id INTO v_ride_id FROM public.ride_service_proposals WHERE id = p_proposal_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'proposal_not_found');
  END IF;

  -- The ride first, then the proposal: the order every writer of a ride's rows uses.
  SELECT * INTO v_ride FROM public.rides WHERE id = v_ride_id FOR UPDATE;
  IF NOT FOUND OR v_ride.customer_id IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object('error', 'proposal_not_found');
  END IF;
  SELECT * INTO v_prop FROM public.ride_service_proposals WHERE id = p_proposal_id FOR UPDATE;

  IF v_prop.status <> 'pending' THEN
    RETURN jsonb_build_object('error', 'proposal_not_pending', 'status', v_prop.status);
  END IF;
  IF v_prop.expires_at <= now() THEN
    RETURN jsonb_build_object('error', 'proposal_expired');
  END IF;
  IF v_ride.status <> 'searching' THEN
    RETURN jsonb_build_object('error', 'ride_not_searching', 'status', v_ride.status);
  END IF;

  IF NOT COALESCE(p_accept, false) THEN
    UPDATE public.ride_service_proposals SET status = 'rejected', responded_at = now() WHERE id = p_proposal_id;
    PERFORM public.log_rpc_attempt('respond_ride_service_proposal', v_uid, v_ride_id, 'rejected',
      jsonb_build_object('proposal_id', p_proposal_id));
    RETURN jsonb_build_object('success', true, 'accepted', false);
  END IF;

  BEGIN
    UPDATE public.ride_service_proposals SET status = 'accepted', responded_at = now() WHERE id = p_proposal_id;
    PERFORM public._apply_ride_service_change(v_ride_id, v_prop.to_service_type, v_prop.to_fare_cup);
  EXCEPTION WHEN raise_exception THEN
    -- _apply_ride_service_change refused (the type's minimum fare went up since the proposal,
    -- for example). Nothing changed and the proposal stays pending.
    PERFORM public.log_rpc_attempt('respond_ride_service_proposal', v_uid, v_ride_id, SQLERRM,
      jsonb_build_object('proposal_id', p_proposal_id));
    RETURN jsonb_build_object('error', SQLERRM);
  END;

  PERFORM public.log_rpc_attempt('respond_ride_service_proposal', v_uid, v_ride_id, 'accepted',
    jsonb_build_object('proposal_id', p_proposal_id, 'service_type', v_prop.to_service_type,
                       'fare_cup', v_prop.to_fare_cup));
  RETURN jsonb_build_object('success', true, 'accepted', true,
                            'service_type', v_prop.to_service_type, 'fare_cup', v_prop.to_fare_cup);
END;
$$;
REVOKE ALL ON FUNCTION public.respond_ride_service_proposal(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.respond_ride_service_proposal(uuid, boolean) TO authenticated, service_role;
```

- [ ] **Step 2: Run the suite**

```bash
supabase/tests/00628/run.sh supabase/migrations/00628_support_assisted_matching.sql | grep -E '^(PASS|FAIL)  (S|P|G1)'
```

Expected: every `S…`, `P…` (P12 included) and `G1` line is PASS. If `S1` fails on its offers column, check that `dispatch_ride` created D5's offer: `find_best_drivers` must see D5 inside the 50 km radius, which needs the ride to be older than `dispatch_stage1_seconds` (the `ride` helper makes it 2 minutes old).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00628_support_assisted_matching.sql
git commit -m "feat(db): support can switch a ride's vehicle type, proposed or applied (00628)"
```

### Task 6: Migration — offers, direct assignment, the waiting list and the assist page's data

**Files:**
- Modify: `supabase/migrations/00628_support_assisted_matching.sql` (append)

- [ ] **Step 1: Append section 7**

```sql
-- 7. What support sees and does on a waiting ride.

-- The banner: searching rides that waited longer than support_alert_after_s, or whose rider asked
-- for help. Help first, then the longest wait. A scheduled ride waits from scheduled_at.
-- Test riders are included and flagged, so the end-to-end check can use a test account.
CREATE OR REPLACE FUNCTION public.admin_support_waiting_rides()
RETURNS TABLE (
  ride_id uuid, code text, waiting_since timestamptz, wait_s integer, help_requested_at timestamptz,
  service_type text, estimated_fare_cup integer, pickup_address text, dropoff_address text,
  pending_offers integer, is_test boolean)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  v_after integer := GREATEST(15, public.get_platform_config_numeric('support_alert_after_s', 60)::int);
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT r.id,
         public._ride_short_code(r.id),
         GREATEST(r.created_at, r.scheduled_at),
         GREATEST(0, floor(extract(epoch FROM now() - GREATEST(r.created_at, r.scheduled_at))))::int,
         ra.help_requested_at,
         r.service_type,
         r.estimated_fare_cup,
         r.pickup_address,
         r.dropoff_address,
         (SELECT count(*)::int FROM public.ride_offers o
           WHERE o.ride_id = r.id AND o.status = 'pending' AND o.expires_at > now()),
         c.is_test
  FROM public.rides r
  JOIN public.users c ON c.id = r.customer_id
  LEFT JOIN public.ride_assist ra ON ra.ride_id = r.id
  WHERE r.status = 'searching'
    AND GREATEST(r.created_at, r.scheduled_at) <= now()
    AND (ra.help_requested_at IS NOT NULL
         OR GREATEST(r.created_at, r.scheduled_at) <= now() - make_interval(secs => v_after))
  ORDER BY (ra.help_requested_at IS NULL), GREATEST(r.created_at, r.scheduled_at)
  LIMIT 50;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_support_waiting_rides() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_support_waiting_rides() TO authenticated, service_role;

-- The assist page: the ride, its rider, help, every offer and the latest proposal, in one call.
CREATE OR REPLACE FUNCTION public.admin_ride_assist_context(p_ride_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_ride public.rides%ROWTYPE;
  v_out  jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;

  SELECT jsonb_build_object(
    'ride', jsonb_build_object(
      'id', v_ride.id, 'code', public._ride_short_code(v_ride.id), 'status', v_ride.status,
      'service_type', v_ride.service_type, 'ride_mode', v_ride.ride_mode,
      'estimated_fare_cup', v_ride.estimated_fare_cup, 'discount_amount_cup', v_ride.discount_amount_cup,
      'payment_method', v_ride.payment_method, 'passenger_count', v_ride.passenger_count,
      'shared_ride', COALESCE(v_ride.shared_ride, false),
      'is_corporate', v_ride.corporate_account_id IS NOT NULL,
      'has_waypoints', EXISTS (SELECT 1 FROM public.ride_waypoints w WHERE w.ride_id = v_ride.id),
      'pickup_address', v_ride.pickup_address, 'dropoff_address', v_ride.dropoff_address,
      'pickup_lat', v_ride.pickup_lat, 'pickup_lng', v_ride.pickup_lng,
      'dropoff_lat', v_ride.dropoff_lat, 'dropoff_lng', v_ride.dropoff_lng,
      'created_at', v_ride.created_at,
      'wait_s', GREATEST(0, floor(extract(epoch FROM now() - GREATEST(v_ride.created_at, v_ride.scheduled_at))))::int,
      'customer_id', v_ride.customer_id, 'customer_name', c.full_name,
      'customer_phone', c.phone, 'customer_is_test', c.is_test),
    'help_requested_at', ra.help_requested_at,
    'offers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'driver_profile_id', o.driver_profile_id, 'driver_name', du.full_name, 'status', o.status,
               'offered_at', o.offered_at, 'expires_at', o.expires_at, 'responded_at', o.responded_at)
             ORDER BY o.offered_at DESC)
      FROM public.ride_offers o
      JOIN public.driver_profiles dp ON dp.id = o.driver_profile_id
      JOIN public.users du ON du.id = dp.user_id
      WHERE o.ride_id = v_ride.id), '[]'::jsonb),
    'proposal', (
      SELECT jsonb_build_object(
               'id', p.id, 'from_service_type', p.from_service_type, 'to_service_type', p.to_service_type,
               'from_fare_cup', p.from_fare_cup, 'to_fare_cup', p.to_fare_cup, 'status', p.status,
               'expires_at', p.expires_at, 'responded_at', p.responded_at, 'created_at', p.created_at)
      FROM public.ride_service_proposals p
      WHERE p.ride_id = v_ride.id
      ORDER BY p.created_at DESC
      LIMIT 1))
  INTO v_out
  FROM public.users c
  LEFT JOIN public.ride_assist ra ON ra.ride_id = v_ride.id
  WHERE c.id = v_ride.customer_id;

  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_ride_assist_context(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_ride_assist_context(uuid) TO authenticated, service_role;

-- The drivers support can call: approved, with a vehicle that can serve p_service_type (the
-- ride's own type by default), online or seen in the last 7 days, not blocked with the rider.
-- Online first, then by distance to the pickup.
CREATE OR REPLACE FUNCTION public.admin_ride_assist_candidates(p_ride_id uuid, p_service_type text DEFAULT NULL)
RETURNS TABLE (
  driver_profile_id uuid, full_name text, phone text, vehicle_type public.vehicle_type, vehicle_label text,
  is_online boolean, last_heartbeat_at timestamptz, distance_m integer, busy_ride_id uuid,
  can_afford boolean, offer_status text, offer_expires_at timestamptz)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  v_ride  public.rides%ROWTYPE;
  v_type  text;
  v_types public.vehicle_type[];
  v_cargo boolean;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  v_type  := COALESCE(p_service_type, v_ride.service_type);
  v_types := public._vehicle_types_for_service(v_type);
  v_cargo := (v_ride.ride_mode = 'cargo' OR v_type = 'mensajeria');

  RETURN QUERY
  SELECT dp.id,
         u.full_name,
         u.phone,
         v.type,
         v.make || ' ' || v.model || ' · ' || v.color || ' · ' || v.plate_number,
         dp.is_online,
         dp.last_heartbeat_at,
         ST_Distance(dp.current_location, v_ride.pickup_location)::int,
         (SELECT a.id FROM public.rides a
           WHERE a.driver_id = dp.id
             AND a.status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination')
           LIMIT 1),
         COALESCE((public.driver_can_afford_commission(dp.id, v_ride.estimated_fare_cup)->>'ok')::boolean, false),
         o.status,
         o.expires_at
  FROM public.driver_profiles dp
  JOIN public.users u ON u.id = dp.user_id
  JOIN LATERAL (
    SELECT v2.* FROM public.vehicles v2
    WHERE v2.driver_id = dp.id
      AND v2.is_active
      AND (v_types IS NULL OR v2.type = ANY (v_types))
      AND (NOT v_cargo OR v2.accepts_cargo IS TRUE)
    ORDER BY v2.created_at DESC
    LIMIT 1
  ) v ON true
  LEFT JOIN public.ride_offers o ON o.ride_id = v_ride.id AND o.driver_profile_id = dp.id
  WHERE dp.status = 'approved'
    AND u.is_active
    AND (dp.is_online OR dp.last_heartbeat_at > now() - interval '7 days')
    AND NOT public._users_blocked(v_ride.customer_id, dp.user_id)
  ORDER BY dp.is_online DESC, ST_Distance(dp.current_location, v_ride.pickup_location) ASC NULLS LAST, u.full_name
  LIMIT 60;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_ride_assist_candidates(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_ride_assist_candidates(uuid, text) TO authenticated, service_role;

-- "Enviar oferta": the driver gets the ride as an offer with the support TTL and accepts it in
-- the app (accept_ride_v2 checks online, free and balance then). Every path pushes the offer
-- except a live one, which is only extended.
CREATE OR REPLACE FUNCTION public.admin_offer_ride_to_driver(p_ride_id uuid, p_driver_profile_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_admin   uuid := auth.uid();
  v_ride    public.rides%ROWTYPE;
  v_dp      public.driver_profiles%ROWTYPE;
  v_offer   public.ride_offers%ROWTYPE;
  v_expires timestamptz;
  v_dist    double precision;
  v_mode    text;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  IF v_ride.status <> 'searching' THEN
    RETURN jsonb_build_object('error', 'ride_not_searching', 'status', v_ride.status);
  END IF;

  SELECT * INTO v_dp FROM public.driver_profiles WHERE id = p_driver_profile_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'driver_not_found');
  END IF;
  IF v_dp.status <> 'approved' THEN
    RETURN jsonb_build_object('error', 'driver_not_approved', 'driver_status', v_dp.status);
  END IF;
  IF NOT public._driver_can_serve_ride(v_dp.id, v_ride.service_type,
                                        v_ride.ride_mode = 'cargo' OR v_ride.service_type = 'mensajeria') THEN
    RETURN jsonb_build_object('error', 'wrong_vehicle_type');
  END IF;
  IF public._users_blocked(v_ride.customer_id, v_dp.user_id) THEN
    RETURN jsonb_build_object('error', 'blocked');
  END IF;

  v_expires := now() + make_interval(secs => GREATEST(30, public.get_platform_config_numeric('support_offer_ttl_s', 120)::int));
  v_dist := ST_Distance(v_dp.current_location, v_ride.pickup_location);

  SELECT * INTO v_offer FROM public.ride_offers
   WHERE ride_id = p_ride_id AND driver_profile_id = p_driver_profile_id
   FOR UPDATE;

  IF NOT FOUND THEN
    -- trg_notify_driver_new_offer pushes it like any dispatched offer.
    INSERT INTO public.ride_offers (ride_id, driver_profile_id, distance_m, expires_at)
    VALUES (p_ride_id, p_driver_profile_id, v_dist, v_expires);
    v_mode := 'created';
  ELSIF v_offer.status = 'pending' AND v_offer.expires_at > now() THEN
    -- Already on the driver's screen: give it the support TTL, without a second push.
    UPDATE public.ride_offers SET expires_at = GREATEST(expires_at, v_expires) WHERE id = v_offer.id;
    v_mode := 'extended';
  ELSE
    -- Re-armed through 'expired', so trg_notify_driver_reoffer (expired -> pending) pushes it.
    IF v_offer.status <> 'expired' THEN
      UPDATE public.ride_offers SET status = 'expired' WHERE id = v_offer.id;
    END IF;
    UPDATE public.ride_offers
       SET status = 'pending', expires_at = v_expires, distance_m = v_dist, responded_at = NULL
     WHERE id = v_offer.id;
    v_mode := 'rearmed';
  END IF;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
  VALUES (v_admin, 'support_offer_ride', 'ride', p_ride_id::text,
          CASE WHEN v_offer.id IS NULL THEN NULL ELSE jsonb_build_object('offer_status', v_offer.status) END,
          jsonb_build_object('driver_profile_id', p_driver_profile_id, 'mode', v_mode, 'expires_at', v_expires));

  RETURN jsonb_build_object('success', true, 'mode', v_mode, 'expires_at', v_expires);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_offer_ride_to_driver(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_offer_ride_to_driver(uuid, uuid) TO authenticated, service_role;

-- "Asignar directo": accept_ride_v2's checks (live body, 00377) without the offer, plus the
-- vehicle type and the block list, then accept_ride_v2's writes. No offer row is inserted: an
-- INSERT would push "Viaje disponible cerca" for a ride that is already the driver's.
CREATE OR REPLACE FUNCTION public.admin_assign_ride_to_driver(p_ride_id uuid, p_driver_profile_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_admin           uuid := auth.uid();
  v_reason          text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_ride            public.rides%ROWTYPE;
  v_dp              public.driver_profiles%ROWTYPE;
  v_active_id       uuid;
  v_afford          jsonb;
  v_fleet_required  boolean := false;
  v_driver_in_fleet boolean := false;
  v_key             text;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;

  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  IF v_ride.status <> 'searching' THEN
    RETURN jsonb_build_object('error', 'ride_not_searching', 'status', v_ride.status);
  END IF;

  SELECT * INTO v_dp FROM public.driver_profiles WHERE id = p_driver_profile_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'driver_not_found');
  END IF;
  IF v_dp.status <> 'approved' THEN
    RETURN jsonb_build_object('error', 'driver_not_approved', 'driver_status', v_dp.status);
  END IF;
  IF NOT v_dp.is_online THEN
    RETURN jsonb_build_object('error', 'not_online');
  END IF;
  IF v_dp.last_heartbeat_at IS NOT NULL AND v_dp.last_heartbeat_at < now() - interval '3 minutes' THEN
    RETURN jsonb_build_object('error', 'stale_heartbeat', 'last_heartbeat_at', v_dp.last_heartbeat_at);
  END IF;
  IF NOT public._driver_can_serve_ride(v_dp.id, v_ride.service_type,
                                        v_ride.ride_mode = 'cargo' OR v_ride.service_type = 'mensajeria') THEN
    RETURN jsonb_build_object('error', 'wrong_vehicle_type');
  END IF;
  IF public._users_blocked(v_ride.customer_id, v_dp.user_id) THEN
    RETURN jsonb_build_object('error', 'blocked');
  END IF;

  -- Fleet gate, as accept_ride_v2 (00337).
  IF v_ride.corporate_account_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.corporate_accounts ca
      WHERE ca.id = v_ride.corporate_account_id
        AND ca.is_fleet_owner = true
        AND EXISTS (
          SELECT 1 FROM public.fleet_members fm
          JOIN public.driver_fleets df ON df.id = fm.fleet_id
          WHERE df.corporate_account_id = ca.id
            AND fm.status = 'active'
            AND fm.driver_id IS NOT NULL)
    ) INTO v_fleet_required;
    IF v_fleet_required THEN
      SELECT EXISTS (
        SELECT 1 FROM public.fleet_members fm
        JOIN public.driver_fleets df ON df.id = fm.fleet_id
        WHERE df.corporate_account_id = v_ride.corporate_account_id
          AND fm.driver_id = v_dp.user_id
          AND fm.status = 'active'
      ) INTO v_driver_in_fleet;
      IF NOT v_driver_in_fleet THEN
        RETURN jsonb_build_object('error', 'not_in_fleet');
      END IF;
    END IF;
  END IF;

  SELECT a.id INTO v_active_id FROM public.rides a
   WHERE a.driver_id = v_dp.id
     AND a.status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination')
     AND a.id <> p_ride_id
   LIMIT 1;
  IF v_active_id IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'busy', 'active_ride_id', v_active_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.service_type_configs WHERE slug = v_ride.service_type AND is_active) THEN
    RETURN jsonb_build_object('error', 'service_config_missing');
  END IF;

  v_afford := public.driver_can_afford_commission(v_dp.id, v_ride.estimated_fare_cup);
  IF NOT COALESCE((v_afford->>'ok')::boolean, true) THEN
    RETURN jsonb_build_object('error', 'insufficient_balance',
      'balance_trc', (v_afford->>'balance_trc')::int, 'required_trc', (v_afford->>'required_trc')::int);
  END IF;

  BEGIN
    UPDATE public.rides
       SET driver_id              = v_dp.id,
           status                 = 'accepted',
           accepted_at            = now(),
           driver_custom_rate_cup = v_dp.custom_per_km_rate_cup
     WHERE id = p_ride_id AND status = 'searching';
  EXCEPTION WHEN unique_violation THEN
    -- rides_one_active_per_driver: the driver took another ride a moment ago.
    RETURN jsonb_build_object('error', 'busy', 'race', true);
  END;

  UPDATE public.ride_offers SET status = 'accepted', responded_at = now()
   WHERE ride_id = p_ride_id AND driver_profile_id = v_dp.id AND status = 'pending';
  UPDATE public.ride_offers SET status = 'superseded', responded_at = now()
   WHERE ride_id = p_ride_id AND driver_profile_id <> v_dp.id AND status = 'pending';
  UPDATE public.ride_service_proposals SET status = 'superseded', responded_at = now()
   WHERE ride_id = p_ride_id AND status = 'pending';

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_admin, 'support_assign_ride', 'ride', p_ride_id::text,
          jsonb_build_object('status', 'searching'),
          jsonb_build_object('status', 'accepted', 'driver_profile_id', v_dp.id),
          v_reason);

  -- The driver's push. Category system is always delivered; send-push overwrites data.type with
  -- the category, so the event travels in data.event. Driver apps from 1.7.4 load the trip when
  -- it arrives; older ones load it when the app comes back to the foreground.
  v_key := public.get_service_role_key();
  IF v_key IS NOT NULL AND v_key <> '' THEN
    PERFORM public.cron_http_post('support-assign-push',
      url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
      body    := jsonb_build_object(
        'user_id', v_dp.user_id::text,
        'title', 'Soporte te asignó un viaje',
        'body', 'Recogida: ' || left(COALESCE(v_ride.pickup_address, '—'), 60)
                || ' · ' || COALESCE(v_ride.estimated_fare_cup, 0) || ' CUP. Abre la app.',
        'category', 'system',
        'data', jsonb_build_object('event', 'ride_assigned', 'ride_id', p_ride_id::text)));
  END IF;

  RETURN jsonb_build_object('success', true, 'ride_id', p_ride_id, 'driver_profile_id', v_dp.id);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_assign_ride_to_driver(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_assign_ride_to_driver(uuid, uuid, text) TO authenticated, service_role;
```

- [ ] **Step 2: Run the suite**

```bash
supabase/tests/00628/run.sh supabase/migrations/00628_support_assisted_matching.sql | grep -E '^(PASS|FAIL)  (W|K|O|A|G4)'
```

Expected: every `W…`, `K…`, `O…`, `A…` and `G4` line is PASS. `O10` proves a support offer is accepted through the live `accept_ride_v2`; `A2` proves the assignment writes what `accept_ride_v2` writes and logs `actor_role = admin` in `ride_transitions`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00628_support_assisted_matching.sql
git commit -m "feat(db): support can offer or assign a waiting ride to a chosen driver (00628)"
```

### Task 7: Migration — alerts, the help request, the cron and the closing checks (GREEN)

**Files:**
- Modify: `supabase/migrations/00628_support_assisted_matching.sql` (append)

- [ ] **Step 1: Append sections 8 and 9**

```sql
-- 8. Alerts to support: a push to every active admin and super_admin, and an e-mail to each
--    address in support_alert_email. Both through cron_http_post, so a failing send-push or
--    send-email shows up in the cron watchdog (check_cron_http_failures).
CREATE OR REPLACE FUNCTION public._support_alert(p_ride_id uuid, p_kind text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_ride     public.rides%ROWTYPE;
  v_customer public.users%ROWTYPE;
  v_admins   uuid[];
  v_key      text;
  v_headers  jsonb;
  v_code     text := public._ride_short_code(p_ride_id);
  v_link     text := 'https://admin.tricigo.com/rides/' || p_ride_id::text || '/assist';
  v_wait_min integer;
  v_title    text;
  v_body     text;
  v_html     text;
  v_to_raw   text;
  v_rcpt     text;
  v_row      text := '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>%s</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">%s</td></tr>';
BEGIN
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT * INTO v_customer FROM public.users WHERE id = v_ride.customer_id;

  v_key := public.get_service_role_key();
  IF v_key IS NULL OR v_key = '' THEN
    RETURN;
  END IF;
  v_headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_key, 'apikey', v_key);

  v_wait_min := GREATEST(0, floor(extract(epoch FROM now() - GREATEST(v_ride.created_at, v_ride.scheduled_at)) / 60))::int;
  v_title := CASE WHEN p_kind = 'help' THEN 'Pasajero pide ayuda · ' ELSE 'Viaje sin conductor · ' END || v_code;
  v_body := 'Espera ' || v_wait_min || ' min · '
         || left(COALESCE(v_ride.pickup_address, '—'), 60) || ' → ' || left(COALESCE(v_ride.dropoff_address, '—'), 60);

  SELECT array_agg(u.id) INTO v_admins
  FROM public.users u
  WHERE u.role IN ('admin', 'super_admin') AND u.is_active;
  IF v_admins IS NOT NULL THEN
    PERFORM public.cron_http_post(
      CASE WHEN p_kind = 'help' THEN 'support-help-alert' ELSE 'support-wait-alert' END,
      url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := v_headers,
      body    := jsonb_build_object(
        'user_ids', to_jsonb(v_admins),
        'title', v_title, 'body', v_body, 'category', 'system',
        'data', jsonb_build_object('event', 'support_' || p_kind, 'ride_id', p_ride_id::text, 'url', v_link)));
  END IF;

  v_to_raw := public.get_platform_config_text('support_alert_email', '');
  IF position('@' IN COALESCE(v_to_raw, '')) > 0 THEN
    -- Every value a user typed is escaped; every other value is non-null, because one NULL in a
    -- || chain blanks the whole body (CLAUDE.md, 00577).
    v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
      || '<h2 style="color:#ff4d00;border-bottom:2px solid #ff4d00;padding-bottom:8px">' || public._html_escape(v_title) || '</h2>'
      || '<p>' || CASE WHEN p_kind = 'help'
           THEN 'El pasajero tocó <b>Pedir ayuda</b> en la pantalla de búsqueda. También puede escribir por WhatsApp con el código del viaje.'
           ELSE 'Este viaje lleva más de ' || public.get_platform_config_numeric('support_alert_after_s', 60)::int
                || ' segundos sin conductor.' END
      || '</p>'
      || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
      || format(v_row, 'Código', v_code)
      || format(v_row, 'Espera', v_wait_min || ' min')
      || format(v_row, 'Pasajero', public._html_escape(COALESCE(v_customer.full_name, '—') || ' ' || COALESCE(v_customer.phone, '')))
      || format(v_row, 'Servicio', public._html_escape(v_ride.service_type) || ' · ' || COALESCE(v_ride.estimated_fare_cup, 0) || ' CUP')
      || format(v_row, 'Origen', public._html_escape(COALESCE(v_ride.pickup_address, '—')))
      || format(v_row, 'Destino', public._html_escape(COALESCE(v_ride.dropoff_address, '—')))
      || '</table>'
      || '<p><a href="' || v_link || '" style="display:inline-block;background:#ff4d00;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Asistir el viaje</a></p>'
      || '<p style="color:#777;font-size:12px">Aviso automático de TriciGo (00628). Se envía una vez por viaje y motivo. No responder.</p>'
      || '</body></html>';
    IF v_html IS NULL THEN
      RAISE EXCEPTION 'empty alert e-mail';
    END IF;
    FOR v_rcpt IN
      SELECT btrim(x) FROM unnest(string_to_array(v_to_raw, ',')) AS t(x) WHERE position('@' IN x) > 0
    LOOP
      PERFORM public.cron_http_post(
        CASE WHEN p_kind = 'help' THEN 'support-help-email' ELSE 'support-wait-email' END,
        url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
        headers := v_headers,
        body    := jsonb_build_object('recipient_email', v_rcpt, 'subject', '[TriciGo] ' || v_title,
                                      -- raw HTML: the legacy path of send-email's resolveTemplate (00503, 00538)
                                      'template', v_html, 'data', '{}'::jsonb));
    END LOOP;
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- An alert never fails its caller (the rider's button, the cron).
  RAISE WARNING '_support_alert failed for ride %: % %', p_ride_id, SQLSTATE, SQLERRM;
END;
$$;
REVOKE ALL ON FUNCTION public._support_alert(uuid, text) FROM PUBLIC, anon, authenticated;

-- The rider's "Pedir ayuda". Idempotent: support is alerted the first time only.
CREATE OR REPLACE FUNCTION public.request_ride_help(p_ride_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_ride public.rides%ROWTYPE;
  v_sent timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id;
  IF NOT FOUND OR v_ride.customer_id IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  IF v_ride.status <> 'searching' THEN
    RETURN jsonb_build_object('error', 'ride_not_searching', 'status', v_ride.status);
  END IF;

  INSERT INTO public.ride_assist (ride_id, help_requested_at)
  VALUES (p_ride_id, now())
  ON CONFLICT (ride_id) DO UPDATE
    SET help_requested_at = COALESCE(public.ride_assist.help_requested_at, EXCLUDED.help_requested_at)
  RETURNING help_alert_sent_at INTO v_sent;

  IF v_sent IS NULL THEN
    UPDATE public.ride_assist SET help_alert_sent_at = now() WHERE ride_id = p_ride_id;
    PERFORM public._support_alert(p_ride_id, 'help');
  END IF;

  RETURN jsonb_build_object('success', true, 'code', public._ride_short_code(p_ride_id));
END;
$$;
REVOKE ALL ON FUNCTION public.request_ride_help(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_ride_help(uuid) TO authenticated, service_role;

-- Every minute: one alert per ride that has waited longer than support_alert_after_s (at most
-- 6 hours back; a scheduled ride waits from scheduled_at). Test riders do not trigger it.
CREATE OR REPLACE FUNCTION public.notify_support_waiting_rides()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_after integer;
  v_id    uuid;
  v_n     integer := 0;
BEGIN
  IF public.get_platform_config_text('support_alert_enabled', 'true') = 'false' THEN
    RETURN 0;
  END IF;
  v_after := GREATEST(15, public.get_platform_config_numeric('support_alert_after_s', 60)::int);

  FOR v_id IN
    SELECT r.id
    FROM public.rides r
    JOIN public.users c ON c.id = r.customer_id
    LEFT JOIN public.ride_assist ra ON ra.ride_id = r.id
    WHERE r.status = 'searching'
      AND NOT c.is_test
      AND GREATEST(r.created_at, r.scheduled_at) <= now() - make_interval(secs => v_after)
      AND GREATEST(r.created_at, r.scheduled_at) > now() - interval '6 hours'
      AND ra.wait_alert_sent_at IS NULL
    ORDER BY GREATEST(r.created_at, r.scheduled_at)
    LIMIT 20
  LOOP
    INSERT INTO public.ride_assist (ride_id, wait_alert_sent_at)
    VALUES (v_id, now())
    ON CONFLICT (ride_id) DO UPDATE SET wait_alert_sent_at = EXCLUDED.wait_alert_sent_at
    WHERE public.ride_assist.wait_alert_sent_at IS NULL;
    IF FOUND THEN
      PERFORM public._support_alert(v_id, 'wait');
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.notify_support_waiting_rides() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('notify-support-waiting-rides', '* * * * *', 'SELECT public.notify_support_waiting_rides()');

-- 9. What this migration promises, checked in the database it just changed.
DO $assert$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (
      '_ride_short_code', '_vehicle_types_for_service', '_driver_can_serve_ride', '_users_blocked',
      '_html_escape', '_write_ride_estimate_snapshot', '_ride_service_change_error',
      '_apply_ride_service_change', '_support_alert', 'notify_support_waiting_rides')
  LOOP
    IF has_function_privilege('anon', r.fn, 'EXECUTE') OR has_function_privilege('authenticated', r.fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00628: % is executable by a client role', r.fn;
    END IF;
  END LOOP;

  FOR r IN
    SELECT p.oid::regprocedure AS fn FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (
      'request_ride_help', 'get_my_ride_service_proposal', 'respond_ride_service_proposal',
      'admin_support_waiting_rides', 'admin_ride_assist_context', 'admin_ride_assist_candidates',
      'admin_offer_ride_to_driver', 'admin_assign_ride_to_driver', 'admin_change_ride_service')
  LOOP
    IF has_function_privilege('anon', r.fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00628: % is executable by anon', r.fn;
    END IF;
    IF NOT has_function_privilege('authenticated', r.fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00628: % is not executable by authenticated', r.fn;
    END IF;
  END LOOP;

  IF has_table_privilege('anon', 'public.ride_assist', 'SELECT')
     OR has_table_privilege('authenticated', 'public.ride_assist', 'SELECT')
     OR has_table_privilege('anon', 'public.ride_service_proposals', 'SELECT')
     OR has_table_privilege('authenticated', 'public.ride_service_proposals', 'SELECT') THEN
    RAISE EXCEPTION '00628: a client role can read a support table';
  END IF;

  IF position('_write_ride_estimate_snapshot' IN
       (SELECT prosrc FROM pg_proc WHERE oid = 'public.tg_rides_create_estimate_snapshot()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '00628: the estimate trigger does not call the shared writer';
  END IF;
  IF position('app.force_discount_recompute' IN
       (SELECT prosrc FROM pg_proc WHERE oid = 'public.tg_rides_validate_promo_discount()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '00628: the discount trigger was not patched';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notify-support-waiting-rides') THEN
    RAISE EXCEPTION '00628: the support alert cron is not scheduled';
  END IF;
END
$assert$;
```

- [ ] **Step 2: Run the whole suite**

```bash
supabase/tests/00628/run.sh supabase/migrations/00628_support_assisted_matching.sql | tail -8
```

Expected: no `FAIL` line, and the last line is `PASS 73  FAIL 0`.

- [ ] **Step 3: Run the repo's migration checks**

```bash
pnpm test:migration-grants && pnpm check:migration-grants
grep -nE '\b(DELETE|DROP|TRUNCATE)\b' supabase/migrations/00628_support_assisted_matching.sql
```

Expected: both checks pass, and `grep` prints five lines and nothing else: the three foreign-key clauses (`ride_assist.ride_id` and `ride_service_proposals.ride_id` with `ON DELETE CASCADE`, `ride_service_proposals.proposed_by` with `ON DELETE SET NULL`) and the two `GRANT SELECT, INSERT, UPDATE, DELETE … TO service_role` lines. None of those is a destructive statement. A `DELETE`, `DROP` or `TRUNCATE` statement anywhere in the file, even inside a function body, makes the MCP apply wait for approval in the app and time out at 60 s (CLAUDE.md § "Aplicar migraciones pesadas por MCP"); if `grep` shows one, rewrite it before going on.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00628_support_assisted_matching.sql
git commit -m "feat(db): alert support about waiting rides by push and e-mail, rider help request (00628)"
```

## Phase 2 — Shared packages

### Task 8: `searchHelpAvailable`, `rideShortCode`, `SUPPORT_WHATSAPP_PHONE` and `pricingClock` in `@tricigo/utils`

**Files:**
- Modify: `packages/utils/src/searchWait.ts`
- Modify: `packages/utils/src/fareCalculator.ts`
- Modify: `packages/utils/src/index.ts:180-182`
- Test: `packages/utils/src/__tests__/searchWait.test.ts`, `packages/utils/src/__tests__/fareCalculator.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/utils/src/__tests__/searchWait.test.ts` (and add `searchHelpAvailable`, `rideShortCode` and `SUPPORT_WHATSAPP_PHONE` to its import list from `'../searchWait'`):

```ts
describe('searchHelpAvailable — when the searching screen offers "Pedir ayuda"', () => {
  it('stays hidden while most rides are still being accepted', () => {
    expect(searchHelpAvailable(0)).toBe(false);
    expect(searchHelpAvailable(44)).toBe(false);
  });

  it('appears from 45 s, the stage where the screen starts reassuring', () => {
    expect(searchHelpAvailable(45)).toBe(true);
    expect(searchHelpAvailable(600)).toBe(true);
  });

  it('stays hidden on a nonsense clock', () => {
    expect(searchHelpAvailable(Number.NaN)).toBe(false);
    expect(searchHelpAvailable(-5)).toBe(false);
  });
});

describe('rideShortCode — the code the rider writes to support on WhatsApp', () => {
  it('is the first 8 characters of the id, upper case, as the server makes it (_ride_short_code)', () => {
    expect(rideShortCode('f1a2b3c4-0000-4000-8000-000000000001')).toBe('F1A2B3C4');
  });
});

describe('SUPPORT_WHATSAPP_PHONE', () => {
  it('is the support number the help screens already open', () => {
    expect(SUPPORT_WHATSAPP_PHONE).toBe('+5356621636');
  });
});
```

Append to `packages/utils/src/__tests__/fareCalculator.test.ts` (and add `pricingClock` to its import list from `'../fareCalculator'`):

```ts
describe('pricingClock — the clock matchPricingRule reads', () => {
  it('reads Havana time in October (UTC-4, daylight saving)', () => {
    // 03:30 UTC on Wednesday 7 Oct 2026 is 23:30 on Tuesday 6 Oct in Havana.
    expect(pricingClock(new Date('2026-10-07T03:30:00Z'), 'America/Havana')).toEqual({ hhmm: '23:30', day: 2 });
  });

  it('reads Havana time in December (UTC-5)', () => {
    // 15:05 UTC on Monday 7 Dec 2026 is 10:05 in Havana.
    expect(pricingClock(new Date('2026-12-07T15:05:00Z'), 'America/Havana')).toEqual({ hhmm: '10:05', day: 1 });
  });

  it('pads single digits and never says 24:00 at midnight', () => {
    expect(pricingClock(new Date('2026-10-07T04:05:00Z'), 'America/Havana')).toEqual({ hhmm: '00:05', day: 3 });
  });

  it('reads the device clock without a zone, as the rider app always has', () => {
    const d = new Date('2026-10-07T15:04:00Z');
    expect(pricingClock(d)).toEqual({
      hhmm: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      day: d.getDay(),
    });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @tricigo/utils exec vitest run src/__tests__/searchWait.test.ts src/__tests__/fareCalculator.test.ts`
Expected: FAIL — `searchHelpAvailable`, `rideShortCode`, `SUPPORT_WHATSAPP_PHONE` and `pricingClock` are not exported.

- [ ] **Step 3: Implement**

At the end of `packages/utils/src/searchWait.ts`:

```ts
/**
 * Whether the searching screen offers "Pedir ayuda" (support helps the rider find a driver).
 * From 45 s, the stage where the screen starts reassuring: before that most rides are still
 * being accepted, and a help button would only add work for support.
 */
export function searchHelpAvailable(elapsedSeconds: number): boolean {
  const stage = searchWaitStage(elapsedSeconds);
  return stage === 'extended' || stage === 'long';
}

/** TriciGo support's WhatsApp, the number the help screens of both apps already open. */
export const SUPPORT_WHATSAPP_PHONE = '+5356621636';

/**
 * The ride code the rider and support talk about: the first 8 characters of the id, upper
 * case. The same as the server's _ride_short_code (00628), so the app can write it on
 * WhatsApp even when request_ride_help did not answer.
 */
export function rideShortCode(rideId: string): string {
  return rideId.slice(0, 8).toUpperCase();
}
```

At the end of `packages/utils/src/fareCalculator.ts`:

```ts
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The wall clock matchPricingRule needs ("HH:MM" and day of week, 0 = Sunday), read in an IANA
 * time zone. Without a zone it reads the device clock, which is what the rider app has always
 * done: phones in Cuba run on Havana time. Support re-quotes a ride from a browser that can be
 * anywhere, so it passes 'America/Havana', the zone the estimate snapshot uses (00299, 00628).
 */
export function pricingClock(date: Date, timeZone?: string): { hhmm: string; day: number } {
  if (!timeZone) {
    return {
      hhmm: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
      day: date.getDay(),
    };
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return { hhmm: `${part('hour')}:${part('minute')}`, day: WEEKDAYS.indexOf(part('weekday')) };
}
```

In `packages/utils/src/index.ts`, change line 180 to also export the three new names:

```ts
export {
  SEARCH_TYPICAL_WAIT_S,
  SEARCH_LONG_WAIT_S,
  searchWaitStage,
  searchWaitView,
  searchHelpAvailable,
  rideShortCode,
  SUPPORT_WHATSAPP_PHONE,
} from './searchWait';
```

(`pricingClock` is already exported through `export * from './fareCalculator'` at line 10.)

- [ ] **Step 4: Run the tests again**

Run: `pnpm --filter @tricigo/utils exec vitest run src/__tests__/searchWait.test.ts src/__tests__/fareCalculator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/utils/src/searchWait.ts packages/utils/src/fareCalculator.ts packages/utils/src/index.ts \
  packages/utils/src/__tests__/searchWait.test.ts packages/utils/src/__tests__/fareCalculator.test.ts
git commit -m "feat(utils): help-button, ride-code and pricing-clock helpers for support-assisted matching"
```

### Task 9: `getLocalFareEstimate` can quote for a rider, on Havana time

Support's quote must be the price the rider would get: the time band in Havana time, and, if a pricing experiment is ever active, the rider's variant, without counting support's quote as an experiment ride. The rider app passes neither option, so its prices do not change.

**Files:**
- Modify: `packages/api/src/services/ride.service.ts:232-239`, `:314-317`, `:399-424`
- Test: `packages/api/src/services/__tests__/ride.test.ts`

- [ ] **Step 1: Write the failing tests**

Add inside `describe('rideService.getLocalFareEstimate', …)` in `packages/api/src/services/__tests__/ride.test.ts`:

```ts
  it('reads the time band in the zone it is given (support quotes on Havana time)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 03:30 UTC is 23:30 the evening before in Havana: the evening rule must win.
    vi.setSystemTime(new Date('2026-10-07T03:30:00Z'));
    const rules = [
      { id: 'rule-dawn', service_type: 'triciclo_basico', base_fare_cup: 9000, per_km_rate_cup: 1000,
        per_minute_rate_cup: 500, min_fare_cup: 3000, time_window_start: '00:00', time_window_end: '06:00',
        day_of_week: null, is_active: true },
      { id: 'rule-evening', service_type: 'triciclo_basico', base_fare_cup: 5000, per_km_rate_cup: 1000,
        per_minute_rate_cup: 500, min_fare_cup: 3000, time_window_start: '18:00', time_window_end: '00:00',
        day_of_week: null, is_active: true },
    ];
    const chain = createMockQueryChain({ data: rules, error: null });
    chain.single.mockResolvedValue({ data: TRICICLO_CONFIG, error: null });
    chain.maybeSingle.mockResolvedValue({ data: null, error: null });
    mockFrom.mockImplementation(() => chain);
    try {
      const estimate = await rideService.getLocalFareEstimate({
        service_type: 'triciclo_basico',
        pickup_lat: 23.1352, pickup_lng: -82.3599, dropoff_lat: 23.1375, dropoff_lng: -82.3964,
        time_zone: 'America/Havana',
      });
      expect(estimate.pricing_rule_id).toBe('rule-evening');
    } finally {
      vi.useRealTimers();
    }
  });

  it('prices an experiment with the rider it is given and does not count the quote', async () => {
    const experiment = { id: 'exp-1', variant_a_multiplier: 1, variant_b_multiplier: 2 };
    const quote = async (userId: string) => {
      const chain = createMockQueryChain();
      chain.single.mockResolvedValue({ data: TRICICLO_CONFIG, error: null });
      chain.maybeSingle.mockResolvedValue({ data: experiment, error: null });
      mockFrom.mockImplementation(() => chain);
      return rideService.getLocalFareEstimate({
        service_type: 'triciclo_basico',
        pickup_lat: 23.1352, pickup_lng: -82.3599, dropoff_lat: 23.1375, dropoff_lng: -82.3964,
        for_user_id: userId,
      });
    };
    // The variant is the parity of the sum of the id's char codes: 'b' (98) is A, 'a' (97) is B.
    const variantA = await quote('b');
    const variantB = await quote('a');

    expect(variantB.estimated_fare_cup).toBe(variantA.estimated_fare_cup * 2);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalledWith('increment_experiment_rides', expect.anything());
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @tricigo/api exec vitest run src/services/__tests__/ride.test.ts -t "getLocalFareEstimate"`
Expected: FAIL — TypeScript rejects `time_zone` and `for_user_id`, or the rule is `rule-dawn`.

- [ ] **Step 3: Implement**

In `packages/api/src/services/ride.service.ts`, add `pricingClock` to the `@tricigo/utils` import list (lines 36-48), then extend the parameters of `getLocalFareEstimate`:

```ts
  async getLocalFareEstimate(params: {
    service_type: ServiceTypeSlug;
    pickup_lat: number;
    pickup_lng: number;
    dropoff_lat: number;
    dropoff_lng: number;
    waypoints?: { lat: number; lng: number }[];
    /**
     * Quote for this rider instead of the signed-in user (support re-quoting a rider's ride):
     * a pricing experiment uses the rider's variant, and the quote is not counted as an
     * experiment ride.
     */
    for_user_id?: string;
    /** IANA zone for the time band. Default: the device's. Support passes 'America/Havana'. */
    time_zone?: string;
  }): Promise<FareEstimate> {
```

Replace the three clock lines (314-317):

```ts
    // Find matching time-based rule (using pure function)
    const { hhmm: currentHour, day: currentDay } = pricingClock(new Date(), params.time_zone);
```

In the A/B experiment block (around 399-424), replace the `userId` line and guard the counter:

```ts
        // Only fetch user if we have an active experiment
        const userId = params.for_user_id ?? (await supabase.auth.getUser()).data.user?.id;
```

```ts
          // Increment rides counter (non-blocking, fire-and-forget). A quote made for someone
          // else (support) is not an experiment ride.
          if (!params.for_user_id) {
            void supabase.rpc('increment_experiment_rides', {
              p_experiment_id: experiment.id,
              p_variant: variant,
            });
          }
```

- [ ] **Step 4: Run the tests again**

Run: `pnpm --filter @tricigo/api exec vitest run src/services/__tests__/ride.test.ts`
Expected: PASS, including the existing estimate tests.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/ride.service.ts packages/api/src/services/__tests__/ride.test.ts
git commit -m "feat(api): fare estimate can quote for a rider on Havana time"
```

### Task 10: `rideAssistService`

**Files:**
- Create: `packages/api/src/services/ride-assist.service.ts`
- Modify: `packages/api/src/index.ts` (after the launch-pulse exports, line 53), `packages/api/package.json` (exports map)
- Test: `packages/api/src/services/__tests__/ride-assist.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
vi.mock('../../client', () => ({
  getSupabaseClient: () => ({ rpc: mockRpc }),
}));

import { rideAssistService, RIDE_ASSIST_UNAVAILABLE, isProposalGone } from '../ride-assist.service';

const MISSING = { code: 'PGRST202', message: 'Could not find the function public.request_ride_help' };

describe('rideAssistService', () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  describe('requestHelp (the rider never waits on it: WhatsApp opens either way)', () => {
    it('returns the ride code', async () => {
      mockRpc.mockResolvedValueOnce({ data: { success: true, code: 'F1000000' }, error: null });
      await expect(rideAssistService.requestHelp('r-1')).resolves.toEqual({ code: 'F1000000' });
      expect(mockRpc).toHaveBeenCalledWith('request_ride_help', { p_ride_id: 'r-1' });
    });

    it('returns null when the migration is missing, the server refuses, or the network fails', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: MISSING });
      await expect(rideAssistService.requestHelp('r-1')).resolves.toBeNull();
      mockRpc.mockResolvedValueOnce({ data: { error: 'ride_not_searching' }, error: null });
      await expect(rideAssistService.requestHelp('r-1')).resolves.toBeNull();
      mockRpc.mockRejectedValueOnce(new TypeError('Network request failed'));
      await expect(rideAssistService.requestHelp('r-1')).resolves.toBeNull();
    });
  });

  describe('getPendingProposal', () => {
    it('returns the proposal', async () => {
      const p = { id: 'p-1', ride_id: 'r-1', from_service_type: 'triciclo_basico', to_service_type: 'auto_standard',
        from_fare_cup: 2000, to_fare_cup: 3000, expires_at: '2026-10-07T12:03:00Z' };
      mockRpc.mockResolvedValueOnce({ data: p, error: null });
      await expect(rideAssistService.getPendingProposal('r-1')).resolves.toEqual(p);
      expect(mockRpc).toHaveBeenCalledWith('get_my_ride_service_proposal', { p_ride_id: 'r-1' });
    });

    it('returns null when there is none or the migration is missing', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });
      await expect(rideAssistService.getPendingProposal('r-1')).resolves.toBeNull();
      mockRpc.mockResolvedValueOnce({ data: null, error: MISSING });
      await expect(rideAssistService.getPendingProposal('r-1')).resolves.toBeNull();
    });

    it('throws any other error', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'timeout' } });
      await expect(rideAssistService.getPendingProposal('r-1')).rejects.toMatchObject({ message: 'timeout' });
    });
  });

  describe('respondProposal', () => {
    it('sends the answer', async () => {
      mockRpc.mockResolvedValueOnce({ data: { success: true, accepted: true }, error: null });
      await rideAssistService.respondProposal('p-1', true);
      expect(mockRpc).toHaveBeenCalledWith('respond_ride_service_proposal', { p_proposal_id: 'p-1', p_accept: true });
    });

    it('throws the server code when it refuses', async () => {
      mockRpc.mockResolvedValueOnce({ data: { error: 'proposal_expired' }, error: null });
      await expect(rideAssistService.respondProposal('p-1', true)).rejects.toMatchObject({ code: 'proposal_expired' });
    });
  });

  describe('isProposalGone (the card goes away; the rider cannot fix it by retrying)', () => {
    it('is true for every refusal from the server', async () => {
      for (const code of ['proposal_expired', 'proposal_not_pending', 'proposal_not_found', 'ride_not_searching', 'fare_below_minimum']) {
        mockRpc.mockResolvedValueOnce({ data: { error: code }, error: null });
        const err = await rideAssistService.respondProposal('p-1', true).catch((e: unknown) => e);
        expect(isProposalGone(err)).toBe(true);
      }
    });

    it('is false for a network error or a database error, which the rider can retry', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'timeout' } });
      const dbErr = await rideAssistService.respondProposal('p-1', true).catch((e: unknown) => e);
      expect(isProposalGone(dbErr)).toBe(false);
      expect(isProposalGone(new TypeError('Network request failed'))).toBe(false);
    });
  });

  describe('getWaitingRides', () => {
    it('returns the rows, or none when the migration is missing', async () => {
      const rows = [{ ride_id: 'r-1', code: 'F1000000', wait_s: 75, help_requested_at: null }];
      mockRpc.mockResolvedValueOnce({ data: rows, error: null });
      await expect(rideAssistService.getWaitingRides()).resolves.toEqual(rows);
      mockRpc.mockResolvedValueOnce({ data: null, error: MISSING });
      await expect(rideAssistService.getWaitingRides()).resolves.toEqual([]);
    });

    it('throws when the caller is not an admin', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'forbidden' } });
      await expect(rideAssistService.getWaitingRides()).rejects.toMatchObject({ message: 'forbidden' });
    });
  });

  describe('support actions', () => {
    it('getAssistContext says the feature is unavailable when the migration is missing', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: MISSING });
      await expect(rideAssistService.getAssistContext('r-1')).rejects.toMatchObject({ code: RIDE_ASSIST_UNAVAILABLE });
    });

    it('getCandidates asks for the ride type unless told otherwise', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });
      await rideAssistService.getCandidates('r-1');
      expect(mockRpc).toHaveBeenCalledWith('admin_ride_assist_candidates', { p_ride_id: 'r-1', p_service_type: null });
      mockRpc.mockResolvedValueOnce({ data: [], error: null });
      await rideAssistService.getCandidates('r-1', 'auto_standard');
      expect(mockRpc).toHaveBeenLastCalledWith('admin_ride_assist_candidates', { p_ride_id: 'r-1', p_service_type: 'auto_standard' });
    });

    it('offerToDriver returns what happened to the offer', async () => {
      mockRpc.mockResolvedValueOnce({ data: { success: true, mode: 'rearmed', expires_at: '2026-10-07T12:02:00Z' }, error: null });
      await expect(rideAssistService.offerToDriver('r-1', 'd-1')).resolves.toEqual({ mode: 'rearmed', expiresAt: '2026-10-07T12:02:00Z' });
      expect(mockRpc).toHaveBeenCalledWith('admin_offer_ride_to_driver', { p_ride_id: 'r-1', p_driver_profile_id: 'd-1' });
    });

    it('offerToDriver throws the refusal code', async () => {
      mockRpc.mockResolvedValueOnce({ data: { error: 'wrong_vehicle_type' }, error: null });
      await expect(rideAssistService.offerToDriver('r-1', 'd-2')).rejects.toMatchObject({ code: 'wrong_vehicle_type' });
    });

    it('assignToDriver sends the reason and throws the refusal code', async () => {
      mockRpc.mockResolvedValueOnce({ data: { error: 'busy', active_ride_id: 'r-9' }, error: null });
      await expect(rideAssistService.assignToDriver('r-1', 'd-4', 'Habló por WhatsApp')).rejects.toMatchObject({ code: 'busy' });
      expect(mockRpc).toHaveBeenCalledWith('admin_assign_ride_to_driver', {
        p_ride_id: 'r-1', p_driver_profile_id: 'd-4', p_reason: 'Habló por WhatsApp',
      });
    });

    it('changeServiceType proposes and returns the proposal', async () => {
      mockRpc.mockResolvedValueOnce({ data: { success: true, mode: 'propose', proposal_id: 'p-1', expires_at: '2026-10-07T12:03:00Z' }, error: null });
      await expect(rideAssistService.changeServiceType('r-1', 'auto_standard', 3000, 'propose'))
        .resolves.toEqual({ proposalId: 'p-1', expiresAt: '2026-10-07T12:03:00Z' });
      expect(mockRpc).toHaveBeenCalledWith('admin_change_ride_service', {
        p_ride_id: 'r-1', p_service_type: 'auto_standard', p_fare_cup: 3000, p_mode: 'propose', p_reason: null,
      });
    });

    it('changeServiceType applies with a reason and throws the refusal code', async () => {
      mockRpc.mockResolvedValueOnce({ data: { error: 'fare_below_minimum' }, error: null });
      await expect(rideAssistService.changeServiceType('r-1', 'auto_standard', 900, 'apply', 'Aceptó por WhatsApp'))
        .rejects.toMatchObject({ code: 'fare_below_minimum' });
      expect(mockRpc).toHaveBeenCalledWith('admin_change_ride_service', {
        p_ride_id: 'r-1', p_service_type: 'auto_standard', p_fare_cup: 900, p_mode: 'apply', p_reason: 'Aceptó por WhatsApp',
      });
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @tricigo/api exec vitest run src/services/__tests__/ride-assist.test.ts`
Expected: FAIL — `Cannot find module '../ride-assist.service'`.

- [ ] **Step 3: Write `packages/api/src/services/ride-assist.service.ts`**

```ts
// ============================================================
// TriciGo — support-assisted matching (migration 00628)
// The rider's "Pedir ayuda" and proposal card, and the admin's assist page.
// The server answers an expected refusal as `{ error: code }`; it comes back here as an
// AppError whose `code` is that string. A missing function (00628 not applied) is PGRST202.
// ============================================================

import { getSupabaseClient } from '../client';
import { AppError } from '../errors';

export type RideOfferStatus = 'pending' | 'accepted' | 'rejected' | 'expired' | 'superseded';
export type ServiceProposalStatus = 'pending' | 'accepted' | 'rejected' | 'superseded';
export type ServiceChangeMode = 'propose' | 'apply';
export type SupportOfferMode = 'created' | 'rearmed' | 'extended';

/** A row of the admin banner (admin_support_waiting_rides). */
export interface SupportWaitingRide {
  ride_id: string;
  code: string;
  waiting_since: string;
  wait_s: number;
  help_requested_at: string | null;
  service_type: string;
  estimated_fare_cup: number;
  pickup_address: string;
  dropoff_address: string;
  pending_offers: number;
  is_test: boolean;
}

/** The pending proposal a rider sees (get_my_ride_service_proposal). */
export interface ServiceProposal {
  id: string;
  ride_id: string;
  from_service_type: string;
  to_service_type: string;
  from_fare_cup: number;
  to_fare_cup: number;
  expires_at: string;
}

export interface RideAssistOffer {
  driver_profile_id: string;
  driver_name: string;
  status: RideOfferStatus;
  offered_at: string;
  expires_at: string;
  responded_at: string | null;
}

export interface RideAssistProposal {
  id: string;
  from_service_type: string;
  to_service_type: string;
  from_fare_cup: number;
  to_fare_cup: number;
  status: ServiceProposalStatus;
  expires_at: string;
  responded_at: string | null;
  created_at: string;
}

/** Everything the assist page shows about a ride (admin_ride_assist_context). */
export interface RideAssistContext {
  ride: {
    id: string;
    code: string;
    status: string;
    service_type: string;
    ride_mode: string;
    estimated_fare_cup: number;
    discount_amount_cup: number;
    payment_method: string;
    passenger_count: number;
    shared_ride: boolean;
    is_corporate: boolean;
    has_waypoints: boolean;
    pickup_address: string;
    dropoff_address: string;
    pickup_lat: number;
    pickup_lng: number;
    dropoff_lat: number;
    dropoff_lng: number;
    created_at: string;
    wait_s: number;
    customer_id: string;
    customer_name: string;
    customer_phone: string | null;
    customer_is_test: boolean;
  };
  help_requested_at: string | null;
  offers: RideAssistOffer[];
  proposal: RideAssistProposal | null;
}

/** A driver support can call or send the ride to (admin_ride_assist_candidates). */
export interface AssistCandidate {
  driver_profile_id: string;
  full_name: string;
  phone: string | null;
  vehicle_type: 'triciclo' | 'moto' | 'auto' | 'confort';
  vehicle_label: string;
  is_online: boolean;
  last_heartbeat_at: string | null;
  distance_m: number | null;
  busy_ride_id: string | null;
  can_afford: boolean;
  offer_status: RideOfferStatus | null;
  offer_expires_at: string | null;
}

/** The code the assist page shows as "not available yet". */
export const RIDE_ASSIST_UNAVAILABLE = 'ride_assist_unavailable';

interface RpcError {
  code?: string;
  message?: string;
}

function isMissingRpc(error: RpcError | null | undefined): boolean {
  return !!error && (error.code === 'PGRST202'
    || /could not find the function|not found in the schema cache/i.test(error.message ?? ''));
}

function unavailable(rpc: string): AppError {
  return new AppError(`${rpc} is not deployed yet (migration 00628)`, RIDE_ASSIST_UNAVAILABLE, 503);
}

/** `{ error: code }` from an RPC becomes an AppError carrying the code. */
function throwIfRefused(rpc: string, data: unknown): void {
  const code = (data as { error?: unknown } | null)?.error;
  if (typeof code === 'string' && code) {
    throw new AppError(`${rpc} refused: ${code}`, code, 409, data as Record<string, unknown>);
  }
}

/**
 * Whether a failed respondProposal means the proposal is over for the rider: it expired, a newer
 * one replaced it, it was answered elsewhere, the ride stopped searching, or the change can no
 * longer be applied (the type's minimum fare went up). The card should go. False for a network
 * or database error, which the rider can retry.
 */
export function isProposalGone(err: unknown): boolean {
  return err instanceof AppError && err.statusCode === 409;
}

export const rideAssistService = {
  /**
   * The rider's "Pedir ayuda": marks the ride and alerts support, once. Returns the ride code
   * for the WhatsApp message, or null if the server could not take the request. Never throws:
   * the caller opens WhatsApp either way.
   */
  async requestHelp(rideId: string): Promise<{ code: string } | null> {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.rpc('request_ride_help', { p_ride_id: rideId });
      if (error) return null;
      const r = data as { success?: boolean; code?: string } | null;
      return r?.success && r.code ? { code: r.code } : null;
    } catch {
      return null;
    }
  },

  /** The rider's pending, unexpired proposal, or null (none, or the migration is missing). */
  async getPendingProposal(rideId: string): Promise<ServiceProposal | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_my_ride_service_proposal', { p_ride_id: rideId });
    if (error) {
      if (isMissingRpc(error)) return null;
      throw error;
    }
    return (data as ServiceProposal | null) ?? null;
  },

  /** The rider accepts or rejects a proposal. Refusals throw with the server's code. */
  async respondProposal(proposalId: string, accept: boolean): Promise<void> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('respond_ride_service_proposal', {
      p_proposal_id: proposalId,
      p_accept: accept,
    });
    if (error) {
      if (isMissingRpc(error)) throw unavailable('respond_ride_service_proposal');
      throw error;
    }
    throwIfRefused('respond_ride_service_proposal', data);
  },

  /** The admin banner's rides. None when the migration is missing; other errors throw. */
  async getWaitingRides(): Promise<SupportWaitingRide[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_support_waiting_rides');
    if (error) {
      if (isMissingRpc(error)) return [];
      throw error;
    }
    return (data ?? []) as SupportWaitingRide[];
  },

  async getAssistContext(rideId: string): Promise<RideAssistContext> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_ride_assist_context', { p_ride_id: rideId });
    if (error) {
      if (isMissingRpc(error)) throw unavailable('admin_ride_assist_context');
      throw error;
    }
    throwIfRefused('admin_ride_assist_context', data);
    return data as RideAssistContext;
  },

  /** Drivers for the ride's own type, or for `serviceType` when support considers another. */
  async getCandidates(rideId: string, serviceType?: string): Promise<AssistCandidate[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_ride_assist_candidates', {
      p_ride_id: rideId,
      p_service_type: serviceType ?? null,
    });
    if (error) {
      if (isMissingRpc(error)) throw unavailable('admin_ride_assist_candidates');
      throw error;
    }
    return (data ?? []) as AssistCandidate[];
  },

  async offerToDriver(rideId: string, driverProfileId: string): Promise<{ mode: SupportOfferMode; expiresAt: string }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_offer_ride_to_driver', {
      p_ride_id: rideId,
      p_driver_profile_id: driverProfileId,
    });
    if (error) {
      if (isMissingRpc(error)) throw unavailable('admin_offer_ride_to_driver');
      throw error;
    }
    throwIfRefused('admin_offer_ride_to_driver', data);
    const r = data as { mode: SupportOfferMode; expires_at: string };
    return { mode: r.mode, expiresAt: r.expires_at };
  },

  async assignToDriver(rideId: string, driverProfileId: string, reason: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_assign_ride_to_driver', {
      p_ride_id: rideId,
      p_driver_profile_id: driverProfileId,
      p_reason: reason,
    });
    if (error) {
      if (isMissingRpc(error)) throw unavailable('admin_assign_ride_to_driver');
      throw error;
    }
    throwIfRefused('admin_assign_ride_to_driver', data);
  },

  /** Propose the type to the rider, or apply it with the rider's WhatsApp consent (`reason`). */
  async changeServiceType(
    rideId: string,
    serviceType: string,
    fareCup: number,
    mode: ServiceChangeMode,
    reason?: string,
  ): Promise<{ proposalId: string | null; expiresAt: string | null }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_change_ride_service', {
      p_ride_id: rideId,
      p_service_type: serviceType,
      p_fare_cup: fareCup,
      p_mode: mode,
      p_reason: reason ?? null,
    });
    if (error) {
      if (isMissingRpc(error)) throw unavailable('admin_change_ride_service');
      throw error;
    }
    throwIfRefused('admin_change_ride_service', data);
    const r = data as { proposal_id?: string; expires_at?: string };
    return { proposalId: r.proposal_id ?? null, expiresAt: r.expires_at ?? null };
  },
};
```

- [ ] **Step 4: Export it**

In `packages/api/src/index.ts`, after the launch-pulse type export block (line 53):

```ts
export { rideAssistService, RIDE_ASSIST_UNAVAILABLE, isProposalGone } from './services/ride-assist.service';
export type {
  SupportWaitingRide,
  ServiceProposal,
  RideAssistContext,
  RideAssistOffer,
  RideAssistProposal,
  AssistCandidate,
  RideOfferStatus,
  ServiceProposalStatus,
  ServiceChangeMode,
  SupportOfferMode,
} from './services/ride-assist.service';
```

In `packages/api/package.json`, add to the `exports` map, next to `"./services/ride"`:

```json
    "./services/ride-assist": "./src/services/ride-assist.service.ts",
```

- [ ] **Step 5: Run the tests and the type check**

Run: `pnpm --filter @tricigo/api exec vitest run src/services/__tests__/ride-assist.test.ts && pnpm --filter @tricigo/api check-types`
Expected: PASS, and no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/services/ride-assist.service.ts packages/api/src/services/__tests__/ride-assist.test.ts \
  packages/api/src/index.ts packages/api/package.json
git commit -m "feat(api): rideAssistService for support-assisted matching"
```

### Task 11: Find a ride by its 8-character code in the admin

The rider writes on WhatsApp "Viaje: F1A2B3C4". Support types that code in `/rides`.

**Files:**
- Modify: `packages/api/src/services/admin.service.ts:7-9` (helper), `:754-757` (filter)
- Test: `packages/api/src/services/__tests__/admin.test.ts` (next to "applies search filter via or (address)")

- [ ] **Step 1: Write the failing test**

```ts
    it('finds a ride by its 8-character code (with or without #, any case)', async () => {
      const rides = [{ id: 'f1a2b3c4-0000-4000-8000-000000000001' }];
      const chain = createMockQueryChain({ data: rides, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getRides({ search: ' #F1A2B3C4 ' });

      expect(chain.gte).toHaveBeenCalledWith('id', 'f1a2b3c4-0000-0000-0000-000000000000');
      expect(chain.lte).toHaveBeenCalledWith('id', 'f1a2b3c4-ffff-ffff-ffff-ffffffffffff');
      expect(chain.or).not.toHaveBeenCalled();
      expect(result).toEqual(rides);
    });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @tricigo/api exec vitest run src/services/__tests__/admin.test.ts -t "8-character code"`
Expected: FAIL — `chain.gte` was not called.

- [ ] **Step 3: Implement**

After `escapeLikePattern` in `packages/api/src/services/admin.service.ts`:

```ts
/**
 * A ride code as riders and support write it ("F1A2B3C4", "#f1a2b3c4"): the first 8 hex
 * characters of the ride id, lower-cased. null when the text is not one.
 */
function rideCodePrefix(text: string): string | null {
  const m = text.trim().match(/^#?([0-9a-f]{8})$/i);
  return m ? m[1]!.toLowerCase() : null;
}
```

Replace the search block of `getRides`:

```ts
    if (filters.search) {
      const code = rideCodePrefix(filters.search);
      if (code) {
        // uuid order is byte order, so every id with this prefix lies in this range.
        query = query
          .gte('id', `${code}-0000-0000-0000-000000000000`)
          .lte('id', `${code}-ffff-ffff-ffff-ffffffffffff`);
      } else {
        const escaped = escapeLikePattern(filters.search);
        query = query.or(`pickup_address.ilike.%${escaped}%,dropoff_address.ilike.%${escaped}%`);
      }
    }
```

- [ ] **Step 4: Run the admin tests**

Run: `pnpm --filter @tricigo/api exec vitest run src/services/__tests__/admin.test.ts`
Expected: PASS, including "applies search filter via or (address)".

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/admin.service.ts packages/api/src/services/__tests__/admin.test.ts
git commit -m "feat(admin): find a ride by its 8-character code"
```

## Phase 3 — Admin panel

The admin has no unit-test runner. Each task is verified with the type check and the lint config CI uses, and the whole panel is checked by hand in Task 21.

### Task 12: Admin copy and settings

**Files:**
- Modify: `packages/i18n/src/locales/{es,en,pt}/admin.json` (new `ride_assist` section at the end; 10 keys in `platform_config`; one placeholder in `rides`)
- Modify: `apps/admin/src/app/settings/platform-config/page.tsx:141` (`KNOWN_KEYS`)

- [ ] **Step 1: Add the `ride_assist` section to each `admin.json`**

`admin.json` already has a `support` section (the support tickets page, 55 keys). The new section must not reuse that name: a second `"support"` key in the same object silently replaces the first when the file is parsed, and the tickets page would lose its copy.

Each file ends with the `incomplete_drivers` section and `}`. Replace the last two lines (`  }` and `}`) with `  },`, the section below, and `}`.

`es/admin.json`:

```json
  "ride_assist": {
    "banner_title_single": "1 viaje esperando conductor",
    "banner_title_many": "{{count}} viajes esperando conductor",
    "banner_help": "Un pasajero pidió ayuda",
    "banner_sound_off": "Haz clic en cualquier parte del panel para activar el sonido de las alertas.",
    "banner_more": "y {{count}} más",
    "banner_assist": "Asistir",
    "chip_help": "Pidió ayuda",
    "chip_test": "Prueba",
    "chip_offers": "{{count}} ofertas activas",
    "assist_title": "Asistir viaje #{{code}}",
    "assist_breadcrumb": "Asistir",
    "assist_open": "Asistir",
    "waiting_for": "Esperando hace {{time}}",
    "not_searching": "El viaje ya no está buscando conductor (estado: {{status}}).",
    "see_ride": "Ver el viaje",
    "unavailable": "Esta función todavía no está disponible: falta aplicar la migración 00628.",
    "load_error": "No se pudo cargar el viaje.",
    "ride_card": "Viaje",
    "origin": "Origen",
    "destination": "Destino",
    "service": "Servicio",
    "passengers": "Pasajeros",
    "payment": "Pago",
    "rider": "Pasajero",
    "whatsapp": "WhatsApp",
    "call": "Llamar",
    "rider_whatsapp_text": "Hola, te escribe el soporte de TriciGo por tu viaje {{code}}.",
    "driver_whatsapp_text": "Hola, te escribe el soporte de TriciGo. ¿Puedes tomar un viaje con recogida en {{pickup}}?",
    "offers_card": "Ofertas enviadas",
    "offers_empty": "Ningún conductor recibió este viaje todavía.",
    "offer_status_pending": "Pendiente",
    "offer_status_accepted": "Aceptada",
    "offer_status_rejected": "Rechazada",
    "offer_status_expired": "Vencida",
    "offer_status_superseded": "Anulada",
    "expires_in": "vence en {{time}}",
    "candidates_card": "Conductores",
    "candidates_type": "Tipo de vehículo",
    "candidates_empty": "No hay conductores de este tipo conectados ni vistos en los últimos 7 días.",
    "candidates_other_type": "Son conductores de otro tipo: para enviarles el viaje, primero cambia el tipo del viaje más abajo.",
    "online": "En línea",
    "offline_seen": "Desconectado · visto hace {{time}}",
    "seen_never": "sin datos",
    "distance_km": "{{km}} km",
    "chip_busy": "En otro viaje",
    "chip_no_balance": "Sin saldo para la comisión",
    "send_offer": "Enviar oferta",
    "assign": "Asignar directo",
    "offer_created": "Oferta enviada a {{name}}. Le llega como cualquier viaje.",
    "offer_rearmed": "Oferta enviada de nuevo a {{name}}.",
    "offer_extended": "{{name}} ya tenía la oferta en pantalla: le dimos más tiempo. Llámalo para avisarle.",
    "assign_title": "Asignar el viaje a {{name}}",
    "assign_message": "El viaje pasa a ser de {{name}} sin que acepte en la app. Escribe por qué (por ejemplo: «lo hablé por WhatsApp»).",
    "assign_reason_placeholder": "Motivo (obligatorio)",
    "assign_confirm": "Asignar",
    "assigned": "Viaje asignado a {{name}}. Si no le aparece, que cierre la app y la vuelva a abrir.",
    "change_card": "Cambiar tipo de vehículo",
    "change_blocked": "No se puede cambiar el tipo de este viaje (corporativo, con paradas o envío).",
    "change_target": "Nuevo tipo",
    "change_quote": "Calcular precio",
    "change_quote_error": "No se pudo calcular el precio. Inténtalo de nuevo.",
    "change_price": "Precio nuevo: {{price}} (ahora: {{current}})",
    "change_shared_lost": "El viaje era compartido: con otro tipo pierde el descuento por compartir.",
    "change_propose": "Proponer al pasajero",
    "change_apply": "Aplicar (conformidad por WhatsApp)",
    "change_apply_title": "Cambiar a {{type}} por {{price}}",
    "change_apply_message": "Hazlo solo si el pasajero aceptó por WhatsApp. Escribe cómo lo aceptó.",
    "change_proposed": "Propuesta enviada. El pasajero la ve en la app si tiene la versión 1.7.4 o posterior; si no, escríbele por WhatsApp.",
    "change_applied": "Tipo cambiado. El viaje se ofrece ahora a conductores de {{type}}.",
    "proposal_pending": "Propuesta pendiente: {{type}} por {{price}} · vence en {{time}}",
    "proposal_expired": "La propuesta de {{type}} por {{price}} venció sin respuesta.",
    "proposal_accepted": "El pasajero aceptó {{type}} por {{price}}.",
    "proposal_rejected": "El pasajero rechazó {{type}} por {{price}}.",
    "proposal_superseded": "La propuesta de {{type}} quedó sin efecto.",
    "error_ride_not_searching": "El viaje ya no está buscando conductor.",
    "error_not_online": "El conductor no está en línea.",
    "error_stale_heartbeat": "La app del conductor no responde hace más de 3 minutos.",
    "error_busy": "El conductor ya está en otro viaje.",
    "error_insufficient_balance": "El conductor no tiene saldo para la comisión.",
    "error_wrong_vehicle_type": "El vehículo del conductor no sirve para este tipo de viaje.",
    "error_blocked": "El pasajero y el conductor se bloquearon.",
    "error_not_in_fleet": "El viaje es de una empresa con flota y el conductor no es de esa flota.",
    "error_driver_not_approved": "El conductor todavía no está aprobado.",
    "error_reason_required": "Escribe el motivo.",
    "error_fare_below_minimum": "El precio es menor que la tarifa mínima de ese tipo.",
    "error_fare_out_of_range": "El precio parece un error: es más de 5 veces el actual.",
    "error_too_many_passengers": "Ese vehículo no lleva tantos pasajeros.",
    "error_same_service_type": "El viaje ya es de ese tipo.",
    "error_service_type_unavailable": "Ese tipo de vehículo no está disponible.",
    "error_forbidden": "No tienes permiso para esto.",
    "error_generic": "No se pudo completar la acción."
  }
}
```

`en/admin.json` (same keys):

```json
  "ride_assist": {
    "banner_title_single": "1 ride waiting for a driver",
    "banner_title_many": "{{count}} rides waiting for a driver",
    "banner_help": "A rider asked for help",
    "banner_sound_off": "Click anywhere in the panel to turn on the alert sound.",
    "banner_more": "and {{count}} more",
    "banner_assist": "Assist",
    "chip_help": "Asked for help",
    "chip_test": "Test",
    "chip_offers": "{{count}} live offers",
    "assist_title": "Assist ride #{{code}}",
    "assist_breadcrumb": "Assist",
    "assist_open": "Assist",
    "waiting_for": "Waiting for {{time}}",
    "not_searching": "The ride is no longer looking for a driver (status: {{status}}).",
    "see_ride": "See the ride",
    "unavailable": "This feature is not available yet: migration 00628 has not been applied.",
    "load_error": "Could not load the ride.",
    "ride_card": "Ride",
    "origin": "Pickup",
    "destination": "Destination",
    "service": "Service",
    "passengers": "Passengers",
    "payment": "Payment",
    "rider": "Rider",
    "whatsapp": "WhatsApp",
    "call": "Call",
    "rider_whatsapp_text": "Hi, this is TriciGo support about your ride {{code}}.",
    "driver_whatsapp_text": "Hi, this is TriciGo support. Can you take a ride with pickup at {{pickup}}?",
    "offers_card": "Offers sent",
    "offers_empty": "No driver has received this ride yet.",
    "offer_status_pending": "Pending",
    "offer_status_accepted": "Accepted",
    "offer_status_rejected": "Rejected",
    "offer_status_expired": "Expired",
    "offer_status_superseded": "Voided",
    "expires_in": "expires in {{time}}",
    "candidates_card": "Drivers",
    "candidates_type": "Vehicle type",
    "candidates_empty": "No drivers of this type are online or were seen in the last 7 days.",
    "candidates_other_type": "These drivers are of another type: to send them the ride, first change the ride's type below.",
    "online": "Online",
    "offline_seen": "Offline · seen {{time}} ago",
    "seen_never": "no data",
    "distance_km": "{{km}} km",
    "chip_busy": "On another ride",
    "chip_no_balance": "No balance for the commission",
    "send_offer": "Send offer",
    "assign": "Assign directly",
    "offer_created": "Offer sent to {{name}}. It arrives like any ride.",
    "offer_rearmed": "Offer sent again to {{name}}.",
    "offer_extended": "{{name}} already had the offer on screen: it now lasts longer. Call to let them know.",
    "assign_title": "Assign the ride to {{name}}",
    "assign_message": "The ride becomes {{name}}'s without them accepting in the app. Write why (for example: \"agreed on WhatsApp\").",
    "assign_reason_placeholder": "Reason (required)",
    "assign_confirm": "Assign",
    "assigned": "Ride assigned to {{name}}. If it does not show up, they should close the app and open it again.",
    "change_card": "Change vehicle type",
    "change_blocked": "This ride's type cannot be changed (corporate, with stops, or a delivery).",
    "change_target": "New type",
    "change_quote": "Calculate price",
    "change_quote_error": "Could not calculate the price. Try again.",
    "change_price": "New price: {{price}} (now: {{current}})",
    "change_shared_lost": "The ride was shared: with another type it loses the shared-ride discount.",
    "change_propose": "Propose to the rider",
    "change_apply": "Apply (agreed on WhatsApp)",
    "change_apply_title": "Change to {{type}} for {{price}}",
    "change_apply_message": "Only if the rider agreed on WhatsApp. Write how they agreed.",
    "change_proposed": "Proposal sent. The rider sees it in the app on version 1.7.4 or later; otherwise, message them on WhatsApp.",
    "change_applied": "Type changed. The ride is now offered to {{type}} drivers.",
    "proposal_pending": "Pending proposal: {{type}} for {{price}} · expires in {{time}}",
    "proposal_expired": "The proposal of {{type}} for {{price}} expired without an answer.",
    "proposal_accepted": "The rider accepted {{type}} for {{price}}.",
    "proposal_rejected": "The rider rejected {{type}} for {{price}}.",
    "proposal_superseded": "The proposal of {{type}} was voided.",
    "error_ride_not_searching": "The ride is no longer looking for a driver.",
    "error_not_online": "The driver is not online.",
    "error_stale_heartbeat": "The driver's app has not responded for more than 3 minutes.",
    "error_busy": "The driver is already on another ride.",
    "error_insufficient_balance": "The driver does not have balance for the commission.",
    "error_wrong_vehicle_type": "The driver's vehicle cannot serve this kind of ride.",
    "error_blocked": "The rider and the driver have blocked each other.",
    "error_not_in_fleet": "The ride belongs to a company with a fleet and the driver is not in it.",
    "error_driver_not_approved": "The driver is not approved yet.",
    "error_reason_required": "Write the reason.",
    "error_fare_below_minimum": "The price is below that type's minimum fare.",
    "error_fare_out_of_range": "The price looks like a mistake: it is more than 5 times the current one.",
    "error_too_many_passengers": "That vehicle does not carry that many passengers.",
    "error_same_service_type": "The ride is already of that type.",
    "error_service_type_unavailable": "That vehicle type is not available.",
    "error_forbidden": "You do not have permission for this.",
    "error_generic": "The action could not be completed."
  }
}
```

`pt/admin.json` (same keys):

```json
  "ride_assist": {
    "banner_title_single": "1 viagem esperando motorista",
    "banner_title_many": "{{count}} viagens esperando motorista",
    "banner_help": "Um passageiro pediu ajuda",
    "banner_sound_off": "Clique em qualquer parte do painel para ativar o som dos alertas.",
    "banner_more": "e mais {{count}}",
    "banner_assist": "Assistir",
    "chip_help": "Pediu ajuda",
    "chip_test": "Teste",
    "chip_offers": "{{count}} ofertas ativas",
    "assist_title": "Assistir viagem #{{code}}",
    "assist_breadcrumb": "Assistir",
    "assist_open": "Assistir",
    "waiting_for": "Esperando há {{time}}",
    "not_searching": "A viagem não está mais procurando motorista (status: {{status}}).",
    "see_ride": "Ver a viagem",
    "unavailable": "Esta função ainda não está disponível: falta aplicar a migração 00628.",
    "load_error": "Não foi possível carregar a viagem.",
    "ride_card": "Viagem",
    "origin": "Origem",
    "destination": "Destino",
    "service": "Serviço",
    "passengers": "Passageiros",
    "payment": "Pagamento",
    "rider": "Passageiro",
    "whatsapp": "WhatsApp",
    "call": "Ligar",
    "rider_whatsapp_text": "Olá, aqui é o suporte da TriciGo sobre a sua viagem {{code}}.",
    "driver_whatsapp_text": "Olá, aqui é o suporte da TriciGo. Você pode fazer uma viagem com embarque em {{pickup}}?",
    "offers_card": "Ofertas enviadas",
    "offers_empty": "Nenhum motorista recebeu esta viagem ainda.",
    "offer_status_pending": "Pendente",
    "offer_status_accepted": "Aceita",
    "offer_status_rejected": "Recusada",
    "offer_status_expired": "Vencida",
    "offer_status_superseded": "Anulada",
    "expires_in": "vence em {{time}}",
    "candidates_card": "Motoristas",
    "candidates_type": "Tipo de veículo",
    "candidates_empty": "Não há motoristas deste tipo online nem vistos nos últimos 7 dias.",
    "candidates_other_type": "São motoristas de outro tipo: para enviar a viagem a eles, primeiro troque o tipo da viagem abaixo.",
    "online": "Online",
    "offline_seen": "Offline · visto há {{time}}",
    "seen_never": "sem dados",
    "distance_km": "{{km}} km",
    "chip_busy": "Em outra viagem",
    "chip_no_balance": "Sem saldo para a comissão",
    "send_offer": "Enviar oferta",
    "assign": "Atribuir direto",
    "offer_created": "Oferta enviada para {{name}}. Chega como qualquer viagem.",
    "offer_rearmed": "Oferta enviada de novo para {{name}}.",
    "offer_extended": "{{name}} já tinha a oferta na tela: ela agora dura mais. Ligue para avisar.",
    "assign_title": "Atribuir a viagem a {{name}}",
    "assign_message": "A viagem passa a ser de {{name}} sem aceitar no app. Escreva o motivo (por exemplo: «combinado pelo WhatsApp»).",
    "assign_reason_placeholder": "Motivo (obrigatório)",
    "assign_confirm": "Atribuir",
    "assigned": "Viagem atribuída a {{name}}. Se não aparecer, peça para fechar o app e abrir de novo.",
    "change_card": "Trocar tipo de veículo",
    "change_blocked": "Não é possível trocar o tipo desta viagem (corporativa, com paradas ou entrega).",
    "change_target": "Novo tipo",
    "change_quote": "Calcular preço",
    "change_quote_error": "Não foi possível calcular o preço. Tente de novo.",
    "change_price": "Preço novo: {{price}} (agora: {{current}})",
    "change_shared_lost": "A viagem era compartilhada: com outro tipo perde o desconto de compartilhar.",
    "change_propose": "Propor ao passageiro",
    "change_apply": "Aplicar (aceito pelo WhatsApp)",
    "change_apply_title": "Trocar para {{type}} por {{price}}",
    "change_apply_message": "Só se o passageiro aceitou pelo WhatsApp. Escreva como aceitou.",
    "change_proposed": "Proposta enviada. O passageiro a vê no app na versão 1.7.4 ou posterior; se não, escreva pelo WhatsApp.",
    "change_applied": "Tipo trocado. A viagem agora é oferecida a motoristas de {{type}}.",
    "proposal_pending": "Proposta pendente: {{type}} por {{price}} · vence em {{time}}",
    "proposal_expired": "A proposta de {{type}} por {{price}} venceu sem resposta.",
    "proposal_accepted": "O passageiro aceitou {{type}} por {{price}}.",
    "proposal_rejected": "O passageiro recusou {{type}} por {{price}}.",
    "proposal_superseded": "A proposta de {{type}} ficou sem efeito.",
    "error_ride_not_searching": "A viagem não está mais procurando motorista.",
    "error_not_online": "O motorista não está online.",
    "error_stale_heartbeat": "O app do motorista não responde há mais de 3 minutos.",
    "error_busy": "O motorista já está em outra viagem.",
    "error_insufficient_balance": "O motorista não tem saldo para a comissão.",
    "error_wrong_vehicle_type": "O veículo do motorista não serve para este tipo de viagem.",
    "error_blocked": "O passageiro e o motorista se bloquearam.",
    "error_not_in_fleet": "A viagem é de uma empresa com frota e o motorista não é dessa frota.",
    "error_driver_not_approved": "O motorista ainda não foi aprovado.",
    "error_reason_required": "Escreva o motivo.",
    "error_fare_below_minimum": "O preço é menor que a tarifa mínima desse tipo.",
    "error_fare_out_of_range": "O preço parece um erro: é mais de 5 vezes o atual.",
    "error_too_many_passengers": "Esse veículo não leva tantos passageiros.",
    "error_same_service_type": "A viagem já é desse tipo.",
    "error_service_type_unavailable": "Esse tipo de veículo não está disponível.",
    "error_forbidden": "Você não tem permissão para isso.",
    "error_generic": "Não foi possível concluir a ação."
  }
}
```

- [ ] **Step 2: Add the settings' labels and help text**

In each `admin.json`, after the line `"driver_whatsapp_group_url_help": …,` of the `platform_config` section, insert:

`es`:
```json
    "support_alert_enabled": "Avisos de viajes sin conductor",
    "support_alert_enabled_help": "true/false — avisa al soporte (push y correo) cuando un viaje lleva buscando conductor más del tiempo configurado abajo. El botón «Pedir ayuda» del pasajero avisa siempre.",
    "support_alert_after_s": "Aviso al soporte después de (segundos)",
    "support_alert_after_s_help": "Segundos de búsqueda sin conductor tras los que el viaje entra en el aviso del panel y se manda el push y el correo al soporte (por defecto 60).",
    "support_offer_ttl_s": "Duración de la oferta del soporte (segundos)",
    "support_offer_ttl_s_help": "Cuánto le dura al conductor una oferta enviada desde «Asistir» (por defecto 120; las del despacho automático duran offer_ttl_seconds).",
    "support_proposal_ttl_s": "Duración de la propuesta de cambio de tipo (segundos)",
    "support_proposal_ttl_s_help": "Cuánto tiempo ve el pasajero la propuesta de otro tipo de vehículo antes de que venza (por defecto 180).",
    "support_alert_email": "Correos del aviso al soporte",
    "support_alert_email_help": "Direcciones separadas por coma que reciben el aviso de viajes sin conductor y de pasajeros que piden ayuda. Vacío = sin correo (el push y el aviso del panel siguen).",
```

`en`:
```json
    "support_alert_enabled": "Alerts for rides without a driver",
    "support_alert_enabled_help": "true/false — alerts support (push and e-mail) when a ride has been looking for a driver longer than the time set below. The rider's \"Pedir ayuda\" button always alerts.",
    "support_alert_after_s": "Alert support after (seconds)",
    "support_alert_after_s_help": "Seconds without a driver after which the ride appears in the panel's alert and support gets the push and the e-mail (default 60).",
    "support_offer_ttl_s": "Support offer duration (seconds)",
    "support_offer_ttl_s_help": "How long an offer sent from \"Assist\" lasts for the driver (default 120; automatic dispatch offers last offer_ttl_seconds).",
    "support_proposal_ttl_s": "Vehicle type proposal duration (seconds)",
    "support_proposal_ttl_s_help": "How long the rider sees the proposal of another vehicle type before it expires (default 180).",
    "support_alert_email": "Support alert e-mails",
    "support_alert_email_help": "Comma-separated addresses that receive the alerts about rides without a driver and riders asking for help. Empty = no e-mail (the push and the panel alert stay).",
```

`pt`:
```json
    "support_alert_enabled": "Alertas de viagens sem motorista",
    "support_alert_enabled_help": "true/false — avisa o suporte (push e e-mail) quando uma viagem está procurando motorista há mais tempo que o configurado abaixo. O botão «Pedir ayuda» do passageiro sempre avisa.",
    "support_alert_after_s": "Avisar o suporte depois de (segundos)",
    "support_alert_after_s_help": "Segundos sem motorista depois dos quais a viagem entra no alerta do painel e o suporte recebe o push e o e-mail (padrão 60).",
    "support_offer_ttl_s": "Duração da oferta do suporte (segundos)",
    "support_offer_ttl_s_help": "Quanto dura para o motorista uma oferta enviada de «Assistir» (padrão 120; as do despacho automático duram offer_ttl_seconds).",
    "support_proposal_ttl_s": "Duração da proposta de troca de tipo (segundos)",
    "support_proposal_ttl_s_help": "Por quanto tempo o passageiro vê a proposta de outro tipo de veículo antes de vencer (padrão 180).",
    "support_alert_email": "E-mails do alerta ao suporte",
    "support_alert_email_help": "Endereços separados por vírgula que recebem o alerta de viagens sem motorista e de passageiros pedindo ajuda. Vazio = sem e-mail (o push e o alerta do painel continuam).",
```

- [ ] **Step 3: Say the rides search also takes a code**

In each `admin.json`, inside `rides` (line 388), change `search_address_placeholder`:
- `es`: `"Buscar por dirección o código del viaje…"`
- `en`: `"Search by address or ride code…"`
- `pt`: `"Buscar por endereço ou código da viagem…"`

and in `apps/admin/src/app/rides/page.tsx:315` change the `defaultValue` to `'Buscar por dirección o código del viaje…'`.

- [ ] **Step 4: Register the five settings**

In `apps/admin/src/app/settings/platform-config/page.tsx`, before the closing `};` of `KNOWN_KEYS` (line 142):

```ts

  // ── Soporte: viajes sin conductor (00628) ──
  support_alert_enabled: { type: 'select', helpKey: 'platform_config.support_alert_enabled_help', options: [{ label: 'true', value: 'true' }, { label: 'false', value: 'false' }] },
  support_alert_after_s: { type: 'number', helpKey: 'platform_config.support_alert_after_s_help' },
  support_offer_ttl_s: { type: 'number', helpKey: 'platform_config.support_offer_ttl_s_help' },
  support_proposal_ttl_s: { type: 'number', helpKey: 'platform_config.support_proposal_ttl_s_help' },
  support_alert_email: { type: 'text', helpKey: 'platform_config.support_alert_email_help' },
```

- [ ] **Step 5: Check JSON and parity**

```bash
for l in es en pt; do node -e "JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/$l/admin.json','utf8'))" && echo "$l ok"; done
pnpm check:i18n
```

Expected: `es ok`, `en ok`, `pt ok`, and the parity check passes.

- [ ] **Step 6: Commit**

```bash
git add packages/i18n/src/locales/*/admin.json apps/admin/src/app/settings/platform-config/page.tsx apps/admin/src/app/rides/page.tsx
git commit -m "feat(admin): copy and settings for support-assisted matching"
```

### Task 13: The waiting-rides banner, with sound, on every page

**Files:**
- Create: `apps/admin/src/lib/chime.ts`
- Create: `apps/admin/src/components/support/supportFormat.ts`
- Create: `apps/admin/src/hooks/useSupportWaitingRides.ts`
- Create: `apps/admin/src/components/support/SupportWaitingBanner.tsx`
- Modify: `apps/admin/src/components/layout/AdminShell.tsx:3-12`, `:75-76`

- [ ] **Step 1: Write `apps/admin/src/lib/chime.ts`**

```ts
/**
 * The support alert sound: two short tones made with Web Audio, so there is no asset to ship.
 * Browsers keep audio locked until the user interacts with the page: the banner calls
 * unlockChime() on the first pointer press anywhere. Until then playChime() is silent and
 * chimeReady() is false, which the banner tells the user.
 */
let ctx: AudioContext | null = null;

function audioContextClass(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function unlockChime(): void {
  const Ctor = audioContextClass();
  if (!Ctor) return;
  try {
    ctx = ctx ?? new Ctor();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

export function chimeReady(): boolean {
  return ctx?.state === 'running';
}

export function playChime(): void {
  const c = ctx;
  if (!c || c.state !== 'running') return;
  const now = c.currentTime;
  [880, 1320].forEach((freq, i) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    const start = now + i * 0.22;
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
    osc.connect(gain).connect(c.destination);
    osc.start(start);
    osc.stop(start + 0.21);
  });
}
```

- [ ] **Step 2: Write `apps/admin/src/components/support/supportFormat.ts`**

The banner and the assist page (Task 14) share it.

```ts
/** Elapsed time as support reads it on the banner: "45s", "2:05", "14:30". */
export function waitLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
}
```

- [ ] **Step 3: Write `apps/admin/src/hooks/useSupportWaitingRides.ts`**

```ts
/**
 * useSupportWaitingRides — the rides waiting for support (admin_support_waiting_rides, 00628),
 * polled every 15 s. Plays the chime when a ride the panel had not seen enters the list, and
 * again when its rider asks for help. Polling rather than Realtime, like useStuckRideAlerts
 * (BUG-277). A failed poll keeps the last list.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { rideAssistService, type SupportWaitingRide } from '@tricigo/api';
import { playChime } from '@/lib/chime';

export function useSupportWaitingRides(pollMs = 15_000) {
  const [rides, setRides] = useState<SupportWaitingRide[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await rideAssistService.getWaitingRides();
      if (!mountedRef.current) return;
      const keys = next.map((r) => `${r.ride_id}:${r.help_requested_at ? 'help' : 'wait'}`);
      const isNew = keys.some((k) => !seenRef.current.has(k));
      seenRef.current = new Set(keys);
      setRides(next);
      if (isNew) playChime();
    } catch {
      // Keep what is shown; the next poll retries.
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const id = setInterval(load, pollMs);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [load, pollMs]);

  return { rides, refresh: load };
}
```

- [ ] **Step 4: Write `apps/admin/src/components/support/SupportWaitingBanner.tsx`**

```tsx
/**
 * SupportWaitingBanner — rides waiting for support, on every page (mounted in AdminShell).
 * Red when a rider asked for help, amber otherwise. Each row opens /rides/[id]/assist.
 */
'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight, LifeBuoy, VolumeX } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { formatCUP } from '@tricigo/utils';
import { useSupportWaitingRides } from '@/hooks/useSupportWaitingRides';
import { chimeReady, unlockChime } from '@/lib/chime';
import { waitLabel } from './supportFormat';

export function SupportWaitingBanner() {
  const { t } = useTranslation('admin');
  const { rides } = useSupportWaitingRides();
  const [soundOn, setSoundOn] = useState(false);

  // Any click on the panel unlocks the audio the browser keeps locked until then.
  useEffect(() => {
    const unlock = () => {
      unlockChime();
      setTimeout(() => setSoundOn(chimeReady()), 100);
    };
    window.addEventListener('pointerdown', unlock);
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  if (rides.length === 0) return null;
  const help = rides.some((r) => r.help_requested_at);
  const shown = rides.slice(0, 5);

  return (
    <div
      role="alert"
      className={`border-b px-4 py-2.5 text-white md:px-6 ${help ? 'border-red-700 bg-red-600' : 'border-amber-700 bg-amber-600'}`}
    >
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <LifeBuoy className="h-4 w-4 shrink-0" strokeWidth={2.4} />
          <p className="font-display text-[13px] font-bold uppercase tracking-wide">
            {help
              ? t('ride_assist.banner_help', { defaultValue: 'Un pasajero pidió ayuda' })
              : rides.length === 1
                ? t('ride_assist.banner_title_single', { defaultValue: '1 viaje esperando conductor' })
                : t('ride_assist.banner_title_many', { count: rides.length, defaultValue: '{{count}} viajes esperando conductor' })}
          </p>
          {!soundOn && (
            <span className="inline-flex items-center gap-1 text-[11.5px] text-white/85">
              <VolumeX className="h-3.5 w-3.5" />
              {t('ride_assist.banner_sound_off', { defaultValue: 'Haz clic en cualquier parte del panel para activar el sonido de las alertas.' })}
            </span>
          )}
        </div>
        <ul className="flex flex-col gap-1">
          {shown.map((r) => (
            <li key={r.ride_id}>
              <Link
                href={`/rides/${r.ride_id}/assist`}
                className="group flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg px-2 py-1 text-[12.5px] transition-colors hover:bg-black/15"
              >
                <span className="font-mono font-semibold">#{r.code}</span>
                <span className="tabular-nums">{waitLabel(r.wait_s)}</span>
                <span className="min-w-0 truncate">{r.pickup_address} → {r.dropoff_address}</span>
                <span className="whitespace-nowrap">{r.service_type} · {formatCUP(r.estimated_fare_cup)}</span>
                {r.help_requested_at && (
                  <span className="rounded-full bg-white/25 px-2 py-0.5 text-[10.5px] font-semibold uppercase">
                    {t('ride_assist.chip_help', { defaultValue: 'Pidió ayuda' })}
                  </span>
                )}
                {r.is_test && (
                  <span className="rounded-full bg-black/20 px-2 py-0.5 text-[10.5px] font-semibold uppercase">
                    {t('ride_assist.chip_test', { defaultValue: 'Prueba' })}
                  </span>
                )}
                {r.pending_offers > 0 && (
                  <span className="text-[11px] text-white/85">
                    {t('ride_assist.chip_offers', { count: r.pending_offers, defaultValue: '{{count}} ofertas activas' })}
                  </span>
                )}
                <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold uppercase">
                  {t('ride_assist.banner_assist', { defaultValue: 'Asistir' })}
                  <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {rides.length > shown.length && (
          <p className="px-2 text-[11.5px] text-white/85">
            {t('ride_assist.banner_more', { count: rides.length - shown.length, defaultValue: 'y {{count}} más' })}
          </p>
        )}
      </div>
    </div>
  );
}
```

`formatCUP` takes the CUP amount the rest of the admin passes it (`apps/admin/src/app/rides/[id]/page.tsx:190` passes `estimated_fare_cup` directly).

- [ ] **Step 5: Mount it in the shell**

In `apps/admin/src/components/layout/AdminShell.tsx`, add the import after line 12:

```ts
import { SupportWaitingBanner } from '@/components/support/SupportWaitingBanner';
```

and render it between `<Header />` and `<main …>` (lines 75-76), so it stays visible while the page scrolls:

```tsx
              <Header />
              <SupportWaitingBanner />
              <main
```

- [ ] **Step 6: Type check and lint**

```bash
pnpm --filter @tricigo/admin check-types
cd apps/admin && npx eslint src/lib/chime.ts src/hooks/useSupportWaitingRides.ts src/components/support/supportFormat.ts src/components/support/SupportWaitingBanner.tsx src/components/layout/AdminShell.tsx --config ../../tools/lint-rules.config.mjs; cd ../..
```

Expected: no errors, and no new warnings in these files.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/lib/chime.ts apps/admin/src/hooks/useSupportWaitingRides.ts apps/admin/src/components/support/supportFormat.ts \
  apps/admin/src/components/support/SupportWaitingBanner.tsx apps/admin/src/components/layout/AdminShell.tsx
git commit -m "feat(admin): banner with sound for rides waiting for support, on every page"
```

### Task 14: The assist page `/rides/[id]/assist`

Everything support does on a waiting ride, on one page: the ride and the rider (with WhatsApp and call links), the offers already sent, the candidate drivers with "Enviar oferta" and "Asignar directo", and "Cambiar tipo". The ride is re-read every 10 s and the candidates every 20 s, so the page follows what drivers and the rider do.

The price for another type comes from `rideService.getLocalFareEstimate` with the Task 9 options. One difference with the rider app is expected: the admin build has no Mapbox token (`deploy-admin.yml` never passes `NEXT_PUBLIC_MAPBOX_TOKEN`, see `apps/admin/src/components/AdminAddressSearch.tsx:13-18`), so the route comes from the public OSRM server while the rider app uses Mapbox, and the distance can differ by a few percent. That is not a money problem: the rider sees the exact price on the card (or hears it on WhatsApp) before consenting, and that price is the one written to the snapshot and charged.

**Files:**
- Modify: `apps/admin/src/components/support/supportFormat.ts`
- Create: `apps/admin/src/components/support/assistErrors.ts`
- Create: `apps/admin/src/components/support/AssistCandidates.tsx`
- Create: `apps/admin/src/components/support/AssistServiceChange.tsx`
- Create: `apps/admin/src/app/rides/[id]/assist/page.tsx`

- [ ] **Step 1: Add `agoLabel` to `supportFormat.ts`**

Append to `apps/admin/src/components/support/supportFormat.ts`:

```ts
/** How long ago, in units every admin locale reads: "3 min", "5 h", "2 d". */
export function agoLabel(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86_400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} d`;
}

/** tel: link for a stored phone (E.164), or null when there is nothing to dial. */
export function telLink(phone: string | null | undefined): string | null {
  const p = (phone ?? '').replace(/[^\d+]/g, '');
  return p.replace(/\D/g, '').length >= 8 ? `tel:${p}` : null;
}
```

WhatsApp links use `waMeLink` from `@tricigo/utils` (`packages/utils/src/driverOutreach.ts:50`), which the incomplete-drivers page already uses.

- [ ] **Step 2: Write `apps/admin/src/components/support/assistErrors.ts`**

```ts
/**
 * The admin.json key for a failed support action (`ride_assist.error_<code>`).
 * rideAssistService throws the server's refusal as an AppError whose `code` is the refusal;
 * a function that raises instead (admin_ride_assist_candidates, admin_support_waiting_rides)
 * comes back as a Postgres error, 42501 when the caller is not an admin.
 */
const CODES = new Set([
  'ride_not_searching',
  'not_online',
  'stale_heartbeat',
  'busy',
  'insufficient_balance',
  'wrong_vehicle_type',
  'blocked',
  'not_in_fleet',
  'driver_not_approved',
  'reason_required',
  'fare_below_minimum',
  'fare_out_of_range',
  'too_many_passengers',
  'same_service_type',
  'service_type_unavailable',
  'forbidden',
]);

export function assistErrorKey(err: unknown): string {
  const raw = (err as { code?: unknown } | null)?.code;
  const code = raw === '42501' ? 'forbidden' : raw;
  return typeof code === 'string' && CODES.has(code) ? `ride_assist.error_${code}` : 'ride_assist.error_generic';
}
```

Every key it returns exists in the three `admin.json` files (Task 12). The other refusals (`cargo_not_supported`, `corporate_not_supported`, `waypoints_not_supported`) cannot happen from this page, which hides "Cambiar tipo" on those rides, and the rest (`ride_not_found`, `driver_not_found`, `invalid_mode`, `snapshot_failed`, `service_config_missing`) are bugs, shown as the generic message.

- [ ] **Step 3: Write `apps/admin/src/components/support/AssistCandidates.tsx`**

```tsx
'use client';

/**
 * The drivers support can send a waiting ride to (admin_ride_assist_candidates, 00628):
 * online first, then by distance to the pickup. "Enviar oferta" puts the ride on the driver's
 * screen like any offer; "Asignar directo" gives it to them at once, with a reason.
 * Support can also look at drivers of another type, to call them before changing the ride's
 * type; the actions stay off until the ride is of their type.
 */

import { useCallback, useEffect, useState } from 'react';
import { MessageCircle, Phone } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { rideAssistService, type AssistCandidate, type RideOfferStatus } from '@tricigo/api';
import { waMeLink } from '@tricigo/utils';
import { useToast } from '@/components/ui/AdminToast';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';
import { assistErrorKey } from './assistErrors';
import { agoLabel, telLink } from './supportFormat';

export interface ServiceTypeOption {
  slug: string;
  name: string;
}

interface Props {
  rideId: string;
  rideServiceType: string;
  pickupAddress: string;
  typeOptions: ServiceTypeOption[];
  onChanged: () => void;
}

const CHIP = 'rounded-full px-2 py-0.5 text-xs font-semibold';
const LINK_BTN =
  'inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-sunken';

export function AssistCandidates({ rideId, rideServiceType, pickupAddress, typeOptions, onChanged }: Props) {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [serviceType, setServiceType] = useState(rideServiceType);
  const [rows, setRows] = useState<AssistCandidate[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [assignTo, setAssignTo] = useState<AssistCandidate | null>(null);
  const [reason, setReason] = useState('');

  // When the ride's type changes (support applied it, or the rider accepted), the list follows.
  useEffect(() => {
    setServiceType(rideServiceType);
  }, [rideServiceType]);

  const otherType = serviceType !== rideServiceType;
  const options = typeOptions.some((o) => o.slug === rideServiceType)
    ? typeOptions
    : [{ slug: rideServiceType, name: rideServiceType }, ...typeOptions];

  const load = useCallback(async () => {
    try {
      const next = await rideAssistService.getCandidates(
        rideId,
        serviceType === rideServiceType ? undefined : serviceType,
      );
      setRows(next);
      setLoadFailed(false);
      setNow(Date.now());
    } catch {
      setLoadFailed(true);
    }
  }, [rideId, serviceType, rideServiceType]);

  useEffect(() => {
    void load();
    const id = setInterval(load, 20_000);
    return () => clearInterval(id);
  }, [load]);

  // Stable, so the modal does not re-run its focus effect on every parent render.
  const closeAssign = useCallback(() => setAssignTo(null), []);

  const offer = async (c: AssistCandidate) => {
    setBusyId(c.driver_profile_id);
    try {
      const r = await rideAssistService.offerToDriver(rideId, c.driver_profile_id);
      const key =
        r.mode === 'created'
          ? 'ride_assist.offer_created'
          : r.mode === 'extended'
            ? 'ride_assist.offer_extended'
            : 'ride_assist.offer_rearmed';
      showToast('success', t(key, { name: c.full_name }));
      onChanged();
      void load();
    } catch (err) {
      showToast('error', t(assistErrorKey(err)));
      onChanged(); // the ride may have been taken or canceled meanwhile: show what it is now
    } finally {
      setBusyId(null);
    }
  };

  const confirmAssign = async () => {
    if (!assignTo) return;
    const why = reason.trim();
    if (!why) {
      showToast('error', t('ride_assist.error_reason_required'));
      return;
    }
    try {
      await rideAssistService.assignToDriver(rideId, assignTo.driver_profile_id, why);
      showToast('success', t('ride_assist.assigned', { name: assignTo.full_name }));
      setAssignTo(null);
      setReason('');
      onChanged();
    } catch (err) {
      showToast('error', t(assistErrorKey(err)));
      onChanged();
    }
  };

  return (
    <section className="mb-6 rounded-xl border border-line bg-surface-elevated p-6 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold">{t('ride_assist.candidates_card')}</h2>
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          {t('ride_assist.candidates_type')}
          <select
            value={serviceType}
            onChange={(e) => setServiceType(e.target.value)}
            className="rounded-lg border border-line bg-surface px-2 py-1 text-sm text-ink"
          >
            {options.map((o) => (
              <option key={o.slug} value={o.slug}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {otherType && (
        <p className="mb-3 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-400">
          {t('ride_assist.candidates_other_type')}
        </p>
      )}
      {loadFailed && <p className="mb-3 text-sm text-red-700 dark:text-red-400">{t('ride_assist.load_error')}</p>}
      {rows !== null && rows.length === 0 && !loadFailed && (
        <p className="text-sm text-ink-muted">{t('ride_assist.candidates_empty')}</p>
      )}

      {rows !== null && rows.length > 0 && (
        <ul className="divide-y divide-line">
          {rows.map((c) => {
            const wa = waMeLink(c.phone, t('ride_assist.driver_whatsapp_text', { pickup: pickupAddress }));
            const tel = telLink(c.phone);
            const offerLapsed =
              c.offer_status === 'pending' && c.offer_expires_at !== null && new Date(c.offer_expires_at).getTime() <= now;
            const offerShown: RideOfferStatus | null = offerLapsed ? 'expired' : c.offer_status;
            const canAct = !otherType && busyId === null;
            return (
              <li key={c.driver_profile_id} className="flex flex-col gap-2 py-3 md:flex-row md:items-center">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink">{c.full_name}</p>
                  <p className="truncate text-xs text-ink-muted">{c.vehicle_label}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {c.is_online ? (
                      <span className={`${CHIP} bg-green-500/10 text-green-700 dark:text-green-400`}>
                        {t('ride_assist.online')}
                      </span>
                    ) : (
                      <span className={`${CHIP} bg-surface-sunken text-ink-muted`}>
                        {c.last_heartbeat_at
                          ? t('ride_assist.offline_seen', { time: agoLabel(c.last_heartbeat_at, now) })
                          : t('ride_assist.seen_never')}
                      </span>
                    )}
                    {c.distance_m !== null && (
                      <span className="text-xs text-ink-muted">
                        {t('ride_assist.distance_km', { km: (c.distance_m / 1000).toFixed(1) })}
                      </span>
                    )}
                    {c.busy_ride_id && (
                      <span className={`${CHIP} bg-amber-500/10 text-amber-800 dark:text-amber-400`}>
                        {t('ride_assist.chip_busy')}
                      </span>
                    )}
                    {!c.can_afford && (
                      <span className={`${CHIP} bg-red-500/10 text-red-700 dark:text-red-400`}>
                        {t('ride_assist.chip_no_balance')}
                      </span>
                    )}
                    {offerShown && (
                      <span className={`${CHIP} bg-surface-sunken text-ink-muted`}>
                        {t(`ride_assist.offer_status_${offerShown}`)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {wa && (
                    <a href={wa} target="_blank" rel="noopener noreferrer" className={LINK_BTN}>
                      <MessageCircle className="h-3.5 w-3.5" />
                      {t('ride_assist.whatsapp')}
                    </a>
                  )}
                  {tel && (
                    <a href={tel} className={LINK_BTN}>
                      <Phone className="h-3.5 w-3.5" />
                      {t('ride_assist.call')}
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => void offer(c)}
                    disabled={!canAct}
                    className="rounded-lg bg-primary-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t('ride_assist.send_offer')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setReason('');
                      setAssignTo(c);
                    }}
                    disabled={!canAct || !c.is_online || c.busy_ride_id !== null}
                    className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t('ride_assist.assign')}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <AdminConfirmModal
        open={assignTo !== null}
        title={t('ride_assist.assign_title', { name: assignTo?.full_name ?? '' })}
        message={t('ride_assist.assign_message', { name: assignTo?.full_name ?? '' })}
        confirmLabel={t('ride_assist.assign_confirm')}
        cancelLabel={t('common.cancel')}
        variant="warning"
        onConfirm={confirmAssign}
        onCancel={closeAssign}
        inputValue={reason}
        onInputChange={setReason}
        inputPlaceholder={t('ride_assist.assign_reason_placeholder')}
      />
    </section>
  );
}
```

`closeAssign` must stay a `useCallback`: `AdminConfirmModal` re-runs its effect (which moves the focus to Cancel) whenever `onCancel` changes, and the page re-renders every second for its countdowns. An inline arrow would pull the focus out of the reason field every second.

- [ ] **Step 4: Write `apps/admin/src/components/support/AssistServiceChange.tsx`**

```tsx
'use client';

/**
 * Switch a waiting ride to another vehicle type (00628). The price is quoted here with the
 * code the rider app uses (rideService.getLocalFareEstimate), on Havana time and for the
 * rider. Support then proposes it to the rider in the app, or applies it with the rider's
 * WhatsApp consent. The admin has no Mapbox token, so the route comes from OSRM: the price
 * can differ a little from what the rider app would show, and the rider consents to this one.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { rideAssistService, rideService, type RideAssistContext } from '@tricigo/api';
import type { ServiceTypeConfig, ServiceTypeSlug } from '@tricigo/types';
import { formatCUP } from '@tricigo/utils';
import { useToast } from '@/components/ui/AdminToast';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';
import { assistErrorKey } from './assistErrors';

interface Props {
  ride: RideAssistContext['ride'];
  configs: ServiceTypeConfig[];
  /** The latest proposal's state, already worded by the page, or null. */
  proposalLine: string | null;
  onChanged: () => void;
}

export function AssistServiceChange({ ride, configs, proposalLine, onChanged }: Props) {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [target, setTarget] = useState<ServiceTypeSlug | ''>('');
  const [quote, setQuote] = useState<number | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [reason, setReason] = useState('');

  // The ride's type changed (applied here, or the rider accepted): start over.
  useEffect(() => {
    setTarget('');
    setQuote(null);
  }, [ride.service_type]);

  // The same refusals as _ride_service_change_error, so support is not offered a dead end.
  const blocked = ride.ride_mode === 'cargo' || ride.is_corporate || ride.has_waypoints;
  const targets = useMemo(
    () =>
      configs.filter(
        (c) =>
          c.is_active &&
          c.slug !== 'mensajeria' &&
          c.slug !== ride.service_type &&
          (c.max_passengers <= 0 || ride.passenger_count <= c.max_passengers),
      ),
    [configs, ride.service_type, ride.passenger_count],
  );
  const targetName = configs.find((c) => c.slug === target)?.name_es ?? target;
  const closeApply = useCallback(() => setApplyOpen(false), []);

  const calculate = async () => {
    if (!target) return;
    setQuoting(true);
    setQuote(null);
    try {
      const estimate = await rideService.getLocalFareEstimate({
        service_type: target,
        pickup_lat: ride.pickup_lat,
        pickup_lng: ride.pickup_lng,
        dropoff_lat: ride.dropoff_lat,
        dropoff_lng: ride.dropoff_lng,
        for_user_id: ride.customer_id,
        time_zone: 'America/Havana',
      });
      setQuote(estimate.estimated_fare_cup);
    } catch {
      showToast('error', t('ride_assist.change_quote_error'));
    } finally {
      setQuoting(false);
    }
  };

  const propose = async () => {
    if (!target || quote === null) return;
    setProposing(true);
    try {
      await rideAssistService.changeServiceType(ride.id, target, quote, 'propose');
      showToast('success', t('ride_assist.change_proposed'));
      onChanged();
    } catch (err) {
      showToast('error', t(assistErrorKey(err)));
      onChanged();
    } finally {
      setProposing(false);
    }
  };

  const apply = async () => {
    if (!target || quote === null) return;
    const why = reason.trim();
    if (!why) {
      showToast('error', t('ride_assist.error_reason_required'));
      return;
    }
    try {
      await rideAssistService.changeServiceType(ride.id, target, quote, 'apply', why);
      showToast('success', t('ride_assist.change_applied', { type: targetName }));
      setApplyOpen(false);
      setReason('');
      onChanged();
    } catch (err) {
      showToast('error', t(assistErrorKey(err)));
      onChanged();
    }
  };

  return (
    <section className="mb-6 rounded-xl border border-line bg-surface-elevated p-6 shadow-sm">
      <h2 className="mb-4 text-lg font-bold">{t('ride_assist.change_card')}</h2>
      {proposalLine && <p className="mb-4 rounded-lg bg-surface-sunken px-3 py-2 text-sm text-ink">{proposalLine}</p>}

      {blocked ? (
        <p className="text-sm text-ink-muted">{t('ride_assist.change_blocked')}</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-ink-muted">
              {t('ride_assist.change_target')}
              <select
                value={target}
                onChange={(e) => {
                  setTarget(e.target.value as ServiceTypeSlug | '');
                  setQuote(null);
                }}
                className="rounded-lg border border-line bg-surface px-2 py-1 text-sm text-ink"
              >
                <option value="">—</option>
                {targets.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.name_es}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => void calculate()}
              disabled={!target || quoting}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('ride_assist.change_quote')}
            </button>
          </div>

          {quote !== null && (
            <>
              <p className="text-sm font-medium text-ink">
                {t('ride_assist.change_price', {
                  price: formatCUP(quote),
                  current: formatCUP(ride.estimated_fare_cup),
                })}
              </p>
              {ride.shared_ride && target !== 'triciclo_basico' && (
                <p className="text-sm text-amber-800 dark:text-amber-400">{t('ride_assist.change_shared_lost')}</p>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void propose()}
                  disabled={proposing}
                  className="rounded-lg bg-primary-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t('ride_assist.change_propose')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setReason('');
                    setApplyOpen(true);
                  }}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm font-semibold text-ink hover:bg-surface-sunken"
                >
                  {t('ride_assist.change_apply')}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <AdminConfirmModal
        open={applyOpen}
        title={t('ride_assist.change_apply_title', {
          type: targetName,
          price: quote !== null ? formatCUP(quote) : '',
        })}
        message={t('ride_assist.change_apply_message')}
        confirmLabel={t('ride_assist.change_apply')}
        cancelLabel={t('common.cancel')}
        variant="warning"
        onConfirm={apply}
        onCancel={closeApply}
        inputValue={reason}
        onInputChange={setReason}
        inputPlaceholder={t('ride_assist.assign_reason_placeholder')}
      />
    </section>
  );
}
```

In prod on 2026-10-07 the active types were `auto_confort` (4 passengers), `auto_standard` (4), `mensajeria` (0), `moto_standard` (1) and `triciclo_basico` (4); `triciclo_premium` was inactive. The `targets` filter therefore offers exactly what the server accepts.

- [ ] **Step 5: Write `apps/admin/src/app/rides/[id]/assist/page.tsx`**

```tsx
'use client';

/**
 * /rides/[id]/assist — support helps a waiting ride find a driver (00628): send it to a
 * chosen driver, assign it directly, or switch its vehicle type with the rider's consent.
 * The ride is re-read every 10 s; the candidates refresh on their own every 20 s.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { MessageCircle, Phone } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import {
  adminService,
  rideAssistService,
  RIDE_ASSIST_UNAVAILABLE,
  type RideAssistContext,
  type RideOfferStatus,
} from '@tricigo/api';
import type { ServiceTypeConfig } from '@tricigo/types';
import { formatCUP, waMeLink } from '@tricigo/utils';
import { AdminBreadcrumb } from '@/components/ui/AdminBreadcrumb';
import { AssistCandidates } from '@/components/support/AssistCandidates';
import { AssistServiceChange } from '@/components/support/AssistServiceChange';
import { telLink, waitLabel } from '@/components/support/supportFormat';
import { formatAdminDate } from '@/lib/formatDate';

const CARD = 'rounded-xl border border-line bg-surface-elevated p-6 shadow-sm';
const LINK_BTN =
  'inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-sunken';

// Text -700 on a -500/10 tint (amber -800) passes AA on every admin surface (CLAUDE.md).
const OFFER_CHIP: Record<RideOfferStatus, string> = {
  pending: 'bg-amber-500/10 text-amber-800 dark:text-amber-400',
  accepted: 'bg-green-500/10 text-green-700 dark:text-green-400',
  rejected: 'bg-red-500/10 text-red-700 dark:text-red-400',
  expired: 'bg-surface-sunken text-ink-muted',
  superseded: 'bg-surface-sunken text-ink-muted',
};

type LoadState = 'loading' | 'ready' | 'unavailable' | 'error';

export default function RideAssistPage() {
  const { t } = useTranslation('admin');
  const { id } = useParams<{ id: string }>();
  const [ctx, setCtx] = useState<RideAssistContext | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [state, setState] = useState<LoadState>('loading');
  const [configs, setConfigs] = useState<ServiceTypeConfig[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const next = await rideAssistService.getAssistContext(id);
      setCtx(next);
      setFetchedAt(Date.now());
      setState('ready');
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      // A failed poll keeps the page as it was; only the first load decides what to show.
      setState((s) => (s === 'ready' ? s : code === RIDE_ASSIST_UNAVAILABLE ? 'unavailable' : 'error'));
    }
  }, [id]);

  useEffect(() => {
    void load();
    const poll = setInterval(load, 10_000);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  useEffect(() => {
    adminService
      .getServiceTypeConfigs()
      .then(setConfigs)
      .catch(() => setConfigs([]));
  }, []);

  const typeName = useCallback((slug: string) => configs.find((c) => c.slug === slug)?.name_es ?? slug, [configs]);
  const typeOptions = useMemo(
    () => configs.filter((c) => c.is_active).map((c) => ({ slug: c.slug, name: c.name_es })),
    [configs],
  );

  if (state === 'loading') {
    return (
      <div className="flex items-center justify-center py-24">
        <p className="text-ink-subtle">{t('common.loading')}</p>
      </div>
    );
  }
  if (state !== 'ready' || !ctx) {
    return (
      <div className="max-w-3xl">
        <p className={`${CARD} text-sm text-ink-muted`}>
          {state === 'unavailable' ? t('ride_assist.unavailable') : t('ride_assist.load_error')}
        </p>
      </div>
    );
  }

  const { ride, offers, proposal } = ctx;
  const searching = ride.status === 'searching';
  const waitS = ride.wait_s + Math.max(0, Math.floor((now - fetchedAt) / 1000));
  const riderWa = waMeLink(ride.customer_phone, t('ride_assist.rider_whatsapp_text', { code: ride.code }));
  const riderTel = telLink(ride.customer_phone);

  let proposalLine: string | null = null;
  if (proposal) {
    const vars = { type: typeName(proposal.to_service_type), price: formatCUP(proposal.to_fare_cup) };
    const left = Math.floor((new Date(proposal.expires_at).getTime() - now) / 1000);
    if (proposal.status === 'pending') {
      proposalLine =
        left > 0
          ? t('ride_assist.proposal_pending', { ...vars, time: waitLabel(left) })
          : t('ride_assist.proposal_expired', vars);
    } else {
      proposalLine = t(`ride_assist.proposal_${proposal.status}`, vars);
    }
  }

  return (
    <div className="max-w-5xl">
      <AdminBreadcrumb
        items={[
          { label: t('sidebar.rides'), href: '/rides' },
          { label: `#${ride.code}`, href: `/rides/${ride.id}` },
          { label: t('ride_assist.assist_breadcrumb') },
        ]}
      />

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">{t('ride_assist.assist_title', { code: ride.code })}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-muted">
            {searching && <span>{t('ride_assist.waiting_for', { time: waitLabel(waitS) })}</span>}
            {ctx.help_requested_at && (
              <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-semibold text-red-700 dark:text-red-400">
                {t('ride_assist.chip_help')}
              </span>
            )}
            {ride.customer_is_test && (
              <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-semibold text-ink-muted">
                {t('ride_assist.chip_test')}
              </span>
            )}
          </div>
        </div>
        <p className="text-3xl font-bold text-primary-500">{formatCUP(ride.estimated_fare_cup)}</p>
      </div>

      {!searching && (
        <div className="mb-6 rounded-xl bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-400">
          {t('ride_assist.not_searching', { status: ride.status })}{' '}
          <Link href={`/rides/${ride.id}`} className="font-semibold underline">
            {t('ride_assist.see_ride')}
          </Link>
        </div>
      )}

      <div className="mb-6 grid grid-cols-1 gap-6 md:grid-cols-2">
        <section className={CARD}>
          <h2 className="mb-4 text-lg font-bold">{t('ride_assist.ride_card')}</h2>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-ink-muted">{t('ride_assist.origin')}</dt>
              <dd className="font-medium text-ink">{ride.pickup_address}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">{t('ride_assist.destination')}</dt>
              <dd className="font-medium text-ink">{ride.dropoff_address}</dd>
            </div>
            <div className="flex flex-wrap gap-6">
              <div>
                <dt className="text-ink-muted">{t('ride_assist.service')}</dt>
                <dd className="font-medium text-ink">{typeName(ride.service_type)}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">{t('ride_assist.passengers')}</dt>
                <dd className="font-medium text-ink">{ride.passenger_count}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">{t('ride_assist.payment')}</dt>
                <dd className="font-medium text-ink">
                  {t(`rides.payment_${ride.payment_method}`, { defaultValue: ride.payment_method })}
                </dd>
              </div>
            </div>
          </dl>
        </section>

        <section className={CARD}>
          <h2 className="mb-4 text-lg font-bold">{t('ride_assist.rider')}</h2>
          <p className="text-sm font-medium text-ink">{ride.customer_name}</p>
          <p className="text-sm text-ink-muted">{ride.customer_phone ?? '—'}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {riderWa && (
              <a href={riderWa} target="_blank" rel="noopener noreferrer" className={LINK_BTN}>
                <MessageCircle className="h-4 w-4" />
                {t('ride_assist.whatsapp')}
              </a>
            )}
            {riderTel && (
              <a href={riderTel} className={LINK_BTN}>
                <Phone className="h-4 w-4" />
                {t('ride_assist.call')}
              </a>
            )}
          </div>
        </section>
      </div>

      <section className={`${CARD} mb-6`}>
        <h2 className="mb-4 text-lg font-bold">{t('ride_assist.offers_card')}</h2>
        {offers.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('ride_assist.offers_empty')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {offers.map((o) => {
              const left = Math.floor((new Date(o.expires_at).getTime() - now) / 1000);
              const live = o.status === 'pending' && left > 0;
              const shown: RideOfferStatus = o.status === 'pending' && !live ? 'expired' : o.status;
              return (
                <li key={o.driver_profile_id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <span className="font-medium text-ink">{o.driver_name}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${OFFER_CHIP[shown]}`}>
                    {t(`ride_assist.offer_status_${shown}`)}
                  </span>
                  {live && <span className="text-ink-muted">{t('ride_assist.expires_in', { time: waitLabel(left) })}</span>}
                  <span className="ml-auto text-xs text-ink-subtle">{formatAdminDate(o.offered_at)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {searching && (
        <>
          <AssistCandidates
            rideId={ride.id}
            rideServiceType={ride.service_type}
            pickupAddress={ride.pickup_address}
            typeOptions={typeOptions}
            onChanged={load}
          />
          <AssistServiceChange ride={ride} configs={configs} proposalLine={proposalLine} onChanged={load} />
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Type check and lint**

```bash
pnpm --filter @tricigo/admin check-types
cd apps/admin && npx eslint src/components/support "src/app/rides/[id]/assist" --config ../../tools/lint-rules.config.mjs; cd ../..
```

Expected: no errors and no warnings in these files. If `tricigo/require-dark-variant` flags a class, pair it with a `dark:` variant or switch to a semantic token (`bg-surface-*`, `text-ink*`, `border-line`).

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/components/support "apps/admin/src/app/rides/[id]/assist"
git commit -m "feat(admin): assist page to offer, assign or re-type a waiting ride"
```

### Task 15: Ways into the assist page

**Files:**
- Modify: `apps/admin/src/app/rides/[id]/page.tsx:3` (import), `:194-201` (button)
- Modify: `apps/admin/src/components/layout/Header.tsx:18-47` (breadcrumb label)

- [ ] **Step 1: "Asistir" on the ride detail page**

In `apps/admin/src/app/rides/[id]/page.tsx`, add after line 3 (`import { useParams, useRouter } from 'next/navigation';`):

```ts
import Link from 'next/link';
```

and in the right-hand column of the header, replace the cancel-button block (lines 194-201) with the same block preceded by the link:

```tsx
          {ride.status === 'searching' && (
            <Link
              href={`/rides/${ride.id}/assist`}
              className="mt-3 mr-2 inline-block px-4 py-2 text-sm rounded-lg bg-primary-500 hover:bg-primary-600 text-white font-medium"
            >
              {t('ride_assist.assist_open', { defaultValue: 'Asistir' })}
            </Link>
          )}
          {CANCELABLE_STATUSES.includes(ride.status) && (
            <button
              onClick={() => { setCancelReason(''); setCancelOpen(true); }}
              className="mt-3 px-4 py-2 text-sm rounded-lg bg-red-600 hover:bg-red-700 text-white font-medium"
            >
              {t('rides.cancel_ride', { defaultValue: 'Cancelar viaje' })}
            </button>
          )}
```

- [ ] **Step 2: Breadcrumb label for the header**

In `apps/admin/src/components/layout/Header.tsx`, add to `BREADCRUMB_LABELS` after `rides: 'Viajes',`:

```ts
  assist: 'Asistir',
```

- [ ] **Step 3: Type check, lint and commit**

```bash
pnpm --filter @tricigo/admin check-types
cd apps/admin && npx eslint "src/app/rides/[id]/page.tsx" src/components/layout/Header.tsx --config ../../tools/lint-rules.config.mjs; cd ../..
git add "apps/admin/src/app/rides/[id]/page.tsx" apps/admin/src/components/layout/Header.tsx
git commit -m "feat(admin): open the assist page from a searching ride"
```

Expected: no type errors and no new lint warnings.

## Phase 4 — Rider app and web

### Task 16: Rider and web copy

**Files:**
- Modify: `packages/i18n/src/locales/{es,en,pt}/rider.json` (inside `home`, after `long_wait_body`, line 56)
- Modify: `packages/i18n/src/locales/{es,en,pt}/web.json` (inside `track`, after `"track": {`, line 384)

Copy rules from CLAUDE.md: real copy goes to the three locales; the tone is neutral Spanish. The vehicle names already exist: `rider.json` → `service_type.<slug>`, `web.json` → `rides.service_<slug>`.

- [ ] **Step 1: Add the rider keys**

In each `rider.json`, after the `"long_wait_body": …,` line insert:

`es`:
```json
    "support_help_cta": "¿No aparece conductor? Pide ayuda",
    "support_help_hint": "Te ayudamos por WhatsApp a conseguir uno. La búsqueda sigue mientras tanto.",
    "support_help_again": "Volver a abrir WhatsApp con soporte",
    "support_help_whatsapp_text": "Hola, necesito ayuda para conseguir conductor. Viaje: {{code}}",
    "support_help_no_whatsapp": "No pudimos abrir WhatsApp. Escríbenos al +53 5662 1636 con el código {{code}}.",
    "support_proposal_title": "Soporte te propone otro vehículo",
    "support_proposal_body": "{{type}} por {{price}}",
    "support_proposal_before": "Ahora: {{type}}, {{price}}",
    "support_proposal_shared_note": "Con este vehículo tu viaje deja de ser compartido y pierde ese descuento.",
    "support_proposal_expires": "Vence en {{time}}",
    "support_proposal_accept": "Aceptar",
    "support_proposal_reject": "Rechazar",
    "support_proposal_accepted": "Listo: ahora buscamos conductores de {{type}}.",
    "support_proposal_gone": "Esa propuesta ya no está disponible.",
    "support_proposal_failed": "No se pudo enviar tu respuesta. Inténtalo de nuevo.",
```

`en`:
```json
    "support_help_cta": "No driver showing up? Ask for help",
    "support_help_hint": "We help you get one on WhatsApp. The search keeps running meanwhile.",
    "support_help_again": "Open WhatsApp with support again",
    "support_help_whatsapp_text": "Hi, I need help getting a driver. Ride: {{code}}",
    "support_help_no_whatsapp": "We could not open WhatsApp. Write to us at +53 5662 1636 with the code {{code}}.",
    "support_proposal_title": "Support suggests another vehicle",
    "support_proposal_body": "{{type}} for {{price}}",
    "support_proposal_before": "Now: {{type}}, {{price}}",
    "support_proposal_shared_note": "With this vehicle your ride is no longer shared and loses that discount.",
    "support_proposal_expires": "Expires in {{time}}",
    "support_proposal_accept": "Accept",
    "support_proposal_reject": "Reject",
    "support_proposal_accepted": "Done: we are now looking for {{type}} drivers.",
    "support_proposal_gone": "That proposal is no longer available.",
    "support_proposal_failed": "Your answer could not be sent. Try again.",
```

`pt`:
```json
    "support_help_cta": "Nenhum motorista aparece? Peça ajuda",
    "support_help_hint": "Ajudamos você a conseguir um pelo WhatsApp. A busca continua enquanto isso.",
    "support_help_again": "Abrir de novo o WhatsApp com o suporte",
    "support_help_whatsapp_text": "Olá, preciso de ajuda para conseguir motorista. Viagem: {{code}}",
    "support_help_no_whatsapp": "Não conseguimos abrir o WhatsApp. Escreva para +53 5662 1636 com o código {{code}}.",
    "support_proposal_title": "O suporte propõe outro veículo",
    "support_proposal_body": "{{type}} por {{price}}",
    "support_proposal_before": "Agora: {{type}}, {{price}}",
    "support_proposal_shared_note": "Com este veículo a sua viagem deixa de ser compartilhada e perde esse desconto.",
    "support_proposal_expires": "Vence em {{time}}",
    "support_proposal_accept": "Aceitar",
    "support_proposal_reject": "Recusar",
    "support_proposal_accepted": "Pronto: agora procuramos motoristas de {{type}}.",
    "support_proposal_gone": "Essa proposta não está mais disponível.",
    "support_proposal_failed": "Não foi possível enviar sua resposta. Tente de novo.",
```

- [ ] **Step 2: Add the web keys**

In each `web.json`, right after the line `  "track": {` insert the same keys as above **except `support_help_no_whatsapp`** (on the web the help button is a plain link), with the same text per locale.

- [ ] **Step 3: Check JSON and parity**

```bash
for f in packages/i18n/src/locales/{es,en,pt}/{rider,web}.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" && echo "$f ok"; done
pnpm check:i18n
```

Expected: six `ok` lines, and the parity check passes.

- [ ] **Step 4: Commit**

```bash
git add packages/i18n/src/locales/*/rider.json packages/i18n/src/locales/*/web.json
git commit -m "feat(i18n): rider and web copy for asking support for help"
```

### Task 17: The rider app — "Pedir ayuda" and the proposal card

**Files:**
- Create: `apps/client/src/hooks/useServiceProposal.ts`
- Create: `apps/client/src/components/SupportHelpButton.tsx`
- Create: `apps/client/src/components/ServiceProposalCard.tsx`
- Modify: `apps/client/app/(tabs)/index.tsx` (imports after line 77; `SearchingView` from line 5024)
- Modify: `apps/client/src/hooks/useRide.ts:252-292` (the 3 s poll)

The client has no React Native renderer in its tests (see `apps/client/vitest.config.ts`): the logic these files need is already tested in `@tricigo/utils` (Task 8: `searchHelpAvailable`, `rideShortCode`, `SUPPORT_WHATSAPP_PHONE`, plus the existing `waMeLink`) and `@tricigo/api` (Task 10: `rideAssistService`, `isProposalGone`). The screens are checked by hand in Task 23.

- [ ] **Step 1: Write `apps/client/src/hooks/useServiceProposal.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { rideAssistService, type ServiceProposal } from '@tricigo/api';

/**
 * The vehicle-type change support proposed for this searching ride (00628), polled every 5 s
 * while `enabled`. null when there is none, when 00628 is not applied, or when a poll fails.
 * `dismiss(id)` hides a proposal the rider already answered, even if a poll that was in flight
 * still returns it.
 */
export function useServiceProposal(rideId: string | null, enabled: boolean) {
  const [proposal, setProposal] = useState<ServiceProposal | null>(null);
  const dismissedRef = useRef<Set<string>>(new Set());
  const activeRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!rideId) return;
    try {
      const next = await rideAssistService.getPendingProposal(rideId);
      if (!activeRef.current) return;
      setProposal(next && !dismissedRef.current.has(next.id) ? next : null);
    } catch {
      // Keep what is shown; the next poll retries.
    }
  }, [rideId]);

  useEffect(() => {
    activeRef.current = true;
    if (!enabled || !rideId) {
      setProposal(null);
      return () => {
        activeRef.current = false;
      };
    }
    void refresh();
    const id = setInterval(refresh, 5_000);
    return () => {
      activeRef.current = false;
      clearInterval(id);
    };
  }, [enabled, rideId, refresh]);

  const dismiss = useCallback((id: string) => {
    dismissedRef.current.add(id);
    setProposal((p) => (p?.id === id ? null : p));
  }, []);

  return { proposal, dismiss };
}
```

- [ ] **Step 2: Write `apps/client/src/components/SupportHelpButton.tsx`**

```tsx
import React, { useState } from 'react';
import { Linking, View } from 'react-native';
import Toast from 'react-native-toast-message';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { rideAssistService } from '@tricigo/api';
import { rideShortCode, searchHelpAvailable, SUPPORT_WHATSAPP_PHONE, waMeLink } from '@tricigo/utils';

interface SupportHelpButtonProps {
  rideId: string;
  /** Seconds the searching screen has been up (SearchingView's counter). */
  elapsedSeconds: number;
}

/**
 * "¿No aparece conductor? Pide ayuda" (00628), from 45 s of searching. Alerts support once
 * (request_ride_help) and opens WhatsApp with the ride code; the search keeps running.
 * The alert is awaited for at most 4 s so it leaves before WhatsApp takes the screen (the app
 * can be suspended then); WhatsApp opens either way, also when 00628 is not applied.
 */
export function SupportHelpButton({ rideId, elapsedSeconds }: SupportHelpButtonProps) {
  const { t } = useTranslation('rider');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  if (!searchHelpAvailable(elapsedSeconds)) return null;
  const code = rideShortCode(rideId);

  const onPress = async () => {
    setSending(true);
    await Promise.race([
      rideAssistService.requestHelp(rideId),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4_000)),
    ]);
    setSending(false);
    setSent(true);
    const url = waMeLink(SUPPORT_WHATSAPP_PHONE, t('home.support_help_whatsapp_text', { code }));
    try {
      if (!url) throw new Error('no WhatsApp link');
      await Linking.openURL(url);
    } catch {
      Toast.show({ type: 'info', text1: t('home.support_help_no_whatsapp', { code }), visibilityTime: 8000 });
    }
  };

  return (
    <View className="w-full px-8 mb-4">
      <Button
        title={sent ? t('home.support_help_again') : t('home.support_help_cta')}
        variant="primary"
        size="md"
        fullWidth
        onPress={() => void onPress()}
        loading={sending}
      />
      {!sent && (
        <Text variant="caption" color="tertiary" className="mt-2 text-center">
          {t('home.support_help_hint')}
        </Text>
      )}
    </View>
  );
}
```

- [ ] **Step 3: Write `apps/client/src/components/ServiceProposalCard.tsx`**

```tsx
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import Toast from 'react-native-toast-message';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { isProposalGone, rideAssistService, type ServiceProposal } from '@tricigo/api';
import { formatCUP, formatTRC } from '@tricigo/utils';

interface ServiceProposalCardProps {
  proposal: ServiceProposal;
  /** 'tricicoin' shows TRC, anything else CUP, like the rest of SearchingView. */
  paymentMethod: string | null | undefined;
  sharedRide: boolean;
  /** The card should go: answered, or no longer acceptable. `accepted` says whether the type changed. */
  onDone: (accepted: boolean) => void;
}

/**
 * Support proposes switching the searching ride to another vehicle type at a new price (00628,
 * admin_change_ride_service). Accepting switches it at once and the search goes on with drivers
 * of the new type; rejecting it, or letting it expire, changes nothing.
 */
export function ServiceProposalCard({ proposal, paymentMethod, sharedRide, onDone }: ServiceProposalCardProps) {
  const { t } = useTranslation('rider');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const left = Math.max(0, Math.floor((new Date(proposal.expires_at).getTime() - now) / 1000));
  // Past expiry the server refuses it anyway; the next poll clears it.
  if (left === 0) return null;

  const money = (n: number) => (paymentMethod === 'tricicoin' ? formatTRC(n) : formatCUP(n));
  const typeName = (slug: string) => t(`service_type.${slug}`, { defaultValue: slug });
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;

  const respond = async (accept: boolean) => {
    setBusy(true);
    try {
      await rideAssistService.respondProposal(proposal.id, accept);
      if (accept) {
        Toast.show({
          type: 'success',
          text1: t('home.support_proposal_accepted', { type: typeName(proposal.to_service_type) }),
        });
      }
      onDone(accept);
    } catch (err) {
      if (isProposalGone(err)) {
        Toast.show({ type: 'info', text1: t('home.support_proposal_gone') });
        onDone(false);
      } else {
        Toast.show({ type: 'error', text1: t('home.support_proposal_failed') });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      variant="filled"
      padding="md"
      className="border border-primary-200 dark:border-primary-800 bg-primary-50 dark:bg-primary-900/20"
    >
      <View className="flex-row items-center mb-2">
        <View className="w-8 h-8 rounded-full bg-primary-500 items-center justify-center mr-3">
          <Ionicons name="swap-horizontal" size={16} color="#fff" />
        </View>
        <Text variant="body" className="flex-1 font-bold">
          {t('home.support_proposal_title')}
        </Text>
      </View>
      <Text variant="body" className="font-bold mb-1">
        {t('home.support_proposal_body', {
          type: typeName(proposal.to_service_type),
          price: money(proposal.to_fare_cup),
        })}
      </Text>
      <Text variant="caption" color="secondary" className="mb-1">
        {t('home.support_proposal_before', {
          type: typeName(proposal.from_service_type),
          price: money(proposal.from_fare_cup),
        })}
      </Text>
      {sharedRide && proposal.to_service_type !== 'triciclo_basico' && (
        <Text variant="caption" color="secondary" className="mb-1">
          {t('home.support_proposal_shared_note')}
        </Text>
      )}
      <Text variant="caption" color="tertiary" className="mb-3">
        {t('home.support_proposal_expires', { time: clock })}
      </Text>
      <View className="flex-row gap-2">
        <View className="flex-1">
          <Button
            title={t('home.support_proposal_reject')}
            variant="outline"
            size="sm"
            fullWidth
            onPress={() => void respond(false)}
            loading={busy}
          />
        </View>
        <View className="flex-1">
          <Button
            title={t('home.support_proposal_accept')}
            size="sm"
            fullWidth
            onPress={() => void respond(true)}
            loading={busy}
          />
        </View>
      </View>
    </Card>
  );
}
```

The `Card` tint follows `SplitInviteCard.tsx`, which renders correctly: per CLAUDE.md § "Un `Card` no se tiñe por `className`", `bg-primary-50` sorts after `Card`'s own `bg-neutral-50` and wins, and `dark:bg-primary-900/20` sorts after `dark:bg-neutral-800`.

- [ ] **Step 4: Wire both into `SearchingView`**

In `apps/client/app/(tabs)/index.tsx`, after line 77 (`import { AcceptedDriverCard } from '@/components/AcceptedDriverCard';`):

```ts
import { ServiceProposalCard } from '@/components/ServiceProposalCard';
import { SupportHelpButton } from '@/components/SupportHelpButton';
import { useServiceProposal } from '@/hooks/useServiceProposal';
```

In `SearchingView`, right after the `useRideOfferStats` call:

```tsx
  const offerStats = useRideOfferStats({
    rideId: activeRide?.id ?? null,
    enabled: activeRide?.status === 'searching',
  });

  // Support-assisted matching (00628): a vehicle-type change support proposed, answered here.
  const customerId = useAuthStore((s) => s.user?.id);
  const { proposal, dismiss: dismissProposal } = useServiceProposal(
    activeRide?.id ?? null,
    activeRide?.status === 'searching',
  );
  const onProposalDone = useCallback(
    async (proposalId: string, accepted: boolean) => {
      dismissProposal(proposalId);
      if (!accepted || !customerId) return;
      // Show the new type and price now, not at the next 3 s poll. Only while still searching:
      // a status change belongs to the poll, which fires its sounds and notices.
      const fresh = await rideService.getActiveRide(customerId).catch(() => null);
      if (fresh?.status === 'searching') useRideStore.getState().updateRideFromRealtime(fresh);
    },
    [dismissProposal, customerId],
  );
```

In the JSX, the proposal card goes first in the "still searching" block. Replace

```tsx
      {!acceptedDriver ? (
        <>
          <Animated.View style={{ opacity: searchFadeAnim }}>
```

with

```tsx
      {!acceptedDriver ? (
        <>
          {proposal && (
            <View className="w-full px-8 mb-4">
              <ServiceProposalCard
                proposal={proposal}
                paymentMethod={activeRide?.payment_method}
                sharedRide={!!activeRide?.shared_ride}
                onDone={(accepted) => void onProposalDone(proposal.id, accepted)}
              />
            </View>
          )}
          <Animated.View style={{ opacity: searchFadeAnim }}>
```

and the help button goes after the progress bar. Replace

```tsx
          {error && (
            <Text variant="bodySmall" color="error" className="mb-4 text-center">
              {error}
            </Text>
          )}
        </>
      ) : null}
```

with

```tsx
          {activeRide && <SupportHelpButton rideId={activeRide.id} elapsedSeconds={elapsedSeconds} />}

          {error && (
            <Text variant="bodySmall" color="error" className="mb-4 text-center">
              {error}
            </Text>
          )}
        </>
      ) : null}
```

(Both search strings occur once in the file: check with `grep -c` before replacing.)

- [ ] **Step 5: Notice a type change in the 3 s poll**

In `apps/client/src/hooks/useRide.ts`, after the `estimatedChanged` declaration (it ends at line 262), add:

```ts

          // Support can switch a searching ride to another vehicle type (00628): a new
          // service_type and fare with the same status, and the fare can even stay equal.
          const serviceChanged =
            fresh.service_type !== pinned.service_type
            || fresh.estimated_fare_trc !== pinned.estimated_fare_trc;
```

add `|| serviceChanged` to the condition below it:

```ts
            || estimatedChanged
            || serviceChanged
            || paymentStatusChanged
          ) {
```

and `service_changed: serviceChanged,` to the `[Watcher] ride changed` log object, after `estimated_changed: estimatedChanged,`.

- [ ] **Step 6: Type check, lint and the client tests**

```bash
pnpm --filter @tricigo/client check-types
cd apps/client && npx eslint src/hooks/useServiceProposal.ts src/components/SupportHelpButton.tsx src/components/ServiceProposalCard.tsx src/hooks/useRide.ts "app/(tabs)/index.tsx" --config ../../tools/lint-rules.config.mjs; cd ../..
pnpm --filter @tricigo/client test
```

Expected: no type errors; no new lint errors or warnings in the three new files (`index.tsx` and `useRide.ts` keep their existing warnings and gain none); all client tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/client/src/hooks/useServiceProposal.ts apps/client/src/components/SupportHelpButton.tsx \
  apps/client/src/components/ServiceProposalCard.tsx "apps/client/app/(tabs)/index.tsx" apps/client/src/hooks/useRide.ts
git commit -m "feat(client): ask support for help while searching, and answer its vehicle proposal"
```

### Task 18: The web — the same button and card on `/track/[id]`

**Files:**
- Create: `apps/web/src/app/track/[id]/SupportHelpCard.tsx`
- Modify: `apps/web/src/app/track/[id]/page.tsx:20` (import), `:882-886` (mount after the status stepper)

- [ ] **Step 1: Write `apps/web/src/app/track/[id]/SupportHelpCard.tsx`**

```tsx
'use client';

// Support-assisted matching (00628), the web side of the rider app's SearchingView: while the
// ride is searching, the vehicle-type change support proposed (Aceptar / Rechazar), and from
// 45 s the "Pedir ayuda" link, which alerts support and opens WhatsApp with the ride code.
// Without 00628 both stay quiet: getPendingProposal answers null and requestHelp never throws,
// so the WhatsApp link still works.

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { isProposalGone, rideAssistService, type ServiceProposal } from '@tricigo/api';
import { formatCUP, rideShortCode, searchHelpAvailable, SUPPORT_WHATSAPP_PHONE, waMeLink } from '@tricigo/utils';

interface Props {
  rideId: string;
  /** When the search started, in ms: created_at, or scheduled_at for a scheduled ride. */
  startedAtMs: number;
  sharedRide: boolean;
  /** Re-reads the ride, so an accepted change shows without waiting for the 3 s poll. */
  onChanged: () => void;
}

function mmss(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function SupportHelpCard({ rideId, startedAtMs, sharedRide, onChanged }: Props) {
  const { t } = useTranslation('web');
  const [now, setNow] = useState(() => Date.now());
  const [proposal, setProposal] = useState<ServiceProposal | null>(null);
  const [answeredId, setAnsweredId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [helpSent, setHelpSent] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const loadProposal = useCallback(async () => {
    try {
      setProposal(await rideAssistService.getPendingProposal(rideId));
    } catch {
      // Keep what is shown; the next poll retries.
    }
  }, [rideId]);

  useEffect(() => {
    void loadProposal();
    const id = setInterval(loadProposal, 5_000);
    return () => clearInterval(id);
  }, [loadProposal]);

  const typeName = (slug: string) => t(`rides.service_${slug}`, { defaultValue: slug });

  const respond = async (p: ServiceProposal, accept: boolean) => {
    setBusy(true);
    setNotice(null);
    try {
      await rideAssistService.respondProposal(p.id, accept);
      setAnsweredId(p.id);
      if (accept) {
        setNotice(t('track.support_proposal_accepted', { type: typeName(p.to_service_type) }));
        onChanged();
      }
    } catch (err) {
      if (isProposalGone(err)) {
        setAnsweredId(p.id);
        setNotice(t('track.support_proposal_gone'));
      } else {
        setNotice(t('track.support_proposal_failed'));
      }
    } finally {
      setBusy(false);
    }
  };

  const left = proposal ? Math.floor((new Date(proposal.expires_at).getTime() - now) / 1000) : 0;
  const shown = proposal && proposal.id !== answeredId && left > 0 ? proposal : null;
  const showHelp = searchHelpAvailable(Math.floor((now - startedAtMs) / 1000));
  const helpUrl = waMeLink(
    SUPPORT_WHATSAPP_PHONE,
    t('track.support_help_whatsapp_text', { code: rideShortCode(rideId) }),
  );

  if (!shown && !showHelp && !notice) return null;

  return (
    <div className="track-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {shown && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.4rem',
            padding: '0.75rem',
            borderRadius: '0.75rem',
            background: 'rgba(255,77,0,0.08)',
            border: '1px solid var(--primary, #FF4D00)',
          }}
        >
          <span style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            {t('track.support_proposal_title')}
          </span>
          <span style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            {t('track.support_proposal_body', {
              type: typeName(shown.to_service_type),
              price: formatCUP(shown.to_fare_cup),
            })}
          </span>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            {t('track.support_proposal_before', {
              type: typeName(shown.from_service_type),
              price: formatCUP(shown.from_fare_cup),
            })}
          </span>
          {sharedRide && shown.to_service_type !== 'triciclo_basico' && (
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              {t('track.support_proposal_shared_note')}
            </span>
          )}
          <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
            {t('track.support_proposal_expires', { time: mmss(left) })}
          </span>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond(shown, false)}
              style={{
                flex: 1,
                padding: '0.6rem',
                borderRadius: '0.6rem',
                border: '1px solid var(--border)',
                background: 'var(--bg-card)',
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.6 : 1,
                fontSize: '0.82rem',
                fontWeight: 600,
                color: 'var(--text-primary)',
              }}
            >
              {t('track.support_proposal_reject')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond(shown, true)}
              style={{
                flex: 1,
                padding: '0.6rem',
                borderRadius: '0.6rem',
                border: 'none',
                background: 'var(--primary, #FF4D00)',
                color: '#fff',
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.6 : 1,
                fontSize: '0.82rem',
                fontWeight: 700,
              }}
            >
              {t('track.support_proposal_accept')}
            </button>
          </div>
        </div>
      )}

      {showHelp && helpUrl && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          {/* A plain link, so the browser opens WhatsApp inside the click (a window.open after
              an await is blocked as a popup). The alert goes out without waiting: the page stays. */}
          <a
            href={helpUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => {
              void rideAssistService.requestHelp(rideId);
              setHelpSent(true);
            }}
            style={{
              display: 'block',
              textAlign: 'center',
              padding: '0.7rem',
              borderRadius: '0.6rem',
              border: '1px solid var(--primary, #FF4D00)',
              background: 'var(--bg-card)',
              color: 'var(--text-primary)',
              fontSize: '0.88rem',
              fontWeight: 700,
              textDecoration: 'none',
            }}
          >
            {helpSent ? t('track.support_help_again') : t('track.support_help_cta')}
          </a>
          {!helpSent && (
            <span style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)', textAlign: 'center' }}>
              {t('track.support_help_hint')}
            </span>
          )}
        </div>
      )}

      {notice && <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{notice}</span>}
    </div>
  );
}
```

The accept button reuses the track page's existing primary-button style (`gps_check_yes`), so it looks like the page's other confirmations.

- [ ] **Step 2: Mount it under the status stepper**

In `apps/web/src/app/track/[id]/page.tsx`, after line 20 (`import { FareSplitCard } from './FareSplitCard';`):

```ts
import { SupportHelpCard } from './SupportHelpCard';
```

Then replace the stepper block

```tsx
          ) : (
            <div className="track-card">
              <StatusStepper steps={statusSteps} currentIdx={currentStepIdx} />
            </div>
          )}
```

with

```tsx
          ) : (
            <div className="track-card">
              <StatusStepper steps={statusSteps} currentIdx={currentStepIdx} />
            </div>
          )}

          {/* Support-assisted matching (00628): a type change support proposed, and "Pedir ayuda". */}
          {ride.status === 'searching' && userId === ride.customer_id && (
            <SupportHelpCard
              rideId={ride.id}
              startedAtMs={Math.max(
                new Date(ride.created_at).getTime(),
                ride.scheduled_at ? new Date(ride.scheduled_at).getTime() : 0,
              )}
              sharedRide={!!ride.shared_ride}
              onChanged={fetchRide}
            />
          )}
```

The page re-reads the whole ride every 3 s (`fetchRide`), so a change support applies with WhatsApp consent shows there on its own; `onChanged` only makes an accepted change show at once.

- [ ] **Step 3: Type check and commit**

```bash
pnpm --filter @tricigo/web check-types
git add "apps/web/src/app/track/[id]/SupportHelpCard.tsx" "apps/web/src/app/track/[id]/page.tsx"
git commit -m "feat(web): ask support for help while searching, and answer its vehicle proposal"
```

Expected: no type errors.

## Phase 5 — Driver app

### Task 19: The driver app picks up a ride support assigned

A directly assigned ride has no offer, so nothing in the driver app reads it while the app is open and idle: realtime is off (BUG-277), the 5 s trip poll in `useDriverRideInit` only runs while there already is a trip, and the 30 s poll of `useIncomingRequests` only looks for searching rides. Today it shows up when the app starts or comes back to the foreground. This task adds two ways in: the `ride_assigned` push (received in the foreground or tapped), and the 30 s poll.

**Files:**
- Create: `apps/driver/src/utils/rideAssignedPush.ts`
- Test: `apps/driver/src/utils/__tests__/rideAssignedPush.test.ts`
- Modify: `apps/driver/src/hooks/useDriverRide.ts` (after `unbindBgLocationFromRide`, line 140; the `useDriverRideInit` effect, lines 159-431; the 30 s poll of `useIncomingRequests`, lines 512-518)
- Modify: `apps/driver/src/hooks/useNotifications.ts:391-428`
- Modify: `packages/i18n/src/locales/{es,en,pt}/driver.json` (inside `trip`, line 121)

`useNotifications.ts` must not import `useDriverRide.ts`: that file pulls native modules (`driver-overlay`, the background location task) that `apps/driver/src/hooks/__tests__/useNotifications.test.ts` does not mock. The two talk through the small pure module below.

- [ ] **Step 1: Write the failing test**

`apps/driver/src/utils/__tests__/rideAssignedPush.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { emitRideAssignedPush, isRideAssignedPush, onRideAssignedPush } from '../rideAssignedPush';

describe('isRideAssignedPush', () => {
  it('recognizes support assigning a ride by data.event (send-push overwrites data.type)', () => {
    expect(isRideAssignedPush({ type: 'system', event: 'ride_assigned', ride_id: 'r-1' })).toBe(true);
  });

  it('ignores every other push', () => {
    expect(isRideAssignedPush({ type: 'system' })).toBe(false);
    expect(isRideAssignedPush({ type: 'ride_offer', ride_id: 'r-1' })).toBe(false);
    expect(isRideAssignedPush({ type: 'system', event: 'support_help' })).toBe(false);
    expect(isRideAssignedPush(undefined)).toBe(false);
    expect(isRideAssignedPush(null)).toBe(false);
  });
});

describe('onRideAssignedPush / emitRideAssignedPush', () => {
  it('calls every listener until it unsubscribes', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onRideAssignedPush(a);
    const offB = onRideAssignedPush(b);

    emitRideAssignedPush();
    offA();
    emitRideAssignedPush();
    offB();
    emitRideAssignedPush();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('keeps calling the others when one listener throws', () => {
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    const offBad = onRideAssignedPush(bad);
    const offGood = onRideAssignedPush(good);

    expect(() => emitRideAssignedPush()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);

    offBad();
    offGood();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @tricigo/driver exec vitest run src/utils/__tests__/rideAssignedPush.test.ts`
Expected: FAIL — `Cannot find module '../rideAssignedPush'`.

- [ ] **Step 3: Write `apps/driver/src/utils/rideAssignedPush.ts`**

```ts
/**
 * Support assigned this driver a ride (00628, admin_assign_ride_to_driver). The push is
 * category `system`, and send-push overwrites data.type with the category, so the event
 * travels in data.event.
 *
 * useNotifications hears the push; useDriverRideInit loads the trip. They talk through this
 * module rather than importing each other: useDriverRide pulls native modules that the
 * notification hook's tests do not mock.
 */
export function isRideAssignedPush(data: unknown): boolean {
  return (data as { event?: unknown } | null | undefined)?.event === 'ride_assigned';
}

type Listener = () => void;
const listeners = new Set<Listener>();

export function onRideAssignedPush(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitRideAssignedPush(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One listener failing must not keep the trip from loading in another.
    }
  }
}
```

- [ ] **Step 4: Run the test again**

Run: `pnpm --filter @tricigo/driver exec vitest run src/utils/__tests__/rideAssignedPush.test.ts`
Expected: PASS.

- [ ] **Step 5: Let the home tab's active-trip check run on demand**

In `apps/driver/src/hooks/useDriverRide.ts`:

1. Add to the imports (after line 21):

```ts
import { onRideAssignedPush } from '@/utils/rideAssignedPush';
```

2. After `function unbindBgLocationFromRide(…) { … }` (it ends at line 140), add:

```ts

/**
 * Re-runs the home tab's active-trip check (useDriverRideInit) from outside it. Support can
 * assign a ride directly while the app is open and idle (00628, admin_assign_ride_to_driver);
 * realtime is off (BUG-277) and the 5 s trip poll only runs while there already is a trip, so
 * nothing else would read it. A no-op while the home tab is not mounted: it checks on mount.
 */
let activeTripReconciler: (() => void) | null = null;
export function requestActiveTripReconcile(): void {
  activeTripReconciler?.();
}
```

3. In the `useDriverRideInit` effect, replace

```ts
    checkActive();

    // Bug 36: Re-check active trip when app returns from background
```

with

```ts
    checkActive();

    const reconcile = () => {
      if (mounted) void checkActive();
    };
    activeTripReconciler = reconcile;

    // Support assigned a ride (push with data.event = 'ride_assigned', 00628): load it now and
    // say so with sound, since it did not come as an offer the driver accepted. A push that is
    // received and then tapped gives one notice, not two.
    let lastAssignedNoticeAt = 0;
    const offRideAssigned = onRideAssignedPush(() => {
      reconcile();
      if (Date.now() - lastAssignedNoticeAt < 10_000) return;
      lastAssignedNoticeAt = Date.now();
      triggerHaptic('success');
      playSound('new_request');
      Toast.show({
        type: 'success',
        text1: i18next.t('driver:trip.support_assigned_title', { defaultValue: 'Soporte te asignó un viaje' }),
        text2: i18next.t('driver:trip.support_assigned_body', {
          defaultValue: 'Ya está en tu pantalla. Ve a recoger al pasajero.',
        }),
        visibilityTime: 6000,
      });
    });

    // Bug 36: Re-check active trip when app returns from background
```

4. In the same effect's cleanup, replace

```ts
    return () => {
      mounted = false;
      channelRef.current?.unsubscribe();
```

with

```ts
    return () => {
      mounted = false;
      if (activeTripReconciler === reconcile) activeTripReconciler = null;
      offRideAssigned();
      channelRef.current?.unsubscribe();
```

5. In `useIncomingRequests`, replace the 30 s fallback poll

```ts
    // Fallback polling every 30s in case realtime disconnects silently
    const pollInterval = setInterval(async () => {
      try {
        const rides = await rideService.getSearchingRides();
        for (const ride of rides) addRequest(ride);
      } catch { /* best-effort fallback */ }
    }, 30000);
```

with

```ts
    // Fallback polling every 30s in case realtime disconnects silently
    const pollInterval = setInterval(async () => {
      try {
        const rides = await rideService.getSearchingRides();
        for (const ride of rides) addRequest(ride);
      } catch { /* best-effort fallback */ }
      // A ride support assigned directly comes with no offer (00628). If its push did not
      // arrive, this is what loads it. getActiveTrip only returns rides still in progress.
      const local = useDriverRideStore.getState().activeTrip;
      if (!local || local.status === 'completed' || local.status === 'canceled') {
        const profileId = useDriverStore.getState().profile?.id;
        if (profileId) {
          const trip = await driverService.getActiveTrip(profileId).catch(() => null);
          if (trip) requestActiveTripReconcile();
        }
      }
    }, 30000);
```

`triggerHaptic`, `playSound`, `Toast`, `i18next`, `driverService`, `useDriverStore` and `useDriverRideStore` are already imported in this file (lines 3-19).

- [ ] **Step 6: Hear the push**

In `apps/driver/src/hooks/useNotifications.ts`, add to the imports (after line 17, `import { router } from 'expo-router';`):

```ts
import { emitRideAssignedPush, isRideAssignedPush } from '@/utils/rideAssignedPush';
```

Then replace the tap and cold-start handlers

```ts
    // Handle notification taps (app in background)
    responseListenerRef.current = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const data = response.notification.request.content.data;
        handleNotificationNavigation(data as Record<string, unknown>);
      },
    );

    // Handle cold-start: notification that launched the app
    // getLastNotificationResponseAsync is not available on web
    (Platform.OS !== 'web' ? Notifications.getLastNotificationResponseAsync() : Promise.resolve(null)).then((response) => {
      if (response && !cancelled) {
        const data = response.notification.request.content.data;
        handleNotificationNavigation(data as Record<string, unknown>);
      }
    });
```

with

```ts
    // Handle notification taps (app in background)
    responseListenerRef.current = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const data = response.notification.request.content.data;
        handleNotificationNavigation(data as Record<string, unknown>);
        if (isRideAssignedPush(data)) emitRideAssignedPush();
      },
    );

    // Support assigned a ride while the app is open (00628): load it without waiting for a tap.
    const receivedListener = Notifications.addNotificationReceivedListener((notification) => {
      if (isRideAssignedPush(notification.request.content.data)) emitRideAssignedPush();
    });

    // Handle cold-start: notification that launched the app
    // getLastNotificationResponseAsync is not available on web
    (Platform.OS !== 'web' ? Notifications.getLastNotificationResponseAsync() : Promise.resolve(null)).then((response) => {
      if (response && !cancelled) {
        const data = response.notification.request.content.data;
        handleNotificationNavigation(data as Record<string, unknown>);
        if (isRideAssignedPush(data)) emitRideAssignedPush();
      }
    });
```

and in the cleanup at the end of the same effect, after `responseListenerRef.current?.remove();`, add:

```ts
      receivedListener.remove();
```

A tapped `ride_assigned` push already opens the home tab: its `data.type` is `system`, which `handleNotificationNavigation` routes to `/(tabs)`.

- [ ] **Step 7: The toast's copy**

In each `driver.json`, right after the line `  "trip": {` insert:

`es`:
```json
    "support_assigned_title": "Soporte te asignó un viaje",
    "support_assigned_body": "Ya está en tu pantalla. Ve a recoger al pasajero.",
```

`en`:
```json
    "support_assigned_title": "Support assigned you a ride",
    "support_assigned_body": "It is on your screen now. Go pick up the rider.",
```

`pt`:
```json
    "support_assigned_title": "O suporte atribuiu uma viagem a você",
    "support_assigned_body": "Já está na sua tela. Vá buscar o passageiro.",
```

- [ ] **Step 8: Type check, lint and the driver tests**

```bash
pnpm --filter @tricigo/driver check-types
cd apps/driver && npx eslint src/utils/rideAssignedPush.ts src/hooks/useDriverRide.ts src/hooks/useNotifications.ts --config ../../tools/lint-rules.config.mjs; cd ../..
pnpm --filter @tricigo/driver test
for l in es en pt; do node -e "JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/$l/driver.json','utf8'))" && echo "$l ok"; done
pnpm check:i18n
```

Expected: no type errors; no new lint warnings in these files; every driver test passes, the existing `useNotifications.test.ts` included; `es ok`, `en ok`, `pt ok`; the parity check passes.

- [ ] **Step 9: Commit**

```bash
git add apps/driver/src/utils/rideAssignedPush.ts apps/driver/src/utils/__tests__/rideAssignedPush.test.ts \
  apps/driver/src/hooks/useDriverRide.ts apps/driver/src/hooks/useNotifications.ts packages/i18n/src/locales/*/driver.json
git commit -m "feat(driver): load a ride support assigned, from its push or the 30 s poll"
```

## Phase 6 — Verification, prod rehearsal, merge, release

### Task 20: Everything CI runs, plus the database rehearsal, on the finished branch

**Files:** none (verification only).

- [ ] **Step 1: Bring the branch up to date and install**

```bash
git fetch origin master && git merge origin/master
pnpm install --frozen-lockfile
git status --short pnpm-lock.yaml   # must print nothing; if it does: git checkout HEAD -- pnpm-lock.yaml
```

If the merge brought a new migration numbered `00628`, renumber this one before anything else (CLAUDE.md § "Pre-flight para elegir número de migración").

- [ ] **Step 2: Run CI's checks**

```bash
pnpm lint
pnpm check:i18n
pnpm test:migration-grants && pnpm check:migration-grants
pnpm check-types
pnpm test
```

Expected: every command exits 0. `pnpm lint` may print the warnings that already exist on master (for example the 12 `react-hooks/exhaustive-deps` in `apps/driver/app/(tabs)/index.tsx`, which this plan does not touch), but none in a file this plan created or changed.

- [ ] **Step 3: Run the database rehearsal both ways**

```bash
supabase/tests/00628/run.sh none | tail -1
supabase/tests/00628/run.sh supabase/migrations/00628_support_assisted_matching.sql | tail -1
```

Expected: `PASS 3  FAIL 70`, then `PASS 73  FAIL 0`.

- [ ] **Step 4: Record the md5 of every function the migration creates or changes**

Task 22 compares prod against these.

```bash
BIN=/usr/lib/postgresql/16/bin; CONN="-h 127.0.0.1 -p 5433 -U pgtest"
$BIN/dropdb $CONN --if-exists md5check; $BIN/createdb $CONN md5check
$BIN/psql $CONN -d md5check -q -v ON_ERROR_STOP=1 -f supabase/tests/00628/scaffold.sql
$BIN/psql $CONN -d md5check -q -v ON_ERROR_STOP=1 -c "SET SESSION AUTHORIZATION postgres; SET search_path = '';" \
  -f supabase/migrations/00628_support_assisted_matching.sql
$BIN/psql $CONN -d md5check -At -c "
  SELECT p.proname || '=' || md5(p.prosrc) || '/' || length(p.prosrc)
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (ARRAY[
    '_ride_short_code', '_vehicle_types_for_service', '_driver_can_serve_ride', '_users_blocked', '_html_escape',
    '_write_ride_estimate_snapshot', 'tg_rides_create_estimate_snapshot', 'tg_rides_validate_promo_discount',
    '_ride_service_change_error', '_apply_ride_service_change', 'admin_change_ride_service',
    'get_my_ride_service_proposal', 'respond_ride_service_proposal', 'admin_support_waiting_rides',
    'admin_ride_assist_context', 'admin_ride_assist_candidates', 'admin_offer_ride_to_driver',
    'admin_assign_ride_to_driver', '_support_alert', 'request_ride_help', 'notify_support_waiting_rides'])
  ORDER BY 1" | tee /tmp/00628-md5-local.txt | wc -l
$BIN/dropdb $CONN md5check
```

Expected: `21`. Keep `/tmp/00628-md5-local.txt` (or paste it into the PR body) for Task 22.

- [ ] **Step 5: Ask for a code review**

Use superpowers:requesting-code-review on the whole diff (`git diff origin/master...HEAD`), with the spec as the requirement. Fix what it finds, re-run steps 2-4, and commit the fixes.

### Task 21: Rehearse the migration in prod, inside a transaction that rolls back

The local scaffold carries the live bodies of the functions this migration touches, but prod has 39 triggers on `rides` (status pushes, SMS to trusted contacts, share tokens, active-city checks, POI learning…). This step runs the migration and every new function once against prod's real schema and data, then throws everything away. Nothing is sent: `net.http_post` only queues in `net.http_request_queue`, which is transactional (CLAUDE.md § "pg_cron + net.http_post").

**Files:** none.

- [ ] **Step 1: Ask for authorization**

It is DDL against prod, even though it rolls back. Use `AskUserQuestion`: "¿Autorizás ensayar la migración 00628 en producción dentro de una transacción que se deshace al final (no queda nada aplicado y no sale ningún aviso)?", with "Sí, ensayala (Recommended)" first. Do not continue without that answer.

- [ ] **Step 2: Pick a quiet moment**

```sql
SELECT count(*) FILTER (WHERE status = 'searching') AS searching,
       count(*) FILTER (WHERE status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination')) AS active
FROM public.rides;
```

The transaction locks `rides` against writes for its few seconds (the new foreign keys). Prefer a moment with `active = 0`; with a trip in progress, its next status change just waits that long.

- [ ] **Step 3: Run the rehearsal**

Build one query string, in this order, and send it with `mcp__Supabase__execute_sql`:

1. `BEGIN;` and `SET LOCAL statement_timeout = '50s';`
2. the whole content of `supabase/migrations/00628_support_assisted_matching.sql`;
3. this block, which uses the new functions the way the rider and support will, and ends by raising its findings, which rolls the whole transaction back:

```sql
DO $prodcheck$
DECLARE
  v_admin  uuid;
  v_rider  uuid;
  v_driver uuid;
  v_ride   uuid := gen_random_uuid();
  v_auto   integer;
  v_comf   integer;
  v_prop   uuid;
  v_res    jsonb;
  v_out    jsonb := '{}'::jsonb;
  v_n      integer;
BEGIN
  -- A super_admin on purpose: the discount trigger must recompute for one too (the 00628 patch).
  SELECT id INTO v_admin FROM public.users WHERE role = 'super_admin' AND is_active LIMIT 1;
  SELECT id INTO v_rider FROM public.users WHERE role = 'customer' AND is_test AND is_active LIMIT 1;
  -- An offline approved driver with an auto or confort, free, whose balance covers a commission.
  SELECT dp.id INTO v_driver
  FROM public.driver_profiles dp
  WHERE dp.status = 'approved' AND NOT dp.is_online
    AND EXISTS (SELECT 1 FROM public.vehicles v WHERE v.driver_id = dp.id AND v.is_active AND v.type IN ('auto', 'confort'))
    AND NOT EXISTS (SELECT 1 FROM public.rides a WHERE a.driver_id = dp.id
                    AND a.status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination'))
    AND COALESCE((public.driver_can_afford_commission(dp.id, 5000)->>'ok')::boolean, false)
  LIMIT 1;
  IF v_admin IS NULL OR v_rider IS NULL OR v_driver IS NULL THEN
    RAISE EXCEPTION 'PRODCHECK fixtures missing: admin=% rider=% driver=%', v_admin, v_rider, v_driver;
  END IF;
  SELECT GREATEST(min_fare_cup + 500, 2500) INTO v_auto FROM public.service_type_configs WHERE slug = 'auto_standard';
  SELECT GREATEST(min_fare_cup + 500, v_auto + 300) INTO v_comf FROM public.service_type_configs WHERE slug = 'auto_confort';

  -- A searching triciclo ride of a test rider, inserted as scheduled so dispatch skips it, then
  -- made due and two minutes old.
  INSERT INTO public.rides (id, customer_id, service_type, status, payment_method,
    pickup_location, pickup_address, dropoff_location, dropoff_address,
    estimated_fare_cup, estimated_fare_trc, estimated_distance_m, estimated_duration_s,
    passenger_count, ride_mode, scheduled_at)
  VALUES (v_ride, v_rider, 'triciclo_basico', 'searching', 'cash',
    ST_SetSRID(ST_MakePoint(-82.3597, 23.1352), 4326)::geography, 'Prueba 00628 · Paseo del Prado, La Habana',
    ST_SetSRID(ST_MakePoint(-82.3830, 23.1225), 4326)::geography, 'Prueba 00628 · Plaza de la Revolución, La Habana',
    2000, 2000, 3200, 900, 1, 'passenger', now() + interval '1 hour');
  UPDATE public.rides SET scheduled_at = NULL, is_scheduled = false, created_at = now() - interval '2 minutes'
   WHERE id = v_ride;

  -- 1. The rider asks for help.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rider, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rider::text, true);
  SET LOCAL ROLE authenticated;
  v_out := v_out || jsonb_build_object('help', public.request_ride_help(v_ride));
  RESET ROLE;

  -- 2. Support sees it and proposes an auto.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.admin_support_waiting_rides() w
   WHERE w.ride_id = v_ride AND w.help_requested_at IS NOT NULL;
  v_out := v_out || jsonb_build_object('banner', v_n);
  v_res := public.admin_ride_assist_context(v_ride);
  v_out := v_out || jsonb_build_object('context', v_res #>> '{ride,status}');
  SELECT count(*) INTO v_n FROM public.admin_ride_assist_candidates(v_ride, 'auto_standard');
  v_out := v_out || jsonb_build_object('auto_candidates', v_n);
  v_res := public.admin_change_ride_service(v_ride, 'auto_standard', v_auto, 'propose', NULL);
  v_prop := (v_res->>'proposal_id')::uuid;
  v_out := v_out || jsonb_build_object('propose', v_res->>'mode');
  RESET ROLE;

  -- 3. The rider sees it and accepts.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rider, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rider::text, true);
  SET LOCAL ROLE authenticated;
  v_out := v_out || jsonb_build_object('rider_sees', public.get_my_ride_service_proposal(v_ride) ->> 'to_service_type');
  v_res := public.respond_ride_service_proposal(v_prop, true);
  v_out := v_out || jsonb_build_object('accept', v_res);
  RESET ROLE;

  -- 4. Support applies confort with WhatsApp consent, sends the ride to the driver, and assigns it.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  SET LOCAL ROLE authenticated;
  v_out := v_out || jsonb_build_object('apply',
    public.admin_change_ride_service(v_ride, 'auto_confort', v_comf, 'apply', 'Prueba 00628 (rollback)') ->> 'mode');
  v_out := v_out || jsonb_build_object('offer', public.admin_offer_ride_to_driver(v_ride, v_driver) ->> 'mode');
  v_out := v_out || jsonb_build_object('assign_offline',
    public.admin_assign_ride_to_driver(v_ride, v_driver, 'Prueba 00628 (rollback)') ->> 'error');
  RESET ROLE;
  -- The driver comes online (inside this transaction only), then support assigns.
  UPDATE public.driver_profiles SET is_online = true, last_heartbeat_at = now() WHERE id = v_driver;
  SET LOCAL ROLE authenticated;
  v_out := v_out || jsonb_build_object('assign', public.admin_assign_ride_to_driver(v_ride, v_driver, 'Prueba 00628 (rollback)'));
  RESET ROLE;

  -- 5. What complete_ride_and_pay would charge, and what the trail says.
  SELECT jsonb_build_object(
           'status', r.status, 'service_type', r.service_type, 'fare', r.estimated_fare_cup,
           'discount', r.discount_amount_cup, 'driver_ok', r.driver_id = v_driver,
           'snapshot_total', (SELECT s.total FROM public.ride_pricing_snapshots s
                              WHERE s.ride_id = r.id AND s.snapshot_type = 'estimate'),
           'snapshots', (SELECT count(*) FROM public.ride_pricing_snapshots s
                         WHERE s.ride_id = r.id AND s.snapshot_type = 'estimate'),
           'admin_actions', (SELECT jsonb_agg(a.action ORDER BY a.created_at, a.action) FROM public.admin_actions a
                             WHERE a.target_type = 'ride' AND a.target_id = r.id::text))
    INTO v_res
    FROM public.rides r WHERE r.id = v_ride;
  v_out := v_out || jsonb_build_object('ride', v_res);

  -- 6. The cron runs (a test ride never triggers it; real rides it alerts are discarded too).
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v_out := v_out || jsonb_build_object('cron', public.notify_support_waiting_rides());

  -- 7. What would have gone out.
  SELECT jsonb_object_agg(jobname, n) INTO v_res
  FROM (SELECT jobname, count(*) AS n FROM public.cron_http_calls
        WHERE called_at >= now() AND jobname LIKE 'support-%' GROUP BY jobname) q;
  v_out := v_out || jsonb_build_object('queued', v_res);

  RAISE EXCEPTION 'PRODCHECK %', v_out;
END
$prodcheck$;
```

Expected: the call fails with an error whose message starts with `PRODCHECK` and holds:
- `help`: `{"success": true, "code": "<8 characters>"}`; `banner`: `1`; `context`: `"searching"`; `auto_candidates`: a number (0 is possible if no auto driver was seen in 7 days); `propose`: `"propose"`; `rider_sees`: `"auto_standard"`;
- `accept`: `{"success": true, "accepted": true, "service_type": "auto_standard", "fare_cup": <v_auto>}`;
- `apply`: `"apply"`; `offer`: `"created"` or `"extended"` (dispatch may have offered it already); `assign_offline`: `"not_online"`;
- `assign`: `{"success": true, …}`;
- `ride`: `status` `"accepted"`, `service_type` `"auto_confort"`, `fare` = `snapshot_total` = `v_comf`, `snapshots` `1`, `discount` `0`, `driver_ok` `true`, and `admin_actions` with `support_propose_service`, `support_change_service`, `support_offer_ride`, `support_assign_ride`;
- `cron`: a number; `queued`: at least `support-help-alert` 1, `support-help-email` (one per address in `support_alert_email`) and `support-assign-push` 1.

Any other error (a missing column, a trigger refusing, `lock_timeout`) is a finding: stop, fix the migration, re-run Task 20, then this step.

- [ ] **Step 4: Confirm nothing stayed**

```sql
SELECT to_regclass('public.ride_assist') IS NULL                                               AS no_table_1,
       to_regclass('public.ride_service_proposals') IS NULL                                    AS no_table_2,
       NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notify-support-waiting-rides')      AS no_cron,
       NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'request_ride_help')                  AS no_rpc,
       position('app.force_discount_recompute' IN
         (SELECT prosrc FROM pg_proc WHERE oid = 'public.tg_rides_validate_promo_discount()'::regprocedure)) = 0 AS trigger_untouched,
       NOT EXISTS (SELECT 1 FROM public.rides WHERE pickup_address LIKE 'Prueba 00628%')       AS no_ride;
```

Expected: every column `true`.

### Task 22: Pull request, merge, apply, deploy

**Files:** none.

- [ ] **Step 1: Push and update the pull request**

```bash
git push -u origin claude/hopeful-shannon-g3theu
```

PR #1094 (draft) already holds this branch. Update its title to `feat: support-assisted matching (00628)` and its body: what it does (from the spec's "Decisions" and "User-facing behavior"), the migration and its rehearsal (`PASS 73 FAIL 0`, the prod rehearsal of Task 21 with its `PRODCHECK` line), the md5 list of Task 20 step 4, and the rollout order (step 3 onwards). State that the migration is not applied yet. Mark it ready for review once CI is green, and drive CI to green.

- [ ] **Step 2: Ask for authorization to merge and apply**

With CI green, use `AskUserQuestion`: "¿Autorizás el squash-merge de #1094 y aplicar la migración 00628 en producción por MCP?", with "Sí: merge y aplicar 00628 (Recommended)" first. Merge and apply need this explicit answer for this PR (CLAUDE.md § "Merges a master requieren autorización explícita por PR").

- [ ] **Step 3: Merge**

Squash-merge #1094 with `mcp__github__merge_pull_request`.

- [ ] **Step 4: Apply the migration**

`mcp__Supabase__apply_migration` with name `00628_support_assisted_matching` and the file's content. The file has no `DELETE`, `DROP` or `TRUNCATE`, so it should not wait for in-app approval. If the call times out at 60 s anyway, do not resend it blindly: check by object first (step 5); if nothing landed, apply it from the SQL Editor, adding the `\r` clean-up block of CLAUDE.md § "Aplicar migraciones pesadas por MCP" for each function when pasting from Windows.

- [ ] **Step 5: Verify by object**

```sql
SELECT p.proname || '=' || md5(p.prosrc) || '/' || length(p.prosrc)
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (ARRAY[
  '_ride_short_code', '_vehicle_types_for_service', '_driver_can_serve_ride', '_users_blocked', '_html_escape',
  '_write_ride_estimate_snapshot', 'tg_rides_create_estimate_snapshot', 'tg_rides_validate_promo_discount',
  '_ride_service_change_error', '_apply_ride_service_change', 'admin_change_ride_service',
  'get_my_ride_service_proposal', 'respond_ride_service_proposal', 'admin_support_waiting_rides',
  'admin_ride_assist_context', 'admin_ride_assist_candidates', 'admin_offer_ride_to_driver',
  'admin_assign_ride_to_driver', '_support_alert', 'request_ride_help', 'notify_support_waiting_rides'])
ORDER BY 1;

SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'notify-support-waiting-rides';
SELECT key, value FROM public.platform_config WHERE key LIKE 'support_%' ORDER BY key;
```

Expected: the 21 lines equal `/tmp/00628-md5-local.txt` from Task 20 line by line; the cron job is active with `* * * * *`; the five settings are there, `support_alert_email` equal to `business_notification_email`. `schema_migrations` registers an MCP apply by timestamp, so do not look it up by number.

- [ ] **Step 6: Check the deploys**

The merge triggers `deploy-admin.yml` and `deploy-web.yml`. When both runs succeed, open https://admin.tricigo.com (any page: no banner while nothing waits) and https://admin.tricigo.com/settings/platform-config (the five `support_*` keys show their help text). If a route answers 404 although the workflow succeeded, follow CLAUDE.md § "`deploy-web.yml` puede reportar success sin desplegar rutas nuevas".

- [ ] **Step 7: Smoke test with the test account, on the web**

The web carries the help button from this merge on, before any app release.

Dispatch does not skip test accounts (measured 2026-10-07: neither `dispatch_ride`, `find_best_drivers` nor `notify_offline_drivers_for_searching_rides` reads `is_test`). A test ride is offered to real online drivers, and after 60 s offline drivers of that type get the "Conéctate" push. Agree the moment with the founder, check who is online first (`SELECT count(*) FROM driver_profiles WHERE is_online`), keep the test short and cancel at the end.

With a test rider (`users.is_test`) signed in on https://tricigo.com:
1. request a ride and stay on `/track/<id>`;
2. after 45 s tap "¿No aparece conductor? Pide ayuda": WhatsApp opens with "Viaje: <CODE>";
3. within 15 s the admin shows the red banner with "Pidió ayuda" and "Prueba", with a sound if the page was clicked once; the support phones with a push token get "Pasajero pide ayuda · <CODE>"; every address in `support_alert_email` gets the e-mail, whose button opens the assist page;
4. on the assist page: propose another type; the web shows the card; accept it; the track page and the assist page show the new type and price;
5. cancel the ride from the web.

Expected: each step as described. `SELECT jobname, status_code FROM cron_http_calls c JOIN net._http_response r ON r.id = c.request_id WHERE c.jobname LIKE 'support-%' ORDER BY c.called_at DESC LIMIT 10` shows 200 for each alert sent.

### Task 23: Client and driver 1.7.4

**Files:**
- Modify: `apps/client/app.json`, `apps/driver/app.json` (`expo.version` → `1.7.4`), in a separate release PR, as #1005 did for 1.7.3.

The button, the card and the driver's pickup reach phones only with new builds. Releasing is the founder's decision: ask before opening the release PR, and again before each merge and each store submission.

- [ ] **Step 1: The release PR**

On a fresh branch from `origin/master`, change `"version": "1.7.3"` to `"version": "1.7.4"` in both `app.json` files; commit `chore(release): client + driver 1.7.4`; open the PR; merge only with the founder's explicit OK.

- [ ] **Step 2: Build**

Follow CLAUDE.md § "Publicar una versión en las tiendas" (parity check against the Android build, `eas build` per app and platform from the merged commit).

- [ ] **Step 3: End-to-end check before submitting**

With the 1.7.4 builds on two phones (test rider, test driver) and the admin open. The same caution as Task 22, step 7 applies: real drivers see these rides too.
1. the rider requests a triciclo ride; after 45 s, "¿No aparece conductor? Pide ayuda" opens WhatsApp with the code, and support gets the push and the e-mail;
2. support proposes an auto; the rider's card shows it with its price and countdown; the rider accepts; the searching screen shows the new type and price within 3 s;
3. support sends the ride as an offer to the test driver (who must have an auto); the driver's phone gets the usual offer and accepts it;
4. the trip is completed; the amount charged (`rides.final_fare_cup`) equals the accepted price minus `discount_amount_cup` plus waiting charges;
5. with a second ride, support assigns it directly to the test driver while the driver app sits open on the home screen: the trip appears within seconds, with the "Soporte te asignó un viaje" toast and sound. Repeat with the app in the background: tapping the push opens the trip.

- [ ] **Step 4: Support staff**

Each person on support installs the TriciGo app, signs in with their admin account and allows notifications (today 1 of the 5 admins has a push token: `SELECT u.full_name, count(d.*) FROM users u LEFT JOIN user_devices d ON d.user_id = u.id WHERE u.role IN ('admin','super_admin') AND u.is_active GROUP BY 1`).
