# Design: TriciGo Client Major Redesign — Master Spec

**Status:** approved (auto mode)
**Date:** 2026-04-29
**Author:** Eduardo + Claude
**Scope:** Full passenger-app visual + structural redesign across Home, Mis Viajes, Tricicoin, Perfil. Adoption of "Cuban modern" identity from existing moodboard. Dark mode coverage fix across the entire app.

## Goal

Transform the client app from a generic Uber-clone aesthetic to the "Cuban modern" identity already specified in [docs/DESIGN_CLIENT_HOME.md](docs/DESIGN_CLIENT_HOME.md). Make dark mode work everywhere (currently broken on most screens). Add Uber-like content cards (promotions, blog, campaigns) to the home so it feels alive instead of dead-empty.

## Non-Goals

- No backend schema changes.
- No driver/web/admin app redesigns (they each have their own identity already).
- No new payment integrations or ride-flow logic changes.
- No new screens/routes — only redesign existing ones + add cards inside Home.
- No iOS-specific work — Android is the validation surface for this iteration.

## User-confirmed decisions

1. **Dark mode** = global (Option B): every screen must respect `useThemeStore`, no exceptions. Current "only home" is treated as a bug.
2. **Tokens** = hybrid (Option C): inherit LUCIA structure (`surface`/`ink`/`line` tiered scale, applied to admin) **+** Cuban Modern palette (Cream/Dusk/Warm + Bricolage/Instrument).
3. **Apps separated**: driver/web/admin out of scope for visual changes; we only verify they don't break.

## Decomposition into 6 sub-projects

Each sub-project gets its own spec → plan → implementation cycle. Order is bottom-up: foundations first.

| # | Sub-project | Status | Spec file |
|---|---|---|---|
| 1 | Tokens + typography migration | next | `2026-04-29-tokens-migration-design.md` |
| 2 | Dark mode systematic coverage | pending | `YYYY-MM-DD-dark-mode-systematic-design.md` |
| 3 | Home enhancement (promos + blog + campaigns) | pending | `YYYY-MM-DD-home-enhancement-design.md` |
| 4 | Mis Viajes redesign | pending | `YYYY-MM-DD-mis-viajes-redesign-design.md` |
| 5 | Tricicoin redesign | pending | `YYYY-MM-DD-tricicoin-redesign-design.md` |
| 6 | Perfil redesign | pending | `YYYY-MM-DD-perfil-redesign-design.md` |

## Verification gate per sub-project

After each sub-project lands:
- **Multi-agent audit** (parallel): driver app, web app, admin app, DB schema — confirm no breakage. Each agent gets a self-contained prompt with exact file paths.
- **Type check** in `apps/client`, `apps/driver`, `apps/web`, `apps/admin`, `packages/*`.
- **Visual smoke test**: build dev client APK (workflow already wired in `android-dev-client-client.yml`).
- Only mark sub-project "done" when all verifications green.

## Existing assets we leverage

- `packages/theme/src/colors.ts:281-327` — `cubanLight`/`cubanDark` tokens already defined, just not exposed.
- `_layout.tsx:6-23` — fonts already loaded (Montserrat, Bricolage, Instrument Serif, JetBrains Mono).
- `packages/ui/` — 36 reusable primitives (Button, Card, Avatar, MenuRow, BalanceHeroCard, etc.).
- `apps/client/src/stores/theme.store.ts` — `useThemeStore`, `setThemeMode`, `useSystemThemeSync` already work.
- `blogService.getPublishedPosts()` ([packages/api/src/services/blog.service.ts](packages/api/src/services/blog.service.ts)) — exists.
- `getPromotions()` ([packages/api/src/services/admin.service.ts:943](packages/api/src/services/admin.service.ts:943)) — exists.

## Risks

- Home `index.tsx` is **3997 lines** — touching it for sub-project #3 risks regressions in ride flow. Mitigation: extract sub-components incrementally during the redesign, never replace wholesale.
- Tokens are referenced via TS imports (`colors.brand.orange`) and via Tailwind classes (`bg-primary-500`). Both paths must stay in sync.
- Web app uses different entry but same `packages/theme` — must verify web doesn't break when adding new tokens (additive should be safe but verify).

## Out-of-scope (parking lot)

- Custom service icons (line-art triciclo/moto/auto). Keep current emoji/icon-set placeholders.
- Mockup HTML (`docs/mockups/client-home-v1.html`) is reference, not source of truth — implementation may diverge.
- Multi-language tone copy (Cuban-flavored copy strings) — copy can land in a follow-up.
- iOS validation — defer to next quarter when iOS dev cert is set up.
