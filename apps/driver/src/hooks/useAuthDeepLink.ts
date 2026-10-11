import { useEffect } from 'react';
import * as Linking from 'expo-linking';
import { logger } from '@tricigo/utils';
import { handleAuthLink } from '@/lib/authLink';

/**
 * Handles tricigo-driver://auth/callback links: the Google/Apple redirect and
 * the email sign-in link. handleAuthLink never lets a link replace another
 * account's session, and asks before using one this phone did not start
 * (lib/authLink.ts).
 */
export function useAuthDeepLink() {
  useEffect(() => {
    function onUrl(event: { url: string }) {
      handleAuthLink(event.url).catch((err) => {
        logger.error('[AuthDeepLink] Error handling callback', { error: String(err) });
      });
    }

    const subscription = Linking.addEventListener('url', onUrl);

    // Cold start with a sign-in link.
    Linking.getInitialURL().then((url) => {
      if (url) onUrl({ url });
    }).catch(() => {});

    return () => subscription.remove();
  }, []);
}
