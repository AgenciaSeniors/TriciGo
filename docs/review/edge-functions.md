# Edge Functions checklist

- [ ] **The function decides who is calling.** `verify_jwt=true` only proves there is some
  session; anyone gets one with an OTP. The function checks the caller and the object inside.
  (CLAUDE.md: "Edge Functions: quién puede llamarlas")
- [ ] **`verify_jwt` in `supabase/config.toml`** matches the intent of the function.
- [ ] **Rate limits are counted after auth**, not per IP before it (triggers and crons share one IP).
- [ ] **Imports are pinned**; `pnpm check:ef-imports` and `pnpm check:ef-types` pass.
- [ ] **Mirrored helpers stay in sync.** When a dataset or helper is duplicated from
  `@tricigo/utils`, both copies change together. (CLAUDE.md: "Mirror EF helpers")
- [ ] **CORS:** `admin.tricigo.com` and the other real origins are in `ALLOWED_ORIGINS` when the
  panel calls the function. (CLAUDE.md: "`admin.tricigo.com` debe estar en `ALLOWED_ORIGINS`")
- [ ] **Service role use is narrow.** The service-role client is used only for what the caller is
  allowed to do, after the check.
- [ ] **Webhooks verify the provider's signature** and are idempotent.
- [ ] **Failures are visible.** Errors are logged without personal data, and a cron caller can see
  the HTTP result (`cron_http_post`).
- [ ] **Deployed on purpose.** The PR says which functions must be deployed and in what order with
  the migrations they need.
