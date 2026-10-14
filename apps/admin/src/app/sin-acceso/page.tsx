'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslation } from '@tricigo/i18n';
import { maskedEmailParam, noAccessReason } from '@tricigo/utils/teamInvitation';
import { createBrowserClient } from '@/lib/supabase-server';
import { GoogleIcon } from '@/components/ui/GoogleIcon';

/**
 * Where the panel sends a signed-in account that has no panel role (00661), with
 * the reason: no invitation, the invitation is for another address, it expired, etc.
 * Public on purpose (outside the middleware), so it never loops.
 */
function NoAccess() {
  const { t } = useTranslation('admin');
  const router = useRouter();
  const params = useSearchParams();
  const reason = noAccessReason(params.get('reason'));
  // Only the masked shape the server produces; a hand-made link shows no address.
  const invited = maskedEmailParam(params.get('email'));
  const [signedInAs, setSignedInAs] = useState('');
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    createBrowserClient()
      .auth.getSession()
      .then(({ data }) => setSignedInAs(data.session?.user.email ?? ''));
  }, []);

  const signOut = async () => {
    setLeaving(true);
    await createBrowserClient().auth.signOut();
    router.replace('/login');
  };

  // Google signs the same account in again unless it is asked to show the account picker.
  // Back in the panel, the middleware accepts a pending invitation for the new address.
  const otherGoogleAccount = async () => {
    setLeaving(true);
    setError('');
    const supabase = createBrowserClient();
    await supabase.auth.signOut();
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        queryParams: { prompt: 'select_account' },
      },
    });
    if (oauthError) {
      setError(oauthError.message);
      setLeaving(false);
    }
  };
  const offerOtherAccount = reason === 'none' || reason === 'wrong_account' || reason === 'needs_google';

  // The account's address is shown when the session has one (Google, Apple).
  const messages: Record<string, string> = {
    none: signedInAs
      ? t('no_access.none', {
          defaultValue:
            'Entraste como {{account}}, y esa cuenta no tiene acceso al panel. Si trabajas en TriciGo, pídele a un superadministrador que te invite. Si ya te invitaron, entra con la cuenta de Google a la que llegó la invitación.',
          account: signedInAs,
        })
      : t('no_access.none_unknown', {
          defaultValue:
            'Esta cuenta no tiene acceso al panel. Si trabajas en TriciGo, pídele a un superadministrador que te invite. Si ya te invitaron, entra con la cuenta de Google a la que llegó la invitación.',
        }),
    wrong_account: !invited
      ? t('no_access.wrong_account_no_email', {
          defaultValue: 'La invitación es para otra cuenta de Google. Entra con la cuenta a la que llegó la invitación.',
        })
      : signedInAs
      ? t('no_access.wrong_account', {
          defaultValue: 'La invitación es para {{invited}}, pero entraste como {{account}}. Cierra sesión y entra con esa cuenta de Google.',
          invited,
          account: signedInAs,
        })
      : t('no_access.wrong_account_unknown', {
          defaultValue: 'La invitación es para {{invited}}, pero entraste con otra cuenta. Cierra sesión y entra con esa cuenta de Google.',
          invited,
        }),
    needs_google: invited
      ? t('no_access.needs_google', {
          defaultValue: 'La invitación es para {{invited}}. Para aceptarla tienes que entrar con Google usando esa dirección.',
          invited,
        })
      : t('no_access.needs_google_no_email', {
          defaultValue: 'Para aceptar la invitación tienes que entrar con Google, con la dirección a la que llegó.',
        }),
    expired: t('no_access.expired', { defaultValue: 'La invitación venció. Pídele a quien te invitó que te mande una nueva.' }),
    canceled: t('no_access.canceled', { defaultValue: 'La invitación fue cancelada. Si crees que es un error, pídele a quien te invitó una nueva.' }),
    used: t('no_access.used', { defaultValue: 'Esa invitación ya se usó.' }),
    blocked: t('no_access.blocked', { defaultValue: 'Tu cuenta está bloqueada. Escribe a soporte@tricigo.com.' }),
    not_found: t('no_access.not_found', { defaultValue: 'No encontramos esa invitación. Revisa el enlace o pide uno nuevo.' }),
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <img src="/logo-wordmark-white.png" alt="TriciGo" className="mx-auto mb-2 h-10 w-auto" />
          <p className="text-sm text-neutral-500">{t('login.admin_panel')}</p>
        </div>
        <div className="space-y-4 rounded-xl bg-neutral-900 p-6 text-sm text-neutral-300">
          <h1 className="text-lg font-semibold text-white">{t('no_access.title', { defaultValue: 'Sin acceso al panel' })}</h1>
          <p role="alert">{messages[reason]}</p>
          {error && <p className="text-red-400">{error}</p>}
          {offerOtherAccount && (
            <button
              type="button"
              onClick={otherGoogleAccount}
              disabled={leaving}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-neutral-700 bg-neutral-800 py-2.5 font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
            >
              <GoogleIcon className="h-5 w-5" />
              {t('no_access.other_google', { defaultValue: 'Entrar con otra cuenta de Google' })}
            </button>
          )}
          <button
            type="button"
            onClick={signOut}
            disabled={leaving}
            className={
              offerOtherAccount
                ? 'w-full rounded-lg py-2.5 font-medium text-neutral-300 transition-colors hover:text-white disabled:opacity-50'
                : 'w-full rounded-lg bg-primary-500 py-2.5 font-medium text-white transition-colors hover:bg-primary-600 disabled:opacity-50'
            }
          >
            {t('no_access.sign_out', { defaultValue: 'Cerrar sesión' })}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function NoAccessPage() {
  return (
    <Suspense fallback={null}>
      <NoAccess />
    </Suspense>
  );
}
