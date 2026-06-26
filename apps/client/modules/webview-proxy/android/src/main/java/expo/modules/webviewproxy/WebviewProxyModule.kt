package expo.modules.webviewproxy

import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executor

/**
 * webview-proxy (Android) — routes ALL WebView traffic through a forward
 * HTTP/CONNECT proxy via androidx.webkit ProxyController. Used to tunnel the
 * in-app payment WebView through our clean-IP VPS so NETOPIA's edge (which
 * 403s reputation-flagged client IPs, incl. Cuban ETECSA) sees the VPS IP.
 *
 * The proxy is a TLS-passthrough CONNECT tunnel (squid, no SSL-bump) → the
 * card data stays encrypted browser↔NETOPIA, the VPS never decrypts it.
 *
 * NOTE on auth: ProxyConfig/ProxyController have NO API to carry proxy
 * credentials, and the default RNCWebViewClient does not answer a 407
 * Proxy-Authentication challenge. So on Android the proxy must be reachable
 * WITHOUT Basic auth (secured instead by an obscure port + a NETOPIA-only
 * destination allowlist on the proxy). The username/password params are
 * accepted only for API parity with iOS (where ProxyConfiguration does carry
 * credentials) and are ignored here.
 *
 * setProxyOverride is PROCESS-WIDE for all WebViews in the app → call it right
 * before mounting the payment WebView and clearProxyOverride() right after.
 */
class WebviewProxyModule : Module() {
  // Run the ProxyController callbacks inline; we resolve the JS Promise from them.
  private val executor = Executor { it.run() }

  override fun definition() = ModuleDefinition {
    Name("WebviewProxy")

    AsyncFunction("setProxyOverride") { host: String, port: Int, _username: String?, _password: String?, promise: Promise ->
      if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
        promise.reject("E_PROXY_UNSUPPORTED", "WebView PROXY_OVERRIDE not supported on this device's WebView", null)
        return@AsyncFunction
      }
      try {
        // "host:port" with no scheme = an HTTP proxy; WebView issues CONNECT
        // for https targets. No addDirect() → we never fall back to the user's
        // (flagged) IP; if the proxy is down the load fails cleanly.
        val config = ProxyConfig.Builder()
          .addProxyRule("$host:$port")
          .build()
        ProxyController.getInstance().setProxyOverride(config, executor) {
          promise.resolve(true)
        }
      } catch (e: Exception) {
        promise.reject("E_PROXY_SET", e.message ?: "failed to set proxy override", e)
      }
    }

    AsyncFunction("clearProxyOverride") { promise: Promise ->
      if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
        promise.resolve(true)
        return@AsyncFunction
      }
      try {
        ProxyController.getInstance().clearProxyOverride(executor) {
          promise.resolve(true)
        }
      } catch (e: Exception) {
        promise.reject("E_PROXY_CLEAR", e.message ?: "failed to clear proxy override", e)
      }
    }
  }
}
