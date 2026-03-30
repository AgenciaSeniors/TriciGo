# TriciGo Web Client - Technical Reference

> Reference document for the mobile client app team. Covers everything implemented in the web client, backend services, DB schema, and integration patterns.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Routes & Pages](#2-routes--pages)
3. [Authentication Flow](#3-authentication-flow)
4. [Booking & Ride Creation](#4-booking--ride-creation)
5. [Delivery (Mensajeria) Feature](#5-delivery-mensajeria-feature)
6. [Fare Estimation & Dynamic Pricing](#6-fare-estimation--dynamic-pricing)
7. [Real-Time Tracking](#7-real-time-tracking)
8. [Notifications](#8-notifications)
9. [Internationalization (i18n)](#9-internationalization-i18n)
10. [Profile & User Features](#10-profile--user-features)
11. [API Services Reference](#11-api-services-reference)
12. [Database Schema](#12-database-schema)
13. [Ride Status FSM](#13-ride-status-fsm)
14. [Key Utilities](#14-key-utilities)
15. [Bugs Fixed & Lessons Learned](#15-bugs-fixed--lessons-learned)
16. [UI & Design System](#16-ui--design-system)
17. [Corporate Booking](#17-corporate-booking)
18. [Wallet & Payments (TropiPay)](#18-wallet--payments-tropipay)

---

## 1. Architecture Overview

```
TriciGo Monorepo (Turborepo + pnpm)
├── apps/
│   ├── web/          # Next.js 15 (App Router) - Client web
│   ├── driver/       # React Native (Expo) - Driver app
│   └── admin/        # Next.js - Admin panel
├── packages/
│   ├── api/          # Supabase services, Zod schemas, business logic
│   ├── i18n/         # i18next config + 3 languages x 5 namespaces
│   ├── types/        # Shared TypeScript interfaces
│   ├── theme/        # Colors, spacing, design tokens
│   ├── ui/           # Shared React Native components (Text, Button, Card)
│   ├── utils/        # Geo, pricing, formatting, haptics, sounds
│   └── config/       # TSConfig, ESLint presets
└── supabase/
    └── migrations/   # 85+ SQL migration files
```

**Tech Stack:**
- **Web Framework:** Next.js 15 (App Router, Server Components where possible)
- **Database:** Supabase (PostgreSQL + Auth + Storage + Realtime + Edge Functions)
- **Maps:** Mapbox GL JS
- **State:** React hooks (no Redux/Zustand)
- **Styling:** CSS custom properties + design tokens + utility classes (no Tailwind)
- **Deploy:** VPS (PM2) at tricigo.com

---

## 2. Routes & Pages

### Public Routes
| Route | Description |
|-------|-------------|
| `/` | Landing page (HomeClient.tsx) |
| `/blog` | Blog list |
| `/blog/[slug]` | Blog post detail |
| `/privacy` | Privacy policy |
| `/terms` | Terms & conditions |
| `/login` | Phone OTP + Social login |
| `/auth/callback` | OAuth redirect handler |

### Authenticated Routes
| Route | Description |
|-------|-------------|
| `/book` | Ride booking (map, vehicle selection, fare estimation) |
| `/track/[id]` | Real-time ride tracking |
| `/track/share/[token]` | Shared tracking link (public, no auth) |
| `/rides` | Ride history list |
| `/rides/[id]` | Ride detail |
| `/rides/[id]/dispute` | File a dispute |
| `/rides/[id]/lost-item` | Report lost item |
| `/wallet` | Balance, transactions, transfers |
| `/notifications` | Notification inbox |
| `/promo/[code]` | Promo code landing |
| `/refer/[code]` | Referral landing |

### Profile Routes (13 sub-pages)
| Route | Description |
|-------|-------------|
| `/profile` | Profile hub with menu |
| `/profile/edit` | Edit name, phone, avatar |
| `/profile/settings` | Language, notifications, theme |
| `/profile/saved-locations` | Home, work, custom saved addresses |
| `/profile/ride-preferences` | Quiet mode, temperature, accessibility |
| `/profile/safety` | SOS, safety features |
| `/profile/emergency-contact` | Emergency contact setup |
| `/profile/trusted-contacts` | Trusted contact list |
| `/profile/corporate` | Corporate account settings |
| `/profile/recurring-rides` | Scheduled recurring rides |
| `/profile/referral` | Referral program |
| `/profile/help` | FAQ & support |
| `/profile/about` | App info |

---

## 3. Authentication Flow

### Phone OTP (Primary)
```
1. User enters phone (+53XXXXXXXX)
2. Client calls: supabase.functions.invoke('send-sms-otp', { phone })
3. User enters 6-digit OTP
4. Client calls: supabase.functions.invoke('verify-whatsapp-otp', { phone, code })
5. Response: { access_token, refresh_token }
6. Client calls: supabase.auth.setSession({ access_token, refresh_token })
7. Redirect to /book
```

### Social Login (Google/Apple)
```
1. supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: '/auth/callback' } })
2. /auth/callback handles session extraction
```

### Session Management
- `AuthProvider` in `providers.tsx` wraps the entire app
- `useAuth()` hook provides: `user`, `isAuthenticated`, `isLoading`, `signOut()`
- Session persistence via Supabase's built-in cookie/localStorage handling
- Auth state listener: `supabase.auth.onAuthStateChange()` keeps UI in sync
- All API calls use `getSupabaseClient()` which shares the same session

---

## 4. Booking & Ride Creation

### File: `apps/web/src/app/book/page.tsx` (~1,562 lines)

### State
```typescript
// Location
pickup: { lat, lng } | null
dropoff: { lat, lng } | null
selectionStep: 'pickup' | 'dropoff' | 'done'
pickupAddress, dropoffAddress: string

// Ride config
serviceType: 'triciclo_basico' | 'moto_standard' | 'auto_standard' | 'auto_confort' | 'mensajeria'
paymentMethod: 'cash' | 'tricicoin'
selectedEstimate: FareEstimate | null
allEstimates: Record<string, FareEstimate>

// Delivery (when serviceType === 'mensajeria')
deliveryDetails: {
  package_description, recipient_name, recipient_phone,
  estimated_weight_kg, special_instructions, package_category,
  package_length_cm, package_width_cm, package_height_cm,
  client_accompanies: boolean,
}
deliveryVehicle: 'triciclo_basico' | 'moto_standard' | 'auto_standard'

// Optional features
waypoints: Array<{ lat, lng, address }>  // max 5
isScheduled: boolean, scheduleDate: string
promoCode: string, promoResult: PromoValidation
insuranceSelected: boolean

// Ride preferences (loaded from customer profile)
ridePrefs: RidePreferences | null  // quiet_mode, temperature, accessibility, etc.

// Corporate booking
corporateAccounts: CorporateAccount[]
selectedCorporateId: string | null  // auto-sets paymentMethod to 'corporate'
```

### Ride Request Flow (`handleRequest()`)

```
1. Validate delivery fields if mensajeria
2. RE-ESTIMATE fare at request time (prevents stale pricing)
   - If price changed >5%, abort with warning to user
3. Call rideService.createRide({
     service_type, payment_method,
     pickup_latitude, pickup_longitude, pickup_address,
     dropoff_latitude, dropoff_longitude, dropoff_address,
     estimated_fare_cup, estimated_distance_m, estimated_duration_s,
     waypoints?, scheduled_at?, promo_code_id?, discount_amount_cup?,
     insurance_selected?, insurance_premium_cup?,
     ride_mode: serviceType === 'mensajeria' ? 'cargo' : 'passenger',
     delivery_details?: { ...deliveryDetails, delivery_vehicle_type },
     rider_preferences?: ridePrefs,          // from saved profile
     corporate_account_id?: selectedCorporateId  // corporate billing
   })
4. Redirect to /track/{rideId}
```

### Important: Stale Pricing Fix
If user estimates at 8am (normal price) but requests at 11pm (peak), the system re-estimates at request time. If the new fare differs >5%, it shows a warning and requires re-confirmation. This prevents users from getting artificially low prices.

---

## 5. Delivery (Mensajeria) Feature

### Key Design Decisions
- **Same fares as vehicle types** - No separate "mensajeria" rate. Uses the same per-km/per-min rates as the selected delivery vehicle
- **Sender can ride along** - `client_accompanies: boolean` at no extra charge
- **2 mandatory photos** - Pickup photo + delivery completion photo
- **Vehicle capacity filtering** - `find_best_drivers` RPC filters by `accepts_cargo` and dimension limits

### Data Flow
```
Booking Form (book/page.tsx)
  → delivery_details object in createRide params
  → Zod validates via createRideSchema (delivery_details optional object)
  → ride.service.ts creates ride with ride_mode='cargo'
  → deliveryService.createDeliveryDetails() inserts into delivery_details table
  → _matchDriversForRide() passes is_delivery:true to findBestDrivers()
  → Notification: "Nuevo envio disponible" to matching drivers
```

### 2-Photo Flow (Driver App)
```
Status: arrived_at_pickup
  → Show DeliveryPhotoSheet(phase='pickup')
  → Driver takes photo → uploadDeliveryPhoto(rideId, uri, 'pickup')
  → Updates pickup_photo_url in delivery_details

Status: in_progress (before completing)
  → Show DeliveryPhotoSheet(phase='delivery')
  → Driver takes photo → uploadDeliveryPhoto(rideId, uri, 'delivery')
  → Updates delivery_photo_url in delivery_details
  → Then complete ride
```

### Tracking Page Delivery UI
When `ride.ride_mode === 'cargo'`, the track page shows:
- Delivery info card (recipient name, phone, package description, category badge, weight)
- "Acompanando el envio" badge if `client_accompanies`
- Pickup and delivery photos side by side when available
- Custom status labels: "Recogiendo paquete", "Paquete en camino", "Entregado"

### Delivery Notifications (4 events)
1. **Ride accepted** → "Tu envio ha sido aceptado, el conductor va en camino"
2. **Pickup photo taken** → "El conductor recogio tu paquete"
3. **In progress** → "Tu paquete esta en camino"
4. **Completed** → "Tu paquete fue entregado"

---

## 6. Fare Estimation & Dynamic Pricing

### File: `packages/api/src/services/fare.service.ts` (via `rideService.getLocalFareEstimate()`)

### Calculation Steps
```
1. Fetch service_type_configs for base rates:
   - base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup

2. Check pricing_rules for time-based overrides:
   - Matches current hour + day_of_week against rule windows
   - Override rates if rule matches

3. Calculate distance & duration:
   - Primary: Mapbox/OSRM route API via fetchRoute()
   - Fallback: Haversine distance × 1.3 multiplier

4. Calculate base fare:
   - Passenger: baseFare + (distanceKm × perKmRate) + (durationMin × perMinRate)
   - Cargo: baseFare + (durationMin × perMinRate)  // no per-km for cargo
   - Apply minimum fare floor

5. Dynamic surge:
   - RPC: calculate_dynamic_surge(pickup_location)
   - Checks active surge_zones near pickup
   - Returns multiplier (1.0 = no surge) and reason (weather, demand, combined)

6. A/B pricing experiments:
   - Check pricing_experiments for active experiment on service_type
   - Hash user_id to deterministically assign variant A or B
   - Apply variant multiplier

7. Currency conversion:
   - CUP amount → TRC via current exchange rate

8. Fare range:
   - min = fare × 0.9, max = fare × 1.1 (±10% variance)

9. Insurance premium (optional):
   - Fetch trip_insurance_configs
   - premium = fare × premium_percent
```

### FareEstimate Response
```typescript
{
  estimated_fare_cup: number,
  estimated_fare_trc: number,
  estimated_distance_m: number,
  estimated_duration_s: number,
  surge_multiplier: number,
  surge_type: 'none' | 'weather' | 'demand' | 'combined',
  fare_range_min_cup: number,
  fare_range_max_cup: number,
  exchange_rate_usd_cup: number,
  insurance_premium_cup?: number,
  insurance_available: boolean
}
```

---

## 7. Real-Time Tracking

### File: `apps/web/src/app/track/[id]/page.tsx`

### Subscription Setup
```typescript
// Primary: Supabase Realtime
rideService.subscribeToRide(rideId, (updatedRide) => {
  setRide(updatedRide);
  // Parse driver location from ride data
});

// Fallback: Polling every 10s
setInterval(() => {
  rideService.getRideWithDriver(rideId).then(setRide);
}, 10000);
```

### Driver Location
- Stored as `GEOGRAPHY POINT` in `driver_profiles.current_location`
- Comes through Realtime as WKB hex string - needs parsing
- Displayed as moving marker on Mapbox map (TrackingMap component)

### Status Steps (6-step progress bar)
```
1. searching       → "Buscando conductor"
2. accepted        → "Conductor asignado"
3. driver_en_route → "En camino a recogerte"
4. arrived_at_pickup → "Llego al punto"
5. in_progress     → "Viaje en curso"
6. completed       → "Viaje completado"
```

---

## 8. Notifications

### Push Notifications
```typescript
// Register device token
notificationService.registerPushToken(userId, expoPushToken, 'ios'|'android')

// Send to user (with preference check)
notificationService.sendToUser(userId, title, body, sentBy, data, category)

// Categories: ride_updates, chat_messages, promotions, payment_updates, driver_approval
// User can disable categories in notification_preferences table
```

### Delivery-Specific Notifications
Sent at 4 status transitions in `driver.service.ts`:
1. `acceptRide()` → ride accepted notification to customer
2. `updateRideStatus('arrived_at_pickup')` → pickup notification
3. `updateRideStatus('in_progress')` → in transit notification
4. Completion → delivered notification

### In-App Notifications (Inbox)
```typescript
notificationService.createInboxNotification(userId, type, title, body, data)
notificationService.getInboxNotifications(userId, { unreadOnly, limit, offset })
notificationService.getUnreadCount(userId)
notificationService.markAsRead(notificationId)
notificationService.subscribeToNotifications(userId, onNotification) // Realtime
```

### Web Notification Inbox (`/notifications`)
**File:** `apps/web/src/app/notifications/page.tsx`

- Fetches up to 50 notifications via `notificationService.getInboxNotifications(userId, { limit: 50 })`
- **Real-time:** `notificationService.subscribeToNotifications()` prepends new notifications live
- **Date grouping:** Notifications grouped by date (Today / Yesterday / full date) via `useFormatDateGroup()` helper
- **Relative time:** `useFormatTime()` shows "5 mins ago", "2 hours ago", etc.
- **Icon by type:** SVG icons colored by notification type:
  - `ride_update` / `ride_completed` / `ride_canceled` → clock icon (orange)
  - `driver_assigned` / `driver_arriving` → person icon (green)
  - `wallet_credit` / `wallet_debit` → dollar icon (yellow)
  - `promo` / `referral_reward` → gift icon (red)
  - default → bell icon (gray)
- **Mark as read:** Click notification → `notificationService.markAsRead(id)`, unread dot + accent background
- **Mark all read:** Button to mark all notifications as read
- **Header badge:** Unread count shown in header with `badgePulse` animation (capped at "9+")

---

## 9. Internationalization (i18n)

### Setup
- **Library:** i18next + react-i18next
- **Languages:** es (Spanish, default), en (English), pt (Portuguese)
- **Namespaces:** common, rider, driver, admin, web
- **Files:** `packages/i18n/src/locales/{lang}/{namespace}.json`

### Web Client Integration
```typescript
// providers.tsx - Init with saved language
const savedLang = localStorage.getItem('tricigo_language');
initI18n(savedLang);

// In components
const { t, i18n } = useTranslation('web');
t('nav.book_ride')          // → "Solicitar viaje" | "Book a ride" | "Pedir viagem"
t('profile.menu_edit')      // → "Editar perfil" | "Edit profile" | "Editar perfil"

// Change language (settings page)
i18n.changeLanguage('en');
localStorage.setItem('tricigo_language', 'en');
document.documentElement.lang = 'en';
```

### Translation Keys Structure (web namespace)
```
nav.*        → Header navigation (book_ride, login, rides, wallet, profile, logout, etc.)
footer.*     → Footer links and text
home.*       → Landing page content
book.*       → Booking page (labels, placeholders, delivery fields, map instructions)
track.*      → Tracking page status labels
profile.*    → Profile menu items (menu_edit, menu_settings, etc.)
privacy.*    → Privacy policy content
terms.*      → Terms & conditions content
blog.*       → Blog listing and detail
```

### Important for Mobile App
- Same `packages/i18n` package works for React Native
- Use `useTranslation('rider')` for rider app, `useTranslation('driver')` for driver app
- `common` namespace has shared terms
- Language persistence: use AsyncStorage instead of localStorage

---

## 10. Profile & User Features

### Saved Locations
```typescript
customerService.getProfile(userId) // Returns saved_locations array
customerService.updateProfile(userId, { saved_locations: [...] })
// Each location: { label, lat, lng, address, icon }
// Icons: home, work, school, gym, custom
```

**Interactive Map (web):** `apps/web/src/app/profile/saved-locations/page.tsx`
- `SavedLocationsMap` component (dynamic import, SSR disabled) — Mapbox map
- `selectMode` state: clicking map fills form with lat/lng + reverse-geocoded address
- `AddressAutocomplete` component: Mapbox-powered search with auto-fill coordinates
- CRUD operations on `saved_locations` array via `customerService.updateProfile()`

### Ride Preferences
```typescript
customerService.getRidePreferences(userId)
customerService.updateRidePreferences(userId, {
  quiet_mode: boolean,
  conversation_ok: boolean,
  trunk_luggage: boolean,
  temperature: 'cold' | 'warm' | 'no_preference',
  accessibility: string[]  // wheelchair, hearing, visual, etc.
})
```

### Trusted Contacts (includes emergency contacts)
```typescript
trustedContactService.getContacts(userId)
trustedContactService.addContact(userId, { name, phone, relationship })
trustedContactService.removeContact(contactId)
// Used for live ride sharing via SMS
// Note: Emergency contacts were merged into trusted contacts (single list)
```

### Referral Program
```typescript
referralService.getReferralCode(userId)
referralService.getReferralStats(userId) // { total_referrals, earned_amount }
```

### Corporate Accounts
```typescript
corporateService.getAccount(userId)
corporateService.joinAccount(userId, corporateCode)
// Corporate rides: payment_method auto-set to 'corporate'
```

---

## 11. API Services Reference

All services exported from `@tricigo/api`:

| Service | Key Methods | Used In |
|---------|-------------|---------|
| `rideService` | `createRide`, `getRideWithDriver`, `subscribeToRide`, `getLocalFareEstimate`, `validatePromoCode`, `cancelRide` | book, track, rides |
| `deliveryService` | `createDeliveryDetails`, `getDeliveryDetails`, `uploadDeliveryPhoto`, `updatePickupPhoto`, `updateDeliveryPhoto` | book, track, driver |
| `driverService` | `acceptRide`, `updateRideStatus`, `getDriverProfile` | driver app |
| `nearbyService` | `subscribeToNearbyVehicles`, `getNearbyVehicleCount` | book (map) |
| `matchingService` | `findBestDrivers` | ride.service (internal) |
| `customerService` | `getProfile`, `updateProfile`, `getRidePreferences` | profile pages |
| `walletService` | `getBalance`, `getTransactions`, `transfer` | wallet |
| `notificationService` | `notifyUser`, `sendToUser`, `registerPushToken`, `getInboxNotifications` | throughout |
| `authService` | `signIn`, `signOut`, `getSession` | login |
| `reviewService` | `submitReview`, `getReviews` | rides/[id] |
| `supportService` | `createTicket`, `getTickets` | help |
| `blogService` | `getPosts`, `getPost` | blog |
| `exchangeRateService` | `getCurrentRate` | fare display |
| `trustedContactService` | `getContacts`, `addContact`, `removeContact` | profile |
| `corporateService` | `getAccount`, `joinAccount` | profile |
| `recurringRideService` | `getSchedules`, `createSchedule`, `deleteSchedule` | profile |
| `referralService` | `getReferralCode`, `getReferralStats` | profile |
| `lostItemService` | `reportItem`, `getItems` | rides/[id] |
| `disputeService` | `createDispute`, `getDispute` | rides/[id] |

---

## 12. Database Schema

### Core Tables

**rides** - Central ride table
```sql
id UUID PK
customer_id UUID FK→users
driver_id UUID FK→driver_profiles (nullable until accepted)
service_type TEXT (triciclo_basico, moto_standard, auto_standard, auto_confort, mensajeria)
status ride_status ENUM (searching, accepted, driver_en_route, arrived_at_pickup, in_progress, completed, canceled, disputed)
payment_method payment_method ENUM (cash, tricicoin, mixed, corporate)
ride_mode TEXT ('passenger' | 'cargo')
pickup_location GEOGRAPHY(POINT), pickup_address TEXT
dropoff_location GEOGRAPHY(POINT), dropoff_address TEXT
estimated_fare_cup INT, estimated_fare_trc INT
estimated_distance_m INT, estimated_duration_s INT
exchange_rate_usd_cup NUMERIC (snapshotted at creation)
final_fare_cup INT (set at completion)
scheduled_at TIMESTAMPTZ (nullable)
promo_code_id UUID (nullable), discount_amount_cup INT
insurance_selected BOOLEAN, insurance_premium_cup INT
share_token TEXT (for public tracking link)
rider_preferences JSONB
created_at, updated_at TIMESTAMPTZ
```

**delivery_details** - Delivery-specific info (1:1 with rides where ride_mode='cargo')
```sql
id UUID PK
ride_id UUID FK→rides
package_description TEXT
recipient_name TEXT, recipient_phone TEXT
estimated_weight_kg NUMERIC (nullable)
special_instructions TEXT (nullable)
package_category TEXT (nullable) -- documentos, comida, paquete_pequeno, paquete_grande, fragil
package_length_cm INT, package_width_cm INT, package_height_cm INT (nullable)
client_accompanies BOOLEAN
delivery_vehicle_type TEXT (nullable)
pickup_photo_url TEXT (nullable)
delivery_photo_url TEXT (nullable)
created_at TIMESTAMPTZ
```

**driver_profiles** - Driver info
```sql
id UUID PK, user_id UUID FK→users
status driver_status ENUM
is_online BOOLEAN
current_location GEOGRAPHY(POINT)
rating_avg NUMERIC, total_rides_completed INT
acceptance_rate NUMERIC, match_score NUMERIC
```

**vehicles** - Driver vehicles (1:N with driver_profiles)
```sql
id UUID PK, driver_id UUID FK→driver_profiles
type vehicle_type ENUM (triciclo, moto, auto)
make, model, color TEXT, plate_number TEXT
capacity INT
accepts_cargo BOOLEAN
max_cargo_length_cm, max_cargo_width_cm, max_cargo_height_cm INT (nullable)
accepted_cargo_categories TEXT[]
```

**service_type_configs** - Fare configuration per vehicle type
```sql
slug TEXT UNIQUE -- 'triciclo_basico', 'auto_confort', etc.
base_fare_cup INT, per_km_rate_cup INT, per_minute_rate_cup INT, min_fare_cup INT
max_passengers INT, icon_name TEXT, is_active BOOLEAN
```

**pricing_rules** - Time-based fare overrides
```sql
service_type TEXT
base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup INT
time_window_start TIME, time_window_end TIME
day_of_week INT[] -- 0=Sun, 6=Sat
is_active BOOLEAN
```

**surge_zones** - Dynamic surge areas
```sql
center_location GEOGRAPHY(POINT), radius_m INT
surge_multiplier NUMERIC, reason TEXT
active BOOLEAN
```

### Supporting Tables
- `ride_waypoints` - Multi-stop waypoints (sort_order, location, address)
- `ride_transitions` - Status change audit log (from_status, to_status, actor, reason)
- `promotions` + `promotion_uses` - Promo codes and usage tracking
- `user_devices` - Push notification tokens (user_id, push_token, platform)
- `notifications` - In-app notification inbox
- `notification_preferences` - Per-category opt-in/out
- `notification_log` - Push send history
- `trip_insurance_configs` - Insurance pricing per service type
- `pricing_experiments` - A/B pricing test variants

---

## 13. Ride Status FSM

```
searching ──→ accepted ──→ driver_en_route ──→ arrived_at_pickup ──→ in_progress ──→ completed
    │              │              │                    │                   │
    └→ canceled    └→ canceled    └→ canceled          └→ canceled         └→ disputed → completed
```

**Enforced by:** Database trigger `enforce_ride_transition()` + `valid_transitions` table

**Active statuses** (ride is ongoing): searching, accepted, driver_en_route, arrived_at_pickup, in_progress

**Terminal statuses:** completed, canceled, disputed

**Key timestamps:** accepted_at, driver_arrived_at, pickup_at, completed_at, canceled_at

---

## 14. Key Utilities

### Pricing (`@tricigo/utils`)
```typescript
calculateBaseFare(distanceKm, durationMin, baseFare, perKmRate, perMinRate, minimumFare)
calculateCargoFare(durationMin, baseFare, perMinRate, minimumFare)
applySurge(fare, multiplier)
matchPricingRule(rules, currentHour, currentDay)
```

### Geo (`@tricigo/utils`)
```typescript
fetchRoute(pickup, dropoff)        // Mapbox/OSRM route
reverseGeocode(lat, lng)           // Coords → address
searchAddress(query, proximity)    // Text → coords
snapToNearestRoad(lat, lng)        // Snap to road
haversineDistance(p1, p2)          // Straight-line distance
isLocationInCuba(lat, lng)         // Bounds check
```

### Validation (`@tricigo/api/schemas`)
```typescript
createRideSchema    // Full ride creation validation
cubanPhoneSchema    // +53XXXXXXXX format
cubaLatSchema       // 19.5 - 23.5
cubaLngSchema       // -85.0 to -74.0
serviceTypeSchema   // Vehicle type enum
paymentMethodSchema // Payment method enum
```

---

## 15. Bugs Fixed & Lessons Learned

### delivery_details data silently lost
**Problem:** `CreateRideParams` didn't include `delivery_details`. Zod's `.strict()` validation stripped unknown fields silently.
**Fix:** Added `delivery_details` to both the TypeScript interface AND the Zod schema. After ride insertion, explicitly call `deliveryService.createDeliveryDetails()`.
**Lesson:** Always verify Zod schemas match your interfaces. Zod strips unknown fields by default.

### Driver matching ignored is_delivery flag
**Problem:** `_matchDriversForRide()` didn't pass `is_delivery: true` for cargo rides, so non-cargo drivers received delivery requests.
**Fix:** Pass `is_delivery: ride.ride_mode === 'cargo'` to `findBestDrivers()`.

### Stale pricing exploit
**Problem:** User estimates fare at 8am (normal price), leaves app open, requests at 11pm (peak) with the old price.
**Fix:** Re-estimate fare at request time. If price changed >5%, abort with warning and show new price.

### i18n not persisting across reloads
**Problem:** `initI18n()` called without the saved language parameter, always defaulted to Spanish.
**Fix:** Read `localStorage.getItem('tricigo_language')` in `I18nProvider` and pass to `initI18n(savedLang)`.

### Profile page not translating
**Problem:** All text in `profile/page.tsx` was hardcoded Spanish strings. No `useTranslation` import.
**Fix:** Added `profile.*` keys to all 3 language JSON files. Updated component to use `t()`.

### Nav menu staying in Spanish
**Problem:** Header used `t('nav.rides', { defaultValue: 'Viajes' })` but the keys `nav.rides`, `nav.wallet`, `nav.profile`, `nav.logout` didn't exist in JSON files. The `defaultValue` (always Spanish) was used as fallback.
**Fix:** Added all missing nav keys to es/en/pt JSON files. Removed `defaultValue` fallbacks.

### Vehicle markers drifting on zoom
**Problem:** HTML markers on Mapbox moved when zooming because they weren't anchored to geographic coordinates properly.
**Fix:** Replaced HTML markers with Mapbox GeoJSON symbol layer (native map layer, zoom-stable).

---

## Deploy Procedure

```bash
# On VPS (187.77.214.236)
cd /var/www/tricigo
git pull origin master
pnpm --filter @tricigo/web build
pm2 restart tricigo-web
```

**Supabase project:** `lqaufszburqvlslpcuac`
**VPS IP:** `187.77.214.236`
**Domain:** `tricigo.com`

---

---

## 16. UI & Design System

### File: `apps/web/src/app/globals.css`

The web client uses a CSS-only design system built on custom properties. No Tailwind or CSS-in-JS.

### Design Tokens (`:root`)
```css
/* Colors */
--primary: #FF4D00           --primary-light: #FF6B2C
--primary-dark: #e04400      --primary-alpha-10: rgba(255,77,0,0.1)
--primary-alpha-20: rgba(255,77,0,0.2)

/* Spacing scale */
--space-xs: 0.25rem  --space-sm: 0.5rem   --space-md: 1rem
--space-lg: 1.5rem   --space-xl: 2rem     --space-2xl: 3rem  --space-3xl: 4rem

/* Typography scale */
--text-xs: 0.75rem   --text-sm: 0.8125rem --text-base: 0.875rem
--text-md: 0.9375rem --text-lg: 1rem      --text-xl: 1.125rem
--text-2xl: 1.5rem   --text-3xl: 2rem

/* Shadows (6 levels) */
--shadow-sm through --shadow-elevated

/* Border radius */
--radius-sm: 0.375rem  --radius-md: 0.75rem  --radius-lg: 1rem
--radius-xl: 1.5rem    --radius-full: 9999px

/* Transitions */
--transition-fast: 0.15s ease   --transition-base: 0.2s ease   --transition-slow: 0.3s ease

/* Gradients */
--gradient-primary: linear-gradient(135deg, var(--primary) 0%, #FF8A5C 100%)
--gradient-card: linear-gradient(180deg, var(--bg-card) 0%, var(--bg-light) 100%)
```

### Dark Mode
- **Toggle:** `[data-theme="dark"]` attribute on `<html>`, toggled via header button
- **Persistence:** `localStorage.setItem('tricigo-theme', 'dark'|'light')`
- **System fallback:** `@media (prefers-color-scheme: dark)` applies when user hasn't explicitly chosen
- All tokens re-declared in dark scope (darker backgrounds, lighter text, heavier shadows)

### Utility Classes
| Class | Purpose |
|-------|---------|
| `.input-base` | Consistent input: border, radius, padding, focus ring (`box-shadow: 0 0 0 3px var(--primary-alpha-10)`) |
| `.btn-base` | Button reset: padding, radius, font, cursor, transition |
| `.btn-primary-solid` | Primary filled button (orange bg, white text, hover darken) |
| `.btn-secondary-outline` | Outlined button (border, transparent bg, hover fill) |
| `.card-base` | Card container: bg, border, radius, shadow |
| `.modal-overlay` | Fixed fullscreen backdrop (`rgba(0,0,0,0.5)`) with `fadeInUp` |
| `.modal-content` | Centered modal box with slide-up animation |

### Component-Specific CSS Classes
| Class | Component |
|-------|-----------|
| `.header-glass` | Header: `backdrop-filter: blur(12px)`, semi-transparent bg, sticky |
| `.nav-link-animated` | Nav links: underline on hover via `::after` scale transform |
| `.badge-pulse` | Notification badge: `badgePulse` animation (scale 1 → 1.15) |
| `.footer-enhanced` | Footer: gradient top border, responsive 3-column grid |
| `.footer-grid` | 3-column grid (2fr 1fr 1fr) for brand / links / legal |
| `.wallet-balance-card` | Gradient card with floating circle overlay (`::after`) |
| `.profile-avatar-ring` | 96px avatar with gradient border ring |
| `.profile-menu-group` | Section container with uppercase `.profile-menu-group-title` |
| `.profile-menu-item` | Menu row: flex, hover bg, SVG icon in `.profile-menu-icon` circle |
| `.ride-route-dots` | Vertical pickup → dropoff visualization with connecting line |
| `.ride-status-badge` | Pill badge colored by status (green/yellow/red/blue) |
| `.spinner` | Loading spinner (24px, border animation) |

### Animations
| Keyframe | Duration | Used For |
|----------|----------|----------|
| `shimmer` | 1.5s | Skeleton loading cards (moving highlight gradient) |
| `float` | 4s | Hero phone frame (gentle up/down) |
| `fadeInUp` | 0.4s | Page sections, empty states, modals |
| `slideUp` | 0.3s | Modal content entrance |
| `badgePulse` | 1.5s | Notification count badge |
| `spin` | 0.6s | Loading spinner |
| `pulse` | 2s | Generic opacity pulse |

### Responsive Breakpoints
```css
@media (max-width: 400px)   /* Small mobile: reduced paddings, smaller phone frame */
@media (max-width: 600px)   /* Mobile: stack columns, full-width cards */
@media (min-width: 768px)   /* Tablet: .page-container → 600px, 2-col grids */
@media (max-width: 900px)   /* Footer grid collapse */
@media (min-width: 1024px)  /* Desktop: full nav, wider layouts */
@media (min-width: 1440px)  /* Large desktop: wider max-width, larger hero */
```
- `env(safe-area-inset-bottom)` applied on `.page-main` for iOS notch
- `.page-container` base max-width: 560px (600px on tablet)

### Header Architecture (`web-header.tsx`)
- Glass effect with `backdrop-filter: blur(12px)` and semi-transparent background
- SVG sun/moon icons for dark mode toggle (not emoji)
- Desktop nav: Book, Rides, Wallet, Notifications (with unread badge), Profile
- Mobile nav: hamburger toggle with slide-down menu
- Avatar: gradient background with initials or `user_metadata.avatar_url`
- Subscribes to Supabase auth state changes + tracks unread notification count

### Footer Architecture (`web-footer.tsx`)
- 3-column responsive grid: Brand description | Quick links | Legal
- Uses i18n with `defaultValue` fallback for missing keys
- Stacks vertically on mobile (<900px)

---

## 17. Corporate Booking

### File: `apps/web/src/app/book/page.tsx`

### Flow
```
1. On mount: corporateService.getMyAccounts(userId) → setCorporateAccounts
2. User taps corporate account toggle button
3. selectedCorporateId is set, paymentMethod auto-switches to 'corporate'
4. UI shows "Viajando como [company name]" context label
5. On ride request: corporate_account_id included in createRide params
```

### State
```typescript
corporateAccounts: CorporateAccount[]     // loaded on init
selectedCorporateId: string | null        // null = personal ride
```

### UI
- "Personal" button + one button per corporate account the user belongs to
- Selected state: `2px solid var(--primary)` border + primary-tinted background
- Switching back to "Personal" clears `selectedCorporateId` and resets payment method

---

## 18. Wallet & Payments (TropiPay)

### File: `apps/web/src/app/wallet/page.tsx`

### TropiPay Recharge Flow
```
1. User enters CUP amount, clicks "Pagar con TropiPay"
2. paymentService.createRechargeLink(userId, amountCup) → returns { paymentUrl }
3. Modal opens with iframe loading paymentUrl (allow="payment")
4. Polling starts: every 5s check walletService.getBalance(userId)
5. If balance increased → close modal, show "Recarga completada" success message
6. Polling auto-stops after 5 minutes (timeout safety)
7. User can close modal manually (balance refreshes on close)
```

### State
```typescript
tropipayUrl: string | null        // iframe src, null = modal closed
tropipayPolling: boolean          // true while checking balance
```

### P2P Transfer
```
1. User enters recipient phone → debounced search via walletService.lookupByPhone()
2. Shows matched user (name + phone) for confirmation
3. User enters amount + optional note
4. walletService.transfer(fromUserId, toUserId, amount, note)
5. Success message + transaction list refresh
```

### Transaction History
- Paginated: 20 per page with "Load more" button
- Filter tabs: All / Credits / Debits (pill-shaped, 44px touch target)
- Each transaction shows: colored dot (green credit / red debit), description, amount, relative date

*Last updated: 2026-03-30*
