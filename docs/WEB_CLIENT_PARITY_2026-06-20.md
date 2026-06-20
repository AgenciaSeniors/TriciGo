# Auditoría Web ↔ Client (pasajero) — 2026-06-20

Referencia/fuente de verdad: **app client** (pasajero móvil). Objetivo: bugs en la web + paridad feature-por-feature. Método: barrido multi-agente (3 agentes de matriz de paridad + 7 finders por bug-class + verificación adversarial con grounding contra prod read-only). Baseline: parte de PASS 2 (2026-06-10/12, PRs #482–#496, todos vivos — verificado).

## Resumen ejecutivo

- **40 features** comparadas → **31 en paridad plena**, 9 con gap/divergencia.
- **31 candidatos** verificados → **27 confirmados**, **4 refutados** (con motivo).
- **0 P1.** Nada bloqueante: sin pérdida de dinero, sin fallas de seguridad, sin crashes. El backend de dinero salió sano (incluido el nuevo modelo USD-anchor 00441–00444, que es interno: el rider sigue viendo CUP/TC 1:1).
- Tras deduplicar (scheduling y promo-deeplink aparecían 2×; wallet-i18n 2×), quedan **~22 hallazgos accionables**: **8 P2** + **~14 P3**. El grueso es **i18n** (7 páginas/comp. web hardcodeados en español) y **display/UX** de paridad.
- **+1 hallazgo fuera del workflow** (grounding propio): `fx_revaluation` mal etiquetado como "Regalo" en el helper compartido (P2, afecta client+driver+web).

## Drift nuevo desde PASS 2 (contexto)

Migraciones **00441–00444** introdujeron pricing y wallet **anclados a USD** (`usd_anchored_pricing`, `wallet_usd_anchor`). Es **interno**: USD es la verdad, la columna CUP es cache derivada, y el rider sigue viendo CUP/TC 1:1. Nuevo `ledger_entry_type` `fx_revaluation` + `wallet_account_type` `platform_fx_reserve`. Próxima migración libre: **00445**.

## Hallazgos confirmados

### P2 (priorizar)

| # | Área | Hallazgo | Archivo | Fix |
|---|------|----------|---------|-----|
| P2-1 | dinero/helper | **`fx_revaluation` se muestra como "Regalo"** en el historial de billetera. El helper compartido `classifyWalletTxn` no tiene rama para `fx_revaluation` → cae a `kind='transfer'`. 4 txns vivas en prod tocan `customer_cash` (rider) y `tricicoin` (driver). Afecta client + driver + web. | `packages/utils/src/ledger.ts:78-133` | Agregar rama `type==='fx_revaluation'` → nuevo `kind:'fx'` (o `'adjustment'`) + label/icon + i18n es/en/pt en las 3 superficies. |
| P2-2 | dinero/web | **"Tarifa final" omite la propina.** `/track/[id]` muestra `final_fare_cup` crudo; `add_tip` solo incrementa `tip_amount`, nunca `final_fare_*`. El detalle `/rides/[id]:561` ya usa `riderChargedTotal`; tracking quedó atrás. | `apps/web/src/app/track/[id]/page.tsx:1379` | `formatCUP(riderChargedTotal(ride))` (+ `riderChargedTotalTrc` para tricicoin/mixed). |
| P2-3 | dinero/web | **Titular "Tarifa estimada" no resta el descuento de compartir viaje.** Muestra tarifa completa mientras el botón Solicitar muestra `displayFareCup` (con descuento). 3 importes en pantalla. El server cobra el del botón (no hay pérdida), pero confunde. | `apps/web/src/app/book/page.tsx:1591` (y :1585 rama con-promo) | Usar `displayFareCup`/`displayFareTrc` como base del titular. |
| P2-4 | notif/web | **Tap del inbox es no-op muerto** para `dispute_update`/`sos`/`lost_item`/`system` (sin `ride_id`): marca leído pero no navega. El móvil tiene `else → home`. Latente post-wipe pero estructural. | `apps/web/src/app/notifications/page.tsx:480-498` | Agregar `else` final → `/rides/${rid}` si hay ride, si no `router.push('/')`. |
| P2-5 | i18n/web | **`/wallet` 100% hardcodeado en español** (0 `t()`). Página de dinero alcanzable desde el nav; EN/PT ven todo en español. El client usa `t()` ~88×. | `apps/web/src/app/wallet/page.tsx` (+ `wallet/receipts` P3) | `useTranslation('web')` + keys es/en/pt. |
| P2-6 | i18n/web | **`/rides` (historial) 100% hardcodeado en español** (0 `t()`). Nav top-level; el detalle `/rides/[id]` sí está localizado, solo la lista regresó. | `apps/web/src/app/rides/page.tsx` | `useTranslation('web')` + keys es/en/pt. |
| P2-7 | paridad/gap | **Viaje programado one-off ("Programar viaje") ausente en la web.** El client manda `scheduled_at` en `createRide` y lista los programados aparte; la web no tiene UI de programar ni sección. El service ya lo soporta (`ride.service.ts:80,483-484`). (Distinto de recurrentes, que sí están.) | `apps/web/src/app/book/page.tsx`, `apps/web/src/app/rides/page.tsx` | Agregar checkbox + `datetime-local` → `scheduled_at`; sección "Programados" en historial. |
| P2-8 | paridad/web | **`/promo/[code]` es un dead-end** ("Abrir en TriciGo") aunque `/book` soporta promo. No detecta sesión ni pre-aplica el código; el rider web logueado tiene que tipearlo a mano. Los hermanos `/gift` y `/refer` sí redirigen/aplican. | `apps/web/src/app/promo/[code]/page.tsx` | Persistir el code + `router.replace('/book?promo=<code>')` y que `/book` lea `useSearchParams().get('promo')` para pre-cargar+validar. |

### P3 (limpieza)

| # | Área | Hallazgo | Archivo |
|---|------|----------|---------|
| P3-1 | dinero/web | Saldo del wallet usa sufijo **"TRC"** vs **"TC"** del client (`formatTRC` vs `formatTriciCoin`). Mismo número, branding inconsistente. | `apps/web/src/app/wallet/page.tsx:529,539` |
| P3-2 | flujo/web | `cancelRide(ride.id, 'delivery_details_failed')` pasa el motivo en el slot de `_userId` → `p_reason=null`, se pierde el motivo (runtime-silent, cliente sin tipar). | `apps/web/src/app/book/page.tsx:863` |
| P3-3 | flujo/web | Error de validación de booking **persiste** tras corregir el input: `handleEstimateAll` nunca hace `setError(null)`. | `apps/web/src/app/book/page.tsx` (efecto auto-estimate :628-634) |
| P3-4 | flujo/web | Timestamps del chat en TZ del navegador, no `America/Havana` (el móvil hace lo mismo — convención, no regresión). | `apps/web/src/app/chat/[rideId]/page.tsx:231` |
| P3-5 | notif/web | Deep-link de notif de viaje **activo** va a `/rides/[id]` (estático) en vez de `/track/[id]` (vivo). | `apps/web/src/app/notifications/page.tsx:485-489` |
| P3-6 | notif/web | Notif de **chat** va a `/rides/[id]` en vez de `/chat/[rideId]` (la web tiene la página de chat). | `apps/web/src/app/notifications/page.tsx:485` |
| P3-7 | notif/web | `lost_item` cae al icono de campana genérico (el móvil usa lupa). | `apps/web/src/app/notifications/page.tsx:17-114` |
| P3-8 | notif/web | Fecha de notifs >7 días omite `timeZone:'America/Havana'` (el hermano date-group sí lo pasa). | `apps/web/src/app/notifications/page.tsx:129` |
| P3-9 | datos/web | **`/support` usa `supabase.from('support_tickets').insert` crudo** con categorías fuera del enum (`'payment'`/`'account'`/`'safety'` no existen en `TicketCategory`); sin CHECK en prod → persiste basura que admin lee como enum. + i18n hardcodeado + fecha sin TZ. | `apps/web/src/app/support/page.tsx:32-38,86-92,321` |
| P3-10 | validación/web | `trusted-contacts` no valida teléfono cubano (`isValidCubanPhone`) al crear; el hermano `emergency-contact` sí. Deja crear un contacto que el SOS no podrá SMS-ear. | `apps/web/src/app/profile/trusted-contacts/page.tsx:90-91,314` |
| P3-11 | paridad/web | Corporate: la web omite la tarjeta "Facturación" (`getBillingSummary`) y "Viajes recientes" (`getCorporateRides`). Dato alcanzable vía reports/invoice. | `apps/web/src/app/profile/corporate/page.tsx` |
| P3-12 | i18n/web | `/wallet/receipts` 100% hardcodeado en español. | `apps/web/src/app/wallet/receipts/page.tsx` |
| P3-13 | i18n/web | `HomeDashboard` (home logueado dentro de `/book`) hardcodea labels de sección. | `apps/web/src/components/HomeDashboard.tsx:103,127,137,184` |
| P3-14 | i18n/web | `SplitInviteBanner` hardcodea español (el client `SplitInviteCard` usa `t()`; las keys existen en es/en/pt). | `apps/web/src/components/SplitInviteBanner.tsx` |
| P3-15 | i18n/web | Páginas de redención deep-link (`refer`/`promo`/`gift` `[code]`) hardcodean español. | `apps/web/src/app/{refer,promo,gift}/[code]/page.tsx` |
| P3-16 | i18n | `book.promo_question`/`book.promo_placeholder` faltan en `en/pt` `web.json` → fuga de español (con `defaultValue`, no key cruda). | `packages/i18n/src/locales/{en,pt}/web.json` |
| P3-17 | i18n/web | `/support` y `/help` FAQ hardcodeados / sin buscador (reparto de responsabilidades benigno, pero copy sin `t()`). | `apps/web/src/app/support/page.tsx`, `apps/web/src/app/profile/help/page.tsx` |

## Refutados (4) — no tocar

1. **Wallet USD-anchor headline divergence** — la diferencia de código es real pero **dormida e intencional**: `balance_usd_cents` está NULL en todas las wallets de prod (el modelo escribe `anchor_usd_cents`), así que el native cae a la misma rama CUP-primary que la web. No hay divergencia visible.
2. **Wallet USD subtitle condition** — mismo motivo: la brecha requiere `balance_usd_cents>0 AND anchor_usd_cents IS NULL`, que no ocurre en prod.
3. **Promo no se limpia al cambiar servicio/vehículo** — ya cerrado en PASS 2 (useEffect centralizado `book/page.tsx:176-179` resetea `promoResult`). No es regresión.
4. **`onClear` no limpia `allEstimates`/promo** — ya cerrado: ambos `onClear` llaman `setAllEstimates({})` (:959,:1013) y el efecto 176-179 limpia el promo. El candidato se generó contra una versión vieja.

## PRs mergeados (resultado — todos en `master`, CI verde)

Los **27 hallazgos confirmados** quedaron arreglados en 10 PRs encadenados (cada uno branch fresh desde `origin/master`, `pnpm check-types` 4 apps verde + CI). El trabajo i18n mecánico y la feature de scheduled-rides se delegaron a subagentes y se verificaron/corrigieron en el loop principal.

| PR | Foco | Hallazgos |
|----|------|-----------|
| [#575](https://github.com/AgenciaSeniors/TriciGo/pull/575) | `fx_revaluation` en `classifyWalletTxn` (+label/icon/i18n, client+driver+web) | P2-1 |
| [#576](https://github.com/AgenciaSeniors/TriciGo/pull/576) | dinero web: propina en "Tarifa final", descuento compartir en titular, sufijo TC | P2-2, P2-3, P3-1 |
| [#578](https://github.com/AgenciaSeniors/TriciGo/pull/578) | inbox web: else de tap, chat→/chat, activo→/track, icono lost_item, TZ fecha | P2-4, P3-5/6/7/8 |
| [#580](https://github.com/AgenciaSeniors/TriciGo/pull/580) | i18n `/wallet` + `/rides` + `/wallet/receipts` (es/en/pt) | P2-5, P2-6, P3-12 |
| [#582](https://github.com/AgenciaSeniors/TriciGo/pull/582) | i18n HomeDashboard, SplitInviteBanner, deep-link `[code]`, `book.promo_*`, FAQ help | P3-13/14/15/16, P3-17(help) |
| [#583](https://github.com/AgenciaSeniors/TriciGo/pull/583) | feature: viaje programado one-off (`/book` + `/rides`) | P2-7 |
| [#585](https://github.com/AgenciaSeniors/TriciGo/pull/585) | `/promo/[code]` aplica el código para riders web logueados | P2-8 |
| [#586](https://github.com/AgenciaSeniors/TriciGo/pull/586) | cleanup: cancelRide slot, error booking stale, chat TZ, validación trusted-contacts | P3-2/3/4/10 |
| [#588](https://github.com/AgenciaSeniors/TriciGo/pull/588) | `/support` → `supportService` + categorías canónicas + i18n + TZ | P3-9, P3-17(support) |
| [#590](https://github.com/AgenciaSeniors/TriciGo/pull/590) | corporate: tarjeta "Facturación" + "Viajes recientes" | P3-11 |

**Cero migraciones** (todo display/UI/i18n; el backend no se tocó). Autorización de merge **permanente** otorgada por el usuario ("mergeá a medida que pasen checks"). Próxima migración libre sigue siendo **00445**.
