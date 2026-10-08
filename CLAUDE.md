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
- GRANT explícito en toda tabla o vista nueva de `public`, en la misma migración y siempre con `service_role` incluido: desde el 30-oct-2026 Supabase ya no los da solo. Lo chequea CI (`pnpm check:migration-grants`). Detalle en § "Tablas nuevas en public: GRANT explícito"
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

> Nota: `google-services.json` también es gitignored y falta en worktrees frescos. **CORRECCIÓN (verificado 2026-08-21): NO es benigno para el dev client.** Sin ese archivo, `expo-updates runtimeversion:resolve` falla al parsear el config y **Metro no puede servir el manifest**: el celu pide y Metro responde error (`Could not parse Expo config: android.googleServicesFile`), la app queda en el splash para siempre. Copiarlo junto con el `.env`:
> ```powershell
> Copy-Item "$mainpps\client\google-services.json" "$wtpps\client\google-services.json" -Force
> ```

### El watcher de Metro puede morir en silencio: `Bundled (1 module)` eterno (verificado 2026-08-21)

**Síntoma:** editás archivos, relanzás la app, y los cambios NO llegan — sin error alguno. **La firma inconfundible:** cada rebuild de Metro dice `Bundled ...ms (1 module)`. Un edit real recompila decenas de módulos; "1 module" repetido = el watcher dejó de ver el disco y Metro sirve su snapshot viejo para siempre. Costó ~4 rondas de "probá ahora" fantasma en un worktree bajo `.claude/worktrees/` (Windows, sin Watchman).

**Verificación decisiva (antes de pedirle al usuario que pruebe NADA):** comparar el disco contra lo que Metro SIRVE:
```bash
grep -c "<marker-del-cambio>" <archivo-editado>   # disco
curl -s "http://localhost:8081/node_modules/expo-router/entry.bundle?platform=android&dev=true&minify=false" | grep -c "<marker-del-cambio>"   # servido
```
Si disco>0 y servido=0 → watcher muerto. **Fix: matar Metro y relanzarlo** (el arranque re-crawlea el disco; el transform cache hace que el rebuild sea rápido). Regla operativa: tras CADA edit destinado al celu, verificar el bundle servido con el grep — nunca inferir entrega del "éxito" del edit.

**Trampa hermana (parches scripteados):** un script Python que hace `assert s.count(old)==1` pero olvida el `s.replace(...)` reescribe el archivo idéntico e imprime éxito. Blindaje: `s2=s.replace(old,new); assert s2!=s` + `grep` del marker nuevo en el archivo después de cada parche.

#### Lo mismo aplica a `apps/web`, pero el archivo se llama `.env.local` (verificado 2026-07-19)

**Ojo con el nombre:** cliente y driver usan `.env`; **web usa `.env.local`** (convención de Next.js, gitignored por `.gitignore:35`). Copiar el archivo equivocado no hace nada.

```powershell
Copy-Item "C:\Users\Eduardo\TriciGo\apps\web\.env.local" "<worktree>\apps\web\.env.local" -Force
```

Contiene `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` (los que rompen todo), más `NEXT_PUBLIC_MAPBOX_TOKEN`, `NEXT_PUBLIC_POSTHOG_*`, `NEXT_PUBLIC_SENTRY_DSN` y `SENTRY_AUTH_TOKEN`/`ORG`/`PROJECT`.

**Verificación al bootear:** Next debe imprimir `- Environments: .env.local`. **Si esa línea NO aparece, el archivo falta** — es el equivalente al `env: load .env` de Metro.

**Síntoma sin el archivo (medido, no deducido):** `getEnvVar` en `packages/api/src/client.ts` **lanza** `Missing environment variable: SUPABASE_URL`, el error boundary lo atrapa y la página muestra **"Algo salió mal — Ha ocurrido un error inesperado"**.

> **La trampa:** el servidor igual responde **`GET /recargar 200`**. Un chequeo con `curl` dice que la página está sana; el fallo solo se ve **abriéndola**. No confundir esto con un bug de la feature ni con un feature flag apagado.

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

**Segundo caso real (2026-08-21, 00571 — más barato porque uno de los dos seguía abierto).** `00571_cuba_pois_garbage_cleanup.sql` se mergeó a master (#978) mientras el PR **abierto** #973 llevaba su propio `00571_destination_suggestions_specific_addresses.sql`; ambas ya estaban aplicadas a prod por MCP (registro por timestamp). Como el choque **todavía no estaba mergeado de los dos lados**, no hizo falta el tercer PR de renumeración: bastó un `git mv` a **00572** en la rama del PR abierto (1 commit, rename 100 %, blob idéntico) — la que ya está en master conserva el número bajo. **Verificar el rename de verdad:** `git status` debe mostrar `R` y `git hash-object <nuevo>` debe dar el mismo blob que `git rev-parse <sha-viejo>:<ruta-vieja>`; un rename que copia y reescribe pasa desapercibido si solo mirás el nombre. Y avisar por SendMessage a la sesión dueña del PR antes de tocar su rama (zona de exclusión) — la de #973 estaba activa y hubo que sincronizar su `git pull --ff-only`.

**El número reservado por un PR abierto puede ser un HUECO en master, no el siguiente.** Ese mismo día 00569 estaba tomada por el PR abierto #965 mientras master saltaba de 00568 a 00570: el `git ls-tree origin/master … | sort -r | head -5` de arriba devuelve `…00568, 00570, 00571` y, leído como "el siguiente después del último", te entrega justo el número ocupado. Por eso el cruce contra `gh pr view <n> --json files` **no es el segundo chequeo opcional, es el que decide** — y conviene barrer TODOS los PRs abiertos, no los últimos.

**Cómo se registra el `version` según el mecanismo de apply** (verificado 2026-06-03): `supabase db push` (CLI) usa el **filename** como version; pero `mcp__apply_migration` registra por **TIMESTAMP** (`20260603190204…`). Por eso, tras aplicar via MCP, buscar en `supabase_migrations.schema_migrations` por número (`WHERE version LIKE '0037%'`) devuelve **vacío** aunque la migración SÍ se aplicó — los objetos están en prod, solo el registro usa timestamp. Verificar por objeto (`pg_proc` / `information_schema.tables`), no por número de migración.

### Cadenas de `CREATE OR REPLACE FUNCTION` — verificar que el último wins no perdió features

**Regresión verificada 2026-05-27.** La función `notify_ride_status_change` fue redefinida en 5 migraciones (00022, 00054, 00095, 00096, 00124). Cada `CREATE OR REPLACE` sobrescribe el cuerpo entero. Cuando 00124 cambió el header de auth para usar vault, copió y pegó la versión BASE de 00054 (sin el caso `arrived_at_destination` que 00096 había agregado, sin el fare en `completed` de 00095). Resultado: dos features perdidas silenciosamente en prod hasta el fix en 00334.

**Patrón canónico cuando vas a hacer `CREATE OR REPLACE FUNCTION X`**:

1. `grep -l "CREATE OR REPLACE FUNCTION.*X\b" supabase/migrations/*.sql | sort` para encontrar todas las migraciones que la redefinen.
2. Leer la **última** versión (la que está en prod hoy).
3. Si tu cambio toca el header/wiring (auth, params), conservar el cuerpo del case statement de la última versión.
4. PR review: incluir un diff entre el cuerpo de la versión NUEVA y la anterior para que el reviewer detecte regresiones.

### Tablas nuevas en public: GRANT explícito (Data API, desde el 30-oct-2026)

**Qué cambia.** Aviso de Supabase del 2026-09-23 ([discusión](https://github.com/orgs/supabase/discussions/45329)): desde el **30 de octubre de 2026**, los objetos NUEVOS de `public` (tablas, vistas, vistas materializadas y las secuencias de las columnas `serial`) ya no reciben permisos automáticos para `anon`, `authenticated` y `service_role`. Sin GRANT, la Data API (PostgREST, supabase-js, GraphQL) no los ve: las apps **y las Edge Functions** reciben `42501 permission denied for table x`. Las tablas que ya existen conservan sus permisos. También afecta a proyectos nuevos, preview branches y `supabase db reset`.

**Estado de prod medido el 2026-09-27 (solo lectura).** `pg_default_acl` todavía da todo (`arwdDxtm` en tablas, `rwU` en secuencias) a los tres roles en cada objeto nuevo de `public`, tanto con `postgres` como con `supabase_admin` de grantor. Por eso las migraciones nunca escribían GRANT: `driver_heartbeat_log` (00576) no tiene ninguno y en prod los tres roles tienen todo. De los 142 objetos de `public`, 134 tienen todos los permisos para los tres roles. Los otros 8 (`partner_places`, `rpc_attempt_log`, `push_registration_status`, `sms_log`, `ride_offers`, `driver_churn_risk`, `eligible_drivers`, `driver_push_reachability`) tienen REVOKE deliberados de 00120, 00123, 00215/00286, 00350, 00532 y 00585.

**La regla.** Toda migración que cree una tabla, vista o vista materializada en `public`, con o sin el prefijo `public.`, lleva en el mismo archivo:

```sql
CREATE TABLE public.<tabla> (...);
ALTER TABLE public.<tabla> ENABLE ROW LEVEL SECURITY;
CREATE POLICY ... ON public.<tabla> ...;                                  -- la RLS decide qué FILAS
GRANT SELECT ON public.<tabla> TO anon;                                   -- solo si se lee sin sesión
GRANT SELECT, INSERT, UPDATE, DELETE ON public.<tabla> TO authenticated;  -- solo lo que usan las apps
GRANT SELECT, INSERT, UPDATE, DELETE ON public.<tabla> TO service_role;   -- SIEMPRE
```

- **`service_role` va siempre.** Lo usan las Edge Functions (webhooks de pago, crons) y los scripts. Se saltea la RLS pero **no** los GRANT: medido en PG16 sin permisos automáticos, un INSERT como `service_role` da `permission denied for table`. El historial muestra la trampa: de las 7 tablas o vistas que alguna vez recibieron GRANT en su propia migración, 6 se los daban solo a `anon`/`authenticated` y dependían del automático para `service_role` (00436, 00532, 00544, 00579 ×2, 00585). La única que no: `push_registration_status` (00585).
- **Tablas-candado** (RLS sin policies; solo las tocan funciones SECURITY DEFINER, pg_cron o Edge Functions, como `rate_limits`, `otp_codes` o `driver_reactivation_pushes`): solo `service_role`. Una función SECURITY DEFINER corre como su dueño (`postgres`) y no necesita GRANT de los roles de la API.
- **Vistas:** igual que las tablas (`GRANT SELECT`), con `security_invoker = true` (patrón 00294). `GRANT ... ON ALL TABLES IN SCHEMA public` también cubre vistas y vistas materializadas, pero no secuencias.
- **Secuencias.** Con `serial`/`bigserial` o `DEFAULT nextval(...)`, cada rol con INSERT necesita además `GRANT USAGE, SELECT ON SEQUENCE public.<tabla>_<col>_seq`: un GRANT sobre la tabla no cubre su secuencia. En una base sin permisos por defecto (proyecto nuevo, branch) el INSERT falla con `permission denied for sequence`. En prod puede que no falle: el SQL que publicó Supabase solo quita `USAGE, SELECT` de las secuencias y deja `UPDATE`, que alcanza para `nextval` (medido en PG16). Supabase igual recomienda el GRANT y el chequeo lo exige. Es mejor usar `bigint GENERATED ALWAYS AS IDENTITY` o `uuid DEFAULT gen_random_uuid()`, que no necesitan permiso de secuencia (medido en PG16). Agregar una columna `serial` a una tabla existente crea una secuencia sin permisos que el chequeo no detecta.
- **Hasta el 30/10, prod sigue abriendo todo** a las tablas nuevas. Si una tabla NO debe ser visible para `anon`, además de los GRANT hace falta `REVOKE ALL ON public.<tabla> FROM anon;` (patrón 00585). Después del 30/10 ese REVOKE no hace nada y no molesta.
- **No crear tablas fuera de migraciones** (dashboard, `execute_sql` suelto, scripts): después del 30/10 nacen sin permisos, y además quedan fuera del historial (ver abajo).

**El chequeo de CI.** `pnpm check:migration-grants` corre en el paso "Check migration grants" de `ci.yml`, después de sus 48 tests (`pnpm test:migration-grants`). Revisa las migraciones con número **≥ 00587** y falla en tres casos:
1. Una tabla o vista nueva no tiene ningún GRANT en la misma migración.
2. Los GRANT no incluyen a `service_role` (o a `PUBLIC`).
3. Un rol con INSERT no tiene USAGE sobre la secuencia de una columna `serial` o `nextval`.

El umbral es 00587 porque al entrar la regla ninguna migración de master numerada desde 00587 creaba tablas (00591–00597 no crean). No se eligió 00598 a propósito: los huecos 00587–00590 y 00593 están reservados por PRs abiertos, y **#1004 crea 4 tablas en 00587 sin GRANT**. Su CI va a fallar hasta que los agregue, que es lo que tiene que pasar. Los huecos más viejos (00071, 00111, 00489, 00569) quedan por debajo; el único PR que ocupa uno, #965 (00569), solo actualiza filas.

Para una tabla que a propósito no debe tener ningún acceso por API, o para un falso positivo del chequeo, se agrega `-- grants-exempt: public.<tabla> <motivo>` en la migración. Falsos positivos conocidos: `CREATE OR REPLACE VIEW` de una vista que ya existe (conserva sus permisos; no re-otorgar a `anon` lo que se le había quitado), una tabla temporal de trabajo creada y borrada en el mismo archivo, y la partición de una tabla ya otorgada. El chequeo saltea el SQL dinámico (`EXECUTE format('... %I ...')`) y no ve `SELECT ... INTO`, `ALTER TABLE ... SET DEFAULT nextval(...)` ni un `REVOKE` posterior al GRANT.

Calibrado contra las 609 migraciones del historial: encuentra 117 tablas y vistas, ninguna con nombre falso, y coinciden una por una con prod (salvo 3 borradas y los objetos creados a mano). Se lo vio fallar con una migración de prueba sin GRANT en el directorio real, y pasar al completarla. Un subagente de revisión encontró un falso negativo que se corrigió: un apóstrofo dentro de un literal `$m$...$m$` (00597 tiene uno) desincronizaba el enmascarado de comentarios, y un GRANT comentado más abajo contaba como real. El parser ahora sigue los delimitadores `$tag$`.

**Bases reconstruidas desde cero (branches, `db reset`): riesgo aceptado (decisión 2026-09-27).** No se agregó una migración de "paridad de permisos". Motivos medidos:
- **Hoy nada reconstruye la base desde el historial.** `list_branches` solo devuelve `main`, así que no hay preview branches, y los PR que tocan migraciones solo corren el CI del repo (ej. #1015). El CI nunca reaplica migraciones (ver el comentario al final de `ci.yml`), y los ensayos locales usan andamios (`supabase/tests/*/scaffold.sql`), no el historial.
- **El historial ya no puede recrear prod, con o sin permisos.** `cms_content`, `blog_posts`, `driver_quests`, `driver_quest_progress`, `influencers_campaign` y la vista `ride_audit_log` se crearon a mano: ninguna migración las crea, aunque 00294, 00380 y 00438 las modifican. Un replay desde cero muere a más tardar en `00156_seed_cms_terms_privacy.sql` (`INSERT INTO cms_content`), así que una migración de paridad en 00598 nunca llegaría a correr.
- **Si algún día hacen falta branches o `db reset`**, el arreglo es un baseline: un volcado del esquema de prod que reemplace al historial para las bases nuevas. `pg_dump --schema-only` incluye los GRANT y REVOKE de cada tabla, salvo que se pase `--no-privileges`. Antes de usarlo, comparar `information_schema.role_table_grants` del baseline contra prod.
- **Descartado: volver al comportamiento viejo** con `ALTER DEFAULT PRIVILEGES ... GRANT ... ON TABLES TO anon, authenticated, service_role`. Va contra el cambio, porque toda tabla nueva vuelve a nacer abierta a `anon` y una sin RLS queda expuesta. Además esconde el bug: en una base que regala permisos, una migración sin GRANT anda en la prueba y falla en prod.
- **Opcional, a decidir (es un cambio en prod y requiere autorización):** adelantar el cambio con `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM anon, authenticated, service_role;`, más lo mismo con `REVOKE USAGE, SELECT ON SEQUENCES`. Es el SQL que publicó Supabase: deja `TRUNCATE`, `REFERENCES`, `TRIGGER` y `MAINTAIN` en las tablas y `UPDATE` en las secuencias, así que no reproduce la falla de secuencias de una base nueva. A favor: la transición ocurre cuando se elige y no el 30/10, y las tablas nuevas dejan de nacer abiertas a `anon`. En contra: toda tabla creada fuera de migraciones, o un PR sin GRANT (hoy #1004), falla desde ese momento.

**Diagnóstico si después del 30/10 aparece `42501 permission denied for table x`:** a esa tabla nueva le falta el GRANT.

```sql
SELECT grantee, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privs
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = '<tabla>'
GROUP BY grantee;
```

Se arregla con una migración nueva que tenga el GRANT, no a mano en prod. `permission denied for sequence <tabla>_id_seq` es el mismo problema con la secuencia.

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

### Credenciales en el repo: es PÚBLICO y lo barren bots (verificado 2026-09-27)

`AgenciaSeniors/TriciGo` es **público**. `scripts/run_migrations.js` y `scripts/run_seeds.js` (commit `b8db356a`, 2026-03-10) tenían la cadena de conexión de prod **con la contraseña del rol `postgres`**, y estuvo ~6,5 meses expuesta. Se borraron los dos scripts, que eran código muerto (solo listaban 00001-00014 y ningún paquete depende de `pg`), y la contraseña se reseteó desde el Dashboard.

- **Ninguna credencial en el código, ni siquiera "temporal".** Se lee de `process.env` / `Deno.env` y el programa falla si falta, sin valor por defecto. Borrarla de HEAD no la saca del historial ni de los clones: el arreglo es **rotarla**.
- **Hay bots probando lo que se filtra.** El 2026-09-26 una IP externa llamó a `GET /auth/v1/admin/users?per_page=1` con el JWT `service_role` legacy, que sigue commiteado en migraciones viejas. Recibió 401 solo porque las claves legacy están deshabilitadas: **no reactivarlas nunca**.
- **Hay bases ajenas que corren nuestros crons contra nuestras funciones** (medido 2026-10-06). Dos Postgres que no son de esta organización (`pg_net/0.20.3`; el nuestro es 0.19.5), uno desde AWS India (`3.108.168.46`) y otro desde AWS Suecia (`13.62.211.38`), llaman a `auto-admin`, `sync-weather`, `sync-exchange-rate` y `behavioral-emails` con nuestros mismos horarios: ~800 llamadas por día. Son bases armadas con nuestro historial de migraciones: 00056, 00061, 00074 y 00214 escriben dentro del cron la URL del proyecto y el JWT `service_role` legacy (la de Suecia lo usa), y la 00219 el `anon` legacy (la de India). Todas reciben `401 UNAUTHORIZED_LEGACY_JWT`. Si las claves legacy se reactivaran, la de Suecia correría `auto-admin` y los correos con permisos de servicio. **Esos 401 no son fallas de nuestros crons**: los nuestros salen de `44.234.196.74` con `pg_net/0.19.5` y la clave `sb_secret_`. Para separarlos, en `function_edge_logs` agrupar por `request.headers.cf_connecting_ip` y `request.headers.user_agent`.
- **Primero se rota la contraseña de la base, y recién después la clave de servicio y los tokens de `platform_config`.** El rol `postgres` lee `vault.decrypted_secrets`, que guarda `service_role_key`, y también `platform_config`. Si se rota al revés, quien tenga la contraseña vieja lee la clave nueva.
- **Se resetea desde el Dashboard, nunca con `ALTER ROLE`.** El panel y el MCP se conectan como `postgres` (`application_name='mgmt-api'`) con la credencial que guarda Supabase. Por SQL, además, la contraseña nueva quedaría en texto plano en la conversación y en los logs. Resetearla no corta las sesiones abiertas, así que después hay que revisar `pg_stat_activity`: como `postgres` solo tiene que quedar `mgmt-api`.
- **Para buscar un secreto sin imprimirlo,** leerlo a una variable dentro del mismo comando (`PW=$(sed -nE '…' archivo)`) y buscar con `git grep -F -e "$PW"` o `git log -S"$PW"`. Para enmascarar la salida: `sed -E 's#(postgres(ql)?://[^:@/ ]+:)[^@ ]+@#\1***@#g'`. El clon del sandbox es superficial (50 commits): correr `git fetch --unshallow origin master` antes de buscar en el historial.
- **Quién prueba claves legacy** (`query_logs`, últimas 24 h):
  ```sql
  select timestamp, event_message, log_attributes['request.headers.cf_connecting_ip'] as ip
  from logs where source = 'edge_logs'
    and log_attributes['request.sb.jwt.authorization.payload.algorithm'] = 'HS256'
  order by timestamp desc limit 20
  ```
  Un HS256 con `role=supabase_admin` y user-agent `@supabase-infra/mgmt-api` es de Supabase. Un `service_role` o `anon` HS256 desde otra IP es alguien probando una clave filtrada.
- **No encontrar rastro no prueba que no hubo uso.** Los logs cubren 24 h y las conexiones directas a Postgres no aparecen en ellos. `pgbouncer_logs` sí registra los logins del pooler dedicado (`login attempt: db=… user=…`).

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

### Una función-estilo de `Pressable` PUEDE descartar su bloque de layout — pero NO siempre. Verificar en celu, nunca reescribir en masa

> **Ojo:** hasta 2026-07-31 esta sección afirmaba que los props de layout dentro de una función-estilo de `Pressable` **siempre** se descartan. **Eso es falso** y llevaba a reescribir código sano. Texto corregido abajo con las dos verificaciones en dispositivo real.

**Síntoma (PR #701, 2026-06-28).** En la wallet del cliente, botones `Pressable` con `flex: 1` (y después `width: '50%'`, y hasta `width: <px>`) **colapsaban al ancho de contenido** aunque su contenedor SÍ era full-width. `pnpm check-types` pasaba y el bundle era fresco (Metro `--clear` + `console.log` de `useWindowDimensions`: valores correctos, sin aplicarse al render).

**Segunda aparición (2026-07-31, perfil del conductor).** `renderMenuRow` en `apps/driver/app/(tabs)/profile.tsx` ponía TODO el layout de la fila dentro de `style={({ pressed }) => [{ flexDirection:'row', padding…, borderBottom… }, pressed && {…}]}`. En el celu la fila salía **apilada en vertical** (ícono / label / chevron), sin padding y sin separadores, mientras cada estilo-objeto de los hijos se aplicaba perfecto. Fix: mover la caja a un `View` interno con estilo-objeto y dejar solo el paint en children-as-function.

**NO es una regla universal — medido, no deducido.** En la MISMA app, mismo build y misma sesión, cinco `Pressable` con la **forma idéntica** (`[{layout inline}, pressed && {…}]`) renderizan **perfecto**, incluido uno con `flexDirection:'row'` + paddings:

| Call site | Layout dentro de la función | En celu |
|---|---|---|
| `driver/(tabs)/profile.tsx` `renderMenuRow` | `flexDirection`, paddings, `borderBottom*` | **ROTO** |
| `driver/wallet/recharge.tsx:379` | `flexDirection`, `gap`, paddings, bordes | sano |
| `driver/wallet/recharge.tsx:491` | `flex: 1`, paddings, bordes | sano |
| `driver/(tabs)/trips.tsx:255` | márgenes, `borderRadius`, sombra | sano |
| `driver/(tabs)/wallet.tsx:370` y `:502` | paddings / `width`+`height`+`borderRadius` | sano |

También sanos: los 3 botones flotantes del mapa en `driver/(tabs)/index.tsx` (`position:absolute` + `width/height`, función que devuelve **objeto**) y `AddressSearchBar` (array con refs de `StyleSheet.create`).

**Descartado como causa** (no volver a investigar por ahí): (a) **no** es dev-vs-release — reproduce igual en un dev client debug; (b) **no** fue un bump de dependencias — `nativewind` es **4.2.2 desde 2026-03-08** y `react-native` 0.83.4 / `expo` ~55.0.14 no se movieron nunca, así que el perfil **estuvo mal desde el rediseño #234**, no "se rompió"; (c) **no** es el interop de NativeWind por lo que se lee en `react-native-css-interop@0.2.2`: `cssInterop(Pressable, {className:"style"})` sin `className` deja `style` intacto (`cleanup()` sale temprano porque Pressable no tiene `nativeStyleToProp`). **El mecanismo real sigue sin explicación.**

**Regla operativa (lo importante):**
1. Cuando una fila/botón salga apilado o sin padding y el bloque de estilo viva en una función-estilo → aplicá el fix canónico de abajo.
2. **NO barras el repo reescribiendo todas las call sites con esa forma.** En 2026-07-31 se auditaron 17 puntos en 13 archivos del driver: **7 candidatos de forma idéntica, 0 rotos**. Reescribirlos habría sido churn con riesgo de regresión en pantallas de dinero.
3. Antes de tocar una call site sospechada, **verificala en celu** con el A/B de abajo.

**A/B decisivo (2 min, cero ambigüedad).** Con el dev client conectado a Metro: `git stash push -- <archivo>` → **reload completo** en el celu (no fast-refresh: los cambios de layout no recalculan en caliente) → mirar → `git stash pop`. Mismo build, mismo celu, misma sesión: lo único que cambia es el código. Si con el código viejo se ve roto y con el nuevo bien, la causalidad está probada. Este método reemplaza a las conjeturas sobre el mecanismo.

**Fix canónico** (y default recomendado para código nuevo — es inmune al problema sea cual sea su mecanismo, y es lo que ya hacen `@tricigo/ui/MenuRow` y `driver/src/components/settings/SettingsRow.tsx`, que renderizan bien):
- Poner el layout en un **estilo-objeto plano** — `style={{ width }}`, `style={styles.x}`, o un `View` interno que lleve la caja — nunca dentro de la función-estilo.
- Para el estado `pressed` sin tocar el layout, usar el **children-as-function** de `Pressable` y aplicar el prop de paint a un hijo con estilo-objeto:
  ```tsx
  <Pressable style={{ width }} android_ripple={{ color: 'rgba(255,255,255,0.18)' }}>
    {({ pressed }) => (
      <Inner style={{ width: '100%', opacity: pressed ? 0.9 : 1 }}>…</Inner>
    )}
  </Pressable>
  ```
- **Diagnóstico decisivo** cuando un flex-row "no llena el ancho": pintá el contenedor y los hijos con `backgroundColor` temporales + reload **limpio** (no fast-refresh: los cambios de layout en caliente no recalculan bien). Si el contenedor llena pero los hijos no → sospechar de la función-estilo. Un `console.log` de las dimensiones leído en el log de Metro confirma si los valores llegan correctos pero no se aplican.

### Un `Card` no se tiñe por `className`: NativeWind no respeta el orden en que se escriben las clases (verificado 2026-09-27)

**Síntoma:** `<Card theme="light" className="bg-orange-50 …">` se ve blanca; `<Card variant="filled" className="bg-error-light …">` se ve gris. Sin error ni warning: el tinte simplemente no aparece. Pasó en 5 tarjetas del driver (disputa, objeto perdido x2, reclamo, flota rechazada).

**Causa (medida con el compilador real, no deducida):** `react-native-css-interop` aplica las reglas que matchean ordenadas por especificidad y después por **orden en la hoja compilada** (`specificityCompare` en `dist/runtime/native/native-interop.js`); gana la última. Tailwind ordena las utilidades de un mismo plugin **alfabéticamente**, sin importar el orden del `className` ni del contenido escaneado. `Card` mete su propio fondo en el mismo `className` (`bg-white` en `theme="light"`, `bg-neutral-50` / `dark:bg-neutral-800` en `filled`…), así que un tinte solo gana si su nombre ordena después (`bg-primary-50` sí, `bg-orange-50` no). Un `dark:` pesa más que cualquier clase sin `dark:` en modo oscuro. Con `forceDark` / `theme="dark"`, `Card` pone el fondo como **estilo inline**, que le gana a toda clase.

**Regla:** una tarjeta con color propio es un `TintedCard` (`apps/driver/src/components/TintedCard.tsx`: la forma de `Card` sin fondo), nunca un `Card` con `bg-*` en `className`. `apps/driver/src/__tests__/cardTints.test.ts` compila cada `<Card>` y `<TintedCard>` del driver con NativeWind y falla si un color de `className` pierde o no existe en el tema. El cliente no tiene ese guard todavía.

**Trampa hermana:** una opacidad fuera de la escala de Tailwind (pasos de 5) no genera nada: `/10` existe, `/6` y `/12` no. Así estuvieron los bordes oscuros de `Card` (`dark:border-white/12` y `/6`) hasta #1048, que los pasó a `/[0.12]` y `/[0.06]`. Con esas clases por fin generadas, un `border-*` sin `dark:` que se le pase a un `Card` pierde en modo oscuro (por eso `ServiceTypeCard` usa `!border-primary-500`). Lo mismo pasaba en `MenuRow` (`forceDark`) y en el login del conductor (borde del `+53`, botón de Google y las líneas del divisor, que no se veían) hasta que se pasaron a `/[0.06]` y `/[0.12]`. En el admin, que también usa Tailwind 3.4, pasaba con `bg-primary-500/8` (la fila seleccionada en disputas, objetos perdidos y soporte no se marcaba) y con `from-primary-500/12` / `via-primary-500/6` en el ítem activo del `Sidebar`, hasta que se pasaron a `/[0.08]`, `/[0.12]` y `/[0.06]`. Ese ítem nunca tuvo fondo: sin la parada `from-`, `--tw-gradient-stops` queda sin definir y `bg-gradient-to-r` no dibuja nada aunque `to-transparent` sí exista. Con el tinte, `text-primary-600` en el rótulo activo quedaba en 3,6:1 en claro, por debajo de AA (sobre blanco ya estaba en 4,05:1), así que el rótulo pasó a `text-primary-700`: 4,9:1 en el peor punto del tinte. En oscuro sigue `dark:text-primary-400` (5,8:1). Un texto `primary-*` sobre un tinte de `primary-*` pierde contraste en los dos temas, así que hay que medirlo sobre el tinte y no sobre la superficie. La opción activa de `ProvinceSwitch` (`bg-primary-500/10`) tenía lo mismo y también pasó a `primary-700` (3,57 → 4,90:1). Lo mismo con el texto chico primario de `StatusBadge`, `FilterBar` (pestaña activa y chip de filtros), el rol `admin` de `users/page.tsx`, `toneBadge` en `app/page.tsx` y el chip "Asignármela" de disputas: 3,57 → 4,90:1 sobre el tinte, 4,60:1 en hover (`/15`). `KpiCard` queda en `primary-600` a propósito, porque lo usa en un ícono y en cifras de 44 px o más, que piden 3:1. Los otros tonos de esos mapas (`StatusBadge`, `FilterBar`, `toneBadge`, roles de usuarios) también estaban por debajo de AA en claro con `-600` sobre su `/10`, y pasaron a `-700` (verde, rojo, celeste) y `-800` (ámbar), igual que otras 48 líneas sueltas del admin con el mismo patrón (insignias, mapas de estado, chip de delta de `KpiCard`, acción destructiva de `DataTable`, fichas de `NotificationBell`). **Medir sobre todos los fondos donde se dibuja, no solo sobre el panel blanco:** el tinte se compone con lo que tenga abajo, y `surface`, el hover de fila de `DataTable` (`surface-sunken/60`) y `surface-sunken` son más oscuros. Con tinte `/10`, el peor caso de cada tono es: verde 4,54, rojo 5,16, celeste 4,88 y ámbar `-800` 5,98:1. El ámbar `-700` daba 4,65 sobre blanco pero 4,40 en el hover de fila y 4,24 sobre `sunken`, por eso es `-800`. `primary-700` pasa en panel, `surface` y hover de fila (4,63) y queda en 4,46 solo apoyado directo sobre el fondo de página `sunken`. Hoy ningún uso cae ahí: el peor contexto real es 4,60, el hover `/15` de "Asignármela" en un panel. Si se agrega una insignia primaria directo sobre la página, va con `primary-800` (6,17:1). Un tinte opaco (`bg-<hue>-50`/`100`) no depende del fondo de abajo. El chip de Reportes (`primary-600` sobre `bg-primary-50`, 3,72:1) pasó a `primary-700` (5,10:1). Las insignias de estado del detalle de viaje (`-700` sobre `-100`) dan entre 4,52 y 5,49:1. **Texto suelto sin tinte, en claro:** `-600` no llega a 4,5:1 sobre blanco en verde (3,30), esmeralda (3,77), ámbar (3,19), amarillo (2,94), naranja (3,56), primario (4,05) ni celeste (4,10). Con `-700` (ámbar y amarillo `-800`) pasa en panel, `surface`, hover de fila y fondo de página (mínimo 4,53). El rojo `-600` pasa sobre blanco (4,83) pero no sobre el fondo de página (4,36) ni sobre `bg-red-50` (4,41). Las cifras grandes (≥24 px, o ≥18,66 px en negrita) y los íconos piden 3:1, así que ahí `-600` suele alcanzar. **Trampa del modo oscuro:** si el elemento no tiene variante `dark:text-`, oscurecer el color para el claro también lo oscurece en oscuro (verde `-700` sobre panel oscuro: 5,43 → 3,57). Hay que agregar `dark:text-<color>-600` para dejar el oscuro como estaba. La excepción son los fondos claros opacos sin `dark:bg-` (`bg-red-50`, `bg-orange-50`), que siguen claros en los dos temas. El campo `color` de `kpiCards` en `reports/page.tsx` no se usa: `KpiCard` no lo recibe. **El gris tenue `--ink-subtle` del admin** (318 usos de `text-ink-subtle`, más placeholders y algunos puntos) estaba en 2,67–2,96:1 en claro y 3,66–4,03:1 en oscuro. Se movió sobre la misma línea de tono hacia `--ink-muted`, hasta el valor más tenue que pasa 4,6 en todos sus fondos reales (panel, `surface`, hover de fila, página, fila seleccionada con tinte `/[0.08]`, contador `sunken/70`): claro `103 110 129` (mínimo 4,60, sobre la página) y oscuro `126 135 156` (mínimo 4,62, en fila seleccionada). La distancia con `ink-muted` baja de 2,36 a 1,37 en claro y de 1,96 a 1,44 en oscuro, pero la jerarquía se sigue notando. No lo aclares de nuevo para "recuperar" esa distancia: cualquier valor más tenue vuelve a quedar por debajo de AA. En oscuro todos siguen con `-400` (5,9 a 11,5:1). Regla para insignias y chips nuevos en claro: texto `-700` sobre un tinte `-500/10` (ámbar `-800`), nunca `-600`. Los `text-amber-700` que quedan van sobre `bg-amber-50`/`100` opaco, que es otro caso. Para buscarlas, un grep de `/N` con N no múltiplo de 5 en las clases (las fracciones como `w-1/3` o `top-1/2` son falsos positivos). Para chequear si una clase existe, compilarla: `postcss([tailwindcss({...config, content:[{raw:'<clases>', extension:'html'}]})]).process('@tailwind utilities;')`. El `tailwind.config.ts` del admin se carga con `require('jiti')(ruta, { interopDefault: true })(ruta)`, con la ruta absoluta: dentro de `node -e`, `__filename` vale `[eval]` y jiti falla.

---

### Search de direcciones — estado canónico (Tier 1.5–1.7 · fuzzy 2026-06-01 · campaña de precisión 2026-08-04/05 · huella de landmarks 2026-08-21)

> Esta sección documenta el estado actual del search y los patrones aprendidos durante 5 sesiones de trabajo (26 PRs mergeados). Sirve para diagnosticar bugs futuros sin re-descubrir contexto.

**La lección transversal de toda la campaña de agosto: cada capa tenía un sesgo de normalización distinto (tildes crudas, alias no comparado, prefijo "Calle" inflando el rank, listas de categorías de la era OSM, nombres de 1 carácter tratados como substring), y en todas el mismo síntoma — la calidad del texto le ganaba a la cercanía por un tecnicismo.** Si aparece un bug nuevo de "me devuelve una calle lejana con nombre parecido", buscá el sesgo de normalización antes que el ranking.

#### Estado actual en prod

| Pieza | Versión | Notas |
|---|---|---|
| RPC `public.search_streets` | **v9 (00553)** | unaccent + velocidad (00544) → dedupe por alias (00552) → nombre pelado sin prefijo genérico + **consultas de 1 carácter** (00553). Buckets 25/100/300 km, difusos al fondo |
| Tabla `public.street_search_names` | 12.476 nombres, **00544** | Diccionario precalculado (`norm_raw`/`norm_disp`/`norm_official`/`norm_bare`/`norm_bare_official`), mantenido por trigger a nivel sentencia. Es lo que hace que el search sea ~200 ms y no 11 s |
| Tabla `public.street_intersections` | 381.951 rows | 16 provincias. `municipality`/`province` re-derivados de `cuba_admin_areas` en **00545** (antes el 63 % traía barrios de OSM mal asignados) |
| EF `search-places-google` | version 5 ACTIVE | locationBias 25km + locationRestriction Cuba bbox + bbox margin ±0.2° + cache 30d + daily cap 1000 + session tokens |
| Helpers SQL | `_street_display_name`, `_street_official_name` (00548), `_street_bare_name` (00553), `_street_full_display`, `_street_normalize_key` | Inmutables, reusables |
| Cliente — 4 componentes search | AbortController + cache + empty state + cleanup | rider mobile, rider web, web landing. **El driver ya no tiene búsqueda de direcciones** (removida en #905) |
| RPC `get_destination_suggestions` | 00359 (+ 00360 fix) | Predicciones de destino history-aware; servicio RPC-first con fallback cliente |
| RPCs de dirección cubana | **00554** | `find_intersection_point` v4 + `suggest_cross_streets` v2: nombres de 1-2 caracteres por palabra completa. Antes buscar la calle "L" matcheaba las 6.883 llamadas "Calle …" y devolvía Calle K |
| Reverse geocode | 00547 + 00550 + **00570** | `get_nearest_cross_streets` con umbral 8 m (era 20, perdía callejones); `lookup_nearest_poi_ranked` **v3**: filtra por `tricigo_category` (la lista OSM excluía el 84,6 %) + **distancia EFECTIVA a la huella del landmark** (`cuba_pois.footprint_radius_m`, 6 semillas curadas) — el pin sobre la Manzana de Gómez dice Kempinski, no "Rooftop Pool & Bar" |
| RPC `search_pois_smart` | 00362 trgm + 00550 | Nombres tolerantes a typos; river/lake/fountain salen de la lista de exclusión |
| `cuba_search_keywords` | **00551** | SOLO categorías genéricas — 10 marcas borradas (Coppelia/CADECA/ETECSA/Viazul…) porque el anti-placeholder hundía al lugar exacto buscado |
| Resolver `searchResultEmoji` | `packages/utils/src/addressSearch.ts` | Emoji de categoría en TODO resultado: tricigo cat → calle 🛣️ / esquina 🔀 → categoría cruda → keyword del nombre → 📍 |
| Anti-pin-inventado | 00546 + `isPlaceholderAddress` | Las sugerencias de transversal llevan coordenada `NaN` + `needsResolution` a propósito: antes se rellenaban con el GPS del pasajero y una dirección a medio escribir llegaba a viajes reales |
| Higiene de datos `cuba_pois` | **00571** | El sync semanal ya NO resucita filas desactivadas (`is_active` queda bajo control de curación; los INSERT nuevos siguen naciendo activos). 757 filas fuera-de-Cuba desactivadas + dupes tele-transportados de hoteles famosos fuera |

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
| **Campaña de precisión 2026-08-04/05** (PRs #929–#937) — disparada por "Callejón de los Protestantes → N e/ 9 y 11 a 1,5 km" | | |
| 00544 | v7 — **unaccent + velocidad** | Diccionario `street_search_names` + índice cubriente. El search comparaba tildes literalmente y tardaba **11,4 s** |
| 00545 | Backfill `municipality`/`province` desde `cuba_admin_areas` | El 63 % traía nombres de barrio de OSM mal asignados. Correr en tandas: revienta el timeout |
| 00546 | Backstop anti-placeholder | `_ride_address_is_placeholder` — texto a medio escribir llegaba como dirección de viajes reales |
| 00547 | `get_nearest_cross_streets` umbral 20 m → **8 m** | Las cuadras cortas (callejones) se perdían y el punto quedaba etiquetado con la calle vecina. Es el síntoma del reporte original |
| 00548 | v8 — **nombre oficial** de las calles con alias | 10,5 % de las calles usa "Oficial (Alias)"; tecleando el oficial devolvía otra a 18 km |
| 00549 | `find_intersection_point` v3 — esquinas inexistentes | Rama `exact_corner` con `cross_street_2` + puerta de palabra completa |
| 00550 | Reverse geocode de lugares por `tricigo_category` | La lista blanca OSM excluía el **84,6 %** de `cuba_pois` — todas las playas. Parado en Playa Guardalavaca la dirección era "Holguín" |
| 00551 | Sacar 10 marcas de `cuba_search_keywords` | Registradas como categoría, el anti-placeholder hundía al lugar exacto buscado |
| 00552 | v8.1 — el dedupe por alias se comía el mejor match | Dos calles oficiales que comparten alias. **Lo encontró la verificación con semillas de OTRA provincia** |
| 00553 | v9 — **prefijo genérico + 1 carácter** | "Calle"/"Avenida" decidían el rank (`23` daba una a 7 km); las calles de 1 letra (11 % de las esquinas) no se podían buscar |
| 00554 | `find_intersection_point` v4 + `suggest_cross_streets` v2 | Nombres de 1-2 caracteres por palabra completa: `'%l%'` matchea "Calle …" porque *calle* tiene una `l` → buscar "L" devolvía **Calle K** |
| *(00555–00569: otras áreas, no search)* | | |
| **00570** | **Huella de landmarks** — `cuba_pois.footprint_radius_m` + `lookup_nearest_poi_ranked` v3 (PR #976, **aplicada 2026-08-21**) | El pin sobre un landmark-cuadra decía su sub-local: "Rooftop Pool & Bar" (11.6 m) le ganaba al Kempinski (23 m) porque las bandas de 10 m van contra el PUNTO que representa la cuadra. Distancia efectiva `GREATEST(0, cruda − huella)` en gather/bandas/orden/**`distance_m` devuelto**; desempates finales cruda + `p.id` |
| **00571** | **Limpieza curada de `cuba_pois`** + el sync deja de resucitar filas desactivadas (PR #978, **aplicada 2026-08-21**) | 757 filas activas FUERA de Cuba (Bahamas/Caimán/cruceros), dupes tele-transportados de hoteles famosos ("Kempinski" en Nuevo Vedado a d=0), y el punto del admin "Parque Central" movido al parque real. **Paso 0 obligatorio**: `bulk_upsert_pois`/`apply_osm_delta_batch` forzaban `is_active=TRUE` al re-encontrar la fila upstream — sin ese parche, TODA limpieza no-admin se revertía en el sync semanal |

**Numeración próxima libre — calculala, no la leas de acá.** El número escrito en este archivo vence en horas: el 2026-08-21 caducó **dos veces el mismo día** (00571 se la llevó un merge, 00573 un PR abierto minutos después de documentarla). Son dos consultas y **hacen falta las dos**:

```bash
git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -5
for pr in $(gh pr list --state open --json number --jq '.[].number'); do gh pr view $pr --json files --jq '.files[].path' | grep supabase/migrations; done
```

**El cruce contra PRs abiertos no es un segundo chequeo opcional, es el que decide**, porque un número reservado puede ser un HUECO en master (ver el detalle en § "Pre-flight para elegir número de migración"). Foto del 2026-08-22, asumila vencida: master en **00572**; reservadas **00569** (#965) y **00573** (#981); **00574** anunciada por otra sesión sin PR todavía; próxima libre **00575**.

#### Huella de landmarks — el pin sobre un landmark grande debe decir el landmark (00570, 2026-08-21)

**Mecánica.** `cuba_pois.footprint_radius_m` (smallint, `NULL` = comportamiento idéntico byte a byte; CHECK: solo `is_admin`, 1..60 — **el 60 está ACOPLADO al prefiltro constante `p_radius_m + 60`** que conserva el índice GIST; si se sube uno, subir el otro). `lookup_nearest_poi_ranked` v3 usa la distancia EFECTIVA en el gather, las bandas, el orden **y el `distance_m` devuelto** — devolverla efectiva es load-bearing: el cliente solo antepone el POI si `distance_m ≤ 20` (`POI_INCLUSION_THRESHOLD_M` en `packages/utils/src/geo.ts`); con la cruda el fix ganaría el ranking y perdería la pantalla. Dentro de la huella el landmark cae en banda 0 e `is_admin` gana el empate contra cualquier sub-local pegado al pin → robusto a imports futuros sin curar nada más. Semillas vivas: Kempinski 30, Hotel Nacional 40, Habana Libre 23, Iberostar Selection Parque Central 8, Inglaterra 10, Casagranda (Santiago) 5.

**Protocolo para sembrar una huella nueva** (todo contra la función viva ANTES de sembrar; los radios de 00570 se re-derivaron 3 veces porque cada borrador flipeaba un vecino real que la suite cazó):

1. **La zona de influencia real es `r + 10 m`** (el ancho de banda): el pin propio de un vecino flipea apenas `dist − r < 10`, y un pin a 5-7 m de su PUERTA flipea antes (medido: Pastelería Francesa a 6.3 m del pin perdía contra Inglaterra con r=12). Regla: `r ≤ dist(vecino genuino más cercano) − 15`, y `r + 10` debe caber en el cuerpo físico del landmark + su propia acera.
2. **Dump del vecindario a 45 m** y clasificar cada punto: amenity propio / basura mal geocodificada / vecino genuino. **Los landmarks famosos son imanes de basura geocodificada** ("Estadio Latinoamericano" a 9.8 m del Hotel Nacional, "Playa Boca Ciega" a 13.4 m del Iberostar PC): dentro del círculo físico del landmark, tragar lo ajeno MEJORA la etiqueta.
3. **Suite mínima**: pines del caso + **sobrevivientes** (el punto exacto del vecino genuino más cercano Y un pin a ~6 m de su puerta) + los 3 controles de 00550 + grilla 9×9 paso 15 m. En grillas multi-semilla la aserción es **cross-seed**: un pin del grid de X puede caer legítimamente en el halo de Y (pasó entre Iberostar PC y Kempinski, a 114 m entre sí).
4. **NO sembrados, con causa — no reintentar**: Ambos Mundos (no hay bug: su único sub-local a 6.8 m siempre comparte banda e `is_admin` ya gana hoy), Brisas Guardalavaca (hostales a 19-22 m del punto = patrón lección-721), "Parque Central" admin (su punto estaba a 7.5 m del hotel Iberostar — **00571 lo movió al centro real del parque**; sigue sin huella, re-evaluable con este protocolo si aparece el síntoma), Iberostar Grand Trinidad (caso de control + vecindario basural), Melia Cohiba (fila sucia, `tricigo_category='transport'`).

#### Novedades 2026-09-05 (PR #989 — mapa del cliente: búsqueda, pin, notas)

- **Esquinas en forma cubana "X y Y" / "X esq. Y".** El servidor las resolvía desde hace meses (`find_intersection_point(main, cross1, NULL)`), pero `parseCubanAddress` solo entendía "e/"/"entre", así que "23 y 12" iba a `search_streets` y volvía como dos calles sueltas. Ahora `parseCornerQuery` (`geo.ts`) las detecta y la búsqueda corre **en paralelo** (cuarto miembro del `Promise.all`) y solo **antepone** el resultado — nunca corto-circuito, para que un POI llamado "Pan y Canela" conserve su fila.
- **Zona amplia ⇒ confirmación de pin obligatoria.** Medido en prod: 13 % de los destinos eran una zona pelada ("Vedado, La Habana", "Cerro, La Habana"). Dos orígenes: (a) fila de Google/Mapbox de tipo `locality/sublocality/neighborhood/…` que pasaba por POI porque `displayName ≠ address` (ahora `isZoneLevelResult` → `zoneLike` → picker con caption "Es una zona amplia"); (b) pin del picker sin calle a <200 m (la capa `locality` del reverse geocode) — ahora el picker muestra confianza (`pinConfidence(source)`: exacta / sin calle cercana) y el botón dice "Confirmar de todos modos". La rama **pickup** de `onSelect` ignoraba `confirmPin`; ya no.
- **Marcadores arrastrables** en el mapa de selección: `PointAnnotation draggable` (long-press y mover; API verificada en `node_modules/@rnmapbox/maps/lib/typescript`). Tres trampas resueltas: el re-fit de bounds salta la cámara tras soltar (grabar `lastFitRideKey` ANTES de avisar al padre); el long-press sobre un marcador debe ser arrastre y no picker (`isNearScreenPoint` sobre `getPointInView`); el bounce del destino vive en un `MarkerView` que `PointAnnotation` no puede animar (ghost swap de 600 ms). Opt-in por props: revisión y viaje activo siguen con pines fijos.
- **Notas al conductor (00578)**: `rides.pickup_notes/dropoff_notes` (≤200). Regla dura: **no** van en el push de oferta (`notify_driver_new_offer`) ni en `SharedRideView`; el conductor las ve en el hero de `DriverTripView` y en `RouteInfoCard`, nunca en la tarjeta de oferta. El cliente tolera la migración sin aplicar: `createRide` reintenta el insert SIN las dos claves ante `PGRST204` que nombre esas columnas (otras columnas ausentes siguen fallando). Casa/Trabajo son slots fijos (`SavedLocation.kind`; `resolveFixedPlaces` cae a la etiqueta para filas legacy) con `details` que prellenan la nota.
- **Ensayo de la migración en Postgres local** (patrón de la sección de `audit_log`): el texto de `pg_get_functiondef` termina en `$function$` **sin punto y coma** — al pegarlo en un andamio hay que cerrarlo con `;` o el statement siguiente se lo traga (costó una vuelta). El md5 del cuerpo parcheado se calcula en Python con el mismo `replace` y se compara con `md5(prosrc)` local: igualdad = el `DO $patch$` hizo exactamente lo previsto.
- **`packages/api/src/__tests__/ride.integration.test.ts` mockea `@tricigo/utils` entero**: cualquier util nuevo que use `ride.service.ts` hay que agregarlo a ese `vi.mock` o la suite falla con "No 'X' export is defined on the mock".

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

**Síntoma: "Parado sobre un landmark grande, la dirección dice su bar/piscina/tienda interna"**

Clase cerrada por 00570 para los landmarks sembrados. Chequear si ese landmark tiene huella: `SELECT name, footprint_radius_m FROM cuba_pois WHERE is_admin AND footprint_radius_m IS NOT NULL`. Si NO está sembrado → sembrarle huella con el protocolo de arriba. **NO tocar el ranking global**: un bonus genérico de distancia para admins regresiona el control de Trinidad (la ventana que arregla la Manzana y no rompe Trinidad no existe), y la supresión por categoría fue medida con 721 víctimas legítimas (lección-721). Si el punto del landmark está mal ubicado, se cura el punto, no el radio (caso "Parque Central" a 7.5 m del hotel — curado en 00571).

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

#### Método para tocar el ranking del search (aprendido a golpes en la campaña de agosto)

1. **Candidata con OTRO nombre en prod, nunca editar la viva.** `search_streets_v9c`, `find_intersection_point_v4c`… Se compara A/B contra la viva con la misma semilla, y la migración final las DROPPEA. Si la candidata necesita columnas nuevas, copiar el diccionario a una tabla desechable (`street_search_names_v9c`) en vez de alterar la real.
2. **Transcribir desde `pg_get_functiondef` VIVO, no desde la migración de git.** Lo que corre puede ser varias migraciones más nuevo que el último archivo que la menciona. Para cambios de una línea sobre funciones grandes, usar el patch in-place con `DO $patch$` (no puede perder features). Comprobar fidelidad con `md5(prosrc)` y `length(prosrc)`.
3. **Arreglar la escalera de `match_rank` NO alcanza: hay que tocar el `sim` en el mismo sitio.** Al empatar en rank 0, decide `sim DESC`, y `similarity('23','23')=1.000` vs `similarity('calle 23','23')=0.333` revierte el arreglo entero. Pasó en 00548 y volvió a pasar en 00553.
4. **Medir con suites de control, no solo con el caso que motivó el cambio.** El mínimo son cuatro: el caso arreglado, tildes, alias-por-oficial, y calles sin nada especial (esta última debe dar **0 filas cambiadas**, no solo "0 empeoran").
5. **Semillas de otra provincia que las del desarrollo.** El bug de 00552 (172 km de error) solo apareció al re-verificar con semillas frescas; el set original no contenía ningún alias compartido.
6. **Las muestras chicas mienten.** La métrica de 00547 pasó de "3/3 mejoras" (300 pts) a "3 arregla / 0 rompe / 36 ambas-válidas" (1.200 pts). Y una muestra elegida a mano hizo creer que `find_intersection_point` tenía el bug del prefijo — 117 casos medidos lo desmintieron.
7. **`EXPLAIN ANALYZE` en estas tablas es ruidoso** (la misma consulta dio 3.331 ms en frío y 385 ms en caliente). Comparar SIEMPRE en caliente, alternado, ≥3 corridas. Un filtro más estricto suele salir **más rápido**, no más lento: recorta el candidato.
8. **Despojar prefijos genéricos por fila cuesta 2,1 s.** Del lado de los nombres va precalculado en `street_search_names`; del lado de la consulta se hace una sola vez.
9. **El conector MCP se cae con estas mediciones.** Partirlas en tandas de ~80-100 casos y `SET statement_timeout='5min'`.
10. **Si el DDL está gateado (MCP guard), la candidata corre como SELECT inline** con las columnas nuevas simuladas por un CTE `VALUES` joineado por id — semánticamente idéntico al patrón candidata-con-otro-nombre y no requiere autorización. Así se midió 00570 entero (pines nombrados + grillas de 486 + barridos nacionales de 2.350 pines) antes del apply; post-apply se re-corre la suite vía la función real.
11. **Cerrar SIEMPRE el ORDER BY con `p.id`.** Los imports apilan POIs distintos en la MISMA coordenada con la misma confidence (3 pares a 0.00 m en el barrido nacional) → sin id, el ganador entre empatados depende del plan de ejecución, no de los datos. Corolario para el A/B: un "diff" puede ser **nondeterminismo preexistente**, no una regresión tuya — la viva devolvió miembros distintos del mismo cluster según el radio de búsqueda; antes de asumir regresión, verificar `ST_Distance(a,b)=0 AND conf_a=conf_b`.
12. **La suite de sobrevivientes va ANTES de fijar constantes, y "la puerta del vecino" es parte de la suite.** Proteger solo el punto exacto del vecino no alcanza: un pin a 5-7 m de su puerta todavía flipea (banda). Los radios de 00570 se re-derivaron 3 veces porque cada borrador rompía un vecino real (La Xana, Pastelería) que solo la suite detectó — el caso que motivó el cambio jamás lo habría mostrado.

#### Deuda explícitamente diferida (no urgente)

- **R2** retry Place Details con backoff 300ms — protege contra 429 transient
- **R3** tabla `google_places_diagnostics` para visibilidad de descartes
- **G2.1** Place Details lazy (solo on-select) — ahorra ~30% costo cuando crezca el tráfico
- **G2.2** reverse geocoding con Google — mejora calidad de "Use my location"
- **Rider cosmético** — isFinite check en recents + emoji categoría Google POIs + unify debounce 300ms
- **Lugares llamados literalmente "Parque" / "Enfermería"** se hunden por `is_generic * 5000` (anti-placeholder). Es por diseño, pero no aparecen ni en el top-5.
- **Zonas rurales sin malla de calles** devuelven nombre de zona en vez de esquinas. Es hueco de datos, no de código.

Abordar cuando aparezca un síntoma concreto que lo justifique, NO preventivamente.

---

### POIs — capa de curación (00579–00581, PR-1 de la campaña 2026-09-05)

Spec: `docs/superpowers/specs/2026-09-05-poi-quality-design.md`; plan PR-1: `docs/superpowers/plans/2026-09-05-poi-quality-pr1-data.md`. **Ensayo local obligatorio antes de tocar estas migraciones:** `supabase/tests/poi/run.sh` (Postgres 16 + PostGIS del sandbox, usuario `pgtest`, puerto 5433) reconstruye la base desde `scaffold.sql` (DDL real de `cuba_pois` + cuerpos VIVOS de los RPC admin), aplica cada `0058x` **dos veces** (idempotencia) y corre `tests.sql` (101 aserciones). Si prod redefine `admin_update_poi` / `admin_create_poi` / `approve_poi_submission` / `import_search_poi` / `map_category_to_tricigo`, re-capturar el cuerpo en el scaffold: los `DO $patch$` asertan que su literal aparece exactamente una vez.

| Pieza | Dónde | Regla |
|---|---|---|
| `display_name` | trigger `tg_cuba_pois_display_name` = `COALESCE(name_override, _poi_clean_name(name))` | El sync jamás la ensucia (recalcula al renombrar); el admin gana con `name_override`. Las apps muestran `display_name`, no `name` |
| `_poi_clean_name` | 00579 §B, 37 fixtures de nombres reales | Saca descriptores suecos de Wikidata, ", La Habana, Cuba", comillas, repara MAYÚSCULAS / minúsculas / "De La … Los". **Exige coma o ciudad antes de "Cuba"**: "Banco Central de Cuba" y "Universidad de La Habana" quedan intactos |
| `cuba_poi_aliases` | popular/official/brand/short/old; seeds OSM (`alt_name`, `brand`…) + 41 nombres populares habaneros ("La Benéfica" → Hospital Miguel Enríquez) | Nunca sobre una fila `transport` (las paradas llevan nombres de landmarks). Alias igual al nombre → se omite |
| `poi_search_names` | diccionario precalculado (display / bare / alias / brand), triggers a nivel sentencia con transition tables | Solo filas activas y no fusionadas. Índice `text_pattern_ops` (la collation es `en_US.UTF-8`: un btree plano NO sirve `LIKE 'x%'`). `search_pois_smart` v2 (PR-2) lee solo esto |
| municipio / provincia | 00580, `_poi_admin_area` por punto-en-polígono, trigger `UPDATE OF location` + backfill por tandas de 20k | `COALESCE`: fuera de todo polígono conserva lo que traía |
| taxonomía | `poi_taxonomy()` = 24 valores (+ `landmark` 🏛️, `venue` 🎭, `stadium` 🏟️); CHECK en `tricigo_category` y `category_override` | **Siete superficies** (TS union, SQL, `categories.json`, importer Mapbox, emoji, grupos visuales, **y el mapper SQL**) — `pnpm check:poi-taxonomy` en CI falla si divergen |
| `map_category_to_tricigo` | **GENERADO** desde `categories.json` por `scripts/sync-pois/gen-sql-mapper.mjs` (mismo algoritmo que `merge_and_upsert.py`) | No se edita a mano: editar el JSON → regenerar → pegar en una migración NUEVA. CI compara byte a byte contra la migración más nueva que lo define |
| curación sync-proof | `name_override`, `category_override`, `is_landmark`, `pick_count`, `merged_into` | `bulk_upsert_pois` **sí** reescribe `tricigo_category` (por eso `categories.json` va en el mismo PR); nunca toca estas columnas |
| `search_pois_smart` **v2** | **00583** (PR-2). Candidatos desde `poi_search_names` (display/bare/alias/brand, índices trgm + prefijo); rank = tier de match → landmark −120 / admin −60 → parada-sombra +700 salvo intención de transporte → −15 por elección (tope 20) → +150 si `synced_at` > 90 d y no-admin → +250 si la categoría no es la del keyword → confianza → distancia → contacto; colapso a 300 m por nombre+categoría sobre el top-K; filas fusionadas fuera | `name` = `display_name` y `tricigo_category` = efectiva (override gana): las apps instaladas ven nombres limpios **sin rebuild**. Columnas nuevas `matched_alias`, `display_name`, `is_landmark` → **DROP + CREATE** (agregar columnas cambia el return type: 42P13 con CREATE OR REPLACE). `SET jit TO off` en la función. `lookup_nearest_poi_ranked` devuelve `display_name` (patch in-place de una línea; el ranking 00570 intacto) |
| aprendizaje de elecciones | **00584**. `record_poi_pick(id)` (authenticated, 60/h; lo llama PR-3), `bump_poi_pick(id)` (solo service role), trigger `trg_rides_learn_poi_picks` AFTER INSERT ON `rides` (defensivo): el texto antes de la primera coma acredita el POI (`find_nearby_poi_match` v2, 60 m, alias y display incluidos) o va a `poi_import_queue`; cron `drain-poi-import-queue` (`*/15`, `cron_http_post`, **solo si hay cola**) → EF `import-mapbox-poi` `{drain:20}` con el service role exacto como Bearer | La EF conserva el modo usuario; el `importPoiFromSearch` del cliente/web se eliminó (el servidor cubre app y web). Suite real: `psql -d poi_real -v fn=search_pois_smart -f supabase/tests/poi/search_suite.sql` (60 consultas + 20 controles v1/v2) |

**Estado en prod (aplicado 2026-09-07):** 00578–00584 aplicadas por MCP (00579 en 5 partes con el backfill de `display_name` en 8 rangos de id; 00580 en DDL + 11 rangos; 00581, 00583 y 00584 enteras — ver § "Aplicar migraciones pesadas por MCP") y EF `import-mapbox-poi` v9 desplegada con `verify_jwt=true`. Verificado contra prod: `poi_search_names` 25.963 entradas / 18.861 POIs activos (806 duplicados fusionados, 782 landmarks, 273 venues, 35 estadios, 0 descriptores suecos activos); municipios distintos 759 → 212 y provincias 200+ → 17; los 3 RPC admin ya no escriben `name_normalized`; `trg_rides_learn_poi_picks` probado con un viaje real dentro de una transacción revertida (Coppelia +1 pick, un paladar inexistente a `poi_import_queue`); cron `drain-poi-import-queue` activo e inerte con cola vacía. **El drenaje automático de la cola NO sirve, y el secret ausente es la MENOR de las razones (medido 2026-09-07).** `MAPBOX_ACCESS_TOKEN` no existe en las Edge Functions, así que el `drain` responde `200 mapbox_not_configured`. Pero setearlo no arregla nada: **Mapbox no tiene POIs de Cuba**. Con el token público del repo, la llamada exacta que hace el drain (`searchbox/v1/forward`, `country=cu`, `types=poi`) devolvió **0 resultados en 10 de 10 lugares emblemáticos** (Coppelia, Hotel Nacional, El Capitolio, La Bodeguita, FAC, Ameijeiras, Cementerio de Colón, aeropuerto José Martí, Karl Marx, Estadio Latinoamericano). Sacando `country=cu` aparecen homónimos de Estados Unidos, Portugal, Brasil, México y Rusia — o sea que el filtro de país es lo único que separa a la cola de importar un "Hotel Nacional" portugués (el geofence `out_of_cuba` de `import_search_poi` es la segunda red). Mapbox sí cubre Cuba a nivel de ciudad (`geocode/v6` devuelve La Habana, La Habana Vieja, La Habana del Este), pero no a nivel de lugar. **Confirmación independiente sin tocar Mapbox:** las 18.861 filas activas salen de `overture` (11.133), `merged` (4.619), `foursquare` (3.001) y `osm` (108) — **`source='mapbox'` es CERO**, pese a que el import cliente estuvo cableado meses. Es el patrón "un fallback que nunca se ejerció no es un fallback" otra vez: un proveedor con 0 filas históricas está roto, no de respaldo.

**Qué hacer con eso (decisión pendiente, no es un secret que falta):** la cola sigue teniendo valor por sí sola — es la lista de lugares que pasajeros reales pidieron y que NO existen en la base, o sea justo el insumo de curación del panel admin (PR-4 de la campaña). Las salidas son: (a) dejar el drenaje apagado y consumir `poi_import_queue` como worklist humana; (b) apuntar el worker a una fuente que sí cubra Cuba (Overture/OSM, que son las que ya llenan la base), lo que además vuelve discutible el motivo original de elegir Mapbox — su TOS permitía almacenar, pero no hay nada que almacenar. **No setear el secret esperando que la cola se drene sola: drenaría a `failed` sin importar una sola fila.** Latencia de `search_pois_smart` v2 en prod en caliente: **18-27 ms** exactas/alias, **96-350 ms** keyword/fuzzy ("hotel", "museo de bellas artes"); las llamadas de 2-5 s vistas justo después del apply son la instancia con memoria fría (mismo plan, mismos buffers, 100× por nodo — ver § "Aplicar migraciones pesadas por MCP"), no el plan.

**Lo que enseñó la búsqueda v2 (PR-2, 2026-09-06 — medido sobre las 19.939 filas activas reales):** (1) **el plan tardaba 45 ms y la función 245: era JIT** — un costo estimado inflado (un `NOT IN`/`NOT EXISTS` contra el CTE) cruzaba `jit_above_cost` y compilar 108 expresiones costaba 149 ms; `auto_explain` con `log_nested_statements` es la única forma de verlo dentro de una plpgsql, y `SET jit TO off` a nivel de función lo cierra sin depender de la config del servidor. (2) **pg_trgm no indexa agujas de <3 caracteres**: `ca` barría el diccionario entero (2,5 s) — bajo 3 chars solo prefijo (btree `text_pattern_ops`) y exacto. (3) **`unaccent()` por fila cuesta ~100 µs**: nunca en la proyección de miles de candidatos; normalizar solo la ventana top-K y sacar `is_generic` del diccionario. (4) **La regla de nombre pelado tiene dos direcciones**: consulta con prefijo y fila sin él ("hotel melia cohiba" → "Meliá Cohiba", rank 0.5) vs prefijos distintos ("restaurante la guarida" → "Paladar La Guarida", 1.5); igualar pelado-con-pelado a rank 0 hacía que "panadería prueba" devolviera "Café de Prueba". (5) **Tokens antes que trigram**: `similarity('museo nacional de bellas artes','museo de bellas artes') > 0.3` ganaba al tier de todos-los-tokens si el fuzzy se evaluaba primero. (6) **Un keyword de categoría necesita desempate por categoría** (+250 dentro del tier) o "Museo de la Farmacia Habanera" le gana a "Farmacia Taquechel" para *farmacia*. (7) Los controles "no cambia" **sí cambian con causa**: la fila admin "Hotel Melia Cohiba" (#71115) es una **parada de guagua** (`public_transport/platform`) con nombre de hotel → +700 y pierde contra el resort real; "cupet" pasa de una fila llamada "CUPET" al servicentro más cercano por la fila `brand`. Cada control movido va explicado en el PR, nunca silenciado. (8) Un `clock_timestamp()` en el mismo SELECT que la llamada medida da **0 ms** (initplan): medir con `\timing` de psql por sentencia.

**Bugs que destapó (y sus trampas):** (1) `admin_update_poi` / `admin_create_poi` / `approve_poi_submission` fallaban con **428C9** desde 00309 (asignaban la columna GENERATED `name_normalized`) — patch in-place. (2) Wikidata nunca cargó: `" ".join` en el `IN (...)` del SPARQL → HTTP 400 en cada corrida; `", ".join` lo arregla (95 features desde el sandbox). (3) Foursquare: el matcher de `label_keywords` itera en orden y `landmark` precedía a `beach`/`park` → 77 playas, 44 parques y 86 barrios etiquetados `museum`. **El orden del JSON es semántica.** (4) En regex de Postgres **`\b` es backspace**, el límite de palabra es `\y` — el borrador del plan lo tenía y habría convertido "Banco Central de Cuba" en "Banco Central de". (5) En un test plpgsql `PERFORM _t(nombre, f_volatil(...) AND EXISTS (SELECT …))` Postgres puede evaluar el `EXISTS` como initplan ANTES de la llamada → asignar primero a una variable y asertar después.

**Lo que enseñaron las pruebas reales (dry-runs sobre prod, 2026-09-05 — commit `220215e`):**
- **Dos copias a mano de un mismo mapeo SIEMPRE divergen.** El mapper SQL y `categories.json` (lo que escribe el sync semanal vía `bulk_upsert_pois`) diferían en 9 pares reales = 101 filas activas que el sync habría revertido en su primera corrida, y en 68 claves del propio JSON. La verificación que lo caza es mecánica y barata: sacar los pares `(source, category, subcategory, count)` distintos de las filas activas de prod, pasarlos por la función SQL (ensayo local) y por los mappers Python (extraídos con `ast` + `exec`, porque `merge_and_upsert.py` importa pyarrow/rtree), y exigir **0 flips**; sumarle un barrido sintético con todas las claves del JSON. La solución durable fue generar el SQL desde el JSON y ponerle CI, no alinear listas.
- **La base activa es un 18 % del total**: el filtro de confianza del 2026-05-25 dejó inactivas ~90k filas OSM (conf 0.5/0.55). Cualquier semilla/alias/curación que apunte a un landmark tiene que verificar `is_active` — 17 de 41 alias curados resolvían a nada por eso, y el arreglo fue reactivar 5 landmarks concretos por id + nombre normalizado, no aflojar el filtro.
- **Una regex con `~` (case-sensitive) devolviendo 0 filas no es "no hay casos"**: los descriptores suecos aparecían con `~*`. Antes de concluir "0", probar la variante insensible.
- **El limpiador se valida contra nombres reales, no contra fixtures inventadas**: una muestra de 183 nombres difíciles de prod (`ORDER BY random()` dentro de un CTE — `UNION … ORDER BY random()` directo falla) revisada a mano destapó 4 sobre-recortes y 2 fallos de capitalización que 37 fixtures no vieron.

**Pruebas de estrés con direcciones y lugares reales (2026-09-06) — el método que funcionó y lo que destapó:**
- **Exportar prod por PostgREST con la publishable key funciona para `cuba_pois`** (RLS abierta a lectura): páginas de 500 filas por keyset (`id=gt.<last>&order=id&limit=500`, ~2 s cada una); 1000 filas con `tags`/`source_ids` revientan el statement_timeout del rol anon (8 s). Con eso las migraciones se ensayan sobre las **19.939 filas activas reales**, no sobre fixtures — y ahí aparecieron los bugs que 40 fixtures jamás muestran (una semilla que nunca podía resolver porque su blanco es `transport`, "Melia Cayo Santa Maria Cuba" → "Melia"). Script: `scratchpad/run_real.sh` de la sesión; el patrón es cargar un CSV en una tabla stage y `INSERT … SELECT` con `ST_SetSRID(ST_MakePoint(lng,lat),4326)::geography`.
- **Un RPC `LANGUAGE sql` se prueba en prod SIN DDL**: su cuerpo entero corre como `SELECT` inline dentro de un `LATERAL` por caso (`WITH cases(...) AS (VALUES …) … CROSS JOIN LATERAL (WITH p AS (…) … ) v5`) al lado de la función viva → A/B con nombre por caso. Así se validó `find_intersection_point` v5 (00582) contra 34 esquinas con nombre y 40 reales al azar antes de escribir la migración. Ojo con `CROSS JOIN LATERAL`: si la candidata devuelve 0 filas el caso desaparece; usar `LEFT JOIN LATERAL … ON true` para ver los NULL.
- **Trampa de coma flotante en `similarity(...) > 0.3`**: `similarity('ciclon','colon')` es exactamente 3/10 y como `real` puede quedar por ENCIMA del literal `0.3` (double) → una candidata que compare contra otro texto (`norm_bare` en vez del nombre crudo) inventa esquinas que la viva rechazaba. Conservar el mismo operando que la función viva o subir el umbral.
- **El control de una función de búsqueda son filas reales consultadas por su propio nombre**: 40 intersecciones al azar (`TABLESAMPLE SYSTEM (0.05)`) con `_street_display_name(main)`/`(cross)` como consulta y "acierto = punto devuelto a ≤40 m del real". v4 dio 36/40 y los 4 fallos eran todos cuadrículas numéricas — el mismo bug de los casos con nombre, medido sin sesgo.
- **`cron`/`clock_timestamp()` para latencia en prod**: `SELECT k, t1−t0 FROM (SELECT 'x', clock_timestamp() t0, (SELECT count(*) FROM rpc(...)), clock_timestamp() t1) x` en un `UNION ALL` mide cada RPC en una sola llamada MCP. Medido: `search_streets` 43-86 ms caliente (480 frío); `search_pois_smart` ~100 ms caliente pero **3-4 s la primera llamada del día**; `find_intersection_point` v4 190-490 ms caliente, 1,2-2,5 s frío (33.618 intersecciones a 8 km del Vedado con `regexp_replace` por fila).
- **Huecos de DATOS, no de código (no perseguirlos en el ranking):** "Jesús del Monte" no existe en ninguna intersección (OSM solo tiene "Calzada del 10 de Octubre"); "23 y Malecón" en La Habana no tiene fila (sí en Caibarién). Van a una tabla de alias de calles, no a `search_streets`.
- **`search_pois_smart` vivo (pre PR-2):** la distancia le gana al nombre exacto ("Fábrica de Arte" → *Fábrica de Tabacos Partagás* primero), las paradas de guagua con nombre de landmark salen antes que el landmark (Ameijeiras, Cementerio de Colón, Hospital Naval), y faltan alias (FAC, La Benéfica, **Covadonga** → agregar como semilla). Reverse geocode sobre 150 POIs reales: etiqueta POI en 150/150, la propia en 130 (los 20 restantes son duplicados/vecinos pegados), calle en 111.
- **El parser de esquinas del cliente (PR #989) corrido sobre los 19.939 nombres reales**: 791 parseaban como esquina, ¾ eran "Hostal X y Y" / instituciones / ministerios → cada uno costaba una RPC por tecla. Prefijos de venue en la lista → 467, y los fuertes que quedan son esquinas de verdad usadas como nombre ("100 y Boyeros", "Línea y G").

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
3. **Corporate**: `corporate_cash` para wallet de empresa (necesita `admin_adjust_wallet` extended desde 00338 para acreditar via RPC oficial). **Se asocia al CREADOR de la cuenta (`corporate_accounts.created_by`), nunca al id de la cuenta**: así la buscan `handle_corporate_ride_completion` (el cobro real; la rama corporativa de `complete_ride_and_pay` es un `NULL`), `process_recharge_payment`/`_refund` y `admin_adjust_wallet`. El id de la cuenta no es un `users.id`: choca con la FK y con la verja de 00591 (42501). El cliente usaba la clave vieja de la 00086 y falló en silencio hasta 00601 (`register_corporate_account`, que crea cuenta, fila de admin y billetera en una transacción). Los lectores `getCorporateBalance` (corporate y wallet service) usaban la clave vieja y mostraban 0 hasta 00624: ahora leen con `get_corporate_balance(p_account_id)`, que sigue `created_by` y deja leer a cualquier admin de la empresa (un segundo admin no puede leer la billetera del creador directo: `wallet_accounts` es propia o de admin). Por lo mismo, los nombres y teléfonos de los empleados salen de `get_corporate_employees` (`users` es propia o de admin), y `addEmployee` busca con `find_user_by_phone` (teléfono confirmado), nunca leyendo `users.phone`. Consecuencia del diseño: un creador con dos cuentas corporativas comparte UNA billetera.
   - **Desde 00625 los viajes corporativos son prepagos.** `tg_rides_validate_corporate` acepta un viaje pagado por la empresa solo si esa billetera cubre su estimado: saldo − `held_balance` − los estimados de los otros viajes en curso de **todas** las empresas del mismo creador. Bloquea la fila de la billetera (`FOR UPDATE`) antes de sumar, así dos pedidos simultáneos no gastan la misma plata. Corre al crear el viaje, al pasarlo a la empresa y cuando sube el estimado, solo con el viaje en curso: un cambio de estado no dispara el trigger, así que nunca frena un viaje empezado. El cobro al completar puede pasar del estimado (espera), y la billetera puede quedar algo negativa. Un viaje programado retiene su estimado desde que se pide. El presupuesto mensual también cuenta los viajes en curso de la empresa.
   - **La empresa fija su presupuesto mensual y su tope por viaje** (0 = sin límite; los dos `>= 0`). Hasta 00625, `tg_corporate_accounts_protect_admin_fields` los revertía en silencio a todo JWT que no fuera admin de plataforma, y la pantalla decía "Guardado". `updateAccount` relee la fila: si no cambió, lanza `CORPORATE_LIMITS_NOT_SAVED` o `CORPORATE_NOT_ADMIN`.
   - **`current_month_spent` lo recalcula el cron `refresh-corporate-month-spend` (minuto 2 de cada hora)** con los `corporate_rides` del mes en La Habana. Antes solo sumaba: el cron que lo reiniciaba (00027) ya no existe. El trigger usa la suma real; esta columna la leen las pantallas y el chequeo previo del cliente.
   - Los rechazos del trigger tienen `MESSAGE` en español y `DETAIL` con un código `corporate_*`. `createRide` los convierte en `AppError` con ese mensaje; los motivos del chequeo previo del cliente (`ACCOUNT_NOT_APPROVED`…) se traducen en `_corporate-rides.ts`. Ensayo: `supabase/tests/00625/run.sh`.
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

#### Cuánto cuesta tiparlo: **113 errores, 0 bugs reales** (medido 2026-07-19)

Se midió la cascada de verdad (rama descartable, revertida): `supabase gen types` → `packages/api/src/database.types.ts` (9.720 líneas, 121 tablas) + `getSupabaseClient(): SupabaseClient<Database>` + `createClient<Database>`, y `npx tsc --noEmit -p <proyecto>/tsconfig.json` en los 5 proyectos.

| Proyecto | Errores | Baseline |
|---|---|---|
| `packages/api` | **103** | 0 |
| `apps/web` / `admin` / `client` | 3 c/u | 0 |
| `apps/driver` | 1 | 0 |
| **Total** | **113** | **0** |

- **Baseline 0 en los 5** → los 113 son atribuibles al cambio, sin ruido. (Ojo: `npx tsc -p packages/api/tsconfig.json` reporta además **28 errores preexistentes en `__tests__/`** que `pnpm check-types` no ve porque su tarea de turbo excluye los tests. No tienen relación con esto.)
- **Concentración: 65% en 4 archivos** — `poi` (21), `ride` (17), `driver` (16), `admin` (13) `.service.ts`. El resto se reparte de a 3-5.
- **Dos patrones mecánicos, sin decisiones de diseño:** (a) **ensanchamiento de enum** — el código pasa `string` donde la DB tiene un CHECK restringido (`document_type`, `role`, `status` de rides); (b) **`jsonb` → `Json`** — los RPC que devuelven jsonb se tipan `Json`, así que leer `.success`/`.error` exige cast (los 6 TS2339 son todos `driver.service.ts:438-451`).
- **Las apps casi no sufren** (10 de 113) porque 53 de sus usos del cliente son `.auth.*` — **el genérico NO toca ese módulo** — y hacen 131 llamadas `.from()`/`.rpc()` contra las 539 de `packages/api`: la capa de servicios absorbe el impacto. Sus 10 son nulabilidad (`string \| null` → `string`) y una interfaz local `SupabaseLike` que deja de matchear.
- **Cero bugs reales.** Se verificaron uno por uno los TS2339, TS2769 y los de nulabilidad: las guardas en runtime **están** (ej. `useDriverPosition.ts` guarda `rideId` en las líneas 47/91 y `driverIdCache` en 126/133); es narrowing de TS a través de closures async. **No esperes que tiparlo destape algo roto — el valor es preventivo**, cubrir permanentemente las 539 llamadas y jubilar este sweep manual.

**Cómo barrer (mecánico, alta precisión, contra prod viva):**

1. **RPC args vs firma real.** Extraé toda `.rpc('fn', {keys})` del repo (parser que captura el 1er string literal + las top-level keys del 2º arg objeto, depth-aware). Por cada `fn`, traé `pg_get_function_arguments(oid)` + `pronargs`/`pronargdefaults` de prod. Reglas PostgREST: (a) **arg extra** del cliente que NO está en los params → la función no resuelve (PGRST202); (b) **param requerido** (los primeros `pronargs − pronargdefaults`, los defaults van trailing en PG) que ningún call site provee → falla. El union de keys cross-call-site hace el check (a) conservador (caza cualquier site).
2. **Columnas write/filter vs schema.** Extraé `.from(t).insert/update/upsert({...})` (keys del payload) + columnas de `.eq/.neq/.gt/.gte/.lt/.lte/.like/.ilike/.is/.in/.order/.contains('col',…)`. **CRÍTICO: acotá el chain a UN solo statement** — desde el `.from(` hasta el **primer `;`** (terminador; los method-chains no tienen `;` top-level) o el siguiente `.from(`, lo que venga antes. Sin esto, columnas de statements adyacentes **sangran** (bleed) y generás decenas de falsos positivos. Después emití los pares `(tabla, columna, kind)` a un `WITH client_refs(...) AS (VALUES …) … LEFT JOIN information_schema.columns … WHERE column_name IS NULL AND tbl IN (tablas de prod)` (excluí buckets de storage: `avatars/receipts/driver-documents/delivery-photos/dispute-evidence/driver-contracts` — son `storage.from()`, no tablas).
3. **Verificá cada candidato con grep/Read del source** antes de afirmarlo (puede quedar 1 bleed residual; y distinguí método muerto vs. live path con `grep` de callers).
4. **Advisors de Supabase** (`get_advisors security|performance`) en la misma pasada: output gigante → parsealo con un script Node (`j.result.lints`, campos `name/level/metadata.{schema,name,type}/detail`). Ruido conocido a descartar: ERROR `spatial_ref_sys` (PostGIS, no se le puede poner RLS — pero su `rls_disabled_in_public` **no es del todo inofensivo**: ver § «`spatial_ref_sys`: el advisor es ruido, los GRANT de `anon` no»); `rls_enabled_no_policy` en tablas-candado intencionales (`otp_codes`, `rate_limits`, caches, counters — incl. `email_sends`, `google_directions_cache`, `google_directions_daily_counter`, `poi_sync_state`) + las `zzz_backup_*`; `anon/authenticated_security_definer_function_executable` mayormente intencional (share links por token, config/geo públicos, fns de trigger inocuas); `rls_policy_always_true` ×3 en `influencers_campaign` (tabla huérfana de marketing creada a mano en prod, **riesgo aceptado explícitamente por el usuario 2026-07-01 — NO tocar ni re-alertar**); performance (initplan/multi-permissive/FK sin índice) = higiene-a-escala, **no** bloqueante de lanzamiento (varios counts inflados tras un wipe).

Resultado del 1er sweep (PR #517): 99 RPCs + 489 refs de columna → **3 bugs reales** (param de RPC en método muerto, `sitemap` filtrando `blog_posts.status` inexistente → blog fuera del sitemap, toggle admin escribiendo `reviews.is_featured` inexistente → mig 00416). Resto del contrato **sano**.

**`.maybeSingle()` solo es seguro cuando el filtro pega en una clave única (verificado 2026-09-25).** Con dos o más filas, `postgrest-js` 2.99.1 **no lanza**: resuelve `{ data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }`. Un servicio que hace `if (error) return null` convierte así "varias filas" en "ninguna", y tipar el cliente con `<Database>` tampoco lo caza, porque es cardinalidad y no tipos. Caso latente (`fleet_members` tenía 0 filas en prod el 2026-09-25): `fleetService.getMembershipForDriver` filtraba `fleet_members` por `driver_id`, que no es único, así que un conductor en dos flotas habría visto el formulario de "crear flota" en vez de las suyas. Lo reemplazó `getMembershipsForDriver`, que lee la lista con un `.order()` determinista cerrado en `id` y decide en código. Dos reglas:
- Antes de escribir `.maybeSingle()` o `.single()`, confirmar contra prod (`pg_constraint`/`pg_index`) que el filtro sea PK o `UNIQUE`. Si no lo es, leer la lista.
- Para testear el caso, el doble del query builder tiene que devolver PGRST116 con 2+ filas, como el real (ver `packages/api/src/services/__tests__/fleet.test.ts`). `createMockQueryChain` devuelve lo que se le pase y esconde el bug.

**Del lado del dueño el fallo no era de cardinalidad: un trigger de protección anulaba la escritura del cliente (verificado 2026-09-25, reproducido en prod como conductor normal dentro de un bloque revertido).** Desde 00418/00434, `is_fleet_owner` solo lo escriben un admin o el service role: `tg_corporate_accounts_protect_insert` lo fuerza a `false` y `tg_corporate_accounts_protect_admin_fields` lo revierte en cada UPDATE de quien no es admin. El `update({ is_fleet_owner: true })` de `FleetRequestForm` devolvía 1 fila sin error y la cuenta seguía en `false`, así que `getFleetByOwner` (`.eq('is_fleet_owner', true)`) daba 0 filas **con una sola cuenta**: todo dueño volvía a ver el formulario, todavía lleno y sin aviso de éxito, y cada toque creaba otra cuenta con su flota. Ahora la flota se reconoce por su fila en `driver_fleets` (UNIQUE por cuenta; con varias gana aprobada > pendiente > suspendida > rechazada, después la más nueva), el formulario ya no intenta marcar la cuenta y un reintento reusa la cuenta que creó. `is_fleet_owner` sigue siendo decisión del admin porque cambia el despacho de los viajes corporativos (00336/00337): con el flag y al menos un miembro `active`, los viajes pagados con esa cuenta solo se ofrecen a conductores de la flota. Lo pone `approveAccount`, en el mismo UPDATE que aprueba, cuando la cuenta tiene fila en `driver_fleets` (el admin pasa el trigger), y nunca lo baja. Hasta entonces la flota se reconoce por esa fila: el admin la usa para el badge "Flota" y para mostrar `FleetReview`, y `getRequestStatus` (pasajero y web) deja fuera las cuentas con fila o con flag. Antes una solicitud de flota pendiente aparecía allí como solicitud de cliente corporativo en revisión. Regla: antes de depender de una columna que escribe el cliente, buscar en `pg_trigger` un `*_protect_*` que la revierta. Un UPDATE que devuelve 1 fila no prueba que el valor cambió.

**Una decisión del admin se liga a la fila que vio, no solo a su id (verificado 2026-09-27; carrera latente, `fleet_members` tenía 0 filas).** Mientras una invitación está `pending_review`, el dueño puede editarla: la RLS `fleet_members_owner_or_admin_update` lo permite y `tg_fleet_members_protect` recién congela la identidad una vez revisada (00600). `approveMember(id)` hacía `UPDATE … WHERE id = $1`: si el dueño cambiaba el teléfono entre que el admin abría `FleetReview` y tocaba "Aprobar", se aprobaba un teléfono que el admin nunca vio, y el auto-link vinculaba a quien fuera su dueño. Ahora `approveMember`/`rejectMember` reciben la fila mostrada y el `UPDATE` exige `status = 'pending_review'` más cada columna de `FLEET_MEMBER_REVIEWED_FIELDS` (`packages/types/src/fleet.ts`: la misma lista que ese trigger congela para el dueño una vez revisada, migración 00600; hay que mantenerlas iguales). Con la 00598, el trigger de aprobación vincula en ese mismo `UPDATE` a la cuenta que confirmó el teléfono por OTP, y ese teléfono es el que vio el admin porque el `WHERE` lo exige. Si no casa ninguna fila lanza `AppError FLEET_MEMBER_CHANGED` (409) y el panel recarga, marca la fila y nombra los campos que cambiaron. **Sin sesión lanza `AuthError` antes de escribir**: el admin copia su sesión de cookies al cliente de `@tricigo/api` en best-effort (`useAdminUser`), y sin ella el PATCH sale como `anon`, la RLS oculta la fila y las 0 filas se leerían como "cambió" (antes de este fix, como un falso "Conductor aprobado"). No hizo falta migración: en READ COMMITTED, si el `UPDATE` espera el lock de la fila, Postgres re-evalúa el `WHERE` sobre la versión que el dueño confirmó, así que una edición concurrente también deja 0 filas (`supabase/tests/fleet-review/run.sh`, casos C1–C3; en el orden inverso, C4, la 00600 conserva lo aprobado). Con la subida write-once de #1032 cada licencia nueva lleva nombre propio, así que cambiar el archivo también cambia `license_doc_path` y la comparación lo ve. Tres trampas:
- **Un NULL se filtra con `.is(col, null)`, nunca con `.eq(col, null)`**: postgrest-js manda `col=eq.null`, que compara contra el texto `'null'` y nunca casa una columna NULL.
- **El valor de un filtro `eq.` de nivel superior es literal** (PostgREST v13, `pSingleVal = many anyChar`): comas, comillas y paréntesis no se escapan (eso es solo dentro de `in.(…)` y `or=(…)`). postgrest-js codifica `+` como `%2B`; un `+` crudo llegaría como espacio.
- **Renderizar un componente del admin en jsdom sin infraestructura de tests** (el admin no tiene vitest): config descartable con `environment: 'jsdom'`, alias `@` → `apps/admin/src` y `oxc: { jsx: { runtime: 'automatic' } }`. Vite 8 usa oxc e ignora `esbuild.jsx`, y el tsconfig de Next trae `jsx: preserve`, que sin eso da `Unexpected JSX expression`.

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

### Flotas: una invitación revisada queda congelada para su dueño (00600, verificado 2026-09-25)

**Regla:** mientras una invitación de `fleet_members` está en `pending_review`, el dueño de la flota puede editarla. Cuando el admin ya la revisó (cualquier otro estado: `approved`, `pending_signup`, `rejected`, `active`, `inactive`), `tg_fleet_members_protect` le revierte al dueño lo que el admin revisó y la flota: `driver_phone`, `driver_name`, `driver_email`, `driver_license_number`, `driver_id_number`, `license_doc_path` y `fleet_id`. `rejected_reason` es texto del admin, así que el dueño no puede cambiarlo en ningún estado. Los admins, las llamadas sin JWT (service role, migraciones, GoTrue) y quienes escriben con `app.trusted_fleet_update` siguen como antes.

**Por qué:** todos los caminos que vinculan una invitación a una cuenta (el alta, la confirmación del teléfono de la 00598, el relink del admin, el backfill) leen una fila aprobada y sin vincular como "el admin aprobó a esta persona con este número". Antes de la 00600, el dueño podía cambiar el número después de la aprobación, y el alta de ese número nuevo entraba a la flota sin que nadie lo revisara (reproducido con los cuerpos vivos).

**Es silencioso, igual que con `status`:** el UPDATE del dueño responde OK y no cambia nada. Para cambiar a un conductor ya revisado, el dueño lo borra y lo invita de nuevo, y la fila nueva vuelve a revisión. Una pantalla futura de "editar conductor" tiene que ofrecer eso y no un UPDATE: con un UPDATE parecería que guarda y no guardaría. Hoy ese camino tampoco existe en la app: `fleetService` no tiene método para borrar un miembro, y `submitFleetRequest` ignora un teléfono que la flota ya tiene. Otro efecto: mover una fila revisada a una flota que no es del dueño antes daba error de RLS; ahora responde OK y no cambia nada.

**Lo que no cubre (pendiente):**
1. La ventana *durante* la revisión. **Cerrado por #1040 (2026-09-27):** `approveMember`/`rejectMember` solo escriben si la fila sigue en `pending_review` con cada valor que el admin vio; si no, lanzan `FLEET_MEMBER_CHANGED` y el panel recarga. Ver «Una decisión del admin se liga a la fila que vio», en la sección del sweep de contrato.
2. El archivo de la licencia. **Cerrado por #1032 (2026-09-27):** `storage-upload` solo deja subir a `fleet-docs/<corp>/<miembro>/…` a los gestores de la cuenta mientras el miembro está en `pending_review` (después responde `409 member_reviewed`), y bajo ese prefijo nunca reemplaza un archivo, para nadie. Ver el guardrail (4) de la sección de Storage.
3. Mover la flota entera a otra empresa del mismo dueño (`driver_fleets.corporate_account_id`). **Cerrado por 00609 (2026-10-06):** desde que el dueño crea la flota, `tg_driver_fleets_protect` (BEFORE UPDATE en `driver_fleets`) le revierte siempre `corporate_account_id` **y `id`**, así que una flota queda en la empresa para la que se creó. Congelar solo la empresa no alcanzaba: los conductores apuntan al `id` de la flota, y `fleet_members_fleet_id_fkey` es `ON UPDATE NO ACTION`, que acepta cambiar una clave referenciada si otra fila la vuelve a ocupar antes de que termine la sentencia. Un solo UPDATE, o un upsert en lote de PostgREST, le daba a la flota un `id` nuevo y dejaba que una flota vacía de otra empresa tomara el viejo, con los conductores revisados adentro (reproducido como el dueño, a través de RLS). Es silencioso, como el resto: el UPDATE responde OK. Mover la flota a la cuenta de otra persona, que antes daba error de RLS, ahora tampoco cambia nada. Los datos descriptivos (nombre, ciudad, tipos de vehículo, zonas, horario, cantidades y notas) siguen editables: solo se muestran en pantalla, como en FleetReview, y nada del servidor los lee: las dos funciones de la base que leen `driver_fleets` (`find_best_drivers` y `accept_ride_v2`) y la Edge Function `storage-upload` usan solo `id` y `corporate_account_id`. Ningún flujo de la app cambia la empresa ni el `id`: el upsert de `submitFleetRequest` busca la flota por `corporate_account_id` y no manda `id`. La 00609 se niega a reemplazar una función o un trigger con esos nombres si no los escribió ella (cuerpo md5 `8ba548f4…`). Ensayo: `supabase/tests/00609/run.sh`.

**Si hay que volver a tocar `tg_fleet_members_protect`:** partir del cuerpo vivo (`pg_get_functiondef`), no del texto de la 00435, que en prod no tiene los comentarios de git. Cuerpos conocidos: el previo a la 00600 (md5 `8b0d07af…`) y el de la 00600 (`2b65b4b8…`). La 00600 se niega a reemplazar un cuerpo que no conoce; conviene que la próxima migración haga lo mismo. Ensayo: `supabase/tests/00600/run.sh`. Si la 00598 está en el checkout, o si se pasa `M598=<ruta>`, también corre la prueba combinada en los dos órdenes.

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

### Flotas: cómo queda vinculada una invitación (00598, verificado 2026-09-25)

**Estado:** aplicada en prod el 2026-09-27, después de la 00599, la 00600 y la 00601, y ninguna de ellas redefine nada de la 00598. Los cuatro cuerpos de prod coinciden byte a byte con git. La prueba combinada de `supabase/tests/00600/run.sh` pasa en los dos órdenes.

**Regla:** una fila de `fleet_members` pasa a `status='active'` con `driver_id` solo hacia **la única cuenta activa que confirmó ese número por OTP** en `auth.users`. Se evalúa en los tres momentos que pueden volverlo cierto, siempre por teléfono normalizado:
1. **Confirmación:** `on_auth_user_phone_confirmed` (AFTER UPDATE ON **`auth.users`**). Actúa cuando un número queda recién confirmado para una cuenta: la primera confirmación, o un número nuevo en una cuenta que ya estaba confirmada. Reconfirmar el mismo número no cuenta. **Acá se vinculan en la práctica las cuentas nuevas:** el `createUser` de `verify-otp` hace el INSERT sin confirmar y confirma en un UPDATE aparte. `link-phone` y el heal de `verify-otp` llaman a `updateUserById`, que ejecuta `ConfirmPhone` **antes** que `SetPhone` (`supabase/auth`, `internal/api/admin.go`).
2. **Alta:** `auto_link_fleet_member_on_signup` (AFTER INSERT ON `public.users`, disparado por `handle_new_user`). Solo vincula si el número ya viene confirmado en el INSERT. Como GoTrue inserta antes de confirmar, este camino casi nunca vincula; está para que el alta no vincule un número sin confirmar.
3. **Aprobación:** `trg_fleet_members_set_driver_on_approval` (BEFORE INSERT OR UPDATE OF status). Actúa cuando la invitación **pasa a** `approved`/`pending_signup`. Una fila que ya estaba aprobada no se vuelve a mirar, así que editarla después no vincula a nadie por este camino. Además, desde la 00600 el dueño de la flota no puede cambiar una invitación que el admin ya revisó; un admin sí.
4. **Manual:** `relink_fleet_member_for_existing_driver` (solo admin; ninguna pantalla lo llama todavía, así que por ahora es solo SQL). Cubre lo que la regla deja afuera: un número nunca confirmado, una cuenta reactivada después de aprobar, o dos cuentas con el mismo número.

Los tres caminos automáticos solo tocan invitaciones `approved`/`pending_signup` que no tienen `driver_id`. Una invitación sin revisar, rechazada o que ya nombra a otra persona no se toca.

Los ensayos repiten las escrituras de GoTrue sentencia por sentencia (INSERT y después UPDATE; `ConfirmPhone` y después `SetPhone`). Un UPDATE único que haga las dos cosas deja sin probar el camino del que depende `link-phone`.

**`public.users.phone` no prueba nada.** No es único, y hasta la 00599 su dueño podía escribir ahí cualquier número por PostgREST, sin OTP (grant de columna, `users_update_own`, y `tg_users_protect_admin_fields` no lo cubría). Desde la 00599 solo puede poner el número que su cuenta confirmó, pero `handle_new_user` sigue copiando el de `auth.users` al crear la cuenta, esté confirmado o no. Por eso el trigger de confirmación vive en `auth.users` y no en `public.users`. En `public.users`, antes de la 00599, cualquiera podía cambiar su número a otro y volver a ponerlo, sin OTP, y dispararlo (ensayo C5).

La fuente confiable es `auth.users.phone` con `phone_confirmed_at`: tiene el índice único `users_phone_key` y va en E.164 **sin `+`** (`53XXXXXXXX`). Para "la cuenta de este número" usar `_user_id_by_verified_phone(text)`, que no es ejecutable por clientes porque es un oráculo número→cuenta.

**Esto depende de dos cosas:**
- **`phone_autoconfirm = false` en prod.** Se lee con `GET /auth/v1/settings` y la clave publicable (verificado el 2026-09-25 y de nuevo el 2026-09-27). Con autoconfirm, GoTrue confirmaría un `PUT /user {phone}` sin OTP. El `config.toml` local tiene `enable_confirmations = false`, pero es solo para desarrollo.
- **Un invariante de las escrituras con la API admin:** todo `phone_confirm` tiene que venir después de un OTP de ese número. Como `updateUserById` confirma antes de poner el número nuevo, una cuenta cuyo número actual nunca se confirmó quedaría con ese número dado por confirmado. Hoy ninguna cuenta con sesión tiene un número sin confirmar. Por lo mismo, `phone_confirmed_at` es por cuenta y no por número: si alguien cambia el teléfono desde el Dashboard sin `phone_confirm`, el número nuevo hereda la fecha de confirmación del anterior.

**Todo trigger en `auth.users` corre dentro de la transacción de GoTrue:** un error ahí rompe el login o la confirmación.
- **Errores contenidos:** el cuerpo va envuelto en `EXCEPTION WHEN OTHERS`, igual que el trigger de alta (la lección de 00595). Un vínculo que falla deja un WARNING y una fila en `rpc_attempt_log` (`outcome = 'link_failed'`); ahí es donde hay que buscar una invitación que quedó `approved` sin razón.
- **Sin esperas largas:** `SET lock_timeout TO '2s'` en la definición de la función convierte una espera de lock en un error que ese bloque atrapa. `WHEN OTHERS` no atrapa `query_canceled`, así que sin ese límite una espera terminaría cortada por `statement_timeout`, y ese error sí rompe el login.
- **Sin columnas en la definición:** el trigger no tiene lista de columnas ni `WHEN`, porque eso le impediría a GoTrue hacer `ALTER COLUMN TYPE` sobre esas columnas. La función filtra adentro y vuelve enseguida en cualquier otro UPDATE.
- **Cómo apagarlo:** `postgres` no es dueño de `auth.users`, así que no puede hacer `DROP` ni `DISABLE` de un trigger ahí. Para apagarlo, reemplazar el cuerpo de la función por `RETURN NEW`.
- **Cómo crearlo:** crear el trigger bloquea las escrituras a `auth.users` hasta el commit. Usar `SET lock_timeout` (con `RESET` al final) y dejarlo para el final de la migración.

Los números fuera de Cuba quedan en GoTrue sin `+` y `_normalize_cuban_phone` no los toca, así que las funciones les agregan el `+` antes de buscarlos.

**Orden de triggers:** los del mismo evento y momento disparan en orden de nombre (strcmp), así que el de aprobación corre después de `trg_fleet_members_protect` (`s` > `p`). Es defensa en profundidad, no algo de lo que dependa la corrección: el protect revierte todo lo que escribe el de aprobación, sin importar cuál corra primero.

**Trampa al ensayar:** `auto_link_fleet_member_on_signup` deja `app.trusted_fleet_update = '1'` hasta el final de su transacción. En prod no importa, porque esa transacción es la de GoTrue. Pero un ensayo que siembra usuarios y prueba al dueño en la misma transacción ve que el protect deja pasar todo, y el test del dueño falla por culpa del arnés. Hay que sembrar en una transacción aparte (`tcase` en `supabase/tests/00598/run.sh`).

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

**Mergear una cadena larga a master (verificado 2026-08-22 con 8 PRs, `#966`→`#973`).** Un PR apilado NO apunta a master: su base es la rama de arriba, así que mergearlo tal cual lo deja dentro de esa rama y **nunca llega a master** — chequear `gh pr view <n> --json baseRefName` antes de prometer que "se mergeó". El bucle por eslabón es: `gh pr edit <n> --base master` → `rebase --onto origin/master <tip-viejo-de-su-base>` → `push --force-with-lease` → esperar CI → merge. Tres cosas que cuestan si se aprenden a los golpes:

- **`git diff master..rama` (DOS puntos) miente sobre lo que un merge haría.** Mide contenido total distinto, así que lista como "borrados" los archivos que master ganó DESPUÉS del punto de bifurcación — en esta sesión pareció que la cadena revertía dos migraciones ya aplicadas en prod, y era falso. El merge es three-way: no toca lo que solo cambió en master. Para ver el aporte real usar **TRES puntos** (`git diff --stat origin/master...rama`), que además tiene que coincidir con el `+X/-Y` que GitHub reporta para ese PR — si no coincide, el rebase se comió o duplicó algo.
- **El CI no corre al cambiar la base de un PR.** `ci.yml` escucha `pull_request: branches:[master]` y `push: branches:[master]`, y `edit --base` no genera `synchronize` → el PR queda MERGEABLE **sin un solo check**. Ordenar `edit --base master` ANTES del `push --force-with-lease` para que el push lo dispare; si ya se pusheó antes, `gh pr close <n> && gh pr reopen <n>` lo dispara sin reescribir nada.
- **Un conflicto puede ser semántico y no textual.** Acá dos fixes independientes tocaban `packNeedsRefresh`: master (#974) le sumó `estimatePackTileCount` —que el hook del **driver** consume— y la rama le agregó un parámetro. Conservar ambos exige **actualizar callers que no están en ninguno de los dos lados**. Y el `pnpm check-types` del proyecto que estás mirando NO lo caza: correr el typecheck y los tests **completos** sobre el resultado ya fusionado, no sobre un lado.

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

### Publicar una versión en las tiendas: qué funcionó y qué no (release 1.7.3, verificado 2026-09-25/27)

**Reparto que resultó más rápido.** Claude hace lo de terminal: verificar los builds, armar iOS y subirlo a App Store Connect con `eas submit`. El usuario hace lo de las consolas web: en Play Console subir el `.aab`, cargar las novedades y enviar a revisión; en App Store Connect crear la versión, elegir el build, cargar las novedades y enviar a revisión. Manejar Play Console con la extensión de Chrome costó más de lo que ahorró (ver abajo). Para que todo salga en un comando falta la API de Play (último punto).

**1. Paridad antes de armar iOS.** Si Android ya está armado, iOS tiene que salir del mismo código de app:
```bash
cd apps/client && npx eas-cli@latest build:view <build-id-android> --json   # gitCommitHash, appVersion, appBuildVersion
git diff --stat <gitCommitHash> HEAD -- apps/client apps/driver packages pnpm-lock.yaml package.json patches
```
Si el diff sale vacío, iOS se puede armar desde `HEAD`.

**1b. Justo antes de enviar a revisión, volver a mirar master.** Los `.aab` de 1.7.3 se armaron el 23/09 desde `c08b68c3` y en los días siguientes entraron **14 merges que tocan las apps** (flotas, cuentas de empresa, colores de tarjetas). La primera tanda (Android vc37/vc47, iOS 41/45) se descartó y se rearmaron las cuatro desde `c48b7604`. Chequeo: `git log --oneline <gitCommitHash>..origin/master -- apps/client apps/driver packages`. Si hay merges que importan:
- **El número de versión se reusa** mientras nada de esa versión esté en revisión: en ASC no había versión 1.7.3 creada y en Play estaba solo el borrador, al que se le cambia el app bundle.
- **Confirmar en prod las migraciones de las que depende el código nuevo** antes de compilar: grep de `rpc('…')` y `from('…')` en el diff de `packages/api/src/services` y buscar cada objeto en `pg_proc` / `information_schema.columns`. En 1.7.3 eran 00598–00602, todas aplicadas. Compararlo contra un marcador del cuerpo de la migración, no contra un nombre adivinado (así salió un falso negativo con 00599).
- **Armar desde el commit exacto sin reinstalar:** si `git diff --quiet <viejo> origin/master -- pnpm-lock.yaml` da igual, `git checkout --detach origin/master`, lanzar los cuatro `eas build … --no-wait` uno tras otro y volver a la rama recién cuando terminó el último (cada uno sube el árbol de trabajo en ese momento). Tardaron unos 15 min en EAS.

**2. `pnpm install --frozen-lockfile` antes de cualquier comando `eas`.** Sin `node_modules` en el worktree falla hasta `eas build:view`, con `expo config --json exited with non-zero code: 1`: Node busca hacia arriba y usa el `expo` del checkout principal. En esta PC tardó 10 min.

**3. Armar iOS en local:** `cd apps/<app> && npx eas-cli@latest build -p ios --profile production --non-interactive --no-wait`. Usa las credenciales guardadas en EAS (el certificado y los perfiles vencen el 24-jun-2027) y no hace falta GitHub Actions. El número de build lo sube EAS solo. La 1.7.3 final quedó: iOS **42** pasajero y **46** conductor; Android vc**38** y vc**48**. Los 41 y 45 de la primera tanda quedaron sin usar en ASC: al elegir el build, fijarse en el número.

**4. Subir iOS a App Store Connect.** Agregar en local, **sin commitear**, en `apps/<app>/eas.json` → `submit.production.ios`: `"ascApiKeyPath": "C:/Users/Eduardo/Downloads/AuthKey_4842VLU5R9.p8"`, `"ascApiKeyIssuerId": "f19c9b1b-da82-4a06-9d67-12d8ed947440"` y `"ascApiKeyId": "4842VLU5R9"`. Después correr `npx eas-cli@latest submit -p ios --profile production --id <buildId> --non-interactive` y deshacer el cambio con `git checkout -- apps/client/eas.json apps/driver/eas.json`.

**5. Bajar los `.aab` para que el usuario los suba.** Tamaño real con `curl -sIL <url> | grep -i content-length`; descarga con `curl -L --fail --retry 5 --retry-all-errors -o <archivo> <url>`; verificación con el tamaño exacto y `zipfile.ZipFile(p).testzip()` en Python. Un `.aab` truncado da en Play el error genérico "No se ha podido subir". Trampa de bash: en `mkdir X && cd X && (curl 1) & (curl 2) & wait`, el `&` corta la cadena y el segundo curl corre en la carpeta anterior.

**Lo que no funcionó (no repetir):**
- **`eas submit -p android`.** `eas.json` pide `./google-service-account.json`, que no existe en ningún checkout, y en expo.dev (Credentials → Android) solo está la clave FCM V1, no la de "Play Store Submissions".
- **Subir el `.aab` con la extensión de Chrome.** `file_upload` acepta como mucho 10 MB y cada `.aab` pesa unos 126 MB. Lo tiene que arrastrar el usuario.
- **Manejar Play Console con la extensión.** El grupo de pestañas de Claude vive en una ventana de Chrome aparte. Si esa ventana no se ve (minimizada, tapada, PC bloqueada), `document.visibilityState` es `hidden` y la SPA de Play Console deja de responder: los clics, reales o por JavaScript, no hacen nada, la lista de versiones no se dibuja y las capturas fallan con "Script injection timed out". Abrir una ventana nueva no lo arregla. Antes de empezar, mirar `document.visibilityState` con `javascript_tool`; si da `hidden`, pasarle esa parte al usuario en vez de insistir.
- **Cuenta.** Play Console de TriciGo está en `/console/u/1/`; en `u/0` aparece "Agencia Señores", de otra cuenta de Google. IDs: desarrollador `8713585500555905623`, pasajero `4974704460419492250`, conductor `4974821218433551452`.

**Datos de las fichas:**
- Play: las novedades van solo en **es-419** (idioma predeterminado), hasta 500 caracteres. La 1.7.2 salió al 100 % en Producción, con la publicación gestionada **desactivada**: se publica sola cuando Google la aprueba.
- App Store Connect: las dos apps tienen una sola localización, **es-ES**, y `releaseType` = `AFTER_APPROVAL` (también se publican solas). Como `app.json` trae `ITSAppUsesNonExemptEncryption: false`, al elegir el build no pregunta por cifrado.
- Con las dos tiendas publicadas, subir `client_latest_version` y `driver_latest_version` en el admin (Settings → Platform Config) para que salga el aviso de actualización.

**Para que sea un comando la próxima vez:**
- **App Store Connect ya se puede, y así se envió la 1.7.3 (2026-09-28, unos 2 min por app).** La misma `.p8` firma la API. Pasos que funcionaron:
  1. `POST /v1/appStoreVersions` con `platform`, `versionString`, `releaseType: AFTER_APPROVAL` y el build en `relationships.build` (una sola llamada). La versión nueva hereda de la anterior la descripción, los datos de contacto y la cuenta demo del revisor.
  2. `PATCH` de `whatsNew` en su `appStoreVersionLocalizations` (única localización: es-ES), con el cuerpo leído de un archivo JSON UTF-8, y leerlo de vuelta para comparar.
  3. Antes de enviar: `GET /v1/reviewSubmissions?filter[app]=…&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,UNRESOLVED_ISSUES,…` vacío, y la `ageRatingDeclaration` del appInfo nuevo sin campos obligatorios en `null`.
  4. `POST /v1/reviewSubmissions` → `POST /v1/reviewSubmissionItems` → `PATCH {submitted:true}`, de a una app y cortando al primer error. Queda `WAITING_FOR_REVIEW`.

  El JWT es ES256 con `node:crypto` (`dsaEncoding: 'ieee-p1363'`) y `iat` 60 s atrasado, o da 401. **Trampa de Git Bash:** un argumento que empieza con `/v1/…` sin `?` se convierte en ruta de Windows y el host queda `api.appstoreconnect.apple.comc` (`ENOTFOUND`). Exportar `MSYS_NO_PATHCONV=1` antes de llamar. Si un envío falla a medias, leer las trampas de la memoria `project_apple_ios_launch`: la lista de envíos miente, y un envío huérfano solo se borra desde la web.
- **Para Play falta una service account.** Crearla en Google Cloud, invitarla en Play Console (Usuarios y permisos) con permiso para gestionar versiones de las dos apps y guardar su JSON como `apps/<app>/google-service-account.json` (ya está en `.gitignore`). Con eso, `eas submit -p android --id <buildId>` sube el `.aab` sin descargarlo. Ojo: por defecto va al track `internal` con `releaseStatus: completed`; para producción sin enviar a revisión, poner `"track": "production", "releaseStatus": "draft"` en el perfil de submit. `eas submit` no carga notas de versión: eso se hace con la API de Play (`edits.tracks.update` con `releaseNotes`).

### Qué versión corre cada instalación: `app_opens` (00622, 2026-10-06)

`user_known_devices.app_version` **no** dice qué versión corre la gente: la escribe `register-login-device` solo al iniciar sesión, y casi nadie vuelve a entrar después de actualizar. El 2026-10-06, los 14 pasajeros activos del último mes figuraban con versiones de 1.0.5 a 1.7.3, cada uno con la de su último login.

Desde 00622, las dos apps llaman a `report_app_open` al arrancar con sesión, después de un login y al volver al frente si pasaron 6 horas desde el último aviso (`useReportAppOpen`, un archivo por app). Se guarda una fila por cuenta, app (`client` o `driver`) e instalación en `public.app_opens`, con la versión y la plataforma de la última apertura.

- **No se puede reusar `register-login-device` para esto.** Con un dispositivo que no conoce, lo registra y, si la cuenta ya tenía otro, manda el correo de "inicio de sesión nuevo". Llamarla al abrir mandaría ese correo sin ningún login, y una apertura registrada antes que el login se comería el aviso de un login real. `report_app_open` no manda correos ni toca `user_known_devices`.
- **Tabla-candado:** RLS sin políticas, `REVOKE ALL` a `anon` y `authenticated`, GRANT solo a `service_role`. Se lee con SQL o la clave de servicio.
- **Tope de 20 instalaciones por cuenta y app:** cada reinstalación es un id nuevo. Pasado el tope responde `capped` y no registra nada.
- **Los builds anteriores a este no avisan.** Una cuenta activa sin fila reciente en `app_opens` está en un build viejo o usa la web, que no avisa.

```sql
-- Qué versiones abrieron la app en las últimas dos semanas
SELECT app, app_version, count(*) FROM public.app_opens
WHERE last_opened_at > now() - interval '14 days' GROUP BY 1, 2 ORDER BY 1, 2;
```

La revisión semanal que decide cuándo borrar `split_delete` (00620) usa esta tabla. Ensayo: `supabase/tests/00622/run.sh` (RED: 11 fallos; GREEN 24/24, en los dos modos de permisos: el de prod hasta el 30/10 y el de después).

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

### Storage y los JWT ES256: las subidas de cliente van por EF service-role (verificado 2026-06-05; Storage ya los valida desde octubre)

> **Actualización 2026-10-07: Storage ya acepta las sesiones de los usuarios.** En 24 h hubo 28 `POST /storage/v1/object/sign/driver-documents` con JWT ES256 de rol `authenticated`, todos con 200 (`edge_logs`, filtro `request.path like '/storage/v1/object/%'`). Firmar un enlace de ese bucket privado pasa por su RLS de SELECT, así que Storage está leyendo `auth.uid()` del token. Lo de abajo describe el problema de junio y por qué existen las EF; **las EF se quedan igual** (ver "Revertir a la subida directa").

**Síntoma:** cualquier subida autenticada cliente→Supabase Storage falla con `new row violates row-level security policy` (la RLS de INSERT rol `authenticated`). Afecta foto de entrega, **documentos de onboarding del conductor** (bloqueante para lanzar), selfie y avatar. Empezó ~2026-04/05.

**Causa raíz (CONFIRMADA por construcción, no asumida):** el proyecto migró a **JWT signing keys asimétricas ES256** (`/auth/v1/.well-known/jwks.json` sirve una clave ES256; el legacy HS256 anon está disabled; el anon key del `.env` es el publishable `sb_publishable_...`). gotrue firma los access tokens con ES256. **PostgREST (Data API), Edge Functions y Realtime validan ese token; el servicio de Storage NO** → trata al usuario como `anon` (auth.uid()=NULL) → la RLS de INSERT falla. **NO es el cliente/SDK:** en `@supabase/supabase-js` 2.99.1, `DEFAULT_HEADERS` no trae Authorization y `fetchWithAuth` inyecta `apikey: <publishable>` + `Authorization: Bearer <session.access_token ES256>` en cada request; `this.rest` y `this.storage` comparten el **mismo** `this.fetch` → mandan auth idéntica. Storage recibe el mismo token válido que PostgREST y lo rechaza. La doc oficial de Supabase dice que Storage *debería* verificar asimétrico → es lag/config de storage-api del proyecto.

**Workaround vigente (NO romper):** las subidas autenticadas van por **Edge Functions service-role** que autentican con `auth.getUser` + validan ownership por bucket + suben con service-role (bypassan Storage RLS):
- `supabase/functions/storage-upload/index.ts` (PR #432) — **genérica**: buckets `avatars` / `driver-documents` (docs + selfie) / `dispute-evidence`. Allowlist estricto + authz que replica la RLS WITH CHECK de cada bucket. `verify_jwt=false` (auth propia adentro). MIME whitelist + cap de tamaño + rechazo de path traversal.
- `supabase/functions/upload-delivery-photo/index.ts` (PR #430) — foto de entrega.
- `packages/api/src/services/_storage-upload.ts` (`uploadFileFromUri`) rutea TODO por `storage-upload` → arregla docs/selfie/avatar móvil + dispute en un solo chokepoint. El avatar **web** (`apps/web/src/app/profile/edit/page.tsx`) invoca la EF directo. Las escrituras a DB post-subida siguen client-side por PostgREST (funcionan). Bucket `dispute-evidence` creado en mig `00385` (público, como delivery-photos).

**Revertir a la subida directa: no hacerlo, aunque Storage ya acepte las sesiones.** Las EF son más estrictas que las políticas de Storage, que con las sesiones aceptadas volvieron a valer para cualquier cliente:
- `delivery_photos_insert` / `_update` dejan al conductor asignado escribir y **reemplazar** la foto de entrega de su viaje en cualquier momento, también después de entregar (no miran el estado del viaje).
- `driver_documents_insert` / `_update` dejan al conductor reemplazar sus documentos en sitio (el problema de `driver-docs/` de abajo, ahora también sin pasar por la EF).
- `fleet-docs/` no tiene ninguna política: solo la EF sabe escribir ahí con escritura única (guardrail 4).
- Las EF además limitan MIME y tamaño.
Medido el 2026-10-07: nadie usa la subida directa (todas las apps pasan por las EF desde mayo) y `delivery-photos` tiene 6 archivos, el último de junio. Si alguna vez se cierra este hueco, es con políticas de Storage más estrictas (por ejemplo, foto de entrega solo con el viaje en curso y sin UPDATE), no quitando las EF.

**GUARDRAILS:** (1) **NO rotar/revocar JWT signing keys** como "fix" — rompe todas las sesiones/servicios; es palanca de soporte. (2) Al agregar una subida **nueva**, rutearla por la EF `storage-upload` (sumar el bucket + su authz al allowlist), NUNCA por `supabase.storage.upload()` directo: hasta octubre fallaba como anon, y hoy funcionaría pero solo con las políticas de Storage, sin los controles de la EF. (3) Diagnóstico: `curl …/auth/v1/.well-known/jwks.json` → clave `ES256` = asimétrico; `SELECT bucket_id, COUNT(*) FILTER (WHERE owner IS NOT NULL) FROM storage.objects GROUP BY 1` → desde junio todo sale sin owner, porque las EF suben con service role (las 35 con owner son de marzo a mayo, antes de las EF; medido 2026-10-07). Un objeto nuevo con owner es una subida directa que no pasó por la EF. Para saber si Storage valida las sesiones, mirar en `edge_logs` el rol y el `algorithm` del JWT de los `/storage/v1/object/sign/…` y su status. (4) **`fleet-docs/` es de escritura única y se cierra con la revisión** (2026-09-27, complemento de 00600): la EF solo deja subir a `fleet-docs/{cuenta}/{miembro}/…` a los gestores de la cuenta (creador o corp admin activo) mientras el miembro está en `pending_review`; después responde `409 member_reviewed` (el admin de plataforma puede siempre). Bajo ese prefijo ignora el `upsert` que manda el cliente y nunca reemplaza un archivo, para nadie, así que el archivo detrás de un `license_doc_path` revisado no puede cambiar. `uploadMemberLicense` sube con nombre `{Date.now()}-{nombre}` y `upsert=false`. Las reglas viven en `supabase/functions/_shared/fleet-docs.ts`, con tests. **Si algún día se revierte `storage-upload` a la subida directa** (desaconsejado, ver arriba), `fleet-docs/` necesita antes sus propias políticas de Storage: hoy ninguna deja escribir ahí, y sin un INSERT limitado a `pending_review` y sin ninguna de UPDATE se pierde la escritura única.

**`driver-docs/` todavía reemplaza en sitio (medido 2026-09-27, sin arreglar).** El conductor sube con el nombre original del archivo (el de la galería o del PDF) y `upsert: true`, así que re-subir el mismo archivo pisa el objeto al que apunta una fila de `driver_documents` ya revisada. En prod: 53 rutas compartidas por 2+ filas y **10 documentos aprobados de 4 conductores cuyo archivo se reemplazó después de la revisión** (entre el 8 y el 12 de julio). No se forzó la escritura única ahí porque las apps instaladas re-suben con el mismo nombre y dependen del `upsert` (una re-subida daría 409 hasta el próximo APK): hace falta primero nombres únicos en las apps, después el APK, y recién ahí la regla en la EF. Para listarlos:
```sql
SELECT v.id, v.driver_id, v.document_type, v.storage_path, v.verified_at, max(l.uploaded_at) AS replaced_at
FROM driver_documents v
JOIN driver_documents l ON l.storage_path = v.storage_path AND l.id <> v.id
 AND l.uploaded_at > coalesce(v.verified_at, v.uploaded_at)
WHERE v.is_verified
GROUP BY v.id, v.driver_id, v.document_type, v.storage_path, v.verified_at;
```

---

### Soporte asistido (00628): qué cambió en funciones vivas y cómo se diagnostica (aplicada 2026-10-07)

Cuando el despacho no encuentra conductor, soporte ayuda desde el panel: banner con sonido en todo el admin, push a los admins y un resumen por correo cuando un viaje lleva más de 60 s buscando o el pasajero toca "Pedir ayuda"; página `/rides/[id]/assist` para mandar una oferta, asignar directo o cambiar el tipo de vehículo. Diseño: `docs/superpowers/specs/2026-10-07-support-assisted-matching-design.md`. Aplicada por MCP (`20261007210630`) y verificada función por función contra el ensayo local (22/22 md5 iguales).

- **Parcheó tres funciones vivas. Un `CREATE OR REPLACE` futuro de cualquiera tiene que partir del cuerpo vivo y conservar el cambio**, o se pierde en silencio (la clase de 00124):
  - `tg_rides_create_estimate_snapshot`: su cuerpo pasó a `_write_ride_estimate_snapshot(p_ride, p_replace)`, que también usa el cambio de tipo. md5 tras 00628: `cf0cdf98…/324`.
  - `tg_rides_validate_promo_discount`: el bypass de super_admin no salta el recálculo mientras la transacción tenga `app.force_discount_recompute = '1'` (solo lo pone `_apply_ride_service_change`). Sin eso, un cambio de tipo aplicado por un super_admin cobraría el descuento viejo. md5: `ae9f33f1…/7877`.
  - `cleanup_orphan_searching_rides`: no cancela por abandono un viaje cuyo pasajero pidió ayuda en los últimos `support_help_keepalive_s` (1800 s), porque "Pedir ayuda" lo manda a WhatsApp y la app deja de refrescar la búsqueda. md5: `51caf5f3…/992`.
- **Ajustes** (`platform_config`, con texto de ayuda en el admin): `support_alert_after_s` (60), `support_offer_ttl_s` (120), `support_proposal_ttl_s` (180), `support_help_keepalive_s` (1800), `support_alert_enabled` (apaga solo el push de espera; un pedido de ayuda siempre avisa) y `support_alert_email`, que arrancó como copia de `business_notification_email` (5 direcciones). Vaciarlo apaga el correo.
- **Diagnóstico de avisos.** Todo sale por `cron_http_post`: `support-help-alert`, `support-wait-alert` (push a admins), `support-alert-email` (resumen) y `support-assign-push` (push al conductor asignado). Un fallo antes del HTTP deja `rpc_attempt_log` con `alert_failed` (o `push_failed` en la asignación); un pasajero con 3 avisos de ayuda en la última hora queda `help_alert_capped`.
  ```sql
  SELECT c.jobname, r.status_code, c.called_at FROM cron_http_calls c
  LEFT JOIN net._http_response r ON r.id = c.request_id
  WHERE c.jobname LIKE 'support-%' ORDER BY c.called_at DESC LIMIT 20;
  ```
- **Una prueba con cuenta de prueba llega a conductores reales**: `dispatch_ride` y `find_best_drivers` no miran `is_test`. El push de espera sí saltea cuentas de prueba, y el banner las muestra marcadas "Prueba".
- **`dispatch_ride` lo llama `_apply_ride_service_change` (SECURITY DEFINER, dueño `postgres`)**, así que 00630, que les quitó EXECUTE a los clientes, no lo afecta. Medido en prod con las dos aplicadas: `authenticated` ya no puede ejecutar `dispatch_ride`, su dueño sí, y las 6 funciones que lo llaman (`_apply_ride_service_change` incluida) son SECURITY DEFINER con dueño `postgres`.
- **Verificar que una migración larga llegó intacta por MCP**: en el ensayo en prod se agregó al bloque final `md5(substring(current_query() FROM <inicio> FOR <largo>))`, que mide el texto que recibió el servidor, y se comparó con el md5 del archivo. Coincidió; si no coincide, algo se transcribió mal antes de que corra nada.

---

### Canales de Realtime: cuáles son privados y cómo agregar uno (00626, verificado 2026-10-07)

Un canal **público** de Realtime no pasa por ninguna regla: cualquiera con sesión que sepa el nombre puede unirse, leer los broadcasts y la presencia, y mandar mensajes. Las reglas de `realtime.messages` solo se aplican a los canales **privados** (`{ config: { private: true } }`). Un canal privado y uno público con el mismo nombre no se cruzan: lo que se manda en uno nunca llega al otro.

- **Privados hoy:** `rider-location:{rideId}` (00433), `ride-search:{rideId}` (00440) y `typing:{rideId}` (00626), los tres solo para las partes del viaje (`is_ride_party` / `can_access_ride_search`). Los demás canales de las apps son `postgres_changes`, que ya aplican la RLS de su tabla.
- **"Allow public access" sigue activado** en los ajustes de Realtime: las versiones instaladas usan canales públicos. Un público con el mismo nombre que un privado no ve el tráfico del privado, así que no hace falta apagarlo para que un canal privado sea privado.
- **Para agregar un canal privado:** (1) migración con una política de SELECT y otra de INSERT sobre `realtime.messages` para ese tema (`realtime.topic()` con regex anclada y el id validado antes del cast), con `extension IN ('broadcast','presence')` según lo que use; (2) en la app, `private: true` y `supabase.realtime.setAuth()` **antes** de `subscribe()`, y no suscribir si el canal ya se cerró (`getChannels()` ya no lo tiene; ver `chatService.subscribeToTyping`); (3) aplicar la migración **antes** del deploy de la web: un canal privado sin política se rechaza. `postgres` puede crear esas políticas aunque no sea dueño de la tabla, por `supautils.policy_grants`.
- **Mientras convivan versiones**, una app vieja (canal público) y una nueva (privado) no se ven entre sí en ese canal. Para "escribiendo…" se aceptó: es un indicador accesorio.
- **Ensayo:** `supabase/tests/00626/run.sh` reproduce la autorización de Realtime (tema en `realtime.topic`, rol `authenticated`, SELECT o INSERT sobre `realtime.messages`, todo revertido). RED: 7 fallos; GREEN: 25/25, con 4 pruebas negativas.
- **No suscribirse a `driver_profiles` desde el pasajero.** Su RLS deja ver solo la fila propia, así que un `postgres_changes` sobre esa tabla nunca le entrega la posición de otro conductor y solo le suma trabajo a la base en cada latido. Hasta octubre de 2026 el mapa de vehículos cercanos del pasajero (app y web) lo hacía. **No se arregla abriendo esa RLS**: expondría el perfil completo de todos los conductores. La posición sale de `find_nearby_vehicles`, por consulta.

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


### Panel admin: middleware, dinero y notificaciones (auditoría 2026-10-07, 00627)

**El middleware vive en `apps/admin/src/middleware.ts`.** Con el app router en `src/app`, Next.js solo carga el middleware de `src/` (`node_modules/next/dist/build/index.js`: `rootDir = join(appDir, '..')`). En la raíz de `apps/admin` nunca se compiló, así que hasta octubre de 2026 cualquier usuario con sesión podía abrir todas las pantallas del panel. Los datos seguían protegidos por la RLS y las RPC de admin. La prueba de que se carga es la línea `ƒ Middleware` en la salida de `next build`.
- **Las redirecciones del middleware se arman con `X-Forwarded-Host`**, como `/auth/callback`. Detrás de nginx, Next ve la URL interna y además convierte `127.0.0.1` en `localhost`, así que `new URL('/login', request.url)` mandaría al navegador a `https://localhost:3002`. Un `Location` relativo tampoco sirve, porque Next lo parsea sin base y lanza un error.
- **Para probarlo en local:** `next build` con `NEXT_PUBLIC_SUPABASE_*`, copiar `.next/static` y `public` dentro de `.next/standalone/apps/admin/` y arrancar `server.js` con `PORT` y `HOSTNAME`. Next se renombra a `next-server (v15.x)`: un servidor viejo no aparece buscando `server.js` en los procesos y sigue ocupando el puerto. El nuevo muere con `EADDRINUSE` y las pruebas le pegan al viejo, con el código anterior. Mirar el log del servidor nuevo antes de creerle a una respuesta. En el sandbox no hay `ps` ni `ss`, y `pkill -f` mata la propia shell.

**El dinero se mueve solo por RPCs (00627).** Siete tablas (`wallet_accounts`, `ledger_entries`, `ledger_transactions`, `wallet_transfers`, `payment_intents`, `wallet_receipts`, `wallet_recharge_requests`) tenían políticas que dejaban a cualquier admin escribir filas por PostgREST. Medido en prod con un admin real, en un bloque revertido: +100.000 CUP en su propia billetera con un UPDATE, y un crédito en el ledger que además subía el ancla USD. 00627 las borró, dejó la lectura y quitó a `anon`/`authenticated` los permisos de tabla que ya no usa ninguna política (TRUNCATE incluido: no pasa por RLS).
- **Una operación de dinero nueva del panel es una RPC SECURITY DEFINER** que ata `auth.uid() = p_admin_user_id`, chequea el rol y deja rastro en `admin_actions`, como `admin_adjust_wallet` (que además rechaza la billetera propia). Nunca una política de escritura para admins.
- Lo único que el panel escribe directo es el rechazo de una recarga: `wrr_admin_reject` deja pasar solo `pending → rejected` con `processed_by` = quien rechaza. `approve_wallet_recharge` rechaza una solicitud del propio admin.
- Ensayo: `supabase/tests/00627/run.sh` (RED: 16 fallos; GREEN 36/36, con 4 pruebas negativas).
- **Estado: aplicada completa en prod el 2026-10-07, en dos partes.** La parte 1 (políticas nuevas, REVOKE y parche de `approve_wallet_recharge`) entró por MCP como `00627_admin_money_through_rpcs_part1_additive`. La parte 2, los 7 `DROP POLICY`, se cortó por MCP esperando la aprobación en la app, y el dueño la pegó en el SQL Editor; por eso no figura en `schema_migrations`. Verificado por objeto después: las aserciones del final del archivo dan todas bien (ninguna política de escritura fuera de `pi_own_insert`, `wrr_own_insert` y `wrr_admin_reject`; `anon` y `authenticated` sin permisos de escritura en las cinco tablas de dinero; las dos lecturas de admin; `approve_wallet_recharge` con md5 `754d9bf4…`).

**Las notificaciones del panel a un usuario salen por `send-push`.** `notificationService.sendToUser` llamaba a Expo desde el navegador, que lo bloquea: las 1.106 que el panel registró (cuenta aprobada, documento verificado, rechazos) tenían `sent_count = 0`, incluidas 206 a conductores con el push registrado. Ahora invoca `send-push` sin categoría, porque esa función pisa `data.type` con la categoría y las apps navegan según `data.type`. `send-push` exige admin o la clave de servicio: desde las apps (`respondToDispute`) responde 403 y no se manda nada, igual que antes.
- `cms_content.updated_by`, `notification_log.sent_by` y `admin_actions.admin_id` son uuid. El panel pasaba el texto `'admin'`: guardar en el CMS fallaba con 22P02 y el historial de push nunca se escribía. `updateContent` y `sendAdminPush` toman ahora al admin de la sesión.

**"Bloquear usuario" bloquea de verdad desde 00629.** Antes el panel hacía un UPDATE de `users.is_active` que la RLS no dejaba pasar (0 filas, y la pantalla decía "bloqueado"), y aunque hubiera pasado no bloqueaba nada: `is_active` solo esconde la cuenta en las búsquedas por teléfono y código de regalo. Ni el login, ni el refresh, ni `find_best_drivers` ni `accept_ride_v2` lo miran. Lo mismo pasaba con el nivel.
- **`admin_set_user_active(user, active, reason)`**, que usa `adminService.toggleUserActive`: pone `is_active`, banea en GoTrue (`auth.users.banned_until` a 100 años), borra las sesiones y refresh tokens, saca de línea al conductor y deja la fila en `admin_actions`. Desbloquear quita el ban. Lo puede hacer cualquier admin, con motivo; no a sí mismo, no a las dos cuentas de sistema (`…0001` y `…0099`, que 00604 dejó baneadas hasta 2999: desbloquearlas les quitaría el ban), y a otro admin solo un super admin.
- **El access token ya emitido sigue valiendo hasta que vence (1 h por defecto).** Para esa hora, `trg_driver_profiles_inactive_stays_offline` no deja que una cuenta inactiva se ponga en línea. El refresh falla enseguida, así que las apps lo mandan al login.
- **`verify-otp` responde 403 `account_blocked`** antes de tocar la contraseña, y las tres apps lo muestran como "Tu cuenta está bloqueada". Google, Apple y el enlace por correo los rechaza GoTrue con su propio error, que las apps muestran como error genérico.
- **`admin_set_user_level`** (`updateUserLevel`): solo super admin, que es lo que ya permitía `tg_users_protect_admin_fields`. El panel deshabilita el selector para los demás.
- Los errores de estas funciones traen el texto en español en MESSAGE y un código en DETAIL. `adminRpcError` los pasa a `AppError` con status 400 a propósito: `getErrorMessage` convierte 401/403 en "Sesión expirada" y escondería el motivo.
- Ensayo: `supabase/tests/00629/run.sh` (RED: 20 fallos; GREEN 27/27, también pegada con CRLF, con 3 pruebas negativas).
- **Estado: aplicada completa en prod el 2026-10-07.** La parte sin borrados (`admin_set_user_level` y el trigger de fuera de línea) entró por MCP como `00629_admin_block_user_and_level_part1_level_and_offline_trigger`. `admin_set_user_active` (su cuerpo borra sesiones) se cortó tres veces por MCP esperando la aprobación, y el dueño pegó el archivo entero en el SQL Editor. Los tres cuerpos coinciden con git (md5 `4fa49090…`, `89ced999…`, `bfc0929e…`). Probado con cuentas reales en un bloque revertido: un pasajero recibe `not_admin`; tocar `…0099` da `system_account`; sin motivo, `reason_required`; un bloqueo cierra la sesión del pasajero, borra sus refresh tokens, lo banea 100 años y deja la fila en `admin_actions`; desbloquear quita el ban. `verify-otp` v44 desplegado el mismo día.

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

### `pg_cron` + `net.http_post` es CIEGO a los fallos de la Edge Function (verificado 2026-07-19)

**La trampa.** Un cron que hace `SELECT net.http_post(...)` solo **encola** la request y devuelve un `request_id`. `cron.job_run_details` registra el resultado del `SELECT` (siempre `succeeded`), **nunca el HTTP**. Prueba del incidente: el runid 608668 corrió 36 ms con `status='succeeded'` mientras `net._http_response` id 77583 guardaba `status_code=502` en ese mismo segundo. **91 corridas verdes consecutivas con la función fallando siempre.**

Aplicaba a **7 crons**: 22 (auto-admin), 23 (sync-exchange-rate), 24 (sync-weather), 25 (behavioral-emails), 33/34 (keepwarm, 401 por diseño), 35 (proxy-health). **Los 7 están instrumentados desde las migs 00506/00507** — ver abajo.

> **REGLA: todo cron nuevo que llame a una Edge Function DEBE usar `public.cron_http_post(...)`, nunca `net.http_post` directo.** Si usás el crudo, ese job vuelve a ser invisible y nadie se entera hasta que un usuario reporta el síntoma.
>
> ```sql
> SELECT cron.schedule('mi-job', '*/10 * * * *', $$
>   SELECT public.cron_http_post('mi-job',
>     url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/mi-ef',
>     headers := jsonb_build_object('Content-Type','application/json',
>                  'Authorization','Bearer '||get_service_role_key(),
>                  'apikey', get_service_role_key()),
>     body    := '{}'::jsonb);
> $$);
> ```
> Si la EF devuelve algo que **no** es 2xx por diseño (como los keepwarm, que dan 401 a propósito), registrarlo o va a alertar para siempre:
> `INSERT INTO cron_http_expectations (jobname, ok_statuses, note) VALUES ('mi-job', ARRAY[200,401], 'por qué');`

**Cómo funciona.** `cron_http_post` envuelve `net.http_post` y loguea `request_id → jobname` en `cron_http_calls`; `check_cron_http_failures()` (cron `40 * * * *`) joinea contra `net._http_response` y alerta por email cuando **cambia el conjunto** de jobs fallando (un job que sigue caído no spamea; uno nuevo que se suma sí avisa). Estado en `platform_config.cron_http_health_{status,signature,detail,at}`.

Detalles que hacen falta si algún día se toca:
- **`net._http_response` NO tiene columna `url`**, y `net.http_request_queue` (que sí la tiene) se vacía al procesarse → después del hecho **no se puede** joinear una respuesta con su job. Por eso el mapeo se registra al llamar.
- El helper toma **los mismos argumentos nombrados** que `net.http_post`, así que instrumentar un cron existente es una **sustitución textual de prefijo** (headers/body quedan byte-idénticos, no se retipea auth).
- Dispara primero y loguea después, con el INSERT en su propio bloque de excepción → el peor caso es "sin trackear", nunca "sin enviar".
- Retención de `net._http_response` = **6 h** → la ventana del reconciliador es 90 min.

**Diagnóstico canónico — NUNCA confiar en `cron.job_run_details` para saber si una EF anduvo:**
```sql
-- Ahora con atribución por job (lo que antes era imposible):
SELECT c.jobname, resp.status_code, count(*), max(c.called_at) AS last_seen,
       left(max(resp.content), 120) AS sample
FROM cron_http_calls c
JOIN net._http_response resp ON resp.id = c.request_id
WHERE c.called_at > now() - interval '6 hours'
GROUP BY 1,2 ORDER BY last_seen DESC;
```
Para lo que quedó fuera de la ventana de 6 h: `get_logs service=edge-function` y filtrar por slug.

**`net._http_response.created` NO es la duración de la llamada** (verificado 2026-07-30). Restarle `cron_http_calls.called_at` da números que parecen latencia y no lo son: es el tick del worker de pg_net. La prueba es que `probe-netopia-proxy-health` arrojó **−0.003 s**, físicamente imposible. Esa métrica falsa hizo creer por un rato que `sync-exchange-rate` respondía en 0.05 s — imposible con su espera obligatoria entre reintentos — y casi lleva a diagnosticar un deploy viejo. **Para duración real usar `execution_time_ms` de `get_logs service=edge-function`**: ahí las mismas corridas medían 5209 ms. Otra vez la lección de *verificar en la superficie correcta*.

**Un 502 de cron NO siempre es un incidente: que el status exprese el invariante, no la suerte de un request.** `sync-exchange-rate` devolvía 502 ante cualquier corrida sin éxito, pero elToque rate-limitea ~75% de los intentos y con ~1 éxito/hora la tasa se mantiene fresquísima contra un techo de 24 h. Resultado: `cron_http_health_status='failing'` permanente mientras `fx_health_status='ok'` — dos watchdogs contradiciéndose y una luz roja que nadie mira. Patrón canónico para cualquier cron de *refresco*: en el fallo, consultar **el estado que el cron mantiene** (¿qué edad tiene el dato?) y devolver **200 `refreshed:false`** mientras el invariante aguante, **502** recién cuando esté en riesgo. Los fallos de **configuración propia** (token ausente, config ilegible) van **siempre a 502**: no se curan solos. **NO usar `cron_http_expectations` para esto** — aceptar 502 como status válido silenciaría también la caída real; la distinción depende de estado, no de código HTTP. Techo duro a respetar: `cron_http_post` pasa `timeout_milliseconds := 30000`; pasarse hace que pg_net registre `status_code NULL` y **se pierda el cuerpo con el diagnóstico**.

**Trampa jsonb: un flag de `platform_config` comparado contra string nunca matchea un boolean.** `platform_config.value` es **jsonb** y PostgREST lo devuelve como tipo JS nativo. `exchange_rate_auto_update` fue sembrado por 00017 como string `'"true"'` pero hoy es **boolean**, así que el `cfg[key] === 'false'` de `sync-exchange-rate` no podía matchear: **el kill switch de FX no apagaba nada**. `auto-admin:37`, `directions-google:107` y `create-stripe-payment-intent:140` ya protegen ambas formas (`=== 'true' || === true`) — esa es la convención. Usar `configFlag()` de `_shared/fx-sync-outcome.ts`. **Deuda conocida:** `sync-weather:114` sigue con la variante débil (cubre string y string entrecomillado, no boolean).

**El `Bearer` de un cron NO es decorativo: el gateway lo valida aunque la EF autorice por `apikey` (incidente 2026-08-17, mig 00567).** A las ~13:45 UTC, `auto-admin` / `sync-exchange-rate` / `sync-weather` pasaron de 200 a **401 `{"code":"UNAUTHORIZED_LEGACY_JWT"}`** en todas sus corridas, sin que nadie tocara nada. Los 4 crons de 00219 mandaban `Authorization: Bearer <legacy ANON JWT hardcodeado>` (el `apikey` sí salía del vault en formato nuevo `sb_secret_*`, y es el que la EF chequea de verdad); ese Bearer existía solo para satisfacer el `verify_jwt=true` del gateway. El legacy anon está `disabled` a nivel proyecto desde BUG-199, pero **el gateway venía grandfathereando los JWT legacy** — riesgo que el propio encabezado de 00219 dejó escrito hace meses — y ese día Supabase dejó de hacerlo. **Diagnóstico en 3 consultas:** (1) `cron_http_calls ⋈ net._http_response` da el minuto exacto del corte por job; (2) `SELECT jobname, command LIKE '%eyJ%' FROM cron.job` parte la lista en dos y **los que fallan son exactamente los que tienen el JWT hardcodeado** — los que usan `get_service_role_key()` (`probe-netopia-proxy-health`, `check-sms-balance`, ambos contra funciones `verify_jwt=true`) seguían en 200 a la misma hora, que es la prueba de que el formato nuevo sirve como Bearer; (3) `pg_proc.prosrc LIKE '%eyJ%'` acota el radio (dio 0 → solo crons). **Regla:** nunca hardcodear un JWT en un cron ni en una función — siempre `'Bearer ' || get_service_role_key()`. Un `apikey` correcto NO te salva del gateway. **Ojo con el orden de daño:** el reloj corre desde el último éxito, no desde el aviso — con FX el techo son 24 h antes de que las recargas devuelvan `503 fx_unavailable`, y el cron diario (`behavioral-emails-daily`) ni siquiera había fallado todavía cuando se detectó.

**Los tests de Edge Functions no los corría nadie** (hasta 2026-07-30). Los 3 proyectos vitest limitan su `include` a `src/**/*.test.ts` de su propio paquete, así que `_shared/demo-otp.test.ts` estuvo huérfano desde que se escribió. Ahora `packages/api/vitest.config.ts` incluye además `../../supabase/functions/_shared/**/*.test.ts`. Un `index.ts` de EF importa de `https://` y toca `Deno.*`, que vitest no resuelve por sí solo, pero **el handler entero se puede testear** (desde 2026-10-07: `send-email/index.test.ts`, `add-email-with-verification/index.test.ts`): `vi.mock` acepta la URL tal cual (`vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', …)` con un cliente falso que registra las consultas), `vi.mock('../_shared/rate-limiter.ts')` decide qué buckets están llenos, y `vi.stubGlobal('Deno', { env, serve })` captura el handler al importar `./index.ts`. Cada carpeta de EF testeada se agrega al `include` de `packages/api/vitest.config.ts`. Ojo también: **`pnpm check:ef-types` no corre desde el sandbox** (el proxy bloquea `esm.sh`, así que `deno check` no puede bajar los imports remotos); tipo-chequear esos módulos con `npx tsc --noEmit --strict`. **Un `index.ts` entero también se puede chequear sin Deno** (verificado 2026-09-27 con `storage-upload`): un `tsconfig` desechable con `"paths": { "https://esm.sh/@supabase/supabase-js@2.108.2": ["<repo>/node_modules/@supabase/supabase-js"] }`, `allowImportingTsExtensions`, `moduleResolution: bundler`, un `.d.ts` con `declare const Deno: { env: { get(n: string): string | undefined }; serve(h: (r: Request) => Response | Promise<Response>): void }` y el `index.ts` en `files`. Los tipos son de la 2.99.1 local, no de la 2.108.2 que corre, pero alcanza para lo que gatea `check:ef-types`: el control negativo (un typo de método, un identificador inexistente, un tipo mal asignado) dio TS2551, TS2304 y TS2322. Correrlo primero sobre la EF sin cambios, para tener línea base.

**Incidente que lo destapó (tipo de cambio congelado 4 días, recargas caídas).** Dos capas:
1. **Bug latente de 4 meses:** `fetchFromAPI` en `sync-exchange-rate` solo aceptaba la forma **anidada** (`d.tasas.USD.median`). La API de elTOQUE devuelve el USD como **número plano**: `{"tasas":{"USD":665.0},...}`. Devolvía `null` en cada corrida y caía al scraper. Prueba dura: `SELECT source, count(*) FROM exchange_rates GROUP BY source` → 2771 filas `eltoque_scraping`, **cero `eltoque_api`, jamás**.
2. **El gatillo:** el 2026-07-15 `eltoque.com` empezó a responder **403 con `Cf-Mitigated: challenge`** (Cloudflare bot management). Murió el scraper que tapaba el bug → las dos fuentes en `null` → `502 all_methods_failed` → tasa congelada → pasadas 24h, las 4 EFs de pago devuelven `503 fx_unavailable`.

**Lección general — un fallback que nunca se ejerció no es un fallback.** Si tenés 2 fuentes y una tapa a la otra, **verificá que AMBAS hayan escrito alguna vez** (agrupá por `source`/proveedor). Una fuente con 0 filas históricas está rota, no de respaldo. Vale para pagos, SMS, geocoding, push.

**Lo que NO hay que hacer** (verificado, son callejones sin salida):
- **NO subir `exchange_rate_max_age_hours` para "desbloquear recargas".** Las 4 EFs de pago **hardcodean 24h contra `created_at` y ni leen esa key**. Lo único que toca es `revalue_anchored_wallets`, y subirla **reactivaría la revaluación de dinero contra una tasa vieja** — justo lo que el fail-closed previene. Peor que no hacer nada.
- **NO cambiar a Stripe.** Mismo gate FX, y `stripe_enabled=false` por el KYC pendiente.
- **NO revivir el scraper spoofeando headers.** Es un managed challenge de Cloudflare; Supabase Edge sale por rangos de datacenter.
- **NO tocar `exchange_rates` con INSERT/UPDATE crudo.** Usar siempre `upsert_exchange_rate(...)` — aplica la banda `[100,5000]`, maneja `is_current` y dispara `recompute_cup_from_usd_prices`.

**Watchdog (mig 00503, aplicado).** `check_exchange_rate_freshness()` + cron 36 (`20 * * * *`) alerta por email en **transición** `ok↔stale` (patrón de `proxy-health/index.ts:158-181`, sin spam horario), a las **20 h** (config `fx_stale_alert_hours`) → ~4 h de margen antes de que las recargas se rompan a las 24 h. Estado en `platform_config.fx_health_{status,at,detail}`.

**Por qué el watchdog es SQL puro y NO una Edge Function:** una EF invocada por `net.http_post` **heredaría exactamente la misma ceguera**. La detección corre dentro de la base leyendo `exchange_rates` directo; el único HTTP es el email, que es la *acción*, no la *detección*.

**Cómo probar un alerta sin spamear** (`business_notification_email` son 3 destinatarios reales): correr todo dentro de `BEGIN; ... ROLLBACK;` — `net.http_post` inserta en `net.http_request_queue`, que **es transaccional**, así que el rollback cancela el envío. Verificado: `emails_sent=3` con **cero** requests en `net._http_response`. Confirmar el rollback releyendo las keys de config después.

### Trampa plpgsql: `RAISE EXCEPTION 'texto' USING MESSAGE = …` aborta con 42601 (verificado 2026-07-27, mig 00519)

**Síntoma que ve el usuario final:** un toast con el texto crudo **"RAISE option already specified: MESSAGE"** en vez del mensaje que la función quería dar. Reportado por un conductor al tocar "Llegué al destino".

**Causa:** la cadena de formato de `RAISE EXCEPTION 'texto'` **ya define** la opción `MESSAGE`. Agregar `USING MESSAGE = …` la define por segunda vez y Postgres aborta la sentencia con `42601`. Es error **de runtime** (`exec_stmt_raise`), no de compilación → la función se crea sin chistar, pasa cualquier `check-types`/deploy, y **solo explota cuando esa rama concreta se ejecuta**. Puede vivir meses dormida en una rama de guarda.

```sql
-- Reproducción mínima:
DO $$ BEGIN RAISE EXCEPTION 'gps_required' USING MESSAGE = 'x'; END $$;
--> ERROR: 42601: RAISE option already specified: MESSAGE
```

**Forma correcta** (el código legible por máquina va a `DETAIL`, que PostgREST expone como `error.details`):

```sql
RAISE EXCEPTION USING
  ERRCODE = 'P0001',
  MESSAGE = format('Estás a %s m del %s. Acércate más para confirmar.', v_dist, v_target_es),
  DETAIL  = 'too_far_for_bypass';
```

**Barrido:** `grep -rn "USING MESSAGE" supabase/migrations/` y revisar cada hit — si la línea del `RAISE` trae además una cadena de formato, está roto. Ojo que **basta con mirar la migración más nueva de cada función**, pero para saber qué corre hoy hay que ir a `pg_get_functiondef` (ver más abajo).

**Amplificador:** `driver.service.updateRideStatus` (y varios services) hacen `throw new Error(error.message)` y la app renderiza `errMsg` **crudo** en el toast. Cualquier `RAISE` mal formado llega tal cual a la pantalla del usuario. Al tocar mensajes de error server-side, recordá que son **copy de UI**: español neutro, accionable.

**Cómo se agrava:** las dos ramas rotas estaban en la verja de proximidad de `update_ride_status_v2`, y el conductor **debe** pasar por `arrived_at_destination` para poder finalizar → el viaje quedaba trabado sin salida. Cuando un guard de estado falla, revisá si el usuario queda en un callejón sin salida, no solo si el mensaje es feo.

**Lección de método (se repitió en esta sesión):** la migración en git **no es** lo que corre en prod. `00233` era la última migración de `update_ride_status_v2` en el repo, pero `00432` había reescrito la función agregando el guard RLC-01. Reescribir desde `00233` habría **borrado ese guard en silencio**. Patrón: transcribir el cuerpo desde `pg_get_functiondef`/`prosrc` vivo, y **probar la fidelidad con hash** — revertir los cambios intencionales sobre el archivo nuevo debe reproducir `md5(prosrc)` y `length(prosrc)` exactos de prod.

### Trampa plpgsql: `make_interval(mins => …)` solo acepta INT — NUMERIC revienta en runtime (00527→00528)

`make_interval(years, months, weeks, days, hours, mins int, secs double precision)`: **solo `secs` es `double precision`; todos los demás campos son `INT`**, y `NUMERIC` NO resuelve implícitamente a `INT`. Como `get_platform_config_numeric()` devuelve `NUMERIC`, esto explota:

```sql
v_after_min NUMERIC := get_platform_config_numeric('...', 10);
... now() - make_interval(mins => v_after_min)
--> ERROR 42883: function make_interval(mins => numeric) does not exist
```

Las funciones hermanas de 00524-00526 zafan porque usan `make_interval(secs => v_x)` con `v_x INT` (INT→double precision **sí** es implícito). Fix: castear a `::int` al asignar, o usar `secs =>`.

**Lo grave es CUÁNDO falla:** plpgsql **no tipa las queries del cuerpo en CREATE**, así que la función se crea sin una queja y solo revienta al ejecutar esa línea. En 00527 eso dejó el cron 10 de auto-offline roto en prod hasta que se corrió la función. **Que `CREATE`/`apply_migration` devuelva éxito NO es evidencia de que una función plpgsql corra** — misma clase que el `RAISE ... USING MESSAGE` de 00519. Después de aplicar una función nueva, **ejecutarla** (en `BEGIN…ROLLBACK` si tiene efectos) antes de darla por buena.

### Trampa plpgsql: una variable `RECORD` hace shadowing del alias SQL con el mismo nombre

**Bug real (mig 00507).** Declarar `r RECORD` para un `FOR` loop **y** usar `r` como alias de tabla en una query de la misma función:

```sql
DECLARE r RECORD;                               -- para el FOR loop
...
SELECT ... FROM net._http_response r WHERE r.status_code IS NULL   -- alias `r`
-- ERROR: record "r" is not assigned yet
```

plpgsql resuelve `r.status_code` contra la **variable RECORD sin asignar**, no contra el alias SQL. Probado en aislamiento: con `DECLARE r RECORD` da el error; renombrando la variable a `v_row` la misma query funciona.

**Por qué es peligroso:** si la función tiene `EXCEPTION WHEN OTHERS` (como todo watchdog defensivo), el error se traga y la función queda **muda pero rota** — devuelve `{"ok":false,...}` y nadie mira. El watchdog de crons estuvo ciego desde que se aplicó hasta que se corrió a mano.

**Regla:** prefijar SIEMPRE las variables plpgsql (`v_*`, `c_*`) y no usar alias SQL de una sola letra que puedan colisionar. Renombrar de los **dos** lados.

### Trampa plpgsql: `COALESCE(<enum>, 'texto')` revienta en runtime (00555 → #945)

`COALESCE(columna_enum, '—')` **no** devuelve texto: Postgres intenta coercionar el literal **al enum** y lanza `22P02 invalid input value for enum <tipo>: "—"`. Hay que castear primero:

```sql
COALESCE(v_a.ride_status::text, '—')   -- rides.status es el enum ride_status
```

**Misma clase que las dos trampas de arriba, y el mismo desenlace:** plpgsql no tipa las sentencias del cuerpo al crear la función, así que el `CREATE` pasa en verde y el error solo aparece al ejecutar esa rama; si la función tiene `EXCEPTION WHEN OTHERS` —lo normal en watchdogs y notificadores defensivos— se lo traga y **falla en silencio para siempre**. En 00555 habría dejado muda la alerta de "la app del conductor murió", que es exactamente el modo de falla que esa migración existía para eliminar.

**Cómo detectarlo antes de escribirlo:** al hacer `COALESCE(x, 'literal')` sobre una columna, comprobar el tipo — `data_type='USER-DEFINED'` significa enum y exige `::text`:

```sql
SELECT column_name, data_type, udt_name FROM information_schema.columns
WHERE table_name='<tabla>' AND column_name='<col>';
```

**Lo que lo cazó no fue la revisión de código sino el ensayo rolleado**: crear la función y **ejecutarla** dentro de `BEGIN … ROLLBACK` antes de aplicar. Vale la pena para cualquier función nueva con lógica no trivial — y es seguro incluso cuando manda correos, porque `net.http_post` encola en `net.http_request_queue`, que es transaccional (verificar después con `SELECT count(*) FROM cron_http_calls WHERE called_at > …`, que debe seguir sin la etiqueta nueva).

### Trampa plpgsql: `DELETE/UPDATE … RETURNING … INTO` aborta con 2+ filas aunque no digas `STRICT` (verificado 2026-09-25, mig 00594)

`SELECT … INTO` sin `STRICT` se queda con la primera fila. **Un `INSERT/UPDATE/DELETE … RETURNING … INTO` no**: si la sentencia toca 2 o más filas, plpgsql lanza `P0003 query returned more than one row`, con o sin `STRICT`.

**Por qué engaña:** con 0 o 1 fila funciona, así que pasa la revisión, las primeras pruebas y meses en prod. El día que califican dos filas, la sentencia se revierte y **el trabajo ya no puede volver a andar nunca**: las filas que debía borrar quedan y el atraso solo crece. Caso real: `cleanup_auth_revocations()` (cron 28, 03:00 UTC) tenía `DELETE … RETURNING 1 INTO v_deleted` y falló **las 14 noches** que guarda `cron.job_run_details`. La tabla juntó 62 filas viejas. La más vieja era del 2026-07-09, y cualquier corrida exitosa desde el 07-11 la habría borrado, así que el cron **no anduvo ni una vez en dos meses y medio**.

**Para contar filas afectadas**, cualquiera de estas dos:
- `GET DIAGNOSTICS v = ROW_COUNT;` justo después de la sentencia, sin `RETURNING`.
- `WITH d AS (DELETE … RETURNING 1) SELECT count(*) INTO v FROM d;` (lo usan `prune_old_ride_location_events`, `anonymize_old_rides` y `auto_offline_stale_drivers`).

`RETURNING … INTO` solo es seguro cuando el `WHERE` va por una clave `PRIMARY KEY` o `UNIQUE`. En el barrido de prod del 2026-09-25, **19 funciones** usan la forma; 17 son seguras (clave única o el patrón CTE), una era este bug y la otra estaba **latente** hasta 00595: `auto_link_fleet_member_on_signup` (`AFTER INSERT ON users`, sin `EXCEPTION`). `fleet_members` es único por `(fleet_id, driver_phone)` y el `UPDATE` compara el teléfono normalizado. Si dos invitaciones pendientes compartían teléfono (de dos flotas, o la misma flota con el número en dos formatos), **el alta de esa persona fallaba**. 00595 la arregló antes de que le pasara a alguien (`fleet_members` tenía 0 filas): ahora vincula todas las invitaciones, igual que `relink_fleet_member_for_existing_driver`.

**En prod, la 00595 figura dos veces en `supabase_migrations.schema_migrations`, y está bien.** Dos sesiones arreglaron el mismo bug en paralelo, y cada una aplicó su archivo por MCP con 15 segundos de diferencia:
- `20260925194738 00595_fix_auto_link_fleet_member_on_signup` viene del #1018. Ese PR se cerró sin mergear, así que **su archivo no está en git**.
- `20260925194753 00595_fix_fleet_signup_multi_invitation` viene del #1019.

Las dos instalan el mismo cuerpo (`md5(prosrc)` `c4b25ab786f201ced8661633ff113e57`, longitud 434), y la segunda solo lo volvió a escribir: no hay nada que corregir. **El chequeo de número de migración no detecta trabajo duplicado** cuando el otro PR se abre y se mergea en minutos. Antes de aplicar en prod, correr `git fetch` y buscar en `git log origin/master` si algo ya tocó el mismo objeto.

**Hasta 00596, ningún watchdog miraba las corridas fallidas de los crons SQL.** `check_cron_http_failures` cubre solo los que llaman a una Edge Function, y por eso este cron falló dos meses y medio sin que nadie se enterara. Desde 00596, `check_cron_sql_failures()` (cron `45 * * * *`) manda un correo a `business_notification_email` cuando cambia la lista de tareas que fallan. Cuenta como fallando una tarea con 3 fallas reales seguidas, o con todas sus corridas fallidas si todavía no tiene 3 (semanales, nuevas). Desde 00597 una falla es real solo si el SQL del job falló (`return_message` empieza con `ERROR:`) o si pg_cron rechazó su comando (`COPY not supported`). Salta todo lo demás, que es pg_cron sin poder correr el job o perdiendo la conexión mientras corría: `job startup timeout`, `server restarted`, `connection failed`, `connection lost`, `job canceled`. Antes saltaba solo los dos primeros, y en modo libpq (el de prod) una caída también puede dejar `connection failed`. Hueco aceptado: un job que muere con FATAL en cada corrida, o cuyo rol o base ya no existe, también se salta. Exige verla fallar en dos revisiones seguidas: medido contra el historial, así se evitan las 4 falsas alarmas de las caídas del 20 y 21 de septiembre. Desde 00597 los correos salen por `cron_http_post` con la etiqueta `cron-sql-failure-alert` (timeout de 30 s en vez de 5): `check_cron_http_failures` avisa cuando `send-email` rechaza 2 o más dentro de su ventana de 90 min. Si el rechazo es de fondo (sin clave de vault, `send-email` caído), su propio aviso falla igual; el rastro queda en `cron_http_calls` (24 h) y `net._http_response` (6 h). `SELECT public.cron_sql_failures_now();` dice qué falla ahora sin mandar nada. El estado queda en `platform_config.cron_sql_health_*`. Cualquier cron nuevo queda cubierto solo, siempre que su función deje salir los errores (ver el apartado siguiente). A mano, las fallas crónicas se ven así:

```sql
SELECT j.jobid, j.jobname, count(*) FILTER (WHERE d.status <> 'succeeded') AS fallidas, count(*) AS corridas
FROM cron.job j JOIN cron.job_run_details d USING (jobid)
WHERE d.start_time > now() - interval '14 days'
GROUP BY 1, 2 HAVING count(*) FILTER (WHERE d.status <> 'succeeded') > 0 ORDER BY 3 DESC;
```

`job startup timeout` y `server restarted` son las caídas de septiembre y el paso a Micro, no bugs. **Un job con fallidas = corridas y un mensaje de error de SQL es un bug de código.**

### Una función de cron no atrapa sus propios errores (00639, 2026-10-08)

**El problema.** `check_cron_sql_failures` cuenta una corrida como fallida solo si `return_message` empieza con `ERROR:`. Una función que envuelve todo su cuerpo en `EXCEPTION WHEN OTHERS THEN RAISE WARNING …; RETURN '{"ok": false}'` deja la corrida en `succeeded`. Además, el manejador deshace todo lo que hizo el bloque: el estado en `platform_config` y los correos encolados. Un vigilante roto dejaba de escribir su estado, no mandaba nada y parecía sano. Medido el 2026-10-08: 17 de los 28 crons SQL tenían algún manejador así; 11 envolvían el cuerpo entero (8 vigilantes y 3 podas) y había 2 auxiliares iguales, cuyo resultado descartaba quien las llamaba. El peor caso era `sample_database_health`: `evaluate_database_health` no mira la antigüedad de la última muestra, así que con el muestreo roto `check_database_health` seguía diciendo "ok" sobre la última muestra buena y renovaba `db_health_at`.

**Qué hizo 00639.** Quitó esos 13 manejadores, parcheando el cuerpo vivo (cada uno tenía que tener el md5 leído de prod), y pasó el correo de conductor sin conexión (`notify_dead_driver_alert`) a su propio job, `notify-dead-driver-alert` (`1-59/5`, un minuto después de `release-dead-driver-rides`). Dentro de la liberación, sin manejador, un correo roto habría deshecho las liberaciones de viajes. Los avisos pendientes quedan en `stuck_ride_alerts` con `emailed_at` vacío, así que el job aparte los toma. Ensayo: `supabase/tests/00639/run.sh` (ROJO: 19 fallos; VERDE: 34/34, con 6 pruebas negativas).

**La regla.** Una función que llama pg_cron no lleva `EXCEPTION WHEN OTHERS` alrededor de todo el cuerpo. Una corrida es su propia transacción, así que un error no tumba nada más; solo hace que el vigilante la vea. Si algo tiene que quedar aislado, va en un bloque propio:
- **una fila de un bucle**, para que un viaje malo no frene al resto (`activate_scheduled_rides`, `create_rides_for_recurring`, el correo por viaje de `check_stuck_active_rides`, el push por grupo de `notify_offline_drivers_for_searching_rides`);
- **un aviso que corre después del trabajo real** (los push de `auto_offline_stale_drivers`, `release_rides_from_dead_drivers` y `retry_dispatch_expired_rides`, el resumen de `notify_support_waiting_rides`). Si el aviso sale por `cron_http_post`, sus fallas HTTP las ve `check_cron_http_failures`.

Si el aviso es justo lo que hay que vigilar, va en su propio job, como `notify-dead-driver-alert`. Para auditar los crons SQL:

```sql
SELECT j.jobname, p.proname, (SELECT count(*) FROM regexp_matches(p.prosrc, 'exception\s+when', 'gi')) AS manejadores
FROM cron.job j JOIN pg_proc p ON p.pronamespace = 'public'::regnamespace AND j.command ~ ('\m' || p.proname || '\s*\(')
WHERE j.command !~* 'cron_http_post' ORDER BY 3 DESC, 1;
```

Un manejador que aparece acá no es un bug por sí solo: hay que leer el cuerpo y ver si envuelve todo o solo una fila o un aviso. Las funciones que llama el job también cuentan: un auxiliar que devuelve `{"ok": false}` y cuyo resultado se descarta con `PERFORM` es igual de ciego.

**Cómo se copian cuerpos vivos byte a byte para un ensayo.** 7 de los 14 cuerpos no coincidían con ningún archivo de git: los habían cambiado parches posteriores aplicados sobre el cuerpo vivo. Para no transcribirlos a mano, se pidieron todos en un solo `execute_sql` que devuelve `json_build_object('functions', json_agg(pg_get_functiondef(...)), 'pad', repeat('#', 150000))`. El relleno hace que la herramienta guarde la respuesta en un archivo, y se decodifica con Python (el JSON de afuera, después el de adentro de `<untrusted-data-…>`). El md5 de cada cuerpo extraído se compara con el de prod. El md5 de `current_query()` en un `execute_sql` no sirve para comparar el texto entero: la herramienta lo envuelve y le suma 107 caracteres.

### Aplicar migraciones pesadas por MCP: pg-meta corta la conexión a ~4 min y un `ADD COLUMN` + backfill deja a las apps en cola (verificado 2026-09-07, 00579)

**Tres límites distintos, medidos aplicando 00579 (110.289 filas de `cuba_pois`) — el primer intento murió por el 2.º, el segundo por el 3.º, y ambos se revirtieron completos:**

| Límite | Valor | Cómo se ve |
|---|---|---|
| Cliente MCP (`apply_migration` / `execute_sql`) | **60 s** | la herramienta devuelve "timed out after 60s" pero **el servidor sigue** — verificar por objeto (`pg_stat_activity`, `to_regclass`), nunca por el error |
| `statement_timeout` del rol `postgres` del MCP | **2 min por sentencia** | `57014 canceling statement due to statement timeout` en `postgres_logs`; `SET statement_timeout = 0` al inicio del batch SÍ lo desactiva (PG13+ aplica el timeout por sentencia del string, y el SET rige para las siguientes) |
| pg-meta (el proxy HTTP detrás del MCP) | **~4 min por petición** | `FATAL 08006 connection to client lost` cuando el backend intenta mandar el siguiente `NOTICE` → transacción **abortada**; no lo cura ningún GUC |

**El daño colateral es peor que el timeout.** `ALTER TABLE … ADD COLUMN` toma `AccessExclusiveLock` y lo retiene hasta el commit; si en la misma transacción viene un backfill de minutos, **todas las lecturas de esa tabla desde las apps quedan en cola** y mueren con el `statement_timeout` de 8 s del rol anon — 00579 dejó 22 × `57014` de consultas de usuarios en los logs durante los dos intentos fallidos (búsqueda y reverse geocode de POIs caídos ~8 min en total). Y el costo del backfill en prod no es el del ensayo local: `cuba_pois` tiene 20 índices (3 GIN trgm) → **~2 ms por fila actualizada** (233 s para 110k filas, medido por `auto_explain`) contra milisegundos en el andamio.

**Patrón canónico para una migración con backfill grande (sin tocar el archivo en git, que sigue siendo idempotente y es lo que corre `supabase db push`):**
1. `apply_migration` con el DDL solo (columnas, funciones, triggers, índices parciales, políticas) + `SET lock_timeout = '10s'` — segundos, lock corto.
2. El backfill como `UPDATE … WHERE id >= a AND id < b` por rangos de id (**~15k filas ≈ 30 s** a 2 ms/fila), vía `execute_sql`, de a 2-4 rangos disjuntos en paralelo: solo `RowExclusiveLock`, las lecturas siguen fluyendo. Calcular los cortes con `row_number() OVER (ORDER BY id)` — los ids tienen huecos enormes.
3. `ALTER COLUMN … SET NOT NULL` / `VALIDATE CONSTRAINT` / `ANALYZE` al final, cada uno en su apply.
4. Un backfill que ya viene en tandas dentro de un `DO` (00580) igual se parte: el `DO` es UNA sentencia y UNA transacción → mismo techo de 4 min y mismo lock hasta el commit. Ejecutar el cuerpo del loop como sentencias sueltas por rango.
5. Registrar las partes como `<numero>_<nombre>_partN` en `apply_migration`; `schema_migrations` registra por timestamp de todos modos.

**Diagnóstico:** `pg_stat_activity` con `query ILIKE '%<numero>%'` da pid / `xact_age` / `wait_event`; `pg_locks` del pid dice en qué sección va (qué tablas y qué modos tiene tomados); `query_logs` (`source='postgres_logs'`, `parsed.error_severity`) da el `57014` / `08006` exacto y los planes de `auto_explain`. Un `xact_age` que desaparece sin que existan los objetos = rollback silencioso. Las tuplas muertas de los intentos revertidos las limpia autovacuum solo (13k de 110k a los 5 min).

**Un `DELETE` por MCP espera que la persona lo apruebe en la app, y ese timeout de 60 s no es como los de arriba (verificado 2026-10-06, 00606).** Los dos primeros intentos de borrar 166.143 filas de `admin_actions` dieron "timed out after 60s" y **la sentencia nunca llegó a la base**: ni `pg_stat_activity`, ni `pg_stat_statements` (con `track_utility = on`) la registraron, y la tabla seguía intacta. En el mismo minuto, las partes sin borrado (funciones, política, índices) entraron al instante. Al tercer intento, con el usuario aprobando el aviso, el `DELETE` sí corrió y quedó confirmado, pero el cliente igual cortó a los 60 s y `apply_migration` **no lo anotó** en `schema_migrations`. Por eso:
- Separar lo destructivo del resto: el trigger, la política y los índices se aplican sin esperar a nadie, y el borrado va en su propia parte.
- Avisar al usuario **antes** de mandar un `DELETE`/`DROP`/`TRUNCATE` por MCP que va a tener que aprobarlo en la app.
- Tras cualquier timeout, verificar por objeto (conteo de filas, `to_regclass`, md5 del cuerpo) y no por `schema_migrations`.
- No esquivar la confirmación metiendo el `DELETE` dentro de un `DO` o de una función: el aviso existe para que la persona decida.

**Qué dispara esa espera, medido el 2026-10-06 con 00617, 00620 y 00622.** No es la palabra sino una sentencia destructiva, y un `DELETE FROM` dentro del cuerpo de una función cuenta:
- La 00617 (con un `DROP POLICY` y una función con `DELETE FROM`) y la 00620 (solo la función con `DELETE FROM`) se cortaron a los 60 s sin llegar a la base: ni la función ni nada en `pg_stat_activity` ni en `schema_migrations`.
- La 00622 entró al instante aunque nombra `DELETE` en un `GRANT … DELETE ON …` y en un comentario.
- Un bloque de prueba que termina en `RAISE EXCEPTION`, con un `DELETE` de limpieza adentro, también se cortó por `execute_sql`, aunque todo se iba a deshacer. Para probar en prod sin esperar, llamar solo a la función bajo prueba y dejar que el `RAISE EXCEPTION` deshaga las filas creadas.
- **El aviso puede no llegar nunca** (2026-10-07): la 00627 (7 `DROP POLICY`) y la 00629 (una función con `DELETE FROM auth.sessions`) se cortaron cinco veces seguidas, también con el dueño en la conversación pidiendo que se aplicara, y nunca vio un aviso a tiempo. Si se corta dos veces, no seguir reintentando: pasarle al usuario los pasos del SQL Editor. Funcionó así: abrir `https://supabase.com/dashboard/project/lqaufszburqvlslpcuac/sql/new`, copiar el archivo de la migración desde GitHub con "Copy raw file", pegar, Run, y confirmar el aviso de operación destructiva con "Run this query". Después, verificar por objeto.

**Si se corta, se aplica desde el SQL Editor, y pegar desde Windows mete `\r` en el cuerpo de las funciones.** La función anda igual, pero su md5 ya no es el de git: la 00617 quedó en `d7957554…/1173` en vez de `582b8dd9…/1136`. Pegar la migración y agregar al final este bloque, en la misma ejecución, la recrea desde el catálogo sin los `\r`. Conserva permisos y SECURITY DEFINER, y frena si el cuerpo no queda igual al de git. Así quedó bien la 00620 a la primera.

```sql
DO $fix$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef('public.<funcion>(<args>)'::regprocedure) INTO v_def;
  IF position(chr(13) IN v_def) > 0 THEN
    EXECUTE replace(v_def, chr(13), '');
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.<funcion>(<args>)'::regprocedure) <> '<md5 de git>' THEN
    RAISE EXCEPTION 'el cuerpo instalado no es el de git';
  END IF;
END
$fix$;
```

Una migración aplicada desde el SQL Editor no queda en `schema_migrations`: se verifica por objeto (md5 y largo del cuerpo, ACL, políticas), como cualquier otra.

**Medir latencia en prod justo después de un backfill engaña, y la firma para reconocerlo es "mismos buffers, 100× más lento".** Tras 00579-00581, `search_pois_smart('hotel')` daba 2,0-5,2 s por MCP contra ~45 ms del ensayo local con las mismas filas; con plan custom, genérico e inline salía igual de mal, así que no era el plan. La respuesta la dio `auto_explain` con `log_nested_statements = on`, `log_analyze = on` y `log_timing = on` en la sesión (los GUC de auto_explain se pueden setear desde el rol `postgres`; el plan de la sentencia interna de la función queda en `postgres_logs`): el plan en frío (2.463 ms) y el mismo plan 1 s después (140 ms) tienen **nodos idénticos y los mismos `shared hit`** (`idx_pois_location` 1.099 buffers en ambos), pero en frío cada nodo tarda **~100×** (ese índice 684 ms vs 7 ms; `idx_cuba_pois_active` 221 ms vs 2 ms; el index scan por pk 4,6 ms/fila vs 0,03). "Hit" con 100× de costo = páginas frías en memoria / CPU contendida de la instancia, no Postgres ni la consulta. Reglas: (1) A/B siempre dentro de UNA petición multi-sentencia, alternando, leyendo las duraciones anidadas en los logs; (2) descartar `plan_cache_mode` ANTES de tocar código (`SET plan_cache_mode = force_custom_plan` / `force_generic_plan` en la sesión — acá el genérico era 2× peor pero no explicaba nada); (3) el número que ven los usuarios es el caliente (PostgREST mantiene sus conexiones): v2 en prod = 18-27 ms exactas/alias, 96-350 ms keyword/fuzzy. La "primera llamada del día de 3-4 s" que ya tenía v1 es esta misma instancia despertando, y se arregla con cómputo, no con SQL.

### Verificar la superficie correcta (2 incidentes el mismo día, 2026-07-19)

Dos veces en una sesión la verificación fue **real pero sobre la superficie equivocada**, y las dos veces llegó a producción:

| Se verificó | Por qué no sirvió | Qué lo destapó |
|---|---|---|
| "los 6 archivos TS parsean" (`node --check`) | valida **sintaxis**, no identificadores → un import faltante parsea perfecto | el output del deploy: la EF rota subió **un archivo menos** al bundle |
| "la query de detección funciona" (suelta, en rollback) | el shadowing plpgsql **solo existe dentro de la función** | correr la **función desplegada** |

**Regla operativa:** probar **el artefacto que se despliega**, no una pieza suya en un contexto distinto. Corolarios verificados:
- Un archivo `_shared/` faltante en el output de `supabase functions deploy` **significa que falta un import**. Comparar contra las EFs hermanas.
- Para una función SQL, ejecutar `SELECT mi_funcion(...)` después de aplicar — no solo su query interna.
- `pnpm check-types` **no cubre** `supabase/functions` (son Deno, fuera de todo tsconfig). Para eso está `pnpm check:ef-types` (`deno check`, gatea solo TS2304/2305/2307/2552 — los que siempre crashean en runtime — y reporta los ~34 preexistentes sin bloquear).

### Proxy de pagos NETOPIA: las "caídas frecuentes" eran NETOPIA-side + flapping de alertas (v2 por capas, 2026-07-21)

**Diagnóstico verificado.** El VPS/squid/nginx NO se caían (nginx 4 semanas up; squid solo reiniciado por el propio watchdog). Todos los eventos "CAÍDO" desde 2026-07-02 fueron del lado de NETOPIA o transitorios de 1 probe:
- **2026-07-20 (~40 min, único incidente real):** el edge de NETOPIA aceptaba el túnel pero colgaba `/ui/card` — squid access.log muestra `TCP_TUNNEL/200` con duración ≈25000ms (el `--max-time` del probe). `/pay/` vía nginx respondía 404 normal al mismo tiempo. Los 4 restarts de squid del watchdog no curaron nada.
- **2026-07-21:** NETOPIA devolvió **502 en `/pay/`** (3 requests). Cero `connect() failed` hacia mobilpay en el error.log de nginx (que SÍ los loguea para otros upstreams) ⇒ el 502 vino del upstream.
- El alerting v1 **flapeaba**: 2 reporters con alcances distintos (watchdog: squid+npproxy; edge-probe: solo npproxy) sobre UNA key → 10 correos por 1 incidente; y 1 solo probe fallido ya emailaba.

**v2 (mig 00510 + EF `proxy-health` + `ops/squid/healthcheck.sh`):** estado por capa con un solo writer c/u (`netopia_proxy_health_squid`/`_npproxy` ← watchdog; `_edge` ← edge-probe; la key vieja `netopia_proxy_health` queda como rollup worst-of), estados `ok|down|upstream|config` — `upstream` = NETOPIA rota, verificado con **sondas directas desde el VPS** (si NETOPIA falla con y sin el proxy, el proxy es inocente) → NO tocar el VPS; `config` = configuración rota: 403 drift de `x-proxy-secret`, **o** la sonda ni pudo correr por secreto ausente (`NP_PROXY_SECRET` sin setear / `hmac_secret` vacío — HTTP `-` en el journal; ojo: `hmac_secret` vacío también rompe el checkout real, el helper de squid lee el mismo archivo). Debounce: `netopia_proxy_alert_after_s` (default 600s) de caída continua antes del ÚNICO correo; recovery solo si alertó; `edge` solo alerta si el watchdog lleva >15 min mudo (= VPS entero caído). El watchdog **ya NO reinicia** squid/nginx en `upstream`/`config` (solo `down` real, 2 strikes, contadores por capa).

**Ante un correo de alerta:** el correo ya dice la capa, la clasificación y la acción. Si dice `upstream` → esperar a NETOPIA, no tocar nada. Diagnóstico manual: `journalctl -t tricigo-proxy-health -n 30`; squid access.log con `TCP_TUNNEL/200` + ~25s = NETOPIA colgada (no squid); `SELECT key, value FROM platform_config WHERE key LIKE 'netopia_proxy_health%'`. El deploy de la EF es single-file via MCP `deploy_edge_function` (verify_jwt=false — el watchdog manda SOLO `x-proxy-alert-secret`, sin JWT; si verify_jwt quedara en true, el gateway 401ea los reportes del VPS). El script del VPS se aplica con `scp ops/squid/healthcheck.sh root@187.77.214.236:/etc/squid/healthcheck.sh`.

### Red de búsqueda de conductores — estado canónico (mig 00524, 2026-07-30)

**Contexto:** con ~6 conductores online (todos La Habana), la mitad de los viajes de jun-jul 2026 murió con CERO ofertas. Causas: techo de radio 10 km (escalera 5→7.5→10), límite top-10, filtro heartbeat 3 min, y **una-oferta-por-conductor-por-viaje para siempre** (`UNIQUE(ride_id, driver_profile_id)` + `ON CONFLICT DO NOTHING` — las rondas de retry solo alcanzaban conductores NUEVOS).

**Modelo actual (todo `platform_config`, editable en admin sin deploy):**
| Key | Default | Semántica |
|---|---|---|
| `dispatch_stage1_seconds` / `dispatch_stage1_radius_m` | 45 / 8000 | **Apertura por etapas (00525).** Los primeros 45 s el viaje se ofrece SOLO dentro de 8 km (≈24 min de espera al ritmo medido); después se abre a `dispatch_max_radius_m`. El radio depende de la EDAD del viaje (`v_ride.created_at`), no del caller. Cualquiera de las dos en 0 desactiva las etapas. **`stage1_seconds` debe ser ≤ `offer_ttl_seconds`**: si fuera mayor, el primer tick del cron de retry cae dentro de la etapa 1 y gasta una ronda en un no-op (el re-arm está bloqueado por `reoffer_cooldown_s`), retrasando la apertura hasta el tick siguiente. |
| `dispatch_max_radius_m` | **50000** (00526) | Tope de la etapa abierta. 0 = sin límite (era el default de 00524; **no volver a 0** — ver geofence abajo). Gobierna `dispatch_ride` Y `dispatch_searching_rides_for_driver` (el viejo tope escondido 15/10 km del trigger driver-online también obedece esta key). |
| `dispatch_offer_limit` | 0 | 0 = oferta a TODOS los elegibles en paralelo. >0 capea (para cuando haya cientos online). |
| `dispatch_heartbeat_window_s` | 0 | 0 = sin filtro de frescura GPS (revierte conscientemente el endurecimiento R5 #541 — con oferta paralela un fantasma no bloquea a nadie). >0 lo restaura. |
| `reoffer_cooldown_s` | 120 | Una oferta **expirada** se re-arma (`status→pending`, TTL fresco) en el siguiente retry una vez pasado el cooldown → el conductor distraído vuelve a sonar cada ~2-3 min. **`rejected` JAMÁS se re-ofrece.** El push del re-arm lo dispara `trg_notify_driver_reoffer` (AFTER UPDATE expired→pending, reusa `notify_driver_new_offer()`). El APK renderiza re-arms vía el poll de 30s (el realtime del driver ignora UPDATEs que quedan pending). |
| `searching_abandon_seconds` | 600 | El pasajero puede backgroundear la app 10 min sin que se cancele la búsqueda (`cleanup_orphan_searching_rides` ya leía la key; antes no existía → default 180). |
| `reactivation_push_after_s` / `_cooldown_s` / `_enabled` | 60 / 1800 / true | Push a conductores **aprobados+offline** del tipo de vehículo pedido ("Un pasajero está buscando triciclo — Conéctate…"), corre dentro del cron `retry-dispatch-expired-rides` (cada 1 min) vía `notify_offline_drivers_for_searching_rides()`. Cooldown por conductor en la tabla `driver_reactivation_pushes` (RLS sin policies = lock-table). Categoría push `ride_matching` (whitelisteada, pref `ride_updates`, tap = abrir app). SIN filtro geográfico — decisión explícita del usuario con toda la flota en Habana; **deuda consciente:** agregar radio cuando haya oferta multi-provincia. |
| `offer_ttl_seconds` | **60** | 30 → 45 (00524) → 120 a mano el 30/07 (un conductor había quedado con ~11 s útiles: el push llegó 19 s dentro de una ventana de 30 s) → **60** en 00526. 120 sobre-corrigió: el retry **no re-despacha mientras haya una oferta pendiente**, así que un TTL de 120 s empujaba la apertura de la etapa 2 a los 2-3 min. Al tocar este valor, recordá que **gobierna de facto cuánto dura la ventaja de los cercanos**. |

**Geofence de Cuba (00526) — invariante, no tunable.** `find_best_drivers` exige que el GPS del conductor esté dentro del bbox `lat 19.3..23.7 / lng -85.2..-73.8` (**el mismo bbox del stack de search** — mantener UNA sola definición de "dentro de Cuba"); `notify_offline_drivers_for_searching_rides` aplica el mismo filtro pero **deja pasar `current_location IS NULL`** (conductor recién instalado sin GPS aún es un objetivo legítimo del aviso). Motivo verificado en prod 2026-07-31: el único conductor online en ese momento reportaba GPS en **Ciudad del Este, Paraguay (−25.46 / −54.59), a 6155 km**, y un dispatch rolleado confirmó que con `dispatch_max_radius_m=0` se le creaba oferta real de un viaje en La Habana. "Sin límite" significaba "cualquier punto del país", nunca "otro continente". Cinturón + tirantes deliberado: el geofence caza al que está dentro de 50 km pero en otra isla; el tope caza al que está dentro del bbox pero absurdamente lejos (viaje en La Habana, conductor en Guantánamo ≈ 900 km).

**Invariantes que NO cambiaron:** tipo de vehículo estricto (decisión explícita — sin fallback cross-vehículo), precio/paridad snapshot, gate low-rating rider (1ª ronda restringida), gate un-viaje-activo, exclusión `user_blocks`, fleet restriction.

**Cómo verificar sin molestar conductores reales:** todo dentro de `BEGIN; … ROLLBACK;` — `net.http_post` encola en `net.http_request_queue` (transaccional) → el rollback cancela los pushes. INSERT de un ride searching dispara el dispatch síncrono en la misma txn; se asserta `ride_offers` y se rollbackea. Patrón completo en `docs/superpowers/plans/2026-07-30-driver-network-expansion.md` (Task 5).

**Costo de la espera (medido, no estimado — usar estos números al discutir radios):** en La Habana el trayecto al pickup corre a **~3 min/km** (triciclo y auto por igual). Las ofertas aceptadas históricamente promedian **1.2 km** (4-10 min de espera). Los dos casos largos del historial: **9.7 km → 33 min** (se completó) y **6.9 km → 21 min** (se canceló). De ahí sale el radio de etapa 1: 8 km ≈ 24 min (elegido por el usuario 2026-07-31 sobre una alternativa de 5 km, priorizando que un cercano alcance a tomarlo). Un conductor a 20 km implicaría ~60 min y el pasajero ya está comprometido (dejó de buscar; su única salida es cancelar y empezar de nuevo). Mitigaciones que YA existen: la tarjeta del conductor muestra "AL RECOGER X KM" + un indicador de rentabilidad (ganancia neta ÷ km al recoger), y el pasajero ve el ETA y puede cancelar sin castigo en la ventana de gracia de 120 s. La preferencia por-conductor `max_distance_km` existe y `find_best_drivers` la respeta, pero **0 de 72 conductores la tiene configurada** — válvula sin usar.

**Si el matching se comporta raro:** 1) leer las keys (`SELECT key, value FROM platform_config WHERE key LIKE 'dispatch%' OR key LIKE 'reoffer%' OR key LIKE 'reactivation%'`); 2) recordar que `dispatch_ride(p_ride_id, p_radius_m)` **ignora `p_radius_m`** desde 00524 (vestigial, solo compat de firma); 3) los re-arms NO incrementan el contador "offered" (`tg_ride_offer_increment_offered` es INSERT-only); 4) si un viaje recién creado no le llega a un conductor lejano, es la etapa 1 haciendo su trabajo — se abre a los 45 s.

### Conductores que se caen solos de línea — diagnóstico canónico (2026-07-31)

**El fenómeno, medido:** en 7 días hubo **142 desconexiones FORZADAS vs 56 manuales** — el 72% de las veces que un conductor sale de línea, no lo pidió. Afecta a 15+ conductores (William 16 forzadas/0 manuales, Rey 14/0, Leonardo 9/0) ⇒ sistémico, no un dispositivo. La sesión mediana que muere forzada dura **37 min**. El heartbeat se corta **en seco** (Leonardo: 45 min de latidos cada 60 s → silencio absoluto → cron a los 14.7 min), sin degradación ni reintentos ⇒ **el proceso de la app deja de ejecutarse**; NO es red intermitente (esa deja huecos y recuperaciones).

**La herramienta para investigarlo: `audit_log`.** Guarda cada UPDATE de `driver_profiles` con `old_values`/`new_values`/`changed_by` (~10k filas/día) → reconstruye el historial completo de heartbeats de cualquier conductor. **El discriminador es `changed_by IS NULL` = lo hizo el cron (service-role) ⇒ desconexión FORZADA**; con uuid = el conductor tocó el switch. Sin ese campo no se puede distinguir "se fue" de "se cayó".

**Mecánica.** Heartbeats: `(tabs)/index.tsx` setInterval **120 s** (`.update()` directo) + `useDriverLocation` + el background task (RPC `driver_heartbeat`, throttle 55 s). Corte: cron 10 `auto-offline-stale-drivers` (cada 5 min) → desde 00527 llama a `auto_offline_stale_drivers()`, que además **avisa al conductor por push** (`driver_offline_after_minutes`=10, `driver_offline_notice_enabled`). Antes era un `UPDATE` crudo y **el conductor no se enteraba de nada**. Desde 00529 el push va por `cron_http_post` (labels `driver-offline-notice` / `driver-reactivation-push` en `cron_http_calls`) → el watchdog de crons LO VE fallar; 00527/00528 lo habían dejado con `net.http_post` crudo (violando la regla dura de cron→EF) y la entrega era invisible. **Aviso ≠ push en el celu:** si el conductor no tiene fila en `user_devices` (clase #853, push no re-registra), el aviso queda solo en el buzón in-app — verificado: 2 de 6 avisados de la primera noche no tenían token.

**Causa raíz PROBABLE (sin confirmar).** El foreground service que mantiene vivo el JS arranca solo si el conductor concedió ubicación **en segundo plano ("Siempre")** — el propio código: "startBgLocationTracking whenever the driver is ONLINE **AND background permission is granted**", y el disclosure ofrece "Más tarde" que lo saltea. En Android 11+ ese permiso **no se concede desde el diálogo del sistema**: hay que entrar a Ajustes a mano, y muy poca gente completa ese 2º paso. **Ya descartado:** manifest y config correctos (`FOREGROUND_SERVICE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, expo-location con `isAndroidForegroundServiceEnabled`, targetSdk 36) y el fix del foreground service existe desde #791 (2026-07-12) — el código está bien escrito, no falta nada ahí.

**Verificación pendiente (10 segundos, sin código):** preguntarle a un conductor conectado si ve la notificación fija *"Estás en línea. Podés recibir viajes con la app en segundo plano"*. Si NO la ve ⇒ el foreground service no corre ⇒ confirmado. Equivalente: Ajustes → Apps → TriciGo Conductor → Permisos → Ubicación; si dice "solo mientras se usa la app", confirmado. Alternativas que ese dato también descartaría: swipe-kill del usuario (mata el foreground service en la mayoría de OEM) y optimización de batería del fabricante (Xiaomi/Huawei).

**Interacción con el dispatch:** `dispatch_heartbeat_window_s=0` (00524) deja elegible al conductor con la app muerta durante los 10-15 min hasta que el cron lo saca. Medido: 0 de 14 ofertas en 7 días cayeron en esa ventana (volumen bajísimo), pero el riesgo crece con la demanda — si aparece, subir esa key a >0 lo cierra sin migración.

### El 74 % de la gente que usa TriciGo no puede recibir un push (medido 2026-09-08, mig 00585)

**El embudo de por qué mueren los viajes.** De 220 viajes: 29 completados (13 %), 20 cancelados ya con conductor, **80 (37 %) recibieron ofertas que nadie tomó** y **89 (41 %) no generaron una sola oferta**. El matcher NO está roto: de los 137 conductores aprobados, **117 pasan todas las verjas** de `find_best_drivers` (vehículo activo, `is_financially_eligible`, `match_score`, geofence, sin viaje en curso). La única que mata es `is_online` — en 14 días hay **1,7 conductores en línea de promedio** y el **35 % de las horas no hay nadie**.

**Las ofertas confirman que es alcance, no desinterés.** Ningún conductor rechazó una oferta jamás (`ride_offers.status`: 81 `expired`, 55 `superseded`, 29 `accepted`, **0 `rejected`**). Las aceptadas venían de conductores a **789 m** de mediana y se contestaron en **13 s**; las vencidas, de conductores a **4.300 m**. Y el pasajero abandona a los **132 s**, antes de que la segunda ronda pueda salir (`offer_ttl_seconds`=60 + `reoffer_cooldown_s`=120).

**La causa alcanzable: 67 de los 91 conductores que trabajaron en 30 días no tienen fila en `user_devices`.** Prueba en vivo en los logs de la EF: `[send-push] summary: sent=11 failed=0 total_tokens=11 targets=51`. Y **52 de las 81 ofertas vencidas** fueron a conductores sin token.

**Descartado con evidencia (no repetir el camino):**
- *Los tokens se borran* (`DeviceNotRegistered` → `DELETE` en `send-push:423`): `failed=0` en todos los envíos recientes y **cero** líneas `Cleaned N dead token(s)`.
- *Preferencias*: `ride_offer` está en las categorías **no filtrables** de `FILTERABLE_CATEGORY_TO_PREF`; una oferta se entrega siempre.
- *Esquema/RLS*: `UNIQUE (user_id, push_token)` existe y las políticas `ud_own`/`ud_admin` son correctas (una policy `FOR ALL` sin `WITH CHECK` reusa el `USING`, así que el upsert propio pasa).
- *Bug de la app del conductor*: **pasajeros 28 % con token vs conductores 26 %** — idéntico, o sea que es el camino compartido de permiso/registro, no una app. Ese test diferencial es el que ordena el diagnóstico; hacerlo primero.
- *El soft-ask de agosto lo empeoró*: **descartado el 2026-09-08 por falta de n, RESUCITADO Y CONFIRMADO el 2026-09-10 con la medición correcta** — ver abajo. La lectura vieja comparaba cohortes crudas (n=38 y n=21) sin normalizar exposición.

**La corrección (2026-09-10): NO es un 74 % plano, es una caída con fecha.** Comparar cohortes por "¿tiene token hoy?" está sesgado — un usuario de julio tuvo dos meses de aperturas para conceder el permiso y uno de septiembre tuvo días. La métrica honesta es **la misma ventana para todos: ¿consiguió token dentro de los 7 días de su alta?** (y descartar cohortes con menos de 7 días de antigüedad, para que la ventana esté completa):

| Cohorte de alta | Usuarios | Con token en 7 d |
|---|---|---|
| junio | 12 | **50 %** |
| julio | **302** | **24 %** |
| agosto | **209** | **7 %** |
| septiembre | 14 | 7 % |

Julio→agosto es 24 %→7 % con n=302 y n=209: no es ruido. Los **dos roles caen juntos** (conductores que usaron la app de verdad: julio 31/99, agosto 7/73, septiembre 3/36), lo que descarta un bug de una app. Y el registro **no está roto** — entran ~33 tokens por mes, el último de conductor el 2026-09-08.

**Lo que cambió en ese borde:** la app dejó de preguntar. Un `requestPermissionsAsync()` incondicional en el primer arranque fue reemplazado por el soft-ask sheet como ÚNICO camino. El sheet es bueno **recuperando** (deep-link a Ajustes, que es la única vuelta posible tras una negación) pero como único preguntador junta un tercio de las concesiones: cuesta dos taps y un modal se descarta por reflejo.

**Trampa de método que casi arruina la medición dos veces:** (1) cohortes sin normalizar exposición dan una pendiente monótona aunque el comportamiento sea constante; (2) el corte semanal muestra conductores en **0 %** cuatro semanas seguidas, que parece un corte brutal y es solo n≈13 por semana — el agregado mensual lo desmiente. Mirar siempre las dos escalas antes de concluir.

**El arreglo (decisión del usuario 2026-09-10):** volver a preguntar, pero **con sesión iniciada**, no en el arranque en frío como julio. El gate es `shouldSpendPushPrompt` (`packages/utils/src/pushRegistration.ts`, con tests): gasta el prompt de una sola vez **solo mientras el permiso está `undetermined`**. Una negación NUNCA re-pregunta — `requestPermissionsAsync()` ahí resuelve al instante con la misma respuesta y el usuario no ve nada, o sea que parecería que se pregunta mientras se juntan cero concesiones; esos van al deep-link del sheet. Cableado en `useNotificationSetup` de los dos apps.

**Bug concreto arreglado de paso:** el sheet del conductor leía `userId` del closure de render, pero el sheet aparece **1500 ms después del montaje** y el store de auth puede no haber hidratado todavía. En esa ventana caía a un `requestPermissionsAsync()` pelado: preguntaba, **no guardaba token**, y después quemaba el cooldown de 7 días — un conductor que decía que sí quedaba incomunicado una semana sin segunda oportunidad. Ahora el id se lee en el momento del tap (`useAuthStore.getState()`).

**Lo que quedaba y no se podía medir:** el permiso del SO nunca se concedió — pero *denegó*, *nunca se le preguntó* y *falló el registro* se ven **exactamente igual** desde el servidor, porque `user_devices` solo registra ÉXITOS. `registerPushTokenForUser` ya calculaba el motivo y devolvía `'registered' | 'denied' | 'error'`, y **sus tres llamadores tiraban ese valor**, dentro de un `catch {}`. Es la misma clase que "un fallback que nunca se ejerció no es un fallback": lo que no se escribe, no existe.

**00585 lo cierra**: tabla `push_registration_status` (PK `(user_id, app)`) con `outcome` ∈ `registered | never_asked | denied | blocked | error` — `never_asked` = bug nuestro, `blocked` = solo Ajustes lo recupera (Android 13+ no vuelve a preguntar), `error` = plomería rota. El helper puro es `classifyPushPermission` (`packages/utils/src/pushRegistration.ts`): **`canAskAgain` es el campo que decide**, no `status`. Vista `driver_push_reachability` (`security_invoker`) para ver hoy mismo quién está incomunicado, sin esperar ninguna app.

**Dos reglas al instrumentar algo así:** (1) la telemetría corre DENTRO del `try` del que mide, así que si puede lanzar convierte un registro exitoso en `'error'` — la medición corrompiendo su propio número; `report()` es fire-and-forget y `recordPushRegistration` no lanza nunca (ni siquiera si falta la tabla). (2) **No cambies el tipo de retorno**: los llamadores comparan `result === 'denied'` (`apps/{driver,client}/app/profile/settings.tsx`); el outcome fino va al servidor, el retorno queda igual.

**Límite honesto:** esto solo produce datos en los teléfonos que instalen un APK nuevo. La comprobación de 10 segundos que confirma la hipótesis sin código: Ajustes → Apps → TriciGo Conductor → Notificaciones.

**Consultas canónicas:**
```sql
-- ¿quién no puede recibir una oferta?  (funciona sin tocar las apps)
SELECT full_name, phone, is_online, push_tokens, last_registration_outcome
FROM driver_push_reachability WHERE push_tokens = 0 ORDER BY is_online DESC;

-- desconexión forzada vs manual: changed_by IS NULL = lo hizo el cron
SELECT count(*) FILTER (WHERE changed_by IS NULL) AS forzadas, count(*) AS total
FROM audit_log WHERE table_name='driver_profiles' AND created_at > now()-interval '30 days'
  AND (old_values->>'is_online') IS DISTINCT FROM (new_values->>'is_online')
  AND NOT (new_values->>'is_online')::boolean;

-- distancia de las ofertas aceptadas vs vencidas (la economía del alcance)
SELECT status, count(*), round(percentile_cont(0.5) WITHIN GROUP (ORDER BY distance_m)::numeric,0) AS mediana_m
FROM ride_offers GROUP BY 1;
```

### La búsqueda NO tiene deadline en el servidor — el cartel de "no hay conductor" era mentira (verificado 2026-09-10)

**`searching_abandon_seconds` NO es "cuánto busca el servidor".** Es la ventana de ABANDONO: `cleanup_orphan_searching_rides` solo cancela viajes cuyo `searching_seen_at` quedó viejo, o sea cuando la app del pasajero **dejó de mirar**. Mientras la pantalla de búsqueda está arriba, `useRideInit` late cada 30 s (`touch_searching_ride`) y esa columna nunca envejece. Y `retry_dispatch_expired_rides` (cron cada minuto) re-despacha **sin tope alguno**: cualquier viaje `searching` cuyo último despacho tenga >30 s y sin oferta viva. Igual `notify_offline_drivers_for_searching_rides`. **Conclusión: con la app abierta, la búsqueda es ilimitada.**

**La app decía lo contrario.** Cliente y web declaraban `searchTimedOut` a los **120 s hardcodeados** y reemplazaban toda la pantalla por "No encontramos conductor" + botón "Reintentar búsqueda" — que llamaba `requestEstimate()` y **no reiniciaba nada**, porque no había nada que reiniciar.

**Medido contra prod (2026-09-10):**

| Señal | Valor |
|---|---|
| Aceptación real (`ride_offers.responded_at − rides.created_at`, n=29) | p50 **29 s** · p75 72 s · p90 145 s · máx **1256 s** (completó) |
| Aceptados DESPUÉS de los 120 s | **6 de 29 (21 %)** |
| Viajes que recibieron una oferta **nueva** pasados los 120 s | **19 de 111** (la más tardía a 690 s) |
| Cancelaciones del pasajero entre 122 s y 179 s | **27** — el minuto que se abre justo cuando aparece el cartel |

**Trampa de datos que casi arruina la medición:** `rides.accepted_at − created_at` da p50 = 120 s, y eso es **un artefacto**: 14 viajes sembrados de junio están en exactamente 120 s y 6 en exactamente 180 s, ninguno con fila en `ride_offers`. Filtrar a los que tienen una oferta aceptada real los saca. **Si una distribución te sale en números redondos, sospechá de datos sembrados antes de creerle.**

**Lo que se hizo (PR #996):** se eliminó el estado de timeout en las dos superficies. La espera ahora se narra por etapas puras (`packages/utils/src/searchWait.ts`, `searchWaitStage`): `opening` (<15 s) fija expectativa, `normal` (15-44 s) calla, `extended` (45-179 s) tranquiliza, `long` (≥180 s, apenas sobre el p90) admite que va lento **y dice qué está haciendo el despacho**. La barra llena sobre `SEARCH_TYPICAL_WAIT_S`=120 s (79 % de los aceptados caen adentro) y después pasa a un barrido indeterminado — una barra llena sobre una búsqueda viva se lee como "terminado". La salida del pasajero sigue siendo el botón Cancelar, que ya lleva su propio cronómetro.

**Regla general:** antes de poner un deadline en el cliente, verificá con `pg_get_functiondef` **vivo** si el servidor tiene alguno. Un timeout de UI que no corresponde a un timeout real no es una salvaguarda, es una mentira con botón.

### Un no-op se vuelve regresión cuando el fix lo hace real (verificado 2026-08-06, #926 → PR de revisión)

**Clase de bug, no incidente aislado.** #926 des-condicionó el arranque del foreground service del permiso "Siempre", así que por fin corría. Pero `useDriverRide.ts` lo **detenía** desde 4 lugares al terminar/cancelar un viaje (`stopBgLocationTracking`, líneas 241/859/875/1073) con el conductor todavía en línea. Mientras el servicio no arrancaba nunca, esos stops eran inocuos. Al volverse real, cada finalización de viaje mataba el único latido que sobrevive con la pantalla apagada → el cron sacaba al conductor de línea 10 min después. **El fix creó exactamente el síntoma que venía a eliminar**, y por eso la métrica no se movió (2,16 → 2,06 desconexiones forzadas por conductor y por día, sin mejora).

**Regla:** cuando enciendas algo que estaba apagado de hecho, **buscá todos los sitios que lo apagan** (`grep` del `stop*`/`disable*`/`clear*` correspondiente) y revisá si alguno era inocuo solo porque el sistema estaba muerto. Vale para servicios, suscripciones, timers y flags.

**Dos trampas específicas de este caso, ambas reutilizables:**
1. **Un viaje terminado sigue teniendo `id`.** El store CONSERVA el viaje `completed` para la pantalla de ganancias, así que `activeTrip?.id` no cambia al finalizar → el efecto de `[driverId, isOnline, activeRideId]` **no vuelve a correr** y nada reinicia nada. Si derivás una dependencia de un viaje activo, filtrá los estados terminales (`completed`/`canceled`) — ver `index.tsx` `trackedRideId`.
2. **Desatar ≠ detener.** Para "que no siga subiendo contra este ride_id" alcanza con `demoteBgLocationToOnline(driverId)` (persiste ctx con `rideId: null`; la tarea sale temprano en `if (!ctx.rideId) return;` **después** del latido). `stopBgLocationTracking()` queda solo para online→offline y desmontaje.

**Métrica de verificación** (línea base ~2,1/conductor/día): `audit_log` con `table_name='driver_profiles'`, `changed_by IS NULL` = lo hizo el cron ⇒ desconexión forzada; con uuid = el conductor tocó el switch.

### La base colapsó por dos tablas de historial sin retención (verificado 2026-08-31, migs 00576/00577)

**El dueño tuvo que reiniciar la base porque colapsó.** Los logs de Postgres retienen 24 h y el reinicio ya los había tapado, así que la causa exacta no se pudo confirmar — pero la medición dejó un candidato dominante y sin discusión.

| Señal | Valor medido |
|---|---|
| Base completa | 2141 MB |
| `audit_log` | **1178 MB (55 % de la base)** — 413.691 filas, **+4.870/día** |
| `cron.job_run_details` | **306 MB** — 951.450 filas, **+5.482/día** |
| Conexiones | **36 de 60** ocupadas en reposo (pools internos de Supabase) |

Esas dos tablas son el **69 % de la base** y crecían **~15,7 MB/día sin techo**. El proyecto tiene 8 crons de limpieza (`otp_codes`, `rpc_attempt_log`, `notifications`, `ride_location_events`…) y **ninguno tocaba estas dos** — eran las únicas sin retención.

**Por qué `audit_log` era tan grande.** De sus 413.691 filas, **408.842 (98,8 %) eran de `driver_profiles`**: los latidos de GPS. Cada latido es un UPDATE y `record_audit()` guardaba el perfil entero DOS veces (`old_values` + `new_values` jsonb) → ~2,8 KB por latido. Desglose por conjunto de columnas que cambian (7 días):

```
last_heartbeat_at                 53,3 %   telemetría
current_heading, current_location 41,1 %   telemetría
(ninguna: UPDATE que no cambió nada) 4,0 %  ruido puro
auto_offline_at, is_online         0,9 %   ← SEÑAL
is_online                          0,2 %   ← SEÑAL
resto (status, approved_at…)       0,2 %   ← SEÑAL
```

**Qué se conserva.** Las filas de `is_online`/`auto_offline_at` — o sea el diagnóstico de desconexión forzada (`changed_by IS NULL` = lo hizo el cron) que usa la sección de conductores que se caen solos — quedan **intactas y completas**. El historial de latidos se movió a `driver_heartbeat_log` (3 columnas, ~50 B/fila en vez de 2.800): misma capacidad forense al 2 % del costo.

**Patrones reutilizables:**

1. **Al auditar por trigger, el criterio NO es una lista de columnas a ignorar sino comparar la fila ENTERA menos la telemetría:** `(to_jsonb(OLD) - cols) IS NOT DISTINCT FROM (to_jsonb(NEW) - cols)`. Si lo que queda es idéntico, solo cambió telemetría. Cualquier cambio real hace que los restos difieran y la fila se audita completa — imposible perder una señal por olvidarse de listarla. Acotá el corto-circuito con `TG_TABLE_NAME` si la función es compartida (`record_audit()` la usan 5 tablas).
2. **Purgar SIEMPRE por tandas.** Un `DELETE` único de 400k filas sobre una tabla de 1,1 GB genera ~1,1 GB de WAL de un saque — la misma presión que ya tumbó la base. 20.000 filas por corrida horaria drenan el atraso en menos de un día sin un pico.
3. **La retención por antigüedad NO alcanza para un atraso reciente.** El bulto arrancaba hace 85 días, o sea que entraba cómodo dentro de 90 días de retención. Hacen falta dos reglas: retención general + retención corta específica para telemetría.
4. **`DELETE` no devuelve el espacio al disco.** Tras drenar, la tabla sigue ocupando lo mismo pero como espacio *reutilizable*: deja de crecer, que es lo que evita el colapso. Recuperar el GB exige `VACUUM (FULL, ANALYZE)` **a mano**: toma `ACCESS EXCLUSIVE LOCK` y, como 5 tablas escriben ahí por trigger, **frena la app** 1-2 minutos. No automatizarlo.
5. **`'texto' || NULL` es NULL: un correo HTML armado por concatenación se vuelve NULL entero si falta UN campo**, y se envía vacío sin que nadie se entere. Envolver toda interpolación en `COALESCE` y que el emisor se niegue a mandar cuerpo vacío. Lo cazó un test, no la revisión.
6. **Un helper de test que hace `IF NOT cond`** trata NULL como "no fallo" → imprime FAIL pero no lo contabiliza, y el resumen miente. Usar `IF cond IS NOT TRUE`.

**Cómo probar migraciones SQL de verdad sin tocar prod (verificado acá).** El sandbox trae `psql` **y** los binarios de Postgres 16 en `/usr/lib/postgresql/16/bin`. Postgres no corre como root, así que hay que crear un usuario (`useradd -m pgtest`) y poner el datadir en **su home** (`/tmp` da `Permission denied` con `su`). Si `pg_ctl start` falla con `could not create lock file "/var/run/postgresql/.s.PGSQL.5433.lock": Permission denied`, agregar `-c unix_socket_directories=/tmp` a las opciones (`-o`): los runners se conectan por TCP a `127.0.0.1`. Con un andamio de ~60 líneas (schemas `auth`/`cron`/`net`, `platform_config`, `get_platform_config_numeric`, `net.http_post` que INSERTA en una tabla en vez de mandar correos) se corre **la migración verbatim** y se le pasan tests de comportamiento. Así se encontró el bug del NULL. Ojo: no hay PostGIS ni pg_cron — simulá `cron.schedule`/`unschedule` y usá `text` donde prod tiene `geography` (válido cuando la columna se resta antes de comparar, o sea cuando su tipo no puede influir en el resultado).

**En Windows, sin sandbox (verificado 2026-09-25 con el ensayo de 00595 del #1018, que no entró a master).** La PC no trae `psql`, WSL ni Docker. Sirven los binarios portables de EnterpriseDB: `postgresql-16.14-1-windows-x64-binaries.zip`, 326 MB, de `get.enterprisedb.com`, sin firma Authenticode. Se descomprimen en el scratchpad sin pgAdmin, con `tar.exe -xf <zip> pgsql/bin pgsql/lib pgsql/share`.
- **Cluster:** `initdb -D <dir> -U pgtest -A trust -E UTF8 --no-locale` y `pg_ctl -D <dir> -o "-p 5433 -c listen_addresses=127.0.0.1" -l <log> -w start`. Esa llamada a `pg_ctl` **no vuelve**, porque postgres hereda el pipe de la herramienta, y la herramienta la pasa a segundo plano. El servidor queda arriba igual; comprobarlo con `pg_ctl status`.
- **El puerto puede ser del cluster de otra sesión** (verificado 2026-09-26). Varias sesiones levantan su Postgres en paralelo: el 5437 y el 5441 ya estaban tomados. `pg_ctl start` falló por el puerto, pero el `psql` siguiente respondió igual, porque le contestaba el cluster de otra sesión, y un `run.sh` ahí le habría borrado las bases. Antes de arrancar, elegir un puerto que no aparezca en `netstat -ano | grep LISTENING`; después, confirmar que el PID que escucha en ese puerto es el de la primera línea de `<datadir>/postmaster.pid`.
- **Mensajes:** `--no-locale` deja `lc_messages=C`, así que los errores del servidor salen en inglés y los `grep` de los `run.sh` funcionan. psql igual traduce sus etiquetas (`SUGERENCIA`, `CONTEXTO`).
- **Codificación (verificado 2026-10-06):** con la salida redirigida (`>/dev/null`, como en los `run.sh`), `psql.exe` lee los `.sql` en la página de códigos de la consola y no en UTF-8. Una `á` llega como dos caracteres y el cuerpo de la función queda un carácter más largo: el guard de 00612 dio md5 `7455d6de…/1967` en vez de `36862c0b…/1966`, 00613 se negó a reemplazarlo y los ensayos de 00613 y 00614 cortaron con "scaffold failed" o "migration failed". Sin la redirección da bien, así que parece aleatorio. Se arregla con `export PGCLIENTENCODING=UTF8` antes del ensayo (`supabase/tests/00614/run.sh` ya lo hace). El de 00613 necesita además `LC_MESSAGES=C`, porque H3 busca la etiqueta `DETAIL:` y psql la traduce a `DETALLE:`. Con las dos variables pasa 28/28.
- **Los `run.sh` de master no corren tal cual.** Fijan `BIN=/usr/lib/postgresql/16/bin`, llaman a `python3` (en Windows el ejecutable es `python`) y comparan la salida de psql, que en Windows termina cada línea en `\r\n`. El ensayo del #1018 corrió con esas tres cosas resueltas: `BIN` apuntando a `pgsql/bin`, `python`, y un `tr -d '\r'` sobre cada salida de psql. Para correr uno de master, usar una copia en el scratchpad con los mismos tres cambios. La excepción es `supabase/tests/00599/run.sh`, que toma `PGBIN`, `PGPORT` y `PYTHON` del entorno y quita el `\r` él mismo: `PGBIN=<scratchpad>/pgsql/bin PGPORT=<puerto> PYTHON=python bash supabase/tests/00599/run.sh ...`.
- **Trampa CRLF (copias sacadas antes de #1021):** con `core.autocrlf=true`, esas copias tienen los `.sh` y `.sql` de `supabase/` en CRLF. El bash de Git for Windows los corre igual y **las pruebas de comportamiento pasan**. Lo que falla es todo chequeo de md5, porque los `\r` que caen dentro del cuerpo de cada función se guardan con él, y el resultado **parece deriva contra prod cuando son solo finales de línea**. Pasa lo mismo si se aplica una migración a prod desde una copia así: la función anda, pero su md5 ya no es el del archivo en git. También falla en falso `pnpm check:poi-taxonomy`: dice que el mapper de 00581 difiere y pide una migración nueva que no hace falta.
  - **Desde #1021** (verificado 2026-09-25), `.gitattributes` fuerza LF en `supabase/tests/**/*.{sh,sql,psv}` y `supabase/migrations/*.sql`, así que un worktree nuevo ya sale bien.
  - **Una copia vieja no se corrige sola.** `git status` sigue limpio, y `git checkout --` o `git restore` no reescriben los archivos que no cambiaron. Si no hay cambios sin commitear en esas carpetas, borrar los archivos rastreados y volver a sacarlos: `git ls-files -z supabase/tests supabase/migrations | xargs -0 rm --` y después `git checkout -- supabase/tests supabase/migrations`.
  - Antes de correr un ensayo, comprobar que `git ls-files --eol supabase/tests/<n>/` diga `w/lf`. Para contar los `\r` a mano, usar `tr -cd '\r' < archivo | wc -c` o `grep -U`: el `grep` de Git Bash quita los `\r` de los archivos de texto y siempre da 0.
- **Al terminar:** `pg_ctl -D <dir> stop` y borrar la carpeta.

**Watchdog de salud (00577).** `check_database_health()` cada hora (muestra + alerta **solo en transición** ok↔warn↔critical, patrón 00503) y `send_db_health_digest()` diario a las 07:30 UTC al `business_notification_email`. Es SQL puro y no una Edge Function por la misma razón que 00503: si la base está por colapsar, la EF puede no conseguir conexión justo cuando hay que avisar. El aviso temprano real es la **proyección**: con 7 días de muestras calcula MB/día y pasa a `warn` cuando faltan ≤14 días para el umbral, *antes* de cruzarlo. `db_size_warn_mb`/`crit_mb` (6000/7500) son el **único número asumido y no medido** — Postgres no conoce el tamaño del disco que le dio Supabase; ajustar si el disco real es otro.

### Tercera tabla de historial sin retención: `admin_actions` (verificado 2026-10-06, mig 00606)

**Síntoma:** el inicio del panel daba 500 de vez en cuando (`PostgREST; error=57014`, tiempo agotado) en `admin_actions?admin_id=eq.<plataforma>&order=created_at.desc&limit=6`. La página se traga el error y muestra la lista vacía, así que solo se ve en `edge_logs` (`response.headers.proxy_status`).

**Causa:** `tg_platform_config_audit` (00603) guarda una fila por cada UPDATE de `platform_config`, y los vigilantes guardan ahí su "última revisión" (`*_at`, `*_detail`) en cada corrida. Eran 168.881 filas, el 99 % latidos a nombre de la cuenta de plataforma (el respaldo cuando no hay JWT), unas 2.000 por día, sin más índice que la PK. Además `aa_select` evaluaba `is_admin()` (plpgsql desde 00592) una vez por fila: 3,3 s en caliente.

**Arreglo (00606):** el trigger no audita un UPDATE automático (sin JWT) sobre una clave de telemetría (`_platform_config_is_telemetry`: termina en `_at` o `_detail`, o es `weather_last_check`). Lo que escribe una persona y todo INSERT o DELETE se siguen auditando. Además se borraron los latidos guardados, hay índices `(admin_id, created_at DESC)` y `(created_at DESC)`, y `aa_select` usa `(SELECT is_admin())`. Ensayo: `supabase/tests/00606/run.sh`.

**Estado:** aplicada en prod el 2026-10-06, en partes: `_part1` (función, trigger y política), `_part3_indexes`, el `DELETE` de la sección C (corrió, pero sin registro en `schema_migrations`; ver § "Aplicar migraciones pesadas por MCP") y `_part4_assert` (las aserciones y la prueba del trigger, que pasaron). Medido después con el mismo admin: el widget del inicio tarda 2,0 ms (antes 3,3 s) y la página de auditoría 2,4 ms. Quedan 2.764 filas, con las 1.332 de personas intactas. El archivo sigue ocupando 83 MB porque el espacio queda para reusar, como estaba previsto.

**Reglas:**
- Un vigilante nuevo que guarde su estado en `platform_config` nombra sus claves de latido con `_at` o `_detail`, así no se auditan. Una configuración que se edita a mano no lleva esos sufijos.
- Toda política RLS que llame a una función va envuelta en `(SELECT …)`, para que se evalúe una vez por consulta y no una vez por fila. Con `is_admin()` en plpgsql la diferencia es grande.
- Para encontrar la próxima tabla de este tipo: `SELECT relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid)) FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 10` y preguntar, por cada una, quién la poda.

### Cuarta tabla de historial sin retención: `rate_limits` (verificado 2026-10-07, mig 00636)

**Qué había:** 90.248 filas (19 MB) desde el 2026-06-07. 72.668 eran de una sola llamada del keepwarm de NETOPIA (`create-netopia-pi:44.234.196.74`, cada 2 min). `cleanup_rate_limits()` existía desde la 00105, pero ningún cron la llamaba.

**Tal como estaba, agendarla habría roto topes.** Borraba todo lo de más de 2 h, y `check_rate_limit` usa ventanas fijas de hasta 24 h: el tope diario de SMS al extranjero, el SOS por día, el aviso de dispositivo nuevo, y desde la 00635 los regalos y el correo a contactos de confianza. Borrar la fila de una ventana abierta reinicia su contador. En el ensayo (W2), un tope diario ya alcanzado pasaba de `allowed=false` a `allowed=true` después de una limpieza.

**Desde la 00636:**
- `cleanup_rate_limits(p_batch DEFAULT 20000)` conserva 30 días, borra lo más viejo primero, de a 20.000 por llamada, y devuelve cuántas filas borró.
- La decisión de 30 días es del dueño: las filas son evidencia forense (count − límite = llamadas rechazadas con 429, por función e IP).
- El cron `cleanup-rate-limits` corre a las :13 de cada hora. En régimen quedan ~45k filas (~1.490 por día × 30).
- La migración no borró nada: el atraso de 59k filas lo drena el cron en tres corridas.
- **Si se agrega un `check_rate_limit` con una ventana de más de un par de días**, revisar `c_keep` en la función: tiene que quedar muy por encima de la ventana más larga.

**Una función que corre por cron no se traga sus errores.** Si su bloque principal tiene `EXCEPTION WHEN OTHERS` y devuelve normal, pg_cron registra la corrida como `succeeded` y `check_cron_sql_failures` (00596) no la ve. Por eso `cleanup_rate_limits` no tiene handler (prueba E1 del ensayo). Medido el 2026-10-07: 17 de los 28 crons SQL llaman a funciones con algún `EXCEPTION WHEN OTHERS`, entre ellas los tres `prune_*` de la 00576 y casi todos los vigilantes. No todos lo tienen en el bloque principal (en un despacho por viaje, atrapar el error de una fila es correcto), así que hay que revisarlos uno por uno antes de concluir que el vigilante no los ve.

Ensayo: `supabase/tests/00636/run.sh` (RED: 14 fallos; GREEN 27/27, con 4 pruebas negativas de sus autochequeos).

**Estado: aplicada en prod el 2026-10-07** por MCP (`20261007233934`), sin espera de aprobación pese al `DELETE` en el cuerpo y al `DROP FUNCTION`. El cuerpo en prod es idéntico al del ensayo (md5 `507797d7…/622`). Las tres primeras corridas del job 70 (00:13, 01:13 y 02:13 UTC del 08/10) salieron `succeeded` en 304, 466 y 539 ms y dejaron la tabla en 31.098 filas, la más vieja del 2026-09-08.

### Toda alarma del proyecto vivía dentro de pg_cron, así que ninguna puede avisar de una caída de disco (verificado 2026-09-21, `ops/supabase-watchdog/`)

**El incidente.** El 2026-09-21, de 09:24 a 12:28 UTC (~3 h), la capa de almacenamiento se atascó. PostgREST devolvió 503 en `/rest/v1/rides` (215), `platform_config` (126), `driver_heartbeat` y `find_nearby_vehicles`; la latencia media por hora llegó a **51 s** y hubo respuestas de **125 s**. **No salió una sola alerta**: el dueño lo descubrió usando la app y reinició el proyecto a mano. Ya había pasado igual el **18** y el **20 de septiembre**.

**Por qué nadie avisó — y es estructural, no un olvido.** Las tres alarmas (`check_database_health` 00577, `check_exchange_rate_freshness` 00503, `check_cron_http_failures` 00507) las dispara **pg_cron**. Cuando el disco se atasca, pg_cron **no arranca sus workers** (98 × `cron job startup timeout` ese día) → ninguna corrió. `platform_config.db_health_status` quedó congelado en `'ok'` desde las 08:55 UTC. **Una alarma que vive dentro de lo que vigila no puede avisar que eso se cayó** — la misma clase que la ceguera de `cron.job_run_details`, un nivel más abajo: ahí el chequeo corría y miraba la señal equivocada; acá ni corre.

**Cómo encontrar caídas pasadas sin ninguna herramienta nueva** — cada hueco en un cron de 1 minuto es una ventana de caída, y `cron.job_run_details` guarda 14 días:

```sql
WITH r AS (SELECT start_time, lag(start_time) OVER (ORDER BY start_time) AS prev
           FROM cron.job_run_details WHERE jobid = 17)
SELECT prev AS caida_desde, start_time AS recupero,
       round(extract(epoch FROM start_time - prev)/60) AS minutos
FROM r WHERE start_time - prev > interval '4 minutes' ORDER BY prev DESC LIMIT 25;
```

**Es el disco, no la base — cómo distinguirlo (y no perder horas).** Todo lo interno estaba impecable durante la caída: 775 MB y bajando −198 MB/día, 13–26/60 conexiones, cache hit **99.76 %**, 0 transacciones largas, 0 `idle in transaction`, 0 deadlocks, ningún `too many clients` ni `out of memory`. Las dos pruebas que sí señalan al almacenamiento:
- **Checkpoints:** `wrote 118 buffers, total=11.9 s` (normal) contra **`wrote 9 buffers, total=265.4 s`**. Escribir 9 buffers en 4 minutos no es carga de base de datos.
- **La misma función, 300× más lenta:** `cleanup_orphan_searching_rides` mide **240 ms** en `pg_stat_statements` y tardó **76.036 ms** durante el incidente, sin cambiar consulta ni datos.

Corolario: **`auto_explain` registra `duration: … ms plan:` con el plan VACÍO** cuando el disco está así (8 consultas de 336–510 s ese día). Un plan truncado no es un misterio de la consulta: es la señal de que ni el logger podía escribir.

**El arreglo (PR de esta sesión).** Dos watchdogs **fuera** de Supabase, porque el arreglo no puede vivir donde vive el bug:
- **Principal:** `ops/supabase-watchdog/healthcheck.sh` + timer systemd de **2 min** en el VPS. Sondea `/rest/v1/platform_config` (el camino exacto de las apps, es el que decide) y `/functions/v1/health-check` (**sobrevive a una base muerta** — verificado: el runtime de EF siguió corriendo toda la caída — y dice qué capa rompió). Estado en archivo local, alertas **directo a Resend/D7**, nunca por las EF `send-email`/`send-sms` (escriben en `email_sends`/`sms_log` → necesitan la base caída). `--selftest` obligatorio antes de programarlo.
- **Respaldo:** `.github/workflows/supabase-uptime.yml` cada 10 min desde GitHub, porque **el VPS es punto único de fallo**. Abre/cierra un issue y falla la corrida.
- **`slow` cuenta como caída.** Con respuestas de 125 s, una sonda de arriba/abajo habría dicho "arriba".

**Tres trampas que cazó la suite (`ops/supabase-watchdog/tests/run.sh`, 21 aserciones) y no la revisión:**
1. **Nunca `source` un archivo de config de alertas.** `ALERT_EMAIL_TO=a@x.com, b@x.com` sin comillas es un **prefijo de comando** para bash: la variable **nunca queda seteada** y todo aviso por correo se salta en silencio — justo el fallo que el watchdog venía a eliminar. Parsear con whitelist, no sourcear (y de paso, un typo en la config no ejecuta nada como root).
2. **`--selftest` imprimía "listo" sin enviar nada**, porque llamaba a `send_email` antes de su definición (en bash el orden es de ejecución). Un autotest que no verifica el envío es el bug que viene a cazar: ahora exige que un canal haya aceptado de verdad y sale ≠0 si no.
3. **`tr -d '\000-\037'` borra los saltos de línea** en vez de escaparlos → el correo de alerta llega como un párrafo corrido de 19 líneas pegadas. Convertirlos a `\n` literal.

Y dos del propio banco de pruebas, que son la lección de "verificar la superficie correcta" otra vez: el mock devolvía **200 a cualquier POST**, así que el caso "canal roto" nunca estuvo roto; y un `python3 mock.py` viejo seguía **sosteniendo el puerto**, de modo que los reinicios morían al bindear y las pruebas corrían contra código anterior (`ss -lptn 'sport = :8799'` lo delata; y `pkill -f mock.py` **se mata a sí mismo** porque el patrón coincide con el propio comando — matar por PID). Si un chequeo de seguridad da "permitido", confirmá primero contra qué está hablando.

**Confirmación independiente que ya estaba en el repo (y un tercer caso del mismo bug).** Los workflows programados de master fallan **exactamente** en los días de caída y pasan en los limpios — 6 de 6:

| Día | `sync-osm-delta` | ¿Hubo caída? |
|---|---|---|
| 16, 17, 19 sept | success | no |
| **18, 20, 21 sept** | **failure** (10:27 / 10:30 / 11:49 UTC, dentro de la ventana) | **sí** |

Y la causa en el log es literal: `{"code":"PGRST002","message":"Could not query the database for the schema cache."}`. O sea que **GitHub Actions ya veía las caídas**; nadie leía esos fallos como tal. Es la prueba de que la sonda desde GitHub funciona, y sirve de evidencia cruzada para el ticket con Supabase.

El tercer caso del bug: `sync-osm-delta.yml` y `sync-pois.yml` avisan de su propio fallo llamando a **`notify_ops_workflow_failure` en la base**, y se tragan el error (`|| echo "::warning::…"`). Cuando el workflow falla *porque* la base está caída, el aviso falla también. Queda cubierto de hecho por `supabase-uptime.yml` (la caída ahora se reporta por su cuenta), así que **no** se tocaron esos dos workflows: hacen syncs de datos de producción y el hueco efectivo ya está cerrado. Si algún día se quiere cerrar del todo, el patrón es el de `supabase-uptime.yml`: abrir un issue cuando la RPC no contesta, en vez de degradar a `::warning::`.

**Lo que NO hay que hacer:** subir `dispatch_*`/timeouts, tocar las migraciones de retención (00576/00577 funcionaron: la base bajó de 2.141 MB a 775 MB), ni buscar la consulta culpable. No hay una.

#### Causa confirmada por Supabase (ticket SU-480720, 2026-09-21): saldo de I/O de EBS agotado en un cómputo **Nano**

- **Soporte lo confirmó:** "your project went down due to EBS IO balance exhaustion". El proyecto seguía en **Nano**, herencia del plan Free (en Pro no se puede crear un Nano, pero no se auto-actualiza "por el downtime"). En Pro, Nano y Micro se facturan igual y el crédito de $10/mes cubre Micro entero: **subir a Micro es gratis**, con menos de 2 min de corte según la doc. La doc de Nano dice **"Max DB Size (Recommended) 500 MB" y la nuestra tiene 777 MB**; Micro es 2 núcleos ARM, 1 GB de RAM, hasta 10 GB.
- **Mecánica** (doc "High Disk I/O"): de Nano a Medium el disco tiene un saldo de ráfaga (*Disk IO Budget*); agotado, la instancia cae a su baseline y "may become unresponsive". El gráfico vive en Reports → Database (`Disk IO % consumed`): >1 % ya significa que ese día se superó el baseline; 100 % es lo que nos pasó. **El porcentaje del saldo no se ve desde SQL**: es una métrica de AWS que solo muestra el panel (no está entre las del endpoint de métricas). Los contadores de disco y memoria del servidor sí se ven (ver «Medir el disco y la memoria desde SQL», más abajo).
- **Lo que la base SÍ deja medir** (`pg_stat_io`, PG17, 9 h tras el reinicio): 161 MB leídos, 131 MB escritos por el checkpointer, 44 MB de WAL, ~15 IOPS de promedio. **El consumo de Postgres es minúsculo: lo que drena el saldo no son nuestras consultas.** Los tres inicios (18: 06:36, 20: 09:46, 21: 09:23 UTC = 02:36 / 05:46 / 05:23 en La Habana) son madrugada sin usuarios. El candidato que Postgres no ve es el **swap** — la doc lo lista primero: "Every Supabase project has 1GB of disk allocated for swapping" — en una caja de 0,5 GB con `shared_buffers` = 224 MB y ~30 conexiones de servicios internos. En Micro quedó medido el 2026-09-25 (ver más abajo): hay swap en uso y el disco del sistema lee 34 veces más que el de la base. Lo de Nano ya no se puede medir, porque los contadores se reinician con el servidor.
- **Descartados con timestamps:** el sync de OSM (GitHub retrasa el cron de 06:00 a ~10:00–11:50 y **arrancó después** del inicio de cada caída: falló porque la base ya estaba caída, no la provocó) y el backup físico diario (`checkpoint starting: immediate force wait` = `pg_backup_start`, **todos los días a las 12:03–12:08 UTC**, o sea al FINAL de las ventanas; el 21 corrió a las 12:32 y 12:37, un minuto después del reinicio, porque el de las 12:05 no pudo).
- **Cómo fechar el inicio real:** los huecos de `cron.job_run_details` lo subestiman (el 18 dieron 07:18 cuando las primeras líneas `duration:` de las consultas de monitoreo de Supabase —`pg_ls_archive_statusdir`, `pg_ls_waldir`, `pg_database_size`, la CTE sobre `pg_stat_statements`— ya pasaban de 10 s a las **06:36**). Corren cada minuto y son operaciones de filesystem: si tardan >10 s el disco está atascado, y marcan el minuto exacto.
- **Trampa al leer checkpoints:** `write=` crece con los buffers porque `checkpoint_completion_target` duerme ~100 ms por buffer (61 buffers → 5,7 s y 282 → 28,6 s son NORMALES). La anomalía es un `total` muy por encima de 0,1 s × buffers (16 buffers / 33 s; 9 buffers / 265 s) o un `total − write − sync` de decenas de segundos.
- **Decisión:** Micro ya (gratis) → mirar 3 días el gráfico de Disk IO Budget → si sigue bajando de ~50 %, Small (+$5/mes neto, 2 GB, otro 2× de baseline). Cada escalón Nano → Micro → Small → Medium duplica el baseline de disco (tabla t4g de AWS: 43 / 87 / 174 / 347 Mbps y 250 / 500 / 1.000 / 2.000 IOPS, ráfaga común de 2.085 Mbps; **no verificada desde el sandbox** porque supabase.com y docs.aws están bloqueados por el proxy: se ve en Settings → Compute and Disk).
- **Micro aplicado el 2026-09-22 y verificado.** El usuario lo subió desde Settings → Compute and Disk. Mientras dura el cambio, `get_project` devuelve `RESIZING` y la base contesta `57P03 the database system is shutting down`. El corte que vieron las apps fue de **2 min 14 s** (23:46:59 → 23:49:13 UTC): 119 respuestas 520/521/522/525 de Cloudflare en `/rest/v1`, y un hueco de 3 min en el cron `jobid 17`. **Ningún conductor quedó fuera de línea**: los dos que estaban conectados volvieron a latir 7-10 s después del arranque.
- **Cómo saber desde SQL en qué cómputo estás.** El sandbox no llega a `supabase.co` (el proxy responde 403), así que todo pasa por MCP. Supabase deriva la configuración de la RAM, y `effective_cache_size` = 0,75 × RAM es la huella más limpia. `pg_postmaster_start_time()` marca el reinicio. Si cambia el arranque y `effective_cache_size` no, fue un reinicio sin upgrade: tratarlo como posible caída.

  | Setting | Nano (0,5 GB) | Micro (1 GB) |
  |---|---|---|
  | `effective_cache_size` | 384 MB | **768 MB** |
  | `shared_buffers` | 224 MB | 256 MB |
  | `work_mem` | 2184 kB | 3500 kB |
  | `maintenance_work_mem` | 32 MB | 64 MB |
  | `max_connections` | 60 | 60 |

- **Revisado el 2026-09-25, al cierre del plazo: por disco no hace falta Small.** Desde el paso a Micro el disco se usó en promedio a ~6 % del baseline, y no hubo un solo atasco. Lo que queda por vigilar es la memoria. Los números y cómo sacarlos, abajo.
- **Respuesta de soporte del 2026-10-01 (Lindsay Moss): mecanismo confirmado, más tres datos que la base no puede dar.**
  - Confirmó con métricas de AWS que durante las tres caídas `nvme0n1` era el root y `nvme1n1` el data, y que **el root tuvo muchísimo más I/O que `/data`** ("compared to your data volume 🦗🦗"). O sea que lo que drenaba el saldo era el swap y el page cache, no Postgres: confirma lo que ya se había medido en Micro.
  - **El saldo se agota de forma cíclica y se recarga cada 24 h.** No existe una "hora de inicio" de la caída de cada día: el consumo estaba sostenidamente por encima del baseline y el saldo simplemente llegaba a 0. Por eso las tres caídas caen en la misma ventana de la mañana sin que haya nada agendado ahí — no hay que seguir buscando el disparador.
  - **Baselines exactos de Micro: 500 IOPS y 11 MB/s**, contra la suma de lectura + escritura de los DOS discos. Es el número que faltaba para que los contadores `node_disk_*` sean un chequeo y no una curiosidad. La tabla por tier está en una nota interna que mandaron (`app.notion.com/p/supabase/Understanding-IO-Utilization-3eb5004b775f80ae9a52ea7637e04a9c`).
  - **El saldo de EBS no está expuesto en ninguna API** — ni el endpoint de métricas ni la Management API; dijeron que lo están discutiendo internamente, y quedó pedido formalmente en el ticket el 2026-10-03. Mientras tanto el proxy es IOPS y MB/s contra el baseline. Para los gráficos que mandaron: la integración de Grafana (`grafana.com/integrations/supabase/monitor`) o los partners de la Metrics API.
  - **Qué vigilar en memoria según ellos: `node_memory_Committed_AS_bytes`.** Hay picos de memoria prometida (algún proceso potencialmente caro) sin nada preocupante, pero es el gráfico que delata un crecimiento con el tiempo. Medido el 2026-10-03: **1,54 GB = 162 % de la RAM**.
  - Errata del correo, para no confundirse al releerlo: dice "much better than they were on the Micro" donde quiere decir **Nano**.

#### Medir el disco y la memoria desde SQL (verificado 2026-09-25)

El sandbox no llega al panel, pero la base sí llega al endpoint de métricas del propio proyecto (`/customer/v1/privileged/metrics`, texto Prometheus con los contadores de node_exporter). Se pide con `pg_net` y la clave se arma dentro de la consulta, así que nunca queda escrita:

```sql
-- 1) Pedir las métricas. encode(..., 'base64') mete un salto de línea cada 76
--    caracteres y un header HTTP no puede llevarlos: el replace() los saca.
SELECT net.http_get(
  url := 'https://lqaufszburqvlslpcuac.supabase.co/customer/v1/privileged/metrics',
  headers := jsonb_build_object('Authorization', 'Basic ' || replace(
    encode(convert_to('service_role:' || public.get_service_role_key(), 'UTF8'), 'base64'), E'\n', '')),
  timeout_milliseconds := 20000) AS request_id;

-- 2) Unos segundos después: ~400 KB de texto en net._http_response (se guarda 6 h).
SELECT line FROM net._http_response r, regexp_split_to_table(r.content, E'\n') AS line
WHERE r.id = <request_id>
  AND line ~ '^node_(disk_(read|written)_bytes_total|disk_(reads|writes)_completed_total|memory_(MemAvailable|Swap(Total|Free))_bytes|vmstat_(pswpin|pswpout|pgmajfault))';
```

- **Qué hay:** `node_disk_*` por disco, `node_memory_*`, `node_vmstat_pswpin` / `pswpout` (páginas de swap) y `pgmajfault` (veces que hubo que ir al disco por una página que no estaba en memoria). **Qué no hay:** el saldo de I/O de EBS, que es de AWS y solo sale en el panel.
- **Promedio:** los contadores arrancan con el servidor, así que se divide por el tiempo desde `pg_postmaster_start_time()` (la máquina arranca un par de minutos antes: el error es despreciable). **Uso actual:** dos pedidos separados por un minuto, y se resta.

Línea base, medida 66,5 h después del reinicio de Micro:

| Disco | Qué tiene | Leído | Escrito | Operaciones |
|---|---|---|---|---|
| `nvme0n1` → `/` (10,4 GB) | sistema, programas, swap | **110 GB** | 12 GB | 4,8 M |
| `nvme1n1` → `/data` (8,4 GB) | Postgres | 3,2 GB | 38 GB | 0,6 M |

- **Total: 0,68 MB/s y 23 operaciones/s de promedio**, ~6 % y ~5 % del baseline de Micro según la tabla de AWS de arriba (87 Mbps / 500 IOPS). En un minuto tranquilo de la tarde: 0,35 MB/s y 12 operaciones/s.
- **El disco del sistema lee 34 veces más que el de Postgres, y todo apunta a falta de memoria.** El servidor tenía 948 MB en total y 455 MB disponibles, con 415 MB en swap, y había mandado 7,2 GB a swap desde el reinicio. De los 110 GB leídos, 6,8 GB son swap que vuelve. El resto, casi seguro, son archivos que el sistema saca de la memoria y vuelve a leer: hubo 1,21 M `pgmajfault`, cada uno una ida al disco por algo que no estaba en memoria. El swap vive en el disco del sistema: la doc de Supabase dice que es 1 GB de disco, y lo que volvió de swap ya es más que todo lo leído de `/data`. Es, con toda probabilidad, lo que en Nano, con la mitad de memoria, se comía el saldo.
- **Casi todo lo escrito en `/data` es relleno de WAL.** Con `archive_timeout = 120 s`, Postgres cierra un segmento de 16 MB cada 2 minutos aunque casi no haya tráfico: se archivaron **2.001 segmentos (~33 GB) para 169 MB de WAL real** (`pg_stat_archiver` contra `pg_stat_wal`). Lo fija Supabase para el backup continuo: no está en el repo y no hay que perseguirlo.
- **Sin atascos desde Micro:** el cron `jobid 17` corrió 3.986 veces con un hueco máximo de 61 s y cero `startup timeout`; el peor checkpoint de 24 h fue de 508 buffers en 50,8 s, o sea los 0,1 s por buffer normales; `cleanup_orphan_searching_rides` tarda como mucho 0,5 s (76 s durante la caída).
- **Qué vigilar:** la memoria, no el disco. Si `SwapFree` se acerca a 0 o las lecturas de `nvme0n1` crecen mucho respecto de esta base, se está repitiendo lo de Nano, y el arreglo es Small (2 GB, el doble de memoria).

**Re-medido a los 10 días (241,5 h de uptime, 2026-10-03): la tasa no se degrada y Micro sigue sobrado.**

| Disco | Leído | Escrito |
|---|---|---|
| `nvme0n1` → `/` (sistema + swap) | **407 GiB** | 50 GiB |
| `nvme1n1` → `/data` (Postgres) | 8,6 GiB | 129 GiB |

- **Combinado: 0,74 MB/s y 27 IOPS**, o sea **6,7 %** de los 11 MB/s y **5,5 %** de los 500 IOPS de Micro.
- **Lo que importa es la tendencia, no el total:** las lecturas del root promediaron 0,49 MB/s en las primeras 66 h y 0,51 MB/s desde entonces. La firma de falta de memoria sigue igual (el root lee **47×** lo que lee `/data`) pero **estable**: `pgmajfault` pasó de 1,21 M a 6,24 M creciendo lineal, no acelerando. Memoria: 427 MB disponibles de 948, y 472 MB de swap en uso de 1 GB (33 GiB mandados a swap, 34 GiB traídos). Por eso se descartó Small otra vez.
- **`pg_stat_checkpointer` es el chequeo más barato de "¿está atascado el disco?"** — un solo SELECT, sin depender del servicio de logs (que falla seguido). Desde el arranque: 2.892 checkpoints, 323.162 buffers, **95,6 ms de `write_time` por buffer** = exactamente la siesta de ~100 ms que hace Postgres por buffer, o sea sano. Durante la caída del 09-21 hubo checkpoints de **~27.000 ms por buffer**. `stats_reset` dice desde cuándo mide: se resetea con el servidor, así que el promedio cubre justo el período post-upgrade.

```sql
SELECT num_timed, buffers_written,
       round((write_time / NULLIF(buffers_written,0))::numeric, 1) AS ms_por_buffer,
       stats_reset
FROM pg_stat_checkpointer;
```

> Trampa: `round(double precision, integer)` no existe en Postgres — hay que castear a `::numeric` o da `42883`.

### `spatial_ref_sys`: el advisor es ruido, los GRANT de `anon` no (verificado 2026-10-03)

El correo semanal **"Action required: security vulnerabilities detected in your projects"** trae un **Critical `rls_disabled_in_public`** y no nombra la tabla. Medido: la **única** tabla de `public` sin RLS es `spatial_ref_sys` (PostGIS, 8.500 filas de definiciones EPSG, 7 MB). Esa parte es el falso positivo conocido — no se le puede habilitar RLS porque su dueño es `supabase_admin`.

**Lo que sí es real y no estaba medido:** `anon` y `authenticated` tienen `arwdDxtm` sobre ella (todo, escritura incluida), otorgado por `supabase_admin`:

```
{supabase_admin=arwdDxtm/supabase_admin, postgres=arwdDxtm/supabase_admin,
 anon=arwdDxtm/supabase_admin, authenticated=arwdDxtm/supabase_admin,
 service_role=arwdDxtm/supabase_admin, =r/supabase_admin}
```

Está en `public`, así que la Data API la expone: cualquiera con la clave publicable puede UPDATE o DELETE. No hay datos nuestros ahí, pero **borrar la fila del SRID 4326 rompe todo `::geography`** — el search de calles, el reverse geocode y el matching de conductores dependen de ella. Probabilidad baja, impacto total.

**No lo podemos revocar nosotros.** El grant lo dio `supabase_admin`: `postgres` no es miembro suyo (`pg_has_role(current_user,'supabase_admin','MEMBER')` = false) y tiene los privilegios **sin** GRANT OPTION (no hay `*` en el ACL), y solo el dueño o el otorgante pueden revocar. Pedido a soporte en el ticket SU-480720 el 2026-10-03: revocar INSERT/UPDATE/DELETE a `anon` y `authenticated` conservando SELECT, y dejar de reportar un Critical que el cliente no puede accionar. **Hasta que lo hagan no hay mitigación de nuestro lado.**

**La regla operativa**, que convierte ese correo semanal en algo útil en vez de ruido:

```sql
SELECT c.relname, pg_get_userbyid(c.relowner) AS dueno, c.relacl::text
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity;
```

Si devuelve **solo** `spatial_ref_sys`, el Critical es el falso positivo de siempre y se archiva. Si devuelve **cualquier otra cosa**, el Critical es nuestro: a esa tabla le falta `ENABLE ROW LEVEL SECURITY` y hay que arreglarlo con una migración.

### Los REVOKE de una migración de lockdown se verifican en prod, no se asumen (00531 → 00591, 2026-09-15)

**Bug verificado.** `00531_lock_down_ungated_public_rpcs.sql` (31-07) revocaba 9 RPCs SECURITY DEFINER sin gate; la auditoría de pagos del 2026-09-15 encontró que **8 de las 9 seguían ejecutables por `anon`/`authenticated` en prod**: la migración quedó en git y nunca se aplicó. Buscar su número en `schema_migrations` no sirve (los applies por MCP se registran por timestamp — ver § "Cómo se registra el `version`"); lo que decide es `has_function_privilege` contra prod. `00591` la re-aplica con guardas `to_regprocedure()` y cierra dos más de la misma clase (`check_rate_limit` ejecutable por `authenticated`, `ensure_wallet_account` sin guard).

**Chequeo canónico después de CUALQUIER migración de permisos** (correr contra prod, no leer el archivo):
```sql
SELECT p.proname, has_function_privilege('anon', p.oid,'EXECUTE') AS anon_x,
       has_function_privilege('authenticated', p.oid,'EXECUTE') AS auth_x
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('…');
```

**Patrón "llamada directa vs anidada" para helpers SECDEF que las apps llaman para sí mismas** (`ensure_wallet_account`, 00591). Un guard ingenuo (`p_user_id = auth.uid()`) rompe a los llamadores internos (`send_gift` la llama para el receptor, `complete_ride_and_pay` para el conductor y la plataforma) porque dentro de ellos `auth.uid()` sigue siendo el usuario. `GET DIAGNOSTICS v_ctx = PG_CONTEXT;` lo resuelve: una llamada RPC directa (PostgREST) tiene UNA sola línea; llamada desde otra función plpgsql trae 2+ líneas separadas por `\n`. Restringir solo el caso directo deja intactos a los llamadores internos sin tocarlos y sin cambiar las apps. Antes de usarlo, listar los llamadores con `SELECT proname, prosecdef, lanname FROM pg_proc … WHERE prosrc ILIKE '%<helper>%'` (los de prod son todos plpgsql SECDEF).

**Ojo con las funciones SQL-language intermedias: NO siempre añaden frame.** Medido con un probe que devuelve `PG_CONTEXT` (corregido 2026-09-15; una versión previa de esta nota afirmaba lo contrario):

| Wrapper `LANGUAGE sql` | Frames | El guard lo ve como |
|---|---|---|
| plano (sin `STRICT`/`STABLE`/`SECURITY DEFINER`/`SET`) | **1** | llamada DIRECTA — el planner lo **inlinea** y el wrapper desaparece |
| `STRICT`, `STABLE`, o `SECURITY DEFINER`+`SET` | 2 | anidada (exento) |

O sea que un wrapper SQL plano queda **denegado**, no exento: el riesgo va en la otra dirección.

**La frontera de confianza, explícita:** la exención significa *"me llamó otra función plpgsql"*, NO *"me llamó código confiable"*. Cualquier función ejecutable por `authenticated` que reenvíe `(p_user_id, p_type)` elegidos por el llamante —una plpgsql, o una SQL no-inlinable— **reabre el agujero**; hay que validar el tipo en esa call site. Hoy ninguna lo hace (`send_gift` filtra su wallet de origen; los llamadores de cargo/referidos/corporativo pasan tipos fijos), y ni `anon` ni `authenticated` pueden `CREATE` en `public` (verificado con `has_schema_privilege`), así que solo un desarrollador puede introducirlo. Está escrito en el `COMMENT` de la función para que se lea donde importa.

**El vector del ancla en `wa_insert_own` (00197 → borrada en 00591).** La policy dejaba insertar `customer_cash` con `balance = 0` pero no limitaba `anchor_usd_cents` / `unbacked_cup`; `revalue_anchored_wallets` pone `balance = ancla/100 × tasa + unbacked` al día siguiente → un usuario SIN fila `customer_cash` (261 de 610 el 2026-09-15, 110 conductores) podía acuñar saldo. Regla: toda columna que un trigger o cron convierte en dinero (`anchor_usd_cents`, `unbacked_cup`, `balance_usd_cents`) queda fuera del alcance de INSERT/UPDATE de usuarios, no solo `balance`; las filas de billetera se crean SIEMPRE vía `ensure_wallet_account`. Y las búsquedas de cuentas de plataforma (`platform_fx_reserve`, `platform_revenue`) filtran por `user_id = '…0001'`, nunca `LIMIT 1` por tipo.

**Una migración de permisos tiene que ASERTAR su resultado, no confiar en su propio loop.** Los `REVOKE` de 00591 se hacen sobre firmas exactas y saltan con un `NOTICE` si la función no existe — y un `NOTICE` es **invisible** a través de `apply_migration`. Si la firma de prod hubiera derivado, la migración habría reportado éxito dejando el agujero abierto: exactamente cómo 00531 "funcionó" sin cambiar nada. Por eso 00591 cierra con bloques que recorren `pg_proc` **por nombre** (todas las sobrecargas) y hacen `RAISE EXCEPTION` si alguna sigue siendo ejecutable por `anon`/`authenticated`. Misma idea antes de parchear `revalue_anchored_wallets`: si la fila `platform_fx_reserve` no es del usuario plataforma, el pin la dejaría sin encontrar y la revaluación diaria sería un **no-op silencioso** (su rama `NULL` hace `RAISE WARNING; RETURN 0`, y el watchdog FX de 00503 solo mira la frescura de `exchange_rates`), así que aborta. **Residual aceptado:** `wallet_accounts.user_id` es FK `ON DELETE SET NULL`, o sea que borrar al usuario plataforma anularía ese dueño y silenciaría la revaluación — antes del pin, el `LIMIT 1` igual la encontraba.

**Ensayo local reproducible:** `supabase/tests/00591/run.sh none` (RED: 27 fallos, incluida la acuñación) / `run.sh supabase/migrations/00591_*.sql` (GREEN: 58/58, aplicada dos veces). El andamio lleva los cuerpos VIVOS de prod y sus ACLs, no los de git. Las dos aserciones de arriba tienen **pruebas negativas propias** (G1/G2: se rompe el invariante en una base desechable y se exige que la migración aborte) — una verificación que nunca se vio fallar no es una verificación.

**Trampa de método en la que caí verificando esto:** probé el guard contra la base del ensayo que había quedado del baseline **RED**, o sea sin el guard aplicado, y concluí que un wrapper SQL plano lo evadía. Todo pasaba porque no había nada que evadir. Si un probe de seguridad da "permitido", confirmá primero contra qué base estás hablando.

### Una función SECURITY DEFINER se salta la RLS de la tabla que lee (verificado 2026-10-06, mig 00608)

La 00517 ocultó las claves secretas de `platform_config` con la política `pc_select`, pero `get_platform_config_text` y `get_platform_config_numeric` son SECURITY DEFINER: leen la tabla como su dueño, sin RLS. La 00348 las había dejado ejecutables por `anon` cuando la tabla todavía era pública. Medido como `anon`: un SELECT de `openweather_api_key` en la tabla devolvía 0 filas, y la función devolvía la clave. Con la clave publicable, cualquiera podía leer por `POST /rest/v1/rpc/get_platform_config_text` el token de elToque, la clave de OpenWeather y las firmas de NETOPIA. La 00608 les quita EXECUTE a `PUBLIC`, `anon` y `authenticated`.

- **Cuando una RLS esconde filas, buscar las funciones SECURITY DEFINER que leen esa tabla y que un cliente puede ejecutar**: para ellas la política no existe.
  ```sql
  SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
    AND p.prosrc ~* 'from\s+(public\.)?<tabla>'
    AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  ```
- **Un helper que solo llaman otras funciones SECURITY DEFINER no necesita EXECUTE para los clientes**: la llamada interna corre como el dueño. El ensayo lo prueba (K2: `get_weather_surge()` como `anon` sigue leyendo su multiplicador).
- **Una función nueva nace con EXECUTE para `PUBLIC`**, y `anon` lo hereda. `refresh_cuba_landmask` (00575) quedó así, y cualquiera podía vaciar y reconstruir `cuba_landmask`.
- **Revocar no deshace lo que ya se leyó.** Esas claves no se rotaron desde marzo (elToque, OpenWeather) y junio (NETOPIA live); se rotan a mano en cada proveedor.

Ensayo: `supabase/tests/00608/run.sh none` (RED: fallan las 7 pruebas de la fuga) / `run.sh supabase/migrations/00608_*.sql` (GREEN 21/21, con 4 pruebas negativas de sus aserciones).

**Barrido de las funciones SECURITY DEFINER que un usuario con sesión puede llamar sobre datos ajenos (00610, 2026-10-06).** De 147 ejecutables por `authenticated`, 18 reciben un id o un punto y no miran `auth.uid()`. La 00610 cerró siete que ninguna app llamó nunca: `check_driver_eligibility` (escribía: marcaba a otro conductor como no apto y lo sacaba del despacho), `driver_can_afford_commission` (saldo exacto de la billetera de cualquier conductor), `find_best_drivers` (distancia exacta de cada conductor a un punto elegido: tres llamadas lo ubican), `_waypoint_pricing`, `get_driver_user_id`, `can_send_sms` y `driver_no_gps_rides_this_week`. **Las otras once quedan abiertas a propósito; no volver a marcarlas sin un motivo nuevo:**
- Las llaman las apps: `calculate_cancellation_fee` y `preview_cancellation_penalty` (builds del pasajero anteriores al 2026-06-03), `check_accept_ride_eligibility`, `calculate_ride_distance`, `ensure_notification_preferences` (solo booleanos) e `increment_experiment_rides` (no hay experimentos).
- Las usan políticas RLS, que se evalúan como el usuario: `can_review_ride` (`reviews.rev_insert`) y `corp_has_no_employees` (`corporate_employees_bootstrap_creator`). Quitarles EXECUTE rompe esas políticas.
- Públicas por diseño: `get_public_display_names` y `recompute_user_rating`. `increment_promo_uses` es un `SELECT 1`.

Antes de revocar una función a los clientes: buscar llamadas en las apps **también en el historial de git** (`git log -S"'<fn>'" -- apps packages supabase/functions`), porque los builds viejos siguen instalados, y confirmar que todas sus funciones SQL llamadoras son SECURITY DEFINER (`prosecdef`). Una función INVOKER que la llama, o una política RLS que la usa, la ejecuta como el usuario y se rompería. Ensayo: `supabase/tests/00610/run.sh` (RED: fallan las 8 pruebas de acceso ajeno; GREEN 21/21).

**`current_user` no sirve para saber quién llamó a una SECURITY DEFINER (00630, 2026-10-07).** Adentro de una función SECURITY DEFINER, `current_user` (y `current_role`) es siempre su dueño, la llame quien la llame. `dispatch_ride` tenía desde la 00211 (el arreglo de BUG-177, "re-dispatch any ride") un `IF pg_trigger_depth() = 0 AND current_user <> 'postgres' AND NOT is_admin() THEN RAISE ...` que nunca saltó, y `authenticated` conservaba EXECUTE: cualquier usuario con sesión podía forzar una ronda de despacho sobre cualquier viaje en búsqueda (ofertas nuevas, las vencidas reactivadas y un push por cada una; en las rondas 2 y 3, también un push al pasajero). La 00630 le quita EXECUTE a `PUBLIC`, `anon` y `authenticated` y reemplaza el chequeo por un comentario. Barrido del mismo día: era la única SECURITY DEFINER de `public` que miraba `current_user`, `current_role` o `session_user`. Estado: aplicada en prod el 2026-10-07 a las 21:06 UTC (`20261007210622`, por MCP en una sola transacción) y verificada por objeto: solo el dueño y `service_role` con EXECUTE, cuerpo `adec90cb…/5673`, y un usuario con sesión recibe `42501`. Un viaje real pedido 46 segundos después se despachó en el INSERT (ronda 1, 2 ofertas), y el cron `retry-dispatch-expired-rides` siguió en verde.
- Para que una función solo la llamen triggers, crons y otras SECURITY DEFINER, el control es el GRANT, no el cuerpo: esos llamadores corren como el dueño y no necesitan permiso de cliente. Si hace falta distinguir al usuario adentro, se usa `auth.uid()` o los claims del JWT, nunca `current_user`.
- En prod `postgres` es miembro de `anon`, `authenticated` y `service_role` con INHERIT: mientras `service_role` tenga EXECUTE, el dueño también. La 00630 asegura el privilegio efectivo del dueño, que es el que usan todos los llamadores internos, y que toda función que llama a `dispatch_ride(` sea SECURITY DEFINER con un dueño que puede ejecutarla: un llamador SECURITY INVOKER la ejecutaría como el usuario y perdería la llamada.
- `CREATE OR REPLACE` conserva los GRANT. Un `DROP` + `CREATE` (un cambio de aridad, como en 00126 y 00336) vuelve a dar los permisos por defecto, EXECUTE para `authenticated` incluido, y tiene que repetir el REVOKE.
- El validador de plpgsql exige EXECUTE sobre la función que valida (`CheckFunctionValidatorAccess`): un dueño sin EXECUTE efectivo ni siquiera puede hacerle `CREATE OR REPLACE`.
- Al ensayar, el dueño del andamio se tiene que llamar `postgres` si el cuerpo compara con ese literal: con otro nombre el chequeo salta y el RED no reproduce prod. `trg_dispatch_on_driver_online` se traga los errores, así que si `dispatch_ride` falla ahí el único síntoma es un viaje que nadie recibe (G6). Ensayo: `supabase/tests/00630/run.sh none` (RED: L1–L4 fallan con la ronda forzada a la vista) / `run.sh supabase/migrations/00630_*.sql` (GREEN 32/32, con 8 pruebas negativas). Cuerpo de `dispatch_ride` antes: md5 `a16ae768…/5537`; después de la 00630: `adec90cb…/5673`.

### Edge Functions: quién puede llamarlas (revisión de las 48 desplegadas, 2026-10-06)

- **`verify_jwt=true` solo prueba que hay alguna sesión**, y cualquiera consigue una con un OTP. Una función que no decide adentro quién la llama queda abierta a todos los usuarios (así estaban `check-sms-balance`, `demand-heatmap` y `search-places-google`). De las 48 desplegadas, 26 tienen `verify_jwt=false`. La clave de servicio se reconoce con `isServiceKeyToken` (comparación exacta); un admin, con `auth.getUser` + `users.role`.
- **Un `X-Forwarded-For` falso no sirve para saltar los límites por IP** (medido: enviado desde pg_net, `rate_limits` registró la IP real `44.234.196.74`). Pero todos los triggers y crons salen de esa misma IP: un límite por IP que se cuenta antes del chequeo de auth los mete en un solo balde (pasaba con `send-push` y las ofertas de viaje).
- **`@tricigo.app` está reservado** para los correos sintéticos (`phone_<n>@tricigo.app`). El `/auth/v1/signup` de GoTrue estaba abierto con autoconfirmación hasta el 2026-10-07 (`disable_signup: false`, `mailer_autoconfirm: true`, `external.phone: true`, leído de `GET /auth/v1/settings` con la clave publicable; sigue abierto, pero ya sin autoconfirmar el correo, ver más abajo): cualquiera podía crear `phone_<víctima>@tricigo.app` con contraseña y `verify-otp`, que también buscaba la cuenta por ese correo, le daba el primer login de ese número. Ahora `verify-otp` busca **solo por teléfono**, entra solo a una cuenta que tiene ese teléfono **confirmado** (`phone_confirmed_at`) y comprueba que la sesión emitida sea de esa cuenta; si no, 409 `account_conflict` (también si el correo sintético ya lo tiene otra cuenta al crearla). Medido: las 572 cuentas con teléfono lo tienen confirmado y todas tienen correo, así que nadie queda afuera.
- **GoTrue conserva `email_confirmed_at` al cambiar el correo con la API admin**, aunque se pase `email_confirm: false` (las 160 cuentas con correo real lo tenían confirmado sin haber pasado por `confirm-email`). Un correo escrito en `auth.users` queda confirmado al instante, y con eso un login con Google o Apple de esa dirección puede vincularse a la cuenta. Por eso `add-email-with-verification` ya no escribe ahí: lo hace `confirm-email` al canjear el token. Efecto visible: las apps leen el correo de la sesión, así que uno recién agregado aparece recién confirmado. La web tampoco llama más a `auth.updateUser({ email })` (GoTrue lo aplicaba al instante y confirmado): usa `add-email-with-verification`, como las apps.
- **`users.email_verified_at` lo escribe solo el servidor (00611).** Hasta ahí `authenticated` podía marcar su propio correo como verificado y un cambio de correo conservaba la marca; esa marca habilita el login por enlace, el reset de contraseña por correo y el aviso de dispositivo nuevo. El trigger `trg_users_protect_email_verification` la borra en todo cambio de correo y revierte cualquier cambio de la marca que venga de un JWT que no es admin. `confirm-email` estampa con el correo exacto en el `WHERE`, así que un cambio hecho mientras se canjea el enlace queda sin verificar. Ensayo: `supabase/tests/00611/run.sh`.
- **"Confirm email" activado el 2026-10-07 (21:46:18 UTC, Dashboard → Authentication → Providers → Email; `mailer_autoconfirm: false`).** Con el signup abierto y autoconfirmado, alguien podía registrar con contraseña el correo real de otra persona, y si esa persona después entraba con Google o Apple, GoTrue la vinculaba a esa cuenta. Ahora un alta por `/auth/v1/signup` queda sin confirmar y sin sesión hasta abrir el correo de GoTrue (SMTP incluido de Supabase, tope bajo: en la práctica esas altas no se completan, y ningún flujo nuestro usa `signUp`). No rompe el login por teléfono: `verify-otp` crea las cuentas con `email_confirm: true` y entra con `signInWithPassword` sobre el correo sintético, y las 670 cuentas tenían el correo confirmado. Verificado con un login real después del cambio (cuenta demo `+5355550100`: `send-sms-otp` 200 → OTP verificado → `login_method: password` → sesión nueva, sin "Email not confirmed"). Si un login fallara por esto, el arreglo inmediato es desactivarlo en la misma pantalla. Sigue pendiente: el proveedor Phone de GoTrue está activo (`external.phone: true`, `sms_provider: twilio`): su `/otp` y su signup por teléfono mandan SMS por Twilio sin pasar por nuestros límites, y ninguna app los usa (el login va por `send-sms-otp` + `verify-otp`). Evaluar apagarlo.
- **Nunca texto del request en un SMS o correo a terceros.** `broadcast-emergency` pegaba en el SMS el nombre y la chapa que mandaba la app: cualquier cuenta mandaba SMS firmados "TriciGo" con su propio texto a los números de sus contactos de confianza. Ahora salen de la base, y los nombres van reducidos a nombre e inicial, solo letras (`full_name` lo escribe su dueño: entero, todavía metía 40 caracteres propios, enlace incluido).
- **Una EF que reenvía pedidos de usuarios a `send-email` con la clave de servicio pone su propio límite por IP del cliente** (2026-10-07). Desde #1097, `send-email` no cuenta las llamadas con clave de servicio, y su bucket por IP del llamador era el único freno a esos relays (contaba la IP de salida de la EF). `add-email-with-verification` cuenta `add-email-ip:<ip>`, 10 por hora, después del chequeo de sesión y antes de leer el cuerpo. Tampoco va texto escrito por el usuario (`full_name`) en un correo a una dirección que eligió quien llama.
- **Toda API paga lleva límite por usuario además del tope global:** `search-places-google` 60 llamadas reales por hora y usuario; `send-sms-otp` 20 SMS por día a números de fuera de Cuba entre todos (90 días medidos: 1.390 a Cuba, 1 afuera); un número extranjero que una cuenta ya tiene confirmado no cuenta en ese cupo, para que una ráfaga de números premium no deje sin login a los usuarios reales de afuera.
- **NETOPIA:** el re-query confirma que un `ntpID` está pagado, no para qué orden. El webhook rechaza un `ntpID` guardado en otra intención (no hay ninguno repetido en el historial; si la consulta falla, 503 y NETOPIA reintenta) e ignora un IPN de fallo cuyo `ntpID` no es el que la intención ya tiene (un IPN de fallo no se confirma con NETOPIA, y sin esto podía desvincular el `ntpID` real). Si el re-query devuelve otro `orderID`, por ahora solo se loguea: nunca se capturó una respuesta de pago real y no sabemos el formato de ese campo; pasarlo a rechazo cuando los logs muestren que NETOPIA devuelve nuestro `orderID` tal cual. Las recargas corporativas exigen una cuenta aprobada que administre quien paga (sin eso, cualquiera sacaba el tope de $500 y el control de velocidad con una cuenta corporativa pendiente propia).
- **Correo a la dirección de una cuenta solo si su dueño la probó (00635, 2026-10-07).** `users.email` se escribe sin verificar (`add-email-with-verification` la guarda antes del clic, y el signup abierto de GoTrue copia cualquier dirección), y siete funciones SQL la usaban igual. El abuso más barato: la cuenta B pone `victim@x` como su correo y A le regala 1 CUP ida y vuelta; cada regalo le mandaba a `victim@x`, desde `noreply@tricigo.com`, el nombre y la nota que escribió A, sin tope. Los recibos de viaje (con las direcciones de origen y destino) también llegaban a un correo con un error de tipeo. La regla vive en una sola función, `mailable_user_emails(uuid[])`: se puede escribir a `users.email` si `email_verified_at` no es NULL **o** la cuenta tiene una identidad de Google o Apple con `email_verified` y la misma dirección (sin distinguir mayúsculas ni espacios). Una identidad `email` (contraseña) no prueba nada. Medido en prod: de 284 cuentas con correo, **0** tienen `email_verified_at` y 156 coinciden con Google/Apple; con la marca sola nadie recibiría estos correos.
  - **Todo remitente nuevo a `users.email` pasa por la regla**: en SQL, `public._user_mailable_email(<user_id>)` (NULL si no se puede); en una Edge Function, `fetchMailableEmail(s)` de `_shared/mailable-emails.ts`, que falla cerrado (si la RPC no responde, no se manda nada). No leer `users.email` ni el correo de `auth.users` para elegir destinatario. `mailable_user_emails` solo la ejecuta `service_role`: dice si una dirección está probada.
  - Usan la regla: `send_driver_payout_email` (regalos y pagos), `apply_cargo_bonus`, `send_first_ride_email`, `send_payment_failed_email`, `send_delivery_receipt_email`, `send_driver_status_email`, `send_ride_receipt_email`, y las EF `behavioral-emails`, `send-bulk-email`, `notify-document-rejection`, `register-login-device` (aviso de dispositivo nuevo), `generate-driver-contract` (copia al conductor) y `generate-recharge-receipt` (copia al usuario). El correo impreso dentro del PDF del contrato y del recibo no cambió; la copia del pagador de la diáspora tampoco (cada envío cuesta un pago real).
  - **El contacto de confianza no se puede probar** (lo escribe el pasajero): `notify_trusted_contacts_on_accept/_complete` mandan como mucho 20 correos por día **por pasajero y dirección** (`_trusted_contact_email_allowed(rider, email)`, clave `trusted-contact-email:<rider>:<dirección en minúsculas>`). Es por pasajero a propósito: con una clave global, cualquiera que nombrara la misma dirección podía gastar el cupo y silenciar los avisos de seguridad de otro pasajero. Los nombres le llegan al contacto como "nombre + inicial", solo letras (`_third_party_person_name`, espejo de `smsPersonName`), en el correo y también en el SMS de esas dos funciones.
  - **Un parche in-place que inserta texto se reconoce por un marcador de una línea**, no por el texto nuevo completo: si la migración se pega en el SQL Editor desde Windows (CRLF) y después la re-aplica `db push` (LF), comparar el bloque entero no lo encuentra y lo parchea dos veces (con el tope de regalos, quedaba en 10 por día). El cierre de 00635 asierta que cada marcador aparece exactamente una vez, y además recorre todo el catálogo: cualquier función de `public` que lea `users.email` y llame a `send-email` sin `_user_mailable_email(` aborta la migración (exenta: `notify_driver_under_review`, que manda a la casilla del admin).
  - **`send_gift`**: nota de hasta 500 caracteres (`DETAIL gift_note_too_long`, el límite que ya tenían las apps) y 20 regalos por día por remitente (`DETAIL gift_rate_limited`, clave `send-gift:<from>` en `rate_limits`). Un regalo rechazado o fallido revierte su conteo y una repetición idempotente vuelve antes del tope. Prod tenía 8 regalos en toda su historia, como mucho 2 por remitente y día.
  - **`register-login-device`** gateaba solo con `email_verified_at`, que no tiene ninguna cuenta de prod (0 de 284 con correo), así que el aviso de dispositivo nuevo no le llegaba a nadie. Desde #1116 usa `fetchMailableEmail` y llega a las 156 con la dirección probada por Google o Apple; conserva el tope de 3 avisos por día y cuenta (`new-device-email:<user>`). Ensayo de la migración: `supabase/tests/00635/run.sh` (ROJO 18 fallos, VERDE 45/45). En Windows, el texto de `psql -c` llega en la página de códigos de la consola: los acentos en una prueba van como `U&'Mar\00EDa'`.
- **Quedaron sin tocar, con motivo:** `verify-selfie` compara caras de mentira, pero `selfie_checks` está vacía; `mint-netopia-proxy-credential` da un proxy HTTPS general (ya en `PROXY_AUDIT_2026-07-02.md`); el PDF que recibe quien paga una recarga de la diáspora trae correo y teléfono del destinatario; `directions-google` no tiene límite por IP pero está apagado; `request-password-reset` y `send-login-email-link` revelan por el tiempo de respuesta si una cuenta existe; diez códigos equivocados en `verify-otp` traban 10 minutos el login de un número.

### Escrituras directas de clientes que decidían dinero o una revisión (00612, 2026-10-06)

Barrido de las columnas que un JWT de cliente puede escribir por PostgREST (políticas RLS + GRANT + triggers `*_protect_*`). Tres casos reales, reproducidos en prod con cuentas de prueba dentro de bloques revertidos:
- **`ride_splits`**: `complete_ride_and_pay` cobra de la billetera `customer_cash` de cada split con `accepted_at` su `share_pct` de la tarifa. El que pide el viaje podía insertar un split ya aceptado para otra cuenta, con cualquier porcentaje, y el invitado podía reescribir cualquier columna de su fila. Medido: invitación al 100 % "pre-aceptada", el conductor completa, quien pidió paga 0 y la otra cuenta paga todo. Desde 00612 (`trg_ride_splits_guard`): `share_pct` en (0, 100]; las partes de un viaje no suman más de 100 % (bajo lock del viaje, para todos, error `23514` con DETAIL `split_over_100`); una invitación de cliente nace pendiente y a nombre de quien la crea; el invitado solo puede aceptar, una vez, con `now()` del servidor. `complete_ride_and_pay` sigue marcando pagos porque setea `app.trusted_driver_update`.
- **`driver_documents`**: `dd_insert` dejaba al conductor insertar sus documentos ya con `is_verified = true` y `verified_by` de un admin; el panel los mostraba revisados. Ahora una escritura de cliente no toca los campos de revisión.
- **`users.is_test`**: lo podía cambiar cada uno sobre su fila, y `detect_collusion_reviews` saltea las cuentas de prueba. Ahora solo admin o service role.

**El reparto lo decide el servidor (00613).** Las apps mandaban `100 / (n+2)` para el invitado nuevo y nunca tocaban a los anteriores (50, 33,33, 25…): con dos invitados quien pedía pagaba 16,67 %, y desde 00612 el tercer invitado se rechazaba. Ahora, en un INSERT de cliente, `tg_ride_splits_guard` ignora el porcentaje que manda la app: el invitado nuevo recibe `floor(100 / n)` % con 2 decimales (n = quien pide + invitados + el nuevo) y baja a ese valor toda otra parte mayor, aceptada o no. Quien pide se queda con el redondeo (3 personas: 33,33 / 33,33 / 33,34). **Las partes nunca suben**, para que a nadie se le cobre más de lo que alguna versión de la app le mostró: si quien pide quita una invitación, los demás conservan su parte y quien pide paga lo liberado. Con un split ya pagado no se toca nada. La bajada corre bajo el flag `app.ride_splits_rebalance`, que el guard acepta como `app.trusted_driver_update` y que se restaura enseguida. Admin, service role y `complete_ride_and_pay` siguen con su porcentaje. "Tu parte" se calcula con `requesterShareTrc` de `@tricigo/utils` (misma cuenta que el cobro: `ROUND(tarifa × parte / 100)` por invitado y el resto para quien pide). Ensayo: `supabase/tests/00613/run.sh` (RED: 13 fallos; GREEN 28/28, con 6 pruebas negativas). Hasta hoy nadie creó nunca un split.

**El invitado puede rechazar (00614).** El "Rechazar" de la app y de la web borraba la fila del invitado, pero `split_delete` solo deja borrar a quien pidió el viaje: PostgREST respondía OK con 0 filas, la tarjeta desaparecía y la invitación volvía en la siguiente carga. La política `split_delete_invitee` (solo `authenticated`) dejaba al invitado borrar su invitación mientras no la haya aceptado ni pagado (`accepted_at` y `paid_at` nulos, `payment_status = 'pending'`); desde 00617 el rechazo pasa por `decline_split_invite` y esa política ya no existe (ver abajo). Rechazar no mueve dinero: el cobro solo lee las partes aceptadas, quien pide paga la parte rechazada y ninguna otra sube. Las apps usan `rideService.declineSplitInvite`, que lanza `SPLIT_ALREADY_ACCEPTED` o `SPLIT_DECLINE_FAILED` en vez de dar por hecho un borrado de 0 filas. **Un DELETE que la RLS no deja pasar no da error**: responde OK con 0 filas, así que todo borrado de cliente que importe pide `.select('id')` y mira cuántas filas volvieron. El realtime de `ride_splits` solo escucha INSERT y UPDATE, así que la hoja de quien pide relee al abrirse y la tarjeta web consulta cada 20 s. Ensayo: `supabase/tests/00614/run.sh` (RED: 5 fallos; GREEN 30/30, con pruebas negativas de cada condición y de la carrera aceptar/rechazar).

**El rechazo toma el lock del viaje, como la invitación (00617).** El rechazo de 00614 era un DELETE por RLS y no bloqueaba el viaje, mientras que la invitación de 00613 lo bloquea antes de contar a los invitados. Si quien pidió invitaba a alguien mientras el rechazo de otro invitado todavía no se confirmaba, la invitación nueva contaba al que se iba. Con Beto (50 %) y Eva (33,33 %), si Beto rechazaba mientras Ana invitaba a Fede, Eva y Fede quedaban en 25 % y Ana pagaba el 50 %, cuando rechazar y después invitar los deja en 33,33 %. Una política RLS no puede bloquear una fila, así que ahora el rechazo es `decline_split_invite(p_split_id)` (SECURITY DEFINER, solo `authenticated`): bloquea el viaje `FOR UPDATE` y recién después borra la invitación sin responder ni pagar de quien llama. Devuelve `declined`, `gone` (no hay invitación suya con ese id: nunca existió, se la retiraron, terminó el viaje o es de otro), `accepted` (se aceptó antes: queda y se cobra) o `kept` (pagada o en cobro). Una invitación y un rechazo del mismo viaje ahora corren uno detrás del otro, y las partes quedan como las dejaría ese orden: si la invitación llegó primero, Eva y Fede quedan en 25 %, que es lo que da invitar y después rechazar, porque las partes nunca suben. La 00617 borró `split_delete_invitee`: un rechazo sin el lock volvería a abrir la carrera. El retiro de quien pidió pasó a tomar el mismo lock en 00620 (abajo). Toda escritura nueva sobre `ride_splits` que dependa de cuántos invitados hay, o que los cambie, bloquea primero el viaje (orden viaje → invitaciones, el mismo del cobro, la invitación y el trigger de 00616) o se puede trabar con ellos. `rideService.declineSplitInvite` llama a la función y, si todavía no existe (`PGRST202`), cae al DELETE directo de 00614. Ensayo: `supabase/tests/00617/run.sh` (RED: 12 fallos, entre ellos la carrera C1; GREEN 29/29, con pruebas de carrera contra una invitación, una aceptación y el cierre del viaje, y pruebas negativas del lock, de cada condición y de las aserciones).

**El retiro de quien pidió también toma el lock del viaje (00620).** `split_delete` (00031) deja a quien pidió el viaje borrar invitaciones con un DELETE directo, sin bloquear el viaje. Eso tenía tres efectos. Los dos primeros duran lo que tarda en confirmarse un pedido, y en los dos el resultado equivale a uno de los dos órdenes posibles:
- Una invitación que llegaba mientras se confirmaba un retiro contaba al que se iba: las partes quedaban como si la invitación hubiera llegado primero.
- Un retiro que corría mientras el conductor iniciaba el viaje lo borraba aunque el viaje ya hubiera empezado, porque la política lee el estado del viaje en la foto con que arrancó el DELETE.
- El tercero es más ancho y sí cobra mal: las apps borraban `rides.is_split` cuando no quedaba nadie, leyendo y escribiendo en dos pedidos más sin lock, y la invitación también lee `is_split` e inserta en dos pedidos. Una invitación enviada en ese momento podía quedar en un viaje con `is_split = false`, y `complete_ride_and_pay` solo cobra a los invitados si `is_split` es true: quien pidió pagaba todo habiendo visto menos.

Ahora el retiro es `withdraw_split_invite(p_split_id)` (SECURITY DEFINER, solo `authenticated`). Bloquea el viaje del que llama `FOR UPDATE`, comprueba con el estado actual que el viaje no empezó (`searching`, `accepted`, `driver_en_route` o `arrived_at_pickup`, los mismos de `split_delete`) y borra la invitación si no está pagada ni en cobro. Una invitación aceptada también se puede retirar antes de recoger, como antes. Devuelve `withdrawn`, `gone` (no hay invitación con ese id en un viaje suyo), `too_late` (el viaje empezó o terminó: la invitación queda) o `kept` (pagada o en cobro). Además:
- **`is_split` ya no se borra:** un viaje dividido queda dividido. Sin invitaciones aceptadas, `complete_ride_and_pay` mueve el mismo dinero (quien pidió paga la tarifa entera, en dos transacciones del ledger en vez de una), y el rechazo ya lo dejaba así. Las versiones instaladas lo siguen borrando hasta que se actualicen.
- **`split_delete` sigue**, porque las apps instaladas retiran con el DELETE directo: sin la política, su "Quitar" respondería OK sin borrar nada. Se puede borrar cuando esas versiones ya no estén; la prueba W12 del ensayo muestra que la función no la necesita.
- `rideService.removeSplitInvite` llama a la función y, si todavía no existe (`PGRST202`), cae al DELETE directo, ahora mirando cuántas filas borró. La app y la web avisan "El viaje ya empezó: ya no puedes quitar a nadie de la división" con `SPLIT_WITHDRAW_TOO_LATE`; antes la web no mostraba nada y la app sacaba de la lista una invitación que seguía viva.

Ensayo: `supabase/tests/00620/run.sh` (RED: 13 fallos, entre ellos las carreras C1 y C3; GREEN 30/30, con 9 pruebas negativas).

**El invitado ve sus invitaciones, y solo mientras el viaje sigue (00616).** La tarjeta "Te invitaron a dividir" no mostró nunca nada: `getMySplitInvites` leía `ride_splits` con `rides!inner(...)`, y las políticas de `rides` solo dejan leer el viaje a su cliente, su conductor y los admins. El invitado veía su fila de `ride_splits`, pero no el viaje, y el join interno las descartaba todas (medido en prod como invitado, en un bloque revertido: 1 fila de split y 0 con el viaje unido). **Un embed `!inner` respeta la RLS de la tabla embebida**: si el que llama no puede leerla, la fila principal desaparece sin error. Ahora la tarjeta lee de `get_my_split_invites()` (SECURITY DEFINER, solo `authenticated`): devuelve las invitaciones del que llama sin responder ni pagar, de viajes todavía en curso, y solo los campos de la tarjeta (parte, quién invitó, estado, origen, destino y tarifa estimada). Además, cuando un viaje pasa a `completed`, `canceled` o `disputed`, `trg_rides_drop_unanswered_split_invites` borra sus invitaciones sin responder. Es un solo trigger para todos los caminos que terminan un viaje. No mueve dinero, porque el cobro solo lee las partes aceptadas. Si el invitado está aceptando en ese mismo instante, el trigger espera como mucho 2 s y después deja la invitación (la función ya no la muestra), así que nunca traba el cierre del viaje. `acceptSplitInvite` ahora mira cuántas filas cambió: si la invitación ya no existe lanza `SPLIT_INVITE_GONE`, y la tarjeta la quita y explica que el viaje terminó o que se la retiraron. La tarjeta de la app se recarga al volver a la pantalla. Las apps instaladas siguen sin ver la tarjeta hasta el próximo build. Ensayo: `supabase/tests/00616/run.sh` (RED: 13 fallos; GREEN 35/35, con pruebas negativas de cada filtro, del SECURITY DEFINER y de la carrera con una aceptación en curso).

**Trampa plpgsql que cazó el ensayo:** `current_setting('x', true)` devuelve **NULL** si la sesión nunca seteó el GUC (y `''` si lo seteó una transacción anterior). `v_trusted := … OR current_setting(...) = '1'` queda en NULL, e `IF NOT v_trusted` **no entra**: el guard se saltaba para todos los clientes. Los triggers que hacen `IF current_setting(...) = '1' THEN RETURN NEW` no tienen el problema porque NULL cae del lado seguro; al guardarlo en un booleano y negarlo, sí. Usar `coalesce(current_setting(...), '') = '1'`. Ensayo: `supabase/tests/00612/run.sh` (RED 19 fallos; GREEN 44/44, con prueba negativa del `coalesce` y del lock).

### Tarifa declarada por el cliente, promos, referidos y regalos (00631, 2026-10-07)

El cliente manda `rides.estimated_fare_cup` al crear el viaje, el snapshot `estimate` guarda ese número como contrato y `complete_ride_and_pay` cobra eso. Con una promo mayor que la comisión (SUPERFLA y BIENVENIDA son 25 %, la comisión 15 %), el subsidio de la promo le paga al conductor más de lo que la plataforma se queda: un pasajero y un conductor de acuerdo pueden acuñar el 10 % de la tarifa que inventen. Medido en prod en un bloque revertido: un viaje de 300 m pedido a 1.000.000 CUP con SUPERFLA dejó al conductor +100.000 en `tricicoin`. La cuenta para cualquier promo de porcentaje p: el conductor queda con `(p − 0,15) × tarifa`.

- **Techo al crear el viaje** (`tg_rides_validate_estimated_fare`, solo para un JWT que no es admin): la banda más cara del servicio (máximo de base, por km, por minuto y mínima entre sus `pricing_rules` activas y su fila de `service_type_configs`) sobre una ruta de 4 × la distancia en línea recta + 5 km a 10 km/h, por el recargo, por 1,5. En 234 viajes con tarifa, el más alto quedó en 0,50 del techo (p99 0,26). Pasarlo da `P0001` con DETAIL `fare_above_ceiling` y un MESSAGE en español, que `createRide` convierte en `AppError` `FARE_ABOVE_CEILING`. `surge_multiplier` queda en [1, 3], el rango de `get_weather_surge()`. **Si se suben las tarifas o se agrega un multiplicador** (experimentos de precio, un recargo nuevo), revisar que siga cabiendo con margen: la consulta que midió el 0,50 está en la descripción del PR #1103.
- **La promo se fija al crear el viaje.** Un UPDATE de un cliente no puede cambiar `promo_code_id` (vuelve al valor anterior, sin error) y no puede subir la parte de promo del descuento, solo bajarla. Antes, poner la promo con un UPDATE la aplicaba sin consumir un uso (una promo de uso único servía para todos los viajes), y un recálculo después de una parada lejana aplicaba el porcentaje también al recargo de la parada. El cambio de tipo de soporte (00628, bandera `app.force_discount_recompute`), los admins y el service role recalculan libres.
- **Referido de pasajero:** un viaje que maneja el referidor o el referido no paga el bono; cuenta el primer viaje completado del referido con otro conductor, igual que el camino del conductor (00615).
- **`admin_send_gift`** no deja que un admin se regale a sí mismo (`DETAIL gift_to_self`), igual que `admin_adjust_wallet`.
- **`referrals` se escribe solo con sus funciones** (todas SECURITY DEFINER): se borró `ref_insert` y `anon`/`authenticated` perdieron INSERT, UPDATE, DELETE y TRUNCATE.
- **Límite conocido (solo builds anteriores a la 00633):** esos builds cotizan un viaje con paradas por la ruta completa, pero el techo solo ve origen y destino, así que una parada a más de ~2,5 km de un viaje corto lo puede pasar (1 viaje con paradas en 120 días, en 0,16 del techo). Desde la 00633 las apps crean el viaje con la tarifa directa y el límite desaparece.
- **Estado: aplicada completa en prod el 2026-10-07, en dos partes.** La parte 1 (las cuatro funciones y el REVOKE) entró por MCP como `00631_free_money_guards_part1_additive`. El `DROP POLICY ref_insert` se cortó dos veces por MCP y el dueño lo pegó en el SQL Editor; por eso no figura en `schema_migrations`. Verificado por objeto: los cuatro cuerpos con los md5 de git, los tres triggers activos, `referrals` solo con `ref_select` y sin escritura para `anon`/`authenticated`. Probado en prod con un pasajero real en bloques revertidos: la tarifa inflada se rechaza, la honesta entra, el recargo 10 queda en 3, la promo no se agrega ni se quita por UPDATE, el recálculo tras una parada lejana no sube el descuento y el autorregalo de admin se rechaza.
- **La 00631 necesita la 00628 antes:** las dos parchean `tg_rides_validate_promo_discount`, y la guarda de la 00628 rechaza cualquier cuerpo que no sea el anterior a ella. Ensayo: `supabase/tests/00631/run.sh` (RED: 13 fallos; GREEN 39/39 con 5 pruebas negativas). El andamio necesita PostGIS (`apt-get install postgresql-16-postgis-3`).

### Paradas: se cotizan como tarifa directa + el recargo del servidor (00633, 2026-10-07)

El recargo por paradas lo pone el servidor: `trg_recalc_fare_on_waypoint_change` → `recalc_ride_estimate_with_waypoints` → `_waypoint_pricing` (00386). Suma `(línea recta origen → paradas → destino − línea recta origen → destino) × 1,3 × per_km_rate_cup de service_type_configs × recargo` sobre `pre_waypoints_total`, cada vez que se inserta, cambia o borra una parada. Ese cálculo se diseñó para "Agregar parada" durante el viaje, pero corre igual para las paradas que se cargan al reservar.

- **El bug (reproducido en prod en un bloque revertido):** la app y la web cotizaban la reserva por la ruta completa con las paradas, creaban el viaje con ese precio y después insertaban las paradas, así que el servidor volvía a sumar el desvío. Del Capitolio al Hotel Nacional pasando por la Plaza: cotizado en 9.000, cobrado 10.516. Nunca se reservó un viaje con paradas en prod (el único que hubo agregó la parada después), así que nadie lo pagó.
- **Ahora:** con paradas, `getLocalFareEstimate` cotiza la tarifa por la ruta **directa** y le suma `preview_stops_surcharge` (00633, la fórmula de `_waypoint_pricing` antes de que exista el viaje; el ensayo comprueba que coinciden en 500 viajes al azar). La distancia y el tiempo que ve el pasajero siguen saliendo de la ruta con paradas. `FareEstimate.stops_surcharge_cup` lleva el recargo y `createRide` inserta `estimated_fare_cup − stops_surcharge_cup`, así el servidor lo suma una sola vez. Mientras falte la función (`PGRST202`), el dispositivo usa la misma fórmula con haversine, que puede diferir en unos pesos.
- **Los descuentos se calculan sobre la tarifa sin paradas.** El servidor aplica la promo, el lugar aliado y el viaje compartido sobre el precio con el que se crea el viaje, y desde la 00631 un recálculo del cliente nunca sube la promo. Toda vista previa de descuento parte de `discountBaseCup(estimate)` (`@tricigo/utils`), nunca de `estimated_fare_cup`.
- **Builds anteriores** siguen cotizando por la ruta completa y cobrando el desvío dos veces hasta que se actualicen. Lo arregla el build nuevo de la app y el deploy de la web; el servidor no cambió.
- **Estado:** 00633 aplicada en prod el 2026-10-07 por MCP (`00633_preview_stops_surcharge`, md5 `a5ee2672…`). Probado en prod en un bloque revertido con un pasajero real: cotización 7.484 + 1.516 = 9.000, y el snapshot cobrado quedó en 9.000.
- Ensayo: `supabase/tests/00633/run.sh` (13/13).

### Un viaje cambia de estado, tarifa y horas solo por sus RPC (00634, 2026-10-07)

La política `r_update` deja al pasajero y al conductor asignado hacer UPDATE de su viaje por PostgREST, y los triggers de `rides` lo frenaban solo en parte. El trigger de transiciones no distingue un UPDATE crudo del de una RPC, porque las RPC conservan el JWT de quien llama. Medido en prod con cuentas de prueba, en bloques revertidos:
- El conductor marcaba `completed` con `final_fare_cup = 1` en un viaje en efectivo: quedaba completado sin ninguna fila en el ledger, o sea sin comisión. En un viaje corporativo, `handle_corporate_ride_completion` le habría cobrado a la empresa la tarifa que el conductor escribiera.
- Atrasar `driver_arrived_at` una hora sumaba 1.840 CUP de espera (20 minutos × 92) a un viaje de 2.000.
- El conductor llegaba a `arrived_at_pickup` sin la verja de GPS, y cancelaba sin pasar por `cancel_ride` (sin castigo de reputación).
- El pasajero dejaba en `disputed` un viaje en curso sin abrir una disputa, y `complete_ride_and_pay` ya no podía cobrarlo.

**La regla:** `tg_rides_client_write_guard` (BEFORE UPDATE) solo le deja cambiar a un UPDATE de cliente (`current_user` `anon` o `authenticated`, no admin) las columnas que las apps escriben directo: `share_token`, `share_token_expires_at`, `next_ride_id`, `is_chained` e `is_split`. Como único cambio de estado, puede pasar a `disputed` un viaje `completed` si quien llama tiene una disputa abierta en ese viaje (`disputeService.createDispute`). Lo demás falla con DETAIL `ride_status_via_rpc` o `ride_column_via_rpc` y un mensaje en español. Admins, service role, cron y SQL no pasan por la verja.
- **`current_user` dice si la escritura viene de una RPC.** Dentro de una función SECURITY DEFINER es su dueño. Un trigger SECURITY INVOKER que dispara por un UPDATE crudo de PostgREST ve `authenticated`. Es el otro lado de la nota de 00630: `current_user` no sirve para saber quién llamó a una SECURITY DEFINER, pero sí para saber si la escritura viene de adentro de una.
- **Si una app necesita escribir otra columna directo**, se agrega a `c_client_columns` en una migración nueva (si no, falla). Mejor todavía, una RPC.
- **Un trigger BEFORE UPDATE nuevo en `rides` cuyo nombre ordene antes de `rides_client_write_guard` rompe la verja**: los triggers del mismo tipo disparan en orden de nombre, y vería como del cliente lo que ese trigger reescribe en NEW (con el orden invertido, hasta compartir el enlace falla). La aserción de 00634 lo controla. Una migración que agregue un trigger así tiene que repetirla.
- **Una disputa abierta durante el viaje** queda registrada, pero el viaje sigue y se cobra al terminar. Antes quedaba en `disputed`, y resolverla con `no_action` lo pasaba a `completed` sin cobrar nada.
- **`update_ride_status_v2`** tenía EXECUTE para `PUBLIC` (en el probe, `anon` llevó un viaje a `in_progress`). Además, su verja `auth.uid() <> v_driver_user_id` da NULL sin sesión o con el viaje sin conductor. Ahora es `IS DISTINCT FROM`, y solo la ejecutan `authenticated` y `service_role`. Con service role sin sesión también responde `Forbidden`; ningún código del servidor la llama.
- También se les quitó TRUNCATE y TRIGGER sobre `rides` a `anon` y `authenticated` (TRUNCATE no pasa por RLS).
- Historial revisado hasta diciembre de 2025: el último código de app que cambiaba estado o tarifa directo (cancelar y aceptar crudos) se borró en abril de 2026.
- Ensayo: `supabase/tests/00634/run.sh` (RED: 18 fallos; GREEN 37/37 con 4 pruebas negativas). Ensayo en prod dentro de un bloque revertido, con los triggers reales: 10/10, incluidos `complete_ride_and_pay`, `cancel_ride`, compartir enlace y abrir una disputa.
- **Estado:** aplicada en prod el 2026-10-07 por MCP (`20261007221834`). Verificado por objeto: la verja (md5 `dadf42ea…`) es el primer trigger BEFORE UPDATE de `rides`, `update_ride_status_v2` quedó en `182eeb57…` sin EXECUTE para `anon`, y `authenticated` ya no tiene TRUNCATE. Probado después en prod en un bloque revertido: el completado crudo y el atraso de llegada se bloquean; `complete_ride_and_pay`, compartir enlace, abrir una disputa, `update_ride_status_v2` y `cancel_ride` siguen andando.

### Un viaje con billetera que no alcanza se cobra en efectivo (00637, 2026-10-07)

`complete_ride_and_pay` debitaba la billetera del pasajero sin mirar el saldo. Si no alcanzaba, el CHECK `wallet_accounts_customer_balance_non_negative` abortaba con 23514, el viaje quedaba `in_progress` y la app del conductor reintentaba tres veces y mostraba el error crudo. Nada retiene el saldo durante el viaje, así que puede faltar por un regalo enviado en medio del viaje (reproducido en prod), por la espera, por una parada agregada o, en un viaje dividido, porque un invitado vació su billetera.
- **Ahora un viaje TriciCoin sin división que la billetera no cubre** (tarifa más prima) se completa como `mixed` con `wallet_ratio = 1`: la billetera paga lo que tiene y el conductor cobra el resto en efectivo. Su tricicoin recibe la parte de billetera menos la comisión, como en cualquier viaje mixto.
- **En un viaje dividido**, cada pagador paga de su billetera hasta su parte y lo que falta es efectivo. Ninguna billetera paga más que su parte: lo que no cubre un invitado no se le pasa al que pidió el viaje. Mientras las billeteras alcancen, el cobro es idéntico al de antes.
- **`payment_method` pasa a `mixed`**, y la app, la web y los recibos ya muestran "X TriciCoin + Y efectivo". La app del conductor toma el método de la respuesta del RPC desde este build. Las versiones instaladas muestran el resumen de TriciCoin sin el aviso de cobrar efectivo.
- **`enforce_ride_update_columns` bloquea cualquier cambio de `payment_method` hecho con el JWT de un usuario, aunque lo haga una RPC**: es SECURITY DEFINER, así que adentro `current_user` siempre es su dueño y no distingue. Ahora deja pasar solo `tricicoin → mixed` en un viaje `completed`, y solo con la bandera de transacción `app.ride_payment_to_mixed`, que `complete_ride_and_pay` pone alrededor de ese UPDATE y nada más. Un UPDATE crudo de cliente igual no llega: la verja de 00634 lo rechaza antes. Si otra RPC necesita una excepción en un trigger de protección SECURITY DEFINER, usar el mismo patrón: una bandera propia, puesta justo alrededor de la escritura.
- **Seguro de viaje:** `tg_rides_validate_insurance` le ponía prima a cualquier viaje que mandara `insurance_selected = true`, aunque el flag `trip_insurance_enabled` no existe y las apps no ofrecen el seguro. En un viaje en efectivo la prima salía del tricicoin del conductor (en la prueba perdió 400 en un viaje de 2.000: 300 de comisión y 100 de prima). Ahora solo se cobra con el flag encendido. Antes de encenderlo hay que decidir quién paga la prima en efectivo y qué pasa cuando la billetera no cubre ni la prima: ese débito sigue fallando por el CHECK. Un viaje TriciCoin le reserva lugar en la billetera; uno dividido, no.
- **Ensayo en prod dentro de un bloque revertido:** 11 viajes completados antes y después del parche, con el ledger cuadrado contra cada saldo. Antes fallaban 5 con 23514; después cierran los 11, y los 4 sin seguro que ya cerraban quedan idénticos. Además, 5 pruebas negativas del permiso nuevo y un control positivo. Cuerpos tras 00637: `complete_ride_and_pay` `dc8ddf90…/31111`, `enforce_ride_update_columns` `31af7a0b…/4179` y `tg_rides_validate_insurance` `37cce0bf…/685`.
- **Estado:** aplicada en prod el 2026-10-07 por MCP, registrada como `20261007234824 00636_wallet_shortfall_pays_cash`: se escribió como 00636 y en git pasó a 00637 porque #1110 (`00636_rate_limits_retention`) se aplicó 9 minutos antes. Los comentarios dentro de los cuerpos dicen 00636, que es lo que tiene prod. Verificado por objeto: los tres cuerpos con los md5 de arriba, sin `\r`, y los ACL sin cambios.
- **Para ensayar en prod una función de dinero grande** sin transcribir 30.000 caracteres a un andamio local: un `DO` que crea funciones `pg_temp` de escenario y las corre antes y después de hacer `EXECUTE` de la migración, y que termina con un `RAISE EXCEPTION` que devuelve los resultados y deshace todo. Cada escenario abre un subbloque, arma el viaje, actúa con `SET LOCAL ROLE authenticated` y los claims, junta los cambios de saldo y las sumas del ledger, y cierra con un `RAISE` propio que deshace solo ese escenario. Las variables de plpgsql sobreviven a ese rollback, así que se puede devolver el resultado.

### Recargas NETOPIA: solo el servidor escribe `payment_intents`, y una devolución sin saldo queda registrada (00639, 2026-10-08)

- **`payment_intents` lo escriben solo las Edge Functions.** La política `pi_own_insert` (00020) dejaba a cualquier usuario con sesión insertar intentos con el estado, el monto, el proveedor y el ntpID que quisiera. Ninguna app lo usaba. Medido en prod en un bloque revertido: una pasajera insertó un intento "completado" de 9.999.999 CUP con el ntpID de una recarga real. El webhook rechaza un IPN cuyo ntpID ya está en otro intento (§2a), así que esa fila le bloqueaba el IPN de devolución o de contracargo a la recarga real: la plata volvía a la tarjeta y se quedaba en la billetera. Esas filas también aparecían como pagadas en el historial y en la lista de pagos del panel. 00639 borró la política, y `anon`/`authenticated` quedaron solo con SELECT.
- **Un ntpID por intento** (índice único parcial `payment_intents_provider_txn_key`). El §2a solo protege si todo ntpID pagado está guardado en su intento. Por eso, si NETOPIA no devuelve el ntpID o no se pudo guardar, `create-netopia-payment-intent` y `create-netopia-recharge-intent` cortan el pago (502) y no devuelven el link.
- **Devolución sin saldo.** `process_recharge_refund` descuenta el USD devuelto a la tasa del día. Si el pasajero ya había gastado la recarga, el descuento violaba el CHECK de saldo no negativo (23514, reproducido en prod). El webhook respondía 500, NETOPIA reintentaba hasta rendirse y la devolución no quedaba registrada en ningún lado. Ahora:
  - se descuenta lo que haya en la billetera del pasajero, hasta dejarla en 0;
  - lo que falta queda como `refund_shortfall_cup` en la metadata del ledger y en el `error_message` del intento;
  - la billetera queda sin ancla USD y sin `unbacked_cup` (si no, la revaluación siguiente le reconstruía saldo);
  - llega un correo a `business_notification_email`, por `cron_http_post` con la etiqueta `refund-shortfall-alert`.

  Las billeteras de conductor (`tricicoin`) y de empresa (`corporate_cash`) pueden quedar negativas y se siguen descontando completas. Para listar las devoluciones sin cubrir: `SELECT id, user_id, error_message FROM payment_intents WHERE error_message LIKE 'refund_shortfall:%';`. **Pendiente de decisión:** qué hacer con la cuenta de ese pasajero; hoy solo se avisa.
- **El webhook ya no deja una recarga trabada si falla el abono** (era #840). Antes el intento quedaba en `processing`, y cada reintento de NETOPIA se respondía como "ya procesado": tarjeta cobrada, billetera sin acreditar. Ahora:
  - si `process_recharge_payment` falla, el intento vuelve a `pending`, nunca a `failed` (eso dispararía de nuevo el push y el correo de pago fallido);
  - si otra ejecución tiene el intento en `processing` hace menos de 10 minutos, se responde 503 para que NETOPIA reintente;
  - un `processing` más viejo se puede volver a tomar.

  El abono es idempotente, así que tomarlo dos veces nunca acredita dos veces. La lógica está en `_shared/payment-intent-claim.ts`, y el handler tiene tests en `process-netopia-webhook/index.test.ts`.
- **#842** (autenticar los IPN de fallo) quedó cubierto por el cambio del 2026-10-06: un IPN de fallo con otro ntpID se ignora.
- **Ensayo:** `supabase/tests/00639/run.sh` (RED: 11 fallos; GREEN 27/27, con 4 pruebas negativas y una copia CRLF).
- **Estado (2026-10-08).** La parte sin borrados entró por MCP como `00639_recharge_intents_server_only_part1_additive`: el REVOKE, el índice único, la alerta y el parche de `process_recharge_refund` (md5 `f9a2baa4…`; la alerta, `03ef5e2f…`). Con eso los clientes ya no pueden insertar, porque no tienen el GRANT. La parte 2 (`DROP POLICY pi_own_insert` y `DROP INDEX idx_payment_intents_stripe_pi_id`, el índice viejo no único) se cortó dos veces por MCP esperando la aprobación y quedó para el SQL Editor. Para saber si ya se aplicó, revisar `pg_policy` de `payment_intents`: debe quedar solo `pi_own_select`. Edge Functions desplegadas: `process-netopia-webhook` v39, `create-netopia-payment-intent` v37 y `create-netopia-recharge-intent` v12, las tres idénticas al repo. Ese deploy también subió el texto en tuteo de `_shared/fx-freshness.ts`, que #1106 cambió sin redesplegar. Probado en prod en bloques revertidos:
  - el insert de un cliente da `42501`;
  - una devolución de $100 sobre una billetera de 46.593 CUP descuenta lo que hay, registra 30.407 de faltante, deja la billetera en 0 sin ancla y encola 5 correos;
  - una devolución que la billetera cubre queda igual que antes.
- **Cuando la parte destructiva de una migración de seguridad tiene que esperar, separar el cierre del agujero de la limpieza.** Si el cierre es un REVOKE, entra sin aprobación, y los DROP pueden esperar sin dejar nada abierto.

### `users.phone` no prueba que el número sea del usuario (00599, 2026-09-26)

**El agujero.** Hasta 00599 cualquier usuario con sesión podía escribir cualquier número en `public.users.phone` por PostgREST, sin OTP: `authenticated` tiene UPDATE sobre la columna, `users_update_own` no tiene `WITH CHECK` y `tg_users_protect_admin_fields` no cubría `phone`. Las dos búsquedas de dinero confiaban en esa columna con `LIMIT 1` sin `ORDER BY`: `find_user_by_phone` (regalos, dividir tarifa) y `find_recipient_for_recharge` (recargas de la diáspora). Reproducido en local con los cuerpos vivos: un número que nadie había registrado resolvía siempre a quien se lo había puesto, y un número ajeno pasaba a resolver al atacante en cuanto se reescribía la fila del dueño (su siguiente viaje).

**Regla desde 00599:**
- El número que prueba propiedad es `auth.users.phone` con `phone_confirmed_at` (único por `users_phone_key`; GoTrue lo guarda como dígitos E.164 **sin `+`**). Toda búsqueda "por número" que decida algo (dinero, vincular cuentas) resuelve contra esa fuente, **nunca** contra `users.phone`: la cuenta activa que lo confirmó, o nadie si hay cero o más de una. Es la misma regla que usa `_user_id_by_verified_phone` (00598), aunque las dos parsean distinto lo que reciben; cuando estén las dos en master, conviene que las búsquedas usen un solo helper.
- `users.phone` igual puede tener un número sin confirmar: `handle_new_user` copia `auth.users.phone` al alta, esté confirmado o no, y el alta por teléfono de GoTrue está abierta (`external.phone = true`, sin auto-confirmación). Son cuentas que no pueden iniciar sesión (0 al 2026-09-26), pero por eso ninguna decisión se toma leyendo `users.phone`. Todo esto depende de que `phone_autoconfirm` siga en `false` (se ve en `/auth/v1/settings`). Y `phone_confirmed_at` es de la **cuenta**, no del número: si un operador cambia `auth.users.phone` desde el Dashboard sin `phone_confirm`, queda la fecha vieja y el número nuevo cuenta como confirmado.
- Un JWT que no es admin solo puede escribir en `users.phone` el número que SU cuenta confirmó, y queda guardado en E.164. Cualquier otro valor se revierte en silencio, como role/level, y deja una fila en `rpc_attempt_log` (`rpc_name = 'users_phone_guard'`, `metadata.reason` = `not_the_verified_phone` / `no_verified_phone` / `cleared`, sin el número). Sin JWT (el espejo service-role de `link-phone`, triggers, cron) y los admins no tienen límite.
- Una pantalla nueva que cambie el teléfono lo confirma primero con `link-phone` (OTP): el `updateProfile({ phone })` de después pasa porque escribe el mismo número.

**Diagnóstico — "cambié mi número y no se guardó":**
```sql
SELECT caller_uid, target_id, metadata->>'reason' AS reason, created_at
FROM rpc_attempt_log WHERE rpc_name = 'users_phone_guard' ORDER BY created_at DESC LIMIT 20;
```
`no_verified_phone` = la cuenta no tiene número confirmado en `auth.users` (se escribió sin pasar por `link-phone`, o `link-phone` falló). Varias `not_the_verified_phone` seguidas desde el mismo `caller_uid` = alguien intentando quedarse con un número ajeno.

**Ensayo:** `supabase/tests/00599/run.sh none` (RED: 23 fallos) / `run.sh supabase/migrations/00599_users_phone_guard_and_verified_lookups.sql` (51/51, aplicada dos veces, más dos pruebas negativas del autotest).

**Estado:** 00599 **aplicada a prod el 2026-09-27 04:09 UTC** por MCP tras el merge de #1039 (`schema_migrations` la registra por timestamp `20260927040913`; verificar por objeto, md5/largo del cuerpo: `tg_users_protect_admin_fields` `377912e83023297eda4761622a113364/2995`, `find_user_by_phone` `16f7c080bc4ded004ba4832b04ebb101/1327`, `find_recipient_for_recharge` `4fc4aa9eb404dd66af2aa12306e5b307/590`). Verificado en prod justo después del apply: el autotest no dejó filas (ni log ni rate limit); una escritura revertida con el JWT de una pasajera real conservó su número y quedó registrada como `reverted:not_the_verified_phone`; el número de Luis Manuel resuelve a su cuenta de conductor y el del super_admin sembrado, a nadie. Sin cambios en las apps (ni rebuild ni OTA). **Una migración que redefina `tg_users_protect_admin_fields` tiene que partir de este cuerpo, con el bloque 00599**, no del de 00543.

### `INSERT` en `public.users`: solo el alta lo hace (00605, 2026-09-27)

Hasta 00605, cualquier cuenta con sesión podía insertar su propia fila en `public.users`: la política `users_insert_own` (del esquema inicial 00001) lo permitía, `anon`/`authenticated` tenían el grant de INSERT, y `tg_users_protect_admin_fields` corre solo en UPDATE. Una cuenta que perdiera su fila (con `auth.users` y sus sesiones vivas) podía recrearla como `super_admin` (reproducido en local: `is_super_admin()` pasó a `true`). 00605 quitó la política **y** el grant de INSERT a `anon`/`authenticated`: son dos capas independientes, así que un `GRANT ALL` futuro sigue sin política y una política futura sigue sin grant.

- La fila la crea solo `handle_new_user` (AFTER INSERT ON `auth.users`, dueño `postgres`, igual que la tabla): no depende ni de la política ni del grant.
- **Nunca `FORCE ROW LEVEL SECURITY` en `public.users`.** Sin política de INSERT, el alta funciona solo porque el dueño de `handle_new_user` es el dueño de la tabla y la RLS no está forzada (el dueño está exento de su RLS salvo que se fuerce). Forzarla rompe todas las altas. El ensayo lo cubre con un canario (R6), y el autotest de 00605 no aplica sobre una tabla con la RLS forzada.
- **Para reparar una cuenta sin fila, usar `service_role`**, que conserva INSERT. Un `upsert` de cliente sobre `users` también queda rechazado; hoy ninguna app lo usa (las apps solo hacen `.update()`).
- Si algún día una app necesita insertar en `users`, **no reabrir la política sola**: agregar un `tg_users_protect_insert` como los de `driver_profiles` y `corporate_accounts`, que fuerzan rol, nivel, contadores y teléfono.

**Ensayo:** `supabase/tests/00605/run.sh none` (RED: 8 fallos) / `run.sh supabase/migrations/00605_users_no_client_insert.sql` (25/25, más cuatro pruebas negativas del autotest). El andamio le da las tablas y funciones a un dueño **que no es superusuario**, como `postgres` en prod: con un superusuario de dueño, el ensayo no puede ver una regresión de RLS forzada, porque un superusuario la saltea igual.

### `INSERT` en `ride_disputes`, `customer_profiles` y `rides.wallet_ratio` (00607, 2026-10-05)

- **Desde el 09/04 nadie podía abrir una disputa.** `ride_disputes.priority` tiene `DEFAULT 'normal'` (00038) y la 00104 le puso un CHECK que solo acepta `low/medium/high/critical`. La app nunca manda la prioridad, así que toda disputa fallaba con 23514 (0 filas en prod). La 00607 pasa el CHECK a `low/normal/high/urgent`, los valores de `DisputePriority` y del panel. **Antes de agregar un CHECK a una columna con DEFAULT, probar un INSERT que no mande esa columna.**
- **En `ride_disputes` y `customer_profiles` los guards `*_protect_*` corrían solo en UPDATE** (la clase de la ronda 7: la 00434 ya había cerrado `driver_profiles` y `corporate_accounts`). Para un cliente, `tg_ride_disputes_protect_insert` crea la disputa `open`/`normal`, sin campos de admin ni de reembolso, con el SLA de 24/72 h calculado en el servidor, la contraparte sacada del viaje y las tarifas del viaje como tope de reembolso. Antes el cliente podía nombrar a cualquier cuenta como contraparte, y esa cuenta podía leer la disputa. **Si la app empieza a mandar un campo nuevo al abrir una disputa, hay que permitirlo en ese guard**: si no, se borra sin error. Lo mismo vale para una RPC `SECURITY DEFINER` que llame un usuario con sesión: tiene JWT y el guard la trata como cliente.
- El guard de calificación de `customer_profiles` ahora también corre en INSERT: un perfil creado por un cliente empieza en 5.00, el valor por defecto.
- **`rides.wallet_ratio` va entre 0 y 1** (CHECK `rides_wallet_ratio_range`). Con pago mixto, si el ratio era mayor que 1 y el saldo mayor que la tarifa, `complete_ride_and_pay` calculaba una parte en efectivo negativa y fallaba en `rides_cash_amount_nonneg`: el conductor no podía terminar el viaje ni cobrarlo.
- En `rides`, `tg_rides_normalize_scheduling` ya forzaba al crear el viaje el estado, el conductor, las tarifas finales y las horas del viaje, y `tg_rides_validate_promo_discount` los descuentos y los socios. Sigue abierto que `estimated_fare_cup` lo pone el cliente y solo se compara con la tarifa mínima.
- **Orden de locks al aplicar con la app en vivo:** `ride_disputes`, después `rides`, después `customer_profiles` (con `CREATE OR REPLACE TRIGGER`, que no bloquea lecturas). Es el orden en que los toman `createDispute`, `cancel_ride` y el despacho; el orden inverso puede producir un deadlock con un viaje real.
- **Ensayo:** `supabase/tests/00607/run.sh none` (RED) / `run.sh supabase/migrations/00607_insert_guards_disputes_rides_profiles.sql` (GREEN, aplicada dos veces, con el cuerpo de git de la 00434 y con prioridades viejas sembradas, más cinco pruebas negativas del autotest).
- **Estado: aplicada completa en prod el 2026-10-06** (`20261006174406`; la sección 1 ya estaba desde `20261006031721`), después de un ensayo en prod dentro de una transacción revertida y del merge de #1059. Lo que quedó en prod coincide con el archivo (md5 del archivo `971b54df…`, del guard nuevo `23426e0f…`, del de calificación `72358ae7…`). Verificado como cuentas reales, en transacciones revertidas: abrir una disputa (pasajero y conductor), la respuesta del conductor, escalar y anotar como admin, resolver con reembolso (`process_dispute_refund`: +100 al pasajero, −100 a la plataforma, el viaje vuelve a `completed`) y sin reembolso, la disputa falsificada limpia e invisible para el extraño, un viaje mixto completo (1500/1500), `wallet_ratio` 5 rechazado, perfil nuevo en 5.00 y la calificación sin poder reescribirse. **Trampa al ensayar:** `complete_ride_and_pay` deja `app.trusted_driver_update = '1'` hasta el final de la transacción, así que en un ensayo de una sola transacción el guard de calificación deja pasar todo lo que viene después; correr esas pruebas antes o en otra transacción.

### Sesión fantasma: la app pide como `anon` y la RLS revienta con `permission denied for function current_user_role` (verificado 2026-09-22, mig 00592)

**Síntoma.** Un conductor toca "Conectarme" y ve el toast **"No se pudo cambiar el estado — permission denied for function current_user_role"**. Mismo error, otra víctima: el SSR público del blog (cliente anon por diseño) recibía 401 en `blog_posts` 7 de 8 veces. Y no era un caso aislado: en 24 h ~10 IPs cubanas mostraban el mismo patrón, incluidas ráfagas de heartbeat del background task del conductor (25 en 23 min).

**Dos causas en capas distintas, y hubo que arreglar las dos.**

1. **Servidor.** `is_admin()` era `LANGUAGE sql` SECURITY INVOKER y llamaba a `current_user_role()`, que es SECURITY DEFINER **sin EXECUTE para `anon`** desde 00517. Toda policy que llegara a `is_admin()` con role `anon` (`dp_update_own` = `user_id = auth.uid() OR is_admin()`; `users_select_own`, que `blog_posts_admin_all` subconsulta) no evaluaba a `false`: **abortaba con 42501**, y PostgREST lo mapea a 401 con ese texto crudo. Ese texto llegaba a la pantalla porque `driver.service` hace `throw new Error(error.message)` y la app lo pinta tal cual (misma clase que el `RAISE ... USING MESSAGE` de 00519).
2. **Apps.** La app del conductor corría **sin sesión en memoria mientras la sesión del servidor estaba intacta** (creada el 09-08, refrescada el 09-22, y el conductor online al rato). Sin sesión, supabase-js manda la publishable key como bearer → role `anon`. El adapter de storage (`packages/api/src/storage.ts`) convertía "el store LANZÓ" (keychain bloqueado en iOS, #802/#804) y "el store está VACÍO" en el mismo `null`, tragándose el error; `hydrateFromCacheOrReset` mantenía la UI logueada desde la cache en los dos casos → **sesión fantasma**: cada request salía como `anon`.

**Cómo verlo en prod (sin la app):** `get_logs service=api` / `query_logs` de edge: las requests del incidente tienen `request.sb.jwt.authorization.payload.role` **vacío** y `request.sb.apikey.apikey.prefix = sb_publishable_…` (una app logueada trae `role=authenticated`). `auth.audit_log_entries` está vacía en prod: usar `auth_logs` con `extract(event_message, 'actor_id\":\"([0-9a-f-]{36})')`. **Pista falsa:** `token_revoked` en los logs de auth es la rotación normal del refresh token, no un logout forzado.

**Fix servidor (00592).** `is_admin()` pasa a **plpgsql** con `IF auth.uid() IS NULL THEN RETURN false; END IF;` antes de llamar a `current_user_role()`. **La trampa que costó una vuelta:** un `CASE WHEN auth.uid() IS NULL THEN false ELSE current_user_role() … END` dentro de una función SQL **no sirve**: el EXECUTE de cada función de la expresión se chequea al **inicializar** la expresión, antes de evaluar rama alguna, así que anon seguía recibiendo 42501 (medido: A1/B3 del ensayo fallaban igual con el CASE instalado). plpgsql prepara cada sentencia la primera vez que la alcanza, así que el `RETURN` guardado nunca toca `current_user_role()` para anon. Se conserva SECURITY INVOKER: anon **sigue sin** EXECUTE en `current_user_role()` (00517), solo que ya no pregunta. La migración se **asserta a sí misma** como anon (`SET LOCAL ROLE anon` dentro del `DO`; `postgres` es miembro de `anon` en Supabase, verificado con `pg_has_role`) — si el path anon sigue reventando, la migración aborta en vez de reportar éxito. Ensayo: `supabase/tests/00592/run.sh none` (RED: A1/B3 reproducen el error exacto) / `run.sh supabase/migrations/00592_is_admin_anon_safe.sql` (15/15, aplicada dos veces).

**Fix apps.** `StorageAdapter.lastReadFailed(key)` + opción `onReadError` (el error que GoTrue nunca ve, ahora logueado) + `didAuthStorageReadFail()` en `@tricigo/api`. `hydrateFromCacheOrReset(…, reason)` en los dos `useAuth`: `'session_missing'` **con lectura exitosa** → `clearAuthCache()` + `reset()` (login; la sesión de verdad no está); lectura fallida o `'transient_error'` → cache, como antes. `driverService.setOnlineStatus` chequea la sesión **antes** de cualquier query y lanza `session_expired` (el toast dice `common.session_unavailable`: "Tu sesión no está disponible. Cierra la app por completo y vuelve a abrirla."); `sendHeartbeat`/`updateDriverPosition` **se saltan** sin sesión (log una vez por proceso) en vez de quemar un 401 cada 55 s. Regla: **una escritura que solo tiene sentido con sesión chequea la sesión primero**; el error de RLS que produciría no significa nada para un usuario.

**Trampa de test (vitest):** las colas "once" (`mockReturnValueOnce`) **no** se limpian con `vi.clearAllMocks()`, solo con `mockReset`. Al mover el chequeo de sesión al principio, un test viejo que encolaba una cadena de `vehicles` dejó de consumirla y esa cadena se filtró a los **18 tests siguientes**, que fallaron por cosas que no tenían nada que ver. Cuando cambiás el ORDEN de llamadas de un servicio, buscá qué colas "once" quedan sin consumir en los tests viejos antes de creerle a la cascada.

**Estado:** 00592 **aplicada a prod el 2026-09-22 18:12 UTC** por MCP tras el merge de #1009 (`schema_migrations` la registra por timestamp `20260922181201`; verificar por objeto: `is_admin` con `lanname = 'plpgsql'`, cuerpo md5 `22cb75e91980d512498034cd33e1eda2` = byte a byte el del archivo). Verificado en prod justo después del apply, en una sola petición multi-sentencia con `SET LOCAL ROLE`: como `anon`, `is_admin()` = false **sin error**, lectura de `blog_posts` publicados OK (3 filas) y UPDATE sobre `driver_profiles` = 0 filas sin error; admin → true, customer → false; `anon` sigue sin EXECUTE en `current_user_role()`. Con las APKs actuales el texto crudo de RLS ya no aparece (el servidor devuelve 0 filas y la app vieja lo reporta como `session_expired`); el login honesto y el heartbeat que se salta sin sesión requieren **rebuild de las dos apps**. Si a un conductor todavía le falla "Conectarme": cerrar la app por completo y reabrirla; si persiste, Perfil → Cerrar sesión → volver a entrar.

### Tarifas: cómo se fijan y cómo cambiarlas (verificado 2026-09-24, mig 00593)

**Modelo.** `pricing_rules` tiene 4 franjas por servicio (00–06, 06–12, 12–18, 18–24, hora del celular). Precio = `max(base + km × per_km + min × per_min, mínima)` (`calculateBaseFare`); los minutos salen de la duración neutra de OSRM, no de la del vehículo. El único recargo es el clima. **La fuente de verdad son las columnas `*_usd`**: `recompute_cup_from_usd_prices()` deriva los CUP con la tasa vigente y el cron de FX lo corre en cada cambio de tasa. Una migración que escriba solo CUP se revierte en el próximo cambio de tasa: escribir USD y llamar a `recompute_cup_from_usd_prices()`.

**El piso que rompe viajes.** `tg_rides_validate_estimated_fare` rechaza todo viaje con precio menor que `service_type_configs.min_fare_cup`. Si bajás la mínima de una franja por debajo de ese piso, **bajá el piso en el mismo cambio** o todo viaje corto falla al pedirlo. `accept_ride_v2` lee esa config pero no la usa.

| Migración | Qué hizo |
|---|---|
| 00441 | Precios de "la nave" × 0,9412, franjas 1 / 1 / 1,5 / 2 |
| 00470 | La nave × 0,90, plano las 24 h |
| 00501 | Noche y madrugada = tarifa publicada de La Nave (se subieron: hay pocos conductores a esas horas) |
| 00569 (#965) | Tarde = La Nave exacto. **Aplicada en prod, PR sin mergear** |
| **00593** | **Fase 1 contra Cinco**: mínimas de día (moto 580, triciclo 1.250, auto 1.450) + Confort = auto × 1,3 en todo |

**Lo que se sabe de Cinco** (14 capturas, 22–24 sept): es más barato que La Nave en viaje corto. Tiene precio dinámico (el mismo viaje llegó a costar 2,4 veces más en un día) y muestra siempre un "−10 %" sobre un precio tachado. Sin recargo cobraba moto 585 y auto 1.480 CUP por un viaje corto en Centro Habana. **Esas capturas solo sirven para calibrar la mínima**: los viajes reales de TriciGo tienen mediana 4,8 km (solo 23 de 221 miden 2 km o menos). Para tocar la tarifa por km hacen falta capturas de ~5 y ~10 km sin recargo. El observatorio de #1004 lo automatiza.

**Pendiente.** Fase 2, noche y madrugada, a decidir después de medir la fase 1: moto 810 / 1.040, triciclo 1.750 / 2.250, auto 2.030 / 2.610. **Anomalía de la tarde:** el triciclo cobra 1.070 + 119/km, así que un viaje de 4,7 km cuesta ~1.630 a las 12:00 contra 2.490 a las 11:59.

**Probar un cambio de tarifas sin dejar nada en prod:** un `DO` que aplica los `UPDATE`, llama a `recompute`, verifica y termina con `RAISE EXCEPTION '<valores>'` (la excepción deshace todo y devuelve los valores en el mensaje). Para el piso: insertar dentro de otro `DO` que termina en excepción un viaje **programado** (`scheduled_at` futuro, no se despacha a nadie) con la mínima nueva, y otro un peso por debajo, que debe rechazarse.

### Recordatorio para Claude

**Siempre leer `CLAUDE.md` al empezar** y actualizar esta sección cuando aparezca un nuevo problema, comando útil, o paso de troubleshooting verificado en una sesión real.
