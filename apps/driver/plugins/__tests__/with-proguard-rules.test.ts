import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// CommonJS plugin, loaded the same way Expo loads it during prebuild.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require('../with-proguard-rules.js');
const { mergeProguardRules, SENTINEL } = plugin;

const GENERATED = `# Add project specific ProGuard rules here.
-keep class com.facebook.react.** { *; }
`;

describe('mergeProguardRules', () => {
  it('keeps everything prebuild generated', () => {
    const out = mergeProguardRules(GENERATED, '-keep class app.tricigo.driver.** { *; }');
    expect(out).toContain('-keep class com.facebook.react.** { *; }');
  });

  it('appends the TriciGo rules under a sentinel', () => {
    const out = mergeProguardRules(GENERATED, '-keep class app.tricigo.driver.** { *; }');
    expect(out).toContain(SENTINEL);
    expect(out.indexOf(SENTINEL)).toBeGreaterThan(out.indexOf('com.facebook.react'));
    expect(out).toContain('-keep class app.tricigo.driver.** { *; }');
  });

  // A second prebuild over the same tree must not stack the rules again.
  it('is idempotent', () => {
    const once = mergeProguardRules(GENERATED, '-keep class app.tricigo.driver.** { *; }');
    const twice = mergeProguardRules(once, '-keep class app.tricigo.driver.** { *; }');
    expect(twice).toBe(once);
    expect(twice.split(SENTINEL).length - 1).toBe(1);
  });

  it('works from an empty file', () => {
    const out = mergeProguardRules('', '-keep class app.tricigo.driver.** { *; }');
    expect(out).toContain('-keep class app.tricigo.driver.** { *; }');
  });
});

// The point of the plugin is the REAL file, not a fixture. If someone moves or
// renames build-config/proguard-rules.pro, R8 would run with no keep rules at
// all and strip every reflection-based library — a build that compiles and
// crashes on the user's phone.
describe('the real build-config/proguard-rules.pro', () => {
  const rules = readFileSync(
    fileURLToPath(new URL('../../build-config/proguard-rules.pro', import.meta.url)),
    'utf8',
  );

  it('exists and carries the rules the reflection-heavy libraries need', () => {
    for (const needed of [
      'com.mapbox',            // loads .so via JNI, reflects on GL configs
      'io.sentry',             // crash reporting must survive obfuscation
      'expo.',                 // every expo module is resolved by name
      'com.facebook.hermes',   // the VM itself
      'com.google.firebase',   // push delivery
    ]) {
      expect(rules).toContain(needed);
    }
  });

  // Without these, Sentry stack traces from release builds are unreadable.
  it('preserves line numbers for Sentry', () => {
    expect(rules).toContain('-keepattributes LineNumberTable,SourceFile');
  });

  it('survives the merge intact', () => {
    const out = mergeProguardRules(GENERATED, rules);
    expect(out).toContain('-keepattributes LineNumberTable,SourceFile');
    expect(out).toContain('com.mapbox');
  });
});
