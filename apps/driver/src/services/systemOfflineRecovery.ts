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
 * Decision (2026-11-01): a driver the system took offline is reconnected with no time limit.
 * Anything a PERSON did is respected: an offline the driver made from another device, an admin's,
 * or a block clears `auto_offline_at` (tg_driver_profiles_shift_intent, admin_set_user_active),
 * and then the app just shows the driver offline. One attempt per drop: if the write goes through
 * but the server still has the same drop (a blocked account stays offline silently), the app shows
 * the driver offline instead of trying forever.
 *
 * In the background (2026-11-18): the drop is almost always a signal loss with the phone in the
 * pocket, so waiting for the next foreground left the driver offline until he opened the app, and
 * by then Android had often killed the process and he had to tap "Conectarme". Now the app also
 * reconnects in the background, but only while the background location service is running: that
 * service is what keeps sending heartbeats afterwards, and without it the driver would be dropped
 * again 10 min later. Only within BACKGROUND_RECONNECT_MAX_AGE_MS of the drop: hours later the
 * driver is more likely done for the day than out of coverage. A failed write in the background
 * does not end the shift (the network is flaky right after it comes back); after
 * BACKGROUND_RECONNECT_ATTEMPTS failures it waits for the foreground, where the one-attempt rule
 * above applies.
 *
 * It only acts while the app is on shift (driver.store keeps the shift through a system drop, see
 * shiftAfterServerRow), so a driver who tapped Desconectar, or killed the app to end the shift and
 * opens it the next day, is NOT put back online.
 */

export interface ServerOnlineState {
  is_online: boolean;
  /** Set by the cron when it took the driver offline; NULL after anything a person did. */
  auto_offline_at: string | null;
}

export type SystemOfflineAction = 'none' | 'reconnect' | 'defer' | 'show_offline';

/** Failed writes in the background before the recovery waits for the foreground. */
export const BACKGROUND_RECONNECT_ATTEMPTS = 3;

/**
 * How old a drop can be for the recovery to reconnect in the background. A signal loss on the
 * road lasts minutes to about an hour (prod: many drops came back 61-66 min later, just past the
 * server's 60-min restore). Past this, the driver is more likely done for the day (mobile data off
 * at home) than out of coverage, so the app waits for him to open it.
 */
export const BACKGROUND_RECONNECT_MAX_AGE_MS = 3 * 60 * 60_000;

export function decideSystemOffline(
  server: ServerOnlineState,
  ctx: {
    appActive: boolean;
    /** The background location service is running (it keeps the heartbeat going). */
    backgroundServiceRunning?: boolean;
    attempted: ReadonlySet<string>;
    /** Drops that failed BACKGROUND_RECONNECT_ATTEMPTS times in the background. */
    backgroundGaveUp?: ReadonlySet<string>;
    /** Now on the server's clock. Without it the background has no age limit. */
    nowMs?: number;
  },
): SystemOfflineAction {
  if (server.is_online) return 'none';
  if (!server.auto_offline_at) return 'show_offline';
  if (ctx.attempted.has(server.auto_offline_at)) return 'show_offline';
  if (ctx.appActive) return 'reconnect';
  if (
    ctx.backgroundServiceRunning &&
    !ctx.backgroundGaveUp?.has(server.auto_offline_at) &&
    withinBackgroundWindow(server.auto_offline_at, ctx.nowMs)
  ) {
    return 'reconnect';
  }
  return 'defer';
}

function withinBackgroundWindow(dropAt: string, nowMs: number | undefined): boolean {
  if (nowMs === undefined) return true;
  const dropMs = Date.parse(dropAt);
  if (Number.isNaN(dropMs)) return false;
  return nowMs - dropMs <= BACKGROUND_RECONNECT_MAX_AGE_MS;
}

interface ServerRow {
  is_online: boolean;
  auto_offline_at?: string | null;
  /** driver_profiles.status; a dropped driver keeps his shift only while approved. */
  status?: string;
}

/** The row says the cron took the driver offline, not a person. */
export function isSystemDrop(row: ServerRow | null | undefined): boolean {
  return !!row && row.is_online === false && !!row.auto_offline_at;
}

/**
 * The app's shift after a driver_profiles row from the server (realtime, profile reload).
 *
 * A row that says the SYSTEM took the driver offline does not end a shift the app is on. Every
 * heartbeat that reaches the server after the cron dropped the driver produces such a row (the
 * server restore is a second UPDATE in the same call), and ending the shift there made
 * useDriverLocation stop the background location service: the only thing that keeps the app
 * heartbeating with the screen off. The recovery decides what happens next and, when it cannot
 * reconnect, ends the shift itself (setOnline(false)).
 *
 * A shift never STARTS from such a row: a process whose first profile comes from the server and
 * says dropped stays offline. (A cold start that falls back to the offline profile cache in
 * useAuth starts from the cached row, which may say online; that predates this rule.)
 * A driver who is no longer approved (suspended, vehicle re-review) loses the shift even if the
 * system had dropped him first: going online would only fail.
 */
export function shiftAfterServerRow(onShift: boolean, row: ServerRow | null): boolean {
  if (!row) return false;
  if (row.is_online) return true;
  if (row.status !== undefined && row.status !== 'approved') return false;
  return onShift && isSystemDrop(row);
}

interface ShiftSnapshot {
  profile: (ServerRow & { id: string }) | null;
  isOnline: boolean;
}

/**
 * A driver_profiles row from the server that the recovery should look at: a new row for this
 * driver that says offline, while the app was (or still is) on shift. The driver's own toggle
 * only changes the shift, not the row, so it never triggers this.
 */
export function serverRowNeedsRecovery(
  state: ShiftSnapshot,
  prev: ShiftSnapshot,
  profileId: string | undefined,
): boolean {
  if (state.profile === prev.profile) return false;
  const row = state.profile;
  if (!row || row.id !== profileId || row.is_online) return false;
  return prev.isOnline || state.isOnline;
}

interface NetSnapshot {
  isConnected: boolean | null;
  isInternetReachable?: boolean | null;
}

function hasInternet(s: NetSnapshot): boolean {
  // isInternetReachable is null while NetInfo has not checked yet: count it as reachable, the
  // recovery reads the server first and does nothing if it cannot.
  return s.isConnected === true && s.isInternetReachable !== false;
}

/**
 * The network (or the internet over it) came back. In Cuba the phone often stays on the network
 * with no internet, so `isConnected` alone never changes: the reachability flip counts too.
 * The first reading (prev null) is not a change.
 */
export function internetCameBack(prev: NetSnapshot | null, next: NetSnapshot): boolean {
  if (!prev) return false;
  return !hasInternet(prev) && hasInternet(next);
}

/** Why the app shows the driver offline instead of reconnecting. */
export type OfflineReason = 'offline' | 'blocked' | 'failed';

export interface RecoveryDeps {
  /** Reads is_online + auto_offline_at from the server. null = could not read: do nothing. */
  fetchServerState(): Promise<ServerOnlineState | null>;
  /** Whether the app is in the foreground (AppState 'active'). */
  isAppActive(): boolean;
  /** Whether the background location service is running. Only asked in the background. */
  isBackgroundServiceRunning(): Promise<boolean>;
  /**
   * Whether the app is on shift (the store's isOnline). A driver who tapped Desconectar during a
   * system drop leaves auto_offline_at on the server (is_online was already false, so nothing
   * cleared it): the app's shift is what says he chose to stop.
   */
  isOnShift(): boolean;
  /** Now on the server's clock (auto_offline_at is server time; phones can be an hour off). */
  nowMs(): number;
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
  const backgroundFailures = new Map<string, number>();
  const backgroundGaveUp = new Set<string>();
  let pending = false;
  let running: Promise<SystemOfflineAction> | null = null;

  async function run(known?: ServerOnlineState): Promise<SystemOfflineAction> {
    const state = known ?? (await deps.fetchServerState());
    if (!state) return 'none';

    const appActive = deps.isAppActive();
    const drop = state.auto_offline_at;
    const mightReconnectInBackground =
      !appActive && !state.is_online && !!drop && !attempted.has(drop) && !backgroundGaveUp.has(drop);
    const backgroundServiceRunning = mightReconnectInBackground
      ? await deps.isBackgroundServiceRunning().catch(() => false)
      : false;

    const action = decideSystemOffline(state, {
      appActive,
      backgroundServiceRunning,
      attempted,
      backgroundGaveUp,
      nowMs: appActive ? undefined : deps.nowMs(),
    });
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
    // Never reconnect a driver who ended the shift (Desconectar).
    if (!deps.isOnShift()) return 'none';

    const dropAt = drop as string;
    const inBackground = !appActive;
    // On screen: one attempt per drop, counted before trying. In the background a failure is
    // retried (see below), so the attempt only counts once it went through.
    if (!inBackground) attempted.add(dropAt);
    const blocked = await deps.blockedReason();
    if (blocked) {
      attempted.add(dropAt);
      deps.onShownOffline('blocked', blocked);
      return 'show_offline';
    }
    try {
      await deps.goOnline();
    } catch (err) {
      if (inBackground) {
        const failures = (backgroundFailures.get(dropAt) ?? 0) + 1;
        backgroundFailures.set(dropAt, failures);
        if (failures >= BACKGROUND_RECONNECT_ATTEMPTS) backgroundGaveUp.add(dropAt);
        pending = true;
        return 'defer';
      }
      deps.onShownOffline('failed', err instanceof Error ? err.message : String(err));
      return 'show_offline';
    }
    attempted.add(dropAt);
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
    /** A drop seen in the background, waiting for the next foreground or retry. */
    hasPending(): boolean {
      return pending;
    },
    /**
     * Resolves once no run is in flight. The Desconectar toggle awaits it before its own write,
     * so a reconnect that was already writing can never land after the driver's choice.
     */
    async idle(): Promise<void> {
      while (running) {
        await running.catch(() => undefined);
      }
    },
  };
}
