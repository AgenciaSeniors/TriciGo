import ExpoModulesCore
import Network
import WebKit

/**
 * webview-proxy (iOS) — routes WKWebView traffic through a forward CONNECT
 * proxy via WKWebsiteDataStore.proxyConfigurations (iOS 17+). Mirror of the
 * Android ProxyController module. TLS-passthrough tunnel → the VPS never sees
 * the card (stays SAQ-A).
 *
 * Set on WKWebsiteDataStore.default() — react-native-webview uses the default
 * data store unless `incognito` is set. iOS 17.0+ only; on <17 we reject so the
 * caller can fall back. Unlike Android, iOS ProxyConfiguration CAN carry
 * credentials (applyCredential), so the proxy may be authenticated on iOS.
 */
public class WebviewProxyModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WebviewProxy")

    AsyncFunction("setProxyOverride") { (host: String, port: Int, username: String?, password: String?, promise: Promise) in
      if #available(iOS 17.0, *) {
        // UInt16(exactly:) returns nil for out-of-range/negative ports, so a bad
        // port is REJECTED (→ caller falls back to the browser) instead of being
        // silently truncated to a wrong-but-valid port.
        guard let port16 = UInt16(exactly: port), let portValue = NWEndpoint.Port(rawValue: port16) else {
          promise.reject("E_PROXY_PORT", "invalid port \(port)")
          return
        }
        let endpoint = NWEndpoint.hostPort(host: NWEndpoint.Host(host), port: portValue)
        var proxyConfig = ProxyConfiguration(httpCONNECTProxy: endpoint)
        if let user = username, let pass = password, !user.isEmpty {
          proxyConfig.applyCredential(username: user, password: pass)
        }
        WKWebsiteDataStore.default().proxyConfigurations = [proxyConfig]
        promise.resolve(true)
      } else {
        promise.reject("E_PROXY_UNSUPPORTED", "WKWebsiteDataStore.proxyConfigurations requires iOS 17+")
      }
    }

    AsyncFunction("clearProxyOverride") { (promise: Promise) in
      if #available(iOS 17.0, *) {
        WKWebsiteDataStore.default().proxyConfigurations = []
      }
      promise.resolve(true)
    }
  }
}
