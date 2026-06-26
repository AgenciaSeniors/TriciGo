-- ============================================================================
-- 00462_pricing_below_competitor.sql
--
-- Recalibra los precios al pasajero para quedar ~10% POR DEBAJO del competidor
-- de referencia (lanave-style) en La Habana, las 24 h, y elimina el recargo
-- nocturno fijo.
--
-- CONTEXTO / CAUSA RAÍZ
-- ---------------------
-- El modelo anterior (creado 2026-03-18, copiado de un competidor de TAXIS con
-- el factor ×0.9412) tenía:
--   - banderazo (base) bajo + per_km ALTO  → en viajes largos el precio se
--     disparaba por encima del competidor (auto 8 km: 13.040 vs 11.016 CUP).
--   - bandas horarias agresivas: ×1.5 de 18:00-00:00 y ×2 de 00:00-06:00
--     → de noche TODO se disparaba (triciclo 8 km: 7.368; auto 8 km: 19.560).
--
-- El competidor usa el modelo inverso: banderazo ALTO + per_km BAJO y SIN
-- recargo nocturno fijo. Reconstruí su curva con dos puntos observados de día
-- (viaje corto ~2 km + viaje largo ~8 km):
--     precio(km) = base + per_km × km        (piso = min_fare)
--   competidor   triciclo 4088/201/4490 · moto 2739/117/2972
--                auto 8027/374/8774 · confort 9550/348/10246
--
-- OBJETIVO (aprobado por el usuario 2026-06-26): "más barato que el competidor
-- en todo" → competidor × 0.90 en los cuatro vehículos.
--
-- DECISIONES:
--   1. precio = competidor × 0.90 (10% más barato), todos los vehículos.
--   2. per_minute = 0  → el precio depende solo de la distancia (predecible,
--      el tráfico no infla el viaje). Las esperas en el pickup se siguen
--      cobrando aparte vía wait_charge / per_wait_minute_rate_cup.
--   3. SIN recargo nocturno: las 4 franjas horarias quedan con el MISMO valor.
--      Esto elimina el ×1.5/×2.
--   4. Mensajería y triciclo_cargo NO se tocan (sin datos del competidor).
--   5. La comisión (platform_config.commission_rate = 0.15) NO se toca: la
--      gestiona el negocio por separado.
--
-- EFECTO vs hoy (viaje 8 km, La Habana):
--   triciclo  día 4.912 → 5.127  ·  noche 7.368 → 5.127
--   moto      día 3.761 → 3.305  ·  noche 5.642 → 3.305
--   auto      día 13.040 → 9.920 ·  noche 19.560 → 9.920
--   confort   día 13.491 → 11.099·  noche 20.237 → 11.099
--   (todo queda 10% por debajo del competidor; el triciclo largo de día sube
--    un marginal +4% porque hoy estaba −14%, pero sigue bajo el competidor.)
--
-- VERIFICACIÓN (precio = base + per_km × km, piso min):
--   2 km / 8 km  →  ≈ competidor × 0.90 (±0,5%) en los cuatro vehículos.
--
-- Las columnas *_usd son sólo para visualización en el panel admin (el fare se
-- calcula con *_cup). Se recomputan = CUP / 670 (mismo rate con que estaban).
-- ============================================================================

-- ── pricing_rules: todas las franjas horarias quedan iguales (sin recargo) ──

UPDATE pricing_rules SET
  base_fare_cup       = 3679,
  per_km_rate_cup     = 181,
  per_minute_rate_cup = 0,
  min_fare_cup        = 4041,
  base_fare_usd       = 5.4910,
  per_km_rate_usd     = 0.2701,
  per_minute_rate_usd = 0,
  min_fare_usd        = 6.0313
WHERE service_type = 'triciclo_basico';

UPDATE pricing_rules SET
  base_fare_cup       = 2465,
  per_km_rate_cup     = 105,
  per_minute_rate_cup = 0,
  min_fare_cup        = 2675,
  base_fare_usd       = 3.6791,
  per_km_rate_usd     = 0.1567,
  per_minute_rate_usd = 0,
  min_fare_usd        = 3.9925
WHERE service_type = 'moto_standard';

UPDATE pricing_rules SET
  base_fare_cup       = 7224,
  per_km_rate_cup     = 337,
  per_minute_rate_cup = 0,
  min_fare_cup        = 7897,
  base_fare_usd       = 10.7821,
  per_km_rate_usd     = 0.5030,
  per_minute_rate_usd = 0,
  min_fare_usd        = 11.7866
WHERE service_type = 'auto_standard';

UPDATE pricing_rules SET
  base_fare_cup       = 8595,
  per_km_rate_cup     = 313,
  per_minute_rate_cup = 0,
  min_fare_cup        = 9221,
  base_fare_usd       = 12.8284,
  per_km_rate_usd     = 0.4672,
  per_minute_rate_usd = 0,
  min_fare_usd        = 13.7627
WHERE service_type = 'auto_confort';

-- ── service_type_configs: fallback usado cuando no matchea ninguna rule ──

UPDATE service_type_configs SET
  base_fare_cup       = 3679,
  per_km_rate_cup     = 181,
  per_minute_rate_cup = 0,
  min_fare_cup        = 4041,
  base_fare_usd       = 5.4910,
  per_km_rate_usd     = 0.2701,
  per_minute_rate_usd = 0,
  min_fare_usd        = 6.0313
WHERE slug = 'triciclo_basico';

UPDATE service_type_configs SET
  base_fare_cup       = 2465,
  per_km_rate_cup     = 105,
  per_minute_rate_cup = 0,
  min_fare_cup        = 2675,
  base_fare_usd       = 3.6791,
  per_km_rate_usd     = 0.1567,
  per_minute_rate_usd = 0,
  min_fare_usd        = 3.9925
WHERE slug = 'moto_standard';

UPDATE service_type_configs SET
  base_fare_cup       = 7224,
  per_km_rate_cup     = 337,
  per_minute_rate_cup = 0,
  min_fare_cup        = 7897,
  base_fare_usd       = 10.7821,
  per_km_rate_usd     = 0.5030,
  per_minute_rate_usd = 0,
  min_fare_usd        = 11.7866
WHERE slug = 'auto_standard';

UPDATE service_type_configs SET
  base_fare_cup       = 8595,
  per_km_rate_cup     = 313,
  per_minute_rate_cup = 0,
  min_fare_cup        = 9221,
  base_fare_usd       = 12.8284,
  per_km_rate_usd     = 0.4672,
  per_minute_rate_usd = 0,
  min_fare_usd        = 13.7627
WHERE slug = 'auto_confort';
