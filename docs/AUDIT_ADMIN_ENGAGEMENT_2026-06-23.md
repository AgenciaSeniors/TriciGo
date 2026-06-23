# Admin panel audit — engagement & money surfaces (2026-06-23)

Scope requested: a functional audit of the admin panel covering **referrals,
promotions, campaigns, announcements (novedades), reviews, support, earnings,
gifts, adjust-TC, receipts, and credits (admin-initiated + app recharges)** —
"that everything works".

Method: 3 parallel Explore agents (marketing surfaces, money surfaces, prod
grounding) followed by **direct verification of every flagged finding** (the
agents are known to over-report — CLAUDE.md). Prod grounding ran read-only SQL
against the production project (`lqaufszburqvlslpcuac`).

## Headline result: the contract is healthy

Prod grounding confirmed **96 RPCs invoked by the audited surfaces all exist
with compatible signatures, and every referenced column exists**. The admin
Supabase client is untyped (`getSupabaseClient()` without `<Database>`), so
`tsc` cannot catch RPC/column typos — but for these surfaces there are none.
Money data (gifts, recharges, adjustments, ledger) is consistent; the only
negative balances are the system accounts (`00000…001`).

Most of the agents' "HIGH/CRITICAL" findings were **false positives**. Verified:

| Reported | Verdict (evidence) |
|---|---|
| Receipts tab broken: `getRecentReceipts` missing | ❌ FALSE — exists at `admin.service.ts:1985`; `check-types` passes |
| Campaigns email/SMS blocked by CORS, never sent | ❌ FALSE — uses the admin's `session.access_token` (not anon) with try/catch + per-channel warnings; `admin.tricigo.com` is in `ALLOWED_ORIGINS` (added 2026-06-23) |
| Campaigns `sent_count` lies / no list refresh | ❌ FALSE — per-channel warnings + `await loadCampaigns()` (campaigns/page.tsx:342) |
| Reviews list broken by `tag_key` schema drift | ❌ FALSE — code embeds `review_tag_definitions(tag_key)` on purpose (reviews/page.tsx:144-169) |
| Announcements save invalid CTA URLs | ❌ FALSE — `handleSave` blocks via `isValidAnnouncementCta` (announcements/page.tsx:131-135) |
| Support reply doesn't refresh the ticket list | ❌ FALSE — updates `tickets` state (support/page.tsx:115-119) |
| Gift unfreeze doesn't refetch | ✅ already fixed in PR #643 |
| earnings `platform_balance` hardcoded user_id | ❌ not a bug — system platform account (documented pattern) |

## Genuine findings (fixed in this PR)

### 1. Driver work-wallet (tricicoin) was never visible in admin
`drivers/[id]` adjusts the driver's `tricicoin` balance (the live single-wallet
the accept-ride commission gate checks) via "Ajustar saldo TC", but **never
displayed the balance** — `getDriverDetail` didn't even fetch it. And
`users/[id]` offered tricicoin adjustment for drivers (`isDriver={role==='driver'}`)
while only showing `customer_cash` (`getUserDetail` hardcodes `customer_cash`),
so a tricicoin top-up looked like it did nothing.

Fix:
- `admin.service.ts` `getDriverDetail` now returns the driver's `tricicoin`
  wallet (`balance`, `held_balance`, `is_active`, `is_frozen`, `frozen_reason`);
  `getUserDetail` returns it as `driverWallet` when the user is a driver.
- `drivers/[id]` renders a "Saldo de trabajo (TC)" card; `users/[id]` renders the
  same card for drivers. Both refresh on the existing post-adjust refetch.

### 2. `drivers/[id]` adjust toast didn't interpolate the balance
Same bug fixed for `users/[id]` in PR #643: the new balance was embedded in the
i18n `defaultValue` string instead of passed as an interpolation variable, so it
wouldn't render once the locale key is populated. Fixed to pass
`balance: formatCUP(result.new_balance)` as `{{balance}}`.

### 3. Minor hardening
- `AdjustWalletModal` / `SendGiftModal`: `parseInt(amountStr, 10)` →
  `Math.round(parseFloat(amountStr))` so a stray decimal isn't silently
  truncated (inputs are `step=1`, so low risk, but it's money).
- Admin ledger `amount` (`admin.service.ts`): computed from the sum of the
  positive (credit) legs instead of the max single leg, so a multi-leg
  transaction shows the full amount moved (same value for balanced 2-leg txns).

## Not changed (acceptable / out of scope)
- No auto-refresh on ~40 list pages: deliberate (Next.js remounts on nav) — see
  PR #643 notes.
- `getSegmentUserIds` / `getReferralStats` load without `LIMIT`: a scale concern,
  not a correctness bug; dev data is tiny. Defer until volume warrants it.
- Untyped Supabase client: known debt (CLAUDE.md PR #517). The contract sweep
  here found no live mismatch in these surfaces.

## Verification
- `pnpm check-types` green (4 apps).
- ESLint clean on all changed files (no new warnings).
- Prod grounding: 96 RPCs present, all columns present, money data consistent.
