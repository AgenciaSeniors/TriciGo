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
 *   await present({ url: redirectUrl, returnUrlBase: RETURN_URL_BASE, intentId, amountUsd });
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
 *
 * UI: a trust-forward dark checkout chrome (the WebView itself renders
 * NETOPIA's hosted card page, which we cannot restyle). Header conveys
 * security (shield + lock + "3-D Secure"), an optional amount chip shows the
 * recharge amount (the net the user selected; NETOPIA's page shows the total
 * incl. fee), a branded loading state covers the first load + the
 * 3-D Secure handoff, and a visible error/recovery state replaces the old
 * silent browser fallback. Colors/icons from @tricigo/theme + Ionicons.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import { paymentService } from '@tricigo/api';
import { colors } from '@tricigo/theme';
import { triggerHaptic } from '@tricigo/utils';
import WebViewProxy from '../../modules/webview-proxy';

type PresentArgs = {
  url: string;
  returnUrlBase: string;
  intentId: string;
  /** Optional: the recharge amount (net USD) to surface as a trust chip. */
  amountUsd?: number;
};
type Outcome = 'returned' | 'closed';

const APP_SCHEMES = ['tricigo://', 'tricigo-driver://'];

// Checkout chrome palette (dark, brand-aligned). Sourced from @tricigo/theme
// so it tracks the brand tokens (Go Orange #FF4D00, dark surfaces).
const PALETTE = {
  bg: '#0d0d1a',
  header: '#0a0a0a',
  orange: colors.brand.orange,
  orangeSoft: 'rgba(255,77,0,0.14)',
  orangeBorder: 'rgba(255,77,0,0.35)',
  textPrimary: '#f5f5f5',
  textSecondary: '#a0a0a0',
  textMuted: '#6b6b75',
  borderSubtle: 'rgba(255,255,255,0.07)',
  chipBg: 'rgba(255,255,255,0.06)',
  success: colors.success.DEFAULT,
  error: colors.error.DEFAULT,
  errorSoft: 'rgba(239,68,68,0.14)',
};

function iosMajorVersion(): number {
  if (Platform.OS !== 'ios') return 0;
  return parseInt(String(Platform.Version).split('.')[0] ?? '0', 10) || 0;
}

// USD with thousands separators (Hermes-safe — no Intl dependency). Keeps cents
// only when the amount isn't a whole dollar, so it never misrepresents the value.
function fmtUsd(n: number): string {
  const fixed = Number.isInteger(n) ? String(n) : n.toFixed(2);
  const dot = fixed.indexOf('.');
  const intPart = dot === -1 ? fixed : fixed.slice(0, dot);
  const decPart = dot === -1 ? '' : fixed.slice(dot + 1);
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${decPart ? `${grouped}.${decPart}` : grouped}`;
}

export function useNetopiaCheckout() {
  const [active, setActive] = useState<{
    url: string;
    username: string;
    password: string;
    amountUsd?: number;
  } | null>(null);
  // Presentational state for the checkout chrome (does not affect payment flow).
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [progress, setProgress] = useState(0);
  const webRef = useRef<WebView>(null);
  const insets = useSafeAreaInsets();
  const resolverRef = useRef<((o: Outcome) => void) | null>(null);
  const returnBaseRef = useRef<string>('');
  const argsRef = useRef<PresentArgs | null>(null);
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

  // Universal recovery: the proxied page failed to load (a proxy 407 the WebView
  // couldn't answer, squid down, TLS error, or a flagged-IP fallthrough). Don't
  // strand the user on a broken page — clear the proxy and retry THIS checkout
  // in the system browser, resolving present() with that outcome. The caller
  // still polls the intent afterwards (DB is the source of truth).
  const handleLoadFailure = useCallback(async () => {
    if (settledRef.current) return;
    settledRef.current = true;
    await WebViewProxy.clearProxyOverride().catch(() => {});
    setActive(null);
    const resolve = resolverRef.current;
    resolverRef.current = null;
    const args = argsRef.current;
    let outcome: Outcome = 'closed';
    if (args) {
      try {
        const dismissUrl = `${args.returnUrlBase}?intent=${encodeURIComponent(args.intentId)}`;
        const res = await WebBrowser.openAuthSessionAsync(args.url, dismissUrl);
        outcome = res.type === 'success' ? 'returned' : 'closed';
      } catch {
        /* swallow — the caller polls the intent regardless */
      }
    }
    resolve?.(outcome);
  }, []);

  const fallbackToBrowser = useCallback(
    async (url: string, returnUrlBase: string, intentId: string): Promise<Outcome> => {
      const dismissUrl = `${returnUrlBase}?intent=${encodeURIComponent(intentId)}`;
      const res = await WebBrowser.openAuthSessionAsync(url, dismissUrl);
      return res.type === 'success' ? 'returned' : 'closed';
    },
    [],
  );

  // Resolve the proxy config + mint the ephemeral token — the two slow,
  // EF-bound steps. Factored out so prewarm() can run them in parallel with the
  // recharge-intent creation, hiding their latency.
  const resolveProxyCreds = useCallback(async (): Promise<
    | { ok: false }
    | { ok: true; host: string; port: number; user: string | null; pass: string | null }
  > => {
    let cfg = { enabled: false, host: '', port: 0 };
    try {
      cfg = await paymentService.getNetopiaProxyConfig();
    } catch {
      /* default: proxy off → fall back */
    }
    const platformSupportsProxy =
      Platform.OS === 'android' || (Platform.OS === 'ios' && iosMajorVersion() >= 17);
    if (!cfg.enabled || !cfg.host || !cfg.port || !platformSupportsProxy) {
      return { ok: false };
    }
    // Auth creds come ONLY from the short-lived ephemeral mint EF (the static
    // platform_config cred was removed — it was client-readable). If minting
    // fails, proceed without creds; the WebView's onError recovers to the browser.
    let host = cfg.host;
    let port = cfg.port;
    let user: string | null = null;
    let pass: string | null = null;
    try {
      const eph = await paymentService.mintNetopiaProxyCredential();
      if (eph?.username && eph.password) {
        host = eph.host || host;
        port = eph.port || port;
        user = eph.username;
        pass = eph.password;
      }
    } catch {
      /* no creds → proceed; onError recovers if the proxy refuses */
    }
    return { ok: true, host, port, user, pass };
  }, []);

  // PERF: pre-resolve the proxy config + mint the token in the background so it
  // OVERLAPS createRechargeIntent (both are slow EF round-trips that otherwise
  // run back-to-back, ~1.5s wasted). Call sites kick this off via Promise.all
  // with the intent creation; present() then picks up the result and opens the
  // WebView without waiting on the mint. Never throws (a failed prewarm just
  // makes present() resolve it inline). Does NOT set the process-wide proxy
  // (that stays in present(), cleared by settle/unmount) so an abandoned prewarm
  // can't leak it.
  const prewarmRef = useRef<Awaited<ReturnType<typeof resolveProxyCreds>> | null>(null);
  const prewarm = useCallback(async () => {
    try {
      prewarmRef.current = await resolveProxyCreds();
    } catch {
      prewarmRef.current = null;
    }
  }, [resolveProxyCreds]);

  const present = useCallback(
    async ({ url, returnUrlBase, intentId, amountUsd }: PresentArgs): Promise<Outcome> => {
      // Use the prewarmed result if a call site kicked it off in parallel with
      // the intent creation; otherwise resolve it inline now.
      const setup = prewarmRef.current ?? (await resolveProxyCreds());
      prewarmRef.current = null;

      if (!setup.ok) {
        return fallbackToBrowser(url, returnUrlBase, intentId);
      }

      // Set the process-wide proxy BEFORE mounting the WebView so the first
      // request goes through the tunnel (no un-proxied 403 flash). iOS applies
      // the creds on the ProxyConfiguration here. On Android ProxyController has
      // no creds API, so the WebView answers the proxy 407 via the
      // basicAuthCredential prop below (device-verified to work, 2026-06-27).
      // If the tunnel still fails, onError on the WebView recovers to the browser.
      try {
        await WebViewProxy.setProxyOverride(setup.host, setup.port, setup.user, setup.pass);
      } catch {
        // Could not set the proxy → don't load un-proxied (a flagged IP would
        // 403); fall back to the system browser instead.
        return fallbackToBrowser(url, returnUrlBase, intentId);
      }

      returnBaseRef.current = returnUrlBase;
      argsRef.current = { url, returnUrlBase, intentId };
      settledRef.current = false;
      return new Promise<Outcome>((resolve) => {
        resolverRef.current = resolve;
        setLoading(true);
        setError(false);
        setProgress(0);
        setActive({ url, username: setup.user ?? '', password: setup.pass ?? '', amountUsd });
      });
    },
    [fallbackToBrowser, resolveProxyCreds],
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

  // Retry THIS checkout in-place (reload through the same proxy) after a load error.
  const retry = useCallback(() => {
    if (settledRef.current) return;
    triggerHaptic('light');
    setError(false);
    setLoading(true);
    setProgress(0);
    webRef.current?.reload();
  }, []);

  // Explicit "open in the system browser" recovery from the error state.
  const openInBrowser = useCallback(() => {
    void handleLoadFailure();
  }, [handleLoadFailure]);

  // Closing mid-payment (the page is up, the user may be entering their card)
  // should confirm; during loading/error there's nothing to lose, close directly.
  const requestClose = useCallback(() => {
    if (!loading && !error) {
      Alert.alert(
        'Cancelar el pago',
        'Si salís ahora, la recarga no se completará.',
        [
          { text: 'Seguir pagando', style: 'cancel' },
          { text: 'Cancelar pago', style: 'destructive', onPress: () => settle('closed') },
        ],
      );
    } else {
      settle('closed');
    }
  }, [loading, error, settle]);

  const checkoutElement = active ? (
    <Modal
      visible
      animationType="slide"
      onRequestClose={requestClose}
      statusBarTranslucent
    >
      <View style={styles.root}>
        {/* Header — trust anchor */}
        <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
          <View style={styles.brandRow}>
            <View style={styles.shieldBadge}>
              <Ionicons name="shield-checkmark" size={20} color={PALETTE.orange} />
            </View>
            <View style={styles.headerText}>
              <Text style={styles.title}>Pago seguro</Text>
              <View style={styles.subtitleRow}>
                <Ionicons name="lock-closed" size={11} color={PALETTE.textSecondary} />
                <Text style={styles.subtitle}>Protegido por NETOPIA · 3-D Secure</Text>
              </View>
            </View>
            <TouchableOpacity
              onPress={requestClose}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              accessibilityRole="button"
              accessibilityLabel="Cerrar pago"
              style={styles.closeBtn}
            >
              <Ionicons name="close" size={22} color={PALETTE.textPrimary} />
            </TouchableOpacity>
          </View>
          <View style={styles.trustStrip}>
            <View style={styles.trustItem}>
              <Ionicons name="lock-closed" size={12} color={PALETTE.success} />
              <Text style={styles.trustText}>Conexión cifrada</Text>
            </View>
            {typeof active.amountUsd === 'number' && active.amountUsd > 0 ? (
              <View style={styles.amountChip}>
                <Ionicons name="card" size={12} color={PALETTE.orange} />
                <Text style={styles.amountChipLabel}>Recarga</Text>
                <Text style={styles.amountChipValue}>{fmtUsd(active.amountUsd)}</Text>
              </View>
            ) : null}
          </View>
        </View>

        {/* In-page navigation progress (e.g. the 3-D Secure redirect) */}
        {!loading && !error && progress > 0 && progress < 1 ? (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
          </View>
        ) : null}

        {/* Payment WebView */}
        <View style={styles.webWrap}>
          <WebView
            ref={webRef}
            source={{ uri: active.url }}
            style={styles.web}
            // Android can't carry proxy creds in ProxyController; this answers
            // the proxy 407 via onReceivedHttpAuthRequest (device-verified to
            // work, 2026-06-27). iOS uses the ProxyConfiguration creds, so this
            // is only wired on Android.
            basicAuthCredential={
              Platform.OS === 'android' && active.username
                ? { username: active.username, password: active.password }
                : undefined
            }
            onShouldStartLoadWithRequest={onShouldStart}
            onNavigationStateChange={onNav}
            onLoadProgress={({ nativeEvent }) => setProgress(nativeEvent.progress)}
            onLoadEnd={() => setLoading(false)}
            // A failed main-frame load (proxy 407, squid down, TLS, flagged
            // fallthrough) → show the recovery state instead of a dead page.
            // Ignore explicit sub-frame failures (e.g. a 3-D Secure iframe
            // hiccup) so they don't take over a still-functional page. (Cast:
            // isMainFrame isn't in the RN type; absent → treated as main frame.)
            onError={({ nativeEvent }) => {
              if ((nativeEvent as { isMainFrame?: boolean }).isMainFrame === false) return;
              setLoading(false);
              setError(true);
            }}
            javaScriptEnabled
            domStorageEnabled
            setSupportMultipleWindows={false}
          />

          {/* Branded loading state (first load + 3-D Secure handoff) */}
          {loading && !error ? (
            <View
              style={styles.overlay}
              accessible
              accessibilityLabel="Conectando con el pago seguro"
            >
              <View style={styles.overlayCard}>
                <View style={styles.loaderRing}>
                  <Ionicons name="lock-closed" size={26} color={PALETTE.orange} />
                </View>
                <ActivityIndicator size="small" color={PALETTE.orange} style={styles.loaderSpinner} />
                <Text style={styles.overlayTitle}>Conectando con el pago seguro…</Text>
                <Text style={styles.overlaySub}>
                  Esto puede tardar unos segundos. No cierres esta pantalla.
                </Text>
              </View>
            </View>
          ) : null}

          {/* Visible error + recovery (replaces the old silent browser jump) */}
          {error ? (
            <View style={styles.overlay} accessibilityLiveRegion="polite" accessibilityRole="alert">
              <View style={styles.overlayCard}>
                <View style={styles.errIcon}>
                  <Ionicons name="cloud-offline-outline" size={30} color={PALETTE.error} />
                </View>
                <Text style={styles.overlayTitle}>No pudimos cargar el pago</Text>
                <Text style={styles.overlaySub}>
                  Revisá tu conexión a internet e intentá de nuevo.
                </Text>
                <TouchableOpacity
                  style={styles.primaryBtn}
                  onPress={retry}
                  accessibilityRole="button"
                  accessibilityLabel="Reintentar el pago"
                >
                  <Text style={styles.primaryBtnText}>Reintentar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.secondaryBtn}
                  onPress={openInBrowser}
                  accessibilityRole="button"
                  accessibilityLabel="Abrir el pago en el navegador"
                >
                  <Text style={styles.secondaryBtnText}>Abrir en el navegador</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}
        </View>

        {/* Footer trust line */}
        <View style={[styles.footer, { paddingBottom: insets.bottom + 10 }]}>
          <Ionicons name="shield-checkmark-outline" size={12} color={PALETTE.textMuted} />
          <Text style={styles.footerText}>Tus datos de tarjeta nunca pasan por TriciGo</Text>
        </View>
      </View>
    </Modal>
  ) : null;

  return { present, prewarm, checkoutElement };
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: PALETTE.bg },
  header: {
    backgroundColor: PALETTE.header,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PALETTE.borderSubtle,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center' },
  shieldBadge: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: PALETTE.orangeSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  headerText: { flex: 1 },
  title: { color: PALETTE.textPrimary, fontSize: 17, fontWeight: '700', letterSpacing: -0.2 },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', marginTop: 3, gap: 5 },
  subtitle: { color: PALETTE.textSecondary, fontSize: 12 },
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PALETTE.chipBg,
    marginLeft: 8,
  },
  trustStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
  },
  trustItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  trustText: { color: PALETTE.textSecondary, fontSize: 12, fontWeight: '500' },
  amountChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: PALETTE.orangeSoft,
    borderColor: PALETTE.orangeBorder,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  amountChipLabel: { color: PALETTE.textSecondary, fontSize: 11, fontWeight: '500' },
  amountChipValue: { color: PALETTE.orange, fontSize: 13, fontWeight: '800' },
  progressTrack: { height: 2.5, backgroundColor: PALETTE.borderSubtle },
  progressFill: { height: 2.5, backgroundColor: PALETTE.orange },
  webWrap: { flex: 1, backgroundColor: '#fff' },
  web: { flex: 1 },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PALETTE.bg,
    paddingHorizontal: 32,
  },
  overlayCard: { alignItems: 'center', maxWidth: 320 },
  loaderRing: {
    width: 64,
    height: 64,
    borderRadius: 20,
    backgroundColor: PALETTE.orangeSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loaderSpinner: { marginTop: 16 },
  errIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: PALETTE.errorSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlayTitle: {
    color: PALETTE.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 18,
  },
  overlaySub: {
    color: PALETTE.textSecondary,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 19,
  },
  primaryBtn: {
    backgroundColor: PALETTE.orange,
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 14,
    marginTop: 24,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
  },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  secondaryBtn: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    marginTop: 8,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  secondaryBtnText: { color: PALETTE.textSecondary, fontSize: 14, fontWeight: '600' },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: PALETTE.header,
    paddingTop: 10,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: PALETTE.borderSubtle,
  },
  footerText: { color: '#9a9a9a', fontSize: 12 },
});
