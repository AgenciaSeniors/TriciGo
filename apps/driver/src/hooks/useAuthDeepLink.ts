import { useEffect } from 'react';
import * as Linking from 'expo-linking';
import { getSupabaseClient } from '@tricigo/api';
import { logger } from '@tricigo/utils';

/**
 * Handles tricigo-driver://auth/callback deep links from OAuth redirect.
 * Extracts access_token and refresh_token from the URL hash and
 * sets the Supabase session, triggering the onAuthStateChange listener.
 */
export function useAuthDeepLink() {
  useEffect(() => {
    function handleAuthCallback(event: { url: string }) {
      try {
        const url = event.url;
        if (!url.includes('auth/callback')) return;

        const hashIndex = url.indexOf('#');
        if (hashIndex === -1) return;

        const hash = url.substring(hashIndex + 1);
        const params = new URLSearchParams(hash);
        const accessToken = params.get('access_token');
        const refreshToken = params.get('refresh_token');

        if (accessToken && refreshToken) {
          const supabase = getSupabaseClient();
          supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          }).then(({ error }) => {
            if (error) {
              logger.error('[AuthDeepLink] Failed to set session', { error: error.message });
            }
          });
        }
      } catch (err) {
        logger.error('[AuthDeepLink] Error handling callback', { error: String(err) });
      }
    }

    const subscription = Linking.addEventListener('url', handleAuthCallback);

    // Handle cold start with auth callback URL
    Linking.getInitialURL().then((url) => {
      if (url && url.includes('auth/callback')) {
        handleAuthCallback({ url });
      }
    }).catch(() => {});

    return () => subscription.remove();
  }, []);
}
