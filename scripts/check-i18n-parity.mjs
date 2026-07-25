#!/usr/bin/env node
// ============================================================
// Guardrail: every i18n key that exists in Spanish must exist in English and
// Portuguese too.
//
// WHY THIS EXISTS
// The codebase has a deliberate convention (CLAUDE.md): trivial labels may be
// written as t('key', { defaultValue: '…' }) with no JSON entry, and only real
// copy gets translated. The failure mode is that "trivial" quietly grows: the
// whole driver-side cargo flow — 26 keys covering the delivery OTP and the
// pickup/delivery photos — reached production with ZERO entries in any locale,
// so an English- or Portuguese-speaking driver read Spanish fallbacks while
// standing at a customer's door holding a package.
//
// A defaultValue means the string still renders, so nothing ever breaks loudly.
// That is exactly why this needs a check rather than a code review.
//
// WHAT IT CHECKS
// Spanish is the source of truth (the product's primary language). For every
// namespace file, every key present in es/ must be present in en/ and pt/.
// Extra keys in en/pt are reported separately as stale, not as failures — they
// are usually leftovers from removed features and deleting them is a different
// decision.
//
// Usage: node scripts/check-i18n-parity.mjs   (exit 1 on any missing key)
// ============================================================

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const LOCALES_DIR = 'packages/i18n/src/locales';
const SOURCE = 'es';
const TARGETS = ['en', 'pt'];

/** Flatten a nested translation object into dotted key paths. */
function flatten(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, path, out);
    else out.push(path);
  }
  return out;
}

function load(locale, file) {
  return JSON.parse(readFileSync(join(LOCALES_DIR, locale, file), 'utf8'));
}

const files = readdirSync(join(LOCALES_DIR, SOURCE)).filter((f) => f.endsWith('.json'));

const missing = [];
const stale = [];

for (const file of files) {
  const sourceKeys = new Set(flatten(load(SOURCE, file)));

  for (const locale of TARGETS) {
    let targetKeys;
    try {
      targetKeys = new Set(flatten(load(locale, file)));
    } catch (err) {
      missing.push(`${locale}/${file} — cannot be read (${err.message})`);
      continue;
    }

    for (const key of sourceKeys) {
      if (!targetKeys.has(key)) missing.push(`${locale}/${file}  ${key}`);
    }
    for (const key of targetKeys) {
      if (!sourceKeys.has(key)) stale.push(`${locale}/${file}  ${key}`);
    }
  }
}

if (stale.length > 0) {
  console.warn(`\n⚠ ${stale.length} key(s) exist in en/pt but not in es (likely stale, not failing):`);
  for (const s of stale.slice(0, 20)) console.warn(`  ${s}`);
  if (stale.length > 20) console.warn(`  … and ${stale.length - 20} more`);
}

if (missing.length > 0) {
  console.error(`\n✖ ${missing.length} Spanish key(s) have no translation:\n`);
  for (const m of missing) console.error(`  ${m}`);
  console.error(
    '\nAdd them to the locale files above. If the string is a throwaway label, keep it\n' +
      "out of es/ too and rely on t('key', { defaultValue: '…' }) instead — the point is\n" +
      'that es/ and en/pt agree on what counts as real copy.\n',
  );
  process.exit(1);
}

console.log(`✓ i18n parity: ${files.length} namespace(s) × ${TARGETS.length} locale(s), no missing translations`);
