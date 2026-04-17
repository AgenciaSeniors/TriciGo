# AUDITORIA ENFOCADA — TriciGo (Flujo de Viaje + Geo + Driver)

**Fecha:** 2026-04-10
**Alcance:** Flujo de viaje end-to-end, geolocalización, driver app
**Superficies:** Web-client, Client-móvil, Driver app, Backend Supabase

---

## RESUMEN EJECUTIVO

| Área | Bugs Críticos | Bugs Altos | Bugs Medios | Bugs Bajos | Veredicto |
|------|--------------|-----------|------------|-----------|-----------|
| Flujo de viaje | 2 | 4 | 3 | 2 | NO LISTO — faltan retry con radio mayor y tracking RT web |
| Geolocalización | 0 | 2 | 3 | 1 | LISTO CON OBSERVACIONES |
| Driver App | 1 | 3 | 4 | 1 | NO LISTO — auto-advance 5s rompe post-viaje |
| **TOTAL** | **3** | **9** | **10** | **4** | |

---

# AREA 1 — FLUJO DE VIAJE

## Bugs Críticos 🔴

### [BUG-F001] Search timeout cancela viaje en vez de reintentar con radio mayor
- **Área:** flujo-viaje
- **Superficie:** client-móvil
- **Archivo(s):** apps/client/src/hooks/useRide.ts:569-598, apps/client/src/config/ride.ts:3
- **Severidad:** 🔴 Crítico
- **Categoría:** funcional
- **Explicación técnica:** `SEARCH_TIMEOUT_MS = 120_000` (2 min). Cuando expira, línea 583 ejecuta `rideService.cancelRide(ar.id, user?.id, 'search_timeout')` y muestra toast "No se encontró conductor". No hay lógica de retry con radio mayor.
- **Impacto en el usuario:** Son las 11pm en La Habana, zona con pocos conductores. El rider solicita un viaje, espera 2 minutos, y el sistema cancela automáticamente mostrando "No se encontró conductor". El rider tiene que volver a solicitar manualmente. No hay expansión de radio de búsqueda — si no hay drivers en 5km, nunca encontrará uno a 8km.
- **Corrección sugerida:** Implementar retry progresivo: 1) mantener el ride en searching, 2) expandir radio de matching (5km→8km→12km), 3) solo cancelar después de 3 intentos fallidos o 5 min total. Requiere parámetro de radio en la edge function cancel-stale-rides o nuevo RPC.
- **¿Bloquea producción?** SÍ — el usuario definió que debe reintentar con radio mayor.

### [BUG-F002] Web tracking no recibe posición del driver en tiempo real
- **Área:** flujo-viaje
- **Superficie:** web-client
- **Archivo(s):** apps/web/src/app/track/[id]/page.tsx:232-241
- **Severidad:** 🔴 Crítico
- **Categoría:** realtime
- **Explicación técnica:** Línea 235: se suscribe a `driver-location-${ride.driver_id}` como canal broadcast. PERO el driver app envía ubicación via `driverService.updateLocation()` que hace UPDATE a `driver_profiles.current_location` (postgres_changes), NO broadcast. El canal broadcast `driver-location-*` nunca recibe eventos porque nadie los emite.
- **Impacto en el usuario:** El rider abre el tracking en la web, ve el mapa con pickup/dropoff pero el marcador del driver NUNCA se mueve. Solo se actualiza cada 10s vía polling (fetchRide). El requisito es tiempo real.
- **Corrección sugerida:** Cambiar la suscripción a `postgres_changes` en `driver_profiles` filtrando por `driver_id`, O hacer que el driver app también emita broadcast en el canal `driver-location-*` al actualizar ubicación.
- **¿Bloquea producción?** SÍ — el usuario requirió tracking web en tiempo real.

## Bugs Altos 🟠

### [BUG-F003] Web tracking: polling 10s con dependencia stale en ride?.status
- **Archivo(s):** apps/web/src/app/track/[id]/page.tsx:192-201
- **Severidad:** 🟠 Alto
- **Categoría:** rendimiento/realtime
- **Explicación técnica:** El useEffect tiene `ride?.status` en dependency array (línea 201). Cada vez que ride.status cambia (via realtime), el useEffect se re-ejecuta creando un NUEVO interval sin limpiar el anterior correctamente durante el re-render cycle. Múltiples intervals pueden acumularse.
- **Impacto en el usuario:** El servidor recibe múltiples fetchRide calls cada 10s por el mismo viaje, desperdiciando bandwidth.
- **Corrección sugerida:** Mover el check de terminal status DENTRO del interval callback (ya se hace en línea 194), y remover `ride?.status` del dependency array.

### [BUG-F004] Client móvil: cancelRide usa userId como segundo parámetro
- **Archivo(s):** apps/web/src/app/track/[id]/page.tsx:614
- **Severidad:** 🟠 Alto
- **Categoría:** funcional
- **Explicación técnica:** Web llama `rideService.cancelRide(rideId, undefined, 'rider_canceled')` — pasa `undefined` como userId. Esto significa que el backend no puede registrar QUIÉN canceló el viaje. El `canceled_by` queda NULL.
- **Impacto en el usuario:** Si el rider cancela desde web, el sistema no sabe quién canceló. La penalización de cancelación no se aplica (línea 760-778 de ride.service.ts: `if (userId)` guarda el fee).
- **Corrección sugerida:** Pasar `userId` (disponible en el componente desde el auth guard) como segundo parámetro.

### [BUG-F005] Driver TripCompleteView auto-advance en 5 segundos
- **Archivo(s):** apps/driver/src/components/DriverTripView.tsx:1114-1122
- **Severidad:** 🟠 Alto
- **Categoría:** UX
- **Explicación técnica:** Línea 1117-1118: `setTimeout(() => clearCompletedTrip(), 5000)`. Después de completar un viaje, la pantalla de resumen se cierra automáticamente en 5 segundos. El driver no tiene tiempo de: ver sus ganancias detalladas, calificar al rider, descargar el recibo.
- **Impacto en el usuario:** El driver completa un viaje largo de 45 minutos. La pantalla de ganancias aparece mostrando ₧2,500 pero desaparece en 5 segundos antes de que pueda calificar al rider o descargar el recibo. Frustración y pérdida de feedback.
- **Corrección sugerida:** Eliminar el auto-timeout. El driver debe tocar "Listo" manualmente (botón ya existe en línea 1282-1287). O aumentar a 30+ segundos con opción de "mantener abierto".

### [BUG-F006] bulkRecordRideLocations no deduplica ni valida orden temporal
- **Archivo(s):** packages/api/src/services/location.service.ts:54-77
- **Severidad:** 🟠 Alto
- **Categoría:** datos
- **Explicación técnica:** La función inserta el batch directamente sin: 1) validar que recorded_at esté ordenado, 2) deduplicar puntos con mismo timestamp+location, 3) verificar que el ride_id es válido. Si el buffer offline se flushea dos veces (race condition en reconnect), se insertan puntos duplicados.
- **Corrección sugerida:** Agregar `ON CONFLICT DO NOTHING` o constraint unique en (ride_id, recorded_at), y validar que todos los eventos pertenecen al mismo ride.

## Bugs Medios 🟡

### [BUG-F007] Web: no hay indicador de "buscando conductor" con nearby vehicles
- **Archivo(s):** apps/web/src/app/track/[id]/page.tsx:203-220
- **Severidad:** 🟡 Medio
- **Categoría:** UX
- **Explicación técnica:** El polling de nearby vehicles (recién implementado) depende del RPC `find_nearby_vehicles` que requiere que los drivers tengan `is_online=true` y `current_location` reciente. Si no hay drivers online, el mapa queda vacío sin feedback visual explicando por qué.
- **Corrección sugerida:** Mostrar texto "0 conductores cercanos" cuando nearbyVehicles.length === 0 durante searching.

### [BUG-F008] Inconsistencia canceled vs cancelled entre superficies
- **Archivo(s):** apps/web/src/app/track/[id]/page.tsx:194, apps/client/src/stores/ride.store.ts:233
- **Severidad:** 🟡 Medio
- **Categoría:** paridad
- **Explicación técnica:** Web check para terminal: `['completed', 'cancelled', 'canceled', ...]` (ambas grafías). Client FSM: solo `'canceled'`. DB enum: solo `'canceled'`. La web duplica el check innecesariamente, pero si algún código externo usara `'cancelled'`, solo la web lo detectaría.
- **Corrección sugerida:** Estandarizar a `'canceled'` (la grafía del enum DB) en todas las superficies.

### [BUG-F009] Client móvil: RideCompleteView no persiste si app se cierra
- **Archivo(s):** apps/client/src/components/RideCompleteView.tsx
- **Severidad:** 🟡 Medio
- **Categoría:** funcional
- **Explicación técnica:** Si el rider cierra la app después de completar el viaje pero antes de calificar, al reabrir no vuelve a ver la pantalla de rating. El `useRideInit` busca rides activos pero un ride `completed` no es "activo".
- **Corrección sugerida:** Almacenar `pendingReviewRideId` en AsyncStorage y mostrar la pantalla de review al reabrir.

## Bugs Bajos 🟢

### [BUG-F010] Web: cancelRide en tracking no deshabilita botón durante la request
- **Archivo(s):** apps/web/src/app/track/[id]/page.tsx:607-618
- **Severidad:** 🟢 Bajo
- **Categoría:** UX
- **Explicación técnica:** `setCanceling(true)` se ejecuta, pero si `cancelRide` lanza error, `setCanceling(false)` se ejecuta. Si tiene éxito, `canceling` nunca se resetea — queda `true` pero la UI se actualiza via realtime. Funcional pero no limpio.

### [BUG-F011] Web: review form no valida ride.driver_id antes de mostrar
- **Archivo(s):** apps/web/src/app/track/[id]/page.tsx (review section)
- **Severidad:** 🟢 Bajo
- **Categoría:** funcional
- **Explicación técnica:** Si un ride se completa sin driver asignado (edge case: cancelación por sistema), el review form se muestra pero submitReview fallará porque driver_id es null.

---

# AREA 2 — GEOLOCALIZACION

## Bugs Altos 🟠

### [BUG-F401] cuba_pois tabla no creada por migraciones
- **Superficie:** backend-supabase
- **Archivo(s):** scripts/import-cuba-pois.mjs (no hay migración SQL)
- **Severidad:** 🟠 Alto
- **Categoría:** datos
- **Explicación técnica:** La tabla `cuba_pois` es creada por el script de importación `import-cuba-pois.mjs`, no por una migración SQL. Esto significa: 1) no hay garantía de que la tabla exista en un fresh deploy, 2) no hay schema versionado, 3) un `supabase db reset` la destruiría.
- **Corrección sugerida:** Crear migración `00106_create_cuba_pois.sql` con el schema de la tabla, índices, y RLS. Mantener el script solo para data import.

### [BUG-F402] search_pois usa ILIKE sin índice GIN/pg_trgm para fuzzy search
- **Superficie:** backend-supabase
- **Archivo(s):** supabase/migrations/00092_search_pois.sql
- **Severidad:** 🟠 Alto
- **Categoría:** rendimiento
- **Explicación técnica:** El RPC `search_pois` usa `ILIKE '%query%'` en `name`, `name_normalized`, y `address`. Con 50K+ POIs, un ILIKE con wildcard al inicio NO puede usar índice B-tree — resulta en sequential scan. Sin índice GIN de pg_trgm, cada búsqueda escanea toda la tabla.
- **Corrección sugerida:** Crear índice GIN con pg_trgm: `CREATE INDEX idx_pois_name_trgm ON cuba_pois USING gin (name_normalized gin_trgm_ops);`. Ya pg_trgm está habilitada (migración 00001).

## Bugs Medios 🟡

### [BUG-F403] suggest_cross_streets no escapa caracteres ILIKE
- **Superficie:** backend-supabase
- **Archivo(s):** supabase/migrations/00093_suggest_cross_streets.sql
- **Severidad:** 🟡 Medio
- **Categoría:** funcional
- **Explicación técnica:** El RPC usa `ILIKE p_main_street || '%'` directamente. Si el usuario busca "100%" (calle con porcentaje en el nombre), el wildcard `%` en el input causa matches incorrectos.
- **Corrección sugerida:** Escapar `p_main_street` antes de concatenar wildcard: `ILIKE replace(replace(replace(p_main_street, '\', '\\'), '%', '\%'), '_', '\_') || '%'`.

### [BUG-F404] Web AddressAutocomplete: requests Mapbox no canceladas
- **Superficie:** web-client
- **Archivo(s):** apps/web/src/components/AddressAutocomplete.tsx
- **Severidad:** 🟡 Medio
- **Categoría:** rendimiento
- **Explicación técnica:** Usa `searchIdRef` para ignorar stale results pero NO usa AbortController para cancelar fetch requests en vuelo. Si el usuario tipea rápido, 5-10 requests a Mapbox Search Box API pueden estar en flight simultáneamente, consumiendo cuota de API.
- **Corrección sugerida:** Agregar AbortController que cancele la request anterior al iniciar una nueva.

### [BUG-F405] No hay validación de zona operativa antes de confirmar viaje
- **Superficie:** transversal
- **Archivo(s):** packages/api/src/services/ride.service.ts (createRide)
- **Severidad:** 🟡 Medio
- **Categoría:** funcional
- **Explicación técnica:** Aunque hay datos para toda Cuba, no hay validación de que pickup/dropoff estén dentro de zonas operativas activas. Un usuario podría solicitar un viaje de La Habana a Santiago (800km) sin restricción.
- **Corrección sugerida:** Agregar check de distancia máxima (ej: 50km) o validar contra tabla de `zones` activas.

## Bugs Bajos 🟢

### [BUG-F406] Nominatim fallback tiene latencia de 200-500ms sin timeout
- **Superficie:** web-client
- **Severidad:** 🟢 Bajo
- **Categoría:** rendimiento
- **Explicación técnica:** Si Mapbox falla y Nominatim es el fallback, no hay timeout configurado. En redes lentas, el autocomplete puede tardar 2+ segundos.

---

# AREA 3 — DRIVER APP

## Bug Crítico 🔴

### [BUG-F601] TripCompleteView se cierra automáticamente en 5s — driver no puede calificar
- **Superficie:** driver
- **Archivo(s):** apps/driver/src/components/DriverTripView.tsx:1114-1122
- **Severidad:** 🔴 Crítico
- **Categoría:** UX
- **Explicación técnica:** Idéntico a BUG-F005. `setTimeout(() => clearCompletedTrip(), 5000)` cierra la pantalla de resumen en 5 segundos. El requisito del usuario es que el driver vea resumen con ganancias y toque "Listo" manualmente.
- **Impacto en el usuario:** El driver completa un viaje. Aparece la pantalla con "₧2,125" de ganancia, desglose de comisión, y la opción de calificar al rider. Pero a los 5 segundos todo desaparece. El driver no calificó, no descargó el recibo, y está confundido.
- **Corrección sugerida:** Eliminar el setTimeout de línea 1117-1119. Mantener solo el botón "Listo" (línea 1282-1287) y el `onComplete` del RiderRatingSheet (línea 1276).
- **¿Bloquea producción?** SÍ — contradice requisito explícito del usuario.

## Bugs Altos 🟠

### [BUG-F602] Offline buffer flush se detiene en el primer batch que falla
- **Superficie:** driver
- **Archivo(s):** apps/driver/src/services/locationBuffer.ts
- **Severidad:** 🟠 Alto
- **Categoría:** funcional
- **Explicación técnica:** Si `bulkRecordRideLocations` falla en el primer batch de 20 puntos, el buffer pone los puntos de vuelta al frente y DEJA DE INTENTAR. Los puntos restantes (hasta 500) quedan en el buffer sin re-intento automático.
- **Impacto en el usuario:** Driver pierde señal en un túnel durante 10 minutos. Al reconectar, el primer batch falla por timeout. Los 60 puntos GPS del trayecto en el túnel NUNCA se envían al servidor. La distancia calculada del viaje será menor → tarifa menor.
- **Corrección sugerida:** Implementar retry con backoff: si el batch falla, esperar 5s y reintentar (máximo 3 intentos). Si sigue fallando, continuar con el siguiente batch.

### [BUG-F603] No hay indicador visual de reconexión
- **Superficie:** driver
- **Severidad:** 🟠 Alto
- **Categoría:** UX
- **Explicación técnica:** Cuando el driver pierde conexión, el `OfflineBanner` existe pero las suscripciones Realtime fallan silenciosamente. No hay "Reconectando..." visible durante la re-suscripción.
- **Corrección sugerida:** Agregar estado `isReconnecting` y mostrarlo en el OfflineBanner.

### [BUG-F604] Driver online status no se resetea al cerrar app
- **Superficie:** driver + backend
- **Severidad:** 🟠 Alto
- **Categoría:** funcional
- **Explicación técnica:** Si el driver cierra la app sin ponerse offline, `is_online` queda `true` en DB. El servidor no tiene heartbeat visible para detectar drivers fantasma. La edge function `cancel-stale-rides` cancela viajes pero no detecta drivers offline.
- **Impacto en el usuario:** El matching service envía solicitudes a drivers "online" que ya cerraron la app hace horas. Los riders ven "Buscando conductor..." sin que nadie responda.
- **Corrección sugerida:** Implementar heartbeat: el driver envía ping cada 60s. Si no hay ping en 3min, marcar `is_online=false` via pg_cron o edge function.

## Bugs Medios 🟡

### [BUG-F605] IncomingRideCard auto-accept: AsyncStorage load async con default false
- **Superficie:** driver
- **Archivo(s):** apps/driver/src/components/IncomingRideCard.tsx:136-142
- **Severidad:** 🟡 Medio
- **Categoría:** UX
- **Explicación técnica:** El default es `false` hasta que AsyncStorage carga. Si AsyncStorage tarda >100ms (posible en dispositivos viejos), la tarjeta se muestra sin countdown por un instante, luego aparece. Flash visible.
- **Corrección sugerida:** Agregar un breve loading state o delay de 200ms antes de renderizar la tarjeta.

### [BUG-F606] GPS accuracy no se envía al servidor en batch flush
- **Superficie:** driver
- **Archivo(s):** packages/api/src/services/location.service.ts:54-63
- **Severidad:** 🟡 Medio
- **Categoría:** datos
- **Explicación técnica:** El buffer incluye `accuracy` (BUG-082 fix), pero `bulkRecordRideLocations` no tiene parámetro `accuracy` en su interface ni lo inserta en la tabla. El dato se pierde en la serialización.
- **Corrección sugerida:** Agregar `accuracy?: number` al interface y al INSERT.

### [BUG-F607] Chat polling fallback no existe para driver
- **Superficie:** driver
- **Archivo(s):** apps/driver/src/hooks/useChat.ts
- **Severidad:** 🟡 Medio
- **Categoría:** realtime
- **Explicación técnica:** Si la suscripción Realtime de chat falla silenciosamente, no hay polling fallback. Los mensajes del rider no se reciben. Solo ride requests tienen fallback polling (30s).
- **Corrección sugerida:** Agregar polling cada 30s como fallback si no hay mensajes via realtime en 60s.

### [BUG-F608] Earnings milestone: todayKey comparison timezone-sensitive
- **Superficie:** driver
- **Archivo(s):** apps/driver/app/(tabs)/earnings.tsx
- **Severidad:** 🟡 Medio
- **Categoría:** funcional
- **Explicación técnica:** `todayKey` se genera con `toLocaleDateString('es-CU')` que depende del locale del dispositivo. Si el driver cambia zona horaria (ej: viaja), los milestones pueden mostrar/resetear incorrectamente.

## Bug Bajo 🟢

### [BUG-F609] Sonido new_request no se silencia con modo silencio del teléfono
- **Superficie:** driver
- **Severidad:** 🟢 Bajo
- **Categoría:** UX
- **Explicación técnica:** Los sonidos se reproducen via `playSound()` que usa Expo Audio. En iOS, respetar el switch de silencio requiere `playsInSilentModeIOS: false`, que no está configurado explícitamente.

---

# MATRIZ DE IMPACTO

| Bug | Sev. Técnica | Impacto Usuario | Frecuencia | Prioridad Fix |
|-----|-------------|----------------|-----------|--------------|
| F001 | 🔴 | Viajes cancelados innecesariamente | Alta (zonas con pocos drivers) | P0 |
| F002 | 🔴 | Tracking web sin RT | Siempre en web | P0 |
| F601 | 🔴 | Driver no puede calificar/ver ganancias | Siempre post-viaje | P0 |
| F003 | 🟠 | Polling duplicado | Cada cambio de status | P1 |
| F004 | 🟠 | Cancelación sin penalización | Cada cancel desde web | P1 |
| F005 | 🟠 | = F601 | = F601 | P0 |
| F006 | 🟠 | GPS duplicados | Al reconectar | P1 |
| F401 | 🟠 | POIs no disponibles en fresh deploy | Raro pero grave | P1 |
| F402 | 🟠 | Búsqueda lenta con 50K+ POIs | Cada búsqueda | P1 |
| F602 | 🟠 | GPS perdidos tras offline | En túneles/sótanos | P1 |
| F603 | 🟠 | Driver no sabe si está conectado | Tras caída de red | P1 |
| F604 | 🟠 | Drivers fantasma en matching | Cuando cierra app | P1 |

---

# VEREDICTO POR AREA

### Flujo de viaje: ❌ NO LISTO
- **Bloqueantes:** Search timeout no reintenta con radio mayor (F001), tracking web no es RT (F002)
- **Riesgo:** Riders en zonas con pocos drivers no podrán completar viajes

### Geolocalización: ✅ LISTO CON OBSERVACIONES
- **No bloqueante** pero necesita: migración para cuba_pois (F401) e índice GIN para performance (F402)
- La funcionalidad core (intersecciones cubanas, POIs, autocomplete) funciona correctamente

### Driver App: ❌ NO LISTO
- **Bloqueante:** TripCompleteView auto-close 5s impide calificar/ver ganancias (F601)
- **Alto riesgo:** Drivers fantasma (F604), buffer offline frágil (F602)

---

# PLAN DE REMEDIACION PRIORIZADO

## P0 — Bloquean producción (3 bugs)
1. **F001**: Implementar retry con radio expandido en search timeout
2. **F002**: Arreglar tracking web RT (broadcast o postgres_changes)
3. **F601/F005**: Eliminar auto-advance 5s en TripCompleteView

## P1 — Deben resolverse antes de launch (9 bugs)
4. **F003**: Limpiar polling duplicado en web track
5. **F004**: Pasar userId en cancelRide desde web
6. **F006**: Agregar dedup/constraint en bulkRecordRideLocations
7. **F401**: Crear migración para cuba_pois
8. **F402**: Crear índice GIN pg_trgm para POI search
9. **F602**: Retry con backoff en buffer flush
10. **F603**: Indicador visual de reconexión
11. **F604**: Heartbeat para detectar drivers offline
12. **F606**: Enviar accuracy GPS al servidor

## P2 — Pueden esperar post-launch (14 bugs restantes)
- F007, F008, F009, F010, F011, F403, F404, F405, F406, F605, F607, F608, F609
