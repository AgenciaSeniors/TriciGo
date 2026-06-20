# Auditoría profunda pasajero (web+client) — robustez/realtime/offline/a11y · 2026-06-20 (tanda 2)

2ª tanda de la auditoría de pasajero (la 1ª fue paridad web↔client, `docs/WEB_CLIENT_PARITY_2026-06-20.md`). Dimensiones: realtime/polling, edge cases del flujo de viaje, errores/offline/timeouts, accesibilidad, performance. Método: 3 Explore agents → pool de candidatos → **workflow de verificación adversarial** (cada candidato abierto contra el código actual + grounding prod read-only, sesgo a refutar) + pase de completeness.

## Resumen

- **22 candidatos del pool** → 9 confirmados, 2 diferidos, **11 refutados**. + **12 hallazgos nuevos** de completeness.
- **0 P1.** Casi todo P3 (UX/robustez) + un puñado P2 (errores crudos, timeout de búsqueda, a11y de pantallas críticas). Backend sano.
- **21 hallazgos accionables arreglados** en 5 PRs (#595–#599). Alcance: robustez funcional + a11y quick-wins (decisión del usuario). Perf pesado (virtualización) y focus-trap → **diferidos**. **Cero migraciones.**
- Alta tasa de falsos confirmada: 11/22 candidatos refutados (varios ya estaban bien o se arreglaron en la tanda 1). Ejemplos: el "spinner de recarga colgado" (sí resetea en catch), corporate recharge (sí tiene finally), confirmRide (sí resetea isRequesting), mapbox fetch (sí tiene timeout vía `@tricigo/utils`), footer imgs (sí tienen alt), driver-stuck/track interval (cleanup correcto).

## Arreglado (5 PRs)

| PR | Tema | Hallazgos |
|----|------|-----------|
| [#595](https://github.com/AgenciaSeniors/TriciGo/pull/595) | web errores/timeouts | booking error crudo→`getErrorMessage` (P2); Nominatim fetch sin timeout→8s AbortController (P2); `err.message`/`String(err)` crudos en profile/edit·referral·corporate→`getErrorMessage` (P3) |
| [#596](https://github.com/AgenciaSeniors/TriciGo/pull/596) | web edge cases viaje | `/track` polling infinito contra ride ilegible (RLS)→corta tras 3 not-found (P3); cerrar add-stop al pasar a terminal (P3) |
| [#597](https://github.com/AgenciaSeniors/TriciGo/pull/597) | web offline | indicador global de conexión `WebOfflineBanner` (paridad con móvil) (P3) |
| [#598](https://github.com/AgenciaSeniors/TriciGo/pull/598) | web a11y quick-wins | aria-label en back/icon buttons + chat/gift/support inputs + dark-mode (es); `htmlFor`/`id` en forms (book-envío, login, emergency, profile-edit, trusted, complete-profile); `aria-live`/`role=alert` en errores/estado dinámico (wallet, book, track, login, gift, emergency) |
| [#599](https://github.com/AgenciaSeniors/TriciGo/pull/599) | client robustez | delivery-cleanup: reason en slot correcto + mensaje accionable si el cancel también falla; `useRiderLocationSharing` leak de suscripción GPS (race de cleanup async); `getRouteETA` guard latest-wins |

## Diferido (documentado, no arreglado)

- **avatarcrop focus-trap** (`apps/web/src/components/AvatarCropModal.tsx`): el modal no atrapa el foco (a11y pesado, fuera del alcance quick-wins). Propuesta: focus-trap + cerrar con Escape.
- **virtualización de listas** (`wallet`/`rides` con "cargar más" acumulan DOM): refactor grande; bajo impacto hoy por volumen de datos chico + paginación. Propuesta: `react-window` cuando crezca el historial.
- **web delivery double-failure message** (`apps/web/src/app/book/page.tsx`): el web ya pasa el reason correcto; agregar el mensaje accionable de doble-fallo (como el client en #599) quedó como residual menor (P3, requiere dos fallos consecutivos, cargo nunca ejercitado en prod).

## Refutados (11) — no tocar

`subscribeToRide` no-op (intencional, polling de respaldo); recharge spinner/`corporate-recharge`/`confirmRide`/`wallet-poll` (todos tienen finally/catch correcto hoy); `mapbox-fetch-no-timeout` (el real vive en `@tricigo/utils` con timeout; `geoService` es re-export); `reverse-geocode-abort` (bounded por debounce+guard); `track-interval-leak`/`driver-stuck-interval` (cleanup exhaustivo); `web-static-route-inprogress` (no es bug de robustez); `footer-img-alt` (las 2 imgs tienen alt); `recharge-error-raw` (`translateNetopiaError` ya se usa); `dispute-upload-abort` (aborta en la 1ª foto pero el manejo de error es aceptable).

## Verificación

`pnpm check-types` (4 apps) verde en cada PR + CI verde. Cambios de a11y = atributos (no alteran render); errores/offline/edge = lógica cliente. Sin migraciones. El código del **client** (#599) ships en el próximo rebuild de APK.
