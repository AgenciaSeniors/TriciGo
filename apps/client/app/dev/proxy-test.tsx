/**
 * DEV-ONLY spike screen — validates that an in-app react-native-webview routed
 * through the VPS CONNECT proxy (webview-proxy native module) loads NETOPIA's
 * hosted card page (and 3DS) from a reputation-flagged device IP, instead of
 * getting the Google Cloud Armor 403.
 *
 * Route: /dev/proxy-test  (not linked from the UI; navigate manually).
 *
 * How to use on a real (flagged) Android device:
 *  1. "Proxy OFF + Load"  → baseline: should show 403 Forbidden (flagged IP).
 *  2. "Proxy ON + Load"   → should load the real mobilpay portal (no 403).
 *  3. Paste a real `redirectUrl` from a recharge into the URL box + "Proxy ON
 *     + Load" → enter card + complete 3DS → watch the log for the return URL.
 *
 * NOTE: Android's ProxyController cannot send proxy credentials, so the squid
 * must be reachable WITHOUT Basic auth for this test (see plan / squid config).
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import WebViewProxy from '../../modules/webview-proxy';

const DEFAULT_PROXY_HOST = '187.77.214.236';
const DEFAULT_PROXY_PORT = '13128';
const DEFAULT_URL = 'https://secure.mobilpay.ro/ui/card';
// The recharge return URL prefix the WebView should detect to close + poll.
const RETURN_PREFIXES = ['https://tricigo.com/', 'tricigo://', 'tricigo-driver://'];

export default function ProxyTestScreen() {
  const [host, setHost] = useState(DEFAULT_PROXY_HOST);
  const [port, setPort] = useState(DEFAULT_PROXY_PORT);
  const [url, setUrl] = useState(DEFAULT_URL);
  const [webUrl, setWebUrl] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const proxyOn = useRef(false);

  const log = useCallback((line: string) => {
    const ts = new Date().toISOString().slice(11, 19);
    setLogs((prev) => [`${ts}  ${line}`, ...prev].slice(0, 200));
  }, []);

  const setProxy = useCallback(async () => {
    try {
      await WebViewProxy.setProxyOverride(host.trim(), parseInt(port, 10), null, null);
      proxyOn.current = true;
      log(`✅ proxy SET → ${host}:${port}`);
    } catch (e) {
      log(`❌ setProxyOverride failed: ${String((e as Error)?.message ?? e)}`);
    }
  }, [host, port, log]);

  const clearProxy = useCallback(async () => {
    try {
      await WebViewProxy.clearProxyOverride();
      proxyOn.current = false;
      log('✅ proxy CLEARED (direct)');
    } catch (e) {
      log(`❌ clearProxyOverride failed: ${String((e as Error)?.message ?? e)}`);
    }
  }, [log]);

  const loadWithProxy = useCallback(async () => {
    await setProxy();
    setWebUrl(null);
    setTimeout(() => setWebUrl(url.trim()), 50); // remount the WebView fresh
    log(`→ loading (proxy ON): ${url.trim()}`);
  }, [setProxy, url, log]);

  const loadDirect = useCallback(async () => {
    await clearProxy();
    setWebUrl(null);
    setTimeout(() => setWebUrl(url.trim()), 50);
    log(`→ loading (proxy OFF / direct): ${url.trim()}`);
  }, [clearProxy, url, log]);

  const onNav = useCallback(
    (nav: WebViewNavigation) => {
      log(`nav: ${nav.loading ? '⏳' : '✓'} ${nav.url}`);
      if (RETURN_PREFIXES.some((p) => nav.url.startsWith(p) && nav.url.includes('intent='))) {
        log(`🎯 RETURN URL detected → ${nav.url}`);
        setWebUrl(null);
        void clearProxy();
      }
    },
    [log, clearProxy],
  );

  return (
    <View style={styles.root}>
      <Text style={styles.title}>NETOPIA proxy spike</Text>

      <View style={styles.row}>
        <TextInput style={[styles.input, styles.flex2]} value={host} onChangeText={setHost} placeholder="proxy host" autoCapitalize="none" />
        <TextInput style={[styles.input, styles.flex1]} value={port} onChangeText={setPort} placeholder="port" keyboardType="number-pad" />
      </View>
      <TextInput style={styles.input} value={url} onChangeText={setUrl} placeholder="URL to load (paste a real redirectUrl to test 3DS)" autoCapitalize="none" autoCorrect={false} />

      <View style={styles.row}>
        <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={loadWithProxy}>
          <Text style={styles.btnText}>Proxy ON + Load</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.btn, styles.btnGray]} onPress={loadDirect}>
          <Text style={styles.btnText}>Proxy OFF + Load</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.row}>
        <TouchableOpacity style={[styles.btn, styles.btnGray]} onPress={clearProxy}>
          <Text style={styles.btnText}>Clear proxy</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.btn, styles.btnGray]} onPress={() => { setWebUrl(null); setLogs([]); }}>
          <Text style={styles.btnText}>Reset</Text>
        </TouchableOpacity>
      </View>

      {webUrl ? (
        <View style={styles.webWrap}>
          <WebView
            source={{ uri: webUrl }}
            style={styles.web}
            onNavigationStateChange={onNav}
            onError={(e) => log(`❌ onError: ${e.nativeEvent.code} ${e.nativeEvent.description}`)}
            onHttpError={(e) => log(`❌ onHttpError: HTTP ${e.nativeEvent.statusCode} ${e.nativeEvent.url}`)}
            onLoadEnd={() => log('onLoadEnd')}
            javaScriptEnabled
            domStorageEnabled
          />
        </View>
      ) : (
        <ScrollView style={styles.logWrap}>
          {logs.map((l, i) => (
            <Text key={i} style={styles.logLine}>{l}</Text>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 12, backgroundColor: '#0a0a0a', gap: 8 },
  title: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 4 },
  row: { flexDirection: 'row', gap: 8 },
  flex1: { flex: 1 },
  flex2: { flex: 2 },
  input: { backgroundColor: '#1c1c1e', color: '#fff', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13 },
  btn: { flex: 1, borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  btnPrimary: { backgroundColor: '#ff6a00' },
  btnGray: { backgroundColor: '#2c2c2e' },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  webWrap: { flex: 1, borderRadius: 8, overflow: 'hidden', marginTop: 4 },
  web: { flex: 1 },
  logWrap: { flex: 1, backgroundColor: '#000', borderRadius: 8, padding: 8, marginTop: 4 },
  logLine: { color: '#7CFC00', fontSize: 11, fontFamily: 'monospace', marginBottom: 2 },
});
