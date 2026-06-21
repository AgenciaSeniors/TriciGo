# Auditoría de la ZONA DE CUENTA (más allá del onboarding) — 2026-06-21

> Continuación de la auditoría de alta de cuenta. Cubre la **gestión de cuenta**: editar perfil, configuración, borrado, contactos de emergencia/confianza, safety/SOS — en cliente/conductor/web. Verificación a nivel código; la parte UI/UX se revisó con la skill **`/ui-ux-pro-max`** (regla `consistency`). Disciplina: **groundear cada hallazgo de los agentes contra el código real** (sobre-reportan).

## Resumen ejecutivo

El núcleo de la zona de cuenta está **bien construido** (igual que onboarding). Se encontraron y arreglaron **3 hallazgos reales** en el cliente; el resto de las pantallas grounded resultaron sólidas.

| # | Hallazgo | Sev | PR |
|---|---|---|---|
| 1 | **Idioma del pasajero no persistía entre reinicios** — el cliente guardaba `preferred_language` al servidor (write-only) y nunca a AsyncStorage; al boot inicializaba i18n con el locale del dispositivo → la elección se revertía. El conductor (AsyncStorage) y la web (ambos) ya persistían bien. | **Bug real (P2)** | **#624** |
| 2 | **Avatar inconsistente onboarding↔edición** — `complete-profile` usaba `ImageManipulator` 300×300 sin recorte; `edit` usa el `AvatarCropModal` compartido (circular, 384×384). Unificado en el modal compartido. | UI/UX | **#625** |
| 3 | **i18n del cliente edit/settings** — copy con `defaultValue` sin entrada en locale → en/pt veían español, incl. el **flujo de borrado de cuenta** (acción sensible). Agregadas ~15 keys a es/en/pt. | i18n | **#626** |

Todos requieren **rebuild de APK** para llegar a los usuarios.

## Pantallas grounded como SÓLIDAS (sin bug real)
- **Cliente edit** (`profile/edit.tsx`): usa `AvatarCropModal`, validación nombre/email, teléfono read-only, `getErrorMessage`. ✓
- **Cliente settings** (`profile/settings.tsx`): además del bug de idioma (#624), el resto OK (toggles de notif, método de pago, danger-zone con confirmación). ✓
- **Cliente safety/SOS** (`profile/safety.tsx`): `Promise.allSettled` con error handling por-promesa, skeleton, error-state con retry, `getErrorMessage`, llamada de emergencia `tel:106` (policía Cuba), share-trip con token. Único menor: fecha de incidentes sin `timeZone America/Havana`. ✓
- **`useLogout`** (cliente + conductor): resetean los stores de sesión correctamente; el conductor **sí** resetea el onboarding store (BUG-299). El agente lo marcó como falso positivo. ✓
- **Borrado de cuenta web**: NO es un bug — el settings web tiene "Danger zone" con link a `/account/delete` (página informativa + email), el patrón de URL-externa de Google Play. Intencional.

## Diferido — bajo valor (documentado, no bloqueante)
- **i18n en/pt de las pantallas de cuenta de conductor/web**: mismo patrón de `defaultValue` faltante, pero menor prioridad — los conductores hablan español, y el copy de settings web ya está mayormente traducido.
- **`block.blocked_users`** (cliente settings): requeriría crear un namespace `block` por un solo label; cae a su `defaultValue` español.
- **Fechas sin `timeZone America/Havana`** en displays de fecha (safety incidents, etc.): clase recurrente, cosmética (el device TZ de un cubano ya es Havana; difiere solo para un turista).
- **Pantallas adyacentes no grounded a fondo** (emergency-contact, trusted-contacts, devices, saved-locations, y equivalentes driver/web): dado el patrón consistente (bien construidas), probablemente sólidas con a lo sumo i18n/date-TZ menores.

## Verificación
- `pnpm check-types` verde (4 apps) en cada PR; los 3 JSON de locale parsean; keys de copy real presentes en es/en/pt.
- **Visual:** los 3 fixes son mobile (cliente) → se ven en device tras el **rebuild de APK**. El avatar (#625) usa el mismo `AvatarCropModal` que el editar-perfil (ya en prod) → idéntico visualmente. La pasada de Metro+screenshots se hace junto con el rebuild (modo demo `DEMO_PHONE→000000`).

## PRs
- **#624** — `fix(client)`: persistir idioma del pasajero entre reinicios.
- **#625** — `fix(client)`: avatar de onboarding con el `AvatarCropModal` compartido.
- **#626** — `i18n(client)`: copy de editar/configuración (incl. borrado de cuenta) a en/pt.

## Procedencia
Auditoría 2026-06-21. 2 agentes Explore (driver personal-info/guards + adyacentes/web) + grounding manual contra el código real. UI/UX revisada con `/ui-ux-pro-max`. Plan: `~/.claude/plans/vamos-a-hacer-un-gentle-sketch.md`.
