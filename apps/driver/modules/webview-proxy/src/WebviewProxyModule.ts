import { NativeModule, requireNativeModule } from 'expo';

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

export default requireNativeModule<WebviewProxyModule>('WebviewProxy');
