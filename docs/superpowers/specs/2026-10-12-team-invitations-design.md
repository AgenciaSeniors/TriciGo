# Team invitations for the admin panel — design

Date: 2026-10-12. Decisions by the owner in the brainstorming session of the same day.

## Problem

Today a team member gets panel access like this:

1. They sign in with Google at admin.tricigo.com.
2. The middleware finds no panel role and sends them back to `/login?error=unauthorized`. The page says "No tienes permisos de administrador.", and their session stays open.
3. Someone tells a super_admin. The super_admin (or Claude, by SQL) runs `promote_user_role` (00291). No screen in the panel calls it.
4. The person signs in again.

It works, but step 2 looks broken to the person, and step 3 depends on SQL.

## Decisions

- Only a super_admin invites, changes a team member's role and removes access.
- An invitation goes out by e-mail from TriciGo, and the panel also shows its link, to send by WhatsApp.
- An invitation is bound to its e-mail address. It is accepted only when the person signs in with a Google account whose verified address is that one. A forwarded link is useless to anyone else.
- "Remove access" takes the panel role away and leaves the account as it was before: a driver if it has a driver profile, a passenger otherwise. It does not block the account.
- Invitations are accepted with Google only. No `@tricigo.com` mailboxes are part of this work.

## What people see

**The super_admin, on a new "Equipo" page** (menu entry and page for super_admin only):

- **Members**: every active account with a panel role, except the system accounts (`…0001`, `…0099`). Columns: name, e-mail, role, last sign-in, and whether they get the daily digest (00656: proven address, not opted out).
  - **Change role** (super_admin, admin, marketing), with a required reason.
  - **Remove access**, with a required reason.
  - Neither action is offered on their own row, and the server refuses both on oneself. The last remaining super_admin cannot be demoted or removed.
- **Pending invitations**: e-mail, role, who invited, expiry. Actions: resend, copy link, cancel.
- **Invite**: e-mail, role (super_admin, admin, marketing), optional name. The invitation lasts 7 days; "resend" sends the e-mail again and restarts the 7 days.

**The invitee:**

1. Gets an e-mail from `noreply@tricigo.com`: "Eduardo te invitó al panel de TriciGo como Admin", a button "Entrar al panel", the expiry date, a line saying to sign in with Google using this same address, and "si no esperabas esta invitación, ignora este correo".
2. The button opens `admin.tricigo.com/invitacion/<token>`, a public page. It shows the role, who invited them, the invited address masked (`l…@gmail.com`) and an "Entrar con Google" button.
3. After Google:
   - **Right account**: the role is assigned on the spot and they land on their home page in the panel.
   - **Another Google account**: a page says the invitation is for `l…@gmail.com`, that they signed in as `x@…`, and offers "Cerrar sesión" to try the other account.
   - **Expired or canceled invitation**: the page says so and tells them to ask whoever invited them for a new one.

**Anyone with no role and no invitation** who signs in no longer gets "No tienes permisos de administrador." on the login page. They get a page saying that their account `x@…` has no access to the panel, that if they work at TriciGo they should ask a super administrator to invite them, and a "Cerrar sesión" button.

**An invitee who already has a TriciGo account** with that Gmail (passenger or driver) keeps it: same account, same rides, now with the role.

**Someone invited who goes straight to admin.tricigo.com** and signs in with the right Google account, without the link, also gets in: the invitation is bound to the address, not to the link.

## Design

### Data

`public.team_invitations`, a lock table: RLS on with no policies, GRANT to `service_role` only (CLAUDE.md, "Tablas nuevas en public"). The panel reaches it only through the functions below.

| Column | Notes |
|---|---|
| `id` | `uuid` default `gen_random_uuid()` |
| `email` | stored trimmed and lowercased |
| `role` | `user_role`, CHECK in (`super_admin`, `admin`, `marketing`) |
| `full_name` | optional, used in the e-mail greeting |
| `token` | 32 random bytes, hex, unique. Only opens the invitation page; it never grants anything by itself |
| `invited_by` | the super_admin |
| `status` | `pending`, `accepted`, `canceled` |
| `created_at`, `expires_at`, `sent_at` | `expires_at` = creation or last resend + 7 days |
| `accepted_at`, `accepted_user_id`, `canceled_at`, `canceled_by` | |

At most one `pending` invitation per address (unique partial index on `email` where `status = 'pending'`). An expired invitation stays `pending` with `expires_at` in the past; everything reads "expired" from `expires_at`.

No table is needed for "the role before joining": it is `driver` when the account has a `driver_profiles` row, `customer` otherwise.

### Server functions

All are SECURITY DEFINER, executable by `authenticated` only, with the gate inside. Errors carry Spanish text in MESSAGE and a code in DETAIL (`team_*`), like 00629.

| Function | Who | What |
|---|---|---|
| `list_team()` | super_admin | Members and pending invitations, for the Equipo page. |
| `create_team_invitation(email, role, name)` | super_admin | Validates the address and the role. Refuses an address that already belongs to a panel member (`team_already_member`) or has a pending invitation (`team_already_invited`: resend it instead). Inserts and queues the e-mail. Returns the link. |
| `resend_team_invitation(id)` | super_admin | Pending only. Restarts the 7 days and queues the e-mail again. |
| `cancel_team_invitation(id)` | super_admin | Pending only. |
| `get_team_invitation(token)` | anyone, `anon` included | For the public page: role, inviter's name, masked address, and whether it is pending, expired, canceled or accepted. Nothing without a valid token. |
| `accept_team_invitation(token default null)` | the signed-in person | See below. |
| `set_team_member_role(user, role, reason)` | super_admin | Target must be a panel member. Not on oneself; never leaves zero super_admins. Cancels the person's pending invitations, so a later sign-in cannot accept one and undo the change. |
| `remove_team_member(user, reason)` | super_admin | Same guards. Sets the role back to `driver` or `customer` and cancels the person's pending invitations. |

**Accepting.** `accept_team_invitation` looks for a pending, unexpired invitation whose address equals one of the caller's verified Google (or Apple) identities: `auth.identities` rows of that provider with `email_verified` true and that address. With a token, only that invitation is considered. The result is one of:

- `accepted`: the role is set and the invitation is marked accepted.
- `wrong_account`: token given, address does not match. The masked invited address comes back.
- `expired` or `canceled`: token given.
- `none`: no token and nothing matches.

Without a token it never reveals other people's invitations. An account that already has a panel role is never downgraded by accepting.

**Writing the role.** `tg_users_protect_admin_fields` reverts any role change made under a JWT that is not super_admin, and the invitee is not one. The trigger gets one more branch: a role change passes when the transaction sets `app.team_role_change = '1'`. Only `accept_team_invitation`, `set_team_member_role` and `remove_team_member` set it, right around their single UPDATE. Clients cannot set `app.*` settings through PostgREST. The trigger is patched from its live body (00599, md5 `377912e8…`), with a guard that refuses an unknown body. `promote_user_role` is left as it is.

**Audit.** Every invite, resend, cancellation, acceptance, role change and removal writes a row to `admin_actions`:

- By the super_admin who did it.
- For an acceptance, by the inviter, with the new member as target.
- The reason is required for role changes and removals.

### The invitation e-mail

A `team_invitation` template is added to the `send-email` registry, in the style of the others (`wrapHtml`). `create_team_invitation` and `resend_team_invitation` queue it through `cron_http_post` (label `team-invitation-email`), so a rejected send shows up in `check_cron_http_failures`. Every value from people (names) is escaped. This needs a `send-email` redeploy.

### Panel

- **`/equipo` page and its menu entry**, super_admin only. The middleware also sends any other role away from `/equipo`, and the functions refuse anyway.
- **`/invitacion/[token]`**, a public page outside the middleware. It reads `get_team_invitation` and starts Google sign-in with the token carried through `/auth/callback`.
- **`/auth/callback`**: after exchanging the code, when a token came along, it calls `accept_team_invitation(token)`. Accepted → the role's home page. Otherwise → `/sin-acceso` with the reason, except for someone who already has a panel role (an old or used link), who goes to their home.
- **Middleware**: when the account has no panel role, it calls `accept_team_invitation()` (no token) once. If that accepts, the request goes on; otherwise → `/sin-acceso`. This covers someone invited who signs in from the plain login page.
- **`/sin-acceso`**, a new page that replaces the `?error=unauthorized` message. It shows the signed-in address, the message for its case (no invitation, wrong account, expired, canceled) and "Cerrar sesión". For no invitation, wrong account and needs Google it also offers "Entrar con otra cuenta de Google", which signs out and opens Google's account picker (`prompt: 'select_account'`); otherwise Google signs the same account in again. The masked address from the URL is shown only in the shape the server produces.
- **Texts** in es/en/pt (`admin.json`).
- **`teamService`** in `packages/api` wraps the functions.

### Errors and edge cases

| Case | Behavior |
|---|---|
| The e-mail fails to send | The invitation still exists. The page shows the link to copy, and the failure shows in the cron HTTP watchdog. |
| Invitation for a passenger or driver account | That account gets the role. "Remove access" brings it back. |
| Two pending invitations for one address | Impossible (unique index). The second attempt says to resend. |
| The invitee signs in with email and password | Not accepted: that is not a verified Google identity. The `/sin-acceso` page says to use Google. |
| An invited account is blocked (`is_active = false`) | Not accepted. Blocking stays the stronger rule. |

## Testing

- **Rehearsal** `supabase/tests/<migration number>/run.sh` (the next free number, checked against master and every open PR when the plan is written) (Postgres 16 local, live bodies of `tg_users_protect_admin_fields` and `mailable_user_emails`).
  - RED without the migration; GREEN with it, applied twice and from a CRLF copy.
  - Cases: every gate; acceptance with the right account, a wrong account, expired, canceled, no token, already a member, blocked account, a password-only identity; the last-super_admin and self guards; the `app.team_role_change` flag not leaking outside its UPDATE.
  - Negative proofs of the migration's own self-checks.
- **vitest**: the service (`teamService`), address masking and the invitation link; the `team_invitation` template (escaping, Spanish copy).
- **Panel**: no test runner in the admin app. Checked in the browser on the preview build before merging: invite, accept with the right account, accept with the wrong one, remove.

## Rollout

Each step needs the owner's OK:

1. Rehearse the migration in prod, rolled back.
2. Apply it.
3. Redeploy `send-email`.
4. Merge, which deploys the panel.

Until step 4 nothing calls the new functions. With the migration applied and the old panel still live, nothing changes for anyone.

## Out of scope

- `@tricigo.com` mailboxes.
- Accepting with email and password.
- Admins (not super_admin) inviting.
- Invitations for passengers or drivers.
