// ============================================================
// TriciGo — Rate Limiter (DB-backed with in-memory fallback)
// BUG-087/088 fix: Uses PostgreSQL check_rate_limit() RPC for
// persistence across restarts and cross-isolate sharing.
// Falls back to in-memory if DB is unavailable.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// --------------- In-memory fallback ---------------
const localStore = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of localStore) {
    if (val.resetAt <= now) localStore.delete(key);
  }
}, 30_000);

function rateLimitLocal(
  key: string,
  maxRequests: number,
  windowMs: number,
): { allowed: boolean; remaining: number; retryAfterMs: number } {
  const now = Date.now();
  const entry = localStore.get(key);

  if (!entry || entry.resetAt <= now) {
    localStore.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1, retryAfterMs: 0 };
  }

  if (entry.count >= maxRequests) {
    return { allowed: false, remaining: 0, retryAfterMs: entry.resetAt - now };
  }

  entry.count++;
  return { allowed: true, remaining: maxRequests - entry.count, retryAfterMs: 0 };
}

// --------------- DB-backed rate limiter ---------------

let _supabase: ReturnType<typeof createClient> | null = null;

function getServiceClient() {
  if (!_supabase) {
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return null;
    _supabase = createClient(url, key);
  }
  return _supabase;
}

export async function rateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }> {
  try {
    const supabase = getServiceClient();
    if (!supabase) return rateLimitLocal(key, maxRequests, windowMs);

    const windowSeconds = Math.ceil(windowMs / 1000);
    const { data, error } = await supabase.rpc('check_rate_limit', {
      p_key: key,
      p_max_requests: maxRequests,
      p_window_seconds: windowSeconds,
    });

    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('Empty response from check_rate_limit');

    return {
      allowed: row.allowed,
      remaining: Math.max(0, maxRequests - row.current_count),
      retryAfterMs: row.allowed ? 0 : Math.max(0, new Date(row.reset_at).getTime() - Date.now()),
    };
  } catch (err) {
    // Graceful degradation: fall back to in-memory
    console.warn('[rate-limiter] DB rate limit failed, using in-memory fallback:', (err as Error).message);
    return rateLimitLocal(key, maxRequests, windowMs);
  }
}

export function rateLimitResponse(retryAfterMs: number): Response {
  return new Response(
    JSON.stringify({ error: 'Too many requests. Try again later.' }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(Math.ceil(retryAfterMs / 1000)),
      },
    },
  );
}
