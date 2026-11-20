# Strong PR validators and manual promotion to production

Date: 2026-11-20. Status: draft for approval.

## Intent

Eduardo asked for the way Criavia works, applied to TriciGo: reviewers and skills, strong
validation on every PR that hunts every kind of bug, tests and rehearsals with every change, and
a controlled path to production.

Criavia does it in three layers (read on 2026-11-20 in its repository):

1. **A method per task.** Own branch and worktree, a written plan, the opposite model reviews the
   plan (`cross-plan`) and later the code (`cross-review`). The verdict is closed (approved,
   approved with reservations, blocked), there are at most two rounds, approving requires a
   passing test the reviewer ran plus one case outside the author's list, blocking requires a
   reproduction. Three human stops: plan, PR, test before production.
2. **A strict CI.** Clean database where migrations must build everything, schema drift check,
   lint, types (also of the tests), unit and integration tests, image builds, dependency audit,
   actions pinned by SHA, minimal token permissions.
3. **Merge does not publish.** Production only receives an artifact that was already built and
   tested, by a manual promotion with a human OK, at low-traffic hours.

Decisions taken with Eduardo on 2026-11-20:

- **No staging environment for now.** Everything rests on the validators before merge.
- **AI review in two places:** locally before the PR (Codex reviews what Claude writes, with
  executed evidence) and as a bot on every PR in GitHub.
- **Manual promotion:** merging to `master` no longer deploys.

## Where TriciGo starts (verified 2026-11-20)

- `deploy-web.yml` and `deploy-admin.yml` run on every push to `master` that touches their paths:
  build on a GitHub runner, then rsync + PM2 on the VPS through the self-hosted runner. Merge is
  deploy. CLAUDE.md "`deploy-web.yml` puede reportar success sin desplegar rutas nuevas"
  documents a deploy that reported success while serving 404s.
- One Supabase project (`lqaufszburqvlslpcuac`), no preview branches. The EAS `preview` profile
  points at the production backend. Emulator QA rounds run against production with QA accounts.
- Migrations are applied by hand through the MCP with Eduardo's OK. CI never runs them, and the
  history cannot be replayed from zero (it dies at `00156` because some tables were created by
  hand; CLAUDE.md, decision 2026-09-27). Edge Functions are deployed by hand.
- `ci.yml` runs on every PR: lint, Edge Function import pinning and types, i18n parity, POI
  taxonomy, migration GRANTs, `check-types`, vitest (about 215 test files in client, driver,
  `packages/api`, `packages/utils` and the functions). It does not build anything. Admin and web
  have no tests, web has no lint script. The 90 SQL rehearsals in `supabase/tests/` run by hand on
  a sandbox Postgres (`sudo -u pgtest psql -p 5433`), never in CI. Maestro (2 flows) and k6 never
  run.
- `master` has no branch protection and no rulesets. There is no PR template and no CODEOWNERS.
  The last 15 merged PRs have no recorded review. The repository is public.
- Both apps use `runtimeVersion: { policy: "appVersion" }` (`apps/client/app.json`,
  `apps/driver/app.json`). The header of `eas-update.yml` still says the driver uses the
  `fingerprint` policy; that is stale. With `appVersion`, a native change shipped without a
  version bump lets an OTA reach binaries that lack the native code.
- **The production migration registry does not match the files one to one.** Of the 90 files from
  `00600` on, 11 have no registry entry starting with their number: `00617`, `00618`, `00620`,
  `00623`, `00626`, `00637`, `00648`, `00653`, `00654`, `00664`, `00666`. They were either applied
  some other way (`execute_sql`, another name) or never applied. Newer applies use the file stem
  as the name (`00691_driver_approval_bonus`).
- Already good and kept: OTA with staged rollout and pause/rollback/promote ops, the GRANT check,
  the runner job gate (`ops/actions-runner/job-gate.sh`), actions pinned by SHA in several
  workflows, the "never `supabase db push`" guard in `ci.yml`.

## Goals

- No PR reaches `master` without a green, required CI that builds, tests and rehearses what it
  changes.
- Every change comes with tests, or with a written reason the reviewers can reject.
- Changes to sensitive areas are reviewed by the opposite model with executed evidence before the
  PR, and every PR gets an automatic review in GitHub whose serious findings block the merge.
- Production only receives a commit of `master` that passed all of the above, through one manual
  door that shows what is going out, asks for Eduardo's approval, deploys the same build CI made,
  and proves the server is serving that commit. Rollback is one run.

## Non-goals

- A staging environment, preview databases or a full-schema baseline (see "What this does not
  cover").
- Running the apps end to end in CI (emulator, Maestro, k6).
- Changing how store builds are made or submitted.
- Coverage percentages. Reviewers judge whether the tests prove the change.

## Design

### 1. Required CI on every PR

`master` gets branch protection: PR required, the checks below required, conversations must be
resolved before merge, no force push, no deletion, and the rules apply to admins too (the agents
work under the owner account, so an admin bypass would let them merge red). Approving reviews are
not required: there is one human account.

Existing steps stay. New ones:

| Check | What it catches | How |
|---|---|---|
| Build web and admin | Build errors that today appear only at deploy | `next build` of both with the production public env values, then start the standalone server and expect 200 on a short list of routes |
| Bundle the apps | Metro bundling errors, missing assets | `expo export` for `apps/client` and `apps/driver` |
| Native change vs version | An OTA that would break installed apps | Compute the Expo native fingerprint (`@expo/fingerprint`) of each app on the base and the head. Changed fingerprint with unchanged `expo.version`: fail. Changed and version bumped: pass, label `needs-store-build` |
| Migration rehearsal | SQL that fails, is not idempotent, breaks access or does not do what it claims | See 1.1 |
| Applied migrations are immutable | Editing a migration already on `master` | A PR that modifies or deletes an existing file under `supabase/migrations/` fails |
| Tests come with the change | Code without tests | See 1.2 |
| Secrets | Keys in a public repo (a service-role key leaked before) | `gitleaks` on the PR commits, pinned by SHA, with an allowlist for the known public values (anon key, publishable keys, public Mapbox token) |
| Production dependencies | Known high vulnerabilities | `pnpm audit --prod --audit-level high` |
| Web lint | Web is skipped by `pnpm lint` today | Add the `lint` script to `apps/web` with the shared config |
| PR description | Missing evidence, missing cross-review | See 1.3 |

Every new check is first proven against a deliberately broken case (it must fail) and the fixed
case (it must pass) before it becomes required. Pre-existing failures it exposes (web lint errors,
audit findings) are fixed in the same PR that adds the check, or listed as an explicit allowlist
with a reason.

#### 1.1 Migration rehearsal

The format already used by the 90 rehearsals becomes mandatory and runs in CI:

- Every new file `supabase/migrations/NNNNN_name.sql` comes with `supabase/tests/NNNNN/`:
  `scaffold.sql` (the minimal live objects the migration touches, with their current production
  definitions), `tests.sql` (assertions that insert failures into `_t_fail`), and optional
  fixtures.
- A runner script (`scripts/rehearse-migration.sh NNNNN`) reads standard `PG*` variables, so the
  same script runs in CI and against a local Docker Postgres. It creates a fresh database, loads
  the scaffold, applies the migration twice (idempotency), runs `tests.sql`, and fails when
  `_t_fail` is not empty.
- CI runs it for every migration the PR adds, on a Postgres service using the `supabase/postgres`
  image pinned by digest, which brings the Supabase roles (`anon`, `authenticated`,
  `service_role`) and extensions such as PostGIS. Whatever the migration needs from `auth` beyond
  what the image provides comes from the scaffold.
- A migration without a rehearsal fails unless its first line is
  `-- rehearsal-exempt: <reason>`. The reviewers judge the reason.
- The old rehearsals keep their own `run.sh`; they are ported only when touched.
- A helper prints the current definition of the functions, views and policies a migration touches
  (read-only, through the MCP or `pg_get_functiondef`), so writing the scaffold is cheap.

#### 1.2 Tests come with the change

If the PR touches source (`packages/*/src`, `apps/*/src`, `apps/*/app`, `supabase/functions` except
tests, `supabase/migrations`) and touches no test (`**/__tests__/**`, `*.test.ts`, `*.test.tsx`,
`supabase/tests/**`, `.maestro/**`), the check fails unless the PR description has a line
`No tests because: <reason>` with a real reason. The cross-review and the bot judge it.

#### 1.3 PR description

A PR template (`.github/pull_request_template.md`) with: what changes for the user, why, how it was
validated (commands and output), the sensitive areas touched, the cross-review verdict, the native
or OTA impact, and migration status (applied or not, and the tolerance of the code while it is
not).

A check reads the description on `opened`, `edited`, `synchronize` and `ready_for_review`:

- the template sections are present and not empty;
- the sensitive areas are detected from the diff with a path map (`docs/review/areas.json`): money
  (wallet, payments, promotions, gifts, bonuses), access (auth, RLS, GRANTs, RPC exposure, and the
  workflows and `ops/` scripts that hold secrets and reach production), schema
  (migrations), dispatch (ride state, offers, matching), Edge Functions, native. If any is touched,
  the description must carry the verdict line produced by the local cross-review:
  `Cross-review: <verdict> <work-id> <sha>`, where `<verdict>` is `APPROVED`,
  `APPROVED_WITH_RESERVATIONS` or `FIX_CONFIRMED`;
- the reviewed `<sha>` must be an ancestor of the PR head, and no file of a sensitive area may
  change after it. A fix after the review needs the round-2 verdict line.

### 2. Reviewers

#### 2.1 One checklist per area

`docs/review/<area>.md`, one per area of the path map plus a general one. Each item says what to
check and how to prove it (a query, a command, a test). They are written from the bugs TriciGo
already had and documented in CLAUDE.md (NETOPIA atomic claim, stale precomputed fields, "the
previous PR changed X and forgot Y", GRANTs on new tables, SECURITY DEFINER without
`search_path`, test accounts leaking into dispatch). The three reviewers below read the same
files: one source of truth.

#### 2.2 Claude reviewer agents

`.claude/agents/reviewer-<area>.md`: read-only plus shell to run tests, given the diff and the
area checklist, returning findings P0 to P3 with proof. The author runs the ones of the touched
areas before calling Codex, so a Codex round is not spent on the obvious. They do not replace the
cross-review: the author's own model does not approve its own work.

#### 2.3 Local cross-review with Codex

Two repository skills adapted from Criavia's, named `cross-plan-tricigo` and
`cross-review-tricigo` so they do not collide with the personal `cross-plan`/`cross-review`
skills, in `.claude/skills/` and `.agents/skills/` (so Codex can run them when it is the author):

- same rules: opposite model through its CLI, closed verdict, two rounds at most, approving needs
  a passing `GATE` test and a case outside the author's list, blocking needs a reproduction,
  operational failure is never approval, no secrets in notes or evidence;
- TriciGo validation commands (lint, `check-types`, the vitest packages touched, the migration
  rehearsal, the builds) and the TriciGo rulebook (CLAUDE.md plus the checklists of the touched
  areas, injected into the prompt by the path map);
- the review folder lives outside the repository (`~/.tricigo-reviews/<work-id>/`);
- the skill ends by printing the verdict line for the PR description (1.3).

When it is required: the code review whenever a sensitive area is touched; the plan review when
the change touches money, dispatch state or access, or crosses several modules. Docs-only and
copy-only changes skip both.

#### 2.4 Codex review bot in GitHub

- Codex code review with automatic reviews, enabled for `AgenciaSeniors/TriciGo` in the Codex
  settings of Eduardo's ChatGPT account. No API key goes into the repository. It reports only P0
  and P1 findings.
- A short root `AGENTS.md` with a "Review guidelines" section: a summary of the area checklists,
  "tests must come with the change", and the TriciGo invariants. The untracked 1510-line
  `AGENTS.md` sitting in the main checkout is an old copy of CLAUDE.md and is not committed.
- Because branch protection requires conversations to be resolved, every bot comment blocks the
  merge until it is fixed or answered. Agents never resolve a bot thread without a fix or
  Eduardo's OK (CLAUDE.md rule).
- If Eduardo's plan does not include automatic reviews, the fallback is commenting `@codex review`
  on each PR.

### 3. Manual promotion to production

#### 3.1 Build once

On every push to `master`, a `release-build` workflow builds web and admin with the production
public values, writes `public/release.json` (`{ "sha": ..., "built_at": ... }`) into each build,
and uploads them as artifacts named `web-<sha>` and `admin-<sha>`, kept 30 days. The artifact
carries its own identity, like an image digest in Criavia.

#### 3.2 One door: `promote.yml`

Launched by hand (`workflow_dispatch`, input `sha`, default the head of `master`). The sessions'
GitHub integration cannot launch workflows (403), so only the owner launches it.

1. **Preflight** (GitHub runner, no approval). Refuses unless the `sha` is on `master`, CI is green
   for it and both artifacts exist. Finds what is in production from the last successful GitHub
   deployment to the `production` environment. Writes a job summary: PRs in the range, migrations
   added in the range with their registry status, Edge Functions changed, native fingerprint
   changes (for the OTA). **Refuses if a migration added in the range has no registry entry named
   exactly as its file stem** (read through the Supabase Management API). Warns, without
   blocking, outside the 02:00 to 06:00 Havana window.
2. **Approval.** The deploy jobs use the `production` environment with Eduardo as required
   reviewer, so the run pauses after the summary until he approves.
3. **Deploy web and admin** (self-hosted runner). If `/var/www/<app>/releases/<sha>` already exists
   it is reused, otherwise the artifact is downloaded. The existing checks stay (sharp loads with
   the server's Node). The `current` link switches to the release and PM2 restarts from it. The
   last 5 releases are kept.
4. **Deploy Edge Functions** (GitHub runner, `production` environment). Functions whose folder
   changed in the range; a change in `supabase/functions/_shared` deploys all. Supabase CLI pinned.
5. **Verify.** `https://tricigo.com/release.json` and the admin equivalent must return the promoted
   `sha`, and a short list of routes must return 200, otherwise the run fails with the rollback
   command. On success it records the GitHub deployment for the `sha`.

`SUPABASE_ACCESS_TOKEN` moves from repository secrets to environment secrets, restricted to the
`master` branch: a `production-preflight` environment without reviewers (the preflight reads the
registry with it) and the `production` environment with Eduardo as reviewer (the Edge Function
deploy). Today any workflow pushed to any branch can read a repository secret; an environment
restricted to `master` cannot be used from another branch.

`ops/actions-runner/job-gate.sh` only lets the `deploy` job of `deploy-web.yml` and
`deploy-admin.yml` through. `promote.yml` is added to `GATE_WORKFLOWS` and the hook is reinstalled
on the VPS (owner action, `ops/actions-runner/README.md`). After the first successful promotion,
the push trigger and the deploy jobs of `deploy-web.yml`/`deploy-admin.yml` are removed, so
promotion is the only door.

#### 3.3 Rollback

Run `promote.yml` with the previous `sha`. Its release folder is still on the VPS, so it switches
in seconds. Migrations are never rolled back by this path; schema problems are fixed forward with
a new migration.

#### 3.4 Migrations

Still applied by hand through the MCP with Eduardo's explicit OK, before promoting the code that
needs them, and the code keeps tolerating their absence (CLAUDE.md "MCP migration guard"). New
rule: `apply_migration` always uses the file stem as the name, so the preflight can match files to
the registry. Before the preflight check goes live, the 11 unmatched files listed above are
reconciled once: for each, confirm in production whether its objects exist and record the result.

#### 3.5 Mobile OTA

`eas-update.yml` keeps its env parity check, bundle gate and staged rollout, and adds: the `sha`
must be on `master` with green CI, and the app's native fingerprint at `sha` must equal the one at
the commit that last changed its `expo.version` (the code the store build of that version was
made from). Its stale header about the driver's `fingerprint` policy is corrected.

### 4. Written rules

- CLAUDE.md gets a section "Método de trabajo y publicación" (in Spanish, like the rest of the
  file): own branch and worktree, plan, `cross-plan-tricigo` when required, code with tests,
  reviewer agents, `cross-review-tricigo`, PR with the template, Eduardo's merge OK per PR,
  promotion launched by Eduardo. It also states that an agent never resolves a bot review thread
  without a fix or Eduardo's OK, and that `apply_migration` uses the file stem as the name. The
  stale "Deploy: Vercel" line is corrected.
- `docs/runbooks/promotion.md`: promote, roll back, the emergency path (temporarily lifting admin
  enforcement on `master`, with the reason recorded), adding a workflow to the runner gate.

## What this does not cover (no staging)

- End-to-end runs of the apps (emulator rounds, Maestro, k6) stay manual and against production
  with QA accounts.
- Migration rehearsals test what the scaffold models, not the full production schema. A full
  baseline needs a production database credential, and a schema dump does not belong in a public
  repository. Revisit with staging.
- Edge Functions have unit tests but no test of the deployed runtime before production.

## Delivery order (separate PRs)

1. **Review text and governance:** PR template, `docs/review/` checklists and `areas.json`, root
   `AGENTS.md` with review guidelines, CLAUDE.md method section. Owner actions: enable the Codex
   bot.
2. **CI checks** (1.1 to 1.3, the table above), each with its negative control. Then the owner
   action: branch protection with the checks required.
3. **Skills and reviewer agents** (2.2, 2.3), exercised end to end on one real PR.
4. **Promotion** (3.1 to 3.5): migration registry reconciliation, `release-build`, `promote.yml`,
   runner gate update, first real promotion, removal of the old deploy triggers, runbook.

## Acceptance

- Each new CI check: a deliberately broken case fails and the fixed case passes, with the run
  links in its PR.
- With protection on, `gh pr merge` is refused on a PR with a red required check or an unresolved
  bot thread.
- The Codex bot reviews a test PR on its own.
- `cross-review-tricigo` runs end to end on one real PR and its verdict line passes the PR
  description check; a line with a stale `sha` fails it.
- One real promotion: the preflight summary lists the right PRs and migrations, the run waits for
  approval, `release.json` serves the promoted `sha`. A rollback to the previous `sha` restores it.

## Risks

- **Hotfixes get slower.** Required checks and a manual door add minutes. The emergency path is
  documented, and the checks run in parallel jobs.
- **CI gets longer.** Builds and `expo export` add time. Actions are free for public
  repositories; the duration is measured in PR 2 and jobs are split if it passes 15 minutes.
- **Rehearsal burden per migration.** Mitigated by the scaffold helper and the exemption line.
- **False positives of the tests-required check.** Mitigated by the reason line.
- **The bot depends on the ChatGPT plan.** Fallback: `@codex review` by hand.
- **The self-hosted runner runs as root.** The gate keeps only master workflows by
  `workflow_dispatch`; `promote.yml` is added explicitly.
- **`SUPABASE_ACCESS_TOKEN` is account-wide.** Supabase has no read-only token, so it stays
  powerful. It is reachable only from `master` workflows through the two environments, and only
  the Edge Function deploy, which waits for approval, writes with it.

## Owner actions

- Enable Codex code review and automatic reviews for the repository.
- Approve the branch protection settings (an agent can apply them with `gh api` after an explicit
  OK).
- Create the `production-preflight` and `production` environments (restricted to `master`, the
  second with himself as required reviewer) and move the secret.
- Update `GATE_WORKFLOWS` on the VPS and reinstall the hook.
- Approve each migration apply, as today.
