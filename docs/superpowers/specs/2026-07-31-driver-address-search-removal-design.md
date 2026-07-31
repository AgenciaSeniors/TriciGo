# Remove the driver home address/zone search — design

**Status:** design approved (2026-07-31). Not yet implemented.
**Scope:** driver app only. Client and web search bars are untouched.
**Related:**
- Same session: `fix(driver): hide the popular-zones toggle when it has nothing to paint` — the other dead-affordance fix on this screen.
- CLAUDE.md → "Search de direcciones — estado canónico" (the shared search stack this bar consumed).

## Problem

The driver home bottom sheet renders a search field labelled *"Buscar dirección o zona…"*. Its entire effect on selection is one line in `apps/driver/app/(tabs)/index.tsx`:

```ts
const handleAddressSelect = useCallback(({ latitude, longitude }) => {
  mapRef.current?.flyTo(latitude, longitude, 15);
}, []);
```

It pans the map camera. Nothing else. It does not filter or redirect ride offers, does not set a work zone, does not start navigation, and does not persist.

The label promises more than that. Read quickly, *"Buscar dirección o zona"* suggests the driver can choose **where they want to work** — a capability that does not exist in the platform: matching runs off the driver's real GPS fix. The affordance is a dead end dressed as a feature.

There is no usage data to appeal to: `validation_events` holds five event types (`driver_ride_rejected`, `driver_fatigue_warning_shown`, `driver_ride_offer_expired`, `driver_ride_auto_accepted`, `driver_near_dropoff`) and none of them covers search. The bar was never instrumented.

## Decision

**Remove it, and remove the code behind it.**

The alternatives were weighed and rejected:

| Alternative | Why not |
|---|---|
| Wire the result to `openNavigation()` (Waze / Google Maps), like the "Sugerencia" card does | Rejected by the product owner: the driver does not need a place-search-and-go tool on the idle screen. |
| Keep the pan-only behaviour, fix the label ("Explorar el mapa") | Keeps a feature nobody asked for, just honestly named. |
| Let the driver pick a work zone for real | Requires changing the matching engine to dispatch against a declared position instead of the GPS fix. Far beyond the intent, and questionable on its own merits. |
| Hide the render, keep the files | Leaves ~700 lines of dead code that rot silently — precisely the failure mode found on this same screen earlier today. |
| Instrument first, delete in two weeks | The current driver fleet has no build carrying such an event, so two weeks would produce no signal anyway. |

The driver keeps map exploration: drag and pinch still work, and the orange recenter button returns them to their own position. What is lost is jumping to a named place.

## Scope

### Removed

| File | Change |
|---|---|
| `apps/driver/src/components/HomeBottomSheet.tsx` | Drop the `AddressSearchBar` import, the `onAddressSelect` prop from the props interface, its destructuring, and the render block (the `{/* Search bar */}` wrapper). |
| `apps/driver/app/(tabs)/index.tsx` | Drop `handleAddressSelect` and the `onAddressSelect={…}` prop passed to `HomeBottomSheet`. |
| `apps/driver/src/components/AddressSearchBar.tsx` | **Delete** — 585 lines, `HomeBottomSheet` is its only consumer. |
| `apps/driver/src/hooks/useDestinationPredictions.ts` | **Delete** — the driver-local copy, whose only consumer is `AddressSearchBar`. The client app keeps its own separate copy. |
| `packages/i18n/src/locales/{es,en,pt}/driver.json` | Remove `home.search_placeholder`. Driver-only namespace, single call site. |

Deletions use `git rm`, not `Remove-Item`: PowerShell reports success on tracked files and leaves them on disk (CLAUDE.md documents this).

### Deliberately untouched

- **`SNAP_POINTS = ['18%', '45%', '85%']`** in `HomeBottomSheet.tsx`. Shared across the offline, online, on-break and banner states; shrinking them to absorb the freed space risks clipping content in those other states. That is a separate visual decision.
- **The recenter button, the map, drag/pinch gestures.**
- **The "Sugerencia" card and its `openNavigation()` call.** Untouched — it remains the one place where a location turns into real navigation.
- **The client and web search bars**, and with them the background `importPoiFromSearch` enrichment of `cuba_pois`. That enrichment runs from three other call sites (`apps/web/src/components/AddressAutocomplete.tsx`, `apps/client/src/components/AddressSearchInput.tsx`, `apps/client/src/components/WebAddressInput.tsx`), so removing the driver's copy does not impoverish the place database.
- **The shared search helpers in `@tricigo/utils`** (`searchPoisSupabase`, `searchStreetsSupabase`, `searchAddressUnified`, `searchResultEmoji`, …) and the `get_destination_suggestions` RPC. All still consumed by client and web.

### Known visual consequence

The footer row (Pausar / Desconectar) sits in normal flow with `marginTop: 14`. The removed block occupied its wrapper's `marginTop: 12` plus the input's fixed `height: 48` — so the footer rises by **60 dp** and that much empty sheet remains below it at the 45% snap point.

This is left uncompensated **on purpose**. It has to be judged on a real device, and adjusting it is a layout change that deserves the design skill (`ui-ux-pro-max`) rather than a blind number tweak. If it reads badly in the build, it is a follow-up.

## Verification

1. `pnpm check-types` — all four apps green. (The worktree needs `pnpm install` first; the script is `check-types`, not `typecheck`.)
2. Paranoia grep over `apps/driver`: zero hits for `AddressSearchBar`, `useDestinationPredictions`, `onAddressSelect`, `handleAddressSelect`, `search_placeholder`.
3. `git diff --stat` matches the Removed table above and nothing else — seven files, since the last row covers three locale files.
4. `pnpm-lock.yaml` unchanged after any install (`git checkout HEAD -- pnpm-lock.yaml` if it drifts).

Not verifiable from the sandbox: the rendered result. This is React Native — the browser preview cannot exercise it. Any claim about how the sheet looks must come from a device screenshot, not from this document.

**No paid build is required, for QA or for shipping.** The change is JS-only: it deletes a component, a hook, i18n keys and prop wiring, and touches no native module, `app.json` entry or dependency. The runtime fingerprint is unchanged, so the installed binary can run the new bundle.

- **QA:** Metro (`--dev-client`, port 8082) against the installed driver dev client. Copy `apps/driver/.env` into the worktree first — it is gitignored, and without it `EXPO_PUBLIC_MAPBOX_TOKEN` inlines empty and the map crashes on open.
- **No dev client on hand:** `android-dev-client-driver.yml` builds the APK on the GitHub runner (`expo prebuild` + `./gradlew assembleDebug`). It does not use EAS cloud build, so it consumes no build credits.
- **Reaching the fleet:** the driver ships OTA — `updates.enabled: true`, `runtimeVersion.policy: "appVersion"` (1.4.0). Publish through the `eas-update.yml` workflow, which supports a staged `rollout-percentage`. Never run `eas update` locally: it inlines an empty env and would break Mapbox for every driver.

## Rollback

A single `git revert` restores the render, both deleted files and the three i18n keys. Nothing here touches the database, an Edge Function, or persisted state, so there is no data migration to undo and no partial state to reconcile.

## Out of scope

- Compensating the 60 dp of freed sheet height.
- Instrumenting anything on the driver home screen.
- The dormant `popular_locations` refresh cron (tracked separately — the matview is empty and nothing refreshes it).
