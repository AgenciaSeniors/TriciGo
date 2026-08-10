# Partner Places & Arrival Coupons Implementation Plan

> ## ⚠️ SUPERSEDED on 2026-08-09 — executed, then undone. Do not run this plan.
>
> This plan shipped as PR #914 (migrations 00532–00536). Nine days later the
> model changed: partner places stopped being **counter coupons the business
> absorbed** and became a **fare discount the platform absorbs out of its own
> commission** (PR #949, migrations 00558–00564). Everything below — the
> coupons table, the code generator, the issuance trigger, the five redemption
> RPCs, the reminder cron and the public `/v` validation page — has since been
> deleted.
>
> Kept as the record of a design that was really built and really reversed.
>
> **The model in production is described in
> [`../specs/2026-08-09-partner-places-fare-discount.md`](../specs/2026-08-09-partner-places-fare-discount.md).**

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin configures a partner business with coordinates and a negotiated perk; any ride ending within that place's radius issues the passenger a single-use coupon, redeemable at the counter and verifiable by the business on a public page.

**Architecture:** Two new tables (`partner_places`, `partner_coupons`). Issuance runs in an `AFTER UPDATE` trigger on `rides` — not inside `complete_ride_and_pay`, because two distinct code paths move a ride to `completed`. Five RPCs cover discovery, the passenger's live coupons, and business-side validate/redeem. A 5-minute `pg_cron` job pushes a reminder at 30 minutes remaining. No money moves anywhere: the business absorbs the perk, so nothing touches the ledger.

**Tech Stack:** Postgres 15 + PostGIS + pg_cron + pg_net (Supabase), TypeScript strict, Expo/React Native (client), Next.js App Router (admin + web), vitest, i18next.

**Spec:** [`docs/superpowers/specs/2026-07-31-partner-places-discounts-design.md`](../specs/2026-07-31-partner-places-discounts-design.md)

---

## Before you start

**Re-check the migration numbers.** This plan uses **00532–00536**. `origin/master` is at `00528` and no open PR adds migrations, but a parallel session can land those numbers while you work. Run this immediately before your first commit and again before pushing:

```bash
git fetch origin master && git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -5
```

If the numbers are taken, shift the whole block up and keep it contiguous.

**You cannot apply migrations to production.** The Supabase MCP guard denies `apply_migration` and DDL through `execute_sql`. Migrations get committed to git; a human applies them. **Every client-side reader in this plan must therefore tolerate the RPC not existing yet** — this is not defensive padding, it is the state the code ships in.

**Install dependencies first** — each worktree has its own `node_modules`:

```bash
pnpm install
```

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/00532_partner_places_schema.sql` | Both tables, indexes, RLS policies, the `platform_config` key, the `notifications.type` CHECK extension |
| `supabase/migrations/00533_partner_coupon_issuance.sql` | Code generator + the `rides` trigger |
| `supabase/migrations/00534_partner_coupon_rpcs.sql` | The five RPCs |
| `supabase/migrations/00535_partner_coupon_reminder_cron.sql` | Reminder function + cron schedule |
| `supabase/migrations/00536_partner_places_admin_rpcs.sql` | Admin list (with the issued/redeemed counters) + upsert |
| `supabase/verify-partner-coupons.sql` | Post-apply verification, run by whoever applies the migrations |
| `supabase/functions/send-push/index.ts` | Add `partner_coupon` to `VALID_CATEGORIES` and the preference map |
| `packages/types/src/partner-place.ts` | `PartnerPlace`, `PartnerCoupon`, `CouponValidation` types (own module — `index.ts` there is a pure barrel) |
| `packages/api/src/services/partner-place.service.ts` | All RPC wrappers, one place |
| `packages/api/src/services/__tests__/partner-place.test.ts` | Service-layer tests |
| `packages/api/src/index.ts` | Export the service + types |
| `apps/admin/src/app/partners/page.tsx` | Admin list + form |
| `apps/admin/src/components/PartnerPlacePicker.tsx` | Leaflet map picker showing the real match radius |
| `apps/admin/src/components/layout/Sidebar.tsx` | Nav entry |
| `apps/client/src/components/PartnerPlacesCarousel.tsx` | Home hero carousel |
| `apps/client/src/components/PartnerCouponBanner.tsx` | Live-coupon banner (both home states) |
| `apps/client/app/coupon/[id].tsx` | The ticket screen |
| `apps/client/app/(tabs)/index.tsx` | Mount carousel + banner |
| `apps/web/src/app/v/[token]/page.tsx` | Public validation page, one secret link per business |
| `apps/web/src/app/v/page.tsx` | Bare `/v` — explains that each business has its own link |
| `apps/web/src/components/HomeDashboard.tsx` | Web parity section |
| `packages/i18n/src/locales/{es,en,pt}/{rider,admin}.json` | Copy |

---

## Task 1: Schema, RLS and config

**Files:**
- Create: `supabase/migrations/00532_partner_places_schema.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00532_partner_places_schema.sql
-- Partner places: an admin-configured business that gives a perk to any
-- passenger whose ride ends there. The business absorbs the perk — nothing
-- in this feature touches wallets or the ledger.
--
-- Standalone by design: no FK to cuba_pois. Eligibility is decided by
-- proximity to the ride's dropoff, so a passenger who reached the business
-- through ordinary address search still earns the coupon. See the spec.

CREATE TABLE IF NOT EXISTS public.partner_places (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT NOT NULL,
  location             GEOGRAPHY(Point, 4326) NOT NULL,
  address              TEXT,
  municipality         TEXT,
  province             TEXT,
  category             TEXT NOT NULL DEFAULT 'other',
  photo_url            TEXT,
  benefit_title        TEXT NOT NULL,
  benefit_description  TEXT NOT NULL,
  terms                TEXT,
  radius_m             INT NOT NULL DEFAULT 80  CHECK (radius_m BETWEEN 20 AND 2000),
  coupon_ttl_minutes   INT NOT NULL DEFAULT 120 CHECK (coupon_ttl_minutes BETWEEN 15 AND 10080),
  -- 0 = unlimited. Parked knob: the user chose no frequency cap, but a
  -- business that gets burned will ask for one and this avoids a code change.
  cooldown_days        INT NOT NULL DEFAULT 0   CHECK (cooldown_days >= 0),
  is_active            BOOLEAN NOT NULL DEFAULT true,
  valid_until          TIMESTAMPTZ,
  phone                TEXT,
  hours                TEXT,
  created_by           UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partner_places_location_gix
  ON public.partner_places USING GIST (location);
CREATE INDEX IF NOT EXISTS partner_places_active_idx
  ON public.partner_places (is_active) WHERE is_active;

CREATE TABLE IF NOT EXISTS public.partner_coupons (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_place_id  UUID NOT NULL REFERENCES public.partner_places(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  ride_id           UUID NOT NULL REFERENCES public.rides(id) ON DELETE CASCADE,
  code              TEXT NOT NULL UNIQUE,
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  redeemed_at       TIMESTAMPTZ,
  -- 'business' = verified on the public validation page.
  -- 'self'     = the passenger tapped "Ya lo usé". A claim, not evidence.
  redeemed_via      TEXT CHECK (redeemed_via IN ('business', 'self')),
  reminded_at       TIMESTAMPTZ,
  CONSTRAINT partner_coupons_ride_place_uniq UNIQUE (ride_id, partner_place_id)
);

CREATE INDEX IF NOT EXISTS partner_coupons_user_live_idx
  ON public.partner_coupons (user_id, expires_at DESC) WHERE redeemed_at IS NULL;
CREATE INDEX IF NOT EXISTS partner_coupons_place_idx
  ON public.partner_coupons (partner_place_id);
CREATE INDEX IF NOT EXISTS partner_coupons_reminder_idx
  ON public.partner_coupons (expires_at) WHERE redeemed_at IS NULL AND reminded_at IS NULL;

-- ── RLS ───────────────────────────────────────────────────────────────
ALTER TABLE public.partner_places  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_coupons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_places_select_auth ON public.partner_places;
CREATE POLICY partner_places_select_auth ON public.partner_places
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS partner_places_admin_all ON public.partner_places;
CREATE POLICY partner_places_admin_all ON public.partner_places
  FOR ALL TO authenticated
  USING (COALESCE(public.is_admin(), false))
  WITH CHECK (COALESCE(public.is_admin(), false));

-- A passenger sees only their own coupons. No INSERT policy at all:
-- issuance happens exclusively inside the SECURITY DEFINER trigger.
DROP POLICY IF EXISTS partner_coupons_select_own ON public.partner_coupons;
CREATE POLICY partner_coupons_select_own ON public.partner_coupons
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR COALESCE(public.is_admin(), false));

-- ── Config ────────────────────────────────────────────────────────────
INSERT INTO public.platform_config (key, value)
VALUES ('partner_places_discovery_radius_m', '15000')
ON CONFLICT (key) DO NOTHING;

-- ── notifications.type CHECK ──────────────────────────────────────────
-- send-push inserts the category verbatim as notifications.type. Without
-- this the push 400s at the EF and, if it got past, would violate the CHECK.
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
  CHECK (type = ANY (ARRAY[
    'ride','ride_offer','ride_matching','chat','proximity','payment',
    'wallet_recharge','wallet_recharge_refund','wallet_credit','wallet_debit',
    'scheduled_ride','lost_item','dispute_update','sos','delivery','system',
    'promo','announcement','blog','news','campaign','ride_updates',
    'wallet_v2_migration',
    'partner_coupon'
  ]));

COMMENT ON TABLE public.partner_places IS
  '00532 Admin-configured partner businesses. The business absorbs the perk; no ledger involvement.';
COMMENT ON COLUMN public.partner_coupons.redeemed_via IS
  '00532 business = verified on tricigo.com/v; self = passenger self-reported. Only the first is evidence.';
```

- [ ] **Step 2: Verify the file parses as SQL**

Run: `node -e "const s=require('fs').readFileSync('supabase/migrations/00532_partner_places_schema.sql','utf8'); if(!/CREATE TABLE IF NOT EXISTS public\.partner_coupons/.test(s)) throw new Error('missing table'); console.log('ok', s.length, 'chars')"`
Expected: `ok <n> chars`

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00532_partner_places_schema.sql
git commit -m "feat(partners): partner_places and partner_coupons schema with RLS"
```

---

## Task 2: Coupon code generator + issuance trigger

**Files:**
- Create: `supabase/migrations/00533_partner_coupon_issuance.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00533_partner_coupon_issuance.sql
-- Issues a coupon when a ride completes inside a partner place's radius.

-- Six characters from a 31-symbol alphabet with 0/1/I/L/O removed, because
-- the code is read aloud across a noisy counter. 31^6 ≈ 887M — six rather
-- than four specifically because the validation page is public and a short
-- code invites brute-forcing other people's coupons into the "used" state.
--
-- Uses pgcrypto (schema `extensions`), not random(): a predictable PRNG is
-- exactly the weakness that makes a public redeem endpoint attackable.
-- Rejection sampling above 248 keeps the distribution uniform (248 = 31*8).
CREATE OR REPLACE FUNCTION public._generate_coupon_code()
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  c_alphabet CONSTANT TEXT := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  v_code TEXT := '';
  v_byte INT;
BEGIN
  WHILE length(v_code) < 6 LOOP
    v_byte := get_byte(extensions.gen_random_bytes(1), 0);
    IF v_byte < 248 THEN
      v_code := v_code || substr(c_alphabet, (v_byte % 31) + 1, 1);
    END IF;
  END LOOP;
  RETURN v_code;
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_rides_issue_partner_coupons()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_place       RECORD;
  v_code        TEXT;
  v_coupon_id   UUID;
  v_expires     TIMESTAMPTZ;
  v_attempts    INT;
  v_service_key TEXT;
BEGIN
  IF NEW.dropoff_location IS NULL OR NEW.customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  FOR v_place IN
    SELECT pp.*
    FROM public.partner_places pp
    WHERE pp.is_active
      AND (pp.valid_until IS NULL OR pp.valid_until > now())
      AND ST_DWithin(pp.location, NEW.dropoff_location, pp.radius_m)
  LOOP
    -- Frequency cap. cooldown_days = 0 (the shipped default) skips this.
    IF v_place.cooldown_days > 0 AND EXISTS (
      SELECT 1 FROM public.partner_coupons pc
      WHERE pc.partner_place_id = v_place.id
        AND pc.user_id = NEW.customer_id
        AND pc.issued_at > now() - make_interval(days => v_place.cooldown_days)
    ) THEN
      CONTINUE;
    END IF;

    -- Deduplication, NOT a frequency cap: while a live unredeemed coupon
    -- exists for this place, don't mint a second one. Two valid codes for
    -- one free coffee is what the business does not want at the counter.
    -- Once it is redeemed or expires, the next qualifying ride issues again.
    IF EXISTS (
      SELECT 1 FROM public.partner_coupons pc
      WHERE pc.partner_place_id = v_place.id
        AND pc.user_id = NEW.customer_id
        AND pc.redeemed_at IS NULL
        AND pc.expires_at > now()
    ) THEN
      CONTINUE;
    END IF;

    v_expires := now() + make_interval(mins => v_place.coupon_ttl_minutes);
    v_coupon_id := NULL;
    v_attempts := 0;

    WHILE v_coupon_id IS NULL AND v_attempts < 5 LOOP
      v_attempts := v_attempts + 1;
      v_code := public._generate_coupon_code();
      BEGIN
        INSERT INTO public.partner_coupons
          (partner_place_id, user_id, ride_id, code, expires_at)
        VALUES (v_place.id, NEW.customer_id, NEW.id, v_code, v_expires)
        ON CONFLICT ON CONSTRAINT partner_coupons_ride_place_uniq DO NOTHING
        RETURNING id INTO v_coupon_id;
        -- DO NOTHING fired: this ride already has a coupon for this place
        -- (the ride re-entered 'completed'). Nothing to do, and no retry.
        EXIT WHEN v_coupon_id IS NULL;
      EXCEPTION WHEN unique_violation THEN
        -- Code collision only. Loop and draw another.
        v_coupon_id := NULL;
      END;
    END LOOP;

    IF v_coupon_id IS NULL THEN
      CONTINUE;
    END IF;

    v_service_key := public.get_service_role_key();
    IF v_service_key IS NULL OR v_service_key = '' THEN
      CONTINUE;
    END IF;

    PERFORM net.http_post(
      url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_service_key,
        'apikey',        v_service_key
      ),
      body := jsonb_build_object(
        'user_id',  NEW.customer_id::text,
        'title',    'Llegaste a ' || v_place.name,
        'body',     v_place.benefit_title || '. Muestra tu cupón antes de las '
                    || to_char(v_expires AT TIME ZONE 'America/Havana', 'HH24:MI') || '.',
        'category', 'partner_coupon',
        'data', jsonb_build_object(
          'type',       'partner_coupon',
          'coupon_id',  v_coupon_id::text,
          'place_name', v_place.name,
          'expires_at', v_expires
        )
      )
    );
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A marketing perk must NEVER block the completion or payment of a ride.
  RAISE WARNING '[tg_rides_issue_partner_coupons] ride %: % %', NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rides_issue_partner_coupons ON public.rides;
CREATE TRIGGER trg_rides_issue_partner_coupons
  AFTER UPDATE OF status ON public.rides
  FOR EACH ROW
  WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION public.tg_rides_issue_partner_coupons();
```

- [ ] **Step 2: Verify the file parses and the guards are present**

Run:
```bash
node -e "const s=require('fs').readFileSync('supabase/migrations/00533_partner_coupon_issuance.sql','utf8'); for (const p of ['EXCEPTION WHEN OTHERS','gen_random_bytes','ST_DWithin','partner_coupons_ride_place_uniq']) if(!s.includes(p)) throw new Error('missing: '+p); console.log('ok')"
```
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00533_partner_coupon_issuance.sql
git commit -m "feat(partners): issue arrival coupons from a defensive rides trigger"
```

---

## Task 3: The five RPCs

**Files:**
- Create: `supabase/migrations/00534_partner_coupon_rpcs.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00534_partner_coupon_rpcs.sql

-- ── Discovery ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_nearby_partner_places(
  p_lat   DOUBLE PRECISION,
  p_lng   DOUBLE PRECISION,
  p_limit INT DEFAULT 10
)
RETURNS TABLE (
  id UUID, name TEXT, benefit_title TEXT, benefit_description TEXT,
  terms TEXT, photo_url TEXT, category TEXT, address TEXT,
  municipality TEXT, phone TEXT, hours TEXT,
  latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
  distance_m DOUBLE PRECISION, has_active_coupon BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_origin GEOGRAPHY;
  v_radius NUMERIC;
BEGIN
  IF auth.uid() IS NULL OR p_lat IS NULL OR p_lng IS NULL THEN
    RETURN;
  END IF;

  v_origin := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
  v_radius := public.get_platform_config_numeric('partner_places_discovery_radius_m', 15000);

  RETURN QUERY
  SELECT pp.id, pp.name, pp.benefit_title, pp.benefit_description,
         pp.terms, pp.photo_url, pp.category, pp.address,
         pp.municipality, pp.phone, pp.hours,
         ST_Y(pp.location::geometry), ST_X(pp.location::geometry),
         ST_Distance(pp.location, v_origin),
         EXISTS (
           SELECT 1 FROM public.partner_coupons pc
           WHERE pc.partner_place_id = pp.id
             AND pc.user_id = auth.uid()
             AND pc.redeemed_at IS NULL
             AND pc.expires_at > now()
         )
  FROM public.partner_places pp
  WHERE pp.is_active
    AND (pp.valid_until IS NULL OR pp.valid_until > now())
    AND ST_DWithin(pp.location, v_origin, v_radius)
  ORDER BY ST_Distance(pp.location, v_origin)
  LIMIT GREATEST(COALESCE(p_limit, 10), 1);
END;
$$;

-- ── The passenger's live coupons ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_partner_coupons()
RETURNS TABLE (
  id UUID, code TEXT, place_name TEXT, benefit_title TEXT,
  benefit_description TEXT, terms TEXT, photo_url TEXT, category TEXT,
  address TEXT, phone TEXT, hours TEXT,
  issued_at TIMESTAMPTZ, expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT pc.id, pc.code, pp.name, pp.benefit_title, pp.benefit_description,
         pp.terms, pp.photo_url, pp.category, pp.address, pp.phone, pp.hours,
         pc.issued_at, pc.expires_at
  FROM public.partner_coupons pc
  JOIN public.partner_places pp ON pp.id = pc.partner_place_id
  WHERE pc.user_id = auth.uid()
    AND pc.redeemed_at IS NULL
    AND pc.expires_at > now()
  ORDER BY pc.expires_at ASC;
END;
$$;

-- ── Shared code normaliser ────────────────────────────────────────────
-- The employee types what they see. Accept 'tg-k7m2qx', 'K7M2QX', 'k7 m2 qx'.
CREATE OR REPLACE FUNCTION public._normalize_coupon_code(p_raw TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  WITH stripped AS (
    SELECT regexp_replace(upper(COALESCE(p_raw, '')), '[^A-Z0-9]', '', 'g') AS s
  )
  SELECT CASE
           -- Strip the display prefix ONLY when doing so leaves exactly six
           -- characters. Both 'T' and 'G' are in the code alphabet, so a
           -- legitimate code can itself begin "TG" (e.g. TG4K9P). Stripping
           -- unconditionally would truncate it to four characters and make
           -- roughly 1 in 961 coupons permanently unredeemable — a failure
           -- the passenger could never work around and the shop could never
           -- explain.
           WHEN length(s) = 8 AND s LIKE 'TG%' THEN substr(s, 3)
           ELSE s
         END
  FROM stripped;
$$;

-- ── Rate-limit helper for the public endpoints ────────────────────────
CREATE OR REPLACE FUNCTION public._coupon_rate_limit_ok(p_scope TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_ip      TEXT;
  v_allowed BOOLEAN;
BEGIN
  v_ip := COALESCE(
    NULLIF(split_part(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ',', 1), ''),
    'unknown'
  );
  SELECT allowed INTO v_allowed
  FROM public.check_rate_limit(p_scope || ':' || v_ip, 30, 600);
  RETURN COALESCE(v_allowed, false);
EXCEPTION WHEN OTHERS THEN
  -- Rate limiter unavailable. Fail CLOSED on a public write endpoint.
  RETURN false;
END;
$$;

-- ── Validation (public, no login) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.validate_partner_coupon(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_code TEXT;
  v_row  RECORD;
BEGIN
  IF NOT public._coupon_rate_limit_ok('coupon_validate') THEN
    RETURN jsonb_build_object('status', 'rate_limited');
  END IF;

  v_code := public._normalize_coupon_code(p_code);
  IF length(v_code) <> 6 THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT pc.id, pc.expires_at, pc.redeemed_at, pc.issued_at,
         pp.name AS place_name, pp.benefit_title, pp.terms,
         u.full_name
  INTO v_row
  FROM public.partner_coupons pc
  JOIN public.partner_places pp ON pp.id = pc.partner_place_id
  JOIN public.users u           ON u.id  = pc.user_id
  WHERE pc.code = v_code;

  IF NOT FOUND THEN
    -- No hint about which codes exist.
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_row.redeemed_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'used', 'redeemed_at', v_row.redeemed_at);
  END IF;

  IF v_row.expires_at <= now() THEN
    RETURN jsonb_build_object('status', 'expired', 'expires_at', v_row.expires_at);
  END IF;

  RETURN jsonb_build_object(
    'status',        'valid',
    'place_name',    v_row.place_name,
    'benefit_title', v_row.benefit_title,
    'terms',         v_row.terms,
    -- First name plus last initial only. Enough to match the person at the
    -- counter, not enough to harvest identities by probing codes.
    'customer',      split_part(COALESCE(v_row.full_name, ''), ' ', 1)
                     || CASE
                          WHEN split_part(COALESCE(v_row.full_name, ''), ' ', 2) <> ''
                          THEN ' ' || left(split_part(v_row.full_name, ' ', 2), 1) || '.'
                          ELSE ''
                        END,
    'arrived_at',    v_row.issued_at,
    'expires_at',    v_row.expires_at
  );
END;
$$;

-- ── Redemption by the business (public, no login) ─────────────────────
CREATE OR REPLACE FUNCTION public.redeem_partner_coupon(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_code TEXT;
  v_id   UUID;
BEGIN
  IF NOT public._coupon_rate_limit_ok('coupon_redeem') THEN
    RETURN jsonb_build_object('status', 'rate_limited');
  END IF;

  v_code := public._normalize_coupon_code(p_code);
  IF length(v_code) <> 6 THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- Atomic claim, same shape as the NETOPIA webhook. Two employees hitting
  -- the same code concurrently: one wins, the other is told it is used.
  UPDATE public.partner_coupons
  SET redeemed_at = now(), redeemed_via = 'business'
  WHERE code = v_code
    AND redeemed_at IS NULL
    AND expires_at > now()
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'redeemed');
  END IF;

  -- Lost the race, already used, expired, or never existed. Re-read to say which.
  RETURN public.validate_partner_coupon(p_code);
END;
$$;

-- ── "Ya lo usé" — the offline fallback ────────────────────────────────
CREATE OR REPLACE FUNCTION public.redeem_own_partner_coupon(p_coupon_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthenticated');
  END IF;

  UPDATE public.partner_coupons
  SET redeemed_at = now(), redeemed_via = 'self'
  WHERE id = p_coupon_id
    AND user_id = auth.uid()
    AND redeemed_at IS NULL
    AND expires_at > now()
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('status', CASE WHEN v_id IS NULL THEN 'unavailable' ELSE 'redeemed' END);
END;
$$;

-- ── Grants ────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.get_nearby_partner_places(DOUBLE PRECISION, DOUBLE PRECISION, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_my_partner_coupons() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.redeem_own_partner_coupon(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_partner_coupon(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.redeem_partner_coupon(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._coupon_rate_limit_ok(TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_nearby_partner_places(DOUBLE PRECISION, DOUBLE PRECISION, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_partner_coupons() TO authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_own_partner_coupon(UUID) TO authenticated;
-- Deliberately anon: the shop employee has no TriciGo account and never will.
GRANT EXECUTE ON FUNCTION public.validate_partner_coupon(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_partner_coupon(TEXT)  TO anon, authenticated;
```

- [ ] **Step 2: Verify the file**

Run:
```bash
node -e "const s=require('fs').readFileSync('supabase/migrations/00534_partner_coupon_rpcs.sql','utf8'); for (const p of ['GRANT EXECUTE ON FUNCTION public.validate_partner_coupon(TEXT) TO anon','redeemed_at IS NULL','RETURN false']) if(!s.includes(p)) throw new Error('missing: '+p); console.log('ok')"
```
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00534_partner_coupon_rpcs.sql
git commit -m "feat(partners): discovery, listing and public validate/redeem RPCs"
```

---

## Task 4: Reminder cron

**Files:**
- Create: `supabase/migrations/00535_partner_coupon_reminder_cron.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00535_partner_coupon_reminder_cron.sql
-- One reminder push when ~30 minutes remain on an unredeemed coupon.
--
-- Two guards, both required and doing DIFFERENT jobs:
--   • the 25–35 min window against a 5-min cadence => caught AT LEAST once
--     (no coupon slips between ticks)
--   • reminded_at                                  => pushed AT MOST once
--     (a coupon caught by two consecutive ticks only fires on the first)
-- Removing either one breaks the guarantee it owns.

CREATE OR REPLACE FUNCTION public.notify_expiring_partner_coupons()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_row         RECORD;
  v_service_key TEXT;
  v_headers     JSONB;
  v_sent        INT := 0;
BEGIN
  v_service_key := public.get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_service_key');
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type',  'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey',        v_service_key
  );

  FOR v_row IN
    SELECT pc.id, pc.user_id, pc.expires_at, pp.name AS place_name, pp.benefit_title
    FROM public.partner_coupons pc
    JOIN public.partner_places pp ON pp.id = pc.partner_place_id
    WHERE pc.redeemed_at IS NULL
      AND pc.reminded_at IS NULL
      AND pc.expires_at > now() + interval '25 minutes'
      AND pc.expires_at <= now() + interval '35 minutes'
  LOOP
    -- cron_http_post, never raw net.http_post: a cron calling an Edge
    -- Function through the raw call is BLIND to HTTP failures —
    -- cron.job_run_details reports success while the call 502s. That
    -- blindness is what froze the exchange rate for four days.
    PERFORM public.cron_http_post(
      'partner-coupon-reminder',
      url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := v_headers,
      body    := jsonb_build_object(
        'user_id',  v_row.user_id::text,
        'title',    'Te queda media hora',
        'body',     '¿Sigues en ' || v_row.place_name || '? Tu '
                    || lower(v_row.benefit_title) || ' vence a las '
                    || to_char(v_row.expires_at AT TIME ZONE 'America/Havana', 'HH24:MI') || '.',
        'category', 'partner_coupon',
        'data', jsonb_build_object(
          'type',      'partner_coupon',
          'coupon_id', v_row.id::text,
          'expires_at', v_row.expires_at
        )
      )
    );

    UPDATE public.partner_coupons SET reminded_at = now() WHERE id = v_row.id;
    v_sent := v_sent + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'sent', v_sent);
END;
$$;

REVOKE ALL ON FUNCTION public.notify_expiring_partner_coupons() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  PERFORM cron.unschedule('partner-coupon-reminder');
EXCEPTION WHEN OTHERS THEN
  NULL;  -- not scheduled yet
END $$;

SELECT cron.schedule(
  'partner-coupon-reminder',
  '*/5 * * * *',
  $cron$ SELECT public.notify_expiring_partner_coupons(); $cron$
);
```

- [ ] **Step 2: Verify the file**

Run:
```bash
node -e "const s=require('fs').readFileSync('supabase/migrations/00535_partner_coupon_reminder_cron.sql','utf8'); if(!s.includes('cron_http_post')) throw new Error('must use cron_http_post'); if(/PERFORM net\.http_post/.test(s)) throw new Error('raw net.http_post in a cron path'); console.log('ok')"
```
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00535_partner_coupon_reminder_cron.sql
git commit -m "feat(partners): 30-minute coupon reminder cron via cron_http_post"
```

---

## Task 5: Whitelist the push category

**Files:**
- Modify: `supabase/functions/send-push/index.ts:48-79` and `:102-123`

- [ ] **Step 1: Add the category to `VALID_CATEGORIES`**

In the `VALID_CATEGORIES` set, immediately after `'campaign',`:

```ts
  'campaign',
  // Partner-place arrival coupons (00532). The CHECK constraint on
  // notifications.type was extended in the same migration.
  'partner_coupon',
```

- [ ] **Step 2: Add the preference mapping**

In `FILTERABLE_CATEGORY_TO_PREF`, after `campaign: 'promotions',`:

```ts
  campaign: 'promotions',
  // A partner coupon is a perk the passenger earned, but it is still
  // promotional in nature. Someone who turned promotions off has said they
  // do not want this — honour that rather than reclassifying it to sneak past.
  partner_coupon: 'promotions',
```

- [ ] **Step 3: Verify the EF still type-checks**

Run: `npx tsc --noEmit --strict --skipLibCheck --moduleResolution bundler --target es2022 supabase/functions/send-push/index.ts 2>&1 | grep -v "Cannot find module 'https://" | grep "error TS" | head`
Expected: no output beyond remote-import errors (the sandbox proxy blocks `esm.sh`, so `deno check` is unavailable — remote-module errors are expected and pre-existing)

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/send-push/index.ts
git commit -m "feat(push): whitelist the partner_coupon category"
```

---

## Task 6: Types and service layer (TDD)

**Files:**
- Modify: `packages/types/src/index.ts`
- Create: `packages/api/src/services/partner-place.service.ts`
- Test: `packages/api/src/services/__tests__/partner-place.test.ts`
- Modify: `packages/api/src/index.ts`

- [ ] **Step 1: Add the types**

Append to `packages/types/src/index.ts`:

```ts
// ── Partner places & arrival coupons (00532) ──────────────────────────
export interface PartnerPlace {
  id: string;
  name: string;
  benefit_title: string;
  benefit_description: string;
  terms: string | null;
  photo_url: string | null;
  category: string;
  address: string | null;
  municipality: string | null;
  phone: string | null;
  hours: string | null;
  latitude: number;
  longitude: number;
  distance_m: number;
  has_active_coupon: boolean;
}

export interface PartnerCoupon {
  id: string;
  code: string;
  place_name: string;
  benefit_title: string;
  benefit_description: string;
  terms: string | null;
  photo_url: string | null;
  category: string;
  address: string | null;
  phone: string | null;
  hours: string | null;
  issued_at: string;
  expires_at: string;
}

export type CouponValidationStatus =
  | 'valid' | 'used' | 'expired' | 'not_found' | 'rate_limited' | 'redeemed'
  // The URL's business token did not resolve. Distinct from not_found, which
  // means the token was good but that business never issued this code.
  | 'invalid_link'
  // The two below come only from redeem_own_partner_coupon — the "Ya lo usé"
  // fallback the passenger taps when the shop cannot open the validation page.
  // Neither is an error: 'unavailable' is the ordinary answer to a double-tap
  // or to tapping after the coupon expired or was already redeemed at the
  // counter, and it is the one the ticket screen most needs to distinguish.
  | 'unavailable'
  | 'unauthenticated';

export interface CouponValidation {
  status: CouponValidationStatus;
  place_name?: string;
  benefit_title?: string;
  terms?: string | null;
  customer?: string;
  arrived_at?: string;
  expires_at?: string;
  redeemed_at?: string;
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/api/src/services/__tests__/partner-place.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
const mockSupabase = { rpc: mockRpc };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

import { partnerPlaceService } from '../partner-place.service';

const COUPON = '11111111-1111-1111-1111-111111111111';

describe('partnerPlaceService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('getNearby', () => {
    it('maps lat/lng/limit to the RPC params', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });
      await partnerPlaceService.getNearby(23.1136, -82.3666, 5);
      expect(mockRpc).toHaveBeenCalledWith('get_nearby_partner_places', {
        p_lat: 23.1136, p_lng: -82.3666, p_limit: 5,
      });
    });

    it('returns the rows', async () => {
      const rows = [{ id: 'a', name: 'Sylvain', benefit_title: 'Café gratis' }];
      mockRpc.mockResolvedValueOnce({ data: rows, error: null });
      expect(await partnerPlaceService.getNearby(1, 2)).toEqual(rows);
    });

    // The migration ships before it is applied to prod (MCP guard). A missing
    // RPC must degrade to "no section", never to a crash or an error toast.
    it('returns [] when the RPC does not exist yet', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function' },
      });
      expect(await partnerPlaceService.getNearby(1, 2)).toEqual([]);
    });

    it('returns [] on any other error rather than throwing', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'denied' } });
      expect(await partnerPlaceService.getNearby(1, 2)).toEqual([]);
    });
  });

  describe('getMyCoupons', () => {
    it('calls the RPC with no arguments', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });
      await partnerPlaceService.getMyCoupons();
      expect(mockRpc).toHaveBeenCalledWith('get_my_partner_coupons', {});
    });

    it('returns [] when the RPC is absent', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'nope' } });
      expect(await partnerPlaceService.getMyCoupons()).toEqual([]);
    });
  });

  describe('validateCode', () => {
    it('passes the raw code through — the RPC normalises it', async () => {
      mockRpc.mockResolvedValueOnce({ data: { status: 'valid' }, error: null });
      await partnerPlaceService.validateCode('a7f3k2b91c04', 'tg-k7m2qx');
      expect(mockRpc).toHaveBeenCalledWith('validate_partner_coupon', {
        p_token: 'a7f3k2b91c04', p_code: 'tg-k7m2qx',
      });
    });

    it('returns the verdict object', async () => {
      const verdict = { status: 'valid', place_name: 'Sylvain', customer: 'Eduardo P.' };
      mockRpc.mockResolvedValueOnce({ data: verdict, error: null });
      expect(await partnerPlaceService.validateCode('a7f3k2b91c04', 'K7M2QX')).toEqual(verdict);
    });

    // This one is public and business-facing: an error must surface, not be
    // swallowed into a green screen that makes the shop give away a coffee.
    it('propagates the RPC error', async () => {
      const err = { message: 'boom', code: 'X' };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });
      await expect(partnerPlaceService.validateCode('a7f3k2b91c04', 'K7M2QX')).rejects.toEqual(err);
    });
  });

  describe('redeemCode', () => {
    it('calls redeem_partner_coupon', async () => {
      mockRpc.mockResolvedValueOnce({ data: { status: 'redeemed' }, error: null });
      expect(await partnerPlaceService.redeemCode('a7f3k2b91c04', 'K7M2QX')).toEqual({ status: 'redeemed' });
      expect(mockRpc).toHaveBeenCalledWith('redeem_partner_coupon', {
        p_token: 'a7f3k2b91c04', p_code: 'K7M2QX',
      });
    });

    it('propagates the RPC error', async () => {
      const err = { message: 'boom', code: 'X' };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });
      await expect(partnerPlaceService.redeemCode('a7f3k2b91c04', 'K7M2QX')).rejects.toEqual(err);
    });
  });

  describe('redeemOwn', () => {
    it('calls redeem_own_partner_coupon with the coupon id', async () => {
      mockRpc.mockResolvedValueOnce({ data: { status: 'redeemed' }, error: null });
      await partnerPlaceService.redeemOwn(COUPON);
      expect(mockRpc).toHaveBeenCalledWith('redeem_own_partner_coupon', { p_coupon_id: COUPON });
    });

    it('propagates the RPC error', async () => {
      const err = { message: 'boom', code: 'X' };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });
      await expect(partnerPlaceService.redeemOwn(COUPON)).rejects.toEqual(err);
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @tricigo/api test -- partner-place`
Expected: FAIL — `Failed to resolve import "../partner-place.service"`

- [ ] **Step 4: Write the service**

Create `packages/api/src/services/partner-place.service.ts`:

```ts
import { getSupabaseClient } from '../client';
import type { PartnerPlace, PartnerCoupon, CouponValidation } from '@tricigo/types';

/**
 * Partner places and the arrival coupons they issue.
 *
 * Read paths (`getNearby`, `getMyCoupons`) swallow errors and return [].
 * That is deliberate: the migrations ship to git before anyone applies them
 * to production, so the RPC is legitimately missing for a while. A missing
 * perk section is invisible; a crashing home screen is not.
 *
 * Write/verdict paths (`validateCode`, `redeemCode`, `redeemOwn`) throw.
 * The business-facing page must never render a green "VÁLIDO" because a
 * network error was quietly turned into an empty object.
 */
export const partnerPlaceService = {
  async getNearby(latitude: number, longitude: number, limit = 10): Promise<PartnerPlace[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_nearby_partner_places', {
      p_lat: latitude,
      p_lng: longitude,
      p_limit: limit,
    });
    if (error) return [];
    return (data ?? []) as PartnerPlace[];
  },

  async getMyCoupons(): Promise<PartnerCoupon[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_my_partner_coupons', {});
    if (error) return [];
    return (data ?? []) as PartnerCoupon[];
  },

  async validateCode(token: string, code: string): Promise<CouponValidation> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('validate_partner_coupon', { p_token: token, p_code: code });
    if (error) throw error;
    return data as CouponValidation;
  },

  async redeemCode(token: string, code: string): Promise<CouponValidation> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('redeem_partner_coupon', { p_token: token, p_code: code });
    if (error) throw error;
    return data as CouponValidation;
  },

  async redeemOwn(couponId: string): Promise<CouponValidation> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('redeem_own_partner_coupon', { p_coupon_id: couponId });
    if (error) throw error;
    return data as CouponValidation;
  },
};
```

- [ ] **Step 5: Export it**

Append to `packages/api/src/index.ts`:

```ts
export { partnerPlaceService } from './services/partner-place.service';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @tricigo/api test -- partner-place`
Expected: PASS — 13 tests

- [ ] **Step 7: Type-check**

Run: `pnpm check-types`
Expected: PASS across all four apps

- [ ] **Step 8: Commit**

```bash
git add packages/types/src/index.ts packages/api/src/services/partner-place.service.ts packages/api/src/services/__tests__/partner-place.test.ts packages/api/src/index.ts
git commit -m "feat(partners): partner place service with absent-RPC tolerance"
```

---

## Task 7: Admin page

> **`validation_token` is deliberately unreadable from the table, and that is not a bug to fix.**
> `partner_places` no longer carries a table-wide SELECT grant for `authenticated`; the non-secret
> columns are granted individually and the token is not among them. Without that, any logged-in
> passenger could `GET /partner_places?select=validation_token` and harvest every business's secret
> link, which would defeat the whole point of having one.
>
> The admin still sees it, because `admin_list_partner_places` is `SECURITY DEFINER` and gated on
> `is_admin()` — privileges are checked against the function owner, not the caller. Verified on the
> QA branch: a direct read as `authenticated` fails with `42501 permission denied`, while the same
> column read through a `SECURITY DEFINER` function returns the real token.
>
> So: if you hit a permission error while building this page, the fix is to route the read through
> the RPC. **Do not** `GRANT SELECT (validation_token)` — and note that `REVOKE SELECT (column)`
> would not undo it, because column privileges are additive with a table-level grant. That trap
> already cost one round here.
>
> Adding a column to `partner_places` later means adding it to the explicit `GRANT SELECT (...)`
> list in 00532, or clients will not see it. That failure direction is the safe one.

**Files:**
- Create: `apps/admin/src/app/partners/page.tsx`
- Modify: `apps/admin/src/components/layout/Sidebar.tsx:127`
- Modify: `packages/api/src/services/partner-place.service.ts` (admin methods)
- Create: `supabase/migrations/00536_partner_places_admin_rpcs.sql`

- [ ] **Step 1: Write the admin RPCs migration**

Create `supabase/migrations/00536_partner_places_admin_rpcs.sql`:

```sql
-- 00536_partner_places_admin_rpcs.sql
-- Admin CRUD + the issued/redeemed counters that measure the health of a deal.

CREATE OR REPLACE FUNCTION public.admin_list_partner_places()
RETURNS TABLE (
  id UUID, name TEXT, category TEXT, address TEXT, municipality TEXT, province TEXT,
  photo_url TEXT, benefit_title TEXT, benefit_description TEXT, terms TEXT,
  latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
  radius_m INT, coupon_ttl_minutes INT, cooldown_days INT,
  is_active BOOLEAN, valid_until TIMESTAMPTZ, phone TEXT, hours TEXT,
  validation_token TEXT,
  created_at TIMESTAMPTZ,
  issued_count BIGINT, redeemed_count BIGINT, redeemed_by_business_count BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
BEGIN
  IF NOT COALESCE(public.is_admin(), false) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'admin only', DETAIL = 'not_admin';
  END IF;

  RETURN QUERY
  SELECT pp.id, pp.name, pp.category, pp.address, pp.municipality, pp.province,
         pp.photo_url, pp.benefit_title, pp.benefit_description, pp.terms,
         ST_Y(pp.location::geometry), ST_X(pp.location::geometry),
         pp.radius_m, pp.coupon_ttl_minutes, pp.cooldown_days,
         pp.is_active, pp.valid_until, pp.phone, pp.hours,
         pp.validation_token, pp.created_at,
         COALESCE(c.issued, 0), COALESCE(c.redeemed, 0), COALESCE(c.by_business, 0)
  FROM public.partner_places pp
  LEFT JOIN LATERAL (
    SELECT count(*) AS issued,
           count(*) FILTER (WHERE pc.redeemed_at IS NOT NULL) AS redeemed,
           count(*) FILTER (WHERE pc.redeemed_via = 'business') AS by_business
    FROM public.partner_coupons pc WHERE pc.partner_place_id = pp.id
  ) c ON true
  ORDER BY pp.is_active DESC, pp.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_upsert_partner_place(
  p_id UUID, p_name TEXT, p_category TEXT,
  p_lat DOUBLE PRECISION, p_lng DOUBLE PRECISION,
  p_benefit_title TEXT, p_benefit_description TEXT,
  p_terms TEXT, p_photo_url TEXT, p_address TEXT,
  p_municipality TEXT, p_province TEXT, p_phone TEXT, p_hours TEXT,
  p_radius_m INT, p_coupon_ttl_minutes INT, p_cooldown_days INT,
  p_is_active BOOLEAN, p_valid_until TIMESTAMPTZ
)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_id  UUID;
  v_loc GEOGRAPHY;
BEGIN
  IF NOT COALESCE(public.is_admin(), false) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'admin only', DETAIL = 'not_admin';
  END IF;
  IF p_lat IS NULL OR p_lng IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Marca el lugar en el mapa antes de guardar.', DETAIL = 'missing_coordinates';
  END IF;

  v_loc := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;

  IF p_id IS NULL THEN
    INSERT INTO public.partner_places (
      name, category, location, benefit_title, benefit_description, terms,
      photo_url, address, municipality, province, phone, hours,
      radius_m, coupon_ttl_minutes, cooldown_days, is_active, valid_until, created_by
    ) VALUES (
      p_name, COALESCE(p_category, 'other'), v_loc, p_benefit_title, p_benefit_description, p_terms,
      p_photo_url, p_address, p_municipality, p_province, p_phone, p_hours,
      COALESCE(p_radius_m, 80), COALESCE(p_coupon_ttl_minutes, 120), COALESCE(p_cooldown_days, 0),
      COALESCE(p_is_active, true), p_valid_until, auth.uid()
    )
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.partner_places SET
      name = p_name, category = COALESCE(p_category, 'other'), location = v_loc,
      benefit_title = p_benefit_title, benefit_description = p_benefit_description,
      terms = p_terms, photo_url = p_photo_url, address = p_address,
      municipality = p_municipality, province = p_province, phone = p_phone, hours = p_hours,
      radius_m = COALESCE(p_radius_m, 80),
      coupon_ttl_minutes = COALESCE(p_coupon_ttl_minutes, 120),
      cooldown_days = COALESCE(p_cooldown_days, 0),
      is_active = COALESCE(p_is_active, true), valid_until = p_valid_until,
      updated_at = now()
    WHERE id = p_id
    RETURNING id INTO v_id;
  END IF;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_partner_places() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_upsert_partner_place(UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT, INT, BOOLEAN, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_partner_places() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_upsert_partner_place(UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT, INT, BOOLEAN, TIMESTAMPTZ) TO authenticated;
```

- [ ] **Step 2: Add the admin service methods**

Append inside the `partnerPlaceService` object in `packages/api/src/services/partner-place.service.ts`, after `redeemOwn`:

```ts
  // ── Admin ───────────────────────────────────────────────────────────
  // These throw: an admin staring at an empty table needs to know the call
  // failed, not silently believe there are no partner places.
  async adminList(): Promise<AdminPartnerPlace[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_list_partner_places', {});
    if (error) throw error;
    return (data ?? []) as AdminPartnerPlace[];
  },

  async adminUpsert(input: AdminPartnerPlaceInput): Promise<string> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_upsert_partner_place', {
      p_id: input.id ?? null,
      p_name: input.name,
      p_category: input.category,
      p_lat: input.latitude,
      p_lng: input.longitude,
      p_benefit_title: input.benefit_title,
      p_benefit_description: input.benefit_description,
      p_terms: input.terms || null,
      p_photo_url: input.photo_url || null,
      p_address: input.address || null,
      p_municipality: input.municipality || null,
      p_province: input.province || null,
      p_phone: input.phone || null,
      p_hours: input.hours || null,
      p_radius_m: input.radius_m,
      p_coupon_ttl_minutes: input.coupon_ttl_minutes,
      p_cooldown_days: input.cooldown_days,
      p_is_active: input.is_active,
      p_valid_until: input.valid_until || null,
    });
    if (error) throw error;
    return String(data);
  },
```

And add these types at the top of the same file, after the imports:

```ts
export interface AdminPartnerPlace {
  id: string;
  name: string;
  category: string;
  address: string | null;
  municipality: string | null;
  province: string | null;
  photo_url: string | null;
  benefit_title: string;
  benefit_description: string;
  terms: string | null;
  latitude: number;
  longitude: number;
  radius_m: number;
  coupon_ttl_minutes: number;
  cooldown_days: number;
  is_active: boolean;
  valid_until: string | null;
  phone: string | null;
  hours: string | null;
  /** The business's secret validation link segment: tricigo.com/v/<token>. */
  validation_token: string;
  created_at: string;
  issued_count: number;
  redeemed_count: number;
  redeemed_by_business_count: number;
}

export interface AdminPartnerPlaceInput {
  id?: string | null;
  name: string;
  category: string;
  latitude: number;
  longitude: number;
  benefit_title: string;
  benefit_description: string;
  terms?: string | null;
  photo_url?: string | null;
  address?: string | null;
  municipality?: string | null;
  province?: string | null;
  phone?: string | null;
  hours?: string | null;
  radius_m: number;
  coupon_ttl_minutes: number;
  cooldown_days: number;
  is_active: boolean;
  valid_until?: string | null;
}
```

Export both from `packages/api/src/index.ts`:

```ts
export {
  partnerPlaceService,
  type AdminPartnerPlace,
  type AdminPartnerPlaceInput,
} from './services/partner-place.service';
```

(Replace the single-line export added in Task 6.)

- [ ] **Step 3: Write the admin page**

Create `apps/admin/src/app/partners/page.tsx`. **Mirror the structure of `apps/admin/src/app/pois/page.tsx`** — same `DataTable`, `useToast`, form-panel toggle and loading/error handling. The distinctive parts:

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Gift, Plus, X } from 'lucide-react';
import { partnerPlaceService, TRICIGO_CATEGORIES } from '@tricigo/api';
import type { AdminPartnerPlace, AdminPartnerPlaceInput } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';
import { useToast } from '@/components/ui/AdminToast';
import { DataTable, type DataColumn } from '@/components/data/DataTable';
import { formatAdminDate } from '@/lib/formatDate';

// Leaflet touches `window`; the admin already loads its maps this way
// (see /fleet and /live-map). Do not swap in mapbox-gl here.
const PlacePicker = dynamic(() => import('@/components/PartnerPlacePicker'), { ssr: false });

const emptyForm: AdminPartnerPlaceInput = {
  id: null,
  name: '',
  category: 'cafe',
  latitude: 23.1136,     // central Havana
  longitude: -82.3666,
  benefit_title: '',
  benefit_description: '',
  terms: '',
  photo_url: '',
  address: '',
  municipality: '',
  province: '',
  phone: '',
  hours: '',
  radius_m: 80,
  coupon_ttl_minutes: 120,
  cooldown_days: 0,      // 0 = unlimited, the shipped default
  is_active: true,
  valid_until: null,
};

export default function PartnersPage() {
  const { showToast } = useToast();
  const [rows, setRows] = useState<AdminPartnerPlace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<AdminPartnerPlaceInput>({ ...emptyForm });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await partnerPlaceService.adminList());
    } catch (err) {
      setRows([]);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openEdit = (p: AdminPartnerPlace) => {
    setForm({
      id: p.id, name: p.name, category: p.category,
      latitude: p.latitude, longitude: p.longitude,
      benefit_title: p.benefit_title, benefit_description: p.benefit_description,
      terms: p.terms ?? '', photo_url: p.photo_url ?? '', address: p.address ?? '',
      municipality: p.municipality ?? '', province: p.province ?? '',
      phone: p.phone ?? '', hours: p.hours ?? '',
      radius_m: p.radius_m, coupon_ttl_minutes: p.coupon_ttl_minutes,
      cooldown_days: p.cooldown_days, is_active: p.is_active,
      valid_until: p.valid_until,
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name.trim())            { showToast('error', 'El nombre es obligatorio.'); return; }
    if (!form.benefit_title.trim())   { showToast('error', 'El título del beneficio es obligatorio.'); return; }
    if (!form.benefit_description.trim()) { showToast('error', 'La descripción del beneficio es obligatoria.'); return; }
    setSaving(true);
    try {
      await partnerPlaceService.adminUpsert(form);
      showToast('success', 'Lugar guardado.');
      setShowForm(false);
      setForm({ ...emptyForm });
      await load();
    } catch (err) {
      showToast('error', getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const columns: DataColumn<AdminPartnerPlace>[] = [
    { id: 'name', header: 'Lugar', primary: true,
      cell: (p) => <span className="font-medium text-ink">{p.name}</span> },
    { id: 'municipality', header: 'Municipio', hideBelow: 'md',
      cell: (p) => p.municipality ?? <span className="text-ink-subtle">—</span> },
    { id: 'benefit', header: 'Beneficio',
      cell: (p) => <span className="text-orange-600 font-medium">{p.benefit_title}</span> },
    // The health of the agreement. 200 issued against 12 redeemed means the
    // perk interests nobody and the deal needs renegotiating — surface it.
    { id: 'usage', header: 'Emitidos / canjeados', width: '190px',
      cell: (p) => {
        const pct = p.issued_count > 0
          ? Math.round((p.redeemed_count / p.issued_count) * 100) : 0;
        return (
          <span className="tabular-nums">
            {p.issued_count} / {p.redeemed_count}
            <span className="ml-2 text-ink-subtle">{p.issued_count > 0 ? `${pct}%` : '—'}</span>
            {p.redeemed_count > p.redeemed_by_business_count && (
              <span className="ml-2 text-[10px] text-ink-subtle">
                ({p.redeemed_by_business_count} verif.)
              </span>
            )}
          </span>
        );
      } },
    { id: 'status', header: 'Estado', width: '110px',
      cell: (p) => (
        <span className={p.is_active ? 'text-emerald-700' : 'text-ink-subtle'}>
          {p.is_active ? 'Activo' : 'Inactivo'}
        </span>
      ) },
    // The secret link you hand the business when the deal is signed. It is the
    // identity the rate limiter counts against and the reason a bakery's coupon
    // cannot be redeemed at a café — so it has to be easy to copy and hard to
    // mistype. Click-to-copy, never a plain <a>: opening it here would burn a
    // validation attempt against that business's own budget.
    { id: 'link', header: 'Enlace del negocio', width: '230px',
      cell: (p) => {
        const url = `https://tricigo.com/v/${p.validation_token}`;
        return (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); void navigator.clipboard.writeText(url); }}
            className="font-mono text-xs text-ink-subtle hover:text-ink"
            title="Copiar el enlace"
          >
            /v/{p.validation_token}
          </button>
        );
      } },
    { id: 'created_at', header: 'Creado', hideBelow: 'lg',
      cell: (p) => formatAdminDate(p.created_at) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink inline-flex items-center gap-2">
          <Gift className="h-5 w-5" /> Lugares aliados
        </h1>
        <button
          onClick={() => { setForm({ ...emptyForm }); setShowForm(true); }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-2 text-sm font-medium text-white"
        >
          <Plus className="h-4 w-4" /> Nuevo lugar
        </button>
      </div>

      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        onRowClick={openEdit}
        emptyLabel="Todavía no hay lugares aliados."
      />

      {showForm && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/30 p-4">
          <div className="mx-auto max-w-2xl space-y-4 rounded-xl bg-white p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-ink">{form.id ? 'Editar lugar' : 'Nuevo lugar'}</h2>
              <button onClick={() => setShowForm(false)} aria-label="Cerrar"><X className="h-5 w-5" /></button>
            </div>

            <PlacePicker
              latitude={form.latitude}
              longitude={form.longitude}
              radiusM={form.radius_m}
              onChange={(lat, lng) => setForm((f) => ({ ...f, latitude: lat, longitude: lng }))}
            />

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="text-sm">Nombre
                <input className="mt-1 w-full rounded-lg border p-2" value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </label>
              <label className="text-sm">Categoría
                <select className="mt-1 w-full rounded-lg border p-2" value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}>
                  {TRICIGO_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="text-sm sm:col-span-2">Título del beneficio (corto — va en la píldora naranja)
                <input className="mt-1 w-full rounded-lg border p-2" placeholder="Café gratis"
                  value={form.benefit_title}
                  onChange={(e) => setForm({ ...form, benefit_title: e.target.value })} />
              </label>
              <label className="text-sm sm:col-span-2">Descripción del beneficio
                <input className="mt-1 w-full rounded-lg border p-2"
                  placeholder="Un café con tu compra, solo por llegar en TriciGo"
                  value={form.benefit_description}
                  onChange={(e) => setForm({ ...form, benefit_description: e.target.value })} />
              </label>
              <label className="text-sm sm:col-span-2">Letra chica (opcional)
                <input className="mt-1 w-full rounded-lg border p-2"
                  placeholder="No acumulable, hasta agotar existencias"
                  value={form.terms ?? ''}
                  onChange={(e) => setForm({ ...form, terms: e.target.value })} />
              </label>
              <label className="text-sm sm:col-span-2">URL de la foto
                <input className="mt-1 w-full rounded-lg border p-2" value={form.photo_url ?? ''}
                  onChange={(e) => setForm({ ...form, photo_url: e.target.value })} />
              </label>
              <label className="text-sm">Dirección
                <input className="mt-1 w-full rounded-lg border p-2" value={form.address ?? ''}
                  onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </label>
              <label className="text-sm">Municipio
                <input className="mt-1 w-full rounded-lg border p-2" value={form.municipality ?? ''}
                  onChange={(e) => setForm({ ...form, municipality: e.target.value })} />
              </label>
              <label className="text-sm">Provincia
                <input className="mt-1 w-full rounded-lg border p-2" value={form.province ?? ''}
                  onChange={(e) => setForm({ ...form, province: e.target.value })} />
              </label>
              <label className="text-sm">Teléfono
                <input className="mt-1 w-full rounded-lg border p-2" value={form.phone ?? ''}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </label>
              <label className="text-sm sm:col-span-2">Horario
                <input className="mt-1 w-full rounded-lg border p-2" placeholder="Lun-Sáb 7:00-19:00"
                  value={form.hours ?? ''}
                  onChange={(e) => setForm({ ...form, hours: e.target.value })} />
              </label>
              <label className="text-sm">Radio (m)
                <input type="number" className="mt-1 w-full rounded-lg border p-2" value={form.radius_m}
                  onChange={(e) => setForm({ ...form, radius_m: Number(e.target.value) })} />
              </label>
              <label className="text-sm">Duración del cupón (min)
                <input type="number" className="mt-1 w-full rounded-lg border p-2" value={form.coupon_ttl_minutes}
                  onChange={(e) => setForm({ ...form, coupon_ttl_minutes: Number(e.target.value) })} />
              </label>
              <label className="text-sm">Espera entre cupones (días — 0 = sin límite)
                <input type="number" className="mt-1 w-full rounded-lg border p-2" value={form.cooldown_days}
                  onChange={(e) => setForm({ ...form, cooldown_days: Number(e.target.value) })} />
              </label>
              <label className="text-sm">Fin del acuerdo (opcional)
                <input type="date" className="mt-1 w-full rounded-lg border p-2"
                  value={form.valid_until ? form.valid_until.slice(0, 10) : ''}
                  onChange={(e) => setForm({ ...form, valid_until: e.target.value ? `${e.target.value}T23:59:59Z` : null })} />
              </label>
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input type="checkbox" checked={form.is_active}
                  onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
                Activo
              </label>
            </div>

            <div className="flex justify-end gap-2">
              <button onClick={() => setShowForm(false)} className="rounded-lg border px-4 py-2 text-sm">Cancelar</button>
              <button onClick={handleSave} disabled={saving}
                className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {saving ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Write the map picker**

Create `apps/admin/src/components/PartnerPlacePicker.tsx`:

```tsx
'use client';

import { MapContainer, TileLayer, CircleMarker, Circle, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

interface Props {
  latitude: number;
  longitude: number;
  radiusM: number;
  onChange: (lat: number, lng: number) => void;
}

function ClickCapture({ onChange }: { onChange: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onChange(e.latlng.lat, e.latlng.lng) });
  return null;
}

/**
 * Click the map to place the business. The shaded circle is the real match
 * radius — an admin who sets 500 m can see it swallowing the whole block
 * before saving, instead of discovering it through spurious coupons.
 */
export default function PartnerPlacePicker({ latitude, longitude, radiusM, onChange }: Props) {
  return (
    <div className="h-64 overflow-hidden rounded-lg border">
      <MapContainer center={[latitude, longitude]} zoom={16} style={{ height: '100%', width: '100%' }}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <ClickCapture onChange={onChange} />
        <Circle center={[latitude, longitude]} radius={radiusM}
          pathOptions={{ color: '#FF4D00', fillOpacity: 0.12, weight: 1 }} />
        <CircleMarker center={[latitude, longitude]} radius={7}
          pathOptions={{ color: '#FF4D00', fillColor: '#FF4D00', fillOpacity: 1 }} />
      </MapContainer>
    </div>
  );
}
```

- [ ] **Step 5: Add the sidebar entry**

In `apps/admin/src/components/layout/Sidebar.tsx`, add `Gift` to the `lucide-react` import and insert immediately after the `/pois` entry on line 127:

```tsx
      { href: '/pois', labelKey: 'sidebar.pois', defaultLabel: 'POIs', icon: MapPin },
      { href: '/partners', labelKey: 'sidebar.partners', defaultLabel: 'Lugares aliados', icon: Gift },
```

- [ ] **Step 6: Verify the build**

Run: `pnpm check-types`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/00536_partner_places_admin_rpcs.sql apps/admin/src/app/partners/page.tsx apps/admin/src/components/PartnerPlacePicker.tsx apps/admin/src/components/layout/Sidebar.tsx packages/api/src/services/partner-place.service.ts packages/api/src/index.ts
git commit -m "feat(admin): partner places CRUD with redemption-rate column"
```

---

## Task 8: Client — hero carousel

**Files:**
- Create: `apps/client/src/components/PartnerPlacesCarousel.tsx`
- Modify: `apps/client/app/(tabs)/index.tsx` (inside `IdleView`, near the announcements section at ~line 2497)

- [ ] **Step 1: Write the carousel**

Create `apps/client/src/components/PartnerPlacesCarousel.tsx`:

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { View, Pressable, Image, ScrollView, useWindowDimensions } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { Ionicons } from '@expo/vector-icons';
import { partnerPlaceService } from '@tricigo/api';
import type { PartnerPlace } from '@tricigo/types';
import { useTranslation } from '@tricigo/i18n';
import { tricigoCategoryEmoji } from '@tricigo/utils';
import { useRefreshOnFocus } from '@/hooks/useRefreshOnFocus';

interface Props {
  latitude: number | null;
  longitude: number | null;
  tokens: any;
  onSelect: (place: PartnerPlace) => void;
}

/**
 * Hero carousel of nearby partner places. Renders nothing when there is no
 * location fix or no place in range — showing a bakery that might be in
 * another province is worse than showing nothing, and the coupon is issued
 * on arrival either way, so nothing is lost by staying quiet.
 */
export function PartnerPlacesCarousel({ latitude, longitude, tokens, onSelect }: Props) {
  const { t } = useTranslation('rider');
  const { width } = useWindowDimensions();
  const [places, setPlaces] = useState<PartnerPlace[]>([]);
  const cardWidth = Math.min(width - 32, 340);

  const load = useCallback(async () => {
    if (latitude == null || longitude == null) { setPlaces([]); return; }
    setPlaces(await partnerPlaceService.getNearby(latitude, longitude, 8));
  }, [latitude, longitude]);

  useEffect(() => { void load(); }, [load]);
  useRefreshOnFocus(load);

  if (places.length === 0) return null;

  return (
    <View style={{ marginTop: 24 }}>
      <Text style={{
        fontFamily: 'JetBrainsMono_600SemiBold', fontSize: 10, letterSpacing: 2,
        color: tokens.ink.subtle, marginBottom: 8,
      }}>
        {t('home.partner_places_label', { defaultValue: 'LUGARES CON BENEFICIO' })}
      </Text>

      <ScrollView
        horizontal
        pagingEnabled
        snapToInterval={cardWidth + 10}
        decelerationRate="fast"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 10, paddingRight: 16 }}
      >
        {places.map((p) => (
          // Layout (`width`) lives in a plain style OBJECT, never inside a
          // Pressable style FUNCTION — RN silently drops layout props from
          // the function form. See the Pressable note in CLAUDE.md.
          <Pressable
            key={p.id}
            style={{ width: cardWidth }}
            onPress={() => onSelect(p)}
            android_ripple={{ color: 'rgba(255,255,255,0.18)' }}
            accessibilityRole="button"
            accessibilityLabel={`${p.name}: ${p.benefit_title}`}
          >
            {({ pressed }) => (
              <View style={{
                width: '100%', opacity: pressed ? 0.92 : 1,
                backgroundColor: tokens.bg.elev1, borderColor: tokens.line, borderWidth: 1,
                borderRadius: 18, overflow: 'hidden',
              }}>
                {p.photo_url ? (
                  <Image source={{ uri: p.photo_url }} style={{ width: '100%', height: 128 }} resizeMode="cover" />
                ) : (
                  <View style={{
                    width: '100%', height: 128, backgroundColor: tokens.bg.elev2,
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Text style={{ fontSize: 40 }}>{tricigoCategoryEmoji(p.category)}</Text>
                  </View>
                )}

                <View style={{ padding: 13 }}>
                  <View style={{
                    alignSelf: 'flex-start', backgroundColor: tokens.accent.orange,
                    borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4, marginBottom: 7,
                  }}>
                    <Text style={{
                      fontFamily: 'JetBrainsMono_600SemiBold', fontSize: 9,
                      letterSpacing: 1.2, color: '#fff',
                    }}>
                      {p.benefit_title.toUpperCase()}
                    </Text>
                  </View>

                  <Text numberOfLines={1} style={{
                    fontFamily: 'BricolageGrotesque_700Bold', fontSize: 16, color: tokens.ink.primary,
                  }}>
                    {p.name}
                  </Text>
                  <Text numberOfLines={2} style={{
                    fontFamily: 'Inter', fontSize: 12, color: tokens.ink.subtle,
                    lineHeight: 16, marginTop: 3,
                  }}>
                    {p.benefit_description}
                  </Text>
                  <Text style={{
                    fontFamily: 'JetBrainsMono_400Regular', fontSize: 10,
                    color: tokens.ink.subtle, letterSpacing: 0.5, marginTop: 7,
                  }}>
                    {(p.municipality ?? '').toUpperCase()}
                    {p.municipality ? ' · ' : ''}
                    {(p.distance_m / 1000).toFixed(1)} KM
                  </Text>

                  {p.has_active_coupon && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8 }}>
                      <Ionicons name="ticket" size={13} color={tokens.accent.orange} />
                      <Text style={{ fontFamily: 'Inter', fontSize: 11, color: tokens.accent.orange }}>
                        {t('home.partner_has_coupon', { defaultValue: 'Ya tienes un cupón activo aquí' })}
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            )}
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
```

- [ ] **Step 2: Mount it in `IdleView`**

In `apps/client/app/(tabs)/index.tsx`, add the import near the other component imports (around line 36):

```tsx
import { PartnerPlacesCarousel } from '@/components/PartnerPlacesCarousel';
```

Then insert the block immediately **before** the `{/* ── Campañas (announcements) ── */}` comment (around line 2497):

```tsx
        {/* ── Lugares con beneficio ── partner places near the passenger */}
        <PartnerPlacesCarousel
          latitude={userLocation?.latitude ?? null}
          longitude={userLocation?.longitude ?? null}
          tokens={tokens}
          onSelect={(place) => {
            setDropoff(place.name, { latitude: place.latitude, longitude: place.longitude });
            setFlowStep('selecting');
          }}
        />
```

> If the variable holding the passenger's coordinates in `IdleView` is not named `userLocation`, grep the component for the state that feeds the map centre and use that. Do not add a second location subscription.

- [ ] **Step 3: Type-check**

Run: `pnpm check-types`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/client/src/components/PartnerPlacesCarousel.tsx "apps/client/app/(tabs)/index.tsx"
git commit -m "feat(client): partner places hero carousel on the home"
```

---

## Task 9: Client — coupon banner and ticket screen

**Files:**
- Create: `apps/client/src/components/PartnerCouponBanner.tsx`
- Create: `apps/client/app/coupon/[id].tsx`
- Modify: `apps/client/app/(tabs)/index.tsx:1729-1737` and `:1760-1764`

- [ ] **Step 1: Write the banner**

Create `apps/client/src/components/PartnerCouponBanner.tsx`:

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { View, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@tricigo/ui/Text';
import { partnerPlaceService } from '@tricigo/api';
import type { PartnerCoupon } from '@tricigo/types';
import { tricigoCategoryEmoji } from '@tricigo/utils';
import { useRefreshOnFocus } from '@/hooks/useRefreshOnFocus';

/** mm:ss or h:mm:ss remaining, or null once it has expired. */
export function remainingLabel(expiresAt: string, now: number): string | null {
  const ms = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Live-coupon banner. Mounted in BOTH home states — idle and ride-in-progress.
 * The idle-only version breaks exactly where it matters: a passenger who
 * closes the ticket and books another ride gets the home replaced by the
 * tracking view, stranding a live coupon with no way back.
 */
export function PartnerCouponBanner({ tokens, compact = false }: { tokens: any; compact?: boolean }) {
  const [coupons, setCoupons] = useState<PartnerCoupon[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setCoupons(await partnerPlaceService.getMyCoupons());
  }, []);

  useEffect(() => { void load(); }, [load]);
  useRefreshOnFocus(load);

  // Drive the countdown. Without this the label freezes at whatever it said
  // on mount — the stale-on-mount class CLAUDE.md tracks permanently.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const live = coupons.filter((c) => remainingLabel(c.expires_at, now) !== null);
  if (live.length === 0) return null;

  return (
    <View style={{ gap: 8, marginBottom: compact ? 10 : 0 }}>
      {live.map((c) => (
        <Pressable
          key={c.id}
          style={{ width: '100%' }}
          onPress={() => router.push(`/coupon/${c.id}` as never)}
          accessibilityRole="button"
          accessibilityLabel={`${c.place_name}: ${c.benefit_title}`}
        >
          {({ pressed }) => (
            <View style={{
              width: '100%', opacity: pressed ? 0.92 : 1,
              flexDirection: 'row', alignItems: 'center', gap: 9,
              backgroundColor: tokens.bg.elev1,
              borderColor: 'rgba(255,77,0,0.32)', borderWidth: 1.5,
              borderRadius: compact ? 12 : 14,
              paddingHorizontal: compact ? 10 : 11,
              paddingVertical: compact ? 8 : 10,
            }}>
              <Text style={{ fontSize: compact ? 17 : 20 }}>
                {tricigoCategoryEmoji(c.category)}
              </Text>
              <View style={{ flexShrink: 1 }}>
                <Text numberOfLines={1} style={{
                  fontFamily: 'BricolageGrotesque_700Bold',
                  fontSize: compact ? 11.5 : 12, color: tokens.ink.primary,
                }}>
                  {c.place_name}
                </Text>
                <Text numberOfLines={1} style={{
                  fontFamily: 'Inter', fontSize: compact ? 10 : 10.5,
                  fontWeight: '700', color: tokens.accent.orange, marginTop: 1,
                }}>
                  {c.benefit_title}
                </Text>
              </View>
              <View style={{
                marginLeft: 'auto', backgroundColor: tokens.accent.orangeGlow,
                borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4,
              }}>
                <Text style={{
                  fontFamily: 'JetBrainsMono_500Medium', fontSize: 9.5,
                  fontWeight: '700', color: tokens.accent.orange,
                }}>
                  {remainingLabel(c.expires_at, now)}
                </Text>
              </View>
            </View>
          )}
        </Pressable>
      ))}
    </View>
  );
}
```

- [ ] **Step 2: Write the ticket screen**

Create `apps/client/app/coupon/[id].tsx`:

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { View, ScrollView, Pressable, ActivityIndicator, Linking } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import Toast from 'react-native-toast-message';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { partnerPlaceService } from '@tricigo/api';
import type { PartnerCoupon } from '@tricigo/types';
import { useTranslation } from '@tricigo/i18n';
import { useThemeStore } from '@/stores/theme.store';
import { cubanLight, cubanDark } from '@tricigo/theme';
import { tricigoCategoryEmoji } from '@tricigo/utils';
import { remainingLabel } from '@/components/PartnerCouponBanner';

export default function CouponScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { t } = useTranslation('rider');
  const scheme = useThemeStore((s) => s.resolvedScheme);
  const tokens = scheme === 'dark' ? cubanDark : cubanLight;

  const [coupon, setCoupon] = useState<PartnerCoupon | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [redeeming, setRedeeming] = useState(false);

  const load = useCallback(async () => {
    const all = await partnerPlaceService.getMyCoupons();
    setCoupon(all.find((c) => c.id === id) ?? null);
    setLoading(false);
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const handleUsed = async () => {
    if (!coupon) return;
    setRedeeming(true);
    try {
      await partnerPlaceService.redeemOwn(coupon.id);
      Toast.show({ type: 'success', text1: t('coupon.marked_used', { defaultValue: 'Cupón marcado como usado' }) });
      router.back();
    } catch {
      Toast.show({ type: 'error', text1: t('coupon.mark_failed', { defaultValue: 'No se pudo marcar el cupón' }) });
    } finally {
      setRedeeming(false);
    }
  };

  if (loading) {
    return (
      <Screen bg="cuban" padded>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={tokens.accent.orange} />
        </View>
      </Screen>
    );
  }

  const left = coupon ? remainingLabel(coupon.expires_at, now) : null;

  // Gone or expired. Say so honestly — and say the useful part: because there
  // is no frequency cap, the next ride there issues a fresh one.
  if (!coupon || left === null) {
    return (
      <Screen bg="cuban" padded scroll>
        <ScreenHeader title={t('coupon.title', { defaultValue: 'Tu cupón' })} onBack={() => router.back()} />
        <View style={{ alignItems: 'center', marginTop: 48, gap: 10 }}>
          <Text style={{ fontSize: 42 }}>⌛</Text>
          <Text style={{ fontFamily: 'BricolageGrotesque_700Bold', fontSize: 18, color: tokens.ink.primary }}>
            {t('coupon.expired_title', { defaultValue: 'Este cupón ya no está disponible' })}
          </Text>
          <Text style={{ fontFamily: 'Inter', fontSize: 13, color: tokens.ink.subtle, textAlign: 'center', lineHeight: 19 }}>
            {t('coupon.expired_body', { defaultValue: 'Tu próximo viaje a ese lugar te da uno nuevo.' })}
          </Text>
        </View>
      </Screen>
    );
  }

  const notch = {
    position: 'absolute' as const, top: -9, width: 18, height: 18, borderRadius: 999,
    backgroundColor: tokens.bg.paper, borderWidth: 1, borderColor: tokens.line,
  };

  return (
    <Screen bg="cuban" padded scroll>
      <ScreenHeader title={t('coupon.title', { defaultValue: 'Tu cupón' })} onBack={() => router.back()} />

      <View style={{
        backgroundColor: tokens.bg.elev1, borderColor: tokens.line, borderWidth: 1,
        borderRadius: 18, overflow: 'hidden', marginTop: 8,
      }}>
        <View style={{ padding: 18, alignItems: 'center' }}>
          <Text style={{ fontSize: 34 }}>{tricigoCategoryEmoji(coupon.category) ?? '🎁'}</Text>
          <Text style={{
            fontFamily: 'BricolageGrotesque_700Bold', fontSize: 18,
            color: tokens.ink.primary, marginTop: 7, textAlign: 'center',
          }}>
            {coupon.place_name}
          </Text>
          <Text style={{
            fontFamily: 'Inter', fontSize: 14, fontWeight: '700',
            color: tokens.accent.orange, marginTop: 6, textAlign: 'center', lineHeight: 19,
          }}>
            {coupon.benefit_description}
          </Text>
        </View>

        <View style={{ height: 1, marginHorizontal: 14, borderTopWidth: 2, borderStyle: 'dashed', borderColor: tokens.line }}>
          <View style={[notch, { left: -24 }]} />
          <View style={[notch, { right: -24 }]} />
        </View>

        <View style={{ padding: 18, alignItems: 'center' }}>
          <Text style={{
            fontFamily: 'JetBrainsMono_600SemiBold', fontSize: 9,
            letterSpacing: 2, color: tokens.ink.subtle, marginBottom: 8,
          }}>
            {t('coupon.show_code', { defaultValue: 'MOSTRÁ ESTE CÓDIGO' })}
          </Text>
          <Text style={{
            fontFamily: 'JetBrainsMono_600SemiBold', fontSize: 30,
            letterSpacing: 3, color: tokens.ink.primary,
          }}>
            TG-{coupon.code}
          </Text>
          <View style={{
            marginTop: 13, backgroundColor: tokens.accent.orangeGlow,
            borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6,
          }}>
            <Text style={{
              fontFamily: 'JetBrainsMono_500Medium', fontSize: 12,
              fontWeight: '700', color: tokens.accent.orange,
            }}>
              ⏱ {left}
            </Text>
          </View>
          <Text style={{
            fontFamily: 'Inter', fontSize: 11, color: tokens.ink.subtle,
            marginTop: 12, textAlign: 'center', lineHeight: 16,
          }}>
            {t('coupon.validate_hint', { defaultValue: 'El negocio puede validarlo en tricigo.com/v' })}
          </Text>
        </View>
      </View>

      {coupon.terms ? (
        <Text style={{ fontFamily: 'Inter', fontSize: 11, color: tokens.ink.subtle, marginTop: 12, lineHeight: 16 }}>
          {coupon.terms}
        </Text>
      ) : null}

      {coupon.address ? (
        <Text style={{ fontFamily: 'Inter', fontSize: 12, color: tokens.ink.secondary, marginTop: 12 }}>
          {coupon.address}{coupon.hours ? ` · ${coupon.hours}` : ''}
        </Text>
      ) : null}

      {coupon.phone ? (
        <Pressable onPress={() => Linking.openURL(`tel:${coupon.phone}`)} style={{ marginTop: 6 }}>
          <Text style={{ fontFamily: 'Inter', fontSize: 12, color: tokens.accent.orange }}>{coupon.phone}</Text>
        </Pressable>
      ) : null}

      <Pressable
        onPress={handleUsed}
        disabled={redeeming}
        style={{
          marginTop: 22, borderWidth: 1, borderColor: tokens.line,
          borderRadius: 13, paddingVertical: 13, alignItems: 'center',
          opacity: redeeming ? 0.6 : 1,
        }}
        accessibilityRole="button"
      >
        <Text style={{ fontFamily: 'Inter', fontSize: 13, fontWeight: '600', color: tokens.ink.secondary }}>
          {t('coupon.mark_used', { defaultValue: 'Ya lo usé' })}
        </Text>
      </Pressable>
      <View style={{ height: 32 }} />
    </Screen>
  );
}
```

- [ ] **Step 3: Mount the banner in BOTH home states**

In `apps/client/app/(tabs)/index.tsx`, add the import next to the carousel import:

```tsx
import { PartnerCouponBanner } from '@/components/PartnerCouponBanner';
```

Inside `NativeHomeScreen`, in the `flowStep !== 'idle'` branch, add the compact banner directly above the `Animated.View` (around line 1732):

```tsx
        <Screen bg="cuban" padded scroll={enableScroll}>
          {flowStep === 'active' && <PartnerCouponBanner tokens={tokens} compact />}
          <Animated.View style={{ opacity: flowFadeAnim, flex: 1 }}>
```

And in `IdleView`, insert the full-size banner as the **first** child of the scrollable content, above the address search:

```tsx
        <PartnerCouponBanner tokens={tokens} />
```

> `tokens` must be in scope in `NativeHomeScreen`. If it is not, derive it the same way `IdleView` does: `const tokens = resolvedScheme === 'dark' ? cubanDark : cubanLight;`.

- [ ] **Step 4: Type-check**

Run: `pnpm check-types`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/components/PartnerCouponBanner.tsx "apps/client/app/coupon/[id].tsx" "apps/client/app/(tabs)/index.tsx"
git commit -m "feat(client): coupon ticket screen and banner in both home states"
```

---

## Task 10: Public validation page

**Files:**
- Create: `apps/web/src/app/v/[token]/page.tsx`
- Create: `apps/web/src/app/v/page.tsx` (bare-URL explainer)

The route carries the business's secret token: `tricigo.com/v/a7f3k2b91c04`. That token, not the
caller's IP, is the identity the rate limiter counts against — see the spec's "Business-facing
surface" for why the IP version was abandoned. Read it with `useParams()`.

Also create a plain `apps/web/src/app/v/page.tsx` for someone who trims the URL: a short Spanish
note saying each business has its own link and to ask TriciGo for it. No input, no lookup — a bare
`/v` has no business identity and must not become a way to probe codes.

- [ ] **Step 1: Write the page**

Create `apps/web/src/app/v/[token]/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { partnerPlaceService } from '@tricigo/api';
import type { CouponValidation } from '@tricigo/types';

/**
 * Public coupon validation for partner businesses. No login, no account,
 * no app. Spanish only on purpose: the reader is a shop employee in Cuba.
 *
 * Built for a cheap phone on a weak connection — large type, no images,
 * minimal payload.
 */
export default function ValidatePage() {
  // The business's secret link. Everything on this page is scoped to it: the
  // rate-limit bucket, and which coupons can be validated at all.
  const params = useParams<{ token: string }>();
  const token = String(params?.token ?? '');
  const [code, setCode] = useState('');
  const [result, setResult] = useState<CouponValidation | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const check = async () => {
    setBusy(true); setFailed(false);
    try {
      setResult(await partnerPlaceService.validateCode(token, code));
    } catch {
      // Never fall through to a green screen: the shop would give away a
      // coffee because the network hiccuped.
      setResult(null); setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true); setFailed(false);
    try {
      setResult(await partnerPlaceService.redeemCode(token, code));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => { setCode(''); setResult(null); setFailed(false); };

  const hhmm = (iso?: string) =>
    iso ? new Intl.DateTimeFormat('es', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Havana',
    }).format(new Date(iso)) : '';

  const box: React.CSSProperties = {
    borderRadius: 16, padding: '20px 16px', textAlign: 'center', marginTop: 18,
  };

  return (
    <main style={{ maxWidth: 420, margin: '0 auto', padding: '20px 16px 60px', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{
        background: '#1A1414', color: '#FFFBF5', borderRadius: 12,
        padding: '11px 14px', display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <strong style={{ fontSize: 15 }}>TriciGo</strong>
        <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.6 }}>VALIDAR CUPÓN</span>
      </div>

      {!result && (
        <>
          <p style={{ fontSize: 14, color: '#6B7F8F', margin: '18px 0 12px', lineHeight: 1.45 }}>
            Escribe el código que te muestra el cliente en su teléfono.
          </p>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === 'Enter' && code.trim()) void check(); }}
            placeholder="K7M2QX"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={12}
            aria-label="Código del cupón"
            style={{
              width: '100%', border: '2px solid rgba(26,20,20,.14)', borderRadius: 13,
              padding: 14, textAlign: 'center', fontSize: 26, letterSpacing: 4,
              fontWeight: 700, boxSizing: 'border-box',
            }}
          />
          <button
            onClick={() => void check()}
            disabled={busy || code.trim().length === 0}
            style={{
              width: '100%', marginTop: 12, background: '#FF4D00', color: '#fff',
              border: 0, borderRadius: 13, padding: 14, fontSize: 16, fontWeight: 700,
              opacity: busy || !code.trim() ? 0.55 : 1,
            }}
          >
            {busy ? 'Validando…' : 'Validar'}
          </button>
          {failed && (
            <p style={{ marginTop: 14, fontSize: 13, color: '#B3261E', textAlign: 'center' }}>
              No se pudo conectar. Revisa la señal e intenta de nuevo.
            </p>
          )}
        </>
      )}

      {result?.status === 'valid' && (
        <>
          <div style={{ ...box, background: '#E8F6EC', border: '1px solid #9FD8B0' }}>
            <div style={{ fontSize: 40 }}>✅</div>
            <div style={{ fontWeight: 800, fontSize: 19, color: '#1B7A3D', marginTop: 6 }}>CUPÓN VÁLIDO</div>
            <div style={{ fontSize: 13, color: '#6B7F8F', marginTop: 5 }}>Entrega el beneficio y confirma abajo.</div>
          </div>
          <dl style={{ marginTop: 16, fontSize: 13 }}>
            <Row k="NEGOCIO" v={result.place_name ?? '—'} />
            <Row k="BENEFICIO" v={result.benefit_title ?? '—'} accent />
            <Row k="CLIENTE" v={result.customer || '—'} />
            <Row k="LLEGÓ" v={hhmm(result.arrived_at)} />
            <Row k="VENCE" v={hhmm(result.expires_at)} />
          </dl>
          {result.terms && (
            <p style={{ fontSize: 12, color: '#A9B4BC', marginTop: 10 }}>{result.terms}</p>
          )}
          <button
            onClick={() => void confirm()}
            disabled={busy}
            style={{
              width: '100%', marginTop: 16, background: '#FF4D00', color: '#fff',
              border: 0, borderRadius: 13, padding: 14, fontSize: 16, fontWeight: 700,
              opacity: busy ? 0.55 : 1,
            }}
          >
            {busy ? 'Confirmando…' : 'Confirmar entrega'}
          </button>
          {failed && (
            <p style={{ marginTop: 12, fontSize: 13, color: '#B3261E', textAlign: 'center' }}>
              No se pudo confirmar. El cupón sigue sin canjear — probá de nuevo.
            </p>
          )}
        </>
      )}

      {result?.status === 'redeemed' && (
        <Verdict icon="🎉" title="CANJEADO" tone="ok" body="Listo. Entrega el beneficio al cliente." onReset={reset} />
      )}
      {result?.status === 'used' && (
        <Verdict icon="🚫" title="YA FUE USADO" tone="bad" onReset={reset}
          body={`Este cupón se canjeó a las ${hhmm(result.redeemed_at)}. No entregues el beneficio.`} />
      )}
      {result?.status === 'expired' && (
        <Verdict icon="⌛" title="CUPÓN VENCIDO" tone="bad" onReset={reset}
          body={`Venció a las ${hhmm(result.expires_at)}. El cupón dura 2 horas desde que el cliente llega.`} />
      )}
      {result?.status === 'not_found' && (
        <Verdict icon="❌" title="CÓDIGO NO VÁLIDO" tone="bad" onReset={reset}
          body="Revisa que esté bien escrito. Son 6 caracteres." />
      )}
      {result?.status === 'rate_limited' && (
        <Verdict icon="🐢" title="DEMASIADOS INTENTOS" tone="bad" onReset={reset}
          body="Espera unos minutos antes de volver a intentar." />
      )}
      {result?.status === 'invalid_link' && (
        <Verdict icon="🔗" title="ENLACE NO VÁLIDO" tone="bad" onReset={reset}
          body="Este enlace no corresponde a ningún negocio activo. Pídele a TriciGo el enlace de tu negocio." />
      )}
    </main>
  );
}

function Row({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', padding: '9px 0',
      borderBottom: '1px solid rgba(26,20,20,.07)',
    }}>
      <dt style={{ color: '#A9B4BC' }}>{k}</dt>
      <dd style={{ margin: 0, fontWeight: 600, color: accent ? '#FF4D00' : '#1A1414' }}>{v}</dd>
    </div>
  );
}

function Verdict({ icon, title, body, tone, onReset }: {
  icon: string; title: string; body: string; tone: 'ok' | 'bad'; onReset: () => void;
}) {
  const ok = tone === 'ok';
  return (
    <>
      <div style={{
        borderRadius: 16, padding: '20px 16px', textAlign: 'center', marginTop: 18,
        background: ok ? '#E8F6EC' : '#FDECEC',
        border: `1px solid ${ok ? '#9FD8B0' : '#F0B4B4'}`,
      }}>
        <div style={{ fontSize: 40 }}>{icon}</div>
        <div style={{ fontWeight: 800, fontSize: 19, marginTop: 6, color: ok ? '#1B7A3D' : '#B3261E' }}>{title}</div>
        <div style={{ fontSize: 13, color: '#6B7F8F', marginTop: 6, lineHeight: 1.45 }}>{body}</div>
      </div>
      <button
        onClick={onReset}
        style={{
          width: '100%', marginTop: 14, background: 'transparent', color: '#6B7F8F',
          border: '1px solid rgba(26,20,20,.14)', borderRadius: 13, padding: 13, fontSize: 15,
        }}
      >
        Validar otro código
      </button>
    </>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm check-types`
Expected: PASS

- [ ] **Step 3: confirm the rate limiter keys on the business, not on anything the caller sends**

The per-IP version of this control was abandoned after a reviewer demonstrated it was forgeable —
`X-Forwarded-For` is written by the client, so an attacker could both bypass the budget and pin a
chosen shop's bucket to deny it service. Identity is now the business's secret token.

Nothing here reads a header any more, so there is no header to verify. What is worth confirming once
the migrations are applied is that the buckets look right:

```sql
SELECT key, count FROM rate_limits WHERE key LIKE 'coupon%' ORDER BY key;
```

Keys must contain a **`partner_place_id` UUID**, and every unresolved token must collapse into the
single shared `coupon_badtoken:all` bucket. A key containing an IP means something reintroduced the
old derivation.

- [ ] **Step 4: Verify it renders**

```bash
cp "$(git rev-parse --show-toplevel | sed 's#/.claude/worktrees/.*##')/apps/web/.env.local" apps/web/.env.local
pnpm --filter @tricigo/web dev
```

Open `http://localhost:3000/v`. Expected: the input screen renders. Typing a bogus code and pressing Validar shows **CÓDIGO NO VÁLIDO** once the migration is applied; before that the RPC is missing and the catch fires — the connection error message is correct behaviour at this stage.

> `apps/web` uses `.env.local`, **not** `.env`. Without it the page throws `Missing environment variable: SUPABASE_URL` and renders "Algo salió mal", while the server still answers `200` — a curl check will lie to you.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/v/page.tsx
git commit -m "feat(web): public coupon validation page at /v"
```

---

## Task 11: Web parity — dashboard section

**Files:**
- Modify: `apps/web/src/components/HomeDashboard.tsx`

- [ ] **Step 1: Add state and loading**

Alongside the existing `promos` / `announcements` state, add:

```tsx
  const [places, setPlaces] = useState<PartnerPlace[]>([]);
  const [coupons, setCoupons] = useState<PartnerCoupon[]>([]);
```

Import the types and service at the top:

```tsx
import { partnerPlaceService } from '@tricigo/api';
import type { PartnerPlace, PartnerCoupon } from '@tricigo/types';
```

In the same effect that loads promos and announcements, add:

```tsx
    // Live coupons first — they are time-critical. Both readers already
    // swallow a missing RPC, so this is safe before the migration lands.
    void partnerPlaceService.getMyCoupons().then(setCoupons);
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          void partnerPlaceService
            .getNearby(pos.coords.latitude, pos.coords.longitude, 8)
            .then(setPlaces);
        },
        // Permission denied or unavailable: no carousel. Same rule as mobile.
        () => setPlaces([]),
        { timeout: 8000 },
      );
    }
```

- [ ] **Step 2: Widen the early return**

The component currently returns `null` when there is nothing to show. Update that guard so the new sections can render:

```tsx
  if (!lastRide && promos.length === 0 && announcements.length === 0
      && places.length === 0 && coupons.length === 0) return null;
```

- [ ] **Step 3: Render the two sections**

Insert **above** the promos section (live coupons outrank marketing):

```tsx
      {/* ── Live coupons ── */}
      {coupons.length > 0 && (
        <section>
          <p style={sectionLabel}>{t('home.dashboard_coupons', { defaultValue: 'Tus cupones' })}</p>
          <div style={{ display: 'grid', gap: 10 }}>
            {coupons.map((c) => (
              <div key={c.id} style={{
                border: '1.5px solid rgba(255,77,0,.32)', borderRadius: 14,
                padding: '12px 14px', background: 'var(--bg-card)',
              }}>
                <strong style={{ fontSize: 14 }}>{c.place_name}</strong>
                <div style={{ color: 'var(--primary)', fontWeight: 700, fontSize: 13, marginTop: 2 }}>
                  {c.benefit_title}
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: 22, letterSpacing: 3, marginTop: 8 }}>
                  TG-{c.code}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                  Vence a las {new Intl.DateTimeFormat('es', {
                    hour: '2-digit', minute: '2-digit', timeZone: 'America/Havana',
                  }).format(new Date(c.expires_at))} · el negocio puede validarlo en tricigo.com/v
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Partner places ── */}
      {places.length > 0 && (
        <section>
          <p style={sectionLabel}>{t('home.dashboard_partner_places', { defaultValue: 'Lugares con beneficio' })}</p>
          <div style={{ display: 'grid', gap: 10 }}>
            {places.map((p) => (
              <a key={p.id}
                 href={`/book?lat=${p.latitude}&lng=${p.longitude}&label=${encodeURIComponent(p.name)}`}
                 style={{
                   border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden',
                   background: 'var(--bg-card)', textDecoration: 'none', color: 'inherit', display: 'block',
                 }}>
                {p.photo_url && (
                  <img src={p.photo_url} alt="" style={{ width: '100%', height: 130, objectFit: 'cover' }} />
                )}
                <div style={{ padding: '12px 14px' }}>
                  <span style={{
                    display: 'inline-block', background: 'var(--primary)', color: '#fff',
                    borderRadius: 999, padding: '3px 9px', fontSize: 10, fontWeight: 700,
                    letterSpacing: 1, textTransform: 'uppercase',
                  }}>
                    {p.benefit_title}
                  </span>
                  <strong style={{ display: 'block', fontSize: 15, marginTop: 7 }}>{p.name}</strong>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                    {p.benefit_description}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                    {(p.distance_m / 1000).toFixed(1)} km
                  </div>
                </div>
              </a>
            ))}
          </div>
        </section>
      )}
```

> Confirm `/book` reads `lat` / `lng` / `label` from the query string. If it does not, link to plain `/book` and drop the params rather than inventing an API the page does not have.

- [ ] **Step 4: Type-check**

Run: `pnpm check-types`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/HomeDashboard.tsx
git commit -m "feat(web): partner places and live coupons on the rider dashboard"
```

---

## Task 12: Copy and i18n

**Files:**
- Modify: `packages/i18n/src/locales/{es,en,pt}/rider.json`
- Modify: `packages/i18n/src/locales/{es,en,pt}/admin.json`

- [ ] **Step 1: Add the rider keys**

`es/rider.json` — merge into the existing `home` and add a `coupon` namespace:

```json
  "home": {
    "partner_places_label": "LUGARES CON BENEFICIO",
    "partner_has_coupon": "Ya tienes un cupón activo aquí",
    "dashboard_coupons": "Tus cupones",
    "dashboard_partner_places": "Lugares con beneficio"
  },
  "coupon": {
    "title": "Tu cupón",
    "show_code": "MOSTRÁ ESTE CÓDIGO",
    "validate_hint": "El negocio puede validarlo en tricigo.com/v",
    "mark_used": "Ya lo usé",
    "marked_used": "Cupón marcado como usado",
    "mark_failed": "No se pudo marcar el cupón",
    "expired_title": "Este cupón ya no está disponible",
    "expired_body": "Tu próximo viaje a ese lugar te da uno nuevo."
  }
```

`en/rider.json`:

```json
  "home": {
    "partner_places_label": "PLACES WITH A PERK",
    "partner_has_coupon": "You already have an active coupon here",
    "dashboard_coupons": "Your coupons",
    "dashboard_partner_places": "Places with a perk"
  },
  "coupon": {
    "title": "Your coupon",
    "show_code": "SHOW THIS CODE",
    "validate_hint": "The business can validate it at tricigo.com/v",
    "mark_used": "I used it",
    "marked_used": "Coupon marked as used",
    "mark_failed": "Could not mark the coupon",
    "expired_title": "This coupon is no longer available",
    "expired_body": "Your next ride there earns you a new one."
  }
```

`pt/rider.json`:

```json
  "home": {
    "partner_places_label": "LUGARES COM BENEFÍCIO",
    "partner_has_coupon": "Você já tem um cupom ativo aqui",
    "dashboard_coupons": "Seus cupons",
    "dashboard_partner_places": "Lugares com benefício"
  },
  "coupon": {
    "title": "Seu cupom",
    "show_code": "MOSTRE ESTE CÓDIGO",
    "validate_hint": "O negócio pode validá-lo em tricigo.com/v",
    "mark_used": "Já usei",
    "marked_used": "Cupom marcado como usado",
    "mark_failed": "Não foi possível marcar o cupom",
    "expired_title": "Este cupom não está mais disponível",
    "expired_body": "Sua próxima viagem até lá dá um novo."
  }
```

- [ ] **Step 2: Add the admin keys**

Into `sidebar` in each `admin.json`: `"partners"` → `"Lugares aliados"` (es) / `"Partner places"` (en) / `"Lugares parceiros"` (pt).

Into `platform_config`, the help text for the config key:

- es: `"partner_places_discovery_radius_m_help": "Radio en metros dentro del cual el pasajero ve lugares aliados en el inicio. 15000 = 15 km."`
- en: `"partner_places_discovery_radius_m_help": "Radius in metres within which a passenger sees partner places on the home. 15000 = 15 km."`
- pt: `"partner_places_discovery_radius_m_help": "Raio em metros dentro do qual o passageiro vê lugares parceiros no início. 15000 = 15 km."`

- [ ] **Step 3: Register the config key in the admin registry**

In `apps/admin/src/app/settings/platform-config/page.tsx`, add to `KNOWN_KEYS`:

```ts
  partner_places_discovery_radius_m: {
    type: 'number',
    helpKey: 'platform_config.partner_places_discovery_radius_m_help',
  },
```

- [ ] **Step 4: Verify the JSON is valid**

Run:
```bash
node -e "for (const l of ['es','en','pt']) for (const f of ['rider','admin']) JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/'+l+'/'+f+'.json','utf8')); console.log('all locale files parse')"
```
Expected: `all locale files parse`

> Edit these files as **text**. Never round-trip them through `JSON.parse` + `JSON.stringify` — it mangles the existing escaping (see the i18n trap in CLAUDE.md).

- [ ] **Step 5: Commit**

```bash
git add packages/i18n/src/locales apps/admin/src/app/settings/platform-config/page.tsx
git commit -m "feat(i18n): partner places and coupon copy in es/en/pt"
```

---

## Task 13: Full verification

**Files:** none — this task produces evidence, not code.

- [ ] **Step 1: Full type-check**

Run: `pnpm check-types`
Expected: PASS in all four apps. Paste the output into the PR.

- [ ] **Step 2: Full test suite**

Run: `pnpm --filter @tricigo/api test`
Expected: all pre-existing tests plus the 13 new ones pass. Record the count.

- [ ] **Step 3: Lint the changed files only**

Run: `pnpm lint 2>&1 | tail -30`
Expected: no NEW warnings in files this branch touched. `apps/driver/app/(tabs)/index.tsx` has 12 pre-existing `react-hooks/exhaustive-deps` warnings — those are intentional, leave them.

- [ ] **Step 4: Re-check the migration numbers**

Run: `git fetch origin master && git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -5`
Expected: nothing in the `00532`–`00536` range. If a parallel session took them, renumber the whole block contiguously and re-commit.

- [ ] **Step 5: Write the post-apply verification script**

Create `supabase/verify-partner-coupons.sql` — this is **run by whoever applies the migrations**, not by you:

```sql
-- Post-apply verification for 00532-00536. Runs entirely inside a
-- transaction that is rolled back: net.http_post enqueues into
-- net.http_request_queue, which IS transactional, so the rollback cancels
-- every push. Nothing reaches a real passenger.
BEGIN;

-- A partner place on top of a well-known Havana corner.
INSERT INTO partner_places (id, name, location, benefit_title, benefit_description, radius_m, coupon_ttl_minutes)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
        'QA Panadería',
        ST_SetSRID(ST_MakePoint(-82.3666, 23.1357), 4326)::geography,
        'Café gratis', 'Un café con tu compra', 80, 120);

-- 1. A ride ending ON the place issues exactly one coupon.
WITH r AS (
  SELECT id FROM rides
  WHERE status <> 'completed' AND customer_id IS NOT NULL
  LIMIT 1
)
UPDATE rides SET
  status = 'completed',
  dropoff_location = ST_SetSRID(ST_MakePoint(-82.3666, 23.1357), 4326)::geography
WHERE id = (SELECT id FROM r);

SELECT 'issued_inside_radius' AS check,
       count(*) AS got, 1 AS want
FROM partner_coupons WHERE partner_place_id = 'aaaaaaaa-0000-0000-0000-000000000001';

-- 2. The code shape: 6 chars, no ambiguous glyphs.
SELECT 'code_shape' AS check,
       bool_and(code ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$') AS ok
FROM partner_coupons WHERE partner_place_id = 'aaaaaaaa-0000-0000-0000-000000000001';

-- 3. Validating that code returns 'valid'.
SELECT 'validate' AS check,
       validate_partner_coupon(
         (SELECT code FROM partner_coupons
          WHERE partner_place_id = 'aaaaaaaa-0000-0000-0000-000000000001' LIMIT 1)
       ) ->> 'status' AS status;

-- 4. Redeeming works once, and the second attempt reports 'used'.
SELECT 'redeem_first' AS check,
       redeem_partner_coupon(
         (SELECT code FROM partner_coupons
          WHERE partner_place_id = 'aaaaaaaa-0000-0000-0000-000000000001' LIMIT 1)
       ) ->> 'status' AS status;

SELECT 'redeem_second' AS check,
       redeem_partner_coupon(
         (SELECT code FROM partner_coupons
          WHERE partner_place_id = 'aaaaaaaa-0000-0000-0000-000000000001' LIMIT 1)
       ) ->> 'status' AS status;

-- 5. An unknown code leaks nothing.
SELECT 'unknown_code' AS check, validate_partner_coupon('ZZZZZZ') ->> 'status' AS status;

ROLLBACK;
```

Expected results when run: `issued_inside_radius` got=1 want=1 · `code_shape` ok=true · `validate` status=`valid` · `redeem_first` status=`redeemed` · `redeem_second` status=`used` · `unknown_code` status=`not_found`.

- [ ] **Step 6: Commit and open the PR**

```bash
git add supabase/verify-partner-coupons.sql
git commit -m "test(partners): post-apply verification script for 00532-00536"
```

Write the PR body to a temp file and use `--body-file` — PowerShell here-strings break on markdown backticks:

```bash
gh pr create --title "feat(partners): partner places with arrival coupons" --body-file .pr-body-temp.md --base master --head claude/configurable-locations-discounts-390ae5
rm .pr-body-temp.md
```

The PR body must state: **migrations 00532–00536 are NOT applied to production (MCP guard); every client reader tolerates their absence and the affected sections simply do not render.** Include the cross-app parity answers (client ✓, web ✓, admin ✓, driver — not applicable, the driver has no role in this feature) and the `pnpm check-types` / test output as evidence.

---

## Self-review notes

**Spec coverage.** Every section of the spec maps to a task: schema → 1; issuance trigger and code generator → 2; the five RPCs → 3; reminder cron → 4; push whitelist → 5; types and service → 6; admin surface → 7; discovery → 8; ticket, banner and both home states → 9; business-facing page → 10; web parity → 11; copy and the config knob → 12; testing → 13.

**One addition beyond the spec:** migration `00536` for the admin CRUD RPCs. The spec named five RPCs — all passenger- and business-facing — and never said how the admin reads or writes `partner_places`. RLS alone would let the admin app hit the table through PostgREST, but every other admin surface in this codebase goes through a `SECURITY DEFINER` RPC with an explicit `is_admin()` gate, and the issued/redeemed counters need an aggregate the client cannot express cleanly. Following the house pattern.

**Deliberately not built** (all listed as out of scope in the spec): business reimbursement, a merchant app, a perk badge in address search, customer coupon history, paid carousel placement, photo upload, and any link to `cuba_pois`.
