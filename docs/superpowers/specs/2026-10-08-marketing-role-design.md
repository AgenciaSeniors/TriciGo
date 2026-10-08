# Marketing role in the admin panel — design

**Status:** approved in conversation on 2026-10-08. Implementation plan comes next.

## Problem

TriciGo's marketing team needs the admin panel for metrics, promo codes, campaigns, announcements and the blog. Today the panel only has `admin` and `super_admin` (`apps/admin/src/middleware.ts`). Making marketing `admin` would also let them:
- adjust wallets, send gifts and approve top-ups;
- approve drivers and block users;
- activate discounts with no review.

## Decisions taken with the founder

| Question | Decision |
|---|---|
| What marketing does | Metrics, promotions, campaigns and announcements, blog. |
| Promotions | Draft plus approval. Marketing creates and edits; an admin or super_admin activates. |
| Personal data | Marketing may see names, phones and e-mails, as an admin does. |
| Campaigns | Push and e-mail go out at once. SMS would need approval, but no SMS campaign screen exists, so marketing gets none. |
| Rest of the panel | Hidden. The menu shows only marketing's sections. |
| Approach | A new `marketing` role (option A). Making them admin (B) and a per-account permission matrix (C) were rejected. |

Choices made in the design that the founder can still reverse:
- **Legal pages stay admin-only.** `cms_content('terms')` feeds the driver contract PDF.
- **Individual push stays admin-only.** The Notificaciones page, which pushes to one user, is support's tool.
- **Referral rewards stay admin-only.** They move money from `platform_promotions`.

## Design

### 1. Role and accounts

- Add `marketing` to the `user_role` enum in its own migration. `ALTER TYPE … ADD VALUE` cannot be used in the transaction that adds it; 00370 split the same way.
- `public.is_marketing()`: `auth.uid()` is not null and `current_user_role() = 'marketing'`. It is plpgsql with the same anon-safe early return as `is_admin()` (00592).
- `is_admin()` does not change. Marketing gets nothing that is gated on `is_admin()` today unless this design opens it explicitly.
- **Creating an account:**
  1. The person signs in once with Google on tricigo.com or the app. `handle_new_user` creates a `customer` row.
  2. A super_admin runs `promote_user_role(<id>, 'marketing', <reason>)`, which already exists, is super_admin-only and is logged in `admin_actions`.
  3. No panel button is added.
- `packages/types` `UserRole` gains `'marketing'`.

### 2. Admin panel shell

- **`middleware.ts`** admits `marketing` too. For a marketing user, any route outside the marketing allow-list redirects to the marketing home (the launch pulse page). The redirect is built from `X-Forwarded-Host`, like the existing redirects.
- **`Sidebar` and `BottomNav`** filter items by role. One shared allow-list module (`apps/admin/src/lib/panelAccess.ts`) is the single source for both the menu and the middleware.
- **`AdminShell`** does not mount `NotificationBell` (SOS) or `SupportWaitingBanner` for marketing. Both read admin-only data.
- The client learns the role from a new `useCurrentRole()` hook. It reads the caller's own `users.role` row, which RLS allows.

**Marketing allow-list:**
- `/launch-pulse`, `/funnel`, `/code-performance`, `/segments`, `/competitors`, `/reports`, `/referrals` (read-only: the reward and invalidate buttons are hidden for marketing, and the server refuses them anyway)
- `/promotions`
- `/campaigns`, `/announcements`
- `/blog`

### 3. Server permissions

New permissions are **added**. No existing policy or grant is loosened for other roles.

| Object | Today | For marketing |
|---|---|---|
| `rides`, `users`, `driver_profiles`, `referrals` | SELECT `is_admin()` | New SELECT policy `is_marketing()`. Per the founder, marketing may see personal data. |
| `promotions` | ALL `is_admin()` | New SELECT, INSERT, UPDATE and DELETE policies for `is_marketing()`, plus the draft trigger in §4. |
| `campaigns` | ALL, `role IN ('admin','super_admin')` hardcoded | New ALL policy `is_marketing()` with `created_by = auth.uid()` on write. |
| `home_announcements` | ALL `is_admin()` | New ALL policy `is_marketing()`. |
| `blog_posts` (created by hand, no migration) | ALL hardcoded admin list | New ALL policy `is_marketing()`. Read the live policies first. |
| `acquisition_codes` | ALL `is_admin()` (00619) | New ALL policy `is_marketing()`. The codes pay no bonus. |
| Metrics RPCs | `IF NOT is_admin() RAISE` / `WHERE is_admin()` | In-place patch to `is_admin() OR is_marketing()`, with an md5 guard on the live body. |
| `get_active_push_user_ids` | `is_admin()` | Same patch, so announcements, promotions and blog can push. |
| `admin_reward_referral`, `admin_invalidate_referral` | hardcoded admin | Unchanged: they move money. |

The metrics RPCs are:
- `admin_launch_pulse`, `admin_signup_code_stats`, `get_competitor_summary`;
- `get_admin_dashboard_metrics`, `get_admin_wallet_stats`, `get_platform_earnings`;
- `get_rides_by_day`, `get_rides_by_service_type`, `get_rides_by_payment_method`, `get_top_drivers`.

Each policy name ends in `_marketing`, so a later rollback can drop exactly these.

**Edge Functions.**
- `send-push` accepts a marketing JWT only for `category` in `campaign`, `announcement`, `promo` and `blog`. Any other category returns 403 for marketing: ride offers, system alerts, support pushes.
- `send-bulk-email` accepts marketing. It still sends only to `marketing_opt_in = true`.
- `send-bulk-sms` and `storage-upload` stay admin-only. Blog and announcement images are URLs typed by hand, so no upload is needed.

### 4. Promotion approval

- **New columns** on `promotions`: `pending_approval boolean NOT NULL DEFAULT false`, `approved_by uuid REFERENCES users(id)` and `approved_at timestamptz`.
- **A `BEFORE INSERT OR UPDATE OR DELETE` trigger** applies when the caller `is_marketing()`. Admins, the service role and triggers keep today's behavior.
  - **INSERT:** `is_active` is forced to `false` and `pending_approval` to `true`. `created_by` is set to `auth.uid()`. `approved_by` and `approved_at` are cleared.
  - **UPDATE of an inactive promotion:** allowed, and sets `pending_approval = true`. Setting `is_active = true` raises `P0001`, with an error code in DETAIL and a Spanish message. Marketing can never write `pending_approval`, `approved_by` or `approved_at` directly.
  - **UPDATE of an active promotion:** only `is_active = false` (pause) is allowed. Any other change raises: "Pausa la promoción para editarla".
  - **DELETE:** allowed only while inactive and `current_uses = 0`.
  - Pausing does not set `pending_approval`. A paused promotion stays off until an admin turns it back on, because marketing can never activate.
- **When an admin or super_admin sets `is_active` from false to true,** the trigger stamps `approved_by` and `approved_at` and clears `pending_approval`.
- **Panel, admin view:**
  - a strip at the top of Promotions: "N promociones esperan aprobación" (`pending_approval` true);
  - a dot on the Promotions menu item;
  - an "Aprobar y activar" button.
  - The "notify on publish" push runs when the admin approves.
- **Panel, marketing view:** no activate toggle; a "Pendiente de aprobación" badge; a pause button on active promotions.

### 5. Role-check sweep (before writing code)

- Grep apps, packages and Edge Functions for role comparisons (`role === '…'`, `IN ('admin','super_admin')`, `UserRole` switches). Make sure a `marketing` account:
  - can still use the passenger app as a passenger;
  - is never treated as admin by the client apps;
  - does not crash a role-keyed map or label in the panel.
- Read the live RLS of `blog_posts` and `cms_content`, which were created by hand, before adding policies.

## Out of scope

- SMS campaigns; there is no screen for them today.
- Partner places, quests, the Notificaciones page, legal pages, referral rewards.
- A per-account permission matrix (option C).
- Three ungated SECURITY DEFINER RPCs found during research: `detect_collusion_reviews`, `get_peak_hours` and `get_driver_utilization`. They are executable by any authenticated user and get a separate fix. Marketing would reach the last two through Reports anyway.

## Testing

- **Local rehearsal** in `supabase/tests/<n>/run.sh` (Postgres 16 with PostGIS), using live bodies checked by md5. One account of each role:
  - marketing reads metrics and personal data, creates a draft promotion, cannot activate it or edit an active one, and cannot pause and silently re-activate;
  - marketing cannot touch wallets, drivers, referral rewards, `cms_content`, or `send-push` system categories;
  - admin approves and the stamp is set;
  - a customer sees none of it.
  - RED without the migration, GREEN applied twice, plus a negative proof for every new policy and for the trigger.
- **Edge Functions:** vitest handler tests for the category gate in `send-push` and the marketing branch in `send-bulk-email`, using the existing `vi.mock` pattern.
- **Panel:** tsc, lint, and a test of `panelAccess` (menu filter and middleware allow-list share it).

## Rollout

1. PR. Then, with the founder's OK, merge.
2. Apply the enum migration, then the permissions migration, each verified by object. Deploy `send-push` and `send-bulk-email`.
3. Create the marketing accounts one by one, confirming each with the founder.
