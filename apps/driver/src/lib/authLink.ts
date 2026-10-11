// ============================================================
// TriciGo Driver — sign-in links (Google, Apple, email link)
//
// Every `tricigo-driver://auth/callback#access_token=…` link goes through here: the
// OS link listener (useAuthDeepLink) and the result of the in-app browser
// (login.tsx). A link never replaces another account's session; it is taken
// without asking only right after the user started a login on this phone, and
// otherwise the user is asked first. Rule: packages/utils/src/authCallback.ts.
// Mirror of apps/client/src/lib/authLink.ts (scheme tricigo).
// ============================================================

import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Toast from 'react-native-toast-message';
import { completeAuthCallback, type AuthCallbackOutcome } from '@tricigo/api';
import { i18n } from '@tricigo/i18n';
import { logger } from '@tricigo/utils';
import {
  PENDING_LOGIN_STORAGE_KEY,
  parseAuthCallbackUrl,
  serializePendingLogin,
  type PendingLoginKind,
} from '@tricigo/utils/authCallback';
import { useAuthStore } from '@/stores/auth.store';

const SCHEMES = ['tricigo-driver'] as const;

const tr = (key: string, defaultValue: string, opts: Record<string, unknown> = {}) =>
  i18n.t(key, { ns: 'common', defaultValue, ...opts });

/** Call right before sending the user to Google/Apple: their link is then
 *  taken without asking for the next few minutes. */
export async function markLoginStarted(kind: PendingLoginKind, expectedEmail?: string | null): Promise<void> {
  try {
    await AsyncStorage.setItem(PENDING_LOGIN_STORAGE_KEY, serializePendingLogin(kind, Date.now(), expectedEmail));
  } catch {
    // Without the marker the link still works, after a confirmation.
  }
}

function confirmLinkSignIn(accountLabel: string | null): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      tr('auth.link_signin_title', '¿Entrar con esta cuenta?'),
      accountLabel
        ? tr('auth.link_signin_body', 'Este enlace abre la cuenta {{account}}. Si no pediste entrar desde aquí, toca Cancelar.', { account: accountLabel })
        : tr('auth.link_signin_body_unknown', 'Este enlace abre una cuenta de TriciGo. Si no pediste entrar desde aquí, toca Cancelar.'),
      [
        { text: tr('cancel', 'Cancelar'), style: 'cancel', onPress: () => resolve(false) },
        { text: tr('auth.link_signin_confirm', 'Entrar'), onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/**
 * Finish a sign-in link. Returns null when `url` is not one (other deep
 * links), otherwise what happened.
 */
export async function handleAuthLink(url: string): Promise<AuthCallbackOutcome | null> {
  const tokens = parseAuthCallbackUrl(url, SCHEMES);
  if (!tokens) return null;

  const outcome = await completeAuthCallback(tokens, {
    readPending: () => AsyncStorage.getItem(PENDING_LOGIN_STORAGE_KEY),
    clearPending: () => AsyncStorage.removeItem(PENDING_LOGIN_STORAGE_KEY),
    confirm: confirmLinkSignIn,
    currentUserId: () => useAuthStore.getState().user?.id ?? null,
  });

  if (outcome === 'other_account_signed_in') {
    Toast.show({
      type: 'info',
      text1: tr('auth.link_signin_other_session_title', 'Ya tienes una sesión abierta'),
      text2: tr('auth.link_signin_other_session_body', 'Ese enlace es de otra cuenta. Para usarlo, primero cierra sesión.'),
    });
  } else if (outcome === 'failed') {
    Toast.show({
      type: 'error',
      text1: tr('auth.social_login_failed_title', 'No se pudo iniciar sesión'),
      text2: tr('auth.link_signin_failed_body', 'El enlace venció o ya se usó. Pide uno nuevo.'),
    });
  }
  if (outcome !== 'signed_in' && outcome !== 'already_signed_in') {
    logger.warn('[AuthLink] sign-in link not used', { outcome });
  }
  return outcome;
}
