# Team daily digest — design

Date: 2026-10-11. Status: implemented on PR #1142 (migration 00656, Edge Functions `send-team-digest` and
`team-digest-unsubscribe`, web page `/resumen-diario/baja`, two settings in the admin). Not applied to prod yet.

## Goal

Every morning at 7:00 Havana time, each member of the team with a panel role receives an email
summarising the previous day: rides, sign-ups, drivers, breakdowns, money, pending work and marketing. Marketing
sees every ride number (it uses them to decide where to focus) but never money, as in the panel,
nor the admins' work queue.

## Decisions taken with the owner

| Topic | Decision |
|---|---|
| Blocks | Rides, sign-ups, breakdowns, money, pending work, marketing, and a comparison with earlier days on every total |
| Who gets what | Directors and admins: everything. Marketing: everything except money and the admins' pending work (all ride numbers included) |
| Breakdowns | Rides by pickup municipality (top 5), by vehicle type and by time band, for every role |
| When | 7:00 Havana time, every day, weekends included. Covers the previous Havana calendar day |
| Recipients | Automatic: every active account with a panel role. Unsubscribe link (one button on a web page), with a way back |
| Build | Metrics in one SQL function (single definition of each number); rendering and sending in an Edge Function |
| Rollout | Rehearsed locally and in prod (rolled back), then sent only to the owner for a few days, then to the team, behind a switch in Settings |

Team roles decided in the same conversation (applied separately, account by account):
Alejandro and Eduardo `super_admin`; Lucía, Liannah and Luis `admin`; the Baco agency `marketing`.

## Content

All numbers are for day **D**, the Havana calendar day before the send. Each total carries its change
against **D−1** and against **D−7** (arrow and percent; "—" when the base is 0). Breakdowns show day D
only, to keep the email readable. "Pending now" is a snapshot at send time and carries no comparison.

**Day boundaries.** D runs from local midnight to local midnight in `America/Havana`. On the November
fall-back day (2026-11-01) local midnight happens twice; the day starts at the first one, so it has 25
hours. The March spring-forward day has 23. Reason: every hour of real activity belongs to exactly one day.

**Test accounts.** A ride counts when its customer is real (not `users.is_test`, not the platform account
`…0001`), whoever the driver is: a real customer's request is real demand even if a test driver took it.
Test drivers leave only the driver-side numbers (online, coverage hours, registered, approved, with a ride).
Referrals with a test account on either side and promotion uses by test accounts do not count.

| Block | Directors and admins | Marketing |
|---|---|---|
| Rides | yes | yes |
| Sign-ups and drivers | yes | yes |
| Breakdowns | yes | yes |
| Marketing | yes | yes |
| Money | yes | no |
| Pending now | yes | no |

### Rides (everyone)

Ride outcomes use the cohort of real rides **requested on D** (`rides.created_at` in D), read at send time:

| Number | Definition |
|---|---|
| Requested | rides created on D |
| Completed | of those, `status = 'completed'` |
| Completion rate | completed / requested |
| Canceled by the rider | `status = 'canceled'`, a driver was assigned, `canceled_by = customer_id` |
| Canceled by the driver | `status = 'canceled'`, a driver was assigned, `canceled_by` = that driver's user |
| No driver | `status = 'canceled'` and `driver_id IS NULL` (nobody accepted; rider gave up or cleanup canceled it) |
| No driver, with an offer / without any | the "no driver" rides split by whether any `ride_offers` row exists |
| Hours without coverage | the hours of D (23, 24 or 25) with no online beat of a real driver in `driver_heartbeat_log` |

A ride nobody accepted is "no driver" whoever canceled it, so no ride is counted twice.
Rides canceled by an admin or by nobody after a driver accepted are counted in "requested" only;
the outcome lines are not required to add up to "requested" (rides can still be active).

Coverage hours are bucketed in UTC (`date_trunc('hour', beat_at, 'UTC')`), so the count does not depend on
the session time zone; Havana's offsets are whole hours, so a UTC hour is a Havana hour.

### Sign-ups and drivers (everyone)

| Number | Definition |
|---|---|
| New riders | real users created on D with no driver profile |
| Drivers registered | driver profiles of real users created on D |
| Drivers approved | driver profiles of real users with `approved_at` in D |
| Drivers online | distinct real drivers with an online beat in `driver_heartbeat_log` in D |
| Drivers with a ride | distinct real drivers of real rides with `completed_at` in D |

### Breakdowns (everyone; day D only)

Over the same cohort of real rides requested on D:

| Breakdown | Rows | Columns |
|---|---|---|
| Pickup municipality | top 5 by requested, from `_poi_admin_area(pickup_location)`; rides outside every polygon go to "Sin ubicación" | requested, completed, no driver |
| Vehicle type | each `service_type` with at least one ride, with its display name | requested, completed, no driver |
| Time band (Havana) | madrugada 00–06, mañana 06–12, tarde 12–18, noche 18–24 (the pricing bands) | requested, no driver |

### Money (directors and admins only)

| Number | Definition |
|---|---|
| Charged in rides | sum of `final_fare_cup` of real rides with `completed_at` in D |
| Platform commission | sum of `commission_amount` of the `final` pricing snapshots of those rides (same as `get_platform_earnings`) |
| Recharged | sum of `amount_cup` of `payment_intents` of non-test users with `status = 'completed'` and `paid_at` in D |

### Pending now (directors and admins only)

| Number | Definition |
|---|---|
| Drivers awaiting approval | real users' `driver_profiles.status = 'under_review'` |
| Open incidents | `incident_reports.status IN ('open', 'investigating')`, SOS counted apart |
| Open disputes | `ride_disputes.resolved_at IS NULL`, and how many are past `sla_resolution_deadline` |

### Marketing (everyone)

| Number | Definition |
|---|---|
| Sign-ups by acquisition code | real users created on D with a `signup_code`; the list shows the top 5 codes with `acquisition_codes.label` |
| Referrals | `referrals` created on D, neither side a test account |
| First rides | real customers whose first completed ride ever has `completed_at` in D. An earlier ride with `completed_at` before D counts as earlier whatever its status is now (a ride disputed later still happened) |
| Campaigns sent | the total counts campaigns `sent` with `sent_at` in D; the list shows `sent` and `failed` ones (name, status, `push_sent`, `email_sent`) |
| Promotions used | `promotion_uses` of non-test users created on D; the list shows the top 10 promotion codes |

Campaign names, codes, labels and municipality names are escaped in the HTML.

A day with no activity still sends, with zeros.

## Architecture

```
pg_cron (hourly, :05)  →  dispatch_team_digest()          [SQL]
                            │ Havana 07:05 or 08:05, switch on, day D has no run
                            ▼ cron_http_post('send-team-digest', {day})
                          send-team-digest (Edge Function, service key only; answers 202)
                            ├─ team_daily_metrics(D)           [SQL, jsonb]   ┐ a failed read claims
                            ├─ team_digest_recipients()        [SQL]          ┘ nothing: 08:05 retries
                            ├─ claim_team_digest(D)            [SQL, one winner; nothing sent before]
                            ├─ render per role (template)      [TS]
                            ├─ send-email, one call per person [existing EF, raw-HTML path]
                            └─ finish_team_digest(D, recipients, sent, failed, error)
pg_cron (*/15)         →  check_team_digest_overdue()     [SQL, raises after 9:00 Havana]
email footer link      →  tricigo.com/resumen-diario/baja#u=…&t=…  [web page]
                            └─ button POST → team-digest-unsubscribe (Edge Function, signed link)
```

### Database (migration 00656)

- `team_digest_runs` — `day date PRIMARY KEY`, `status` (`sending` / `sent` / `failed`), `started_at`,
  `finished_at`, `recipients`, `sent`, `failed`, `last_error`. Lock table: RLS with no policies,
  GRANT to `service_role` only.
- `team_digest_optouts` — `user_id uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE`,
  `opted_out boolean DEFAULT true`, `updated_at`. Coming back sets `opted_out = false` (an update, never a
  delete). Same lock-table treatment.
- `_team_digest_totals(p_day date) RETURNS jsonb` — the totals of one day: `{rides, signups, money, marketing}`.
- `team_daily_metrics(p_day date) RETURNS jsonb` — returns
  `{day, current, previous, week_ago, breakdowns, pending, lists}`, where `current` / `previous` /
  `week_ago` are `_team_digest_totals` of D, D−1 and D−7, and the breakdowns, pending snapshot and lists
  are for D only.
- `team_digest_recipients() RETURNS TABLE(user_id, role, email, full_name)` — active users with role
  `super_admin`, `admin` or `marketing`, not the platform account, not opted out, with a provable
  address from `mailable_user_emails` (00635). When `team_digest_preview_to` is set, only the account whose
  id matches it, compared case-insensitively and trimmed; a value that matches no account sends to nobody.
- `claim_team_digest(p_day date) RETURNS boolean` — inserts the run as `sending`; returns false if the
  day already has a run. Before that it marks any run stuck in `sending` for more than 30 minutes as
  `failed` (`interrupted`); such a run is never claimed again (a retry could send twice).
- `finish_team_digest(p_day, p_recipients, p_sent, p_failed, p_error) RETURNS boolean` — only while the
  day is `sending`. Anything sent is `sent`, with its failures counted. Nothing sent is `failed`, including
  zero recipients, recorded with `last_error = 'no_recipients'` (or the sender's error if it passed one),
  so the overdue check alerts.
- `dispatch_team_digest(p_now DEFAULT now())` — sweeps stuck runs to `failed` even with the switch off.
  Does nothing else unless `team_digest_enabled` is true, the Havana hour is 7 or 8 (the job runs at :05,
  so 07:05 and 08:05), and D has no run. Then calls `cron_http_post`. Without a service key in the vault it
  raises (`team_digest_no_service_key`). That error alone does not reach `check_cron_sql_failures`, which
  needs 3 failures in a row while this job fails at most twice a day; the overdue check reports it.
- `check_team_digest_overdue(p_now DEFAULT now())` — with the switch on and the Havana hour at 9 or later,
  raises (`team_digest_overdue`) if D's run is not `sent`. When D has no run and the vault has no service
  key, the message says so. Its own cron job, so the raise does not roll back the dispatch call;
  `check_cron_sql_failures` emails the business address.
- `set_team_digest_optout(p_user uuid, p_out boolean) RETURNS boolean` — false for an unknown account.
- `platform_config`: `team_digest_enabled` (false at launch) and `team_digest_preview_to` (a user id,
  empty for everyone), editable in Settings → Platform config with help text (es/en/pt).

Every function is SECURITY DEFINER and executable by `service_role` only. Every function that the cron
calls lets its errors through (no whole-body `EXCEPTION WHEN OTHERS`, see CLAUDE.md § "Una función de cron
no atrapa sus propios errores").

**Switch-on window.** The dispatcher only fires at 07:05 and 08:05 Havana time. Turned on after 08:05,
that day has no digest and the overdue check fails from 9:00 until midnight (the cron-failure watchdog
sends one alert, then one recovery); the next day goes out normally. A day sent in preview counts as sent:
the rest of the team starts the day after the preview field is cleared.

### Edge Functions

- **`send-team-digest`** (`verify_jwt` true, service key required). Body: optional `{day: 'YYYY-MM-DD'}`;
  missing means the Havana day before. A body that is not a JSON object is a 400, and so is a day after the
  Havana day before (a claimed day is never sent again, so an unfinished day would block its real run).
  Answers 202 and works in `EdgeRuntime.waitUntil`, like `send-campaign`:
  1. reads the metrics and the recipients; a failed read claims nothing, so the 08:05 dispatch retries;
  2. claims D; a lost claim sends nothing. Nothing is sent before the claim, so the day goes out once at most;
  3. renders and sends each person's version through `send-email` (raw-HTML path, service key). Each person
     is isolated: a failure or an exception counts in `failed` and the loop goes on. Each `send-email` call
     times out at 20 s and is retried once after about 1 s, so the worst case is about 41 s per person. If
     `send-email` hung for everyone, about 10 recipients would exceed the function's wall clock; the run
     would stay `sending` and be swept to `failed` at 30 minutes. A timed-out attempt that was in fact
     delivered can leave that person a duplicate copy (one extra email beats none);
  4. records the outcome with `finish_team_digest`, also with nobody to send to.

  It does not read the switch, so a manual call sends even with it off, but it respects the preview
  setting. Addresses and tokens are never logged. `TEAM_DIGEST_RETRY_DELAY_MS` only exists for the tests.
- **`team-digest-unsubscribe`** (`verify_jwt` false: the page calls it with the publishable key, which the
  gateway would reject). The footer link is `https://tricigo.com/resumen-diario/baja#u=<user id>&t=<token>`,
  with `t` = HMAC-SHA256 of `team-digest:<user id>` keyed with `TEAM_DIGEST_SECRET`, falling back to the
  service role key. Rotating whichever key is used invalidates the links in emails already sent. The
  account and token travel in the URL **fragment**, which never reaches nginx logs or the server. The page
  (Supabase serves Edge Function HTML as text/plain, so it lives on the web app) reads the fragment after
  mount, clears it from the address bar and from Next's `history.state`, and shows one button; only that
  button POSTs `{u, t, action: 'out' | 'in'}`, because mail scanners and link previews open links by
  themselves. Coming back with Back shows the bad-link message, since the token is stored nowhere. The page
  is `noindex` and sends no Referer, and the web's Sentry drops the fragment on that path. The function
  checks the token in constant time, answers JSON with the CORS headers of `ALLOWED_ORIGINS` (tricigo.com
  and www.tricigo.com) and allows 20 calls per hour per IP.

### Email template

`supabase/functions/_shared/email-templates/team_daily_digest.ts`, not in the registry (`index.ts`):
`send-team-digest` renders it and sends the HTML through `send-email`'s raw-HTML path, so `send-email`
needed no redeploy. Input: the metrics JSON, the recipient's role, name, panel URL and unsubscribe URL.
Output: subject "TriciGo · resumen del <weekday> <day> de <month>" and the HTML on the shared layout. Only
`super_admin` and `admin` get the Money and Pending now blocks; for any other role they are not rendered at
all (not hidden). Every ride number and breakdown is rendered for everyone. Spanish (neutral, tuteo);
amounts with `formatCUP`-style thousands separators.

## Errors

| Case | Behaviour |
|---|---|
| The cron runs twice for the same day | `claim_team_digest` lets one through |
| Reading the numbers or the recipients fails | nothing is claimed; the 08:05 dispatch retries; if that fails too, the 9:00 check alerts |
| The Edge Function dies mid-send | the run stays `sending`; after 30 min it is `failed`; the 9:00 check alerts; no automatic resend |
| One address fails | retried once, then counted in `failed`; the others still go out |
| `send-email` hangs for everyone | ~41 s per person; with about 10 or more recipients the function runs out of time, the run stays `sending` and is swept to `failed` |
| Nobody to send to (all opted out, preview id matches no account) | the run is `failed` with `no_recipients`; the check alerts every day while it lasts |
| No service key in the vault | the dispatch raises; the overdue check reports it and names the missing key |
| Switch off | nothing is sent and the overdue check stays quiet |
| Switch turned on after 08:05 | no digest that day; the check fails from 9:00 to midnight; the next day is normal |
| A person loses their role | not in the next day's recipients |

## Manual resend

Delete the day's row in `team_digest_runs` and call `send-team-digest` with the service key and
`{"day":"YYYY-MM-DD"}`. The day must not be after the Havana day before.

## Testing

- **SQL rehearsal** (`supabase/tests/00656/run.sh`, local Postgres 16 + PostGIS): seeded rides, users,
  heartbeats, offers, campaigns and promotions with known answers for D, D−1 and D−7 and each breakdown
  (rides outside every polygon, a ride at 00:00 and 23:59 Havana, a test driver's ride, a disputed earlier
  ride); both daylight-saving days; session time zone; recipients by role, opt-out and opt-in, preview mode
  (case and spaces), the mailable-address rule; claim idempotency and the 30-minute sweep; zero recipients;
  dispatch only at Havana 07–08 (both DST offsets) and without a vault key; overdue check; grants. Then a
  CRLF copy, 6 negative proofs of the migration's self-checks, and 14 mutations that each remove one filter
  of the numbers and must change them. Measured: with the migration (applied twice) 72 passed, 0 failed;
  with `none`, 3 passed (the scaffold checks S0–S2) and 48 failed.
- **Vitest** (62 tests): helpers 9 (token, fragment link, secret fallback, Havana day across both time
  changes), template 17 (marketing version has no Money or Pending, escaping, arrows and a 0 base),
  `send-team-digest` 23 (service key, body validation, read before claim, failed or lost claim, retry,
  per-person isolation, zero recipients, no address or token in the logs), `team-digest-unsubscribe` 13
  (CORS, GET refused, bad signature, secret, unknown account, rate limit).
- **Prod rehearsal** inside a rolled-back block with real data, then preview mode to the owner only.

## Rollout

Each step with the owner's OK: merge → deploy both Edge Functions (`team-digest-unsubscribe` with
`verify_jwt = false`) → rehearse 00656 in prod in a rolled-back block → apply → set `team_digest_preview_to`
to the owner's id and turn the switch on before 08:05 Havana → after a few days, clear the preview field.

## Out of scope

Weekly or monthly summaries, per-person choice of blocks, recipients without a panel account, charts
or images in the email, and showing the same numbers in the panel (the SQL function makes that easy
later).
