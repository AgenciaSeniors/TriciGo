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
| Duplicate coupons | **Not issued** while a live unredeemed coupon for the same place exists. Deduplication, not a frequency cap. |
| Re-entry to a live coupon | **Home banner in both home states** (idle and ride-in-progress) plus the two pushes. No dedicated screen. |
| Data model | **Standalone table, no POI link.** Admin creates one object, not two. |
| Code verification | **Both:** live countdown (works offline) *and* a code the business validates on a public page. |
| Who may validate | **Each business gets its own secret link** `tricigo.com/v/<token>`. Rate limiting keys on the business, not the caller's IP — see "Business-facing surface" for why the IP version was abandoned. A coupon validates only at the business that issued it. |
| Home presentation | **Large hero card in a carousel**, immediately after the Capitolio divider and **above Promos**. The mockup this was approved from showed it under the service selector, but that layout does not exist — Servicios sits at the very bottom of the real home, so following the mockup would have buried the row. Placed above Promos on the owner's decision; the cost is that TriciGo's own ride promos drop one position. |

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
brute-forcing valid codes to mark other people's coupons as used. Combined with per-business rate
limiting this closes the hole; two extra characters cost the employee nothing.

Collision handling: `UNIQUE` constraint plus bounded retry on conflict.

The validation RPC normalizes input before lookup — uppercase, strip whitespace, strip dashes, and
strip a leading `TG` **only when doing so leaves exactly six characters** — so an employee typing
`tg-k7m2qx`, `K7M2QX`, or `k7 m2 qx` all resolve.

That length condition is load-bearing, not defensive tidiness. `T` and `G` are both in the code
alphabet, so a legitimate code can itself begin `TG` — `TG4K9P`. Stripping unconditionally would
truncate it to four characters, fail the length check, and return `not_found`: roughly **1 coupon in
961 permanently unredeemable**, with no workaround the passenger could find and no explanation the
shop could give. The displayed form is eight characters and a bare code is six, so the rule is
unambiguous.

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
3. Skip a place when this customer **already holds a live, unredeemed coupon** for it
   (`redeemed_at IS NULL AND expires_at > now()`). This is deduplication, not a frequency limit:
   once that coupon is redeemed or expires, the next qualifying ride issues a fresh one. Without it,
   a passenger riding twice to the same bakery inside two hours ends up holding two valid codes for
   one free coffee — which is precisely what the business does not want to see at the counter.
4. Insert the coupon with a generated code and `expires_at = now() + coupon_ttl_minutes`.
   `ON CONFLICT (ride_id, partner_place_id) DO NOTHING` makes re-entry harmless.
5. Fire the arrival push via `net.http_post`, the shape every push-sending trigger already uses
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
`reminded_at`. The two guards do different jobs and both are required: the ten-minute window against
a five-minute cadence guarantees every coupon is caught **at least once** (no coupon slips between
ticks), while `reminded_at` guarantees **at most once** (a coupon caught by two consecutive ticks is
only pushed on the first). Neither alone is sufficient.

Each push **must** be dispatched through `public.cron_http_post(...)`, never `net.http_post`
directly. This is the hard rule in CLAUDE.md: a cron calling an Edge Function through raw
`net.http_post` is blind to HTTP failures — `cron.job_run_details` reports success while the call
502s. That blindness is what froze the exchange rate for four days.

### RPCs

| RPC | Caller | Purpose |
|---|---|---|
| `get_nearby_partner_places(lat, lng, limit)` | authenticated | Active places within the discovery radius, ordered by distance, with `distance_m` and whether the caller already holds an active coupon |
| `get_my_partner_coupons()` | authenticated | The caller's active coupons (`auth.uid()` only) |
| `validate_partner_coupon(token, code)` | **anon** | Rate-limited per business. Returns status + business + benefit + customer first name & initial + arrival time |
| `redeem_partner_coupon(token, code)` | **anon** | Rate-limited per business. Atomic claim, sets `redeemed_via = 'business'` |
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
`useRefreshOnFocus` keeps the countdown and the list honest — a screen that fetches once on mount
would freeze, which is the stale-on-mount class CLAUDE.md marks as a permanent audit dimension.

**The ticket is an ordinary screen, not a trap.** It closes, it reopens as many times as wanted, and
booking another ride does nothing to the coupon — they are independent. Nothing the passenger does
in the app consumes a coupon except redeeming it.

**The banner renders in BOTH home states.** This is the one detail that makes the banner sufficient
on its own. The obvious implementation — putting it in the idle home — breaks exactly where it
matters: a passenger who closes the ticket and books another ride gets the home replaced by the
tracking view, and the banner goes with it. So the banner is also drawn **above the ride-tracking
card**, in a compact variant, whenever a coupon is live.

Two re-entry paths total:

| Path | Works when |
|---|---|
| Home banner, both states (idle and ride-in-progress) | Whenever the passenger is on Inicio. |
| The two pushes (arrival, and 30 minutes remaining), deep-linking to the ticket | Always, including with the app closed — but only if notifications are permitted. |

**Accepted cost, stated plainly:** a passenger sitting on another tab — Billetera, Mis viajes,
Perfil — sees nothing and must return to Inicio. A dedicated "Mis cupones" menu entry would cover
that, and was deliberately rejected in favour of maintaining one surface instead of two. With push
permission granted this gap is nearly invisible; without it, the coupon depends on the passenger
returning to Inicio unprompted.

**Close.** The business validates at `tricigo.com/v` and confirms. The passenger's "Ya lo usé"
button stays as the offline fallback and records `redeemed_via = 'self'`.

**Closing the app loses nothing.** The coupon is a server-side row, not device state. What runs is
the clock, not the app.

**Web parity** (mandatory per CLAUDE.md): the same section inside
`apps/web/src/components/HomeDashboard.tsx`, which already carries the last-ride, promos and
announcements sections, plus the coupon view and the same banner treatment.

**Ships over the air.** `apps/client/app.json` has `updates.enabled: true` with
`runtimeVersion.policy: appVersion`, and nothing in this feature needs a native module — no camera,
no QR library. Installed apps get it via EAS Update without a store release.

---

## Business-facing surface

A public, unauthenticated route at **`tricigo.com/v/<token>`** — each partner business gets its own
secret link, handed over when the deal is signed.

### Why a per-business link, and not just an IP rate limit

The first design rate-limited the public endpoints per IP, derived from `X-Forwarded-For`. A code
reviewer demonstrated on a QA branch that this is worthless, and worse than nothing:

- **It reads the leftmost element of the header, which the client writes.** Supabase's edge appends
  the real IP to the *right*. Three anonymous requests carrying two forged headers produced three
  separate buckets.
- **It hands an attacker a targeted denial of service.** Sending `X-Forwarded-For: <a chosen
  bakery's IP>` thirty times locks that shop out of validating coupons, and `check_rate_limit`
  increments unconditionally, so holding it there costs almost nothing.
- **It lets an anonymous caller mint unbounded rows** in `rate_limits`, keyed by arbitrary text.

And the mirror failure, specific to this market: **Cuban mobile data is near-universally CGNAT**, so
several partner businesses share one public egress IP and would exhaust a shared bucket honestly.
The same mechanism was simultaneously too weak against a forger and too strong against real shops.

The token fixes all of it by changing *what counts as identity*: a secret the business holds rather
than a header the caller asserts. It also buys a correctness win that was missing entirely —
**a coupon now only validates at the business that issued it**. Under the first design a bakery's
coupon would have redeemed at a café.

Shape: 12 lowercase hex characters (`encode(gen_random_bytes(6),'hex')`, ≈2.8×10¹⁴). Hex rather than
the coupon alphabet because this string lives in a URL an employee bookmarks and retypes, where case
ambiguity is the enemy. Generated automatically on insert; surfaced in the admin for copying.

Rate limiting keys on the **resolved `partner_place_id`** — a UUID, so cardinality is bounded by the
partner count and nothing a caller sends can affect it. Tokens that do not resolve share a single
bucket and return `invalid_link` with no other detail. Budget and window are `platform_config` keys
(`coupon_validate_max_per_window`, `coupon_validate_window_s`), not literals, so they can be tightened
during an incident without shipping a migration.

The flow itself:

1. **Input** — one field, six characters, one button.
2. **Valid** — green verdict plus business, benefit, customer first name & initial, and arrival time
   ("14:32 · hace 8 min"). A "Confirmar entrega" button closes it.
3. **Already used** — red, with the redemption time.
4. **Expired / unknown** — red, with a one-line explanation.

Built for a cheap phone on a weak connection: large type, no images. Rate-limited per business
through the existing `check_rate_limit`.

The page also declares `robots: { index: false, follow: false }`. `robots.ts` only disallows `/api/`
and `/login`, and **a crawled token is a leaked token** — the entire security model rests on that URL
staying private.

**Where the payload promise is only half kept, stated honestly:** the page's own content is ~2.7 kB,
but it inherits the marketing header and footer from the root layout, so a first load is ~303 kB.
Removing that means restructuring the shared root layout, which touches every page on the site;
`track/share/[token]` already lives with the same cost. It matters only on the employee's *first*
open — the page is then cached and bookmarked — so it is accepted rather than fixed, but it should
not be described as a minimal payload.

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
- Anon RPCs are `SECURITY DEFINER`, rate-limited **per partner business** (never per IP — an IP is
  whatever the caller says it is), and return a minimal shape.
- `REVOKE ... FROM PUBLIC` **alone does nothing in this project**: `pg_default_acl` grants EXECUTE
  explicitly to `anon`, `authenticated` and `service_role` on every new function in `public`, so
  there is no PUBLIC grant to remove. Always `REVOKE ... FROM PUBLIC, anon, authenticated`, then
  GRANT back only what is needed. The effective ACL also depends on *which role applies the
  migration* — `postgres` and `supabase_admin` have different defaults — so the fuller form is the
  only one correct under both.
- The two `pc.user_id = auth.uid()` predicates in the reader RPCs are the data-isolation boundary.
  Both functions are `SECURITY DEFINER`, so RLS is bypassed and those lines are the only thing
  separating one passenger's coupons from everybody else's. They are commented as such in the SQL.
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
- A second ride to the same place while a live unredeemed coupon exists issues none; after that
  coupon is redeemed or expires, a further ride issues one again.
- Redemption is atomic: a second `redeem_partner_coupon` on the same code returns "already used".
- An expired coupon validates as expired, not valid.

**Vitest in `packages/api`:** service-layer error propagation for validate/redeem, and the
absent-RPC path returning empty instead of throwing.

---

## Deploy order — this one is not cosmetic

**Deploy the `send-push` Edge Function BEFORE applying the migrations.**

`send-push` 400s on any category outside its curated whitelist. Until `partner_coupon` is in that
list, every push this feature sends is rejected. Two senders are affected: the arrival push in the
issuance trigger (00533) and the reminder cron (00535).

The arrival push failing is merely a lost notification — the coupon still exists, and the banner
still shows it. The reminder is worse. 00535 stamps `reminded_at` the moment it dispatches, because
`pg_net` is asynchronous and delivery cannot be confirmed in the same transaction. That is the right
call for at-most-once, but it means **a coupon whose reminder 400s is burned permanently** and will
never get a second one.

One mitigating detail, by construction rather than luck: the reminder goes out through
`cron_http_post`, so a 400 is visible to the cron watchdog instead of being reported as a success
the way raw `net.http_post` would.

The safe sequence:

1. Deploy `send-push`.
2. Apply migrations 00532–00536.
3. Create the first partner place in the admin. **Nothing can fire before this** — with no partner
   places, no ride matches and no coupon is ever issued, which is the natural safety margin.
4. Deploy web (admin page + `/v/<token>`).
5. Ship the client over the air.

## Migration numbering

Next free number is **00532**, verified against `origin/master` (latest `00528`) **and** all seven
open PRs, none of which add migrations. Re-check immediately before pushing — a parallel session can
land the number in the meantime.

---

## Explicitly out of scope

- Reimbursing businesses. The business absorbs the perk; no ledger involvement of any kind.
- A merchant app or merchant accounts. The validation page is public and stateless by design.
- A "has a perk" badge inside address-search results.
- Coupon history for the customer (expired/past coupons). Active coupons only.
- A dedicated "Mis cupones" screen or menu entry. Considered and rejected: the home banner rendered
  in both states covers the same gap with one surface instead of two. Revisit if telemetry shows
  coupons expiring unredeemed at a meaningful rate.
- Paid or manual placement in the carousel. Distance ordering only.
- Photo upload. Admin pastes a URL, as with announcements today.
- Linking a partner place to a `cuba_pois` row. Additive later if the search badge is ever wanted.
