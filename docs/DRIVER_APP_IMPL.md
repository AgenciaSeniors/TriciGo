# TriciGo Driver App — Implementation Guide

> Complete technical reference for the driver React Native app.
> **Owner:** Persona B (driver app developer)
> **Last updated:** 2026-03-30

---

## Table of Contents

1. [Team Coordination Rules](#1-team-coordination-rules)
2. [Project Setup](#2-project-setup)
3. [Architecture Overview](#3-architecture-overview)
4. [Navigation (Expo Router)](#4-navigation-expo-router)
5. [State Management (Zustand)](#5-state-management-zustand)
6. [Authentication Flow](#6-authentication-flow)
7. [Driver Onboarding (4-Step Registration)](#7-driver-onboarding-4-step-registration)
8. [Home Screen & Incoming Rides](#8-home-screen--incoming-rides)
9. [Map Integration (Mapbox)](#9-map-integration-mapbox)
10. [Active Trip Lifecycle](#10-active-trip-lifecycle)
11. [Location Tracking & Background GPS](#11-location-tracking--background-gps)
12. [Delivery (Cargo) Rides](#12-delivery-cargo-rides)
13. [Trip History & Detail](#13-trip-history--detail)
14. [Earnings & Revenue](#14-earnings--revenue)
15. [Notifications](#15-notifications)
16. [Chat with Rider](#16-chat-with-rider)
17. [Profile & Sub-pages](#17-profile--sub-pages)
18. [Offline Support](#18-offline-support)
19. [Styling (NativeWind)](#19-styling-nativewind)
20. [Shared Packages](#20-shared-packages)
21. [Services & Hooks Reference](#21-services--hooks-reference)
22. [Build & Deploy (EAS)](#22-build--deploy-eas)
23. [Testing & QA](#23-testing--qa)

---

## 1. Team Coordination Rules

Two developers work in parallel: **Persona A** (client app) and **Persona B** (this app). These rules prevent conflicts.

### Ownership Boundaries

| Area | Owner | Others: Read-Only |
|------|-------|--------------------|
| `apps/driver/**` | **Persona B** | Persona A must NOT edit |
| `apps/client/**` | **Persona A** | Persona B must NOT edit |
| `packages/api/src/services/**` | Shared | Coordinate before editing |
| `packages/types/src/**` | Shared | Coordinate before editing |
| `packages/ui/src/**` | Shared | Coordinate before editing |
| `packages/i18n/src/locales/**` | Shared | Coordinate before editing |
| `packages/utils/src/**` | Shared | Coordinate before editing |
| `packages/theme/src/**` | Shared | Coordinate before editing |
| `supabase/migrations/**` | Shared | **Must** coordinate — one migration at a time |
| `apps/web/**` | Neither | Do NOT touch |
| `apps/admin/**` | Neither | Do NOT touch |

### Shared Package Rules

1. **Before editing any file in `packages/*`:** Notify the other dev via chat/message. Wait for acknowledgment if they're mid-task on the same package.
2. **New types in `@tricigo/types`:** Add to a new file or clearly separated section. Never modify existing interfaces that the other app uses without coordinating.
3. **New API services in `@tricigo/api`:** Create a new file (e.g., `new-feature.service.ts`) rather than modifying an existing service file. If you MUST modify an existing service, coordinate.
4. **New translations in `@tricigo/i18n`:** Each app uses its own namespace (`driver` for driver, `rider` for client). Only edit your namespace. `common` namespace requires coordination.
5. **Database migrations:** Only ONE person creates a migration at a time. Use Slack/chat to claim: "I'm writing migration XXX." Migrations must be sequential — never create two in parallel.
6. **Git branches:** Use prefix `driver/` for all branches (e.g., `driver/fix-location-buffer`). Persona A uses `client/`. This prevents confusion.

### Conflict Resolution

- If both need to modify the same shared file: the first person to push wins. The second must rebase.
- If a breaking change in `packages/*` is needed: create a PR, tag the other dev for review before merging.
- Daily sync (5 min): "What shared packages did you touch today?"

---

## 2. Project Setup

### Location
```
apps/driver/          # Root of the driver app
```

### Tech Stack
| Technology | Version | Purpose |
|-----------|---------|---------|
| Expo SDK | 55 | App framework |
| React | 19.2.0 | UI library |
| React Native | 0.83.2 | Native rendering |
| Expo Router | 55.0.5 | File-based navigation |
| Zustand | 5.0.3 | State management |
| NativeWind | 4.1.23 | Tailwind CSS for RN |
| @rnmapbox/maps | 10.1.34 | Native maps |
| @supabase/supabase-js | 2.49.1 | Backend client |
| @tanstack/react-query | 5.66.0 | Data fetching/caching |
| expo-notifications | 55.0.12 | Push notifications |
| expo-location | 55.1.2 | GPS + background tracking |
| @sentry/react-native | 7.11.0 | Error tracking |
| posthog-react-native | 4.37.2 | Analytics |
| i18next | 24.2.2 | Internationalization |

### Scripts
```bash
pnpm --filter @tricigo/driver dev          # Start Expo dev server
pnpm --filter @tricigo/driver build        # Type check (tsc --noEmit)
pnpm --filter @tricigo/driver lint         # ESLint
pnpm --filter @tricigo/driver check-types  # TypeScript check
```

### Environment Variables (`.env`)
```
EXPO_PUBLIC_SUPABASE_URL=https://lqaufszburqvlslpcuac.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<key>
EXPO_PUBLIC_MAPBOX_TOKEN=<token>
EXPO_PUBLIC_SENTRY_DSN=<dsn>
EXPO_PUBLIC_POSTHOG_API_KEY=<key>
```

### Path Alias
```
@/* → ./src/*
```

---

## 3. Architecture Overview

### Directory Structure
```
apps/driver/
├── app/                            # Expo Router pages
│   ├── _layout.tsx                 # Root: auth gate + onboarding routing
│   ├── (auth)/                     # Login & OTP
│   │   ├── _layout.tsx
│   │   ├── login.tsx
│   │   └── verify-otp.tsx
│   ├── (tabs)/                     # Main 4-tab layout
│   │   ├── _layout.tsx             # Tabs: Home, Trips, Earnings, Profile
│   │   ├── index.tsx               # Home (map, incoming rides, active trip)
│   │   ├── trips.tsx               # Trip history
│   │   ├── earnings.tsx            # Revenue & stats
│   │   └── profile.tsx             # Profile hub
│   ├── onboarding/                 # 4-step driver registration
│   │   ├── _layout.tsx
│   │   ├── personal-info.tsx       # Step 1: Name, email, phone
│   │   ├── vehicle-info.tsx        # Step 2: Vehicle type, plate, color
│   │   ├── documents.tsx           # Step 3: ID, vehicle docs, selfie
│   │   ├── review.tsx              # Step 4: Summary + submit
│   │   └── pending.tsx             # Waiting for approval / suspended
│   ├── profile/                    # Profile sub-pages
│   │   ├── _layout.tsx
│   │   ├── edit.tsx
│   │   ├── vehicle.tsx
│   │   ├── documents.tsx
│   │   ├── safety.tsx
│   │   ├── pricing.tsx
│   │   ├── settings.tsx
│   │   ├── help.tsx
│   │   ├── referral.tsx
│   │   ├── reviews.tsx
│   │   ├── penalties.tsx
│   │   └── ticket-detail.tsx
│   ├── trip/                       # Trip detail & disputes
│   │   ├── _layout.tsx
│   │   ├── [id].tsx                # Trip detail with fare breakdown
│   │   ├── dispute-respond/
│   │   │   └── [disputeId].tsx     # Respond to rider dispute
│   │   └── lost-item/
│   │       └── [id].tsx            # Lost item response
│   ├── chat/
│   │   ├── _layout.tsx
│   │   └── [rideId].tsx            # Chat with rider
│   ├── notifications/
│   │   └── index.tsx
│   └── +not-found.tsx
│
├── src/
│   ├── stores/                     # Zustand stores (8)
│   │   ├── auth.store.ts
│   │   ├── driver.store.ts         # Driver profile + online status
│   │   ├── ride.store.ts           # Incoming requests + active trip
│   │   ├── location.store.ts       # GPS position + heading
│   │   ├── chat.store.ts
│   │   ├── notification.store.ts
│   │   ├── theme.store.ts
│   │   └── onboarding.store.ts     # Multi-step form data
│   ├── hooks/                      # Custom hooks (12)
│   │   ├── useAuth.ts              # Auth init + realtime profile sync
│   │   ├── useNotifications.ts     # Push token + handlers + deep links
│   │   ├── useDriverLocation.ts    # GPS tracking + offline buffer
│   │   ├── useMapboxOffline.ts     # Weekly Havana tile downloads
│   │   ├── useDriverRide.ts        # Active trip lifecycle
│   │   ├── useDriverETA.ts         # ETA calculations
│   │   ├── useRoutePolyline.ts     # Route polyline
│   │   ├── useDemandHeatmap.ts     # Demand visualization
│   │   ├── useChat.ts              # Chat messages
│   │   ├── useSelfieCheck.ts       # Selfie liveness verification
│   │   └── useInAppNavigation.ts   # Deep link handling
│   ├── components/                 # Reusable components (9)
│   │   ├── RideMapView.tsx         # Map with markers, polyline, heatmap
│   │   ├── OfflineBanner.tsx       # Offline status + pending queue
│   │   ├── IncomingRideCard.tsx    # Accept/reject ride card
│   │   ├── DriverTripView.tsx      # Active trip status view
│   │   ├── NavigationOverlay.tsx   # Navigation controls
│   │   ├── RiderRatingSheet.tsx    # Post-trip rating modal
│   │   ├── DeliveryPhotoSheet.tsx  # Photo capture for deliveries
│   │   ├── EarningsBarChart.tsx    # Revenue chart
│   │   └── HourlyHeatmap.tsx       # Demand heatmap
│   ├── services/
│   │   └── locationBuffer.ts       # SQLite location buffering
│   ├── providers/
│   │   └── app-providers.tsx       # React Query, PostHog, offline, i18n
│   ├── lib/
│   │   ├── sentry.ts
│   │   └── useAuth.ts
│   └── utils/
│       └── navigation.ts
│
├── assets/                         # Images, icons, sounds
├── app.json                        # Expo config
├── tsconfig.json
├── tailwind.config.js
├── metro.config.js
├── babel.config.js
└── eas.json
```

### Data Flow
```
Supabase Realtime (ride requests, status updates)
  → Zustand Store (ride.store, driver.store)
    → Component re-render
      → User action (accept, status change)
        → @tricigo/api Service (driverService, rideService)
          → Supabase (PostgreSQL + Realtime)
```

---

## 4. Navigation (Expo Router)

### Root Layout (`app/_layout.tsx`) — Auth State Machine
```
Not authenticated                            → /(auth)/login
Authenticated + no profile/pending_verification → /onboarding/personal-info
Authenticated + profile pending/suspended    → /onboarding/pending
  (EXCEPTION: has active trip → allow /(tabs) to complete it)
Authenticated + profile approved             → /(tabs)
```

### Tab Layout (`app/(tabs)/_layout.tsx`)
4 tabs:
| Tab | Route | Icon | Purpose |
|-----|-------|------|---------|
| Home | `/(tabs)/` | `navigate` | Map, incoming rides, active trip |
| Trips | `/(tabs)/trips` | `car` | Trip history |
| Earnings | `/(tabs)/earnings` | `cash` | Revenue & stats |
| Profile | `/(tabs)/profile` | `person` | Profile menu |

### Dynamic Routes
| Route | Param | Purpose |
|-------|-------|---------|
| `/trip/[id]` | `id` (UUID) | Trip detail with fare breakdown |
| `/trip/dispute-respond/[disputeId]` | `disputeId` | Respond to rider dispute |
| `/trip/lost-item/[id]` | `id` | Respond to lost item report |
| `/chat/[rideId]` | `rideId` | Chat with rider |

---

## 5. State Management (Zustand)

### auth.store.ts
```typescript
interface AuthState {
  user: User | null
  isAuthenticated: boolean
  isLoading: boolean
  isInitialized: boolean
  setUser(user: User | null): void
  setLoading(loading: boolean): void
  reset(): void
}
```

### driver.store.ts
```typescript
interface DriverState {
  profile: DriverProfile | null     // Driver-specific fields
  isOnline: boolean                 // Available for rides
  setProfile(profile: DriverProfile | null): void
  setOnline(isOnline: boolean): void
  reset(): void
}
```

### ride.store.ts (Driver-specific)
```typescript
interface DriverRideState {
  incomingRequests: TimestampedRide[]  // Rides awaiting accept/reject
  activeTrip: Ride | null              // Currently active trip
  addRequest(ride: Ride): void
  removeRequest(rideId: string): void
  removeStaleRequests(): void          // Removes >30s old requests
  clearRequests(): void
  setActiveTrip(trip: Ride | null): void
  updateActiveTrip(trip: Ride): void   // Ignores stale realtime updates
  reset(): void
}
```

**Important: 30-second TTL on incoming requests.** Each request is timestamped when added. `removeStaleRequests()` purges requests older than 30 seconds. This prevents accepting expired ride offers.

### location.store.ts
```typescript
interface LocationState {
  latitude: number | null
  longitude: number | null
  heading: number | null              // Compass heading in degrees
  setLocation(lat: number, lng: number, heading: number | null): void
}
```

### onboarding.store.ts
```typescript
// Multi-step form data:
// Step 1: full_name, email, phone
// Step 2: vehicle_type, plate_number, color
// Step 3: document photos (ID, vehicle reg, inspection, selfie)
// Step 4: review + submit
```

### chat.store.ts, notification.store.ts, theme.store.ts
Same interface as client app (see client doc for details).

---

## 6. Authentication Flow

### Phone OTP
```
1. login.tsx: Driver enters phone (+53XXXXXXXX)
2. authService.sendOTP(phone) → SMS sent
3. verify-otp.tsx: Driver enters 6-digit code
4. authService.verifyOTP(phone, code) → Session created
5. authService.getCurrentUser() → User object
6. driverService.getProfile(userId) → Check registration status
7. Route based on status:
   - No profile → /onboarding/personal-info
   - pending_verification → /onboarding/personal-info
   - pending / suspended / rejected → /onboarding/pending
   - approved → /(tabs)
```

### Session Persistence
- `useAuthInit()` in `src/lib/useAuth.ts`
- SecureStore (native) / localStorage (web)
- `authService.onAuthStateChange()` listener
- **Realtime profile sync:** Supabase channel on `driver_profiles` table — detects admin status changes (approved → suspended, etc.)

### Sign Out
```typescript
// 1. Mark driver offline first
driverService.setOnlineStatus(driverId, false)
// 2. Clear all stores
authService.signOut()
useAuthStore.reset()
useDriverStore.reset()
useDriverRideStore.reset()
useLocationStore.reset()  // Not explicitly, but implicitly
useChatStore.reset()
useNotificationStore.reset()
// → Redirect to /(auth)/login
```

---

## 7. Driver Onboarding (4-Step Registration)

### Step 1: Personal Info (`onboarding/personal-info.tsx`)
- Full name (required, 2+ chars, sanitized)
- Email (optional, validated if filled)
- Phone (read-only, from auth)
- `StatusStepper` component shows 1/4

### Step 2: Vehicle Info (`onboarding/vehicle-info.tsx`)
- Vehicle type selection: Triciclo / Moto / Auto (card radio buttons)
- License plate input
- Vehicle color
- `StatusStepper` 2/4

### Step 3: Documents (`onboarding/documents.tsx`)
- ID/Passport photo upload (expo-image-picker)
- Vehicle registration document upload
- Vehicle inspection certificate upload
- Selfie with liveness check (`useSelfieCheck()` hook)
- Image preview before submission
- `StatusStepper` 3/4

### Step 4: Review (`onboarding/review.tsx`)
- Summary of all steps with edit buttons
- Submit → POST to backend
- Confirmation modal on success
- `StatusStepper` 4/4

### Pending Screen (`onboarding/pending.tsx`)
Shown when profile status is `pending`, `suspended`, `rejected`, or `on_hold`:
- Status-specific messaging
- Estimated approval timeline
- Appeal/support link

---

## 8. Home Screen & Incoming Rides

### File: `app/(tabs)/index.tsx`

### Online/Offline Toggle
```typescript
// Toggle button on home screen
driverService.setOnlineStatus(driverId, isOnline)
useDriverStore.setOnline(isOnline)
// When online: GPS tracking starts, ride requests received
// When offline: GPS stops, no new requests
```

### Incoming Ride Flow
```
1. Supabase Realtime delivers new ride request
2. ride.store.addRequest(ride) → timestamped
3. IncomingRideCard renders with:
   - Pickup/dropoff addresses
   - Estimated fare
   - Distance from current location
   - Accept / Reject buttons
   - Countdown timer (30 seconds)
4. Driver taps Accept:
   - driverService.acceptRide(rideId, driverId)
   - ride.store.setActiveTrip(ride)
   - ride.store.clearRequests()
5. Driver taps Reject:
   - ride.store.removeRequest(rideId)
6. Timer expires (30s):
   - ride.store.removeStaleRequests() auto-cleans
```

### Active Trip Display
When `activeTrip` is set:
- `DriverTripView` component replaces incoming cards
- Shows current status, rider info, navigation controls
- `NavigationOverlay` with turn-by-turn directions

### Audio Notification
`expo-notifications.scheduleNotificationAsync()` fires a local notification + sound when new ride arrives.

### Key Components
| Component | File | Purpose |
|-----------|------|---------|
| `RideMapView` | `src/components/RideMapView.tsx` | Map with markers, route, heatmap |
| `IncomingRideCard` | `src/components/IncomingRideCard.tsx` | Accept/reject ride UI |
| `DriverTripView` | `src/components/DriverTripView.tsx` | Active trip status |
| `NavigationOverlay` | `src/components/NavigationOverlay.tsx` | Navigation controls |
| `HourlyHeatmap` | `src/components/HourlyHeatmap.tsx` | Demand visualization |

---

## 9. Map Integration (Mapbox)

### Native: `@rnmapbox/maps`
Map displays on home screen with:
- **Driver position:** Blue pulsing circle with glow
- **Pickup marker:** Green circle (`#22c55e`)
- **Dropoff marker:** Orange/red circle (`#F97316` / error color)
- **Route polyline:** Orange line from location events
- **Demand heatmap:** Circle layers — green (low) → yellow (medium) → red (high demand)
- Camera auto-fits to relevant bounds

### Offline Map Pack
```typescript
// useMapboxOffline() hook
// Downloads weekly:
// - Region: Havana city center + suburbs
// - Zoom: 10-14 (street level)
// - Storage: Device via MapboxGL.offlineManager
```

### Web Stub
`@rnmapbox/maps` is stubbed on web in `metro.config.js`. Web views show fallback content for Play Store screenshots.

---

## 10. Active Trip Lifecycle

### Status Transitions (Driver Controls)
```
accepted
  → driverService.updateRideStatus(rideId, 'driver_en_route')
    Driver navigates to pickup

driver_en_route
  → driverService.updateRideStatus(rideId, 'arrived_at_pickup')
    Driver arrives, waits for rider

arrived_at_pickup
  → driverService.updateRideStatus(rideId, 'in_progress')
    Rider boards, trip starts
    (For cargo: DeliveryPhotoSheet appears first — must take pickup photo)

in_progress
  → driverService.updateRideStatus(rideId, 'completed')
    Trip ends, final fare calculated
    (For cargo: DeliveryPhotoSheet appears — must take delivery photo)

completed
  → RiderRatingSheet appears → driver rates rider
  → Trip moves to history
```

### Cancellation
Driver can cancel at any status (except `completed`):
```typescript
driverService.updateRideStatus(rideId, 'canceled', reason)
ride.store.setActiveTrip(null)
```

### Realtime Updates
```typescript
rideService.subscribeToRide(rideId, (updatedRide) => {
  ride.store.updateActiveTrip(updatedRide)
  // Note: updateActiveTrip() ignores stale updates
  // (checks timestamp to prevent out-of-order overwrites)
})
```

### Location Recording During Trip
```typescript
// useDriverLocation() hook active during trip
// Records location events:
locationService.recordRideLocation({
  ride_id: rideId,
  latitude, longitude, heading,
  speed, accuracy, timestamp
})
// Bulk uploads buffered locations:
locationService.bulkRecordRideLocations(batch)
```

---

## 11. Location Tracking & Background GPS

### Hook: `useDriverLocationTracking(driverId, isOnline, activeRideId)`

### Permissions
| Type | When Requested | Purpose |
|------|---------------|---------|
| Foreground | Always (when online) | Show position on map, match with riders |
| Background | During active ride only | Continue tracking when app backgrounded |

### Watch Configuration
```typescript
Location.watchPositionAsync({
  accuracy: Location.Accuracy.High,
  distanceInterval: 30,      // meters
  timeInterval: 10000,        // ms
})
```

### Stale Location Filter
Locations older than 90 seconds are ignored.

### Data Flow
```
GPS Update
  → locationStore.setLocation(lat, lng, heading)
  → driverService.updateLocation(driverId, lat, lng, heading)  // Profile broadcast
  → if activeRide:
      → locationService.recordRideLocation(...)                 // Ride history
```

### Offline Buffer (`src/services/locationBuffer.ts`)
When offline:
- Locations buffered to SQLite
- On reconnection: `locationService.bulkRecordRideLocations(batch)` flushes buffer
- Prevents location data loss during connectivity drops

---

## 12. Delivery (Cargo) Rides

### Identification
```typescript
ride.ride_mode === 'cargo'   // This is a delivery
```

### Photo Requirements
Two mandatory photos managed by `DeliveryPhotoSheet`:

#### Pickup Photo (status: `arrived_at_pickup`)
```typescript
// DeliveryPhotoSheet(phase='pickup') appears
// Driver takes photo → expo-image-picker
// deliveryService.uploadDeliveryPhoto(rideId, uri, 'pickup')
// → Updates delivery_details.pickup_photo_url
// Then: updateRideStatus('in_progress')
```

#### Delivery Photo (status: `in_progress`, before completing)
```typescript
// DeliveryPhotoSheet(phase='delivery') appears
// Driver takes photo
// deliveryService.uploadDeliveryPhoto(rideId, uri, 'delivery')
// → Updates delivery_details.delivery_photo_url
// Then: updateRideStatus('completed')
```

### Delivery Info Display
When handling a cargo ride, driver sees:
- Recipient name + phone (tap to call)
- Package description + category badge
- Weight estimate
- Special instructions
- "Client acompanando" badge if sender is riding along

---

## 13. Trip History & Detail

### File: `app/(tabs)/trips.tsx`

### Features
- Paginated FlatList (20 per page)
- Filters: status (completed/canceled), service type, payment method, date range
- Pull-to-refresh
- CSV export (expo-sharing + expo-file-system)
- Skeleton loaders
- Navigate to `/trip/[id]` for detail

### Trip Detail (`app/trip/[id].tsx`)
- Map with route polyline (from recorded location events)
- Pickup/dropoff addresses + markers
- **Fare breakdown:** Base, Distance, Time, Surge, Tip
- **Commission calculation:** 15% default rate
- **Net earnings:** Fare - Commission + Tip
- **Trip stats:** Distance, duration, payment method
- **Dispute banner:** If rider filed dispute → navigate to `/trip/dispute-respond/[disputeId]`
- **Lost item banner:** If rider reported lost item → navigate to `/trip/lost-item/[id]`
- **Timestamps:** Created, accepted, completed/canceled

### Dispute Response (`app/trip/dispute-respond/[disputeId].tsx`)
- Shows rider's dispute reason
- Text response input
- Photo evidence upload (optional)
- Submit via `disputeService.respondToDispute(disputeId, response)`

### Lost Item Response (`app/trip/lost-item/[id].tsx`)
- Shows item description from rider
- "I found it" / "I didn't find it" options
- Photo upload if found
- Status tracking

---

## 14. Earnings & Revenue

### File: `app/(tabs)/earnings.tsx`

### Features
- **EarningsBarChart:** Daily/weekly/monthly revenue visualization
- **HourlyHeatmap:** Earnings by hour + demand density
- **Commission breakdown:** Gross fare → commission (15%) → net earnings
- **Tip totals:** If applicable
- **Period selectors:** Day, week, month

### Data Source
```typescript
driverService.getEarnings(driverId, { period: 'daily' | 'weekly' | 'monthly' })
```

---

## 15. Notifications

### Push Setup (`src/hooks/useNotifications.ts`)
```typescript
// 1. Request permission (expo-notifications)
// 2. Get push token
// 3. Register: notificationService.registerPushToken(userId, token, platform)
// 4. Set handler: show notification in foreground
// 5. Handle tap → deep link to relevant screen
```

### Notification Types & Deep Links
| Type | Navigate To |
|------|-------------|
| `ride` | `/(tabs)` (home, shows incoming ride) |
| `chat` | `/chat/[rideId]` |
| `wallet` | `/(tabs)/earnings` |

### Local Notifications (Incoming Rides)
```typescript
// When new ride added to store:
Notifications.scheduleNotificationAsync({
  content: { title: 'New ride request', body: 'Pickup at...' },
  trigger: null  // immediate
})
```

### Preferences (AsyncStorage)
```
@tricigo/notifications_enabled     # Master toggle
@tricigo/notif_rides               # Ride requests
@tricigo/notif_chat                # Messages
@tricigo/notif_wallet              # Earnings
```

### SMS Alerts
```typescript
notificationService.getSmsPreference(userId)
notificationService.updateSmsPreference(userId, enabled)
```

### Auto-Accept Rides
```typescript
// Eligible if: 50+ completed trips AND 4.5+ rating
driverService.isEligibleForAutoAccept(driverId)
driverService.setAutoAccept(driverId, enabled)
// When enabled: incoming rides auto-accepted without manual tap
```

---

## 16. Chat with Rider

### File: `app/chat/[rideId].tsx`

### Store: `chat.store.ts`
- Messages array (max 200)
- Realtime via Supabase channel
- Typing indicator

### Hook
```typescript
useChat(rideId)  // Load history, subscribe, send messages
```

### Availability
Chat is only visible during an active trip. Disappears after ride completes.

---

## 17. Profile & Sub-pages

### Main Profile (`app/(tabs)/profile.tsx`)
- Driver avatar (initials from full_name)
- Driver stats: Status badge, Rating (average), Total rides
- Menu navigation
- Logout with confirmation (marks offline before signing out)

### Sub-pages

| Route | Feature |
|-------|---------|
| `/profile/edit` | Edit name, email, phone |
| `/profile/vehicle` | Vehicle details (type, plate, color) |
| `/profile/documents` | Upload/manage docs (ID, vehicle reg, inspection) with status badges (pending/approved/expired) |
| `/profile/safety` | Safety rating, violations list |
| `/profile/pricing` | Commission rate (15%), surge explanation, fare breakdown example |
| `/profile/settings` | Language, notifications (master + granular), auto-accept toggle, SMS alerts |
| `/profile/help` | FAQ accordion + support ticket form |
| `/profile/referral` | Referral code, earnings, invited drivers list |
| `/profile/reviews` | Rider ratings (1-5 stars) + comments |
| `/profile/penalties` | Violations, suspension reason, appeal form |
| `/profile/ticket-detail` | Support ticket detail + reply |

---

## 18. Offline Support

### Architecture
```
Driver action while offline
  → @tricigo/api offline queue (AsyncStorage adapter)
    → Mutation stored locally
      → OfflineBanner shows pending count + progress
        → Network restored → auto-flush queue
          → UI updated
```

### Location-Specific Offline
```
GPS update while offline
  → locationBuffer (SQLite) stores reading
    → Network restored
      → locationService.bulkRecordRideLocations(batch)
        → Buffer cleared
```

### Components
| Component | Purpose |
|-----------|---------|
| `OfflineBanner` | Shows offline status, pending mutation count, sync progress |

### Hooks
| Hook | Purpose |
|------|---------|
| `useConnectivity()` | `@react-native-community/netinfo` listener |
| `useOfflineSync()` | Processes mutation queue on reconnect |

### Registration
```typescript
// src/providers/app-providers.tsx
initOfflineQueue({ adapter: asyncStorageAdapter })
registerAllOfflineMutations()
```

---

## 19. Styling (NativeWind)

### Setup
Same as client app — `nativewind` 4.1.23, Tailwind classes.

### Config
- `tailwind.config.js` extends `@tricigo/theme/tailwind-preset`
- `darkMode: 'class'`
- Content: `app/**/*.{ts,tsx}`, `src/**/*.{ts,tsx}`, `../../packages/ui/src/**/*.{ts,tsx}`

### Theme Colors
| Token | Value | Usage |
|-------|-------|-------|
| `brand-orange` | `#F97316` | Primary, active states |
| `neutral-50..950` | Grayscale | Backgrounds, text |
| `success` | `#22c55e` | Completed trips, earnings |
| `error` | `#ef4444` | Errors, cancellations |
| `warning` | `#f59e0b` | Pending, warnings |

### Shared UI Components (`@tricigo/ui`)
- `Screen`, `Text`, `Button`, `Input`, `Card`
- `StatusStepper` (onboarding)
- `HistoryFilters` (trip history)
- `Skeleton`, `EmptyState`, `ErrorState`

---

## 20. Shared Packages

| Package | Import | Used For |
|---------|--------|----------|
| `@tricigo/api` | Services, Supabase client | All backend calls |
| `@tricigo/types` | TypeScript interfaces | Ride, Driver, Vehicle types |
| `@tricigo/i18n` | `useTranslation('driver')` | All UI text |
| `@tricigo/theme` | Colors, tailwind preset | NativeWind theme |
| `@tricigo/ui` | Shared RN components | Buttons, Inputs, Cards |
| `@tricigo/utils` | Geo, pricing, formatting | Distance calc, fare formatting |

### i18n Namespace
Driver app uses `driver` namespace:
```typescript
const { t } = useTranslation('driver')
t('home.go_online')          // "Conectarse"
t('trip.status_en_route')    // "En camino al punto"
```
Translation files: `packages/i18n/src/locales/{es,en,pt}/driver.json`

---

## 21. Services & Hooks Reference

### API Services Used (from `@tricigo/api`)
| Service | Key Methods |
|---------|-------------|
| `authService` | `sendOTP`, `verifyOTP`, `getCurrentUser`, `signOut`, `onAuthStateChange` |
| `driverService` | `getProfile`, `updateLocation`, `setOnlineStatus`, `acceptRide`, `updateRideStatus`, `getTripHistoryFiltered`, `isEligibleForAutoAccept`, `setAutoAccept`, `getEarnings` |
| `locationService` | `recordRideLocation`, `bulkRecordRideLocations`, `getRideLocationEvents` |
| `rideService` | `getRideWithDriver`, `getPricingSnapshot`, `subscribeToRide` |
| `deliveryService` | `uploadDeliveryPhoto`, `getDeliveryDetails` |
| `disputeService` | `getDisputeByRide`, `respondToDispute` |
| `lostItemService` | `getLostItemByRide`, `respondToLostItem` |
| `notificationService` | `registerPushToken`, `removePushToken`, `getSmsPreference`, `updateSmsPreference` |
| `walletService` | `getBalance`, `getTransactions` |

### Local Services (`src/services/`)
| Service | Purpose |
|---------|---------|
| `locationBuffer.ts` | SQLite-based GPS buffering for offline |

### Custom Hooks (`src/hooks/`)
| Hook | Purpose |
|------|---------|
| `useAuth` | Auth init + realtime `driver_profiles` sync |
| `useNotifications` | Push token, handlers, deep links |
| `useDriverLocation` | GPS tracking + offline buffer + profile broadcast |
| `useMapboxOffline` | Weekly Havana tile downloads |
| `useDriverRide` | Active trip lifecycle management |
| `useDriverETA` | ETA calculations |
| `useRoutePolyline` | Route polyline fetching |
| `useDemandHeatmap` | Demand visualization data |
| `useChat` | Chat messages + realtime |
| `useSelfieCheck` | Selfie liveness verification for onboarding |
| `useInAppNavigation` | Deep link routing |

---

## 22. Build & Deploy (EAS)

### EAS Config (`eas.json`)
| Profile | Distribution | Client | Env |
|---------|-------------|--------|-----|
| `development` | Internal | Dev client | Supabase + Mapbox tokens |
| `preview` | Internal | Release | Same |
| `production` | Store | Release | Production keys |

### Build Commands
```bash
eas build --platform ios --profile development
eas build --platform android --profile development
eas build --platform all --profile production
```

### App Store Info (`app.json`)
```json
{
  "name": "TriciGo Conductor",
  "slug": "tricigo-driver",
  "scheme": "tricigo-driver",
  "ios.bundleIdentifier": "app.tricigo.driver",
  "android.package": "app.tricigo.driver"
}
```

### Permissions
| Permission | Platform | Reason |
|-----------|----------|--------|
| `ACCESS_FINE_LOCATION` | Android | Driver tracking |
| `ACCESS_BACKGROUND_LOCATION` | Android | Track during active ride |
| `NSLocationWhenInUseUsageDescription` | iOS | Driver tracking |
| `NSLocationAlwaysAndWhenInUseUsageDescription` | iOS | Background tracking |
| Push notifications | Both | Ride requests, chat |
| Camera | Both | Document upload, delivery photos, selfie |
| Photo library | Both | Document upload |

---

## 23. Testing & QA

### Type Check
```bash
pnpm --filter @tricigo/driver check-types
```

### Manual Test Checklist
1. **Auth:** Login → OTP → Onboarding (all 4 steps) → Pending → Approved → Tabs
2. **Go Online:** Toggle online → Verify GPS starts → See demand heatmap
3. **Accept Ride:** Receive request → Accept within 30s → Navigate to pickup
4. **Trip Lifecycle:** Accepted → En route → Arrived → In progress → Completed → Rate rider
5. **Delivery:** Accept cargo ride → Take pickup photo → Drive → Take delivery photo → Complete
6. **Offline:** Disconnect → Accept ride → Location buffered → Reconnect → Verify sync
7. **Earnings:** Check daily/weekly/monthly breakdown, commission calculation
8. **Chat:** Send/receive messages during active trip
9. **Dark mode:** Toggle → Verify all screens
10. **Push:** Receive ride request notification → Tap → Opens app to incoming ride

### Error Tracking
- Sentry: `@sentry/react-native` with PII stripping
- PostHog: Event analytics

---

## Supabase Project
- **Project ID:** `lqaufszburqvlslpcuac`
- **URL:** `https://lqaufszburqvlslpcuac.supabase.co`

## Quick Reference
- **Web Technical Reference:** `docs/WEB_CLIENT_TECHNICAL_REFERENCE.md`
- **Client App Guide:** `docs/CLIENT_APP_IMPL.md`
- **Database schema & RLS:** `supabase/migrations/`
