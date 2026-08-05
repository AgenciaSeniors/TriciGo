-- ============================================================
-- Migration 00551: teclear una MARCA cubana (Coppelia, CADECA, ETECSA…)
--                  hundía exactamente el lugar que se buscaba
--
-- WHY (medido contra prod):
--
--   `search_pois_smart` tiene una regla anti-placeholder correcta: si la
--   consulta es una palabra de categoría (`cuba_search_keywords`) y un lugar
--   se llama EXACTAMENTE así, ese lugar se hunde (`is_generic * 5000` en el
--   ORDER BY). Un bar llamado "Bar" es ruido de datos; hundirlo está bien.
--
--   Pero la tabla de keywords mezclaba dos clases distintas:
--
--     GENÉRICOS  (bar, cafetería, hospital, parque…)  → hundir es correcto
--     MARCAS     (Coppelia, CADECA, ETECSA, Viazul…)  → hundir es lo OPUESTO
--
--   Para una cadena, el nombre de la sucursal ES la marca: hay 19 oficinas
--   activas llamadas exactamente "ETECSA", 14 "Coppelia", 13 "Banco
--   Metropolitano", 4 "CADECA", 4 "Viazul", 5 "Casa de la Trova". Teclear la
--   marca hundía precisamente esos lugares y subía filas raras o categoría
--   suelta. Medido en la barrida E2E de las 16 provincias:
--
--     tecleado    devolvía                                  el lugar real
--     coppelia    "El Jardín de Xiomy" (otro café)          Coppelia a 2 km
--     etecsa      "ETECSA_Cuba Guantánamo"                  ETECSA (exacta)
--     cadeca      "Cadeca - Casas De Cambio"                CADECA (exacta)
--
-- WHAT THIS DOES:
--   Borra las 10 keywords que son MARCAS/nombres propios, no categorías.
--   Sin la keyword: (a) el lugar de nombre exacto deja de hundirse y gana por
--   calidad de match + cercanía; (b) desaparece la expansión category_only,
--   que para una marca era ruido (tecleás "cadeca" y te salían bancos que no
--   son CADECA). La búsqueda por nombre cubre todas las sucursales porque
--   las sucursales llevan la marca en el nombre.
--
--   Se conservan TODAS las keywords genéricas — "bar" siguió devolviendo un
--   bar real y "hospital" al Hermanos Ameijeiras en la verificación.
--
-- VERIFICADO en transacción revertida (junto al patch de 00550):
--     coppelia → Coppelia · cadeca → CADECA · etecsa → ETECSA
--     viazul → Estación Viazul · banco metropolitano → Banco Metropolitano
--     bar → Bar Melodrama · hospital → Hospital Hermanos Ameijeiras
--   Barrida E2E de lugares por provincia: 156/160 → **160/160**.
--
-- ROLLBACK (si hiciera falta restaurar):
--   INSERT INTO cuba_search_keywords (keyword, tricigo_category) VALUES
--     ('etecsa','shop'),('coppelia','cafe'),('cadeca','bank'),
--     ('banco metropolitano','bank'),('viazul','transport'),
--     ('casa de la trova','museum'),('cupet','gas_station'),
--     ('oro negro','gas_station'),('malecon','park'),('pnr','gov');
-- ============================================================

DELETE FROM cuba_search_keywords WHERE keyword IN (
  'etecsa',
  'coppelia',
  'cadeca',
  'banco metropolitano',
  'viazul',
  'casa de la trova',
  'cupet',
  'oro negro',
  'malecon',
  'pnr'
);

COMMENT ON TABLE cuba_search_keywords IS
  'Palabras de CATEGORÍA en español/cubano para search_pois_smart (00255). '
  'REGLA (00551): solo palabras genéricas de categoría — nunca marcas ni nombres '
  'propios (Coppelia, CADECA, ETECSA…), porque la regla anti-placeholder hunde a '
  'los lugares cuyo nombre coincide exactamente con una keyword, y para una cadena '
  'el nombre de la sucursal ES la marca.';
