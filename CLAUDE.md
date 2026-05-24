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

**A. Dev client APK ya instalado (lo más común)** — Buscar en el celu el icono "TriciGo" o "TriciGo (Dev)". Abrirlo, "Enter URL manually", `exp://192.168.x.x:8081`, reload. Funciona TODO (Mapbox, Stripe, Sentry, expo-dev-client). El proyecto importa varios módulos nativos así que esto es el camino canónico para QA real.

**B. Necesita un APK nuevo (CI cloud)** — el repo tiene workflow `android-dev-client-client.yml` que compila el APK en GitHub Actions:
```powershell
gh workflow run android-dev-client-client.yml --ref master
gh run list --workflow=android-dev-client-client.yml --limit 1   # ver run id
gh run download <RUN_ID> --name client-dev-client-apk
```
~10-15 min, después se pasa el `.apk` al celu, instalar con "fuentes desconocidas" habilitado.

**C. Build local con EAS** — `npx eas-cli build --profile development --platform android`. Compila en la nube de Expo (10-20 min), devuelve URL de descarga. Requiere cuenta Expo (gratis).

**D. Expo Go (limitado, NO recomendado)** — Expo Go no soporta los módulos nativos del proyecto: `@rnmapbox/maps`, `@stripe/stripe-react-native`, `@sentry/react-native`, `expo-dev-client`. Si lo usás, se pueden probar Perfil, Configuración, búsqueda de direcciones, recorte de foto, idiomas; **falla** mapa, recargas con tarjeta. Levantar con `npx expo start --port 8081` (sin `--dev-client`).

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

---

### Recordatorio para Claude

**Siempre leer `CLAUDE.md` al empezar** y actualizar esta sección cuando aparezca un nuevo problema, comando útil, o paso de troubleshooting verificado en una sesión real.
