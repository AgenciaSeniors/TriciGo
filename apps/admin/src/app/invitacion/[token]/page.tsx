'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useTranslation } from '@tricigo/i18n';
import { teamService, type PublicInvitation } from '@tricigo/api';
import { isInvitationToken } from '@tricigo/utils/teamInvitation';
import { createBrowserClient } from '@/lib/supabase-server';
import { formatAdminDate } from '@/lib/formatDate';
import { GoogleIcon } from '@/components/ui/GoogleIcon';

/**
 * The page an invitation e-mail links to (00660). Public: it reads the invitation
 * with its token (role, who invited, the address masked) and signs in with Google.
 * /auth/callback accepts the invitation with the same token.
 */
export default function InvitationPage() {
  const { t } = useTranslation('admin');
  const params = useParams<{ token: string }>();
  const token = typeof params?.token === 'string' ? params.token : '';
  const [invitation, setInvitation] = useState<PublicInvitation | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!isInvitationToken(token)) {
      setInvitation({ status: 'not_found' });
      return;
    }
    let cancelled = false;
    teamService
      .getInvitation(token)
      .then((inv) => {
        if (!cancelled) setInvitation(inv);
      })
      .catch(() => {
        if (!cancelled) setError(t('invitation.load_error', { defaultValue: 'No pudimos cargar la invitación. Intenta de nuevo.' }));
      });
    return () => {
      cancelled = true;
    };
  }, [token, t]);

  const signIn = async () => {
    setStarting(true);
    setError('');
    const { error: oauthError } = await createBrowserClient().auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback?invite=${token}`,
        // Lets the person pick the Google account of the invited address.
        queryParams: { prompt: 'select_account' },
      },
    });
    if (oauthError) {
      setError(oauthError.message);
      setStarting(false);
    }
  };

  const roleLabel = (role?: string) => t(`team.role_${role ?? 'admin'}`, { defaultValue: role ?? '' });

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <img src="/logo-wordmark-white.png" alt="TriciGo" className="mx-auto mb-2 h-10 w-auto" />
          <p className="text-sm text-neutral-500">{t('login.admin_panel')}</p>
        </div>
        <div className="space-y-4 rounded-xl bg-neutral-900 p-6 text-sm text-neutral-300">
          {!invitation && !error && <p>{t('invitation.loading', { defaultValue: 'Cargando la invitación…' })}</p>}

          {invitation?.status === 'pending' && (
            <>
              <h1 className="text-lg font-semibold text-white">
                {t('invitation.title', { defaultValue: 'Te invitaron al panel de TriciGo' })}
              </h1>
              <p>
                {t('invitation.body', {
                  defaultValue: '{{inviter}} te invitó con el rol {{role}}.',
                  inviter: invitation.inviter_name || t('invitation.someone', { defaultValue: 'Alguien del equipo' }),
                  role: roleLabel(invitation.role),
                })}
              </p>
              <p>
                {t('invitation.use_google', {
                  defaultValue: 'Entra con la cuenta de Google de {{email}}. Con otra cuenta la invitación no funciona.',
                  email: invitation.email_masked ?? '',
                })}
              </p>
              {invitation.expires_at && (
                <p className="text-neutral-500">
                  {t('invitation.expires', { defaultValue: 'Vence el {{date}}.', date: formatAdminDate(invitation.expires_at) })}
                </p>
              )}
              <button
                type="button"
                onClick={signIn}
                disabled={starting}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-neutral-700 bg-neutral-800 py-2.5 font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
              >
                <GoogleIcon className="h-5 w-5" />
                {t('invitation.sign_in', { defaultValue: 'Entrar con Google' })}
              </button>
            </>
          )}

          {invitation && invitation.status !== 'pending' && (
            <p role="alert">
              {invitation.status === 'expired'
                ? t('invitation.expired', { defaultValue: 'La invitación venció. Pídele a quien te invitó que te mande una nueva.' })
                : invitation.status === 'canceled'
                  ? t('invitation.canceled', { defaultValue: 'La invitación fue cancelada. Si crees que es un error, pídele a quien te invitó una nueva.' })
                  : invitation.status === 'accepted'
                    ? t('invitation.accepted', { defaultValue: 'Esta invitación ya se usó. Entra desde la página de inicio de sesión.' })
                    : t('invitation.not_found', { defaultValue: 'No encontramos esa invitación. Revisa el enlace o pide uno nuevo.' })}
            </p>
          )}

          {error && <p role="alert" className="text-red-400">{error}</p>}
        </div>
      </div>
    </div>
  );
}
