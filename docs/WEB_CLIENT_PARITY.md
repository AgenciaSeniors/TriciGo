# Web ↔ Client parity (rider)

Living checklist for bringing `apps/web` to full functional parity with the mobile
rider app `apps/client`. Web keeps its own design; only business logic + features
must match. Source of truth = the **native** render of the client
(`NativeHomeScreen`, `NativeWalletScreen`, `RideActiveView`, `RideCompleteView`,
hooks in `apps/client/src/hooks/`).

Legend: `[x]` done · `[ ]` pending · `[~]` partial/in-progress

---

## Fase 0 — Cross-cutting
- [x] Share `RIDE_CONFIG` via `@tricigo/utils` (`packages/utils/src/ride-config.ts`); client re-exports.
- [x] Cuban phone validation already shared (`@tricigo/utils` → `isValidCubanPhone`/`normalizeCubanPhone`).
- [x] Create this parity doc.

## Fase 1 — Booking (`apps/web/src/app/book/page.tsx`)
Logic divergences:
- [x] Minimum distance 200m (`RIDE_CONFIG.MIN_DISTANCE_M`) in confirm.
- [x] 1.2× surge buffer on TriciCoin balance check (+ fresh balance fetch at confirm).
- [x] Re-check corporate budget before create (`corporateService.getAccount`).
- [x] Send `insurance_premium_cup` + respect `insurance_available` (toggle gated on availability).
- [x] Estimate freshness — re-estimate at confirm + Δ>5% abort + `fareEstimatedAtRef`.
- [x] Double-submit guard with sync refs (`isSubmittingRef`/`pendingRequestIdRef`).
- [x] Price snapshot breakdown in `createRide` (base/per_km/per_min/min_fare/surge/pricing_rule_id).
Missing features:
- [dropped] ~~Scheduled ride (≥15min)~~ — feature retired, no longer used; not ported to web.
- [x] Shared ride (triciclo: `share_ride`/`declared_passengers` + seats stepper + discount preview).
- [dropped] ~~Ride preferences (`rider_preferences`)~~ — feature retired, no longer used; not ported to web.
- [x] Destination prediction (`useDestinationPredictions` web hook → quick-pick chips).
- [x] Delivery: package dims (L/W/H) + `deliveryService.createDeliveryDetails` (cancel-on-failure).
- [n/a] Notify trusted contacts — fires at *arrival* in client, belongs to Fase 2 (tracking), not booking.
Alignment:
- [x] Receiver phone regex unified (`isValidRecipientPhone`).
- [x] `pickup_address`/`dropoff_address` format (raw `address`, like client).
- [x] `ride_mode: 'passenger'` explicit.
- [x] Nearby radius/limit aligned to client (5km / 30).

Verification: `pnpm check-types` green (4 apps); `/book` compiles + renders 200 in Next dev. Full
authenticated booking E2E pending (needs live OTP session on device).

## Fase 2 — Tracking + Chat (`track/[id]`, `chat/[rideId]`)
- [x] **[CRITICAL]** Driver position: `/track/[id]` migrated from dead broadcast to polling RPC `get_driver_position` (new `useDriverPosition` web hook, 1 Hz + timeout/retry).
- [x] Dynamic ETA (OSRM via `fetchRoute`, 30s throttle, from live driver position to pickup/dropoff).
- [x] Rider location sharing in pickup (new `useRiderLocationSharing` web hook → `rider-location:${rideId}` broadcast).
- [x] `arrived_at_destination` state in stepper.
- [x] Tracking health banners (waiting-for-location / stale signal).
- [x] Cancel with status-aware preview copy (fee warning when driver en route).
- [x] `RideCompleteView`: tip (`TipFlow`) + categorized rating tags.
- [x] Chat: quick replies (`getQuickRepliesForRole`), char counter (400/500), offline banner.
- [x] Cancel **exact** fee + penalty preview (`previewCancellationFee` + `previewCancelPenalty` in the confirm dialog).
- [x] Driver-no-GPS consent + confirm-arrival modal (`gps_override_*` + `riderConfirmDriverArrival`; `Ride` type extended with `gps_override_requested_at`/`gps_override_confirmed_at`/`gps_check_distance_m`).
- [x] Add stop mid-ride (`getRideWaypoints` list + `AddressAutocomplete` → `estimateWaypointAddition` preview → `addWaypointToActiveRide`, máx 3).
- [x] Receipt download (HTML → print/PDF) + email (`getReceiptData` + `generateReceiptHTML` / `sendRideReceipt`) in `/track/[id]` completed view **and** `/rides/[id]`.
- [x] "Llegó seguro" auto-share contact SMS on completion (once, `localStorage` guard) + lightweight rating reminder banner (5 min, scrolls to rating).
Remaining (deferred — lower-frequency / heavier):
- [x] Split fare management. (PR-FU-6: `track/[id]` gestión + `SplitInviteBanner` en `/book` + estado en `rides/[id]`)
- [ ] Chat unread badge / last-read sealing; driver header vehicle+plate.

Verification: `pnpm check-types` green (4 apps); `/track/[id]` + `/rides/[id]` + `/chat/[rideId]` compile + render 200 in Next dev. Live driver-marker movement + GPS/confirm-arrival modal trigger E2E pending (needs an active ride with the `gps_override_*` flags set / a driver streaming GPS).

## Fase 3 — Wallet (`wallet/page.tsx`, `wallet/receipts`)
- [ ] USD-cents / Wallet v2 (`availableUsdCents`/`migrationRate`) + migration banner.
- [ ] `translateNetopiaError` on failures.
- [ ] Receipt PDF polling post-recharge (6×2s) + tappable chip.
- [ ] Per-transaction USD caption.
- Keep: `deviceFingerprint`, dynamic provider, no `recharge_type` (default `customer`).

## Fase 4 — Auth (`login` + complete-profile + verify-phone)
- [ ] Cuban phone validation/normalization + demo mode.
- [ ] OTP auto-submit at 6th digit + 60s resend timer.
- [ ] `deviceService.registerLoginDevice` after OTP login.
- [ ] complete-profile screen (force name/avatar on first login).
- [ ] verify-phone screen (`linkPhone`/`verifyPhoneLink` for OAuth).
- [ ] Route via `authService` (not raw EF calls).
- [ ] Session guard (missing `full_name`→complete-profile, OAuth missing `phone`→verify-phone).
- [ ] Clear domain stores on logout.

## Fase 5 — Profile + secondary screens
Build (missing): ~~`ride-preferences`~~ (dropped — retired), ~~`recurring-rides`~~ (dropped — retired), `emergency-contact`, `ticket-detail`.
Parity pass (existing): `settings`, `saved-locations`, `safety`, `trusted-contacts`, `corporate`, `help`, `about`, `referral`, `support`, `driver-profile/[userId]`, `promo/[code]`, `refer/[code]`, `notifications`.

## Fase 6 — Gift P2P (new)
- [ ] `wallet/gift` (send): phone/code, amount, note, my code + QR.
- [ ] `gift/[code]` (redeem/landing).
- [ ] "Regalar" button in `/wallet`.
- [ ] Reuse `walletService.sendGift/findUserByPhone/findUserByGiftCode/getTransfers`, `referralService.getOrCreateReferralCode`.
- [ ] Web QR (lib) + code-text fallback.

---

# Re-auditoría a grano fino (2026-05-31)

Las Fase 0–6 de arriba quedaron **gruesas y desactualizadas** (marcaban Wallet/Auth/Gift como "pendientes" cuando ya estaban implementadas). Esta sección las **reemplaza** con micro-fases por comportamiento: cada una lleyó el client (fuente de verdad) y la web, y dejó una tabla de diff `✅` a la par / `⚠️` parcial / `❌` falta. Orden de la app; 1 PR por área.

## Área 1 — Auth (`login`, `complete-profile`, `verify-phone`, `auth/callback`, `providers`)

### 1.1 Login — entrada de teléfono
| Comportamiento (client) | Web | Nota |
|---|---|---|
| Validación/normalización cubana | ✅ | `isValidCubanPhone`/`normalizeCubanPhone` |
| Modo demo: picker de prefijo (CU/BR) + validación permisiva | ✅ FIX | Infra ya existía en `config/demo.ts`; ahora el login la usa (`DEMO_MODE`/`DEMO_DIAL_CODES`/`isValidDemoPhone`/`normalizeDemoPhone`) |
| `authService.sendOTP` | ✅ | |
| OAuth Google/Apple | ✅ | `signInWithOAuth` → `/auth/callback` |
| Captura de referral (puente sessionStorage) | ✅ | `PENDING_REFERRAL_KEY` |
| Aviso legal (Términos/Privacidad) | ✅ FIX | Links a `/terms` y `/privacy` añadidos |
| Feedback "teléfono incompleto" | ✅ | Web deshabilita el botón (patrón web equivalente al toast móvil) |

### 1.2 Login — verificación OTP
| Comportamiento (client) | Web | Nota |
|---|---|---|
| Validación 6 dígitos + `verifyOTP` | ✅ | |
| `registerLoginDevice` post-login | ✅ | `registerWebLoginDevice` en `routeAfterAuth` |
| Auto-submit al 6º dígito | ✅ | |
| Timer de reenvío 60s | ✅ | |
| Confirmación de reenvío | ✅ FIX | Mensaje inline "Código reenviado" (equivalente al toast móvil) |
| Limpiar error al re-tipear | ✅ FIX | `setError(null)` en onChange del OTP |

### 1.3 Complete-profile
| Comportamiento (client) | Web | Nota |
|---|---|---|
| Nombre mín. 2 + hint inline | ✅ | |
| `updateProfile` → home; redirect si ya completo | ✅ | |
| Avatar (opcional) | ⚠️ | Web ofrece email (opcional) en su lugar; avatar editable luego en `profile/edit` — adaptación web aceptada |
| Escape hatch (cambiar/cerrar cuenta) | ✅ FIX | Link "¿No sos vos? Cerrar sesión" (parity con `SwitchAccountFooter`, BUG-299b) |

### 1.4 OAuth + guard de sesión + logout
| Comportamiento (client) | Web | Nota |
|---|---|---|
| OAuth Google/Apple | ✅ | |
| Routing del callback (sin nombre→complete, sin teléfono→verify-phone) | ✅ | `auth/callback` con timeout 5s |
| Guard de sesión en rutas de app | ✅ | `ProfileGuard` en `providers.tsx` |
| Pantalla verify-phone (linkPhone/verifyPhoneLink) | ✅ | Web incluso agrega auto-submit; demo picker añadido (FIX) |
| Limpiar stores de dominio al logout | n/a | La web no tiene stores zustand globales (estado por página); `signOut` limpia sesión Supabase |

**Verificación Área 1:** `pnpm --filter @tricigo/web check-types` verde; `/login`, `/complete-profile`, `/verify-phone` render 200 en dev sin error markers. Demo mode se ejercita con `NEXT_PUBLIC_DEMO_MODE=true`.

## Área 2 — Booking (`book/page.tsx`, `BookingMap`, `AddressAutocomplete`)

Fuente de verdad = flujo **nativo** del client `SelectingView` (`app/(tabs)/index.tsx`) + `useRide.ts` `confirmRide`. (El `WebHomeScreen`/`ReviewingView` del client son su propio fallback Expo-web / código muerto — NO son la referencia.) Resultado: **paridad esencialmente completa**; la web incluso va por delante en varias cosas. Único gap real cerrado: el TTL del estimado.

### 2.1 Selector de servicio + disponibilidad
| Comportamiento (client) | Web | Nota |
|---|---|---|
| 5 tipos de servicio | ✅ | `page.tsx` WEB_SERVICES |
| ETA por tipo (conductor más cercano) | ✅ | Web usa ruta real (`fetchETAsToPickup`+`adjustETAForVehicle`) — más preciso que el haversine del client |
| Vehículos cercanos | ✅ | 5km/30; render como markers (ninguna pantalla activa muestra conteo) |
| Deshabilitar grid hasta tener origen+destino | ✅ | gate por `pickup && dropoff` |

### 2.2 Búsqueda de origen
| Comportamiento (client) | Web | Nota |
|---|---|---|
| Recientes / guardados / predicciones | ✅ | `AddressAutocomplete` (localStorage + saved + predictions) |
| POIs / calles / cruces / parsing cubano | ✅ | |
| Abort / cache / session-token | ✅ | |
| "Usar mi ubicación" + reverse-geocode | ✅ | Web lo pone en el mapa (botón) en vez de fila en el dropdown — equivalente |
| Confirmar pin en mapa | ✅ | `BookingMap` center pin + `handleConfirmLocation` |

### 2.3 Destino + predicciones + waypoints
| Comportamiento (client) | Web | Nota |
|---|---|---|
| Quick-picks por historial (solo destino) | ✅ | |
| Pin de destino en mapa | ✅ | |
| Agregar paradas ≤3 al reservar | ✅ | `< 3` + payload de waypoints |

### 2.4 Estimado + desglose
| Comportamiento (client) | Web | Nota |
|---|---|---|
| Estimado por tipo | ✅ | `handleEstimateAll` |
| Tarjeta de desglose (km/min/per-km/surge/USD) | ✅ | Web muestra per-km + tasa de cambio; ninguna pantalla activa muestra base/min_fare itemizado |
| Buffer surge 1.2× en chequeo TriciCoin | ✅ | `requiredTrc * 1.2` |
| Re-estimación al confirmar + abort Δ>5% | ✅ | |
| **TTL de frescura (>5 min → rechazar/refrescar)** | ✅ FIX | `fareEstimatedAtRef` se seteaba pero **nunca se leía**; ahora el confirm rechaza estimados viejos (`RIDE_CONFIG.FARE_ESTIMATE_TTL_MS`) y auto-refresca (parity con `useRide.ts` X1.3) |
| Fetch fresco de saldo al confirmar | ✅ | |

### 2.5 Opciones
| Comportamiento (client) | Web | Nota |
|---|---|---|
| Pago: efectivo / TriciCoin (saldo vivo) / mixto (slider) | ✅ | |
| Selector corporativo | ✅ | Web tiene MÁS (no está en el `SelectingView` activo del client) |
| Promo + preview de descuento | ✅ | |
| Compartir viaje + asientos + descuento (triciclo) | ✅ | misma fórmula `floor(gross×freeSeats×7%)` |
| Mensajería: categoría/peso/dims/destinatario/instrucciones/acompaña | ✅ | Web incluye dims (≥ client) |

### 2.6 Guards de confirmación + transición
| Comportamiento (client) | Web | Nota |
|---|---|---|
| Distancia mín 200m | ✅ | `RIDE_CONFIG.MIN_DISTANCE_M` |
| Chequeo saldo TriciCoin / mixto | ✅ | |
| Re-chequeo presupuesto corporativo (`getAccount`) | ✅ | |
| Anti-doble-submit (refs sync) | ✅ | `isSubmittingRef`/`pendingRequestIdRef` |
| Snapshot de precio en createRide (6 campos) | ✅ | base/per_km/per_min/min_fare/surge/pricing_rule_id |
| `ride_mode` explícito | ✅ | |
| Transición a búsqueda | ✅ | Web navega a `/track/[id]` (arquitectura distinta, equivalente) |
| Detalles de entrega bloqueantes + cancel-on-fail | ✅ | |

**Retirados (correctamente ausentes en web):** viaje programado, preferencias de viaje, seguro. (El client aún arrastra `scheduled_at`/`insurance_*` en el payload de `useRide`, pero su UI activa no los expone; la web no los manda.)

**Verificación Área 2:** `pnpm --filter @tricigo/web check-types` verde; `/book` render 200 en dev sin error markers. El gap del TTL se cerró; el resto ya estaba a la par (varios ítems con la web por delante).

## Área 3 — Tracking (`track/[id]/page.tsx`, `TrackingMap`, hooks)

Fuente de verdad = `RideActiveView`/`RideCompleteView` + `useRide.ts`. La página recibió mucho trabajo reciente (#329/#333), así que gran parte ya está a la par. Principio: **features/lógica deben coincidir; la web mantiene su diseño** (animaciones/confeti/haptics/pulse = aceptable que difieran).

### 3.1 Búsqueda
| Comportamiento (client) | Web | Nota |
|---|---|---|
| Heartbeat + rondas de reintento + expansión de radio | ✅ | `useSearchingRide` (10s + retry) |
| Presencia "N conductores revisando" + fast-accept | ✅ | `useSearchingDrivers` |
| Marcadores cercanos + "Ampliando la búsqueda…" | ✅ | |
| Cancelar durante búsqueda; nunca auto-cancela | ✅ | |
| Pantalla dura "sin conductor" a los 120s | n/a | Era del `WebSearchingState` (fallback Expo-web del client); **no existe status `no_driver_found`** (no es un `RideStatus`). La retroalimentación de reintento/expansión es el equivalente nativo |
| Rotación de mensajes de búsqueda | ⚠️ | Web usa estados por `searchRound` (no rotación libre) — menor |

### 3.2 Aceptado / en-camino
| Comportamiento (client) | Web | Nota |
|---|---|---|
| Tarjeta de conductor (nombre/rating/vehículo/placa) + link a perfil | ✅ | |
| ETA dinámica (ruta, throttle 30s) | ✅ | |
| Compartir ubicación del rider en pickup | ✅ | `useRiderLocationSharing` |
| **Banner de proximidad ("conductor llegando")** | ✅ FIX | `haversineDistance` driver→pickup <300m (parity con `ProximityBanner`) |
| Polyline conductor→pickup (pre-viaje) | ✅ FIX PR-FU-4 | `TrackingMap` dibuja `approach-route` (driver→pickup, línea gris punteada) en `accepted`/`driver_en_route`, refetch >50m/5s, se limpia fuera de fase |
| Foto de conductor/vehículo | ⚠️ | Web muestra avatar con inicial — menor |
| Pulse ETA <3min / slide-up / "ver más" | n/a | Animaciones — diseño web propio |

### 3.3 Llegada + en-curso
| Comportamiento (client) | Web | Nota |
|---|---|---|
| Stepper con `arrived_at_destination` | ✅ | |
| Agregar parada (≤3) + preview de tarifa | ✅ | |
| Lista de paradas con estado | ✅ | |
| Polyline en vivo conductor→destino (en viaje) | ✅ | `TrackingMap` live route |
| **Banner llegada/llegando a destino** | ✅ FIX | cubierto por el banner de proximidad (driver→dropoff <300m) |
| Tarjeta de llegada + confeti | n/a | Confeti = diseño; el aviso textual lo da el banner |
| Barra de progreso del viaje (% + km restante) | ✅ FIX PR-FU-4 | `useTripProgress` web (port del móvil: proyecta GPS sobre la polyline pickup→dropoff, % monótono) + barra flotante en `in_progress`/`arrived_at_destination` |

### 3.4 Modales GPS
| Comportamiento (client) | Web | Nota |
|---|---|---|
| Consentimiento conductor-sin-GPS (continuar/cancelar-sin-cargo) | ✅ | |
| Confirmar-llegada ("¿Tu conductor está acá?") + "No lo veo" | ✅ | |

### 3.5 Completado
| Comportamiento (client) | Web | Nota |
|---|---|---|
| Estrellas + tags categorizados | ✅ | |
| Propina (presets+custom, no-efectivo) | ✅ | `TipFlow` |
| Recibo descargar (HTML/PDF) + email | ✅ | |
| SMS "llegó seguro" una vez (guard) | ✅ | |
| Recordatorio de calificación (5 min) | ✅ | banner (sin notif local — aceptable) |
| Persistir tags en `review_tags` | ✅ FIX PR-FU-4 | Web pasa **tag_keys** (mismo fallback set que el móvil) como `tags` a `submitReview` — ya no los dobla en el comentario. Gateado tras `categorized_ratings_enabled` (igual que `RideCompleteView`; hoy OFF → ningún app muestra chips). **Bug latente compartido:** el insert de `submitReview` usa `tag_key` pero `review_tags` sólo tiene `tag_id` NOT NULL + `review_tag_definitions` vacía → dormido en ambos por el flag OFF; fuera de scope web |
| Stats distancia/duración + línea de descuento | ⚠️ | Web muestra sólo tarifa — menor |
| Desglose de fare-split | ✅ FIX PR-FU-6 | gestión en `track/[id]` (invitar por teléfono `findUserByPhone`→`createSplitInvite`, listar/quitar `getSplitsForRide`/`removeSplitInvite`, sólo tricicoin); invitaciones entrantes en `/book` (`SplitInviteBanner`, poll `getMySplitInvites` + aceptar/rechazar); estado read-only en `rides/[id]` |

### 3.6 Seguridad / compartir / cancelar
| Comportamiento (client) | Web | Nota |
|---|---|---|
| Cancelar con preview de fee + penalización | ✅ | `previewCancellationFee`+`previewCancelPenalty` |
| SOS en cascada (reporte+broadcast+tel:106) | ✅ | |
| Banners de salud (esperando/señal intermitente) | ✅ | |
| **Compartir viaje** | ✅ FIX | Antes sólo copiaba un token existente; ahora **genera** el token al vuelo (`generateShareToken`) si falta, luego copia (parity con `handleShareTrip`) |
| Revocar token / dejar de compartir | ❌ | menor; el token expira 24h tras completar |
| Banners "conductor no se mueve (5min)" / "última vez hace X" | ✅ FIX PR-FU-4 | banner único con prioridad **stuck > stale > waiting** (parity con la versión colapsada de `RideActiveView`): detección "no se mueve" (coords sin cambio >20m por 5min) + subtexto "Visto hace X" desde `driverPos.position.recordedAt` |

**Fixes en este PR (Área 3):** banner de proximidad (#2) + generación de token al compartir (#6). **Fixes follow-up PR-FU-4:** polyline conductor→pickup (`approach-route`), barra de progreso (`useTripProgress` web), tags por `tag_key` (gateado tras `categorized_ratings_enabled`, paridad con móvil), banner de inactividad/última-vez. **Falsos positivos descartados:** estado `no_driver_found` (no es un `RideStatus`). **Fix follow-up PR-FU-6:** fare-split (gestión en `track/[id]` + banner de invitaciones en `/book` + estado en `rides/[id]`). **Área 3 sin follow-ups funcionales restantes.** **Diferencias de diseño aceptadas:** confeti, pulse, slide-up, haptics, foto de conductor.

**Verificación Área 3:** `pnpm --filter @tricigo/web check-types` verde; `/track/[id]` render 200 en dev sin error markers.

## Área 4 — Chat (`chat/[rideId]/page.tsx`, `useChat`, `track/[id]`)

Fuente de verdad = `app/chat/[rideId].tsx` + `useChat`/`useUnreadChatCount` móvil. El núcleo del chat ya estaba sólido; los gaps eran el **punto de entrada** y el **badge de no-leídos**.

### 4.1 Chat núcleo
| Comportamiento (client) | Web | Nota |
|---|---|---|
| Mensajes (`ride_messages`) | ✅ | `useChat` |
| Realtime + polling 8s fallback | ✅ | `useChat` |
| Indicador de tipeo + `notifyTyping` (debounced) | ✅ | |
| Quick replies por rol | ✅ | `getQuickRepliesForRole('rider')` |
| Contador de chars 400/500 | ✅ | |
| Banner offline | ✅ | la web **además** tiene cola offline que drena al reconectar (el client NO encola — sólo avisa); web por delante |
| Empty state / loading / auto-scroll / pendiente | ✅ | |

### 4.2 Chat — entrada + no-leídos + header
| Comportamiento (client) | Web | Nota |
|---|---|---|
| Botón de chat in-app desde el viaje activo | ✅ FIX | La web **no tenía punto de entrada** (sólo WhatsApp externo); ahora `/track/[id]` muestra "Mensajes" → `/chat/[id]` cuando hay conductor |
| Badge de no-leídos | ✅ FIX | nuevo `useUnreadChatCount` web (poll 12s, `chat_last_read_<id>` en localStorage, cuenta mensajes del otro > last-read) |
| Sellado de last-read (al abrir/cerrar el chat) | ✅ FIX | `stampChatRead` en mount+unmount del chat |
| Header del conductor: nombre + vehículo/placa | ✅ FIX | Antes sólo "Chat del viaje"; ahora nombre (1er nombre) + marca/modelo/placa vía `getRideWithDriver` |

**Fixes en este PR:** punto de entrada al chat + badge de no-leídos (`useUnreadChatCount` web + `stampChatRead`) + header con vehículo/placa. Cierra los pendientes "Chat unread badge / last-read sealing; driver header vehicle+plate" de la Fase 2. **Aclaración:** la "cola offline" no es un comportamiento del client (su banner dice reintentá manual) — la web ya la tiene y va por delante.

**Verificación Área 4:** `pnpm --filter @tricigo/web check-types` verde; `/track/[id]` + `/chat/[rideId]` render 200 en dev sin error markers.

## Área 5 — Wallet (`wallet/page.tsx`, `wallet/receipts`)

Fuente de verdad = `NativeWalletScreen` (`app/(tabs)/wallet.tsx`) + `walletService`/`paymentService`. La web ya estaba **muy completa y por delante** en varias cosas (Wallet v2 USD-cents, banner de migración, `translateNetopiaError`, `deviceFingerprint`, provider dinámico, página dedicada de recibos, paginación, UI de recarga multi-paso). Cerrados los gaps reales de freshness + acceso a recibos.

### 5.1 Saldo
| Comportamiento (client) | Web | Nota |
|---|---|---|
| USD-cents primario (`availableUsdCents`) + subtítulo TRC/CUP | ✅ | |
| Saldo retenido (USD-cents aware) | ✅ | |
| Banner de migración + bono | ✅ | |
| **Refetch al volver al foco** | ✅ FIX | nuevo effect `visibilitychange`/`focus` → refresca saldo + transacciones (parity con `useFocusEffect` móvil); antes sólo refrescaba al volver de NETOPIA |
| Animación count-up del saldo | n/a | cosmético — diseño web propio |
| Card "Este mes" (gastado/viajes/promedio) | ✅ FIX (PR-FU-1) | card mensual: sólo débitos `ride_payment`/`redemption` del mes → total/viajes/promedio + caption USD; se oculta si no hubo viajes (parity con BUG-280 móvil) |

### 5.2 Recarga
| Comportamiento (client) | Web | Nota |
|---|---|---|
| NETOPIA: presets + monto custom (USD) | ✅ | |
| Desglose USD neto + fee | ✅ | helpers idénticos |
| `translateNetopiaError` en fallo | ✅ | |
| Polling del intent al volver (20×2s) | ✅ | |
| `deviceFingerprint` | ✅ | **web por delante** (el nativo no lo manda) |
| Provider dinámico + CTA deshabilitada si off | ✅ | **web por delante** (el nativo hardcodea netopia) |
| Estados redirecting/verifying/success/failed | ✅ | **web por delante** (el nativo usa toasts) |
| `recharge_type` → customer por defecto | ✅ | la web lo omite (correcto) |

### 5.3 Recibos
| Comportamiento (client) | Web | Nota |
|---|---|---|
| Poll del PDF post-recarga (6×2s) | ✅ | |
| Página/lista de recibos + abrir (signed URL) | ✅ | **web por delante** — `/wallet/receipts` (el nativo no tiene lista) |
| **Acceso persistente a recibos desde el wallet** | ✅ FIX | antes `/wallet/receipts` sólo era alcanzable tras una recarga; ahora link "Ver recibos →" siempre visible en el header de transacciones |
| Chip inline "Comprobante" por transacción | n/a | el nativo lo usa porque NO tiene página de lista; la web cubre el acceso con la lista + el link persistente. Además `LedgerTransaction` no trae `payment_intent_id` (mapear chip↔recibo sería frágil) |

### 5.4 Transacciones
| Comportamiento (client) | Web | Nota |
|---|---|---|
| Lista + filtros (Todos/Recargas/Viajes/Bonos/Ajustes) | ✅ | mismos 5 chips |
| **Caption USD por transacción (≈ $X)** | ✅ FIX | antes requería `migrationRate`; ahora cae a la tasa de cambio en vivo (`migrationRate ?? exchangeRate`) como el nativo → wallets pre-migración igual muestran ≈ $X |
| Paginación / cargar más | ✅ | **web por delante** (el nativo carga 1 página de 20) |
| Empty state | ⚠️ | web sin CTA de acción (el nativo ofrece "Recargar"/"Mostrar todos") — menor |
| Íconos por tipo de transacción | n/a | el nativo mapea Ionicons; la web usa punto de color — diseño web propio |

**Fixes en este PR:** refetch-on-focus (#3) + link persistente "Ver recibos" + caption USD con fallback a tasa en vivo (#6). **Follow-ups:** card "Este mes" (insights mensuales), CTA en empty state. **Diferencias de diseño aceptadas:** count-up del saldo, íconos por tipo. **Web por delante:** deviceFingerprint, provider dinámico, página de recibos, paginación, UI de recarga.

**Verificación Área 5:** `pnpm --filter @tricigo/web check-types` verde; `/wallet` + `/wallet/receipts` render 200 en dev sin error markers.

## Área 6 — Rides (historial) (`rides/page.tsx`, `rides/[id]/page.tsx`)

Fuente de verdad = `NativeRidesScreen` (`app/(tabs)/rides.tsx`) + `app/ride/[id].tsx`. El **detalle** ya está por delante del nativo en muchas cosas (badge por estado, avatar, timeline con íconos, líneas surge/espera/propina/cancelación, tasa de cambio, recibo descargar/email, TipFlow). Los gaps reales estaban en la **lista**.

### 6.1 Lista de historial
| Comportamiento (client) | Web | Nota |
|---|---|---|
| Agrupación por fecha (Hoy/Ayer) | ✅ | web con headers explícitos de fecha (por delante) |
| Filtro de estado (Todos/Completados/Cancelados) | ✅ | |
| **Tarifa por fila — currency-aware + con propina** | ✅ FIX | antes `formatTRC(final_fare_trc)` para todos (mostraba TRC en efectivo, omitía propina); ahora `riderChargedTotal`/`riderChargedTotalTrc` → CUP en efectivo/mixto/corporativo, TRC en tricicoin (parity con el nativo) |
| Distancia por fila | ✅ | web la muestra (por delante) |
| Paginación / cargar más | ✅ | |
| **Refetch al volver al foco** | ✅ FIX | nuevo effect `visibilitychange`/`focus` (parity con el pull-to-refresh del nativo) |
| **Estado de error + reintentar** | ✅ FIX | antes tragaba el error y mostraba "sin viajes"; ahora muestra error + botón Reintentar |
| **Export CSV** | ✅ FIX | botón "Exportar CSV" (reusa `generateHistoryCSV`; en web descarga el archivo) |
| Tap fila → detalle, skeleton, empty state | ✅ | |
| Filtros extra (tipo de servicio / método de pago / rango de fechas) | ✅ FIX (PR-FU-3) | panel "Más filtros" → select servicio + select pago + fechas desde/hasta → `getRideHistoryFiltered` (server-side) |
| Sección de viajes programados | n/a | feature **retirada** (programados) — correctamente ausente |
| Íconos por tipo de vehículo (premium/confort/cargo) | ⚠️ | web usa 4 PNGs por prefijo — menor |

### 6.2 Detalle de viaje
| Comportamiento (client) | Web | Nota |
|---|---|---|
| Badge de estado / direcciones / conductor (nombre/rating/vehículo/placa) | ✅ | web por delante (color por estado, avatar, color/año) |
| Timeline de timestamps | ✅ | web por delante (íconos + motivo de cancelación) |
| Desglose de tarifa (descuento/surge/espera/propina/cancelación/total) | ✅ | web por delante en líneas de ítems |
| Método de pago / stats distancia-duración | ✅ | |
| Recibo descargar + email | ✅ | **web por delante** (el detalle nativo no los tiene) |
| TipFlow (no-efectivo) | ✅ | **web por delante** |
| Mapa de la ruta en el detalle | ✅ FIX (PR-FU-3) | reusa `TrackingMap` en modo estático (sin driver) con pickup/dropoff |
| Bloque cargo/delivery (destinatario/teléfono/paquete/OTP/instrucciones/fotos) | ✅ FIX (PR-FU-3) | `deliveryService.getDeliveryDetails` → card cuando `ride_mode==='cargo'` |
| Desglose CUP por-km/por-min + tachado estimado-vs-final | ⚠️ follow-up menor | la web muestra km/min como unidades; el desglose ya tiene surge/espera/propina/cancelación/total. Diferido (`getPricingSnapshot`) |
| Copiar ID / compartir viaje en el detalle | ⚠️ | menor |
| Links de disputa / objeto perdido | n/a | **retirados** — correctamente ausentes (el detalle nativo aún arrastra el código) |

**Fixes en este PR:** tarifa por fila currency-aware + con propina (#6, corrige regresión), estado de error + reintentar, refetch-on-focus, export CSV. **Follow-ups:** filtros extra de la lista, mapa + bloque cargo + desglose CUP/tachado en el detalle. **Retirados (correctamente ausentes):** viajes programados, disputa/objeto-perdido.

**Verificación Área 6:** `pnpm --filter @tricigo/web check-types` verde; `/rides` + `/rides/[id]` render 200 en dev sin error markers.

## Área 7 — Profile + subpantallas (`profile/*`, `support`)

Fuente de verdad = `app/(tabs)/profile.tsx` + `app/profile/*`. La más grande. **Construidas las 2 pantallas faltantes** + corregidos gaps de correctitud; los gaps de features más pesados quedan como follow-ups.

### 7.x Pantallas nuevas (construidas)
| Pantalla | Estado | Nota |
|---|---|---|
| `profile/emergency-contact` | ✅ NEW | Form nombre/teléfono(cubano)/relación → `customerService.updateProfile` (JSONB) + upsert `trustedContactService` con `is_emergency`+`auto_share` (parity con el screen móvil). Enlazada desde `/profile/safety`. |
| `support/[ticketId]` (ticket-detail) | ✅ NEW | Hilo de mensajes + responder (`supportService.getTicket/getMessages/sendMessage`), bloqueado si resuelto/cerrado. Las tarjetas de `/support` ahora enlazan al detalle (antes no se podía abrir un ticket). |

### 7.1–7.8 Subpantallas existentes
| Pantalla | Veredicto | Nota |
|---|---|---|
| Profile home | ✅ | menú/logout/nivel/avatar a la par |
| **Edit profile** | ✅ FIX | el guardado escribía nombre sólo en `user_metadata`; ahora **espeja a `public.users`** (como ya hacía el avatar) para que los conductores/listados vean el cambio |
| **Settings** | ✅ FIX (+ PR-FU-5b) | + persiste idioma en `users.preferred_language` (sync cross-device) + **enlace "Eliminar cuenta"** → `/account/delete` + **selector de método de pago** (cash/tricicoin/mixed) vía `customerService.ensureProfile`/`updateProfile` con `default_payment_method` (optimista+revert, paridad con el cycle del settings móvil). Notificaciones: la web usa modelo de 3 canales (push/email/sms) — adaptación web aceptada |
| Saved locations | ✅ | CRUD + autocomplete + pick-on-map; web por delante (detección home/work) |
| **Safety** | ✅ FIX (+ PR-FU-5b) | + botón **`tel:106`** + entrada al `emergency-contact`; + **compartir viaje activo** (`getActiveRide` → `getShareTokenForRide`/`generateShareToken` → Web Share / copiar enlace `tricigo.com/track/share/<token>`); + **historial de incidentes** (`incidentService.getMyIncidents`, últimos 5 con tipo/fecha/estado) — paridad con el safety móvil |
| Trusted contacts | ✅ | add/remove + auto_share + máx 5 + is_emergency |
| **Corporate** | ✅ FIX PR-FU-5a | + **onboarding no-miembros**: empty-state ahora renderiza form de solicitud (`submitClientRequest`) / "en revisión" / "rechazada+reenviar" según `getRequestStatus` (espejo de `CorporateRequestForm`); + **gestión de empleados**: sección colapsable por cuenta con lista (`getEmployees`), alta por teléfono+rol (`addEmployee`) y baja (`removeEmployee`) gateadas a admin. Lo de admins (presupuesto/recarga/política/reportes/factura) ya estaba |
| Referral | ✅ | código/compartir/aplicar/historial; web por delante (stats) |

**Fixes en este PR (Área 7):** 2 pantallas nuevas (emergency-contact, ticket-detail) + sus enlaces; edit→`public.users`; settings idioma-persist + enlace eliminar-cuenta; safety `tel:106` + entrada emergency-contact. **Fix follow-up PR-FU-5a:** corporate onboarding (form/en-revisión/rechazada) + gestión de empleados (alta/baja). **Fix follow-up PR-FU-5b:** safety historial de incidentes + compartir viaje activo; settings selector de método de pago. **Área 7 a la par — sin follow-ups funcionales restantes.** **Retirados (correctamente ausentes):** ride-preferences, recurring-rides, disputas, objetos perdidos.

**Verificación Área 7:** `pnpm --filter @tricigo/web check-types` verde; `/profile/emergency-contact`, `/support/[ticketId]`, `/profile/settings`, `/profile/safety`, `/profile/edit` render 200 en dev sin error markers.

## Área 8 — Regalo P2P (`wallet/gift`, `gift/[code]`)

Fuente de verdad = `app/wallet/gift.tsx` + `app/gift/[code].tsx`. **Resultado: ya está a la par** — no requirió cambios de código. (Construida en Fase 6; esta auditoría lo confirma comportamiento-por-comportamiento contra el fallback **web** del client.)

### 8.1 Enviar regalo
| Comportamiento (client) | Web | Nota |
|---|---|---|
| Saldo (`customer_cash`) | ✅ | `walletService.getBalance(_, 'customer_cash')` |
| Buscar destinatario por código (`findUserByGiftCode`) / teléfono (`findUserByPhone`) + toggle | ✅ | |
| Guard anti-self + "usuario no encontrado" | ✅ | |
| Monto (>0, ≤ saldo) + nota (máx 200) | ✅ | |
| Enviar (`walletService.sendGift`) + refrescar saldo | ✅ | |
| Mi código para recibir: mostrar + copiar + compartir | ✅ | `navigator.clipboard` / `navigator.share` |
| QR del propio código | ✅ FIX (PR-FU-2) | `qrcode.react` (`QRCodeSVG`) → QR de `https://tricigo.com/gift/<code>`; un amigo lo escanea con la cámara y abre el landing `/gift/[code]`. Mantiene el fallback texto+copiar/compartir. (El client sólo lo muestra en nativo; la web ahora lo tiene en escritorio.) |
| Escanear QR de un amigo | n/a | Escáner es nativo-only en el client; en web se tipea el código (igual que el fallback web del client) |

### 8.2 Landing + entrada
| Comportamiento (client) | Web | Nota |
|---|---|---|
| `gift/[code]` resuelve el código → pantalla de regalo precargada (NO redime como referido) | ✅ | redirect a `/wallet/gift?code=` (idéntico al client) |
| Botón "Regalar" en `/wallet` | ✅ | `wallet/page.tsx` enlaza a `/wallet/gift` |

**Sin cambios de código** — la web ya cubre todo el comportamiento del flujo de regalo del client (incl. su fallback web). **Enhancement diferido:** QR escaneable del propio código en web (necesita una lib de QR; el client tampoco lo muestra en web).

**Verificación Área 8:** revisión de código — `/wallet/gift` + `/gift/[code]` ya a la par; sin cambios necesarios.

---

## Estado final de la re-auditoría

Las **8 áreas** (Auth, Booking, Tracking, Chat, Wallet, Rides, Perfil, Regalo) fueron auditadas a grano fino y cerradas. Hallazgo macro: la web estaba **mucho más completa** de lo que indicaba el doc grueso (Fase 0–6), e incluso **por delante** del client nativo en varios puntos (ETA por ruta real, selector corporativo, deviceFingerprint, provider dinámico, página de recibos, cola offline de chat, paginación, desgloses de tarifa). Los gaps reales cerrados fueron puntuales y de correctitud. **Follow-ups documentados** (features más pesadas, no bloqueantes): split-fare; barra de progreso + polyline conductor→pickup + banners de inactividad en tracking; corporate onboarding/empleados; safety incidentes/compartir-activo; settings selector de pago; "Este mes" en wallet; mapa + bloque cargo en detalle de viaje; QR web del regalo.
