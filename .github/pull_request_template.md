<!--
The repository is public: no secret, token, signed URL or real personal data in this PR.
List the review areas with `pnpm review:areas` and read their checklists in docs/review/.
-->

## What changes

<!-- The effect for riders, drivers or the team, in one or two sentences. Not the file list. -->

## Why

<!-- The bug seen, the request, or the decision this closes. Link the issue, spec or plan. -->

## How it was validated

<!-- Commands you ran and what came out. Paste the relevant output, not the whole suite. -->

```
```

## Tests

<!-- The tests added or changed and what each one proves. If there are none, one line:
No tests because: <reason> -->

## Review areas

<!-- Paste the output of `pnpm review:areas`. -->

```
```

## Cross-review

<!-- When any review area is touched: the verdict line printed by the cross-review,
Cross-review: <APPROVED|APPROVED_WITH_RESERVATIONS|FIX_CONFIRMED> <work-id> <sha>
plus the reservations accepted. Otherwise: Not required, no review area touched. -->

## Native and OTA

- [ ] JavaScript only: can ship by OTA
- [ ] Needs a store build: `expo.version` bumped in the app's `app.json`
- [ ] Does not touch the mobile apps

## Migrations

<!-- For each migration: applied in production or not yet, and how the code behaves until it is.
Otherwise: None. -->

## Final check

- [ ] No secret, `.env`, token or real personal data in the diff or in this text
- [ ] Docs updated where the behaviour changed (CLAUDE.md section, spec or runbook)
