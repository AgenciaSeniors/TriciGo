#!/usr/bin/env node
// ============================================================================
// Guardrail: type-check the Deno Edge Functions for RUNTIME-FATAL errors.
//
// WHY THIS EXISTS
// PR #828 refactored the four payment Edge Functions to use a shared
// getFreshFx() helper, but create-netopia-payment-intent ended up CALLING
// getFreshFx and FX_UNAVAILABLE_DETAIL with no import for them — a guaranteed
// ReferenceError on every authenticated NETOPIA recharge (the main payment
// path). It reached production. Nothing in the pipeline could catch it:
//   - `node --check` validates SYNTAX only; an undefined identifier parses fine.
//   - `pnpm check-types` (tsc/turbo) does not cover supabase/functions — those
//     are Deno, outside every tsconfig in the monorepo.
// The only thing that surfaced it was the CLI deploy output listing one fewer
// bundled file than its siblings. That is not a control; it's luck.
//
// WHY NOT JUST FAIL ON EVERY `deno check` ERROR
// Measured on master (2026-07-19): a blanket `deno check` over the 45 entry
// points reports 34 PRE-EXISTING errors — TS2352 (19), TS2345 (8), TS2339 (4),
// TS2739, TS2551, TS1192 — mostly loose `as` casts and untyped supabase.rpc()
// results (the Supabase client is intentionally untyped; see CLAUDE.md "Sweep de
// contrato cliente↔prod"). Gating on all of them would paint CI red on every
// unrelated PR and get the check disabled within a week.
//
// So this gates on a SMALL set of codes that (a) mean "this throws at runtime,
// always", and (b) have ZERO occurrences on master today — verified, so it goes
// green on day one and any future hit is a genuine regression. Everything else
// is printed as informational legacy debt and does not fail the build.
// ============================================================================

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Codes that are unambiguously a runtime crash, with 0 hits on master today.
// Verified: removing the fx-freshness import from create-netopia-payment-intent
// reproduces exactly TS2304 x2 ("Cannot find name 'getFreshFx'" /
// "'FX_UNAVAILABLE_DETAIL'"), i.e. this set would have caught the real incident.
//
// TS2551 was NOT gated originally because it had one pre-existing hit — and that
// hit turned out to be a live bug, not noise: `supabase.rpc(...).catch(...)` in
// directions-google. PostgrestFilterBuilder is a thenable with no .catch, so that
// throws a TypeError. It is the same defect that produced the new-user signup 500
// in verify-otp (#622). With it fixed the count is zero, so the code can gate and
// the whole ".catch on a Postgrest builder" family is now caught at PR time.
// Lesson: a lone pre-existing "error" is worth reading before writing it off as
// baseline noise.
const FATAL = {
  TS2304: "Cannot find name (identifier used but never imported/declared)",
  TS2305: "Module has no exported member (importing something that doesn't exist)",
  TS2307: "Cannot find module (broken import path)",
  TS2551: "Property does not exist, did you mean...? (calling a method that isn't there)",
  TS2552: "Cannot find name, did you mean...? (typo'd identifier)",
};

const FUNCTIONS_DIR = join('supabase', 'functions');
const stripAnsi = (s) => s.replace(/\[[0-9;]*m/g, '');

function resolveDeno() {
  // CI installs deno via denoland/setup-deno (on PATH). Locally fall back to npx.
  if (spawnSync('deno', ['--version'], { shell: true }).status === 0) {
    return { cmd: 'deno', pre: [] };
  }
  return { cmd: 'npx', pre: ['--yes', 'deno@2'] };
}

function main() {
  if (!existsSync(FUNCTIONS_DIR)) {
    console.error(`[check-ef-types] ${FUNCTIONS_DIR} not found — run from the repo root.`);
    process.exit(1);
  }

  const entrypoints = readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => join(FUNCTIONS_DIR, d.name, 'index.ts'))
    .filter(existsSync);

  if (entrypoints.length === 0) {
    console.error('[check-ef-types] no Edge Function entrypoints found.');
    process.exit(1);
  }

  const { cmd, pre } = resolveDeno();
  console.log(`[check-ef-types] deno check over ${entrypoints.length} entrypoints...`);

  const res = spawnSync(cmd, [...pre, 'check', '--no-lock', ...entrypoints], {
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = stripAnsi(`${res.stdout ?? ''}\n${res.stderr ?? ''}`);

  // Deno couldn't run at all (network down, binary missing) — don't silently pass.
  if (res.error || (res.status !== 0 && !/TS\d+ \[ERROR\]/.test(output))) {
    console.error('[check-ef-types] deno check could not complete:');
    console.error(output.split('\n').filter(Boolean).slice(-25).join('\n'));
    process.exit(1);
  }

  // Split the report into per-error blocks so each code keeps its location.
  const blocks = output.split(/(?=TS\d+ \[ERROR\])/).filter((b) => /^TS\d+ \[ERROR\]/.test(b));
  const fatal = [];
  const legacy = new Map();

  for (const block of blocks) {
    const code = block.match(/^(TS\d+)/)[1];
    if (code in FATAL) fatal.push(block.trim());
    else legacy.set(code, (legacy.get(code) ?? 0) + 1);
  }

  const legacyTotal = [...legacy.values()].reduce((a, b) => a + b, 0);
  if (legacyTotal > 0) {
    const breakdown = [...legacy.entries()].sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `${c}x${n}`).join(' ');
    console.log(`[check-ef-types] ${legacyTotal} pre-existing non-fatal type errors (not gated): ${breakdown}`);
  }

  if (fatal.length === 0) {
    console.log('[check-ef-types] OK — no runtime-fatal type errors.');
    return;
  }

  console.error(`\n[check-ef-types] FAILED — ${fatal.length} runtime-fatal type error(s):\n`);
  for (const block of fatal) {
    console.error(block.split('\n').slice(0, 6).join('\n'));
    console.error('');
  }
  console.error('These crash at runtime the first time the code path executes.');
  console.error('Gated codes:');
  for (const [code, why] of Object.entries(FATAL)) console.error(`  ${code}  ${why}`);
  process.exit(1);
}

main();
