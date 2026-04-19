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

## Apagar el modo demo

```
EXPO_PUBLIC_DEMO_MODE=false
# o simplemente remover la línea
```

Rebuild.

El código NO tiene branching complejo — todos los cambios leen
`DEMO_MODE` en cada llamada. Cuando está false, comportamiento idéntico
al original (pre-Brasil).
