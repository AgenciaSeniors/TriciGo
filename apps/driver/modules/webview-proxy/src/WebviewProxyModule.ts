import { NativeModule, requireOptionalNativeModule } from 'expo';

declare class WebviewProxyModule extends NativeModule<{}> {
  /**
   * Route ALL WebView traffic through the given CONNECT proxy.
   * Android: process-wide (set before mounting the WebView, clear after);
   * username/password are ignored (ProxyController has no creds API).
   * iOS 17+: applied to the default WKWebsiteDataStore; username/password used.
   * Rejects on unsupported WebView (Android) / iOS < 17.
   */
  setProxyOverride(
    host: string,
    port: number,
    username?: string | null,
    password?: string | null,
  ): Promise<boolean>;

  /** Remove the proxy override (back to direct). */
  clearProxyOverride(): Promise<boolean>;
}

// requireOptionalNativeModule returns null (instead of THROWING) when the native
// module isn't in the binary — e.g. a store build made before this local module
// existed, or a JS↔native/OTA mismatch (runtimeVersion 'appVersion' ships newer
// JS to older binaries). The throw at import propagated through NetopiaCheckout →
// the wallet route → expo-router's fromImport, crashing the recharge screen on
// open (mirror of the client build-16 rejection 2.1(a)). Falling back to a
// no-proxy stub keeps the route loadable; useNetopiaCheckout takes its WebBrowser
// path.
const nativeWebviewProxy = requireOptionalNativeModule<WebviewProxyModule>('WebviewProxy');

// Stub used only when the native module is absent. setProxyOverride REJECTS so
// useNetopiaCheckout.present() takes its browser fallback instead of loading an
// un-proxied page (a flagged Cuban IP would get NETOPIA's 403). clearProxyOverride
// is a no-op (callers already wrap it in .catch(() => {})).
const fallbackWebviewProxy = {
  setProxyOverride(): Promise<boolean> {
    return Promise.reject(new Error('WebviewProxy native module unavailable'));
  },
  clearProxyOverride(): Promise<boolean> {
    return Promise.resolve(false);
  },
};

export default nativeWebviewProxy ?? fallbackWebviewProxy;
