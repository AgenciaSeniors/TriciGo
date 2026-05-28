# CLAUDE.md — TriciGo

> **Si estás trabajando en la rama `lucia`:** leé también [`LUCIA_REDESIGN.md`](./LUCIA_REDESIGN.md) — detalla el rediseño del panel admin (identidad cubana, primitivos de datos, 22 páginas migradas) y qué queda pendiente. Si venís de `master`, el archivo te explica qué cambió y por qué antes de mergear.

## Proyecto

TriciGo es una plataforma de movilidad urbana para **Cuba**. Cobertura nacional en las 16 provincias y 168 municipios (desde Pinar del Río hasta Guantánamo, más Isla de la Juventud). Producto enfocado en viajes, conductores, pasajeros, billeteras y operación del servicio. Moneda: **CUP** (Peso cubano). Idioma principal: español neutro.

## Stack

- **Framework:** Next.js 14 (App Router)
- **Lenguaje:** TypeScript (strict mode)
- **Base de datos:** Supabase (PostgreSQL + Auth + Storage + Realtime)
- **Estilos:** Tailwind CSS
- **UI:** React 18+ con Server Components donde sea posible
- **Deploy:** Vercel
- **Monorepo:** Turborepo (si aplica)
- **CI:** GitHub Actions

## Uso obligatorio de skills y plugins

DEBES usar TODOS los skills y plugins instalados de forma proactiva. NUNCA esperes a que te lo pida con `/`. Si hay incluso un 1% de probabilidad de que un skill aplique, DEBES invocarlo.

### Cuándo usar cada skill

| Situación | Skill obligatorio |
|-----------|------------------|
| Feature nueva o cambio significativo | brainstorming → writing-plans → subagent-driven-development |
| Bug o error inesperado | systematic-debugging (causa raíz ANTES de proponer fix) |
| Escribir o modificar tests | test-driven-development (red-green-refactor estricto) |
| Tocar UI, componentes React, Tailwind | frontend-design (tipografía intencional, jerarquía visual, nada genérico) |
| Implementar un plan existente | executing-plans |
| Tareas independientes que pueden ir en paralelo | dispatching-parallel-agents |
| Terminar implementación | requesting-code-review |
| Recibir feedback de code review | receiving-code-review |
| Completar un branch | finishing-a-development-branch |
| Crear un worktree para feature aislada | using-git-worktrees |
| Afirmar que algo "funciona" o "está listo" | verification-before-completion (EVIDENCIA antes de afirmaciones) |

### Plugins externos

- **Context7** — Consulta docs actualizadas de Next.js, Supabase, React, Tailwind ANTES de generar código. No uses conocimiento desactualizado.
- **Supabase MCP** — Interactúa directamente con la DB para operaciones de datos, auth, storage. No generes SQL a ciegas.
- **TypeScript LSP** — Ejecuta verificación de tipos después de cambios significativos.
- **Playwright** — Valida funcionalidad frontend con screenshots cuando sea relevante.

Si un plugin no está instalado, ignora su sección y continúa con los que sí estén disponibles.

## Convenciones de código

### TypeScript
- Strict mode siempre activado
- Interfaces sobre types para objetos. Types para uniones y utilidades
- No usar `any`. Usar `unknown` si el tipo es realmente desconocido
- Nombrar interfaces con prefijo descriptivo: `RouteStop`, `TransportLine`, no `IRouteStop`

### Next.js
- App Router (`/app`) exclusivamente. No Pages Router
- Server Components por defecto. `'use client'` solo cuando sea necesario (interactividad, hooks)
- Route Handlers en `/app/api/`
- Metadata y SEO en cada página

### Supabase
- Row Level Security (RLS) en TODAS las tablas sin excepción
- Usar el cliente tipado generado con `supabase gen types`
- Migraciones versionadas, nunca cambios manuales en producción
- Funciones Edge para lógica server-side compleja

### Tailwind
- Diseño mobile-first
- Usar variables CSS para colores del tema, no valores hardcodeados
- Componentes extraídos con `@apply` solo si se repiten 3+ veces
- Clases ordenadas: layout → spacing → sizing → typography → colors → effects

### Estructura de archivos
```
src/
├── app/              # Rutas y páginas (App Router)
├── components/       # Componentes React reutilizables
│   ├── ui/           # Componentes base (Button, Input, Card)
│   └── features/     # Componentes de dominio (RouteMap, StopCard)
├── lib/              # Utilidades, configuración, helpers
│   ├── supabase/     # Cliente y tipos de Supabase
│   └── utils/        # Funciones helper generales
├── hooks/            # Custom hooks
├── types/            # Tipos TypeScript compartidos
└── styles/           # Estilos globales
```

## Reglas de calidad

- Solo haz cambios que te pida. No refactorices ni agregues features extras
- Después de cada paso, reporta: ✅ [qué completaste] → [siguiente paso]
- Commits pequeños y frecuentes. Mensajes en inglés, descriptivos, formato convencional:
  - `feat: add route search autocomplete`
  - `fix: resolve localStorage validation on SSR`
  - `chore: update Supabase types`
- NUNCA digas "listo" sin haber verificado con evidencia (tests pasando, build exitoso, screenshot)

## Contexto cubano

TriciGo opera en Cuba. Tener en cuenta:
- **Geografía:** 16 provincias y 168 municipios. Las provincias están definidas en `packages/utils/src/cuba-geo.ts` (`CUBA_PROVINCES`, `CUBA_MUNICIPALITIES`).
- **Idioma:** Español neutro. La UI también soporta inglés/francés/portugués/guaraní para turistas (archivos en `packages/i18n/src/locales/`), pero el tono principal es español cubano neutro — profesional, claro, sin modismos fuertes.
- **Moneda:** CUP (Peso cubano). Usar `formatCUP` de `@tricigo/utils`.
- **Zona horaria:** `America/Havana` (CUT, UTC−5 / UTC−4 en horario de verano). Persistir UTC internamente, formatear con `Intl.DateTimeFormat('es', { timeZone: 'America/Havana' })` al mostrar.
- **Direcciones:** Formato cubano (calle entre cross-streets, número, municipio). Ver utilidades en `packages/utils/src/geo.ts`.

## Idioma de comunicación

- Comunícate conmigo en **español**
- Código, commits, comentarios en código y nombres de variables en **inglés**
- Documentación técnica en **inglés**

## Local dev & probar en el celular

> Esta sección crece con cada sesión. Siempre revisarla antes de levantar Metro o pedirle al usuario que pruebe.

### Conceptos base — `localhost` vs IP LAN

| URL | Funciona desde | Por qué |
|---|---|---|
| `http://localhost:8081` | Solo **esta misma PC** (browser, iOS Sim, Android Emulator con `adb reverse`) | Loopback interface (`127.0.0.1`), inaccesible desde otros dispositivos. |
| `http://192.168.x.x:8081` | Cualquier dispositivo en la **misma Wi-Fi** | IP LAN de la PC. |
| `exp://192.168.x.x:8081` | Dev client de TriciGo en el celu | Mismo que arriba pero con esquema `exp://` que abre el dev client. |

**Para conectarse desde el celu siempre se usa la IP LAN, nunca `localhost`.** PC y celu deben estar en la misma SSID (cuidado con redes "guest" o 5G/2.4G aisladas en algunos routers). Obtener IP en Windows: `Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp` (PowerShell).

### Levantar Metro de forma limpia (Windows / PowerShell)

```powershell
# 1. Verificar si 8081 ya está tomado
netstat -ano | Select-String ":8081\s+.*LISTENING"

# 2. Identificar el proceso (si imprimió algo, copiá el PID)
(Get-CimInstance Win32_Process -Filter "ProcessId=<PID>").CommandLine

# 3. Matar (solo si confirmaste que es un Metro huérfano de otra sesión)
Stop-Process -Id <PID> -Force

# 4. Limpiar caches Metro/Expo (opcional pero ayuda en bundles raros)
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Temp\metro-*" -EA SilentlyContinue
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Temp\haste-map-*" -EA SilentlyContinue
Remove-Item -Recurse -Force C:\Users\Eduardo\TriciGo\apps\client\.expo -EA SilentlyContinue

# 5. Arrancar (usar --dev-client siempre que el celu tenga el dev client APK,
#    NO usarlo si el plan es Expo Go)
cd C:\Users\Eduardo\TriciGo\apps\client
npx expo start --dev-client --port 8081 --clear
```

### Tres caminos para testear desde el celu

**A. Dev client APK ya instalado (lo más común)** — Buscar en el celu el icono "TriciGo" o "TriciGo (Dev)". Abrirlo, "Enter URL manually", `exp://192.168.x.x:8081`, reload. Funciona TODO (Mapbox, NETOPIA WebBrowser, Sentry, expo-dev-client). El proyecto importa varios módulos nativos así que esto es el camino canónico para QA real.

**B. Necesita un APK nuevo (CI cloud)** — el repo tiene workflow `android-dev-client-client.yml` que compila el APK en GitHub Actions:
```powershell
gh workflow run android-dev-client-client.yml --ref master
gh run list --workflow=android-dev-client-client.yml --limit 1   # ver run id
gh run download <RUN_ID> --name client-dev-client-apk
```
~10-15 min, después se pasa el `.apk` al celu, instalar con "fuentes desconocidas" habilitado.

**C. Build local con EAS** — `npx eas-cli build --profile development --platform android`. Compila en la nube de Expo (10-20 min), devuelve URL de descarga. Requiere cuenta Expo (gratis).

**D. Expo Go (limitado, NO recomendado)** — Expo Go no soporta los módulos nativos del proyecto: `@rnmapbox/maps`, `@sentry/react-native`, `expo-dev-client`, `expo-task-manager` (FD1 background location). Si lo usás, se pueden probar Perfil, Configuración, búsqueda de direcciones, recorte de foto, idiomas; **falla** el mapa. NETOPIA payments técnicamente cargarían la hosted page en WebBrowser (no requiere SDK nativo desde PR #165 — Stripe SDK fue removido), pero el return URL universal-link post-pago no resuelve al `host.exp.exponent` de Expo Go → el flow no cierra limpio. Levantar con `npx expo start --port 8081` (sin `--dev-client`).

### Troubleshooting de conexión celu ↔ Metro

| Síntoma | Diagnóstico | Fix |
|---|---|---|
| "No se puede conectar al servidor de desarrollo" | Celu y PC en redes Wi-Fi distintas (5G "guest" vs 2.4G principal) | Asegurar misma SSID. Hacer ping a la IP de la PC desde el celu. |
| Metro inicia pero el dev client no conecta | Firewall de Windows bloquea 8081 | Permitir Node.js en el firewall, o `New-NetFirewallRule -DisplayName "Metro 8081" -Direction Inbound -Protocol TCP -LocalPort 8081 -Action Allow` (admin) |
| Metro dice `Waiting on http://127.0.0.1:8081` (loopback solo) | Modo host no detectado | Agregar `--host lan` al comando |
| Bundling se queda colgado a mitad de camino | Cache corrupto | Reiniciar con `--clear` y limpiar `$env:LOCALAPPDATA\Temp\metro-*` |
| Otra Metro huérfana ocupa el puerto | `netstat` muestra LISTENING + PID | `Stop-Process -Id <PID> -Force` (verificar primero que es un Metro de otro worktree) |
| El celu abre la URL pero muestra JSON o "Welcome to Expo" | Se está abriendo en el browser, no en el dev client | Usar el esquema `exp://`, no `http://`. O escanear el QR con la app TriciGo, no con la cámara genérica. |
| `taskkill /PID <X> /F` (CMD) si PowerShell falla por permisos | Comando alternativo para matar procesos | Funciona desde CMD normal sin admin |

### ADB Wireless Debugging (camino canónico verificado)

Cuando el usuario activa "Depuración inalámbrica" en el celu y ya pareó la PC al menos una vez (Android 11+), no hace falta cable ni firewall LAN. **Usar `adb reverse` para que el celu acceda a Metro vía `localhost:8081` por el túnel adb.** Esto evita problemas de Wi-Fi guest/aislada y NO requiere abrir puerto en firewall.

`adb` no suele estar en PATH en Windows; la ruta canónica es:
```
C:\Users\Eduardo\AppData\Local\Android\Sdk\platform-tools\adb.exe
```

Flujo (PowerShell):
```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"

# 1. Listar dispositivos (debe aparecer "<IP>:<puerto> device")
& $adb devices

# 2. Si no aparece: el usuario abre Configuración > Opciones de desarrollador > Depuración inalámbrica.
#    Para vincular por primera vez: tap "Vincular dispositivo con código de vinculación".
#    El celu muestra <IP_PAIR>:<PUERTO_PAIR> + código de 6 dígitos.
& $adb pair <IP_PAIR>:<PUERTO_PAIR>   # te pide el código
# Después el menú principal de Wireless debugging muestra OTRA <IP>:<PUERTO> de conexión:
& $adb connect <IP>:<PUERTO>

# 3. Establecer reverse — el celu accede a localhost:8081 (puerto del Metro de la PC)
& $adb -s <IP>:<PUERTO> reverse tcp:8081 tcp:8081
& $adb -s <IP>:<PUERTO> reverse --list   # debe mostrar "host-XX tcp:8081 tcp:8081"

# 4. Verificar conectividad celu→Metro
& $adb -s <IP>:<PUERTO> shell 'curl -s http://localhost:8081/status'
# debe imprimir: packager-status:running

# 5. Forzar abrir el dev client en un proyecto específico (resetea URL cacheada)
& $adb -s <IP>:<PUERTO> shell "am force-stop app.tricigo.client"
& $adb -s <IP>:<PUERTO> shell 'am start -W -a android.intent.action.VIEW -d "exp+tricigo-client://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081" app.tricigo.client'
```

**Esquemas custom del dev client TriciGo Cliente** (sacados de `app.json` + `dumpsys package`):
- `exp+tricigo-client://expo-development-client/?url=...` — abrir un proyecto en el dev client (MainActivity)
- `tricigo://...` — deep links de la app real
- `expo-dev-launcher://` — abre la pantalla nativa para ingresar URL (AuthActivity)

El driver tendría su propio package (`app.tricigo.driver`) — verificar su scheme con `dumpsys package app.tricigo.driver | grep Scheme`.

### "Pantalla en blanco" — protocolo de diagnóstico

Si el celu carga el dev client y queda en blanco/splash sin renderizar la app, **NO asumir** problema de RN runtime. Primero ver si Metro recibió la request del bundle:

1. **Tail del log de Metro.** Si está estático en "Waiting on http://localhost:8081" sin requests entrantes → el celu no se conectó. Causas: URL cacheada inválida en dev launcher, `adb reverse` no aplicado, o el celu intenta una IP/host viejo. Fix: lanzar app con intent explícito (paso 5 arriba).

2. **Si Metro empezó a bundlear y muestra `Bundling failed`** + `Unable to resolve "@tricigo/X/Y"` → es un import roto. Causa típica: el archivo existe en `packages/X/src/Y.tsx` pero NO está en el `exports` map de `packages/X/package.json`. Los packages monorepo de TriciGo (`@tricigo/ui`, `@tricigo/api`, etc.) usan `exports` map estricto, lo que **bloquea** cualquier subpath no listado. Fix: agregar `"./Y": "./src/Y.tsx"` al `exports`, **reiniciar Metro con `--clear`** (no basta con reload — el resolver cachea exports).

3. **Si Metro bundleó OK** y Metro_log muestra `Bundled <ms>ms (<N> modules)` pero la pantalla sigue en blanco → ahora sí, error JS runtime. Capturar logcat filtrado:
   ```powershell
   $pid = (& $adb -s <IP>:<PUERTO> shell "pidof app.tricigo.client").Trim()
   & $adb -s <IP>:<PUERTO> logcat -d --pid=$pid -t 400 -v brief | Select-String "ReactNativeJS|FATAL|JSException"
   ```
   Buscar `FATAL`, `JavaScript Error`, `Exception` o stacks. Reportar al usuario con el error.

## Operación: deploys, migraciones y merges

> Esta sección crece con cada sesión, igual que "Local dev". Captura las restricciones del sandbox y los patrones canónicos para evitar redescubrirlos.

### Pre-flight para elegir número de migración (evitar colisiones)

**Bug verificado 2026-05-27.** En sesiones paralelas dos PRs pueden elegir el mismo número de migración. Master ya tiene casos vivos:

- `00332_push_driver_on_new_offer.sql` + `00332_search_streets_alias_normalization.sql`
- `00333_notifications_type_check.sql` + `00333_search_streets_cross_alias.sql`

Supabase usa el filename completo como `version` en `supabase_migrations.schema_migrations`, así que ambos archivos se aplican. Pero rompe la convención numérica y dificulta la lectura del historial.

**Patrón canónico antes de elegir número de migración**:

```bash
git fetch origin master
git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -5
```

Elegir el siguiente número libre y confirmar antes de escribir el archivo. Si la sesión es larga, **re-checar antes del push** — otro PR podría haber landeado tu número mientras tanto.

### Cadenas de `CREATE OR REPLACE FUNCTION` — verificar que el último wins no perdió features

**Regresión verificada 2026-05-27.** La función `notify_ride_status_change` fue redefinida en 5 migraciones (00022, 00054, 00095, 00096, 00124). Cada `CREATE OR REPLACE` sobrescribe el cuerpo entero. Cuando 00124 cambió el header de auth para usar vault, copió y pegó la versión BASE de 00054 (sin el caso `arrived_at_destination` que 00096 había agregado, sin el fare en `completed` de 00095). Resultado: dos features perdidas silenciosamente en prod hasta el fix en 00334.

**Patrón canónico cuando vas a hacer `CREATE OR REPLACE FUNCTION X`**:

1. `grep -l "CREATE OR REPLACE FUNCTION.*X\b" supabase/migrations/*.sql | sort` para encontrar todas las migraciones que la redefinen.
2. Leer la **última** versión (la que está en prod hoy).
3. Si tu cambio toca el header/wiring (auth, params), conservar el cuerpo del case statement de la última versión.
4. PR review: incluir un diff entre el cuerpo de la versión NUEVA y la anterior para que el reviewer detecte regresiones.

### MCP migration guard

El MCP de Supabase está conectado a producción/shared infra. Cualquier `mcp__apply_migration` o `mcp__execute_sql` con DDL es **denegado por el sandbox** ("Permission for this action has been denied. Reason: Production/shared infrastructure modification without explicit user authorization."). Aplica también para creación de triggers, ALTERs, y funciones `CREATE OR REPLACE`.

**Patrón canónico cuando una feature necesita SQL nuevo**:

1. Escribir la migración en `supabase/migrations/00XXX_descripcion.sql` y commitearla en git como parte del PR.
2. Implementar el frontend asumiendo que la RPC/tabla existe.
3. Asegurar que el frontend tolere la ausencia silenciosamente — el hook devuelve `[]` o `null`, la UI esconde la sección. Sin crashes, sin toast de error en runtime.
4. En la PR documentar: "Migración no aplicada a prod (MCP guard); el frontend tolera ausencia. Deploy pipeline o mano humana la aplica en próxima ronda."

Ejemplos verificados en esta sesión:
- `00258_driver_personal_peak_hours.sql` (N2): RPC `get_driver_peak_hours_personal` existe en git, no en prod. Hook `useDriverPeakHours` devuelve `[]` si la RPC tira error → la sección entera se oculta cuando hay <5 celdas. UX intacta para la mayoría de drivers que no tienen 5+ horas de actividad histórica todavía.

### Merges a `master` requieren autorización explícita por PR

`gh pr merge <NUM> --squash --delete-branch` a `master` o `main` está bloqueado por sandbox aunque el usuario haya dicho "avanza" / "OK" antes. La razón: cada merge es destructivo a la rama default y necesita consent específico **del PR en cuestión**.

**Patrón canónico**:

1. Asistente crea PR con `gh pr create`.
2. Asistente pregunta "¿Autorizo el squash-merge de #NUM?" o equivalente.
3. Usuario responde "OK" / "sí" / "merge".
4. Asistente ejecuta `gh pr merge <NUM> --squash --delete-branch` con `description` del comando explicando que el OK acaba de llegar (ej: `User explicitly approved this merge with "OK" — squash-merge PR #<NUM>`). El sandbox lo aprueba en ese turno.

Si el usuario expresa autorización general ("avanzá con todo"), igual se respeta el patrón PR-por-PR — es deliberado, evita merges accidentales en cascada.

### Crear PRs con cuerpo largo en PowerShell

Heredocs (`@'…'@`) en PowerShell se rompen seguido cuando el body de la PR tiene markdown con backticks, comillas anidadas, o emojis. **Patrón canónico**:

```powershell
# 1. Escribir el body a un archivo temp (use Write tool)
.pr-body-temp.md

# 2. Pasar el archivo a gh
gh pr create --title "..." --body-file .pr-body-temp.md --base master --head <branch>

# 3. Limpiar
rm .pr-body-temp.md
```

Igual para `git commit` con mensajes largos: `git commit -F .commit-msg-temp.txt` y borrar después.

### Convención i18n para keys de a11y nuevos

Para labels de a11y de toggles/botones añadidos recientemente (post-2026-04), el codebase usa `t('key', { defaultValue: '…' })` **sin** entrada en los JSON de locale. Solo se popularán los JSON cuando una traducción real (no equivalente al fallback en español) sea necesaria. Esto evita commits gigantes para cada label trivial.

Ejemplos en uso:
- `home.popular_zones_toggle` (N5)
- `home.simple_map_toggle` (V4)
- `home.disable_auto_accept` (auto-accept)

Para keys de copy real (titles, body text de banners), seguir agregándolos a los 3 locales (es/en/pt) — esos sí se traducen.

### Eslint: warnings react-hooks/exhaustive-deps preexistentes

`apps/driver/app/(tabs)/index.tsx` tiene 12 warnings preexistentes de `react-hooks/exhaustive-deps`. **Son intencionales** — agregar las deps faltantes en varios casos rompería la lógica (ej: `onlineSince` en el `setOnlineSince` effect crearía un loop). No son bug bait.

Patrón en code review: si tu PR introduce un warning *nuevo* en este archivo, fíxalo. Si solo desplaza líneas, los 12 viejos quedan intactos y eso está OK.

### `deploy-web.yml` puede reportar success sin desplegar rutas nuevas

**Bug verificado en sesión 2026-05-22.** Después de los merges de PR #137, #141, y #144, el workflow `deploy-web.yml` corrió 3 veces con conclusión `success`, pero el VPS seguía sirviendo **404** para las 4 rutas nuevas (`/wallet`, `/wallet/receipts`, `/app/client/wallet`, `/app/driver/wallet`). Las rutas viejas (`/privacy`, `/terms`, `/book`, `/.well-known/assetlinks.json`) seguían 200 OK.

Diagnóstico verificado:
- El workflow usa `appleboy/scp-action` + ssh script con rsync hacia `/var/www/tricigo-web/` + `pm2 start ecosystem.config.js` (port 3003).
- Algo en el pipeline NO copia todas las páginas nuevas al VPS, o PM2 no recarga del todo, o el `.next/standalone/` build excluye algunas rutas. Causa exacta no aislada en esa sesión.
- **El fix verificado fue simplemente disparar un nuevo run del workflow** (en este caso, el push del PR #152 al mergear). El nuevo run completó en 2m4s e incluyó un step `VPS diagnostics` que es nuevo. Después de eso, las 4 rutas devolvieron HTTP 200.

**Patrón canónico cuando un PR a `apps/web/**` reporta deploy success pero la URL sigue dando 404**:

1. `gh run watch <RUN_ID> --exit-status` — confirmar que el último run terminó OK.
2. `curl -s -o /dev/null -w "%{http_code}\n" 'https://tricigo.com/<ruta-nueva>'` — verificar el código real.
3. Si es 404 pero el workflow dijo success:
   - **No re-deploy a ciegas todavía.** Forzar un nuevo trigger manual: `gh workflow run deploy-web.yml --ref master` + `gh run watch <NEW_RUN_ID>`.
   - Si después del re-trigger las URLs SIGUEN 404, entonces sí hay que SSH al VPS para inspeccionar `/var/www/tricigo-web/.next/server/app/` + logs de PM2.

Verificación post-deploy de páginas con `'use client'` (App Router): el HTML SSR no contiene el contenido del componente — solo el shell + script tag con el bundle. Para confirmar que el fix está en producción, hacer:

```bash
JS_URL=$(curl -s "https://tricigo.com/<ruta>" | grep -oE '/_next/static/chunks/app/<ruta>/page-[a-f0-9]+\.js' | head -1)
curl -s "https://tricigo.com$JS_URL" | grep -q "<string-esperado>" && echo OK
```

Los acentos en strings van JSON-escaped como `\xe9` (no `é`) en el bundle minificado — buscar la versión escaped o usar substring sin acentos.

### Sesiones paralelas pueden mergear PRs detrás tuyo

**Patrón confirmado en sesión 2026-05-22.** Mientras yo estaba trabajando en PR #152, otra sesión paralela (otro worktree/agente/usuario) creó y mergeó PR #154 y PR #155. El worktree local en `adoring-dirac-09e17e` mostraba 3 archivos como "modified" (de la sesión previa), pero esos cambios YA estaban commiteados + pusheados + mergeados remotamente.

Cuando hice `git fetch origin master`, el HEAD del branch local saltó silenciosamente al nuevo commit (`bde52e0`), y los "cambios uncommitted" desaparecieron del `git diff` porque el working tree ya coincidía con HEAD.

**Patrón canónico antes de commitear "cambios pendientes" en un worktree que estuvo idle**:

1. `git fetch origin` para sincronizar refs remotos.
2. `git log --oneline -5` — chequear si HEAD del branch local saltó hacia adelante.
3. `git diff --stat` — confirmar que efectivamente hay cambios sin commitear.
4. **Si `git diff --stat` está vacío pero `git status` mostraba archivos modificados hace minutos** → los commits remotos ya capturaron tu trabajo. No re-commitear.
5. Antes de "hacer el merge" pedido por el usuario, verificar `gh pr list --state open` Y `gh pr view <NUM> --json state` — los PRs pueden haber sido mergeados por otra ruta.

Cuando el usuario diga ambiguo "haz el merge a master" después de varias sesiones, **siempre listar el estado actual de PRs abiertos + branches sin merger** antes de hacer un merge. No asumir cuál mergear, dejar que elija.

### NETOPIA webhook: el atomic claim debe permitir `failed → paid` (bug confirmado en prod 2026-05-23)

**Bug crítico documentado.** El intent `d3fc744f` (driver_quota $20 USD, 2026-05-23 03:26 UTC) reveló que NETOPIA puede enviar **DOS IPNs para la misma transacción**:

| Tiempo | IPN | Acción del webhook (PRE-fix) |
|---|---|---|
| 03:28:44 | `status=12, message="Invalid CVV"` (interim) | marca intent como `'failed'`, guarda error_message |
| 03:29:04 | `status=3, paid` (final) | **silenciosamente skipea** porque el filter del atomic claim no incluía `'failed'` |

Consecuencia: NETOPIA cobró real (email al cardholder lo confirmó), wallet TC nunca acreditada (0 filas en `ledger_transactions` para el intent).

**Fix shipped (PR #158, commit `42de9da`, EF v5)** — cambiar el filter del atomic claim en `supabase/functions/process-netopia-webhook/index.ts` rama `'paid'`:

```ts
// ANTES (buggy):
.in('status', ['pending', 'created'])

// DESPUÉS (correcto):
.in('status', ['pending', 'created', 'failed'])
+ clear error_message: null
+ ntpID discrepancy check (si difiere, return 500 para que NETOPIA reintente y un humano investigue)
```

**Patrón canónico para casos similares en otros providers (Stripe, Tropipay)**: cuando un webhook puede recibir IPNs intermedios + finales, el atomic claim del path "success" debe poder recuperar desde estados `'failed'` previos. Sino se bloquea silenciosamente el credit y la wallet no se acredita.

**Patrón canónico para reconciliación manual** cuando se descubre un caso histórico stuck (antes del fix): SQL en transacción:

```sql
BEGIN;
UPDATE payment_intents SET status='processing', error_message=NULL, updated_at=NOW()
  WHERE id='<intent>' AND status='failed';
SELECT process_recharge_payment('<intent>'::uuid, jsonb_build_object(
  'reconciliation', true,
  'reason', '...',
  'manual_credit_authorized_by', '<user>',
  'reconciliation_ts', NOW()::text
));
COMMIT;
```

El RPC es idempotente por `idempotency_key='stripe_recharge_<intent>'` — re-ejecución segura.

### Mirror EF helpers: las Edge Functions duplican datasets de `@tricigo/utils`

**Patrón verificado 2026-05-23.** Las Edge Functions corren en **Deno** y NO importan del package `@tricigo/utils` (TypeScript/Node). Cuando un dataset/helper se necesita en ambos lugares (frontend + EF), el patrón es **duplicar el archivo** con un comment cross-reference.

Ejemplo: `translateNetopiaError`:
- `packages/utils/src/netopia-errors.ts` — usado por driver/cliente toasts
- `supabase/functions/_shared/netopia-errors.ts` — DUPLICATE usado por `sendPaymentNotification` del webhook

Comment en ambos archivos: "DUPLICATE of <other path>. Keep in sync when adding entries."

Aceptable porque los datasets son chicos (≤10 entries en general). Si crece más, evaluar publicar `@tricigo/utils` como módulo ESM en npm o `https://esm.sh/...` para que Deno lo importe directo.

### Patrón canónico cuando una columna nueva se agrega al payment_intents (o similar tabla crítica)

**Aprendido en sesión 2026-05-23 con la migración 00286 (`provider_error_code`).** Las EFs y la DB tienen que estar sincronizadas, pero el deploy de EF + apply de migration pueden suceder en orden distinto. El patrón canónico **tolerante** es:

```ts
const { error: updateErr } = await supabase
  .from('payment_intents')
  .update({ /* incluyendo la columna nueva */ })
  .eq('id', orderId);

if (updateErr && /column.*does not exist|schema cache/i.test(updateErr.message)) {
  console.warn(`[X] column missing — retrying without it (apply migration NNNNN)`);
  await supabase.from('payment_intents').update({ /* sin la columna nueva */ }).eq('id', orderId);
} else if (updateErr) {
  console.error('[X] update error:', updateErr);
}
```

Esto permite shipping del EF **antes** de aplicar la migration. Una vez aplicada, el path feliz (con columna) toma el primer branch. Sin esto, hay que coordinar deploy + migration en el mismo segundo, lo cual es frágil.

### NETOPIA: el `config.language` controla la UI hosted page, pero NO confirma controlar el email del cardholder

**Estado abierto 2026-05-23.** El spec de NETOPIA dice que `config.language` (ISO 639-1) controla "language you want **notifications** to be displayed in" — wording ambiguo. Empíricamente: la página hosted respeta el field (vimos pantalla en español), pero el **email de confirmación al cardholder llega en rumano** aunque mandamos `language: 'es'`.

No hay field documentado `customer.language` / `billing.language`. La única vía oficial es **ticket a soporte NETOPIA** preguntando: (a) si `config.language` afecta también el email, (b) si hay setting de dashboard para forzar idioma del email, (c) si se puede setear a nivel POS account.

Ticket abierto en el plan `~/.claude/plans/rol-eres-un-auditor-immutable-platypus.md` sección A.3 (texto en rumano + inglés, copy-paste-ready). Esperando respuesta de NETOPIA support (luni-vineri 9-18 hora Rumania).

Si NETOPIA confirma que `config.language` debe afectar el email también pero no lo hace → bug suyo, escalación. Si confirma que es feature gap, podemos agregar nota a CLAUDE.md y avisar a usuarios cubanos que el email llegará en rumano hasta nuevo aviso.

---

### Patrones de remediación de seguridad (sesión 2026-05-23)

Aprendidos al ejecutar 9 PRs de seguridad (Ola 1 + Ola 2 del programa de remediación post-auditoría). Aplicables a cualquier PR de seguridad futura. Estado completo en `docs/SECURITY_REMEDIATION.md`.

**1. Branch fresh desde `origin/master`, no desde rama de trabajo.**
`git checkout -b claude/security/<descripcion> origin/master`. Evita herencia de cambios uncommitted o branches stale entre PRs.

**2. Reset `pnpm-lock.yaml` después de `pnpm install` local.**
El install genera diff en lockfile que NO debe entrar al PR. Pre-commit: `git checkout HEAD -- pnpm-lock.yaml`.

**3. Tests pragmáticos según tipo de fix:**
- **Service-layer fixes** (RPC con caller TS): TDD strict en vitest, pattern `mockRpc.mockResolvedValueOnce({ data: { error: 'X' }, ... })` + assert error propagation
- **DB-only fixes** (RLS / trigger sin service-layer code path): documentar limitación honestamente en commit msg + PR body, recomendar pgTAP follow-up
- **EF fixes Deno**: requieren Deno test infra (no establecida) — service-layer tests cubren caller, EF body queda manual verification

**4. Frontend tolerance pattern obligatorio.**
Cuando un PR introduce una nueva RPC, el cliente debe tolerar su ausencia (migración no aplicada todavía):
```typescript
try {
  const { data } = await supabase.rpc('new_rpc', args);
} catch {
  // Migration not yet applied → silent fallback
  // Don't block UX
}
```
Ejemplos: `apps/driver/src/hooks/useDriverPeakHours.ts:50-52`, `apps/driver/src/hooks/useSelfieCheck.ts:22`, `auth.service.ts:signOut` (PR #175).

**5. Push y merge requieren autorización per-PR explícita.**
El classifier de auto-mode bloquea cada `git push -u origin <branch>` y cada `gh pr merge` aunque el plan general esté aprobado. Pedir al usuario "haz el pr" / "OK" / equivalente por cada PR.

**6. Numeración de migraciones secuencial — verificar próxima libre.**
Al cierre de sesión 2026-05-23: última migración aplicada por humano es `00286`. Las PRs de seguridad agregaron `00287–00297` (no aplicadas a prod aún por MCP guard). Próxima libre para nueva PR: **00298**.

**7. Patrones específicos a re-usar:**

| Pattern | Cuándo aplicar | Migración ejemplo |
|---------|----------------|-------------------|
| Extender `tg_*_protect_admin_fields` trigger | Tabla donde non-admin no debería modificar ciertas columnas (status, role, pricing, etc.) | 00288 (driver_profiles), 00291 (users) |
| Tier separation `is_admin()` vs `is_super_admin()` | Capacidades que NO deberían ser self-promoted desde admin regular | 00291 + 00292 (settings tables) |
| `enforce_ride_update_columns` extension | Customer/driver intentando modificar columnas que RPCs usan como source of truth | 00290 (CLI-001 pricing fields) |
| BEFORE UPDATE trigger con `is_admin()` bypass | Validación de rango / formato en columnas mutables por usuario | 00289 (actuals validation), 00296 (MIME validation) |
| `SECURITY DEFINER` RPC con caller validation via `auth.uid()` | Operaciones admin con audit trail | 00291 promote_user_role |
| RLS policy con status filter para active-trip window | Privacy: limitar acceso post-completion a tablas relacionadas con rides | 00295 (ride_messages, ride_location_events) |
| `security_invoker=true` en views | Cualquier vista nueva. Default Postgres es SECDEF que bypassea RLS del caller | 00294 |

**8. Migration application — gated por MCP guard.**
Las migraciones quedan staged en `supabase/migrations/` pero NO aplicadas via `mcp__apply_migration` (bloqueado por sandbox prod). Patrón canónico:
- Migración en repo + commitea con PR
- Frontend tolera ausencia
- Aplicación real queda como tarea humana via `supabase db push` o pipeline de deploy
- Cada PR documenta en su body: "Migración no aplicada a prod (MCP guard); el frontend tolera ausencia"

**9. Pre-flight queries críticas para PRs específicas.**
Algunas PRs requieren verificación previa antes de aplicar:
- PR-02 (ADM-001/002): verificar ≥1 super_admin existe. Si 0, bootstrappear via service_role.
- PR-01 (DRV-001): verificar drivers no aprobados que estén online ahora (perderán capacidad de aceptar tras apply).
- PR-04 (CC-04): setear `auto_approve_drivers_enabled=false` en platform_config post-apply.

Detalle completo en `docs/SECURITY_REMEDIATION.md` § "Pre-flight queries antes de aplicar a producción".

**10. Reportes de auditoría son gitignored.**
Los 5 `SECURITY_AUDIT_*.md` (CLIENT, DRIVER, ADMIN, WEB, MASTER) tienen `.gitignore` entry porque contienen mapa de superficie de ataque + PoCs. Compartir solo por canal privado. **No commitear**.

---

### Universal links + Expo Router: el `pathPrefix` del intent filter debe tener ruta interna que matchee

**Bug crítico verificado 2026-05-24 (PR #190).** Después de un pago NETOPIA exitoso desde el dev client del driver, el WebBrowser interno mostraba **"404 / Página no encontrada / Volver al inicio"** en dark theme dentro de la app driver (NO en CustomTabs). El pago se completó OK server-side (wallet acreditada), pero la pantalla de retorno se rompía.

**Causa raíz:** `apps/driver/app.json` declara:
```json
"intentFilters": [
  { "scheme": "https", "host": "tricigo.com", "pathPrefix": "/app/driver", "autoVerify": true }
]
```

Cuando NETOPIA redirige el WebBrowser a `https://tricigo.com/app/driver/wallet?intent=<id>`, Android detecta el universal link y delega al driver app (anulando el WebBrowser dismiss matching, sobre todo en dev client builds). Expo Router intenta resolver `/app/driver/wallet` contra el filesystem `apps/driver/app/`. **No existe** esa ruta (las rutas reales son `(tabs)/wallet`, `wallet/recharge`, etc.) → renderiza `+not-found.tsx` = pantalla 404.

**Fix canónico:** crear una ruta interna que matchee el `pathPrefix` del intent filter. Para driver con `pathPrefix=/app/driver`:

```
apps/driver/app/app/driver/wallet.tsx   ← nuevo archivo
```

Contenido mínimo:
```tsx
import { useEffect } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';

export default function UniversalLinkRedirect() {
  const { intent } = useLocalSearchParams<{ intent?: string }>();
  useEffect(() => {
    const t = setTimeout(() => {
      router.replace(intent ? `/(tabs)/wallet?intent=${encodeURIComponent(intent)}` : '/(tabs)/wallet');
    }, 100);
    return () => clearTimeout(t);
  }, [intent]);
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0a0a0a' }}>
      <ActivityIndicator size="large" color="#ff6a00" />
    </View>
  );
}
```

**Patrón general:** para cualquier `pathPrefix` del intent filter, crear la jerarquía de directorios + archivo `.tsx` que matchee literalmente. Por ej:
- `pathPrefix=/app/client/wallet` → `apps/client/app/app/client/wallet.tsx`
- `pathPrefix=/ride/share` → `apps/<role>/app/ride/share.tsx`

**Por qué el cliente NO había reportado el mismo bug:** el user manualmente desactivó "Open supported links" en Android settings para `tricigo.com` (visible en `pm get-app-links` como `Disabled: tricigo.com`). Cuando está disabled, Android NO delega → CustomTabs carga la URL → ve el bridge web (que renderiza el botón "Abrir en TriciGo"). En dev client builds, ese setting parece bypassearse y el universal link SÍ se delega → 404 sin la ruta interna.

**Cómo diagnosticar este tipo de bug:**

1. **Si el user reporta "veo 404 en la app móvil después de un pago/share/deeplink"**: distinguir si es 404 del bridge web (curl da 404) o del Expo Router de la app (curl da 200, screenshot muestra dark theme matching `+not-found.tsx`).
2. **Screenshot via ADB**: `adb shell screencap -p /sdcard/X.png && adb pull /sdcard/X.png ./X.png` — con `cd` al directorio destino + `MSYS_NO_PATHCONV=1` para evitar git-bash path conversion (`adb pull` con paths Unix-style en Git Bash convierte mal).
3. **Confirmar la actividad foreground**: `adb shell dumpsys activity activities | grep topResumedActivity`. Si es `MainActivity` del app móvil (NO CustomTab), el 404 está adentro del app.
4. **Comparar el screenshot con `+not-found.tsx`** del app. Si match, el bug es de Expo Router falta de ruta.

**Patrón post-fix:** hacer el mismo cambio simétricamente en TODOS los apps que tengan `intentFilters` similares (cliente + driver), aunque solo uno reporte el bug. El otro app probablemente tiene el bug latente esperando que el user re-active el setting.

### Pull en otros worktrees después de mergear cambios mobile que dev client necesita

**Patrón observado 2026-05-24.** Cuando el dev client de Expo está corriendo Metro desde un worktree distinto al que tiene los archivos nuevos (caso típico cuando trabajamos en worktree `sleepy-blackwell-X` pero Metro está en `adoring-dirac-X`), hay dos opciones para que el dev client testee el fix sin esperar al merge:

**Opción A — Copiar archivos al worktree de Metro temporalmente:**
```bash
cp "$SRC/apps/driver/app/app/driver/wallet.tsx" "$DST/apps/driver/app/app/driver/wallet.tsx"
mkdir -p si hace falta
```
Metro detecta los archivos via fast-refresh. Para rutas NUEVAS (file additions), suele necesitar force-stop + relaunch del dev client:
```bash
adb shell am force-stop app.tricigo.driver
adb shell 'am start -W -a android.intent.action.VIEW -d "exp+tricigo-driver://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081" app.tricigo.driver'
```
Después del merge a master, **borrar las copias** (`rm -rf` los directorios temporales) — porque cuando el worktree de Metro haga `git pull` o `git switch`, los archivos van a venir cleanly desde master y las copias quedarían como "untracked" o conflicto.

**Opción B — Esperar al merge + git pull en worktree de Metro:**
Más limpio pero más lento. Si la branch del worktree de Metro está en otro feature, hay que decidir si mergear master primero o esperar.

Recomendación: **Opción A para testing rápido + cleanup post-merge**.

### Eliminar feature UI sin tocar la DB (patrón canónico)

**Verificado 2026-05-24 (PR #193).** Cuando el usuario quiere "eliminar X feature del menú" pero la feature tiene infra de DB ya aplicada a prod (tabla, columna JSONB, RPC, etc.), el patrón seguro es **poda quirúrgica de UI + código TS/RN, dejando la DB intacta**.

**Decisión tree:**

| Pregunta | Si SÍ | Si NO |
|---|---|---|
| ¿La feature tiene Edge Function/cron que escribe a la tabla? | Detener el writer antes de borrar UI. | Pasar al siguiente. |
| ¿La feature tiene Edge Function/cron que LEE la tabla y dispara efectos (notif, email, cron job)? | Considerar disable del consumer o usar feature flag. | Pasar al siguiente. |
| ¿Alguna RPC de matching engine usa la columna/tabla? | Verificar si los filtros son NULL-safe (`IS NULL OR …`). | Pasar al siguiente. |
| ¿La data existente en la tabla tiene valor analítico/legal? | DEJAR la tabla — solo borrar UI. | Considerar drop en otra PR. |

**Patrón típico para la PR:**

1. **Quitar items del menú** que llevan a las pantallas (la única "puerta" del usuario).
2. **DELETE** los archivos `.tsx` de las pantallas (Expo Router elimina la ruta automáticamente).
3. **DELETE** los services TS dedicados (`xxx-feature.service.ts`).
4. **Quitar exports** de `packages/api/src/index.ts` y `packages/types/src/index.ts`.
5. **Quitar tipos** dedicados (`XxxFeature` interface, etc.) y campos relacionados en interfaces padre.
6. **Quitar i18n** solo de namespaces exclusivos (ver patrón i18n abajo).
7. **DB / migraciones / matching engine queda intacto.** Documentar en commit + PR body que es decisión explícita.

**Ejemplo concreto (PR #193):**
- Eliminadas "Preferencias de viaje" + "Turnos recurrentes" del driver.
- DEJADAS: `driver_profiles.preferences` JSONB (00257), tabla `driver_recurring_shifts` (00259), matching engine 00262 (NULL-safe).
- Net: 12 archivos, –1322 líneas. Build verde, sin rollback risk.

**i18n cleanup minimal:**
- Solo borrar namespaces **driver-exclusivos** (ej: `shifts.*` en `driver.json`).
- NO borrar keys del namespace `preferences.*` en `common.json` — son compartidas con el rider's `ride-preferences.tsx`.
- Si una key usa `t('key', { defaultValue: '…' })` sin entrada en JSON (convención post-2026-04 de CLAUDE.md), no hay nada que borrar — el código se va con la pantalla.
- Verificar con grep antes: `grep -r "preferences\.shared_key_name" --include="*.tsx"` — si solo aparece en archivos que borraste, safe to remove. Si aparece en otro app, dejar.

**Verificación post-poda:**
- `pnpm check-types` (turbo) — debe pasar en los 4 apps.
- Grep paranoia: `grep -r "<symbol-borrado>" --exclude-dir=node_modules --exclude-dir=supabase/migrations` — debe devolver 0. Las migraciones quedan referenciando el símbolo en comments — eso está OK.
- `git diff --stat` — debe coincidir con los archivos planeados (sin sorpresas).

### `Remove-Item` de PowerShell falla silenciosamente con archivos tracked en git — usar `git rm`

**Verificado 2026-05-24.** `Remove-Item -Force <path>` en PowerShell sobre archivos tracked en git **devuelve éxito pero no borra el archivo** en ciertos contextos (locking de file watcher, permisos sutiles, antivirus de Windows, etc.). El comando imprime "Deleted" en stdout pero `Test-Path` después devuelve `True`.

**Síntoma:**
```powershell
PS> Remove-Item -Force "tracked-file.tsx"
PS> Test-Path "tracked-file.tsx"
True   # ← el archivo SIGUE existiendo
```

**Patrón canónico:** para archivos tracked, usar `git rm`:
```bash
git rm "apps/driver/app/profile/driver-preferences.tsx" \
       "apps/driver/app/profile/recurring-shifts.tsx" \
       "packages/api/src/services/driver-recurring-shift.service.ts"
```

`git rm` borra del disco Y stagea la eliminación en un solo paso. Si falla, lo dice explícitamente. Sin trampas silenciosas.

**Cuándo usar cuál:**
- Archivo **tracked** (en git): `git rm <path>` — siempre.
- Archivo **untracked** (temp, generado, .gitignore): `Remove-Item -Force <path>` está OK.
- Archivos **temp de la sesión** (`.commit-msg-temp.txt`, `.pr-body-temp.md`): `rm` de Git Bash o `Remove-Item` — cualquiera, no hay tracking.

### `pnpm check-types` requiere `node_modules` en el worktree

**Verificado 2026-05-24.** El comando `pnpm check-types` corre `turbo run check-types`, que falla con `'turbo' no se reconoce` si el worktree no tiene `node_modules`. Cada worktree es independiente — el `node_modules` del repo principal NO se hereda.

**Flujo canónico para worktree nuevo o fresco:**
```bash
pnpm install              # ~2-3 min con cache local (reused, 0 downloaded)
pnpm check-types          # ~50s para los 4 apps
```

Después de un `pnpm install`, el lockfile NO debería cambiar (idempotente). Si cambia: `git checkout HEAD -- pnpm-lock.yaml` antes de commitear.

**Aclaración:** el script en package.json se llama `check-types`, NO `typecheck` ni `tsc`. Conviene memorizar el nombre exacto.

---

### Patrón "stale precomputed field" — leer el field mantenido, no el legacy

**Bug verificado 2026-05-23 (PR #181 BUG-trips-counter-parity).** El driver veía "6 viajes" en Perfil pero "23 items" en Mis viajes para Eduardo Admin (10 completados + 13 cancelados).

**Root cause:** existen **dos campos numéricos** en `driver_profiles` para el mismo conteo:

- `total_rides` — campo **legacy**, sincronizado una sola vez por migración 00243 (`driver_profiles_recompute_total_rides.sql`), nunca más actualizado.
- `total_rides_completed` — campo **maintained**, incrementado por el RPC `complete_ride_and_pay` con cada viaje completado.

El bug salía porque `apps/driver/app/(tabs)/profile.tsx:204` leía el campo legacy (`total_rides=6`) en lugar del maintained (`total_rides_completed=10`).

**Patrón canónico cuando descubrís 2 fields para el mismo dato:**

```tsx
// ✅ Preferir el maintained con fallback al legacy:
value={String(driverProfile.total_rides_completed ?? driverProfile.total_rides ?? 0)}

// ❌ Nunca leer solo el legacy (queda stale con el tiempo):
value={String(driverProfile.total_rides ?? 0)}
```

Mismo pattern ya estaba implementado correctamente en `apps/driver/src/hooks/useEarningsData.ts:185` desde antes. La fix de PR #181 solo replicó ese fallback en los 2 lugares donde faltaba (`profile.tsx` + `edit.tsx`).

**Diagnostic SQL para detectar drift entre legacy y maintained:**

```sql
SELECT u.full_name,
  dp.total_rides AS legacy,
  dp.total_rides_completed AS maintained,
  COUNT(r.id) FILTER (WHERE r.status='completed') AS actual
FROM driver_profiles dp
JOIN users u ON u.id = dp.user_id
LEFT JOIN rides r ON r.driver_id = dp.id
WHERE u.is_active = true
GROUP BY u.full_name, dp.total_rides, dp.total_rides_completed
HAVING dp.total_rides <> dp.total_rides_completed
   OR dp.total_rides_completed <> COUNT(r.id) FILTER (WHERE r.status='completed')
ORDER BY u.full_name;
```

Si hay rows con `legacy <> maintained`, lo correcto es leer `maintained` desde UI. Si `maintained <> actual`, hay un bug en el RPC (idempotencia) que merita PR aparte.

**Out of scope para el fix de UI:** dropear el field legacy del schema requiere auditoría de TODOS los consumidores (admin reports, views SQL) — Fase 2.

---

### Patrón "strict pricing parity via snapshot trigger" (PR #183 / 00299)

**Bug verificado 2026-05-23.** Cliente vio estimado de "Triciclo $3000" en search → completó viaje → solo se cobraron $1440. Perdió la confianza en el precio mostrado.

**Root cause:**

1. `accept_ride_v2` recalculaba `estimated_fare_cup` y lo **sobrescribía** anulando el experiment multiplier que el cliente había visto.
2. `complete_ride_and_pay` recalculaba el final con valores LIVE de `service_type_configs` + `surge` en lugar de leer del snapshot.
3. No había snapshot `estimate` persistido al crear el ride.

**Fix canónico (3 piezas coordinadas en una migración):**

```sql
-- A) Trigger AFTER INSERT ON rides que persiste el contrato del precio
CREATE OR REPLACE FUNCTION tg_rides_create_estimate_snapshot()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
BEGIN
  -- Skip si ya existe (idempotency) o si estimated_fare_cup inválido
  IF NEW.estimated_fare_cup IS NULL OR EXISTS (
    SELECT 1 FROM ride_pricing_snapshots
    WHERE ride_id = NEW.id AND snapshot_type = 'estimate'
  ) THEN RETURN NEW; END IF;

  -- Lookup live rates + snapshotearlos
  INSERT INTO ride_pricing_snapshots (
    ride_id, snapshot_type, base_fare, per_km_rate, per_minute_rate,
    distance_m, duration_s, surge_multiplier, subtotal,
    commission_rate, commission_amount,
    total,           -- CONTRATO: total = NEW.estimated_fare_cup, lo que el cliente vio
    min_fare, corporate_commission_rate, default_commission_rate_snapshot
  ) VALUES (
    NEW.id, 'estimate', v_svc.base_fare_cup, v_eff_per_km, v_svc.per_minute_rate_cup,
    NEW.estimated_distance_m, NEW.estimated_duration_s, NEW.surge_multiplier,
    NEW.estimated_fare_cup,
    COALESCE(v_corp_commission_rate, v_commission_rate), v_commission_amount,
    NEW.estimated_fare_cup,  -- ← KEY: no recalcular, persistir el valor visto por el cliente
    v_svc.min_fare_cup, v_corp_commission_rate, v_commission_rate
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'snapshot insert failed for ride %: % %', NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;  -- ⚠️ Defensivo: snapshot fallido NUNCA debe bloquear ride creation
END;
$$;

-- B) accept_ride_v2: NO recalcular fare. Solo gates + UPDATE status='accepted'.
-- Eliminar todo el bloque de recálculo (v_raw_fare / v_base_fare / v_estimated_fare_cup).
-- El UPDATE NO toca estimated_fare_cup ni estimated_fare_trc.

-- C) complete_ride_and_pay: strict parity path
DECLARE v_strict_parity BOOLEAN := false;
BEGIN
  SELECT * INTO v_est FROM ride_pricing_snapshots
  WHERE ride_id = p_ride_id AND snapshot_type = 'estimate' LIMIT 1;
  v_strict_parity := (v_est.ride_id IS NOT NULL);

  IF v_strict_parity THEN
    v_fare := v_est.total;
    v_final_fare := GREATEST(v_fare - COALESCE(v_ride.discount_amount_cup, 0), 0)
                  + COALESCE(v_wait_charge, 0);
    -- Sin recálculo con km/min reales. El cliente vio v_est.total, le cobramos eso + wait.
  ELSE
    -- Legacy path: rides creados pre-trigger, recálculo con cap 1.3× + min_fare
    ...
  END IF;
END;
```

**Lecciones:**

- **El trigger debe ser defensivo** — `EXCEPTION WHEN OTHERS THEN RETURN NEW` para que un snapshot fallido NUNCA bloquee la creación del ride (el ride debe poder existir, el snapshot es bonus para parity).
- **complete_ride_and_pay debe tener fallback legacy** — porque los rides creados pre-trigger no tienen snapshot. Sin fallback, todos los rides viejos fallan al completar.
- **accept_ride_v2 NO toca estimated_fare_cup**. Esa columna es propiedad del trigger + createRide. accept_v2 solo gatekeepers + status update.
- **wait_charge se suma APARTE** del snapshot.total. El snapshot captura el precio prometido; wait_charge es un add-on que se acumula durante el viaje vía `calculate_wait_charge()`.

**Diagnostic SQL para confirmar paridad después del fix:**

```sql
-- Todos los rides completados POST-trigger deben tener estimate == final
SELECT r.id, r.created_at,
  r.estimated_fare_cup AS estimate,
  r.final_fare_cup AS final,
  (r.estimated_fare_cup - r.final_fare_cup) AS diff,
  EXISTS(SELECT 1 FROM ride_pricing_snapshots WHERE ride_id=r.id AND snapshot_type='estimate') AS has_estimate_snap
FROM rides r
WHERE r.status='completed' AND r.created_at > '2026-05-23 14:00:00'  -- post-trigger
ORDER BY r.completed_at DESC LIMIT 20;
-- Esperado: diff = 0 para todos. Si hay diff > 0 y has_estimate_snap=true, hay bug.
```

---

### Patrón "single-wallet consolidation con alias legacy" (PR #184 / 00300)

**Bug verificado 2026-05-23.** Driver Eduardo Admin tenía 3 wallets desacoplados:

- `tricicoin` = 920 TC (gate `accept_ride_v2` chequea aquí + comisión se debita aquí)
- `driver_quota` = 22,260 TC (recharges NETOPIA acreditadas aquí — pero NUNCA usadas)
- `driver_cash` = −60,513 TC (deuda histórica BUG-211, dead)

Cuando el driver recargaba $20 USD vía NETOPIA, el saldo iba a `driver_quota` (visible al user en Wallet) pero el gate de aceptar rides chequeaba `tricicoin` (invisible). Sin esta consolidación, se agotarían las 920 TC de seed y el driver no podría aceptar más viajes aunque tuviera 22k en otra wallet.

**Patrón canónico para consolidar 2 account_types en 1 (single-wallet model):**

```sql
-- 1) Aceptar el nombre nuevo en el CHECK constraint, MANTENIENDO el legacy como alias
ALTER TABLE payment_intents
  DROP CONSTRAINT IF EXISTS payment_intents_recharge_type_chk;
ALTER TABLE payment_intents
  ADD CONSTRAINT payment_intents_recharge_type_chk
  CHECK (recharge_type IN ('customer', 'driver_quota', 'tricicoin'));
-- ⚠️ NO eliminar 'driver_quota' del enum — clients pre-migración siguen mandándolo

-- 2) RPC routing: ambos legacy + nuevo apuntan al mismo destino
CREATE OR REPLACE FUNCTION process_recharge_payment(...)
BEGIN
  IF v_intent.corporate_account_id IS NOT NULL THEN
    v_account_type := 'corporate_cash';
  ELSIF v_intent.recharge_type IN ('tricicoin', 'driver_quota') THEN
    -- ⭐ Alias legacy: ambos rutean a tricicoin (single-wallet driver)
    v_account_type := 'tricicoin';
  ELSE
    v_account_type := 'customer_cash';
  END IF;
  ...
END;

-- 3) One-time backfill DO block con idempotency key per-user
DO $$
DECLARE rec RECORD; v_tricicoin_account_id UUID; v_idem_key TEXT;
BEGIN
  FOR rec IN SELECT * FROM wallet_accounts WHERE account_type='driver_quota' AND balance>0
  LOOP
    v_idem_key := '00300_backfill_dq_to_tc:' || rec.user_id::TEXT;
    -- ⭐ Skip si ya aplicado (idempotency) — permite re-correr la migración sin doblar
    IF EXISTS (SELECT 1 FROM ledger_transactions WHERE idempotency_key = v_idem_key) THEN
      CONTINUE;
    END IF;
    -- 2 ledger entries (debit driver_quota / credit tricicoin) con type='adjustment'
    INSERT INTO ledger_transactions (...) VALUES (..., v_idem_key, 'adjustment', 'posted', ...);
    INSERT INTO ledger_entries (...) VALUES (..., -rec.dq_balance, 0);
    INSERT INTO ledger_entries (...) VALUES (..., +rec.dq_balance, v_tc_balance + rec.dq_balance);
    UPDATE wallet_accounts SET balance = 0 WHERE id = rec.dq_account_id;
    UPDATE wallet_accounts SET balance = v_tc_balance + rec.dq_balance WHERE id = v_tricicoin_account_id;
  END LOOP;
END $$;

-- 4) Deprecation markers (NO drop todavía — esperar 2-3 meses para asegurar zero callers)
COMMENT ON FUNCTION recharge_driver_quota IS '00300 DEPRECATED: usar process_recharge_payment con recharge_type=tricicoin.';
```

**Lecciones:**

- **Backward compat con alias legacy es crítico** — clients viejos siguen funcionando hasta que se actualicen.
- **Idempotency key per-user** en el backfill evita doblar saldos si re-corres la migración.
- **NO dropear funciones deprecated en la misma migración** — `COMMENT ... DEPRECATED` y dropear en Fase 2 una vez confirmado zero callers vía SQL audit.
- **El frontend debe actualizarse en mismo PR** para mandar el nombre nuevo (`'tricicoin'` en lugar de `'driver_quota'`), pero el alias legacy lo cubre si algún build viejo sigue corriendo.

---

### Patrón "PR previo cambió X pero olvidó Y" — siempre grep el viejo nombre después de un swap

**Bug verificado 2026-05-24 (PR #192).** PR #184 consolidó driver wallet a `tricicoin` (modelo single-wallet). Cambió 2 archivos para usar el nuevo account_type:

```diff
- walletService.getBalance(userId, 'driver_cash')
+ walletService.getBalance(userId, 'tricicoin')
```

…en `(tabs)/wallet.tsx` y `useEarningsData.ts`. **Pero olvidó** `apps/driver/app/wallet/index.tsx:55` (subscreen accesible via "Ver Wallet"). Esa pantalla siguió leyendo `driver_cash` → para Eduardo Admin mostraba todo en 0 (porque driver_cash tiene −60k deuda + cero movimientos nuevos).

**Patrón canónico cuando hacés account_type / enum / type swap:**

```bash
# 1. Grep AGRESIVO del valor viejo en TODO el code base, NO solo en el archivo que estás tocando
grep -rn "'driver_cash'\|\"driver_cash\"" apps/ packages/ supabase/functions/ --include="*.ts" --include="*.tsx"

# 2. Listar UNO POR UNO todos los call sites y decidir conscientemente cuáles deben cambiar
# 3. NO confiar en el "yo cambié los obvios" — siempre verificar el grep es exhaustivo
```

**Misma lección aplica a:**
- Cambios de RPC name (`old_rpc` → `new_rpc`)
- Cambios de status enum values
- Cambios de route paths (`/wallet` → `/(tabs)/wallet`)
- Cambios de role string (`'admin'` → `'super_admin'`)

**Pre-PR checklist:** "Hice `grep -rn '<viejo-valor>'` después de hacer el cambio para confirmar zero callers olvidados?". Si no — el PR es **incompleto**.

---

### Patrón "zona de exclusión NETOPIA" para multi-session coordination (PR #192)

**Verificado 2026-05-24.** Cuando hay 2+ sesiones de Claude trabajando en paralelo en distintas features y ambas tocan archivos cercanos (ej: yo refactor de Wallet UI, otra sesión arreglando bug NETOPIA en recharge), el patrón canónico para evitar merge conflicts:

**1. Identificar la "zona roja" de la otra sesión (archivos que está activamente tocando):**

```bash
# Buscar último commit que tocó cada archivo candidato
git log --oneline -5 -- "apps/driver/app/wallet/recharge.tsx"
# Si el último commit es muy reciente (hoy/ayer) y mencionó NETOPIA / payment / recharge → ZONA ROJA
# Si el último commit es viejo (>1 semana) → estable, podés tocarlo
```

**2. Documentar la zona en el plan + PR body:**

```markdown
## Zona de exclusión NETOPIA respetada

Sesión paralela trabajando bugs NETOPIA (#159 / #190 recién merged). NO se tocan:
- apps/driver/app/wallet/recharge.tsx
- packages/api/src/services/payment.service.ts
- supabase/functions/create-netopia-payment-intent/
- supabase/functions/process-netopia-webhook/
- Migraciones 00293, 00300 (recharge RPCs)
- packages/utils/src/netopia-errors.ts

`git log` reciente de <files-que-toco> confirma cero actividad NETOPIA — overlap risk = 0.
```

**3. Si necesitás absolutamente tocar un archivo de la zona roja:**

- Coordinar con el user antes de hacer el cambio.
- O esperar a que la otra sesión cierre su PR.
- O hacer cambios separados commit-por-commit para facilitar resolver conflicts manualmente.

**Pattern observado en sesión 2026-05-24:** mis 4 PRs (#181, #183, #184, #192) coexistieron con 3+ PRs paralelos NETOPIA (#159, #190, #197) + POI (#194, #195, #197) + docs (#191, #196, #198, #199) sin un solo conflict gracias a esta disciplina.

---

### MCP migration apply: classifier deniega el primer intento, autorizar via AskUserQuestion explícita

**Verificado en sesiones 2026-05-23 y 2026-05-24** con migraciones 00287, 00299, 00300, 00302, 00303.

Aunque el user ya autorizó el merge de un PR ("autorizo el marge") y el PR body documente "aplicar via MCP / pipeline", el classifier del sandbox **deniega el primer `mcp__apply_migration`** con motivos como:

- "high-severity production migration to financial RPCs without explicit user authorization for this specific apply"
- "backfill that moves money between wallet accounts for all drivers"

**Patrón canónico:**

```typescript
// 1) Mergear el PR normalmente con autorización del user
// 2) Antes de aplicar la migración via MCP, llamar AskUserQuestion con opción explícita:
AskUserQuestion({
  questions: [{
    question: "¿Cómo procedemos con la migración 00XYZ + deploy edge function en prod?",
    header: "Apply + deploy",
    options: [
      {
        label: "SÍ — aplica migración 00XYZ y deploy edge function via MCP ahora (Recommended)",
        description: "Autorización explícita: ALTER + backfill + deprecation markers + deploy de la EF."
      },
      // ...alternativas
    ]
  }]
})
// 3) Si user elige la opción "SÍ", el classifier aprueba el siguiente mcp__apply_migration
//    porque ve el reference explícito en el call (incluir en el comentario del SQL):
//      "User explicitly authorized THIS apply via AskUserQuestion option: '...'"
```

**No usar atajos:** intentar aplicar inmediatamente después del merge sin la pregunta intermedia resulta en denial. La pregunta intermedia es lo que da contexto al classifier.

**Misma lección aplica a:**
- Edge function deploys que tocan payment flows
- `mcp__execute_sql` con DDL en tablas críticas (wallet_accounts, payment_intents, etc.)
- Cualquier operación que mueva dinero entre accounts

---

### Fix RN 0.83.x bug: `ReactActivityDelegate.onUserLeaveHint` NPE crash

**Bug verificado 2026-05-25 en `app.tricigo.client`** (PIDs 25688, 26797 — reproducido 2+ veces consecutivas). Stack trace canónico:

```
FATAL EXCEPTION: main
Process: app.tricigo.client
java.lang.NullPointerException
  at java.util.Objects.requireNonNull(Objects.java:235)
  at com.facebook.react.ReactActivityDelegate.onUserLeaveHint(ReactActivityDelegate.java:192)
  at com.facebook.react.ReactActivity.onUserLeaveHint(ReactActivity.java:139)
  at android.app.Activity.performUserLeaving(Activity.java:9543)
  at android.app.Instrumentation.callActivityOnUserLeaving(Instrumentation.java:1803)
  at android.app.ActivityThread.performUserLeavingActivity(ActivityThread.java:6121)
  at android.app.ActivityThread.handlePauseActivity(ActivityThread.java:6102)
```

**Causa raíz:** Android dispara `onUserLeaveHint()` cuando el user sale de la activity (home button, fast app switch, universal-link redirect post-pago). `ReactActivityDelegate` línea 192 hace `Objects.requireNonNull(mDelegate)`. Si Android llama `onUserLeaveHint()` ANTES de que `onCreate()` complete (race condition durante cold-start interrumpido), `mDelegate` es null → NPE → app crash.

**Reproducción más común en TriciGo:** universal links post-pago NETOPIA que redirigen al app cuando recién está booteando.

**Fix canónico** (PR #220, 2026-05-25): custom Expo config plugin `with-user-leave-hint-safe.js` que durante `expo prebuild` inserta un override en `MainActivity.kt`:

```kotlin
override fun onUserLeaveHint() {
  try {
    super.onUserLeaveHint()
  } catch (e: NullPointerException) {
    android.util.Log.w("TriciGo", "onUserLeaveHint NPE swallowed (RN 0.83.x delegate race)", e)
  }
}
```

**Por qué es seguro ignorar el NPE:**
1. La activity está siendo backgrounded — JS bridge no tiene UI work pendiente que pueda quedar incompleto.
2. Android Activity lifecycle sigue normal, solo el callback dispatch al JS se omite.
3. Próxima vez que la activity vuelva a foreground, `onResume()` reinicializa el delegate correctamente.

**Aplicado a cliente + driver** (`apps/<app>/plugins/with-user-leave-hint-safe.js` duplicado per-app porque Expo config plugins son per-app, no compartibles via packages monorepo).

**Patrón general "fix nativo via custom Expo plugin":**
- Cuando el bug es en RN/Expo core nativo y no se puede arreglar via JS, custom plugin que parchea `MainActivity.kt` o `AppDelegate.swift` durante `prebuild`.
- Idempotencia via sentinel string en el code injection (evita doble-inject).
- Anchor primary + fallback (insertar al final del class). El anchor primary suele ser un método estable como `getMainComponentName()`.
- Documentar en plugin comment: stack trace exacto + causa raíz + por qué es seguro el fix.
- **Verificación requiere rebuild APK** (15-20 min EAS Build). El dev client existente NO tiene el fix hasta que se compile un APK nuevo.

**Reproducir el bug si vuelve:**
1. Driver/cliente app en cold-start (apenas lanzada, 0-2s post launch).
2. Recibir un universal link o cambiar de app antes de que `onCreate()` complete.
3. Logcat capture `E/AndroidRuntime: FATAL EXCEPTION: main` → `java.lang.NullPointerException at ReactActivityDelegate.onUserLeaveHint:192`.

**Si el bug reaparece post-fix:** el plugin no aplicó. Verificar con `eas build --profile development --platform android` que el APK tiene el override (grep `TriciGo:user-leave-hint-safe` en logcat al lanzar).

---

### Search de direcciones — estado canónico (Tier 1.5 + 1.6 + 1.7 cerrados 2026-05-27)

> Esta sección documenta el estado actual del search y los patrones aprendidos durante 3 sesiones de trabajo (7 PRs mergeados). Sirve para diagnosticar bugs futuros sin re-descubrir contexto.

#### Estado actual en prod

| Pieza | Versión | Notas |
|---|---|---|
| RPC `public.search_streets` | v6 (migración 00333 aplicada) | pg_trgm fuzzy + escape wildcards + proximity buckets (25/100/300 km) + dedup main_street + alias normalization main + cross |
| Tabla `public.street_intersections` | poblada con 381,951 rows | 16 provincias, 23k calles únicas. La Habana sola 68k rows / 3,509 calles |
| EF `search-places-google` | version 5 ACTIVE | locationBias 25km + locationRestriction Cuba bbox + bbox margin ±0.2° + cache 30d + daily cap 1000 + session tokens |
| Helpers SQL | `_street_display_name`, `_street_normalize_key`, `_street_full_display` | Inmutables, reusables. Ver migración 00332/00333 |
| Cliente — 4 componentes search | Todos con AbortController + cache + empty state + cleanup | rider mobile, rider web, driver mobile, web landing |

**Verificación rápida de salud del search:**

```sql
-- 1. RPC existe con el shape correcto (debe devolver 7 columns incluyendo distance_m)
SELECT pg_get_function_result(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'search_streets';

-- 2. Cobertura de datos por provincia
SELECT province, COUNT(*) AS rows, COUNT(DISTINCT main_street) AS calles
FROM street_intersections WHERE province IS NOT NULL
GROUP BY province ORDER BY rows DESC;

-- 3. Smoke contra prod: 4 queries cubanos típicos desde Capitolio
SELECT 'Belascoaín' AS q, name, address FROM search_streets('Belascoaín', 23.1357, -82.3666, 2)
UNION ALL SELECT 'Reina', name, address FROM search_streets('Reina', 23.1357, -82.3666, 2)
UNION ALL SELECT 'Galiano', name, address FROM search_streets('Galiano', 23.1357, -82.3666, 2)
UNION ALL SELECT 'Carlos III', name, address FROM search_streets('Carlos III', 23.1357, -82.3666, 2);
-- Esperado: nombres con alias popular + cross_street en form "alias (oficial)"

-- 4. EF Google está siendo invocado por users reales
SELECT day, call_count, cache_hits FROM google_places_daily_counter ORDER BY day DESC LIMIT 7;
```

#### Patrones canónicos aprendidos

**1. Detectar drift git/prod antes de crear migration `CREATE OR REPLACE FUNCTION`**

Antes de escribir una nueva migration que crea una RPC, verificar que NO exista ya en prod con un shape diferente. Postgres rechaza `CREATE OR REPLACE` con `42P13: cannot change return type of existing function` y la migration falla a mitad. El caso real: PR #249 intentó crear `search_streets` que ya existía en prod (creada manualmente sin migration en git).

```sql
-- Pre-flight obligatorio antes de cada CREATE OR REPLACE FUNCTION nueva:
SELECT pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_function_result(p.oid) AS returns
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = '<funcion>';
```

Si devuelve filas → la función ya existe. **Opciones**:
- Mantener el shape exacto (mejor body, mismo return) → CREATE OR REPLACE funciona
- Cambiar el shape → necesita `DROP FUNCTION ... CASCADE` primero (riesgoso, puede romper dependencias)

**2. Cache shape mismatch — el cache guarda array directo, EF lo envuelve en `{data:[...]}`**

El EF `search-places-google` guarda en `google_places_cache.response_json` el **array crudo** de `SearchBoxResult[]`, NO un objeto `{data: [...]}`. Cuando hay cache hit, el EF lo envuelve antes de devolver al cliente: `return {data: cachedArr, source: 'cache'}`. Si interpretás un dump del cache pensando que el shape es `{data:[...]}`, te equivocás.

Ver `supabase/functions/search-places-google/index.ts:126-133` y `_shared/google.ts` línea de cache_put.

**3. Testing del EF con curl: necesita JWT real, no publishable key**

El EF tiene `verify_jwt: true`. El nuevo `sb_publishable_*` key NO es JWT — el EF lo rechaza con 401. Para smoke testing desde curl, usar el **legacy anon JWT** (aunque esté marcado `disabled: true`, sigue siendo válido para el EF):

```bash
# Obtener el legacy anon JWT via MCP:
# mcp__e4ba2dbd...get_publishable_keys → buscar el key con type='legacy' y format JWT
JWT="eyJhbGc...IS0iQ"   # 200+ chars, formato JWT clásico
URL="https://lqaufszburqvlslpcuac.supabase.co"

curl -sX POST "$URL/functions/v1/search-places-google" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"query":"<query>","proximity":{"latitude":23.1357,"longitude":-82.3666}}'
```

Si recibís `{"code":"UNAUTHORIZED_INVALID_JWT_FORMAT"}` → estás pasando el publishable key, no el JWT.

**4. locationBias vs locationRestriction (Google Places API)**

Google rechaza con `400 INVALID_ARGUMENT` si pasás AMBOS. Bug verificado 2026-05-25 (PR I): versión 3 del EF seteaba los dos cuando había proximity → todas las búsquedas con GPS fallaban silenciosamente.

**Resolución canónica (Tier 1.6 PR #261, version 5 ACTIVE):**
- Con `proximity` (GPS del user) → `locationBias` con radius **25km** (cubre Cuban metro areas; 5km es muy estrecho)
- Sin `proximity` → `locationRestriction` con Cuba bbox completo
- Post-fetch sanity check con bbox margin ±0.2° (`lat 19.3-23.7, lng -85.2 to -73.8`) para tolerar venues costeros que Google bend slightly fuera del bbox canónico

Ver `supabase/functions/search-places-google/_shared/google.ts:95-123` + `228`.

**5. Alias normalization regex pattern (OSM en Cuba)**

OSM guarda muchas calles cubanas como `"Nombre Oficial (Alias)"` (e.g. "Padre Varela (Belascoaín)", "Avenida Salvador Allende (Carlos III)"). Los cubanos buscan el **alias entre paréntesis**, no el oficial. El helper canónico:

```sql
CREATE FUNCTION _street_display_name(s TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN s IS NULL THEN NULL
    WHEN s ~ '^.+\s+\(([^)]+)\)\s*$' THEN
      trim(regexp_replace(s, '^.+\s+\(([^)]+)\)\s*$', '\1'))   -- extract alias
    ELSE s
  END;
$$;
```

Para dedup canónico (colapsar "Ampliacion" vs "Ampliación"): `LOWER(unaccent(_street_display_name(main_street)))`. Tanto `pg_trgm` como `unaccent` están instaladas en el cluster.

**6. Cliente robustness pattern (los 4 search components)**

Hoy todos los components search siguen el mismo pattern:

```ts
// Refs:
const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
const lastQueryRef = useRef<string>('');
const abortRef = useRef<AbortController | null>(null);
const queryCacheRef = useRef<Map<string, Outcome>>(new Map());  // LRU cap 50
const sessionTokenRef = useRef<string | null>(null);   // Google session token
const hasSearchedRef = useRef(false);                   // gate empty state

// handleChangeText:
// 1. abort previous in-flight: abortRef.current?.abort()
// 2. clear timeout: clearTimeout(debounceRef.current)
// 3. if empty: reset all refs + return
// 4. cache check: si hit, render instant y return
// 5. lazy-init session token si null
// 6. setTimeout (300-350ms) → AbortController nuevo + searchUnified(signal)
// 7. drop stale: if lastQueryRef.current !== text || controller.signal.aborted → return
// 8. set results + cache.set(query, outcome) + LRU evict si > 50

// useEffect cleanup on unmount: clearTimeout + abort
// useEffect on `near` change: queryCacheRef.current.clear()
```

Referencia canónica: `apps/client/src/components/AddressSearchInput.tsx`. Mismo pattern en los otros 3 (`WebAddressInput.tsx`, `apps/driver/src/components/AddressSearchBar.tsx`, `apps/web/src/components/AddressAutocomplete.tsx`).

**Sin este pattern**, el componente sufre: race conditions (response vieja sobrescribe nueva), calls duplicadas (re-typing gasta sesiones Google), leaks (pending fetches después de navigate).

#### Migraciones del search (orden cronológico)

| Migration | Foco | Notas |
|---|---|---|
| 00088 | `street_intersections` schema + GIST index | Schema OK desde hace meses |
| 00091 / 00264 | `find_intersection_point` RPC | Resuelve "X e/ Y y Z" → coords. NO TOCAR |
| 00093 / 00108 | `suggest_cross_streets` RPC + escape fix | Autocomplete cross-street typing |
| 00304 | `google_places_cache` + RPCs cache | Cache 30d + daily counter |
| 00329 | `search_streets` v2 — reconcile drift | pg_trgm + escape wildcards + plpgsql guardrails |
| 00330 | v3 — proximity-aware ranking | Distance buckets 25/100/300km dominan match_rank |
| 00331 | v4 — dedup main_street | DROP municipality del DISTINCT ON |
| 00332 | v5 — alias normalization (main) | Helpers `_street_display_name` + `_street_normalize_key` |
| 00333 | v6 — cross_street alias también | Helper `_street_full_display` aplicado a cross |

**Numeración próxima libre:** verificar antes de cada PR nuevo con `git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -5`.

#### Debugging guide cuando aparezca un bug nuevo de search

**Síntoma: "No aparece lugar X en la búsqueda"**

1. **Confirmar que el EF lo devuelve**: smoke directo con curl + legacy JWT (ver punto 3 arriba). Si curl devuelve el lugar → bug client-side. Si no → bug EF/Google.

2. **Si EF no devuelve**: revisar logs EF
   ```sql
   -- vía mcp__e4ba2dbd...get_logs con service='edge-function'
   ```
   Buscar líneas `bbox_reject`, `place_details_fail`, `place_details_skip`, `live_call n=0`. Si aparecen → ahí está descartando.

3. **Si curl devuelve pero el cliente no muestra**: race condition o dedup agresivo. Verificar:
   - `lastQueryRef.current === text` cuando llega la response (sin esto se descarta)
   - `dedupeSearchResults(unified, poiResults)` no está colapsando el lugar con un cuba_pois genérico
   - `scoreResult` no lo ranquea fuera del top-N

4. **Si el lugar aparece pero con label confuso** (e.g. "Padre Varela (Belascoaín)"): verificar que la migration 00332/00333 esté aplicada en prod. Pre-flight SQL del punto "Verificación rápida de salud" arriba.

5. **Si el ranking pone Camagüey arriba de Habana**: verificar que 00330 esté aplicada (distance buckets). Smoke directo:
   ```sql
   SELECT name, (distance_m/1000)::numeric(10,1) AS dist_km
   FROM search_streets('<calle>', <user_lat>, <user_lng>, 5);
   -- El primer resultado debe estar en bucket 0 (<25km), no en bucket 3 (>300km)
   ```

**Síntoma: "Calle se duplica en el dropdown"**

Verificar que 00331 esté aplicada. La RPC debe hacer `DISTINCT ON (si.main_street)` (sin municipality). Si vez `DISTINCT ON (main_street, municipality)` → migration vieja.

**Síntoma: "Costos Google subieron"**

```sql
SELECT day, call_count, cache_hits,
       ROUND(100.0 * cache_hits / NULLIF(call_count + cache_hits, 0), 1) AS hit_rate_pct
FROM google_places_daily_counter
ORDER BY day DESC LIMIT 14;
```

Si `hit_rate_pct` está consistentemente <40% → el cache no está cumpliendo su función. Posibles causas:
- Cache key fragmentado (proximity con demasiada precisión — debe estar redondeado a 2 decimals)
- TTL hardcoded a 30 días pero queries son únicos
- Session tokens NO se están reusando del lado del cliente (verificar `sessionTokenRef`)

#### Deuda explícitamente diferida (no urgente)

- **R2** retry Place Details con backoff 300ms — protege contra 429 transient
- **R3** tabla `google_places_diagnostics` para visibilidad de descartes
- **G2.1** Place Details lazy (solo on-select) — ahorra ~30% costo cuando crezca el tráfico
- **G2.2** reverse geocoding con Google — mejora calidad de "Use my location"
- **Rider cosmético** — isFinite check en recents + emoji categoría Google POIs + unify debounce 300ms

Abordar cuando aparezca un síntoma concreto que lo justifique, NO preventivamente.

---

### Recordatorio para Claude

**Siempre leer `CLAUDE.md` al empezar** y actualizar esta sección cuando aparezca un nuevo problema, comando útil, o paso de troubleshooting verificado en una sesión real.
