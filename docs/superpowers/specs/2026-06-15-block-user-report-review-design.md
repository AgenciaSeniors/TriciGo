# Diseño — Bloquear usuario + Reportar reseña (UGC / Apple Guideline 1.2)

**Fecha:** 2026-06-15
**Estado:** Aprobado (brainstorming) — pendiente plan de implementación

## Objetivo

Cumplir **Apple App Store Guideline 1.2** (moderación de contenido generado por usuarios). Hoy TriciGo tiene reportar por seguridad/disputa y reseñas bidireccionales, pero **no** permite que un usuario **bloquee** a otro ni **reporte una reseña** abusiva desde la app, y el content rating **subdeclara** las reseñas como UGC. Esta feature cierra ese gap.

## Decisiones (definidas en brainstorming)

1. **Bloqueo = mutuo / "no volver a emparejar".** Si A bloquea a B, el matching nunca más asigna un viaje entre ellos en **ninguna** dirección. El chat es efímero (solo durante un viaje activo), así que cortar el emparejamiento es suficiente; no se toca el chat.
2. **Reseña reportada = sigue visible hasta que el admin decida.** Reportar encola el caso en moderación; el admin oculta (`is_visible=false`) si confirma el abuso (objetivo: actuar ≤24h). Protege la integridad: nadie puede esconder una mala reseña legítima solo reportándola.

## Modelo de datos (1 migración nueva — verificar número libre, ≥00433)

### Tabla nueva `user_blocks`
| Columna | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK default gen_random_uuid() | |
| `blocker_id` | `uuid` NOT NULL → `users(id)` ON DELETE CASCADE | quien bloquea |
| `blocked_id` | `uuid` NOT NULL → `users(id)` ON DELETE CASCADE | bloqueado |
| `reason` | `text` NULL | opcional, del usuario |
| `created_at` | `timestamptz` default now() | |

- `UNIQUE(blocker_id, blocked_id)`; `CHECK (blocker_id <> blocked_id)`.
- Índices: `(blocker_id)`, `(blocked_id)` para el lookup mutuo del matching.
- **RLS:** `SELECT`/`INSERT`/`DELETE` solo donde `blocker_id = auth.uid()`. Nadie ve quién lo bloqueó (anti-señal). El matching lee con `SECURITY DEFINER` (bypassa RLS).

### Extensión de `incident_reports` (reportar reseña reusa esta tabla)
- `ALTER TYPE incident_type ADD VALUE 'review_abuse'` (en su **propia** transacción/migración — Postgres prohíbe usar un valor de enum en la misma txn que lo agrega; mismo cuidado que el tier 00370).
- `ALTER TABLE incident_reports ADD COLUMN review_id uuid NULL REFERENCES reviews(id) ON DELETE CASCADE`.
- Reportar una reseña = fila con `type='review_abuse'`, `review_id`, `against_user_id` = autor de la reseña, `reported_by = auth.uid()`, `description` = motivo. `is_visible` de la reseña **no** cambia.

## Componentes

### Backend (RPCs, `SECURITY DEFINER`)
- `block_user(p_blocked_id uuid, p_reason text default null)` → INSERT en `user_blocks` con `blocker_id = auth.uid()`, `ON CONFLICT DO NOTHING` (idempotente). Valida no-self, que el target exista.
- `unblock_user(p_blocked_id uuid)` → DELETE del par del caller.
- `get_blocked_users()` → lista de bloqueados del caller (para la pantalla de gestión), con nombre/foto resueltos.
- `report_review(p_review_id uuid, p_reason text)` → valida que el caller sea el `reviewee_id` de la reseña (solo reportás reseñas que te dejaron a vos), inserta el `incident_report` `review_abuse`. Idempotente por `(reported_by, review_id)`.

### Matching engine — exclusión del par bloqueado
- `find_best_drivers` (mig 00336): agregar **un param** `p_customer_id uuid` y, en el `WHERE` de selección de candidatos, antes del `ORDER BY`:
  ```sql
  AND NOT EXISTS (
    SELECT 1 FROM user_blocks ub
    WHERE (ub.blocker_id = p_customer_id AND ub.blocked_id = dp.user_id)
       OR (ub.blocker_id = dp.user_id AND ub.blocked_id = p_customer_id)
  )
  ```
- `dispatch_ride` (mismo archivo) ya conoce el `customer_id` del ride → pasarlo en la llamada. Cambio de aridad ⇒ `DROP FUNCTION ... ; CREATE ...` (patrón ya usado en 00336). `p_customer_id` nullable-tolerante (si null, no filtra — preserva llamadas legacy/manuales).
- **Reproducir el cuerpo vivo** de ambos RPCs vía `pg_get_functiondef` antes de reescribir (no perder features; cf. regresión histórica 00124). Patch quirúrgico preferido sobre reescritura verbatim.

### Service layer (`packages/api`)
- `userService` (o `blockService`): `blockUser`, `unblockUser`, `getBlockedUsers`.
- `reviewService.reportReview(reviewId, reason)`.
- Tipos en `packages/types`: `UserBlock`, y `IncidentType` += `'review_abuse'`.
- **Tolerancia a RPC ausente** (migración no aplicada aún por MCP guard): los hooks/llamadas degradan en silencio (no crash, no toast de error en runtime).

### UI — Cliente y Conductor
- **Bloquear:** botón con confirmación (`Alert`) en:
  - Fin de viaje: `RideCompleteView` (cliente → bloquear conductor) y `RiderRatingSheet` (conductor → bloquear pasajero).
  - Detalle de viaje del historial: `ride/[id].tsx` (cliente) y el equivalente del conductor.
- **Pantalla "Usuarios bloqueados"** en perfil/ajustes: lista (de `get_blocked_users`) + acción "Desbloquear".
- **Reportar reseña:** botón "Reportar" por reseña recibida (conductor: `profile/reviews.tsx`; cliente: su lista de reseñas) → hoja con motivo → `report_review`. Feedback con toast de éxito.
- i18n es/en/pt para labels, confirmaciones, motivos y la pantalla de bloqueados (copy real → 3 locales).

### Admin
- Extender la página de incidentes existente (`apps/admin/.../incidents`) para los `review_abuse`: mostrar la reseña enlazada (texto + autor + afectado) y acciones **"Ocultar reseña"** (`is_visible=false`) / **"Mantener"** (resuelve el incidente como dismissed). Reusa `getIncidents`/`updateIncidentStatus` + un método nuevo `adminHideReview(reviewId)`.
- **Sin** panel admin para `user_blocks` (los bloqueos son self-service del usuario, no requieren moderación).

### Declaración / metadata (parte "sin código" de la opción B)
- `apps/client/store-metadata/content-rating.md` y `apps/driver/...`: declarar reseñas como UGC ("Users Interact / users can rate each other; ratings visible on profiles; reportable in-app").
- `data-safety.md` (ambos): agregar UGC (reviews/ratings) a "App activity".
- `app-store-review-notes.md` (ambos): sección "Content moderation" — reportar (seguridad/disputa + reseñas), bloquear (no rematch), cola admin, chat efímero.

## Flujos

- **Bloquear:** usuario toca "Bloquear" → confirmación → `block_user` → toast → futuros `dispatch_ride` excluyen el par. Reversible desde "Usuarios bloqueados".
- **Reportar reseña:** afectado toca "Reportar" en una reseña → motivo → `report_review` → incidente `review_abuse` en el panel admin (reseña sigue visible) → admin oculta o mantiene.

## Manejo de errores
- RPCs validan caller (`auth.uid()`), no-self, ownership (solo reportás reseñas tuyas). Errores tipados que la UI muestra como toast.
- Bloqueo idempotente (re-bloquear no duplica). Reporte idempotente por `(reported_by, review_id)`.
- Edge case: si bloquear deja a un rider sin candidatos cercanos, el retry/expansión de radio existente de `dispatch_ride` ya lo cubre; el bloqueo solo recorta el set, no rompe el dispatch.

## Testing
- **Service layer (vitest, `packages/api`):** `blockUser`/`unblockUser`/`getBlockedUsers`/`reportReview` — propagación de error, idempotencia, validación de ownership (mock RPC).
- **DB (manual / pgTAP follow-up):** par bloqueado excluido del matching en ambas direcciones; `report_review` rechaza si el caller no es el reviewee; RLS de `user_blocks` impide ver bloqueos ajenos.
- **Anti-regresión matching:** diff del cuerpo de `find_best_drivers`/`dispatch_ride` (nuevo vs vivo) para confirmar que solo se agregó el filtro + el param.
- `pnpm check-types` verde en los 4 apps.

## Fuera de alcance (YAGNI)
- No se toca el chat (efímero) ni se agrega "reportar mensaje individual" — reportar al usuario (seguridad/disputa) ya cubre 1.2.
- No hay panel admin de bloqueos.
- No se auto-ocultan reseñas reportadas (decisión 2).

## Entrega
Cadena de PRs apilados por capa (patrón del repo), cada rama fresca desde `origin/master`:
1. **Backend** — migración(es) + RPCs + service layer + types.
2. **Cliente** — UI bloquear/reportar/pantalla bloqueados + i18n.
3. **Conductor** — ídem.
4. **Admin** — moderación de `review_abuse`.
5. **Metadata** — content-rating / data-safety / review-notes.

Migración **no** aplicada a prod por el MCP guard hasta autorización explícita; el frontend tolera la ausencia.
