# "Confirma tu correo" Notice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell users whose `users.email` is not proven to confirm it, let them resend the link, and make every path that saves an address actually send the link.

**Architecture:** A caller-scoped RPC `get_my_email_status()` (migration 00640) answers with the 00635 rule. `@tricigo/api` wraps it (null on any error) and maps the 429 of `add-email-with-verification` to `rate_limited`; `@tricigo/utils` holds the 7-day snooze and the error-to-message mapping. Each app has a `useEmailConfirmation()` hook; the driver home renders a dismissible `Banner`; Profile on the rider app, the driver app and the web renders a non-dismissible row. The rider "Editar perfil" and driver onboarding start calling `addBackupEmail`.

**Tech Stack:** Postgres 16 (Supabase), TypeScript, vitest, Expo Router / React Native (NativeWind in the rider app, palette styles in the driver app), Next.js 14 (web), i18next.

Spec: `docs/superpowers/specs/2026-10-08-email-confirm-notice-design.md`.

---

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/00640_my_email_status.sql` (new) | `get_my_email_status()` + grants + self-checks |
| `supabase/tests/00640/{run.sh,scaffold.sql,seed.sql}` (new) | Local rehearsal (RED without, GREEN with the migration) |
| `packages/types/src/user.ts` | `EmailConfirmationStatus` type |
| `packages/utils/src/emailNotice.ts` (new) + `__tests__/emailNotice.test.ts` | Snooze rule and error-key mapping |
| `packages/utils/src/index.ts` | Export the above |
| `packages/api/src/services/auth.service.ts` | `getMyEmailStatus()`; 429 → `rate_limited` in `addBackupEmail` |
| `packages/api/src/services/__tests__/auth.test.ts` | Tests for both |
| `packages/i18n/src/locales/{es,en,pt}/common.json` | `email_notice.*` copy |
| `apps/{client,driver}/src/hooks/useEmailConfirmation.ts` (new) | Load status on focus, resend |
| `apps/driver/src/components/HomeBottomSheet.tsx` + `apps/driver/app/(tabs)/index.tsx` | Home banner + 7-day snooze |
| `apps/{client,driver}/src/components/EmailConfirmRow.tsx` (new) | Profile row per app style |
| `apps/client/app/(tabs)/profile.tsx`, `apps/driver/app/(tabs)/profile.tsx` | Mount the row |
| `apps/web/src/app/profile/page.tsx` | Web row |
| `apps/client/app/profile/edit.tsx`, `apps/driver/app/onboarding/review.tsx` | Send the link when the address is saved |

---

### Task 1: Migration 00640 and its rehearsal

**Files:**
- Create: `supabase/tests/00640/scaffold.sql`, `supabase/tests/00640/seed.sql`, `supabase/tests/00640/run.sh`
- Create: `supabase/migrations/00640_my_email_status.sql`

- [ ] **Step 1: Scaffold.** Roles `anon`/`authenticated`/`service_role`/`postgres` (non-superuser owner, member of the three API roles, as in prod), schema `auth` with `auth.uid()` reading `request.jwt.claim.sub`, `auth.identities (user_id, provider, identity_data jsonb)`, `public.users (id, email, email_verified_at)`, `public.email_verification_tokens (id, user_id, email, token_hash, expires_at, used_at, created_at)`, and the two 00635 helpers copied verbatim from `supabase/migrations/00635_mail_only_proven_addresses.sql` section 1 (`mailable_user_emails`, `_user_mailable_email`) with their REVOKE/GRANT. `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role` at the end, like prod.

- [ ] **Step 2: Seed.** Users: `UNC` ('unc@x.test', unconfirmed), `FLAG` (email_verified_at set), `GOOG` (Google identity, same address, email_verified true), `PHONE` ('phone_5355555555@tricigo.app'), `NOMAIL` (NULL email), `SPACE` (' Spaced@X.test '). Tokens for `UNC`: one used, one expired, one for another address, one valid created 2 h ago, one valid created 1 h ago.

- [ ] **Step 3: run.sh** (same harness as `supabase/tests/00635/run.sh`: `PGBIN`/`PGPORT`/`PYTHON` overrides, `LC_MESSAGES=C`, `PGCLIENTENCODING=UTF8`, `apply`/`apply_err`/`val`/`has`). Tests, all written against the GREEN behaviour:

```
S0  scaffold helpers carry the prod bodies: mailable_user_emails 58def9245ceb43b710a57ef01c450572/479, _user_mailable_email 99a0551a2ad5dd6fbf65619c81842e83/72
E1  anon cannot execute get_my_email_status            -> has "42501: permission denied for function get_my_email_status"
E2  authenticated without a subject                     -> "0" rows
E3  UNC  -> "unc@x.test|unconfirmed|<link of the 1 h token>"   (assert link = max valid created_at)
E4  FLAG -> "flag@x.test|proven|"
E5  GOOG -> "goog@x.test|proven|"
E6  PHONE -> "|none|"
E7  NOMAIL -> "|none|"
E8  SPACE -> "Spaced@X.test|unconfirmed|"
E9  a caller sees exactly one row, its own (count=1, email = its own)
M1  (GREEN only) SECURITY DEFINER, search_path pg_catalog, public; EXECUTE anon=false authenticated=true service_role=true
M2  (GREEN only) second apply leaves the body identical
N1  (GREEN only) sabotage: drop "anon" from the REVOKE -> migration aborts with "00640: anon can execute public.get_my_email_status()"
N2  (GREEN only) sabotage: drop the GRANT to authenticated -> aborts with "00640: authenticated cannot execute public.get_my_email_status()"
```

- [ ] **Step 4: Run RED.** `PGBIN=<scratchpad>/pgsql/bin PGPORT=<port> PYTHON=python bash supabase/tests/00640/run.sh none`. Expected: S0 passes, E1–E9 fail (function does not exist).

- [ ] **Step 5: Migration.**

```sql
-- 00640: let an account ask whether ITS e-mail address is proven, so the apps can tell it
-- to confirm the address (spec: docs/superpowers/specs/2026-10-08-email-confirm-notice-design.md).
-- Same rule as 00635 (_user_mailable_email); about the caller only, no arguments.

CREATE OR REPLACE FUNCTION public.get_my_email_status()
RETURNS TABLE (email text, status text, link_sent_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  WITH me AS (
    SELECT u.id,
           CASE
             WHEN btrim(coalesce(u.email, '')) = '' THEN NULL
             WHEN btrim(u.email) ~* '^phone_[0-9]+@tricigo\.app$' THEN NULL
             ELSE btrim(u.email)
           END AS addr
    FROM public.users u
    WHERE u.id = auth.uid()
  )
  SELECT me.addr,
         CASE
           WHEN me.addr IS NULL THEN 'none'
           WHEN public._user_mailable_email(me.id) IS NOT NULL THEN 'proven'
           ELSE 'unconfirmed'
         END,
         (SELECT max(t.created_at)
            FROM public.email_verification_tokens t
           WHERE t.user_id = me.id
             AND t.used_at IS NULL
             AND t.expires_at > now()
             AND lower(btrim(t.email)) = lower(me.addr))
  FROM me;
$fn$;

COMMENT ON FUNCTION public.get_my_email_status() IS
  '00640: the caller''s users.email (NULL when empty or the phone placeholder), whether it is proven (00635 rule: none/unconfirmed/proven) and when the newest still-valid confirmation link was sent. About auth.uid() only.';

REVOKE ALL ON FUNCTION public.get_my_email_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_email_status() TO authenticated, service_role;

DO $assert$
BEGIN
  IF has_function_privilege('anon', 'public.get_my_email_status()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '00640: anon can execute public.get_my_email_status()';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_my_email_status()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '00640: authenticated cannot execute public.get_my_email_status()';
  END IF;
END
$assert$;
```

- [ ] **Step 6: Run GREEN.** Same command with `supabase/migrations/00640_my_email_status.sql`. Expected: all pass.

- [ ] **Step 7: Commit.** `git add supabase/migrations/00640_my_email_status.sql supabase/tests/00640 && git commit -m "feat(email): get_my_email_status for the confirm-your-email notice (00640)"`

### Task 2: Type and pure rules

**Files:**
- Modify: `packages/types/src/user.ts` (append)
- Create: `packages/utils/src/emailNotice.ts`, `packages/utils/src/__tests__/emailNotice.test.ts`
- Modify: `packages/utils/src/index.ts` (append export)

- [ ] **Step 1: Type** (append to `packages/types/src/user.ts`):

```ts
/** What get_my_email_status (00640) says about the caller's users.email. */
export type EmailConfirmationState = 'none' | 'unconfirmed' | 'proven';

export interface EmailConfirmationStatus {
  /** users.email trimmed, or null when empty or the phone-OTP placeholder. */
  email: string | null;
  status: EmailConfirmationState;
  /** When the newest still-valid confirmation link was sent, or null. */
  linkSentAt: string | null;
}
```

- [ ] **Step 2: Failing tests** `packages/utils/src/__tests__/emailNotice.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EMAIL_NOTICE_SNOOZE_MS, emailNoticeErrorKey, emailNoticeVisible } from '../emailNotice';

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

describe('emailNoticeVisible', () => {
  it('shows only for an unconfirmed address', () => {
    expect(emailNoticeVisible('unconfirmed', null, NOW)).toBe(true);
    expect(emailNoticeVisible('proven', null, NOW)).toBe(false);
    expect(emailNoticeVisible('none', null, NOW)).toBe(false);
    expect(emailNoticeVisible(null, null, NOW)).toBe(false);
    expect(emailNoticeVisible(undefined, null, NOW)).toBe(false);
  });

  it('stays hidden for 7 days after "Ahora no", then comes back', () => {
    expect(emailNoticeVisible('unconfirmed', NOW - EMAIL_NOTICE_SNOOZE_MS + 1, NOW)).toBe(false);
    expect(emailNoticeVisible('unconfirmed', NOW - EMAIL_NOTICE_SNOOZE_MS, NOW)).toBe(true);
  });

  it('a dismissal stamped in the future (clock moved back) does not hide it for good', () => {
    expect(emailNoticeVisible('unconfirmed', NOW + 60_000, NOW)).toBe(true);
  });

  it('ignores a dismissal that is not a finite number', () => {
    expect(emailNoticeVisible('unconfirmed', Number.NaN, NOW)).toBe(true);
  });
});

describe('emailNoticeErrorKey', () => {
  it('maps the codes the resend can fail with to their message', () => {
    expect(emailNoticeErrorKey('rate_limited')).toBe('email_notice.error_rate_limited');
    expect(emailNoticeErrorKey('email_already_taken')).toBe('email_notice.error_taken');
    expect(emailNoticeErrorKey('invalid_email')).toBe('email_notice.error_generic');
    expect(emailNoticeErrorKey(undefined)).toBe('email_notice.error_generic');
  });
});
```

- [ ] **Step 3: Run RED.** `cd packages/utils && npx vitest run src/__tests__/emailNotice.test.ts` → fails (module missing).

- [ ] **Step 4: Implement** `packages/utils/src/emailNotice.ts`:

```ts
// The "Confirma tu correo" notice (spec 2026-10-08): who sees it, and what a failed resend says.
import type { EmailConfirmationState } from '@tricigo/types';

/** "Ahora no" hides the home banner this long; it comes back if still unconfirmed. */
export const EMAIL_NOTICE_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

export function emailNoticeVisible(
  status: EmailConfirmationState | null | undefined,
  dismissedAtMs: number | null,
  nowMs: number,
): boolean {
  if (status !== 'unconfirmed') return false;
  if (dismissedAtMs === null || !Number.isFinite(dismissedAtMs)) return true;
  if (dismissedAtMs > nowMs) return true;
  return nowMs - dismissedAtMs >= EMAIL_NOTICE_SNOOZE_MS;
}

export type EmailNoticeErrorKey =
  | 'email_notice.error_rate_limited'
  | 'email_notice.error_taken'
  | 'email_notice.error_generic';

export function emailNoticeErrorKey(code: string | null | undefined): EmailNoticeErrorKey {
  if (code === 'rate_limited') return 'email_notice.error_rate_limited';
  if (code === 'email_already_taken') return 'email_notice.error_taken';
  return 'email_notice.error_generic';
}
```

Export from `packages/utils/src/index.ts`:

```ts
export { EMAIL_NOTICE_SNOOZE_MS, emailNoticeVisible, emailNoticeErrorKey } from './emailNotice';
export type { EmailNoticeErrorKey } from './emailNotice';
```

- [ ] **Step 5: Run GREEN**, then commit `feat(email): snooze rule and error mapping for the confirm-your-email notice`.

### Task 3: API

**Files:** Modify `packages/api/src/services/auth.service.ts`; tests in `packages/api/src/services/__tests__/auth.test.ts`.

- [ ] **Step 1: Failing tests** (inside `describe('authService')`):

```ts
  describe('getMyEmailStatus', () => {
    it('maps the RPC row', async () => {
      mockRpc.mockResolvedValue({
        data: [{ email: 'a@x.test', status: 'unconfirmed', link_sent_at: '2026-10-08T10:00:00Z' }],
        error: null,
      });
      await expect(authService.getMyEmailStatus()).resolves.toEqual({
        email: 'a@x.test', status: 'unconfirmed', linkSentAt: '2026-10-08T10:00:00Z',
      });
      expect(mockRpc).toHaveBeenCalledWith('get_my_email_status');
    });

    it('returns null when the RPC fails (migration not applied yet)', async () => {
      mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'not found' } });
      await expect(authService.getMyEmailStatus()).resolves.toBeNull();
    });

    it('returns null without a row or with an unknown status', async () => {
      mockRpc.mockResolvedValue({ data: [], error: null });
      await expect(authService.getMyEmailStatus()).resolves.toBeNull();
      mockRpc.mockResolvedValue({ data: [{ email: 'a@x.test', status: 'weird', link_sent_at: null }], error: null });
      await expect(authService.getMyEmailStatus()).resolves.toBeNull();
    });
  });
```

and, in `describe('addBackupEmail')`:

```ts
    it('turns the 429 of the Edge Function into rate_limited', async () => {
      const ctx = new Response(JSON.stringify({ error: 'Too many requests. Try again later.' }), { status: 429 });
      mockFunctions.invoke.mockResolvedValue({ data: null, error: Object.assign(new Error('429'), { context: ctx }) });
      await expect(authService.addBackupEmail('a@b.com')).rejects.toMatchObject({ code: 'rate_limited' });
    });
```

- [ ] **Step 2: Run RED** (`cd packages/api && npx vitest run src/services/__tests__/auth.test.ts`).

- [ ] **Step 3: Implement.** In `addBackupEmail`, inside `if (ctx)` before reading the body: `if (ctx.status === 429) efCode = 'rate_limited';` and only read the body when `efCode` is still null. Fix the stale doc comment (the function no longer writes auth.users; the link confirms the address, which `confirm-email` stamps). Add after it:

```ts
  /**
   * Whether the caller's users.email is proven (00640 get_my_email_status, same rule as
   * 00635). Null on any failure — callers show no notice then.
   */
  async getMyEmailStatus(): Promise<EmailConfirmationStatus | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_my_email_status');
    if (error) return null;
    const row = (Array.isArray(data) ? data[0] : data) as
      | { email?: unknown; status?: unknown; link_sent_at?: unknown }
      | null
      | undefined;
    if (!row) return null;
    const status = row.status;
    if (status !== 'none' && status !== 'unconfirmed' && status !== 'proven') return null;
    return {
      email: typeof row.email === 'string' ? row.email : null,
      status,
      linkSentAt: typeof row.link_sent_at === 'string' ? row.link_sent_at : null,
    };
  },
```

(import `EmailConfirmationStatus` from `@tricigo/types`).

- [ ] **Step 4: GREEN**, full `packages/api` suite, commit `feat(email): getMyEmailStatus and rate_limited for the resend`.

### Task 4: Copy (es/en/pt `common.json`, new top-level `email_notice`)

| key | es | en | pt |
|---|---|---|---|
| `title` | Confirma tu correo | Confirm your email | Confirme seu e-mail |
| `body` | Sin confirmarlo no te llegan recibos ni avisos de tu cuenta. | Until you do, you won't get receipts or account notices. | Sem confirmar, você não recebe recibos nem avisos da sua conta. |
| `unconfirmed` | Sin confirmar | Not confirmed | Não confirmado |
| `resend` | Reenviar enlace | Resend link | Reenviar link |
| `later` | Ahora no | Not now | Agora não |
| `sent` | Enlace enviado a {{email}}. Revisa tu correo, también la carpeta de spam. | Link sent to {{email}}. Check your inbox and your spam folder. | Link enviado para {{email}}. Confira sua caixa de entrada e o spam. |
| `sent_short` | Enlace enviado | Link sent | Link enviado |
| `sent_alert_body` | Te enviamos un enlace a {{email}}. Ábrelo para confirmar tu correo. | We sent a link to {{email}}. Open it to confirm your email. | Enviamos um link para {{email}}. Abra-o para confirmar seu e-mail. |
| `error_rate_limited` | Ya pediste varios enlaces. Espera un rato y vuelve a intentarlo. | You've asked for several links. Wait a while and try again. | Você já pediu vários links. Espere um pouco e tente de novo. |
| `error_taken` | Ese correo ya lo usa otra cuenta. Cámbialo en Editar perfil. | Another account already uses that email. Change it in Edit profile. | Outra conta já usa esse e-mail. Troque-o em Editar perfil. |
| `error_generic` | No pudimos enviar el enlace. Inténtalo más tarde. | We couldn't send the link. Try again later. | Não conseguimos enviar o link. Tente mais tarde. |

Edit with a Python script that loads, sets `email_notice`, and dumps with `ensure_ascii=False, indent=2` plus the file's original trailing newline; check `git diff --stat` touches only the three files. Run `packages/utils` tests (copyTuteo guard). Commit `feat(i18n): copy for the confirm-your-email notice`.

### Task 5: `useEmailConfirmation()` (client and driver, same file)

`apps/client/src/hooks/useEmailConfirmation.ts` and `apps/driver/src/hooks/useEmailConfirmation.ts`:

```ts
import { useCallback, useRef, useState } from 'react';
import { authService } from '@tricigo/api';
import type { EmailConfirmationStatus } from '@tricigo/types';
import { emailNoticeErrorKey, type EmailNoticeErrorKey } from '@tricigo/utils';
import { useRefreshOnFocus } from './useRefreshOnFocus';

export type ResendResult = { ok: true } | { ok: false; errorKey: EmailNoticeErrorKey };

/**
 * The caller's e-mail confirmation status (00640), reloaded on focus and when the app
 * returns to the foreground, so the notice goes away after the link is opened.
 * `enabled` false (no session) keeps it null.
 */
export function useEmailConfirmation(enabled: boolean) {
  const [status, setStatus] = useState<EmailConfirmationStatus | null>(null);
  const [resending, setResending] = useState(false);
  const [sentNow, setSentNow] = useState(false);
  const busy = useRef(false);

  const refresh = useCallback(() => {
    if (!enabled) { setStatus(null); return; }
    authService.getMyEmailStatus().then(setStatus).catch(() => setStatus(null));
  }, [enabled]);
  useRefreshOnFocus(refresh);

  const resend = useCallback(async (): Promise<ResendResult> => {
    const email = status?.email;
    if (!email || busy.current) return { ok: false, errorKey: 'email_notice.error_generic' };
    busy.current = true;
    setResending(true);
    try {
      await authService.addBackupEmail(email);
      setSentNow(true);
      refresh();
      return { ok: true };
    } catch (err) {
      return { ok: false, errorKey: emailNoticeErrorKey((err as { code?: string } | null)?.code) };
    } finally {
      busy.current = false;
      setResending(false);
    }
  }, [status?.email, refresh]);

  return { status, resending, linkSent: sentNow || !!status?.linkSentAt, resend, refresh };
}
```

`pnpm check-types` must pass. Commit `feat(email): useEmailConfirmation hook in the two apps`.

### Task 6: Driver home banner (use the ui-ux-pro-max skill here)

- `HomeBottomSheet.tsx`: new optional props

```ts
  // ── E-mail confirmation ──
  /** Shown when set: the driver's unconfirmed address. */
  emailNotice?: { email: string; linkSent: boolean; resending: boolean } | null;
  onResendEmailLink?: () => void;
  onDismissEmailNotice?: () => void;
```

  destructure them and render, right after the selfie/eligibility banners and before the WhatsApp one:

```tsx
      {!!emailNotice && (
        <Banner
          variant="info"
          icon="mail-unread-outline"
          message={t('email_notice.title', { ns: 'common', defaultValue: 'Confirma tu correo' })}
          subtitle={emailNotice.linkSent
            ? t('email_notice.sent', { ns: 'common', email: emailNotice.email, defaultValue: 'Enlace enviado a {{email}}. Revisa tu correo, también la carpeta de spam.' })
            : `${t('email_notice.body', { ns: 'common', defaultValue: 'Sin confirmarlo no te llegan recibos ni avisos de tu cuenta.' })} ${emailNotice.email}`}
          actionLabel={t('email_notice.resend', { ns: 'common', defaultValue: 'Reenviar enlace' })}
          onActionPress={onResendEmailLink}
          actionDisabled={emailNotice.resending}
          onDismiss={onDismissEmailNotice}
          dismissLabel={t('email_notice.later', { ns: 'common', defaultValue: 'Ahora no' })}
          palette={palette}
        />
      )}
```

- `(tabs)/index.tsx`: `const emailConfirm = useEmailConfirmation(!!user?.id)`; load the dismissal from AsyncStorage key `email_notice_dismissed_at:<userId>` into state; `showEmailNotice = emailNoticeVisible(emailConfirm.status?.status, dismissedAt, Date.now())`; `dismissEmailNotice` stores `String(Date.now())` and updates state; `resendEmailLink` calls `emailConfirm.resend()` and shows `Toast` error with `t(result.errorKey)` on failure. Pass `emailNotice={showEmailNotice && emailConfirm.status?.email ? { email, linkSent, resending } : null}`.

`pnpm check-types`. Commit `feat(driver): confirm-your-email banner on the home`.

### Task 7: Profile rows (use the ui-ux-pro-max skill here)

- `apps/client/src/components/EmailConfirmRow.tsx` and `apps/driver/src/components/EmailConfirmRow.tsx`: props `{ email: string; linkSent: boolean; resending: boolean; onResend: () => void }`. A compact row under the address: a small amber dot + "Sin confirmar" and a text button "Reenviar enlace" (disabled while `resending`; replaced by "Enlace enviado" once `linkSent`). Rider: `@tricigo/ui` `Text` + `Pressable`, NativeWind classes. Driver: palette inline styles like the profile header. Accessible label on the button; minimum 44 px touch target via `hitSlop`.
- Rider `(tabs)/profile.tsx`: `const emailConfirm = useEmailConfirmation(!!user?.id)`; under the caption, render the row when `emailConfirm.status?.status === 'unconfirmed' && emailConfirm.status.email`; on resend failure `Toast.show({ type: 'error', text1: t(errorKey) })`, on success `Toast.show({ type: 'success', text1: t('email_notice.sent_short') })`.
- Driver `(tabs)/profile.tsx`: same, under the phone line.

`pnpm check-types`. Commit `feat(apps): confirm-your-email row in Profile`.

### Task 8: Web profile row (use the ui-ux-pro-max skill here)

`apps/web/src/app/profile/page.tsx`: `const { t: tc } = useTranslation('common')`; state `emailStatus`, `resending`, `linkSent`, `resendError`; after the session loads, `authService.getMyEmailStatus().then(setEmailStatus)`; under `<p className="profile-email">`, when `emailStatus?.status === 'unconfirmed'`, render a small inline notice: "Sin confirmar" + a button "Reenviar enlace" (calls `authService.addBackupEmail(emailStatus.email)`), "Enlace enviado a {{email}}…" after success, and `tc(emailNoticeErrorKey(code))` after failure. Uses the page's CSS variables.

`pnpm check-types`. Commit `feat(web): confirm-your-email row in Profile`.

### Task 9: Send the link where the address is saved

- Rider `apps/client/app/profile/edit.tsx`: compute `emailChanged` like the driver screen (`email.trim().toLowerCase() !== (realEmail(user.email) ?? '').toLowerCase()`). After `updateProfile` succeeds and `emailChanged && email.trim()`: `try { await authService.addBackupEmail(email.trim()); Alert.alert(t('email_notice.title'), t('email_notice.sent_alert_body', { email: email.trim() })); } catch (err) { Alert.alert(t('email_notice.title'), t(emailNoticeErrorKey((err as { code?: string })?.code))); }`, then `router.back()` as today. The profile save toast stays for the no-email-change path.
- Driver `apps/driver/app/onboarding/review.tsx`: after the `updateProfile` call, when `personalInfo.email` is set and differs from `realEmail(user.email)` (case-insensitive), `try { await authService.addBackupEmail(personalInfo.email.trim()); } catch (err) { console.warn('Onboarding confirmation link error:', err); }` — never blocks the submission.

`pnpm check-types`. Commit `fix(apps): send the confirmation link when the rider or onboarding saves an address`.

### Task 10: Verify and ship

- `pnpm check-types`; `packages/api`, `packages/utils`, `apps/client`, `apps/driver` test suites; the 00640 rehearsal RED/GREEN.
- CLAUDE.md: one bullet under the 00635 notes about `get_my_email_status`, the notice and the two fixed paths.
- Re-check the migration number against master and open PRs; independent review; PR; after approval, merge, apply 00640 (dry run first), and an OTA for the apps.
