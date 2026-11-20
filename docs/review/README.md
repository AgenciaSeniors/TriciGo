# Review areas and checklists

One definition of what is sensitive in TriciGo, read by every reviewer:

- the Claude reviewer agents the author runs before asking for a review,
- the local cross-review by Codex before the PR,
- the Codex review bot on GitHub (through the summary in the root `AGENTS.md`).

## Which checklists apply to a change

    pnpm review:areas                       # this branch against origin/master
    node scripts/review-areas.mjs --json    # machine output

The map is `areas.json`: path regexes plus words of migration file names
(`00637_wallet_shortfall_pays_cash.sql` is money because of `wallet` and `cash`). Docs and test files
never count. `general.md` applies to every PR.

## Changing the map

Edit `areas.json` and run `pnpm test:review-areas`. The tests fail when a path regex matches no
tracked file (a typo or a renamed folder) or a checklist file is missing. A new area needs its
checklist file in the same PR.

## Writing a checklist item

Each item is a check and a way to prove it: a command, a query or a test. "Looks fine" is not a
proof. When a bug teaches something new, add the item in the PR that fixes it, with the CLAUDE.md
section or PR that tells the story.

## Severity

- **P0**: breaks use, operations or data broadly (money lost or created, rides stuck for
  everyone, data of one user readable by others).
- **P1**: must be fixed before merging (security hole, data loss, regression, acceptance not met,
  a change without tests that needed them).
- **P2**: should be fixed, does not block.
- **P3**: minor improvement.
