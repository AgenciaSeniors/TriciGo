// Web: no-op. There is no WebView proxy on web; the web wallet recharge
// navigates the browser directly (apps/web), so this module is never used.
export default {
  async setProxyOverride(
    _host: string,
    _port: number,
    _username?: string | null,
    _password?: string | null,
  ): Promise<boolean> {
    return false;
  },
  async clearProxyOverride(): Promise<boolean> {
    return false;
  },
};
