// In-memory rate limiter for Deno Edge Functions
// Uses Map with IP/key -> { count, resetAt }
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

// Clean expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitStore) {
    if (val.resetAt <= now) rateLimitStore.delete(key);
  }
}, 60_000);

export function rateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): { allowed: boolean; remaining: number; retryAfterMs: number } {
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry || entry.resetAt <= now) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1, retryAfterMs: 0 };
  }

  if (entry.count >= maxRequests) {
    return { allowed: false, remaining: 0, retryAfterMs: entry.resetAt - now };
  }

  entry.count++;
  return { allowed: true, remaining: maxRequests - entry.count, retryAfterMs: 0 };
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
