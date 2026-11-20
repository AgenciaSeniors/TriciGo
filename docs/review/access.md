# Access checklist: auth, RLS, GRANTs, RPC exposure, roles, secrets, paths to production

- [ ] **Every new table in `public` has RLS and explicit GRANTs** (Data API change of 2026-10-30).
  `pnpm check:migration-grants` passes. (CLAUDE.md: "Tablas nuevas en public: GRANT explícito")
- [ ] **SECURITY DEFINER functions skip RLS.** Each one checks the caller inside (`auth.uid()`,
  role), sets `search_path`, and `anon` cannot execute it unless that is the point. When a policy
  hides rows, look for SECURITY DEFINER functions that read the same table. Prove: the
  `has_function_privilege('anon', ...)` query of CLAUDE.md. (CLAUDE.md: "Una función SECURITY
  DEFINER se salta la RLS de la tabla que lee")
- [ ] **REVOKEs are verified in production, not assumed** from the migration file. (CLAUDE.md:
  "Los REVOKE de una migración de lockdown se verifican en prod")
- [ ] **What one person can read of another** stays limited: phone, plate, location, ratings.
  Prove: as a second authenticated test user, the read returns 200 with an empty list (an HTTP
  error does not prove the policy). (CLAUDE.md: "Lo que una persona puede leer de otra"; "Patentes
  de los vehículos")
- [ ] **Object ownership is checked on the server** for every RPC or function that takes an id
  (ride, wallet, document, ticket). The panel hiding a button is not a check.
- [ ] **Roles of the admin panel.** A new page or action is gated in `apps/admin/src/middleware.ts`
  and in the RPC, for every role (`admin`, `marketing`, `operator`). (CLAUDE.md: "Panel admin:
  middleware, dinero y notificaciones"; "Rol `operator`")
- [ ] **Login never changes another account's session**, does not rotate passwords on each login,
  and respects the daily and per-number code limits. (CLAUDE.md: "Login en una app deslogueaba la
  otra"; "Enlaces de login"; "Códigos de login: topes")
- [ ] **Text from users inside HTML, `<script>` or a redirect is escaped** (`htmlSafety`).
  (CLAUDE.md: "Texto ajeno dentro de HTML")
- [ ] **Workflows and ops.** A workflow change keeps pinned actions, read-only token by default,
  free text through `env:` (never `${{ }}` inside `run:`), and a new job on the self-hosted runner
  is added to `GATE_WORKFLOWS`. (CLAUDE.md: "Deploy web/admin: self-hosted runner"; "Cadena de
  suministro de CI")
- [ ] **No secret in the diff.** Names of variables only, never values; a real value found in code
  is moved out and the key rotated. The repository is public.
