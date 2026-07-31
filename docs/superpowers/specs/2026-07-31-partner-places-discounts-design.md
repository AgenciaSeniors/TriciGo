# Partner Places & Arrival Coupons — Design

**Date:** 2026-07-31
**Status:** Approved by user (question-by-question, then full design)

**Problem:** TriciGo has no way to turn a ride into value for a local business, and no way to give
a passenger a reason to pick one destination over another. Admin can already create places by hand
(`cuba_pois`, `source='admin'`, 389 rows today) but a place carries no commercial meaning — it is
just an address.

**Goal:** admin configures a partner business (a bakery, a café) with coordinates and a negotiated
perk. Any passenger whose ride ends at that business earns a single-use coupon — free coffee, 2x1,
20% off, whatever was agreed — redeemable at the counter. The business absorbs the perk; TriciGo
brings it customers and can prove how many.

---

## User decisions (recorded verbatim intent)

| Topic | Decision |
|---|---|
| Redemption mechanism | **Coupon with a unique code in the app.** Staff reads the code; no merchant app required. |
| Who funds the perk | **The business absorbs it.** Zero money movement inside TriciGo — no ledger, no settlement, no invoicing. |
| Eligibility | **Any ride that ends there.** Proximity match on the ride's dropoff, regardless of how the passenger booked. |
| Frequency limit | **None.** `cooldown_days` ships as a knob defaulted to `0` (unlimited) so a business can later ask for a cap without a code change. |
| Coupon lifetime | **2 hours** from arrival. |
| Clock start | **At arrival**, plus a reminder push at 30 minutes remaining. |
| Data model | **Standalone table, no POI link.** Admin creates one object, not two. |
| Code verification | **Both:** live countdown (works offline) *and* a code the business validates on a public page. |
| Home presentation | **Large hero card in a carousel**, below the service selector. |

### Two decisions worth re-reading before implementation

**Why "no POI link" is safe.** The initial concern was that a standalone place would not appear in
address search, so a passenger searching "Sylvain" would miss the perk. That concern is weak here:
eligibility is decided by **proximity to the dropoff**, so a passenger who found the bakery through
normal address search and was dropped there **still earns the coupon**. The only thing lost is a
"has a perk" badge inside search results, which is not part of this scope.

**Why losing a coupon is not painful.** Because there is no frequency limit, an expired or missed
coupon is not a burned opportunity — the next ride ending at the same place issues a fresh one.
Had the frequency been "once per customer, ever", expiry would have been a serious UX problem and
this design would need a recovery path. It does not.

---

## Architecture

Two new tables, one trigger, five RPCs, one cron. No changes to `complete_ride_and_pay`, no changes
to pricing, no changes to the ledger.

### `partner_places` — the business and the agreement

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | text NOT NULL | "Panadería Sylvain" |
| `location` | geography(Point,4326) NOT NULL | GIST-indexed |
| `address`, `municipality`, `province` | text | Display + admin filtering |
| `category` | text | Reuses TriciGo categories → drives the emoji via `tricigoCategoryEmoji` |
| `photo_url` | text | Pasted URL, same as `home_announcements.image_url`. **No file upload.** |
| `benefit_title` | text NOT NULL | "Café gratis" — short, renders in the orange pill |
| `benefit_description` | text NOT NULL | "Un café con tu compra, solo por llegar en TriciGo" |
| `terms` | text | Optional fine print: "no acumulable, hasta agotar existencias" |
| `radius_m` | int NOT NULL DEFAULT 80 | Match radius |
| `coupon_ttl_minutes` | int NOT NULL DEFAULT 120 | Coupon lifetime |
| `cooldown_days` | int NOT NULL DEFAULT 0 | **0 = unlimited** (the parked knob) |
| `is_active` | bool NOT NULL DEFAULT true | |
| `valid_until` | timestamptz NULL | Agreement end date; NULL = open-ended |
| `phone`, `hours` | text | Shown on the coupon detail |
| `created_at`, `updated_at`, `created_by` | | |

**No `priority` column.** The carousel orders by distance to the passenger. Manual/paid placement
is deferred until a business actually asks for it.

### `partner_coupons` — one issued coupon

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `partner_place_id` | uuid NOT NULL → `partner_places` | |
| `user_id` | uuid NOT NULL → `users` | |
| `ride_id` | uuid NOT NULL → `rides` | |
| `code` | text NOT NULL UNIQUE | 6 chars, stored bare; displayed as `TG-XXXXXX` |
| `issued_at` | timestamptz NOT NULL DEFAULT now() | |
| `expires_at` | timestamptz NOT NULL | `issued_at + coupon_ttl_minutes` |
| `redeemed_at` | timestamptz NULL | |
| `redeemed_via` | text NULL | `'business'` (verified) or `'self'` (customer self-reported) |
| `reminded_at` | timestamptz NULL | Set by the 30-minute reminder cron |
| | | `UNIQUE (ride_id, partner_place_id)` |

**No status column.** State is derived: `redeemed_at IS NOT NULL` → redeemed; `now() > expires_at`
→ expired; otherwise active. One less thing to keep in sync.

`redeemed_via` is not cosmetic. A coupon closed by the business is verified evidence; one closed by
the customer is a claim. When renewing an agreement, only the first number is worth quoting.

### Coupon code

`TG-` prefix (display only) + 6 characters drawn from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` — digits and
letters with `0`, `1`, `I`, `L`, `O` removed, because the code gets read aloud across a noisy
counter. 31^6 ≈ 887 million combinations.

Six characters rather than four **because of the public validation page**: a shorter code invites
brute-forcing valid codes to mark other people's coupons as used. Combined with per-IP rate
limiting this closes the hole; two extra characters cost the employee nothing.

Collision handling: `UNIQUE` constraint plus bounded retry on conflict.

The validation RPC normalizes input before lookup — uppercase, strip whitespace, strip dashes,
strip a leading `TG` — so an employee typing `tg-k7m2qx`, `K7M2QX`, or `k7 m2 qx` all resolve.

### Issuance — trigger on `rides`

```
AFTER UPDATE ON rides
WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed')
```

**Why a table trigger and not a branch inside `complete_ride_and_pay`:** the round-6 launch audit
found **two distinct code paths** that move a ride to `completed`. A trigger on the table catches
both; a branch inside one RPC would leave a silent gap.

The trigger body:

1. Find active places where `ST_DWithin(pp.location, NEW.dropoff_location, pp.radius_m)`, honouring
   `is_active` and `valid_until`.
2. Skip a place when `cooldown_days > 0` and this customer already has a coupon for it inside the
   window. `cooldown_days = 0` skips this check entirely.
3. Insert the coupon with a generated code and `expires_at = now() + coupon_ttl_minutes`.
   `ON CONFLICT (ride_id, partner_place_id) DO NOTHING` makes re-entry harmless.
4. Fire the arrival push via `net.http_post`, the shape every push-sending trigger already uses
   (`trg_notify_driver_new_offer`). Raw `net.http_post` is correct **inside a trigger**; the rule
   against it applies to crons — see below.

Wrapped in `EXCEPTION WHEN OTHERS THEN RAISE WARNING …; RETURN NEW`. **A marketing perk must never
block the completion or payment of a ride.** Same defensive shape as the tier trigger (00371) and
the driver-contract trigger (00405).

Proximity is measured against `rides.dropoff_location` — the *requested* destination, not a GPS fix
at drop-off, which the schema does not store. This means the coupon is issued on intent: a driver
who stops half a block short still earns the passenger the perk, which is the fair reading.

### Reminder cron

A `pg_cron` job **running every 5 minutes** calls a SQL function that selects unredeemed, unexpired
coupons with 25–35 minutes remaining and `reminded_at IS NULL`, sends one push each, and stamps
`reminded_at`. The ten-minute window against a five-minute cadence guarantees every coupon is seen
at least once without ever being seen twice; `reminded_at` is the belt to that suspenders.

Each push **must** be dispatched through `public.cron_http_post(...)`, never `net.http_post`
directly. This is the hard rule in CLAUDE.md: a cron calling an Edge Function through raw
`net.http_post` is blind to HTTP failures — `cron.job_run_details` reports success while the call
502s. That blindness is what froze the exchange rate for four days.

### RPCs

| RPC | Caller | Purpose |
|---|---|---|
| `get_nearby_partner_places(lat, lng, limit)` | authenticated | Active places within the discovery radius, ordered by distance, with `distance_m` and whether the caller already holds an active coupon |
| `get_my_partner_coupons()` | authenticated | The caller's active coupons (`auth.uid()` only) |
| `validate_partner_coupon(code)` | **anon** | Rate-limited. Returns status + business + benefit + customer first name & initial + arrival time |
| `redeem_partner_coupon(code)` | **anon** | Rate-limited. Atomic claim, sets `redeemed_via = 'business'` |
| `redeem_own_partner_coupon(coupon_id)` | authenticated | The "Ya lo usé" fallback, sets `redeemed_via = 'self'` |

Both redemption paths use `UPDATE … WHERE redeemed_at IS NULL RETURNING` — the same atomic-claim
shape as the NETOPIA webhook. Two employees validating the same code concurrently: one wins, the
other sees "already used". No double delivery.

The anon RPCs return the minimum needed to serve a customer: business name, benefit, first name with
last initial, and how long ago the passenger arrived. An unknown code returns `not_found` and
nothing else — no hint about which codes exist.

---

## Client surfaces

**Discover.** Hero carousel below the service selector on the passenger home. Full-width card:
photo, orange benefit pill, business name, description, distance. Tapping sets the place as
destination and enters the booking flow, reusing the path the announcement cards already take. When
no place is within the discovery radius the section does not render at all — same as PROMOS and
CAMPAÑAS behave today.

The RPC needs a location fix to order by distance. **Without one — permission denied, or no fix yet
— the section does not render.** It is not worth showing a passenger a bakery that might be in
another province; the coupon still gets issued on arrival regardless, so nothing is actually lost.

**Earn.** The ticket appears on the ride-complete screen, accompanied by a push: *"Llegaste a
Panadería Sylvain — tenés un café gratis, mostrá tu cupón."* With a two-hour window the push is
load-bearing, not decoration: a passenger who pocketed the phone has no other signal.

**Use.** While a coupon is live, a banner sits at the top of the home with the countdown running;
more than one active coupon renders as a list. Tapping opens the full ticket — code, countdown,
terms, business address and phone, and a line telling the employee where to validate.

**Close.** The business validates at `tricigo.com/v` and confirms. The passenger's "Ya lo usé"
button stays as the offline fallback and records `redeemed_via = 'self'`.

**Closing the app loses nothing.** The coupon is a server-side row, not device state. What runs is
the clock, not the app.

**Web parity** (mandatory per CLAUDE.md): the same section inside
`apps/web/src/components/HomeDashboard.tsx`, which already carries the last-ride, promos and
announcements sections, plus the coupon view.

**Ships over the air.** `apps/client/app.json` has `updates.enabled: true` with
`runtimeVersion.policy: appVersion`, and nothing in this feature needs a native module — no camera,
no QR library. Installed apps get it via EAS Update without a store release.

---

## Business-facing surface

A public, unauthenticated route at `tricigo.com/v`:

1. **Input** — one field, six characters, one button.
2. **Valid** — green verdict plus business, benefit, customer first name & initial, and arrival time
   ("14:32 · hace 8 min"). A "Confirmar entrega" button closes it.
3. **Already used** — red, with the redemption time.
4. **Expired / unknown** — red, with a one-line explanation.

Built for a cheap phone on a weak connection: large type, no images, minimal payload. Rate-limited
per IP through the existing `check_rate_limit`.

---

## Admin surface

New page **Lugares aliados**.

**List:** name, municipality, benefit, status, and **issued / redeemed** with the redemption
percentage. That last column is the health of the agreement — 200 issued against 12 redeemed means
the perk does not interest anyone and the deal needs renegotiating.

**Form:** the place (name, category, coordinates via `react-leaflet` map picker — consistent with
`/fleet` and `/live-map`, per CLAUDE.md — address, phone, hours, photo URL), the benefit (title,
description, fine print), and the knobs (radius, TTL, cooldown, active, agreement end date).

**Detail:** the coupons issued for that place with their state and how each was closed.

Discovery radius goes to `platform_config` as `partner_places_discovery_radius_m` (default 15000),
with its entry in `KNOWN_KEYS` in `settings/platform-config` and help text in es/en/pt — the
convention already written in CLAUDE.md. Rows without that metadata render raw.

## Copy and i18n

All customer-facing copy — section label, coupon screen, banner, both push notifications, the four
verdicts on the validation page — is real copy, so it goes in es/en/pt across the relevant
namespaces. Trivial accessibility labels may use the `t('key', { defaultValue: '…' })` shorthand
without a JSON entry, per the post-2026-04 convention.

The business-facing validation page is **Spanish only**. Its audience is a shop employee in Cuba;
translating it would be pretend work.

---

## Security

- RLS enabled on both tables, no exceptions.
- `partner_places`: `SELECT` for authenticated; write for admin only.
- `partner_coupons`: a customer sees **only their own** (`user_id = auth.uid()`); admin sees all;
  no client-side `INSERT` — issuance happens exclusively inside the `SECURITY DEFINER` trigger.
- Anon RPCs are `SECURITY DEFINER` with per-IP rate limiting and a minimal return shape.
- Any view created ships with `security_invoker = true` (Postgres defaults to definer, which
  bypasses the caller's RLS).
- Authorization gates use explicit `COALESCE` — a three-valued gate without it fails **open**.
- A new push category (`partner_coupon`) must be added to the `send-push` whitelist from migration
  00380, otherwise the notifications are silently dropped.

---

## Failure modes

| Failure | Behaviour |
|---|---|
| Coupon issuance throws | Ride still completes and charges. `EXCEPTION WHEN OTHERS THEN RETURN NEW`. |
| Migration not yet applied in prod (MCP guard) | RPC missing → hook returns `[]` → section does not render. No crash, no error toast. The frontend-tolerance pattern CLAUDE.md marks as mandatory. |
| Two employees validate the same code at once | Atomic claim; one succeeds, the other sees "already used". |
| No connectivity at the counter | Employee cannot validate; the countdown on the passenger's phone remains the fallback control. Closed as `self`, not `business`. |
| Passenger arrives with no mobile data | The clock still runs. Mitigated by the 30-minute reminder push and, ultimately, by unlimited frequency — the next ride issues a fresh coupon. |
| Push permission denied | Banner on home plus the carousel card remain as discovery paths. |

---

## Testing

**SQL, inside `BEGIN … ROLLBACK` against prod** — the same pattern used to verify dispatch without
disturbing real drivers (`net.http_post` enqueues transactionally, so a rollback cancels the pushes):

- Dropoff inside the radius issues exactly one coupon.
- Dropoff outside the radius issues none.
- The same ride re-entering `completed` still yields one coupon (idempotency).
- An inactive place, or one past `valid_until`, issues none.
- With `cooldown_days > 0`, a second ride inside the window issues none; `cooldown_days = 0` always
  issues.
- Redemption is atomic: a second `redeem_partner_coupon` on the same code returns "already used".
- An expired coupon validates as expired, not valid.

**Vitest in `packages/api`:** service-layer error propagation for validate/redeem, and the
absent-RPC path returning empty instead of throwing.

---

## Migration numbering

Next free number is **00529**, verified against `origin/master` (latest `00528`) **and** all seven
open PRs, none of which add migrations. Re-check immediately before pushing — a parallel session can
land the number in the meantime.

---

## Explicitly out of scope

- Reimbursing businesses. The business absorbs the perk; no ledger involvement of any kind.
- A merchant app or merchant accounts. The validation page is public and stateless by design.
- A "has a perk" badge inside address-search results.
- Coupon history for the customer (expired/past coupons). Active coupons only.
- Paid or manual placement in the carousel. Distance ordering only.
- Photo upload. Admin pastes a URL, as with announcements today.
- Linking a partner place to a `cuba_pois` row. Additive later if the search badge is ever wanted.
