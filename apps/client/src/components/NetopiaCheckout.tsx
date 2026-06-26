/**
 * NetopiaCheckout — in-app payment WebView for NETOPIA card payments, routed
 * through the VPS CONNECT proxy (webview-proxy native module) so NETOPIA's
 * edge sees the clean VPS IP instead of the user's (possibly reputation-
 * flagged, e.g. Cuban ETECSA) IP that otherwise gets a Google Cloud Armor 403
 * on the hosted card page. TLS passthrough → the VPS never sees the card →
 * stays PCI SAQ-A. NEVER enable SSL-bump on the proxy.
 *
 * DUPLICATE of apps/driver/src/components/NetopiaCheckout.tsx — keep in sync.
 * (Per-app because the webview-proxy native module is app-local and
 * packages/ui doesn't depend on react-native-webview.)
 *
 * Usage:
 *   const { present, checkoutElement } = useNetopiaCheckout();
 *   ...
 *   await present({ url: redirectUrl, returnUrlBase: RETURN_URL_BASE, intentId });
 *   ...
 *   return (<>{...screen}{checkoutElement}</>);
 *
 * present() resolves when the hosted page redirects back to the return URL
 * (success path) or the user closes the sheet. The caller ALWAYS polls the
 * intent afterwards (the DB is the source of truth) — exactly like the
 * WebBrowser flow it replaces.
 *
 * Fallback (additive, low-risk): when the proxy can't/shouldn't be used —
 * flag `netopia_proxy_enabled` off, iOS < 17 (no WKWebsiteDataStore
 * proxyConfigurations), or setProxyOverride throws — present() transparently
 * falls back to WebBrowser.openAuthSessionAsync, the EXACT pre-existing
 * behavior. With the flag off, this component changes nothing.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import * as WebBrowser from 'expo-web-browser';
import { paymentService } from '@tricigo/api';
import WebViewProxy from '../../modules/webview-proxy';

type PresentArgs = { url: string; returnUrlBase: string; intentId: string };
type Outcome = 'returned' | 'closed';

const APP_SCHEMES = ['tricigo://', 'tricigo-driver://'];

function iosMajorVersion(): number {
  if (Platform.OS !== 'ios') return 0;
  return parseInt(String(Platform.Version).split('.')[0] ?? '0', 10) || 0;
}

export function useNetopiaCheckout() {
  const [active, setActive] = useState<{
    url: string;
    username: string;
    password: string;
  } | null>(null);
  const resolverRef = useRef<((o: Outcome) => void) | null>(null);
  const returnBaseRef = useRef<string>('');
  const settledRef = useRef(false);

  // Safety net: if the screen unmounts mid-checkout, drop the process-wide
  // Android proxy override so it can't leak into other WebViews.
  useEffect(() => {
    return () => {
      WebViewProxy.clearProxyOverride().catch(() => {});
    };
  }, []);

  const settle = useCallback((o: Outcome) => {
    if (settledRef.current) return;
    settledRef.current = true;
    WebViewProxy.clearProxyOverride().catch(() => {});
    setActive(null);
    const r = resolverRef.current;
    resolverRef.current = null;
    r?.(o);
  }, []);

  const fallbackToBrowser = useCallback(
    async (url: string, returnUrlBase: string, intentId: string): Promise<Outcome> => {
      const dismissUrl = `${returnUrlBase}?intent=${encodeURIComponent(intentId)}`;
      const res = await WebBrowser.openAuthSessionAsync(url, dismissUrl);
      return res.type === 'success' ? 'returned' : 'closed';
    },
    [],
  );

  const present = useCallback(
    async ({ url, returnUrlBase, intentId }: PresentArgs): Promise<Outcome> => {
      let cfg = { enabled: false, host: '', port: 0, username: '', password: '' };
      try {
        cfg = await paymentService.getNetopiaProxyConfig();
      } catch {
        /* default: proxy off → fall back */
      }
      const platformSupportsProxy =
        Platform.OS === 'android' || (Platform.OS === 'ios' && iosMajorVersion() >= 17);

      if (!cfg.enabled || !cfg.host || !cfg.port || !platformSupportsProxy) {
        return fallbackToBrowser(url, returnUrlBase, intentId);
      }

      // Prefer a SHORT-LIVED ephemeral credential (mint EF) so a leaked cred
      // isn't a standing tunnel; fall back to the static config cred if minting
      // fails (EF absent/disabled, not logged in, network).
      let host = cfg.host;
      let port = cfg.port;
      let user: string | null = cfg.username || null;
      let pass: string | null = cfg.password || null;
      try {
        const eph = await paymentService.mintNetopiaProxyCredential();
        if (eph?.username && eph.password) {
          host = eph.host || host;
          port = eph.port || port;
          user = eph.username;
          pass = eph.password;
        }
      } catch {
        /* keep the static cfg creds */
      }

      // Set the process-wide proxy BEFORE mounting the WebView so the very first
      // request goes through the tunnel (no un-proxied 403 flash). On iOS the
      // creds are applied to the ProxyConfiguration here; on Android
      // ProxyController has no creds API, so the WebView answers the proxy's 407
      // via the basicAuthCredential prop below (HTTP proxy → the 407 surfaces to
      // onReceivedHttpAuthRequest).
      try {
        await WebViewProxy.setProxyOverride(host, port, user, pass);
      } catch {
        // Could not set the proxy → don't load un-proxied (a flagged IP would
        // 403); fall back to the system browser instead.
        return fallbackToBrowser(url, returnUrlBase, intentId);
      }

      returnBaseRef.current = returnUrlBase;
      settledRef.current = false;
      return new Promise<Outcome>((resolve) => {
        resolverRef.current = resolve;
        setActive({ url, username: user ?? '', password: pass ?? '' });
      });
    },
    [fallbackToBrowser],
  );

  const isReturnUrl = useCallback((u: string): boolean => {
    if (!u) return false;
    return (
      (returnBaseRef.current.length > 0 && u.startsWith(returnBaseRef.current)) ||
      APP_SCHEMES.some((s) => u.startsWith(s))
    );
  }, []);

  // Primary interception: stop the WebView from actually loading the return
  // URL (it may be a custom scheme the WebView can't resolve) and settle.
  const onShouldStart = useCallback(
    (req: { url: string }): boolean => {
      if (isReturnUrl(req.url)) {
        settle('returned');
        return false;
      }
      return true;
    },
    [isReturnUrl, settle],
  );

  // Backup: some redirects only surface here.
  const onNav = useCallback(
    (nav: WebViewNavigation) => {
      if (isReturnUrl(nav.url)) settle('returned');
    },
    [isReturnUrl, settle],
  );

  const checkoutElement = active ? (
    <Modal
      visible
      animationType="slide"
      onRequestClose={() => settle('closed')}
      statusBarTranslucent
    >
      <View style={styles.root}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.title}>Pago seguro</Text>
            <Text style={styles.subtitle}>Procesado por NETOPIA · 3D-Secure</Text>
          </View>
          <TouchableOpacity
            onPress={() => settle('closed')}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="Cerrar"
          >
            <Text style={styles.close}>✕</Text>
          </TouchableOpacity>
        </View>
        <WebView
          source={{ uri: active.url }}
          style={styles.web}
          // Android can't carry proxy creds in ProxyController; this answers the
          // proxy's 407 (HTTP proxy → onReceivedHttpAuthRequest fires). iOS uses
          // the ProxyConfiguration creds instead, so only wire it on Android.
          basicAuthCredential={
            Platform.OS === 'android' && active.username
              ? { username: active.username, password: active.password }
              : undefined
          }
          onShouldStartLoadWithRequest={onShouldStart}
          onNavigationStateChange={onNav}
          startInLoadingState
          renderLoading={() => (
            <View style={styles.loading}>
              <ActivityIndicator size="large" color="#ff6a00" />
            </View>
          )}
          javaScriptEnabled
          domStorageEnabled
          setSupportMultipleWindows={false}
        />
      </View>
    </Modal>
  ) : null;

  return { present, checkoutElement };
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 56 : 16,
    paddingBottom: 12,
    backgroundColor: '#0a0a0a',
  },
  headerText: { flex: 1 },
  title: { color: '#fff', fontSize: 16, fontWeight: '700' },
  subtitle: { color: '#9aa0a6', fontSize: 12, marginTop: 2 },
  close: { color: '#fff', fontSize: 22, fontWeight: '600', paddingLeft: 12 },
  web: { flex: 1 },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
});
