import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getServiceKey,
  isServiceKey,
  isServiceKeyToken,
  listServiceKeys,
  resolveServiceKey,
  type EnvGetter,
} from './service-key';

// Fake key material. The shapes mimic real keys (same prefix, realistic length) so the
// length-sensitive comparison paths are exercised, but none of these is a credential.
const OLD = 'sb_secret_OLDoldOLDoldOLDoldOLDold01';
const NEW = 'sb_secret_NEWnewNEWnewNEWnewNEWnew02';
const LEGACY = 'eyJhbGciOiJIUzI1NiJ9.fake-legacy-service-role.sig';

function envOf(vars: Record<string, string | undefined>): EnvGetter {
  return (name) => vars[name];
}

const keys = (map: Record<string, unknown>) => JSON.stringify(map);

describe('resolveServiceKey', () => {
  it('returns the default secret key', () => {
    expect(resolveServiceKey(envOf({ SUPABASE_SECRET_KEYS: keys({ default: OLD }) }))).toBe(OLD);
  });

  it('prefers the default secret key over the legacy variable', () => {
    const env = envOf({ SUPABASE_SECRET_KEYS: keys({ default: OLD }), SUPABASE_SERVICE_ROLE_KEY: LEGACY });
    expect(resolveServiceKey(env)).toBe(OLD);
  });

  it('SERVICE_KEY_NAME selects a named key', () => {
    const env = envOf({
      SUPABASE_SECRET_KEYS: keys({ default: OLD, 'edge-2026-09': NEW }),
      SERVICE_KEY_NAME: 'edge-2026-09',
    });
    expect(resolveServiceKey(env)).toBe(NEW);
  });

  it('ignores whitespace around SERVICE_KEY_NAME', () => {
    const env = envOf({
      SUPABASE_SECRET_KEYS: keys({ default: OLD, 'edge-2026-09': NEW }),
      SERVICE_KEY_NAME: ' edge-2026-09\n',
    });
    expect(resolveServiceKey(env)).toBe(NEW);
  });

  it('falls back to default when SERVICE_KEY_NAME points to a missing name', () => {
    const env = envOf({
      SUPABASE_SECRET_KEYS: keys({ default: OLD, 'edge-2026-09': NEW }),
      SERVICE_KEY_NAME: 'edge-2026-9',
    });
    expect(resolveServiceKey(env)).toBe(OLD);
  });

  it('falls back to default when SERVICE_KEY_NAME points to an empty value', () => {
    const env = envOf({ SUPABASE_SECRET_KEYS: keys({ default: OLD, edge: '' }), SERVICE_KEY_NAME: 'edge' });
    expect(resolveServiceKey(env)).toBe(OLD);
  });

  it('does not resolve inherited object properties as key names', () => {
    const env = envOf({ SUPABASE_SECRET_KEYS: keys({ default: OLD }), SERVICE_KEY_NAME: 'constructor' });
    expect(resolveServiceKey(env)).toBe(OLD);
  });

  it('without a default key, picks the first non-empty key by sorted name', () => {
    // Deliberately inserted out of order: the result must not depend on JSON key order.
    const env = envOf({ SUPABASE_SECRET_KEYS: keys({ zeta: OLD, alpha: '', beta: NEW }) });
    expect(resolveServiceKey(env)).toBe(NEW);
  });

  it('picks the remaining key once the default one is deleted', () => {
    // End of the rotation: `default` is gone, SERVICE_KEY_NAME may or may not be set.
    expect(resolveServiceKey(envOf({ SUPABASE_SECRET_KEYS: keys({ 'edge-2026-09': NEW }) }))).toBe(NEW);
  });

  it('ignores non-string values', () => {
    const env = envOf({ SUPABASE_SECRET_KEYS: keys({ default: 123, other: NEW }) });
    expect(resolveServiceKey(env)).toBe(NEW);
  });

  it('uses the legacy variable when only it is set', () => {
    expect(resolveServiceKey(envOf({ SUPABASE_SERVICE_ROLE_KEY: LEGACY }))).toBe(LEGACY);
  });

  it('uses the legacy variable when SERVICE_KEY_NAME is set but SUPABASE_SECRET_KEYS is not', () => {
    const env = envOf({ SERVICE_KEY_NAME: 'edge-2026-09', SUPABASE_SERVICE_ROLE_KEY: LEGACY });
    expect(resolveServiceKey(env)).toBe(LEGACY);
  });

  it('never throws on malformed JSON and falls back to the legacy variable', () => {
    const env = envOf({ SUPABASE_SECRET_KEYS: '{"default": "sb_secret_', SUPABASE_SERVICE_ROLE_KEY: LEGACY });
    expect(() => resolveServiceKey(env)).not.toThrow();
    expect(resolveServiceKey(env)).toBe(LEGACY);
  });

  it('treats valid JSON that is not an object as empty', () => {
    for (const raw of ['null', '42', '"sb_secret_x"', '["sb_secret_x"]', 'true', '']) {
      const env = envOf({ SUPABASE_SECRET_KEYS: raw, SUPABASE_SERVICE_ROLE_KEY: LEGACY });
      expect(resolveServiceKey(env)).toBe(LEGACY);
    }
  });

  it('returns an empty string when nothing is configured', () => {
    expect(resolveServiceKey(envOf({}))).toBe('');
    expect(resolveServiceKey(envOf({ SUPABASE_SECRET_KEYS: 'not json', SUPABASE_SERVICE_ROLE_KEY: '' }))).toBe('');
  });
});

describe('listServiceKeys', () => {
  it('lists every secret key plus the legacy variable', () => {
    const env = envOf({
      SUPABASE_SECRET_KEYS: keys({ default: OLD, 'edge-2026-09': NEW }),
      SUPABASE_SERVICE_ROLE_KEY: LEGACY,
    });
    expect([...listServiceKeys(env)].sort()).toEqual([LEGACY, NEW, OLD].sort());
  });

  it('dedupes a legacy variable that mirrors a secret key', () => {
    const env = envOf({ SUPABASE_SECRET_KEYS: keys({ default: OLD }), SUPABASE_SERVICE_ROLE_KEY: OLD });
    expect(listServiceKeys(env)).toEqual([OLD]);
  });

  it('dedupes two names that hold the same value', () => {
    const env = envOf({ SUPABASE_SECRET_KEYS: keys({ default: OLD, alias: OLD }) });
    expect(listServiceKeys(env)).toEqual([OLD]);
  });

  it('skips empty and non-string values', () => {
    const env = envOf({ SUPABASE_SECRET_KEYS: keys({ a: '', b: 5, c: NEW, d: null }), SUPABASE_SERVICE_ROLE_KEY: '' });
    expect(listServiceKeys(env)).toEqual([NEW]);
  });

  it('is empty when nothing is configured, and survives malformed JSON', () => {
    expect(listServiceKeys(envOf({}))).toEqual([]);
    expect(listServiceKeys(envOf({ SUPABASE_SECRET_KEYS: '{oops' }))).toEqual([]);
    expect(listServiceKeys(envOf({ SUPABASE_SECRET_KEYS: '{oops', SUPABASE_SERVICE_ROLE_KEY: LEGACY }))).toEqual([LEGACY]);
  });
});

describe('isServiceKey', () => {
  // Mid-rotation: both keys exist and outgoing calls already use the new one.
  const rotating = envOf({
    SUPABASE_SECRET_KEYS: keys({ default: OLD, 'edge-2026-09': NEW }),
    SERVICE_KEY_NAME: 'edge-2026-09',
    SUPABASE_SERVICE_ROLE_KEY: OLD,
  });

  it('accepts BOTH the old and the new key during rotation', () => {
    expect(isServiceKey(OLD, rotating)).toBe(true);
    expect(isServiceKey(NEW, rotating)).toBe(true);
  });

  it('accepts the legacy variable value', () => {
    expect(isServiceKey(LEGACY, envOf({ SUPABASE_SERVICE_ROLE_KEY: LEGACY }))).toBe(true);
  });

  it('rejects a different string of the same length', () => {
    const lastCharFlipped = OLD.slice(0, -1) + (OLD.endsWith('1') ? '2' : '1');
    expect(lastCharFlipped).toHaveLength(OLD.length);
    expect(isServiceKey(lastCharFlipped, rotating)).toBe(false);
    const firstCharFlipped = 'S' + OLD.slice(1);
    expect(isServiceKey(firstCharFlipped, rotating)).toBe(false);
  });

  it('rejects strings of a different length, including prefixes and extensions', () => {
    expect(isServiceKey(OLD.slice(0, -1), rotating)).toBe(false);
    expect(isServiceKey(`${OLD}x`, rotating)).toBe(false);
    expect(isServiceKey('sb_secret_', rotating)).toBe(false);
    expect(isServiceKey(`${OLD}${NEW}`, rotating)).toBe(false);
  });

  it('is exact: no trimming and case-sensitive', () => {
    expect(isServiceKey(` ${OLD}`, rotating)).toBe(false);
    expect(isServiceKey(`${OLD}\n`, rotating)).toBe(false);
    expect(isServiceKey(`Bearer ${OLD}`, rotating)).toBe(false);
    expect(isServiceKey(OLD.toUpperCase(), rotating)).toBe(false);
  });

  it('rejects the empty string, null and undefined', () => {
    expect(isServiceKey('', rotating)).toBe(false);
    expect(isServiceKey(null, rotating)).toBe(false);
    expect(isServiceKey(undefined, rotating)).toBe(false);
    // An empty key in the environment must never turn an empty header into a match.
    const emptyEverywhere = envOf({ SUPABASE_SECRET_KEYS: keys({ default: '' }), SUPABASE_SERVICE_ROLE_KEY: '' });
    expect(isServiceKey('', emptyEverywhere)).toBe(false);
  });

  it('rejects everything when no key is configured', () => {
    expect(isServiceKey(OLD, envOf({}))).toBe(false);
    expect(isServiceKey(OLD, envOf({ SUPABASE_SECRET_KEYS: 'not json' }))).toBe(false);
  });

  it('stops accepting a key once it is removed from both sources', () => {
    const afterDeletion = envOf({ SUPABASE_SECRET_KEYS: keys({ 'edge-2026-09': NEW }) });
    expect(isServiceKey(NEW, afterDeletion)).toBe(true);
    expect(isServiceKey(OLD, afterDeletion)).toBe(false);
  });

  it('keeps accepting whatever SUPABASE_SERVICE_ROLE_KEY still holds', () => {
    // Documents the contract: the legacy variable is always a valid credential. If Supabase
    // keeps injecting a deleted key there, it stays accepted (see the PR runbook check).
    const legacyLingers = envOf({ SUPABASE_SECRET_KEYS: keys({ 'edge-2026-09': NEW }), SUPABASE_SERVICE_ROLE_KEY: OLD });
    expect(isServiceKey(OLD, legacyLingers)).toBe(true);
  });
});

describe('Deno wrappers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubDenoEnv(vars: Record<string, string | undefined>) {
    vi.stubGlobal('Deno', { env: { get: (name: string) => vars[name] } });
  }

  it('return safe defaults when there is no Deno global', () => {
    expect(typeof (globalThis as { Deno?: unknown }).Deno).toBe('undefined');
    expect(getServiceKey()).toBe('');
    expect(isServiceKeyToken(OLD)).toBe(false);
    expect(isServiceKeyToken('')).toBe(false);
  });

  it('read the live environment through Deno.env.get', () => {
    stubDenoEnv({
      SUPABASE_SECRET_KEYS: keys({ default: OLD, 'edge-2026-09': NEW }),
      SERVICE_KEY_NAME: 'edge-2026-09',
      SUPABASE_SERVICE_ROLE_KEY: OLD,
    });
    expect(getServiceKey()).toBe(NEW);
    expect(isServiceKeyToken(OLD)).toBe(true);
    expect(isServiceKeyToken(NEW)).toBe(true);
    expect(isServiceKeyToken(LEGACY)).toBe(false);
    expect(isServiceKeyToken(undefined)).toBe(false);
  });

  it('warns once, listing the available key names but no value, when SERVICE_KEY_NAME matches nothing', async () => {
    vi.resetModules();
    const fresh = await import('./service-key');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubDenoEnv({
      SUPABASE_SECRET_KEYS: keys({ default: OLD, 'edge-2026-09': NEW }),
      SERVICE_KEY_NAME: 'edge-2026-9',
    });

    expect(fresh.getServiceKey()).toBe(OLD);
    expect(fresh.getServiceKey()).toBe(OLD);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0].map(String).join(' ');
    expect(message).toContain('SERVICE_KEY_NAME');
    expect(message).toContain('default');
    expect(message).toContain('edge-2026-09');
    expect(message).not.toContain(OLD);
    expect(message).not.toContain(NEW);
  });

  it('never echoes SERVICE_KEY_NAME, so pasting a key VALUE there cannot leak it into logs', async () => {
    vi.resetModules();
    const fresh = await import('./service-key');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubDenoEnv({ SUPABASE_SECRET_KEYS: keys({ default: OLD }), SERVICE_KEY_NAME: NEW });

    expect(fresh.getServiceKey()).toBe(OLD);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0].map(String).join(' ');
    expect(message).not.toContain(NEW);
    expect(message).not.toContain(OLD);
  });

  it('does not warn when SERVICE_KEY_NAME resolves or is unset', async () => {
    vi.resetModules();
    const fresh = await import('./service-key');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    stubDenoEnv({ SUPABASE_SECRET_KEYS: keys({ default: OLD, 'edge-2026-09': NEW }), SERVICE_KEY_NAME: 'edge-2026-09' });
    expect(fresh.getServiceKey()).toBe(NEW);
    stubDenoEnv({ SUPABASE_SECRET_KEYS: keys({ default: OLD }) });
    expect(fresh.getServiceKey()).toBe(OLD);

    expect(warn).not.toHaveBeenCalled();
  });
});
