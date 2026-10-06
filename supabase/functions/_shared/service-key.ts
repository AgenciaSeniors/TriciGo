// ============================================================
// Service key for Edge Functions — rotation-safe resolution.
//
// Every EF used to read Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'). We cannot
// point that variable at a new key: names starting with SUPABASE_ are reserved
// and injected by Supabase. Supabase also injects SUPABASE_SECRET_KEYS, a JSON
// object that maps each secret API key's NAME to its value. The initial key is
// `default`; a key created in Dashboard → Settings → API Keys appears there
// under its own name.
//
//   OUTGOING (supabase-js clients, the apikey/Authorization we send to other
//   EFs or PostgREST) → getServiceKey():
//     1. the key named by our own EF secret SERVICE_KEY_NAME, if present
//     2. else SUPABASE_SECRET_KEYS.default
//     3. else the first non-empty key, by sorted name (deterministic)
//     4. else the legacy SUPABASE_SERVICE_ROLE_KEY
//     5. else ''
//
//   INCOMING service-role auth → isServiceKeyToken(token): true when the token
//   equals ANY configured secret key or the legacy variable. During a rotation
//   callers that still hold the old key (pg_cron jobs read the vault copy) keep
//   working until the vault and every caller have moved to the new key.
//
// Pure module: no remote imports, and Deno is only touched behind a typeof
// guard, so packages/api's vitest imports it unmodified.
// ============================================================

export type EnvGetter = (name: string) => string | undefined;

const SECRET_KEYS_VAR = 'SUPABASE_SECRET_KEYS';
const LEGACY_VAR = 'SUPABASE_SERVICE_ROLE_KEY';
const NAME_VAR = 'SERVICE_KEY_NAME';
const DEFAULT_NAME = 'default';

interface NamedKey {
  name: string;
  value: string;
}

/** Non-empty string entries of SUPABASE_SECRET_KEYS, sorted by name. Never throws. */
function readSecretKeys(env: EnvGetter): NamedKey[] {
  const raw = env(SECRET_KEYS_VAR);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  const record = parsed as Record<string, unknown>;
  const names = Object.keys(record).sort();
  const keys: NamedKey[] = [];
  for (let i = 0; i < names.length; i++) {
    const value = record[names[i]];
    if (typeof value === 'string' && value.length > 0) keys.push({ name: names[i], value });
  }
  return keys;
}

function findKey(keys: NamedKey[], name: string): string | undefined {
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].name === name) return keys[i].value;
  }
  return undefined;
}

interface Resolution {
  key: string;
  /** SERVICE_KEY_NAME was set but SUPABASE_SECRET_KEYS has no usable key by that name. */
  requestedNameMissing: boolean;
  availableNames: string[];
}

function resolve(env: EnvGetter): Resolution {
  const keys = readSecretKeys(env);
  const availableNames = keys.map((k) => k.name);
  const requested = (env(NAME_VAR) ?? '').trim();
  const named = requested ? findKey(keys, requested) : undefined;
  const requestedNameMissing = requested !== '' && named === undefined;
  if (named) return { key: named, requestedNameMissing, availableNames };

  const fallback = findKey(keys, DEFAULT_NAME) ?? (keys.length > 0 ? keys[0].value : undefined);
  return { key: fallback ?? (env(LEGACY_VAR) || ''), requestedNameMissing, availableNames };
}

/** The key to use for outgoing service-role calls. '' when nothing is configured. */
export function resolveServiceKey(env: EnvGetter): string {
  return resolve(env).key;
}

/** Every key an incoming service-role caller may present, deduped. */
export function listServiceKeys(env: EnvGetter): string[] {
  const values: string[] = [];
  const keys = readSecretKeys(env);
  for (let i = 0; i < keys.length; i++) {
    if (values.indexOf(keys[i].value) === -1) values.push(keys[i].value);
  }
  const legacy = env(LEGACY_VAR);
  if (legacy && values.indexOf(legacy) === -1) values.push(legacy);
  return values;
}

/** Equality whose running time does not depend on where the strings differ. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when `candidate` is exactly one of the configured service keys. */
export function isServiceKey(candidate: string | null | undefined, env: EnvGetter): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const keys = listServiceKeys(env);
  let match = false;
  // No early exit: every configured key is compared, whichever one matches.
  for (let i = 0; i < keys.length; i++) {
    if (timingSafeEqual(candidate, keys[i])) match = true;
  }
  return match;
}

// ── Thin wrappers for EF code (read the live environment) ──

// Deno typing — vitest (Node) imports this module too, and there is no Deno global there.
declare const Deno: { env: { get(name: string): string | undefined } } | undefined;

function denoEnv(name: string): string | undefined {
  return typeof Deno !== 'undefined' ? Deno.env.get(name) : undefined;
}

let warnedMissingName = false;

/** Service key for outgoing calls (supabase-js clients, apikey/Bearer headers). */
export function getServiceKey(): string {
  const resolution = resolve(denoEnv);
  if (resolution.requestedNameMissing && !warnedMissingName) {
    warnedMissingName = true;
    // Names only. SERVICE_KEY_NAME itself is never echoed: if someone pasted a key
    // VALUE into it by mistake, this line must not copy that value into the logs.
    const names = resolution.availableNames.length > 0 ? resolution.availableNames.join(', ') : 'none';
    console.warn(
      `[service-key] SERVICE_KEY_NAME does not match any key in ${SECRET_KEYS_VAR} ` +
        `(available names: ${names}); using the fallback key (default, else first by name, else ${LEGACY_VAR}).`,
    );
  }
  return resolution.key;
}

/** Incoming auth: true when `candidate` is exactly one of the configured service keys. */
export function isServiceKeyToken(candidate: string | null | undefined): boolean {
  return isServiceKey(candidate, denoEnv);
}
