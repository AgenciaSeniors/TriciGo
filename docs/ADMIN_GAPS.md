# Admin — Backend gaps

**Fecha:** 2026-04-18
**Scope:** páginas del admin panel que existen como UI pero no tienen backend (tabla/RPC en Supabase). Se muestran con "No pudimos cargar los datos" o similar al entrar.

Este documento sirve como **triage**: qué features son placeholder, cuánto esfuerzo requieren para activarse, y en qué orden priorizarlas.

---

## Estado por página

| Página | Service/query principal | Tabla(s) esperada(s) | Estado | Acción necesaria |
|---|---|---|---|---|
| `/content` | `cmsService.list/get/create/update/delete` | `cms_content` | ❌ tabla no existe | Migration + service wire |
| `/blog` | `blogService.list/create/update/delete/publish` | `blog_posts` | ❌ tabla no existe | Migration + service wire |
| `/quests` | `questService.list/create/update/delete` | `quests`, `user_quests` | ❌ tablas no existen | Migration + service wire |
| `/segments` | `supabase.from('user_segments')` | `user_segments` | ❌ tabla no existe | Migration + service wire |
| `/funnel` | `supabase.from('funnel_events')` | `funnel_events` | ❌ tabla no existe | Migration (o reusar analytics provider) |
| `/campaigns` | `supabase.from('campaigns')` | `campaigns` | ⚠️ tabla existe, verificar columnas | Revisar schema vs query |
| `/businesses`, `/businesses/[id]` | `corporateService.*` | `corporate_accounts`, `corporate_employees`, `corporate_rides` | ✅ tablas existen | Verificar que el page consume las columnas correctas |
| `/disputes` | `disputeService.*` | `ride_disputes` (00038) | ✅ existe | Verificar nombre de tabla en el service (puede estar buscando `dispute_cases`) |
| `/lost-found` | `lostItemService.*` | `lost_items` | ✅ existe | — |
| `/fraud` | `fraudService.*` | `fraud_alerts` | ✅ existe | — |
| `/validation` | — | `validation_events` | ✅ existe | — |
| `/referrals` | `referralService.*` | `referrals` | ✅ existe | — |
| `/reviews` | `supabase.rpc('get_global_review_stats')` | **RPC faltante**, tabla `reviews` existe | ✅ arreglado (commit 2026-04-18) — ahora agrega client-side | — |
| `/wallet` (Retiros) | `adminService.getPendingRedemptions` con `status='pending'` | enum es `'requested'` | ✅ arreglado (commit 2026-04-18) | — |
| `/settings/*` (13 páginas) | varias | cities, zones, pricing_rules, platform_config, promotions, surge_zones, feature_flags, etc. | ✅ todas verificadas | — |
| Core (`/`, `/drivers`, `/rides`, `/users`, `/incidents`, `/audit`, `/reports`, `/live-map`, `/notifications`) | `adminService.*` | múltiples | ✅ todas verificadas | — |

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
