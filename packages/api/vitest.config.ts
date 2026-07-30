import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'src/**/*.test.ts',
      // Edge Function shared helpers. They had NO runner: every vitest project here
      // scopes include to its own src/, so supabase/functions/_shared/demo-otp.test.ts
      // sat unexecuted from the day it was written. These are plain TypeScript modules
      // with no Deno or remote imports, so they run here unmodified — and the backend
      // service layer is the closest thing they have to a home.
      // NOTE: only _shared/ helpers qualify. An EF index.ts imports from https:// URLs
      // and touches Deno.*, which vitest cannot resolve.
      '../../supabase/functions/_shared/**/*.test.ts',
    ],
  },
});
