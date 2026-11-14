# Automatic apology when a ride finds no driver

Date: 2026-11-14. Builds on 00674 (the manual apology coupon, `docs/superpowers/specs/2026-11-02-missed-ride-apology-coupon-design.md`).

## Goal

When a passenger's ride ends with no driver, the passenger gets an apology from support, plus 10 % off
their next ride, without anyone on the team doing anything. Measured on 2026-11-14: 45 such rides by
22 people in 14 days.

## Decisions (owner, 2026-11-14)

- **Trigger:** a passenger ride canceled with no driver after waiting `support_alert_after_s` (60 s) or
  more. The passenger may have canceled it, or the server may have closed it because the passenger left
  the app (`searching_abandoned`). This is the same rule as the "Sin chofer" list (`_missed_rider_summary`).
- **Frequency:** once per confirmed phone, ever. The automatic path and the WhatsApp path from
  "Sin chofer" (00674) share this limit: whoever got the coupon one way never gets it the other way.
- **Message:** a push, which also lands in the Notificaciones inbox, plus a support ticket in the
  person's name with the apology message.
- **Discount:** the migration creates the apology promotion itself at 10 %, active. Marketing can edit
  or pause it in Promociones.
- **Mechanism:** a server job that runs every minute (option A), not a trigger inside the cancellation.
  It never slows down or blocks a cancellation, and the cron watchdog sees it if it fails. The push can
  arrive up to a minute after the cancellation.

## Design

### 1. The apology promotion

The migration inserts a `grant_only` promotion: code `PERDON10`, 10 % off, `is_public = false`,
`first_ride_only = false` (00674's CHECKs require both), `is_active = true`, no dates, no use limit.
`_missed_ride_current_coupon()` already picks the newest active grant-only promotion, so the WhatsApp
path uses this promotion too.

The insert runs only if no grant-only promotion exists yet. If someone already created one (the
WhatsApp path needs one), the migration leaves it alone.

### 2. The job

`grant_missed_ride_apologies()`: SECURITY DEFINER, run by pg_cron every minute as
`grant-missed-ride-apologies`. No client can execute it.

- **Off switch:** `platform_config.missed_ride_auto_apology_enabled` (default `true`; registered in
  the admin's `KNOWN_KEYS`). When it is `false`, the job does nothing.
- **Candidates:** rides that meet all of these:
  - match the segment's ride rule (passenger, `canceled`, `driver_id IS NULL`, waited at least
    `support_alert_after_s`);
  - `canceled_at` is within the last 2 hours and after `missed_ride_auto_apology_since` (set to the
    moment the migration runs, so no backfill of older rides);
  - have no row yet in `missed_ride_auto_apologies`.
  
  At most 50 rides per run, oldest first.
- **Per ride, in its own block:**
  1. Record the ride in `missed_ride_auto_apologies` (ride_id is the primary key), so it is never
     processed twice.
  2. Skip, recording the reason, if any of these holds:
     - the person is outside the segment (`_missed_rider_summary(user).eligible` is false: inactive,
       test, team or system account, or already took a ride since): `not_eligible`;
     - the person has no confirmed phone: `no_phone`;
     - no apology promotion is usable right now: `no_coupon`;
     - the phone already got the coupon (`_claim_reward` says `taken`, or a `promotion_grants` row
       exists for the user): `already_given`.
  3. Otherwise:
     - claim the reward (`_claim_reward(user, 'missed_ride_coupon')`);
     - insert the grant (`promotion_grants`, `source = 'missed_ride'`, `granted_by` = the platform
       account `…0001`);
     - open the support ticket;
     - queue the push;
     - record `granted`.
- **Errors:** a ride whose block fails is skipped and logged in `rpc_attempt_log`
  (`rpc_name = 'grant_missed_ride_apologies'`, `outcome = 'failed'`). It gets no row, so the next run
  retries it while it is inside the 2-hour window. If every candidate in a run failed, the run itself
  fails, so `check_cron_sql_failures` reports it. The function has no handler around its whole body
  (CLAUDE.md, 00640).

### 3. The texts

All in tuteo, no dash punctuation.

| Piece | Text |
|---|---|
| Push title | "Perdón, no encontramos chofer" |
| Push body | "Te regalamos {descuento} en tu próximo viaje. Se aplica solo cuando lo pidas." |
| Ticket subject | "Disculpa por tu viaje sin chofer" |
| Ticket message | "Hola {nombre}, sentimos que no encontraras chofer el {día}. Para agradecerte la paciencia, tu próximo viaje tiene {descuento}: se aplica solo cuando lo pidas. Si necesitas algo más, respóndenos aquí." |

- `{descuento}` comes from the granted promotion: "10 % de descuento" for a percentage, "N CUP de
  descuento" for a fixed amount. That way, an edit in Promociones changes the text too.
- `{nombre}` is the first name, from `_third_party_person_name`; without a name, the message starts
  with "Hola,".
- `{día}` is the failed ride's day in Cuba's time zone.

### 4. Push

Sent through `cron_http_post` to `send-push`, with the label `missed-ride-apology`. Category
`system`: it is a support message, so a marketing opt-out does not silence it. The plan confirms that
`send-push` does not filter `system` by preferences. Tapping it opens the home tab; the installed
client already routes `system` there. Booking already pre-fills and validates the coupon
(`get_my_signup_promotion`, 00674).

### 5. Support ticket

- **`support_tickets`:** the person's `user_id`, the failed `ride_id`, category `ride_issue`, priority
  `low`, status `waiting_user`. The person can reply, and support sees the ticket as waiting on the
  person, not as a new case.
- **`ticket_messages`:** one message, `is_admin = true`, sender the platform account `…0001`.
- **Guards:** written by the job (`current_user` is the owner), so the client guards of 00653/00663
  do not apply.

### 6. Tracking table

`missed_ride_auto_apologies` is a lock table: RLS with no policies, GRANT to `service_role` only.

| Column | Contents |
|---|---|
| `ride_id` | PK, FK `rides` ON DELETE CASCADE |
| `user_id` | |
| `outcome` | CHECK: `granted`, `already_given`, `no_phone`, `no_coupon`, `not_eligible` |
| `grant_id` | |
| `ticket_id` | |
| `created_at` | |

The "Sin chofer" page needs no change: it already shows when a person has the coupon.

### 7. No app changes

Push routing, the inbox, the support screen and the coupon in booking already exist in the installed
apps.

## Testing

`supabase/tests/<n>/run.sh`, reusing 00674's scaffold. RED against master, GREEN with the migration
applied twice and from a CRLF copy, plus a negative test for each self-check. Cases:

- qualifying canceled ride → grant + ticket + message + push queued, once;
- second run → nothing new;
- second failed ride by the same person → `already_given`;
- same phone on another account → `already_given`;
- WhatsApp grant first → automatic path gives `already_given`;
- no phone, test account, team account, a ride taken since, waited under 60 s, has a driver, delivery
  ride, older than the cutoff, off switch → no grant;
- no usable promotion → `no_coupon`, no push, no ticket;
- one ride whose block fails does not stop the others; all failing fails the run;
- promotion text: percentage and fixed amount;
- the migration does not insert a second promotion when one exists.

Then a prod rehearsal inside a rolled-back block with the demo passenger, and the apply and merge
with the owner's OK.

## Out of scope

- Sending to people who failed before the migration runs (the "Sin chofer" page covers them by
  WhatsApp).
- Any change to the dispatch itself.
