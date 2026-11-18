# Driver offer auto-open reach (option A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Android offer auto-open reach every driver: ask for the overlay permission again every 3 days, walk Xiaomi-family phones to their extra permission, and report to the server who has the permission and whether launches reach the front.

**Architecture:** Pure decision rules live in `@tricigo/utils` (`overlayPermission.ts`). The driver app gets three small modules: `overlayPrompt.ts` (alerts and storage), `offerLaunch.ts` (one launch per offer, a 4-second foreground watch, the report) and a status reporter called from `useReportAppOpen`. The server gets a lock table `driver_overlay_status` and a SECURITY DEFINER RPC `report_driver_overlay` (migration 00689). Everything on the device is JS, so it ships by OTA on runtime 1.8.0.

**Tech Stack:** Expo SDK 55 / React Native 0.83, `expo-device`, React Native `Linking.sendIntent`, AsyncStorage, vitest, Supabase Postgres 17 (rehearsed on local Postgres 16).

**Spec:** `docs/superpowers/specs/2026-11-18-driver-offer-autoopen-reach-design.md`

## Global Constraints

- JS only on the device: no change under `apps/driver/modules/`, `app.json` or any native file.
- Cooldown for each alert: 3 days (`OVERLAY_PROMPT_COOLDOWN_MS = 259_200_000`). Overlay and Xiaomi alerts each have their own key.
- Storage keys: `@tricigo/overlay_prompt_at:<userId>`, `@tricigo/xiaomi_prompt_at:<userId>`, `@tricigo/xiaomi_popup_ok:<userId>` (values: epoch ms as string; `'true'`). The old `@tricigo/overlay_prompt_shown` is no longer read.
- Xiaomi family: `manufacturer` or `brand` matches `/xiaomi|redmi|poco/i`.
- Xiaomi intent: action `miui.intent.action.APP_PERM_EDITOR`, extra `extra_pkgname` = `app.tricigo.driver`; fallback `Linking.openSettings()`.
- The Xiaomi flag is never cleared by a launch result.
- Launch watch: wait up to 4 000 ms for `AppState` `active`. Results: `foreground`, `not_foreground`, `no_permission`.
- One launch and one report per ride id within 60 000 ms; without a ride id, the 3 000 ms throttle.
- Status report: when the status changed since the last report, or `APP_OPEN_REPORT_INTERVAL_MS` (6 h) passed.
- Migration number 00689 (00686–00688 are reserved by sibling sessions). Re-check `origin/master` and open PRs before pushing.
- Migration rules (CLAUDE.md): RLS on and no policies, `REVOKE ALL` from `anon, authenticated`, GRANT to `service_role`, function SECURITY DEFINER with `SET search_path`, EXECUTE for `authenticated` and `service_role` only, md5 guard on re-run, end-state `DO $check$`.
- Copy: Spanish tuteo, neutral. New keys go in es/en/pt `driver.json` under `overlay`.
- Code, comments and commits in English; commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **`Linking.sendIntent` rejects** (HyperOS without the MIUI permission editor, or a non-MIUI ROM that reports Xiaomi): the driver must still land on a settings page. Test in Task 4: a rejected `sendIntent` calls `Linking.openSettings()`.
2. **`expo-device` missing or returning null** (old dev client, odd ROM): no crash, the phone is treated as non-Xiaomi. Test in Task 1 (`isXiaomiFamily(null, null)` is false) and Task 4 (`getDeviceMaker()` returns nulls when the require throws).
3. **A stored prompt time in the future** (the driver moved the phone's clock back): the alert must become due, not be silenced for days. Test in Task 1: `lastAt > now` counts as due.
4. **An offer arriving after the driver logged out** (the task fires, no session): the launch still happens; no report is sent and nothing throws. Test in Task 3.
5. **Migration not applied yet** (PGRST202): no crash, and the app stops calling until restart. Test in Task 2 (service maps it) and Task 3 (reporter stops after `'unavailable'`).

---

### Task 1: Decision rules in `@tricigo/utils`

**Files:**
- Create: `packages/utils/src/overlayPermission.ts`
- Modify: `packages/utils/src/index.ts` (export next to the `appOpen` exports, line ~125)
- Test: `packages/utils/src/__tests__/overlayPermission.test.ts`

**Interfaces:**
- Produces:
  - `export const OVERLAY_PROMPT_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;`
  - `export function isXiaomiFamily(manufacturer: string | null | undefined, brand: string | null | undefined): boolean`
  - `export interface OverlayStepInput { moduleAvailable: boolean; overlayGranted: boolean; xiaomiFamily: boolean; xiaomiOk: boolean; overlayPromptAt: number | null; xiaomiPromptAt: number | null; now: number; }`
  - `export type OverlayStep = 'none' | 'overlay' | 'xiaomi';`
  - `export function nextOverlayStep(input: OverlayStepInput): OverlayStep`
  - `export function isPromptDue(lastAt: number | null, now: number, cooldownMs?: number): boolean` (null → true; `lastAt > now` → true; else `now - lastAt >= cooldownMs`)

- [ ] **Step 1: Write the failing tests**

```ts
describe('isXiaomiFamily', () => {
  it.each([['Xiaomi', null], [null, 'Redmi'], ['xiaomi', 'POCO'], ['XIAOMI', 'redmi']])('%s/%s → true', (m, b) =>
    expect(isXiaomiFamily(m, b)).toBe(true));
  it.each([['samsung', 'samsung'], ['motorola', null], [null, null], ['', '']])('%s/%s → false', (m, b) =>
    expect(isXiaomiFamily(m, b)).toBe(false));
});

describe('isPromptDue', () => {
  const now = 1_000_000_000_000;
  it('is due when never shown', () => expect(isPromptDue(null, now)).toBe(true));
  it('is not due 1 ms before the cooldown', () => expect(isPromptDue(now - OVERLAY_PROMPT_COOLDOWN_MS + 1, now)).toBe(false));
  it('is due exactly at the cooldown', () => expect(isPromptDue(now - OVERLAY_PROMPT_COOLDOWN_MS, now)).toBe(true));
  it('is due when the stored time is in the future (clock moved back)', () => expect(isPromptDue(now + 60_000, now)).toBe(true));
});

describe('nextOverlayStep', () => {
  const now = 1_000_000_000_000;
  const base = { moduleAvailable: true, overlayGranted: false, xiaomiFamily: false, xiaomiOk: false, overlayPromptAt: null, xiaomiPromptAt: null, now };
  it('asks for the overlay when missing and due', () => expect(nextOverlayStep(base)).toBe('overlay'));
  it('says nothing without the native module', () => expect(nextOverlayStep({ ...base, moduleAvailable: false })).toBe('none'));
  it('respects the overlay cooldown', () => expect(nextOverlayStep({ ...base, overlayPromptAt: now - 1000 })).toBe('none'));
  it('says nothing to a granted non-Xiaomi phone', () => expect(nextOverlayStep({ ...base, overlayGranted: true })).toBe('none'));
  it('asks the Xiaomi step once the overlay is granted', () =>
    expect(nextOverlayStep({ ...base, overlayGranted: true, xiaomiFamily: true, overlayPromptAt: now - 1000 })).toBe('xiaomi'));
  it('the overlay cooldown does not hide the Xiaomi step', () =>
    expect(nextOverlayStep({ ...base, overlayGranted: true, xiaomiFamily: true, overlayPromptAt: now })).toBe('xiaomi'));
  it('respects the Xiaomi cooldown', () =>
    expect(nextOverlayStep({ ...base, overlayGranted: true, xiaomiFamily: true, xiaomiPromptAt: now - 1000 })).toBe('none'));
  it('stops for good once the Xiaomi step is done', () =>
    expect(nextOverlayStep({ ...base, overlayGranted: true, xiaomiFamily: true, xiaomiOk: true })).toBe('none'));
  it('never asks the Xiaomi step before the overlay is granted', () =>
    expect(nextOverlayStep({ ...base, xiaomiFamily: true, overlayPromptAt: now - 1000 })).toBe('none'));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/utils && npx vitest run src/__tests__/overlayPermission.test.ts`
Expected: FAIL, cannot resolve `../overlayPermission`.

- [ ] **Step 3: Implement the four exports in `packages/utils/src/overlayPermission.ts` and export them (and the two types) from `packages/utils/src/index.ts`**

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/utils && npx vitest run src/__tests__/overlayPermission.test.ts`
Expected: PASS, 21 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/utils/src/overlayPermission.ts packages/utils/src/index.ts packages/utils/src/__tests__/overlayPermission.test.ts
git commit -m "feat(utils): decide when to ask drivers for the overlay and Xiaomi permissions"
```

---

### Task 2: Server table, RPC and service (migration 00689)

**Files:**
- Create: `supabase/migrations/00689_driver_overlay_status.sql`
- Create: `supabase/tests/00689/run.sh` (copy the shape of `supabase/tests/00622/run.sh`, reuse `../00612/scaffold.sql`, which has `public.users` and `public.driver_profiles`)
- Modify: `packages/api/src/services/device.service.ts` (new method on `deviceService`)
- Test: `packages/api/src/services/__tests__/device.service.test.ts`

**Interfaces:**
- Produces (SQL):
  - Table `public.driver_overlay_status`: `user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE`, `device_id text NOT NULL CHECK (length BETWEEN 1 AND 128)`, `manufacturer text`, `brand text`, `os_version text`, `app_version text` (each `CHECK (length(...) <= 64)`), `module_available boolean NOT NULL`, `overlay_granted boolean NOT NULL`, `xiaomi_ok boolean NOT NULL DEFAULT false`, `launches_foreground int NOT NULL DEFAULT 0`, `launches_not_foreground int NOT NULL DEFAULT 0`, `launches_no_permission int NOT NULL DEFAULT 0`, `last_launch_result text CHECK (IN ('foreground','not_foreground','no_permission'))`, `last_launch_at timestamptz`, `first_reported_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()`, `PRIMARY KEY (user_id, device_id)`; index on `(updated_at DESC)`.
  - `public.report_driver_overlay(p_device_id text, p_manufacturer text, p_brand text, p_os_version text, p_app_version text, p_module_available boolean, p_overlay_granted boolean, p_xiaomi_ok boolean, p_launch_result text) RETURNS text` → `'recorded' | 'updated' | 'capped' | 'invalid'`. No session → `RAISE ... ERRCODE '42501'`. No `driver_profiles` row for `auth.uid()`, empty/over-long device id, or a launch result outside the three values → `'invalid'`. 20 installs per account cap. `p_launch_result` NULL updates status only; otherwise also bumps its counter and sets `last_launch_result`/`last_launch_at`. Text inputs `left(nullif(btrim(x), ''), 64)`.
- Produces (TS):
  - `export type DriverLaunchResult = 'foreground' | 'not_foreground' | 'no_permission';`
  - `export interface ReportDriverOverlayInput { device_id: string; manufacturer: string | null; brand: string | null; os_version: string | null; app_version: string | null; module_available: boolean; overlay_granted: boolean; xiaomi_ok: boolean; launch_result: DriverLaunchResult | null; }`
  - `export type ReportDriverOverlayOutcome = 'recorded' | 'updated' | 'capped' | 'invalid' | 'unavailable';`
  - `deviceService.reportDriverOverlay(input: ReportDriverOverlayInput): Promise<ReportDriverOverlayOutcome>` (PGRST202 or "could not find the function" → `'unavailable'`; other errors throw), all three exported from `@tricigo/api` like `ReportAppOpenInput`.

- [ ] **Step 1: Write the failing rehearsal `supabase/tests/00689/run.sh`**

Cases, each a `val`/`err` line in the 00622 style, run in both `prod` and `strict` privilege modes:
- R1 a driver (Beto in the scaffold has a `driver_profiles` row; check, else insert one in the runner's setup) reports status → `recorded`; a second report → `updated`; the row shows `module_available`, `overlay_granted`, `xiaomi_ok` as sent.
- R2 the same driver reports `foreground`, `foreground`, `not_foreground`, `no_permission` → counters `2|1|1`, `last_launch_result = no_permission`, `last_launch_at` set.
- R3 a non-driver account (Ana) → `invalid`, no row.
- R4 `p_launch_result = 'weird'` → `invalid`; empty device id → `invalid`; 129-char device id → `invalid`.
- R5 anon (`SET LOCAL ROLE anon`) calling the function → error `permission denied`; authenticated with no `sub` → `42501`.
- R6 21st install of one account → `capped`; an existing install still `updated`.
- R7 `anon` and `authenticated` cannot `SELECT`/`INSERT`/`UPDATE` the table; `service_role` can `INSERT`.
- R8 a 70-char manufacturer is stored as 64 chars.
- G1 applied twice → second apply `applied`; a CRLF copy (`sed 's/$/\r/'`) applies.
- N1 negative proof of the md5 guard: replace the function body with `SELECT 'x'` and re-apply → error `unexpected body`.
- N2 negative proof of the end-state check: add a policy on the table, re-apply → error `must have no policies`.

- [ ] **Step 2: Run it without the migration (RED)**

Run (cluster from CLAUDE.md § "En Windows, sin sandbox", binaries already at `C:/Users/Lucia Soler/AppData/Local/Temp/claude/687e2e6499a41ea4/dba17a78-c459-4919-be0e-21009420eb28/scratchpad/pgsql/bin`, own datadir in this session's scratchpad, a port not in `netstat -ano | grep LISTENING`):
`PGBIN=<bin> PGPORT=<port> PYTHON=python bash supabase/tests/00689/run.sh none`
Expected: every R case FAILs (function does not exist).

- [ ] **Step 3: Write `supabase/migrations/00689_driver_overlay_status.sql`**

Header in the 00622 style: WHY (the three findings from the spec, with the 2026-11-18 numbers), WHAT, the two queries from the spec's section 5. Then `SET lock_timeout = '5s'`, the table, RLS, REVOKE/GRANT, the md5 `$pre$` guard (allow NULL or the final body's md5), the function, `REVOKE ALL ... FROM PUBLIC, anon`, `GRANT EXECUTE ... TO authenticated, service_role`, and a `$check$` block asserting RLS on, no policies, no API-role table access, `service_role` INSERT, SECURITY DEFINER, EXECUTE only for signed-in users.

- [ ] **Step 4: Run the rehearsal with the migration (GREEN)**

Run: `PGBIN=<bin> PGPORT=<port> PYTHON=python bash supabase/tests/00689/run.sh supabase/migrations/00689_driver_overlay_status.sql`
Expected: every case PASS, final line with 0 failures. Then put the final body's md5 into the `$pre$` guard and rerun (still GREEN).

- [ ] **Step 5: Write the failing service tests in `device.service.test.ts`**

```ts
it('reports through report_driver_overlay with every argument', async () => {
  mockRpc.mockResolvedValueOnce({ data: 'recorded', error: null });
  await expect(deviceService.reportDriverOverlay(input)).resolves.toBe('recorded');
  expect(mockRpc).toHaveBeenCalledWith('report_driver_overlay', {
    p_device_id: 'dev-1', p_manufacturer: 'Xiaomi', p_brand: 'Redmi', p_os_version: '14', p_app_version: '1.8.0',
    p_module_available: true, p_overlay_granted: true, p_xiaomi_ok: false, p_launch_result: 'foreground',
  });
});
it('answers unavailable while the migration is missing (PGRST202)', ...) // resolves 'unavailable'
it('throws any other error', ...)                                          // rejects
```

- [ ] **Step 6: Run to verify they fail, implement `reportDriverOverlay` next to `reportAppOpen`, export the types from `packages/api/src/index.ts`, run to verify they pass**

Run: `cd packages/api && npx vitest run src/services/__tests__/device.service.test.ts`
Expected: FAIL first (`reportDriverOverlay is not a function`), PASS after.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/00689_driver_overlay_status.sql supabase/tests/00689 packages/api/src/services/device.service.ts packages/api/src/services/__tests__/device.service.test.ts packages/api/src/index.ts
git commit -m "feat(db): record which drivers can be auto-opened on an offer (00689)"
```

---

### Task 3: One launch per offer, its watch and its report

**Files:**
- Create: `apps/driver/src/lib/offerLaunch.ts`
- Create: `apps/driver/src/lib/overlayReport.ts` (status + launch reporting shared by Tasks 3 and 4)
- Modify: `apps/driver/src/lib/device.ts` (add `getDeviceMaker`)
- Modify: `apps/driver/src/tasks/rideOfferLaunchTask.ts` (export `extractRideId`; body calls `attemptOfferLaunch`)
- Modify: `apps/driver/src/hooks/useDriverRide.ts:585-642` (drop `lastForegroundLaunchRef`; call `attemptOfferLaunch(ride.id, 'realtime')` in place of the inline block)
- Test: `apps/driver/src/lib/__tests__/offerLaunch.test.ts`, `apps/driver/src/tasks/__tests__/rideOfferLaunchTask.test.ts`, `apps/driver/src/lib/__tests__/overlayReport.test.ts`

**Interfaces:**
- Consumes: `deviceService.reportDriverOverlay`, `DriverLaunchResult` (Task 2); `isXiaomiFamily` (Task 1).
- Produces:
  - `getDeviceMaker(): { manufacturer: string | null; brand: string | null }` in `device.ts` (lazy `require('expo-device')` in try/catch, like `getDeviceInfo`).
  - `XIAOMI_OK_KEY(userId: string): string` → `` `@tricigo/xiaomi_popup_ok:${userId}` `` in `overlayReport.ts`.
  - `reportOverlayLaunch(result: DriverLaunchResult): Promise<void>` and `reportOverlayStatus(userId: string): Promise<void>` in `overlayReport.ts`. Both read the session user from `useAuthStore.getState().user?.id` (status takes it as an argument), the device id from `getOrCreateDeviceId`, maker from `getDeviceMaker`, `app_version` from `Constants.expoConfig?.version`, the permission from `DriverOverlay.canDrawOverlays()`, the module from `isDriverOverlayAvailable`, and `xiaomi_ok` from AsyncStorage. No user → return without calling. Never throw. After an `'unavailable'` answer, every later call returns at once (module flag). `reportOverlayStatus` sends only if the tuple `(module_available, overlay_granted, xiaomi_ok)` changed since its last send for that user, or `APP_OPEN_REPORT_INTERVAL_MS` passed. `resetOverlayReportsForTests(): void`.
  - `attemptOfferLaunch(rideId: string | null, source: 'push' | 'realtime'): Promise<DriverLaunchResult | 'skipped'>` in `offerLaunch.ts`. Returns `'skipped'` when not Android, when `AppState.currentState === 'active'`, or when the same ride id was attempted in the last 60 000 ms (or any attempt in the last 3 000 ms with a null id). Otherwise: without `canDrawOverlays()` → report and return `no_permission`; else `bringAppToForeground()`, wait for `active` up to 4 000 ms, report the result; on `foreground` also `AsyncStorage.setItem(XIAOMI_OK_KEY(user), 'true')` when the phone is Xiaomi family and a user is signed in. `resetOfferLaunchForTests(): void`.
  - `extractRideId(raw: unknown): string | undefined` in `rideOfferLaunchTask.ts`, probing the same layouts as `extractNotificationType` for `ride_id`.

- [ ] **Step 1: Write the failing tests**

`offerLaunch.test.ts` mocks `react-native` (`Platform.OS`, `AppState.currentState`, `AppState.addEventListener` that stores the listener), the driver-overlay module, `../overlayReport` and AsyncStorage, and uses fake timers:

```ts
it('skips when the app is already in front', async () => { appState = 'active'; expect(await attemptOfferLaunch('r1', 'push')).toBe('skipped'); expect(bring).not.toHaveBeenCalled(); });
it('reports no_permission without the grant and does not launch', async () => { granted = false; expect(await attemptOfferLaunch('r1', 'push')).toBe('no_permission'); expect(bring).not.toHaveBeenCalled(); expect(reportLaunch).toHaveBeenCalledWith('no_permission'); });
it('resolves foreground when AppState turns active within 4 s', async () => { const p = attemptOfferLaunch('r1', 'push'); fireAppState('active'); expect(await p).toBe('foreground'); expect(reportLaunch).toHaveBeenCalledWith('foreground'); });
it('resolves not_foreground after 4 s', async () => { const p = attemptOfferLaunch('r1', 'push'); await vi.advanceTimersByTimeAsync(4000); expect(await p).toBe('not_foreground'); });
it('launches and reports once when push and realtime fire for the same ride', async () => { /* push then realtime 5 s later, both not_foreground */ expect(bring).toHaveBeenCalledTimes(1); expect(reportLaunch).toHaveBeenCalledTimes(1); });
it('launches again for the same ride after 60 s', ...);
it('throttles 3 s when no ride id is known', ...);
it('marks the Xiaomi step done after a foreground launch on a Xiaomi phone', async () => { maker = { manufacturer: 'Xiaomi', brand: 'Redmi' }; ... expect(setItem).toHaveBeenCalledWith('@tricigo/xiaomi_popup_ok:u1', 'true'); });
it('never clears the Xiaomi flag on not_foreground', async () => { ... expect(removeItem).not.toHaveBeenCalled(); expect(setItem).not.toHaveBeenCalledWith(expect.stringContaining('xiaomi_popup_ok'), expect.anything()); });
```

`rideOfferLaunchTask.test.ts`: `extractRideId` and `extractNotificationType` over three payload shapes — root `{ type, ride_id }`, `{ data: { body: JSON.stringify({ type, ride_id }) } }`, and `{ data: { dataString: JSON.stringify(...) } }` — plus `undefined` for non-objects and non-JSON strings. Mock `expo-task-manager` and `expo-notifications` so importing the module is side-effect free.

`overlayReport.test.ts`:

```ts
it('sends nothing when no driver is signed in', async () => { user = null; await reportOverlayLaunch('foreground'); expect(reportDriverOverlay).not.toHaveBeenCalled(); });
it('sends the launch with the status fields', ...);              // launch_result 'foreground', overlay_granted true, xiaomi_ok from storage
it('stops calling after the server answers unavailable', async () => { reportDriverOverlay.mockResolvedValueOnce('unavailable'); await reportOverlayLaunch('foreground'); await reportOverlayLaunch('foreground'); expect(reportDriverOverlay).toHaveBeenCalledTimes(1); });
it('swallows a thrown error', ...);                               // resolves undefined
it('status: sends once, then again only when the grant changes or 6 h pass', ...);
it('treats a missing expo-device as unknown maker', ...);         // getDeviceMaker() → { manufacturer: null, brand: null } when require throws
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/driver && npx vitest run src/lib src/tasks`
Expected: FAIL, modules and exports missing.

- [ ] **Step 3: Implement `getDeviceMaker`, `overlayReport.ts`, `offerLaunch.ts` and `extractRideId` with the signatures above**

The watch: subscribe to `AppState` `change`, resolve on `active`, `setTimeout(4000)` resolves `not_foreground`; always remove the subscription and clear the timer. `attemptOfferLaunch` records the ride id and time before calling `bringAppToForeground()`, so a second path arriving during the 4-second watch is skipped.

- [ ] **Step 4: Wire the two paths**

- `rideOfferLaunchTask.ts`: keep the `error`, platform and type checks; replace the AppState/throttle/permission/launch block with `await attemptOfferLaunch(extractRideId(data) ?? null, 'push')`. Remove `lastLaunchAt`. Update the header comment: the throttle and the report now live in `lib/offerLaunch.ts`.
- `useDriverRide.ts`: in the INSERT callback, replace the `if (Platform.OS === 'android' && ...) { ... bringAppToForeground(); }` block with `void attemptOfferLaunch(ride.id, 'realtime')`; delete `lastForegroundLaunchRef`. Keep the comment explaining why only Realtime INSERTs (not the 30 s poll) launch.

- [ ] **Step 5: Run to verify they pass, then the driver typecheck**

Run: `cd apps/driver && npx vitest run && npx tsc --noEmit -p .`
Expected: all tests PASS; tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/driver/src/lib apps/driver/src/tasks apps/driver/src/hooks/useDriverRide.ts
git commit -m "feat(driver): launch once per offer, watch whether it reached the front, and report it"
```

---

### Task 4: Ask again, the Xiaomi step, Ajustes and the status report

**Files:**
- Create: `apps/driver/src/lib/overlayPrompt.ts`
- Modify: `apps/driver/app/(tabs)/index.tsx:1071-1102` (replace the inline one-time prompt with `void maybePromptOverlay(userId, t)`)
- Modify: `apps/driver/app/profile/settings.tsx:614-634` (Xiaomi row under the overlay row)
- Modify: `apps/driver/src/hooks/useReportAppOpen.ts` (call `reportOverlayStatus(userId)` next to `reportAppOpen(userId)`, both on start and on `active`)
- Modify: `packages/i18n/src/locales/{es,en,pt}/driver.json` (`overlay` block)
- Test: `apps/driver/src/lib/__tests__/overlayPrompt.test.ts`

**Interfaces:**
- Consumes: `nextOverlayStep`, `isXiaomiFamily`, `OVERLAY_PROMPT_COOLDOWN_MS` (Task 1); `getDeviceMaker`, `XIAOMI_OK_KEY`, `reportOverlayStatus` (Task 3).
- Produces (all in `overlayPrompt.ts`):
  - `maybePromptOverlay(userId: string, t: TFunction): Promise<OverlayStep>`: reads the three keys, computes the step, shows the matching alert, writes its `*_prompt_at` key with `Date.now()` when shown, returns the step. Any storage error → `'none'`, no alert.
  - `openXiaomiPermissions(): Promise<void>`: `Linking.sendIntent('miui.intent.action.APP_PERM_EDITOR', [{ key: 'extra_pkgname', value: 'app.tricigo.driver' }])`, on rejection `Linking.openSettings()`, never throws.
  - The overlay alert's "Activar" opens `DriverOverlay.openOverlaySettings()` and arms a one-shot `AppState` listener: on the next `active`, if `canDrawOverlays()` is now true and the phone is Xiaomi family and the flag is not set, show the Xiaomi alert at once (and write its key).
  - Xiaomi alert buttons: "Abrir permisos" → `openXiaomiPermissions()`; "Ya lo activé" → `setItem(XIAOMI_OK_KEY(userId), 'true')` then `reportOverlayStatus(userId)`; "Ahora no" → nothing more.

Copy (es; en/pt translate it):

| Key | es |
|---|---|
| `overlay.xiaomi_title` | Un permiso más en tu Xiaomi |
| `overlay.xiaomi_body` | Para que TriciGo se abra sola, activa también «Mostrar ventanas emergentes mientras se ejecuta en segundo plano». Toca Abrir permisos y búscalo en la lista. |
| `overlay.xiaomi_open` | Abrir permisos |
| `overlay.xiaomi_done` | Ya lo activé |
| `overlay.settings_xiaomi_title` | Permiso extra de Xiaomi |
| `overlay.settings_xiaomi_sub` | Necesario en Xiaomi, Redmi y POCO para que la app se abra sola |

The existing `overlay.prompt_*` keys stay; `prompt_later` ("Ahora no") is reused by the Xiaomi alert.

- [ ] **Step 1: Write the failing tests in `overlayPrompt.test.ts`**

Mock `react-native` (`Alert.alert` capturing buttons, `Linking.sendIntent`, `Linking.openSettings`, `AppState`, `Platform.OS = 'android'`), AsyncStorage (in-memory map), the overlay module, `@/lib/device` and `@/lib/overlayReport`.

```ts
it('asks a driver who said "Ahora no" under the old forever flag', async () => { store.set('@tricigo/overlay_prompt_shown', '1'); expect(await maybePromptOverlay('u1', t)).toBe('overlay'); expect(Alert.alert).toHaveBeenCalledTimes(1); });
it('writes the overlay prompt time when shown, so it is quiet for 3 days', async () => { await maybePromptOverlay('u1', t); expect(await maybePromptOverlay('u1', t)).toBe('none'); });
it('asks the Xiaomi step on a granted Xiaomi phone', ...);              // returns 'xiaomi', title 'overlay.xiaomi_title'
it('"Ya lo activé" stores the flag and reports the status', ...);      // setItem('@tricigo/xiaomi_popup_ok:u1','true'), reportOverlayStatus('u1')
it('"Activar" chains the Xiaomi alert on return when now granted', ...); // press Activar, granted=true, fire 'active' → second Alert with xiaomi_title
it('opens the system app page when the MIUI intent is rejected', async () => { sendIntent.mockRejectedValueOnce(new Error('no activity')); await openXiaomiPermissions(); expect(openSettings).toHaveBeenCalled(); });
it('shows nothing and returns none when storage throws', ...);
it('shows nothing without the native module', ...);
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/driver && npx vitest run src/lib/__tests__/overlayPrompt.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement `overlayPrompt.ts`; wire `index.tsx`, `settings.tsx` and `useReportAppOpen.ts`; add the six keys to es/en/pt `driver.json`**

- `index.tsx`: keep the guard `newStatus && Platform.OS === 'android' && isDriverOverlayAvailable && user?.id` (`user` is `useAuthStore((s) => s.user)`, line 170), call `void maybePromptOverlay(user.id, t)`. Remove the `OVERLAY_PROMPT_KEY` block.
- `settings.tsx`: compute `xiaomi = isXiaomiFamily(...getDeviceMaker())` once; render a second `MenuRow` inside the same card when `xiaomi`, `icon="phone-portrait-outline"`, label/subtitle from the new keys, `onPress={() => void openXiaomiPermissions()}`.

- [ ] **Step 4: Run all driver tests, typecheck, and the shared guards**

Run: `cd apps/driver && npx vitest run && npx tsc --noEmit -p .`, then `cd packages/utils && npx vitest run src/__tests__/copyTuteo.test.ts`
Expected: all PASS, tsc exits 0, the tuteo guard passes with the new copy.

- [ ] **Step 5: Commit**

```bash
git add apps/driver/src/lib/overlayPrompt.ts apps/driver/src/lib/__tests__/overlayPrompt.test.ts "apps/driver/app/(tabs)/index.tsx" apps/driver/app/profile/settings.tsx apps/driver/src/hooks/useReportAppOpen.ts packages/i18n/src/locales
git commit -m "feat(driver): ask again for the overlay permission and walk Xiaomi phones to theirs"
```

---

### Task 5: Whole-branch verification and PR

- [ ] **Step 1: Full checks**

Run, from the worktree root, after `pnpm install --frozen-lockfile` if `node_modules` is missing:
- `pnpm --filter @tricigo/utils test`, `pnpm --filter @tricigo/api test`, `pnpm --filter @tricigo/driver test` → all PASS.
- `pnpm check-types` → exit 0.
- `git diff --stat origin/master...HEAD` → only the files named in Tasks 1–4, the spec and this plan.
- `git checkout HEAD -- pnpm-lock.yaml` if the install touched it.

- [ ] **Step 2: Re-check the migration number**

Run: `git fetch origin master && git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -5` and the open-PR scan from CLAUDE.md.
Expected: 00689 not taken; if it is, `git mv` to the next free number, update the header and `supabase/tests/<n>/`, rerun the rehearsal.

- [ ] **Step 3: Code review**

Use superpowers:requesting-code-review on the branch; fix what it finds with superpowers:receiving-code-review.

- [ ] **Step 4: Push and open the PR to `master`**

Body: what changes for drivers, the three findings with numbers, migration not applied (needs the user's OK, rehearsal in a rolled-back block first), OTA needed for the driver app on runtime 1.8.0 (needs the user's OK), the B1/C follow-ups, the tests run. End with the Claude Code line.

Do not apply the migration, merge or publish an OTA without the user's explicit OK in chat.
