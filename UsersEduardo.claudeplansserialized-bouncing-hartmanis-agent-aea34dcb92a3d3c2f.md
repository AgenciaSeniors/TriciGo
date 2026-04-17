# TriciGo Live Tracking Visual Redesign -- Implementation Plan

## Overview

Visual upgrade of existing live tracking across client (React Native + Expo), web (Next.js 14), and driver (React Native + Expo) apps. All hooks, data flow, and real-time infrastructure are fully functional. This plan touches ONLY visual rendering: map styles, markers, route lines, and overlay styling.

---

## Phase 0: Shared Map Constants (Foundation)

### New file: packages/utils/src/mapStyles.ts

Create a centralized config consumed by all four map components. Pure constants, zero runtime dependencies.

**Contents:**

1. **Map style URLs**
   - MAP_STYLE_LIGHT: mapbox://styles/mapbox/light-v11 (replaces streets-v12)
   - MAP_STYLE_DARK_NAV: mapbox://styles/mapbox/navigation-night-v1 (driver night)
   - MAP_STYLE_STREETS: mapbox://styles/mapbox/streets-v12 (offline fallback)

2. **Marker colors**
   - PICKUP_COLOR: #22c55e, PICKUP_GLOW: rgba(34,197,94,0.3)
   - DROPOFF_COLOR: #EF4444, DROPOFF_GLOW: rgba(239,68,68,0.3)
   - DRIVER_RING_COLOR: #3b82f6, DRIVER_GLOW: rgba(59,130,246,0.35)

3. **Route line colors**
   - ROUTE_PRIMARY: #3b82f6 (blue replaces orange)
   - ROUTE_SHADOW: rgba(0,0,0,0.15)
   - ROUTE_WIDTH: 6, ROUTE_SHADOW_WIDTH: 10, ROUTE_SHADOW_BLUR: 3

4. **Glassmorphism presets**
   - GLASS_LIGHT and GLASS_DARK object literals

5. **Marker dimensions**
   - PICKUP_SIZE: 32, DROPOFF_SIZE: 32, DRIVER_SIZE: 44, DRIVER_RING_SIZE: 56

**Registration:** Add ./mapStyles export to packages/utils/package.json and index.ts.

---

## Phase 1: Client Native -- apps/client/src/components/RideMapView.tsx

- 1A: Map style from streets-v12 to MAP_STYLE_LIGHT (line 255)
- 1B: Pickup marker -- 32px green + white dot + pulse ring + label pill (lines 321-348)
- 1C: Dropoff marker -- pin-style + red + flag icon + bounce-in (lines 350-378)
- 1D: Driver marker -- vehicle image in 44px dark circle + blue ring + pulse (lines 406-429). Add vehicleType prop.
- 1E: Route line -- blue + shadow layer (lines 305-318)
- 1F: Driver-to-pickup route -- lighter blue dashed, 4px (lines 289-303)
- 1G: Waypoint markers -- 24px orange + elevated shadow (lines 381-404)

---

## Phase 2: Client Web -- apps/client/src/components/WebMapView.tsx

- 2A: Map style to MAP_STYLE_LIGHT (line 43)
- 2B: Pickup marker -- 32px green HTML + CSS pulse ring (lines 152-159)
- 2C: Dropoff marker -- red pin-style HTML + CSS bounce-in (lines 162-169)
- 2D: Route line -- shadow layer + blue primary (lines 196-261)
- 2E: Driver-to-pickup route -- lighter blue (lines 297-331)

---

## Phase 3: Web TrackingMap -- apps/web/src/app/track/TrackingMap.tsx

- 3A: Map style to MAP_STYLE_LIGHT (line 137)
- 3B: Pickup marker -- premium green + pulse ring + shadow (lines 24-40)
- 3C: Dropoff marker -- red pin + drop-in animation (lines 43-60)
- 3D: Driver marker -- vehicle image from /images/vehicles/markers/ + blue ring (lines 63-84). Add vehicleType to props.
- 3E: Route line -- shadow + blue primary (lines 153-183)
- 3F: CSS keyframes -- pulse-pickup, pulse-driver, drop-in (lines 86-97)

---

## Phase 4: Shared Tracking -- apps/web/src/app/track/share/[token]/page.tsx

- 4A: Glassmorphism cards via .shared-tracking wrapper class
- 4B: Replace CTA with Powered by TriciGo footer (lines 354-365)
- 4C: Enhanced live indicator with glow
- 4D: Pass vehicleType to TrackingMap

---

## Phase 5: Private Tracking -- apps/web/src/app/track/[id]/page.tsx

- 5A: Pass vehicleType to TrackingMap

---

## Phase 6: CSS Updates -- apps/web/src/app/track/[id]/track.css

- 6A: New .track-card--glass with backdrop-filter (after line 86)
- 6B: Mobile bottom sheet layout at 768px breakpoint (lines 624-655)
- 6C: Keyframe animations: badgePulse, drop-in
- 6D: @media (prefers-reduced-motion: reduce) support

---

## Phase 7: Driver App -- apps/driver/src/components/RideMapView.tsx

- 7A: Day style to MAP_STYLE_LIGHT, keep night (lines 73, 721)
- 7B: Pickup marker -- 32px + white dot + pulse (lines 779-781, 879-883)
- 7C: Dropoff marker -- pin-style (lines 784-786, 884-888)
- 7D: Rider marker -- 28px + pulse + glow (lines 789-791, 889-893)
- 7E: Driver self-marker -- keep orange, polish ring 60px, more shadow (lines 793-809)
- 7F: Route -- blue + shadow (lines 770-776)
- 7G: Web markers -- 28px, glow shadows, blue route (lines 275-310)

---

## Phase 8: Offline -- packages/utils/src/mapboxOffline.ts

Line 19: MAPBOX_STYLE_URL from streets-v12 to MAP_STYLE_LIGHT.

---

## Implementation Order

0 -> 8 -> 1+2 -> 3+6 -> 4+5 -> 7
Phases 1, 3, 7 are independent after Phase 0.
Estimated: 7-8 hours.

## Files: 1 new, 10 modified.