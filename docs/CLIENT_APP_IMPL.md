# TriciGo Client (Rider) App — Implementation Guide

> Complete technical reference for the client/rider React Native app.
> **Owner:** Persona A (client app developer)
> **Last updated:** 2026-03-30

---

## Table of Contents

1. [Team Coordination Rules](#1-team-coordination-rules)
2. [Project Setup](#2-project-setup)
3. [Architecture Overview](#3-architecture-overview)
4. [Navigation (Expo Router)](#4-navigation-expo-router)
5. [State Management (Zustand)](#5-state-management-zustand)
6. [Authentication Flow](#6-authentication-flow)
7. [Home Screen & Ride Booking](#7-home-screen--ride-booking)
8. [Map Integration (Mapbox)](#8-map-integration-mapbox)
9. [Active Ride & Tracking](#9-active-ride--tracking)
10. [Delivery (Mensajeria) Feature](#10-delivery-mensajeria-feature)
11. [Ride History](#11-ride-history)
12. [Wallet & Payments](#12-wallet--payments)
13. [Notifications](#13-notifications)
14. [Chat with Driver](#14-chat-with-driver)
15. [Profile & Sub-pages](#15-profile--sub-pages)
16. [Offline Support](#16-offline-support)
17. [Styling (NativeWind)](#17-styling-nativewind)
18. [Shared Packages](#18-shared-packages)
19. [Services & Hooks Reference](#19-services--hooks-reference)
20. [Build & Deploy (EAS)](#20-build--deploy-eas)
21. [Testing & QA](#21-testing--qa)

---

## 1. Team Coordination Rules

Two developers work in parallel: **Persona A** (this app) and **Persona B** (driver app). These rules prevent conflicts.

### Ownership Boundaries

| Area | Owner | Others: Read-Only |
|------|-------|--------------------|
| `apps/client/**` | **Persona A** | Persona B must NOT edit |
| `apps/driver/**` | **Persona B** | Persona A must NOT edit |
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
4. **New translations in `@tricigo/i18n`:** Each app uses its own namespace (`rider` for client, `driver` for driver). Only edit your namespace. `common` namespace requires coordination.
5. **Database migrations:** Only ONE person creates a migration at a time. Use Slack/chat to claim: "I'm writing migration XXX." Migrations must be sequential — never create two in parallel.
6. **Git branches:** Use prefix `client/` for all branches (e.g., `client/fix-wallet-refresh`). Persona B uses `driver/`. This prevents confusion.

### Conflict Resolution

- If both need to modify the same shared file: the first person to push wins. The second must rebase.
- If a breaking change in `packages/*` is needed: create a PR, tag the other dev for review before merging.
- Daily sync (5 min): "What shared packages did you touch today?"

---

## 2. Project Setup

### Location
```
apps/client/          # Root of the client app
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
| mapbox-gl | 3.20.0 | Web maps fallback |
| @supabase/supabase-js | 2.49.1 | Backend client |
| @tanstack/react-query | 5.66.0 | Data fetching/caching |
| expo-notifications | 55.0.12 | Push notifications |
| expo-location | 55.1.2 | GPS |
| @sentry/react-native | 7.11.0 | Error tracking |
| posthog-react-native | 4.37.2 | Analytics |
| i18next | 24.2.2 | Internationalization |

### Scripts
```bash
pnpm --filter @tricigo/client dev          # Start Expo dev server
pnpm --filter @tricigo/client build        # Type check (tsc --noEmit)
pnpm --filter @tricigo/client lint         # ESLint
pnpm --filter @tricigo/client check-types  # TypeScript check
```

### Environment Variables (`.env`)
```
EXPO_PUBLIC_SUPABASE_URL=https://lqaufszburqvlslpcuac.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<key>
EXPO_PUBLIC_MAPBOX_TOKEN=<token>        # Set in EAS secrets for builds
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
apps/client/
├── app/                            # Expo Router pages
│   ├── _layout.tsx                 # Root: auth gate + routing logic
│   ├── (auth)/                     # Login & verification
│   │   ├── _layout.tsx
│   │   ├── login.tsx
│   │   ├── verify-otp.tsx
│   │   ├── verify-phone.tsx        # Social login → phone verification
│   │   └── complete-profile.tsx    # New user profile setup
│   ├── (tabs)/                     # Main 4-tab layout
│   │   ├── _layout.tsx             # Tabs: Home, Rides, Wallet, Profile
│   │   ├── index.tsx               # Home (booking)
│   │   ├── rides.tsx               # Ride history
│   │   ├── wallet.tsx              # TriciCoin wallet
│   │   └── profile.tsx             # Profile hub
│   ├── profile/                    # 14 profile sub-pages
│   │   ├── _layout.tsx
│   │   ├── edit.tsx
│   │   ├── settings.tsx
│   │   ├── saved-locations.tsx
│   │   ├── emergency-contact.tsx
│   │   ├── trusted-contacts.tsx
│   │   ├── safety.tsx
│   │   ├── referral.tsx
│   │   ├── recurring-rides.tsx
│   │   ├── ride-preferences.tsx
│   │   ├── corporate.tsx
│   │   ├── about.tsx
│   │   ├── blog.tsx
│   │   ├── help.tsx
│   │   └── ticket-detail.tsx
│   ├── ride/                       # Ride detail & post-ride
│   │   ├── _layout.tsx
│   │   ├── [id].tsx                # Single ride detail
│   │   ├── dispute/[rideId].tsx
│   │   ├── lost-item/[rideId].tsx
│   │   └── share/[token].tsx       # Public share link
│   ├── chat/
│   │   ├── _layout.tsx
│   │   └── [rideId].tsx            # Chat with driver
│   ├── notifications/
│   │   └── index.tsx
│   ├── refer/[code].tsx            # Referral deep link
│   ├── promo/[code].tsx            # Promo deep link
│   └── +not-found.tsx
│
├── src/
│   ├── stores/                     # Zustand stores (5)
│   │   ├── auth.store.ts
│   │   ├── ride.store.ts
│   │   ├── notification.store.ts
│   │   ├── chat.store.ts
│   │   └── theme.store.ts
│   ├── hooks/                      # Custom hooks (19)
│   ├── components/                 # Reusable components (17)
│   ├── services/                   # Local services (6)
│   ├── providers/
│   │   └── app-providers.tsx       # React Query, PostHog, offline
│   ├── lib/
│   │   ├── useAuth.ts              # Auth initialization
│   │   └── sentry.ts
│   ├── config/
│   │   └── ride.ts                 # Ride constants
│   └── utils/
│       └── vehicleImages.ts
│
├── assets/                         # Images, sounds, icons
├── app.json                        # Expo config
├── tsconfig.json
├── tailwind.config.js
├── metro.config.js
├── babel.config.js
└── eas.json                        # EAS Build config
```

### Data Flow
```
User Action
  → Hook (useRide, useChat, etc.)
    → Zustand Store (ride.store, chat.store)
      → @tricigo/api Service (rideService, chatService)
        → Supabase (PostgreSQL + Realtime)
          → Realtime subscription updates store
            → UI re-renders
```

---

## 4. Navigation (Expo Router)

### Root Layout (`app/_layout.tsx`)
Auth-based routing:
```
Not authenticated           → /(auth)/login
Authenticated, no full_name → /(auth)/complete-profile
Authenticated, no phone     → /(auth)/verify-phone
Authenticated, complete     → /(tabs)
```
Public deep links (`refer`, `promo`) bypass auth.

### Tab Layout (`app/(tabs)/_layout.tsx`)
4 tabs with Ionicons:
| Tab | Route | Icon |
|-----|-------|------|
| Home | `/(tabs)/` | `home` |
| Rides | `/(tabs)/rides` | `car` |
| Wallet | `/(tabs)/wallet` | `wallet` |
| Profile | `/(tabs)/profile` | `person` |

### Dynamic Routes
| Route | Param | Purpose |
|-------|-------|---------|
| `/ride/[id]` | `id` (UUID) | Ride detail |
| `/ride/dispute/[rideId]` | `rideId` | File dispute |
| `/ride/lost-item/[rideId]` | `rideId` | Report lost item |
| `/ride/share/[token]` | `token` | Public tracking |
| `/chat/[rideId]` | `rideId` | In-ride chat |
| `/refer/[code]` | `code` | Referral |
| `/promo/[code]` | `code` | Promo code |

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

### ride.store.ts
```typescript
interface RideState {
  flowStep: 'idle' | 'selecting' | 'reviewing' | 'searching' | 'active' | 'completed'
  draft: RideRequestDraft     // pickup, dropoff, serviceType, paymentMethod
  fareEstimate: FareEstimate | null
  activeRide: Ride | null
  rideWithDriver: RideWithDriver | null
  delivery: DeliveryDraft     // mensajeria fields
  waypoints: LocationDraft[]  // max 5 stops
  splits: RideSplit[]         // fare splitting
  promoCode: string
  promoResult: PromoResult | null
  corporateAccountId: string | null
  isLoading: boolean
  isFareEstimating: boolean
  error: string | null
}
```

### notification.store.ts
```typescript
interface NotificationState {
  unreadCount: number
  notifications: AppNotification[]
  isLoading: boolean
  setUnreadCount(n: number): void
  incrementUnread(): void
  markRead(id: string): void
  markAllRead(): void
}
```

### chat.store.ts
```typescript
interface ChatState {
  messages: ChatMessage[]     // Max 200 kept
  isLoading: boolean
  remoteTyping: boolean
  setMessages(msgs: ChatMessage[]): void
  addMessage(msg: ChatMessage): void
  setRemoteTyping(typing: boolean): void
  reset(): void
}
```

### theme.store.ts
```typescript
// Via @tricigo/theme createThemeStore()
// Persists to AsyncStorage: '@tricigo/theme_mode'
// Values: 'light' | 'dark' | 'system'
```

---

## 6. Authentication Flow

### Phone OTP (Primary)
```
1. login.tsx: User enters phone (+53XXXXXXXX)
2. authService.sendOTP(phone) → SMS sent
3. verify-otp.tsx: User enters 6-digit code
4. authService.verifyOTP(phone, code) → Session created
5. authService.getCurrentUser() → User object
6. customerService.ensureProfile(userId) → Profile created/fetched
7. Auth store updated → Root layout routes to /(tabs)
```

### Social Login (Google/Apple)
```
1. login.tsx: User taps Google/Apple
2. authService.signInWithGoogle/Apple() → OAuth flow
3. verify-phone.tsx: User adds phone number (required for Cuban market)
4. complete-profile.tsx: User fills name if missing
5. Route to /(tabs)
```

### Session Persistence
- `useAuthInit()` hook in `src/lib/useAuth.ts`
- Checks SecureStore (native) / localStorage (web) for existing session
- `authService.onAuthStateChange()` keeps UI in sync
- 15-second timeout safety if init is slow

### Sign Out
```typescript
// Clears all stores in sequence:
authService.signOut()
useAuthStore.reset()
useRideStore.reset()
useChatStore.reset()
useNotificationStore.reset()
// → Redirects to /(auth)/login
```

---

## 7. Home Screen & Ride Booking

### File: `app/(tabs)/index.tsx`

### Booking Flow (ride.store flowStep)
```
idle → User opens app, sees map with nearby vehicles
  ↓ taps "Where to?"
selecting → AddressSearchInput for pickup + dropoff
  ↓ both set
reviewing → Service type cards, fare estimate, payment method
  ↓ taps "Request Ride"
searching → rideService.createRide() called, waiting for driver
  ↓ driver accepts
active → RideActiveView shows driver location, ETA, status
  ↓ ride completes
completed → RideCompleteView shows rating, fare summary
  ↓ user rates
idle → Reset
```

### Ride Request Parameters
```typescript
rideService.createRide({
  service_type,           // 'triciclo_basico' | 'moto_standard' | 'auto_standard' | 'auto_confort' | 'mensajeria'
  payment_method,         // 'cash' | 'tricicoin' | 'corporate'
  pickup_latitude, pickup_longitude, pickup_address,
  dropoff_latitude, dropoff_longitude, dropoff_address,
  estimated_fare_cup, estimated_distance_m, estimated_duration_s,
  waypoints?,             // Multi-stop (max 5)
  scheduled_at?,          // Future ride
  promo_code_id?, discount_amount_cup?,
  insurance_selected?, insurance_premium_cup?,
  ride_mode,              // 'passenger' | 'cargo'
  delivery_details?,      // If mensajeria
  rider_preferences?,     // From saved profile
  corporate_account_id?,  // Corporate billing
})
```

### Stale Pricing Protection
Fare is re-estimated at request time. If price changed >5% from original estimate, user is warned and must re-confirm.

### Key Components
| Component | File | Purpose |
|-----------|------|---------|
| `RideMapView` | `src/components/RideMapView.tsx` | Map with markers, polyline, nearby vehicles |
| `RideActiveView` | `src/components/RideActiveView.tsx` | Active ride UI (driver position, timer) |
| `RideCompleteView` | `src/components/RideCompleteView.tsx` | Post-ride rating & summary |
| `AddressSearchInput` | `src/components/AddressSearchInput.tsx` | Autocomplete address |
| `ConfirmLocationScreen` | `src/components/ConfirmLocationScreen.tsx` | Pin drop confirmation |
| `FareSplitSheet` | `src/components/FareSplitSheet.tsx` | Fare splitting UI |
| `CancelRideSheet` | `src/components/CancelRideSheet.tsx` | Cancellation flow |
| `SafetySheet` | `src/components/SafetySheet.tsx` | Emergency actions |

### Key Hooks
| Hook | File | Purpose |
|------|------|---------|
| `useRide` | `src/hooks/useRide.ts` | Main ride booking/actions |
| `useNearbyVehicles` | `src/hooks/useNearbyVehicles.ts` | Map vehicle markers |
| `useRoutePolyline` | `src/hooks/useRoutePolyline.ts` | Route line on map |
| `useDriverPosition` | `src/hooks/useDriverPosition.ts` | Driver location updates |
| `useAnimatedPosition` | `src/hooks/useAnimatedPosition.ts` | Smooth marker animation |
| `useETA` | `src/hooks/useETA.ts` | ETA calculation |
| `useCorporateAccounts` | `src/hooks/useCorporateAccounts.ts` | Corporate account selection |
| `useDeliveryVehicles` | `src/hooks/useDeliveryVehicles.ts` | Delivery vehicle options |
| `useRecentAddresses` | `src/hooks/useRecentAddresses.ts` | Recent pickup/dropoff cache |
| `useDestinationPredictions` | `src/hooks/useDestinationPredictions.ts` | Address autocomplete |

---

## 8. Map Integration (Mapbox)

### Native: `@rnmapbox/maps`
- MapView with `Mapbox.StyleURL.Street` style
- Camera auto-fits bounds to pickup + dropoff + driver
- Markers: pickup (green), dropoff (orange), nearby vehicles
- Route polyline from Mapbox Directions API

### Web: `mapbox-gl`
- `WebMapView.tsx` component for web platform
- Metro config stubs `@rnmapbox/maps` on web
- `Platform.OS === 'web'` detection to switch components

### Offline Maps
```typescript
// useMapboxOffline() hook
// Downloads Havana region tiles weekly
// Bounds: Havana city center + suburbs
// Zoom levels: 10-14
// Stored on device via MapboxGL.offlineManager
```

### Geocoding & Routing
```typescript
// src/services/mapbox.service.ts
fetchRouteETA(pickup, dropoff)     // Mapbox Directions API, 30s cache
reverseGeocode(lat, lng)           // Coords → address
searchAddress(query, proximity)    // Text → coords

// Caching services:
// src/services/geocodeCache.ts     → Reverse geocode results
// src/services/predictionCache.ts  → Autocomplete predictions
// src/services/driverPositionCache.ts → Driver positions
```

---

## 9. Active Ride & Tracking

### Realtime Subscription
```typescript
rideService.subscribeToRide(rideId, (updatedRide) => {
  useRideStore.setActiveRide(updatedRide)
})
```

### Status Steps (6-step progress)
```
1. searching        → "Buscando conductor"
2. accepted         → "Conductor asignado"
3. driver_en_route  → "En camino a recogerte"
4. arrived_at_pickup → "Llego al punto"
5. in_progress      → "Viaje en curso"
6. completed        → "Viaje completado"
```

### Driver Location Display
- Realtime updates from `driver_profiles.current_location`
- `useDriverPosition()` subscribes to changes
- `useAnimatedPosition()` smooths marker movement
- `useETA()` calculates arrival time

### Ride Sharing
- Share token generated at ride creation
- `/ride/share/[token]` is a public route (no auth required)
- `useRiderLocationSharing()` hook manages sharing with trusted contacts

---

## 10. Delivery (Mensajeria) Feature

### Delivery Fields (in ride.store)
```typescript
delivery: {
  package_description: string
  recipient_name: string
  recipient_phone: string
  estimated_weight_kg: number | null
  special_instructions: string
  package_category: 'documentos' | 'comida' | 'paquete_pequeno' | 'paquete_grande' | 'fragil'
  package_length_cm: number | null
  package_width_cm: number | null
  package_height_cm: number | null
  client_accompanies: boolean
}
```

### Delivery Vehicle Selection
- `useDeliveryVehicles()` fetches available vehicle types that accept cargo
- User chooses: triciclo, moto, or auto for delivery
- Uses SAME fare rates as passenger rides for the selected vehicle

### Tracking Labels (cargo mode)
| Status | Label |
|--------|-------|
| `accepted` | "Conductor va a recoger tu paquete" |
| `arrived_at_pickup` | "Recogiendo paquete" |
| `in_progress` | "Paquete en camino" |
| `completed` | "Entregado" |

### 2-Photo Flow (Driver Side)
Photos appear in client tracking when taken:
1. Pickup photo → "El conductor recogio tu paquete"
2. Delivery photo → "Tu paquete fue entregado"

---

## 11. Ride History

### File: `app/(tabs)/rides.tsx`

### Features
- Paginated list (FlatList)
- Filters: date range, service type, payment method
- CSV export (expo-sharing + expo-file-system)
- Pull-to-refresh
- Skeleton loaders during fetch
- Navigate to `/ride/[id]` for detail

### Ride Detail (`app/ride/[id].tsx`)
- Map with route polyline
- Pickup/dropoff addresses
- Fare breakdown (base, distance, time, surge, discount, insurance)
- Dispute filing → `/ride/dispute/[rideId]`
- Lost item report → `/ride/lost-item/[rideId]`

---

## 12. Wallet & Payments

### File: `app/(tabs)/wallet.tsx`

### Features
- Balance display (animated card)
- Recharge via TropiPay (phone top-up integration)
- Transaction history with filters (recharge, ride payment, transfers, commission)
- P2P transfers between users

### Services Used
```typescript
walletService.getBalance(userId)
walletService.getTransactions(accountId, { limit, offset, filter })
walletService.transfer(fromId, toId, amount, note)
walletService.ensureAccount(userId)
paymentService.createRechargeLink(userId, amountCup)
exchangeRateService.getCurrentRate()
```

---

## 13. Notifications

### Push Setup
```typescript
// src/hooks/useNotifications.ts
// 1. Request permission via expo-notifications
// 2. Get push token → notificationService.registerPushToken(userId, token, platform)
// 3. Set notification handler for foreground display
// 4. Handle notification tap → deep link to relevant screen
```

### In-App Inbox (`app/notifications/index.tsx`)
```typescript
notificationService.getInboxNotifications(userId, { limit: 50 })
notificationService.subscribeToNotifications(userId, onNew)
notificationService.markAsRead(notificationId)
```

### Notification Types & Deep Links
| Type | Navigate To |
|------|-------------|
| `ride_update` | `/ride/[rideId]` |
| `driver_assigned` | `/(tabs)` (home, shows active ride) |
| `wallet_credit` | `/(tabs)/wallet` |
| `chat_message` | `/chat/[rideId]` |
| `promo` | `/promo/[code]` |

---

## 14. Chat with Driver

### File: `app/chat/[rideId].tsx`

### Store: `chat.store.ts`
- Max 200 messages kept in memory
- Real-time via Supabase channel subscription
- Typing indicator support (`remoteTyping`)

### Hooks
```typescript
useChat(rideId)  // Load messages, subscribe to new ones, send
```

---

## 15. Profile & Sub-pages

### Main Profile (`app/(tabs)/profile.tsx`)
- User info display (avatar, name, phone)
- Menu navigation to 14 sub-pages

### Sub-pages

| Route | Feature |
|-------|---------|
| `/profile/edit` | Edit name, email, avatar |
| `/profile/settings` | Language, notifications, theme |
| `/profile/saved-locations` | CRUD saved addresses (with map) |
| `/profile/emergency-contact` | Single emergency contact |
| `/profile/trusted-contacts` | Multiple contacts for ride sharing |
| `/profile/safety` | SOS button, safety preferences |
| `/profile/referral` | Referral code, invite tracking |
| `/profile/recurring-rides` | Schedule recurring bookings |
| `/profile/ride-preferences` | Quiet mode, temperature, accessibility |
| `/profile/corporate` | Corporate account management |
| `/profile/about` | App version, info |
| `/profile/blog` | In-app news/blog |
| `/profile/help` | FAQ + support tickets |
| `/profile/ticket-detail` | Single support ticket detail |

---

## 16. Offline Support

### Architecture
```
User triggers action while offline
  → @tricigo/api offline queue (AsyncStorage adapter)
    → Mutation stored locally
      → useOfflineSync() detects reconnection
        → Queue processed automatically
          → UI updated with server response
```

### Components
- `OfflineBanner.tsx` — Shows offline status + pending mutation count
- `useConnectivity()` — Monitors network via `@react-native-community/netinfo`
- `useOfflineSync()` — Processes queue on reconnect
- `useMapboxOffline()` — Weekly map tile downloads

### Offline Queue Registration
```typescript
// src/providers/app-providers.tsx
initOfflineQueue({ adapter: asyncStorageAdapter })
registerAllOfflineMutations()  // Registers ride create, wallet transfer, etc.
```

---

## 17. Styling (NativeWind)

### Setup
- `nativewind` 4.1.23 — Tailwind classes in React Native
- `tailwind.config.js` extends `@tricigo/theme/tailwind-preset`
- Dark mode: `darkMode: 'class'`
- Content paths: `app/**/*.{ts,tsx}`, `src/**/*.{ts,tsx}`, `../../packages/ui/src/**/*.{ts,tsx}`

### Usage Pattern
```tsx
<View className="flex-row items-center gap-2 px-4 py-3 rounded-xl bg-white dark:bg-neutral-900">
  <Text className="text-lg font-semibold text-neutral-900 dark:text-white">Title</Text>
</View>
```

### Theme Colors (from @tricigo/theme)
| Token | Value | Usage |
|-------|-------|-------|
| `brand-orange` | `#FF4D00` / `#F97316` | Primary CTA, active states |
| `neutral-50..950` | Grayscale | Backgrounds, text, borders |
| `success` | `#22c55e` | Completed rides, positive amounts |
| `error` | `#ef4444` | Errors, cancellations, negative amounts |
| `warning` | `#f59e0b` | Warnings, pending states |

### Shared UI Components (`@tricigo/ui`)
- `Screen`, `Text`, `Button`, `Input`, `Card`
- `StatusStepper`, `HistoryFilters`
- `Skeleton`, `EmptyState`, `ErrorState`

---

## 18. Shared Packages

| Package | Import | Used For |
|---------|--------|----------|
| `@tricigo/api` | Services, Supabase client | All backend calls |
| `@tricigo/types` | TypeScript interfaces | Ride, User, Vehicle, Wallet types |
| `@tricigo/i18n` | `useTranslation('rider')` | All UI text |
| `@tricigo/theme` | Colors, tailwind preset | NativeWind theme |
| `@tricigo/ui` | Shared RN components | Buttons, Inputs, Cards |
| `@tricigo/utils` | Geo, pricing, formatting | Distance calc, fare formatting |

### i18n Namespace
Client app uses `rider` namespace:
```typescript
const { t } = useTranslation('rider')
t('home.where_to')        // "A donde vas?"
t('ride.status_searching') // "Buscando conductor"
```
Translation files: `packages/i18n/src/locales/{es,en,pt}/rider.json`

---

## 19. Services & Hooks Reference

### Local Services (`src/services/`)
| Service | Purpose |
|---------|---------|
| `mapbox.service.ts` | Route ETA, geocoding (30s cache) |
| `push.service.ts` | Push notification registration & handling |
| `recentAddresses.ts` | AsyncStorage cache for recent addresses |
| `predictionCache.ts` | Address autocomplete cache |
| `geocodeCache.ts` | Reverse geocoding cache |
| `driverPositionCache.ts` | Driver position cache |

### Custom Hooks (`src/hooks/`)
| Hook | Purpose |
|------|---------|
| `useAuth` | Current user context |
| `useRide` | Main ride booking + actions |
| `useNearbyVehicles` | Nearby drivers for map |
| `useRoutePolyline` | Route geometry from Mapbox |
| `useDriverPosition` | Subscribe to driver location |
| `useAnimatedPosition` | Smooth marker animation |
| `useETA` | ETA calculation |
| `useConnectivity` | Network status |
| `useOfflineSync` | Process offline queue |
| `useDeepLinkHandler` | Route deep links |
| `useMapboxOffline` | Download offline tiles |
| `useRecentAddresses` | Recent address cache |
| `useDestinationPredictions` | Address autocomplete |
| `useCorporateAccounts` | Corporate account list |
| `useDeliveryVehicles` | Delivery vehicle options |
| `useRiderLocationSharing` | Share location with contacts |
| `useChat` | Chat messages & realtime |
| `useNotifications` | Push + inbox management |
| `useSurgeZones` | Surge pricing zones (disabled) |

---

## 20. Build & Deploy (EAS)

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
  "name": "TriciGo",
  "slug": "tricigo-client",
  "scheme": "tricigo",
  "ios.bundleIdentifier": "app.tricigo.client",
  "android.package": "app.tricigo.client"
}
```

### Permissions
| Permission | Platform | Reason |
|-----------|----------|--------|
| `ACCESS_FINE_LOCATION` | Android | Find nearby drivers |
| `NSLocationWhenInUseUsageDescription` | iOS | Find nearby drivers |
| Push notifications | Both | Ride updates, chat |
| Camera | Both | Profile photo, delivery photos |
| Photo library | Both | Profile photo upload |

---

## 21. Testing & QA

### Type Check
```bash
pnpm --filter @tricigo/client check-types
```

### Manual Test Checklist
1. **Auth:** Login → OTP → Profile complete → Tabs
2. **Booking:** Select pickup/dropoff → Estimate fare → Request → Track → Rate
3. **Delivery:** Switch to mensajeria → Fill delivery form → Select vehicle → Request
4. **Wallet:** View balance → Recharge → View transactions
5. **Offline:** Disconnect → Attempt action → Reconnect → Verify sync
6. **Dark mode:** Toggle → Verify all screens
7. **Deep links:** `tricigo://refer/CODE`, `tricigo://promo/CODE`
8. **Push:** Send test notification → Verify display + deep link

### Error Tracking
- Sentry: `@sentry/react-native` captures unhandled errors
- PostHog: Event analytics for user flows

---

## Supabase Project
- **Project ID:** `lqaufszburqvlslpcuac`
- **URL:** `https://lqaufszburqvlslpcuac.supabase.co`

## Quick Reference
- **Web Technical Reference:** `docs/WEB_CLIENT_TECHNICAL_REFERENCE.md`
- **Driver App Guide:** `docs/DRIVER_APP_IMPL.md`
- **Database schema & RLS:** `supabase/migrations/`
