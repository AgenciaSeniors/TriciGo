# Auditoría de basura en `cuba_pois` — 2026-08-21

**Alcance:** las clases de basura detectadas durante la verificación de 00570 (PR #976): duplicados mal
geolocalizados de hoteles famosos, clusters enteros fuera de Cuba, y puntos famosos mal ubicados que
des-etiquetan su entorno. **Entregable:** migración [`00571_cuba_pois_garbage_cleanup.sql`](../supabase/migrations/00571_cuba_pois_garbage_cleanup.sql).

> **APLICADA a prod el 2026-08-21** (autorización explícita; registro `20260821191406 cuba_pois_garbage_cleanup`).
> Resultado: **814 filas desactivadas = 744 clase A + 70 clases B/C/D** (cierre exacto contra lo esperado),
> ambos RPCs del sync parcheados (targets ausentes de los cuerpos vivos), "Parque Central" (11241) movido a
> (23.137500, −82.358730) con `tricigo_category='park'`. Suite post-apply con la función real: **14/14 pines
> idénticos a la simulación GREEN** (incl. NULL en Nuevo Vedado/Camagüey/Santiago/Boyeros, "Parque Central"
> d=0.3 en el monumento, y el McDonald's de GTMO conservado). Búsqueda: `search_pois_smart('estadio
> latinoamericano')` → el Cerro con `name_exact`; `('kempinski')` → solo el admin de la Manzana + el resort
> real de Cayo Guillermo. Nota operativa: el timeout del cliente MCP durante el apply NO cancela la query —
> el primer intento siguió corriendo server-side (~5 min por la clase A) y comiteó completo; el reintento
> quedó esperando el lock y terminó como no-op idempotente (por diseño).
>
> **CERRADO el 2026-08-22 — el candado está probado, sin esperar al sync.** `bulk_upsert_pois` corrido en
> prod dentro de `BEGIN…ROLLBACK` con un payload que matchea por `source_ids.ovt` la fila 195801 (una de las
> desactivadas): **`synced_at` avanzó y `is_active` siguió FALSE** — refresca sin resucitar, que es
> exactamente la semántica buscada. Estado: 19.679 activas (= 20.493 − 814 exacto), 0 filas curadas
> re-activadas, `updated_at` máximo = el instante del apply, un solo asiento en `schema_migrations`.
> (Corrección: el paso 5 decía "lunes 25/08"; el 21/08 fue **viernes**, o sea lunes **24/08**. Da igual: ese
> chequeo habría dado un **falso verde**, porque los dos syncs están caídos — ver el aviso de abajo.)

> **Contexto de 00570:** se mergeó Y se aplicó a prod el mismo día de esta auditoría (sesión paralela).
> 00570 NO hizo limpieza alguna — sus únicos UPDATEs siembran `footprint_radius_m` en 6 filas admin
> correctas; esta basura quedó declarada "out of scope" en su spec, y 00571 es exactamente ese follow-up.
> Las sondas RED de abajo se midieron con la 00550 entonces viva y se re-midieron contra la v3 real
> (cambios anotados en la tabla). La simulación GREEN usa la semántica v3 (huella efectiva + p.id).

**Estado de la tabla al auditar:** 110.024 filas, **20.493 activas** (osm 0 activas — capa desactivada por 00311;
merged 4.844 con los 389 admin; overture 11.908; foursquare 3.741). Las activas son lo que ven
`lookup_nearest_poi_ranked` y `search_pois_smart` (ambas filtran `is_active`).

---

## Hallazgo transversal: el sync resucita lo que se desactive (por eso el Paso 0)

`cuba_pois` NO es write-once: el workflow semanal `sync-pois.yml` (lunes 06:00 UTC) llama a
`bulk_upsert_pois`, y el diario `sync-osm-delta.yml` a `apply_osm_delta_batch`. Verificado en los
**cuerpos vivos** de ambos RPCs:

- `bulk_upsert_pois` — rama UPDATE: `is_active = TRUE, synced_at = v_now, …` y en su `ON CONFLICT`:
  `is_active = TRUE, synced_at = EXCLUDED.synced_at, …`. Además **pisa `location`** con la del upstream.
- `apply_osm_delta_batch` — rama MODIFY: `is_active = TRUE,` (y pisa `location`).
- Ambos **saltan `is_admin`** en todas sus ramas (los admin son intocables — por eso la curación del
  Parque Central sí es durable).

El bbox del sync (`CUBA_BBOX = (-85.0, 19.5, -74.0, 23.5)`) **incluye Cayman Brac y Little Cayman**
(lat 19.65–19.76) y el SE de Bahamas hasta lat 23.5, y las marcas US siguen en Foursquare OS Places
⇒ toda fila no-admin desactivada se **re-activa y re-ubica** en el próximo sync (el último full sync fue
2026-08-10: 17.973 filas tocadas). Los quality gates del sync no la filtran (conf 0.7 ≥ 0.6; clusters de
2-4 < 5). **Por eso 00571 parchea primero ambos RPCs** (in-place sobre el cuerpo vivo): el sync sigue
refrescando datos e insertando filas nuevas activas, pero `is_active` pasa a ser propiedad de la curación.
Trade-off aceptado: un lugar OSM borrado y luego re-creado con el mismo id quedará inactivo hasta que un
admin lo reactive (caso raro; preferible a perder la limpieza cada lunes).

Nota: la desactivación por antigüedad que promete el docstring del script ("not seen in this run AND older
than 60 days → is_active=false") **no está implementada** en ningún RPC — nada desactiva filas stale hoy.

### Addendum 2026-08-22: los dos syncs estaban CAÍDOS (preexistente) — arreglados en 00573 + workflow

Al ir a verificar el candado se descubrió que **ningún sync corría desde el 2026-08-10** (`max(synced_at)`),
o sea 12 días sin refrescar lugares, fallando en silencio (el aviso de Slack de ambos workflows cuelga de un
secret `SLACK_WEBHOOK_OPS` que no está configurado). Dos causas independientes, ninguna de ellas de 00571
(los runs fallidos del 19/20/21-08 son de las 06:37 UTC y el parche se aplicó el 21 a las 19:14):

> **Corrección del alcance (medido el 22/08 con `gh run list --limit 200`):** el delta diario NO llevaba
> días caído sino **~2 meses**. Está en rojo **todos los días desde el 2026-06-24**, y sus únicos "success"
> (08-03, 07-20, 07-13, 07-06, 06-29 — casi todos lunes, justo después de que el full semanal adelantara el
> puntero) son **no-ops**: el log dice `already up to date at seq NNNN` y el script retorna 0 **sin llamar
> al RPC**. O sea, **el delta nunca aplicó un solo diff desde que se creó** (2026-05-24). Los días en que
> tuvo trabajo real, falló. Detalle en la tabla de abajo.

1. **Delta diario, todos los días desde ≥19/08.** `apply_osm_delta_batch` asignaba
   `cuba_pois.name_normalized`, que es **GENERATED ALWAYS** → `428C9` → PostgREST lo devuelve como **400** →
   el script muere en `raise_for_status()`. Asignaba la columna en dos sitios (el INSERT y el SET del
   UPDATE) y, como el INSERT corre primero, **todo evento CREATE/MODIFY fallaba**; solo la rama DELETE
   sobrevivía. `import_search_poi` ya llevaba el arreglo equivalente; a este RPC se le había pasado.
   → **Fix: [`00573_apply_osm_delta_generated_column_fix.sql`](../supabase/migrations/00573_apply_osm_delta_generated_column_fix.sql)**,
   patch in-place sobre el cuerpo VIVO (no sobre 00305, que revertiría el candado de 00571 en silencio),
   con las 4 ramas probadas en `BEGIN…ROLLBACK`.
2. **Full semanal, desde el 17/08.** El paso de Overture aborta con `Could not fetch STAC catalog: HTTP
   Error 404`. Al ser el paso 1 sin `continue-on-error`, los 4 pasos siguientes quedaban `skipped` y no se
   hacía ningún upsert.

   **El 404 fue TRANSITORIO — no un endpoint muerto ni un pin viejo.** (Rectifica la primera lectura, que
   decía "catálogo remoto que ya no resuelve"; el error *parece* un pin vencido y no lo es.) Medido:
   - `https://stac.overturemaps.org/catalog.json` — literalmente `STAC_CATALOG_URL` en
     `overturemaps/core.py:15`, el **único** sitio que levanta `Could not fetch STAC catalog` — responde
     **200 en 3 sondas seguidas**, con `"latest": "2026-08-19.0"`.
   - `overturemaps` instalado fue **1.0.1 en las DOS corridas**: la última exitosa (run `31364944202`,
     10/08) y la fallida (`32002252161`, 17/08). Misma versión, mismo código ⇒ lo único que cambió fue la
     respuesta del otro lado. (`1.0.1` se publicó el 30/06: venía andando 6 semanas.)

   ⇒ El defecto real era que **una sola llamada HTTP a un tercero flojo mataba el sync semanal entero**.
   → **Fix en dos capas:** (a) **reintento con backoff** 3× (30 s, 90 s) — la causa; y (b) **degradación**
   `continue-on-error` + borrado del parcial + aviso en el job summary — la red de seguridad, para que si el
   corte dura más que los reintentos el merge siga con OSM + Foursquare + Wikidata. Sin (a), cada blip deja
   sin refrescar **11.908 de ~19.679 filas activas** (la fuente más grande) durante una semana entera y en
   silencio.

**Lección (misma familia que la "ceguera de crons" de CLAUDE.md):** un workflow programado que falla no
avisa a nadie. Los dos se descubrieron de casualidad — uno con 2 semanas en rojo, el otro con 2 meses.
El aviso de Slack estaba **doblemente** muerto: el secret `SLACK_WEBHOOK_OPS` no existe **y** su condición
`if: always() && env.SLACK_WEBHOOK != ''` leía un `env:` declarado **en el propio paso**, que GitHub monta
*después* de evaluar el `if:` — así que valía siempre `''` y el paso nunca corría ni con el secret puesto
(en el run `32002252161` figura `skipped` aunque el job falló).

→ **Fix: [`00574_poi_sync_failure_alerting.sql`](../supabase/migrations/00574_poi_sync_failure_alerting.sql)**,
dos capas porque cada una tapa un agujero que la otra no ve:

| capa | qué es | qué atrapa | qué NO puede ver |
|---|---|---|---|
| `notify_ops_workflow_failure()` | paso `if: failure()` en ambos workflows → email a `business_notification_email` | el run en **rojo** | que el workflow **no corra** (sin run no hay fallo) |
| `check_poi_sync_freshness()` | cron horario sobre `poi_sync_state.last_sync_at` | que el sync **deje de correr** (deshabilitado, renombrado, schedule apagado) | un fallo puntual dentro del umbral |

Detalles que hacen que funcione: el alerting es **transition-only** (`ok↔stale`, patrón de 00503) → no hace
spam; el email usa secrets que **ya existen** (`SUPABASE_SERVICE_ROLE` + `NEXT_PUBLIC_SUPABASE_URL`), que es
justo lo que mató al de Slack; y el early-return `already up to date` de `apply_osm_delta.py` ahora escribe
**heartbeat**, sin el cual la base no puede distinguir "corrió y no había nada que aplicar" de "dejó de
correr" — las dos dejaban `last_sync_at` quieto.

---

## Clase A — fuera de Cuba (predicado geométrico)

**Detección:** fila activa no cubierta por ningún polígono provincial (`cuba_admin_areas`, admin_level=4,
16 provincias OSM) **y** a >2 km de todos ellos. Resultado: **757 activas fuera de polígonos**, de las
cuales **13 están a ≤2 km** (costeros legítimos: puntos en el agua junto a la costa — se conservan)
⇒ **~744 a desactivar**, incluidas **4 filas is_admin conf 1**:

| id | name | dónde está en realidad |
|---|---|---|
| 202022 | Little Cayman Beach Resort | Little Cayman (19.663, −80.077) |
| 202079 | Sir Charles Kirkconnell International Airport | aeropuerto de Cayman Brac |
| 207266 | Haulover Bay Restaurant, Bar and Grill | Exuma, Bahamas (`province='EX'`) |
| 207293 | Rusty Anchor | Exuma, Bahamas (`province='EX'`) |

**Verificación por muestreo (cobertura completa):**
- Las **250 filas más lejanas** (≥205 km) fueron revisadas una a una (subagente): 249 en el SE de Bahamas
  (Long Island / Exuma / Crooked Island — resorts, iglesias, gasolineras, aeropuertos de Bahamas; metadata
  delatora: `province` = "New York", "ny", "Florida", "LONG ISLAND") + 1 en mar abierto. **0 lugares cubanos.**
- El resto se verificó por **mapa de clusters** (celdas de 0,1°, cada una identificable por coordenadas +
  nombres de muestra). Clusters dominantes:

| celda (lat, lng) | n | qué es |
|---|---|---|
| 19.7, −80.1 / −79.9 / −79.8 / −80.0 / −79.7 | ~204 | **Islas Caimán** (Little Cayman + Cayman Brac): resorts, aeropuertos, dive shops, "Temple Beth Shalom", "Bucky's" |
| 23.1–23.5, −74.9..−75.8 | ~315 | **SE de Bahamas** (Long Island, Exuma, Crooked, Ragged) |
| 22.1–22.9, −74.1..−74.5 | ~40 | Crooked/Acklins (Bahamas) |
| 19.5, −80.6 | 2 | Grand Cayman (Kimpton Seafire, Ritz Carlton) |
| ~30 celdas de n=1-4 en el mar (−76..−85) | ~70 | **check-ins de CRUCEROS**: "Allure of the Seas", "MSC Seashore", "Norwegian Gem", "Caribbean Sea", "Middle Of The Atlantic", "Somewhere in the Caribbean Sea", "labadee, haiti" |

- **0 filas de la base naval de Guantánamo** aparecen fuera de polígonos (la base está cubierta por el
  polígono de Guantánamo — sus McDonald's/Pizza Hut/KFC reales NO se tocan, ver keep-list).
- **Falso-positivo check de cayos:** 0 activas alrededor de Cayo Coco (radio 12 km) quedan fuera de los
  polígonos — los polígonos provinciales incluyen los cayos. Cayo Guillermo/Largo/Santa María idem
  (ninguna aparece en el conjunto "outside").

**Por qué predicado y no lista de ids:** son ~744 filas, la geometría es el criterio (no hay juicio por
fila), es idempotente y auditable, y la migración lleva **freno de radio de daño** (aborta >1000 filas,
avisa <600). No es supresión por categoría (lección-721): es geografía.

**Por qué no DELETE:** con filas conservadas (inactivas), el sync las matchea por `source_ids` y no las
re-inserta; borradas, el INSERT del próximo sync las recrearía activas. `is_active=false` + parche del
Paso 0 es la única combinación durable — y reversible (patrón 00311).

## Clase B — duplicados / famosos tele-transportados (53 filas curadas)

Criterio: el referente real del nombre está a **≥1 km** del punto, verificado fila a fila; donde existe,
se citó la fila activa **bien ubicada** que conserva el lugar en la búsqueda. Dos sub-patrones:

1. **Dupes del mismo hotel famoso** con el pin corrido (Kempinski en Nuevo Vedado `195801` y en la
   Universidad `195595`; TRYP Habana Libre ×3 lejanos + 2 apilados + la parada de bus merged conf 1
   `22736` con tc `transport`; "National Hotel Havana Cuba" `195604`; TRYP Cayo Coco ×3 con category
   "roofing"; Kempinski Cayo Guillermo `204470` a 7,8 km).
2. **Famosos tele-transportados a otros landmarks** (los landmarks son imanes de basura — 00570): en el
   punto del Hotel Nacional estaban apilados "Estadio Latinoamericano", "San Cristobal Catedral",
   "Palacio de la Revolución", "Muraleando", "Tobacco Farm", "Rio Hatiguanico", "elian gonzalez square",
   "Dona Carmela", "Cuba Island", "Casa De La Musica Havana"; en el Iberostar PC: "Havana Cathedral",
   "Playa Boca Ciega", "Hotel National La Habana"; en Inglaterra: "Castillo de San Carlos de la Cabaña",
   "La Habana cuba Los Nardos"; en el Habana Libre: "Escuela Taller Gaspar Melchor De Jovellanos"; y la
   pila de Trinidad sobre el Parque Céspedes ("Playa Ancon" ×3, "Cayo Iguana", "Valle de los Ingenios",
   "Javira Waterfall", "Sendero Vegas Grande", "El Cubano" ×2, "Hotel Club Amigo Ancón").
   Contrapartes reales verificadas: Estadio `54803` (Cerro), Catedral `197525`/`197526`, FAC
   `116258`/`193277` (conf 1, Calle 26), Los Nardos `4887`, Muraleando `197653`, Fortaleza de la Cabaña
   `197789`, Playa Ancón `202815`/`202812`, Valle de los Ingenios `202736`/`202738`, Doña Carmela `4936`,
   Casas de la Música Galiano/Miramar/Plaza, Boca Ciega `199963`/`213989`, Jardín Botánico `209057`.
3. **9 dupes confirmados por el detector de similitud** (trgm ≥0.55, 120 m–15 km, contra las 389 anclas
   admin; 75 matches revisados a mano, 63 descartados como lugares distintos): `209270` Cabaret Parisien
   (en Playa, real = admin en el Nacional), `214020` Callejón de Hamel (en Habana Vieja), `210228`
   El Cocinero (en el Cerro), `209564` Melodrama (cruzando la bahía), `209368` Bom Apetite, `201861`
   Bar-Café Colonial Villaverde (Cienfuegos), `200876` Hotel Brisas del Caribe, `210641`/`210751`
   Blau Varadero ×2.

## Clase C — marcas US inexistentes en Cuba (10 filas)

`211827` Dunkin donuts + `211826` Pnc bank + `211828` Yamato hibachi (apiladas en el mismo punto de campo
en Camagüey, `province='Pa'` = Pennsylvania — coordenadas de fallback de Foursquare); Starbucks `210229`
(Boyeros) y `210838` (`province='Virginia'`, coords en Santa Clara); McDonald's `211552` (Santiago) y
`209578` (Habana del Este); Pizza Hut `209055`; Wendy's `211485` (Holguín); RedBox Walgreens `212218`.

## Clase D — check-ins de vuelos en HAV (7 filas)

Venues de Foursquare que no son lugares: `209077`/`209121` Cayman Airways 833/835, `209101`/`209114`
Copa CM231/CM437, `209125` United UA1503, `209096` Vuelo LATAM LA 2411, `209113` "izm-İT" (apilado en el
punto exacto del aeropuerto, tc museum). Parado en HAV, el ranking podía etiquetar "Copa Flight CM437".
Los vuelos con coords en Caimán caen por la clase A.

## Clase E — curación: el punto del admin "Parque Central" (11241)

Estaba en (23.138582, −82.358732): a **7,5 m** del punto del Iberostar Selection Parque Central y ~120 m
del parque real — etiquetaba la puerta del hotel como "Parque Central" y dejaba el parque huérfano.
Nuevo punto: **(23.137500, −82.358730)** = el monumento a José Martí, centro físico del parque, anclado
por 3 fuentes independientes apiladas a <5 m entre sí (merged `59039`, osm `141895`, foursquare `209955`).
Además `tricigo_category` 'museum' → 'park'. Durable: la fila es is_admin y ambos syncs saltan admins.

---

## Verificación (RED con la función viva / GREEN con espejo exacto + exclusiones)

GREEN = espejo read-only de la semántica v3 viva (00570 aplicada: bandas de 10 m sobre la distancia
EFECTIVA a la huella → `is_admin` → `confidence` → efectiva → cruda → `p.id`) con la lista curada
excluida y 11241 movido (mismo método "candidata inline" de 00570).

| pin | VIVO (v3, hoy) | CANDIDATO (post-00571) | veredicto |
|---|---|---|---|
| Nuevo Vedado (23.104020,−82.374920) | Gran Hotel Manzana Kempinski d=0 | NULL (gana la dirección de calle) | ✅ arreglado |
| Universidad (23.135582,−82.380856) | Gran Hotel Manzana Kempinski La Habana d=0 | Monte Freddo 18 m | ✅ arreglado |
| campo Camagüey (21.333050,−77.429620) | Pnc bank d=0 (pre-00570 daba Dunkin — empate apilado, ahora determinista por `p.id`) | NULL | ✅ arreglado |
| Santiago centro | McDonald's d=0.1 | NULL | ✅ arreglado |
| Boyeros | Starbucks d=0 | NULL | ✅ arreglado |
| punto Hotel Nacional +12 m | Hotel Nacional de Cuba d=0 (la huella r=40 de 00570 ya curó la etiqueta) | idéntico | ✅ 00571 saca el dupe "National Hotel Havana Cuba" de la BÚSQUEDA |
| Calle L (punto del dupe transport) | Hotel Tryp Habana Libre (public_transport) d=0 | Fonda La Paila Restaurant Paladar 9.9 m (restaurante real vecino) | ✅ arreglado |
| monumento José Martí | "Parque Central" 3.0 m (la parada de bus homónima) | **"Parque Central" 0.3 m (el admin movido)** | ✅ |
| pin medio del parque | Monumento Jose Marti 19.3 m | idéntico | ✅ etiqueta correcta (el monumento ESTÁ en el parque) |
| puerta del Iberostar PC | Iberostar Selection Parque Central d=0 | idéntico | ✅ control |
| Parque Céspedes Trinidad (control 00550) | Parque Cespedes d=0.1 | idéntico | ✅ control |
| punto Iberostar Grand Trinidad | Iberostar Grand Trinidad 4.6 m | idéntico | ✅ control |
| aeropuerto HAV | José Martí International Airport 0.1 m | idéntico | ✅ control |
| McDonald's base GTMO (19.917052,−75.138767) | McDonald's d=0 | **McDonald's d=0** | ✅ conservadurismo probado |

(La clase A no está en la lista de exclusión del espejo; ninguna de sus filas cae dentro del radio de
captación de ningún pin de la suite — verificado por coordenadas — así que los resultados no cambian.)

## Keep-list (NO tocar — decisión explícita)

- **Base naval GTMO (dentro de Cuba):** McDonald's `214473`/`208536`/`208538`, Pizza Hut Express `211643`,
  Taco Bell/KFC/A&W `211645`, KFC `211609` (Leeward Point). Son los locales US **reales**.
- **Negocios cubanos con nombre "de marca":** Wendy studios `196127`, Wendy's Salon `203145`,
  Pinturas Cayman `192592`, Cayman Airways - Havana Station `209120` (oficina real), Cuba Tours & Travel
  Cayman Islands `198324`, Tour Cuba e Isole Cayman `193621`.
- **Costeros ≤2 km de los polígonos** (13 filas): protegidos por la tolerancia del predicado.
- **Amenities propios de los hoteles** (Salón 1930, Comedor de Aguiar, Turquino, Galería Comercial,
  Rooftop bars, "Habana Libre Residence"): reales, patrón lección-721.
- **"Hotel Parque Central" `109971`** (admin, nombre viejo del Iberostar, ubicación correcta): se queda —
  el nombre sigue en la fachada; candidato a fusión en una curación admin futura.
- **~1.400 pares apilados cross-source de lugares reales** (Museo Farmacéutico, Torre de Iznaga…):
  dedup cosmético, no basura; el desempate por `p.id` de 00570 ya los estabiliza.
- **Pilas de Overture a nivel de cuadra** (varios negocios reales con el mismo punto grueso): reales.

## Residuales documentados (no accionados — confianza insuficiente o daño bajo)

- Sub-locales foursquare ambiguos junto al Nacional: "moraleja", "San Jose", "CINE", "Viña del mar",
  "Paricien" (dupe del Cabaret con typo), "Hall Of Fame". La huella r=40 de 00570 neutraliza su daño de
  etiqueta; sin referente verificable no se tocan.
- "El Mediterraneo" `209852` (restaurante dentro del parque PC), "Cine Payret" `196692` (~150 m),
  "Templo De Yemaya" `203045` (~400 m), "Museo Nacional de la Lucha Contra Bandidos" `212163` (~400 m),
  "Parque Central Habana" `196672` (65 m): bajo el umbral de 1 km.
- Dupes internos detectados de paso por el detector: `193217`/`213183` (Casa Bella Vista El Mirador ×2),
  `140320`/`7494` (Casa de la Amistad ×2), `16324`/`210196` (Biblioteca Nacional ×2), `213515` (dupe del
  aeropuerto Jardines del Rey), `138100` "Donde Dorian" (¿sucursal?): fusión futura, no urgente.
- "Catedral Del Morro Havana, Cuba" `209554`, "Centro Histórico De La Habana" `196746` (tc transport),
  nombres genéricos ("Bar"): daño bajo.
- La fila sucia del Hotel Melia Cohiba (tc transport, admin) sigue pendiente de curación admin (ya
  anotada en 00570).

## Runbook post-apply (ejecutado 2026-08-21; solo queda el paso 5)

1. ✅ `mcp__apply_migration` de 00571 (autorizado via AskUserQuestion). Los NOTICE no llegaron al cliente
   (timeout — la query completó server-side), pero los conteos reconcilian exactos: 814 desactivadas en la
   ventana del apply = 744 A + 70 B/C/D; funciones parcheadas; E movido (verificado por estado, no por log).
2. ✅ Suite de pines re-corrida con la función real: 14/14 idénticos a la columna CANDIDATO.
3. ✅ (por aritmética + muestra) 757 fuera de polígonos pre-apply − 744 desactivadas = 13 restantes = las
   costeras ≤2 km conservadas; muestra de la caja Bahamas: 0 activas. La query completa de vacío es cara
   (~3 min) — opcional re-correrla en frío.
4. ✅ Smoke de búsqueda: 'estadio latinoamericano' → el Cerro (`name_exact`); 'kempinski' → solo el admin
   de la Manzana + el resort real de Cayo Guillermo.
5. ✅ **Reemplazado y cumplido el 2026-08-22.** El chequeo "esperar al lunes" habría dado un falso verde
   (ambos syncs estaban caídos, ver addendum). Se probó el candado directamente: `bulk_upsert_pois` en
   `BEGIN…ROLLBACK` contra la fila 195801 desactivada → refrescó `synced_at` y dejó `is_active=false`.
   Sigue valiendo re-correrlo tras el **primer sync exitoso** post-00573:
   `SELECT count(*) FROM cuba_pois WHERE is_active AND id IN (211827, 202022, 194312, 195801, 22736);` → 0.

## Recomendaciones (fuera del alcance de 00571, no accionadas)

1. **Cerrar la puerta de entrada:** bajar el sur del `CUBA_BBOX` de 19.5 a **19.80** en
   `scripts/sync-pois/merge_and_upsert.py` + `sync-pois.yml` (Cuba llega a ~19.82; Cayman Brac termina en
   ~19.76) y recortar el este de −74.0 a −74.10. Eso evita que Caimán/Bahamas-fringe entren como filas
   NUEVAS (el parche del Paso 0 solo congela las existentes). Mejor aún: validar punto-en-Cuba con
   `cuba_admin_areas` dentro de `bulk_upsert_pois`/`import_search_poi` (el bbox de `import_search_poi`
   también deja pasar Caimán: lat ≥ 19.5).
2. **Geo-gate para promociones a admin:** 4 admin conf 1 estaban fuera del país — la promoción a admin
   debería exigir el mismo punto-en-Cuba.
3. **Staleness:** decidir si se implementa la desactivación por "no visto en 60 días" que el docstring
   promete (hoy no existe); con el Paso 0 aplicado, sería el único mecanismo automático que desactive.
4. Curación futura: fusionar los dupes internos listados en residuales; sembrar huella 00570 para
   "Parque Central" una vez movido (el parque es grande y ya no ensucia el halo del Iberostar).
