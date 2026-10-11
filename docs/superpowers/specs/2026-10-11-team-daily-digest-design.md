# Team daily digest — design

Date: 2026-10-11. Status: approved in conversation, pending written-spec review.

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
| When | 7:00 Havana time, every day, weekends included. Covers the previous day, 00:00–24:00 Havana |
| Recipients | Automatic: every active account with a panel role. One-tap unsubscribe link, with a way back |
| Build | Metrics in one SQL function (single definition of each number); rendering and sending in an Edge Function |
| Rollout | Rehearsed locally and in prod (rolled back), then sent only to the owner for a few days, then to the team, behind a switch in Settings |

Team roles decided in the same conversation (applied separately, account by account):
Alejandro and Eduardo `super_admin`; Lucía, Liannah and Luis `admin`; the Baco agency `marketing`.

## Content

All numbers are for day **D** (the Havana calendar day before the send), excluding test accounts
(`users.is_test`) and the platform account (`…0001`). Each total carries its change against **D−1**
and against **D−7** (arrow and percent; "—" when the base is 0). Breakdowns show day D only, to keep
the email readable. "Pending now" is a snapshot at send time and carries no comparison.

| Block | Directors and admins | Marketing |
|---|---|---|
| Rides | yes | yes |
| Sign-ups and drivers | yes | yes |
| Breakdowns | yes | yes |
| Marketing | yes | yes |
| Money | yes | no |
| Pending now | yes | no |

### Rides (everyone)

Ride outcomes use the cohort of rides **requested on D** (`rides.created_at` in D), read at send time:

| Number | Definition |
|---|---|
| Requested | rides created on D |
| Completed | of those, `status = 'completed'` |
| Completion rate | completed / requested |
| Canceled by the rider | `status = 'canceled'`, `canceled_by = customer_id` |
| Canceled by the driver | `status = 'canceled'`, `canceled_by` = the user of the assigned driver profile |
| No driver | `status = 'canceled'` and `driver_id IS NULL` (nobody accepted; rider gave up or cleanup canceled it) |
| No driver, with an offer / without any | the "no driver" rides split by whether any `ride_offers` row exists |
| Hours without coverage | how many of the 24 Havana hours of D had no online beat in `driver_heartbeat_log` |

Rides canceled by an admin or by nobody after a driver accepted are counted in "requested" only;
the outcome lines are not required to add up to "requested" (rides can still be active).

### Sign-ups and drivers (everyone)

| Number | Definition |
|---|---|
| New riders | users created on D with no driver profile |
| Drivers registered | driver profiles created on D |
| Drivers approved | driver profiles with `approved_at` in D |
| Drivers online | distinct `driver_heartbeat_log.driver_profile_id` with an online beat in D |
| Drivers with a ride | distinct drivers of rides with `completed_at` in D |

### Breakdowns (everyone; day D only)

Over the same cohort of rides requested on D:

| Breakdown | Rows | Columns |
|---|---|---|
| Pickup municipality | top 5 by requested, from `_poi_admin_area(pickup_location)`; rides with no location or outside every polygon go to "Sin ubicación" | requested, completed, no driver |
| Vehicle type | each `service_type` with at least one ride, with its display name | requested, completed, no driver |
| Time band (Havana) | madrugada 00–06, mañana 06–12, tarde 12–18, noche 18–24 (the pricing bands) | requested, no driver |

### Money (directors and admins only)

| Number | Definition |
|---|---|
| Charged in rides | sum of `final_fare_cup` of rides with `completed_at` in D |
| Platform commission | sum of `commission_amount` of the `final` pricing snapshots of rides completed in D (same as `get_platform_earnings`) |
| Recharged | sum of `amount_cup` of `payment_intents` with `status = 'completed'` and `paid_at` in D |

### Pending now (directors and admins only)

| Number | Definition |
|---|---|
| Drivers awaiting approval | `driver_profiles.status = 'under_review'` |
| Open incidents | `incident_reports.status IN ('open', 'investigating')`, SOS counted apart |
| Open disputes | `ride_disputes.resolved_at IS NULL`, and how many are past `sla_resolution_deadline` |

### Marketing (everyone)

| Number | Definition |
|---|---|
| Sign-ups by acquisition code | users created on D grouped by `users.signup_code`, top 5, with `acquisition_codes.label` |
| Referrals | `referrals` created on D |
| First rides | riders whose first completed ride has `completed_at` in D |
| Campaigns sent | campaigns with `sent_at` in D: name, status, `push_sent`, `email_sent` |
| Promotions used | `promotion_uses` created on D, grouped by promotion code |

Campaign names, codes, labels and municipality names are escaped in the HTML.

A day with no activity still sends, with zeros.

## Architecture

```
pg_cron (hourly, :05)  →  dispatch_team_digest()          [SQL]
                            │ Havana hour ≥ 7, switch on, day D not claimed
                            ▼ cron_http_post('send-team-digest', {day})
                          send-team-digest (Edge Function, service key only)
                            ├─ claim_team_digest(D)            [SQL, one winner]
                            ├─ team_daily_metrics(D)           [SQL, jsonb]
                            ├─ team_digest_recipients()        [SQL]
                            ├─ render per role (template)      [TS]
                            ├─ send-email, one call per person [existing EF]
                            └─ finish_team_digest(D, sent, failed, error)
pg_cron (*/15)         →  check_team_digest_overdue()     [SQL, raises after 9:00 Havana]
email footer link      →  team-digest-unsubscribe (Edge Function, signed link)
```

### Database (one migration; number chosen at implementation time)

- `team_digest_runs` — `day date PRIMARY KEY`, `status` (`sending` / `sent` / `failed`), `started_at`,
  `finished_at`, `recipients`, `sent`, `failed`, `last_error`. Lock table: RLS with no policies,
  GRANT to `service_role` only.
- `team_digest_optouts` — `user_id uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE`,
  `created_at`. Same lock-table treatment.
- `team_daily_metrics(p_day date) RETURNS jsonb` — SECURITY DEFINER, executable by `service_role`
  only. Computes the totals for D, D−1 and D−7 from one inner query set, the breakdowns and the
  pending snapshot for D only, and returns
  `{day, rides, signups, breakdowns, money, pending, marketing, previous, week_ago}`.
- `team_digest_recipients() RETURNS TABLE(user_id, role, email, full_name)` — active users with role
  `super_admin`, `admin` or `marketing`, not the platform account, not opted out, with a provable
  address from `public._user_mailable_email(id)` (00635). When `team_digest_preview_to` is set, only
  that user. `service_role` only.
- `claim_team_digest(p_day date) RETURNS boolean` — inserts the run as `sending`; returns false if the
  day already has a run. A run stuck in `sending` for more than 30 minutes is marked `failed` and is
  not retried automatically (a retry could send twice).
- `finish_team_digest(p_day, p_recipients, p_sent, p_failed, p_error)`.
- `dispatch_team_digest()` — does nothing unless `team_digest_enabled` is true, the Havana hour is
  between 7 and 8, and D has no run. Then calls `cron_http_post`. Without a service key in the vault,
  raises (`team_digest_no_service_key`) so `check_cron_sql_failures` sees it.
- `check_team_digest_overdue()` — with the switch on and the Havana hour at 9 or later, raises
  (`team_digest_overdue`) if D's run is not `sent`. Its own cron job, so the raise does not roll back
  the dispatch call; `check_cron_sql_failures` emails the business address.
- `set_team_digest_optout(p_user uuid, p_out boolean)` — used by the unsubscribe function.
  `service_role` only.
- `platform_config`: `team_digest_enabled` (false at launch) and `team_digest_preview_to` (a user id,
  empty for everyone), with help text in the admin Settings page (es/en/pt).

Every function that the cron calls lets its errors through (no whole-body `EXCEPTION WHEN OTHERS`,
see CLAUDE.md § "Una función de cron no atrapa sus propios errores").

### Edge Functions

- **`send-team-digest`** (`verify_jwt` true, service key required). Claims D, reads the metrics and the
  recipients, renders each person's version and sends it through `send-email` with the service key and
  template `team_daily_digest`. One failed address does not stop the rest. Records the outcome with
  `finish_team_digest`. Responds 202 and does the work in `EdgeRuntime.waitUntil`, like
  `send-campaign`, so the cron call never waits on the sends.
- **`team-digest-unsubscribe`** (`verify_jwt` false). The footer link carries `u` (user id) and `t`
  (HMAC-SHA256 of `team-digest:<user id>` with `TEAM_DIGEST_SECRET`, falling back to the service role
  key, as `verify-otp` does). `GET` shows a page with one button; the `POST` from that button opts the
  person out and shows "Listo, ya no lo vas a recibir" with a "Volver a recibirlo" button (another
  `POST`). The opt-out happens on the `POST` because mail scanners and link previews follow `GET`
  links and would unsubscribe people by themselves. Rate-limited per IP.

### Email template

`supabase/functions/_shared/email-templates/team_daily_digest.ts`, registered in `index.ts`.
Input: the metrics JSON, the recipient's role, name, panel URL and unsubscribe URL. Output: subject
"TriciGo · resumen del <weekday> <day> de <month>" and the HTML on the shared layout. For `marketing`
the Money and Pending now blocks are not rendered at all; every ride number and breakdown is. Spanish (neutral, tuteo); dates in
Havana time; amounts with `formatCUP`-equivalent formatting in the Edge runtime.

## Errors

| Case | Behaviour |
|---|---|
| The cron runs twice in the hour | `claim_team_digest` lets one through |
| The Edge Function dies mid-send | the run stays `sending`; after 30 min it is `failed`; the 9:00 check alerts; no automatic resend |
| One address bounces or `send-email` fails for one person | counted in `failed`, the others still go out |
| No service key in the vault | the dispatch raises; `check_cron_sql_failures` reports it |
| Switch off | nothing is sent and the overdue check stays quiet |
| A person loses their role | not in the next day's recipients |

## Testing

- **SQL rehearsal** (`supabase/tests/<n>/run.sh`, local Postgres): seeded rides, users, heartbeats,
  offers, campaigns and promotions with known answers for D, D−1 and D−7, and for each breakdown
  (including rides with no location and a ride at 23:59 / 00:00 Havana); recipients by role,
  opt-out, preview mode and the mailable-address rule; claim idempotency; dispatch only at Havana
  7–8 (including both DST offsets); overdue check; grants (`anon` and `authenticated` cannot execute
  any of the new functions); negative proofs of the migration's own checks; CRLF copy.
- **Template tests** (vitest): the marketing version contains every ride number and breakdown but no
  Money or Pending now block; user-written text is escaped; arrows and percentages, including a 0 base.
- **Edge Function tests** (vitest, `send-campaign` pattern): claim lost → nothing sent; one failed
  send does not stop the others; unsubscribe rejects a bad signature, opts out only on `POST`.
- **Prod rehearsal** inside a rolled-back block with real data, then preview mode to the owner only.

## Out of scope

Weekly or monthly summaries, per-person choice of blocks, recipients without a panel account, charts
or images in the email, and showing the same numbers in the panel (the SQL function makes that easy
later).
