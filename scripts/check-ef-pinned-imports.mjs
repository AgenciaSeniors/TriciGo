#!/usr/bin/env node
// ============================================================
// Guardrail: every remote import in supabase/functions/** must be pinned to an
// EXACT version (@x.y.z).
//
// Floating specifiers (@2, @latest, a jsr:/npm: package without a full semver,
// or no version at all) silently resolve to whatever the CDN serves AT DEPLOY
// TIME. A @supabase/supabase-js@2 esm.sh bump on 2026-06-20 changed the
// Postgrest builder under us and broke new-user login (verify-otp 500) and
// address search (~1% TypeError). This check runs in CI so a floating import
// can never land again.
//
// Usage: node scripts/check-ef-pinned-imports.mjs   (exit 1 if any floating)
// ============================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'supabase/functions';

// A specifier is "remote" if it loads code over the network / a registry.
const REMOTE = /^(https?:\/\/|jsr:|npm:)/;
// "Pinned" = contains a full exact semver somewhere in the specifier
// (e.g. @2.108.2, pdf-lib@1.17.1?target=deno, jsr:@scope/pkg@1.2.3).
const EXACT_SEMVER = /@\d+\.\d+\.\d+/;

// Capture the specifier from the three import forms we use:
//   import { x } from '<spec>'   |   import '<spec>'   |   import('<spec>')
const SPEC_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // dir missing → nothing to check
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

const offenders = [];
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((rawLine, i) => {
    const trimmed = rawLine.trim();
    // Skip comment lines so a URL mentioned in a comment isn't flagged.
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    for (const re of SPEC_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(rawLine)) !== null) {
        const spec = m[1];
        if (REMOTE.test(spec) && !EXACT_SEMVER.test(spec)) {
          offenders.push({ file: file.replace(/\\/g, '/'), line: i + 1, spec });
        }
      }
    }
  });
}

if (offenders.length > 0) {
  console.error(`\n✖ ${offenders.length} floating (unpinned) remote import(s) in Edge Functions:\n`);
  for (const o of offenders) console.error(`  ${o.file}:${o.line}  →  ${o.spec}`);
  console.error('\nPin every remote import to an exact version (@x.y.z), e.g.');
  console.error("  'https://esm.sh/@supabase/supabase-js@2.108.2'   (NOT @2 / @latest)");
  console.error('\nWhy: an unpinned @supabase/supabase-js@2 bump (esm.sh, 2026-06-20)');
  console.error('changed the Postgrest builder and broke new-user login + address search.\n');
  process.exit(1);
}

console.log('✓ All Edge Function remote imports are pinned to exact versions.');
