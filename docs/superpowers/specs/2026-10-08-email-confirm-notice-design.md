# "Confirma tu correo" notice — design

Date: 2026-10-08. Approved by the owner in chat on the same day.

## Why

Since migration 00635, TriciGo only e-mails an account at an address its owner proved:
`users.email_verified_at` is set (stamped by `confirm-email`), or a Google/Apple identity the
provider verified carries the same address. Measured in prod on 2026-10-07: 128 accounts have an
address that is not proven, 103 of them approved drivers, 71 with a session in the last 30 days.
They no longer receive receipts, gift notices, driver status mail or the contract PDF.

Nobody has ever confirmed an address through the current flow: `email_verification_tokens` has
0 rows in its whole history. Three reasons, found in the code:

1. The rider app's "Editar perfil" writes `users.email` directly (`authService.updateProfile`)
   and never asks for the confirmation link. A rider cannot confirm an address at all.
2. Driver onboarding (`apps/driver/app/onboarding/review.tsx`) does the same.
3. No screen knows whether the address is confirmed, so nothing tells the user.

Only the driver app's "Editar perfil" and the web profile edit call
`add-email-with-verification`, and only when the address changes.

## Decisions (owner, 2026-10-08)

- Where: a banner on the driver home, plus a row in Profile on the rider app, the driver app
  and the web.
- Insistence: the home banner can be dismissed and comes back after 7 days if the address is
  still unconfirmed. The Profile row cannot be dismissed.
- UI work follows the ui-ux-pro-max skill, reusing the existing components.

## Design

### 1. Server: `public.get_my_email_status()` (migration 00643)

Returns one row about the caller only, from `auth.uid()`:

| column | meaning |
|---|---|
| `email` | `btrim(users.email)`, or NULL when empty or the phone-OTP placeholder `phone_<n>@tricigo.app` |
| `status` | `none` (no real address), `proven` (`_user_mailable_email(auth.uid())` is not NULL), else `unconfirmed` |
| `link_sent_at` | newest `email_verification_tokens.created_at` for the caller and that address that is unused and unexpired, else NULL |

- `LANGUAGE sql STABLE SECURITY DEFINER`, `SET search_path = pg_catalog, public`. It reuses the
  00635 rule, so there is no second copy of "what counts as proven".
- Takes no arguments: it cannot be asked about another account. Without a session it returns no
  rows.
- `REVOKE ALL ... FROM PUBLIC, anon`; `GRANT EXECUTE ... TO authenticated, service_role`.
  The migration asserts the grants at the end (the 00531 lesson).

### 2. API (`packages/api`, `packages/types`, `packages/utils`)

- Type `EmailConfirmationStatus = { email: string | null; status: 'none' | 'unconfirmed' | 'proven'; linkSentAt: string | null }`.
- `authService.getMyEmailStatus(): Promise<EmailConfirmationStatus | null>`: calls the RPC.
  Any error (the migration not applied yet, network) returns `null`, which every caller treats
  as "show nothing".
- `authService.addBackupEmail(email)` keeps its behaviour and gains one mapping: a 429 from the
  Edge Function throws with `code: 'rate_limited'` (today the code is the raw sentence
  "Too many requests. Try again later.").
- `@tricigo/utils`: `EMAIL_NOTICE_SNOOZE_MS` (7 days) and
  `emailNoticeVisible(status, dismissedAtMs, nowMs)`: true only when the status is
  `unconfirmed` and the banner was never dismissed or was dismissed at least 7 days ago.
- `emailNoticeErrorKey(code)`: maps `rate_limited`, `email_already_taken` and anything else to
  the i18n key of the message to show.

### 3. Fix the two paths that never send the link

- Rider "Editar perfil": when the address changes and is not empty, after `updateProfile`,
  call `addBackupEmail(email)` and show "Confirma tu correo / Te enviamos un enlace a {{email}}".
  On failure, keep the saved profile and show the mapped error. This mirrors the driver screen.
- Driver onboarding review: after `updateProfile`, when the typed address differs from the
  stored one, call `addBackupEmail` in its own try/catch. A failure never blocks the submission
  (the home banner lets the driver resend later).

### 4. The notice

Each app gets a small hook `useEmailConfirmation()` (`apps/<app>/src/hooks/`) that loads the
status on focus and when the app returns to the foreground (`useRefreshOnFocus`), and exposes
`resend()` (calls `addBackupEmail(status.email)`, then reloads). Web does the same inside the
profile page.

- **Driver home**: a `Banner` (the existing component in `HomeBottomSheet`), variant `info`,
  icon `mail-unread-outline`.
  - Text: "Confirma tu correo" / "Sin confirmarlo no te llegan recibos ni avisos de tu cuenta.
    {{email}}".
  - Action "Reenviar enlace"; dismiss "Ahora no". The dismissal date is stored in AsyncStorage
    under `email_notice_dismissed_at:<userId>`; `emailNoticeVisible` decides.
  - After a resend, or while `linkSentAt` is recent, the subtitle says "Enlace enviado a
    {{email}}. Revisa tu correo, también la carpeta de spam."
- **Profile** (rider app header card, driver app header, web `profile-email`): under the
  address, a row "Sin confirmar · Reenviar enlace". It shows only while the status is
  `unconfirmed`, cannot be dismissed, and turns into "Enlace enviado" after a resend.
- Error messages after a failed resend: `rate_limited` → "Ya pediste varios enlaces. Espera un
  rato y vuelve a intentarlo."; `email_already_taken` → "Ese correo ya lo usa otra cuenta.
  Cámbialo en Editar perfil."; anything else → "No pudimos enviar el enlace. Inténtalo más tarde."

Copy goes in `common.json` (es/en/pt) under `email_notice.*`, in tú (never voseo).

## Out of scope

- The web's `/auth/email-confirmed` page keeps its hard-coded Spanish copy.
- `register-login-device` is being switched to the proven-address rule in a separate session.
- Nothing changes in what counts as proven or in who gets e-mail.

## Testing

- SQL rehearsal `supabase/tests/00643/run.sh`, RED without the migration, GREEN with it applied
  twice: anon cannot execute; each status (`none`, placeholder, `unconfirmed`, proven by flag,
  proven by Google) for the caller; `link_sent_at` ignores used, expired and other-address
  tokens; a session sees only its own row; negative proofs of the migration's grant checks.
- vitest: `getMyEmailStatus` mapping and its null-on-error; `addBackupEmail` 429 →
  `rate_limited`; `emailNoticeVisible` and `emailNoticeErrorKey`.
- `pnpm check-types` for the four apps, and the existing test suites.

## Rollout

Apply 00643 first; the apps tolerate its absence (no notice). The web ships with the merge. The
two apps need an OTA update or a new build.
