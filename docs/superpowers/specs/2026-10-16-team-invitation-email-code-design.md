# Accepting a team invitation with an e-mail code — design

Date: 2026-10-16. Decisions by the owner in the brainstorming session of the same day. Builds on [team invitations](2026-10-12-team-invitations-design.md) (00661).

## Problem

Since 00661 an invitation is accepted only by signing in with a Google or Apple account whose verified address is the invited one (`accept_team_invitation` reads `auth.identities`). That is the only proof the person controls the mailbox.

The marketing agency Baco uses `info@bacoagency.com`. Its mail is served by `mail.alanpro.dev`, not Google, so that address has no Google account. Today they would have to create a Google account for their existing address before they can accept. The owner wants a second way: prove the mailbox with a code sent to it, and with that code create the panel account.

## Decisions

- Google stays exactly as it is. The code is a second way, on the same invitation page.
- The code is ours: generated and checked by the server, sent from `noreply@tricigo.com` through `send-email` (Resend). Not GoTrue's e-mail OTP (built-in SMTP sends few mails per hour and lands in spam, and GoTrue's "confirmed e-mail" is not proof, see below). Not the invitation link alone (its token sits in nginx logs, is shared by WhatsApp and travels with forwarded mail).
- With the code the person chooses a password. After that they sign in with e-mail and password, or with Google if they have it.
- The code also works for an account that already exists with that address, with the rules in "Which account gets the role".

## What people see

On `admin.tricigo.com/invitacion/<token>` (the page already shows the role, who invited and the address masked as `i…@bacoagency.com`), under "Entrar con Google", a second option: **Crear cuenta con un código**.

1. They tap it. The page says "Te mandamos un código de 6 dígitos a i…@bacoagency.com" and offers **Enviar código**.
2. They get an e-mail from `noreply@tricigo.com`, subject "Tu código para el panel de TriciGo", with the code, that it expires in 10 minutes, and "si no pediste este código, ignora este correo".
3. A form asks for the code, their name (prefilled from the invitation when it has one), a password of at least 8 characters and the password again. Button: **Crear cuenta y entrar**.
   - When the address already has an account, the form says "Ya hay una cuenta con este correo: elige una contraseña nueva para entrar" and does not ask for the name.
4. On success they land on their panel home (`panelHome(role)`): marketing on *Pulso del lanzamiento*, admins on the home page.
5. **Enviar otro código** is enabled 60 s after each send.

The invitation e-mail and the page stop saying that only Google works. The e-mail line becomes: "Toca el botón y entra con la cuenta de Google de <address>, o crea tu cuenta con un código que te mandamos a esta dirección."

## Which account gets the role

An account "exists" when its sign-in address (`auth.users.email`, unique in GoTrue) is the invited one. `public.users.email` does not count: its owner writes it without proof.

| Case | Result |
|---|---|
| No account with that address | Created with `email_confirm: true`, the name and the chosen password. It gets the role. |
| Account exists and Google or Apple verified that same address (an identity in `auth.identities` with that e-mail and `email_verified = true`) | The chosen password is set, every session of the account is closed, and it gets the role. A confirmed phone on it belongs to the same owner and is left alone. |
| Account exists without that proof and has no phone and no other identity (e-mail and password only) | Same: new password, sessions closed, role. Whoever opened it before with that address loses access, because the old password no longer works. |
| Account exists without that proof and has a phone (confirmed or not) or another identity | Refused (`needs_google`): whoever holds that phone could sign in through the app and reach the panel. Message: "Esta cuenta también entra con un teléfono. Para aceptar, entra con Google con este correo." |
| No account has the address as its sign-in address, but an identity of some account carries it | Refused (`needs_google`): signing in with Google would land on that account, so a second account with the same address must not be created. |
| Account blocked (`users.is_active = false` or banned in GoTrue) | Refused (`blocked`): "Tu cuenta está bloqueada." |
| Invited address under `@tricigo.app` or `@tricigo.system` | Refused (`internal_address`), when sending, checking and accepting. |

Accepting also records what the code proved: `users.email_verified_at` (when `users.email` is the invited address; password reset and e-mail login read it) and `users.password_set_at` (the person chose a password, see "Phone logins keep a chosen password").

Measured in prod on 2026-10-16: of 169 accounts with a real sign-in address, 72 have a confirmed phone and all 72 have a Google identity with that same verified address; 3 have an address nothing proves and none of them has a phone. The refused case has no account today.

Rules kept from 00661: the role never goes down (`_team_role_rank`), and an expired, used or canceled invitation cannot be accepted.

## Design

### Data (one new migration, number chosen right before writing it)

- `public.team_invitation_codes`, a lock table (RLS on, no policies, GRANT to `service_role` only): `invitation_id uuid PRIMARY KEY REFERENCES team_invitations ON DELETE CASCADE`, `code_hash text NOT NULL`, `expires_at timestamptz NOT NULL`, `attempts smallint NOT NULL DEFAULT 0`, `sent_at timestamptz NOT NULL DEFAULT now()`. One row per invitation: a new code replaces the old one.
- `public.team_invitation_code_salt`, a lock table with one random salt, like `reward_identity_salt` (00658). The code is stored as `hmac(code, salt, 'sha256')`, so a copy of the codes table does not let anyone try the million codes offline.
- Send counts go to `rate_limits` through `check_rate_limit`.

### Server functions (SECURITY DEFINER, EXECUTE for `service_role` only)

- `team_invitation_code_issue(p_token text)`: checks the invitation is pending and not expired and the address is not internal; enforces 60 s between sends and at most 5 codes per hour and 10 per day per invitation; generates the code with `gen_random_bytes` (no modulo bias); upserts the row; returns to the Edge Function the code, the full address, the invitation's name and whether an account already has that address. The Edge Function passes on `account_exists` (so the form knows whether to ask for the name) and `invitee_name`, the name the super_admin typed in the invitation (to prefill the field); it never returns the code or the address. Whoever holds the link learns whether the invited address has a TriciGo account and the name the inviter typed, and nothing more.
- `team_invitation_code_check(p_token text, p_code text)`: locks the row; `code_expired` past 10 minutes; `locked` after 5 wrong attempts; on a wrong code adds an attempt and returns how many are left; on the right code deletes the row (single use) and returns the address, the account id if one exists, and its case from the table above. A right code for a `blocked` or `needs_google` account is answered with that case and not spent: nothing was granted, and the person may fix the account and try again.
- `accept_team_invitation_by_code(p_token text, p_user uuid)`: checks everything again (invitation pending and not expired, address not internal, `auth.users.email` of `p_user` is the invited address, the case allows it, account not blocked). Locks the person's row first and the invitation second, the order every 00661 function uses. Closes every session and refresh token of the account, writes the role with `_team_write_role` (never lowering it), sets `email_verified_at` and `password_set_at` as above, marks the invitation accepted, and writes `admin_actions` (`team_invite_accepted`, `new_values.method = 'email_code'`).

Outcomes are jsonb answers (`{result: ...}`), never exceptions: the Edge Function passes them on and the panel turns each one into Spanish text.

### Edge Function `team-invitation-code`

`verify_jwt = false`: the caller has no session yet. It answers with `getCorsHeaders` (`ALLOWED_ORIGINS` already has admin.tricigo.com).

- `{ action: 'send', token }`: per-IP limit (10 per hour), `team_invitation_code_issue`, then the `team_invitation_code` template through `send-email` with the service key. If the mail fails it answers `send_failed`.
- `{ action: 'verify', token, code, password, full_name? }`: per-IP limit (30 per hour); validates the password (8 to 72 characters, the bcrypt limit) and the name (at most 80 characters; the form requires it for a new account, and the server uses the invitation's name when it is empty, because the code is already used at that point; ignored for an existing account); `team_invitation_code_check`; then `auth.admin.createUser` (new account) or `auth.admin.updateUserById` with the password and `email_confirm: true` (existing account: since 2026-10-07 a GoTrue sign-up leaves the address unconfirmed, and an unconfirmed address cannot sign in with a password); then `accept_team_invitation_by_code`. It answers `{ result: 'accepted', email, role }`. The full address is returned only after a right code.

For an existing account the function sets `password_set_at` before it writes the password, so a failure after that write can't leave the chosen password open to a phone login overwriting it. If a step fails after the code was used, the worst left behind is an account without a role. The person asks for a new code; the second try falls in "account exists" and completes. No role is ever granted without a checked code.

### Phone logins keep a chosen password

`verify-otp` signs a phone user in with a password derived from the account id (Strategy A), and when that sign-in fails it writes the derived password over the account's (CLAUDE.md § "Login en una app deslogueaba la otra"). A team member whose account also has a confirmed phone (a `proven` account) would lose the password chosen with the code the first time they open the driver or passenger app.

- The mark is `public.users.password_set_at`. It exists in prod (created by hand, 0 rows set on 2026-10-16; `set-password-after-otp` already writes it) and 00664 brings it into git: `ADD COLUMN` only when it is missing, so prod takes no lock.
- `verify-otp` reads it right before minting the session. Set, or unreadable: it skips Strategy A and mints with the magic link (Strategy B), which writes no password and closes no session. Not set: unchanged.
- Who sets it: `accept_team_invitation_by_code` (above), `set-password-after-otp` (already), and the panel's `/reset-password` page after `auth.updateUser({ password })` (the "¿Olvidaste tu contraseña?" path; a user may update that column on their own row).
- The magic link has been only a fallback until now. Before the rollout counts on it, it is checked in prod with the store demo account (see Rollout).

### E-mail

New template `team_invitation_code` in `_shared/email-templates/` (code, 10-minute expiry, the ignore line), registered in the template index. The `team_invitation` template gets the new line above. Both need a `send-email` redeploy.

### Panel

- `/invitacion/[token]`: a new client component with the steps above. On `accepted` it calls `signInWithPassword` with the browser client (session in cookies, like the rest of the panel) and goes to `panelHome(role)`. The page text no longer says Google is the only way.
- `teamService` in `@tricigo/api`: `requestInvitationCode(token)` and `acceptInvitationWithCode({ token, code, password, fullName })`, turning each `result` into an `AppError` with Spanish text, status 400 (so `getErrorMessage` does not turn it into "Sesión expirada").

### Limits

| What | Limit |
|---|---|
| Code | 6 digits, 10 minutes, single use, 5 attempts |
| Send | 60 s apart; 5 per hour and 10 per day per invitation; 10 per hour per IP |
| Verify | 30 per hour per IP |

With these, someone holding the link can try at most 50 codes a day: 350 over the 7 days of an invitation, out of a million (0.035 %).

Known and accepted:

- **An access token outlives the closed sessions by up to an hour.** In the `password_only` case, whoever had a session on the account keeps its last access token until it expires (1 h), now with the panel role. The panel middleware asks GoTrue every minute and sends them away, but a direct API call with that token works until it expires. Same window as blocking a user (00629). Today 3 accounts have an address nothing proves.
- **`accept_team_invitation_by_code` does not check a code itself.** It trusts that the Edge Function ran `team_invitation_code_check` first; only `service_role` can call it.
- **Whoever holds the link can spend the day's codes** (and lock the current one with 5 wrong tries). The invitee then waits or the super_admin sends a new invitation.

### Errors the person sees

Wrong code (attempts left), code expired or locked (ask for another), sent too soon (seconds left), too many codes this hour or today, invitation expired, used or canceled (00661 texts), password too short or not matching, account blocked, the phone case, and mail not sent (try again in a while).

## Testing

- SQL rehearsal `supabase/tests/<n>/run.sh` on the live bodies: the account cases (including an unconfirmed phone and an address only an identity carries), expired, used and canceled invitations, the fifth wrong attempt, cooldown and caps (the last allowed code and the first refused one), internal addresses at every step, the role never going down, sessions closed, the two marks set, and an accept racing `remove_team_member`.
- Vitest handler tests for `verify-otp`: with the mark, or when it cannot be read, no password is written or tried and the session comes from the magic link; without it, Strategy A as before. RED without the migration, GREEN with it applied twice, plus negative tests of its own checks and a CRLF copy.
- Vitest handler tests for the Edge Function (pattern of `send-email/index.test.ts`): both actions, IP limits, GoTrue failures, and that a wrong code never returns the address.
- Template tests for `team_invitation_code` and the changed `team_invitation`.
- `pnpm check-types` and the `@tricigo/api` tests.
- A real run in prod, with the owner's OK: an invitation to an address of the owner, the whole code path, the role checked, then access removed.

## Rollout

Each step with the owner's OK:

1. Apply the migration.
2. Check the magic-link login in prod: the owner sets `password_set_at` on the store demo passenger account, deploys `verify-otp`, signs in on a phone with the demo code, and then clears the mark.
3. Deploy `team-invitation-code` and redeploy `send-email`.
4. Merge the PR, which deploys the panel.

Nothing breaks halfway: until step 4 the page does not show the option, and until step 3 nothing calls the functions. `verify-otp` changes behavior only for accounts with the mark, and before step 4 only the demo account has it.

Then: update the team invitations section of CLAUDE.md, and drop the "create a Google account" step from the message for Baco.

## Out of scope

- Setting a password from the panel for an existing team member (they use "¿Olvidaste tu contraseña?").
- A code by SMS for the refused phone case. Today no account falls in it.
- Two-factor sign-in for password accounts.
