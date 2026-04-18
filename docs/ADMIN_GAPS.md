# Admin — Backend gaps

**Fecha:** 2026-04-18 (actualizado tras verificación directa contra Supabase prod)
**Scope:** páginas del admin panel que existen como UI pero no tienen backend (tabla/RPC en Supabase). Se muestran con "No pudimos cargar los datos" o similar al entrar.

Este documento sirve como **triage**: qué features son placeholder, cuánto esfuerzo requieren para activarse, y en qué orden priorizarlas.

## 🆕 Finding crítico (2026-04-18)

Muchas páginas admin quedaron con `.from('profiles')` después del rediseño de lucia, pero **la tabla se llama `users`** en TriciGo. Además, `users.city_id` **no existe**. Esto causaba fallos en:
- `/reviews` (join)
- `/segments`
- `/campaigns`

Arreglados en commit 2026-04-18. Las tablas y columnas del schema real se verificaron con el Supabase MCP.

---

## Estado por página

| Página | Service/query principal | Tabla(s) / estado real en DB | Acción |
|---|---|---|---|
| `/content` | `cmsService` | ✅ `cms_content` **existe** (columnas: slug, title_es, title_en, body_es, body_en, updated_at, updated_by) | Verificar que service usa esas columnas |
| `/blog` | `blogService` | ✅ `blog_posts` **existe** (usa `is_published` boolean, no `status` enum) | Confirmado OK |
| `/quests` | `questService` | ❌ `quests`, `user_quests` no existen | Migration + service wire |
| `/segments` | consulta directa | ❌ `user_segments` no existe; users no tiene `city_id` | Parche aplicado (2026-04-18): segmentos new/power/inactive funcionan; `by_city` retorna vacío hasta agregar `city_id` a users |
| `/funnel` | consulta directa | ❌ `funnel_events` no existe | Migration (o integrar PostHog analytics) |
| `/campaigns` | consulta directa | ✅ `campaigns` **aplicada al DB** (2026-04-18) — usaba migration 00073 pero no se había ejecutado. Columnas: name, segment_type, segment_city_id, message_title, message_body, promo_code_id, channel, status, scheduled_at, sent_at, sent_count, created_by. | Funciona para segmentos all/new/power/inactive; by_city requiere users.city_id |
| `/businesses`, `/businesses/[id]` | `corporateService` | ✅ `corporate_accounts`, `corporate_employees`, `corporate_rides` existen | — |
| `/disputes` | `disputeService` | ✅ `ride_disputes` (usado correctamente por el service) | — |
| `/lost-found` | `lostItemService` | ✅ `lost_items` existe | — |
| `/fraud` | `fraudService` | ✅ `fraud_alerts` existe | — |
| `/validation` | — | ✅ `validation_events` existe | — |
| `/referrals` | `referralService` | ✅ `referrals` existe | — |
| `/reviews` | consulta directa | ✅ `reviews` existe; RPC `get_global_review_stats` no existe (removido); join fix `profiles→users` aplicado | Funciona |
| `/wallet` (Retiros) | `adminService.getPendingRedemptions` | ✅ `wallet_redemptions` existe; enum corregido a `'requested'` | Funciona |
| `/settings/*` (13 páginas) | varias | ✅ todas verificadas | — |
| Core (`/`, `/drivers`, `/rides`, `/users`, `/incidents`, `/audit`, `/reports`, `/live-map`, `/notifications`) | `adminService.*` | ✅ todas verificadas | — |

### Tablas que aún faltan (5 páginas realmente placeholder)

| Tabla | Página que la necesita | Prioridad |
|---|---|---|
| `quests`, `user_quests` | `/quests` | Media (gamification) |
| `user_segments` | `/segments` (para segmentos custom guardables) | Baja (los 4 segmentos default ya funcionan) |
| `funnel_events` | `/funnel` | Baja (reemplazable con PostHog) |

### Columnas pendientes

- `users.city_id` (o `users_cities` junction) → re-habilita segmento `by_city` en `/segments` y `/campaigns`.

---

## Migrations faltantes — drafts sugeridos

### 1. `cms_content` (para `/content`)

Necesaria para el CMS del admin (páginas internas, términos, políticas, tips para conductores).

```sql
-- 00129_cms_content.sql
CREATE TABLE cms_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  title_es TEXT NOT NULL,
  title_en TEXT,
  body_es TEXT NOT NULL,
  body_en TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  author_id UUID REFERENCES users(id),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE cms_content ENABLE ROW LEVEL SECURITY;
-- RLS: admin-only write, public read for published
```

### 2. `blog_posts` (para `/blog`)

Blog público del sitio web + gestor del admin.

```sql
-- 00130_blog_posts.sql
CREATE TABLE blog_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  title_es TEXT NOT NULL,
  title_en TEXT,
  excerpt_es TEXT,
  excerpt_en TEXT,
  body_es TEXT NOT NULL,
  body_en TEXT,
  cover_image_url TEXT,
  tags TEXT[],
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  author_id UUID REFERENCES users(id),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE blog_posts ENABLE ROW LEVEL SECURITY;
```

### 3. `quests` + `user_quests` (para `/quests`)

Quests / gamification para conductores (ya referenciada en TRC economy).

```sql
-- 00131_quests.sql
CREATE TABLE quests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  title_es TEXT NOT NULL,
  title_en TEXT,
  description_es TEXT,
  description_en TEXT,
  goal_type TEXT NOT NULL, -- 'rides_count', 'earnings_amount', 'hours_online', etc.
  goal_value NUMERIC NOT NULL,
  reward_trc BIGINT NOT NULL DEFAULT 0,
  reward_cup NUMERIC DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE user_quests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  quest_id UUID NOT NULL REFERENCES quests(id),
  progress NUMERIC NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  UNIQUE(user_id, quest_id)
);
```

### 4. `user_segments` (para `/segments`)

Segmentación de usuarios para marketing / targeting.

```sql
-- 00132_user_segments.sql
CREATE TABLE user_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  criteria JSONB NOT NULL, -- {min_rides: 5, last_active_days: 30, role: 'driver'}
  user_count INT DEFAULT 0, -- cached, refreshed by trigger or cron
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 5. `funnel_events` (para `/funnel`)

Event tracking para conversion funnels (alternativa: usar PostHog events y dejar funnel como un dashboard embebido).

```sql
-- 00133_funnel_events.sql
CREATE TABLE funnel_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  session_id TEXT,
  event_name TEXT NOT NULL,
  properties JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_funnel_events_user ON funnel_events(user_id, occurred_at);
CREATE INDEX idx_funnel_events_name ON funnel_events(event_name, occurred_at);
```

### 6. `get_global_review_stats` (RPC opcional)

Optimización para `/reviews` si la tabla crece. Actualmente se computa client-side.

```sql
-- Optional: 00134_review_stats_rpc.sql
CREATE OR REPLACE FUNCTION get_global_review_stats()
RETURNS TABLE(total BIGINT, average_rating NUMERIC, today_count BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT
    COUNT(*)::BIGINT AS total,
    ROUND(AVG(rating)::NUMERIC, 2) AS average_rating,
    COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW()))::BIGINT AS today_count
  FROM reviews;
$$;
GRANT EXECUTE ON FUNCTION get_global_review_stats() TO authenticated;
```

---

## Prioridad sugerida

1. **Alta** — `/blog` + `/content`: necesarios para el sitio web público y comms con drivers/riders.
2. **Media** — `/quests`: gamification impacta retention de drivers; ya hay referencias a TRC economy.
3. **Media** — `/segments`: habilita campaigns dirigidas (depende de `/campaigns` funcionar).
4. **Baja** — `/funnel`: PostHog puede cubrir esto; la tabla solo es útil si se quiere auditar eventos en DB.
5. **Baja** — `get_global_review_stats` RPC: solo necesaria cuando `reviews` supere ~10k rows.

---

## Verificaciones adicionales recomendadas

- Abrir **una por una** las páginas con "status ✅ tabla existe" y confirmar que los columns consumidos en el page coinciden con el schema real. Candidatos a drift:
  - `/businesses` — `corporate_rides` puede tener columnas nuevas
  - `/disputes` — verificar que `disputeService` no busca `dispute_cases` en lugar de `ride_disputes`
  - `/campaigns` — tabla existe pero el query puede esperar columnas nuevas

Comando útil:

```bash
# Listar columnas de una tabla específica
grep -A 30 "CREATE TABLE.*table_name" supabase/migrations/*.sql
```
