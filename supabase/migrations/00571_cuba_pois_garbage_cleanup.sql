-- ============================================================
-- Migration 00571: limpieza curada de basura en cuba_pois + el sync
--                  deja de resucitar filas desactivadas
--
-- WHY (medido contra prod, 2026-08-21 — auditoría completa en
-- docs/AUDIT_CUBA_POIS_2026-08-21.md):
--   Los imports bulk (overture/foursquare) dejaron clases de basura activa
--   que des-etiquetan el reverse geocode y teletransportan búsquedas.
--   Sondas RED con la función VIVA (lookup_nearest_poi_ranked, radio 30):
--
--   | pin | etiqueta viva (mal) |
--   |---|---|
--   | Nuevo Vedado (23.104020,-82.374920) | "Gran Hotel Manzana Kempinski" d=0 (el real está a 3,9 km) |
--   | Universidad de La Habana (23.135582,-82.380856) | "Gran Hotel Manzana Kempinski La Habana" d=0 |
--   | campo de Camagüey (21.333050,-77.429620) | "Dunkin donuts" d=0 (fila Foursquare con province='Pa' = Pennsylvania) |
--   | Santiago centro (20.023733,-75.814096) | "McDonald's" d=0.1 |
--   | Boyeros (23.076521,-82.366201) | "Starbucks" d=0 |
--   | punto del Hotel Nacional +12m | "National Hotel Havana Cuba" d=0 |
--   | Calle L (23.139426,-82.382573) | "Hotel Tryp Habana Libre" (public_transport, conf 1) d=0 |
--
--   (Sondas medidas con la 00550 entonces viva. 00570 se aplicó a prod ese
--   mismo día; re-medido contra la v3 REAL: el punto del Hotel Nacional ya
--   dice "Hotel Nacional de Cuba" — la huella r=40 curó la ETIQUETA y el
--   dupe queda dañando la BÚSQUEDA; en la pila de Camagüey el ganador pasó
--   a "Pnc bank" (desempate p.id de v3 — eran empates plan-dependientes);
--   el resto de las sondas RED persiste idéntico.)
--
--   Y 757 filas ACTIVAS fuera de los polígonos provinciales de Cuba
--   (3,7 % de las activas): ~315 en el SE de Bahamas (Long Island / Exuma /
--   Crooked Island), ~208 en las Islas Caimán, decenas de check-ins de
--   CRUCEROS en altamar ("Allure of the Seas", "Somewhere in the Caribbean
--   Sea"…) y 4 filas is_admin conf 1 fuera del país ("Little Cayman Beach
--   Resort", "Sir Charles Kirkconnell International Airport" y 2
--   restaurantes de Exuma con province='EX').
--
-- POR QUÉ EL PASO 0 ES OBLIGATORIO (verificado en los cuerpos vivos):
--   bulk_upsert_pois (sync semanal, lunes 06:00 UTC) fuerza
--   `is_active = TRUE` en su rama UPDATE y en su ON CONFLICT para toda fila
--   no-admin re-encontrada upstream; apply_osm_delta_batch (delta diario)
--   hace lo mismo en su rama MODIFY. El bbox del sync (19.5 sur) INCLUYE
--   Cayman Brac y Little Cayman, y las marcas US siguen en Foursquare OS
--   Places ⇒ sin el parche, TODA la limpieza no-admin se revierte en el
--   próximo sync semanal. El parche es in-place sobre el cuerpo VIVO
--   (patrón CLAUDE.md "patch in-place") — no puede perder features.
--   Semántica nueva: el sync refresca datos pero is_active queda bajo
--   control de curación; el INSERT de filas nuevas sigue naciendo activo.
--
-- WHAT THIS DOES:
--   0. Parcha bulk_upsert_pois (2 sitios) y apply_osm_delta_batch (1 sitio)
--      para que sus ramas UPDATE preserven is_active.
--   1. Clase A — fuera de Cuba, por GEOMETRÍA: is_active=false para toda
--      fila activa NO cubierta por ningún polígono provincial
--      (cuba_admin_areas admin_level=4) Y a más de 2 km de todos ellos.
--      La tolerancia de 2 km conserva las 13 filas costeras legítimas
--      (muelles/playas con el punto en el agua). Esperadas: ~744.
--      Muestreo verificado fila a fila / cluster a cluster en la auditoría
--      (0 lugares cubanos entre ellas; 0 filas en la base naval GTMO, que
--      SÍ está cubierta por los polígonos). Incluye las 4 admin foráneas.
--      Guard: aborta si el conteo supera 1000 (freno de radio de daño ante
--      drift de polígonos).
--   2. Clases B/C/D — curadas fila a fila (id+name), solo no-admin:
--      B: duplicados/mal ubicados de lugares famosos (criterio: el referente
--         real está a ≥1 km; donde existe, se verificó la fila activa BIEN
--         ubicada que conserva el lugar en la búsqueda). Incluye 9 dupes
--         confirmados por el detector de similitud contra anclas admin.
--      C: marcas US inexistentes en Cuba (Dunkin/PNC/Starbucks/…) — se
--         CONSERVAN a propósito los locales reales de la base naval de
--         Guantánamo (McDonald's/Pizza Hut/Taco Bell-KFC/KFC Leeward) y los
--         negocios cubanos con nombres parecidos (Wendy studios, Wendy's
--         Salon, Pinturas Cayman).
--      D: check-ins de VUELOS de Foursquare en el aeropuerto HAV
--         ("Copa Flight CM437 HAV-PTY", …) — no son lugares.
--   3. Clase E — curación de datos: el punto del admin "Parque Central"
--      (11241, conf 1) estaba a 7,5 m del hotel Iberostar y ~120 m del
--      parque; se mueve al monumento a José Martí = centro real del parque,
--      anclado por 3 fuentes independientes apiladas a <5 m entre sí
--      (merged 59039 / osm 141895 / foursquare 209955 ≈ 23.13750,-82.35873).
--      + tricigo_category 'museum' → 'park' (es un parque). La fila es
--      is_admin: ambos syncs la saltan ⇒ curación durable.
--
-- REGLA RESPETADA: cero supresión por categoría (lección-721) — todo es
--   fila-a-fila con guarda id+name, o geometría verificada por muestreo.
--
-- MEDIDO (simulación GREEN read-only contra la v3 REAL ya aplicada: espejo
-- de la semántica 00570 — huella efectiva + desempates raw/p.id — con la
-- lista curada excluida y 11241 movido; suite de 14 pines, 2026-08-21):
--   * 5 pines RED arreglados: Nuevo Vedado→NULL (gana la dirección de
--     calle), Universidad→"Monte Freddo" 18m, Camagüey (Pnc bank)→NULL,
--     Santiago→NULL, Boyeros→NULL.
--   * Calle L: "Hotel Tryp Habana Libre" (bus) → "Fonda La Paila
--     Restaurant Paladar" 9.9m (restaurante real vecino, banda 0).
--   * 7 controles IDÉNTICOS vivo=candidato: puerta del Iberostar PC,
--     Parque Céspedes Trinidad (control 00550), punto Iberostar Grand
--     Trinidad, aeropuerto HAV ("José Martí International Airport"),
--     McDonald's real de la base GTMO (se conserva), pin medio del parque,
--     y punto del Hotel Nacional ("Hotel Nacional de Cuba" — 00570 ya curó
--     la etiqueta; 00571 saca el dupe de la búsqueda).
--   * pin en el monumento: vivo "Parque Central" 3.0m (era la parada de
--     bus homónima, category public_transport) → candidato "Parque Central"
--     0.3m (el admin movido, park).
--
-- WHAT STAYS: los ~1.400 pares apilados cross-source de lugares REALES
--   (dedup cosmético, no basura); las pilas de Overture a nivel de cuadra
--   (negocios reales con punto grueso); todo lo <1 km de su referente real
--   (Cine Payret, Templo de Yemayá, hostales de Trinidad — lección-721);
--   la fila admin duplicada "Hotel Parque Central" (109971, nombre viejo
--   del Iberostar, ubicación correcta); las 13 filas costeras a ≤2 km.
-- ============================================================

SET statement_timeout = '600s';

-- ────────────────────────────────────────────────────────────
-- Paso 0a: bulk_upsert_pois — la rama UPDATE y el ON CONFLICT dejan de
-- forzar is_active=TRUE (parche in-place sobre el cuerpo vivo)
-- ────────────────────────────────────────────────────────────
DO $patch$
DECLARE
  v_src text;
  v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'bulk_upsert_pois';

  IF v_src IS NULL THEN
    RAISE NOTICE '00571: bulk_upsert_pois ausente; skip';
    RETURN;
  END IF;

  IF position('is_active = TRUE, synced_at = v_now' IN v_src) = 0
     AND position('is_active = TRUE, synced_at = EXCLUDED.synced_at' IN v_src) = 0 THEN
    RAISE NOTICE '00571: bulk_upsert_pois ya no fuerza is_active; skip';
    RETURN;
  END IF;

  v_n := (length(v_src) - length(replace(v_src, 'is_active = TRUE, synced_at = v_now', '')))
         / length('is_active = TRUE, synced_at = v_now');
  IF v_n <> 1 THEN
    RAISE EXCEPTION '00571: target de la rama UPDATE aparece % veces en bulk_upsert_pois (esperaba 1) — el cuerpo derivó, revisar a mano', v_n;
  END IF;
  v_n := (length(v_src) - length(replace(v_src, 'is_active = TRUE, synced_at = EXCLUDED.synced_at', '')))
         / length('is_active = TRUE, synced_at = EXCLUDED.synced_at');
  IF v_n <> 1 THEN
    RAISE EXCEPTION '00571: target del ON CONFLICT aparece % veces en bulk_upsert_pois (esperaba 1) — el cuerpo derivó, revisar a mano', v_n;
  END IF;

  v_src := replace(v_src, 'is_active = TRUE, synced_at = v_now', 'synced_at = v_now');
  v_src := replace(v_src, 'is_active = TRUE, synced_at = EXCLUDED.synced_at', 'synced_at = EXCLUDED.synced_at');
  EXECUTE v_src;
  RAISE NOTICE '00571: bulk_upsert_pois parcheado — el sync ya no re-activa filas desactivadas';
END $patch$;

COMMENT ON FUNCTION public.bulk_upsert_pois(jsonb) IS
  '00250 + 00571: upsert masivo del sync de POIs. Desde 00571 las ramas '
  'UPDATE/ON CONFLICT preservan is_active (curación manda); solo el INSERT '
  'de filas nuevas nace activo. Los admin siguen intocables.';

-- ────────────────────────────────────────────────────────────
-- Paso 0b: apply_osm_delta_batch — la rama MODIFY deja de forzar
-- is_active=TRUE (mismo patrón). El soft-delete de la rama DELETE y el
-- INSERT activo de filas nuevas quedan intactos.
-- ────────────────────────────────────────────────────────────
DO $patch$
DECLARE
  v_src text;
  v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'apply_osm_delta_batch';

  IF v_src IS NULL THEN
    RAISE NOTICE '00571: apply_osm_delta_batch ausente; skip';
    RETURN;
  END IF;

  IF position('is_active = TRUE,' IN v_src) = 0 THEN
    RAISE NOTICE '00571: apply_osm_delta_batch ya no fuerza is_active; skip';
    RETURN;
  END IF;

  v_n := (length(v_src) - length(replace(v_src, 'is_active = TRUE,', '')))
         / length('is_active = TRUE,');
  IF v_n <> 1 THEN
    RAISE EXCEPTION '00571: target aparece % veces en apply_osm_delta_batch (esperaba 1) — el cuerpo derivó, revisar a mano', v_n;
  END IF;

  v_src := replace(v_src, 'is_active = TRUE,', '');
  EXECUTE v_src;
  RAISE NOTICE '00571: apply_osm_delta_batch parcheado — el delta OSM ya no re-activa filas desactivadas';
END $patch$;

COMMENT ON FUNCTION public.apply_osm_delta_batch(jsonb) IS
  '00305 + 00571: delta diario OSM. Desde 00571 la rama MODIFY preserva '
  'is_active (curación manda); DELETE sigue desactivando y CREATE sigue '
  'insertando activo. Los admin siguen intocables.';

-- ────────────────────────────────────────────────────────────
-- Paso 1: clase A — POIs activos FUERA de Cuba (geometría).
-- Fila activa NO cubierta por ningún polígono provincial Y a >2 km de
-- todos ellos = fuera del país (Bahamas / Caimán / cruceros en altamar /
-- Haití / mar). La tolerancia de 2 km conserva los costeros legítimos.
-- Incluye a propósito las 4 filas is_admin foráneas.
-- Verificación por muestreo (todas las filas ≥205 km + mapa de clusters
-- del resto) en docs/AUDIT_CUBA_POIS_2026-08-21.md.
-- ────────────────────────────────────────────────────────────
DO $cleanup_a$
DECLARE
  v_n int;
  v_admins int;
BEGIN
  WITH hit AS (
    UPDATE public.cuba_pois p
       SET is_active = FALSE, updated_at = NOW()
     WHERE p.is_active
       AND NOT EXISTS (
         SELECT 1 FROM public.cuba_admin_areas pr
         WHERE pr.admin_level = 4
           AND pr.geom && ST_SetSRID(p.location::geometry, 4326)
           AND ST_Covers(pr.geom, ST_SetSRID(p.location::geometry, 4326)))
       AND NOT EXISTS (
         SELECT 1 FROM public.cuba_admin_areas pr
         WHERE pr.admin_level = 4
           AND ST_DWithin(ST_SetSRID(pr.geom, 4326)::geography, p.location, 2000))
    RETURNING p.id, p.is_admin
  )
  SELECT count(*), count(*) FILTER (WHERE is_admin) INTO v_n, v_admins FROM hit;

  RAISE NOTICE '00571 A (fuera de Cuba): % filas desactivadas (% admin) — esperadas ~744 (4 admin) al 2026-08-21', v_n, v_admins;
  IF v_n > 1000 THEN
    -- El UPDATE ya corrió dentro de esta transacción; abortar la revierte.
    RAISE EXCEPTION '00571 A: % filas superan el freno de 1000 — los polígonos de cuba_admin_areas derivaron; revisar antes de aplicar', v_n;
  END IF;
  IF v_n < 600 THEN
    RAISE WARNING '00571 A: solo % filas (esperadas ~744) — puede que un sync previo haya desactivado parte; verificar con la auditoría', v_n;
  END IF;
END $cleanup_a$;

-- ────────────────────────────────────────────────────────────
-- Paso 2: clases B/C/D — curadas fila a fila (solo no-admin).
--   B: dupes/mal ubicados de famosos (referente real ≥1 km; contraparte
--      activa bien ubicada verificada donde existe — ver auditoría).
--   C: marcas US inexistentes en Cuba (GTMO base y negocios cubanos
--      homónimos EXCLUIDOS a propósito).
--   D: check-ins de vuelos en HAV (no-lugares).
-- Guarda id+name: una fila renombrada/movida en prod convierte el UPDATE
-- en no-op contado, nunca en mis-hit.
-- ────────────────────────────────────────────────────────────
DO $cleanup_bcd$
DECLARE
  v_n int;
  v_expected int;
BEGIN
  WITH garbage(id, name) AS (VALUES
    -- B · Manzana Kempinski (real: admin 196627 en la Manzana de Gómez)
    (195801, 'Gran Hotel Manzana Kempinski'),                        -- overture, en Nuevo Vedado a 3,9 km
    (195595, 'Gran Hotel Manzana Kempinski La Habana'),              -- overture, en la Universidad a 2,4 km
    -- B · Habana Libre (real: admin 195545)
    (22736,  'Hotel Tryp Habana Libre'),                             -- merged conf 1, parada de bus con nombre del hotel (tc transport)
    (210058, 'Hotel Tryp Habana Libre'),                             -- foursquare, apilado a 56 m
    (194312, 'Havana Libre Hotel, Havana, Cuba'),                    -- overture, apilado a 41 m
    (193501, 'TRYP Habana Libre'),                                   -- overture, a 3,2 km (Vedado oeste)
    (194676, 'Tryp Habana Libre - Cuba'),                            -- overture, a 8 km (Marianao)
    (213738, 'Havana Libre'),                                        -- overture, a 11 km (Boyeros), tc other
    (214056, 'Escuela Taller Gaspar Melchor De Jovellanos'),         -- overture @Habana Libre; la real está en Habana Vieja
    -- B · Hotel Nacional (real: admin 195601) — imán de basura teleportada
    (195604, 'National Hotel Havana Cuba'),                          -- overture, apilado a 12,6 m
    (196707, 'Hotel National La Habana'),                            -- overture, en el Iberostar PC a 1,9 km
    (210091, 'Estadio Latinoamericano'),                             -- foursquare @Nacional; el real (54803) está en el Cerro
    (195605, 'San Cristobal Catedral Habana Vieja'),                 -- overture @Nacional; la Catedral real (197525/197526) está en Habana Vieja
    (195624, 'Palacio de la Revolución'),                            -- merged @Nacional; el real está en Plaza (sin fila activa: mejor sin resultado que teleport)
    (195619, 'Muraleando'),                                          -- merged @Nacional; el real (197653) está en Luyanó
    (195617, 'Tobacco Farm'),                                        -- merged @Nacional; Viñales
    (214046, 'Rio Hatiguanico'),                                     -- overture @Nacional; el río está en Matanzas
    (210088, 'elian gonzalez square'),                               -- foursquare @Nacional; Cárdenas
    (210100, 'Dona Carmela Restaurante Hostal'),                     -- foursquare @Nacional; el real (4936) está en Casablanca
    (195602, 'Cuba Island'),                                         -- overture @Nacional a 0,4 m; "la isla entera" como POI
    (195606, 'Casa De La Musica Havana'),                            -- overture @Nacional; las reales: Galiano 29440 / Miramar 193016 / Plaza 193916
    (209270, 'Cabaret Parisien'),                                    -- foursquare en Playa a 7,1 km; el real es el admin 120006 en el Nacional
    -- B · Iberostar Selection Parque Central (real: admin 196691)
    (213292, 'Havana Cathedral'),                                    -- overture @Iberostar; la real (197525, mismo nombre y conf) está en la Catedral
    (196701, 'Playa Boca Ciega'),                                    -- merged @Iberostar; las reales (199963/213989) en Habana del Este a 23 km
    -- B · Hotel Inglaterra
    (196718, 'Castillo de San Carlos de la Cabaña'),                 -- overture @Inglaterra; la real (197789 Fortaleza) cruza la bahía
    (214036, 'La Habana cuba Los Nardos'),                           -- overture @Inglaterra; el real (4887) frente al Capitolio
    -- B · Trinidad — pila de geografía imposible sobre el Parque Céspedes
    (202977, 'Playa Ancon, Trinidad, Cuba'),                         -- la playa real (202815/202812) está a 12 km
    (213474, 'La Playa De Trinidad'),
    (203204, 'Playa Ancon, Kuba'),
    (203054, 'Hotel Club Amigo Ancón'),                              -- el real (202814) está en la península de Ancón
    (203043, 'Cayo Iguana, Cuba'),                                   -- el cayo está a 25 km mar adentro
    (203040, 'Javira Waterfall'),                                    -- Topes de Collantes
    (202996, 'Valle de los Ingenios'),                               -- el valle real (202736/202738) está a 10 km
    (202973, 'Sendero Vegas Grande'),                                -- Topes de Collantes
    (203044, 'Parque El Cubano, Trinidad'),                          -- el parque real está a 5 km
    (203046, 'El Cubano, Trinidad, Cuba.'),
    -- B · Cayos (reales: admin 204559 Tryp Cayo Coco / 204485 Kempinski C.G.)
    (204470, 'Cayo Guillermo Resort Kempinski Cuba'),                -- overture, a 7,8 km del resort real
    (213514, 'TRYP Cayo Coco'),                                      -- overture cat "roofing", a 13 km, apilado
    (204511, 'TRYP Cayo Coco'),                                      -- overture cat "roofing", a 13 km, apilado
    (204571, 'TRYP Cayo Coco'),                                      -- overture cat "roofing", a 1,7 km
    -- B · Parque Central — dupes lejanos del parque
    (213234, 'La Habana, Parque Central'),                           -- overture, a 3,5 km (Habana del Este)
    (213289, 'Parque Central Habana'),                               -- overture, a 1,1 km
    -- B · otros famosos mal ubicados (referente real ≥1 km, verificado)
    (201023, 'Jardín Botánico Nacional de Cuba'),                    -- overture con coords de VARADERO; el real (209057) está en Boyeros
    (194109, 'Hotel Meliá Internacional Varadero Cuba. Reservas online.'), -- overture, hotel de Varadero con punto en el Vedado
    (193701, 'Fábrica de Arte Cubano'),                              -- overture, a 2 km; la FAC real (116258/193277, conf 1) está en Calle 26
    (214020, 'El Callejón de Hamel, La Habana, Cuba'),               -- overture en Habana Vieja; el real (ancla admin) está en Cayo Hueso a 2,1 km
    (210228, 'El Cocinero'),                                         -- foursquare en el Cerro a 6,3 km; el real (ancla admin) está junto a la FAC
    (209564, 'Melodrama'),                                           -- foursquare cruzando la bahía a 3,4 km del ancla admin "Bar Melodrama"
    (209368, 'Bom Apetite'),                                         -- foursquare a 2,3 km del ancla admin "Bom apetit"
    (201861, 'Bar-Café Colonial Villaverde'),                        -- overture a 1,5 km del ancla admin (Cienfuegos)
    (200876, 'Hotel Brisas del Caribe'),                             -- overture a 11 km del ancla admin (Varadero)
    (210641, 'Blau Varadero'),                                       -- foursquare tc museum a 8,2 km del ancla admin
    (210751, 'BlauVaradero'),                                        -- foursquare a 10 km del ancla admin
    -- C · marcas US inexistentes en Cuba (fuera de la base GTMO)
    (211827, 'Dunkin donuts'),                                       -- province='Pa' (Pennsylvania), coords en campo de Camagüey
    (211826, 'Pnc bank'),                                            -- ídem, apilado
    (211828, 'Yamato hibachi'),                                      -- ídem, apilado
    (210229, 'Starbucks'),                                           -- Boyeros
    (210838, 'Starbucks'),                                           -- province='Virginia', coords en Santa Clara
    (211552, 'McDonald''s'),                                         -- Santiago de Cuba centro
    (209578, 'McDonald''s'),                                         -- Habana del Este
    (209055, 'Pizza Hut'),                                           -- campo de Artemisa/Mayabeque
    (211485, 'Wendy''s'),                                            -- Holguín centro
    (212218, 'RedBox Walgreens'),                                    -- Topes de Collantes
    -- D · check-ins de vuelos de Foursquare en HAV (no-lugares)
    (209077, 'Cayman Airways Flight 833'),
    (209121, 'Cayman Airways flight 835'),
    (209101, 'Copa Flight CM 231 Havana-Panama'),
    (209114, 'Copa Flight CM437 HAV-PTY'),
    (209125, 'United Airlines Flight UA 1503 HAV - EWR'),
    (209113, 'izm-İT'),                                              -- apilado en el punto exacto del aeropuerto, tc museum
    (209096, 'Vuelo LATAM LA 2411')
  ),
  hit AS (
    UPDATE public.cuba_pois p
       SET is_active = FALSE, updated_at = NOW()
      FROM garbage g
     WHERE p.id = g.id AND p.name = g.name AND p.is_active AND NOT p.is_admin
    RETURNING p.id
  )
  SELECT count(*), (SELECT count(*) FROM garbage) INTO v_n, v_expected FROM hit;
  RAISE NOTICE '00571 B/C/D (dupes famosos / marcas US / vuelos): % de % filas desactivadas', v_n, v_expected;
  IF v_n < v_expected THEN
    RAISE WARNING '00571 B/C/D: % filas no matchearon (renombrada/movida/ya inactiva) — cotejar contra docs/AUDIT_CUBA_POIS_2026-08-21.md', v_expected - v_n;
  END IF;
END $cleanup_bcd$;

-- ────────────────────────────────────────────────────────────
-- Paso 3: clase E — mover el admin "Parque Central" (11241) al centro real
-- del parque (monumento a José Martí; 3 fuentes independientes apiladas a
-- <5 m: merged 59039 / osm 141895 / foursquare 209955) y corregir
-- tricigo_category 'museum' → 'park'. La fila es is_admin: ambos syncs la
-- saltan, así que la curación es durable. Idempotente por distancia.
-- ────────────────────────────────────────────────────────────
DO $curation$
DECLARE
  v_n int;
BEGIN
  UPDATE public.cuba_pois
     SET location = ST_SetSRID(ST_MakePoint(-82.358730, 23.137500), 4326)::geography,
         tricigo_category = 'park',
         updated_at = NOW()
   WHERE id = 11241 AND name = 'Parque Central' AND is_admin
     AND ST_Distance(location, ST_SetSRID(ST_MakePoint(-82.358730, 23.137500), 4326)::geography) > 30;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '00571 E: "Parque Central" (11241) movido al centro del parque + tricigo_category=park';
  ELSE
    RAISE NOTICE '00571 E: "Parque Central" (11241) ya curado o sin match (n=%) — verificar a mano si es inesperado', v_n;
  END IF;
END $curation$;

-- ────────────────────────────────────────────────────────────
-- Verificación post-apply (runbook completo en la auditoría):
--   SELECT * FROM lookup_nearest_poi_ranked(23.104020,-82.374920,30); -- ≠ Kempinski
--   SELECT * FROM lookup_nearest_poi_ranked(23.137502,-82.358732,30); -- 'Parque Central' d≈0
--   SELECT * FROM lookup_nearest_poi_ranked(19.917052,-75.138767,30); -- 'McDonald''s' (GTMO se conserva)
--   SELECT count(*) FROM cuba_pois p WHERE p.is_active
--     AND NOT EXISTS (SELECT 1 FROM cuba_admin_areas a WHERE a.admin_level=4
--                     AND ST_Covers(a.geom, ST_SetSRID(p.location::geometry,4326)))
--     AND NOT EXISTS (SELECT 1 FROM cuba_admin_areas a WHERE a.admin_level=4
--                     AND ST_DWithin(ST_SetSRID(a.geom,4326)::geography, p.location, 2000)); -- 0
-- ────────────────────────────────────────────────────────────
