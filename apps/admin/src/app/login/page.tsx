'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslation } from '@tricigo/i18n';
import { createBrowserClient } from '@/lib/supabase-server';
import { safeInternalPath } from '@tricigo/utils/htmlSafety';
import { GoogleIcon } from '@/components/ui/GoogleIcon';

export default function AdminLoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useTranslation('admin');
  const rawRedirect = searchParams.get('redirect') ?? '/';
  // BUG-018: only paths on this site. safeInternalPath also refuses "/\host", which
  // browsers read as "//host" (another site).
  const redirect = safeInternalPath(rawRedirect) ?? '/';
  const errorParam = searchParams.get('error');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(
    errorParam === 'unauthorized'
      ? t('login.error_unauthorized')
      : errorParam === 'oauth'
        ? t('login.error_generic')
        : '',
  );

  const handleGoogleSignIn = async () => {
    const supabase = createBrowserClient();
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      // Return to the /auth/callback route handler, which exchanges the PKCE
      // code for a session (sets auth cookies) before the middleware runs.
      // `redirect` preserves the page the user was originally headed to.
      options: {
        redirectTo: `${window.location.origin}/auth/callback?redirect=${encodeURIComponent(redirect)}`,
      },
    });
    if (oauthError) setError(oauthError.message);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const supabase = createBrowserClient();
      const { error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (authError) {
        setError(authError.message);
        return;
      }

      router.push(redirect);
      router.refresh();
    } catch {
      setError(t('login.error_generic'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <img
            src="/logo-wordmark-white.png"
            alt="TriciGo"
            className="h-10 w-auto mx-auto mb-2"
          />
          <p className="text-neutral-500 text-sm">{t('login.admin_panel')}</p>
        </div>

        {/* Login Form */}
        <form onSubmit={handleLogin} className="bg-neutral-900 rounded-xl p-6 space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-neutral-300 mb-1">
              {t('login.email_label')}
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-4 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-primary-500 text-sm"
              placeholder={t('login.email_placeholder')}
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-neutral-300 mb-1">
              {t('login.password_label')}
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-4 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-primary-500 text-sm"
              placeholder={t('login.password_placeholder')}
            />
          </div>

          <div className="text-right">
            <Link href="/forgot-password" className="text-sm text-primary-400 hover:text-primary-300">
              {t('login.forgot_password')}
            </Link>
          </div>

          {error && (
            <p role="alert" className="text-red-400 text-sm">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-medium rounded-lg text-sm transition-colors"
          >
            {loading ? t('login.logging_in') : t('login.login_button')}
          </button>

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-neutral-700" />
            <span className="text-neutral-500 text-xs uppercase">{t('login.or_divider')}</span>
            <div className="flex-1 h-px bg-neutral-700" />
          </div>

          {/* Google Sign-In */}
          <button
            type="button"
            onClick={handleGoogleSignIn}
            className="w-full py-2.5 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-white font-medium rounded-lg text-sm transition-colors flex items-center justify-center gap-2"
          >
            <GoogleIcon className="w-5 h-5" />
            {t('login.sign_in_with_google')}
          </button>
        </form>
      </div>
    </div>
  );
}
