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

// ── Duplicate keys ───────────────────────────────────────────────────────────
// JSON.parse silently keeps the LAST of two same-named keys, so a duplicate is
// invisible to every check above — and to the reviewer reading the diff. The
// shadowed entry still looks live in the file, which is the trap: editing it
// changes nothing at all.
//
// This is not hypothetical. 34 duplicates had accumulated across driver.json
// and rider.json in all three locales, and the pairs had drifted apart:
// ride.cancel_confirm held BOTH the question ("¿Seguro que deseas cancelar el
// viaje?") and the button label ("Sí, cancelar"); trip.action_finish held both
// "Finalizar" and "Finalizar viaje"; five strings had a typographic ellipsis in
// the dead copy and "..." in the live one. Somebody polished each of those and
// the polish never shipped.
//
// Needs its own parser precisely because JSON.parse cannot express the
// question: by the time you hold the object, the evidence is gone.
function findDuplicateKeys(text) {
  let i = 0;
  const dups = [];
  const lineOf = (idx) => text.slice(0, idx).split('\n').length;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  function str() {
    i++;
    let s = '';
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') { s += text[i + 1]; i += 2; continue; }
      if (c === '"') { i++; return s; }
      s += c; i++;
    }
    throw new Error('unterminated string');
  }
  function value(path) {
    ws();
    const c = text[i];
    if (c === '{') return object(path);
    if (c === '[') return array(path);
    if (c === '"') return str();
    while (i < text.length && !/[,\]}\s]/.test(text[i])) i++;
  }
  function object(path) {
    i++; ws();
    const seen = new Map();
    if (text[i] === '}') { i++; return; }
    for (;;) {
      ws();
      const at = i;
      const key = str();
      const full = path ? `${path}.${key}` : key;
      if (seen.has(key)) dups.push({ path: full, first: seen.get(key), second: lineOf(at) });
      else seen.set(key, lineOf(at));
      ws(); i++; // ':'
      value(full);
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; break; }
      throw new Error(`unexpected ${JSON.stringify(text[i])} at offset ${i}`);
    }
  }
  function array(path) {
    i++; ws();
    if (text[i] === ']') { i++; return; }
    let n = 0;
    for (;;) {
      value(`${path}[${n++}]`); ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; break; }
      throw new Error(`unexpected ${JSON.stringify(text[i])} at offset ${i}`);
    }
  }
  value('');
  return dups;
}

const files = readdirSync(join(LOCALES_DIR, SOURCE)).filter((f) => f.endsWith('.json'));

const missing = [];
const stale = [];
const duplicates = [];

for (const locale of [SOURCE, ...TARGETS]) {
  for (const file of readdirSync(join(LOCALES_DIR, locale)).filter((f) => f.endsWith('.json'))) {
    const text = readFileSync(join(LOCALES_DIR, locale, file), 'utf8');
    for (const d of findDuplicateKeys(text)) {
      duplicates.push(`${locale}/${file}  ${d.path}  (lines ${d.first} and ${d.second})`);
    }
  }
}

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

// ── Shared-source contract: the quick replies ────────────────────────────────
// packages/utils/src/chatQuickReplies.ts is the single source of truth for
// which canned replies exist and which role sees each one. Every entry there
// is rendered as `chat.quick_<key>`, so a preset with no matching locale entry
// silently renders its own key name.
//
// This is deliberately narrow rather than a blanket "every key used in code
// must exist in es". That blanket rule would fight a documented convention:
// throwaway labels are allowed to live as t('key', { defaultValue: '…' }) with
// no JSON entry at all, so it would report hundreds of intentional cases and be
// switched off within a week. What broke here was not a missing translation but
// a BROKEN CONTRACT — the driver screen asked for `quick_waiting` and
// `quick_thanks` while the shared source declares `wait_please` and
// `thank_you`. Checking the contract catches that with no noise.
const QUICK_REPLY_SOURCE = 'packages/utils/src/chatQuickReplies.ts';
const contractBreaks = [];
try {
  const src = readFileSync(QUICK_REPLY_SOURCE, 'utf8');
  const presets = [...src.matchAll(/key:\s*'([a-z0-9_]+)'\s*,[\s\S]*?roles:\s*\[([^\]]*)\]/g)].map(
    (m) => ({ key: m[1], roles: m[2] }),
  );
  if (presets.length === 0) {
    contractBreaks.push(`${QUICK_REPLY_SOURCE} — no presets parsed; has QUICK_REPLIES changed shape?`);
  }
  // rider → rider.json, driver → driver.json
  for (const { key, roles } of presets) {
    for (const [role, ns] of [['rider', 'rider.json'], ['driver', 'driver.json']]) {
      if (!roles.includes(`'${role}'`)) continue;
      for (const locale of [SOURCE, ...TARGETS]) {
        const keys = new Set(flatten(load(locale, ns)));
        if (!keys.has(`chat.quick_${key}`)) {
          contractBreaks.push(`${locale}/${ns}  chat.quick_${key}  (declared for '${role}' in QUICK_REPLIES)`);
        }
      }
    }
  }
} catch (err) {
  contractBreaks.push(`${QUICK_REPLY_SOURCE} — cannot be checked (${err.message})`);
}

if (stale.length > 0) {
  console.warn(`\n⚠ ${stale.length} key(s) exist in en/pt but not in es (likely stale, not failing):`);
  for (const s of stale.slice(0, 20)) console.warn(`  ${s}`);
  if (stale.length > 20) console.warn(`  … and ${stale.length - 20} more`);
}

if (contractBreaks.length > 0) {
  console.error(`\n✖ ${contractBreaks.length} quick-reply preset(s) have no locale entry:\n`);
  for (const c of contractBreaks) console.error(`  ${c}`);
  console.error(
    '\nEvery entry in QUICK_REPLIES renders as chat.quick_<key>. Add the missing\n' +
      'entries, or remove the preset from the shared source if it is not wanted.\n',
  );
}

if (missing.length > 0) {
  console.error(`\n✖ ${missing.length} Spanish key(s) have no translation:\n`);
  for (const m of missing) console.error(`  ${m}`);
  console.error(
    '\nAdd them to the locale files above. If the string is a throwaway label, keep it\n' +
      "out of es/ too and rely on t('key', { defaultValue: '…' }) instead — the point is\n" +
      'that es/ and en/pt agree on what counts as real copy.\n',
  );
}

if (duplicates.length > 0) {
  console.error(`\n✖ ${duplicates.length} duplicate key(s) in the locale files:\n`);
  for (const d of duplicates) console.error(`  ${d}`);
  console.error(
    '\nJSON.parse keeps the LAST one, so the earlier entry is dead weight that still\n' +
      'looks live — edit it and nothing happens. Keep one entry per key: put the value\n' +
      'you want on the first occurrence and delete the rest.\n',
  );
}

if (missing.length > 0 || contractBreaks.length > 0 || duplicates.length > 0) process.exit(1);

console.log(
  `✓ i18n parity: ${files.length} namespace(s) × ${TARGETS.length} locale(s), no missing translations` +
    '\n✓ quick-reply presets: every entry in QUICK_REPLIES has a locale entry for each role that sees it' +
    '\n✓ no duplicate keys shadowing each other',
);
