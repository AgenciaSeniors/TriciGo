# TriciGo — Auditoría de bugs pre-lanzamiento (2026-06-20)

> Barrido amplio multi-agente (workflow ultracode): 12 finders → grounding SQL secuencial contra prod viva → verificación adversarial → triage. 35 agentes, ~52 min. Estado prod: project `lqaufszburqvlslpcuac`, migración más alta `00444`.

## Resumen ejecutivo

El **núcleo de dinero está estructuralmente sano**: ledger doble-entrada balanceado, paridad estricta estimate=cobro intacta, TRC=CUP 1:1 (sin regresión de `00379`). **0 P0.**

- **1 bloqueante de lanzamiento (P1):** NETOPIA IPN sin verificación de autenticidad (AUD-001). El guard `IPN_AUTHENTICITY_VERIFIED=false` fail-closea correctamente en `live` (503 a todo pago) → **NO habilitar live** hasta implementar firma/re-query. En `sandbox` el path de crédito es forjable (0 pérdida histórica: nunca fue a live).
- **2 bloqueantes funcionales (P1):** tipo de cambio admin **sin cota** (un typo re-precia todas las tarifas + revalúa todas las wallets ancladas) y la página admin `settings/promotions` que **×100** infla descuentos fijos → viaje gratis.
- **Cluster del subsistema USD-anchor / revaluación FX** (migs `00441`/`00443`/`00444`, **nuevo y vivo**): 6 defectos P2/P3 — etiqueta "Regalo" en ajustes FX, revaluación de saldos no respaldados (promo/regalo), drift de redondeo, falta de row-locks. **Decisión de producto pendiente: mantener o quitar la feature para lanzar.**
- **Gaps latentes-pero-ciertos** (dormidos solo por 0 uso en prod, **muerden al lanzar**): comisión corporativa re-spliteada al 15% ignorando el override, presupuesto corporativo gateando el estimado (no el final), viajes programados/recurrentes chocando con el lock de un-viaje-activo, contador de cancelaciones revertido por protect-trigger.

**Counts:** P0=0 · P1=3 · P2=9 · P3=9 (21 total).

---

## P1 — Bloqueantes

### AUD-001 · NETOPIA IPN authenticity (WPS-01) — `edge-fn` — confianza alta
El webhook no hace verificación HMAC/firma ni re-query de estado. El UUID `orderID` + atomic claim solo evitan **doble** crédito de un intent, no crear N intents propios y forjar el IPN `paid`. El monto es server-side (no manipulable), pero la **autenticidad** falta. `IPN_AUTHENTICITY_VERIFIED=false` (línea ~210) → 503 a todo pago `paid` cuando `netopia_environment='live'` → habilitar live rechaza toda recarga legítima. Hoy `sandbox` → path forjable abierto (0 pérdida: nunca fue live).
**Fix:** antes de habilitar live, implementar (a) verificación de firma/HMAC contra el POS secret sobre el body crudo, o (b) re-query server-to-server por `ntpID` con el API key secreto; `IPN_AUTHENTICITY_VERIFIED=true` solo tras pasar el check (validado en sandbox). Mantener el 503 fail-closed hasta entonces.
`supabase/functions/process-netopia-webhook/index.ts`

### AUD-002 · Tipo de cambio admin sin cota → re-precia todo + revalúa toda wallet anclada — `money` — alta
`exchange_rates` sin `CHECK` en `usd_cup_rate`. El trigger `trg_exchange_rate_recompute_prices` reescribe CUP de `service_type_configs`+`pricing_rules` = `ROUND(usd*v_rate)` sin cota; `revalue_anchored_wallets` fuerza `balance=ROUND(anchor_usd_cents/100*v_rate)` para cada `customer_cash`/`corporate_cash` (cron 04:30). El clamp `[100,5000]` vive **solo** en `sync-exchange-rate` (scraping); `upsert_exchange_rate` y `setManualRate` no lo tienen; el admin solo chequea `rate>0`. Un typo (6950 vs 695) ×10 toda tarifa viva y, al siguiente cron, ×10 el CUP de toda wallet anclada.
**Fix:** `CHECK (usd_cup_rate BETWEEN 100 AND 5000)` en `exchange_rates` (chokepoint único: EF + RPC + admin). + cota en `setManualRate` y UI admin. Opcional: cap `|v_delta|` en `revalue_anchored_wallets`.
`00017_exchange_rate_billing.sql:9` · `00441:172` · `00443:114` · `exchange-rate.service.ts:88` · `admin/settings/exchange-rate/page.tsx:43`

### AUD-003 · `settings/promotions` ×100 en `discount_fixed_cup` → viaje gratis — `admin` — alta
`admin/settings/promotions/page.tsx:125` guarda `Math.round(parseFloat(discount_fixed_cup)*100)` para `fixed_discount`+`bonus_credit` y :174 muestra con `formatCUP` sin dividir. La **otra** ruta `admin/promotions/page.tsx:148` guarda raw — dos rutas admin vivas escriben la misma columna a escalas opuestas. El trigger `tg_rides_validate_promo_discount` trata `discount_fixed_cup` como CUP raw (`LEAST(discount_fixed_cup, fare)`) → un `fixed_discount` de la settings-page queda ×100 → clamp a tarifa completa → **viaje gratis**. Latente: solo existe `TRICIGO1000=1000` (creado por la página correcta).
**Fix:** quitar el `*100` en settings/promotions (guardar entero CUP), **o** borrar la página duplicada y dejar solo `admin/promotions` (raw CUP, correcta).
`admin/settings/promotions/page.tsx:125,174` · `admin/promotions/page.tsx:148` · `utils/src/currency.ts:100`

---

## P2

### AUD-004 · `fx_revaluation` no manejado en `classifyWalletTxn` → ajustes FX salen "Regalo" — `service-ts` — alta · **YA VIVO**
`classifyWalletTxn` (`utils/src/ledger.ts:78-133`) no tiene rama para `type='fx_revaluation'` → cae al `else` → `kind='transfer'` → ambas superficies etiquetan "Regalo" (cliente `wallet.tsx:99`, web `wallet/page.tsx:49`). El cron `revalue-anchored-wallets` está **activo** y ya posteó filas en wallets demo reales. Display-only, recurrente, cada wallet anclada cada día.
**Fix:** rama `type==='fx_revaluation'` → `WalletTxnKind` dedicado ("fx"/"revaluation") con icono swap + signo direccional + copy "Ajuste por tipo de cambio" es/en/pt en cliente/driver/web + CSV. Test que impida el fallback a "transfer".

### AUD-005 · La revaluación USD revalúa saldos NO respaldados (promo/regalo) hacia arriba — `money` — media · **decisión de producto**
Para CUP respaldado (recarga/earnings) la revaluación es correcto FX-hedging (ledger balanceado, `platform_fx_reserve` es el contra-pasivo) — la framing de "mint/corrupción" se **refuta**. Lo que **sobrevive**: el anchor NO distingue CUP respaldado del acreditado por promo/referral/regalo → la porción no respaldada **también** se revalúa hacia arriba en cada movimiento de tasa = regalo escalado por la tasa, acotado al pool (chico) de promo/regalo. Los invariantes de `money-health-check` no lo cazan (doble-entrada balanceada por construcción).
**Fix:** decidir intención de la feature. Si se mantiene: exentar el saldo no respaldado del anchor (anchor 0 para entries promo/referral/regalo, espejo del skip de `fx_revaluation`). Si se quita: unschedule el cron + revertir las txns `fx_revaluation`. + detector en `money-health-check` (SUM anchor-USD vs SUM USD recargado+ganado por wallet).

### AUD-006 · Comisión corporativa re-spliteada al 15% ignorando el override — `money` — alta · latente (0 uso)
En `corporate`, `complete_ride_and_pay` computa el split con override y persiste `final_fare_trc` (ya descontado), pero la rama corporate hace `NULL` (no mueve plata). El movimiento real es el trigger AFTER-UPDATE `handle_corporate_ride_completion` (`00407:64-150`) que lee **solo** `platform_config.commission_rate` (0.15), nunca `corporate_accounts.commission_percent` ni el snapshot. Ej (orig 1000, default 15%, corp 8%): ride guarda 930 (intención driver 850/plataforma 80); el trigger splitea 930→comisión 140/driver 790 → **driver corto 60, plataforma larga 60**. Ledger nets 0 (no salta detector). Primer fire en prod al lanzar.
**Fix:** el trigger debe leer el snapshot final (`ride_pricing_snapshots snapshot_type='final'`, `commission_rate`+`corporate_commission_rate`) y usar `snapshot.commission_amount`/(`total`−`commission_amount`) para que el split del trigger == el de `complete_ride_and_pay`.

### AUD-007 · Enforcement corporativo gatea el ESTIMADO (fail-open si =0); completion no re-chequea contra el final — `money` — alta · latente
`tg_rides_validate_corporate` (`00429:70-94`) gatea cap+budget sobre `NEW.estimated_fare_trc` al INSERT. `ride.service.ts:444` setea `estimatedFareTrc=0` cuando `estimated_fare_cup` es falsy → `0>cap` false (cap salteado), budget no consumido. Aparte, `handle_corporate_ride_completion` debita `corporate_cash` por `final_fare_trc` **sin** comparar cap/budget, y el final puede exceder el estimado (viaje más largo + espera, hasta 1.3×).
**Fix:** re-chequear budget/cap al completar usando el final dentro del trigger (sin rollback: `RAISE WARNING` + flag de reconciliación si excede). + requerir `estimated_fare_trc>0` en el INSERT corporativo (y espejo en `validateCorporateRide` cliente).

### AUD-008 · Viajes programados/recurrentes en `searching` chocan con el lock de un-viaje-activo — `trigger` — alta · latente
El lock de `00231` (índice parcial `rides_one_active_per_customer` + trigger `enforce_one_active_ride_per_customer`) cuenta `status='searching'` como activo **sin** excluir `is_scheduled`/futuro. `00407` mantiene a propósito los programados/recurrentes en `searching` desde la creación; `00435 create_rides_for_recurring` los INSERTa en `searching` dentro de un EXCEPTION por-iteración (su comentario SCHED-01 nombra la colisión). Efectos: (1) un programado futuro bloquea una reserva inmediata; (2) una ocurrencia recurrente se descarta silenciosamente; (3) dos futuros chocan en el índice único.
**Fix:** excluir programados futuros del set activo en ambas superficies. Trigger: `AND NOT (is_scheduled=true AND scheduled_at > now())`. El índice parcial no puede usar `now()`: expresar el carve-out sin él (ej. excluir mientras `is_scheduled=true AND scheduled_notified=false`, flipear a `true` al despachar).

### AUD-009 · Velocity de recargas cuenta solo `completed` → recargas paralelas en vuelo bypassean el límite (fail-open) — `edge-fn` — alta
`check_topup_velocity` (`00276`) filtra `status='completed'` e ignora created/pending/processing. Corre al CREAR el intent, así que N creates concurrentes leen 0 y todos pasan. Fail-open: en error hace `console.error`+procede.
**Fix:** incluir estados en vuelo (`status IN ('created','pending','processing','completed')`) en ambas ventanas. Opcional fail-closed sobre un umbral de monto. Corporate exento.

### AUD-010 · `mapNetopiaStatus` trata status=4 como `refunded` (debita wallet) con mapeo no confirmado — `edge-fn` — media
`process-netopia-webhook:88` `if (s===4) return 'refunded'` → debita la wallet por `amount_cup`. El comentario admite que el 4 es la mejor conjetura del equipo para refunded/reversed en NETOPIA v2. Gateado a `existingIntent.status==='completed'` (un 4 sobre intent no-completado se ACKea seguro), pero sobre uno completado un 4 mal interpretado **drena** la wallet (balance negativo permitido). 0 exposición viva.
**Fix:** confirmar el status numérico de refund merchant-initiated contra el spec/sandbox live antes de confiar en 4; gatear el debit detrás de una señal verificada (re-query por `ntpID`). Mismo gate que AUD-001.

### AUD-011 · `settle_and_scrub_for_deletion` drena `platform_revenue` cuando el driver tiene balance NEGATIVO — `money` — alta · dormido
El loop (`00439:52`) selecciona `WHERE balance <> 0` (no `> 0`), así que balances negativos matchean. Para uno negativo, inserta un debit positivo (+|deuda|) para cerrar la wallet, y `balance = balance + v_acct.balance` (negativo) **reduce** `platform_revenue` por |deuda|, con descripción engañosa ("unclaimed funds"). Driver puede offboardear para escribir-off deuda de comisión/seguro.
**Fix:** restringir el loop a `WHERE balance > 0`. Dejar las negativas al FK `SET NULL` (`00422`) como pérdida de wallet huérfana con descripción/reference distinta, nunca confiscada de `platform_revenue`.

### AUD-013 · El cliente móvil bloquea viajes corporativos con presupuesto ILIMITADO (`monthly_budget_trc=0`) — `mobile` — alta
La web (`book/page.tsx:757`) guarda `if ((monthly_budget_trc ?? 0) > 0)` (BUG-073: 0 = ILIMITADO). El móvil (`useRide.ts:581`) calcula `remainingBudget=(budget??0)-(spent??0)` y bloquea con "Presupuesto insuficiente" **sin** el guard `>0`. Con budget=0 (DEFAULT=ilimitado) → `remainingBudget≤0<fare` → bloqueado en cliente aunque el trigger solo enforce cuando `>0`.
**Fix:** envolver el pre-check móvil en `if ((monthly_budget_trc ?? 0) > 0) { … }`, espejo de la web. (Requiere rebuild APK.)

---

## P3

| ID | Título | Área | Fix breve |
|---|---|---|---|
| AUD-012 | Cross-check de monto compara cargo NETOPIA (net+fee 3%) vs `amount_usd` net; el fee consume casi toda la tolerancia 5% | edge-fn | Comparar contra `amount_usd + fee_usd` (cargo real); persistir `charge_usd` |
| AUD-014 | `cancel_ride` UPDATE de `cancellation_count`/`last_cancellation_at` revertido por `tg_users_protect_admin_fields` (trust-flag nunca extendido) | trigger | GUC `app.trusted_cancel_update` set por `cancel_ride` + el protect-trigger lo honra **solo** para esas 2 columnas |
| AUD-015 | `revalue_anchored_wallets` ajusta el balance aun con tasa sin cambio → drift de redondeo per-tx al ledger | money | Gatear en cambio real de tasa o dead-band `|v_delta|` chico |
| AUD-016 | Mantenimiento de anchor (`ROUND amount/rate*100`) vs revaluación (`ROUND anchor/100*rate`) no-inversos → error sub-CUP acumulado | money | Recomputar anchor autoritativo (`ROUND(balance/rate*100)`) o llevar USD nativo + dead-band |
| AUD-017 | `revalue_anchored_wallets` sin `FOR UPDATE` en `platform_fx_reserve` ni el cursor por-wallet → hazard latente de `balance_after` | money | `SELECT … FOR UPDATE` el reserve + re-leer cada wallet bajo lock |
| AUD-018 | `tg_rides_validate_insurance` recomputa `insurance_premium_cup` de config viva en cada UPDATE (sin snapshot) | trigger | Snapshotear la prima al booking + scope `UPDATE OF insurance_selected, service_type, estimated_fare_cup` |
| AUD-019 | Push de pago-fallido muestra USD mientras el email muestra CUP — inconsistencia cross-canal | trigger | `CREATE OR REPLACE notify_payment_intent_failure` para renderizar CUP como el email |
| AUD-020 | `setManualRate` update-then-insert no atómico (no usa `upsert_exchange_rate`) → ventana sub-ms de cero-current | service-ts | Usar `rpc('upsert_exchange_rate', …)` como el EF |
| AUD-021 | Grant colgante: `get_users_with_anniversary_today` whitelisteado para behavioral-emails pero la EF no tiene path de aniversario (infra muerta) | edge-fn | Implementar el job, o dropear función+grant y arreglar el comentario (default lanzamiento: dropear) |

---

## Diferidos / externos (no son bugs de código)

- **NETOPIA live onboarding** (dashboard geo-bloqueado, factura+comodato firmados por María Loraime). El fix de AUD-001 es **código** y debe shippear **antes** del switch; habilitar live es el paso externo. No flipear `netopia_environment='live'` hasta que AUD-001 shippee.
- **Apple Developer enrollment** bloqueado (INVALIDITCUSER) → inscribir como Organización (D-U-N-S → $99, autoridad María Loraime). Android-first. Sin acción de código.
- **Google Play**: 2 apps en review normal desde 7-8 jun. Build v5 sin los fixes del 10-jun → tarea operativa shippear v6. No es bug.
- **Apple review-note refund-copy mismatch** (`client/store-metadata/app-store-review-notes.md:55-56` promete refund opcional al borrar cuenta, pero `00439` forfeit a `platform_revenue`; la web es consistente con forfeiture). Fix de copy (riesgo de rechazo Apple), no de dinero: editar la nota Apple a "el saldo se pierde/no se reembolsa", salvo que refund-to-source sea la intención real de producto.

---

## Guion E2E (Fase B) — transacciones rolled-back contra prod

> Valida el camino real que el seed demo (triggers OFF, `session_replication_role=replica`) nunca ejercitó. Cada caso en `DO $$ … RAISE EXCEPTION 'rollback' $$` (auto-revertido) o `BEGIN … ROLLBACK`. Autorización vía AskUserQuestion (mueve dinero/triggers en infra compartida). Actores prod: `:DRIVER_PROFILE=70fda82e-…`, `:DRIVER_USER=feccfe1f-…`, `:CUSTOMER(María)=f2b1564e-…`. Impersonar con `set_config('request.jwt.claims', json_build_object('sub', <uid>), true)`. `commission_rate=0.15`.

1. **E2E-1 CASH** — crear ride → seed `ride_offers` → `accept_ride_v2` → `complete_ride_and_pay`. Asserts: snapshot trigger disparó; **paridad estricta** (`accept_ride_v2` no recomputa fare → `final==estimated`); **sin `driver_cash`** en los ledger_entries de comisión de ESE ride (scoped, no grep global); `recompute_user_level` disparó; legs de comisión suman 0.
2. **E2E-2 TRICICOIN** — María (`customer_cash≥2200`) paga tricicoin; driver acreditado a **tricicoin** (no driver_cash); anchor: `trg_ledger_maintain_usd_anchor` baja el anchor por `ROUND(2200/rate*100)`; legs suman 0.
3. **E2E-3 MIXED** — porción wallet 1100 de María; driver recibe solo la porción wallet; cash off-ledger; legs (wallet+comisión) suman 0; anchor baja por `ROUND(1100/rate*100)`.
4. **E2E-4 CORPORATE** (el más importante) — `corporate_account` throwaway con `corporate_cash` fondeado → ride corporate 2200 → completar. `handle_corporate_ride_completion` setea `app.trusted_corporate_update` antes del UPDATE. Asserts: `current_month_spent` +2200 (no revertido por el protect-trigger); `corporate_cash −2200` = driver+plataforma suman 0. **Extensión para cazar AUD-006:** assert driver = orig − corp_rate split (no 15% default).
5. **E2E-5 LATE CANCEL** — aceptar, backdatear `accepted_at` a `now()−20min`, `cancel_ride` como pasajero. Asserts: usa `cancellation_rating_events`, **no** `apply_cancellation_fee` (sin dinero); 2ª tardía = 3.0★. **CAVEAT:** confirmar el nombre de la columna de rating antes de assertear.
6. **E2E-POST** — correr `supabase/money-health-check.sql`: los 7 detectores vacíos, `final==estimated` donde hay snapshot, legs suman 0. `ROLLBACK` final — sin mutación persistida.

---

## Procedencia
Workflow `wf_5e01f4dd-b2c` (run 2026-06-20). Grounding contra prod viva (`pg_get_functiondef`/`prosrc`/`list_migrations`/`get_advisors`), no contra archivos de migración. Próxima migración libre: **00445** (`00433`/`00440` saltados).
