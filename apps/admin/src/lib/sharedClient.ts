'use client';

import { setSupabaseClient } from '@tricigo/api';
import { createBrowserClient } from './supabase-server';

// One Supabase client for the whole panel: the @supabase/ssr one, whose session
// lives in the cookies the middleware reads. @tricigo/api's services use it too
// (getSupabaseClient), so there is no second session to keep in sync. AdminShell
// imports this module first, before anything calls a service.
if (typeof window !== 'undefined') {
  setSupabaseClient(createBrowserClient());
}
