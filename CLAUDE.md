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

### Worktrees frescos: copiar `.env` antes de levantar Metro (verificado 2026-05-28)

**Bug verificado.** Al levantar Metro desde un worktree recién creado (`.claude/worktrees/<nombre>`), las apps cargan pero **el mapa crashea** (`MapboxConfigurationException: requires a valid access token`) y **no conectan al backend** (login/datos fallan).

**Causa raíz:** los `.env` de `apps/client` y `apps/driver` están **gitignored**, así que un worktree fresco NO los tiene (los worktrees solo checkoutean archivos *tracked*). Toda la config de runtime vive ahí: `EXPO_PUBLIC_MAPBOX_TOKEN`, `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_POSTHOG_API_KEY`, `EXPO_PUBLIC_DEMO_MODE/CITY`. Esos valores también están en `eas.json` (`build.base.env`) **pero solo se inyectan en `eas build`, NUNCA en `npx expo start`** — en local Expo los carga del `.env`. Sin `.env`, Metro inlinea cada `EXPO_PUBLIC_*` como **vacío** → token Mapbox vacío + Supabase URL vacía → apps rotas.

**Fix canónico (antes de levantar Metro en un worktree):**
```powershell
$main = "C:\Users\Eduardo\TriciGo"
$wt   = "C:\Users\Eduardo\TriciGo\.claude\worktrees\<nombre>"
Copy-Item "$main\apps\client\.env" "$wt\apps\client\.env" -Force
Copy-Item "$main\apps\driver\.env" "$wt\apps\driver\.env" -Force
# luego arrancar Metro normalmente
```
El `.env` copiado queda gitignored (no ensucia `git status`). **Verificación:** el output de Metro debe imprimir `env: load .env` seguido de `env: export EXPO_PUBLIC_MAPBOX_TOKEN ... EXPO_PUBLIC_SUPABASE_URL ...`. Si esa línea NO aparece, el `.env` falta y el mapa va a crashear.

**Diagnóstico si reaparece:** el driver crashea inmediato (su home es mapa); el cliente blanquea/crashea al abrir una pantalla con mapa. Confirmar en el crash buffer:
```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb logcat -d -b crash -t 80 -v time | Select-String "Mapbox|tricigo"
# → MapboxConfigurationException ... requires ... a valid access token
```

**Levantar los 2 Metros a la vez (cliente 8081 + driver 8082):** limpiar el cache **una sola vez** antes (`Remove-Item ... metro-* / haste-map-*`) y arrancar **sin `--clear`** en ambos — dos `--clear` simultáneos chocan por `metro-cache\<n>` y tiran `EPERM, Permission denied` (uno de los dos Metro muere al boot). Verificado 2026-05-28.

> Nota: `google-services.json` también es gitignored y falta en worktrees frescos, pero su warning (`Could not parse Expo config: android.googleServicesFile`) es **benigno** para el dev client — ese archivo solo se usa en build/prebuild (ya está horneado en el APK), no afecta el bundle JS servido por Metro.

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

### Deploy web/admin: self-hosted runner en el VPS (GitHub→VPS SSH bloqueado por Hostinger) — verificado 2026-06-03

**Síntoma:** `deploy-web.yml` / `deploy-admin.yml` empiezan a fallar **solos** (nadie tocó nada) con `dial tcp ***:22: i/o timeout` en el primer paso SSH (`appleboy/ssh-action` / `scp-action`). El deploy venía funcionando y de golpe deja de andar.

**Causa raíz (confirmada):** **Hostinger filtra los rangos de IP de los runners de GitHub (Azure) en su red, río arriba del VPS** — probablemente su mitigación anti-abuso/DDoS automática, gatillada por la ráfaga de conexiones SSH de los deploys desde IPs de datacenter. **El box está perfecto** (`ufw` permite 22 desde Anywhere; `iptables -L INPUT` limpio; sin CrowdSec/fail2ban/ipset). Diagnóstico decisivo: en `/var/log/auth.log` los intentos SSH de GitHub **dejan de aparecer** (los paquetes ni llegan a `sshd`), mientras una IP no-datacenter (ej. el sandbox) **sí** llega al `:22`. El secret `VPS_HOST` es correcto (`187.77.214.236`, VPS Hostinger `srv1411116`, `ssh root@`).

**Fix canónico (NO depende de Hostinger): self-hosted runner.** Un runner de GitHub Actions **dentro del VPS** que sale outbound hacia GitHub → inmune al filtro de entrada.
- Runner instalado como servicio systemd (`/root/actions-runner`, `RUNNER_ALLOW_RUNASROOT=1`, `./svc.sh install && ./svc.sh start`). Corre como root (necesario: el `pm2` y `/var/www/*` son de root). Labels: `self-hosted, Linux, X64`. Sobrevive reinicios.
- Ambos workflows = 2 jobs: **build** en `ubuntu-latest` (sube `.next/standalone` + `.next/static` + `public` como artifact) → **deploy** en `runs-on: self-hosted` (baja el artifact y hace `rsync` local + `pm2 restart`, **sin SSH/SCP**).
- Si el runner aparece offline: `cd /root/actions-runner && ./svc.sh status` / `start`. Verificar online: `gh api repos/AgenciaSeniors/TriciGo/actions/runners`.

**Para volver a SSH** (si Hostinger deja de filtrar): restaurar los pasos `appleboy/scp-action` + `ssh-action` y `runs-on: ubuntu-latest` en el job de deploy.

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

**Caso real verificado 2026-06-03 (choque resuelto con renumeración).** Dos sesiones paralelas eligieron 00370/00371: una para el feature **Tier** (`user_level` bronce→diamante, PR #386) y otra para **cancelación reputacional** (PR #387). Ambos se mergearon con el mismo número base. La resolución fue un **tercer PR de solo-renumeración** (#388, `chore(migrations): renumber…`) que movió los archivos de cancelación a `00372`/`00373`/`00374` (Tier se quedó con 00370/00371). Como el SQL de cancelación es `CREATE OR REPLACE` / `CREATE TABLE IF NOT EXISTS` idéntico, **prod no necesitó re-aplicar nada** — solo se reordenaron los archivos en git. Lección: si el choque ya se mergeó, el fix es un PR de renumeración aparte (no tocar prod), eligiendo qué feature conserva el número bajo.

**Cómo se registra el `version` según el mecanismo de apply** (verificado 2026-06-03): `supabase db push` (CLI) usa el **filename** como version; pero `mcp__apply_migration` registra por **TIMESTAMP** (`20260603190204…`). Por eso, tras aplicar via MCP, buscar en `supabase_migrations.schema_migrations` por número (`WHERE version LIKE '0037%'`) devuelve **vacío** aunque la migración SÍ se aplicó — los objetos están en prod, solo el registro usa timestamp. Verificar por objeto (`pg_proc` / `information_schema.tables`), no por número de migración.

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

#### Follow-up SDK 55: el anchor del plugin inyectaba el override FUERA de la clase (PR #288, 2026-05-29)

**Bug verificado.** Tras subir a Expo SDK 55 / RN 0.83.x, el APK dejó de compilar:

```
MainActivity.kt:51:5 Unresolved reference: override
> Task :app:compileDebugKotlin FAILED
```

**Causa raíz:** `with-user-leave-hint-safe.js` ancla la inyección después de `getMainComponentName()` con un regex `getMainComponentName\(\)[^}]*}`. En SDK ≤54 ese método tenía cuerpo con llaves (`{ return "main" }`), así que el `}` matcheaba el cierre del método. En **SDK 55** Expo migró el template de `MainActivity.kt` a **expression-body** (`override fun getMainComponentName(): String = "main"`, **sin llaves**). El `[^}]*}` entonces corría hasta la PRIMERA llave que encontraba — la del **cierre de la clase** — e inyectaba el `override fun onUserLeaveHint()` *después* de cerrar la clase → método suelto a nivel de archivo → `Unresolved reference: override`.

**Fix canónico (PR #288):** anclar al **header de la clase** en lugar de a un método, e insertar justo después de la llave de apertura de la clase:

```js
// Anchor robusto: la declaración de la clase + su llave de apertura.
const classHeader = /(class\s+\w+\s*:\s*ReactActivity\s*\([^)]*\)\s*\{)/;
// Insertar el override inmediatamente DESPUÉS de `{` → siempre dentro de la clase,
// sin importar si los métodos usan block-body o expression-body.
contents = contents.replace(classHeader, `$1\n${OVERRIDE_SNIPPET}`);
```

**Lección general:** los config plugins que parchean `MainActivity.kt`/`AppDelegate.swift` por regex **no deben anclar a cuerpos de método** (cambian entre SDKs: block-body ↔ expression-body). Anclar a estructuras estables: el header de la clase + su `{`. Verificar el plugin con un test Node que corra el `.replace` sobre el template del SDK nuevo y assertee que el snippet quedó **dentro** del bloque de la clase (contar llaves, o regex `class ... { ... <snippet> ... }`). Aplicado a cliente + driver (plugins duplicados per-app).

### `Pressable` función-estilo descarta props de layout (`width`/`flex`) — usar estilo-objeto

**Bug verificado 2026-06-28 (PR #701).** En la wallet del cliente, una fila de botones `Pressable` con `flex: 1` (y después `width: '50%'`, y hasta `width: <px>`) **colapsaba al ancho de contenido** — los botones no llenaban el ancho aunque su contenedor SÍ era full-width (confirmado pintando contenedor + hijos con `backgroundColor` temporal). `pnpm check-types` pasaba y el bundle era fresco (verificado con Metro `--clear` + un `console.log` de `useWindowDimensions`: `windowWidth=411`, `quickActionHalf=189.7` correctos pero sin aplicarse al render).

**Causa raíz:** los props **de layout** (`width`, `flex`) puestos dentro del **array que devuelve una función-estilo de `Pressable`** —`style={({ pressed }) => [{ width }, pressed && {…}]}`— se **descartan silenciosamente** en esta versión de RN. Los props de **paint** (`opacity`, `transform`) del mismo array SÍ se aplican (por eso el feedback de pulsado andaba pero el ancho no). El `ServiceIconButton` del home no sufre esto porque pone `flex:1` en un **estilo-objeto** (`StyleSheet.create`), no en función.

**Fix canónico:**
- Poner layout (`width`/`flex`) en un **estilo-objeto plano**: `style={{ width }}` o `style={styles.x}`, NUNCA dentro de la función.
- Para el estado `pressed` sin tocar el layout, usar el **children-as-function** de `Pressable` y aplicar el prop de paint a un hijo con estilo-objeto:
  ```tsx
  <Pressable style={{ width }} android_ripple={{ color: 'rgba(255,255,255,0.18)' }}>
    {({ pressed }) => (
      <Inner style={{ width: '100%', opacity: pressed ? 0.9 : 1 }}>…</Inner>
    )}
  </Pressable>
  ```
- **Diagnóstico decisivo** cuando un flex-row "no llena el ancho": pintá el contenedor y los hijos con `backgroundColor` temporales + reload **limpio** (no fast-refresh: los cambios de layout en caliente no recalculan bien). Si el contenedor llena pero los hijos no → sospechar de la función-estilo. Un `console.log` de las dimensiones leído en el log de Metro confirma si los valores llegan correctos pero no se aplican.

---

### Search de direcciones — estado canónico (Tier 1.5–1.7 cerrados 2026-05-27 · fuzzy + sugerencias + emoji 2026-06-01)

> Esta sección documenta el estado actual del search y los patrones aprendidos durante 4 sesiones de trabajo (16 PRs mergeados). Sirve para diagnosticar bugs futuros sin re-descubrir contexto.

#### Estado actual en prod

| Pieza | Versión | Notas |
|---|---|---|
| RPC `public.search_streets` | v6 (migración 00333 aplicada) | pg_trgm fuzzy + escape wildcards + proximity buckets (25/100/300 km) + dedup main_street + alias normalization main + cross |
| Tabla `public.street_intersections` | poblada con 381,951 rows | 16 provincias, 23k calles únicas. La Habana sola 68k rows / 3,509 calles |
| EF `search-places-google` | version 5 ACTIVE | locationBias 25km + locationRestriction Cuba bbox + bbox margin ±0.2° + cache 30d + daily cap 1000 + session tokens |
| Helpers SQL | `_street_display_name`, `_street_normalize_key`, `_street_full_display` | Inmutables, reusables. Ver migración 00332/00333 |
| Cliente — 4 componentes search | Todos con AbortController + cache + empty state + cleanup | rider mobile, rider web, driver mobile, web landing |
| RPC `get_destination_suggestions` | 00359 (+ 00360 fix) aplicada | Predicciones de destino history-aware; servicio RPC-first con fallback cliente |
| RPCs de dirección cubana | 00361 unaccent + trgm | `find_intersection_point` / `suggest_cross_streets` tolerantes a acentos y typos; 00363 devuelve dirección canónica |
| RPC `search_pois_smart` | 00362 trgm | Nombres de POI tolerantes a typos |
| `cuba_pois.tricigo_category` | 00364 re-cat (DATA) | ~1241 filas `other` → transport/restaurant/religion/shop/park; el resto queda `other` |
| Resolver `searchResultEmoji` | `packages/utils/src/addressSearch.ts` (PR-F1 #361) | Emoji de categoría en TODO resultado: tricigo cat → calle 🛣️ / esquina 🔀 → categoría cruda → keyword del nombre → 📍 |

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

#### Novedades 2026-06-01 (fuzzy + sugerencias + emoji)

**1. `searchResultEmoji(result)` — emoji de categoría en TODO resultado.** Vive en `packages/utils/src/addressSearch.ts` (módulo compartido, con tests TDD). Cadena de fallback, primer match gana: (1) `tricigoCategoryEmoji` si la tricigo-category es conocida; (2) `category==='street'` → 🛣️, dirección con " e/ " / " entre " → 🔀; (3) mapa de **categoría cruda** del provider (landmark→🏛️, public_transport→🚌, botanical_garden→🌳, retail→🛍️…); (4) **keyword español del nombre** (capitolio→🏛️, teatro→🎭, museo→🖼️…); (5) 📍 solo como último recurso. Lo usan los 4 componentes (rider/web/driver/guest) — reemplazó sus mapas locales divergentes (`getResultIcon`/`getIcon`). Garantiza el emoji en pantalla aunque la DB tenga la categoría en `other`.

**2. Re-categorización de `other` (00364) — complementa al resolver.** `other` era la 2ª categoría más grande de `cuba_pois`. La migración (DATA, idempotente, conservadora) reclasificó ~1241 filas de alta confianza por su categoría cruda: public_transport→transport (~923), dining→restaurant, church→religion, retail→shop, garden/plaza→park. Lo ambiguo queda `other` y lo cubre el resolver por keyword. Verificación: `SELECT count(*) FROM cuba_pois WHERE tricigo_category='other' AND category='public_transport'` debe dar **0**; `tricigo_category='transport'` quedó en ~10.3k.

**3. `get_destination_suggestions` (00359/00360) — predicciones history-aware.** Servicio en `packages/api` con patrón **RPC-first + fallback cliente** (tolera ausencia de la RPC sin romper UX). El hook `useDestinationPredictions` quedó unificado entre rider y driver.

**4. Fuzzy matching cubano (00361/00362/00363).** `find_intersection_point` y `suggest_cross_streets` (00361) + `search_pois_smart` (00362) usan `unaccent` + `pg_trgm` → toleran acentos faltantes y typos. 00363 hace que `find_intersection_point` devuelva la dirección en forma **canónica** "X e/ Y y Z".

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
| 00359 / 00360 | `get_destination_suggestions` RPC (+ fix variable conflict) | Predicciones de destino history-aware (RPC-first, fallback cliente) |
| 00361 | RPCs de dirección cubana: unaccent + trgm | `find_intersection_point` / `suggest_cross_streets` tolerantes a acento + typo |
| 00362 | `search_pois_smart` trgm | Nombres de POI tolerantes a typos |
| 00363 | `find_intersection_point` — dirección canónica | Devuelve la forma canónica "X e/ Y y Z" |
| 00364 | Re-categorizar `other` cuba_pois (DATA) | ~1241 filas → transport/restaurant/religion/shop/park; conservador, idempotente |

**Numeración próxima libre:** verificar antes de cada PR nuevo con `git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -5`. (Al cierre 2026-06-01 la última es **00367**; próxima libre **00368**. Ojo: 00365/00366 son de *device-registry* y 00367 de *launch-readiness* (restore wallet gate), no de search.)

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

### Wallet model — 2 generaciones coexistiendo (verificado 2026-05-28)

**Esto es crítico para cualquier RPC nuevo o fix que toque dinero.** Hay 2 generaciones de wallets viviendo en `wallet_accounts` simultáneamente:

**Gen A (pre PR #184)** — código viejo aún los toca:
- Driver: `driver_cash` (earnings) + `driver_quota` (commission credit, deprecated)
- Customer: `customer_cash`

**Gen B (post PR #184)** — wallet "vivo" actual:
- Driver: `tricicoin` (consolidado, todo aquí)
- Customer: `customer_cash` (sin cambio — funciona como saldo TC)

**Drift histórico real verificado en prod**:
| account_type | balance total | users | notas |
|---|---|---|---|
| `tricicoin` | 196,814 | 7 drivers | Gen B activo |
| `driver_cash` | 228,696 | 3 | Gen A legacy, sigue creciendo si no se hace el fix |
| `customer_cash` | 23,600 | 3 | activo |
| `corporate_cash` | 5,000 | 1 | activo |
| `platform_revenue` | 82,044 | 1 | activo |

Ejemplo concreto: Eduardo Admin tiene `tricicoin=80,905` (visible) Y `driver_cash=−60,403` (legacy drift BUG-211).

**Patrón canónico cuando vas a tocar wallets en un RPC nuevo**:

1. **Drivers**: usar `tricicoin` para earnings y commission. NUNCA `driver_cash` (excepto insurance que sigue ahí por legacy — referencia el código del ELSE branch en `complete_ride_and_pay`).
2. **Customers**: usar `customer_cash` para saldo TC.
3. **Corporate**: `corporate_cash` para wallet de empresa (necesita `admin_adjust_wallet` extended desde 00338 para acreditar via RPC oficial).
4. **Platform**: `platform_revenue` para commissions/insurance.

**Si encontrás un RPC que credita `driver_cash` para earnings**: es bug silencioso. Verificar con SQL `SELECT prosrc FROM pg_proc WHERE proname='X'` y buscar `'driver_cash'`. Fix patrón: change `ensure_wallet_account(_, 'driver_cash')` → `'tricicoin'` para el path del driver.

Migration de referencia: `00340_complete_ride_and_pay_tricicoin_mixed_fix.sql` cerró este bug para los payment methods `tricicoin` y `mixed`.

**`held_balance` está FUERA del modelo de ancla USD (deuda dormida, verificado 2026-06-27).** El ancla (revaluación + trigger) solo razona sobre `wallet_accounts.balance`; `held_balance` (fondos congelados en holds) no participa. Hoy es inofensivo porque los holds están dormidos (`held_balance=0` siempre; `complete_ride_and_pay` debita `balance` directo, no usa holds). **Si alguna vez se reactivan los holds** (mover N CUP de `balance`→`held` al iniciar un viaje), el ancla quedará reflejando solo `balance` y se desincronizará de `balance+held` → al liberar/capturar el hold la revaluación puede regalar o destruir valor. Antes de reactivar holds hay que extender el modelo de ancla para que cubra `balance + held_balance` (o snapshotear el ancla del monto congelado). Auditoría FX: `~/.claude/plans/tengo-una-pregunta-porque-composed-hare.md`.

### Auditoría secuencial pattern — Explore → SQL → Plan → PRs en cadena

**Patrón verificado 2026-05-27 / 28** ejecutando 3 audits grandes (corporate, driver rendering, payment methods). Funcionó bien y produjo 13 PRs mergeados con cero rollbacks.

**Fases**:

1. **Phase 1 — Explore agents en paralelo** (max 3): map codebase para entender el flujo. Útil para preguntas tipo "¿funciona X?" donde necesitamos abrirnos primero.

2. **Phase 2 — Queries SQL en prod para grounding real**: los Explore agents pueden reportar bugs basados en código viejo. SIEMPRE verificar contra prod con `SELECT pg_get_functiondef(...)` del RPC actual (lo que está vivo, no lo que dice la migration #N). En este sesión, el primer Explore agent dijo "tricicoin está roto" basándose en mig 00247, pero pg_get_functiondef confirmó que la migration última 00247 sigue siendo la vigente y efectivamente tenía el bug.

3. **Phase 3 — Real data check**: ¿cuántas veces se ejercitó esto en prod? Si 0 veces, el bug es silencioso histórico (caso de tricicoin/mixed: 0 rides ever, 47 cash rides). Datos cambian la prioridad del fix.

4. **Phase 4 — Plan file con propuestas PR-XXX-N**: documentar findings + propuestas con scope claro. Usar `AskUserQuestion` para confirmar scope antes de ExitPlanMode.

5. **Phase 5 — PRs en cadena** (PR-XXX-1, PR-XXX-2, ...) cada uno con su branch fresh from origin/master, check-types, commit, push, autorización explícita per-PR (per CLAUDE.md), merge, opcionalmente apply migration via MCP.

**Performance metric**: este pattern produjo 8 migrations aplicadas + 13 PRs mergeados en una sesión, sin rollbacks ni bugs introducidos en otras áreas.

### Sweep de contrato cliente↔prod — el cliente Supabase está SIN tipar (verificado 2026-06-13, PR #517)

`getSupabaseClient()` devuelve `SupabaseClient` **sin** el genérico `<Database>` (ver `packages/api/src/client.ts`). Consecuencia crítica: `.rpc('fn', {args})`, `.from(t).insert/update/upsert({...})`, `.eq('col',...)`, `.select('cols')` son **loosely-typed** → **`tsc` NO caza typos** de nombre de RPC-arg, columna ni payload. Esa clase de bug es **runtime-only** (PostgREST `PGRST202` "función no encontrada" / `42703` "columna no existe") y suele estar en code paths que no se ejercitan seguido (admin, sitemap, métodos muertos). **Si algún día el cliente se tipa con `<Database>`, esta clase entera la cubre tsc y este sweep deja de hacer falta.**

**Cómo barrer (mecánico, alta precisión, contra prod viva):**

1. **RPC args vs firma real.** Extraé toda `.rpc('fn', {keys})` del repo (parser que captura el 1er string literal + las top-level keys del 2º arg objeto, depth-aware). Por cada `fn`, traé `pg_get_function_arguments(oid)` + `pronargs`/`pronargdefaults` de prod. Reglas PostgREST: (a) **arg extra** del cliente que NO está en los params → la función no resuelve (PGRST202); (b) **param requerido** (los primeros `pronargs − pronargdefaults`, los defaults van trailing en PG) que ningún call site provee → falla. El union de keys cross-call-site hace el check (a) conservador (caza cualquier site).
2. **Columnas write/filter vs schema.** Extraé `.from(t).insert/update/upsert({...})` (keys del payload) + columnas de `.eq/.neq/.gt/.gte/.lt/.lte/.like/.ilike/.is/.in/.order/.contains('col',…)`. **CRÍTICO: acotá el chain a UN solo statement** — desde el `.from(` hasta el **primer `;`** (terminador; los method-chains no tienen `;` top-level) o el siguiente `.from(`, lo que venga antes. Sin esto, columnas de statements adyacentes **sangran** (bleed) y generás decenas de falsos positivos. Después emití los pares `(tabla, columna, kind)` a un `WITH client_refs(...) AS (VALUES …) … LEFT JOIN information_schema.columns … WHERE column_name IS NULL AND tbl IN (tablas de prod)` (excluí buckets de storage: `avatars/receipts/driver-documents/delivery-photos/dispute-evidence/driver-contracts` — son `storage.from()`, no tablas).
3. **Verificá cada candidato con grep/Read del source** antes de afirmarlo (puede quedar 1 bleed residual; y distinguí método muerto vs. live path con `grep` de callers).
4. **Advisors de Supabase** (`get_advisors security|performance`) en la misma pasada: output gigante → parsealo con un script Node (`j.result.lints`, campos `name/level/metadata.{schema,name,type}/detail`). Ruido conocido a descartar: ERROR `spatial_ref_sys` (PostGIS, no se le puede poner RLS); `rls_enabled_no_policy` en tablas-candado intencionales (`otp_codes`, `rate_limits`, caches, counters — incl. `email_sends`, `google_directions_cache`, `google_directions_daily_counter`, `poi_sync_state`) + las `zzz_backup_*`; `anon/authenticated_security_definer_function_executable` mayormente intencional (share links por token, config/geo públicos, fns de trigger inocuas); `rls_policy_always_true` ×3 en `influencers_campaign` (tabla huérfana de marketing creada a mano en prod, **riesgo aceptado explícitamente por el usuario 2026-07-01 — NO tocar ni re-alertar**); performance (initplan/multi-permissive/FK sin índice) = higiene-a-escala, **no** bloqueante de lanzamiento (varios counts inflados tras un wipe).

Resultado del 1er sweep (PR #517): 99 RPCs + 489 refs de columna → **3 bugs reales** (param de RPC en método muerto, `sitemap` filtrando `blog_posts.status` inexistente → blog fuera del sitemap, toggle admin escribiendo `reviews.is_featured` inexistente → mig 00416). Resto del contrato **sano**.

**Ruido esperado en logs de prod (verificado en la auditoría de readiness 2026-07-01 — NO re-diagnosticar):** (a) los logs de EF muestran **401 cada 2 min** en `create-netopia-payment-intent` y `mint-netopia-proxy-credential` = crons **keepwarm** (cron.job 33/34, header `x-keepwarm`) que mantienen calientes las EFs NETOPIA; el 401 es esperado — la función bootea y responde, y eso basta para el warm. (b) Los logs de auth se saturan de `GET /user` 403 (`bad_jwt` / `missing sub claim`) = **monitor de uptime externo** (IPs AWS rotando) que carga tricigo.com cada 2 min y el JS de la web llama `getUser()` sin sesión al montar — benigno, pero consume el tope de 100 entradas de `get_logs service=auth` en <1h (para auditar logins reales, filtrar ese patrón). (c) Transacciones de ledger **single-entry** (recargas, ajustes admin) son por diseño — dinero externo, ver §10b de `supabase/money-health-check.sql`; el chequeo canónico de dinero es ese archivo (9 checks = 0 filas en el estado sano, verificado 2026-07-01).

### Pattern para CREATE OR REPLACE FUNCTION grandes (≥7k chars)

**Verificado 2026-05-28 con `complete_ride_and_pay` de 24,240 chars.**

`pg_get_functiondef(oid)` retorna el cuerpo completo del RPC, pero `mcp__execute_sql` tiene limit ~30k de output. Para RPCs grandes que necesitás reproducir verbatim:

```sql
-- Fetch en chunks de 7000 chars
SELECT substring(pg_get_functiondef(oid) FROM 1 FOR 7000) AS chunk1
FROM pg_proc WHERE proname = 'X' LIMIT 1;

SELECT substring(pg_get_functiondef(oid) FROM 7001 FOR 7000) AS chunk2
FROM pg_proc WHERE proname = 'X' LIMIT 1;

-- ... continuar
```

Luego ensamblar el archivo de migración con la fuente completa + cambios surgicales. CREATE OR REPLACE FUNCTION debe tener la SAME signature (mismos params + mismo arg count) — sino Postgres crea overload en vez de replace.

**Para cambios de arity** (params nuevos), DROP FUNCTION primero con la signature vieja, después CREATE. Ver `00336_find_best_drivers_fleet_priority.sql` para el ejemplo (12 params → 13 params).

#### Patch in-place para cambios de UNA línea en RPCs grandes (verificado 2026-06-13)

Cuando solo necesitás cambiar 1-2 strings en un RPC de ~24k chars (ej: `'driver_cash'` → `'tricicoin'`, agregar un `AND` a un `WHERE`), **NO reescribas el cuerpo entero** — el verbatim tiene riesgo de transcripción y **puede perder features** silenciosamente (cf. regresión 00124). En su lugar, leé el cuerpo VIVO y patcheálo server-side:

```sql
DO $patch$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef('public.fn(args)'::regprocedure) INTO v_src;
  IF v_src IS NOT NULL AND position('<target literal>' IN v_src) > 0 THEN
    EXECUTE replace(v_src, '<target literal>', '<replacement>');
    RAISE NOTICE '...';
  END IF;
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE 'fn absent; skipping';
END $patch$;
```

Reglas: (1) **verificá que el target sea único ANTES** — `(length(prosrc)-length(replace(prosrc,'target','')))/length('target')` debe dar 1; (2) **idempotente** — agregá un guard `AND position('<marker-del-cambio>' IN v_src) = 0` para no re-aplicar; (3) escapá comillas simples en los literales (`''driver_cash''`); (4) el `EXCEPTION WHEN undefined_function` lo hace seguro en DBs frescas (la función la crea una migración anterior; el patch corre después por número). **Ventaja clave sobre el verbatim: no puede perder features** porque parte del cuerpo vivo. Ejemplos: `00408` (`complete_ride_and_pay` `driver_cash`→`tricicoin`; `find_best_drivers` + filtro de heartbeat).

### Fleet membership 3-way gate (corporate)

**Verificado en migraciones 00336 + 00337.**

Para gates donde "solo drivers de la flota del corporate":

```sql
-- 3-way check defensive:
SELECT EXISTS (
  SELECT 1
  FROM corporate_accounts ca
  WHERE ca.id = v_corporate_account_id
    AND ca.is_fleet_owner = true
    AND EXISTS (
      SELECT 1 FROM fleet_members fm
      JOIN driver_fleets df ON df.id = fm.fleet_id
      WHERE df.corporate_account_id = ca.id
        AND fm.status = 'active'
        AND fm.driver_id IS NOT NULL  -- KEY: skip pending_signup
    )
) INTO v_use_fleet_restriction;
```

**Falsos negativos defensivos**: si el corp NO es fleet_owner, o NO tiene members activos, la gate se desactiva silenciosamente. Esto evita romper service mid-setup (corp recién creada sin drivers asignados todavía).

**FK schema importante**: `fleet_members.driver_id` referencia `users.id`, NO `driver_profiles.id`. En el JOIN final, usar `fm.driver_id = dp.user_id` (NO `dp.id`).

### Smoke test E2E paths cuando el rider OTP no funciona

Verificado 2026-05-28 — cuando un test rider está en otro país (Lucía en Brasil) y no puede recibir OTP cubano, hay 3 alternativas:

| Opción | Descripción | Cuándo elegir |
|---|---|---|
| **A** | Eduardo (super_admin + driver + employee) rider Y driver en 2 devices | Más realista, no rompe nada. `accept_ride_v2` no tiene check `customer_id ≠ driver_id`. |
| **B** | Simular ride via SQL/RPC directo | Salta UI pero valida backend (triggers + ledger). Útil para validar `complete_ride_and_pay` branches. |
| **C** | Bypass OTP via admin SDK (createSession) | Genera token de sesión sin SMS. Requiere dev build, más setup. |

En la sesión 2026-05-28 elegimos esperar a Lucía (Opción "esperá") pero las 3 alternativas funcionan. Para futuras situaciones similares, escalar a Opción A primero.

### Patrón de Admin map: react-leaflet vs Mapbox-gl-js

**Decisión verificada 2026-05-28 (PR-MAP-1).**

El admin app (`apps/admin/`) usa **react-leaflet** para mapas (`live-map`, `fleet`), NO mapbox-gl-js. El web app usa mapbox-gl-js. El mobile usa `@rnmapbox/maps`.

**Cuándo usar cuál**:
- Admin nuevas pantallas con mapa → react-leaflet (consistente con live-map existente, sin dep adicional)
- Web nuevas pantallas con mapa → mapbox-gl-js (consistente con BookingMap)
- Mobile → `@rnmapbox/maps`

**Pattern react-leaflet en admin** (referencia `apps/admin/src/app/fleet/page.tsx`):
- `dynamic` import con `ssr: false` (Leaflet toca `window`)
- `MapContainer` + `TileLayer` + `CircleMarker` + `Popup` (no GeoJSON sources tipo Mapbox)
- Realtime via Supabase channel + 30s polling fallback

---

### Feature "Regalo" (gift P2P closed-loop) — estado canónico (cerrado 2026-05-29)

**Qué es.** Un usuario envía saldo TriciCoin a un amigo dentro de la app, posicionado como **"Regalo"** (no "transferencia de dinero"). Disponible en cliente, conductor y admin. Esto **revierte deliberadamente** la decisión de `00274_remove_p2p_transfer.sql` (que eliminó el P2P libre por riesgo e-money), reposicionándolo como **closed-loop**: el destinatario debe ser un usuario TriciGo activo, el saldo regalado solo se gasta en viajes (no cash-out), y el admin puede revertir/congelar.

**Mecánica.** El regalo es una **transferencia atómica de doble entrada** (misma plantilla que el `transfer_wallet_p2p` removido). Wallet origen/destino **según rol**: pasajero → `customer_cash`, conductor → `tricicoin` (cross-type permitido por el ledger). Resuelto server-side por el helper `_gift_wallet_type(user_id)`.

**Migraciones `00343`–`00346` (aplicadas a prod + verificadas).** RPCs vivos:
| RPC | Qué hace | Gate |
|---|---|---|
| `send_gift(from, to, amount, note)` | débito wallet-rol emisor + crédito wallet-rol receptor; `wallet_transfers.kind='gift'` | `is_admin() OR auth.uid()=from`; valida `amount>0`, no-self, receptor `is_active`, saldo, no-frozen |
| `find_user_by_phone(phone)` | restaurado verbatim de `00216` | auth + `check_rate_limit(...,30,3600)` + match exacto + revoke anon (anti-enumeración BUG-195) |
| `find_user_by_gift_code(code)` | resuelve `referral_codes.code → user` | auth + mismo rate-limit |
| `admin_send_gift(...)` | regalo manual desde `platform_promotions` | doble gate admin (`auth.uid()=admin_id` + rol) + `admin_actions` audit |
| `admin_reverse_gift(transfer_id, admin_id)` | **asiento de compensación** (receptor→emisor), marca `reversed_at/reversed_by` | gate admin; ledger inmutable (nunca UPDATE) |
| `get_gift_stats()` | KPIs globales (total, reversed, volumen, 7d, distinct senders) | `is_admin()` |
| `freeze_wallet` / `unfreeze_wallet` | congelar/descongelar wallet de abusador | reusados de `00013`; `send_gift` falla con "wallet frozen" |

**QR (Fase 2).** Generar: `react-native-qrcode-svg` (JS puro sobre `react-native-svg` ya presente → **NO requiere rebuild**), render con guard `Platform.OS !== 'web'`. Escanear: `expo-camera` (`CameraView` + `barcodeScannerSettings={{barcodeTypes:['qr']}}`) en `apps/<app>/src/components/GiftQrScanner.tsx` (**NO** en `packages/ui`, para no meter `expo-camera` como dep del paquete compartido) → **requiere rebuild APK**. Deep link `tricigo://gift/<code>` (driver: `tricigo-driver://`): `apps/<app>/app/gift/[code].tsx` **resuelve** el código → usuario y abre la pantalla de regalo pre-cargada (NO "redime" como referido — el código identifica al **destinatario**).

**Service layer.** `walletService.sendGift/findUserByPhone/findUserByGiftCode/getGifts`; `adminService.getGiftStats/freezeWallet/unfreezeWallet` (toman el admin via `getUser()` internamente). Schemas `sendGiftSchema` + `giftCodeSchema` (`/^[A-Za-z0-9]{6,16}$/`) reemplazaron al huérfano `transferP2PSchema`. PRs Fase 1: #279/#280/#281/#282; Fase 2 extendió esos mismos PRs + #287 (admin) + #288 (plugin fix).

---

### Feature "Compartir viaje" (shared ride) — estado canónico (cerrado 2026-05-29)

**Qué es.** Para viajes en **triciclo** (`triciclo_basico`, único triciclo de pasajeros), el pasajero activa "Compartir viaje": acepta que el conductor recoja otros pasajeros (efectivo, **fuera de la app**) en los asientos libres. Por cada asiento libre que ofrece, el pasajero recibe un **descuento por adelantado** (7% por asiento, configurable). El conductor lo ve **solo informativo** (badge "Comparte · N asientos") y cobra sobre la tarifa con descuento; su incentivo es el efectivo extra.

**El punto clave de seguridad.** `rides.discount_amount_cup` **NO se confía del cliente** — el trigger `tg_rides_validate_promo_discount` (BUG-115, `00172`, endurecido en `00320/00322`) lo recomputa server-side en cada INSERT/UPDATE. Por eso el descuento por compartir **no se puede sumar desde el cliente**. **Solución: extender ese mismo trigger** (`00347`) para que sume promo + compartir en `discount_amount_cup`. Así `complete_ride_and_pay` y el estimate snapshot **NO cambian** (su `final = snapshot.total − discount_amount_cup + wait` ya resta el total).

**Migración `00347` (aplicada a prod + verificada).**
1. `UPDATE service_type_configs SET max_passengers = 4 WHERE slug='triciclo_basico'` (estaba en 8).
2. `INSERT platform_config ('shared_ride_discount_per_seat_pct','7') ON CONFLICT DO NOTHING`.
3. Columnas en `rides`: `shared_ride BOOL`, `shared_ride_seats_occupied INT`, `shared_ride_discount_cup INT` (audit/display).
4. `CREATE OR REPLACE tg_rides_validate_promo_discount()` con un bloque shared-ride al inicio (clamp `seats_occupied` a `[1, cap−1]`, `free = cap−occ`, `v_shared = FLOOR(estimated_fare × free × pct/100)`) y **cada** asignación de `discount_amount_cup` arrastra `v_shared` (aplica con o sin promo). Final: `LEAST(promo + shared, estimated_fare)`. Trigger recreado con `UPDATE OF ..., shared_ride, shared_ride_seats_occupied`.

**Verificado en prod** (transacción rolleada): triciclo fare 2200, 1 asiento ocupado → 3 libres → `shared_ride_discount_cup = FLOOR(2200×3×7/100) = 462` ✓. **Anti-tamper**: cliente manda `discount_amount_cup=9999` en ride no-compartido → recomputado a **0** ✓.

**Frontend.** Cliente: `ride.store.ts` (`shareRide` + `setShareRide`, reusa `passengerCount` como asientos ocupados); toggle "Compartir viaje" en `app/(tabs)/index.tsx` (solo `serviceType==='triciclo_basico'` y tarifa>0) con preview en vivo; `useRide.ts` pasa `share_ride`+`declared_passengers` (solo triciclo). Conductor: badge en `IncomingRideCard.tsx`. Admin: `shared_ride_discount_per_seat_pct` en `KNOWN_KEYS` (super_admin edita). PRs #289 (backend) / #290 (driver) / #291 (cliente) / #292 (admin).

---

### Patrones reutilizables (de las features Regalo + Compartir viaje)

**1. Extender un trigger de validación de descuento server-side (en vez de confiar del cliente).** Cuando un campo monetario es server-authoritative vía trigger (`discount_amount_cup` lo recomputa `tg_rides_validate_promo_discount`), **no agregues una segunda fuente sumable desde el cliente** — el trigger la borraría. En su lugar **extendé el trigger** para que calcule la pieza nueva server-side y la sume. Reglas:
- Verificá la versión **LIVE** vía `pg_get_functiondef(oid)` ANTES de hacer `CREATE OR REPLACE` — el cuerpo puede haber sido endurecido en migraciones posteriores (acá: claim atómico de promo de `00320/00322`). Copiá el cuerpo vivo, no la migración original.
- La pieza nueva se calcula al inicio y se arrastra en **todas** las ramas de salida (incluyendo las de "no hay promo" / "promo inválida"), no solo en la rama feliz.
- Cap final defensivo: `LEAST(suma, COALESCE(estimated_fare,0))` → nunca deja la tarifa negativa downstream.
- Recreá el TRIGGER agregando las columnas nuevas al `UPDATE OF` (sino no dispara cuando solo cambian esas columnas).
- Test anti-tamper en transacción rolleada: mandá un valor inflado desde el "cliente" y confirmá que el trigger lo recomputa.

**2. Config numérica editable por admin vía `platform_config` + `get_platform_config_numeric`.** Para un parámetro que el admin debe poder cambiar sin deploy (acá: `shared_ride_discount_per_seat_pct`):
- Migración: `INSERT INTO platform_config (key,value) VALUES ('mi_key','default') ON CONFLICT (key) DO NOTHING`.
- Server (trigger/RPC): leer con `get_platform_config_numeric('mi_key', <fallback>)` — nunca hardcodear el valor.
- Admin UI: agregar `mi_key: { type: 'number', helpKey: 'platform_config.mi_key_help' }` al registro `KNOWN_KEYS` de `apps/admin/src/app/settings/platform-config/page.tsx` + help text en es/en/pt `admin.json`. La pantalla ya renderiza/persiste las known keys; escritura gated a `super_admin` (mig `00292`).
- Preview en cliente: leer el mismo valor con `walletService.getConfigValue(...)` para que el preview coincida con lo que el server aplicará.

**3. Cadena de PRs apilados por capa, rebasados tras el merge del base.** Features que tocan backend+apps se entregan en cadena (PR-1 migración+service+types → PR-2 cliente → PR-3 driver → PR-4 admin), cada branch desde `origin/master`. Cuando los dependientes se ramifican del backend, **tras mergear el backend (squash)**: `git fetch`; por cada dependiente `git rebase --onto origin/master <sha-base-viejo>` (dropea el commit de backend ya squasheado) + `git push --force-with-lease`. Resultado: cada PR queda con su diff limpio de 1 commit. Autorización **explícita per-PR** para cada merge/force-push/apply (MCP guard + classifier).

---

### Feature "Tier / Niveles de lealtad" (sube con viajes completados) — estado canónico (cerrado 2026-06-03)

**Qué es.** El nivel del usuario (`users.level`, enum `user_level`) **sube solo a medida que la persona completa viajes**. 5 niveles: `bronce < plata < oro < platino < diamante`. Antes la feature (de `00009`, feb 2024) estaba **huérfana**: todos quedaban en `bronce` para siempre.

**Causa raíz que arregló (verificada contra prod, no solo migraciones):** (a) los contadores por usuario (`users.total_rides`/`total_spent`) nunca se incrementaban — `complete_ride_and_pay` solo toca `driver_profiles.total_rides_completed`; (b) `maybe_promote_user_level()` no tenía caller (el trigger que `00015` decía crear **no existía** entre los triggers vivos de `rides`).

**Decisión del usuario (2026-06-03):** criterio = **solo viajes completados** (sin gasto); **5 niveles** (se agregó platino/diamante al enum); aplica a **pasajeros Y conductores** (un mismo `users.level`; el conteo = viajes de la persona como rider + como driver).

**Migraciones (aplicadas a prod + verificadas; PR #386):**
| Migración | Qué hace |
|---|---|
| `00370_user_level_add_platino_diamante.sql` | `ALTER TYPE user_level ADD VALUE 'platino'/'diamante' AFTER 'oro'/'platino'` (orden de comparación correcto) + 4 keys de umbral en `platform_config`. *(Parte 1: NO usa los valores nuevos — PG prohíbe usar un `ADD VALUE` en la misma txn que lo agrega.)* |
| `00371_recompute_user_level_trips.sql` | `recompute_user_level(uuid)` + trigger `trg_recompute_level_on_complete` + deprecación de `maybe_promote_user_level` + backfill idempotente |

**Mecánica clave.**
- `recompute_user_level(p_user_id)` cuenta viajes `status='completed'` de la persona (como `customer_id` + como driver vía `driver_profiles.user_id`), elige nivel por umbrales, y hace `UPDATE users SET total_rides = <conteo>, level = GREATEST(level, <nuevo>)`. **SET, no `+1`** → self-healing, sin el drift del contador legacy (ver "stale precomputed field"). **Promote-only** (`GREATEST`) → nadie baja ni se pisan overrides manuales de admin.
- Trigger `AFTER UPDATE ON rides WHEN (NEW.status='completed' AND OLD.status<>'completed')` recalcula al **pasajero y al conductor**. **Defensivo** (`EXCEPTION WHEN OTHERS THEN RETURN NEW`): un fallo de tier NUNCA bloquea el cierre del viaje.
- Backfill idempotente recalculó a todos desde el historial. Verificado en prod: María/Carlos 120→diamante, Eduardo Admin 51 (27 rider + 24 driver)→platino, Papa 24→oro, Eduardo Daniel 18→plata, <5 viajes→bronce.

**Tunables `platform_config`** (editables por admin sin redeploy, leídos con `get_platform_config_numeric`): `tier_plata_min_trips` (5), `tier_oro_min_trips` (20), `tier_platino_min_trips` (50), `tier_diamante_min_trips` (100). El ladder es **único** para riders y drivers (un driver activo sube rápido; si se quiere distinto, duplicar keys `*_driver`).

**Frontend.** Tipo `UserLevel` (5 valores) en `packages/types`; i18n es/en/pt: `common.json` `profile.level_platino/diamante` (badge móvil) + `admin.json` `users.level_platinum/diamond`. Badge de tier en perfil de **pasajero** (`StatusBadge`) y **conductor** (píldora que reusa el patrón del status-pill, sin meter `StatusBadge` en el header cubano a medida). Admin: `<select>` de override con los 5 niveles + las 4 keys de umbral en platform-config. Web: el perfil ahora lee `users.level` de la DB (antes leía `user_metadata.level` stale → el badge nunca aparecía). **Los textos Platino/Diamante requieren rebuild del APK** — las builds instaladas pre-merge no tienen esas 2 keys; un build nuevo desde `master` sí.

**Diagnóstico.**
```sql
-- estado del tier de cada usuario con viajes vs su conteo real
SELECT u.full_name, u.level, u.total_rides AS cache,
  (SELECT count(*) FROM rides r WHERE r.customer_id=u.id AND r.status='completed')
  + (SELECT count(*) FROM rides r JOIN driver_profiles dp ON dp.id=r.driver_id
       WHERE dp.user_id=u.id AND r.status='completed') AS trips_reales
FROM users u WHERE u.total_rides>0 OR u.level<>'bronce' ORDER BY trips_reales DESC;
-- forzar recálculo de un usuario
SELECT recompute_user_level('<user_id>');
```

**Deuda diferida:** dropear `maybe_promote_user_level` (deprecada, sin callers) tras confirmar; `total_spent` queda como cache derivado sin uso (criterio = solo viajes).

---

### Feature "Castigo por cancelar" (reputación, no dinero) — estado canónico (cerrado 2026-06-03)

**Qué es.** Cancelar un viaje **ya no cobra dinero**. Una cancelación **tardía** baja las **estrellas visibles** (`rating_avg`) de quien cancela —rider o driver— y eso le cuesta **prioridad de matching**. Reemplaza deliberadamente el modelo monetario previo (`apply_cancellation_fee` que compensaba al driver + `apply_cancellation_penalty` progresiva que iba a la plataforma + bloqueo en la 5ª).

**Decisión del usuario (2026-06-03):** castigar sin dinero, bajando el **rating de estrellas** (NO un score separado), para **ambos roles**, consecuencia = **menor prioridad de emparejamiento**.

**Migraciones (aplicadas a prod + verificadas; numeración FINAL en git tras la renumeración #388).**
| Migración | Qué hace |
|---|---|
| `00372_cancellation_rating_events.sql` | Tabla `cancellation_rating_events` (1 fila por cancelación tardía; `rating_value` NULL = gracia) + `recompute_user_rating()` + `apply_user_rating()` + `update_rating_avg()` reescrito (promedia **reviews + eventos de cancelación**, ventana configurable) + trigger + 6 `platform_config` keys |
| `00373_cancel_ride_reputation.sql` | `cancel_ride()` sin dinero (inserta evento con progresión + gracia + exención no-show) + `preview_cancellation_rating_impact()`; `apply_cancellation_fee` / `apply_cancellation_penalty` **DEPRECADAS** (no se llaman, no se dropean) |
| `00374_dispatch_low_rating_rider_gate.sql` | `dispatch_ride()` gate suave de prioridad para riders bajo umbral (1ª ronda con menos drivers/radio; el retry loop existente los rescata) |

**Mecánica clave.**
- **Elegibilidad** (simétrica rider/driver): estado activo (`accepted`/`driver_en_route`/`arrived_at_pickup`/`in_progress`) Y fuera de `free_cancel_window_s` (120s). En `searching` (sin driver) = gracia total.
- **Progresión** (por usuario, ventana 24h): 1ª tardía = gracia (evento con `rating_value` NULL → no baja el promedio pero cuenta para la progresión); 2ª → `cancel_rating_value_second` (3.0★); 3ª+ → `cancel_rating_value_third` (2.0★).
- **No-show**: un driver que cancela con reason `%no_show%` NO se penaliza (el pasajero no apareció; penalizar al rider no-show queda como mejora futura — requiere prueba server-side).
- **Recálculo**: `rating_avg` = AVG(reviews visibles + eventos no-gracia dentro de `cancel_rating_event_window_days`). Sin eventos reproduce el AVG de reviews **exacto** (no altera ratings existentes). Verificado en prod: 1 evento de 3.0★ sobre 6 reviews de 4.5 → 4.29.
- **Menor prioridad de matching**: el driver es **automático** (su `rating_avg` ya pesa 20% en `find_best_drivers` → menos estrellas, menos ofertas); el rider es el **gate** de `dispatch_ride` (configurable, `low_rating_rider_threshold=0` lo desactiva).

**Tunables `platform_config`** (sin redeploy): `cancel_rating_value_second` (3.0), `cancel_rating_value_third` (2.0), `cancel_rating_event_window_days` (90; 0 = permanente), `low_rating_rider_threshold` (3.0; **0 desactiva el gate**), `low_rating_rider_dispatch_limit` (5), `low_rating_rider_radius_m` (3000).

**Frontend.** TS: `CancellationFeePreview` → `CancellationRatingImpact`; `cancelRide` devuelve `ratingImpact`; `previewCancellationImpact()` tolera RPC ausente. UI "Tu calificación bajará ★X→★Y" en `CancelRideSheet` / `RideActiveView` / `useRide` (cliente), `track/[id]` (web) y `trip.cancel_body` (driver) + i18n es/en/pt. **`cancel_ride` mantiene `fee_cup`/`penalty_amount`=0 → las apps móviles viejas muestran "gratis" sin romperse; la UI nueva requiere rebuild de las apps.**

**Diagnóstico.**
```sql
-- ¿cancel_ride dejó de cobrar y usa reputación?
SELECT (prosrc ILIKE '%cancellation_rating_events%' AND prosrc NOT ILIKE '%apply_cancellation_fee%') AS no_money
FROM pg_proc WHERE proname='cancel_ride' AND pronamespace='public'::regnamespace;
-- eventos recientes
SELECT user_id, rating_value, role_at_event, reason, created_at
FROM cancellation_rating_events ORDER BY created_at DESC LIMIT 20;
```

---

### Correo de "nuevo dispositivo" con cuerpo `security_new_device` — trigger huérfano + template key desincronizada (verificado 2026-06-01)

**Síntoma:** al iniciar sesión llega un correo (remitente `noreply@tricigo.com`, asunto "🔐 Inicio de sesión nuevo — TriciGo") cuyo **cuerpo es literalmente la cadena `security_new_device`**.

**NO es Supabase nativo** (pista falsa que costó tiempo): los correos de auth de Supabase salen de su built-in email service (custom SMTP NO configurado), no de `noreply@tricigo.com`; y el Dashboard (Auth → Emails → Security) **no tiene** ningún toggle "Signed in from a new device" (sus notifs son password/email/phone changed, sign-in linked/removed, MFA added/removed). Tampoco es el mecanismo móvil `register-login-device`.

**Causa raíz:** lo manda un **trigger HUÉRFANO en `auth.sessions`** — `trg_send_security_new_device_email` → `public.send_security_new_device_email()` (creado a mano en prod, **nunca estuvo en git**, no aparece en `grep` del repo). Hace `net.http_post` a la EF `send-email` con `template: 'security_new_device'`. Esa key **no está registrada** en `supabase/functions/_shared/email-templates/index.ts`, así que `resolveTemplate()` ([send-email/index.ts](supabase/functions/send-email/index.ts)) cae al **legacy path** que trata el string del `template` como **HTML crudo** → el cuerpo termina siendo "security_new_device". El registry se reescribió el **2026-05-12** y el template nuevo quedó como `new_device_login`, pero **nadie actualizó el trigger** → patrón "renombraron pero quedó el caller viejo" (mismo de la sección de `driver_cash`).

**Fix (migración `00365`, aplicada a prod 2026-06-01):** `CREATE OR REPLACE` de la función para llamar `template: 'new_device_login'` (registrado) con data `{email, date, ip, device, os}` (+ fecha en español America/Havana). Trae el huérfano a git. Se conservó la dedup por user-agent (30d) y el `EXCEPTION WHEN OTHERS THEN RETURN NEW`.

**Dos mecanismos de nuevo-dispositivo coexisten** (deuda a consolidar): (A) este trigger server-side en `auth.sessions` (heurística de user-agent, el único que dispara hoy); (B) EF `register-login-device` + `user_known_devices` (app-driven, device_id estable) — **dormido**: `user_known_devices` tiene 0 filas porque las apps móviles instaladas aún no shippean la llamada `deviceService.registerLoginDevice` (requiere release). Cuando salga el release, decidir si se elimina A para no duplicar correos.

**Tips diagnósticos reutilizables:** (1) si el **cuerpo** de un correo es una key cruda, es `send-email` cayendo al legacy path por una `template` key que no pasa `isTemplateKey()` — buscá el caller (EF, **trigger DB**, cron) que manda esa key. (2) Para ver el correo real (remitente/asunto/cuerpo) usá el **MCP de Gmail** (`search_threads`/`get_thread`): el remitente distingue app (`noreply@tricigo.com`/Resend) vs Supabase. (3) Objetos huérfanos en prod (funciones/triggers creados a mano, no en migraciones) existen — confirmá con `pg_get_functiondef` + `pg_trigger`, no solo con `grep` del repo.

### Correo de "regalo" con cuerpo `driver_payout` — FAMILIA de 6 triggers de email huérfanos (verificado 2026-06-03, PR #392 / mig 00375)

**Síntoma:** al recibir un **regalo** llega un correo (remitente `noreply@tricigo.com`, asunto "Pago recibido — TriciGo") cuyo **cuerpo es literalmente `driver_payout`**. Misma clase de bug que `security_new_device`/00365, pero **no era 1 trigger — eran 6**.

**Causa raíz:** `send_gift` inserta en `wallet_transfers`, lo que dispara el trigger huérfano `trg_send_driver_payout_email` → `send_driver_payout_email()` → `net.http_post` a `send-email` con `template: 'driver_payout'`, key **no registrada** → legacy path → cuerpo crudo. El forense (`prosrc ILIKE '%send-email%'`) reveló **6 funciones de email huérfanas** (ninguna en git), todas con keys no registradas:

| Trigger / tabla-evento | template key faltante |
|---|---|
| `trg_send_driver_payout_email` (`wallet_transfers` INSERT) | `driver_payout` |
| `trg_send_cargo_bonus_email` (`ledger_transactions`, `cargo_bonus:%`) | `driver_payout` |
| `trg_send_delivery_receipt` (`rides` completed cargo) | `delivery_receipt_customer` |
| `trg_send_first_ride_email` (`rides` completed passenger 1º) | `first_ride_celebration` |
| `trg_send_payment_failed_email` (`payment_intents`→failed) | `payment_failed` |
| `trg_send_driver_status_email` (`driver_profiles` status) | `driver_approved`/`driver_rejected`/`driver_suspended` |

**Fix (PR #392, mig 00375 + deploy send-email):** fix-forward = registrar los 8 templates faltantes en `_shared/email-templates/` (7 keys + `gift_received` dedicada para regalos, branding "Recibiste un regalo 🎁") + traer las 6 funciones+triggers a git **verbatim**. Único cambio de comportamiento: `send_driver_payout_email` ramifica `kind='gift' AND reversal_of IS NULL` → `gift_received` (con `from_name` + nota); el resto idéntico a prod.

**Aprendizajes reutilizables:**
1. **Cuando encuentres UN email-trigger huérfano roto, buscá la FAMILIA**: `SELECT proname FROM pg_proc WHERE prosrc ILIKE '%send-email%'` + extraé la `template` key de cada uno con `regexp_match(prosrc, '''template''\s*,\s*''([a-zA-Z_]+)''')` y compará contra `isTemplateKey()`. Casi nunca está roto uno solo.
2. **Deploy de send-email (multi-file) = CLI, no MCP**: `npx supabase functions deploy send-email --project-ref lqaufszburqvlslpcuac` (resuelve los imports `_shared/` solos desde el worktree). El `config.toml` fija `[functions.send-email] verify_jwt = false`, así que la CLI no lo cambia. El MCP `deploy_edge_function` requiere mandar los 21 archivos a mano (frágil).
3. **Verificar el render de send-email SIN exponer el service_role key**: `send-email` exige el service_role exacto (rechaza anon JWT), así que el smoke test con curl+anon **no aplica**. En su lugar, invocá la EF **desde SQL** con `SELECT net.http_post(url:='.../send-email', headers:=jsonb_build_object('Authorization','Bearer '||get_service_role_key(),...), body:=jsonb_build_object('template','gift_received',...))` → el key se resuelve en la query, nunca en texto. Luego `SELECT status_code, content FROM net._http_response WHERE id=<request_id>` (status 200 + `success:true`) y leé el HTML real con el **MCP de Gmail** (`get_thread` FULL_CONTENT). Ojo: el `snippet` de Gmail colapsa separadores (mostró "100000"); el `htmlBody`/`plaintextBody` tienen el valor real ("100,000"). `toLocaleString('es-CU')` SÍ formatea bien en el runtime Edge.
4. **El emoji en el subject** lo codifica `encodeSubject` (RFC 2047) en [send-email/index.ts](supabase/functions/send-email/index.ts); en el HTML body, `asciiSafeHtml` (en `_layout.ts:wrapHtml`) lo colapsa a entidad numérica — seguro en cualquier cliente.

---

### Surge → solo clima (global). Zona + demanda eliminados (migs 00375/00376)

**Qué cambió.** Se eliminaron las "tarifas dinámicas por zona": surge geográfico por zona (`zones.surge_multiplier`, tabla `surge_zones`, `surge_predictions`) **y** surge por demanda (ratio oferta/demanda en `calculate_dynamic_surge`). El **único** multiplicador que queda es el **clima** (lluvia, tormenta, ciclón/extremo, **frío extremo**), global a toda la ciudad. La tarifa base sigue siendo base + distancia + tiempo.

**Hallazgo previo:** `rides.surge_multiplier > 1` tenía **0 filas históricas** — el surge nunca se cobró (el cliente llamaba `calculate_dynamic_surge(p_zone_id=null,…)` y la rama de zona/clima hacía `WHERE zone_id = p_zone_id` → nunca matcheaba). Por eso "activar el clima de verdad" no cambió precios históricos, solo encendió un sistema dormido.

**Arquitectura nueva:**
- EF `sync-weather` (cron 24, c/15 min) ya **no** escribe `surge_zones`; escribe un único `platform_config.weather_surge_multiplier` (global) + `weather_last_check`. Agrega **frío extremo**: `temp <= weather_cold_threshold_c` (def 12 °C) → `weather_cold_multiplier` (def 1.3); factor final = `MAX(condición, frío)`. Respeta kill-switch `weather_surge_enabled='false'` (escribe 1.0 y sale).
- RPC `get_weather_surge()` (mig 00375, `STABLE SECURITY DEFINER`, grants anon/authenticated/service_role) lee el config, clamp `[1.0, 3.0]`, devuelve 1.0 si deshabilitado. Reemplaza a `calculate_dynamic_surge` en el estimate (`ride.service.ts getLocalFareEstimate`, key de dedupe global `'weather_surge'`).
- `complete_ride_and_pay` (00375): la rama legacy de fallback usa `get_weather_surge()` en vez de `get_surge_multiplier(pickup)`. La rama de **paridad estricta (snapshot) NO cambió**. Reproducido verbatim desde prod (24k chars, 4 chunks) con **un solo** cambio de línea.
- Se **mantienen** `rides.surge_multiplier` y `ride_pricing_snapshots.surge_multiplier` (ahora guardan el factor de clima + paridad/auditoría).

**00376 (drops, aplicar DESPUÉS de desplegar EF + apps):** `calculate_dynamic_surge`, `calculate_surge`, `get_surge_multiplier`, `calculate_surge_predictions` (+ unschedule cron 9 `calculate-surge-predictions`), tablas `surge_zones` y `surge_predictions`, columnas `zones.surge_multiplier` y `pricing_rules.{surge_threshold,max_surge_multiplier}`. Pre-flight verificado: 0 FK/vista/trigger/policy/índice dependían de esos objetos.

**Secuencia de deploy (orden importa):** aplicar 00375 → deploy EF `sync-weather` → deploy apps (estimate llama `get_weather_surge` tolerante) → aplicar 00376. Aplicación gated por MCP guard: autorizar **por paso** vía AskUserQuestion.

**Admin:** se borró `settings/surge-zones`; `settings/surge-dashboard` se reemplazó por `settings/weather` (estado del clima + toggle `weather_surge_enabled` + link a platform-config para `weather_cold_threshold_c`/`weather_cold_multiplier`). `zones`/`pricing` ya no editan campos de surge. `live-map` sigue usando la key i18n `surge_dashboard.last_updated` (genérica) — no la borres.

**UI rider/driver/web:** los displays de `surge_multiplier > 1` se conservan pero **re-etiquetados** a "Mal tiempo"/"Recargo por mal tiempo" (i18n `*.surge_active` actualizado en es/en/pt; el driver perdió los overlays de polígonos de surge en el mapa porque el clima es global). `applySurge`/`calculateFareRange` en `@tricigo/utils` se mantienen (válidos para clima).

**Verificación (2026-06-03):** `pnpm check-types` verde (4 apps); `@tricigo/api` 442 tests + `@tricigo/utils` 382 tests verdes; smoke read-only confirmó que `get_weather_surge` daría 1.0 con el estado actual. Migraciones/EF **escritos pero NO aplicados** (MCP guard).

---

### Capturas de tienda (store screenshots) — workflow canónico (verificado 2026-06-04)

Para refrescar `apps/<app>/store-metadata/screenshots/` (Google Play / App Store):

**1. Barra de estado limpia — demo mode de Android SystemUI (por ADB).**
```
adb shell settings put global sysui_demo_allowed 1
adb shell am broadcast -a com.android.systemui.demo -e command enter
adb shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 1200
adb shell am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false
adb shell am broadcast -a com.android.systemui.demo -e command network -e wifi show -e level 4
adb shell am broadcast -a com.android.systemui.demo -e command notifications -e visible false
```
Apagar: `... -e command exit` + `settings put global sysui_demo_allowed 0`. **Limitación verificada (Pixel 9):** controla reloj/batería/wifi/señal pero **NO oculta las notificaciones** (Gmail, ads del carrier). Para barra impecable: el usuario las borra (swipe) o el recorte del paso 3 saca la barra entera.

**2. Bajar por ADB + identificar.** El usuario captura en el celu (NO tomamos screenshots nosotros — rompe la sesión). Bajar con **PowerShell** (NO Git Bash: convierte mal `/sdcard/...`; si hay que usar bash, `MSYS_NO_PATHCONV=1` + dest en path Windows). Listar capturas: `adb shell content query --uri content://media/external/images/media --projection _display_name:relative_path --sort '_id DESC'`. **Identificar pantalla→archivo con un SUBAGENTE aislado** (leer 5-6 PNG en la sesión principal la crashea; el subagente lo absorbe).

**3. Recortar a la proporción de Google Play: MÁXIMO 2:1.** Las nativas del Pixel 9 son **1080×2424 (~2.24:1) → Play las RECHAZA**. Recortar a **1080×2160 (2:1)** con `System.Drawing` (PowerShell, sin deps): sacar la barra de estado (arriba) + barra de nav/tabs (abajo); en pantallas con contenido abajo (login) recortar más de arriba. **Verificar el recorte con un subagente** (que no cortó título/botones).

**4. Seed temporal si la captura se ve vacía ($0).** Sembrar datos reales en prod (`mcp__execute_sql`, autorizar vía AskUserQuestion): viajes completados HOY con `id` fijos (`ON CONFLICT DO NOTHING`, idempotente), `driver_id` = **`driver_profiles.id`** (NO el `users.id`). El display computa earnings = `SUM(final_fare_cup) × (1−comisión)`. **Limpiar después**: `DELETE` por los ids fijos + sus `ride_pricing_snapshots` (insertar el ride directo NO toca wallet/ledger → cleanup limpio).

**5. Colocar + commitear** por nombre estable (`01-login`…`05-*`). El usuario sube manual a la consola (el repo es backup/control de versión).

### Worktrees compartidos: sesiones paralelas pueden cambiar tu rama (verificado 2026-06-04)

Un worktree (`.claude/worktrees/<x>`) puede estar en uso por **varias sesiones**. Una sesión paralela puede hacer **checkout de otra rama** en tu worktree detrás tuyo: tu commit queda en la rama vieja, el working tree salta de rama, y tus cambios sin commitear cuelgan en la rama equivocada. **Antes de commitear/pushear SIEMPRE `git branch --show-current` + `git log -1`.**

**Para commitear a una rama sin pelear con el worktree compartido → worktree temporal aislado:**
```
git worktree add <temp> <branch>                  # rama existente
git worktree add -b <nueva> <temp> origin/master  # rama nueva desde master
# editar/copiar, git add, commit, push
git worktree remove <temp>
```

**No mergear a master una rama cuyo PR ya fue squash-merged.** Tras el squash (#NNN) la rama queda "detrás" en historia aunque su **contenido** ya esté en master. `git diff --stat origin/master..rama` (DIRECTO, dos puntos) muestra el contenido realmente distinto; si lista archivos que master tiene **más nuevos**, mergear esa rama los **revertiría**. En ese caso: rama **fresca desde `origin/master`** con SOLO el delta nuevo. (Esta sesión: #398 ya había squash-mergeado driver-launch-fixes + map-fix; los screenshots fueron a una rama fresca para no revertir #399/#400.)

---

### Storage no valida los JWT ES256 del proyecto → subidas autenticadas de cliente van por EF service-role (verificado 2026-06-05)

**Síntoma:** cualquier subida autenticada cliente→Supabase Storage falla con `new row violates row-level security policy` (la RLS de INSERT rol `authenticated`). Afecta foto de entrega, **documentos de onboarding del conductor** (bloqueante para lanzar), selfie y avatar. Empezó ~2026-04/05.

**Causa raíz (CONFIRMADA por construcción, no asumida):** el proyecto migró a **JWT signing keys asimétricas ES256** (`/auth/v1/.well-known/jwks.json` sirve una clave ES256; el legacy HS256 anon está disabled; el anon key del `.env` es el publishable `sb_publishable_...`). gotrue firma los access tokens con ES256. **PostgREST (Data API), Edge Functions y Realtime validan ese token; el servicio de Storage NO** → trata al usuario como `anon` (auth.uid()=NULL) → la RLS de INSERT falla. **NO es el cliente/SDK:** en `@supabase/supabase-js` 2.99.1, `DEFAULT_HEADERS` no trae Authorization y `fetchWithAuth` inyecta `apikey: <publishable>` + `Authorization: Bearer <session.access_token ES256>` en cada request; `this.rest` y `this.storage` comparten el **mismo** `this.fetch` → mandan auth idéntica. Storage recibe el mismo token válido que PostgREST y lo rechaza. La doc oficial de Supabase dice que Storage *debería* verificar asimétrico → es lag/config de storage-api del proyecto.

**Workaround vigente (NO romper):** las subidas autenticadas van por **Edge Functions service-role** que autentican con `auth.getUser` + validan ownership por bucket + suben con service-role (bypassan Storage RLS):
- `supabase/functions/storage-upload/index.ts` (PR #432) — **genérica**: buckets `avatars` / `driver-documents` (docs + selfie) / `dispute-evidence`. Allowlist estricto + authz que replica la RLS WITH CHECK de cada bucket. `verify_jwt=false` (auth propia adentro). MIME whitelist + cap de tamaño + rechazo de path traversal.
- `supabase/functions/upload-delivery-photo/index.ts` (PR #430) — foto de entrega.
- `packages/api/src/services/_storage-upload.ts` (`uploadFileFromUri`) rutea TODO por `storage-upload` → arregla docs/selfie/avatar móvil + dispute en un solo chokepoint. El avatar **web** (`apps/web/src/app/profile/edit/page.tsx`) invoca la EF directo. Las escrituras a DB post-subida siguen client-side por PostgREST (funcionan). Bucket `dispute-evidence` creado en mig `00385` (público, como delivery-photos).

**Root fix pendiente (Supabase, no código):** ticket a Supabase support para que storage-api valide los ES256 del proyecto (draft en `.support-ticket-storage-jwt.md`, no commiteado). **Cuando lo resuelvan:** re-correr repro (una subida directa autenticada deja objeto con `owner`=user id); si verde → revertir las EFs a `supabase.storage.from().upload()` directo en `_storage-upload.ts` + `delivery.service.ts` + avatar web, y borrar las 2 EFs + sus entradas en `config.toml`. Dejar el bucket `dispute-evidence`.

**GUARDRAILS:** (1) **NO rotar/revocar JWT signing keys** como "fix" — rompe todas las sesiones/servicios; es palanca de soporte. (2) Al agregar una subida **nueva**, rutearla por la EF `storage-upload` (sumar el bucket + su authz al allowlist), NUNCA por `supabase.storage.upload()` directo (fallaría como anon). (3) Diagnóstico: `curl …/auth/v1/.well-known/jwks.json` → clave `ES256` = asimétrico; `SELECT bucket_id, COUNT(*) FILTER (WHERE owner IS NOT NULL) FROM storage.objects GROUP BY 1` → 0 con owner (salvo EF/service-role) = subidas autenticadas rotas.

---

### Login con Google del panel admin (admin.tricigo.com) — 3 capas + ruta de detalle de incidente (verificado 2026-06-06)

**El login con Google del admin estaba roto por TRES causas en capas distintas.** Las tres tuvieron que arreglarse. (Email+contraseña nunca se afectó: `signInWithPassword` no usa redirect.)

**Síntoma 1 — Google redirige a `tricigo.com`, no entra al admin.**
- **Causa A (config Supabase):** `https://admin.tricigo.com` NO estaba en las "Redirect URLs" de Supabase Auth. El admin pide `redirectTo: window.location.origin`; como ese destino no está en la allowlist, GoTrue lo descarta y cae al **Site URL** por defecto (`https://tricigo.com`). Caer en tricigo.com = firma inconfundible de ese fallback.
- **Fix A (Dashboard, NO código):** Authentication → URL Configuration → Redirect URLs → agregar `https://admin.tricigo.com/**`. **NUNCA** por `config.toml`/`config push` (pisaría el Site URL de prod). También desbloquea el reset de contraseña del admin.

**Síntoma 2 (tras A) — `/auth/callback` hace loop a `/login`.**
- **Causa B (código):** el admin usa `@supabase/ssr` (flujo **PKCE server-side + cookies**, porque su `middleware.ts` exige sesión en cookies). No tenía handler para canjear el `?code=`; redirigía a `/` (protegido) con el code sin canjear → middleware sin sesión → loop. (El web NO sufre esto: usa **implicit flow** client-side, tokens en el hash.)
- **Fix B (PR #451):** `apps/admin/src/app/auth/callback/route.ts` (route handler GET) → `exchangeCodeForSession(code)` setea las cookies ANTES del middleware; honra `x-forwarded-host` (detrás de nginx); guard de open-redirect en `redirect`. `login/page.tsx` apunta `redirectTo` a `/auth/callback?redirect=<dest>`. `middleware.ts` excluye `auth/callback` del matcher. El `code_verifier` viaja en cookie del dominio admin → el route handler server-side lo lee.

**Síntoma 3 (tras A+B) — 502 en `/auth/callback`.**
- **Causa C (nginx):** error log = `upstream sent too big header while reading response header`. Al canjear OK, Supabase emite las cookies de sesión (JWT partido en varios `Set-Cookie`); ese response excede el `proxy_buffer_size` default de nginx (4-8k). El web no lo sufre (implicit flow, sin `Set-Cookie` grandes del servidor); el admin usa PKCE server-side.
- **Fix C (nginx VPS, NO repo):** en `/etc/nginx/sites-available/tricigo.com`, server block `admin.tricigo.com` → `location /`, agregar `proxy_buffer_size 16k;` + `proxy_buffers 8 16k;` + `proxy_busy_buffers_size 32k;`, luego `nginx -t` + `systemctl reload nginx`. (Editar el VPS con `ssh ... "echo <b64> | base64 -d | bash"` evita el quoting hell PowerShell→SSH; backup `.bak` antes; restaurar si `nginx -t` falla.)

**Diagnóstico canónico:**
- Supabase Auth log (`get_logs service=auth`): `POST /token grant_type=pkce status 200` con `remote_addr` = IP del VPS → el intercambio server-side funcionó; el 502 es post-intercambio (no es el código).
- `tail /var/log/nginx/error.log` → `upstream sent too big header` = buffer, no la app.
- **SSH al VPS desde el sandbox SÍ funciona** (`ssh -o BatchMode=yes root@187.77.214.236`): Hostinger filtra las IP de los runners de GitHub, pero NO el sandbox. Oro para diagnosticar prod (`pm2 describe/logs tricigo-admin`, `ss -tlnp`, nginx config/logs, `curl localhost:3002/...`).
- Riesgo latente de deploy: el proceso PM2 `tricigo-admin` cae a PORT 3000 (default de Next standalone) si el env no llega en un restart → `EADDRINUSE` con `nghttpx` (escucha en :3000). Estable salvo durante **deploys concurrentes** (2 runs de Deploy-Admin a la vez se pisan en el `pm2 delete`/`start`).

**Ruta de detalle de incidente (mismo día, PR #454):** el banner SOS (`SosAlertBanner.tsx`) enlaza a `/incidents/${id}` cuando hay **1 solo** SOS abierto, pero esa ruta de detalle **nunca existió** (solo la lista `/incidents`) → **404**. Fix: `apps/admin/src/app/incidents/[id]/page.tsx` (sigue el patrón de `rides/[id]`) + `adminService.getIncidentDetail(id)` (incidente + nombres reporter/acusado/resolver + resumen del viaje). El banner no se tocó: su enlace ahora resuelve. Lección: cuando un `Link` apunta a `/recurso/[id]`, confirmá que existe `app/recurso/[id]/page.tsx` — el admin tiene vista de detalle solo para `businesses`, `drivers`, `rides`, `users`, `incidents`.

---

### `admin.tricigo.com` debe estar en `ALLOWED_ORIGINS` de las Edge Functions (CORS) — verificado 2026-06-23

**Síntoma:** desde el panel admin lanzás una campaña (correo/push) o tocás "Notificar ahora" en Anuncios/Promos y **no llega nada**, pero la UI dice "enviada". Misma **clase de trampa de allowlist** que el login admin (admin.tricigo.com olvidado en las Redirect URLs de Supabase Auth): el subdominio del panel se olvida en una allowlist.

**Causa raíz:** las EFs de notificación (`send-push`, `send-bulk-email`, `send-bulk-sms`, y todas las que usan `getCorsHeaders`) calculan `allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ''` (sin fallback). El secret project-wide `ALLOWED_ORIGINS` tenía `https://tricigo.com,https://www.tricigo.com,http://localhost:3001,http://localhost:3000` pero **NO** `https://admin.tricigo.com`. Resultado: el preflight OPTIONS responde 200 pero con `Access-Control-Allow-Origin` **vacío** → el navegador del admin **bloquea el POST real** → no se envía nada. La firma en los logs de EF es inconfundible: **OPTIONS 200 sin un POST que lo siga**.

**Diagnóstico canónico (sin leer el secret):**
- Probar el preflight desde el sandbox (read-only): `curl -s -i -X OPTIONS '.../functions/v1/send-bulk-email' -H 'Origin: https://admin.tricigo.com' -H 'Access-Control-Request-Method: POST' | grep -i access-control-allow-origin`. Si NO devuelve el header → el origen no está allowlisted. Un origen de control (`https://tricigo.com`) sí lo devuelve.
- `get_logs service=edge-function` en el minuto del envío: `OPTIONS 200` de `send-bulk-email`/`send-bulk-sms` **sin POST** = preflight rechazado por el navegador.

**Fix (config, sin deploy de código):** agregar `https://admin.tricigo.com` (y `http://localhost:3002` para dev del admin) al secret. `supabase secrets set` **reemplaza** el valor entero y `secrets list` solo muestra el **hash SHA-256** — para no pisar lo existente, **reconstruir el valor exacto brute-forceando el digest** (`sha256` de permutaciones de los orígenes conocidos hasta matchear el hash de `secrets list`), luego setear la lista completa + los nuevos. Correr el CLI **desde un dir vacío** (`mkdir /tmp/x && cd /tmp/x && npx supabase secrets set ALLOWED_ORIGINS="..." --project-ref lqaufszburqvlslpcuac`) porque desde el repo el CLI parsea `supabase/config.toml` y falla (`email_change` schema drift). El cambio toma efecto **inmediato** (sin redeploy de las EFs). Verificar re-probando el preflight.

**Defecto de código separado (push de Campañas):** la página `apps/admin/.../campaigns/page.tsx` mandaba el push por `notificationService.sendToMultipleUsers` → `sendToUser` → `fetch('https://exp.host/...')` **directo desde el navegador** (cross-origin a Expo → bloqueado; y escribía `notification_log`, no el inbox `notifications`). Arreglar el CORS NO lo desbloquea. Fix: enrutar por la EF `send-push` vía un método nuevo `notificationService.sendCampaignPush(userIds, {...})` (espejo de `broadcastToActiveUsers` con lista explícita; `category:'campaign'`) → entrega service-side **y** persiste al inbox. Anuncios/Promos ya usaban el camino bueno (`broadcastToActiveUsers` → `send-push` vía `functions.invoke`), así que esos los arregla solo el fix de CORS. Bonus UX: el handler contaba "userIds procesados" como entregas y tragaba errores de `fetch` → ahora reporta `{sent}` real y muestra toast de advertencia si 0/0 o error.

---

### Checklist de paridad cross-app (auditoría 2026-06-10, PRs PARITY-1/2)

**Regla:** toda feature de pasajero debe existir en paridad **web ↔ app móvil**, con contraparte **driver** (si interactúa) y **admin** (si se gestiona/configura). La auditoría 2026-06-10 (informe en `~/.claude/plans/necesito-un-analisis-para-bright-hamming.md`) encontró la paridad casi perfecta — el único gap funcional era recurrentes en web (cerrado en PARITY-1) — porque ~95% de la lógica vive en `packages/api` y ambas superficies consumen los mismos services.

**Todo PR que toque una feature de pasajero debe responder en su body:**
1. ¿Existe/actualicé el equivalente en **client** Y en **web**? (si no aplica, decirlo explícitamente — ej. corporativo avanzado con facturas/reportes es web-first por decisión)
2. ¿El **driver** ve/reacciona correctamente? (card de oferta, viaje activo, wallet, earnings)
3. ¿El **admin** puede verlo/gestionarlo/configurarlo? (página de detalle/gestión; si agregás un tunable a `platform_config`, sumalo a `KNOWN_KEYS` de `settings/platform-config` + help text es/en/pt en `admin.json` — las filas sin metadata se renderizan crudas)
4. ¿i18n es/en/pt en los namespaces correctos? (keys de copy real a los 3 locales; labels triviales con `defaultValue`)
5. ¿Tipos de notificación nuevos mapeados en los **3 inboxes** (client/driver/web: icono + navegación al tocar)? Los inboxes mapean por las categorías reales que `send-push` escribe en `notifications.type` (`ride`, `announcement`, `blog`…), no por el enum legacy.

**Patrón canónico para fixes cross-surface:** PRs apareados como PASS#3 — #477 (client/driver) + #478 (web/admin) — cada uno con branch fresh desde `origin/master`.

**Trampas verificadas al auditar paridad (2026-06-10):**
- Los agentes Explore reportan gaps falsos con frecuencia — **verificar cada gap con grep/Read directo antes de reportarlo**. De ~14 gaps reportados, 10 eran falsos (la web SÍ tenía shared ride, add-stop en vivo, gift+QR, preview de cancelación, tier badge, anuncios, tags de review; el driver SÍ tenía OTP de entrega+foto; el admin SÍ tenía incidents/[id] y override de nivel).
- La página admin `settings/platform-config` lista **todas** las filas de `platform_config` (KNOWN_KEYS solo agrega tipo/help) — un tunable "ausente" del UI suele estar presente pero sin metadata.
- Rutas web espejo de pantallas móviles: la web usa páginas con inline styles + CSS vars (`var(--primary)`, `var(--bg-card)`) y los mismos services de `@tricigo/api` — ver `apps/web/src/app/profile/recurring-rides/page.tsx` como referencia del patrón (flag check con `useFeatureFlag`, auth con `getSession`, `WebSkeletonList`/`WebEmptyState`).

### Contrato de aceptación de T&C del conductor — estado canónico (cerrado 2026-06-12)

**Qué es.** Al completar el registro (status → `under_review`), se genera un **contrato PDF de aceptación de los Términos y Condiciones** y se envía por email al conductor (español) y a administración (**español + rumano** — MACH DIGITAL TECH S.R.L. es rumana). El admin lo ve/descarga/regenera en `drivers/[id]` (sección "Contrato"). PRs #498 (backend) / #499 (admin) / #500 (checkbox app driver); migración `00405` aplicada a prod + EF `generate-driver-contract` deployada 2026-06-12.

**Mecánica.** Trigger `trg_generate_driver_contract` (`AFTER UPDATE OF status`, patrón 00138: vault + `net.http_post`, `EXCEPTION → RETURN NEW`, nunca bloquea onboarding) → EF genera 2 PDFs A4 con pdf-lib (portada con datos del conductor/vehículo + declaración de aceptación + nº `CTR-YYYY-NNNNNN` vía `generate_contract_no()`; **Anexo I = T&C completos**), sube a bucket privado `driver-contracts/{user_id}/…-{es|ro}.pdf`, upsertea `driver_contracts` (UNIQUE driver_id, idempotente; `force` regenera) y manda emails vía Resend directo (from `contratos@tricigo.com`): conductor → PDF ES; admin → **ambos PDFs** a `ADMIN_CONTRACT_EMAIL` env (fallback `soporte@tricigo.com`).

**Gotchas:**
- **El anexo ES sale del `cms_content('terms').body_es` VIVO** (captura la versión aceptada); **el RO es traducción estática** en `supabase/functions/_shared/driver-contract.ts` (`TERMS_RO_BODY`, basada en el body del 2026-05-30). **Si se editan los T&C en el CMS → actualizar la traducción RO + redeploy de la EF** (el drift se detecta comparando `driver_contracts.terms_updated_at` vs `TERMS_RO_BASED_ON`).
- **Diacríticos rumanos (ș/ț/ă) NO existen en WinAnsi** → las StandardFonts de pdf-lib no sirven. La EF fetchea DejaVu Sans (jsdelivr, override `CONTRACT_FONT_URL`) con cache por proceso y embebe **subsetted vía `@pdf-lib/fontkit`**; fallback Helvetica + strip de diacríticos para nunca fallar. Verificado: `unicode_font:true`, ~78KB por PDF.
- **Auth dual de la EF** (`verify_jwt=false`): service-role exacto (trigger) O JWT de usuario con rol admin/super_admin (botón "Generar contrato"). Patrón storage-upload.
- `driver_profiles.terms_accepted_at` lo estampa el checkbox del onboarding (#500, **requiere rebuild APK**); para builds viejas la EF cae al momento del submit. `submitForVerification` tolera la columna ausente (retry sin ella).
- Verificación rápida: `SELECT contract_no, accepted_at, pdf_es_path, emailed_admin_at FROM driver_contracts ORDER BY created_at DESC LIMIT 5;` + objetos en `storage.objects WHERE bucket_id='driver-contracts'`.

### Auditoría de frescura de datos (clase "stale-on-mount") — dimensión PERMANENTE

**Clase de bug a chequear en TODA auditoría de UI mobile.** En las apps Expo (cliente/driver), los **tabs no se desmontan** al cambiar de tab. Una pantalla que trae **dato mutable** con `useEffect(() => Service.getX(...), [userId])` (o `[]`) y **no tiene** mecanismo de refresco queda **congelada** en el valor que tenía al abrir la app, hasta un reinicio completo — aunque el dato cambie por fuera (crédito de admin, regalo, pago de viaje, rating, estado de aprobación, penalización, contador). Caso real: el saldo del home no se actualizaba tras un crédito del admin (la billetera sí, porque refetchea al foco) → **PR #631**.

**Regla:** toda pantalla que muestre dato mutable-externamente debe refrescarse al ganar foco + al volver del background. El primitivo canónico es **`useRefreshOnFocus(refetch)`** (`apps/<app>/src/hooks/useRefreshOnFocus.ts` — `useFocusEffect` + listener de `AppState 'active'`; pasar un `refetch` estable con `useCallback`). Para update instantáneo-sin-foco hace falta realtime (`supabase.channel(...postgres_changes...)`), que el codebase evita a propósito (BUG-277) salvo casos puntuales (driver `driver_profiles`, ride offers) — `useRefreshOnFocus` cubre el caso práctico sin el costo/RLS de realtime.

**Cómo barrer (en cada auditoría):**
1. `grep -rL "useFocusEffect" --include=*.tsx apps/<app>/app` cruzado con pantallas que tengan `useEffect(...Service.get...,[deps])` renderizando dato mutable → candidatas stale-prone.
2. **Cross-check sibling:** si el mismo dato es reactivo en una pantalla (ej. billetera, `useFocusEffect`) y fetch-once en otra (ej. home, rides) → bug fuerte (asimetría).
3. **NO confundir** con dato store-synced: lo que vive en `useAuthStore`/`useDriverStore` y se actualiza por `setUser`/realtime (ej. tier/level, nombre, rating del profile-tab del driver) ya es reactivo — no tocar.
4. Excluir lectura de `AsyncStorage` local single-device (ej. auto-accept): no hay mutación externa, es otra sub-clase.

**Fix canónico:** envolver el fetch existente en un `refetch` (`useCallback`) y llamar `useRefreshOnFocus(refetch)`. Mirar `apps/client/app/(tabs)/wallet.tsx` (useFocusEffect) y `apps/client/app/(tabs)/index.tsx` (#631) como referencia. Cambio mobile → **requiere rebuild de APK**. Estado del barrido + las pantallas migradas: `docs/AUDIT_DATA_FRESHNESS_2026-06-21.md`.

### Contactos de confianza + viaje en vivo — estado canónico (auditado + E2E real 2026-07-02)

**Qué es.** Contactos (máx 5, `trusted_contacts`, RLS own-only) que reciben **SMS automáticos** del viaje del pasajero: al **aceptarse** el viaje (link `https://tricigo.com/track/share/<token>`), al **completarse** ("✅ llegó a su destino"), y en **SOS**. La página pública `apps/web/src/app/track/share/[token]/page.tsx` (sin login) resuelve por RPCs anon token-gated (`get_shared_ride_by_token` + `get_shared_trip_state` polling 3s + waypoints); token de 24 hex generado on-accept (trigger BEFORE), expira 48h post-terminal. Verificado E2E con SMS reales a un número en Brasil (DLR `delivered` + confirmación en mano): PRs #734/#735/#736 + migs 00473/00474/00475, todas aplicadas a prod.

**Arquitectura de envío — REGLA DURA: el SMS a contactos es 100% server-side.** La EF `send-sms` exige `apikey === SERVICE_ROLE_KEY` → **cualquier `functions.invoke('send-sms')` client-side muere con 401 silencioso** (clase de bug que mató 3 features hasta 00473). Canales vivos:
- accept → `trg_notify_trusted_contacts` → `notify_trusted_contacts_on_accept` (contactos `auto_share=true` del **pasajero**; el driver NO genera estos SMS al conducir)
- completed → `trg_notify_trusted_contacts_complete` (00473)
- SOS → trigger safety-net `incident_reports_notify_sos` (throttle 1/60s) **+** EF `broadcast-emergency` (JWT, GPS exacto; la llaman client/driver/web) — redundancia deliberada
- `notificationService` ya NO tiene sender SMS client-side (removido en #735); si aparece uno nuevo, es bug.

**Lecciones verificadas (reusables):**
1. **Teléfonos de contacto se normalizan a E.164 en DB** (`trg_trusted_contacts_normalize_phone` → `_normalize_cuban_phone`, espejo del de `users`) + en las 4 UIs con `normalizeCubanPhone`. D7 no entrega números locales de 8 dígitos crudos. Números internacionales con `+` pasan intactos.
2. **NO abrir un SMS con el emoji 🚨** — los carriers lo filtran silenciosamente AUNQUE el DLR diga `delivered` (A/B verificado: mismo texto sin el emoji SÍ llega; el ✅ no se filtra). Ver 00475. Para diagnósticos de "el SMS no llega pero D7 dice delivered": sospechar filtro de contenido, hacer A/B por `net.http_post` directo a `send-sms`.
3. **`sms_log.user_id` es nullable desde 00474** — era NOT NULL y el trigger SOS no lo pasaba → la EF tragaba el error del insert y TODO SMS de SOS quedaba sin auditar. El error solo era visible en los logs de Postgres (`null value in column "user_id"`). Los 3 triggers ahora pasan `user_id`.
4. **Verificación de entrega**: `sms_log` (envío aceptado) + `sms_deliveries` join por `request_id=twilio_sid` (DLR real) + `net._http_response` (respuesta de la EF). `share_access_log` registra aperturas del link vía RPC `log_share_access` (anon, solo tokens que resuelven).
5. **E2E de viaje por SQL**: INSERT ride `searching` (respetar fare floor `tg_rides_validate_estimated_fare` — pedía ≥3739 CUP triciclo) + UPDATE walk del FSM (`searching→accepted→driver_en_route→arrived_at_pickup→in_progress→completed`). Los triggers disparan igual que en la app; `enforce_ride_update_columns` se salta con `auth.uid()` NULL. Limpieza: borrar incidents→location_events→snapshots→ride→contacto y `SELECT recompute_user_level(<rider>),(<driver user_id>)` para restaurar contadores de tier.

### Login en una app deslogueaba la otra — `verify-otp` rotaba el password cada login (verificado 2026-07-09, PR #782 / EF verify-otp v33)

**Síntoma:** un usuario con el MISMO teléfono en cliente Y conductor: al iniciar sesión en una app se le cerraba la sesión en la otra. Solo afectaba usuarios de **teléfono**, no email/OAuth.

**Causa raíz:** ambas apps son el MISMO `auth.users` (email sintético `phone_<n>@tricigo.app` — correcto y por diseño: un `public.users` por persona, el tier cuenta viajes como rider + driver). La EF `verify-otp` (Strategy A) hacía `admin.updateUserById(userId, { password })` en **cada** login. **En GoTrue, cambiar el password revoca las demás sesiones del usuario** → login en app B mataba la sesión de app A → su auto-refresh (`autoRefreshToken:true`) fallaba → `SIGNED_OUT` → `reset()` de stores → deslogueada. El handler `SIGNED_OUT` de `useAuth.ts` es correcto; el bug era el `SIGNED_OUT` espurio.

**Evidencia decisiva (read-only, prod):** usuarios email/OAuth (no rotan password) tienen hasta 5 sesiones concurrentes en `auth.sessions`; usuarios `phone_*` SIEMPRE tienen exactamente 1. `signInWithPassword` por sí solo NO revoca — solo el CAMBIO de password revoca. La asimetría es la prueba.

**Fix (todo en `supabase/functions/verify-otp/index.ts`):** password **determinístico estable** por usuario = `Otp1_` + HMAC-SHA256(secret, `otp-pw:<userId>`) en hex, `secret = OTP_PASSWORD_SECRET ?? SUPABASE_SERVICE_ROLE_KEY`. Strategy A ahora hace `signInWithPassword(stable)` y solo escribe el password si el signin falla (heal 1 sola vez / seed en `createUser`). Happy path = **cero escrituras de password → cero revocación → ambas apps coexisten**. Se hizo condicional el `updateUserById({phone})` per-login (2ª posible fuente de revocación). Magic-link sigue de fallback (tampoco rota). **Server-side puro: NO requiere rebuild de apps** — los usuarios lo obtienen en su próximo login.

**Verificación E2E (patrón reutilizable, contra prod con teléfono descartable):** sembrar OTP en `otp_codes` (phone `+…` E.164, code, `expires_at=now()+10min`) → `curl` POST a `…/functions/v1/verify-otp` con `{phone,code}` y header `apikey: <publishable>` (la EF es `verify_jwt=false`) → capturar `refresh_token`. Repetir con un 2º OTP (simula la otra app). Confirmar en `auth.sessions`/`auth.refresh_tokens`: **2 sesiones, ambos `revoked=false`**; y refrescar el token del 1er login vía `POST …/auth/v1/token?grant_type=refresh_token` → **200** (con el bug daría 400 `invalid_refresh_token`). Limpieza: `DELETE public.users` → `DELETE auth.users` (cascada sesiones/identidades) → `DELETE otp_codes`.

**Deploy de la EF sin CLI autenticado:** el sandbox NO tenía `SUPABASE_ACCESS_TOKEN` (CLI de Supabase sin login) → se desplegó vía **MCP `deploy_edge_function`** con los 2 archivos del bundle (`functions/verify-otp/index.ts` + `functions/_shared/rate-limiter.ts`, `verify_jwt=false`). Patrón seguro para reconstruir el contenido inline de una EF de auth: escribir la reconstrucción a un temp y `diff` (CR-normalizado, `tr -d '\r'`) contra el archivo del worktree ANTES de desplegar; y `get_edge_function` + diff DESPUÉS para confirmar. Ojo: prod corría `@supabase/supabase-js@2` sin pinear mientras master tiene `@2.108.2` — el deploy alineó prod con master.

**Pendiente / residual:** `OTP_PASSWORD_SECRET` no se pudo setear desde el sandbox (sin CLI auth) → queda para el usuario (dashboard EF secrets o `npx supabase secrets set OTP_PASSWORD_SECRET=$(openssl rand -hex 32) --project-ref lqaufszburqvlslpcuac` desde un dir vacío tras `supabase login`); el fallback a service-role key funciona mientras tanto. Residual aceptado: el 1er login post-deploy de cada usuario existente escribe el password 1 vez (heal → revoca su única sesión previa; invisible). Conflicto latente documentado en el código: el password determinístico clobbea cualquier password propio de `set-password-after-otp` (inactivo hoy: sin login-por-password para phone users).

### Sembrar un viaje de prueba para UN conductor específico (patrón canónico, verificado 2026-07-16)

Para QA manual ("lanzale un viaje al conductor X y que le suene el celu") **sin** que la oferta les llegue a otros conductores reales que estén online.

**El problema:** `INSERT INTO rides (status='searching')` dispara `trg_on_ride_insert_dispatch` → `dispatch_ride(id)` → `find_best_drivers(..., limit 10, radius 5000)` → inserta una fila en `ride_offers` **por cada** conductor elegible del radio. Y `trg_notify_driver_new_offer` (AFTER INSERT en `ride_offers`) manda el push. **Borrar después las ofertas ajenas NO sirve**: el `net.http_post` ya quedó encolado en la misma transacción y el push sale igual al commitear.

**La palanca:** `tg_rides_normalize_scheduling` (BEFORE INSERT) deriva `is_scheduled := (scheduled_at IS NOT NULL AND scheduled_at > now())`, y `on_ride_insert_dispatch` **NO despacha** los programados a futuro. Entonces: crear el ride programado → desprogramarlo → insertar la oferta a mano solo para el conductor objetivo. Todo en **una transacción atómica**: nadie más ve una oferta ni recibe push.

```sql
BEGIN;
INSERT INTO rides (
  id, customer_id, service_type, status, payment_method,
  pickup_location, pickup_address, dropoff_location, dropoff_address,
  estimated_fare_cup, estimated_distance_m, estimated_duration_s,
  passenger_count, ride_mode, scheduled_at
) VALUES (
  '<uuid-fijo>', '<customer_id>', 'triciclo_basico', 'searching', 'cash',
  ST_SetSRID(ST_MakePoint(<lng_pickup>, <lat_pickup>),4326)::geography, '<dirección pickup>',
  ST_SetSRID(ST_MakePoint(<lng_drop>, <lat_drop>),4326)::geography, '<dirección destino>',
  <fare>, <dist_m>, <dur_s>, 1, 'passenger',
  now() + interval '1 hour'          -- ← evita el auto-dispatch
);
UPDATE rides SET scheduled_at = NULL, is_scheduled = false WHERE id = '<uuid-fijo>';
INSERT INTO ride_offers (ride_id, driver_profile_id, composite_score, distance_m, expires_at)
VALUES ('<uuid-fijo>', '<driver_profile_id>', 0.76, <dist_driver_al_pickup>,
        now() + interval '2 minutes');   -- el default (offer_ttl_seconds) es 30s: poco para QA
COMMIT;
```

**Gotchas verificados:**
- **El gate de un-viaje-activo se bypassea.** `trg_enforce_one_active_ride_per_customer` es **BEFORE INSERT only** y exceptúa los programados → este patrón puede dejar al pasajero con 2 viajes activos (estado que la app real nunca produce). **Cerrar siempre el viaje anterior antes de lanzar otro** (`admin_cancel_ride`).
- **Una oferta vencida NO cancela el ride**: el `expires_at` pasa, la oferta desaparece de la pantalla del conductor, pero el ride sigue `searching` y el pasajero sigue ocupado. Cancelar explícito.
- **Fare floor**: `tg_rides_validate_estimated_fare` rechaza `estimated_fare_cup < min_fare_cup` del `service_type_configs` (triciclo_basico = 1505 al 2026-07-16). Calcular la tarifa con la config viva, no a ojo.
- **`auth.uid()` NULL (MCP/service-role) es lo que hace funcionar el patrón**: salta el rate-limit (`tg_rides_rate_limit`) y `normalize_scheduling` no resetea campos. Si impersonás a alguien en la misma transacción, cambia el comportamiento.
- **`ride_offers.driver_profile_id` es `driver_profiles.id`**, NO `users.id`.
- **No hay ningún gate geográfico**: prod aceptó sin chistar un ride con pickup/dropoff en Brasil (`city_id` NULL). Útil para QA desde el exterior; la tarifa igual sale en CUP (los precios son de la config cubana, no cambian por país).
- **Limpieza**: `admin_cancel_ride('<uuid>', '<motivo>')` impersonando admin (`set_config('request.jwt.claim.sub', '<admin_user_id>', true)`). Vía admin = **sin evento reputacional** para nadie (ver `cancellation_rating_events`); un `cancel_ride` normal fuera de la ventana de gracia (120s) sí deja marca.

### `rpc_attempt_log` — evidencia forense de qué pasó en un RPC (verificado 2026-07-16)

Varios RPCs críticos (`cancel_ride`, `accept_ride_v2`, …) llaman `log_rpc_attempt(rpc, caller, target, outcome, metadata)`, que escribe en **`public.rpc_attempt_log`** (la tabla NO se llama `rpc_attempts`). `log_rpc_attempt` tiene `EXCEPTION WHEN OTHERS THEN NULL` → nunca puede tumbar al RPC que la llama.

**Es la primera parada cuando el usuario reporta "la app me dijo error X"**: da el `outcome` exacto (`unauthenticated` / `ride_not_found` / `ride_already_closed` / `unauthorized` / `success`) con timestamp y metadata, sin depender de logs del cliente.

```sql
SELECT rpc_name, caller_uid, target_id, outcome, metadata, created_at
FROM rpc_attempt_log WHERE created_at > NOW() - interval '30 minutes'
ORDER BY created_at DESC LIMIT 20;
```

**Ojo con el timestamp**: `created_at` es `now()` = **hora de inicio de la transacción**, no del INSERT. Dos operaciones concurrentes pueden aparecer en orden contraintuitivo. Y los early-returns (que hacen `RETURN`, no `RAISE`) **sí** quedan registrados; un fallo por excepción de trigger haría rollback y **no** dejaría rastro — la ausencia de fila no prueba que no se intentó.

**Caso real:** el usuario reportó "No se pudo cancelar el viaje" en la app conductor. El log mostró `cancel_ride → ride_already_closed` a las 18:03:03.430, y el `canceled_at` del ride (cancelación admin) a las 18:03:03.515: **una carrera**, no un bug del RPC. Pero el mismo log destapó un bug real: otro conductor canceló OK (`success`) y su app disparó 4 intentos más → 4 × `ride_already_closed` → 4 carteles rojos tras un cancel exitoso (arreglado en #814).

### `ride_already_closed` NO es un fallo — la intención ya está satisfecha (#814)

`cancel_ride` devuelve `{"error":"ride_already_closed","status":"canceled"}` cuando el viaje ya es terminal (la otra parte o un admin lo cerró primero, o es doble-tap). **El viaje SÍ está cancelado.** Tratarlo como error genérico es mentirle al usuario **y** dejar un viaje muerto colgado en pantalla.

**Patrón canónico:** `ride.service.cancelRide` lanza `AppError` con `code: 'RIDE_ALREADY_CLOSED'` (409) + `details.status`. El caller lo trata **como éxito**: mismo teardown que el happy path + mensaje honesto (`driver:trip.cancel_already_closed`). Implementado en `apps/driver/src/hooks/useDriverRide.ts` (`cancelTrip`).

**Deuda conocida:** el cliente (`apps/client/src/hooks/useRide.ts`) y la web (`apps/web/src/app/track/[id]/page.tsx`) **siguen tratándolo como fallo genérico** — el `AppError` tipado ya les deja el camino hecho.

**Lección transversal:** un `catch {}` que se traga el error sin loguear hace el bug indiagnosticable desde la app (era el caso). Loguear siempre con contexto (`rideId`).

### Ajustar saldo de wallet: usar `admin_adjust_wallet`, NUNCA `UPDATE wallet_accounts.balance` (verificado 2026-07-16)

El ancla USD del conductor (`wallet_accounts.anchor_usd_cents`) la mantiene **`trg_ledger_maintain_usd_anchor`, un trigger sobre `ledger_entries`** — NO hay trigger sobre `wallet_accounts`. Consecuencia: un `UPDATE` directo del `balance` **no toca el ancla** → queda respaldando un saldo que ya no existe y la próxima revaluación cambiaria regala o destruye valor.

```sql
BEGIN;
SELECT set_config('request.jwt.claim.sub', '<admin_user_id>', true);  -- el RPC exige auth.uid() = p_admin_user_id
SELECT admin_adjust_wallet('<target_user_id>'::uuid, 'tricicoin'::wallet_account_type,
                           -320733, '<motivo ≥3 chars>', '<admin_user_id>'::uuid);
COMMIT;
```

**Detalles del RPC:** acepta montos **negativos** (solo rechaza 0); soporta `customer_cash|driver_cash|corporate_cash|tricicoin`; un admin **no puede** ajustar su propia wallet. En **créditos** inyecta `anchor_directives` (`unbacked_cup_delta`) al metadata de la transacción; en **débitos** no, y el trigger reduce el ancla **proporcionalmente** (verificado: 330,733 CUP / $501.11 → 10,000 CUP / $15.15 = exactamente 10000/330733 del ancla). Deja rastro en `ledger_transactions` (type `adjustment`) + `admin_actions`.

### Auto-launch de oferta en el conductor: 2 canales (realtime frágil vs push fiable) — #807 + #817

**Diagnóstico en vivo 2026-07-16** (dispositivo real, APK 1.2.0, permiso overlay concedido): repro 1 = la app **no** se abrió (solo llegó el push); repro 2 = se abrió **con demora**, el push llegó primero.

**Causa:** el auto-launch de #807 se dispara desde el **WebSocket de Realtime** (`subscribeToNewRides` → `DriverOverlay.bringAppToForeground()`), que (a) se cae en silencio en background — el propio código tiene un poll de respaldo de 30s que **a propósito NO lanza la app**, y (b) aun conectado pierde la carrera contra FCM (socket despriorizado en background + re-fetch del ride antes de lanzar). El push (trigger `trg_notify_driver_new_offer` → EF `send-push`) es el canal rápido y fiable, pero solo visible.

**Rediseño (#817, mergeado, PENDIENTE de activar):** `send-push` manda, para `category='ride_offer'`, un **2º mensaje data-only high-priority** (`type: 'ride_offer_launch'`, solo a devices `platform='android'`) → despierta el background task `apps/driver/src/tasks/rideOfferLaunchTask.ts` (`Notifications.registerTaskAsync` + `TaskManager.defineTask` con import por side-effect en `_layout.tsx`, mismo contrato que el task FD1 de ubicación) → `bringAppToForeground()`. El camino realtime queda como redundancia (launch duplicado = no-op por `SINGLE_TOP` + throttle 3s).

**Para activarlo hacen falta LAS DOS piezas** (ninguna rompe nada por separado): (1) `npx supabase functions deploy send-push --project-ref lqaufszburqvlslpcuac`; (2) **rebuild del APK** conductor (sin OTA). Sin (1), el APK nuevo se comporta como hoy; sin (2), el mensaje no lo escucha nadie.

**Verificado contra el fuente de `expo-notifications@55.0.18`** (no contra la doc — 3 casos borde encontrados así):
- `FirebaseMessagingDelegate.onMessageReceived` corre los task consumers **incondicionalmente**, también en foreground → el task necesita gate de `AppState`.
- En **background**, un data-only nunca se presenta (`ExpoHandlingDelegate.shouldPresent()` exige title o text) → **los APKs viejos lo ignoran por completo**. En **foreground** sí llega al handler JS → con `shouldShowAlert:true` mostraría una **notificación vacía**: hay que gatear `ride_offer_launch` en los 3 handlers (driver `useNotifications`, client `useNotifications` **y** client `push.service.ts` — ambos setean el handler global y gana el del import order; el cliente puede recibirlo porque `user_devices` no distingue apps).
- `RemoteMessageSerializer` espeja el JSON del `data.body` de FCM también como `dataString` (key cross-platform documentada) → sondear ambas.

**Diagnóstico si reaparece "no se abre sola":** (1) ¿aparece la **burbuja flotante** al minimizar? Sí ⇒ el permiso `SYSTEM_ALERT_WINDOW` está OK (misma llave para burbuja y launch) y el problema es el canal, no el permiso. (2) versión del APK ≥ rebuild post-#817. (3) `launch_sent=N/M` en el summary log de `send-push`. (4) Sentry: `logger.warn('[rideOfferLaunch] …')`. El modo de falla es **silencioso-benigno**: siempre queda el push visible.

### Recordatorio para Claude

**Siempre leer `CLAUDE.md` al empezar** y actualizar esta sección cuando aparezca un nuevo problema, comando útil, o paso de troubleshooting verificado en una sesión real.
