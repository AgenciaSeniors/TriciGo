'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useTranslation } from '@tricigo/i18n';
import { createBrowserClient } from '@/lib/supabase-server';

export default function ResetPasswordPage() {
  const { t } = useTranslation('admin');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const supabaseRef = useRef(createBrowserClient());

  useEffect(() => {
    const supabase = supabaseRef.current;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setHasSession(true);
      }
    });

    // Also check if session already exists (e.g., page refreshed after token was consumed)
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setHasSession(true);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!hasSession) {
      setError(t('reset_password.error_no_session'));
      return;
    }

    if (newPassword.length < 8) {
      setError(t('reset_password.error_too_short'));
      return;
    }

    if (newPassword !== confirmPassword) {
      setError(t('reset_password.error_mismatch'));
      return;
    }

    setLoading(true);

    try {
      const supabase = supabaseRef.current;
      const { error: updateError } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (updateError) {
        setError(updateError.message);
        return;
      }

      // Sign out after password update so they log in fresh
      await supabase.auth.signOut();
      setSuccess(true);
    } catch {
      setError(t('reset_password.error_generic'));
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

        {success ? (
          <div className="bg-neutral-900 rounded-xl p-6 space-y-4 text-center">
            <div className="text-3xl mb-2">✅</div>
            <p className="text-neutral-300 text-sm">
              {t('reset_password.success_message')}
            </p>
            <Link
              href="/login"
              className="block text-sm text-primary-400 hover:text-primary-300 mt-4"
            >
              {t('reset_password.go_to_login')}
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="bg-neutral-900 rounded-xl p-6 space-y-4">
            <h2 className="text-white text-lg font-semibold">
              {t('reset_password.title')}
            </h2>
            <p className="text-neutral-400 text-sm">
              {t('reset_password.description')}
            </p>

            <div>
              <label htmlFor="newPassword" className="block text-sm font-medium text-neutral-300 mb-1">
                {t('reset_password.new_password_label')}
              </label>
              <input
                id="newPassword"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
                className="w-full px-4 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-primary-500 text-sm"
                placeholder={t('reset_password.new_password_placeholder')}
              />
            </div>

            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-neutral-300 mb-1">
                {t('reset_password.confirm_password_label')}
              </label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
                className="w-full px-4 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-primary-500 text-sm"
                placeholder={t('reset_password.confirm_password_placeholder')}
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
              {loading ? t('reset_password.resetting') : t('reset_password.reset_button')}
            </button>

            <Link
              href="/login"
              className="block text-center text-sm text-primary-400 hover:text-primary-300"
            >
              {t('reset_password.go_to_login')}
            </Link>
          </form>
        )}
      </div>
    </div>
  );
}
