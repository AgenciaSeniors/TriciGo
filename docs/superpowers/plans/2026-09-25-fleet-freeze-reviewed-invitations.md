# Freeze a reviewed fleet invitation: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** once the admin has reviewed a fleet invitation, the fleet owner can no longer change what was reviewed (number, person, licence, fleet) or the admin's rejection reason. The change is silently discarded, like `status` today.

**Architecture:** one migration (00600) replaces `tg_fleet_members_protect()` with the live body plus one block in the owner's UPDATE branch. It refuses to replace a body it does not know, and it asserts itself with a rolled-back self-test that acts as a real non-admin account. A local Postgres rehearsal with the live prod bodies proves RED → GREEN. Spec: `docs/superpowers/specs/2026-09-25-fleet-freeze-reviewed-invitations-design.md`.

**Tech Stack:** PostgreSQL 16 / plpgsql (Supabase), bash + psql rehearsal, TypeScript JSDoc in `@tricigo/api`.

---

## File structure

| File | Responsibility |
|---|---|
| `supabase/tests/00600/scaffold.sql` (create) | Live prod shapes, RLS policies, grants and the function bodies an owner's write and the link paths run (byte for byte) |
| `supabase/tests/00600/run.sh` (create) | RED/GREEN runner: seed, owner-after-review cases, must-keep-working cases, contract, fidelity, a database built from git, negative proofs |
| `supabase/migrations/00600_freeze_reviewed_fleet_invitations.sql` (create) | Drift guard, the new `tg_fleet_members_protect()`, comment, self-test |
| `packages/api/src/services/fleet.service.ts` (modify: JSDoc of `uploadMemberLicense`) | Say that the path only changes while the invitation is in review |
| `CLAUDE.md` (modify: before "Fleet membership 3-way gate (corporate)") | The freeze rule, so a future owner-side edit screen doesn't get surprised |

Local cluster (Windows): portable Postgres 16 in the scratchpad, started with
`pg_ctl -D <scratchpad>/pgdata -o "-p 5441 -c listen_addresses=127.0.0.1" -l <scratchpad>/pg.log -w start`.
Runner env on Windows: `PGBIN=<scratchpad>/pgsql/bin PGPORT=5441 PYTHON=python`.

---

### Task 1: Rehearsal scaffold and runner (RED)

**Files:** create `supabase/tests/00600/scaffold.sql` (Appendix A), `supabase/tests/00600/run.sh` (Appendix B, mode 755).

- [ ] **Step 1:** write the scaffold. Every function body is copied from the live `pg_get_functiondef` (2026-09-25) and checked by md5 in the runner's `S` cases.
- [ ] **Step 2:** write the runner.
- [ ] **Step 3: run RED**

Run: `PGBIN=… PGPORT=5441 PYTHON=python bash supabase/tests/00600/run.sh none`
Expected: every `S … is the prod body` PASSES (the scaffold is faithful). The owner-after-review cases FAIL for the right reason: A1, A3–A6 and A9–A10 show the owner's values; A2 links the new number; A7–A8 show the owner's rejection text. PASS as controls: B1–B9 and D1–D4.

- [ ] **Step 4: commit**

```bash
git add supabase/tests/00600/scaffold.sql supabase/tests/00600/run.sh
git commit -m "test(fleet): rehearsal for freezing reviewed fleet invitations (RED)"
```

### Task 2: Migration 00600 (GREEN)

**Files:** create `supabase/migrations/00600_freeze_reviewed_fleet_invitations.sql` (Appendix C).

- [ ] **Step 1: re-check the number is free.** Look at master, every open PR and the other worktrees; 00598 and 00599 are taken by parallel sessions.

```bash
git fetch origin
git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -3
for pr in $(gh pr list --state open --json number --jq '.[].number'); do gh pr view $pr --json files --jq '.files[].path' | grep supabase/migrations; done
```

- [ ] **Step 2:** write the migration. The function body is the live one plus the `-- 00600:` block at the end of the UPDATE branch. The drift guard accepts three md5s: the live body, 00435's text in git, and the new body (a re-run).
- [ ] **Step 3: run GREEN**

Run: `PGBIN=… PGPORT=5441 PYTHON=python bash supabase/tests/00600/run.sh supabase/migrations/00600_freeze_reviewed_fleet_invitations.sql`
Expected: `summary: N passed, 0 failed`, including M1–M2, D5 (fidelity), G1 (a database built from git) and N1–N6.

- [ ] **Step 4:** check line endings: `git ls-files --eol` shows `w/lf` for the new files after `git add`.
- [ ] **Step 5: commit**

```bash
git add supabase/migrations/00600_freeze_reviewed_fleet_invitations.sql
git commit -m "fix(db): the fleet owner can no longer rewrite a reviewed invitation (00600)"
```

### Task 3: Service JSDoc

**Files:** modify `packages/api/src/services/fleet.service.ts` (JSDoc of `uploadMemberLicense`).

- [ ] **Step 1:** add to the JSDoc that the database keeps `license_doc_path` as reviewed once the invitation left review (00600), so the update only takes effect while it is `pending_review`.
- [ ] **Step 2: verify.** Run `pnpm check-types` (all packages pass) and `pnpm --filter @tricigo/api test -- fleet` (the fleet tests pass).
- [ ] **Step 3: commit**

```bash
git add packages/api/src/services/fleet.service.ts
git commit -m "docs(fleet): a reviewed invitation keeps its licence path"
```

### Task 4: CLAUDE.md

- [ ] **Step 1:** add a short section before "Fleet membership 3-way gate (corporate)": what the owner can and cannot change, why (every link path trusts `driver_phone` on an approved row), how to change a reviewed member (delete and invite again), and that the owner's write succeeds silently.
- [ ] **Step 2: commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): a reviewed fleet invitation is frozen for its owner"
```

### Task 5: Review, push, PR

- [ ] **Step 1:** get a code review from a subagent (superpowers:requesting-code-review) over `origin/master...HEAD`. Address the findings with superpowers:receiving-code-review, and re-run the rehearsal after any SQL change.
- [ ] **Step 2:** re-run the migration-number check from Task 2 Step 1 right before pushing.
- [ ] **Step 3:** `git push -u origin claude/fleet-freeze-reviewed-invitations`, then `gh pr create --base master --body-file <scratchpad>/pr-body.md`. The body covers the problem, the decisions, the fix, the rehearsal numbers, "not applied to production (MCP guard)" and the test plan.
- [ ] **Step 4:** file the two out-of-scope chips (the window during review, the licence file in Storage) and tell the 00598 session the PR number.
- [ ] **Step 5:** do not merge and do not apply the migration without explicit authorization for this PR.

---
