# Testing GPS flows en Foz do Iguaçu con Mock Location

## Setup Lockito (10 min, una sola vez)

### 1. Habilitar developer mode (ya tenés)
- Settings → About phone → Build number (tap 7 veces)

### 2. Instalar Lockito
- Play Store: buscar "Lockito" (ícono naranja con ubicación)
- Permisos: Location (always allow), Notifications

### 3. Configurar Lockito como Mock GPS provider
- Settings → Developer options → "Select mock location app"
- Seleccionar **Lockito**

### 4. Verificar que TriciGo lo está leyendo
- Abrir TriciGo Driver con Lockito apagado → debería mostrar "GPS no disponible"
- Encender Lockito → debería ver tu posición simulada

---

## Coordenadas de test para Foz do Iguaçu

Todas reales, en Foz do Iguaçu (Paraná, Brasil — la zona donde estuviste testeando).

### Pickup point fijo
**Centro de Foz do Iguaçu — Avenida Brasil 525**
- **Lat:** `-25.5163`
- **Lng:** `-54.5854`

### Dropoff point fijo
**Vila A — Rua Pernambuco**
- **Lat:** `-25.5440`
- **Lng:** `-54.5950`
- **Distancia al pickup:** ~3.5 km
- **Tiempo estimado:** ~10 min

### Driver test points (4 escenarios)

| # | Caso | Lat | Lng | Distancia al pickup | Comportamiento esperado |
|---|------|-----|-----|---------------------|------------------------|
| 1 | **Lejos** (no allowed) | `-25.5040` | `-54.5780` | ~1,500 m | Tap "Llegué" → ERROR `too_far_for_bypass` |
| 2 | **Bypass zone** (rider tap) | `-25.5145` | `-54.5825` | ~330 m | Tap "Llegué" → cliente ve modal "¿Está acá?" |
| 3 | **At pickup** (auto allow) | `-25.5160` | `-54.5851` | ~50 m | Tap "Llegué" → status avanza directo |
| 4 | **At dropoff** | `-25.5440` | `-54.5950` | (3.5km del pickup, 0m del dropoff) | Tap "Llegué al destino" → status avanza |

### Driver presets para Lockito itinerary

**Itinerary 1: "Drive normal" (acercándose progresivamente)**
- Punto A: `-25.5040, -54.5780` (lejos)
- Punto B: `-25.5145, -54.5825` (bypass zone)
- Punto C: `-25.5160, -54.5851` (at pickup)
- Punto D: `-25.5440, -54.5950` (at dropoff)
- Speed: 30 km/h
- Total time: ~10 min

**Itinerary 2: "Stuck far" (driver no se mueve, simulamos fraude)**
- Single point: `-25.5040, -54.5780` (1.5km)
- Sin movimiento

---

## Step-by-step: cómo crear un Itinerary en Lockito

1. Abrir Lockito
2. Tap **+** (esquina superior derecha)
3. **Itinerary**
4. Long-press en el mapa para agregar waypoints (los 4 puntos arriba)
5. Set speed: 30 km/h (o lo que quieras)
6. Tap ▶ Play
7. Lockito empieza a mover el GPS automáticamente

Para parar y poner un punto fijo:
1. Tap "Joystick mode"
2. Drag el ícono al punto deseado
3. Tap "Set position"

---

## Test scenarios paso a paso

### Test 1: Happy path completo (driver llega normal)

```
1. Driver: abrir TriciGo Driver, toggle "Estoy disponible" → online
2. Cliente: abrir TriciGo, marcar:
   - Pickup: tap el mapa en Avenida Brasil → confirmar
   - Dropoff: marcar otro punto en Foz → confirmar
   - Tap "Solicitar Auto"
3. Driver: recibe oferta → "Aceptar"
4. Lockito: poner driver en punto #3 (-25.5160, -54.5851) — al pickup
5. Driver app: ver banner verde "✅ Llegaste al pasajero"
6. Driver tap "Llegué al pasajero" → status avanza ✓
7. Driver tap "Iniciar viaje" → status='in_progress'
8. Lockito: mover driver al dropoff (-25.5440, -54.5950)
9. Driver app: banner verde "✅ Llegaste al destino"
10. Driver tap "Llegué al destino" → "Finalizar viaje"
11. Cliente y driver ven completion screen
```

**Verificar en DB:**
```sql
SELECT * FROM ride_audit_log 
WHERE ride_id = (SELECT id FROM rides ORDER BY created_at DESC LIMIT 1)
ORDER BY at;
```

Esperado:
```
ride_created           → coordinates correctas
driver_accepted        → driver_id asignado
arrived_at_pickup      → distance_at_check_m: ~50
in_progress            
arrived_at_destination → distance_at_check_m: ~20
completed              → final_fare_cup correcto
```

### Test 2: Bypass del rider

```
1-3. Mismo setup
4. Lockito: punto #2 (-25.5145, -54.5825) — bypass zone (~330m)
5. Driver app: banner naranja "📍 Estás a 330m del pasajero"
6. Driver tap "Llegué al pasajero"
7. Driver: toast "Esperando al pasajero…"
8. Cliente: aparece modal "¿Tu conductor está acá?"
9. Cliente tap "Sí, lo veo"
10. Driver: re-tap "Llegué" → status avanza ✓
```

**Verificar:**
```sql
SELECT * FROM ride_audit_log WHERE ride_id = '...';
```
Esperado eventos: `gps_override_requested` (300m) → `gps_override_confirmed_by_rider` → `arrived_at_pickup` (300m, audit trail).

### Test 3: Driver fraude (lejos)

```
1-3. Mismo setup
4. Lockito: punto #1 (-25.5040, -54.5780) — 1.5km
5. Driver app: banner gris "📍 Estás a 1.5km del pasajero"
6. Driver tap "Llegué al pasajero"
7. Driver app: error toast "Estás a 1500m del pasajero. Acercate más para confirmar."
8. status NO avanza
9. Cliente: NO ve ningún modal (porque está fuera de bypass range)
```

**Verificar:** ride se queda en `driver_en_route` indefinidamente, NO advance.

### Test 4: GPS unavailable + rider consent

```
1-3. Mismo setup
4. Lockito: APAGAR (sin GPS)
5. Driver app: banner rojo "⚠️ GPS no disponible / [Avisarle al pasajero]"
6. Driver tap "Avisarle al pasajero"
7. Driver app: banner cambia a "⏳ Esperando respuesta del pasajero"
8. Cliente: aparece modal rojo "Conductor sin GPS"
9. Cliente tap "Continuar igual"
10. Driver app: banner verde "✓ El pasajero aceptó continuar sin GPS"
11. Driver puede avanzar status libremente sin proximity check
```

**Verificar:**
```sql
SELECT driver_gps_status, driver_gps_unavailable_at, rider_gps_consent_at
FROM rides WHERE id = '...';
```

Esperado: `driver_gps_status='rider_consented'`, ambos timestamps fillados.

### Test 5: GPS unavailable + rider cancela

```
1-7. Mismo que test 4
8. Cliente: aparece modal "Conductor sin GPS"
9. Cliente tap "Cancelar viaje"
10. Cliente: toast "Viaje cancelado sin cargo"
11. Driver: ride desaparece de su pantalla, vuelve a home
```

**Verificar:**
```sql
SELECT status, cancellation_reason FROM rides WHERE id = '...';
-- status='canceled', cancellation_reason='rider_refused_no_gps'
```

---

## Tips Lockito

- **Acelerar testing**: subir speed a 60 km/h en itineraries para que el viaje sea más rápido
- **Simular GPS jitter**: Lockito tiene "Random offset" — agrega ±X metros random a cada update (útil para testar bypass zone)
- **Pause itinerary**: tocar ⏸ para parar movimiento donde está, después ▶ continúa
- **Multiple devices**: si tenés un segundo dispositivo, podés simular el rider moviéndose también, pero no es necesario para nuestro testing

---

## Acceso a logs Metro durante el test

Mientras Lockito + Mock GPS está activo, **NO te alejás del WiFi del PC** así que ADB y Metro siguen funcionando normalmente. Vas viendo logs en `/tmp/driver-metro4.log` y `/tmp/client-metro3.log`.

Para vista live de los logs durante el test:

```bash
tail -f /tmp/driver-metro4.log | grep -E "ActiveTripMap|VehicleMarker|gps_status|Reconcile"
tail -f /tmp/client-metro3.log | grep -E "useDriverPosition|Watcher|gps_status|FareRefresh"
```

---

## Limpiar entre tests

Después de cada test, cancelá el ride si quedó colgado:

```sql
UPDATE rides 
SET status = 'canceled', canceled_at = now() 
WHERE customer_id = '<your_customer_id>' 
  AND status NOT IN ('completed', 'canceled');
```

Y resetear driver online:
```sql
UPDATE driver_profiles 
SET is_online = true, last_heartbeat_at = now() 
WHERE user_id = '<your_driver_user_id>';
```
