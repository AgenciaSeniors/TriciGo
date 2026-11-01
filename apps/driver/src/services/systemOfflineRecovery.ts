/**
 * Bringing back a driver the SYSTEM took offline while the app still shows "En línea".
 *
 * The cron `auto_offline_stale_drivers` takes a driver offline when heartbeats stop for 10 min
 * (Android froze the JS, the phone lost signal) and marks it with `auto_offline_at`. The server
 * restores the driver on its own only when a heartbeat arrives within 60 min of that (00540).
 * Past that window the app never found out: it kept showing "En línea" and kept heartbeating while
 * the server had the driver offline, so no offers arrived. Measured in prod: 2–7 such drivers a
 * day, one for 5 hours straight on 2026-11-01.
 *
 * Decision (2026-11-01): with the app on screen, a driver the system took offline is reconnected
 * with no time limit. Anything a PERSON did is respected: an offline the driver made from another
 * device, an admin's, or a block clears `auto_offline_at` (tg_driver_profiles_shift_intent,
 * admin_set_user_active), and then the app just shows the driver offline. With the app in the
 * background it waits for the next foreground. One attempt per drop: if the write goes through but
 * the server still has the same drop (a blocked account stays offline silently), the app shows the
 * driver offline instead of trying forever.
 *
 * It only runs inside a process that saw the driver online, so a driver who killed the app to end
 * the shift and opens it the next day is NOT put back online.
 */

export interface ServerOnlineState {
  is_online: boolean;
  /** Set by the cron when it took the driver offline; NULL after anything a person did. */
  auto_offline_at: string | null;
}

export type SystemOfflineAction = 'none' | 'reconnect' | 'defer' | 'show_offline';

export function decideSystemOffline(
  server: ServerOnlineState,
  ctx: { appActive: boolean; attempted: ReadonlySet<string> },
): SystemOfflineAction {
  if (server.is_online) return 'none';
  if (!server.auto_offline_at) return 'show_offline';
  if (ctx.attempted.has(server.auto_offline_at)) return 'show_offline';
  return ctx.appActive ? 'reconnect' : 'defer';
}

/** Why the app shows the driver offline instead of reconnecting. */
export type OfflineReason = 'offline' | 'blocked' | 'failed';

export interface RecoveryDeps {
  /** Reads is_online + auto_offline_at from the server. null = could not read: do nothing. */
  fetchServerState(): Promise<ServerOnlineState | null>;
  /** Whether the app is in the foreground (AppState 'active'). */
  isAppActive(): boolean;
  /**
   * Something the driver must fix before going online (location permission, negative balance),
   * or null. Reconnecting past it would only fail or put an unusable driver in the matching.
   */
  blockedReason(): Promise<string | null>;
  /** Puts the driver online on the server and in the app. Throws when it cannot. */
  goOnline(): Promise<void>;
  onReconnected(): void;
  onShownOffline(reason: OfflineReason, detail?: string): void;
}

export function createSystemOfflineRecovery(deps: RecoveryDeps) {
  const attempted = new Set<string>();
  let pending = false;
  let running: Promise<SystemOfflineAction> | null = null;

  async function run(known?: ServerOnlineState): Promise<SystemOfflineAction> {
    const state = known ?? (await deps.fetchServerState());
    if (!state) return 'none';

    const action = decideSystemOffline(state, { appActive: deps.isAppActive(), attempted });
    if (action === 'defer') {
      pending = true;
      return action;
    }
    pending = false;
    if (action === 'none') return action;
    if (action === 'show_offline') {
      deps.onShownOffline('offline', undefined);
      return action;
    }

    attempted.add(state.auto_offline_at as string);
    const blocked = await deps.blockedReason();
    if (blocked) {
      deps.onShownOffline('blocked', blocked);
      return 'show_offline';
    }
    try {
      await deps.goOnline();
    } catch (err) {
      deps.onShownOffline('failed', err instanceof Error ? err.message : String(err));
      return 'show_offline';
    }
    deps.onReconnected();
    return 'reconnect';
  }

  return {
    /**
     * Looks at the server state (the one given, or a fresh read) and acts on it. Calls that
     * overlap share one run, so a heartbeat and a foreground event never reconnect twice.
     */
    evaluate(known?: ServerOnlineState): Promise<SystemOfflineAction> {
      if (running) return running;
      running = run(known).finally(() => {
        running = null;
      });
      return running;
    },
    /** A drop seen in the background, waiting for the next foreground. */
    hasPending(): boolean {
      return pending;
    },
  };
}
