# Team invitations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A super admin invites people to the admin panel from an "Equipo" page. The invitation is bound to an e-mail address and accepted by signing in with that Google account. The panel also changes roles and removes access, and replaces the "No tienes permisos" bounce with a page that says what happened.

**Architecture:**
- **Database (migration 00661):** a lock table `team_invitations`, and SECURITY DEFINER RPCs that gate themselves (super_admin to manage, the token for the public page, the signed-in person to accept). There is one flag-guarded branch in `tg_users_protect_admin_fields`, so the RPCs can write the role.
- **E-mail:** it goes through `send-email` (new template `team_invitation`) via `cron_http_post`.
- **Panel:** `/equipo` for super admins, the public pages `/invitacion/[token]` and `/sin-acceso`. `/auth/callback` accepts a token, and the middleware accepts a pending invitation for the caller's Google address.

**Tech Stack:** Postgres 16 / Supabase (plpgsql), Deno-compatible TypeScript for the e-mail template, Next.js 15 app router (admin), vitest, the local rehearsal cluster.

**Spec:** `docs/superpowers/specs/2026-10-12-team-invitations-design.md`

**Order:** this branch is rebased on master after the admin speed PR (`claude/admin-panel-speed`) merges. It builds on that PR's middleware (getClaims, role cache, role cookie) and its single Supabase client.

**Migration number:** 00661. On 2026-10-12, master ended at 00659 (#1153); among the open PRs #965 reserved 00569 and #1155 reserved 00660. Re-check right before pushing:
```bash
git fetch origin master && git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -3
```
Also check the files of every open PR.

---

### Task 1: Rehearsal scaffold, seed and runner (RED)

**Files:**
- Create: `supabase/tests/00661/scaffold.sql`, `supabase/tests/00661/seed.sql`, `supabase/tests/00661/run.sh`

The three files are already drafted and checked: `scratchpad/plan-team/tests/`.
- **Scaffold:** the live bodies of `tg_users_protect_admin_fields`, `is_admin`, `is_super_admin`, `current_user_role` and `mailable_user_emails`, read from prod (S0 compares their md5).
- **Stubs:** `cron_http_post` and `get_service_role_key`.
- **Seed:** the eleven people listed in its header.
- **Runner:** 47 cases plus G0–G5.

- [ ] **Step 1:** Copy the three files to `supabase/tests/00661/` and `chmod +x run.sh`.
- [ ] **Step 2:** Start the cluster: `su pgtest -c "/usr/lib/postgresql/16/bin/pg_ctl -D /home/pgtest/data -o '-p 5433 -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp' -l /home/pgtest/pg.log -w start"`.
- [ ] **Step 3:** Run `supabase/tests/00661/run.sh none`. Expected: `3 passed, 44 failed` (S0, S1 and the control C13 pass).
- [ ] **Step 4:** Commit: `test(db): rehearsal for team invitations (00661)`.

### Task 2: Migration 00661 (GREEN)

**Files:**
- Create: `supabase/migrations/00661_team_invitations.sql` (drafted and checked: `scratchpad/plan-team/00661_team_invitations.sql`)

Sections:
- 0: guard on the live trigger md5.
- 1: table, unique pending index, RLS, grants.
- 2: helpers.
- 3: the eight RPCs.
- 4: trigger patch (anchor `IF current_setting('app.trusted_tier_update', true) = '1' THEN`, branch built with `chr(10)`).
- 5: permissions.
- 6: CRLF strip.
- 7: self-checks.

- [ ] **Step 1:** Copy the file.
- [ ] **Step 2:** Run `supabase/tests/00661/run.sh supabase/migrations/00661_team_invitations.sql`. Expected: `53 passed, 0 failed`. That covers both applies, the CRLF copy and G1–G5.
- [ ] **Step 3:** Commit: `feat(db): team invitations (00661)`.

### Task 3: The `team_invitation` e-mail

**Files:**
- Create: `supabase/functions/_shared/email-templates/team_invitation.ts` and `team_invitation.test.ts` (drafted: `scratchpad/plan-team/files/email/`)
- Modify: `supabase/functions/_shared/email-templates/index.ts`:
  - import `teamInvitationHtml`, `teamInvitationSubject`, `type TeamInvitationData`;
  - add `'team_invitation'` to `TemplateKey`;
  - add a `case 'team_invitation'` with `subject: subjectOverride ?? teamInvitationSubject(d)` and `html: teamInvitationHtml(d)`;
  - add `key === 'team_invitation' ||` to `isTemplateKey`.

- [ ] **Step 1:** Copy the test, then run `cd packages/api && npx vitest run ../../supabase/functions/_shared/email-templates/team_invitation.test.ts`. It must fail with a missing module.
- [ ] **Step 2:** Copy the template and edit the registry.
- [ ] **Step 3:** Run the test again. Expected: 7 passed.
- [ ] **Step 4:** Type-check without Deno. Use a throwaway tsconfig with `allowImportingTsExtensions`, `moduleResolution: bundler`, `strict`, and `files: [index.ts]`, then run `npx tsc --noEmit -p <it>`. Expected: no errors.
- [ ] **Step 5:** Commit: `feat(email): team invitation template`.

### Task 4: Invitation outcome helpers and the super-admin-only route

**Files:**
- Create: `packages/utils/src/teamInvitation.ts`, `packages/utils/src/__tests__/teamInvitation.test.ts` (drafted: `scratchpad/plan-team/files/utils/`)
- Modify: `packages/utils/package.json`, adding the export `"./teamInvitation": "./src/teamInvitation.ts"`.
- Modify: `packages/utils/src/adminPanelAccess.ts`, adding `SUPER_ADMIN_ROUTES = ['/equipo']`. `canOpenPanelPath` returns `role === 'super_admin'` for any path under it, before the admin check.
- Modify: `packages/utils/src/__tests__/adminPanelAccess.test.ts`, adding a test that `/equipo` and `/equipo/x` open only for super_admin, and that `/equipos` stays an admin page.

- [ ] **Step 1:** Write the tests and run them. They must fail.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Run `cd packages/utils && npx vitest run`. Everything must pass.
- [ ] **Step 4:** Commit: `feat(utils): team invitation outcomes and the super-admin-only Equipo route`.

### Task 5: `teamService`

**Files:**
- Create: `packages/api/src/services/team.service.ts`, `packages/api/src/services/__tests__/team.test.ts` (drafted: `scratchpad/plan-team/files/api/`)
- Modify: `packages/api/src/index.ts`, exporting `teamService` and the types `TeamRole`, `TeamMember`, `TeamInvitation`, `TeamListing`, `InvitationSent`, `PublicInvitation`, `PublicInvitationStatus`.

- [ ] **Step 1:** Copy the test and run it. It must fail.
- [ ] **Step 2:** Copy the service and add the exports.
- [ ] **Step 3:** Run `cd packages/api && npx vitest run src/services/__tests__/team.test.ts`. Expected: 7 passed.
- [ ] **Step 4:** Commit: `feat(api): teamService`.

### Task 6: Middleware, callback and shell

**Files:**
- Modify: `apps/admin/src/middleware.ts`:
  - The matcher also excludes `invitacion|sin-acceso`.
  - When the account is active and its role is not a panel role, call `supabase.rpc('accept_team_invitation')`, parse it with `parseAcceptOutcome`, and drop the role cache entry for that user.
    - Accepted with a panel role: continue with that role (`canOpenPanelPath`, `rememberRole`).
    - Otherwise: redirect to `invitationOutcomePath(outcome)`, carry the refreshed session cookies, and delete the role cookie.
  - A blocked account (`active` false) keeps going to `/login?error=unauthorized`.
- Modify: `apps/admin/src/app/auth/callback/route.ts`:
  - Read `invite` and keep it only if `isInvitationToken`.
  - After `exchangeCodeForSession` succeeds with a token: call `accept_team_invitation` with `p_token` and redirect to `invitationOutcomePath(parseAcceptOutcome(data))`. On an RPC error, redirect with `{ result: 'none' }`.
- Modify: `apps/admin/src/components/layout/AdminShell.tsx`: `isAuthPage` also covers `/sin-acceso` and `pathname.startsWith('/invitacion/')`.
- Create: `apps/admin/src/components/ui/GoogleIcon.tsx`, the four-path Google SVG moved from `login/page.tsx`, which then uses it.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Run `npx tsc --noEmit -p apps/admin/tsconfig.json`. Expected: clean.
- [ ] **Step 3:** Extend the speed PR's mock-Supabase middleware rehearsal (`scratchpad/mw-e2e`):
  - Mock `/rest/v1/rpc/accept_team_invitation`: accepted/marketing for one customer, `none` for another.
  - Expected: the first gets 200 on `/launch-pulse` with the role cookie `marketing`; the second gets 307 to `/sin-acceso?reason=none` with the role cookie deleted.
  - Run it against a build pointed at the mock.
- [ ] **Step 4:** Commit: `feat(admin): accept invitations on sign-in`.

### Task 7: Public pages `/invitacion/[token]` and `/sin-acceso`

**Files:**
- Create: `apps/admin/src/app/invitacion/[token]/page.tsx`, `apps/admin/src/app/sin-acceso/page.tsx` (drafted: `scratchpad/plan-team/files/admin/`)

- [ ] **Step 1:** Copy them and type-check.
- [ ] **Step 2:** Commit: `feat(admin): invitation and no-access pages`.

### Task 8: The Equipo page and its menu entry

**Files:**
- Create: `apps/admin/src/app/equipo/page.tsx` (drafted: `scratchpad/plan-team/files/admin/equipo/page.tsx`)
- Modify: `apps/admin/src/components/layout/Sidebar.tsx`, adding `{ href: '/equipo', labelKey: 'sidebar.team', defaultLabel: 'Equipo', icon: UserCog }` to the `system` group. `canOpenPanelPath` already hides it from everyone but super_admin.

- [ ] **Step 1:** Implement and type-check.
- [ ] **Step 2:** Commit: `feat(admin): Equipo page`.

### Task 9: Texts in es/en/pt

**Files:**
- Modify: `packages/i18n/src/locales/{es,en,pt}/admin.json`, adding `sidebar.team`, the namespaces `team.*`, `invitation.*` and `no_access.*` (the keys the three pages use), and `team.role_super_admin|admin|marketing`.
  - Spanish: the `defaultValue`s, in tú.
  - English and Portuguese: real translations.
  - The admin only loads Spanish (speed PR), but every locale keeps the same keys.

- [ ] **Step 1:** Add the keys.
- [ ] **Step 2:** Run `cd packages/utils && npx vitest run src/__tests__/copyTuteo.test.ts` (no voseo) and the i18n key-parity test, if there is one.
- [ ] **Step 3:** Commit: `feat(i18n): team page texts`.

### Task 10: Docs, full verification, push

- [ ] **Step 1:** Add a CLAUDE.md section, "Equipo del panel: invitaciones (00661)". It covers the rules, the trigger flag, the role cache delay (up to 1 minute), the e-mail label, and how to diagnose a stuck invitation.
- [ ] **Step 2:** Run `pnpm check-types`, the vitest suites of `packages/api` and `packages/utils`, and `supabase/tests/00661/run.sh <migration>`. Build the admin and open `/invitacion/<64 hex>` and `/sin-acceso?reason=wrong_account&email=l…@gmail.com` in Chromium. Take screenshots.
- [ ] **Step 3:** Re-check the migration number, push and update draft PR #1151. Dispatch a final code reviewer.

### Task 11: Rollout (each step needs the owner's OK)

1. Rehearse 00661 in prod inside a rolled-back block:
   - Run `EXECUTE` of the file, check md5 equality of the text, then run cases as real accounts.
   - Make `cron_http_post` safe: the rollback cancels the queued request.
2. Apply 00661 by MCP. It has no DROP or DELETE, so no destructive prompt.
3. Deploy `send-email` with the new template (MCP `deploy_edge_function` with every file it imports).
4. Merge #1151, which deploys the panel.
5. The owner invites a test Gmail and accepts it, then tries the wrong account, then removes access.
