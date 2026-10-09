# Scheduled campaigns that actually send

Date: 2026-10-09. Approved by the founder in the session on the same day.

## Problem

The admin Campañas page (`apps/admin/src/app/campaigns/page.tsx`) offers "Programar para". Saving stores the
campaign with `status = 'scheduled'` and `scheduled_at`, and nothing ever sends it: no cron job, Edge Function
or trigger reads scheduled campaigns. The campaign stays "Programada" forever and reaches nobody.

"Enviar ahora" works, but it runs in the browser: the page computes the recipients itself (several queries
through PostgREST, capped at 1000 rows), calls `send-push` and `send-bulk-email`, then inserts the campaign
row with the counts the browser computed. If the tab closes halfway, the send stops halfway.

Two smaller defects on the same path:

- The `datetime-local` value is sent as is (`"2026-10-09T10:00"`). Postgres reads it as UTC, so 10:00 in
  Havana would be stored as 06:00 Havana.
- The e-mail body is built as `<p>${body.replace(/\n/g, '<br/>')}</p>` without escaping.

Prod on 2026-10-08: 2 campaigns, both `sent`, none `scheduled`. Nobody has been hit yet.

## Decisions (founder, 2026-10-09)

1. **Everything sends from the server.** "Enviar ahora" and "Programar" both store the campaign; one Edge
   Function sends it. The recipient rules live in one place, in SQL.
2. **A scheduled campaign can be cancelled while it has not started.** An admin can cancel any; marketing
   only the ones its own account created.
3. Included on purpose: the chosen time is Havana time; blocked accounts (`users.is_active = false`) never
   receive a campaign; the push carries the campaign id so inbox reads can be measured later.

## Design

### Lifecycle

```
scheduled ──claim──▶ sending ──▶ sent
    │                   └──────▶ failed   (every chosen channel failed, or interrupted)
    └──cancel──▶ cancelled
```

- `draft` stays a valid value (existing default) but nothing writes it.
- A campaign is claimed (`scheduled → sending`) in one statement with `FOR UPDATE SKIP LOCKED`, so the
  button and the cron can never send the same campaign twice.
- A campaign stuck in `sending` for more than 15 minutes (the function died) becomes `failed` with
  `last_error = 'interrupted'`. It is never retried automatically: a retry could send twice.

### Database (migration 00649, number to re-check before push)

**`campaigns` columns added:** `started_at timestamptz`, `recipient_count int NOT NULL DEFAULT 0`,
`push_sent int NOT NULL DEFAULT 0`, `email_sent int NOT NULL DEFAULT 0`, `last_error text`,
`canceled_at timestamptz`, `canceled_by uuid REFERENCES auth.users(id) ON DELETE SET NULL`.
`sent_count` stays and keeps its meaning for the list ("Enviados" = the larger of push and e-mail sent).

**Status CHECK:** `status IN ('draft','scheduled','sending','sent','failed','cancelled')`. Existing rows are
all `sent`.

**Client writes:**
- `REVOKE UPDATE, TRUNCATE ON public.campaigns FROM anon, authenticated` and `REVOKE INSERT … FROM anon`.
  Status and counters change only through the functions below (service role or SECURITY DEFINER). The admin
  `ALL` policy keeps SELECT, INSERT and DELETE.
- `tg_campaigns_client_insert` (BEFORE INSERT, only when `current_user IN ('anon','authenticated')`): forces
  `status = 'scheduled'`, `scheduled_at = GREATEST(COALESCE(scheduled_at, now()), now())`, every counter to 0,
  `sent_at`, `started_at`, `last_error`, `canceled_*` to NULL and `created_by = auth.uid()`.
- **Legacy exception:** an insert that arrives with `status = 'sent'` is kept as it comes (only `created_by`
  is forced). Only the old panel sends that: it has already delivered the campaign from the browser, and a
  panel tab opened before the deploy keeps running the old code until it reloads. Turning that row into
  `scheduled` would send the campaign a second time. The cost is that a staff account can still record a
  `sent` row with invented counts, which only affects the history list. A later migration can remove the
  exception once no old tab can be open.

**`campaign_recipient_ids(p_campaign_id uuid) RETURNS uuid[]`** (SECURITY DEFINER, `search_path = ''`,
EXECUTE for `service_role` only). An array, not a set: PostgREST cuts a set-returning function at 1000 rows. Same segments as today's browser code, evaluated at send time, never
including `is_active = false` accounts:

| segment_type | customer audience | driver audience |
|---|---|---|
| `all` | `users.role = 'customer'` | `users.role = 'driver'` |
| `new_users` | role match, `created_at >= now() - 7 days` | same |
| `power_users` | more than 10 rides (any status) as `rides.customer_id` | `driver_profiles`: `COALESCE(total_rides_completed, total_rides, 0) > 10` |
| `inactive` | role match and no ride as customer in 30 days | role match and no ride as driver (`rides.driver_id → driver_profiles.user_id`) in 30 days |
| `by_city` | role match and `users.city_id = segment_city_id` (NULL city → nobody) | same |

Any other value returns nobody. CHECKs on `channel`, `segment_type` and `audience_role`, and one that a
`scheduled` row has a `scheduled_at`, keep such rows out; the fallback stays in case a CHECK is ever dropped.

**`claim_campaigns(p_campaign_id uuid DEFAULT NULL, p_limit int DEFAULT 5) RETURNS SETOF campaigns`**
(SECURITY DEFINER, `service_role` only): moves due campaigns (`status = 'scheduled' AND scheduled_at <= now()`,
optionally only `p_campaign_id`) to `sending`, sets `started_at`, oldest first, `FOR UPDATE SKIP LOCKED` inside a
`MATERIALIZED` CTE (written as `id IN (SELECT … LIMIT … FOR UPDATE SKIP LOCKED)` the planner re-runs the
subquery per row and the `LIMIT` stops holding).

**`cancel_campaign(p_campaign_id uuid) RETURNS text`** (SECURITY DEFINER, `authenticated` only):
- Allowed when `is_admin()`, or `is_marketing()` and `created_by = auth.uid()`; otherwise 42501 with
  DETAIL `campaign_cancel_forbidden`.
- Locks the row (`FOR UPDATE`, so a claim in progress makes it wait and then read `sending`); if it is still
  `scheduled`, sets `cancelled`, `canceled_at`, `canceled_by` (FK to `auth.users`, `ON DELETE SET NULL`) and
  returns `'cancelled'`. Otherwise returns the current status (`'sending'`, `'sent'`, …) and changes nothing.

**`dispatch_due_campaigns() RETURNS integer`** (SECURITY DEFINER, `service_role` only), run by the cron job
`send-due-campaigns` every minute:
1. Marks `sending` rows older than 15 minutes as `failed` / `interrupted`.
2. Only if a due `scheduled` campaign exists, calls
   `public.cron_http_post('send-due-campaigns', '<project>/functions/v1/send-campaign', <service-key headers>, '{"due":true}')`.
   If the vault has no service key it raises instead (DETAIL `campaign_dispatch_no_service_key`): a call
   without a key would get 401 every minute, unseen.
3. No `EXCEPTION WHEN OTHERS` in the main block, so a failure reaches `check_cron_sql_failures` (00596).

New grants follow `pnpm check:migration-grants` (no new tables).

### Edge Function `send-campaign` (new)

`verify_jwt = true`. Two callers:

| Call | Who | What |
|---|---|---|
| `{ "campaign_id": "…" }` | panel user (admin, or marketing for its own campaign) or service key | claims that campaign, sends it, answers with the counts |
| `{ "due": true }` | service key only (cron) | answers 202 at once and, in the background (`EdgeRuntime.waitUntil`), claims one due campaign, sends it and claims the next, until none is due or 300 s are spent. The cron call never hits pg_net's 30 s timeout, and a worker stopped mid-run leaves at most one campaign in `sending`; the rest stay `scheduled` for the next minute |

For each claimed campaign:
1. `campaign_recipient_ids` → user ids, sent to each channel in batches of 300 (`send-push` and
   `send-bulk-email` filter with `.in()`, and 700 or more uuids exceed PostgREST's URL limit).
2. Push (channel `push` or `both`): internal call to `send-push`, category `campaign`, data
   `{ deep_link: 'tricigo://home', content_type: 'campaign', content_id: <campaign id> }`.
3. E-mail (channel `email` or `both`): internal call to `send-bulk-email` with the title as subject, the body
   HTML-escaped with line breaks as `<br/>`, and `promo_code_id`. `send-bulk-email` keeps its rules: opted-in
   users at a proven address only.
4. Writes `recipient_count`, `push_sent`, `email_sent`, `sent_count = GREATEST(push_sent, email_sent)`,
   `sent_at = now()`, and `status = 'sent'`, or `'failed'` when every chosen channel call failed. A channel
   that failed while another worked leaves `sent` with its error in `last_error`. Zero recipients is `sent`
   with 0.

Errors never leave a campaign in `sending` on purpose: the function catches per campaign and writes `failed`.

### Panel

- **Form:** "Enviar ahora" (default) or "Programar para (hora de Cuba)". The input value is converted from
  Havana local time to UTC with a new `havanaLocalToUtcIso` in `@tricigo/utils` (date.ts); it must be in the
  future in Havana terms.
- **Save:** inserts the campaign (no `status`, counters or `scheduled_at` for "Enviar ahora"), then for
  "Enviar ahora" calls `send-campaign` with the id and shows the result as today (sent counts, and the
  same warnings when a channel reached nobody or failed). For "Programar", a toast with the Havana time.
- **List:** a "Programada para" column (Havana time, `utcIsoToHavanaLocal`/`formatAdminDate`); the status
  badge gains `sending` ("Enviando") and `failed` ("Falló", with `last_error` on hover); a **Cancelar** button
  on `scheduled` rows: admins on every row, marketing on rows where `created_by` is its own id. The list
  refreshes every 30 s while any row is `scheduled` or `sending`.
- The browser no longer computes recipients or calls `send-push` / `send-bulk-email` for campaigns.
- A new `campaignService` in `packages/api` (create, sendNow, cancel) keeps the page thin and testable.

### Tests

- **SQL rehearsal** `supabase/tests/00649/run.sh` (local Postgres 16, live bodies where the migration patches
  nothing): each segment and audience, blocked users excluded, claim exclusivity with two sessions, cancel
  rules (admin any, marketing own only, not after claim), the insert guard, the stuck sweep, and that the
  dispatcher calls `cron_http_post` only when something is due. RED without the migration, GREEN applied twice.
- **Edge Function** `supabase/functions/send-campaign/index.test.ts` (vitest, mocked supabase-js and fetch):
  401/403 gates, marketing cannot send another account's campaign, `due` needs the service key, push and
  e-mail calls and the counts written, one channel failing, every channel failing, nothing claimed.
- **Utils:** `havanaLocalToUtcIso` / `utcIsoToHavanaLocal` across Cuban DST changes.
- **Service:** `campaignService` unit tests. Repo checks: check-types, lint, tests, i18n guards, migration
  grants.

### Rollout (each step with the founder's OK)

1. Deploy `send-campaign`. Nothing calls it until 00649 exists, and once 00649 is applied the cron job calls it
   within a minute of any due campaign, so it has to be there first.
2. Apply 00649 (rehearsed in prod first inside a rolled-back transaction).
3. Merge the panel (it deploys on merge). Until each open tab reloads, the old panel keeps working:
   "Enviar ahora" still sends from the browser and is stored as `sent` (legacy exception, no second send).
   "Programar" from an old tab stores the raw local time, which Postgres reads as UTC, so that campaign would
   go out 4 to 5 hours early. Nobody has ever scheduled a campaign; the risk is accepted.
4. Update the marketing guide: remove the warning about scheduled campaigns.

## Out of scope

- Editing a scheduled campaign (cancel and create a new one).
- Retrying failed campaigns, open/click tracking, campaign conversion metrics.
- The promotions page date inputs have the same UTC bug (`isoToInput`/`inputToIso`); the new helpers make
  that fix easy, but it is a separate change.
