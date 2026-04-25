# BUG-199 — Service Role JWT Rotation Procedure (P0 EMERGENCY)

## What happened

The TriciGo Supabase **service_role JWT** is hardcoded inside the
following committed migration files:

- `supabase/migrations/00021_pg_cron_scheduled_jobs.sql`
- `supabase/migrations/00022_push_notification_triggers.sql`
- `supabase/migrations/00032_sms_notifications.sql`
- `supabase/migrations/00035_auto_share_trigger.sql`
- `supabase/migrations/00041_lost_and_found.sql`
- `supabase/migrations/00042_scheduled_ride_activation.sql`
- `supabase/migrations/00056_weather_sync_cron.sql`
- `supabase/migrations/00061_auto_admin_config.sql`
- `supabase/migrations/00074_behavioral_email_tracking.sql`
- `supabase/migrations/00214_wire_behavioral_emails_cron.sql`
- (also previously in `.env.example`, now sanitized)

The repo is **public on GitHub** (`AgenciaSeniors/TriciGo`). Anyone who
clones it gets a JWT with `role=service_role` that:

- Bypasses ALL Row Level Security
- Can read/write/delete every table (rides, wallets, ledger, users, etc.)
- Can mint admin sessions
- Doesn't expire until 2036

**This is a P0 emergency. The JWT is already public — assume an attacker
has it. Rotate immediately.**

## Rotation procedure

### Step 1 — Rotate the service_role JWT in Supabase

1. Go to https://supabase.com/dashboard/project/lqaufszburqvlslpcuac/settings/api
2. Find **Service role key** (the long `eyJ...` JWT)
3. Click **Reset / Generate new** (Supabase will revoke the old one)
4. Copy the new JWT — keep it secret.

### Step 2 — Add the new JWT to Vault

Run this in the Supabase SQL editor:

```sql
INSERT INTO vault.secrets (name, secret, description)
VALUES (
  'service_role_jwt',
  'PASTE_THE_NEW_JWT_HERE',
  'Bearer JWT for cron->EF calls (BUG-199 rotation)'
)
ON CONFLICT (name) DO UPDATE SET secret = EXCLUDED.secret;
```

### Step 3 — Update Edge Function env vars

In Supabase Dashboard → Edge Functions → Settings → Secrets, update:

- `SUPABASE_SERVICE_ROLE_KEY` = `<new JWT from step 1>`

This is the env var the EFs read at runtime to verify `apikey` headers.

### Step 4 — Apply migration 00217

This re-schedules every cron to read the JWT from Vault instead of
hardcoding it. Run via the Supabase MCP or `supabase db push`.

After this, the cron commands look like:

```sql
SELECT net.http_post(
  url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='supabase_url') || '/functions/v1/<ef-name>',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='service_role_jwt')
  ),
  body := '{}'::jsonb
);
```

### Step 5 — Verify

After ~10 minutes, check that crons are still firing successfully:

```sql
SELECT j.jobname, COUNT(*) AS recent_failures
FROM cron.job j
JOIN cron.job_run_details d ON d.jobid = j.jobid
WHERE d.status = 'failed' AND d.start_time > NOW() - INTERVAL '20 minutes'
GROUP BY j.jobname;
```

Expected: 0 rows (or only the pre-existing `create-recurring-rides`
issue documented in BUG-168 follow-up).

### Step 6 — Audit downstream

1. Check Supabase logs for any unauthorized service_role usage from
   unfamiliar IPs in the last 24 hours:
   `Dashboard → Logs → Auth Logs`
2. If you find evidence of abuse: review wallet_accounts changes,
   ledger_entries, rides table for any rows you didn't create.
3. Run the wallet integrity invariant:
   ```sql
   SELECT COUNT(*) FROM wallet_accounts wa
   LEFT JOIN (SELECT account_id, SUM(amount) AS s FROM ledger_entries GROUP BY account_id) le
     ON le.account_id = wa.id
   WHERE wa.balance <> COALESCE(le.s, 0);
   ```
   Must be 0.

## Why we can't fix this fully via code

Once committed to git history, the JWT is forever in the public log
(even after deletion). The only effective remediation is rotation
(invalidating the old JWT). Code-level changes can prevent FUTURE
leaks but can't recover the already-leaked secret.

For future-proofing:
- Use Vault for all secrets (BUG-194)
- Keep `.env.example` placeholders only
- Pre-commit hook to scan for JWT-shaped strings
- Make repo private if business allows
