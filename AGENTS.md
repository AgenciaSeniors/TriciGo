# TriciGo: instructions for Codex

TriciGo is a ride-hailing platform for Cuba: rider app (`apps/client`) and driver app
(`apps/driver`) in Expo, web (`apps/web`) and admin panel (`apps/admin`) in Next.js, shared code in
`packages/`, and Supabase (Postgres, RLS, RPCs, Edge Functions in `supabase/functions`,
migrations in `supabase/migrations`).

The working rules, verified incidents and patterns live in `CLAUDE.md` (in Spanish). Read the
sections it names before changing an area. Code, comments, commits and technical docs are in
English; text for users is neutral Cuban Spanish through i18n.

Validation commands: `pnpm lint`, `pnpm check-types`, `pnpm test`, `pnpm check:i18n`,
`pnpm check:ef-imports`, `pnpm check:ef-types`, `pnpm check:migration-grants`.
Never run `supabase db push`: it would re-run old migrations against production.

## Review guidelines

These guide the automatic Codex review of every pull request.

- Find which areas a PR touches with `node scripts/review-areas.mjs --base origin/master` (or from
  the paths: see `docs/review/areas.json`) and review against `docs/review/general.md` plus the
  checklist of each touched area in `docs/review/`.
- **Tests come with the change.** Code without a test that fails without it is a finding, unless
  the PR has a line `No tests because:` with a real reason.
- **Money** moves only through server RPCs that write `ledger_entries`; never a direct update of
  `wallet_accounts.balance`; payments, webhooks and bonuses are idempotent and claim rows
  atomically; fares, promos, referrals and gifts are decided by the server.
- **Access:** every new table has RLS and explicit GRANTs; SECURITY DEFINER functions check the
  caller, set `search_path` and are not executable by `anon` unless intended; RPCs and Edge
  Functions check ownership of the object they receive; `verify_jwt=true` alone is not an
  authorization check.
- **Rides** change state, fare and times only through their RPCs; concurrent paths lock the row;
  `ride_already_closed` is a success for the caller.
- **Migrations** are never edited once on `master`; a `CREATE OR REPLACE FUNCTION` starts from the
  live body; they run twice without harm; cron functions do not wrap their whole body in
  `EXCEPTION WHEN OTHERS` and call Edge Functions through `public.cron_http_post`; the app
  tolerates a migration that is not applied yet.
- **Mobile:** both apps use `runtimeVersion` policy `appVersion`; a native change (config plugins,
  native modules, native dependencies, permissions) without an `expo.version` bump is a P0,
  because an OTA would reach binaries without that native code.
- **Public repository:** any secret or real personal data in the diff is a P0.
- Report problems introduced or exposed by the PR, each with the file and line and the scenario
  that breaks. Do not report style or what lint and CI already enforce.
