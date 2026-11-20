# General checklist (every PR)

- [ ] **Tests prove the change.** A test fails without the change and passes with it. A test that
  only renders or only calls the function without asserting the behaviour does not count.
  Prove: revert the change locally, run the test, see it fail.
- [ ] **Cases outside the author's list.** Empty, null, the first and the last item, a second tap,
  no network, an expired session. Prove: run at least one yourself.
- [ ] **"The previous PR changed X and forgot Y".** After renaming or swapping anything (a column,
  an account type, an i18n key, an RPC), every old use is gone. Prove: `git grep -n "<old name>"`
  returns nothing outside history and comments. (CLAUDE.md: "Patrón PR previo cambió X pero olvidó Y")
- [ ] **Read the maintained field, not the legacy one.** When two fields hold the same fact, the
  code reads the one something keeps updated. (CLAUDE.md: "Patrón stale precomputed field")
- [ ] **Turning something on that was off.** When a fix makes a dead path run, every place that
  stops, clears or disables it is checked. Prove: `git grep` of the matching `stop*`, `disable*`,
  `clear*`. (CLAUDE.md: "Un no-op se vuelve regresión cuando el fix lo hace real")
- [ ] **Data is fresh.** A screen that loads once on mount also refreshes when it matters (focus,
  reconnect, app back to foreground). (CLAUDE.md: "Auditoría de frescura de datos")
- [ ] **Errors are honest.** A known server answer is not shown as a generic failure (for example
  `ride_already_closed` is a success). Nothing is swallowed silently where the user needs to act.
  (CLAUDE.md: "`ride_already_closed` NO es un fallo")
- [ ] **The right surface.** The change is in the app, panel or function the bug was seen in, and
  it is verified there. (CLAUDE.md: "Verificar la superficie correcta")
- [ ] **i18n.** New user text goes through i18n in every locale; `pnpm check:i18n` passes. Spanish
  copy is neutral Cuban Spanish.
- [ ] **No secret and no real personal data** in the diff, tests, fixtures or PR text. The
  repository is public. (CLAUDE.md: "Credenciales en el repo: es PÚBLICO")
- [ ] **Scope.** The PR does what it says and nothing else; unrelated refactors go to their own PR.
