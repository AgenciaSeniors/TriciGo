#!/usr/bin/env node
// ============================================================
// Guardrail: the NETOPIA in-app checkout is DUPLICATED per app (the
// webview-proxy native module is app-local, so packages/ui can't host the
// component). The client and driver copies MUST stay byte-identical — a fix
// applied to one and not the other is a real regression on the money path
// (Track 2d of the 2026-07-02 proxy audit).
//
// This checks the files that carry the payment LOGIC + native bridge. It does
// NOT check WebviewProxyModule.ts (that file has an intentional app-specific
// comment about which route the stub keeps loadable).
//
// Usage: node scripts/check-netopia-checkout-sync.mjs   (exit 1 if any drift)
// ============================================================

import { readFileSync } from 'node:fs';

// [clientPath, driverPath] pairs that must be identical.
const PAIRS = [
  ['apps/client/src/components/NetopiaCheckout.tsx', 'apps/driver/src/components/NetopiaCheckout.tsx'],
  ['apps/client/src/lib/pendingRecharge.ts', 'apps/driver/src/lib/pendingRecharge.ts'],
  ['apps/client/modules/webview-proxy/index.ts', 'apps/driver/modules/webview-proxy/index.ts'],
  [
    'apps/client/modules/webview-proxy/android/src/main/java/expo/modules/webviewproxy/WebviewProxyModule.kt',
    'apps/driver/modules/webview-proxy/android/src/main/java/expo/modules/webviewproxy/WebviewProxyModule.kt',
  ],
  ['apps/client/modules/webview-proxy/ios/WebviewProxyModule.swift', 'apps/driver/modules/webview-proxy/ios/WebviewProxyModule.swift'],
];

function read(p) {
  try {
    // Normalize line endings so a CRLF/LF mismatch alone isn't a false failure.
    return readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  } catch (e) {
    return { __missing: true, err: String(e) };
  }
}

const drift = [];
for (const [a, b] of PAIRS) {
  const ca = read(a);
  const cb = read(b);
  if (ca && ca.__missing) { drift.push(`${a} — missing (${ca.err})`); continue; }
  if (cb && cb.__missing) { drift.push(`${b} — missing (${cb.err})`); continue; }
  if (ca !== cb) drift.push(`${a}  ≠  ${b}`);
}

if (drift.length > 0) {
  console.error(`\n✖ NETOPIA checkout copies drifted (${drift.length}):\n`);
  for (const d of drift) console.error(`  ${d}`);
  console.error('\nApply the SAME change to both apps, e.g.:');
  console.error('  cp apps/client/src/components/NetopiaCheckout.tsx apps/driver/src/components/NetopiaCheckout.tsx\n');
  process.exit(1);
}

console.log('✓ NETOPIA checkout client/driver copies are in sync.');
