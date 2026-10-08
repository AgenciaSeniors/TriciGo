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
      // NOTE: an EF index.ts usually imports from https:// URLs and touches Deno.*,
      // which vitest cannot resolve. The handlers below are the exceptions.
      '../../supabase/functions/_shared/**/*.test.ts',
      // send-email's handler: its only remote import (supabase-js, inside
      // _shared/rate-limiter.ts) is replaced with vi.mock, and the test stubs Deno.
      '../../supabase/functions/send-email/*.test.ts',
      // add-email-with-verification's handler: same, plus its own esm.sh import of
      // supabase-js, which the test also replaces with vi.mock.
      '../../supabase/functions/add-email-with-verification/*.test.ts',
      // behavioral-emails, send-bulk-email and notify-document-rejection: same,
      // supabase-js replaced with vi.mock.
      '../../supabase/functions/behavioral-emails/*.test.ts',
      '../../supabase/functions/send-bulk-email/*.test.ts',
      // send-push's handler: role and category gate (00641). supabase-js and the rate limiter
      // replaced with vi.mock, Deno stubbed.
      '../../supabase/functions/send-push/*.test.ts',
      '../../supabase/functions/notify-document-rejection/*.test.ts',
    ],
  },
});
