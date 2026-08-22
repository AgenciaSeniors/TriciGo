-- ============================================================
-- Migration 00573: el delta diario de OSM vuelve a poder escribir —
--                  dejar de asignar la columna GENERADA name_normalized
--
-- WHY (reproducido contra prod, 2026-08-22):
--   El workflow `sync-osm-delta.yml` falla TODOS los días desde ≥19/08
--   (último sync exitoso de POIs: 2026-08-10). El script muere en
--   `raise_for_status()` con:
--
--     requests.exceptions.HTTPError: 400 Client Error: Bad Request
--       for url: .../rest/v1/rpc/apply_osm_delta_batch
--
--   El 400 es PostgREST traduciendo este error de Postgres:
--
--     428C9: cannot insert a non-DEFAULT value into column "name_normalized"
--     DETAIL: Column "name_normalized" is a generated column.
--     CONTEXT: PL/pgSQL function apply_osm_delta_batch(jsonb) line 65
--
--   `cuba_pois.name_normalized` es GENERATED ALWAYS (Postgres la deriva de
--   `name`), pero `apply_osm_delta_batch` sigue asignándola en DOS sitios:
--   la lista de columnas + VALUES de su INSERT, y el SET de su UPDATE.
--   Como el INSERT corre ANTES del UPDATE en la rama CREATE/MODIFY, la
--   función revienta en el primer evento: **todo CREATE y MODIFY falla**;
--   solo la rama DELETE (que no toca la columna) sobrevive.
--
--   No es regresión de 00571: los runs fallidos del 19, 20 y 21/08 son de
--   las 06:37 UTC y el parche de 00571 se aplicó el 21/08 a las 19:14 UTC.
--   `import_search_poi` YA lleva el arreglo equivalente (con el comentario
--   "name_normalized is GENERATED ALWAYS — Postgres populates it from
--   name"); a este RPC se le pasó.
--
-- WHAT THIS DOES:
--   Patch in-place (patrón CLAUDE.md) sobre el cuerpo VIVO: 3 reemplazos
--   quirúrgicos que quitan las dos asignaciones a `name_normalized`.
--   Postgres la sigue poblando sola desde `name`, así que el
--   comportamiento observable no cambia — solo deja de ser ilegal.
--
--   Se parte del cuerpo VIVO y NO de la migración de git a propósito:
--   00571 quitó el `is_active = TRUE,` de la rama UPDATE (para que el sync
--   no resucite filas curadas — 814 desactivadas). Transcribir desde
--   00305 habría revertido ese candado en silencio y devuelto la basura
--   fuera de Cuba. El patch no puede perder features porque parte de lo
--   que corre hoy. Guards: cada target debe aparecer exactamente 1 vez, y
--   se re-verifica que el candado de 00571 siga ausente al terminar.
--
-- LO QUE NO CAMBIA: firma, rama DELETE (su `AND is_active = TRUE` del
--   WHERE es un predicado y queda intacto), gate `is_admin = FALSE` en
--   todas las ramas, bbox de Cuba, e `is_active` en el INSERT de filas
--   nuevas (posicional `FALSE, TRUE` — las nuevas siguen naciendo activas).
--
-- MEDIDO (prod, patch + ejecución real dentro de BEGIN…ROLLBACK, 2026-08-22
-- — "CREATE en verde NO prueba que una función corra", lección de CLAUDE.md):
--
--   | prueba                                             | resultado |
--   |----------------------------------------------------|-----------|
--   | ANTES del patch: MODIFY way/289803271              | aborta con 428C9 (el 400 del workflow) |
--   | A. MODIFY sobre fila DESACTIVADA por 00571 (22736) | corre; refresca el nombre; `is_active` sigue FALSE ⇒ candado de 00571 intacto |
--   | B. CREATE de fila nueva (node/999888777666)        | INSERT ok, nace ACTIVA |
--   | C. MODIFY sobre fila ACTIVA normal (node/343276699)| renombra y sigue ACTIVA ⇒ el candado no daña el caso normal |
--   | D. DELETE (node/4626473589)                        | la desactiva |
--   | `name_normalized` en las 4                         | poblada por Postgres desde `name`, con unaccent correcto ("policlinico aleyda fernandez") |
-- ============================================================

DO $patch$
DECLARE
  v_src        text;
  v_n          int;
  c_upd_set    CONSTANT text := 'name_normalized = lower(unaccent(trim(v_name))),';
  c_ins_cols   CONSTANT text := 'osm_id, osm_type, name, name_normalized,';
  c_ins_value  CONSTANT text := 'lower(unaccent(trim(v_name))),';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'apply_osm_delta_batch';

  IF v_src IS NULL THEN
    RAISE NOTICE '00573: apply_osm_delta_batch ausente; nada que hacer';
    RETURN;
  END IF;

  -- Idempotencia: si ya no menciona la columna generada, este patch ya corrió.
  IF position('name_normalized' IN v_src) = 0 THEN
    RAISE NOTICE '00573: apply_osm_delta_batch ya no asigna name_normalized; skip';
    RETURN;
  END IF;

  -- (1) SET de la rama UPDATE (MODIFY).
  v_n := (length(v_src) - length(replace(v_src, c_upd_set, ''))) / length(c_upd_set);
  IF v_n <> 1 THEN
    RAISE EXCEPTION '00573: el SET de name_normalized aparece % veces (esperaba 1) — el cuerpo derivó, curar a mano', v_n;
  END IF;
  v_src := replace(v_src, c_upd_set, '');

  -- (2) Lista de columnas del INSERT.
  v_n := (length(v_src) - length(replace(v_src, c_ins_cols, ''))) / length(c_ins_cols);
  IF v_n <> 1 THEN
    RAISE EXCEPTION '00573: la lista de columnas del INSERT aparece % veces (esperaba 1) — el cuerpo derivó, curar a mano', v_n;
  END IF;
  v_src := replace(v_src, c_ins_cols, 'osm_id, osm_type, name,');

  -- (3) El valor correspondiente en el VALUES. Tras (1) debe quedar 1 solo.
  v_n := (length(v_src) - length(replace(v_src, c_ins_value, ''))) / length(c_ins_value);
  IF v_n <> 1 THEN
    RAISE EXCEPTION '00573: el valor de name_normalized en VALUES aparece % veces (esperaba 1) — el cuerpo derivó, curar a mano', v_n;
  END IF;
  v_src := replace(v_src, c_ins_value, '');

  -- Cinturón: el candado de 00571 no puede volver por la ventana.
  IF position('is_active = TRUE,' IN v_src) > 0 THEN
    RAISE EXCEPTION '00573: el cuerpo resultante re-introduce la asignación is_active = TRUE — abortado para no revertir 00571';
  END IF;
  IF position('name_normalized' IN v_src) > 0 THEN
    RAISE EXCEPTION '00573: quedó una referencia a name_normalized sin limpiar — abortado';
  END IF;

  EXECUTE v_src;
  RAISE NOTICE '00573: apply_osm_delta_batch parcheado — el delta diario vuelve a poder insertar/actualizar';
END $patch$;

COMMENT ON FUNCTION public.apply_osm_delta_batch(jsonb) IS
  '00305 + 00571 + 00573: delta diario OSM. 00571: la rama MODIFY preserva '
  'is_active (la curacion manda; DELETE sigue desactivando y CREATE sigue '
  'insertando activo). 00573: ya no asigna name_normalized, que es GENERATED '
  'ALWAYS — asignarla daba 428C9 y PostgREST lo devolvia como 400, con el '
  'sync diario caido. Los admin siguen intocables en todas las ramas.';
