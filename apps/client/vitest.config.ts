import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Mirrors apps/driver/vitest.config.ts. The client app had no test setup at
// all, so everything here was covered only by tsc — and tsc cannot tell you
// that a timer is cleared before it ever fires.
//
// Deliberately narrow, for the same reason the driver's is: plain-TypeScript
// modules. There is no React Native renderer in this repo, so hook *bodies*
// stay out of reach; logic that needs coverage gets lifted into plain
// functions (see src/hooks/searchHeartbeat.ts) and tested directly.
export default defineConfig({
  test: {
    globals: true,
    // plugins/ is included on purpose: the Expo config plugins are build
    // logic that only runs during prebuild, so a bug there surfaces as a broken
    // APK rather than a failing test. with-user-leave-hint-safe already shipped
    // one (an anchor that matched outside the class body on SDK 55).
    include: ['src/**/*.test.ts', 'plugins/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
