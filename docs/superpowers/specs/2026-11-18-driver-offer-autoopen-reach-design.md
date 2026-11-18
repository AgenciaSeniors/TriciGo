# Driver offer auto-open: reach every Android driver (option A)

Date: 2026-11-18. Status: draft for approval.

## Intent

A driver asked, in a voice note, for the driver app to come to the front by itself when a
ride offer arrives, "like the other apps in Cuba do". Drivers who are not holding the phone
then find the offer on screen when they pick it up, and they take rides faster when there
are many.

The Android app already does this (PR #807, PR #817, July 2026). When an offer arrives,
`send-push` sends a second, data-only push that wakes `rideOfferLaunchTask`, which calls
`DriverOverlay.bringAppToForeground()`. The Realtime path in `useDriverRide` does the same
as a backup. Android only allows that background launch when the driver granted
"Display over other apps" (`SYSTEM_ALERT_WINDOW`). The server side works: on 2026-11-17 the
`send-push` logs show `launch_sent=1/1` on almost every offer to an Android phone.

It does not reach most drivers, for three reasons found on 2026-11-18:

1. The app asks for the permission once. The first time a driver goes online without it, an
   alert offers "Activar" or "Ahora no", and either answer sets
   `@tricigo/overlay_prompt_shown` forever. A driver who tapped "Ahora no" is never asked
   again. The only other way in is a row in Ajustes.
2. Xiaomi, Redmi and POCO phones add a second permission of their own, "Mostrar ventanas
   emergentes mientras se ejecuta en segundo plano". It is off by default, Android's
   `canDrawOverlays()` does not report it, and without it the system drops the launch with
   no error. 57 of the 185 approved Android drivers with a known model (31 %) use one of
   these phones. Samsung is 79 (43 %), Tecno/Infinix/itel 17, Motorola 9, others 23.
3. Nobody knows how many drivers have the permission or whether the launch works on their
   phone. The app reports nothing about it.

Offers are the reason this matters: in the 30 days to 2026-11-18, 145 of the 250 offers sent
to Android drivers expired unanswered.

## Goals

- Every Android driver without the permission is asked again, at the moment it matters
  (going online), until they grant it, without nagging on every tap.
- Drivers on Xiaomi, Redmi and POCO are taken to the screen of the second permission.
- The server can answer: how many online Android drivers have the permission, by phone
  brand, and whether the launch brings the app to the front on their phones.
- Ships to the installed 1.8.0 app as an OTA update, with no new native build.

## Non-goals

- Showing the offer over the lock screen or turning the screen on (option B1). Needs native
  changes and a store build. Next phase.
- A full-screen notification like an incoming call (option B2). Google Play does not grant
  it by default to ride-hailing apps; declaring it risks a rejected release. Dropped.
- iPhone. Apple does not let an app open itself. The time-sensitive alert (option C) needs an
  iOS build. Next phase.
- Other brands' extra permissions (Tecno/Infinix "autostart", Oppo/Vivo pop-ups). The
  measurement will show whether they block the launch; handle them in a later change if so.

## Anti-goals (a failure even if it works)

- A prompt on every "Conectarme" tap. Drivers connect several times a day.
- Blocking or delaying going online. The prompt stays after the online switch succeeds, as
  today.
- A button that does nothing. On a binary without the native module (old APK + OTA JS),
  `isDriverOverlayAvailable` is false and no invitation is shown, as today.
- Reporting telemetry so often that it costs the driver data. Cuban mobile data is
  expensive.

## Constraints

- OTA only: everything in this change must be JS. The installed 1.8.0 binary has the
  `DriverOverlay` module (`canDrawOverlays`, `openOverlaySettings`,
  `bringAppToForeground`), React Native's `Linking.sendIntent` and `Linking.openSettings`,
  and `expo-device` (`Device.manufacturer`, `Device.brand`).
- `canDrawOverlays()` is the only permission the app can read. There is no public API for
  the Xiaomi permission. Reading it needs an `AppOpsManager` call through reflection with an
  undocumented op code (10021), that is native code, so it is out of this change.
- The migration follows CLAUDE.md: lock table with RLS and no policies, explicit GRANTs with
  `service_role`, a SECURITY DEFINER function callable by `authenticated` only, md5 guard on
  re-runs, and an end-state check. The app tolerates the function being absent (PGRST202):
  it stops reporting until the next restart.
- Migration number 00689. 00686, 00687 and 00688 are reserved by the sibling sessions
  working on priorities 1 to 3; re-check `origin/master` and open PRs before pushing.

## Approaches considered

| Approach | Trade-off | Decision |
|---|---|---|
| **A. Make the existing launch reach every Android driver: re-ask, Xiaomi step, measure** | JS only, ships by OTA, no store risk. Cannot verify the Xiaomi permission directly; uses evidence and the driver's word. | **Chosen now** |
| B1. Show the offer over the lock screen and turn the screen on | Same permission, but native changes to `MainActivity` (show-when-locked, turn-screen-on): needs a store build and a test on a real phone. | Next phase, with C |
| B2. Full-screen intent, like an incoming call | Play grants it by default only to calling and alarm apps; drivers would enable it by hand, and declaring it risks rejection. | Dropped |
| C. iPhone time-sensitive alert with a longer sound | Breaks through Focus and stays first on the lock screen; does not open the app. Needs an iOS build (entitlement) and `interruptionLevel` from `send-push`. | Next phase, with B1 |

The user chose "A now, B1 and C later" on 2026-11-18.

## Design

### 1. Ask again, at most every 3 days (my call)

When the driver goes online on Android, the module is in the binary and `canDrawOverlays()`
is false, show the same alert as today ("No te pierdas ningún viaje" / "Activar" /
"Ahora no"), unless it was shown in the last 3 days. Both buttons record the time the
alert was shown. The old forever flag `@tricigo/overlay_prompt_shown` is ignored, so drivers
who said "Ahora no" months ago are asked once more. The new key is
`@tricigo/overlay_prompt_at:<userId>` (epoch ms).

Why 3 days: often enough that a driver who said "Ahora no" on a busy day gets another
chance that week; rare enough that a driver who never wants it is asked about twice a week.

### 2. The Xiaomi step (my call on wording and frequency)

Xiaomi family = `Device.manufacturer` or `Device.brand` matches `xiaomi`, `redmi` or `poco`,
case-insensitive. On those phones, once `canDrawOverlays()` is true (now, or when the driver
comes back from the system screen), show a second alert when they go online:

- Title: "Un permiso más en tu Xiaomi".
- Body: "Para que TriciGo se abra sola, activa también «Mostrar ventanas emergentes mientras
  se ejecuta en segundo plano». Toca Abrir permisos y búscalo en la lista."
- Buttons: "Abrir permisos", "Ya lo activé", "Ahora no".

"Abrir permisos" calls `Linking.sendIntent('miui.intent.action.APP_PERM_EDITOR',
[{ key: 'extra_pkgname', value: 'app.tricigo.driver' }])`; if that rejects, it falls back to
`Linking.openSettings()` (the app's system page).

When it appears (my call):

- **Right after the first permission.** When the driver tapped "Activar" on the step-1 alert
  and comes back to the app with `canDrawOverlays()` now true, the Xiaomi alert shows at
  once, outside the go-online handler: that is the moment they are already in the settings
  flow. This is the only place an AppState listener is added for it, armed by the "Activar"
  tap and disarmed after one return.
- **Otherwise, when going online**, with its own 3-day cooldown key,
  `@tricigo/xiaomi_prompt_at:<userId>`. Steps 1 and 2 never share a cooldown, so tapping
  "Activar" today does not hide the Xiaomi step for 3 days.

It stops for good when one of these happens:

- the driver taps "Ya lo activé";
- the app sees a launch succeed on this phone (section 4).

Either one sets `@tricigo/xiaomi_popup_ok:<userId>` to `true`. **The flag is never cleared
by launch results** (my call). `not_foreground` is ambiguous: the target driver keeps the
phone in a pocket with the screen off, so a launch that works can still look like a miss.
Clearing on misses would bring the alert back to drivers who did enable it, against the
no-nagging anti-goal. A driver who tapped "Ya lo activé" by mistake still has the Ajustes
row, and the server data shows by brand whether launches reach the front.

The Ajustes row for "Mostrar sobre otras apps" gets a sibling row on Xiaomi phones,
"Permiso extra de Xiaomi", that opens the same screen.

### 3. One place for the rules

The decisions are pure functions in `packages/utils/src/overlayPermission.ts`, with tests:

- `isXiaomiFamily(manufacturer, brand)`;
- `nextOverlayStep({ moduleAvailable, overlayGranted, xiaomiFamily, xiaomiOk,
  overlayPromptAt, xiaomiPromptAt, now })` returns `'none' | 'overlay' | 'xiaomi'`, each
  step checked against its own cooldown;
- `OVERLAY_PROMPT_COOLDOWN_MS = 3 days`.

`apps/driver/app/(tabs)/index.tsx` replaces its inline block with a small helper,
`maybePromptOverlay(userId)` in `apps/driver/src/lib/overlayPrompt.ts`, which reads storage,
calls `nextOverlayStep` and shows the alert.

### 4. Seeing whether a launch worked

After each `bringAppToForeground()` call (the push task and the Realtime path), wait up to
4 seconds for `AppState` to become `active`.

- If it does, the result is `foreground`.
- If not, the result is `not_foreground`.
- If the call was skipped because `canDrawOverlays()` was false, the result is
  `no_permission`.

`not_foreground` is ambiguous. The launch may have been blocked (the Xiaomi case), or the
screen may have been off, so the app opened behind the lock screen and only becomes active
when the driver unlocks. Read it by brand and in aggregate, not as proof for one phone.
`foreground` is unambiguous, so it can set the Xiaomi flag.

**One attempt per offer** (my call). For one offer, both the push task and the Realtime path
can fire, a few seconds apart. When a launch fails, the app is still in the background when
the second path runs, so each path would report its own miss, counting failures twice and
successes once. Both paths go through one shared helper,
`attemptOfferLaunch(rideId, source)` in `apps/driver/src/lib/offerLaunch.ts`. It launches
and reports at most once per ride id within 60 seconds, and falls back to the existing
3-second throttle when no ride id is known. The data-only push carries `ride_id` (it is in
`notify_driver_new_offer`'s `data`), and the Realtime callback has the ride. This replaces
the two separate throttles (the task's module variable and the hook's ref). The other launch
conditions stay as they are: Android, app not active, permission granted.

### 5. Reporting to the server

New lock table `public.driver_overlay_status`, one row per account and install:

| Column | Meaning |
|---|---|
| `user_id`, `device_id` | primary key; `device_id` is the per-install id from `getOrCreateDeviceId` |
| `manufacturer`, `brand`, `os_version`, `app_version` | text, ≤ 64 |
| `module_available` | the native module is in the binary |
| `overlay_granted` | `canDrawOverlays()` at the last report |
| `xiaomi_ok` | the driver confirmed, or a launch was seen to succeed |
| `launches_foreground`, `launches_not_foreground`, `launches_no_permission` | counters |
| `last_launch_result`, `last_launch_at` | the latest attempt |
| `first_reported_at`, `updated_at` | timestamps |

RPC `report_driver_overlay(p_device_id, p_manufacturer, p_brand, p_os_version,
p_app_version, p_module_available, p_overlay_granted, p_xiaomi_ok, p_launch_result)`:

- signed-in accounts that have a `driver_profiles` row, whatever their status or role
  (my call): admins and operators who also drive are counted, and a pending applicant who
  opens the app is too. Anyone else gets `'invalid'`, and anon gets 42501;
- `p_launch_result` is `NULL` for a plain status report and bumps one counter otherwise;
- returns `'recorded' | 'updated' | 'capped' | 'invalid'`;
- caps an account at 20 installs, like 00622.

The app reports in two cases:

- **Status:** when the app comes to the foreground with a session, if the status changed or
  6 hours passed since the last report.
- **Launch:** after every launch attempt. That is one call per offer received in the
  background, and offers run under 10 a day per driver.

Errors are logged and swallowed. `PGRST202` stops reporting until the next restart.

The queries this unlocks, written into the migration's header:

```sql
-- Android drivers who reported in the last 14 days: with the permission, by brand
SELECT lower(coalesce(brand, manufacturer)) AS brand, count(*) AS installs,
       count(*) FILTER (WHERE overlay_granted) AS granted
FROM public.driver_overlay_status
WHERE updated_at > now() - interval '14 days' AND module_available
GROUP BY 1 ORDER BY 2 DESC;

-- Do launches reach the front, by brand
SELECT lower(coalesce(brand, manufacturer)) AS brand,
       sum(launches_foreground) AS ok, sum(launches_not_foreground) AS not_seen,
       sum(launches_no_permission) AS no_permission
FROM public.driver_overlay_status GROUP BY 1 ORDER BY 2 DESC;
```

### 6. What is not touched

- `send-push`, the data-only push, the background task's wake-up, the bubble.
- The two launch paths keep their conditions; they only call the shared helper of section 4.

## Tests

- `packages/utils`: `isXiaomiFamily` (Xiaomi, Redmi, POCO, mixed case, Samsung, null), and
  `nextOverlayStep` over the cooldown edges, a missing module, a granted permission with and
  without the Xiaomi flag, and iOS-like input.
- `packages/api`: `driverOverlayService.report` sends the RPC arguments, maps `PGRST202` to
  `'unavailable'` and never throws.
- `apps/driver`: `attemptOfferLaunch` resolves `foreground` on an `active` event and
  `not_foreground` after the timeout (fake timers), reports `no_permission` when the
  permission is missing, and launches and reports once when both paths fire for the same
  ride. `extractNotificationType` and a new `extractRideId` get tests too: the task has none
  today.
- SQL: `supabase/tests/00689/run.sh`, same shape as other migration rehearsals:
  - RED without the migration, GREEN applied twice, plus a CRLF copy;
  - anon gets 42501;
  - a non-driver gets `invalid`;
  - counters increment;
  - the cap holds;
  - API roles have no table access;
  - negative tests for each end-state check.
- On the emulator, if time allows: a Xiaomi build cannot be emulated, but the alert flow and
  the report can (`adb_ui.py`).

## Delivery

1. PR to `master` with the migration file, the JS and the tests.
2. With the user's OK: apply 00689 in prod (rehearsal in a rolled-back block first), merge,
   publish the OTA for the driver app (runtime 1.8.0).
3. One week after, read the table and decide B1, C and other brands with numbers.

## Left to the builder

- Exact Spanish copy of the Ajustes row and the alerts, keeping the tone above. Add the new
  keys to es/en/pt `driver.json`, since they are user copy, not a11y labels.
- Where the watcher lives (a small module shared by the task and `useDriverRide`).
- Whether the status report piggybacks on `useReportAppOpen`'s AppState listener or has its
  own hook; it must not add a second 6-hour throttle that drifts from the first.
