// ============================================================
// TriciGo — fetch with a timeout, for Supabase clients
// Its own module (no side effects) so the admin panel can give it to the
// @supabase/ssr client it owns without loading the rest of @tricigo/api.
// ============================================================

// ── Global fetch timeout (PASS #3 resilience) ──
// On a stalled Cuban 3G connection a Supabase HTTP request can hang
// indefinitely at the TCP layer — the socket never errors unless the server
// closes it — so the UI shows a loading spinner forever and the user has to
// kill and reopen the app. We wrap the client's fetch with an AbortController
// timeout so a dead connection surfaces as an error (which TanStack Query then
// retries) instead of hanging. Reads/writes get a tight backstop; uploads and
// edge functions (which can legitimately be slow over a poor link) get a
// generous one so we never abort a real-but-slow transfer.
const READ_TIMEOUT_MS = 30_000;
const LONG_TIMEOUT_MS = 120_000;

// Loosely typed (input/init: any) on purpose: the exact `fetch` signature
// differs across the consuming environments (React Native vs Next.js DOM lib),
// so a strict `typeof fetch` annotation fails type-check in one of them. `any`
// params keep this assignable to whatever Supabase's `global.fetch` expects.
export function makeTimeoutFetch() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (input: any, init?: any): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : (input?.href ?? input?.url ?? '');
    // Edge functions (incl. all authenticated uploads, which route through
    // /functions/v1/storage-upload + upload-delivery-photo) and direct storage
    // ops can be slow on 3G — give them the generous backstop.
    const isLongOp = /\/functions\/v1\/|\/storage\/v1\//.test(String(url));
    const timeoutMs = isLongOp ? LONG_TIMEOUT_MS : READ_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Respect a caller-supplied AbortSignal (e.g. the address-search
    // components abort stale requests): abort ours when theirs fires.
    const callerSignal: AbortSignal | undefined = init?.signal ?? undefined;
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (globalThis.fetch as any)(input, { ...init, signal: controller.signal }).finally(() =>
      clearTimeout(timer),
    );
  };
}
