# Bundle Optimization Status

Last reviewed: 2026-03-22

## Current Optimizations

### expo-image Migration (Completed)
Replaced `react-native` Image with `expo-image` for all network (uri-based) images:
- `packages/ui/src/Avatar.tsx` -- blur placeholder + 200ms transition
- `packages/ui/src/DriverCard.tsx` -- vehicle photo with 300ms transition
- `apps/client/app/ride/dispute/[rideId].tsx` -- evidence photos with 200ms transition

Benefits: built-in caching, progressive loading (blurhash), better memory management, WebP support.

Local `require()` images left on `react-native` Image (bundled assets do not benefit from expo-image).

### Tree-Shaking: No Issues Found
- All `import * as` patterns are Expo SDK modules (ImagePicker, Location, Notifications, Sentry, etc.) which require namespace imports by design.
- No full-library imports (lodash, moment) detected.
- `@expo/vector-icons` consistently uses `{ Ionicons } from '@expo/vector-icons'` (correct tree-shakeable pattern).

### app.json Plugins: Clean
Both `apps/client/app.json` and `apps/driver/app.json` contain only necessary plugins:
- expo-router, expo-localization, expo-notifications, expo-location, @rnmapbox/maps
- Client: @react-native-community/datetimepicker, expo-secure-store, expo-sharing
- Driver: expo-image-picker

No unnecessary or oversized plugins detected.

## Known Large Dependencies

| Dependency | Used In | Size Impact | Notes |
|---|---|---|---|
| `@rnmapbox/maps` | client, driver | ~2-4 MB native | Core feature, cannot remove |
| `@sentry/react-native` | client, driver | ~200-400 KB | Error monitoring, essential |
| `mapbox-gl` | client (web) | ~500 KB | Web map rendering |
| `react-native-svg` | driver | ~150 KB | SVG rendering |
| `posthog-react-native` | client, driver | ~100 KB | Analytics |

## Recommendations for Further Optimization

1. **Lazy-load map components** -- Use `React.lazy()` for map screens to defer loading `@rnmapbox/maps` until needed.
2. **Code splitting (web)** -- `mapbox-gl` is only used in the client web app; ensure it is not bundled for native builds.
3. **Image asset compression** -- Run local PNG/JPG assets through a compressor (e.g., `expo-optimize`) before building.
4. **Font subsetting** -- If custom fonts are added, subset to required glyphs only.
5. **Monitor with `npx expo-doctor`** -- Periodically run to detect duplicate or oversized dependencies.
6. **Consider `react-native-reanimated` lazy loading** -- If added in the future, use the Babel plugin with `disableInlineStylesWarning`.
