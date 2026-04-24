/// <reference types="nativewind/types" />

// NOTE: Mirrors apps/client/nativewind-env.d.ts + apps/driver/nativewind-env.d.ts
// so packages/ui components that use `className` on React Native
// primitives (View, Pressable, Text, Animated.*) type-check both when
// compiled standalone (pnpm --filter @tricigo/ui exec tsc) and when
// consumed from an app that runs tsc across the workspace.
