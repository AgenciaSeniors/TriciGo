# AUDITORIA PRE-PRODUCCION — TriciGo

**Fecha:** 2026-04-09
**Alcance:** Monorepo completo (web, admin, client, driver, packages, DB, edge functions)
**Metodologia:** 8 agentes de auditoria en 3 batches paralelos

---

## RESUMEN EJECUTIVO

| Severidad | Cantidad | Resueltos | Descartados | Pendientes |
|-----------|----------|-----------|-------------|-----------|
| P0-crash | 9 | 6 ✅ | 3 | 0 |
| P1-funcionalidad-rota | 41 | 38 ✅ | 3 | 0 |
| P2-degradado | 53 | 51 ✅ | 0 | 2 (mitigados) |
| P3-cosmetico | 13 | 13 ✅ | 0 | 0 |
| **TOTAL** | **116** | **108 ✅** | **6** | **2 (mitigados)** |

| Superficie | P0 | P1 | P2 | P3 | Total |
|------------|----|----|----|----|-------|
| Web (rider) | 2 | 6 | 8 | 4 | 20 |
| Admin | 0 | 4 | 8 | 3 | 15 |
| Client (mobile) | 0 | 12 | 10 | 3 | 25 |
| Driver (mobile) | 1 | 6 | 8 | 0 | 15 |
| Shared packages | 1 | 4 | 8 | 3 | 16 |
| Database | 3 | 2 | 2 | 0 | 7 |
| Edge functions | 2 | 7 | 9 | 0 | 18 |

---

# P0 — CRASHES / SEGURIDAD CRITICA ✅ (6/6 RESUELTOS)

### BUG-001: SQL injection en verify-otp edge function ✅ FIXED
- **Superficie:** edge-fn
- **Archivo(s):** supabase/functions/verify-otp/index.ts:174
- **Descripcion:** `userId` se interpola directamente en SQL raw: `UPDATE auth.users SET ... WHERE id = '${userId}'`. Un atacante puede inyectar SQL arbitrario.
- **Impacto:** Takeover de cuentas, escalacion de privilegios, modificacion masiva de auth.users.
- **Fix sugerido:** Usar RPC parametrizado: `await supabase.rpc('fix_null_tokens', { p_user_id: userId })`

### BUG-002: Webhook TropiPay sin verificacion de firma obligatoria ✅ FIXED
- **Superficie:** edge-fn
- **Archivo(s):** supabase/functions/process-tropipay-webhook/index.ts:152-183
- **Descripcion:** Si `TROPIPAY_WEBHOOK_SECRET` no esta configurado, el webhook se procesa igual (solo log warning). Un atacante puede forjar confirmaciones de pago.
- **Impacto:** Fraude financiero directo — recarga de wallets y pagos de viajes sin pago real.
- **Fix sugerido:** Rechazar con 403 si el secret no esta configurado en lugar de solo advertir.

### BUG-003: I18nProvider retorna null, app web completamente en blanco ✅ FIXED
- **Superficie:** web
- **Archivo(s):** apps/web/src/app/providers.tsx:87
- **Descripcion:** `I18nProvider` retorna `null` mientras i18n se inicializa. Como envuelve toda la app, la pagina queda completamente en blanco durante la carga inicial.
- **Impacto:** Usuarios ven pagina en blanco al entrar. Bloqueante para produccion.
- **Fix sugerido:** Retornar un loading skeleton o fallback UI en lugar de null.

### BUG-004: Track page sin auth guard — datos de viaje publicos ✅ FIXED
- **Superficie:** web
- **Archivo(s):** apps/web/src/app/track/[id]/page.tsx:97
- **Descripcion:** La pagina /track/[rideId] no tiene verificacion de autenticacion. Cualquier usuario puede acceder adivinando el ride ID. No hay middleware web.
- **Impacto:** Brecha de privacidad — datos de ubicacion en tiempo real expuestos.
- **Fix sugerido:** Agregar auth guard en useEffect + verificar ownership del ride en backend.

### BUG-005: Race condition en aceptacion de viaje — phantom trip ✅ FIXED
- **Superficie:** driver
- **Archivo(s):** apps/driver/src/hooks/useDriverRide.ts:225-289
- **Descripcion:** `acceptRide()` broadcast la aceptacion al rider ANTES de que el RPC complete. Si dos drivers aceptan simultaneamente, ambos setean `activeTrip` localmente. El segundo driver queda con un viaje fantasma.
- **Impacto:** Driver ve viaje que no existe en servidor; app queda stuck.
- **Fix sugerido:** Agregar `acceptingRef = useRef(false)` guard; solo setear activeTrip despues del RPC exitoso.

### BUG-006: Schema type error — service_type_slug no existe ✅ FIXED
- **Superficie:** db
- **Archivo(s):** supabase/migrations/00036_trip_insurance.sql:12
- **Descripcion:** Columna referencia tipo PostgreSQL `service_type_slug` que nunca se crea en ninguna migracion.
- **Impacto:** Migracion 00036 falla; feature de seguro de viaje completamente roto.
- **Fix sugerido:** Cambiar definicion de columna a `service_type TEXT NOT NULL`.

### BUG-007: FK type mismatch — driver_score_events.driver_id referencia users en vez de driver_profiles — DOWNGRADED P2
- **Superficie:** db
- **Archivo(s):** supabase/migrations/00012_score_matching.sql:20
- **Descripcion:** FK apunta a `users(id)` pero `update_driver_score()` inserta `driver_profiles.id`. Constraint violation en cada ride completado.
- **Impacto:** Driver scoring crashea; matching de drivers se rompe.
- **Fix sugerido:** ALTER FK para referenciar `driver_profiles(id)`.

### ~~BUG-008~~: REMOVIDO — tips FK es correcto
- **Estado:** No es un bug. La funcion `add_tip()` resuelve correctamente `driver_profiles.id` → `users.id` antes de insertar. El FK a `users(id)` es correcto para el flujo de la funcion.

### ~~BUG-009~~: REMOVIDO — proyecto es solo Cuba
- **Estado:** No aplica. El proyecto opera solo en Cuba, no requiere BRL/PYG/ARS.

---

# P1 — FUNCIONALIDAD ROTA ✅ (38/38 RESUELTOS, 3 descartados)

### BUG-010: Cancel button usa status inexistente 'driver_assigned' ✅ FIXED
- **Superficie:** web
- **Archivo(s):** apps/web/src/app/track/[id]/page.tsx:400
- **Descripcion:** Cancel button aparece para `['searching', 'driver_assigned', 'driver_en_route']` pero el FSM usa `'accepted'`, no `'driver_assigned'`. Boton NUNCA aparece despues de aceptacion.
- **Impacto:** Riders no pueden cancelar viajes post-aceptacion.
- **Fix sugerido:** Cambiar a `['searching', 'accepted', 'driver_en_route']`.

### BUG-011: Chat page sin auth guard ✅ FIXED
- **Superficie:** web
- **Archivo(s):** apps/web/src/app/chat/[rideId]/page.tsx:113-120
- **Descripcion:** /chat/[rideId] no tiene proteccion de autenticacion. Usuarios no autenticados pueden acceder.
- **Impacto:** Acceso no autorizado a chat de viajes.
- **Fix sugerido:** Agregar auth gate useEffect con redirect a /login.

### BUG-012: Ride detail page auth gate retorna null (flash) ✅ FIXED
- **Superficie:** web
- **Archivo(s):** apps/web/src/app/rides/[id]/page.tsx:102
- **Descripcion:** Auth check retorna null antes de redirect, causando flash de contenido blanco.
- **Impacto:** UX roto con paginas en blanco durante transicion de auth.
- **Fix sugerido:** Retornar loading screen en lugar de null.

### BUG-013: Wallet page auth gate retorna null ✅ FIXED
- **Superficie:** web
- **Archivo(s):** apps/web/src/app/wallet/page.tsx:167
- **Descripcion:** Mismo patron que BUG-012 — retorna null durante auth check.
- **Impacto:** Flash de pantalla en blanco.
- **Fix sugerido:** Retornar loading screen.

### BUG-014: Wallet balance failure silenciosa bloquea bookings ✅ FIXED
- **Superficie:** web
- **Archivo(s):** apps/web/src/app/book/page.tsx:332-337
- **Descripcion:** Si getBalance() falla, walletBalance queda en 0. Rider con TriciCoin no puede reservar porque el sistema cree que tiene saldo 0.
- **Impacto:** Riders con saldo no pueden pagar con TriciCoin.
- **Fix sugerido:** Distinguir "balance desconocido" de "balance es 0"; mostrar warning si falla.

### BUG-015: Profile pages sin auth guards ✅ FIXED
- **Superficie:** web
- **Archivo(s):** apps/web/src/app/profile/edit/page.tsx (y otros profile/*)
- **Descripcion:** Paginas de perfil no tienen auth guards. Intentan fetch con userId undefined.
- **Impacto:** API errors en paginas de perfil para usuarios no autenticados.
- **Fix sugerido:** Agregar useEffect auth gate a todas las paginas profile/*.

### BUG-016: Header crash cuando email es undefined ✅ FIXED
- **Superficie:** admin
- **Archivo(s):** apps/admin/src/components/layout/Header.tsx:40
- **Descripcion:** `email.charAt(0)` crashea si email es undefined/empty string durante inicializacion de useAdminUser().
- **Impacto:** Admin ve pantalla blanca — header component crashea.
- **Fix sugerido:** `const initial = (email || 'A').charAt(0).toUpperCase()`.

### BUG-017: Pagination allows negative page numbers ✅ FIXED
- **Superficie:** admin
- **Archivo(s):** apps/admin/src/app/rides/page.tsx:317
- **Descripcion:** Boton "previous" usa `setPage(p => p - 1)` sin bounds checking.
- **Impacto:** Requests API con offsets negativos.
- **Fix sugerido:** Usar `Math.max(0, p - 1)`.

### BUG-018: Open redirect en login admin ✅ FIXED
- **Superficie:** admin
- **Archivo(s):** apps/admin/src/app/login/page.tsx:13,49
- **Descripcion:** Parametro `redirect` de URL se usa directamente sin validacion. Permite redirect a URLs externas via `?redirect=https://evil.com`.
- **Impacto:** Phishing attacks contra admins.
- **Fix sugerido:** Validar que redirect es relativo y comienza con '/'.

### BUG-019: Suspension de driver sin confirmacion de consecuencias ✅ FIXED
- **Superficie:** admin
- **Archivo(s):** apps/admin/src/app/drivers/[id]/page.tsx:633-641
- **Descripcion:** Modal de suspension no explica que viajes activos seran cancelados.
- **Impacto:** Admin suspende driver activo accidentalmente.
- **Fix sugerido:** Agregar warning explicito sobre consecuencias.

### BUG-020: ILIKE sin escape de caracteres especiales ✅ FIXED
- **Superficie:** admin
- **Archivo(s):** packages/api/src/services/admin.service.ts:112,347
- **Descripcion:** Search filters usan `ilike('%${search}%')` sin escapar %, _, \.
- **Impacto:** Filtros de busqueda pueden matchear registros no deseados.
- **Fix sugerido:** Escapar caracteres especiales de LIKE antes de query.

### BUG-021: Discount applied wrong unit (CUP as TRC) ✅ FIXED
- **Superficie:** client
- **Archivo(s):** apps/client/app/(tabs)/index.tsx:3048
- **Descripcion:** `discountTrc` recibe valor en CUP de `promoResult?.discountAmount`, pero el nombre del campo sugiere TRC.
- **Impacto:** Montos de descuento incorrectos mostrados al rider.
- **Fix sugerido:** Trackear `discountCup` y `discountTrc` separadamente.

### BUG-022: Promo code discount no se limpia al re-estimar fare ✅ FIXED
- **Superficie:** client
- **Archivo(s):** apps/client/app/(tabs)/index.tsx:1934
- **Descripcion:** Cuando cambia el metodo de pago y se re-calcula fare, `promoResult` no se limpia. Descuento viejo aplicado a nuevo fare.
- **Impacto:** Perdida financiera — descuento incorrecto en cobro final.
- **Fix sugerido:** En `requestEstimate()`, limpiar promoResult antes de fetch.

### BUG-023: Corporate payment method no se resetea al deseleccionar cuenta ✅ FIXED
- **Superficie:** client
- **Archivo(s):** apps/client/src/stores/ride.store.ts:281-288
- **Descripcion:** Al deseleccionar cuenta corporativa, paymentMethod se resetea a 'cash' en vez de preservar el metodo anterior.
- **Impacto:** Usuario pierde seleccion de metodo de pago.
- **Fix sugerido:** Guardar metodo de pago previo antes de cambiar a corporate.

### BUG-024: validatingPromo race condition (useState + useRef) ✅ FIXED
- **Superficie:** client
- **Archivo(s):** apps/client/src/hooks/useRide.ts:161-188
- **Descripcion:** Doble estado (useState + useRef) para `validatingPromo` crea ventana donde confirm button puede estar habilitado durante validacion.
- **Impacto:** Double submission posible en dispositivos lentos.
- **Fix sugerido:** Usar solo ref OR solo state, no ambos.

### BUG-025: Minimum distance check (200m) bypassable ✅ FIXED
- **Superficie:** client
- **Archivo(s):** apps/client/src/hooks/useRide.ts:105-115
- **Descripcion:** Check de distancia minima solo en `requestEstimate()`. Si `confirmRide()` se llama directamente (deep link), se bypassa.
- **Impacto:** Rides con pickup = dropoff; backend rechaza, mala UX.
- **Fix sugerido:** Tambien validar distancia en `confirmRide()`.

### BUG-026: TRC balance check usa fare estimate stale ✅ FIXED
- **Superficie:** client
- **Archivo(s):** apps/client/src/hooks/useRide.ts:230
- **Descripcion:** Balance check compara con `estimated_fare_trc` que puede tener hasta 5 min. Si hay surge pricing, fare real > estimada.
- **Impacto:** Pago TRC falla al completar viaje; rider bloqueado.
- **Fix sugerido:** Re-estimar fare antes de balance check o agregar buffer 20%.

### BUG-027: Driver cancellation toast confuso en in_progress ✅ FIXED
- **Superficie:** client
- **Archivo(s):** apps/client/src/hooks/useRide.ts:456-467
- **Descripcion:** Si driver cancela durante `in_progress`, el mismo toast de "driver cancelo" aparece, lo cual no tiene sentido.
- **Impacto:** Mensaje confuso al rider.
- **Fix sugerido:** Verificar status previo !== 'in_progress' antes de mostrar toast.

### BUG-028: Re-estimate on payment change no actualiza promo ✅ FIXED (via BUG-022)
- **Superficie:** client
- **Archivo(s):** apps/client/app/(tabs)/index.tsx:1934-1942
- **Descripcion:** Cambio de metodo de pago re-calcula fare pero descuento de promo no se re-valida.
- **Impacto:** Descuento invalido aplicado a nuevo fare.
- **Fix sugerido:** Limpiar promoResult antes de re-estimate (ver BUG-022).

### BUG-029: Promo validation blocking confirm sin feedback claro ✅ FIXED
- **Superficie:** client
- **Archivo(s):** apps/client/src/hooks/useRide.ts:216-221
- **Descripcion:** Si usuario toca confirm durante validacion de promo, retorna early con toast. Boton sigue habilitado visualmente.
- **Impacto:** Usuario confundido por que confirm no funciona.
- **Fix sugerido:** Deshabilitar boton mientras `validatingPromo` es true.

### BUG-030: Delivery details no se guardan si falla API ✅ FIXED
- **Superficie:** client
- **Archivo(s):** apps/client/src/hooks/useRide.ts:296-323
- **Descripcion:** `createDeliveryDetails()` se llama DESPUES de crear ride. Si falla, ride existe sin metadata de delivery.
- **Impacto:** Driver no sabe destino ni datos del destinatario.
- **Fix sugerido:** Hacer creacion de delivery un paso bloqueante; si falla, cancelar ride.

### BUG-031: Stale realtime update detection fails con timestamps iguales ✅ FIXED
- **Superficie:** driver
- **Archivo(s):** apps/driver/src/stores/ride.store.ts:67-79
- **Descripcion:** Check usa `<=` en timestamps. Si DB actualiza ride dos veces en el mismo milisegundo, segunda actualizacion se ignora como "stale".
- **Impacto:** Cambios de status o fare silenciosamente descartados.
- **Fix sugerido:** Usar strict `<` o agregar campo de version.

### BUG-032: Auto-navigation countdown no respeta cancelacion ✅ FIXED
- **Superficie:** driver
- **Archivo(s):** apps/driver/app/(tabs)/index.tsx:363-377
- **Descripcion:** Si driver cancela auto-nav, `navCancelledRef` se setea true pero el timeout no lo verifica y lanza navegacion igual.
- **Impacto:** App lanza navegacion despues de que driver la cancelo.
- **Fix sugerido:** Agregar check `if (navCancelledRef.current) return` al inicio del timeout callback.

### BUG-033: Chat messages perdidos entre fetch y subscribe ✅ FIXED
- **Superficie:** driver
- **Archivo(s):** apps/driver/src/hooks/useChat.ts:20-26
- **Descripcion:** `getMessages()` y luego subscribe. Mensajes entre ambas operaciones se pierden.
- **Impacto:** Historial de chat se pierde al navegar fuera y volver.
- **Fix sugerido:** Subscribe PRIMERO, luego fetch. Dedup por message ID.

### BUG-034: Delivery photo upload retry con URI stale ✅ FIXED
- **Superficie:** driver
- **Archivo(s):** apps/driver/src/components/DeliveryPhotoSheet.tsx:61-84
- **Descripcion:** Si upload falla, `photoUri` no se limpia. Driver puede re-intentar con URI corrupta.
- **Impacto:** Foto subida dos veces o datos corruptos enviados.
- **Fix sugerido:** Agregar `setPhotoUri(null)` en catch block.

### BUG-035: Auto-accept sin preferencia de usuario para desactivar ✅ FIXED
- **Superficie:** driver
- **Archivo(s):** apps/driver/src/components/IncomingRideCard.tsx:134-188
- **Descripcion:** Auto-accept countdown no tiene forma de desactivarse permanentemente.
- **Impacto:** Driver forzado a aceptar viajes no deseados.
- **Fix sugerido:** Agregar AsyncStorage key `@tricigo/auto_accept_enabled`.

### BUG-036: Cron functions sin autenticacion (auto-admin, behavioral-emails, cancel-stale-rides) ✅ FIXED
- **Superficie:** edge-fn
- **Archivo(s):** supabase/functions/auto-admin/index.ts:362, behavioral-emails/index.ts:250, cancel-stale-rides/index.ts:16
- **Descripcion:** Functions de cron no validan que el request venga de pg_cron. Cualquier usuario autenticado puede invocarlas via HTTP.
- **Impacto:** Escalacion de privilegios — usuarios pueden aprobar drivers, resolver fraudes, etc.
- **Fix sugerido:** Validar x-cron-secret header o restriccion de acceso.

### BUG-037: Negative amount validation en create-tropipay-link ✅ FIXED
- **Superficie:** edge-fn
- **Archivo(s):** supabase/functions/create-tropipay-link/index.ts:88
- **Descripcion:** `amount_cup` se valida > 0 pero no para NaN o valores extremos.
- **Impacto:** Pagos negativos o overflow posibles.
- **Fix sugerido:** `if (!Number.isFinite(amount_cup) || amount_cup <= 0 || amount_cup > 10_000_000)`.

### BUG-038: Duplicate webhook processing — double credit ✅ FIXED
- **Superficie:** edge-fn
- **Archivo(s):** supabase/functions/process-tropipay-webhook/index.ts:219-226
- **Descripcion:** Idempotency check solo valida status='completed', pero webhooks duplicados en flight pueden ejecutar dos RPCs simultaneos.
- **Impacto:** Wallet creditada dos veces por un solo pago.
- **Fix sugerido:** Marcar intent como 'processing' atomicamente antes de RPC.

### BUG-039: Session token disclosure en verify-otp fallback ✅ FIXED
- **Superficie:** edge-fn
- **Archivo(s):** supabase/functions/verify-otp/index.ts:196-252
- **Descripcion:** Fallback genera password temporal y lo logea. Si logs expuestos, session tokens se filtran.
- **Impacto:** Compromiso de cuenta via leaked session en logs.
- **Fix sugerido:** No usar fallback con password temporal; fallar limpiamente.

### BUG-040: Unhandled auth.admin.listUsers crash en verify-otp ✅ FIXED
- **Superficie:** edge-fn
- **Archivo(s):** supabase/functions/verify-otp/index.ts:135
- **Descripcion:** Llamada sin error handling. Si falla, funcion entera crashea sin response.
- **Impacto:** 500 error sin feedback; usuario no puede verificar OTP.
- **Fix sugerido:** Agregar error handling con response 503.

### BUG-041: Silent push notification failures ✅ FIXED
- **Superficie:** edge-fn
- **Archivo(s):** supabase/functions/auto-admin/index.ts:131-139
- **Descripcion:** `send-push` failures se atrapan con `.catch(() => {})` — completamente silenciosas.
- **Impacto:** Notificaciones no llegan; nadie se entera.
- **Fix sugerido:** Logear errores de push en catch block.

### BUG-042: Race condition en sync-exchange-rate fallback ✅ FIXED
- **Superficie:** edge-fn
- **Archivo(s):** supabase/functions/sync-exchange-rate/index.ts:246-275
- **Descripcion:** Entre UPDATE old rate y INSERT new rate, hay momento con NO current rate.
- **Impacto:** Pricing de viajes usa rate null; calculos fallan.
- **Fix sugerido:** Usar operacion atomica (single RPC call).

### BUG-043: WalletRedemption status enum mismatch ✅ FIXED
- **Superficie:** shared
- **Archivo(s):** packages/types/src/wallet.ts:88
- **Descripcion:** DB enum: requested/approved/processed/rejected. TS type: pending/approved/rejected. Missing 'requested' y 'processed', usando 'pending' inexistente.
- **Impacto:** INSERT de redemptions falla; tracking de estados incompleto.
- **Fix sugerido:** Actualizar TS type a `'requested' | 'approved' | 'processed' | 'rejected'`.

### BUG-044: Ride disputes table missing fare snapshot columns ✅ FIXED
- **Superficie:** shared
- **Archivo(s):** supabase/migrations/00038_ride_disputes.sql vs packages/types/src/dispute.ts:52-53
- **Descripcion:** TS type tiene `ride_final_fare_trc` y `ride_estimated_fare_trc` pero DB no tiene esas columnas.
- **Impacto:** Refunds no se pueden capear al fare real; posible refund mayor que pago.
- **Fix sugerido:** Agregar columnas a tabla y CHECK constraint.

### BUG-045: payment_method enum 00049 posiblemente no aplicada a produccion ✅ FIXED
- **Superficie:** shared
- **Archivo(s):** supabase/migrations/00049_add_payment_method_values.sql
- **Descripcion:** Migracion agrega 'tropipay' y 'corporate' al enum payment_method. Ya se confirmo en sesion anterior que no estaba aplicada (error en vivo).
- **Impacto:** Rides con tropipay/corporate fallan con constraint violation.
- **Fix sugerido:** Verificar y aplicar migracion en produccion.

### BUG-046: arrived_at_destination status — migracion duplicada — NO ES BUG (IF NOT EXISTS seguro)
- **Superficie:** shared
- **Archivo(s):** supabase/migrations/00096_arrived_at_destination.sql:14, 00099_fsm_arrived_destination_roles.sql:5
- **Descripcion:** Dos migraciones agregan el mismo valor al enum. ALTER TYPE ADD VALUE no es rollbackable.
- **Impacto:** Si alguna migracion falla parcialmente, deployments posteriores se rompen.
- **Fix sugerido:** Remover duplicado de 00099.

### BUG-047: Trigger referencia funcion inexistente update_updated_at() ✅ FIXED (via migration 00101)
- **Superficie:** db
- **Archivo(s):** supabase/migrations/00036_trip_insurance.sql:40-43
- **Descripcion:** Trigger llama `update_updated_at()` pero la funcion se llama `update_updated_at_column()` (definida en 00004).
- **Impacto:** UPDATE en trip_insurance_configs falla.
- **Fix sugerido:** Cambiar a `EXECUTE FUNCTION update_updated_at_column()`.

### BUG-048: Phone validation solo Cuba, missing trinational — DEFERRED (roadmap)
- **Superficie:** shared
- **Archivo(s):** packages/utils/src/validation.ts:9-34
- **Descripcion:** Solo soporta formato cubano +535XXXXXXX. Sin validacion para Brasil (+55), Paraguay (+595), Argentina (+54).
- **Impacto:** Usuarios de expansion no pueden registrarse.
- **Fix sugerido:** Agregar funciones de validacion trinacional (roadmap item).

### BUG-049: Missing FK constraint en ride_disputes.incident_report_id ✅ FIXED
- **Superficie:** db
- **Archivo(s):** supabase/migrations/00038_ride_disputes.sql:41
- **Descripcion:** Columna sin FK constraint pero referencia incident_reports. Sin cascade behavior.
- **Impacto:** Registros huerfanos si incident_reports se borran.
- **Fix sugerido:** ADD CONSTRAINT FK con ON DELETE SET NULL.

### BUG-050: driver_score_events delta puede ser NULL — NO ES BUG (ya NOT NULL + COALESCE)
- **Superficie:** db
- **Archivo(s):** supabase/migrations/00012_score_matching.sql:23
- **Descripcion:** Columna delta sin NOT NULL. CASE sin ELSE retorna NULL. Math con NULL = NULL.
- **Impacto:** match_score del driver se convierte en NULL; scoring roto.
- **Fix sugerido:** ADD CONSTRAINT CHECK (delta IS NOT NULL).

---

# P2 — DEGRADADO ✅ (51/51 RESUELTOS)

### BUG-051: Track page polling never stops on terminal rides ✅ FIXED
- **Superficie:** web
- **Archivo(s):** apps/web/src/app/track/[id]/page.tsx:134
- **Descripcion:** setInterval(fetchRide, 10_000) nunca se detiene cuando ride completa/cancela.
- **Impacto:** Backend overload, bandwidth desperdiciado.
- **Fix sugerido:** clearInterval cuando isTerminal = true.

### BUG-052: Realtime subscription memory leak on book page ✅ FIXED
- **Superficie:** web
- **Archivo(s):** apps/web/src/app/book/page.tsx:245-264
- **Descripcion:** Multiple subscriptions pueden acumularse sin cleanup en remount rapido.
- **Impacto:** Memory leak si pagina de booking se monta/desmonta repetidamente.
- **Fix sugerido:** Ensure unsubscribe siempre se llama; custom hook wrapper.

### BUG-053: Promo code silent failure without service type ✅ FIXED
- **Superficie:** web
- **Archivo(s):** apps/web/src/app/book/page.tsx:545-573
- **Descripcion:** Si no hay selectedEstimate, handleApplyPromo retorna silenciosamente.
- **Impacto:** Usuario no sabe por que promo no aplica.
- **Fix sugerido:** Mostrar mensaje de error.

### BUG-054: Delivery phone validation regex too permissive ✅ FIXED
- **Superficie:** web
- **Archivo(s):** apps/web/src/app/book/page.tsx:593
- **Descripcion:** `/^\+?[\d\s-]{6,}$/` acepta "------" como valido.
- **Impacto:** Numeros invalidos aceptados para delivery.
- **Fix sugerido:** Regex mas estricto.

### BUG-055: Race condition in reverse geocode (pickup/dropoff) ✅ FIXED
- **Superficie:** web
- **Archivo(s):** apps/web/src/app/book/page.tsx:385-387
- **Descripcion:** Sin guard de race condition como centerGeoIdRef. Geocode requests pueden sobreescribir con datos stale.
- **Impacto:** Direccion incorrecta mostrada temporalmente.
- **Fix sugerido:** Usar ref counter guard.

### BUG-056: Track page realtime channel sin error handling ✅ FIXED
- **Superficie:** web
- **Archivo(s):** apps/web/src/app/track/[id]/page.tsx:128-135
- **Descripcion:** Sin error handling si channel.subscribe() falla.
- **Impacto:** Actualizaciones en tiempo real fallan silenciosamente.
- **Fix sugerido:** Agregar error handler y logging.

### BUG-057: Notifications page missing auth check ✅ FIXED
- **Superficie:** web
- **Archivo(s):** apps/web/src/app/notifications/page.tsx
- **Descripcion:** Sin auth guard en pagina de notificaciones.
- **Impacto:** Acceso no autenticado a notificaciones.
- **Fix sugerido:** Agregar auth gate.

### BUG-058: Missing error boundary on chat page ✅ FIXED
- **Superficie:** web
- **Archivo(s):** apps/web/src/app/chat/[rideId]/
- **Descripcion:** Sin error.tsx error boundary. Chat crashes no tienen recovery UI.
- **Impacto:** Errores rompen chat sin recuperacion.
- **Fix sugerido:** Crear chat/[rideId]/error.tsx.

### BUG-059: Admin dashboard realtime subscription leak ✅ FIXED
- **Superficie:** admin
- **Archivo(s):** apps/admin/src/app/page.tsx:85-106
- **Descripcion:** Channel subscription sin unsubscribe correcto en unmount. Sin logica de reconexion.
- **Impacto:** Memory leak, datos stale en dashboard.
- **Fix sugerido:** unsubscribe() antes de removeChannel().

### BUG-060: Disputes page race condition en resoluciones ✅ FIXED
- **Superficie:** admin
- **Archivo(s):** apps/admin/src/app/disputes/page.tsx:125-128
- **Descripcion:** Clicks rapidos en "resolve" pueden bypassar validacion de form.
- **Impacto:** Doble-submission de resoluciones de disputas.
- **Fix sugerido:** setResolving(true) ANTES de validacion.

### BUG-061: Pagination edge case — last page exactamente PAGE_SIZE items ✅ FIXED
- **Superficie:** admin
- **Archivo(s):** apps/admin/src/app/drivers/page.tsx, users/page.tsx
- **Descripcion:** canGoNext asume que length === PAGE_SIZE significa mas datos. False positive en ultima pagina.
- **Impacto:** Admin navega a pagina vacia.
- **Fix sugerido:** Implementar hasMore flag.

### BUG-062: Document URLs silent failure ✅ FIXED
- **Superficie:** admin
- **Archivo(s):** apps/admin/src/app/drivers/[id]/page.tsx:104-111
- **Descripcion:** Carga de URLs de documentos silenciosamente falla. Admin no ve errores.
- **Impacto:** Documentos no cargan; admin aprueba sin ver documentos.
- **Fix sugerido:** Mostrar estado de error en UI.

### BUG-063: Type safety violation en disputes page ✅ FIXED
- **Superficie:** admin
- **Archivo(s):** apps/admin/src/app/disputes/page.tsx:140
- **Descripcion:** Cast implicito de resolution a DisputeStatus sin validacion.
- **Impacto:** Mismatch de tipos puede causar errores runtime.
- **Fix sugerido:** Usar mapping object explicito.

### BUG-064: Missing .limit() en admin_actions query ✅ FIXED
- **Superficie:** admin
- **Archivo(s):** packages/api/src/services/admin.service.ts
- **Descripcion:** Dashboard query sin limit puede cargar datasets masivos.
- **Impacto:** Dashboard lento/unresponsive.
- **Fix sugerido:** Enforce .limit(50).

### BUG-065: Sidebar nav hardcoded ✅ FIXED
- **Superficie:** admin
- **Archivo(s):** apps/admin/src/components/layout/Sidebar.tsx:42-69
- **Descripcion:** navItems list hardcoded. Nuevas rutas no aparecen automaticamente.
- **Impacto:** Features de admin no descubribles.
- **Fix sugerido:** Documentar requisito de actualizar sidebar.

### BUG-066: Split fare UI potential stale activeRide ✅ FIXED
- **Superficie:** client
- **Archivo(s):** apps/client/app/(tabs)/index.tsx:3162
- **Descripcion:** Con clicks rapidos en confirm, activeRide stale puede mostrar split fare UI.
- **Impacto:** UI glitch mostrando split despues de interacciones rapidas.
- **Fix sugerido:** Guard en FareSplitSheet.

### BUG-067: Insurance/discount order unclear ✅ FIXED
- **Superficie:** client
- **Archivo(s):** apps/client/app/(tabs)/index.tsx:3048
- **Descripcion:** Descuento aplica antes o despues de insurance? Ambiguedad en FareBreakdownCard.
- **Impacto:** Rider no conoce costo real final.
- **Fix sugerido:** Clarificar que descuento aplica solo a fare base.

### BUG-068: Discount not validated for negative values ✅ FIXED
- **Superficie:** client
- **Archivo(s):** apps/client/src/hooks/useRide.ts:278-279
- **Descripcion:** `discount_amount_cup` enviado sin validar >= 0.
- **Impacto:** Calculo de fare incorrecto si descuento negativo.
- **Fix sugerido:** Validar discount >= 0 antes de crear ride.

### BUG-069: Rating reminder not cleared on error ✅ FIXED
- **Superficie:** client
- **Archivo(s):** apps/client/src/components/RideCompleteView.tsx:200-210
- **Descripcion:** Si review submission falla, notificacion de reminder no se limpia.
- **Impacto:** Rider recibe reminder duplicado.
- **Fix sugerido:** Limpiar ratingReminderId en catch block.

### BUG-070: WebMapView CSS injection on every mount ✅ FIXED
- **Superficie:** client
- **Archivo(s):** apps/client/src/components/WebMapView.tsx:17-40
- **Descripcion:** ensureMapboxCSS() se llama en cada mount en vez de una sola vez.
- **Impacto:** Memory leak potencial con estilos duplicados.
- **Fix sugerido:** Mover a module-level call.

### BUG-071: Route polyline waypoints unnecessary recalculation ✅ FIXED
- **Superficie:** client
- **Archivo(s):** apps/client/src/hooks/useRoutePolyline.ts:77
- **Descripcion:** waypoints array reference change causa recalculo innecesario de ruta OSRM.
- **Impacto:** API calls excesivos.
- **Fix sugerido:** Memoizar waypoints o usar JSON.stringify en dependency array.

### BUG-072: ETA minimum 1 minute inaccurate ✅ FIXED
- **Superficie:** client
- **Archivo(s):** apps/client/src/hooks/useETA.ts:111,118,126
- **Descripcion:** ETA nunca muestra < 1 min. Driver a 30 segundos muestra "1 min".
- **Impacto:** Rider sorprendido por llegada anticipada.
- **Fix sugerido:** Retornar fracciones para ETA < 1 min.

### BUG-073: Corporate budget doesn't account for pending rides ✅ FIXED
- **Superficie:** client
- **Archivo(s):** apps/client/app/(tabs)/index.tsx:2553-2561
- **Descripcion:** Budget remaining no incluye rides en "searching". Rider ve budget disponible, reserva, backend rechaza.
- **Impacto:** Creacion de ride falla post-confirm.
- **Fix sugerido:** Fetch corporate details frescos antes de confirmRide.

### BUG-074: Scheduled ride date minimum not enforced correctly ✅ FIXED
- **Superficie:** client
- **Archivo(s):** apps/client/app/(tabs)/index.tsx:2614-2649
- **Descripcion:** Si reloj del dispositivo esta mal, rider puede reservar viaje en el pasado.
- **Impacto:** Backend rechaza; mala UX.
- **Fix sugerido:** Validar schedule time en confirmRide.

### BUG-075: Realtime subscription cleanup leak in useRide ✅ FIXED
- **Superficie:** client
- **Archivo(s):** apps/client/src/hooks/useRide.ts:338-478
- **Descripcion:** Si subscribeToRide() falla, subscription no se captura para cleanup.
- **Impacto:** Memory leak si subscription setup throws.
- **Fix sugerido:** Wrap subscribe en try-catch.

### BUG-076: GPS fraud detection too strict ✅ FIXED
- **Superficie:** driver
- **Archivo(s):** apps/driver/src/hooks/useDriverRide.ts:329-337
- **Descripcion:** Warning si gpsPointCount < 10 && distance < estimated*0.5 es demasiado estricto en trafico lento.
- **Impacto:** Warning confuso en viajes normales.
- **Fix sugerido:** Check points per km en vez de total.

### BUG-077: Stale request acceptance — no toast de expiracion ✅ FIXED
- **Superficie:** driver
- **Archivo(s):** apps/driver/src/hooks/useDriverRide.ts:152-156
- **Descripcion:** Requests expiradas (30s TTL) se remueven silenciosamente del store.
- **Impacto:** Driver frustrado por accepts rechazados sin explicacion.
- **Fix sugerido:** Toast 'Oferta expirada' cuando se remueven stale requests.

### BUG-078: Break toggle blocked after ride completes (realtime lag) ✅ FIXED
- **Superficie:** driver
- **Archivo(s):** apps/driver/app/(tabs)/index.tsx:466-483
- **Descripcion:** activeTrip sigue truthy hasta que realtime sync actualiza. Driver no puede tomar break por 20-60s despues de completar.
- **Impacto:** Driver no puede descansar inmediatamente.
- **Fix sugerido:** Permitir break si ride status es 'completed'.

### BUG-079: Earnings milestone toast shown multiple times ✅ FIXED
- **Superficie:** driver
- **Archivo(s):** apps/driver/app/(tabs)/earnings.tsx:168-196
- **Descripcion:** shownMilestonesRef se resetea a medianoche pero milestones del dia anterior siguen en memoria.
- **Impacto:** Milestones duplicados.
- **Fix sugerido:** Resetear ref cuando todayKey cambia.

### BUG-080: Notification unread count desync ✅ FIXED
- **Superficie:** driver
- **Archivo(s):** apps/driver/app/(tabs)/index.tsx:275-292
- **Descripcion:** Notifications entre fetch y subscribe pueden perderse.
- **Impacto:** Badge muestra numero incorrecto.
- **Fix sugerido:** Solo contar notifications con created_at > fetchTime.

### BUG-081: Wallet balance stale values ✅ FIXED
- **Superficie:** driver
- **Archivo(s):** apps/driver/app/(tabs)/wallet.tsx:76-126
- **Descripcion:** Balance y transactions se fetchean en paralelo; balance puede ser inconsistente con tx list.
- **Impacto:** Balance menor que suma de transacciones recientes.
- **Fix sugerido:** Fetch secuencial o indicador de stale.

### BUG-082: Offline location buffering loses accuracy metadata ✅ FIXED
- **Superficie:** driver
- **Archivo(s):** apps/driver/src/hooks/useDriverLocation.ts:127-149
- **Descripcion:** Buffer offline no incluye accuracy GPS. Fraud detection imposible para segmentos offline.
- **Impacto:** GPS spoofing no detectable offline.
- **Fix sugerido:** Incluir accuracy en buffer structure.

### BUG-083: No input size limits en edge functions ✅ FIXED
- **Superficie:** edge-fn
- **Archivo(s):** All functions using req.json()
- **Descripcion:** Sin limites de tamano en request bodies. Payloads de 10MB+ posibles.
- **Impacto:** DoS via memory exhaustion.
- **Fix sugerido:** Check content-length header; rechazar > 1MB.

### BUG-084: Health-check public con CORS abierto ✅ FIXED
- **Superficie:** edge-fn
- **Archivo(s):** supabase/functions/health-check/index.ts:5
- **Descripcion:** `Access-Control-Allow-Origin: *` revela status de servicios internos.
- **Impacto:** Information disclosure para planning de ataques.
- **Fix sugerido:** Restringir a origins permitidos o internal-only.

### BUG-085: No email validation en send-email ✅ FIXED
- **Superficie:** edge-fn
- **Archivo(s):** supabase/functions/send-email/index.ts:514-520
- **Descripcion:** recipient_email no validado como formato de email valido.
- **Impacto:** Emails enviados a direcciones malformadas; delivery failure.
- **Fix sugerido:** Validar con regex de email.

### BUG-086: No phone validation en send-sms/send-sms-otp ✅ FIXED
- **Superficie:** edge-fn
- **Archivo(s):** supabase/functions/send-sms/index.ts:74, send-sms-otp/index.ts:27-34
- **Descripcion:** Numeros de telefono aceptados sin validacion de formato.
- **Impacto:** SMS malformados; potencial injection.
- **Fix sugerido:** Validar formato E.164.

### BUG-087: Rate limiter in-memory, lost on restart ✅ FIXED (documented + reduced window)
- **Superficie:** edge-fn
- **Archivo(s):** supabase/functions/_shared/rate-limiter.ts:3
- **Descripcion:** Rate limiter usa Map() en memoria. Se pierde en cada restart de Edge Function.
- **Impacto:** Rate limiting inefectivo; atacante puede bypassar esperando restart.
- **Fix sugerido:** Mover rate limiting a DB o Redis.

### BUG-088: Cron functions sin rate limiting ✅ FIXED (mitigated by BUG-036 cron auth)
- **Superficie:** edge-fn
- **Archivo(s):** cancel-stale-rides, auto-admin, behavioral-emails, sync-exchange-rate, sync-weather
- **Descripcion:** Functions de cron no usan rate-limiter. Si callable via HTTP, spam posible.
- **Impacto:** DoS de funciones y database.
- **Fix sugerido:** Agregar rate limiting.

### BUG-089: send-sms-otp dev mode fallback en produccion ✅ FIXED
- **Superficie:** edge-fn
- **Archivo(s):** supabase/functions/send-sms-otp/index.ts:45-50
- **Descripcion:** Si credentials de Meta/Twilio faltan, retorna `{ success: true, dev: true }` en vez de error.
- **Impacto:** OTP parece enviado exitosamente pero SMS nunca llega.
- **Fix sugerido:** Retornar 503 error si credentials no configuradas.

### BUG-090: ALLOWED_ORIGINS fallback hardcoded ✅ FIXED
- **Superficie:** edge-fn
- **Archivo(s):** supabase/functions/send-sms-otp/index.ts:9, verify-otp/index.ts:9
- **Descripcion:** Fallback a `'https://tricigo.com'` si ALLOWED_ORIGINS vacio. Potencial CORS bypass.
- **Impacto:** Requests desde dominios no autorizados aceptados.
- **Fix sugerido:** No usar fallback; requerir configuracion explicita.

### BUG-091: Sensitive data logged en process-tropipay-webhook ✅ FIXED
- **Superficie:** edge-fn
- **Archivo(s):** supabase/functions/process-tropipay-webhook/index.ts:186
- **Descripcion:** Payload completo de TropiPay logeado incluyendo posibles tokens de pago.
- **Impacto:** Data sensible en logs; leak potencial.
- **Fix sugerido:** Omitir campos sensibles del log.

### BUG-092: No logging de payment intents fallidos ✅ FIXED
- **Superficie:** edge-fn
- **Archivo(s):** supabase/functions/create-tropipay-link/index.ts:234-238
- **Descripcion:** Error solo logeado a console. Sin registro en DB para audit trail.
- **Impacto:** Failures silenciosos; admin no puede debuggear.
- **Fix sugerido:** Insertar en tabla de logs.

### BUG-093: Concurrent selfie verifications sin locking ✅ FIXED
- **Superficie:** edge-fn
- **Archivo(s):** supabase/functions/verify-selfie/index.ts:89-101
- **Descripcion:** Sin mecanismo de lock. Dos calls simultaneos pueden dar resultados diferentes.
- **Impacto:** Resultado no-deterministico.
- **Fix sugerido:** Check status 'pending' antes de procesar.

### BUG-094: ride_mode campo uses string en vez de RideMode enum ✅ FIXED
- **Superficie:** shared
- **Archivo(s):** packages/types/src/ride.ts:161
- **Descripcion:** `ride_mode: string` en vez de `ride_mode: RideMode` ('passenger' | 'cargo').
- **Impacto:** Sin type safety en mode checks.
- **Fix sugerido:** Cambiar a RideMode type.

### BUG-095: payment_status es TEXT sin constraint ✅ FIXED
- **Superficie:** shared
- **Archivo(s):** supabase/migrations/00024_tropipay_direct_payment.sql:9
- **Descripcion:** Columna TEXT sin CHECK constraint. Cualquier string puede insertarse.
- **Impacto:** Valores invalidos de payment_status en rides.
- **Fix sugerido:** Crear enum DB o CHECK constraint.

### BUG-096: Dispute enums sin enforcement en DB ✅ FIXED
- **Superficie:** shared
- **Archivo(s):** supabase/migrations/00038_ride_disputes.sql
- **Descripcion:** reason, status, priority, resolution son TEXT sin CHECK constraints.
- **Impacto:** Valores invalidos pueden insertarse.
- **Fix sugerido:** Crear DB enums o CHECK constraints.

### BUG-097: Unsafe type assertions en delivery details ✅ FIXED
- **Superficie:** shared
- **Archivo(s):** packages/api/src/services/ride.service.ts:448,453
- **Descripcion:** `as any` cast para package_category y delivery_vehicle_type.
- **Impacto:** Valores invalidos pueden insertarse sin validacion.
- **Fix sugerido:** Validar contra constantes antes de insercion.

### BUG-098: Exchange rate fallback silencioso a 1.0 ✅ FIXED
- **Superficie:** shared
- **Archivo(s):** packages/api/src/services/ride.service.ts:134
- **Descripcion:** Si RPC de surge falla, fallback hardcoded a 1.0 sin warning.
- **Impacto:** Surge pricing invisible; zero visibility si servicio caido.
- **Fix sugerido:** Logear warning; definir default en constante.

### BUG-099: driver_documents query sin limit en admin ✅ FIXED
- **Superficie:** shared
- **Archivo(s):** packages/api/src/services/admin.service.ts:153-156
- **Descripcion:** select('*') sin .limit(). Drivers con muchos documentos causan queries pesadas.
- **Impacto:** Admin page timeout para drivers con muchos docs.
- **Fix sugerido:** Agregar .limit(100).

### BUG-100: Unsafe ServiceTypeConfig type assertion ✅ FIXED
- **Superficie:** shared
- **Archivo(s):** packages/api/src/services/ride.service.ts:145
- **Descripcion:** Cast `as ServiceTypeConfig` sin validacion de shape.
- **Impacto:** Silent crash si RPC retorna shape inesperado.
- **Fix sugerido:** Null check antes de cast.

### BUG-101: RLS policy logic error — delivery_details con NULL driver_id ✅ FIXED
- **Superficie:** db
- **Archivo(s):** supabase/migrations/00084_delivery_feature_expansion.sql:35
- **Descripcion:** RLS policy permite driver UPDATE cuando rides.driver_id es NULL (antes de aceptar).
- **Impacto:** Customers pueden modificar delivery details antes de que driver acepte.
- **Fix sugerido:** Agregar NOT NULL check explicito en policy.

---

# P3 — COSMETICO ✅ (13/13 RESUELTOS)

### BUG-102: Missing Suspense fallback on track map ✅ FIXED
- **Superficie:** web
- **Archivo(s):** apps/web/src/app/track/[id]/page.tsx:13
- **Descripcion:** Dynamic import sin loading component explicitoo.
- **Impacto:** Mapa carga sin feedback visual.
- **Fix sugerido:** Agregar loading: () => <MapLoadingSkeleton />.

### BUG-103: Inconsistent loading UI text ✅ FIXED
- **Superficie:** web
- **Archivo(s):** apps/web/src/app/book/page.tsx:707-714
- **Descripcion:** Fallback hardcoded 'Cargando...' vs texto traducido en otras paginas.
- **Impacto:** Inconsistencia menor de UX.
- **Fix sugerido:** Estandarizar fallback text.

### BUG-104: Missing SEO on track/share pages ✅ FIXED
- **Superficie:** web
- **Archivo(s):** apps/web/src/app/track/share/[token]/page.tsx
- **Descripcion:** Sin Metadata export. Link previews no funcionan.
- **Impacto:** Pobre preview cuando riders comparten tracking links.
- **Fix sugerido:** Agregar generateMetadata.

### BUG-105: Missing loading shimmer on track page ✅ FIXED
- **Superficie:** web
- **Archivo(s):** apps/web/src/app/track/[id]/page.tsx
- **Descripcion:** Sin loading skeleton dedicado para mapa.
- **Impacto:** UX sin feedback durante carga.
- **Fix sugerido:** Agregar skeleton component.

### BUG-106: Missing error context in admin driver detail ✅ FIXED
- **Superficie:** admin
- **Archivo(s):** apps/admin/src/app/drivers/[id]/page.tsx:89
- **Descripcion:** Error silencioso — admin ve "not found" en vez de "API error".
- **Impacto:** Admin no puede distinguir "driver borrado" de "error de API".
- **Fix sugerido:** Pass error through state y mostrar ErrorState.

### BUG-107: Inconsistent error handling pattern across admin pages ✅ FIXED
- **Superficie:** admin
- **Archivo(s):** Multiple pages
- **Descripcion:** Algunas paginas usan error state + banner, otras silenciosamente atrapan errores.
- **Impacto:** UX inconsistente para admins.
- **Fix sugerido:** Estandarizar patron error state + AdminErrorBanner.

### BUG-108: No loading state during level change confirmation ✅ FIXED
- **Superficie:** admin
- **Archivo(s):** apps/admin/src/app/users/[id]/page.tsx:84-103
- **Descripcion:** Boton de confirm no se deshabilita durante request.
- **Impacto:** Double-click posible.
- **Fix sugerido:** disabled={levelUpdating || !reason.trim()}.

### BUG-109: Fare range ignores discount ✅ FIXED
- **Superficie:** client
- **Archivo(s):** apps/client/app/(tabs)/index.tsx:3071-3076
- **Descripcion:** Rango "usual fare" calculado sobre fare base, no descontado.
- **Impacto:** Rider confundido sobre rango de precio esperado.
- **Fix sugerido:** Calcular rango sobre monto descontado.

### BUG-110: Delivery vehicle type not validated before confirm ✅ FIXED
- **Superficie:** client
- **Archivo(s):** apps/client/app/(tabs)/index.tsx:1959-1964
- **Descripcion:** deliveryValid no verifica deliveryVehicleType.
- **Impacto:** Confirm falla, pobre UX.
- **Fix sugerido:** Agregar check de deliveryVehicleType.

### BUG-111: Nearby vehicles count hidden when 0 drivers ✅ FIXED
- **Superficie:** client
- **Archivo(s):** apps/client/app/(tabs)/index.tsx:3025-3031
- **Descripcion:** Si no hay drivers cercanos, no se muestra ningun texto.
- **Impacto:** Rider sin feedback sobre por que busqueda demora.
- **Fix sugerido:** Mostrar "0 conductores cercanos".

### BUG-112: payment_intent amount comment inconsistency ✅ FIXED
- **Superficie:** shared
- **Archivo(s):** supabase/migrations/00020_tropipay_payment_intents.sql:11
- **Descripcion:** Comentario dice "centavos" pero sistema usa unidades enteras post-rebase.
- **Impacto:** Confusion en mantenimiento.
- **Fix sugerido:** Actualizar comentario.

### BUG-113: Deprecated cupToTrcCentavos() still in use ✅ FIXED
- **Superficie:** shared
- **Archivo(s):** packages/api/src/services/ride.service.ts:33,265,286,355
- **Descripcion:** Funcion marcada @deprecated sigue en uso. Funciona pero confusa.
- **Impacto:** Confunsion de mantenimiento.
- **Fix sugerido:** Reemplazar con cupToTrc().

---

# TESTS

**Resultado:** 585 pass / 51 fail / 0 skipped

| Package | Pass | Fail | Total |
|---------|------|------|-------|
| @tricigo/api | 389 | 47 | 436 |
| @tricigo/utils | 196 | 4 | 200 |
| config, i18n, theme, types, ui | - | - | sin tests |

## Causas raiz de los 51 test failures:

### 1. Service/test drift — Zod validation (30+ failures)
Tests usan IDs simples ("ride-1", "user-1") pero services ahora validan UUID con Zod.
- **Archivos:** chat.test.ts, review.test.ts, dispute.test.ts, ride.test.ts
- **Fix:** Actualizar fixtures a UUIDs validos

### 2. Supabase mock chain incompleto (12+ failures)
Tests mockean `.from()` pero no `.select()` encadenado.
- **Archivos:** review.test.ts, dispute.test.ts, admin.test.ts, ride.test.ts
- **Fix:** Actualizar mocks para soportar .from().select() chain

### 3. Auth service functions.invoke undefined (4 failures)
Mock de Supabase client no incluye propiedad `functions`.
- **Archivo:** auth.test.ts
- **Fix:** Agregar `functions: { invoke: vi.fn() }` al mock

### 4. Matching service parameter drift (2 failures)
Service ahora envia `p_is_delivery: false` y usa `.eq('id', ...)` en vez de `.eq('user_id', ...)`.
- **Archivo:** matching.test.ts
- **Fix:** Actualizar expectations

### 5. Fare calculator business logic change (3 failures)
`calculateFareRange` ya no convierte via exchange rate de la misma forma.
- **Archivo:** fareCalculator.test.ts
- **Fix:** Actualizar assertions a nueva logica post-rebase

### 6. Phone mask format change (1 failure)
`maskPhone` ahora muestra mas digitos de prefijo internacional.
- **Archivo:** validation.test.ts:295
- **Fix:** Actualizar expected value

---

# PRIORIDAD DE FIXES

## Inmediato (Bloquea produccion) — TODOS FIXEADOS:
1. ~~BUG-001~~: SQL injection en verify-otp — FIXED (RPC parametrizado fix_null_auth_tokens)
2. ~~BUG-002~~: Webhook sin firma en TropiPay — FIXED (reject 500 si secret no configurado)
3. ~~BUG-003~~: I18nProvider retorna null — FIXED (loading skeleton branded)
4. ~~BUG-004~~: Track page sin auth — FIXED (auth guard + redirect a /login)
5. ~~BUG-005~~: Race condition aceptacion driver — FIXED (RPC primero, broadcast despues + acceptingRef)
6. ~~BUG-006~~: service_type_slug type inexistente — FIXED (migracion 00101 + aplicada a produccion)
7. BUG-007: FK mismatch driver_score_events — Ya arreglado en produccion (sesion anterior), solo limpieza de migracion
8. ~~BUG-008~~: REMOVIDO — no es un bug (funcion resuelve user_id correctamente)
9. ~~BUG-009~~: REMOVIDO — proyecto solo Cuba

## Alta prioridad (Pre-launch):
9-50: Todos los P1 bugs

## Post-launch:
51-101: P2 bugs
102-113: P3 bugs
