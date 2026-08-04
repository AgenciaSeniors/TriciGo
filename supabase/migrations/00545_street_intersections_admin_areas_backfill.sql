-- ============================================================
-- Migration 00545: street_intersections.municipality guardaba BARRIOS de OSM,
--                  mal asignados. Se recalcula desde los polígonos oficiales.
--
-- WHY:
--   El campo `municipality` se muestra al pasajero y al conductor dentro de la
--   dirección del viaje ("Calle F e/ 5ta y 3ra, Cojimar, La Habana"). Medido
--   contra los polígonos de cuba_admin_areas:
--
--     - Muestra nacional de 3.819 filas: 63 % de los municipios NO coinciden
--       con el polígono que contiene el punto.
--     - Rango id 1..20000 (19.864 filas): 15.528 municipios mal (78 %),
--       378 provincias mal (1,9 %), 21 puntos sin polígono (0,1 %).
--
--   No es una diferencia de escala barrio-vs-municipio: los valores están
--   directamente mal asignados. "Cojimar" (un pueblo costero de Habana del
--   Este) aparece como municipio de puntos cuyo polígono real es Guanabacoa
--   (50), Habana del Este (48), Plaza de la Revolución (45) y Centro Habana
--   (36). "Managua" (Arroyo Naranjo) aparece para Arroyo Naranjo (99),
--   Boyeros (89), San Miguel del Padrón (60), Cotorro (41) y Diez de Octubre
--   (34). Un mismo nombre repartido por media provincia = el importador
--   asignó el place node más cercano sin límite de distancia.
--
--   Se ve en viajes reales de esta semana: la misma calle Graciela salió como
--   "Diez de Octubre" en un viaje y como "Managua" en otro, con coordenadas
--   casi idénticas.
--
--   Contexto: packages/utils/src/geo.ts ya prefiere el municipio de Mapbox
--   sobre el de Supabase justamente por esto (comentario en
--   composeStructuredAddress), y 00369 documenta por qué usa una grilla en
--   vez de este campo. Esta migración arregla la fuente en vez de esquivarla.
--
-- WHAT THIS DOES:
--   Recalcula `municipality` y `province` desde cuba_admin_areas por
--   ST_Contains: admin_level 6 = los 168 municipios, admin_level 4 = las 16
--   provincias. Es la misma fuente que ya usa resolve_point_address() (00539)
--   como último recurso, así que el backstop de rides y esta tabla pasan a
--   decir lo mismo.
--
--   SEGURO PORQUE ES DATO DE PRESENTACIÓN: se auditaron los ~20 consumidores
--   del campo en supabase/migrations/ (00088, 00089, 00091, 00264, 00328-00333,
--   00361, 00363, 00378) y TODOS lo hacen solo SELECT hacia la dirección que
--   devuelven. Nunca es filtro, join ni clave.
--
--   Se pierde el nombre de barrio que había — es la intención: estaba mal. Si
--   algún día se quiere mostrar el barrio ("Vedado", "Nuevo Vedado"), hay que
--   importarlo bien desde OSM place=neighbourhood, no rescatar estos valores.
--
-- WHAT STAYS:
--   - Si ningún polígono contiene el punto (21 de 19.864 en la muestra, costa
--     con precisión de polígono), se CONSERVA el valor existente. Nunca se
--     escribe NULL sobre algo.
--   - Idempotente (`IS DISTINCT FROM`): re-aplicar la migración no toca nada.
--
-- POR QUÉ POR LOTES:
--   statement_timeout de la sesión = 2min. El lookup de polígonos cuesta
--   ~0,09 ms/fila (medido: 19.864 filas en 1.787 ms vía
--   idx_cuba_admin_areas_geom), o sea ~34 s de lectura para las 381.951 filas,
--   más la escritura de ~240k filas. En una sola sentencia queda demasiado
--   cerca del techo. Se procesa en lotes de 20.000 ids con el timeout
--   desactivado para la transacción de la migración.
--
--   Un UPDATE toma RowExclusiveLock: NO bloquea lecturas, así que la búsqueda
--   de direcciones sigue funcionando durante el backfill.
--
--   Si el cliente que aplica la migración corta antes de terminar, la
--   transacción entera revierte y se puede volver a aplicar sin daño.
--   Duración esperada: 1-3 minutos. Aplicar con `supabase db push` si el
--   cliente MCP corta antes.
-- ============================================================

-- El backfill completo excede el statement_timeout de 2min de la sesión.
-- SET a secas (no SET LOCAL) para que funcione tanto si el runner envuelve la
-- migración en una transacción como si no; se restaura con RESET al final.
SET statement_timeout = 0;

DO $backfill$
DECLARE
  c_chunk   CONSTANT bigint := 20000;
  v_max_id  bigint;
  v_from    bigint := 0;
  v_changed bigint;
  v_total   bigint := 0;
BEGIN
  SELECT COALESCE(MAX(id), 0) INTO v_max_id FROM public.street_intersections;

  WHILE v_from <= v_max_id LOOP
    -- El CTE resuelve los polígonos UNA vez por fila; el UPDATE solo escribe
    -- las que realmente cambian (idempotencia).
    WITH target AS (
      SELECT
        si.id,
        (SELECT a.name FROM public.cuba_admin_areas a
          WHERE a.admin_level = 6
            AND ST_Contains(a.geom, si.intersection_point::geometry)
          LIMIT 1) AS mun,
        (SELECT a.name FROM public.cuba_admin_areas a
          WHERE a.admin_level = 4
            AND ST_Contains(a.geom, si.intersection_point::geometry)
          LIMIT 1) AS prov
      FROM public.street_intersections si
      WHERE si.id >= v_from
        AND si.id <  v_from + c_chunk
    )
    UPDATE public.street_intersections s
    SET municipality = COALESCE(t.mun,  s.municipality),
        province     = COALESCE(t.prov, s.province)
    FROM target t
    WHERE s.id = t.id
      AND (s.municipality IS DISTINCT FROM COALESCE(t.mun,  s.municipality)
        OR s.province     IS DISTINCT FROM COALESCE(t.prov, s.province));

    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_total := v_total + v_changed;
    v_from  := v_from + c_chunk;
  END LOOP;

  RAISE NOTICE '00545: % filas de street_intersections actualizadas con municipio/provincia oficial', v_total;
END
$backfill$;

ANALYZE public.street_intersections;

RESET statement_timeout;

COMMENT ON COLUMN public.street_intersections.municipality IS
  '00545: municipio oficial (uno de los 168), derivado del polígono que contiene el punto '
  '(cuba_admin_areas admin_level=6). ANTES guardaba nombres de barrio de OSM mal asignados '
  '(63 % no coincidía con su polígono: "Cojimar" aparecía en Centro Habana, "Managua" en '
  'Diez de Octubre). Es dato de PRESENTACIÓN — no filtrar ni hacer join por él.';

COMMENT ON COLUMN public.street_intersections.province IS
  '00545: provincia oficial (una de las 16), derivada del polígono que contiene el punto '
  '(cuba_admin_areas admin_level=4).';
