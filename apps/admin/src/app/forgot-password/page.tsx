'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslation } from '@tricigo/i18n';
import { createBrowserClient } from '@/lib/supabase-server';

export default function ForgotPasswordPage() {
  const { t } = useTranslation('admin');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const supabase = createBrowserClient();
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(
        email,
        { redirectTo: `${window.location.origin}/reset-password` },
      );

      if (resetError) {
        setError(resetError.message);
        return;
      }

      setSent(true);
    } catch {
      setError(t('forgot_password.error_generic'));
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

        {sent ? (
          <div className="bg-neutral-900 rounded-xl p-6 space-y-4 text-center">
            <div className="text-3xl mb-2">✉️</div>
            <h2 className="text-white text-lg font-semibold">
              {t('forgot_password.success_title')}
            </h2>
            <p className="text-neutral-400 text-sm">
              {t('forgot_password.success_message', { email })}
            </p>
            <Link
              href="/login"
              className="block text-sm text-primary-400 hover:text-primary-300 mt-4"
            >
              {t('forgot_password.back_to_login')}
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="bg-neutral-900 rounded-xl p-6 space-y-4">
            <h2 className="text-white text-lg font-semibold">
              {t('forgot_password.title')}
            </h2>
            <p className="text-neutral-400 text-sm">
              {t('forgot_password.description')}
            </p>

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-neutral-300 mb-1">
                {t('forgot_password.email_label')}
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-4 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-primary-500 text-sm"
                placeholder={t('forgot_password.email_placeholder')}
              />
            </div>

            {error && (
              <p role="alert" className="text-red-400 text-sm">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-medium rounded-lg text-sm transition-colors"
            >
              {loading ? t('forgot_password.sending') : t('forgot_password.send_link')}
            </button>

            <Link
              href="/login"
              className="block text-center text-sm text-primary-400 hover:text-primary-300"
            >
              {t('forgot_password.back_to_login')}
            </Link>
          </form>
        )}
      </div>
    </div>
  );
}
