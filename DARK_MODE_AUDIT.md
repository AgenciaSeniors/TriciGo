# DARK_MODE_AUDIT — Auditoría de contraste en modo oscuro

Rama `fix/dark-mode-contrast` · base `29a20db` · 2026-05-19
Fase 0 del plan. El detalle completo está en los 5 archivos `DARK_MODE_AUDIT_*.md`.

## Resumen ejecutivo

| Área | Archivos | FIX | KEEP | REVIEW |
|---|---|---|---|---|
| packages compartidos | 42 + tokens | 7 | — | 6 |
| admin | 84 | 168 | 36 | 4 |
| web | 57 | 56 | 71 | 17 |
| client | 79 | 17 | (muchos) | 14 |
| driver | 99 | 1 | (casi todo) | 3 |
| **TOTAL FIX** | | **~249** | | |

## Metodología

- Firmas de grep por las 3 clases de bug, derivadas de los patrones de error pasados
  (commits `8bb388d`, `29a20db`, `dc5d5bb`, `1fd1280`).
- Las 3 clases: (1) falta variante `dark:` / color de un solo modo; (2) color
  hardcodeado que ignora el tema; (3) token compartido con mal valor.
- Triage (alcance = solo legibilidad): **FIX** = color bloqueado en una superficie que
  voltea con el tema → texto ilegible o contraste chocante al cambiar. **KEEP** =
  apariencia fija intencional (CTA de marca, overlay de mapa, indicador de estado).
  **REVIEW** = dudoso.
- 4 agentes en paralelo (1 por app) + auditoría manual de los packages compartidos.

## Hallazgos clave — desviaciones del plan

1. **driver — modo fijo a propósito.** El driver app NO es theme-flipping: está
   construido como dos superficies de un solo modo (mapas/navegación siempre oscuros,
   pantallas estándar siempre claras — sistema `midnightEmber.map` vs `.screen`). Solo
   **1 bug real** (`ExcessDistanceSheet.tsx`: filas claras dentro de una hoja oscura). Su
   toggle de modo oscuro en Ajustes **no hace nada**. El plan asumía ~150 fixes en
   driver; la realidad es 1.

2. **client — rutas de render WEB sin modo oscuro.** `WebHomeScreen`, `WebRidesScreen`,
   `WebActiveRideView`, `WebAddressInput` usan ~200 colores claros fijos y cero manejo de
   tema. Es **una brecha de feature** (esa variante nunca tuvo modo oscuro), no 200 bugs
   de contraste sueltos. Las rutas NATIVAS del client (las del celular) sí están bien y
   se arreglan.

3. **admin — el grande, pero acotado.** 168 fixes, TODOS en páginas operativas viejas sin
   migrar (`drivers`, `settings/*`, `reports`, `users`, `businesses`). El shell nuevo y
   las páginas redibujadas ya usan los tokens semánticos y están **limpias** (0 hallazgos).
   Fix mecánico: migrar a `text-ink*` / `bg-surface*` que ya existen.

4. **web — `refer/[code]` y `promo/[code]` rotas en AMBOS temas.** Escritas con clases
   Tailwind, pero web no usa Tailwind → renderizan casi sin estilo. Bug aparte, no de
   contraste; queda anotado.

## Decisiones del checkpoint (2026-05-19)

1. **client — rutas de render web: SE INCLUYEN.** Se le agrega modo oscuro completo a
   `WebHomeScreen`, `WebRidesScreen`, `WebActiveRideView`, `WebAddressInput` como parte de
   la Fase 4 (~200 cambios extra).
2. **driver — toggle muerto: SE QUITA.** Además del bug de `ExcessDistanceSheet.tsx`, se
   elimina el switch de modo oscuro de Ajustes del driver (no tenía efecto). Fase 5.

## Detalle por área

- `DARK_MODE_AUDIT_shared.md` — packages/ui (42) + packages/theme. 7 FIX. Claves:
  `BottomSheet` bloqueado claro, `Button` ghost sin `dark:`, `Input` no theme-aware.
- `DARK_MODE_AUDIT_admin.md` — 168 FIX. Hotspots: `drivers/[id]`, `settings/pricing`,
  `reports`, `users/[id]`, `businesses/[id]`. Offensores compartidos: `FleetReview.tsx`,
  `FilterPanel.tsx`.
- `DARK_MODE_AUDIT_web.md` — 56 FIX. Paneles de tinte pálido que no voltean + grises
  hardcodeados. Hotspots: `book/`, `profile/*`, `blog`/`privacy`/`terms`.
- `DARK_MODE_AUDIT_client.md` — 17 FIX (rutas nativas). Hotspots: `app/(tabs)/index.tsx`,
  `profile/ride-preferences.tsx`. + la brecha de render web (punto 2).
- `DARK_MODE_AUDIT_driver.md` — 1 FIX (`ExcessDistanceSheet.tsx`). El resto = modo fijo
  intencional.

## Orden de remediación (fases del plan)

1. packages compartidos (7) — máxima palanca, un fix → las 4 apps.
2. admin (168) — el grueso.
3. web (56).
4. client (17) — rutas nativas.
5. driver (1).
6. regla de lint anti-regresión.
