# Auditoría de alta de cuenta — Cliente + Conductor (2026-06-21)

> Funcionalidad + UX + UI + i18n del **alta de cuenta** (pasajero y conductor). Las auditorías previas (dinero, seguridad, backend) nunca cubrieron este flujo. Verificación **a nivel código** (decisión del usuario; sin correr las apps). Método: 3 agentes Explore mapearon los flujos → **grounding de cada hallazgo contra el código real antes de tocar nada** (los agentes sobre-reportan).

## Resumen ejecutivo

| Flujo | Veredicto | Acción |
|---|---|---|
| **Cliente (pasajero)** | **Ya estaba sano** — endurecido en rondas previas (R5/BUG-201/BUG-299b). | i18n para turistas (en/pt) + pulido menor → **#619** |
| **Conductor** | **1 P0 (bloqueante de lanzamiento)** + resto sano. | Fix del P0 → **#620** |

**Lección transversal (reforzada):** los agentes Explore reportaron **decenas** de "concerns" en ambos flujos; la **gran mayoría eran falsos positivos** por lectura superficial (botones atrás, manejo de rate-limit, timers, validación inline, CTAs en pantallas de estado — todo ya presente). El valor estuvo en **groundear cada uno**: así se descartó el ruido y se encontró el único bug real que importaba (el P0 del conductor).

---

## 🔴 P0 — Conductor no podía registrarse (FIXED #620)

`apps/driver/app/onboarding/review.tsx` comparaba el conteo de documentos contra un **`5` hardcodeado**, pero **CC-04** (2026-05-23) removió el selfie y bajó el set a **4 documentos** (`national_id`, `drivers_license`, `vehicle_registration`, `vehicle_photo` — ver `onboarding.store` `INITIAL_DOCUMENTS`).

```tsx
disabled={submitting || uploadedCount < 5 || !driverProfileId || !termsAccepted}
```

Con 4 docs, `uploadedCount` llega máximo a 4 → `uploadedCount < 5` **siempre true** → **el botón Enviar nunca se habilita**. Un conductor sube los 4 documentos, llega a Revisión, ve **"4 de 5 / Falta 1 documento"** y **no puede enviar nunca** → **ningún conductor nuevo podía completar el registro**.

**Por qué no se detectó:** los conductores demo se sembraron por **SQL** (no por el flujo de onboarding) y sobrevivieron al wipe pre-lanzamiento, así que el camino real **no se ejercitó** desde CC-04.

**Fix:** usar `totalDocs = documents.length` (el largo real del store) en vez del `5`. `documents.tsx` ya estaba correcto (`documents.every` / `documents.length`). **Requiere rebuild de APK** para llegar a los conductores.

---

## Cliente — verdicto detallado (FIXED #619)

**Funcionalidad y UX: SANAS.** Falsos positivos descartados con grounding:

| Reportado por el agente | Realidad (verificada) |
|---|---|
| "sin botón atrás / dead-end en OTP" | `verify-otp` tiene back; `verify-phone` tiene "Cambiar número" |
| "botón Verificar habilitado durante el retry" | `loading` sigue `true` hasta el `finally` → deshabilitado |
| "timer de reenvío va negativo en background" | clampea a 0 |
| "sin validación inline" | hint de nombre + toast de teléfono ya presentes |
| "errores genéricos en social login" | toasts específicos ya presentes |

**Gap real (sí importa para turistas):** las pantallas agregaban ~28 strings con `t(key, { defaultValue })` **sin** entrada en el JSON → en inglés/portugués el turista veía esos textos **en español** mezclados con el resto traducido. **Fix:** agregadas a es/en/pt `common.json` (`auth.*` + `profile.*` + `switch_account.*`).

**Menor (también arreglado en #619):** `verify-phone` mapea ahora `PHONE_TAKEN`/`INVALID_CODE` a copy traducido (antes genérico); fondo de ícono con variante dark consistente.

**Intencional (no tocado):** gradientes naranja de marca hardcodeados (documentados); teléfono **solo-Cuba en prod** (rechaza +1/+33) — **decisión de producto a revisar** dado que los turistas son target (¿permitir números extranjeros para pasajeros?).

---

## Conductor — verdicto detallado

Aparte del P0, el resto del wizard está **bien construido** (grounding confirmó):
- **`review.tsx`**: edit-links para volver a cada paso, `StatusStepper`, mensajes explícitos de "submit deshabilitado" (docs faltantes / T&C sin aceptar), toast de error.
- **`documents.tsx`**: conteo correcto, compresión para 3G, `getErrorMessage` (sanitiza), `createProfile` con fallback a `getProfile` (race manejado), timeout de 30s.
- **`pending.tsx`**: pantallas de rejected/suspended/under-review con CTAs reales (reenviar docs, contactar soporte WhatsApp, cambiar cuenta) — **no son dead-ends**; el polling que falla reintenta benignamente.
- **`vehicle-info.tsx`**: validación completa (tipo/marca/modelo/año/color/placa vía `isValidPlateNumber`/capacidad + cargo). Las dimensiones de carga son opcionales **por diseño** (peso + categoría es el mínimo).
- **Navegación atrás**: el wizard usa `router.push` (stack) → el back nativo funciona; los edit-links de Revisión dan acceso explícito.

### Diferido — bajo valor (no bloqueante)
- **i18n en/pt del conductor:** las keys nuevas con `defaultValue` faltan en en/pt (igual que el cliente), pero el **driver app lo usan conductores cubanos (español)** — los turistas en/pt son **pasajeros**, no conductores. El `defaultValue` español sirve para la audiencia real. Las keys **sin** `defaultValue` (`pending_review`, etc.) **sí existen** → no hay keys crudas en pantalla. Completar en/pt queda como mejora cosmética de baja prioridad.
- Pulidos UX menores señalados por el agente (guía de calidad de foto, copy de tranquilidad sobre antecedentes, indicador de progreso que incluya "pendiente") — nice-to-have, no bloqueantes.

---

## Verificación
- `pnpm check-types` verde (4 apps) en cada PR; los 3 JSON de locale parsean; keys de copy real presentes en es/en/pt (cliente).
- **Límite honesto:** verificación **solo-código** (sin correr las apps) → se validó lo estructural (gates, navegación, manejo de error, tokens, keys i18n), **no** pixel-por-pixel. Tras el rebuild de APK, conviene una **pasada visual** del flujo de conductor (modo demo `DEMO_PHONE→000000`) para confirmar que el Submit se habilita con los 4 docs.

## PRs
- **#619** — `fix(client-onboarding)`: i18n en/pt + errores específicos en verify-phone + dark-mode icon bg.
- **#620** — `fix(driver-onboarding)`: **P0** — Submit deshabilitado que impedía todo registro de conductor.

## Procedencia
Auditoría 2026-06-21. 3 agentes Explore (cliente / conductor / infra compartida) + grounding manual contra el código real. Plan: `~/.claude/plans/vamos-a-hacer-un-gentle-sketch.md`.
