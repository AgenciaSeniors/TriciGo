# TriciGo — Auditoría de Seguridad e Integridad

**Última actualización:** 2026-04-25
**Estado del sprint:** 14 tiers cerrados, ~80 bugs fixed (BUG-086..203). **BUG-199 P0 RESUELTO** post-doc. 4 P1-P3 documentados pendientes (acción manual del usuario).

Este documento consolida todos los bugs encontrados y arreglados durante el sprint de auditoría 2026-04. Está organizado por **tier** (orden cronológico de descubrimiento) para que sea fácil de navegar. Cada bug entra como una fila con: severidad, vector explotable, fix (migración/archivo), estado.

**Convenciones:**

- **Sev**: 🔥 P0 / 🔴 crit / 🟠 high / 🟡 med / 🟢 low / 📝 P3
- **Estado**: ✅ fixed in master | 🚧 fixed pero requires user action | 📝 documented only

---

## Tier 4 — Driver wallet, ride flow integrity (5 bugs, migraciones 00152-00154)

| Bug | Sev | Vector | Fix |
|---|---|---|---|
| BUG-086 | 🟠 | Driver podía aceptar ride sin saldo para cubrir comisión → wallet drift negativo en cash rides | `00153_wallet_floor_gate_on_accept.sql` — gate en `accept_ride_v2` con `driver_can_afford_commission` |
| BUG-087 | 🟢 | `driver_profiles.total_rides_offered` nunca incrementaba → métricas de oferta rotas | `00152_increment_offered_on_ride_offer_insert.sql` |
| BUG-089 | 🟡 | `service_type` aceptaba slugs inválidos en INSERT, fallaba al completar ride | `00154_service_type_fk_guards.sql` — FK constraint hard |
| BUG-090 | 🔴 | Apps móviles cargaban `https://tricigo.com/terms` via WebView hardcoded — no respetaban CMS, rompiendo cumplimiento legal | `apps/{driver,client}/app/profile/{terms,privacy}.tsx` — `cmsService.getContent()` |
| BUG-091 | 🟡 | `cities.is_active=false` no impedía dispatch → rides aceptados en ciudades desactivadas | `00157_city_active_dispatch_gate.sql` — JOIN en `find_best_drivers` + INSERT trigger |

**Status**: ✅ todos cerrados.

---

## Tier 5 — Platform config + audit + atomic flows (5 bugs)

| Bug | Sev | Vector | Fix |
|---|---|---|---|
| BUG-095 | 🟡 | JSONB cast pattern `(value #>> '{}')::NUMERIC` repetido N veces → rotura silenciosa al cambiar formato | `00158_platform_config_numeric_helper.sql` — `get_platform_config_numeric()` + `_text()` |
| BUG-096 | 🟡 | Cambios en `platform_config` (commission_rate, surge, etc.) sin auditoría → no se sabe quién cambió qué | `00159_platform_config_audit_trigger.sql` — trigger AFTER INSERT/UPDATE/DELETE → `admin_actions` |
| BUG-097 | 🟡 | Cache de exchange_rate 5min stale → admin cambia tasa pero rides nuevos siguen calculando con vieja | `packages/api/src/services/exchange-rate.service.ts` TTL 60s + `apps/admin/src/app/settings/exchange-rate/page.tsx` invalidate hook |
| BUG-100 | 🟠 | RLS `users.role = 'admin'` excluía a super_admin → super_admins no podían leer su propia data | `00160_rls_include_super_admin.sql` |
| BUG-101 | 🔴 | `complete_ride_and_pay` ejecutaba branch corporativo Y branch normal → doble crédito + doble débito en corporate rides | `00161_complete_ride_skip_corporate_branch.sql` — short-circuit cuando `payment_method='corporate'` |

---

## Tier 6 — Stripe + payment_intents schema (5 bugs)

| Bug | Sev | Vector | Fix |
|---|---|---|---|
| BUG-102 | 🟠 | `process_stripe_recharge` hardcoded `account_type='customer_cash'` → corporate recharges via Stripe se acreditaban a wallet personal | `00162_stripe_recharge_corporate_routing.sql` |
| BUG-103 | 🟡 | `payment_intents.status` CHECK no incluía `processing` → INSERT del EF falla mid-flow | `00163_payment_intents_allow_processing_status.sql` |
| BUG-104 | 🟡 | `process_stripe_recharge` casteaba `p_payment_intent_id::TEXT` para reference_id (uuid column) → silently truncated | `00164_stripe_recharge_reference_id_type.sql` |
| BUG-105 | 🟡 | SOS notifications eran client-only → si la app cliente crasheaba, contactos de confianza nunca se enteraban | `00165_sos_safety_net_trigger.sql` — server-side AFTER INSERT de incident_reports |
| BUG-106 | 🟢 | `create_rides_for_recurring` cron referenciaba columna inexistente `last_ride_created_at` → fallando silenciosamente | `00166_fix_create_rides_for_recurring.sql` — usar `last_triggered_at` |

---

## Tier 7 — RLS + dispute resolution (5 bugs)

| Bug | Sev | Vector | Fix |
|---|---|---|---|
| BUG-108 | 🟡 | `process_dispute_refund` escribía `status='resolved'` pero el enum espera `'admin_resolved'` → CHECK violation al fix dispute | `00167_process_dispute_refund_status_mapping.sql` |
| BUG-112 | 🟢 | Pensé que `lost_items` tenía RLS sin policies (efectivamente locked). False positive — al final `00169_revert_redundant_lost_items_policies.sql` rollback. |
| BUG-113 | 🟡 | `auto_confort` listado en `service_type_configs` activo pero sin `cancellation_fee_configs` → cancel falla | `00170_seed_auto_confort_cancellation_fee.sql` |
| BUG-114 | 🟠 | `ride_waypoints` tenía SELECT policy para participants pero no INSERT/UPDATE → cliente no podía agregar paradas | `00171_ride_waypoints_customer_write_policies.sql` |
| BUG-115 | 🔴 | Cliente podía enviar `discount_amount_cup` arbitrario al INSERT ride — sin validación contra promo real | `00172_rides_promo_validation_trigger.sql` — recompute desde `promotions` row |

---

## Tier 8 — Atomic ops + reviews + ratings (5 bugs)

| Bug | Sev | Vector | Fix |
|---|---|---|---|
| BUG-116 | 🟠 | `admin.service.processRecharge` corría 5 ops no atómicas — fallback dejaba inconsistencia | `00173_approve_wallet_recharge_atomic.sql` — RPC con idempotency_key |
| BUG-117 | 🟡 | Trigger de rating solo actualizaba `customer_profiles.rating_avg` — driver_profiles quedaba desync | `00174_reviews_update_both_profiles.sql` |
| BUG-118 | 🟠 | `getPublicRideByShareToken` exponía PII completa del driver/customer | `00176_get_shared_ride_by_token_rpc.sql` — RPC SECDEF privacy-safe |
| BUG-120 | 🟠 | `apply_cancellation_penalty` cobraba **100x** lo previsto (20000/10000 con comentario "centavos" eran whole CUP) | `00177_cancellation_penalty_unit_fix.sql` |
| BUG-121 | 🟡 | `corporate_employees` SELECT policy con EXISTS self-recursive → infinite recursion en RLS | `00178/00179_corp_admin_helper_and_fix_recursion.sql` |

---

## Tier 9 — Driver PII + dispatch integrity + caller validation (8 bugs)

| Bug | Sev | Vector | Fix |
|---|---|---|---|
| BUG-123 | 🔴 | `dp_select_own` tenía clause pública `(approved AND online)` exponiendo `identity_number`, `address`, `criminal_record_details` | `00180_driver_profiles_pii_lockdown.sql` — RPC `count_online_drivers` + `get_assigned_driver_info` |
| BUG-124 | 🟠 | `find_best_drivers` double-booking guard comparaba `r.driver_id = dp.user_id` (wrong UUID) → drivers tomaban 2 rides simultáneos | `00181_find_best_drivers_double_booking_fix.sql` |
| BUG-125 | 🟢 | `recurring_rides` sin SELECT policy para admin + no dedupe por `last_triggered_at` | `00182_recurring_rides_admin_select_and_dedupe.sql` |
| BUG-126 | 🟢 | `trusted_contacts` sin admin SELECT policy para investigar SOS | `00183_trusted_contacts_admin_select.sql` |
| BUG-127 | 🟡 | `payment_intents.intent_type` referenciado por EF pero la columna no existía | `00184_payment_intents_intent_type_column.sql` |
| BUG-128 | 🟡 | `payment_intents.ride_id` referenciado por process-tropipay-webhook pero no existía | `00185_payment_intents_ride_id_column.sql` |
| BUG-129 | 🔴 | `selfie_checks_driver_update` permitía driver setearse `status=passed` y `face_match_score=1.0` → bypass KYC | `00186_selfie_checks_driver_no_self_pass.sql` |
| BUG-161 | 🔴 | `complete_ride_and_pay` no validaba que caller fuera el assigned driver — cualquier authenticated user podía completar cualquier ride con métricas falsas | `00203_complete_ride_and_pay_caller_check.sql` |
| BUG-162 | 🟡 | 19 columnas money/fee sin CHECK constraints (defense in depth) | `00204_money_columns_check_constraints.sql` |
| BUG-163 | 🟡 | TS types declaraban non-null en columnas DB-nullable. 68/85 rides tenían `payment_status=NULL` pero código asumía non-null | `00205_tighten_nullability_type_drift.sql` — backfill + NOT NULL en 7 columnas |
| BUG-164 | 🟡 | 16 SECDEF functions sin `search_path` explícito — vulnerable a schema-injection hijack | `00206_secdef_pin_search_path.sql` |
| BUG-165 | 🟢 | 6 RPCs muertos granted a authenticated + cron `keep-test-drivers-online` corriendo en prod | `00207_drop_dead_rpcs_and_test_cron.sql` |

---

## Tier 10 — SECDEF caller gates + storage hijack + cron exposure (16 bugs)

| Bug | Sev | Vector | Fix |
|---|---|---|---|
| BUG-130 | 🔴 | `process_dispute_refund` SECDEF granted authenticated, sin admin check — anyone podía mover money entre wallets | `00187_process_dispute_refund_admin_only.sql` |
| BUG-131 | 🔴 | `admin_reward_referral` y `admin_invalidate_referral` sin admin gate | `00188_referral_admin_rpcs_admin_only.sql` |
| BUG-132 | 🟠 | `admin.service.processRedemption` solo updateaba status — debía debitar/creditar atómicamente | `00189_wallet_redemption_atomic_approve.sql` |
| BUG-133 | 🟠 | 4 admin report RPCs sin admin gate — anyone podía sacar reports | `00190_admin_report_rpcs_admin_only.sql` |
| BUG-134 | 🔴 | `dp_update_own` permitía driver cambiar `status`, `is_kyc_approved`, `quota_blocked` (defeat wallet floor) | `00191_driver_profiles_field_lockdown.sql` + lockdown trigger |
| BUG-135 | 🔴 | `users_update_own` sin column-level lockdown — cualquier user podía hacer `UPDATE users SET role='super_admin' WHERE id=auth.uid()` | `00192_users_role_lockdown.sql` + lockdown trigger |
| BUG-136 | 🟠 | `update_driver_score` SECDEF granted authenticated — anyone podía manipular driver scores | `00195_update_driver_score_admin_or_trigger_only.sql` |
| BUG-138/139/140/141 | 🟡 | auto-admin EF tenía 4 bugs (autoApproveRedemptions no usaba RPC, autoFailStaleTropipay con campo wrong, autoCloseIncidents target wrong, autoApproveDrivers buscaba push_token en columna wrong) | `supabase/functions/auto-admin/index.ts` v8 |
| BUG-145 | 🟠 | `rev_insert` solo verificaba `reviewer_id=auth.uid()` — anyone podía escribir reviews falsos sobre rides ajenos | `00196_reviews_participant_check.sql` |
| BUG-146 | 🟠 | `wa_insert_own` permitía user crear wallet con balance arbitrario + account_type='platform_revenue' | `00197_wallet_accounts_user_insert_lockdown.sql` |
| BUG-147 | 🔴 | `send-sms` EF sin auth — Twilio open relay (anyone enviaba SMS arbitrario) | EF `send-sms` v9 — service_role only |
| BUG-148 | 🟢 | Crones `auto-admin` y `behavioral-emails-daily` con stub `SELECT 1;` — EF nunca se llamaba | `00198_fix_cron_auto_admin_and_behavioral_emails.sql` |
| BUG-150 | 🟡 | `corporate_rides` INSERT policy permisiva — anyone podía insertar rides corporativos directamente | `00199_advisors_critical_fixes.sql` |
| BUG-151 | 🟢 | `paper_config`, `paper_trades`, `portfolio_snapshots` con RLS pero sin policies — efectivamente locked | `00199` (drop RLS, son admin-only) |
| BUG-152 | 🟡 | Views `driver_churn_risk` + `eligible_drivers` sin `security_invoker` — bypass del lockdown de BUG-123 | `00199` recreate con `security_invoker=true` |
| BUG-157 | 🔴 | `recharge_driver_quota` SECDEF granted — defeat del wallet-floor gate de BUG-086 | `00200_recharge_driver_quota_admin_only.sql` |
| BUG-158 | 🟢 | ~60 foreign keys sin backing index → JOINs lentos | `00201_add_missing_fk_indexes.sql` |
| BUG-159 | 🟡 | `ride_messages.body` sin length CHECK — chat podía recibir mensaje 10MB | `00202_ride_messages_body_length_check.sql` |
| BUG-160 | 🔴 | `sync-exchange-rate` y `sync-weather` sin auth — anyone trigger spam ElToque/OpenWeatherMap quota | EFs deployed con apikey check |
| BUG-166 | 🔴 | 4 webhook RPCs (`process_*payment*`) granted anon/authenticated — free-money exploit racing webhooks | `00208_lock_webhook_rpcs_to_service_role.sql` |
| BUG-167 | 🟢 | `enforce_max_trusted_contacts` TOCTOU race — concurrent inserts → 6+ contactos | `00209_trusted_contacts_race_lock.sql` — advisory lock |
| BUG-168 | 🟡 | Storage avatar UPDATE sin `WITH CHECK` — rename hijack a otra carpeta | `00210_storage_update_with_check.sql` |
| BUG-169 | 🟠 | Storage driver-documents UPDATE sin `WITH CHECK` — KYC docs override de otro driver | `00210` |
| BUG-170 | 🔴 | `transfer_wallet_p2p` aceptaba `p_from_user_id` arbitrario — robar de cualquier wallet | `00211_secdef_caller_gates.sql` |
| BUG-171 | 🔴 | `add_tip` aceptaba `p_from_user_id` — drain via tip | `00211` |
| BUG-172 | 🔴 | `upsert_exchange_rate` sin admin gate — rewrite USD/CUP rate | `00211` |
| BUG-173 | 🟠 | `freeze_wallet` sin admin gate — DoS cualquier wallet | `00211` |
| BUG-174 | 🟠 | `unfreeze_wallet` sin admin gate — defeat freezes | `00211` |
| BUG-175 | 🔴 | `approve_wallet_recharge` sin admin gate — free recharge | `00211` |
| BUG-177 | 🟠 | `dispatch_ride` exposed a authenticated — grief drivers | `00211` (internal-only via pg_trigger_depth) |
| BUG-178 | 🔴 | 3 admin RPCs validaban role pero NO `auth.uid()=p_admin_user_id` — impersonate admin con UID enumerable | `00211` |
| BUG-183 | 🟠 | 5 cron-only RPCs granted authenticated | `00212_cron_only_rpcs_revoke_execute.sql` |

---

## Tier 11 — OTP brute force + payment intent EFs + view exposure (10 bugs)

| Bug | Sev | Vector | Fix |
|---|---|---|---|
| BUG-179 | 🔴 | `send-bulk-sms` EF sin auth — Twilio drain + SMS phishing canal | EF `send-bulk-sms` deployed — admin role gate |
| BUG-180 | 🔴 | `send-bulk-email` sin auth — Resend phishing desde @tricigo.com | EF `send-bulk-email` |
| BUG-181 | 🟡 | `notify-business-movement` sin auth | EF `notify-business-movement` |
| BUG-182 | 🟠 | `send-push` sin user_ids ownership check | EF `send-push` |
| BUG-184 | 🔴 | `verify-otp` Cuba path TOCTOU race + off-by-one — OTP brute force con botnet | `00213_atomic_cuba_otp_verify.sql` — `verify_cuba_otp` RPC atomic |
| BUG-186 | 🟠 | OTP rate limit solo per-IP — botnet bypassable | EFs `verify-otp` + `send-sms-otp` con per-phone rate limit |
| BUG-187 | 🟠 | `create-stripe-payment-intent` sin auth — DoS Stripe + arbitrary user_id | EF deployed con JWT + ownership |
| BUG-188 | 🟠 | `create-tropipay-link` sin auth | EF |
| BUG-189 | 🟠 | `create-ride-payment-link` sin auth + sin ride.customer_id ownership check | EF |
| BUG-190 | 📝 | TropiPay HMAC compare con `!==` (timing-leak teórico) | **Deferred** — provider deprecated, riesgo bajo |
| BUG-191 | 🟠 | `send-email` aceptaba any recipient_email — phishing | EF `send-email` deployed — service_role only |
| BUG-192 | 🟡 | Cron `behavioral-emails-daily` con stub `SELECT 1;` — emails nunca enviados | `00214_wire_behavioral_emails_cron.sql` |
| BUG-193 | 🟢 | Views `eligible_drivers` + `driver_churn_risk` granted anon (defense in depth) | `00215_revoke_anon_on_admin_views.sql` |

---

## Tier 12 — Auth/session security (1 fix + 3 docs)

| Bug | Sev | Vector | Fix |
|---|---|---|---|
| BUG-195 | 🔴 | `find_user_by_phone` granted anon + authenticated — enumeración masiva de teléfonos cubanos + nombres | `00216_find_user_by_phone_lockdown.sql` — auth required + 30/h rate limit |
| BUG-196 | 📝 P1 | 0/4 admins enrolados en MFA | **Documented** — manual: enroll MFA, luego enforce `aal=aal2` en `is_admin()` |
| BUG-197 | 📝 P3 | `auth.audit_log_entries` vacío — auth audit logging puede estar deshabilitado | **Documented** — verificar project settings |
| BUG-198 | 📝 P2 | Admin reset-password permite contraseña 8 chars sin complejidad | **Documented** — recomendar 12+ con zxcvbn |

---

## Tier 13 — Service role JWT exposure (CRITICAL) + cron auth regression (3 bugs)

| Bug | Sev | Vector | Fix |
|---|---|---|---|
| BUG-199 | 🔥 P0 | service_role JWT hardcoded en 11 migraciones de un repo público GitHub. **VERIFICACIÓN EMPÍRICA 2026-04-25**: PostgREST ya rechazaba (Supabase auto-revocó legacy JWT secret 19 días antes), PERO 4 EFs (auto-admin, sync-weather, sync-exchange-rate, send-sms) seguían aceptando vía BUG-201 decoder no-verifier | ✅ **RESOLVED** (commit `e6c00a5`): migración 00219 actualizó cron commands para enviar `apikey: <vault.service_role_key>`; los 4 EFs se redeployaron con `apikey === env.SUPABASE_SERVICE_ROLE_KEY` (sb_secret_*) — leaked JWT ahora retorna 401 en los 4. Crones siguen funcionando 200 |
| BUG-200 | 🟡 | Default privileges en `public` schema otorgaban `EXECUTE` automático a anon en cada nueva function — causa raíz de la mayoría de bugs SECDEF de Tiers 6+ | `00218_revoke_default_execute_anon.sql` |
| BUG-201 | 🔴 | EFs `sync-exchange-rate`, `sync-weather`, `send-sms` chequeaban `apikey === serviceRoleKey` — pero crones envían JWT solo en `Authorization`. Crones fallaban 401 silenciosamente por una semana | EFs redeployed con JWT role-claim check (decode payload, validate `role=service_role`) |

---

## Tier 14 — Storage / mobile / backup / concurrency (0 fixable + 3 docs)

| Bug | Sev | Vector | Fix |
|---|---|---|---|
| BUG-202 | 📝 P3 | Android `tricigo://` custom scheme sin `autoVerify` — vulnerable a hijack por otra app que registre el mismo scheme | **Documented** — requiere `intentFilters` con `autoVerify=true` + hosted `assetlinks.json` |
| BUG-203 | 📝 P3 | Backup tier no auditable vía SQL | **Documented** — verificar tier de backup en Supabase dashboard |

**Tier 14 audits limpios** (no nuevos bugs):
- ✅ Storage buckets: limits + MIME allowlists ok
- ✅ Mobile: SecureStore (Keychain/EncryptedSharedPrefs) en uso
- ✅ Idempotency: UNIQUE INDEX en `ledger_transactions.idempotency_key`, 0 duplicados
- ✅ pg_cron: 14 jobs todos como `postgres` (modelo Supabase estándar)
- ✅ `accept_ride_v2`: `FOR UPDATE` row lock + offer lock + status guard. 0 rides asignados a múltiples drivers en historia.

---

## Pendiente (acción manual)

### ✅ BUG-199 P0 — RESUELTO 2026-04-25

Estado al cierre del sprint:
- Supabase ya había auto-revocado el legacy JWT secret 19 días antes (HS256 → ECC P-256). PostgREST y la mayoría de EFs ya rechazaban el JWT leakeado.
- 4 EFs (auto-admin, sync-weather, sync-exchange-rate, send-sms) seguían siendo explotables vía BUG-201 decoder. Verificación empírica con curl confirmó la vulnerabilidad.
- Fix aplicado en commit `e6c00a5`:
  - Migración 00219 — cron commands envían `apikey: <vault.service_role_key>` (sb_secret_*)
  - 4 EFs redeployadas — revert a `apikey === env.SUPABASE_SERVICE_ROLE_KEY` (post-rotation Supabase auto-mantiene env var con sb_secret_*)
  - Verificación: leaked JWT → 401 en los 4, cron-style → 200, wallet invariant 0
- `docs/JWT_ROTATION.md` queda como referencia histórica del procedimiento.
- **Recomendación remanente**: cuando convenga, en algún momento ejecutar `git filter-branch` o BFG Repo-Cleaner para purgar el JWT del git history (no urgente ya que el secret está revocado y el JWT ya no autentica, pero es hygiene).

### 🟠 P1 — BUG-196: MFA admins

- Enrolar MFA en los 4 admins via Supabase auth flow.
- Después de enrolar todos, agregar check `auth.jwt() ->> 'aal' = 'aal2'` en `is_admin()` para que admins sin MFA no puedan ejecutar ops privilegiadas.

### 🟡 P2 — BUG-198: admin password policy

- Editar `apps/admin/src/app/reset-password/page.tsx` y `apps/admin/src/app/login/page.tsx`:
  - Min length 12 (no 8).
  - Integrar `zxcvbn` o similar para complejidad mínima.

### 📝 P3 — BUG-197, BUG-202, BUG-203

- BUG-197: Verificar que auth audit logging esté habilitado en Supabase project settings.
- BUG-202: Agregar `intentFilters` con `autoVerify: true` en `apps/{driver,client}/app.json` + hostear `https://tricigo.com/.well-known/assetlinks.json` con app signing key.
- BUG-203: Confirmar tier de backup/PITR adecuado para producción en Supabase dashboard.

### 🟢 Cleanup opcional (test data acumulado)

Quedaron en producción:

- 5 rides "E2E/Regression/Trigger test" (status=completed, customer = test seed).
- 2 comisiones falsas (+209 TRC en `platform_revenue` de los rides E2E).
- Admin adjustments ±10k que netean a cero (mantener para auditoría).
- 3 wallets driver_cash con balance negativo (test drivers, modelo de débito por commission cash → no es bug, lo dejamos).

Limpieza es decisión del usuario. SQL para borrar test data disponible bajo demanda.

---

## Stats agregadas del sprint

- **78+ bugs cerrados** desde BUG-086 hasta BUG-203 (con gaps numéricos en bugs descartados o duplicados). **BUG-199 P0 cerrado post-doc** con verificación empírica.
- **32 nuevas migraciones** aplicadas (00141..00219) — todas con commit en master, todas idempotentes-friendly.
- **12 Edge Functions** redeployed con caller-gates + auth checks: `auto-admin`, `send-sms`, `send-sms-otp`, `verify-otp`, `send-push`, `send-email`, `send-bulk-sms`, `send-bulk-email`, `notify-business-movement`, `sync-exchange-rate`, `sync-weather`, `create-stripe-payment-intent`, `create-tropipay-link`, `create-ride-payment-link` (más). 
- **Wallet ledger invariant** (≡ `balance = SUM(entries.amount)`): mantenido en 0 mismatches durante todo el sprint.
- **0 regresiones funcionales** detectadas post-deploy (excepto BUG-201 que se detectó y arregló dentro del mismo sprint).
- **5 P1-P3 pendientes** (BUG-196, 197, 198, 202, 203) — todos requieren acción manual del usuario fuera del scope SQL/EF.
- **1 P0 pendiente** (BUG-199) — service_role JWT rotation. Procedimiento documentado.
