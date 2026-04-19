# Modo Demo — probar la app fuera de Cuba

**Propósito:** permitir que el creador (vos) pruebe la app cliente en Brasil
(o cualquier otro país) sin romper con validaciones hardcodeadas a Cuba.
Está pensado para **testing visual y flujos end-to-end** — **NO** es un
modo de producción multi-país.

## Cómo activarlo

Agregar a un `.env` o directo en `app.json → extra`:

```
EXPO_PUBLIC_DEMO_MODE=true
EXPO_PUBLIC_DEMO_CITY=sao_paulo
```

Valores de `EXPO_PUBLIC_DEMO_CITY`:
- `sao_paulo` (default) → centro mapa Sao Paulo
- `rio` → centro Rio de Janeiro
- `brasilia` → centro Brasília
- `havana` → equivalente a tener el flag apagado (fallback Cuba)

Rebuild el APK tras el cambio (el flag es build-time, no runtime).

## Qué cambia cuando `EXPO_PUBLIC_DEMO_MODE=true`

| Componente | Comportamiento normal | Demo mode |
|---|---|---|
| Fallback del mapa (sin GPS) | La Habana (-82.37, 23.11) | Coords de la ciudad elegida |
| Prefijo teléfono en login | `🇨🇺 +53` bloqueado | Picker Cuba/Brasil seleccionable |
| Validación `isValidCubanPhone` | Estricta formato cubano | Acepta 7-15 dígitos cualquier país |
| Normalización teléfono | `normalizeCubanPhone` | Usa el dial code elegido |
| Banner persistente | (oculto) | Barra naranja arriba: "MODO DEMO · Sao Paulo" |

## Qué NO cambia

- El **backend** sigue siendo el Supabase de prod Cuba. Los rides creados
  en modo demo se insertan en la misma DB — se pueden filtrar después
  por device/user para borrarlos. **No usar con el account principal.**
- La **moneda** sigue siendo CUP. Los fares se muestran en CUP aunque
  estés probando en Brasil. Esto es intencional — el propósito es
  validar UX y flujos, no cálculos comerciales.
- Los **service types** siguen siendo los de Cuba (triciclo, moto,
  auto, mensajería). Un testeo Brasil real requeriría reconfigurar
  `service_type_configs`.
- **Matching de conductores**: no hay drivers en Brasil. Para testear
  el flujo completo client↔driver, el otro device tiene que correr
  el APK driver con el mismo flag + hacerse driver cuenta test.

## Activar en el APK de GitHub Actions

El workflow `.github/workflows/android-apk.yml` ya expone las
`EXPO_PUBLIC_*` vars en los steps de `Expo prebuild` y
`Build release APK`. Para un build demo:

1. Editar el workflow temporalmente (o agregar un paso):
   ```yaml
   env:
     EXPO_PUBLIC_DEMO_MODE: "true"
     EXPO_PUBLIC_DEMO_CITY: "sao_paulo"
   ```
2. Pushear + tag `client-v1.1.X-apk-demo` (o equivalente).
3. Cuando ya no se necesita el APK demo, revertir el cambio y tag
   normal.

## Archivos que implementan el flag

- `apps/client/src/config/demo.ts` — lee las env vars, expone constantes.
- `apps/client/src/components/DemoBanner.tsx` — barra naranja top.
- `apps/client/src/components/RideMapView.tsx` — usa `getDemoFallbackCoord()`.
- `apps/client/src/components/ConfirmLocationScreen.tsx` — idem.
- `apps/client/app/(auth)/login.tsx` — picker de dial code + validación permisiva.
- `apps/client/app/(auth)/verify-phone.tsx` — idem.
- `apps/client/app/_layout.tsx` — mounts `<DemoBanner>`.

## Apagar el modo demo — volver a Cuba

Para volver a APKs de producción Cuba, **simplemente usar tags
sin sufijo `-demo-apk`**:

```bash
# Build Brasil demo
git tag client-v1.1.7-demo-apk
git tag driver-v1.1.7-demo-apk
git push origin client-v1.1.7-demo-apk driver-v1.1.7-demo-apk

# Build Cuba prod (sin el sufijo -demo)
git tag client-v1.1.8-apk
git tag driver-v1.1.8-apk
git push origin client-v1.1.8-apk driver-v1.1.8-apk
```

El workflow (`.github/workflows/android-apk.yml`) detecta el sufijo
`-demo-apk` en `github.ref` y automáticamente:
- **Con sufijo `-demo-apk`**: `EXPO_PUBLIC_DEMO_MODE=true`, city `sao_paulo`.
- **Sin sufijo**: `EXPO_PUBLIC_DEMO_MODE=false`, behavior original Cuba.

NO hay ramas separadas, NO hay que tocar el `.env` manualmente, NO hay
código `if (isBrasil)` que se olvide de borrar. El mismo commit de
master produce APK demo o APK prod según el tag.

### Verificar qué mode está activo

En un APK instalado:
- **Demo mode ON**: barra naranja arriba "MODO DEMO · SÃO PAULO · NO PRODUCCIÓN" siempre visible.
- **Demo mode OFF**: sin barra, login directo con `🇨🇺 +53` bloqueado, mapa default Havana.

Si la barra naranja está, es demo. Si no, es prod.

### Qué hacer con los rides demo de testing en la DB

Los rides creados durante tests demo van al Supabase prod
(`lqaufszburqvlslpcuac`). No rompen nada (está el schema normal) pero
conviene limpiarlos. Sugerencia SQL:

```sql
-- Borrar rides creados durante test en Brasil (coords de São Paulo,
-- Rio, Brasília). Ajustar bounding box según necesidad.
DELETE FROM rides
WHERE pickup_lat BETWEEN -35 AND 5
  AND pickup_lng BETWEEN -75 AND -30
  AND created_at > NOW() - INTERVAL '48 hours';
```

Hacerlo ANTES de poblar datos reales en Cuba — así queda la DB limpia.

## Cambio de un lado a otro sin recompilar

No es posible — el flag es build-time (`EXPO_PUBLIC_*` vars se bakean
al bundle JS). Cada cambio entre demo y prod requiere tag + rebuild
APK + reinstalar. Tiempo total: ~20 min por APK.

**Workflow típico:**
1. Desarrollo en Brasil con APK demo instalado.
2. Cuando termino una feature, pusheo tag sin `-demo`, build de ~18 min.
3. Instalo APK prod Cuba en el mismo Samsung (desinstalar el demo primero por keystore).
4. Mando APK prod a Cuba para probar real.
