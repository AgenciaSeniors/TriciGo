# Design: Making the passenger map feel alive

**Status:** approved
**Date:** 2026-08-20
**Author:** Eduardo + Claude
**Scope:** `apps/client` — interactivity, detail and motion on the passenger map. Delivered in three waves; wave 1 ships and gets reviewed on a device before waves 2 and 3 are written.

## Goal

The user's words: the map should feel "más vivo, más detallado" and "más interactivo". Today it renders correct information and ignores the person looking at it. An audit found four concrete reasons why, and the most striking one is that **the passenger is not drawn on their own map**.

## The four gaps (audited, not assumed)

| Gap | Evidence |
|---|---|
| The rider can't see themselves | `MapboxGL.UserLocation` has **zero occurrences** in `apps/client`. GPS only feeds `initialUserCenter` to move the camera. Asymmetry: `useRiderLocationSharing` broadcasts the rider's position so the *driver* can see it (`apps/driver/.../RideMapView.tsx:1382`), but the rider's own map never draws it. |
| The map ignores touch | No `onPress`, no `onLongPress`, no `queryRenderedFeatures` anywhere in the repo. No marker responds to a tap. The only gesture listened to is `onTouchStart` (`RideMapView.tsx:811`) and it just pauses the follow camera. No haptics tied to any map action. |
| Deliberately low detail | `light-v11` is chosen specifically to hide shop/restaurant POIs (`mapStyles.ts:7`). No `FillExtrusionLayer`, no traffic, no sky, no terrain. |
| Nearby vehicles teleport | `nearbyGeoJSON` is built straight from the raw prop (`RideMapView.tsx:502-521`) with a 15 s refresh (`useNearbyVehicles.ts:36`). No interpolation, no enter/exit animation — while the assigned driver has the full machinery (`useAnimatedCoordinate`, `useAnimatedHeading`, `smoothHeading`, `snapDriverToRoute`). |

## Non-goals

- No map on the idle home screen — that's a separate redesign of `IdleView`.
- No changes to the driver app.
- No change to the 1 Hz driver-position poll (BUG-277 is deliberate).
- No new backend tables. One feature flag row is the only server-side addition.

## User-confirmed decisions

1. **All four gaps are in scope**, but delivered in waves.
2. **Detail behind a switch.** Richer style always on (costs nothing extra in tiles); 3D buildings and traffic are opt-in.
3. **3D/traffic default OFF.** There is no low-end-device detection in the monorepo (verified — `lib/device.ts` is identity only, not capability), and building a heuristic to calibrate blind was rejected. Nobody gets stutter they didn't ask for; the switch is discoverable in Settings.
4. **Wave 1 ships and gets reviewed on a real device** before waves 2 and 3 are planned.

## Wave 1 — The map recognizes you

Highest impact, no trade-offs, no extra data cost.

**Rider location puck.** `MapboxGL.UserLocation` with the native puck and heading indicator, in `RideMapView` and `ConfirmLocationScreen`. No asset needed — Mapbox draws it. Renders nothing when permission is denied, so it degrades on its own.

**Haptics on the moments that are currently silent.** `triggerHaptic` / `triggerSelection` already exist in `@tricigo/utils` and are used elsewhere in the app, just never near the map:
- pin settles on a new place in the picker (`onMapIdle`)
- confirm location
- a driver accepts the ride

**Tappable vehicle markers.** Both the driver and the nearby vehicles are drawn as `ShapeSource` + `SymbolLayer`, so taps come from `onPress` on the shape source — GL layers aren't views and can't take an `onPress` of their own. Two distinct payoffs, and the second is the one that actually adds information:
- during an active ride, tapping the driver re-centers the camera on them (same effect as the recenter FAB, but by touching the thing you want to look at)
- during vehicle selection, tapping a nearby vehicle shows a small callout with its type and its ETA to the pickup — data `find_nearby_vehicles` already returns (`eta_seconds`, `distance_to_pickup_m`) and that the map currently throws away

**Long-press the map** → sets that point as the destination by opening `ConfirmLocationScreen` in `dropoff-confirm` mode with those coordinates. Deliberately reuses the existing pin-confirmation flow (00537) rather than inventing a new sheet: the address still gets reverse-geocoded and confirmed, so a long press can't produce a ride with an invented address. Today, picking a destination by hand forces a trip through search first.

## Wave 2 — The map moves

**Nearby vehicles stop teleporting.** Note a real constraint: `useAnimatedCoordinate` is a hook and cannot be called inside a `.map()` over N vehicles. The wave needs a new `useAnimatedVehicles(vehicles)` that runs **one** rAF loop and returns the whole interpolated `FeatureCollection` — the same shape as the existing dash-animation loop, not one hook per vehicle.

**Enter/exit fade** for vehicles appearing and leaving, via a per-feature opacity property driven by the same loop.

**ETA bubble anchored to the driver**, travelling with the marker: a `SymbolLayer` with `textField` on the driver's existing shape source. Today no map in the app draws text of its own (`textField` has zero occurrences).

**Route paints as you travel.** `ROUTE.progress` already exists in `mapStyles.ts:44` and is unused by the client; `useTripProgress` already computes the position along the polyline. Needs `lineMetrics: true` on the route source for a gradient, or a second clipped layer.

## Wave 3 — The map has a world

**Revised after investigation: the base style does not change.** The original plan was to swap `light-v11` for a style that shows shops. That would break offline maps silently. Packs are downloaded per style URL (`useDynamicOfflineMap.ts:101`) and their metadata records only `{tiles, lastUsedAt}` — no style. `ensurePack` reuses a pack by cell key alone and returns early, so after a style change every cached pack would be orphaned: holding tiles for the old style, never re-downloading. In Cuba that means losing the map exactly when connectivity is worst, with nothing surfaced to say why.

The better path was already on disk. The vector tiles the app downloads today carry Mapbox Streets data, including a `poi_label` layer and building footprints — the base style just doesn't draw most of it. So wave 3 adds its own layers over the existing source instead of changing the style: no new tiles, no extra bytes, offline untouched, and TriciGo picks which places are worth showing rather than inheriting whatever a stock style decided.

**Places worth travelling to, as our own layer.** A `SymbolLayer` bound to `sourceID: 'composite'` / `sourceLayerID: 'poi_label'`, filtered to categories that matter for a ride, drawn with the maki icons already in the style's sprite. **Icons only, no labels** — same reasoning as the ETA bubble: nothing in this repo draws map-layer text, and the name can appear on tap instead of crowding the map.

**Tap a place to set it as the destination.** `MapView.onPress` carries `screenPointX/Y`, which feeds `queryRenderedFeaturesAtPoint([x, y], undefined, [ourLayerId])`. Choosing one routes into the same pin-confirmation flow the long-press uses, so the address is still resolved and confirmed.

**3D buildings behind a "Mapa detallado" switch.** A `FillExtrusionLayer` over the same `composite` source (`building` layer), off by default. Follows the driver's `driver_simple_map_mode` precedent: AsyncStorage key, toggle suppresses visual layers only. **Traffic is dropped from scope** — unlike buildings and places it is not in the tiles the app already has, so it would mean new downloads for every rider, which is the cost this wave was rewritten to avoid.

**Offline packs get versioned here.** Recording the style URL in pack metadata and refreshing on mismatch is what makes any future style change safe. It is a few lines, and today its absence is a trap for whoever changes the style next.

## Risks

- **Puck vs. pickup marker confusion.** The pickup pin is a green pulsing circle; the puck is a blue dot. They can sit meters apart and mean different things ("where I am" vs "where you'll be picked up"). Verify on device that the two read as distinct.
- **Long-press vs. pan.** A long press that fires while the user meant to drag the map would be worse than having no gesture. Needs a movement threshold and testing with real thumbs.
- **Text on the map** (wave 2) needs a font that exists in the style, or the layer silently renders nothing.
- **Offline cache invalidation** (wave 3) is the one that can actually degrade service for someone with no connectivity.

## Verification

Per wave: `pnpm check-types` (4 apps), `pnpm --filter client test`, `pnpm --filter client lint` (baseline is 66 warnings, 0 errors), `pnpm check:i18n` for any new copy.

On device — the user takes the screenshots, per project convention:
- puck appears and tracks movement; nothing appears with location permission denied
- haptics fire at pin-settle, confirm and driver-accept
- tapping the driver opens the card; long-press offers the destination
- **the driver app is untouched**
