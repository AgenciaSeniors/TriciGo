import { describe, it, expect, beforeEach } from 'vitest';
import type { DriverProfile } from '@tricigo/types';
import { useDriverStore } from '../driver.store';

/**
 * The store's `isOnline` is the app's shift: it decides whether the background
 * location service runs (useDriverLocation stops it on the online -> offline
 * edge). A row from the server must not end the shift when it only says the
 * SYSTEM took the driver offline (auto_offline_at set): that is the row every
 * heartbeat produces when the signal comes back after the cron dropped the
 * driver, and ending the shift there killed the one service that keeps the app
 * heartbeating with the screen off. The recovery (services/systemOfflineRecovery)
 * decides what happens next.
 */

function row(over: Partial<DriverProfile> & { auto_offline_at?: string | null }): DriverProfile {
  return {
    id: 'driver-1',
    user_id: 'user-1',
    is_online: true,
    auto_offline_at: null,
    ...over,
  } as DriverProfile;
}

const SYSTEM_DROP = row({ is_online: false, auto_offline_at: '2026-11-17T22:35:00.408963+00:00' });
const PERSON_OFF = row({ is_online: false, auto_offline_at: null });
const ONLINE_ROW = row({ is_online: true, auto_offline_at: null });

describe('driver store: the shift survives a system drop', () => {
  beforeEach(() => {
    useDriverStore.getState().reset();
  });

  it('keeps an on-shift app on shift when the server row says the system took it offline', () => {
    useDriverStore.getState().setProfile(ONLINE_ROW);
    expect(useDriverStore.getState().isOnline).toBe(true);

    useDriverStore.getState().setProfile(SYSTEM_DROP);

    expect(useDriverStore.getState().isOnline).toBe(true);
    // The row itself is stored as it came: the recovery reads it.
    expect(useDriverStore.getState().profile).toBe(SYSTEM_DROP);
  });

  it('ends the shift when a person took the driver offline (another device, an admin)', () => {
    useDriverStore.getState().setProfile(ONLINE_ROW);
    useDriverStore.getState().setProfile(PERSON_OFF);
    expect(useDriverStore.getState().isOnline).toBe(false);
  });

  it('never starts a shift from a system drop: a fresh app that loads it stays offline', () => {
    useDriverStore.getState().setProfile(SYSTEM_DROP);
    expect(useDriverStore.getState().isOnline).toBe(false);
  });

  it('follows the server when it says online', () => {
    useDriverStore.getState().setProfile(PERSON_OFF);
    useDriverStore.getState().setProfile(ONLINE_ROW);
    expect(useDriverStore.getState().isOnline).toBe(true);
  });

  it('the server restore arrives as two rows (heartbeat, then is_online); the shift never drops in between', () => {
    useDriverStore.getState().setProfile(ONLINE_ROW);
    const seen: boolean[] = [];
    const unsub = useDriverStore.subscribe((s) => seen.push(s.isOnline));
    useDriverStore.getState().setProfile(SYSTEM_DROP); // UPDATE last_heartbeat_at
    useDriverStore.getState().setProfile(ONLINE_ROW); // UPDATE is_online = true
    unsub();
    expect(seen).toEqual([true, true]);
  });

  it('setOnline(false) ends the shift whatever the profile says (the toggle, or the recovery giving up)', () => {
    useDriverStore.getState().setProfile(ONLINE_ROW);
    useDriverStore.getState().setProfile(SYSTEM_DROP);
    useDriverStore.getState().setOnline(false);
    expect(useDriverStore.getState().isOnline).toBe(false);

    // Once off, a later system-drop row does not bring the shift back.
    useDriverStore.getState().setProfile({ ...SYSTEM_DROP });
    expect(useDriverStore.getState().isOnline).toBe(false);
  });

  it('a null profile is never on shift', () => {
    useDriverStore.getState().setProfile(ONLINE_ROW);
    useDriverStore.getState().setProfile(null);
    expect(useDriverStore.getState().isOnline).toBe(false);
  });
});
