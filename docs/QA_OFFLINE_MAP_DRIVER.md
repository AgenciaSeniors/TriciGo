# QA — Mapa offline del conductor

Prueba en dispositivo del sistema de packs offline de `apps/driver`. Escrita al
cerrar #974, que corrigió el estilo con el que se descargan los packs.

**Cuándo correrla:** después de cualquier cambio en
`apps/driver/src/hooks/useDynamicOfflineMap.ts`, en `packages/utils/src/offlineRegion.ts`,
o en el estilo que renderiza `RideMapView`. También al validar un APK/OTA nuevo si el
mapa offline entra en el alcance.

## Por qué esta prueba está diseñada así

**El ambient cache hace pasar una prueba ingenua.** Mapbox mantiene dos cachés:

| | Qué es |
|---|---|
| **Packs offline** | Lo que descargamos a propósito: la celda completa (~13 km), zoom 10-16, protegida de que la borren. Es el sistema que se prueba acá. |
| **Ambient cache** | LRU automático de lo que el mapa ya pidió estando online. Siempre funciona, no lo controlamos. |

Si abrís el mapa sin señal en el lugar donde acabás de estar, vas a ver calles **aunque
los packs no sirvan para nada** — las está sirviendo el ambient cache. Ese fue
exactamente el estado previo a #974: los packs se bajaban para `light-v11` mientras el
mapa dibujaba `navigation-night-v1`, así que ni un tile era legible, y aun así el mapa
parecía andar donde el conductor venía circulando.

Los pasos 4 y 5 son los que separan una cosa de la otra. **Sin ellos la prueba no
prueba nada.**

## 0. Precondición

Un build del conductor con el cambio. Es JS puro: sirve OTA (`eas-update.yml`) o APK.

## 1. Conectar y mirar los logs

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb devices
& $adb logcat -c
& $adb logcat | Select-String "OfflineMap"
```

Dejar esa ventana abierta. Todo lo que sigue se confirma ahí.

## 2. Que descargue el pack (con señal)

Abrir la app con GPS activo, en La Habana, con datos. El hook consulta cada 30 s
(`POLL_MS`), así que puede tardar hasta medio minuto.

```
[OfflineMap] region cell_192_-687 ensuring pack
[OfflineMap] createPack cell_192_-687 ~852 tiles (z10-16)
```

**El número identifica qué código corre.** En celdas de La Habana el conteo correcto es
**~852**; antes de #974 era ~748. La diferencia son los tiles de `mapbox-traffic-v1` e
`mapbox-incidents-v1`, que `navigation-night-v1` agrega sobre el composite (topados en
z14). Si ves ~748, el build no tomó.

En un teléfono que ya tenía packs viejos aparece además la línea que **solo emite el
código nuevo**, y es la confirmación de que la migración corrió:

```
[OfflineMap] style changed — refreshing pack cell_192_-687
```

Esperar a que termine. Son 1-3 MB por celda (tiles medidos sobre La Habana: 1,3 KB a
z16, ~6 KB a z12; 748 posiciones × las fuentes del estilo).

## 3. Cortar la conectividad

Modo avión desde el teléfono. **No por adb**: hay que cortar datos y wifi de verdad.

## 4. La prueba real

```powershell
& $adb shell am force-stop app.tricigo.driver
```

Reabrir la app. El force-stop importa: sin él estarías mirando tiles que ya estaban
renderizados.

Ahora lo decisivo: **mover el mapa a una parte de la celda por donde no pasaste** — unos
kilómetros en cualquier dirección, sin salir de los ~13 km.

- **Se ven las calles** → las sirve el pack. El ambient cache no puede tener esa zona.
  Prueba superada.
- **Oscuro o vacío** → el pack no se está leyendo. Ver la tabla de abajo.

Que a zoom 17-18 se vea borroso es **esperado**: los packs llegan hasta z16
(`OFFLINE_PACK_MAX_ZOOM`) y arriba de eso Mapbox reescala.

## 5. Control negativo (no saltear)

Seguir alejándose hasta salir de la celda, más de ~13 km (`OFFLINE_GRID_DEG` = 0.12°).
**Ahí tiene que quedar oscuro y sin calles.**

Si se ve bien en todos lados, algo más está sirviendo tiles y la prueba es inconcluyente
— verificar que el modo avión esté realmente activo.

## 6. Diagnóstico

| Log | Qué significa |
|---|---|
| `no street data near <lat> <lng>` | Esa celda no tiene calles en la DB. Probar desde el centro de La Habana. |
| `resolve failed (best-effort)` | Falló la RPC `getOfflineRegionForPoint`. Backend, no el hook. |
| Ningún `[OfflineMap]` en 60 s | El hook no corre: sin fix de GPS, o `getOnlineStatus()` en false. |
| `createPack ~748 tiles` | Build viejo. |
| `evict LRU pack` | Normal si recorriste varias celdas: el presupuesto es `OFFLINE_MAX_TILES` = 5500, y a 852 por celda entran 6. |

## 7. Repetir desde cero

```powershell
& $adb shell pm clear app.tricigo.driver
```

Borra AsyncStorage (`@tricigo/offline-pack-meta`) y la base offline de Mapbox, así que
el próximo arranque descarga todo de nuevo. **Desloguea al usuario** — hace falta el OTP.

## Contexto

Un pack solo sirve tiles cuya **URL** coincida, y Mapbox sirve el `composite` de un
estilo desde un endpoint nombrado por su lista completa de tilesets. Por eso
`light-v11` y `navigation-night-v1` no comparten **ningún** tile pese a usar los dos
`mapbox-streets-v8`: la lista de light incluye `mapbox-bathymetry-v2` y eso cambia la
URL entera.

```
light-v11            /v4/…streets-v8,terrain-v2,bathymetry-v2/{z}/{x}/{y}.vector.pbf
navigation-night-v1  /v4/…streets-v8,terrain-v2/{z}/{x}/{y}.vector.pbf
```

`light-v11` y `dark-v11` **sí** resuelven a la misma URL, así que los packs del
pasajero sirven su mapa claro y su mapa oscuro por igual.
