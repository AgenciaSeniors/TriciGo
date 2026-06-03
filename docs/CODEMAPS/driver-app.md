# TriciGo Driver App — Codemap

**Last Updated:** 2026-05-04  
**Entry Points:** `apps/driver/app/`, `apps/driver/src/`  
**Owner:** Persona B (driver app developer)

---

## Architecture Overview

```
Expo Router (app/) — Tab navigation
  ├── (auth) — Login & OTP
  ├── (tabs) — Home, Trips, Earnings, Profile
  │   └── index.tsx — Map + incoming rides + home sheet (Phase 2/3 hub)
  ├── onboarding/ — 4-step driver registration
  ├── profile/ — Sub-pages (edit, vehicle, documents, safety, etc.)
  ├── trip/ — Trip detail & disputes
  ├── chat/ — Rider messaging
  └── notifications/

Zustand Stores (src/stores/) — State management
  ├── auth.store.ts — User session
  ├── driver.store.ts — Driver profile + online status
  ├── ride.store.ts — Incoming requests + active trip (30s TTL on requests)
  ├── location.store.ts — GPS position + heading
  ├── chat.store.ts — Messages + typing
  ├── notification.store.ts — Push preferences
  ├── theme.store.ts — Dark mode
  └── onboarding.store.ts — Multi-step form data

Custom Hooks (src/hooks/) — Data fetching & lifecycle
  ├── useAuth — Auth init + realtime profile sync
  ├── useNotifications — Push token + handlers
  ├── useDriverLocation — GPS tracking + offline buffer
  ├── useMapboxOffline — Weekly Havana tiles
  ├── useDriverRide — Active trip lifecycle
  ├── useDriverETA — ETA calculations
  ├── useRoutePolyline — Route geometry
  ├── useDemandHotspots — Live request clusters
  ├── usePopularLocations — 90-day pickup/dropoff clusters (Phase 2 N5)
  ├── useSmartSuggestion — Ranked target (Phase 2 N1) → score = (live_count × surge) / sqrt(distance + 0.5)
  ├── useDriverPeakHours — Personal earnings heatmap (Phase 2 N2)
  ├── useNearbyDrivers — Peer driver positions
  ├── useChat — Chat messages + realtime
  ├── useSelfieCheck — Liveness verification
  └── useInAppNavigation — Deep link routing

Components (src/components/) — UI & interaction
  ├── HomeBottomSheet.tsx — Control panel (online/offline, stats, suggestions) [Phase 2/3 hub]
  ├── RideMapView.tsx — Map with markers, polyline, heatmap, overlays
  ├── IncomingRideCard.tsx — Accept/reject ride UI
  ├── DriverTripView.tsx — Active trip status + actions
  ├── NavigationOverlay.tsx — Turn-by-turn controls
  ├── PopularLocationPin.tsx — Static pin for historical clusters (Phase 2 N5)
  ├── PersonalPeakHours.tsx — 7×24 earnings heatmap (Phase 2 N2)
  ├── PerformanceMetricsSection.tsx — Driver stats + cancellation alert (Phase 2 N3)
  ├── ReviewTagsBreakdown.tsx — Positive/negative tag breakdown (Phase 2 N4)
  ├── SettingsRow.tsx — Settings toggle (Phase 3 V2/V3 touch targets)
  ├── RiderRatingSheet.tsx — Post-trip rating modal
  ├── DeliveryPhotoSheet.tsx — Cargo pickup/delivery photos
  └── OfflineBanner.tsx — Sync status

Services (src/services/) — Local operations
  └── locationBuffer.ts — SQLite GPS buffering (offline resilience)

---

## Phase 2/3 Features (Shipped 2026-05)

### Phase 2 — Driver-Only Features

| Feature | Hook/Component | DB | Analytics (actual events) |
|---------|---|---|---|
| **N1: Smart Route Suggestions** | `useSmartSuggestion` → `HomeBottomSheet` | — | `driver_suggestion_followed` (on tap) |
| **N2: Personal Peak Hours Heatmap** | `useDriverPeakHours` + `PersonalPeakHours` | `get_driver_peak_hours_personal` RPC (00258 — not yet applied to prod) | — |
| **N3: Cancellation-Rate Alert** | `PerformanceMetricsSection` (amber banner) | — | — (slim slice; deep slice with trigger deferred) |
| **N4: Review Tag Analytics** | `ReviewTagsBreakdown` | `get_review_tag_summary` RPC (pre-existing) | — |
| **N5: Popular Zones Overlay** | `usePopularLocations` + `PopularLocationPin` | `get_popular_locations` RPC | — |
| **N6: Anti-Fatigue Banner MVP** | `HomeBottomSheet` + `AsyncStorage driver_online_since` | — | `driver_fatigue_warning_shown` (per level transition) + reuses `driver_break_started` for follow-through |

### Phase 3 — Visual Polish

| Feature | Files | Detail |
|---------|-------|--------|
| **V1: Token Consistency** | — | `midnightEmber` theme verified in `@tricigo/theme` |
| **V2: Touch Targets** | `SettingsRow`, `IncomingRideCard`, etc. | 5 fixes → all ≥44pt; ripple on Android |
| **V3: State Clarity** | `SettingsRow`, theme tabs | Press feedback (opacity 0.7); `accessibilityRole="radio"` |
| **V4: Simple Map Mode** | `app/(tabs)/index.tsx` | `AsyncStorage driver_simple_map_mode`; suppresses surge/demand/peers + their top banners; analytics `driver_map_density_toggled` |

---

## Key Data Flows

### Incoming Ride Request (Realtime)
```
Supabase Realtime (rides table insert)
  → ride.store.addRequest(ride, timestamp)
  → IncomingRideCard renders (30s countdown timer)
  → Driver taps Accept
    → driverService.acceptRide(rideId)
    → ride.store.setActiveTrip(ride)
    → HomeBottomSheet → DriverTripView transition
```

### Smart Route Suggestion (Phase 2 N1)
```
useDemandHotspots (live clusters)
+ usePopularLocations (90-day historical)
  → useSmartSuggestion calculates score per candidate
  → Returns top 1 with reason string
  → HomeBottomSheet displays actionable card
  → Driver taps → navigate to location
```

### Personal Peak Hours (Phase 2 N2)
```
useDriverPeakHours polls get_driver_peak_hours_personal RPC
  (completed rides last 30 days, grouped by DOW × hour)
  → PersonalPeakHours renders 7×24 heatmap
  (cell color intensity = earnings relative to driver's peak)
  → Driver sees "Friday 7pm makes me 40% more than average"
```

### Active Trip Lifecycle
```
Accepted ride
  → driver_en_route (navigate to pickup)
  → arrived_at_pickup (wait for rider)
  → [if cargo: DeliveryPhotoSheet for pickup photo]
  → in_progress (trip underway; location buffered)
  → completed (final fare + tip)
  → [if cargo: DeliveryPhotoSheet for delivery photo]
  → RiderRatingSheet (driver rates rider)
```

---

## Shared Dependencies

| Package | Key Exports |
|---------|---|
| `@tricigo/api` | `driverService`, `rideService`, `locationService`, `deliveryService`, `reviewService`, `notificationService` |
| `@tricigo/types` | `Ride`, `Driver`, `DriverProfile`, `DemandHotspot`, `PopularLocation`, `DriverPeakHourCell` |
| `@tricigo/i18n` | `useTranslation('driver')` for all UI text |
| `@tricigo/theme` | Colors, `midnightEmber` token, `tailwind-preset` |
| `@tricigo/ui` | `Button`, `Input`, `Card`, `DraggableSheet`, `Text` |
| `@tricigo/utils` | `haversineDistance`, `formatCUP`, `trackEvent`, `HAVANA_CENTER`, `CUBA_PROVINCES` |

---

## Database Migrations (Recent)

| Migration | Feature | RPC/Change |
|-----------|---------|-----------|
| 00257 | Driver preferences | `driver_preferences` table (language, notifications) |
| 00258 | Personal peak hours (Phase 2 N2) | `get_driver_peak_hours_personal(driver_id, days)` RPC |

**Note:** Migration 00258 not yet applied to production (MCP guard). Frontend tolerates missing RPC gracefully (silent fallback).

---

## Screen Routes & States

| Route | File | States |
|-------|------|--------|
| `/` (home) | `app/(tabs)/index.tsx` | Offline, Online Idle, Online On-Break, Active Trip, Simple Map Mode (V4) |
| `/trips` | `app/(tabs)/trips.tsx` | Paginated history, filters, CSV export |
| `/earnings` | `app/(tabs)/earnings.tsx` | Daily/weekly/monthly breakdown, commission, tips, performance metrics (N3) |
| `/profile` | `app/(tabs)/profile.tsx` | Driver avatar, stats, menu |
| `/profile/reviews` | `app/profile/reviews.tsx` | Rider ratings + N4 review tag breakdown |
| `/trip/[id]` | `app/trip/[id].tsx` | Trip detail, fare breakdown, dispute/lost-item banners |
| `/chat/[rideId]` | `app/chat/[rideId].tsx` | Realtime messages during active trip |

---

## Testing Checklist (Phase 2/3)

- [ ] N1: Smart suggestion scores highest demand zone correctly; navigates on tap
- [ ] N2: Personal peak hours heatmap renders, cells color-scale with earnings
- [ ] N3: Cancellation alert appears when rate >15%; disappears below 15%
- [ ] N4: Review tags split positive/negative; correct i18n keys load
- [ ] N5: Popular location pins visible; toggle works; pickup vs dropoff arrows distinguish
- [ ] N6: Anti-fatigue banner fires at 6h + 10h thresholds; dismissible
- [ ] V2: Touch targets ≥44pt on Banner, Desconectar, Switch (scale 0.85), toggles
- [ ] V3: Press feedback visible; accessibility states mirror; keyboard nav works
- [ ] V4: Simple map mode suppresses surge/demand/peers; `driver_map_density_toggled` fires; AsyncStorage key persists

---

## Related Docs

- `docs/DRIVER_APP_IMPL.md` — Full technical reference (sections 1–23)
- `docs/CLIENT_APP_IMPL.md` — Parallel client app architecture
- `CLAUDE.md` — Project conventions & troubleshooting
